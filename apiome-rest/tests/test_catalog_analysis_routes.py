"""Route contract for the catalog payload-analysis surfaces (CPDO-1.1, #4794).

Two surfaces, deliberately split by what they disclose:

* ``GET /v1/catalog/{tenant}/{item}`` embeds an ``analysis`` **summary** — status, reason and
  counts, never payload material — readable by anyone who can read the catalog item at all.
* ``GET /v1/catalog/{tenant}/{item}/analysis`` returns the **record**: the native tree, its source
  locations, the analyzer warnings, and the redaction metadata. It is gated on ``imports:view``,
  the permission governing imported source material.

These pin that split, the tenant scoping, the ``valueVisibility`` contract (it can narrow, never
widen), and — the acceptance criterion this whole ticket turns on — that a legacy revision reports a
declared ``unavailable`` status with a reason code rather than a fabricated tree.
"""

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.payload_analysis import (
    REASON_NOT_ANALYZED,
    STATUS_AVAILABLE,
    STATUS_UNAVAILABLE,
    AnalysisNode,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    bound_tree,
    source_digest,
)

client = TestClient(app)

_MOCK_AUTH = {
    "tenant_id": "test-tenant-id",
    "user_id": "test-user-id",
    "auth_method": "jwt",
}


def _override_auth():
    return _MOCK_AUTH


_CATALOG_ITEM = {
    "id": "cat-1",
    "tenant_id": "test-tenant-id",
    "creator_id": "user-1",
    "name": "Acme 837 Claims",
    "description": "imported from an X12 interchange",
    "slug": "acme-837-claims",
    "enabled": True,
    "metadata": {},
    "publishable": False,
    "created_at": "2026-01-01T00:00:00",
    "updated_at": "2026-01-01T00:00:00",
    "deleted_at": None,
    "creator_name": "Test User",
    "creator_email": "test@example.com",
    "quality_score": 78,
    "quality_grade": "C",
    "versions_count": 1,
    "source_format": "edi-x12",
    "protocol": None,
    "format_metadata": {
        "sourceLabel": "claim.edi",
        "inputKind": "file",
        "sourceContent": "ISA*00*",
    },
    "tool_versions": {"edix12": "1.4.0"},
}


def _stored_document() -> PayloadAnalysisDocument:
    """A stored ``available`` analysis: an X12 envelope whose element value was withheld."""
    tree, metrics = bound_tree(
        [
            AnalysisNode(
                id="isa",
                kind="interchange",
                name="ISA",
                attributes={"elementSeparator": "*"},
                children=[
                    AnalysisNode(
                        id="nm1-01",
                        kind="element",
                        name="NM101",
                        value="SENSITIVE-ACCOUNT-42",
                        value_present=True,
                    )
                ],
            )
        ]
    )
    document = PayloadAnalysisDocument(
        status=STATUS_AVAILABLE,
        source_format="edi-x12",
        source_hash=source_digest("ISA*00*"),
        analyzer=AnalyzerInfo(key="edix12", version="1.0.0", tool_versions={"edix12": "1.4.0"}),
        tree=tree,
        metrics=metrics,
    )
    return apply_value_visibility(document, ValueVisibility.STRUCTURAL)


def _analysis_row() -> dict:
    """The stored row for :func:`_stored_document`, as the data layer returns it."""
    document = _stored_document()
    payload = document.model_dump(mode="json", by_alias=False)
    return {
        "id": "an-1",
        "tenant_id": "test-tenant-id",
        "project_id": "cat-1",
        "version_id": "ver-1",
        "analysis_sequence": 1,
        "schema_version": document.schema_version,
        "content_fingerprint": analysis_content_fingerprint(document),
        "source_format": document.source_format,
        "source_hash": document.source_hash,
        "analyzer_key": document.analyzer.key,
        "analyzer_version": document.analyzer.version,
        "tool_versions": document.analyzer.tool_versions,
        "status": document.status,
        "status_reason": document.status_reason,
        "tree": payload["tree"],
        "metrics": payload["metrics"],
        "warnings": payload["warnings"],
        "redaction": payload["redaction"],
        "created_by": None,
        "created_at": "2026-07-27T00:00:00+00:00",
    }


def _wire_store(mock_store_db, *, row, revision_id="ver-1"):
    """Point the store's data layer at ``row`` for both the summary and full-record reads."""
    mock_store_db.get_latest_revision_id_for_project.return_value = revision_id
    mock_store_db.get_payload_analysis_for_version.return_value = row
    mock_store_db.get_payload_analysis_summary_row_for_version.return_value = (
        {k: v for k, v in row.items() if k != "tree"} if row else None
    )


# ---------------------------------------------------------------------------
# Authentication and scoping
# ---------------------------------------------------------------------------
def test_analysis_requires_auth():
    """The analysis endpoint requires authentication."""
    response = client.get("/v1/catalog/test-tenant/cat-1/analysis")
    assert response.status_code == 401
    assert "Authentication required" in response.json()["detail"]


