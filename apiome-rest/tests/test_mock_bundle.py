"""Portable mock bundle format tests (#4741, PMR-1.1).

Covers the four acceptance criteria: a bundle is self-contained (loads offline), runtime/manifest
incompatibility is explicit, the same version yields the same manifest digest, and no tenant
credentials survive into the document.
"""

from __future__ import annotations

import base64
import copy
import json

import pytest

from app.mock_bundle import (
    BUNDLE_FORMAT,
    BUNDLE_FORMAT_VERSION,
    CODE_BUNDLE_FORMAT_UNSUPPORTED,
    CODE_CREDENTIAL_PRESENT,
    CODE_DIGEST_MISMATCH,
    CODE_MALFORMED,
    CODE_RUNTIME_TOO_NEW,
    CODE_RUNTIME_TOO_OLD,
    CODE_RUNTIME_VERSION_INVALID,
    CODE_SIGNATURE_INVALID,
    CODE_SIGNATURE_MISSING,
    MAX_RUNTIME_VERSION,
    MIN_RUNTIME_VERSION,
    PAYLOAD_TYPE,
    BundleIdentity,
    FixtureSource,
    build_bundle,
    bundle_bytes,
    canonical_json,
    content_digest,
    find_credential_fields,
    manifest_digest,
    redact_mock_settings,
    verify_bundle,
    version_digest,
)

SECRET = "shared-bundle-secret"
RUNTIME = "0.2.0"

IDENTITY = BundleIdentity(
    tenant="acme-corp",
    project="petstore",
    version="1.0.0",
    revision_id="11111111-2222-3333-4444-555555555555",
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
                    }
                }
            }
        }
    },
}

MOCK_SETTINGS = {
    "mode": "private",
    "scenarios": {
        "quota-exceeded": {
            "description": "Throttled.",
            "operations": {
                "GET /pets": {"responses": [{"status": 429, "headers": {"Retry-After": "60"}}]}
            },
        }
    },
    "chaos": {"default": {"delayMs": 100}},
}

FIXTURES = (
    FixtureSource(name="pets.json", content=b'{"pets":[{"id":1}]}'),
    FixtureSource(name="empty.json", content=b"{}"),
)


def _bundle(**overrides):
    """Build a signed bundle with the shared inputs, overriding selected build arguments."""
    kwargs = {
        "identity": IDENTITY,
        "spec": SPEC,
        "mock_settings": MOCK_SETTINGS,
        "fixtures": FIXTURES,
        "secret": SECRET,
    }
    kwargs.update(overrides)
    return build_bundle(**kwargs)


# ---------------------------------------------------------------------------
# Canonical serialization
# ---------------------------------------------------------------------------


def test_canonical_json_is_key_order_independent() -> None:
    assert canonical_json({"b": 1, "a": {"d": 2, "c": 3}}) == canonical_json(
        {"a": {"c": 3, "d": 2}, "b": 1}
    )
    assert canonical_json({"a": 1, "b": 2}) == '{"a":1,"b":2}'


def test_content_digest_is_prefixed_and_stable() -> None:
    digest = content_digest({"a": 1})
    assert digest.startswith("sha256:")
    assert len(digest) == len("sha256:") + 64
    assert digest == content_digest({"a": 1})
    assert digest != content_digest({"a": 2})


def test_version_digest_covers_identity_and_spec() -> None:
    other = BundleIdentity(
        tenant=IDENTITY.tenant,
        project=IDENTITY.project,
        version="2.0.0",
        revision_id=IDENTITY.revision_id,
    )
    assert version_digest(IDENTITY, SPEC) == version_digest(IDENTITY, dict(SPEC))
    assert version_digest(IDENTITY, SPEC) != version_digest(other, SPEC)
    assert version_digest(IDENTITY, SPEC) != version_digest(IDENTITY, {"openapi": "3.1.0"})


# ---------------------------------------------------------------------------
# AC: publishing the same version yields the same manifest digest
# ---------------------------------------------------------------------------


def test_bundle_is_byte_for_byte_deterministic() -> None:
    first = _bundle()
    second = _bundle()
    assert first == second
    assert bundle_bytes(first) == bundle_bytes(second)
    assert first["manifestDigest"] == second["manifestDigest"]


def test_fixture_order_does_not_change_the_digest() -> None:
    forward = _bundle(fixtures=FIXTURES)
    reversed_order = _bundle(fixtures=tuple(reversed(FIXTURES)))
    assert forward["manifestDigest"] == reversed_order["manifestDigest"]


