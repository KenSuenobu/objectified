"""Offline mock bundle loading tests (#4741, PMR-1.1).

These tests never touch Postgres or the network: a bundle is the whole world the portable runtime
needs, which is exactly the acceptance criterion "bundle loads offline".
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from uuid import UUID

import pytest
from app.mock_bundle import (
    MAX_RUNTIME_VERSION,
    MIN_RUNTIME_VERSION,
    BundleIdentity,
    FixtureSource,
    build_bundle,
    bundle_bytes,
    content_digest,
    manifest_digest,
)

from apiome_mock.bundle import (
    BUNDLE_EPOCH,
    RUNTIME_VERSION,
    LoadedBundle,
    MockBundleError,
    MockBundleIncompatibleError,
    load_bundle_document,
    load_bundle_file,
)
from apiome_mock.chaos import effective_knobs

SECRET = "shared-bundle-secret"
REVISION_ID = "11111111-2222-3333-4444-555555555555"

IDENTITY = BundleIdentity(
    tenant="acme-corp",
    project="petstore",
    version="1.0.0",
    revision_id=REVISION_ID,
    published=True,
    protocol="openapi",
)

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "array"}}},
                    },
                    "429": {"description": "throttled"},
                }
            },
            "post": {"responses": {"201": {"description": "created"}}},
        }
    },
}

SETTINGS = {
    "mode": "private",
    "scenarios": {
        "quota-exceeded": {
            "description": "Throttled.",
            "operations": {"GET /pets": {"responses": [{"status": 429, "headers": {"Retry-After": "60"}}]}},
        }
    },
    "chaos": {"default": {"delayMs": 250}, "operations": {"GET /pets": {"errorRate": 25}}},
}

FIXTURES = (FixtureSource(name="pets.json", content=b'{"pets":[{"id":1}]}'),)


def _document(**overrides: object) -> dict:
    """Build a signed bundle document with the shared inputs."""
    kwargs: dict = {
        "identity": IDENTITY,
        "spec": SPEC,
        "mock_settings": SETTINGS,
        "fixtures": FIXTURES,
        "secret": SECRET,
    }
    kwargs.update(overrides)
    return build_bundle(**kwargs)


def _write(tmp_path: Path, document: dict) -> Path:
    """Write a bundle to disk exactly as the exporter would."""
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))
    return path


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def test_runtime_version_is_inside_the_published_compatibility_window() -> None:
    """The shipped runtime must be able to load the bundles this build produces."""
    current = tuple(int(part) for part in RUNTIME_VERSION.split("-")[0].split("."))
    assert current >= tuple(int(part) for part in MIN_RUNTIME_VERSION.split("."))
    assert current < tuple(int(part) for part in MAX_RUNTIME_VERSION.split("."))


def test_load_bundle_file_reads_and_verifies_offline(tmp_path: Path) -> None:
    loaded = load_bundle_file(_write(tmp_path, _document()), secret=SECRET)

    assert isinstance(loaded, LoadedBundle)
    assert loaded.digest == manifest_digest(_document()["manifest"])
    assert loaded.signed is True
    assert loaded.source == tmp_path / "bundle.json"
    assert loaded.cache_key == ("acme-corp", "petstore", "1.0.0")
    assert loaded.tenant_slug == "acme-corp"
    assert loaded.project_slug == "petstore"
    assert loaded.version_label == "1.0.0"


def test_loaded_bundle_compiles_the_routing_table() -> None:
    loaded = load_bundle_document(_document(), secret=SECRET)
    keys = {f"{operation.method} {operation.path_template}" for operation in loaded.operations}
    assert keys == {"GET /pets", "POST /pets"}


def test_loaded_bundle_carries_scenarios_and_chaos() -> None:
    loaded = load_bundle_document(_document(), secret=SECRET)

    assert set(loaded.scenarios) == {"quota-exceeded"}
    responses = loaded.scenarios["quota-exceeded"].operations["GET /pets"].responses
    assert [response.status for response in responses] == [429]
    assert responses[0].headers == (("Retry-After", "60"),)

    knobs = effective_knobs(loaded.chaos, "GET /pets")
    assert knobs.delay_ms == 250
    assert knobs.error_rate == 25


def test_loaded_bundle_exposes_fixture_references() -> None:
    loaded = load_bundle_document(_document(), secret=SECRET)
    assert [entry["name"] for entry in loaded.fixtures] == ["pets.json"]
    assert loaded.fixtures[0]["bytes"] == len(FIXTURES[0].content)


def test_loaded_bundle_decodes_fixture_data_for_templates() -> None:
    """Fixture payloads become template-readable values on the compiled spec (#4744, PMR-2.1)."""
    loaded = load_bundle_document(_document(), secret=SECRET)
    assert loaded.fixture_data == {"pets.json": {"pets": [{"id": 1}]}}
    assert loaded.to_compiled_spec().fixtures == loaded.fixture_data


def test_to_compiled_spec_matches_the_hosted_serving_unit() -> None:
    compiled = load_bundle_document(_document(), secret=SECRET).to_compiled_spec()

    assert compiled.revision_id == UUID(REVISION_ID)
    assert compiled.cache_key == ("acme-corp", "petstore", "1.0.0")
    assert compiled.spec == SPEC
    assert compiled.updated_at == BUNDLE_EPOCH
    assert len(compiled.operations) == 2
    assert set(compiled.scenarios) == {"quota-exceeded"}
    assert effective_knobs(compiled.chaos, "GET /pets").error_rate == 25


def test_non_uuid_revision_ids_load_with_a_derived_stable_uuid() -> None:
    identity = BundleIdentity(tenant="t", project="p", version="1.0.0", revision_id="rev-1")
    compiled = load_bundle_document(_document(identity=identity, secret=None)).to_compiled_spec()
    other = load_bundle_document(_document(identity=identity, secret=None)).to_compiled_spec()
    assert compiled.revision_id == other.revision_id
    assert isinstance(compiled.revision_id, UUID)


def test_bundle_without_settings_or_fixtures_still_loads() -> None:
    loaded = load_bundle_document(_document(mock_settings=None, fixtures=(), secret=None))
    assert loaded.scenarios == {}
    assert loaded.fixtures == ()
    assert loaded.signed is False
    assert effective_knobs(loaded.chaos, "GET /pets").delay_ms == 0


# ---------------------------------------------------------------------------
# Explicit incompatibility
# ---------------------------------------------------------------------------


def test_runtime_older_than_the_bundle_raises_incompatible() -> None:
    document = _document(secret=None)
    document["manifest"]["runtime"]["minRuntimeVersion"] = "99.0.0"
    document["manifestDigest"] = manifest_digest(document["manifest"])

    with pytest.raises(MockBundleIncompatibleError) as excinfo:
        load_bundle_document(document)

    assert excinfo.value.codes == ("runtime-too-old",)
    assert "99.0.0" in str(excinfo.value)
    assert RUNTIME_VERSION in str(excinfo.value)


def test_runtime_past_the_bundle_window_raises_incompatible() -> None:
    document = _document(secret=None)
    document["manifest"]["runtime"]["maxRuntimeVersion"] = "0.0.1"
    document["manifestDigest"] = manifest_digest(document["manifest"])

    with pytest.raises(MockBundleIncompatibleError) as excinfo:
        load_bundle_document(document)
    assert excinfo.value.codes == ("runtime-too-new",)


def test_unsupported_format_version_raises_incompatible() -> None:
    document = _document(secret=None)
    document["manifest"]["bundleFormatVersion"] = 99
    document["manifestDigest"] = manifest_digest(document["manifest"])

    with pytest.raises(MockBundleIncompatibleError) as excinfo:
        load_bundle_document(document)
    assert excinfo.value.codes == ("bundle-format-unsupported",)
    assert excinfo.value.as_dict()["problems"][0]["pointer"] == "/manifest/bundleFormatVersion"


def test_incompatibility_is_distinguishable_from_corruption() -> None:
    """An incompatible bundle is still a :class:`MockBundleError`, but a narrower one."""
    document = _document(secret=None)
    document["manifest"]["bundleFormatVersion"] = 99
    document["manifestDigest"] = manifest_digest(document["manifest"])

    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document(document)
    assert isinstance(excinfo.value, MockBundleIncompatibleError)

    tampered = _document(secret=None)
    tampered["spec"]["info"]["title"] = "Trojan"
    with pytest.raises(MockBundleError) as corrupt:
        load_bundle_document(tampered)
    assert not isinstance(corrupt.value, MockBundleIncompatibleError)


# ---------------------------------------------------------------------------
# Rejected bundles
# ---------------------------------------------------------------------------


def test_tampered_spec_is_rejected() -> None:
    document = _document()
    document["spec"]["paths"]["/pets"]["get"]["responses"]["200"]["description"] = "changed"

    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document(document, secret=SECRET)
    assert "digest-mismatch" in excinfo.value.codes


def test_wrong_secret_is_rejected() -> None:
    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document(_document(), secret="other")
    assert excinfo.value.codes == ("signature-invalid",)


def test_unsigned_bundle_is_rejected_when_a_signature_is_required() -> None:
    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document(_document(secret=None), require_signature=True)
    assert excinfo.value.codes == ("signature-missing",)


def test_credential_bearing_bundle_is_rejected() -> None:
    document = _document(secret=None)
    document["settings"]["scenarios"]["quota-exceeded"]["apiKey"] = "live-key"
    document["manifest"]["contents"]["settings"]["digest"] = content_digest(document["settings"])
    document["manifestDigest"] = manifest_digest(document["manifest"])

    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document(document)
    assert "credential-present" in excinfo.value.codes


def test_missing_file_reports_the_path(tmp_path: Path) -> None:
    with pytest.raises(MockBundleError, match="could not be read"):
        load_bundle_file(tmp_path / "absent.json")


def test_non_json_file_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "bundle.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(MockBundleError, match="not valid JSON"):
        load_bundle_file(path)


def test_non_bundle_document_is_rejected() -> None:
    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document({"hello": "world"})
    assert excinfo.value.codes == ("bundle-malformed",)


def test_error_renders_for_structured_logs() -> None:
    with pytest.raises(MockBundleError) as excinfo:
        load_bundle_document(_document(), secret="other")
    payload = excinfo.value.as_dict()
    assert json.loads(json.dumps(payload)) == payload
    assert payload["problems"][0]["code"] == "signature-invalid"


def test_file_load_names_the_source_in_errors(tmp_path: Path) -> None:
    path = _write(tmp_path, _document())
    with pytest.raises(MockBundleError, match=str(path)):
        load_bundle_file(path, secret="other")


# ---------------------------------------------------------------------------
# Offline guarantee
# ---------------------------------------------------------------------------


def test_loading_never_opens_a_database_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Guard the offline promise: any pool construction during a load is a regression."""
    import psycopg_pool

    def _explode(*args: object, **kwargs: object) -> None:
        raise AssertionError("bundle loading must not open a database connection")

    monkeypatch.setattr(psycopg_pool.AsyncConnectionPool, "__init__", _explode)
    monkeypatch.setattr(psycopg_pool.ConnectionPool, "__init__", _explode)

    loaded = load_bundle_file(_write(tmp_path, _document()), secret=SECRET)
    assert loaded.to_compiled_spec().spec == SPEC


def test_bundle_file_bytes_are_reproducible(tmp_path: Path) -> None:
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_dir.mkdir()
    second_dir.mkdir()
    assert _write(first_dir, _document()).read_bytes() == _write(second_dir, _document()).read_bytes()


def test_embedded_fixture_bytes_survive_the_round_trip(tmp_path: Path) -> None:
    document = json.loads(_write(tmp_path, _document()).read_text(encoding="utf-8"))
    assert base64.b64decode(document["fixtures"]["pets.json"]) == FIXTURES[0].content
