"""Tests for the on-demand export round-trip comparison — IXH-4.4 (#5112).

Pins the ticket's acceptance criteria on the REST side:

* **explicit and bounded** — the loop runs only when the route is posted to; one
  emit + one re-import, nothing persisted (asserted via the read-only dispatch);
* **differences are grouped** — ``matched`` carries every difference the fidelity
  report explains (paired with its finding), ``unexplained`` carries the rest, and
  ``overclaims`` carries ``OK`` findings reality contradicts;
* **skip with an explanation** — a target with no import adapter (``sample``)
  returns ``status: unsupported`` with the matrix's own human-readable reason,
  never a silent omission;
* **reconciles with the 1.7 matrix** — for the corpus's representative OpenAPI
  entry, the Studio loop and :func:`app.roundtrip_matrix.run_roundtrip` agree on
  the verdict and the unexplained set;
* **reproduction provenance** — the response carries fingerprints and
  emitter/apiome/registry versions (the issue-report coordinates) without any
  source bytes;
* **route wiring** — auth required, loader errors map to 404, an unknown target
  to 400, and the response JSON uses the shared serialization (``construct``
  alias on loss items).
"""

from __future__ import annotations

import json
from typing import Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.export_roundtrip as export_roundtrip_module
from app.auth import validate_authentication
from app.canonical_model import CanonicalApi
from app.emitter import load_builtin_emitters
from app.export_roundtrip import run_export_roundtrip
from app.export_source import ExportSource, ExportSourceError
from app.import_source import (
    ImportSourceError,
    get_import_source,
    load_builtin_import_sources,
)
from app.lossiness import (
    LossinessKind,
    LossinessReport,
    LossinessSeverity,
    LossItem,
)
from app.main import app
from app.roundtrip_matrix import MatrixCellStatus

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _registries() -> None:
    """Emitters + import adapters registered for every test."""
    load_builtin_emitters()
    load_builtin_import_sources()


#: A small OpenAPI 3.1 document imported through the real adapter, so the source
#: model's keys are exactly what a re-import produces (the same precondition the
#: 1.7 matrix establishes by importing corpus entries).
_OPENAPI_DOC = {
    "openapi": "3.1.0",
    "info": {"title": "Round Trip Probe", "version": "1.0.0"},
    "paths": {
        "/users/{id}": {
            "get": {
                "operationId": "getUser",
                "tags": ["Users"],
                "parameters": [
                    {
                        "name": "id",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    }
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/User"}
                            }
                        },
                    }
                },
            }
        }
    },
    "components": {
        "schemas": {
            "User": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            }
        }
    },
}


def _imported_api() -> CanonicalApi:
    """Import the probe document to a canonical model through the real adapter."""
    adapter = get_import_source("openapi")
    assert adapter is not None
    native = adapter.parse(json.dumps(_OPENAPI_DOC), source_label="roundtrip-test")
    return adapter.normalize(native, include_raw=False)


def _source(api: Optional[CanonicalApi] = None) -> ExportSource:
    return ExportSource(
        api=api if api is not None else _imported_api(),
        artifact_id="artifact-1",
        version_record_id="rev-1",
        version_label="1.0.0",
    )


# ---------------------------------------------------------------------------
# Unit: run_export_roundtrip
# ---------------------------------------------------------------------------


def test_clean_roundtrip_passes_with_equal_fingerprints() -> None:
    """An imported OpenAPI source round-trips through openapi with zero differences."""
    resp = run_export_roundtrip(_source(), "openapi", version="1.0.0")
    assert resp.status is MatrixCellStatus.PASS
    assert resp.reason is None
    assert resp.diff_count == 0
    assert resp.matched == [] and resp.unexplained == [] and resp.overclaims == []
    assert resp.adapter_key == "openapi"
    assert resp.emit_key == "openapi"
    assert resp.target == "openapi-3.1"
    assert resp.source_fingerprint == resp.reimported_fingerprint
    # Echoed coordinates + reproduction provenance ride along.
    assert resp.artifact == "artifact-1"
    assert resp.version == "1.0.0"
    assert resp.version_record_id == "rev-1"
    assert resp.apiome_version and resp.registry_version and resp.emitter_version


def test_no_import_adapter_is_skipped_with_explanation() -> None:
    """The sample emitter has no re-import adapter: unsupported, with the matrix's reason."""
    resp = run_export_roundtrip(_source(), "sample")
    assert resp.status is MatrixCellStatus.UNSUPPORTED
    assert resp.adapter_key is None
    assert resp.reason is not None and "No import adapter" in resp.reason
    # The loop never ran: no diff groups, no re-imported fingerprint.
    assert resp.diff_count == 0
    assert resp.matched == [] and resp.unexplained == [] and resp.overclaims == []
    assert resp.reimported_fingerprint is None


def test_explained_difference_is_matched_to_its_finding() -> None:
    """A difference the fidelity report explains lands in ``matched``, paired."""
    api = _imported_api()
    mutated = api.model_copy(update={"types": [t for t in api.types if t.key != "User"]})
    real_dispatch = export_roundtrip_module.dispatch_from_source

    def dispatch_with_drop_finding(*args, **kwargs):
        dispatch = real_dispatch(*args, **kwargs)
        report = LossinessReport(
            items=[
                LossItem(
                    construct_key="User",
                    kind=LossinessKind.DROP,
                    severity=LossinessSeverity.WARN,
                    message="target cannot carry User",
                )
            ]
        )
        fidelity = dispatch.fidelity.model_copy(update={"report": report})
        return dispatch.model_copy(update={"fidelity": fidelity})

    with (
        patch.object(export_roundtrip_module, "dispatch_from_source", dispatch_with_drop_finding),
        patch.object(export_roundtrip_module, "reimport_emitted", lambda *a, **k: mutated),
    ):
        resp = run_export_roundtrip(_source(api), "openapi")

    assert resp.status is MatrixCellStatus.PASS
    assert resp.diff_count == 1 and resp.matched_count == 1
    assert resp.unexplained == [] and resp.overclaims == []
    [pair] = resp.matched
    assert pair.entry.key == "User" and pair.entry.change.value == "removed"
    assert pair.finding.construct_key == "User" and pair.finding.kind is LossinessKind.DROP


