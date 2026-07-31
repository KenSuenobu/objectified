"""The two webhook REST surfaces (REPO-4.3, #2781).

``POST /v1/repositories/webhook/{provider}`` is the unauthenticated ingestion endpoint: the
signature is the authentication, so these tests pin the status codes it maps outcomes onto
and the deliberate thinness of its response body.

``GET /v1/tenants/{slug}/repositories/{id}/webhook`` is the authenticated status view. Its
job in this file is to prove acceptance criterion 4 end to end: the signing secret is not in
the response, on any path, even when the underlying row is stuffed with one.
"""

import hashlib
import hmac
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.repository_webhook_dispatch import (
    OUTCOME_ENQUEUED,
    OUTCOME_IGNORED,
    WebhookIngestResult,
    WebhookRejectedError,
)

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_USER_ID = "660e8400-e29b-41d4-a716-446655440001"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_SUB_ID = "990e8400-e29b-41d4-a716-446655440004"
_SECRET = "signing-secret"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": _USER_ID,
    "auth_method": "jwt",
}

_REPO_ROW = {
    "id": _REPO_ID,
    "tenant_id": _TENANT_ID,
    "source": "public_url",
    "provider": "github",
    "clone_url": "https://github.com/octocat/Hello-World.git",
    "repository_full_name": "octocat/Hello-World",
    "default_branch": "main",
    "status": "ready",
}


@pytest.fixture
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _signed_push(secret: str = _SECRET):
    payload = {
        "ref": "refs/heads/main",
        "after": "a" * 40,
        "repository": {"full_name": "octocat/hello-world"},
        "head_commit": {"id": "a" * 40},
    }
    body = json.dumps(payload).encode("utf-8")
    sig = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return body, {
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": "d-1",
        "X-Hub-Signature-256": sig,
        "Content-Type": "application/json",
    }


# --- Ingestion endpoint -----------------------------------------------------------------


def test_the_ingestion_endpoint_needs_no_bearer_token() -> None:
    """A provider holds no token; the signature is the authentication."""
    body, headers = _signed_push()
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.return_value = WebhookIngestResult(outcome=OUTCOME_ENQUEUED, jobs_enqueued=1)
        r = client.post("/v1/repositories/webhook/github", content=body, headers=headers)

    assert r.status_code == 200
    assert r.json() == {
        "accepted": True,
        "outcome": "enqueued",
        "reason": None,
        "jobsEnqueued": 1,
    }


def test_the_handler_passes_the_raw_bytes_through_untouched() -> None:
    """A re-serialisation would invalidate a signature over the provider's exact bytes."""
    body = b'{"repository":{"full_name":"octocat/hello-world"},  "ref":"refs/heads/main"}'
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.return_value = WebhookIngestResult(outcome=OUTCOME_ENQUEUED)
        client.post(
            "/v1/repositories/webhook/github",
            content=body,
            headers={"Content-Type": "application/json", "X-GitHub-Event": "push"},
        )

    assert ingest.call_args.kwargs["raw_body"] == body


def test_a_deliberately_ignored_delivery_is_still_a_200() -> None:
    """The provider must stop retrying something that is working as intended."""
    body, headers = _signed_push()
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.return_value = WebhookIngestResult(
            outcome=OUTCOME_IGNORED, reason="branch-not-tracked"
        )
        r = client.post("/v1/repositories/webhook/github", content=body, headers=headers)

    assert r.status_code == 200
    assert r.json()["outcome"] == "ignored"
    assert r.json()["reason"] == "branch-not-tracked"


def test_a_signature_that_does_not_verify_is_a_401() -> None:
    body, headers = _signed_push(secret="attacker")
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.side_effect = WebhookRejectedError("signature_invalid", "did not verify")
        r = client.post("/v1/repositories/webhook/github", content=body, headers=headers)

    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "signature_invalid"


def test_the_401_body_names_no_tenant_or_repository() -> None:
    """Anyone can reach this endpoint; the error must not describe a tenant's repositories."""
    body, headers = _signed_push(secret="attacker")
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.side_effect = WebhookRejectedError("signature_invalid", "did not verify")
        r = client.post("/v1/repositories/webhook/github", content=body, headers=headers)

    rendered = r.text
    assert _TENANT_ID not in rendered
    assert _REPO_ID not in rendered
    assert "octocat" not in rendered


def test_an_unusable_body_is_a_400() -> None:
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.side_effect = ValueError("body is not valid JSON")
        r = client.post(
            "/v1/repositories/webhook/github",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )

    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "malformed_payload"


