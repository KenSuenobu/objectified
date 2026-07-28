"""HTTP contract tests for the verification-target registry endpoints — ECA-1.2 (#4730).

``/v1/tenants/{tenant_slug}/verification-targets`` and friends. The store is faked (its own tests
cover it); what is asserted here is the endpoint's own contract:

* **only authorized users and runners get through** — every route is gated on the
  ``verification_targets`` RBAC resource, with managing separated from viewing/resolving, and a
  denial is a 403 rather than a silent no-op;
* a refusal from the contract layer becomes the HTTP status that matches its *kind* (404 unknown,
  409 slug taken, 400 bad definition) and always carries the stable code;
* the response shapes a client parses, including the fact that resolving returns a credential
  *reference* and never a credential;
* the audit ledger read is available on the same permission that grants a resolve.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.verification_target import (
    AUTH_KIND_ENV,
    AUTH_SCHEME_BEARER,
    CODE_DISABLED,
    CODE_NOT_FOUND,
    CODE_SLUG_TAKEN,
    CODE_URL_PRIVATE_NETWORK,
    NETWORK_CLASS_PUBLIC,
    ResolvedTarget,
    TargetAuthReference,
    TargetValidationError,
    VerificationPolicy,
    VerificationTargetRecord,
)

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}
_TARGET = "22222222-2222-4222-8222-222222222222"
_BASE = "/v1/tenants/acme/verification-targets"


def _record(**overrides: Any) -> VerificationTargetRecord:
    """A stored target as the store returns one."""
    payload: Dict[str, Any] = {
        "id": _TARGET,
        "tenant_id": "test-tenant-id",
        "slug": "staging",
        "name": "Staging",
        "description": None,
        "environment": "staging",
        "base_url": "https://staging.example.com/api",
        "network_class": NETWORK_CLASS_PUBLIC,
        "auth": TargetAuthReference(
            kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref="APIOME_STAGING_TOKEN"
        ),
        "policy": VerificationPolicy(),
        "enabled": True,
        "created_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
    }
    payload.update(overrides)
    return VerificationTargetRecord(**payload)


def _resolved() -> ResolvedTarget:
    """A resolved target as the store returns one."""
    record = _record()
    return ResolvedTarget(
        target_id=record.id,
        slug=record.slug,
        name=record.name,
        environment=record.environment,
        network_class=record.network_class,
        base_url=record.base_url,
        policy=record.policy,
        auth=record.auth,
        resolved_at=datetime.now(timezone.utc),
    )


def _definition() -> Dict[str, Any]:
    """A valid create body."""
    return {
        "slug": "staging",
        "name": "Staging",
        "base_url": "https://staging.example.com/api",
        "auth": {"kind": "env", "scheme": "bearer", "ref": "APIOME_STAGING_TOKEN"},
    }


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request and grant the permission each route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch(
        "app.verification_target_routes.enforce_permission", return_value="test-user-id"
    ):
        yield
    app.dependency_overrides.clear()


# ===========================================================================
# List
# ===========================================================================


def test_listing_returns_the_tenants_targets_with_a_count() -> None:
    with patch("app.verification_target_routes.list_targets", return_value=[_record()]):
        response = client.get(_BASE)
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["targets"][0]["slug"] == "staging"


def test_a_listed_target_carries_a_reference_and_no_credential() -> None:
    with patch("app.verification_target_routes.list_targets", return_value=[_record()]):
        body = client.get(_BASE).json()
    auth = body["targets"][0]["auth"]
    assert auth == {
        "kind": "env",
        "scheme": "bearer",
        "ref": "APIOME_STAGING_TOKEN",
        "header_name": None,
    }


def test_an_empty_registry_is_an_empty_list_not_an_error() -> None:
    with patch("app.verification_target_routes.list_targets", return_value=[]):
        response = client.get(_BASE)
    assert response.status_code == 200
    assert response.json() == {"targets": [], "count": 0}


# ===========================================================================
# Create
# ===========================================================================


def test_creating_a_target_returns_201_and_the_stored_record() -> None:
    with patch(
        "app.verification_target_routes.create_target", return_value=_record()
    ) as create:
        response = client.post(_BASE, json=_definition())
    assert response.status_code == 201
    assert response.json()["slug"] == "staging"
    assert create.call_args.args[0] == "test-tenant-id"


def test_a_refused_definition_is_a_400_with_its_stable_code() -> None:
    with patch(
        "app.verification_target_routes.create_target",
        side_effect=TargetValidationError(CODE_URL_PRIVATE_NETWORK, "resolves to 10.0.0.5"),
    ):
        response = client.post(_BASE, json={**_definition(), "base_url": "http://10.0.0.5"})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == CODE_URL_PRIVATE_NETWORK


def test_a_duplicate_slug_is_a_409() -> None:
    with patch(
        "app.verification_target_routes.create_target",
        side_effect=TargetValidationError(CODE_SLUG_TAKEN, "already exists"),
    ):
        response = client.post(_BASE, json=_definition())
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == CODE_SLUG_TAKEN


def test_a_body_that_pastes_a_token_into_the_reference_is_rejected_by_validation() -> None:
    body = {**_definition(), "auth": {"kind": "env", "scheme": "bearer", "ref": "sk_live_abc"}}
    with patch("app.verification_target_routes.create_target", return_value=_record()) as create:
        response = client.post(_BASE, json=body)
    assert response.status_code == 422
    create.assert_not_called()


def test_an_unknown_field_in_the_body_is_rejected() -> None:
    with patch("app.verification_target_routes.create_target", return_value=_record()):
        response = client.post(_BASE, json={**_definition(), "token": "hunter2"})
    assert response.status_code == 422


# ===========================================================================
# Read / update / delete
# ===========================================================================


def test_reading_a_target_by_reference_returns_it() -> None:
    with patch("app.verification_target_routes.get_target", return_value=_record()):
        response = client.get(f"{_BASE}/staging")
    assert response.status_code == 200
    assert response.json()["id"] == _TARGET


def test_an_unknown_target_is_a_404_with_its_code() -> None:
    with patch(
        "app.verification_target_routes.get_target",
        side_effect=TargetValidationError(CODE_NOT_FOUND, "no such target"),
    ):
        response = client.get(f"{_BASE}/nope")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == CODE_NOT_FOUND


def test_reading_a_retired_target_is_possible_for_an_evidence_reference() -> None:
    with patch(
        "app.verification_target_routes.get_target", return_value=_record()
    ) as get_target:
        client.get(f"{_BASE}/{_TARGET}?include_deleted=true")
    assert get_target.call_args.kwargs["include_deleted"] is True


def test_updating_a_target_returns_the_updated_record() -> None:
    with patch("app.verification_target_routes.get_target", return_value=_record()):
        with patch(
            "app.verification_target_routes.update_target",
            return_value=_record(name="Staging EU"),
        ):
            response = client.patch(f"{_BASE}/staging", json={"name": "Staging EU"})
    assert response.status_code == 200
    assert response.json()["name"] == "Staging EU"


def test_an_update_that_pastes_a_token_is_rejected_by_validation() -> None:
    with patch("app.verification_target_routes.get_target", return_value=_record()):
        response = client.patch(
            f"{_BASE}/staging",
            json={"auth": {"kind": "env", "scheme": "bearer", "ref": "Bearer abc123"}},
        )
    assert response.status_code == 422


def test_retiring_a_target_is_a_204() -> None:
    with patch("app.verification_target_routes.get_target", return_value=_record()):
        with patch("app.verification_target_routes.delete_target", return_value=True) as delete:
            response = client.delete(f"{_BASE}/staging")
    assert response.status_code == 204
    delete.assert_called_once()


def test_retiring_an_unknown_target_is_a_404() -> None:
    with patch(
        "app.verification_target_routes.get_target",
        side_effect=TargetValidationError(CODE_NOT_FOUND, "no such target"),
    ):
        response = client.delete(f"{_BASE}/nope")
    assert response.status_code == 404


# ===========================================================================
# Resolve
# ===========================================================================


def test_resolving_returns_the_identity_endpoint_policy_and_reference() -> None:
    with patch("app.verification_target_routes.resolve_target", return_value=_resolved()):
        response = client.post(f"{_BASE}/staging/resolve", json={"suite_digest": "sha256:abc"})
    assert response.status_code == 200
    body = response.json()
    assert body["target_id"] == _TARGET
    assert body["base_url"] == "https://staging.example.com/api"
    assert body["policy"]["max_concurrency"] == 4
    assert body["auth"]["ref"] == "APIOME_STAGING_TOKEN"


def test_resolving_forwards_the_suite_digest_for_the_audit_entry() -> None:
    with patch(
        "app.verification_target_routes.resolve_target", return_value=_resolved()
    ) as resolve:
        client.post(f"{_BASE}/staging/resolve", json={"suite_digest": "sha256:abc"})
    assert resolve.call_args.kwargs["suite_digest"] == "sha256:abc"


def test_resolving_works_without_a_body() -> None:
    with patch(
        "app.verification_target_routes.resolve_target", return_value=_resolved()
    ) as resolve:
        response = client.post(f"{_BASE}/staging/resolve")
    assert response.status_code == 200
    assert resolve.call_args.kwargs["suite_digest"] is None


def test_resolving_a_disabled_target_is_a_400_with_its_code() -> None:
    with patch(
        "app.verification_target_routes.resolve_target",
        side_effect=TargetValidationError(CODE_DISABLED, "target is disabled"),
    ):
        response = client.post(f"{_BASE}/staging/resolve")
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == CODE_DISABLED


def test_resolving_an_unknown_target_is_a_404() -> None:
    with patch(
        "app.verification_target_routes.resolve_target",
        side_effect=TargetValidationError(CODE_NOT_FOUND, "no such target"),
    ):
        response = client.post(f"{_BASE}/nope/resolve")
    assert response.status_code == 404


# ===========================================================================
# Audit ledger
# ===========================================================================


def _audit_rows() -> List[Dict[str, Any]]:
    """Two ledger rows: a successful selection and a denial."""
    return [
        {
            "id": "a-1",
            "target_id": _TARGET,
            "target_slug": "staging",
            "action": "target.resolve",
            "outcome": "success",
            "reason": None,
            "actor_id": "test-user-id",
            "actor_label": "ci-key",
            "actor_kind": "api_key",
            "detail": {"suite_digest": "sha256:abc"},
            "created_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
        },
        {
            "id": "a-2",
            "target_id": None,
            "target_slug": "prod",
            "action": "target.resolve",
            "outcome": "denied",
            "reason": CODE_NOT_FOUND,
            "actor_id": None,
            "actor_label": None,
            "actor_kind": "api_key",
            "detail": None,
            "created_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
        },
    ]


def test_the_ledger_read_returns_selections_and_denials() -> None:
    with patch("app.verification_target_routes.list_audit", return_value=_audit_rows()):
        response = client.get("/v1/tenants/acme/verification-targets-audit")
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert body["entries"][0]["actor_kind"] == "api_key"
    assert body["entries"][1]["reason"] == CODE_NOT_FOUND
    # A row with no detail reads as an empty object, never as null.
    assert body["entries"][1]["detail"] == {}


def test_the_ledger_read_can_be_scoped_to_one_target() -> None:
    with patch(
        "app.verification_target_routes.list_audit", return_value=_audit_rows()[:1]
    ) as list_audit:
        client.get(f"/v1/tenants/acme/verification-targets-audit?target_id={_TARGET}&limit=5")
    assert list_audit.call_args.kwargs == {"target_id": _TARGET, "limit": 5}


def test_the_ledger_read_rejects_an_out_of_range_limit() -> None:
    response = client.get("/v1/tenants/acme/verification-targets-audit?limit=5000")
    assert response.status_code == 422


# ===========================================================================
# Authorization
# ===========================================================================


def test_every_route_enforces_the_verification_targets_resource() -> None:
    from app.permissions import Action, Resource

    calls = []

    def _record_permission(db, auth_data, resource, action, **kwargs):
        calls.append((resource, action))
        return "test-user-id"

    with patch(
        "app.verification_target_routes.enforce_permission", side_effect=_record_permission
    ):
        with patch("app.verification_target_routes.list_targets", return_value=[]):
            client.get(_BASE)
        with patch("app.verification_target_routes.create_target", return_value=_record()):
            client.post(_BASE, json=_definition())
        with patch("app.verification_target_routes.get_target", return_value=_record()):
            client.get(f"{_BASE}/staging")
            with patch(
                "app.verification_target_routes.update_target", return_value=_record()
            ):
                client.patch(f"{_BASE}/staging", json={"name": "x"})
            with patch("app.verification_target_routes.delete_target", return_value=True):
                client.delete(f"{_BASE}/staging")
        with patch("app.verification_target_routes.resolve_target", return_value=_resolved()):
            client.post(f"{_BASE}/staging/resolve")
        with patch("app.verification_target_routes.list_audit", return_value=[]):
            client.get("/v1/tenants/acme/verification-targets-audit")

    assert {resource for resource, _ in calls} == {Resource.VERIFICATION_TARGETS}
    assert calls == [
        (Resource.VERIFICATION_TARGETS, Action.VIEW),
        (Resource.VERIFICATION_TARGETS, Action.CREATE),
        (Resource.VERIFICATION_TARGETS, Action.VIEW),
        (Resource.VERIFICATION_TARGETS, Action.EDIT),
        (Resource.VERIFICATION_TARGETS, Action.DELETE),
        (Resource.VERIFICATION_TARGETS, Action.VIEW),
        (Resource.VERIFICATION_TARGETS, Action.VIEW),
    ]


def test_a_denied_permission_is_a_403() -> None:
    from fastapi import HTTPException

    with patch(
        "app.verification_target_routes.enforce_permission",
        side_effect=HTTPException(status_code=403, detail="Permission denied"),
    ):
        assert client.get(_BASE).status_code == 403
        assert client.post(_BASE, json=_definition()).status_code == 403
        assert client.post(f"{_BASE}/staging/resolve").status_code == 403


def test_a_credential_with_no_tenant_cannot_reach_the_registry() -> None:
    app.dependency_overrides[validate_authentication] = lambda: {"user_id": "u", "auth_method": "jwt"}
    with patch("app.verification_target_routes.list_targets", return_value=[]):
        response = client.get(_BASE)
    assert response.status_code == 403
