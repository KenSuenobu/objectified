"""The webhook source-IP allowlist REST surface (REPO-7.6, #2804).

Two surfaces in one file, because they are two halves of one acceptance criterion.

``POST /v1/repositories/webhook/{provider}`` is the enforcement point: a source address
nobody vouches for gets a 403, and — the part that makes it defense in depth rather than a
second opinion — the dispatcher is never called at all, so nothing ever reaches
``verify_signature``.

``/v1/tenants/{slug}/repository-webhook-ip-allowlist`` is the admin surface: readable by
anyone who can see imports, writable only by a tenant administrator, because widening the set
of addresses that may reach the signature check is the same class of act as turning the
filter off.
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.config import settings
from app.main import app
from app.repository_webhook_dispatch import OUTCOME_ENQUEUED, WebhookIngestResult
from app.repository_webhook_ip_allowlist import (
    IP_ALLOWLIST_UPDATED_ACTION,
    IP_POLICY_UPDATED_ACTION,
    reset_provider_range_cache,
)

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_USER_ID = "660e8400-e29b-41d4-a716-446655440001"
_ENTRY_ID = "aa0e8400-e29b-41d4-a716-44665544000a"
_URL = "/v1/tenants/acme/repository-webhook-ip-allowlist"
_GITHUB_HOOK_RANGE = "192.30.252.0/22"
_GITHUB_HOOK_IP = "192.30.252.7"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": _USER_ID,
    "auth_method": "jwt",
}
_API_KEY_AUTH = {**_JWT, "auth_method": "api_key"}


@pytest.fixture(autouse=True)
def _no_range_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "repository_webhook_ip_cache_seconds", 0)
    reset_provider_range_cache()
    yield
    reset_provider_range_cache()


@pytest.fixture
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


@pytest.fixture
def auth_api_key():
    app.dependency_overrides[validate_authentication] = lambda: _API_KEY_AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


# =========================================================================================
# The enforcement point
# =========================================================================================


def _post_delivery(
    *,
    provider_ranges: Optional[List[Dict[str, Any]]] = None,
    tenant_ids: Optional[List[str]] = None,
    tenant_entries: Optional[List[Dict[str, Any]]] = None,
    policy: Optional[Dict[str, Any]] = None,
    body: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
):
    """Drive the ingestion endpoint against a mocked store, returning (response, ingest)."""
    with (
        patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest,
        patch("app.repository_webhook_routes.db") as route_db,
    ):
        ingest.return_value = WebhookIngestResult(outcome=OUTCOME_ENQUEUED, jobs_enqueued=1)
        route_db.list_webhook_provider_ip_ranges.return_value = provider_ranges or []
        route_db.list_repository_webhook_tenant_ids.return_value = tenant_ids or []
        route_db.list_tenant_webhook_ip_allowlist.return_value = tenant_entries or []
        route_db.get_tenant_webhook_ip_policy.return_value = policy
        response = client.post(
            "/v1/repositories/webhook/github",
            content=(body if body is not None else json.dumps(
                {"repository": {"full_name": "octocat/Hello-World"}}
            ).encode("utf-8")),
            headers={"Content-Type": "application/json", **(headers or {})},
        )
    return response, ingest


def _range_row(cidr: str = _GITHUB_HOOK_RANGE) -> Dict[str, Any]:
    return {"cidr": cidr, "family": 4, "source": "provider", "refreshed_at": None}


def test_the_filter_is_off_by_default_so_an_upgrade_changes_nothing() -> None:
    """Enforcement that switched itself on would 403 every existing deployment's
    deliveries, and providers quietly retrying into a 403 is a near-invisible outage."""
    response, ingest = _post_delivery()
    assert response.status_code == 200
    ingest.assert_called_once()


@pytest.mark.usefixtures("_no_range_cache")
def test_a_disallowed_source_is_a_403(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    response, _ = _post_delivery(provider_ranges=[_range_row()])
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "source_not_allowed"


def test_a_blocked_delivery_never_reaches_the_signature_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The acceptance criterion in one assertion: blocked means "not given a chance to
    verify", not "verified and then rejected"."""
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    _, ingest = _post_delivery(provider_ranges=[_range_row()])
    ingest.assert_not_called()