def test_an_unsupported_provider_is_a_400_that_lists_the_supported_ones() -> None:
    r = client.post(
        "/v1/repositories/webhook/gogs",
        content=b"{}",
        headers={"Content-Type": "application/json"},
    )

    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "unsupported_provider"
    assert "github" in detail["message"] and "gitlab" in detail["message"]


def test_the_delivery_reaches_the_dispatcher_with_its_headers() -> None:
    body, headers = _signed_push()
    with patch("app.repository_webhook_routes.ingest_webhook_delivery") as ingest:
        ingest.return_value = WebhookIngestResult(outcome=OUTCOME_ENQUEUED)
        client.post("/v1/repositories/webhook/GitHub", content=body, headers=headers)

    kwargs = ingest.call_args.kwargs
    assert kwargs["provider"] == "github"  # normalized before dispatch
    assert kwargs["headers"]["x-hub-signature-256"] == headers["X-Hub-Signature-256"]


# --- Status endpoint --------------------------------------------------------------------

_SUBSCRIPTION_ROW = {
    "id": _SUB_ID,
    "tenant_id": _TENANT_ID,
    "repository_id": _REPO_ID,
    "provider": "github",
    "repo_full_name": "octocat/hello-world",
    "secret_fingerprint": "0123456789abcdef",
    "pr_preview_enabled": True,
    "provider_hook_id": "4242",
    "registration_state": "registered",
    "registration_error": None,
    "last_event_at": None,
    "last_delivery_id": "d-1",
    "event_count": 5,
    "created_at": None,
    "updated_at": None,
}

_EVENT_ROW = {
    "id": "aa0e8400-e29b-41d4-a716-446655440009",
    "provider": "github",
    "delivery_id": "d-1",
    "event_type": "push",
    "action": None,
    "branch": "main",
    "head_sha": "a" * 40,
    "pr_number": None,
    "outcome": "enqueued",
    "reason": None,
    "jobs_enqueued": 1,
    "received_at": None,
}


