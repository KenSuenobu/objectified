"""Stored per-revision lint reports (#5259).

Listing a project's versions must never re-lint them: the versions list carries the score /
grade stored on each version record, and ``GET .../lint`` serves the stored report whenever
its content fingerprint still matches the rebuilt OpenAPI document — linting (and persisting)
only when a revision has no stored report or its schema content changed. Push / fork / publish
capture the score as *version changes*.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.schema_lint import LintResult
from app.version_quality_capture import (
    SOURCE_FINGERPRINT_KEY,
    openapi_source_fingerprint,
    persistable_lint_report,
    stored_report_is_current,
)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

PID = "00000000-0000-0000-0000-0000000000a1"
VID = "00000000-0000-0000-0000-0000000000b1"
BASE_VID = "00000000-0000-0000-0000-0000000000b0"

HEAD_SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Payments", "version": "1.0.0"},
    "paths": {},
    "components": {
        "schemas": {
            "Payment": {
                "type": "object",
                "description": "A payment.",
                "properties": {
                    "amount": {"type": "integer", "description": "cents", "example": 1},
                },
            }
        }
    },
}

# The same document after an in-place schema edit (a new property).
EDITED_SPEC: Dict[str, Any] = {
    **HEAD_SPEC,
    "components": {
        "schemas": {
            "Payment": {
                "type": "object",
                "description": "A payment.",
                "properties": {
                    "amount": {"type": "integer", "description": "cents", "example": 1},
                    "currency": {"type": "string"},
                },
            }
        }
    },
}


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(vid: str = VID) -> Dict[str, Any]:
    return {"id": vid, "project_id": PID, "version_id": "1.0.0", "metadata": None}


def _captured(
    score: Optional[int],
    grade: Optional[str],
    fingerprint: Optional[str],
    quality_report: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "quality_score": score,
        "quality_grade": grade,
        "quality_report_fingerprint": fingerprint,
        "quality_report": quality_report or {},
    }


def _stored_report(spec: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
    """A persisted ``quality_report`` scored from ``spec`` (fingerprinted, #5259)."""
    report = {
        "score": 56,
        "grade": "C",
        "report_fingerprint": "fp-stored",
        "rule_hits": {"docs.info-description-missing": 1},
        "severity_counts": {"warning": 1, "error": 0, "info": 0},
        "findings": [
            {
                "id": "lint-abc",
                "path": "info.description",
                "category": "documentation",
                "rule": "docs.info-description-missing",
                "severity": "warning",
                "message": "Missing description.",
            }
        ],
        "categories": [{"name": "documentation", "score": 40}],
        SOURCE_FINGERPRINT_KEY: openapi_source_fingerprint(spec),
    }
    report.update(extra)
    return report


# ---------------------------------------------------------------------------
# version_quality_capture helpers
# ---------------------------------------------------------------------------


def test_source_fingerprint_is_stable_and_order_independent():
    a = {"openapi": "3.1.0", "paths": {"/a": {}, "/b": {}}, "info": {"title": "x"}}
    b = {"info": {"title": "x"}, "paths": {"/b": {}, "/a": {}}, "openapi": "3.1.0"}
    assert openapi_source_fingerprint(a) == openapi_source_fingerprint(b)
    assert openapi_source_fingerprint(a).startswith("sha256:")


def test_source_fingerprint_changes_when_content_changes():
    assert openapi_source_fingerprint(HEAD_SPEC) != openapi_source_fingerprint(EDITED_SPEC)


def test_stored_report_is_current_only_when_fingerprints_match():
    stored = _stored_report(HEAD_SPEC)
    assert stored_report_is_current(stored, HEAD_SPEC) is True
    assert stored_report_is_current(stored, EDITED_SPEC) is False
    # Legacy reports (no fingerprint) and empty reports can never be proven current.
    legacy = {k: v for k, v in stored.items() if k != SOURCE_FINGERPRINT_KEY}
    assert stored_report_is_current(legacy, HEAD_SPEC) is False
    assert stored_report_is_current({}, HEAD_SPEC) is False
    assert stored_report_is_current(None, HEAD_SPEC) is False


def test_persistable_lint_report_extends_engine_report():
    result = LintResult(
        score=90,
        grade="A",
        findings=(),
        rule_hits={},
        severity_counts={"error": 0, "warning": 0, "info": 0},
        report_fingerprint="fp-live",
    )
    guide = MagicMock(guide_id="g1", source="custom")
    guide.name = "House Style"
    report = persistable_lint_report(result, HEAD_SPEC, guide=guide)
    assert {k: report[k] for k in result.report_dict()} == result.report_dict()
    assert report[SOURCE_FINGERPRINT_KEY] == openapi_source_fingerprint(HEAD_SPEC)
    assert (report["guide_id"], report["guide_name"], report["guide_source"]) == (
        "g1",
        "House Style",
        "custom",
    )
    # Without a document there is nothing to fingerprint; without a guide, no guide context.
    bare = persistable_lint_report(result)
    assert SOURCE_FINGERPRINT_KEY not in bare and "guide_id" not in bare


# ---------------------------------------------------------------------------
# GET /v1/versions/{tenant}/{project} — the list carries the stored score
# ---------------------------------------------------------------------------


def _list_row(**overrides: Any) -> Dict[str, Any]:
    row = {
        "id": VID,
        "project_id": PID,
        "creator_id": "u1",
        "version_id": "1.0.0",
        "description": "note",
        "change_log": None,
        "visibility": "private",
        "published": False,
        "published_at": None,
        "published_immutable": False,
        "mock_enabled": False,
        "mock_settings": {},
        "enabled": True,
        "parent_version_id": None,
        "merge_parent_version_id": None,
        "forked_from_revision_id": None,
        "upstream_project_id": None,
        "revision_locked": False,
        "metadata": None,
        "commit_author": None,
        "commit_message": None,
        "external_ref": None,
        "source_commit_sha": None,
        "source_committed_at": None,
        "quality_score": 82,
        "quality_grade": "B",
        "fork_source_version_string": None,
        "fork_source_project_name": None,
        "upstream_project_name": None,
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "creator_name": "Dev",
        "creator_email": "dev@example.com",
        "project_name": "Payments",
        "project_slug": "payments",
    }
    row.update(overrides)
    return row


def test_list_versions_carries_stored_quality_without_linting(client: TestClient):
    """The list surfaces the stored score/grade per row and never touches the lint engine."""
    rows = [_list_row(), _list_row(id=BASE_VID, quality_score=None, quality_grade=None)]
    with patch("app.versions_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.versions_routes.db.get_versions_for_project", return_value=rows
    ), patch("app.lint_routes.guided_lint_openapi_spec") as m_lint, patch(
        "app.lint_routes.openapi_for_revision"
    ) as m_recon:
        r = client.get(f"/v1/versions/acme/{PID}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body[0]["qualityScore"] == 82
    assert body[0]["qualityGrade"] == "B"
    # An unscored revision reads as null (the UI shows a click-to-lint chip), never as 0/F.
    assert body[1]["qualityScore"] is None
    assert body[1]["qualityGrade"] is None
    m_lint.assert_not_called()
    m_recon.assert_not_called()


def test_get_versions_for_project_selects_stored_quality_columns():
    """The list query reads the stored headline from ``apiome.versions`` (no lint join)."""
    from app.database import Database

    inst = Database.__new__(Database)
    seen: Dict[str, Any] = {}

    def fake_execute_query(query, params=None):
        seen["query"] = " ".join(query.split())
        return []

    inst.execute_query = fake_execute_query  # type: ignore[method-assign]
    inst.get_versions_for_project(PID, "t1")
    assert "v.quality_score, v.quality_grade" in seen["query"]
    assert "lint" not in seen["query"].lower()

    seen.clear()
    # ``get_version_by_id`` guards on an RFC-4122 id before querying.
    inst.get_version_by_id("11111111-1111-4111-8111-111111111111", "t1")
    assert "v.quality_score, v.quality_grade" in seen["query"]


# ---------------------------------------------------------------------------
# GET .../lint — stored-first, persist-on-compute
# ---------------------------------------------------------------------------


def test_lint_persists_live_report_onto_the_revision(client: TestClient):
    """A never-scored revision is linted once and the report is stored on its record."""
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.lint_routes.openapi_for_revision", return_value=HEAD_SPEC), patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(None, None, None),
    ), patch("app.database.db.set_version_quality_score", return_value=True) as m_set:
        r = client.get(f"/v1/versions/acme/{PID}/{VID}/lint")
    assert r.status_code == 200, r.text
    body = r.json()
    m_set.assert_called_once()
    args, kwargs = m_set.call_args
    assert args[:2] == (VID, "t1")
    assert args[2] == body["score"] and args[3] == body["grade"]
    assert args[4] == body["reportFingerprint"]
    stored = kwargs["quality_report"]
    assert stored[SOURCE_FINGERPRINT_KEY] == openapi_source_fingerprint(HEAD_SPEC)
    assert stored["report_fingerprint"] == body["reportFingerprint"]
    assert [f["rule"] for f in stored["findings"]] == [f["rule"] for f in body["findings"]]
    # The freshly persisted values are the captured ones — nothing is stale.
    assert body["capturedScore"] == body["score"]
    assert body["capturedGrade"] == body["grade"]
    assert body["capturedReportFingerprint"] == body["reportFingerprint"]
    assert body["scoreIsStale"] is False


def test_lint_serves_current_stored_report_without_relinting(client: TestClient):
    """A stored report whose content fingerprint still matches is served: no lint, no write."""
    stored = _stored_report(HEAD_SPEC, guide_id="g1", guide_name="House", guide_source="custom")
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch(
        "app.lint_routes.openapi_for_revision", return_value=HEAD_SPEC
    ) as m_recon, patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(56, "C", "fp-stored", quality_report=stored),
    ), patch("app.lint_routes.guided_lint_openapi_spec") as m_lint, patch(
        "app.database.db.set_version_quality_score"
    ) as m_set:
        r = client.get(f"/v1/versions/acme/{PID}/{VID}/lint")
    assert r.status_code == 200, r.text
    body = r.json()
    # Freshness is decided by rebuilding the document (cheap) — never by re-linting.
    m_recon.assert_called_once()
    m_lint.assert_not_called()
    m_set.assert_not_called()
    assert body["score"] == 56 and body["grade"] == "C"
    assert body["reportFingerprint"] == "fp-stored"
    assert body["findings"][0]["rule"] == "docs.info-description-missing"
    assert body["scoreIsStale"] is False
    # Guide context stored with the report is echoed back (parity with the live report).
    assert (body["guideId"], body["guideName"], body["guideSource"]) == ("g1", "House", "custom")