def test_manifest_digest_changes_with_content() -> None:
    baseline = _bundle()["manifestDigest"]
    assert _bundle(spec={**SPEC, "info": {"title": "Other", "version": "1.0.0"}})["manifestDigest"] != baseline
    assert _bundle(mock_settings={"scenarios": {}})["manifestDigest"] != baseline
    assert _bundle(fixtures=())["manifestDigest"] != baseline


def test_signature_is_not_part_of_the_manifest_digest() -> None:
    signed = _bundle()
    unsigned = _bundle(secret=None)
    assert unsigned["signature"] is None
    assert signed["manifestDigest"] == unsigned["manifestDigest"]


def test_manifest_carries_no_wall_clock() -> None:
    text = canonical_json(_bundle()["manifest"])
    for field in ("generatedAt", "exportedAt", "timestamp", "updatedAt"):
        assert field not in text


# ---------------------------------------------------------------------------
# Bundle shape
# ---------------------------------------------------------------------------


def test_bundle_shape_and_manifest_contents() -> None:
    bundle = _bundle()
    assert bundle["bundleFormat"] == BUNDLE_FORMAT
    manifest = bundle["manifest"]
    assert manifest["bundleFormatVersion"] == BUNDLE_FORMAT_VERSION
    assert manifest["runtime"] == {
        "minRuntimeVersion": MIN_RUNTIME_VERSION,
        "maxRuntimeVersion": MAX_RUNTIME_VERSION,
    }
    assert manifest["api"] == {
        "tenant": "acme-corp",
        "project": "petstore",
        "version": "1.0.0",
        "revisionId": IDENTITY.revision_id,
        "published": True,
        "protocol": "openapi",
    }
    assert manifest["versionDigest"] == version_digest(IDENTITY, SPEC)
    assert manifest["contents"]["spec"]["digest"] == content_digest(SPEC)
    assert [entry["name"] for entry in manifest["contents"]["fixtures"]] == ["empty.json", "pets.json"]
    assert manifest["contents"]["fixtures"][1]["bytes"] == len(FIXTURES[0].content)
    assert bundle["manifestDigest"] == manifest_digest(manifest)
    assert bundle["signature"]["payloadType"] == PAYLOAD_TYPE
    assert bundle["signature"]["alg"] == "hmac-sha256"


def test_identity_omits_protocol_when_unset() -> None:
    identity = BundleIdentity(tenant="t", project="p", version="1", revision_id="r")
    assert "protocol" not in identity.as_dict()


def test_fixtures_are_embedded_so_the_bundle_loads_offline() -> None:
    bundle = _bundle()
    decoded = base64.b64decode(bundle["fixtures"]["pets.json"])
    assert json.loads(decoded) == {"pets": [{"id": 1}]}


def test_bundle_bytes_round_trip_through_json() -> None:
    bundle = _bundle()
    assert json.loads(bundle_bytes(bundle).decode("utf-8")) == bundle


def test_duplicate_fixture_names_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate fixture name"):
        _bundle(fixtures=(FixtureSource("a.json", b"1"), FixtureSource("a.json", b"2")))


# ---------------------------------------------------------------------------
# AC: no tenant credentials
# ---------------------------------------------------------------------------


def test_only_allowlisted_settings_keys_are_bundled() -> None:
    settings, _ = redact_mock_settings(MOCK_SETTINGS)
    assert set(settings) == {"scenarios", "chaos"}
    assert "mode" not in settings


def test_response_correlation_travels_in_the_bundle() -> None:
    """A correlated version must behave the same offline, so its block is bundled (#5527)."""
    block = {"mode": "inferred", "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}}}

    settings, redactions = redact_mock_settings({"mode": "private", "responseCorrelation": block})

    assert settings == {"responseCorrelation": block}
    assert redactions == ()


def test_credential_keys_are_dropped_and_recorded() -> None:
    settings, redactions = redact_mock_settings(
        {
            "scenarios": {
                "s": {
                    "operations": {
                        "GET /pets": {
                            "responses": [
                                {
                                    "status": 200,
                                    "headers": {
                                        "Authorization": "Bearer abc123",
                                        "X-Api-Key": "k-1",
                                        "Retry-After": "60",
                                    },
                                }
                            ]
                        }
                    }
                }
            }
        }
    )
    headers = settings["scenarios"]["s"]["operations"]["GET /pets"]["responses"][0]["headers"]
    assert headers == {"Retry-After": "60"}
    assert redactions == (
        "/scenarios/s/operations/GET ~1pets/responses/0/headers/Authorization",
        "/scenarios/s/operations/GET ~1pets/responses/0/headers/X-Api-Key",
    )


def test_redaction_pointers_are_published_in_the_manifest() -> None:
    bundle = _bundle(mock_settings={"scenarios": {"s": {"token": "abc"}}})
    assert bundle["manifest"]["redactions"] == ["/scenarios/s/token"]
    assert verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET).ok