def test_analysis_404s_for_a_non_catalog_item():
    """A Project's id — or an unknown id — is not a catalog item."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = None
            response = client.get("/v1/catalog/test-tenant/proj-publishable/analysis")
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_analysis_is_gated_on_imports_view():
    """The native tree is imported source material, so it needs the permission that governs it."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = False
            response = client.get("/v1/catalog/test-tenant/cat-1/analysis")
        assert response.status_code == 403
        assert "imports:view" in response.json()["detail"]
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_missing_item_is_checked_before_the_permission():
    """A 404 for an id in another tenant must not be turned into a 403 that confirms it exists."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = None
            mock_db.user_has_permission.return_value = False
            response = client.get("/v1/catalog/test-tenant/cat-other-tenant/analysis")
        assert response.status_code == 404
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------
def test_analysis_returns_the_native_tree_and_its_identity():
    """The record carries the analyzer's own vocabulary plus the identity that makes it citable."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get("/v1/catalog/test-tenant/cat-1/analysis")

        assert response.status_code == 200
        data = response.json()
        assert data["analysisId"] == "an-1"
        assert data["versionRecordId"] == "ver-1"
        assert data["analysisSequence"] == 1
        assert data["contentFingerprint"]

        analysis = data["analysis"]
        assert analysis["status"] == STATUS_AVAILABLE
        assert analysis["sourceHash"].startswith("sha256:")
        assert analysis["analyzer"]["key"] == "edix12"
        assert analysis["tree"][0]["kind"] == "interchange"
        assert analysis["tree"][0]["children"][0]["name"] == "NM101"
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_analysis_never_serves_a_withheld_value():
    """A value the store never held cannot come back out; presence and length still can."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get("/v1/catalog/test-tenant/cat-1/analysis")

        assert "SENSITIVE-ACCOUNT-42" not in response.text
        element = response.json()["analysis"]["tree"][0]["children"][0]
        assert element["value"] is None
        assert element["valuePresent"] is True
        assert element["valueLength"] == 20
        assert element["redacted"] is True
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_analysis_reports_its_redaction_policy():
    """"No values here" is always a stated policy, never something a reader has to infer."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get("/v1/catalog/test-tenant/cat-1/analysis")

        redaction = response.json()["analysis"]["redaction"]
        assert redaction["valueVisibility"] == ValueVisibility.STRUCTURAL
        assert redaction["redactedNodeCount"] == 1
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# valueVisibility
# ---------------------------------------------------------------------------
def test_value_visibility_can_narrow_the_response():
    """A caller may ask for less than the record holds."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get(
                "/v1/catalog/test-tenant/cat-1/analysis?valueVisibility=none"
            )

        element = response.json()["analysis"]["tree"][0]["children"][0]
        assert element["valuePresent"] is None
        assert element["valueLength"] is None
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_value_visibility_cannot_widen_the_response():
    """Asking for ``full`` over a structurally-stored record returns no values — they are not there."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get(
                "/v1/catalog/test-tenant/cat-1/analysis?valueVisibility=full"
            )

        assert response.status_code == 200
        assert "SENSITIVE-ACCOUNT-42" not in response.text
        assert response.json()["analysis"]["tree"][0]["children"][0]["value"] is None
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_unknown_value_visibility_is_refused():
    """An unrecognised level is a 422 rather than a silently-ignored parameter."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            response = client.get(
                "/v1/catalog/test-tenant/cat-1/analysis?valueVisibility=everything"
            )
        assert response.status_code == 422
        assert "valueVisibility" in response.json()["detail"]
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# Declared absence
# ---------------------------------------------------------------------------
def test_legacy_revision_returns_declared_unavailable_not_a_fabricated_tree():
    """The acceptance criterion: an unanalysed revision says so, with a reason and no tree."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.user_has_permission.return_value = True
            _wire_store(mock_store_db, row=None)
            response = client.get("/v1/catalog/test-tenant/cat-1/analysis")

        assert response.status_code == 200
        analysis = response.json()["analysis"]
        assert analysis["status"] == STATUS_UNAVAILABLE
        assert analysis["statusReason"] == REASON_NOT_ANALYZED
        assert analysis["tree"] == []
        assert analysis["sourceFormat"] == "edi-x12"
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# The detail summary
# ---------------------------------------------------------------------------
def test_detail_embeds_the_analysis_summary():
    """The detail read carries status and counts, so the UI can decide whether to offer the tab."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_related_artifact_rows.return_value = []
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get("/v1/catalog/test-tenant/cat-1")

        assert response.status_code == 200
        analysis = response.json()["analysis"]
        assert analysis["available"] is True
        assert analysis["status"] == STATUS_AVAILABLE
        assert analysis["nodeCount"] == 2
        assert analysis["kindCounts"] == {"interchange": 1, "element": 1}
        assert analysis["analysisId"] == "an-1"
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_detail_summary_carries_no_payload_material():
    """The summary is readable without ``imports:view``, so it must disclose nothing structural."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_related_artifact_rows.return_value = []
            _wire_store(mock_store_db, row=_analysis_row())
            response = client.get("/v1/catalog/test-tenant/cat-1")

        analysis = response.json()["analysis"]
        assert "tree" not in analysis
        assert "SENSITIVE-ACCOUNT-42" not in response.text
        mock_store_db.get_payload_analysis_for_version.assert_not_called()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_detail_reports_absence_rather_than_omitting_the_field():
    """An unanalysed item still gets an ``analysis`` block — with a status and a reason."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_related_artifact_rows.return_value = []
            _wire_store(mock_store_db, row=None)
            response = client.get("/v1/catalog/test-tenant/cat-1")

        analysis = response.json()["analysis"]
        assert analysis["available"] is False
        assert analysis["status"] == STATUS_UNAVAILABLE
        assert analysis["statusReason"] == REASON_NOT_ANALYZED
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_detail_survives_an_unreadable_analysis_store():
    """A store fault degrades one field to ``failed``; it does not take the catalog item down."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.payload_analysis_store.db"
        ) as mock_store_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_related_artifact_rows.return_value = []
            mock_store_db.get_latest_revision_id_for_project.side_effect = RuntimeError(
                "connection refused"
            )
            response = client.get("/v1/catalog/test-tenant/cat-1")

        assert response.status_code == 200
        analysis = response.json()["analysis"]
        assert analysis["status"] == "failed"
        assert analysis["available"] is False
    finally:
        app.dependency_overrides.pop(validate_authentication, None)
