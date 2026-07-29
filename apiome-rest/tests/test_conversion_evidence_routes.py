"""Tests for the conversion provenance evidence history routes — CPDO-3.3 (#4803).

Pins the read contract on both surfaces:

* ``GET /v1/catalog/{tenant}/{item}/conversions`` — the catalog item's history list: newest-first
  ledger rows with the empty-string storage sentinels normalized to ``null``, plus
  ``currentSourceHash`` so a client can mark rows as historic; a broken source read yields
  ``null``, never a 500.
* ``GET /v1/catalog/{tenant}/{item}/conversions/{id}/evidence`` — one page of the *stored*
  snapshot graph (never a rebuild), gated ``imports:view`` after the item lookup; a provenance row
  belonging to another item 404s; the three degrade states (``predates_snapshots`` /
  ``snapshot_missing`` / ``unreadable``) are HTTP 200 data, never errors.
* the project-side twins under ``/v1/projects/{tenant}/{project}/conversions``, which stay
  readable when the source catalog item is gone.

Also extends the CPDO-3.2 redaction-by-construction guarantee to the snapshot path: the captured
raw source text never appears in a stored snapshot or an evidence response.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.database as database
from app.auth import validate_authentication
from app.catalog_conversion import build_conversion_source
from app.conversion_job import preview_conversion
from app.conversion_projection import (
    paginate_conversion_evidence,
    summarize_conversion_manifest,
)
from app.main import app
from app.payload_analysis import source_digest

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


# A catalog item whose captured GraphQL source reconstructs into a real canonical model. The SDL
# doubles as the redaction sentinel: it must never appear in a snapshot or an evidence response.
_GRAPHQL_SDL = "type Query { pingEvidenceSentinel: String }"
_CATALOG_ITEM = {
    "id": "cat-1",
    "tenant_id": "test-tenant-id",
    "name": "Ping API",
    "slug": "ping-api",
    "publishable": False,
    "source_format": "graphql",
    "protocol": None,
    "tool_versions": {"graphql-lib": "1.2"},
    "format_metadata": {"sourceContent": _GRAPHQL_SDL, "sourceLabel": "schema.graphql"},
}

# The real manifest a conversion of that item is approved under — built through the same path the
# commit uses, so the stored-snapshot fixtures are the genuine article, hash and all.
_MANIFEST = preview_conversion(
    build_conversion_source(_CATALOG_ITEM, source_version_id="rev-1", analysis=None)
).manifest
_SUMMARY = summarize_conversion_manifest(_MANIFEST)

_SOURCE_HASH = source_digest(_GRAPHQL_SDL)


def _stored_manifest_json() -> dict:
    """The snapshot store's manifest JSON: source ids nulled, exactly as the commit path stores it."""
    stored = _MANIFEST.model_copy(
        update={
            "source": _MANIFEST.source.model_copy(
                update={"project_id": None, "version_record_id": None}
            )
        }
    )
    return stored.model_dump(mode="json")


def _snapshot_row() -> dict:
    return {
        "tenant_id": "test-tenant-id",
        "manifest_hash": _MANIFEST.manifest_hash,
        "schema_version": _MANIFEST.schema_version,
        "conversion_mode": _MANIFEST.conversion_mode,
        "source_format": "graphql",
        "target_format": _MANIFEST.target_format,
        "tool_versions": dict(_MANIFEST.tool_versions),
        "defaults": dict(_MANIFEST.defaults),
        "manifest": _stored_manifest_json(),
        "node_count": len(_MANIFEST.nodes),
        "edge_count": len(_MANIFEST.edges),
        "truncated": _MANIFEST.truncated,
        "created_by": "test-user-id",
        "created_at": "2026-07-01T00:00:00Z",
    }