def test_blank_placeholders_are_not_treated_as_credentials() -> None:
    settings, redactions = redact_mock_settings(
        {"scenarios": {"s": {"apiKey": "", "token": None, "secrets": {}}}}
    )
    assert redactions == ()
    assert settings["scenarios"]["s"] == {"apiKey": "", "token": None, "secrets": {}}


def test_a_credential_cannot_hide_inside_a_wrapper_object() -> None:
    settings, redactions = redact_mock_settings(
        {"scenarios": {"s": {"token": {"value": "abc"}, "credentials": ["k1", "k2"]}}}
    )
    assert settings["scenarios"]["s"] == {}
    assert redactions == ("/scenarios/s/credentials", "/scenarios/s/token")
    assert find_credential_fields({"token": {"value": "abc"}}) == ["/token"]


def test_find_credential_fields_detects_keys_and_value_markers() -> None:
    found = find_credential_fields(
        {
            "client_secret": "s3cr3t",
            "nested": [{"pem": "-----BEGIN PRIVATE KEY-----"}, {"note": "fine"}],
            "header": "Bearer abc",
            "count": 3,
        }
    )
    assert found == ["/client_secret", "/header", "/nested/0/pem"]


def test_key_matching_ignores_separators_and_case() -> None:
    found = find_credential_fields({"API_KEY": "a", "apiKey": "b", "Api-Key": "c", "keyword": "d"})
    assert found == ["/API_KEY", "/Api-Key", "/apiKey"]


def test_verify_rejects_a_bundle_with_smuggled_credentials() -> None:
    bundle = _bundle()
    bundle["settings"]["scenarios"]["quota-exceeded"]["password"] = "hunter2"
    bundle["manifest"]["contents"]["settings"]["digest"] = content_digest(bundle["settings"])
    bundle["manifestDigest"] = manifest_digest(bundle["manifest"])
    result = verify_bundle(bundle, runtime_version=RUNTIME)
    assert not result.ok
    assert [problem.code for problem in result.problems] == [CODE_CREDENTIAL_PRESENT]
    assert result.problems[0].pointer == "/settings/scenarios/quota-exceeded/password"


def test_verify_rejects_credentials_hidden_in_a_fixture() -> None:
    bundle = _bundle(
        fixtures=(FixtureSource("creds.json", b'{"apiKey":"live-key"}'),),
        secret=None,
    )
    result = verify_bundle(bundle, runtime_version=RUNTIME)
    assert [problem.code for problem in result.problems] == [CODE_CREDENTIAL_PRESENT]
    assert result.problems[0].pointer == "/fixtures/creds.json/apiKey"


def test_spec_security_schemes_are_not_flagged_as_credentials() -> None:
    spec = {
        **SPEC,
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer", "name": "Authorization"}
            }
        },
    }
    assert verify_bundle(_bundle(spec=spec), runtime_version=RUNTIME, secret=SECRET).ok


# ---------------------------------------------------------------------------
# AC: runtime/manifest incompatibility is explicit
# ---------------------------------------------------------------------------


def test_verify_accepts_a_freshly_built_bundle() -> None:
    result = verify_bundle(_bundle(), runtime_version=RUNTIME, secret=SECRET)
    assert result.ok
    assert result.problems == ()
    assert result.digest == _bundle()["manifestDigest"]
    assert result.summary() == "verified"
    assert not result.incompatible


def test_runtime_older_than_the_manifest_window_is_explicit() -> None:
    result = verify_bundle(_bundle(), runtime_version="0.1.9", secret=SECRET)
    assert not result.ok
    assert result.incompatible
    codes = [problem.code for problem in result.problems]
    assert codes == [CODE_RUNTIME_TOO_OLD]
    assert MIN_RUNTIME_VERSION in result.problems[0].message
    assert "0.1.9" in result.problems[0].message