def test_the_status_endpoint_reports_the_subscription_and_recent_deliveries(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _REPO_ROW
        mdb.get_repository_webhook_subscription.return_value = _SUBSCRIPTION_ROW
        mdb.list_repository_webhook_events.return_value = [_EVENT_ROW]
        r = client.get(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook")

    assert r.status_code == 200
    body = r.json()
    assert body["subscription"]["registrationState"] == "registered"
    assert body["subscription"]["providerHookId"] == "4242"
    assert body["subscription"]["signatureHeader"] == "X-Hub-Signature-256"
    assert body["events"][0]["branch"] == "main"
    assert body["events"][0]["jobsEnqueued"] == 1


def test_the_status_response_never_carries_the_signing_secret(auth_jwt) -> None:
    """Acceptance criterion 4, end to end: even a row stuffed with a secret projects none."""
    poisoned = {
        **_SUBSCRIPTION_ROW,
        "secret_enc": b"super-secret-ciphertext",
        "secret": "plaintext-secret-should-never-appear",
    }
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _REPO_ROW
        mdb.get_repository_webhook_subscription.return_value = poisoned
        mdb.list_repository_webhook_events.return_value = []
        r = client.get(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook")

    rendered = r.text
    assert r.status_code == 200
    assert "super-secret-ciphertext" not in rendered
    assert "plaintext-secret-should-never-appear" not in rendered
    assert "secretEnc" not in rendered
    # Only the fingerprint survives.
    assert r.json()["subscription"]["secretFingerprint"] == "0123456789abcdef"


def test_a_repository_with_no_subscription_reports_null_not_an_error(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _REPO_ROW
        mdb.get_repository_webhook_subscription.return_value = None
        mdb.list_repository_webhook_events.return_value = []
        r = client.get(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook")

    assert r.status_code == 200
    assert r.json()["subscription"] is None
    assert r.json()["events"] == []


def test_the_status_endpoint_is_scoped_to_the_callers_tenant(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = None
        r = client.get(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook")

    assert r.status_code == 404
    mdb.get_repository_webhook_subscription.assert_not_called()


# --- Provisioning happens on the registration path --------------------------------------


_CREATE_META = {
    "provider": "github",
    "repository_full_name": "octocat/Hello-World",
    "description": None,
    "default_branch": "main",
    "visibility": "public",
    "canonical_clone_url": "https://github.com/octocat/Hello-World.git",
}


def test_registering_a_repository_provisions_its_webhook(auth_jwt) -> None:
    """The ticket puts provisioning on the REPO-1.4 registration path; this pins it there."""
    inserted = {**_REPO_ROW, "clone_url": _CREATE_META["canonical_clone_url"]}
    with (
        patch(
            "app.tenant_repositories_routes.validate_public_clone_url",
            return_value=_CREATE_META,
        ),
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.provision_repository_webhook") as provision,
    ):
        mdb.insert_tenant_repository.return_value = inserted
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={
                "source": "public_url",
                "clone_url": "https://github.com/octocat/Hello-World.git",
            },
        )

    assert r.status_code == 200
    kwargs = provision.call_args.kwargs
    assert kwargs["repository_id"] == _REPO_ID
    assert kwargs["provider"] == "github"
    assert kwargs["repo_full_name"] == "octocat/Hello-World"
    # A public-URL registration has no linked-account token to create a hook with.
    assert kwargs["access_token"] is None


def test_a_failed_webhook_provisioning_never_fails_the_registration(auth_jwt) -> None:
    """The tenant still has the polling cadence; a webhook is an accelerator, not a gate."""
    inserted = {**_REPO_ROW, "clone_url": _CREATE_META["canonical_clone_url"]}
    with (
        patch(
            "app.tenant_repositories_routes.validate_public_clone_url",
            return_value=_CREATE_META,
        ),
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.provision_repository_webhook") as provision,
    ):
        mdb.insert_tenant_repository.return_value = inserted
        provision.return_value = type(
            "R", (), {"error": "provider refused", "state": "failed", "secret": None}
        )()
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={
                "source": "public_url",
                "clone_url": "https://github.com/octocat/Hello-World.git",
            },
        )

    assert r.status_code == 200
    assert r.json()["success"] is True


def test_the_registration_response_never_carries_the_minted_secret(auth_jwt) -> None:
    """The secret reaches the operator through the webhook status view, not this response."""
    inserted = {**_REPO_ROW, "clone_url": _CREATE_META["canonical_clone_url"]}
    with (
        patch(
            "app.tenant_repositories_routes.validate_public_clone_url",
            return_value=_CREATE_META,
        ),
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.provision_repository_webhook") as provision,
    ):
        mdb.insert_tenant_repository.return_value = inserted
        provision.return_value = type(
            "R",
            (),
            {"error": None, "state": "local", "secret": "d" * 64, "subscription": {}},
        )()
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={
                "source": "public_url",
                "clone_url": "https://github.com/octocat/Hello-World.git",
            },
        )

    assert "d" * 64 not in r.text


def test_the_delivery_limit_is_bounded(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _REPO_ROW
        mdb.get_repository_webhook_subscription.return_value = None
        mdb.list_repository_webhook_events.return_value = []
        too_many = client.get(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook?limit=5000"
        )
        too_few = client.get(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook?limit=0")

    assert too_many.status_code == 422
    assert too_few.status_code == 422


# --- Rotation endpoint (REPO-4.7, #2785) ------------------------------------------------

_ROTATED_ROW = {
    **_SUBSCRIPTION_ROW,
    "secret_fingerprint": "aaaabbbbccccdddd",
    "previous_secret_fingerprint": "0123456789abcdef",
    "previous_secret_expires_at": "2026-08-01T12:00:00+00:00",
    "rotated_at": "2026-07-31T12:00:00+00:00",
    "rotation_count": 1,
    "provider_secret_synced": True,
    "rotation_error": None,
}


def _rotation_result(**overrides):
    from app.repository_webhook_rotation import RotationResult

    fields = {
        "subscription": dict(_ROTATED_ROW),
        "grace_seconds": 86400,
        "provider_synced": True,
        "provider_error": None,
    }
    fields.update(overrides)
    return RotationResult(**fields)


def test_rotating_reports_the_new_fingerprint_and_the_deadline(auth_jwt) -> None:
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW
        rotate.return_value = _rotation_result()
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={}
        )

    assert r.status_code == 200
    body = r.json()
    assert body["subscription"]["secretFingerprint"] == "aaaabbbbccccdddd"
    assert body["subscription"]["previousSecretFingerprint"] == "0123456789abcdef"
    assert body["subscription"]["previousSecretExpiresAt"] == "2026-08-01T12:00:00+00:00"
    assert body["graceSeconds"] == 86400
    assert body["providerSecretSynced"] is True


def test_the_rotation_response_never_carries_a_secret(auth_jwt) -> None:
    """Neither the new secret nor the outgoing one has anywhere to appear."""
    poisoned = {
        **_ROTATED_ROW,
        "secret_enc": b"new-ciphertext",
        "previous_secret_enc": b"old-ciphertext",
        "secret": "plaintext-should-never-appear",
    }
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW
        rotate.return_value = _rotation_result(subscription=poisoned)
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={}
        )

    assert r.status_code == 200
    assert "new-ciphertext" not in r.text
    assert "old-ciphertext" not in r.text
    assert "plaintext-should-never-appear" not in r.text


def test_a_requested_grace_window_reaches_the_rotation(auth_jwt) -> None:
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW
        rotate.return_value = _rotation_result(grace_seconds=3600)
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate",
            json={"graceSeconds": 3600},
        )

    assert r.status_code == 200
    assert rotate.call_args.kwargs["grace_seconds"] == 3600


def test_omitting_the_body_field_uses_the_deployment_default(auth_jwt) -> None:
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW
        rotate.return_value = _rotation_result()
        client.post(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={})

    assert rotate.call_args.kwargs["grace_seconds"] is None


def test_a_negative_grace_window_is_rejected_by_the_model(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _REPO_ROW
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate",
            json={"graceSeconds": -1},
        )

    assert r.status_code == 422


def test_a_rotation_the_provider_refused_is_still_a_success(auth_jwt) -> None:
    """The new secret exists and the old one still works; the flag is where the news is."""
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW
        rotate.return_value = _rotation_result(
            provider_synced=False, provider_error="GitHub said no"
        )
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={}
        )

    assert r.status_code == 200
    assert r.json()["providerSecretSynced"] is False
    assert r.json()["providerError"] == "GitHub said no"


def test_rotating_a_repository_of_another_tenant_is_a_404(auth_jwt) -> None:
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = None
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={}
        )

    assert r.status_code == 404
    rotate.assert_not_called()


@pytest.mark.parametrize(
    "code,status",
    [
        ("no_subscription", 404),
        ("no_encryption_key", 409),
        ("no_secret_to_rotate", 409),
        ("store_failed", 500),
    ],
)
def test_a_refused_rotation_maps_onto_an_honest_status(auth_jwt, code, status) -> None:
    from app.repository_webhook_rotation import RotationError

    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW
        rotate.side_effect = RotationError(code, "nope")
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={}
        )

    assert r.status_code == status
    assert r.json()["detail"]["code"] == code