def _row(**overrides) -> dict:
    """One enriched conversion_provenance row, as the history DAO reads return them."""
    row = {
        "id": "prov-1",
        "tenant_id": "test-tenant-id",
        "source_project_id": "cat-1",
        "source_version_id": "rev-1",
        "source_format": "graphql",
        "source_protocol": None,
        "source_version_label": "1.0",
        "source_tool_versions": {"graphql-lib": "1.2"},
        "target_project_id": "proj-9",
        "target_version_id": "ver-9",
        "target_version_label": "1.0.0",
        "fidelity_report": {"grade": "C"},
        "fidelity_score": 74,
        "fidelity_grade": "C",
        "fidelity_tier": "medium",
        "lint_score": 88,
        "lint_grade": "B",
        "converter_tool_versions": {"apiome-rest": "9.9.9", "conversion-mode": "lossy"},
        "reconverted": False,
        "projection_manifest_hash": _MANIFEST.manifest_hash,
        "projection_manifest": _SUMMARY.model_dump(mode="json"),
        "source_hash": _SOURCE_HASH,
        "created_by": "test-user-id",
        "created_at": "2026-07-01T00:00:00Z",
        "snapshot_available": True,
        "source_project_name": "Ping API",
        "source_project_deleted_at": None,
        "target_project_name": "Ping API (OpenAPI)",
        "target_project_slug": "ping-api-openapi",
        "target_project_deleted_at": None,
    }
    row.update(overrides)
    return row


def _legacy_row() -> dict:
    """A pre-CPDO-3.3 ledger row: empty-string sentinels, no snapshot."""
    return _row(
        id="prov-0",
        projection_manifest_hash="",
        projection_manifest={},
        source_hash="",
        snapshot_available=False,
        created_at="2026-06-01T00:00:00Z",
    )


@pytest.fixture(autouse=True)
def _authed():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        yield
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# Catalog history list
# ---------------------------------------------------------------------------
def test_catalog_history_requires_auth():
    app.dependency_overrides.pop(validate_authentication, None)
    response = client.get("/v1/catalog/test-tenant/cat-1/conversions")
    assert response.status_code == 401


def test_catalog_history_404_when_not_catalog_item():
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = None
        response = client.get("/v1/catalog/test-tenant/proj-x/conversions")
    assert response.status_code == 404


def test_catalog_history_lists_rows_and_normalizes_sentinels():
    """Rows come back newest-first; ''-sentinels serialize as null; the current digest is echoed."""
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversions_for_source.return_value = [_row(), _legacy_row()]
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions")
    assert response.status_code == 200
    body = response.json()
    assert body["itemId"] == "cat-1"
    # The current source digest lets a client mark rows whose sourceHash differs as historic.
    assert body["currentSourceHash"] == _SOURCE_HASH
    assert [row["provenanceId"] for row in body["conversions"]] == ["prov-1", "prov-0"]

    fresh, legacy = body["conversions"]
    assert fresh["manifestHash"] == _MANIFEST.manifest_hash
    assert fresh["sourceHash"] == _SOURCE_HASH
    assert fresh["snapshotAvailable"] is True
    assert fresh["conversionMode"] == "lossy"
    assert fresh["targetProjectId"] == "proj-9"
    assert fresh["targetVersionRecordId"] == "ver-9"
    assert fresh["targetVersionLabel"] == "1.0.0"
    assert fresh["fidelityGrade"] == "C"
    assert fresh["schemaVersion"] == _MANIFEST.schema_version
    # Pre-CPDO-3.3 rows degrade to nulls, never empty-string storage sentinels.
    assert legacy["manifestHash"] is None
    assert legacy["sourceHash"] is None
    assert legacy["snapshotAvailable"] is False


def test_catalog_history_current_digest_degrades_to_null():
    """No captured source (or a broken read) → currentSourceHash null, list still served."""
    item_no_source = {**_CATALOG_ITEM, "format_metadata": {"package": "acme.v1"}}
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = item_no_source
        mock_db.get_conversions_for_source.return_value = [_row()]
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions")
    assert response.status_code == 200
    assert response.json()["currentSourceHash"] is None

    with patch("app.catalog_routes.db") as mock_db, patch(
        "app.conversion_evidence.resolve_source_payload", side_effect=RuntimeError("boom")
    ):
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversions_for_source.return_value = []
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions")
    assert response.status_code == 200
    assert response.json()["currentSourceHash"] is None


# ---------------------------------------------------------------------------
# Catalog evidence read — authorization ordering
# ---------------------------------------------------------------------------
def test_catalog_evidence_requires_auth():
    app.dependency_overrides.pop(validate_authentication, None)
    response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 401


def test_catalog_evidence_404_when_not_catalog_item():
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = None
        response = client.get("/v1/catalog/test-tenant/proj-x/conversions/prov-1/evidence")
    assert response.status_code == 404


def test_catalog_evidence_403_without_imports_view():
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = False
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 403
    assert "imports:view" in response.json()["detail"]