def test_runtime_past_the_manifest_window_is_explicit() -> None:
    result = verify_bundle(_bundle(), runtime_version="1.0.0", secret=SECRET)
    assert result.incompatible
    assert [problem.code for problem in result.problems] == [CODE_RUNTIME_TOO_NEW]
    assert MAX_RUNTIME_VERSION in result.problems[0].message


def test_unsupported_bundle_format_version_is_explicit() -> None:
    bundle = _bundle(secret=None)
    bundle["manifest"]["bundleFormatVersion"] = 99
    bundle["manifestDigest"] = manifest_digest(bundle["manifest"])
    result = verify_bundle(bundle, runtime_version=RUNTIME)
    assert result.incompatible
    assert [problem.code for problem in result.problems] == [CODE_BUNDLE_FORMAT_UNSUPPORTED]


def test_unparseable_versions_are_reported_not_silently_accepted() -> None:
    assert [p.code for p in verify_bundle(_bundle(secret=None), runtime_version="not-a-version").problems] == [
        CODE_RUNTIME_VERSION_INVALID
    ]

    bundle = _bundle(secret=None)
    bundle["manifest"]["runtime"]["minRuntimeVersion"] = "one.two.three"
    bundle["manifestDigest"] = manifest_digest(bundle["manifest"])
    result = verify_bundle(bundle, runtime_version=RUNTIME)
    assert [problem.code for problem in result.problems] == [CODE_RUNTIME_VERSION_INVALID]


def test_prerelease_runtime_versions_compare_on_their_core() -> None:
    assert verify_bundle(_bundle(secret=None), runtime_version="0.2.0-rc.1+build7").ok


def test_open_ended_runtime_window_is_allowed() -> None:
    bundle = _bundle(secret=None)
    bundle["manifest"]["runtime"]["maxRuntimeVersion"] = None
    bundle["manifestDigest"] = manifest_digest(bundle["manifest"])
    assert verify_bundle(bundle, runtime_version="9.9.9").ok


def test_compatibility_is_skipped_when_no_runtime_version_is_given() -> None:
    assert verify_bundle(_bundle(), secret=SECRET).ok


# ---------------------------------------------------------------------------
# Tamper detection
# ---------------------------------------------------------------------------


def test_tampered_spec_fails_the_digest_check() -> None:
    bundle = _bundle()
    bundle["spec"]["info"]["title"] = "Trojan Store"
    result = verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET)
    assert not result.ok
    assert CODE_DIGEST_MISMATCH in {problem.code for problem in result.problems}
    assert "/spec" in {problem.pointer for problem in result.problems}


def test_tampered_settings_fail_the_digest_check() -> None:
    bundle = _bundle()
    bundle["settings"]["chaos"]["default"]["delayMs"] = 30_000
    result = verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET)
    assert "/settings" in {problem.pointer for problem in result.problems}


def test_tampered_fixture_fails_the_digest_check() -> None:
    bundle = _bundle()
    bundle["fixtures"]["pets.json"] = base64.b64encode(b'{"pets":[{"id":99}]}').decode("ascii")
    result = verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET)
    assert [problem.code for problem in result.problems] == [CODE_DIGEST_MISMATCH]
    assert result.problems[0].pointer == "/fixtures/pets.json"


def test_missing_fixture_payload_is_reported() -> None:
    bundle = _bundle(secret=None)
    del bundle["fixtures"]["pets.json"]
    result = verify_bundle(bundle, runtime_version=RUNTIME)
    assert [problem.code for problem in result.problems] == [CODE_MALFORMED]


def test_non_base64_fixture_payload_is_reported() -> None:
    bundle = _bundle(secret=None)
    bundle["fixtures"]["pets.json"] = "not base64!!"
    assert [p.code for p in verify_bundle(bundle, runtime_version=RUNTIME).problems] == [CODE_MALFORMED]


def test_rewriting_the_manifest_breaks_the_published_digest() -> None:
    bundle = _bundle()
    bundle["manifest"]["api"]["tenant"] = "attacker"
    result = verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET)
    codes = {problem.code for problem in result.problems}
    assert CODE_DIGEST_MISMATCH in codes
    assert CODE_SIGNATURE_INVALID in codes


def test_resigning_a_rewritten_manifest_needs_the_secret() -> None:
    bundle = _bundle()
    bundle["manifest"]["api"]["tenant"] = "attacker"
    bundle["manifestDigest"] = manifest_digest(bundle["manifest"])
    forged = build_bundle(
        identity=IDENTITY, spec=SPEC, mock_settings=MOCK_SETTINGS, fixtures=FIXTURES, secret="wrong"
    )
    bundle["signature"] = forged["signature"]
    result = verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET)
    assert [problem.code for problem in result.problems] == [CODE_SIGNATURE_INVALID]