def test_unexplained_difference_fails_and_is_listed() -> None:
    """A difference no finding accounts for fails the verdict and lands in ``unexplained``."""
    api = _imported_api()
    mutated = api.model_copy(update={"types": [t for t in api.types if t.key != "User"]})

    with patch.object(export_roundtrip_module, "reimport_emitted", lambda *a, **k: mutated):
        resp = run_export_roundtrip(_source(api), "openapi")

    assert resp.status is MatrixCellStatus.FAIL
    assert resp.reason is not None and "unexplained" in resp.reason
    assert any(e.key == "User" for e in resp.unexplained)
    # The grouping partitions the diff: every entry is explained or unexplained.
    assert resp.diff_count == resp.matched_count + len(resp.unexplained)
    assert resp.source_fingerprint != resp.reimported_fingerprint


def test_reimport_failure_is_reported_not_raised() -> None:
    """An artifact its own adapter cannot re-ingest is a reported failure, not a 500."""

    def boom(*args, **kwargs):
        raise ImportSourceError("synthetic parse failure")

    with patch.object(export_roundtrip_module, "reimport_emitted", boom):
        resp = run_export_roundtrip(_source(), "openapi")

    assert resp.status is MatrixCellStatus.FAIL
    assert resp.reason is not None and resp.reason.startswith("Re-import failed:")
    assert resp.adapter_key == "openapi"
    assert resp.reimported_fingerprint is None
    assert resp.diff_count == 0 and resp.matched == []


def test_diff_partition_invariant_against_real_loop() -> None:
    """Whatever the verdict, the response's groups partition the empirical diff."""
    resp = run_export_roundtrip(_source(), "openapi")
    assert resp.diff_count == resp.matched_count + len(resp.unexplained)
    assert len(resp.matched) == resp.matched_count


def test_reconciles_with_the_17_matrix_for_a_corpus_entry() -> None:
    """AC: Studio results reconcile with the 1.7 matrix for corpus entries."""
    from corpus_roundtrip import _import_entry, representatives_by_format

    from app.roundtrip_matrix import production_emit_targets, run_roundtrip

    entry = representatives_by_format().get("openapi")
    if entry is None:  # pragma: no cover - corpus always ships openapi entries
        pytest.skip("no runnable openapi corpus representative in this runtime")
    api = _import_entry(entry)
    [target] = [t for t in production_emit_targets() if t.descriptor.key == "openapi"]

    matrix_cell = run_roundtrip(api, target, source_format="openapi", corpus_path=entry.path)
    studio = run_export_roundtrip(_source(api), "openapi")

    assert studio.status is matrix_cell.status
    assert [e.key for e in studio.unexplained] == [e.key for e in matrix_cell.unexplained]
    assert [i.construct_key for i in studio.overclaims] == [
        i.construct_key for i in matrix_cell.overclaims
    ]


# ---------------------------------------------------------------------------
# Route wiring
# ---------------------------------------------------------------------------


def _post_roundtrip(body: dict) -> "TestClient.response":
    return client.post("/v1/export/test-tenant/roundtrip", json=body)


def test_route_requires_authentication() -> None:
    app.dependency_overrides.pop(validate_authentication, None)
    response = _post_roundtrip({"artifact": "artifact-1", "target": "openapi"})
    assert response.status_code in (401, 403)


def test_route_maps_unknown_artifact_to_404() -> None:
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("Artifact 'nope' has no versions.", status_code=404),
        ):
            response = _post_roundtrip({"artifact": "nope", "target": "openapi"})
        assert response.status_code == 404
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_route_maps_unknown_target_to_400() -> None:
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = _post_roundtrip({"artifact": "artifact-1", "target": "not-a-target"})
        assert response.status_code == 400
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_route_returns_full_envelope_with_shared_serialization() -> None:
    """The JSON envelope carries the verdict, groups, and provenance; loss items use
    the shared ``construct`` alias so the UI mirror types apply unchanged."""
    api = _imported_api()
    mutated = api.model_copy(update={"types": [t for t in api.types if t.key != "User"]})
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with (
            patch("app.export_routes.load_export_source", return_value=_source(api)),
            patch.object(export_roundtrip_module, "reimport_emitted", lambda *a, **k: mutated),
        ):
            response = _post_roundtrip(
                {"artifact": "artifact-1", "version": "1.0.0", "target": "openapi"}
            )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "fail"
        assert body["artifact"] == "artifact-1"
        assert body["target"] == "openapi-3.1"
        assert body["adapter_key"] == "openapi"
        assert any(e["key"] == "User" and e["change"] == "removed" for e in body["unexplained"])
        assert body["diff_count"] == body["matched_count"] + len(body["unexplained"])
        assert body["apiome_version"] and body["registry_version"] and body["emitter_version"]
        assert body["source_fingerprint"] and body["reimported_fingerprint"]
        # Shared serialization: a matched pair's finding keys its construct as "construct".
        for pair in body["matched"]:
            assert "construct" in pair["finding"]
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_route_skip_envelope_for_unsupported_target() -> None:
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = _post_roundtrip({"artifact": "artifact-1", "target": "sample"})
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "unsupported"
        assert body["adapter_key"] is None
        assert "No import adapter" in body["reason"]
    finally:
        app.dependency_overrides.pop(validate_authentication, None)