def test_catalog_evidence_checks_the_item_before_the_permission():
    """A cross-tenant id 404s rather than confirming its existence with a 403."""
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = None
        mock_db.user_has_permission.return_value = False
        response = client.get("/v1/catalog/test-tenant/other-item/conversions/prov-1/evidence")
    assert response.status_code == 404


def test_catalog_evidence_404_when_row_belongs_to_another_item():
    """One item's evidence cannot be probed through another item's URL."""
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _row(
            source_project_id="cat-other"
        )
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Catalog evidence read — the stored snapshot is served, not a rebuild
# ---------------------------------------------------------------------------
def test_catalog_evidence_serves_the_stored_snapshot():
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _row()
        mock_db.get_conversion_evidence_snapshot.return_value = _snapshot_row()
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 200
    body = response.json()
    assert body["provenanceId"] == "prov-1"
    assert body["itemId"] == "cat-1"
    assert body["snapshot"] == {"status": "available", "reason": None}
    assert body["manifestHash"] == _MANIFEST.manifest_hash
    assert body["sourceHash"] == _SOURCE_HASH
    # The summary describes the stored graph, and the page is the paginator's exact output.
    assert body["summary"]["manifest_hash"] == _MANIFEST.manifest_hash
    expected_page = paginate_conversion_evidence(_MANIFEST, limit=50)
    assert body["page"]["total"] == expected_page.total
    assert [edge["id"] for edge in body["page"]["edges"]] == [
        edge.id for edge in expected_page.edges
    ]
    # The snapshot lookup was content-addressed by the row's hash.
    mock_db.get_conversion_evidence_snapshot.assert_called_once_with(
        "test-tenant-id", _MANIFEST.manifest_hash
    )


def test_catalog_evidence_scope_filter_and_bad_inputs():
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _row()
        mock_db.get_conversion_evidence_snapshot.return_value = _snapshot_row()

        scoped = client.get(
            "/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence?scope=checklist"
        )
        assert scoped.status_code == 200
        assert all(edge["scope"] == "checklist" for edge in scoped.json()["page"]["edges"])

        bad_scope = client.get(
            "/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence?scope=nope"
        )
        assert bad_scope.status_code == 400

        bad_cursor = client.get(
            "/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence?cursor=%21%21"
        )
        assert bad_cursor.status_code == 422


def test_catalog_evidence_degrades_predates_snapshots():
    """A pre-CPDO-3.3 row is normal history: HTTP 200 with an explicit unavailable state."""
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _legacy_row()
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-0/evidence")
    assert response.status_code == 200
    body = response.json()
    assert body["snapshot"] == {"status": "unavailable", "reason": "predates_snapshots"}
    assert body["summary"] is None and body["page"] is None
    # No hash, no lookup: the store is never asked for the empty sentinel.
    mock_db.get_conversion_evidence_snapshot.assert_not_called()


def test_catalog_evidence_degrades_snapshot_missing():
    """A row naming a hash whose best-effort snapshot write failed degrades, not 500s."""
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _row()
        mock_db.get_conversion_evidence_snapshot.return_value = None
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 200
    assert response.json()["snapshot"] == {"status": "unavailable", "reason": "snapshot_missing"}


def test_catalog_evidence_degrades_unreadable_snapshot():
    """A stored manifest this reader cannot validate degrades truthfully, not 500s."""
    corrupt = {**_snapshot_row(), "manifest": {"schema_version": "9.0.0", "nodes": "corrupt"}}
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _row()
        mock_db.get_conversion_evidence_snapshot.return_value = corrupt
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 200
    body = response.json()
    assert body["snapshot"] == {"status": "unavailable", "reason": "unreadable"}
    assert body["summary"] is None and body["page"] is None


def test_stored_snapshot_and_evidence_response_never_carry_raw_source():
    """CPDO-3.2's redaction-by-construction extends to persistence: no source bytes anywhere."""
    stored = _stored_manifest_json()
    assert _GRAPHQL_SDL not in json.dumps(stored)
    # And the nulled ids never leak the writer's coordinates into the shared snapshot.
    assert stored["source"]["project_id"] is None
    assert stored["source"]["version_record_id"] is None

    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.get_conversion_provenance_by_id.return_value = _row()
        mock_db.get_conversion_evidence_snapshot.return_value = _snapshot_row()
        response = client.get("/v1/catalog/test-tenant/cat-1/conversions/prov-1/evidence")
    assert response.status_code == 200
    assert _GRAPHQL_SDL not in response.text