def test_lint_relints_and_repersists_when_content_changed(client: TestClient):
    """When the schema content changed since capture, the report is recomputed and re-stored."""
    stored = _stored_report(HEAD_SPEC)  # captured from the *old* content
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch(
        "app.lint_routes.openapi_for_revision", return_value=EDITED_SPEC
    ) as m_recon, patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(56, "C", "fp-stored", quality_report=stored),
    ), patch("app.database.db.set_version_quality_score", return_value=True) as m_set:
        r = client.get(f"/v1/versions/acme/{PID}/{VID}/lint")
    assert r.status_code == 200, r.text
    body = r.json()
    # The document is rebuilt exactly once and reused for the re-lint.
    m_recon.assert_called_once()
    m_set.assert_called_once()
    stored_now = m_set.call_args.kwargs["quality_report"]
    assert stored_now[SOURCE_FINGERPRINT_KEY] == openapi_source_fingerprint(EDITED_SPEC)
    assert body["reportFingerprint"] != "fp-stored"
    assert body["reportFingerprint"] == stored_now["report_fingerprint"]
    # Re-persisted → the captured values are the new ones, so nothing reads as stale.
    assert body["capturedReportFingerprint"] == body["reportFingerprint"]
    assert body["scoreIsStale"] is False


def test_lint_legacy_stored_report_without_fingerprint_is_served_as_is(client: TestClient):
    """A pre-#5259 report (no content fingerprint) stays authoritative: no rebuild, no lint."""
    legacy = {
        k: v for k, v in _stored_report(HEAD_SPEC).items() if k != SOURCE_FINGERPRINT_KEY
    }
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.lint_routes.openapi_for_revision") as m_recon, patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(56, "C", "fp-stored", quality_report=legacy),
    ), patch("app.database.db.set_version_quality_score") as m_set:
        body = client.get(f"/v1/versions/acme/{PID}/{VID}/lint").json()
    m_recon.assert_not_called()
    m_set.assert_not_called()
    assert body["score"] == 56 and body["reportFingerprint"] == "fp-stored"


