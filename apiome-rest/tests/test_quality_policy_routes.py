"""Endpoint tests for the import/export quality policy API — IXH-2.3 (#5098).

The DB layer is patched (on ``app.quality_policy_routes.db`` and, where the routes call
through the engine, ``app.import_export_quality_policy.db``) so these tests exercise the route
contract: the advisory default a tenant sees before saving anything, the admin gate on writes,
the append-only version history, the server-side role check on a waiver grant, the audit rows
every mutation writes, and the 409 the import-start endpoint returns when policy blocks.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"
POLICY_ID = "11111111-1111-1111-1111-111111111111"
NOW = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "email": "admin@example.com",
    "auth_method": "jwt",
}

POLICY_URL = f"/v1/tenants/{TENANT_SLUG}/governance/quality-policy"
WAIVER_URL = f"/v1/tenants/{TENANT_SLUG}/governance/quality-waivers"


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    app.openapi_schema = None
    yield
    app.dependency_overrides.clear()
    app.openapi_schema = None


@pytest.fixture(autouse=True)
def _admin():
    """Policy writes require a tenant admin; default every test to an admin caller."""
    with patch("app.quality_policy_routes.db.is_user_tenant_admin", return_value=True):
        yield


@pytest.fixture(autouse=True)
def _audit():
    """Capture audit rows instead of writing them, and assert they are attempted."""
    rows: List[Dict[str, Any]] = []
    with patch(
        "app.quality_policy_routes.db.write_access_audit",
        side_effect=lambda **kwargs: rows.append(kwargs),
    ):
        yield rows


def _row(**overrides: Any) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "id": POLICY_ID,
        "tenant_id": TENANT_ID,
        "version_number": 2,
        "content_fingerprint": "fp-policy",
        "import_min_grade": "B",
        "import_min_score": 80,
        "import_block_on_severity": "error",
        "import_enforcement": "block",
        "export_min_grade": None,
        "export_min_score": None,
        "export_block_on_severity": None,
        "export_enforcement": "advisory",
        "format_overrides": {"openapi": {"import": {"minScore": 95}}},
        "allow_override": True,
        "override_roles": ["owner", "admin"],
        "waiver_ttl_hours": 48,
        "actor_user_id": USER_ID,
        "actor_label": "admin@example.com",
        "created_at": NOW,
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def test_openapi_exposes_the_policy_and_waiver_operations():
    spec = app.openapi()
    policy_path = "/v1/tenants/{tenant_slug}/governance/quality-policy"
    waiver_path = "/v1/tenants/{tenant_slug}/governance/quality-waivers"
    assert {"get", "put"} <= set(spec["paths"][policy_path])
    assert {"get", "post"} <= set(spec["paths"][waiver_path])


def test_tenant_without_a_policy_reads_the_advisory_default():
    with patch(
        "app.quality_policy_routes.db.get_latest_import_export_quality_policy",
        return_value=None,
    ):
        response = client.get(POLICY_URL)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["isDefault"] is True
    assert body["versionNumber"] == 0
    assert body["import"] == {
        "minGrade": None,
        "minScore": None,
        "blockOnSeverity": None,
        "enforcement": "advisory",
    }
    assert body["export"]["enforcement"] == "advisory"
    assert body["allowOverride"] is True
    assert body["waiverTtlHours"] == 168


def test_saved_policy_is_reported_with_its_resolution_inputs():
    with patch(
        "app.quality_policy_routes.db.get_latest_import_export_quality_policy",
        return_value=_row(),
    ):
        response = client.get(POLICY_URL)
    body = response.json()
    assert body["isDefault"] is False
    assert body["policyVersionId"] == POLICY_ID
    assert body["import"]["minGrade"] == "B"
    assert body["import"]["enforcement"] == "block"
    assert body["formatOverrides"] == {"openapi": {"import": {"minScore": 95}}}
    assert body["overrideRoles"] == ["owner", "admin"]


def test_version_history_lists_saved_versions_newest_first():
    rows = [_row(version_number=2), _row(version_number=1, id="22222222-2222-2222-2222-222222222222")]
    with patch(
        "app.quality_policy_routes.db.list_import_export_quality_policy_versions",
        return_value=rows,
    ):
        response = client.get(f"{POLICY_URL}/versions")
    body = response.json()
    assert body["count"] == 2
    assert [v["versionNumber"] for v in body["versions"]] == [2, 1]


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def test_saving_a_policy_appends_a_version_and_audits_it(_audit):
    captured: Dict[str, Any] = {}

    def _insert(**kwargs: Any) -> Dict[str, Any]:
        captured.update(kwargs)
        return _row(
            import_min_grade=kwargs["import_min_grade"],
            import_enforcement=kwargs["import_enforcement"],
            content_fingerprint=kwargs["content_fingerprint"],
            version_number=3,
        )

    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=None,
    ), patch(
        "app.quality_policy_routes.db.insert_import_export_quality_policy",
        side_effect=_insert,
    ):
        response = client.put(
            POLICY_URL,
            json={"import": {"minGrade": "B", "enforcement": "block"}},
        )
    assert response.status_code == 200, response.text
    assert response.json()["versionNumber"] == 3
    assert captured["import_min_grade"] == "B"
    assert captured["import_enforcement"] == "block"
    assert len(captured["content_fingerprint"]) == 64

    assert len(_audit) == 1
    audit = _audit[0]
    assert audit["action"] == "governance.quality_policy.update"
    assert audit["detail"]["import"]["minGrade"] == "B"
    assert audit["actor_id"] == USER_ID


def test_saving_a_policy_carries_omitted_sections_forward():
    captured: Dict[str, Any] = {}

    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=_row(export_min_score=70, export_enforcement="block"),
    ), patch(
        "app.quality_policy_routes.db.insert_import_export_quality_policy",
        side_effect=lambda **kwargs: (captured.update(kwargs), _row())[1],
    ):
        response = client.put(POLICY_URL, json={"import": {"minScore": 60}})
    assert response.status_code == 200, response.text
    assert captured["export_min_score"] == 70
    assert captured["export_enforcement"] == "block"
    assert captured["waiver_ttl_hours"] == 48  # untouched
    assert captured["format_overrides"] == {"openapi": {"import": {"minScore": 95}}}


def test_saving_a_policy_requires_a_tenant_admin():
    with patch("app.quality_policy_routes.db.is_user_tenant_admin", return_value=False):
        response = client.put(POLICY_URL, json={"import": {"minScore": 60}})
    assert response.status_code == 403
    assert "administrators" in response.json()["detail"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"openapi": "strict"},  # not an object
        {"openapi": {"publish": {"minScore": 90}}},  # unknown scope
        {"openapi": {"import": {"minScore": 900}}},  # out-of-range score
        {"openapi": {"import": {"enforcement": "warn"}}},  # unknown enforcement mode
    ],
)
def test_malformed_format_overrides_are_rejected(overrides):
    """Silently ignoring an override would leave a tenant believing a format is gated."""
    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=None,
    ), patch(
        "app.quality_policy_routes.db.insert_import_export_quality_policy",
        side_effect=lambda **_k: pytest.fail("a malformed override reached the store"),
    ):
        response = client.put(POLICY_URL, json={"formatOverrides": overrides})
    assert response.status_code == 422, response.text


def test_format_override_keys_are_normalized_to_the_resolver_vocabulary():
    captured: Dict[str, Any] = {}
    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=None,
    ), patch(
        "app.quality_policy_routes.db.insert_import_export_quality_policy",
        side_effect=lambda **kwargs: (captured.update(kwargs), _row())[1],
    ):
        response = client.put(
            POLICY_URL,
            json={"formatOverrides": {"OpenAPI": {"import": {"minGrade": "A"}}}},
        )
    assert response.status_code == 200, response.text
    assert list(captured["format_overrides"]) == ["openapi"]


# ---------------------------------------------------------------------------
# Waivers
# ---------------------------------------------------------------------------


def _waiver_row(**overrides: Any) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "id": "33333333-3333-3333-3333-333333333333",
        "tenant_id": TENANT_ID,
        "scope": "import",
        "subject_key": "a" * 64,
        "subject_label": "petstore.yaml",
        "format_key": "openapi",
        "report_fingerprint": "lint-fp",
        "score": 41,
        "grade": "F",
        "policy_version_id": POLICY_ID,
        "policy_content_fingerprint": "fp-policy",
        "reason": "demo deadline",
        "expires_at": NOW + timedelta(hours=48),
        "expiry_notified_at": None,
        "actor_user_id": USER_ID,
        "actor_label": "admin@example.com",
        "actor_role": "owner",
        "created_at": NOW,
    }
    row.update(overrides)
    return row


def test_a_permitted_role_may_record_a_waiver(_audit):
    captured: Dict[str, Any] = {}
    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=_row(),
    ), patch(
        "app.import_export_quality_policy.db.get_effective_role_slug", return_value="owner"
    ), patch(
        "app.import_export_quality_policy.db.insert_import_export_quality_waiver",
        side_effect=lambda **kwargs: (captured.update(kwargs), _waiver_row())[1],
    ):
        response = client.post(
            WAIVER_URL,
            json={
                "scope": "import",
                "subjectKey": "a" * 64,
                "subjectLabel": "petstore.yaml",
                "formatKey": "openapi",
                "reason": "demo deadline",
                "score": 41,
                "grade": "F",
                "reportFingerprint": "lint-fp",
            },
        )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["scope"] == "import"
    assert body["actorRole"] == "owner"
    assert body["reason"] == "demo deadline"
    # TTL comes from the policy, not the client.
    assert captured["expires_at"] - datetime.now(timezone.utc) < timedelta(hours=48, minutes=1)
    assert captured["actor_role"] == "owner"

    grant = [a for a in _audit if a["action"] == "governance.quality_waiver.grant"]
    assert len(grant) == 1
    assert grant[0]["detail"]["subjectKey"] == "a" * 64


def test_a_role_the_policy_does_not_name_may_not_waive():
    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=_row(),
    ), patch(
        "app.import_export_quality_policy.db.get_effective_role_slug", return_value="editor"
    ), patch(
        "app.import_export_quality_policy.db.insert_import_export_quality_waiver",
        side_effect=lambda **_k: pytest.fail("a forbidden role recorded a waiver"),
    ):
        response = client.post(
            WAIVER_URL, json={"subjectKey": "a" * 64, "reason": "please"}
        )
    assert response.status_code == 403
    assert "owner, admin" in response.json()["detail"]


def test_a_policy_that_forbids_overrides_refuses_every_waiver():
    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=_row(allow_override=False),
    ), patch(
        "app.import_export_quality_policy.db.get_effective_role_slug", return_value="owner"
    ):
        response = client.post(
            WAIVER_URL, json={"subjectKey": "a" * 64, "reason": "please"}
        )
    assert response.status_code == 403
    assert "does not permit overrides" in response.json()["detail"]


def test_a_waiver_requires_a_reason():
    response = client.post(WAIVER_URL, json={"subjectKey": "a" * 64, "reason": ""})
    assert response.status_code == 422


def test_waiver_ledger_lists_active_waivers():
    with patch(
        "app.quality_policy_routes.db.list_import_export_quality_waivers",
        return_value=[_waiver_row()],
    ) as listed:
        response = client.get(f"{WAIVER_URL}?scope=import")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["count"] == 1
    assert body["waivers"][0]["subjectLabel"] == "petstore.yaml"
    assert listed.call_args.kwargs["scope"] == "import"
    assert listed.call_args.kwargs["active_only"] is True


def test_waiver_ledger_rejects_an_unknown_scope():
    response = client.get(f"{WAIVER_URL}?scope=publish")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Server-side enforcement at the import-start endpoint
# ---------------------------------------------------------------------------


def _start_body(**option_overrides: Any) -> Dict[str, Any]:
    return {
        "metadata": {
            "source_kind": "graphql",
            "project": {"name": "Orders", "slug": "orders"},
            "version": {"version_id": "1.0.0"},
            "options": {**option_overrides},
        },
        "document_base64": base64.standard_b64encode(
            b"type Query { hello: String }"
        ).decode("ascii"),
        "filename": "schema.graphql",
    }


def test_blocked_import_is_refused_before_a_job_is_created():
    """The gate is server-side: ignoring the pre-flight verdict does not get you past it."""

    class _Lint:
        score = 41
        grade = "F"
        severity_counts = {"error": 3}

    class _Detection:
        adapter_key = "graphql"

    class _Report:
        ok = True
        lint = _Lint()
        detection = _Detection()

    async def _report(*_a: Any, **_k: Any):
        return _Report()

    with patch("app.spec_import_routes.enforce_permission", return_value=None), patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=_row(format_overrides={}),
    ), patch(
        "app.import_export_quality_policy.db.list_active_import_export_quality_waivers",
        return_value=[],
    ), patch(
        "app.import_preflight.run_import_preflight", side_effect=_report
    ), patch(
        "app.spec_import_routes.schedule_spec_import",
        side_effect=lambda *_a, **_k: pytest.fail("a blocked import created a job"),
    ):
        response = client.post(f"/v1/tenants/{TENANT_SLUG}/imports", json=_start_body())
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "QUALITY_POLICY_BLOCKED"
    assert detail["category"] == "policy"
    assert detail["retriable"] is False
    assert detail["policy"]["blocking"] is True
    assert detail["remediation"]


def test_dry_run_start_is_never_gated():
    """A dry run persists nothing, so there is nothing for the intake gate to protect."""
    scheduled: List[Any] = []

    async def _schedule(*args: Any, **_kwargs: Any):
        scheduled.append(args)
        return {
            "job_id": "j1",
            "status": "queued",
            "tenant_slug": TENANT_SLUG,
            "status_path": f"/v1/tenants/{TENANT_SLUG}/imports/j1",
        }

    with patch("app.spec_import_routes.enforce_permission", return_value=None), patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        side_effect=lambda _t: pytest.fail("the gate ran for a dry run"),
    ), patch("app.spec_import_routes.schedule_spec_import", side_effect=_schedule):
        response = client.post(
            f"/v1/tenants/{TENANT_SLUG}/imports", json=_start_body(dry_run=True)
        )
    assert response.status_code == 202, response.text
    assert len(scheduled) == 1


def test_start_rejects_a_document_that_is_not_base64():
    body = _start_body()
    body["document_base64"] = "not base64!!"
    with patch("app.spec_import_routes.enforce_permission", return_value=None), patch(
        "app.spec_import_routes.schedule_spec_import",
        side_effect=lambda *_a, **_k: pytest.fail("an undecodable document started a job"),
    ):
        response = client.post(f"/v1/tenants/{TENANT_SLUG}/imports", json=body)
    assert response.status_code == 422, response.text


def test_audit_detail_is_json_serializable(_audit):
    """The audit writer serializes ``detail`` with json.dumps — it must not choke on it."""
    with patch(
        "app.import_export_quality_policy.db.get_latest_import_export_quality_policy",
        return_value=None,
    ), patch(
        "app.quality_policy_routes.db.insert_import_export_quality_policy",
        return_value=_row(),
    ):
        client.put(POLICY_URL, json={"import": {"minScore": 60, "enforcement": "block"}})
    assert json.dumps(_audit[0]["detail"], sort_keys=True, default=str)