# ---------------------------------------------------------------------------
# Signature handling
# ---------------------------------------------------------------------------


def test_wrong_secret_fails_verification() -> None:
    result = verify_bundle(_bundle(), runtime_version=RUNTIME, secret="other-secret")
    assert [problem.code for problem in result.problems] == [CODE_SIGNATURE_INVALID]


def test_unsigned_bundle_is_valid_until_a_signature_is_required() -> None:
    unsigned = _bundle(secret=None)
    assert verify_bundle(unsigned, runtime_version=RUNTIME).ok
    assert [
        problem.code
        for problem in verify_bundle(unsigned, runtime_version=RUNTIME, require_signature=True).problems
    ] == [CODE_SIGNATURE_MISSING]
    assert [
        problem.code for problem in verify_bundle(unsigned, runtime_version=RUNTIME, secret=SECRET).problems
    ] == [CODE_SIGNATURE_MISSING]


def test_signed_bundle_without_a_secret_can_still_be_required_to_verify() -> None:
    signed = _bundle()
    assert verify_bundle(signed, runtime_version=RUNTIME).ok
    assert [
        problem.code
        for problem in verify_bundle(signed, runtime_version=RUNTIME, require_signature=True).problems
    ] == [CODE_SIGNATURE_MISSING]


def test_wrong_signature_payload_type_is_rejected() -> None:
    bundle = _bundle()
    bundle["signature"]["payloadType"] = "application/json"
    assert [
        problem.code for problem in verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET).problems
    ] == [CODE_SIGNATURE_INVALID]


# ---------------------------------------------------------------------------
# Malformed documents
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("document", [None, "text", 42, [], {"manifest": "nope"}])
def test_non_bundle_documents_are_rejected(document: object) -> None:
    result = verify_bundle(document, runtime_version=RUNTIME)
    assert not result.ok
    assert result.problems[0].code == CODE_MALFORMED
    assert result.digest is None


def test_wrong_format_id_is_rejected() -> None:
    bundle = _bundle(secret=None)
    bundle["bundleFormat"] = "apiome.mock.bundle/v2"
    assert CODE_MALFORMED in {p.code for p in verify_bundle(bundle, runtime_version=RUNTIME).problems}


def test_missing_manifest_digest_is_reported() -> None:
    bundle = _bundle(secret=None)
    del bundle["manifestDigest"]
    assert CODE_MALFORMED in {p.code for p in verify_bundle(bundle, runtime_version=RUNTIME).problems}


def test_missing_contents_block_is_reported() -> None:
    bundle = _bundle(secret=None)
    del bundle["manifest"]["contents"]
    bundle["manifestDigest"] = manifest_digest(bundle["manifest"])
    assert CODE_MALFORMED in {p.code for p in verify_bundle(bundle, runtime_version=RUNTIME).problems}


def test_every_problem_is_reported_not_just_the_first() -> None:
    bundle = _bundle()
    bundle["spec"]["info"]["title"] = "Tampered"
    bundle["settings"]["scenarios"]["quota-exceeded"]["secret"] = "leak"
    result = verify_bundle(bundle, runtime_version="0.1.0", secret="wrong")
    codes = {problem.code for problem in result.problems}
    assert codes == {
        CODE_RUNTIME_TOO_OLD,
        CODE_DIGEST_MISMATCH,
        CODE_SIGNATURE_INVALID,
        CODE_CREDENTIAL_PRESENT,
    }
    # Both edits are reported (spec payload and settings payload), and the summary names them all.
    assert len(result.problems) == 5
    summary = result.summary()
    assert all(problem.code in summary for problem in result.problems)


def test_problem_rendering_is_json_safe() -> None:
    problems = verify_bundle(_bundle(), runtime_version="0.1.0", secret=SECRET).problems
    payload = [problem.as_dict() for problem in problems]
    assert json.loads(json.dumps(payload)) == payload
    assert payload[0]["code"] == CODE_RUNTIME_TOO_OLD


def test_deep_copied_bundle_still_verifies() -> None:
    """Serialization round-trips (copy, JSON) must not disturb verification."""
    bundle = json.loads(json.dumps(copy.deepcopy(_bundle())))
    assert verify_bundle(bundle, runtime_version=RUNTIME, secret=SECRET).ok