def test_lint_freshness_probe_failure_serves_the_stored_report(client: TestClient):
    """If the document cannot be rebuilt for the freshness check, the stored report still serves."""
    stored = _stored_report(HEAD_SPEC)
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch(
        "app.lint_routes.openapi_for_revision", side_effect=RuntimeError("no classes table")
    ), patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(56, "C", "fp-stored", quality_report=stored),
    ), patch("app.lint_routes.guided_lint_openapi_spec") as m_lint, patch(
        "app.database.db.set_version_quality_score"
    ) as m_set:
        r = client.get(f"/v1/versions/acme/{PID}/{VID}/lint")
    assert r.status_code == 200, r.text
    assert r.json()["reportFingerprint"] == "fp-stored"
    m_lint.assert_not_called()
    m_set.assert_not_called()


def test_lint_base_revision_comparison_is_never_persisted(client: TestClient):
    """A base-revision compare depends on the chosen base, so it is computed live, not stored."""
    rows = {VID: _version_row(VID), BASE_VID: _version_row(BASE_VID)}
    stored = _stored_report(HEAD_SPEC)
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", side_effect=lambda vid, tid: rows.get(vid)
    ), patch("app.lint_routes.openapi_for_revision", return_value=HEAD_SPEC), patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(56, "C", "fp-stored", quality_report=stored),
    ), patch("app.database.db.set_version_quality_score") as m_set:
        r = client.get(f"/v1/versions/acme/{PID}/{VID}/lint?baseRevisionId={BASE_VID}")
    assert r.status_code == 200, r.text
    body = r.json()
    m_set.assert_not_called()
    assert body["baseRevisionId"] == BASE_VID
    # The stored (base-less) values are still surfaced as the captured score, never stale.
    assert body["capturedScore"] == 56
    assert body["scoreIsStale"] is False