def test_the_403_body_names_neither_the_allowlist_nor_a_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A richer body would answer "what is your network policy" for anyone willing to send
    one unsigned POST."""
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    response, _ = _post_delivery(
        provider_ranges=[_range_row()], tenant_ids=[_TENANT_ID]
    )
    body = json.dumps(response.json())
    assert _TENANT_ID not in body
    assert _GITHUB_HOOK_RANGE not in body
    assert "octocat" not in body


def test_a_delivery_from_the_providers_published_range_is_handled_normally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    # TestClient reports 'testclient' as the socket peer, which is not an address, so the
    # case is driven through a trusted proxy hop: one proxy, and the header entry it
    # appended is the real client.
    monkeypatch.setattr(settings, "repository_webhook_trusted_proxy_hops", 1)
    response, ingest = _post_delivery(
        provider_ranges=[_range_row()], headers={"X-Forwarded-For": _GITHUB_HOOK_IP}
    )
    assert response.status_code == 200
    ingest.assert_called_once()


def test_a_tenants_own_range_lets_its_own_delivery_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    monkeypatch.setattr(settings, "repository_webhook_trusted_proxy_hops", 1)
    response, ingest = _post_delivery(
        provider_ranges=[_range_row()],
        tenant_ids=[_TENANT_ID],
        tenant_entries=[{"cidr": "203.0.113.0/24", "enabled": True}],
        headers={"X-Forwarded-For": "203.0.113.9"},
    )
    assert response.status_code == 200
    ingest.assert_called_once()


def test_a_tenant_that_bypassed_enforcement_accepts_any_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    response, ingest = _post_delivery(
        provider_ranges=[_range_row()],
        tenant_ids=[_TENANT_ID],
        policy={"enforcement_enabled": False, "bypass_reason": "vendor relay"},
    )
    assert response.status_code == 200
    ingest.assert_called_once()


def test_an_unsupported_provider_is_still_a_400_not_a_403() -> None:
    """The provider check comes first: an unknown provider has no signature scheme, so
    there is no filter to apply and nothing to hide."""
    response = client.post("/v1/repositories/webhook/sourcehut", content=b"{}")
    assert response.status_code == 400


def test_an_unreadable_body_is_blocked_rather_than_400d_when_enforcing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A body the guard cannot scope to a tenant falls through to the provider-range
    verdict; the 400 still exists, for the deliveries that get past the filter."""
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    response, ingest = _post_delivery(
        provider_ranges=[_range_row()], body=b"<not json>"
    )
    assert response.status_code == 403
    ingest.assert_not_called()


# =========================================================================================
# The admin surface
# =========================================================================================


def _admin_db(**overrides: Any) -> MagicMock:
    db = MagicMock()
    db.is_user_tenant_admin.return_value = True
    db.get_tenant_webhook_ip_policy.return_value = None
    db.list_webhook_provider_ip_refresh.return_value = [
        {
            "provider": "github",
            "last_attempt_at": datetime(2026, 8, 1, 10, tzinfo=timezone.utc),
            "last_success_at": datetime(2026, 8, 1, 10, tzinfo=timezone.utc),
            "last_outcome": "success",
            "last_error": None,
            "range_count": 1,
        }
    ]
    db.list_webhook_provider_ip_ranges.side_effect = (
        lambda provider: [_range_row()] if provider == "github" else []
    )
    db.list_tenant_webhook_ip_allowlist.return_value = [
        {
            "id": _ENTRY_ID,
            "cidr": "203.0.113.0/24",
            "family": 4,
            "description": "vendor relay",
            "enabled": True,
            "created_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
        }
    ]
    for key, value in overrides.items():
        setattr(db, key, value)
    return db


def _with_admin_db(db: MagicMock):
    """Patch the routes' database and permission check for one call."""
    return (
        patch("app.tenant_repositories_routes.db", db),
        patch("app.tenant_repositories_routes.enforce_permission"),
    )


def _get(db: MagicMock):
    perms, enforce = _with_admin_db(db)
    with perms, enforce:
        return client.get(_URL)


def _mutate(db: MagicMock, method: str, url: str, payload: Any = None):
    perms, enforce = _with_admin_db(db)
    with perms, enforce:
        return getattr(client, method)(url, json=payload) if payload is not None else getattr(
            client, method
        )(url)


# --- the read ----------------------------------------------------------------------------