def test_the_rotation_passes_the_registering_accounts_token(auth_jwt) -> None:
    """A hook created under one account cannot be edited with another account's token."""
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = {
            **_REPO_ROW,
            "linked_account_id": "aa0e8400-e29b-41d4-a716-44665544000a",
            "created_by": _USER_ID,
        }
        mdb.get_external_auth_provider_for_user.return_value = {"access_token": "gh-token"}
        rotate.return_value = _rotation_result()
        client.post(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={})

    assert rotate.call_args.kwargs["access_token"] == "gh-token"
    assert rotate.call_args.kwargs["actor_id"] == _USER_ID


def test_a_public_url_repository_rotates_without_a_token(auth_jwt) -> None:
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = _REPO_ROW  # no linked account
        rotate.return_value = _rotation_result()
        client.post(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={})

    assert rotate.call_args.kwargs["access_token"] is None
    mdb.get_external_auth_provider_for_user.assert_not_called()


def test_a_token_lookup_failure_does_not_block_the_rotation(auth_jwt) -> None:
    """A rotation that can only be local is still better than a secret that never rotates."""
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch("app.tenant_repositories_routes.rotate_repository_webhook_secret") as rotate,
    ):
        mdb.get_tenant_repository.return_value = {
            **_REPO_ROW,
            "linked_account_id": "aa0e8400-e29b-41d4-a716-44665544000a",
            "created_by": _USER_ID,
        }
        mdb.get_external_auth_provider_for_user.side_effect = RuntimeError("down")
        rotate.return_value = _rotation_result()
        r = client.post(
            f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook/rotate", json={}
        )

    assert r.status_code == 200
    assert rotate.call_args.kwargs["access_token"] is None


def test_the_status_view_reports_a_rotation_in_progress(auth_jwt) -> None:
    """The state an operator has to act on: the provider is still on the outgoing secret."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _REPO_ROW
        mdb.get_repository_webhook_subscription.return_value = {
            **_ROTATED_ROW,
            "provider_secret_synced": False,
            "rotation_error": "GitHub said no",
        }
        mdb.list_repository_webhook_events.return_value = []
        r = client.get(f"/v1/tenants/acme/repositories/{_REPO_ID}/webhook")

    subscription = r.json()["subscription"]
    assert subscription["providerSecretSynced"] is False
    assert subscription["rotationError"] == "GitHub said no"
    assert subscription["previousSecretExpiresAt"] == "2026-08-01T12:00:00+00:00"
    assert subscription["rotationCount"] == 1