def test_lint_persist_failure_keeps_serving_the_live_report(client: TestClient):
    """A failed write is best-effort: the live report is returned with the prior captured values."""
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.lint_routes.openapi_for_revision", return_value=HEAD_SPEC), patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(42, "F", "fp-old"),
    ), patch(
        "app.database.db.set_version_quality_score", side_effect=RuntimeError("db down")
    ):
        r = client.get(f"/v1/versions/acme/{PID}/{VID}/lint")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["capturedScore"] == 42
    assert body["capturedReportFingerprint"] == "fp-old"
    assert body["scoreIsStale"] is True


def test_lint_persists_canonical_relint_for_legacy_native_imports(client: TestClient):
    """A native import that predates report persistence is re-linted once and then stored."""
    canonical = {
        "score": 71,
        "grade": "C",
        "report_fingerprint": "fp-canonical",
        "rule_hits": {},
        "severity_counts": {"error": 0, "warning": 0, "info": 0},
        "findings": [],
        "categories": [],
    }
    with patch("app.lint_routes.db.get_project_by_id", return_value={"id": PID}), patch(
        "app.lint_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.lint_routes.openapi_for_revision") as m_recon, patch(
        "app.lint_routes.db.get_version_quality_score",
        return_value=_captured(71, "C", "fp-canonical"),
    ), patch(
        "app.lint_routes._try_relint_canonical_source", return_value=canonical
    ), patch("app.lint_routes.db.set_version_quality_score", return_value=True) as m_set:
        body = client.get(f"/v1/versions/acme/{PID}/{VID}/lint").json()
    m_recon.assert_not_called()
    m_set.assert_called_once()
    args, kwargs = m_set.call_args
    assert args == (VID, "t1", 71, "C", "fp-canonical")
    assert kwargs["quality_report"] is canonical
    assert body["score"] == 71 and body["reportFingerprint"] == "fp-canonical"


# ---------------------------------------------------------------------------
# Version changes capture the score: push, fork, publish precheck
# ---------------------------------------------------------------------------


def _push_row() -> Dict[str, Any]:
    return _list_row(quality_score=None, quality_grade=None)


def test_push_schedules_lint_capture_for_the_new_revision(client: TestClient):
    """Creating a revision (push) captures its stored score after the response (#5259)."""
    with patch("app.versions_routes.enforce_permission"), patch(
        "app.versions_routes.db"
    ) as mdb, patch("app.versions_routes.capture_version_quality_score") as m_capture:
        mdb.get_project_by_id.return_value = {"id": PID, "slug": "payments", "metadata": {}}
        mdb.get_latest_version_for_project.return_value = None
        mdb.list_version_branches_for_project.return_value = []
        mdb.get_latest_revision_id_for_project.return_value = None
        mdb.create_version_push_transaction.return_value = (_push_row(), 0)
        r = client.post(
            f"/v1/versions/acme/{PID}",
            json={"version_id": "1.0.0", "shortMessage": "init", "baseRevisionId": ""},
        )
    assert r.status_code == 200, r.text
    # The new revision has no stored score yet — the list shows it as unscored until the
    # background capture lands, then renders the badge from the record.
    assert r.json()["qualityScore"] is None
    m_capture.assert_called_once_with("acme", "t1", VID)