def test_the_read_reports_the_posture_the_ranges_and_the_entries(auth_jwt) -> None:
    response = _get(_admin_db())
    assert response.status_code == 200
    body = response.json()
    assert body["enforcementEnabled"] is False
    assert body["tenantEnforcementEnabled"] is True
    assert [p["provider"] for p in body["providers"]] == ["github", "gitlab", "bitbucket"]
    assert body["entries"][0]["cidr"] == "203.0.113.0/24"


def test_the_read_is_camel_case_on_the_wire(auth_jwt) -> None:
    """The UI binds to these names; a snake_case leak is a silently blank panel."""
    body = _get(_admin_db()).json()
    assert "refreshIntervalSeconds" in body
    assert "trustedProxyHops" in body
    assert set(body["providers"][0]) >= {"rangeCount", "lastSuccessAt", "lastOutcome", "stale"}
    assert set(body["entries"][0]) >= {"createdAt", "updatedAt"}


def test_the_read_does_not_require_an_administrator(auth_jwt) -> None:
    """Seeing the filter is how a member diagnoses "our webhooks stopped"; only changing
    it is privileged."""
    db = _admin_db()
    db.is_user_tenant_admin.return_value = False
    assert _get(db).status_code == 200


# --- adding an entry ---------------------------------------------------------------------


def test_an_administrator_can_add_a_range(auth_jwt) -> None:
    db = _admin_db()
    response = _mutate(
        db, "post", f"{_URL}/entries", {"cidr": "203.0.113.9", "description": "relay"}
    )
    assert response.status_code == 200
    kwargs = db.add_tenant_webhook_ip_allowlist_entry.call_args.kwargs
    assert kwargs["cidr"] == "203.0.113.9/32"
    assert kwargs["family"] == 4
    assert kwargs["created_by"] == _USER_ID


def test_adding_a_range_is_audited(auth_jwt) -> None:
    db = _admin_db()
    _mutate(db, "post", f"{_URL}/entries", {"cidr": "203.0.113.0/24", "description": "relay"})
    args = db.insert_workflow_audit.call_args.args
    assert args[0] == _TENANT_ID
    assert args[3] == IP_ALLOWLIST_UPDATED_ACTION
    assert args[6]["change"] == "added"


def test_a_non_administrator_cannot_add_a_range(auth_jwt) -> None:
    """Widening the set of addresses that may reach the signature check is the same class
    of act as turning the filter off."""
    db = _admin_db()
    db.is_user_tenant_admin.return_value = False
    response = _mutate(
        db, "post", f"{_URL}/entries", {"cidr": "203.0.113.0/24", "description": "relay"}
    )
    assert response.status_code == 403
    db.add_tenant_webhook_ip_allowlist_entry.assert_not_called()


def test_an_api_key_cannot_add_a_range(auth_api_key) -> None:
    """An API key must not escalate into a network-policy change by resolving to the
    account that created it."""
    db = _admin_db()
    response = _mutate(
        db, "post", f"{_URL}/entries", {"cidr": "203.0.113.0/24", "description": "relay"}
    )
    assert response.status_code == 403


def test_a_cidr_with_host_bits_is_a_400_not_a_silent_widening(auth_jwt) -> None:
    db = _admin_db()
    response = _mutate(
        db, "post", f"{_URL}/entries", {"cidr": "10.0.0.1/24", "description": "relay"}
    )
    assert response.status_code == 400
    assert "host bits" in response.json()["detail"]
    db.add_tenant_webhook_ip_allowlist_entry.assert_not_called()


def test_an_entry_without_a_reason_is_refused(auth_jwt) -> None:
    """An allowlist entry nobody can explain is one nobody will ever remove."""
    db = _admin_db()
    response = _mutate(db, "post", f"{_URL}/entries", {"cidr": "203.0.113.0/24"})
    assert response.status_code == 400
    assert "description is required" in response.json()["detail"]


# --- toggling and removing ---------------------------------------------------------------


def test_an_entry_can_be_disabled_without_losing_it(auth_jwt) -> None:
    db = _admin_db()
    db.set_tenant_webhook_ip_allowlist_entry_enabled.return_value = {
        "id": _ENTRY_ID,
        "cidr": "203.0.113.0/24",
    }
    response = _mutate(db, "patch", f"{_URL}/entries/{_ENTRY_ID}", {"enabled": False})
    assert response.status_code == 200
    db.set_tenant_webhook_ip_allowlist_entry_enabled.assert_called_once_with(
        _TENANT_ID, _ENTRY_ID, False
    )


