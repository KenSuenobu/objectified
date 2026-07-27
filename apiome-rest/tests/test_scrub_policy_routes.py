"""Endpoint tests for the intake secret-scrub policy API — MFI-29.6 (#4393).

The DB layer is patched (on ``app.scrub_policy_routes.db`` and, where the route reads through
the resolver, ``app.intake_scrub_policy.db``) so these tests exercise the route contract: the
enforce default a tenant sees before saving anything, the admin gate on writes, carry-forward
of omitted fields, override validation, the append-only version history, and the audit row
every mutation writes.

Relaxing this policy is the one governance change that can let a live credential persist, so
the admin gate and the audit trail are pinned as tightly as the behaviour itself.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.intake_scrub_policy import ALWAYS_ENFORCED_FORMATS
from app.main import app

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"
POLICY_ID = "11111111-1111-1111-1111-111111111111"
NOW = datetime(2026, 7, 26, 12, 0, tzinfo=timezone.utc)

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "email": "admin@example.com",
    "auth_method": "jwt",
}

POLICY_URL = f"/v1/tenants/{TENANT_SLUG}/governance/secret-scrub-policy"
VERSIONS_URL = f"{POLICY_URL}/versions"


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
    with patch("app.scrub_policy_routes.db.is_user_tenant_admin", return_value=True):
        yield


@pytest.fixture(autouse=True)
def _audit():
    """Capture audit rows instead of writing them, and assert they are attempted."""
    rows: List[Dict[str, Any]] = []
    with patch(
        "app.scrub_policy_routes.db.write_access_audit",
        side_effect=lambda **kwargs: rows.append(kwargs),
    ):
        yield rows


def _row(**overrides: Any) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "id": POLICY_ID,
        "tenant_id": TENANT_ID,
        "version_number": 2,
        "content_fingerprint": "fp-scrub",
        "mode": "warn_only",
        "entropy_detection": False,
        "format_overrides": {"har": {"mode": "enforce"}},
        "actor_user_id": USER_ID,
        "actor_label": "admin@example.com",
        "created_at": NOW,
    }
    row.update(overrides)
    return row


# --- read ------------------------------------------------------------------------------


def test_get_returns_the_enforce_default_when_nothing_is_saved():
    """An upgrade must change nothing: no row means the behaviour tenants already had."""
    with patch("app.scrub_policy_routes.db.get_latest_intake_secret_scrub_policy", return_value=None):
        response = client.get(POLICY_URL)

    assert response.status_code == 200
    body = response.json()
    assert body["isDefault"] is True
    assert body["mode"] == "enforce"
    assert body["entropyDetection"] is True
    assert body["versionNumber"] == 0
    assert body["formatOverrides"] == {}


def test_get_returns_the_saved_policy():
    with patch(
        "app.scrub_policy_routes.db.get_latest_intake_secret_scrub_policy", return_value=_row()
    ):
        response = client.get(POLICY_URL)

    assert response.status_code == 200
    body = response.json()
    assert body["isDefault"] is False
    assert body["mode"] == "warn_only"
    assert body["entropyDetection"] is False
    assert body["versionNumber"] == 2
    assert body["policyVersionId"] == POLICY_ID
    assert body["formatOverrides"] == {"har": {"mode": "enforce"}}
    assert body["actorLabel"] == "admin@example.com"


def test_get_advertises_the_always_enforced_formats():
    """A tenant reading a warn-only policy must be able to see what it does *not* cover."""
    with patch("app.scrub_policy_routes.db.get_latest_intake_secret_scrub_policy", return_value=None):
        response = client.get(POLICY_URL)

    assert response.json()["alwaysEnforcedFormats"] == sorted(ALWAYS_ENFORCED_FORMATS)


def test_versions_lists_newest_first():
    rows = [_row(version_number=3, id="33333333-3333-3333-3333-333333333333"), _row()]
    with patch(
        "app.scrub_policy_routes.db.list_intake_secret_scrub_policy_versions", return_value=rows
    ):
        response = client.get(VERSIONS_URL)

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert [version["versionNumber"] for version in body["versions"]] == [3, 2]


# --- write -----------------------------------------------------------------------------


def test_put_appends_a_version_and_audits_it(_audit):
    saved = _row(version_number=3, mode="warn_only")
    with patch(
        "app.intake_scrub_policy.db.get_latest_intake_secret_scrub_policy", return_value=None
    ), patch(
        "app.scrub_policy_routes.db.insert_intake_secret_scrub_policy", return_value=saved
    ) as insert:
        response = client.put(POLICY_URL, json={"mode": "warn_only"})

    assert response.status_code == 200
    assert response.json()["mode"] == "warn_only"
    assert insert.call_args.kwargs["mode"] == "warn_only"
    # The fingerprint is content-addressed, not echoed from the request.
    assert len(insert.call_args.kwargs["content_fingerprint"]) == 64

    assert len(_audit) == 1
    detail = _audit[0]["detail"]
    assert detail["mode"] == "warn_only"
    assert detail["previousMode"] == "enforce"
    assert _audit[0]["action"] == "governance.secret_scrub_policy.update"


def test_put_carries_forward_omitted_fields(_audit):
    """Changing the mode must not silently reset the entropy switch or the overrides."""
    with patch(
        "app.intake_scrub_policy.db.get_latest_intake_secret_scrub_policy", return_value=_row()
    ), patch(
        "app.scrub_policy_routes.db.insert_intake_secret_scrub_policy", return_value=_row()
    ) as insert:
        response = client.put(POLICY_URL, json={"mode": "enforce"})

    assert response.status_code == 200
    kwargs = insert.call_args.kwargs
    assert kwargs["mode"] == "enforce"
    assert kwargs["entropy_detection"] is False, "the entropy switch was reset"
    assert kwargs["format_overrides"] == {"har": {"mode": "enforce"}}, "overrides were dropped"


def test_put_normalizes_override_format_keys():
    with patch(
        "app.intake_scrub_policy.db.get_latest_intake_secret_scrub_policy", return_value=None
    ), patch(
        "app.scrub_policy_routes.db.insert_intake_secret_scrub_policy", return_value=_row()
    ) as insert:
        response = client.put(
            POLICY_URL, json={"formatOverrides": {"  Postman ": {"mode": "warn_only"}}}
        )

    assert response.status_code == 200
    assert insert.call_args.kwargs["format_overrides"] == {"postman": {"mode": "warn_only"}}


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ({"formatOverrides": {"openapi": "warn_only"}}, "override is not an object"),
        ({"formatOverrides": {"openapi": {}}}, "override states no mode"),
        ({"formatOverrides": {"openapi": {"mode": "off"}}}, "mode is not in the vocabulary"),
        ({"formatOverrides": {"openapi": {"mode": "enforce", "extra": 1}}}, "unknown field"),
        ({"mode": "disabled"}, "tenant mode is not in the vocabulary"),
    ],
)
def test_put_rejects_a_malformed_policy(payload, reason):
    """A malformed override must be refused, never stored and then ignored at resolution."""
    with patch(
        "app.intake_scrub_policy.db.get_latest_intake_secret_scrub_policy", return_value=None
    ), patch("app.scrub_policy_routes.db.insert_intake_secret_scrub_policy") as insert:
        response = client.put(POLICY_URL, json=payload)

    assert response.status_code == 422, reason
    insert.assert_not_called()


def test_put_is_refused_for_a_non_admin():
    with patch("app.scrub_policy_routes.db.is_user_tenant_admin", return_value=False), patch(
        "app.scrub_policy_routes.db.insert_intake_secret_scrub_policy"
    ) as insert:
        response = client.put(POLICY_URL, json={"mode": "warn_only"})

    assert response.status_code == 403
    insert.assert_not_called()


def test_put_reports_a_store_failure_as_a_400():
    with patch(
        "app.intake_scrub_policy.db.get_latest_intake_secret_scrub_policy", return_value=None
    ), patch(
        "app.scrub_policy_routes.db.insert_intake_secret_scrub_policy",
        side_effect=RuntimeError("constraint violated"),
    ):
        response = client.put(POLICY_URL, json={"mode": "warn_only"})

    assert response.status_code == 400
    assert "Could not save" in response.json()["detail"]


def test_get_is_readable_by_a_non_admin():
    """Any member may read the policy; only administrators may change it."""
    with patch("app.scrub_policy_routes.db.is_user_tenant_admin", return_value=False), patch(
        "app.scrub_policy_routes.db.get_latest_intake_secret_scrub_policy", return_value=_row()
    ):
        response = client.get(POLICY_URL)

    assert response.status_code == 200
