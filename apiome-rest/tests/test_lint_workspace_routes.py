"""Route-level tests for the lint workspace API (CLX-4.1, #4859)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "email": "a@b.c"}

# Relative to wall clock so the trends window (``days``) always includes these rows.
NOW = datetime.now(timezone.utc).replace(microsecond=0)


@pytest.fixture(autouse=True)
def _auth_override():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _evidence_row(run_id: str, findings: list, *, created_at: datetime = NOW, rn: int = 1):
    return {
        "id": run_id,
        "subject_type": "catalog_revision",
        "version_record_id": "v1",
        "mcp_version_id": None,
        "scanner_id": "apiome.native-lint",
        "scanner_version": "1",
        "profile": "import-capture",
        "outcome": "findings",
        "report_fingerprint": f"fp-{run_id}",
        "findings": findings,
        "coverage": {"state": "full"},
        "created_at": created_at,
        "project_id": "p1",
        "project_name": "Petstore",
        "publishable": True,
        "subject_label": "1.0.0",
        "rn": rn,
    }


def _finding(fp: str, severity: str = "error", category: str | None = None):
    return {
        "source_fingerprint": fp,
        "rule_id": "r1",
        "message": f"message {fp}",
        "severity": severity,
        "category": category,
        "location": {"path": "/pets"},
    }


def _decision_row(**overrides):
    row = {
        "id": "d1",
        "tenant_id": "t1",
        "project_id": None,
        "source_fingerprint": "f1",
        "rule_id": "r1",
        "state": "acknowledged",
        "owner_user_id": None,
        "rationale": None,
        "linked_ticket": None,
        "expires_at": None,
        "policy_version_id": None,
        "evidence_fingerprint_at_decision": "f1",
        "actor_user_id": "u1",
        "actor_label": "u1",
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(overrides)
    return row


# --- GET /findings --------------------------------------------------------------------------------


@patch("app.lint_workspace.db")
def test_findings_queue_filters_paginates_and_facets(mdb):
    mdb.list_latest_lint_evidence_runs_for_tenant.return_value = [
        _evidence_row(
            "run-1",
            [
                _finding("e1", "error", "security"),
                _finding("e2", "error"),
                _finding("w1", "warning"),
            ],
        )
    ]
    mdb.list_latest_axis_evaluations_for_tenant.return_value = []
    mdb.list_latest_lint_policy_evaluations_for_tenant.return_value = []
    mdb.list_lint_finding_decisions.return_value = []

    resp = client.get(
        "/v1/lint/workspace/findings",
        params={"severity": "error", "limit": 1, "offset": 0, "sort": "rule"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2
    assert body["count"] == 1
    assert body["limit"] == 1
    # camelCase projection with the linkage fields criterion 2 requires.
    row = body["findings"][0]
    assert row["sourceFingerprint"] in ("e1", "e2")
    assert row["evidenceRunId"] == "run-1"
    assert row["versionRecordId"] == "v1"
    assert row["projectId"] == "p1"
    assert row["subjectLabel"] == "1.0.0"
    assert row["effectiveState"] == "open"
    assert row["isNew"] is True
    assert row["location"] == {"path": "/pets"}
    # Facets cover the filtered (error-only) set, pre-pagination.
    assert body["facets"]["severity"] == {"error": 2}
    assert body["facets"]["axis"] == {"security": 1, "quality": 1}


@patch("app.lint_workspace.db")
def test_findings_new_unwaived_security_errors_queue(mdb):
    """Acceptance criterion 1: the workspace finds every new unwaived security error."""
    mdb.list_latest_lint_evidence_runs_for_tenant.return_value = [
        _evidence_row(
            "run-2",
            [
                _finding("sec-new", "error", "security"),
                _finding("sec-waived", "error", "security"),
                _finding("plain", "error"),
            ],
            rn=1,
        ),
        _evidence_row("run-1", [], created_at=NOW - timedelta(days=1), rn=2),
    ]
    mdb.list_latest_axis_evaluations_for_tenant.return_value = []
    mdb.list_latest_lint_policy_evaluations_for_tenant.return_value = []
    mdb.list_lint_finding_decisions.return_value = [
        _decision_row(
            id="d-waived",
            source_fingerprint="sec-waived",
            state="waived",
            rationale="accepted",
            expires_at=NOW + timedelta(days=30),
        )
    ]
    resp = client.get(
        "/v1/lint/workspace/findings",
        params={"new": "true", "severity": "error", "axis": "security", "state": "open"},
    )
    assert resp.status_code == 200, resp.text
    fingerprints = [f["sourceFingerprint"] for f in resp.json()["findings"]]
    assert fingerprints == ["sec-new"]


def test_findings_rejects_unknown_filter_values():
    resp = client.get("/v1/lint/workspace/findings", params={"severity": "critical"})
    assert resp.status_code == 400
    resp2 = client.get("/v1/lint/workspace/findings", params={"sort": "vibes"})
    assert resp2.status_code == 400


@patch("app.lint_workspace.db")
def test_findings_empty_tenant_returns_empty_page(mdb):
    mdb.list_latest_lint_evidence_runs_for_tenant.return_value = []
    mdb.list_latest_axis_evaluations_for_tenant.return_value = []
    mdb.list_latest_lint_policy_evaluations_for_tenant.return_value = []
    mdb.list_lint_finding_decisions.return_value = []
    resp = client.get("/v1/lint/workspace/findings")
    assert resp.status_code == 200
    assert resp.json() == {
        "findings": [],
        "count": 0,
        "total": 0,
        "limit": 50,
        "offset": 0,
        "facets": {
            "severity": {},
            "effectiveState": {},
            "scannerId": {},
            "axis": {},
            "grade": {},
        },
    }


# --- GET /summary ----------------------------------------------------------------------------------


@patch("app.lint_workspace.db")
def test_summary_reports_posture_rollup(mdb):
    mdb.list_latest_lint_evidence_runs_for_tenant.return_value = [
        _evidence_row("run-1", [_finding("sec-err", "error", "security")])
    ]
    mdb.list_latest_axis_evaluations_for_tenant.return_value = [
        {
            "id": "ax1",
            "subject_type": "catalog_revision",
            "version_record_id": "v1",
            "mcp_version_id": None,
            "axes": [{"key": "quality", "assessed": False}],
            "composite_score": None,
            "composite_grade": None,
            "required_coverage_met": False,
            "evaluated_at": NOW,
            "project_id": "p1",
            "project_name": "Petstore",
            "subject_label": "1.0.0",
        }
    ]
    mdb.list_latest_lint_policy_evaluations_for_tenant.return_value = []
    mdb.list_lint_finding_decisions.return_value = []

    resp = client.get("/v1/lint/workspace/summary")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["findings"]["unwaived_errors"] == 1
    assert body["findings"]["unwaived_security_errors"] == 1
    assert body["coverage"]["missing_count"] == 1
    assert body["gradeDistribution"]["ungraded"] == 1
    assert body["subjects"]["catalog_revisions"] == 1
    axes = {a["key"]: a for a in body["axes"]}
    assert axes["quality"]["notAssessedCount"] == 1


# --- GET /trends -----------------------------------------------------------------------------------


@patch("app.lint_workspace.db")
def test_trends_route_shapes_series(mdb):
    day1 = NOW - timedelta(days=1)
    mdb.list_latest_lint_evidence_runs_for_tenant.return_value = [
        _evidence_row("run-2", [_finding("kept")], rn=1),
        _evidence_row("run-1", [_finding("kept"), _finding("gone")], created_at=day1, rn=2),
    ]
    mdb.list_lint_finding_decision_events_for_tenant.return_value = []
    mdb.list_style_guide_policy_versions_for_tenant.return_value = []
    mdb.list_lint_finding_decisions.return_value = []

    resp = client.get("/v1/lint/workspace/trends", params={"days": 3})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["days"] == 3
    assert len(body["series"]) == 3
    today = {point["date"]: point for point in body["series"]}[NOW.date().isoformat()]
    assert today["remediatedFindings"] == 1
    # The deep evidence window is requested for diffing.
    kwargs = mdb.list_latest_lint_evidence_runs_for_tenant.call_args.kwargs
    assert kwargs["runs_per_scanner"] >= 2


# --- POST /decisions/bulk ---------------------------------------------------------------------------


def _bulk(items, set_fields):
    return client.post(
        "/v1/lint/workspace/decisions/bulk",
        json={"items": items, "set": set_fields},
    )


@patch("app.lint_workspace_routes.db")
def test_bulk_requires_edit_permission_and_audits_denial(mdb):
    mdb.user_has_permission.return_value = False
    resp = _bulk([{"sourceFingerprint": "f1"}], {"state": "acknowledged"})
    assert resp.status_code == 403
    mdb.write_access_audit.assert_called_once()
    audit_kwargs = mdb.write_access_audit.call_args.kwargs
    assert audit_kwargs["action"] == "permission.denied"
    assert audit_kwargs["detail"] == {"resource": "lint_findings", "action": "edit"}


@patch("app.lint_workspace_routes.db")
def test_bulk_waiver_approval_needs_publish_per_item(mdb):
    # Editor: edit yes, publish no.
    mdb.user_has_permission.side_effect = (
        lambda tenant, user, resource, action: action == "edit"
    )
    mdb.list_lint_finding_decisions.return_value = []
    resp = _bulk(
        [{"sourceFingerprint": "f1"}],
        {"state": "waived", "rationale": "ok", "expiresAt": "2026-08-01T00:00:00Z"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["appliedCount"] == 0
    assert body["failedCount"] == 1
    assert "publish" in body["results"][0]["error"]
    mdb.upsert_lint_finding_decision.assert_not_called()


@patch("app.lint_workspace_routes.db")
def test_bulk_acknowledge_applies_per_item_with_before_states(mdb):
    mdb.user_has_permission.return_value = True
    mdb.list_lint_finding_decisions.return_value = [
        _decision_row(id="d1", source_fingerprint="f1", state="open")
    ]
    mdb.upsert_lint_finding_decision.side_effect = [
        _decision_row(id="d1", source_fingerprint="f1", state="acknowledged"),
        _decision_row(id="d2", source_fingerprint="f2", state="acknowledged"),
    ]
    resp = _bulk(
        [{"sourceFingerprint": "f1"}, {"sourceFingerprint": "f2"}],
        {"state": "acknowledged", "ownerUserId": "owner-9"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["appliedCount"] == 2
    assert body["failedCount"] == 0
    # beforeState enables the exact inverse request (reversibility).
    assert body["results"][0]["beforeState"] == "open"
    assert body["results"][1]["beforeState"] is None
    assert all(r["afterState"] == "acknowledged" for r in body["results"])
    assert mdb.upsert_lint_finding_decision.call_count == 2
    first_kwargs = mdb.upsert_lint_finding_decision.call_args_list[0].kwargs
    assert first_kwargs["tenant_id"] == "t1"
    assert first_kwargs["state"] == "acknowledged"
    assert first_kwargs["owner_user_id"] == "owner-9"
    assert first_kwargs["actor_user_id"] == "u1"


@patch("app.lint_workspace_routes.db")
def test_bulk_continues_past_per_item_failures(mdb):
    mdb.user_has_permission.return_value = True
    mdb.list_lint_finding_decisions.return_value = []
    mdb.upsert_lint_finding_decision.side_effect = [
        RuntimeError("boom"),
        _decision_row(id="d2", source_fingerprint="f2", state="fixed"),
    ]
    resp = _bulk(
        [{"sourceFingerprint": "f1"}, {"sourceFingerprint": "f2"}],
        {"state": "fixed"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["appliedCount"] == 1
    assert body["failedCount"] == 1
    assert body["results"][0]["ok"] is False
    assert body["results"][1]["ok"] is True


@patch("app.lint_workspace_routes.db")
def test_bulk_waiver_request_then_approval_flow(mdb):
    """waiver_requested is an edit; approving it into waived is publish-gated."""
    mdb.user_has_permission.return_value = True
    mdb.list_lint_finding_decisions.return_value = []
    mdb.upsert_lint_finding_decision.return_value = _decision_row(
        id="d1", source_fingerprint="f1", state="waiver_requested", rationale="please"
    )
    resp = _bulk(
        [{"sourceFingerprint": "f1"}],
        {"state": "waiver_requested", "rationale": "please"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["appliedCount"] == 1

    # Approval: current row is waiver_requested; approve into waived.
    mdb.list_lint_finding_decisions.return_value = [
        _decision_row(id="d1", source_fingerprint="f1", state="waiver_requested")
    ]
    mdb.upsert_lint_finding_decision.return_value = _decision_row(
        id="d1",
        source_fingerprint="f1",
        state="waived",
        rationale="approved",
        expires_at=NOW + timedelta(days=30),
    )
    resp2 = _bulk(
        [{"sourceFingerprint": "f1"}],
        {"state": "waived", "rationale": "approved", "expiresAt": "2026-08-13T12:00:00Z"},
    )
    assert resp2.status_code == 200, resp2.text
    body = resp2.json()
    assert body["appliedCount"] == 1
    assert body["results"][0]["beforeState"] == "waiver_requested"
    assert body["results"][0]["afterState"] == "waived"


def test_bulk_validates_state_and_caps_items():
    resp = _bulk([{"sourceFingerprint": "f1"}], {"state": "nonsense"})
    assert resp.status_code == 400

    resp2 = _bulk([{"sourceFingerprint": "f1"}], {})
    assert resp2.status_code == 400
    assert "state and/or an owner" in resp2.json()["detail"]

    too_many = [{"sourceFingerprint": f"f{i}"} for i in range(201)]
    resp3 = _bulk(too_many, {"state": "acknowledged"})
    assert resp3.status_code == 400
    assert "capped" in resp3.json()["detail"]


@patch("app.lint_workspace_routes.db")
def test_bulk_waiver_request_requires_rationale(mdb):
    mdb.user_has_permission.return_value = True
    resp = _bulk([{"sourceFingerprint": "f1"}], {"state": "waiver_requested"})
    assert resp.status_code == 400
    assert "rationale" in resp.json()["detail"].lower()


# --- Single decision upsert guard (lint_routes, CLX-4.1) --------------------------------------------


@patch("app.lint_routes.db")
def test_single_upsert_waiver_needs_publish(mdb):
    mdb.user_has_permission.side_effect = (
        lambda tenant, user, resource, action: action == "edit"
    )
    mdb.list_lint_finding_decisions.return_value = []
    resp = client.post(
        "/v1/lint/decisions",
        json={
            "sourceFingerprint": "f1",
            "state": "waived",
            "rationale": "ok",
            "expiresAt": "2026-08-01T00:00:00Z",
        },
    )
    assert resp.status_code == 403
    assert "lint_findings:publish" in resp.json()["detail"]


@patch("app.lint_routes.db")
def test_single_upsert_waiver_request_state(mdb):
    mdb.user_has_permission.return_value = True
    mdb.list_lint_finding_decisions.return_value = []
    mdb.upsert_lint_finding_decision.return_value = _decision_row(
        state="waiver_requested", rationale="please"
    )
    resp = client.post(
        "/v1/lint/decisions",
        json={
            "sourceFingerprint": "f1",
            "state": "waiver_requested",
            "rationale": "please",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["state"] == "waiver_requested"


# --- Tenant-wide SQL param alignment -------------------------------------------------------------


def test_tenant_wide_query_params_align_with_placeholders(monkeypatch):
    """Pin the SQL param order of the workspace read paths (regression: #4859).

    The UNION queries place BOTH subject CTEs before the per-branch filters, so params
    must be (catalog CTE ×3, mcp CTE ×1, branch, branch) — a swap puts an integer into
    ``ep.tenant_id`` and fails at runtime with ``operator does not exist: uuid = integer``,
    which mocked-db route tests can never see.
    """
    from app.database import db as real_db

    captured = []
    monkeypatch.setattr(
        real_db, "execute_query", lambda query, params=None: captured.append((query, params)) or []
    )

    real_db.list_latest_lint_evidence_runs_for_tenant("tenant-1")
    real_db.list_latest_axis_evaluations_for_tenant("tenant-1")
    real_db.list_latest_lint_policy_evaluations_for_tenant("tenant-1")

    evidence_q, evidence_p = captured[0]
    axis_q, axis_p = captured[1]
    policy_q, policy_p = captured[2]

    assert evidence_p == ("tenant-1", None, None, "tenant-1", 2, 2)
    assert axis_p == ("tenant-1", None, None, "tenant-1", "clx-axis-v1", "clx-axis-v1")
    assert policy_p == ("tenant-1", None, None, "tenant-1")
    # Placeholder count must match the params for every query.
    for query, params in captured:
        assert query.count("%s") == len(params)

    # Project-scoped variants (catalog branch only).
    captured.clear()
    real_db.list_latest_lint_evidence_runs_for_tenant("tenant-1", project_id="p1")
    real_db.list_latest_axis_evaluations_for_tenant("tenant-1", project_id="p1")
    real_db.list_latest_lint_policy_evaluations_for_tenant("tenant-1", project_id="p1")
    assert captured[0][1] == ("tenant-1", "p1", "p1", 2)
    assert captured[1][1] == ("tenant-1", "p1", "p1", "clx-axis-v1")
    assert captured[2][1] == ("tenant-1", "p1", "p1")
    for query, params in captured:
        assert query.count("%s") == len(params)


# --- Real auth dependency wiring ---------------------------------------------------------------


def test_findings_requires_tenant_slug_query_param():
    """Pin the tenant-scope contract against the REAL dependency (no override).

    ``validate_authentication`` takes ``tenant_slug`` and these routes have no path segment
    for it, so FastAPI surfaces it as a REQUIRED QUERY parameter — the UI proxies must send
    ``?tenant_slug=``. Without this test the dependency-override fixtures would hide a
    regression entirely (which is exactly how the original 422 shipped).
    """
    app.dependency_overrides.pop(validate_authentication, None)
    try:
        # Missing tenant_slug -> FastAPI request validation error.
        resp = client.get("/v1/lint/workspace/findings")
        assert resp.status_code == 422
        assert any(
            e.get("loc") == ["query", "tenant_slug"] for e in resp.json()["detail"]
        )
        # With tenant_slug but no credentials -> the route resolves and auth answers 401.
        resp2 = client.get("/v1/lint/workspace/findings", params={"tenant_slug": "acme"})
        assert resp2.status_code == 401
    finally:
        app.dependency_overrides[validate_authentication] = lambda: _JWT


# --- Saved views -------------------------------------------------------------------------------------


def _view_row(**overrides):
    row = {
        "id": "11111111-1111-1111-1111-111111111111",
        "tenant_id": "t1",
        "user_id": "u1",
        "name": "Security errors",
        "filters": {"severity": ["error"], "axis": ["security"]},
        "query": "",
        "sort": "severity",
        "is_pinned": True,
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(overrides)
    return row


@patch("app.lint_workspace_routes.db")
def test_saved_views_list_and_create(mdb):
    mdb.list_lint_workspace_saved_views.return_value = [_view_row()]
    resp = client.get("/v1/lint/workspace/views")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["views"][0]["name"] == "Security errors"
    assert body["views"][0]["isPinned"] is True

    mdb.create_lint_workspace_saved_view.return_value = _view_row()
    resp2 = client.post(
        "/v1/lint/workspace/views",
        json={
            "name": "Security errors",
            "filters": {"severity": "error", "axis": "security"},
            "sort": "severity",
            "isPinned": True,
        },
    )
    assert resp2.status_code == 201, resp2.text
    create_kwargs = mdb.create_lint_workspace_saved_view.call_args.kwargs
    # Filters are normalized into canonical csv-expanded lists.
    assert create_kwargs["filters"] == {"severity": ["error"], "axis": ["security"]}


@patch("app.lint_workspace_routes.db")
def test_saved_views_reject_invalid_filters_and_duplicates(mdb):
    resp = client.post(
        "/v1/lint/workspace/views",
        json={"name": "Bad", "filters": {"severity": "catastrophic"}},
    )
    assert resp.status_code == 422

    from psycopg2 import errors as pg_errors

    mdb.create_lint_workspace_saved_view.side_effect = pg_errors.UniqueViolation()
    resp2 = client.post(
        "/v1/lint/workspace/views",
        json={"name": "Security errors", "filters": {}},
    )
    assert resp2.status_code == 409


@patch("app.lint_workspace_routes.db")
def test_saved_views_patch_and_delete_404s(mdb):
    mdb.update_lint_workspace_saved_view.return_value = None
    resp = client.patch(
        "/v1/lint/workspace/views/11111111-1111-1111-1111-111111111111",
        json={"name": "Renamed"},
    )
    assert resp.status_code == 404

    mdb.delete_lint_workspace_saved_view.return_value = False
    resp2 = client.delete(
        "/v1/lint/workspace/views/11111111-1111-1111-1111-111111111111"
    )
    assert resp2.status_code == 404


@patch("app.lint_workspace_routes.db")
def test_saved_views_require_attributable_user(mdb):
    mdb.get_fallback_creator_user_id_for_tenant.return_value = None
    app.dependency_overrides[validate_authentication] = lambda: {
        "tenant_id": "t1",
        "auth_method": "api_key",
    }
    resp = client.get("/v1/lint/workspace/views")
    assert resp.status_code == 403