def test_an_entry_can_be_removed(auth_jwt) -> None:
    db = _admin_db()
    db.delete_tenant_webhook_ip_allowlist_entry.return_value = {
        "id": _ENTRY_ID,
        "cidr": "203.0.113.0/24",
    }
    response = _mutate(db, "delete", f"{_URL}/entries/{_ENTRY_ID}")
    assert response.status_code == 200
    assert db.insert_workflow_audit.call_args.args[6]["change"] == "removed"


def test_another_tenants_entry_id_is_a_404(auth_jwt) -> None:
    db = _admin_db()
    db.list_tenant_webhook_ip_allowlist.return_value = []
    response = _mutate(db, "delete", f"{_URL}/entries/{_ENTRY_ID}")
    assert response.status_code == 404
    db.delete_tenant_webhook_ip_allowlist_entry.assert_not_called()


def test_a_malformed_entry_id_is_a_404_not_a_500(auth_jwt) -> None:
    """A bad UUID would otherwise surface as a database cast error."""
    db = _admin_db()
    response = _mutate(db, "delete", f"{_URL}/entries/not-a-uuid")
    assert response.status_code == 404


# --- the bypass --------------------------------------------------------------------------


def test_an_administrator_can_bypass_enforcement_with_a_reason(auth_jwt) -> None:
    db = _admin_db()
    response = _mutate(
        db,
        "put",
        f"{_URL}/policy",
        {"enforcementEnabled": False, "bypassReason": "vendor relay has no published range"},
    )
    assert response.status_code == 200
    kwargs = db.set_tenant_webhook_ip_policy.call_args.kwargs
    assert kwargs["enforcement_enabled"] is False
    assert kwargs["bypass_reason"] == "vendor relay has no published range"
    assert kwargs["updated_by"] == _USER_ID


def test_a_bypass_without_a_reason_is_refused(auth_jwt) -> None:
    """"Who turned the filter off, when, and why" is the first thing a review asks and
    the hardest thing to reconstruct afterwards."""
    db = _admin_db()
    response = _mutate(db, "put", f"{_URL}/policy", {"enforcementEnabled": False})
    assert response.status_code == 400
    db.set_tenant_webhook_ip_policy.assert_not_called()


def test_re_enabling_enforcement_clears_the_stale_reason(auth_jwt) -> None:
    """A leftover "we had an incident in March" next to an enforced filter reads as
    though the bypass were still in place."""
    db = _admin_db()
    _mutate(
        db,
        "put",
        f"{_URL}/policy",
        {"enforcementEnabled": True, "bypassReason": "old incident"},
    )
    assert db.set_tenant_webhook_ip_policy.call_args.kwargs["bypass_reason"] is None


def test_a_non_administrator_cannot_bypass_enforcement(auth_jwt) -> None:
    db = _admin_db()
    db.is_user_tenant_admin.return_value = False
    response = _mutate(
        db, "put", f"{_URL}/policy", {"enforcementEnabled": False, "bypassReason": "x"}
    )
    assert response.status_code == 403
    db.set_tenant_webhook_ip_policy.assert_not_called()


def test_a_bypass_is_audited_as_a_failure_outcome(auth_jwt) -> None:
    """Turning a security control off is not a routine success, and an outcome an alert
    can key on is the difference between noticing and not."""
    db = _admin_db()
    _mutate(
        db, "put", f"{_URL}/policy", {"enforcementEnabled": False, "bypassReason": "relay"}
    )
    args = db.insert_workflow_audit.call_args.args
    assert args[3] == IP_POLICY_UPDATED_ACTION
    assert args[4] == "failure"


def test_an_audit_outage_does_not_fail_the_change(auth_jwt) -> None:
    """The change is already committed by the time the audit row is written."""
    db = _admin_db()
    db.insert_workflow_audit.side_effect = RuntimeError("audit down")
    response = _mutate(
        db, "put", f"{_URL}/policy", {"enforcementEnabled": False, "bypassReason": "relay"}
    )
    assert response.status_code == 200


def test_every_mutation_answers_with_the_full_allowlist(auth_jwt) -> None:
    """The panel re-renders from what was stored rather than from what it hoped it
    stored, so an edit can never leave the screen disagreeing with the database."""
    db = _admin_db()
    body = _mutate(
        db, "put", f"{_URL}/policy", {"enforcementEnabled": True}
    ).json()
    assert "providers" in body and "entries" in body