def test_fork_schedules_lint_capture_for_the_forked_revision(client: TestClient):
    with patch("app.versions_routes.enforce_permission"), patch(
        "app.versions_routes.db"
    ) as mdb, patch("app.versions_routes.capture_version_quality_score") as m_capture:
        mdb.get_project_by_id.return_value = {"id": PID, "slug": "payments", "metadata": {}}
        mdb.get_latest_version_for_project.return_value = None
        mdb.create_forked_version.return_value = {"success": True, "version": _push_row()}
        r = client.post(
            f"/v1/versions/acme/{PID}/fork",
            json={"sourceRevisionId": BASE_VID, "version_id": "1.0.0", "shortMessage": "fork"},
        )
    assert r.status_code == 200, r.text
    m_capture.assert_called_once_with("acme", "t1", VID)


def test_publish_precheck_persists_the_report_it_computes():
    """The publish precheck already lints the head; #5259 stores that report on the revision."""
    from app.models import VersionPublishRequest
    from app.version_publish_prechecks import enforce_publish_prechecks

    result = LintResult(
        score=95,
        grade="A",
        findings=(),
        rule_hits={},
        severity_counts={"error": 0, "warning": 0, "info": 0},
        report_fingerprint="fp-publish",
    )
    guide = MagicMock(guide_id="g1", source="custom")
    guide.name = "House"
    with patch(
        "app.version_publish_prechecks.openapi_for_revision", return_value=HEAD_SPEC
    ), patch(
        "app.style_guide_engine.guided_lint_openapi_spec", return_value=(result, guide)
    ), patch(
        "app.version_publish_prechecks.persist_version_lint_report"
    ) as m_persist, patch(
        "app.version_publish_prechecks._with_verification_policy",
        side_effect=lambda outcome, **_: outcome,
    ), patch(
        "app.version_publish_prechecks._with_breaking_publish_guardrail",
        side_effect=lambda outcome, **_: outcome,
    ), patch("app.version_publish_prechecks.db") as m_db:
        m_db.get_latest_published_version_for_project.return_value = None
        m_db.get_versions_for_project.return_value = []
        outcome = enforce_publish_prechecks(
            tenant_slug="acme",
            tenant_id="t1",
            project_id=PID,
            existing=_version_row(),
            request=VersionPublishRequest(),
        )
    assert outcome.lint_error_count == 0
    m_persist.assert_called_once_with(VID, "t1", result, HEAD_SPEC, guide=guide)


def test_capture_helper_persists_fingerprinted_report():
    """The shared capture (import / push / fork) stores the fingerprinted report on the row."""
    from app.version_quality_capture import capture_version_quality_score

    mock_db = MagicMock()
    mock_db.get_version_by_id.return_value = _version_row()
    result = LintResult(
        score=88,
        grade="B",
        findings=(),
        rule_hits={},
        severity_counts={"error": 0, "warning": 0, "info": 0},
        report_fingerprint="fp-capture",
    )
    guide = MagicMock(guide_id=None, source="fallback")
    guide.name = "Apiome Recommended"
    with patch("app.database.db", mock_db), patch(
        "app.compatibility_engine.openapi_for_revision", return_value=HEAD_SPEC
    ), patch(
        "app.style_guide_engine.guided_lint_openapi_spec", return_value=(result, guide)
    ), patch(
        "app.openapi_validation_evidence.capture_openapi_external_validation_evidence_sync"
    ) as m_evidence:
        capture_version_quality_score("acme", "t1", VID)
    args, kwargs = mock_db.set_version_quality_score.call_args
    assert args == (VID, "t1", 88, "B", "fp-capture")
    assert kwargs["quality_report"][SOURCE_FINGERPRINT_KEY] == openapi_source_fingerprint(
        HEAD_SPEC
    )
    m_evidence.assert_called_once()