# ---------------------------------------------------------------------------
# Project-side twins
# ---------------------------------------------------------------------------
def test_project_history_404_when_project_unknown():
    with patch("app.projects_routes.db") as mock_db:
        mock_db.get_project_by_id.return_value = None
        response = client.get("/v1/projects/test-tenant/proj-x/conversions")
    assert response.status_code == 404


def test_project_history_links_rows_to_target_revisions():
    with patch("app.projects_routes.db") as mock_db:
        mock_db.get_project_by_id.return_value = {"id": "proj-9", "name": "Ping API (OpenAPI)"}
        mock_db.get_conversions_for_project.return_value = [
            _row(id="prov-2", target_version_id="ver-10", target_version_label="1.0.1",
                 reconverted=True),
            _row(),
        ]
        response = client.get("/v1/projects/test-tenant/proj-9/conversions")
    assert response.status_code == 200
    body = response.json()
    assert body["projectId"] == "proj-9"
    reconvert, first = body["conversions"]
    # Each entry names the target revision its snapshot is linked to (AC: re-conversions create
    # separate snapshots linked to target revisions).
    assert (reconvert["targetVersionRecordId"], reconvert["targetVersionLabel"]) == ("ver-10", "1.0.1")
    assert reconvert["reconverted"] is True
    assert (first["targetVersionRecordId"], first["targetVersionLabel"]) == ("ver-9", "1.0.0")
    # The backlink to the source catalog item survives on the row.
    assert first["sourceProjectId"] == "cat-1"
    assert first["sourceProjectName"] == "Ping API"


def test_project_evidence_403_without_imports_view():
    with patch("app.projects_routes.db") as mock_db:
        mock_db.get_project_by_id.return_value = {"id": "proj-9"}
        mock_db.user_has_permission.return_value = False
        response = client.get("/v1/projects/test-tenant/proj-9/conversions/prov-1/evidence")
    assert response.status_code == 403


def test_project_evidence_404_when_row_targets_another_project():
    with patch("app.projects_routes.db") as mock_db:
        mock_db.get_project_by_id.return_value = {"id": "proj-9"}
        mock_db.get_conversion_provenance_by_id.return_value = _row(target_project_id="proj-other")
        response = client.get("/v1/projects/test-tenant/proj-9/conversions/prov-1/evidence")
    assert response.status_code == 404


def test_project_evidence_readable_after_source_item_deleted():
    """The converted artifact keeps its approved evidence even when the source item is gone."""
    with patch("app.projects_routes.db") as mock_db:
        mock_db.get_project_by_id.return_value = {"id": "proj-9"}
        mock_db.get_conversion_provenance_by_id.return_value = _row(
            source_project_id=None, source_project_name=None
        )
        mock_db.get_conversion_evidence_snapshot.return_value = _snapshot_row()
        response = client.get("/v1/projects/test-tenant/proj-9/conversions/prov-1/evidence")
    assert response.status_code == 200
    body = response.json()
    assert body["projectId"] == "proj-9"
    assert body["snapshot"]["status"] == "available"
    assert body["summary"]["manifest_hash"] == _MANIFEST.manifest_hash


def test_project_evidence_degrades_like_the_catalog_side():
    with patch("app.projects_routes.db") as mock_db:
        mock_db.get_project_by_id.return_value = {"id": "proj-9"}
        mock_db.get_conversion_provenance_by_id.return_value = _legacy_row()
        response = client.get("/v1/projects/test-tenant/proj-9/conversions/prov-0/evidence")
    assert response.status_code == 200
    assert response.json()["snapshot"] == {
        "status": "unavailable",
        "reason": "predates_snapshots",
    }


# ---------------------------------------------------------------------------
# Retention delegate
# ---------------------------------------------------------------------------
def test_purge_delegate_calls_the_v215_function(monkeypatch: pytest.MonkeyPatch) -> None:
    executed = {}

    def _query(query, params):
        executed["query"] = query
        executed["params"] = params
        return [{"purged": 3}]

    monkeypatch.setattr(database.db, "execute_query", _query)
    assert database.db.purge_conversion_evidence_snapshots(30) == 3
    assert "apiome.purge_conversion_evidence_snapshots(%s)" in executed["query"]
    assert executed["params"] == (30,)
