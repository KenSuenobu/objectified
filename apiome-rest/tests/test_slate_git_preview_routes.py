"""Git-triggered preview REST surface — APX-3.3 (private-suite#2458).

Pins the wiring the store tests cannot: the authorization posture (reads view, mutations
publish), 404-not-403 on scope misses, the signature-verified webhook receiver (raw-body
verification, idempotent reporting, and the accepted-but-ignored non-buildable cases), the rule
that a connection response never carries its secret or token, and that every preview reports the
honest "not built / not dispatched" delivery block. Store functions are patched, so no database
is required.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.slate_auth import validate_slate_authentication
from app.slate_git_preview import SlatePreviewEventError

client = TestClient(app)

_MOCK_JWT = {
    "tenant_id": "t1",
    "user_id": "user-a",
    "email": "dana@example.com",
    "auth_method": "jwt",
}

COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"


def connection_public(**overrides):
    base = {
        "id": "conn-1",
        "site_id": "site-1",
        "provider": "github",
        "repo_owner": "acme",
        "repo_name": "docs",
        "repo_full_name": "acme/docs",
        "default_branch": "main",
        "preview_host": "previews.apiome.dev",
        "has_webhook_secret": True,
        "has_token": True,
        "created_at": None,
        "updated_at": None,
    }
    return {**base, **overrides}


def preview_row(**overrides):
    base = {
        "id": "prev-1",
        "connection_id": "conn-1",
        "site_id": "site-1",
        "environment_id": "lane-1",
        "source_commit": COMMIT,
        "source_ref": "main",
        "source_message": "Document invoices",
        "source_digest": "sha256:" + "d" * 64,
        "status": "queued",
        "checks_state": "pending",
        "immutable_url": "https://previews.apiome.dev/acme-docs/commit/a1b2c3d4e5f6",
        "access_policy": "tenant",
        "robots_excluded": True,
        "build_dispatched": False,
        "retry_count": 0,
        "expires_at": None,
        "created_at": None,
        "changed_pages": [],
        "alias_url": None,
    }
    return {**base, **overrides}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_slate_authentication] = lambda: dict(_MOCK_JWT)
    yield
    app.dependency_overrides.pop(validate_slate_authentication, None)


@pytest.fixture(autouse=True)
def _permissions():
    with patch("app.slate_git_preview_routes.enforce_permission") as enforce:
        yield enforce


class TestAuthorization:
    def test_creating_a_connection_requires_publish(self, _permissions):
        with patch("app.slate_git_preview_routes.upsert_connection", return_value=connection_public()):
            client.post(
                "/v1/slate/git/connections",
                json={
                    "siteId": "site-1",
                    "repoOwner": "acme",
                    "repoName": "docs",
                    "previewHost": "previews.apiome.dev",
                },
            )
        _, args, _ = _permissions.mock_calls[0]
        assert args[2] == "versions"
        assert args[3] == "publish"

    def test_listing_connections_requires_view(self, _permissions):
        with patch("app.slate_git_preview_routes.list_connections", return_value=[]):
            client.get("/v1/slate/git/connections")
        _, args, _ = _permissions.mock_calls[0]
        assert args[3] == "view"

    def test_getting_a_preview_requires_view(self, _permissions):
        with patch("app.slate_git_preview_routes.get_preview", return_value=preview_row()):
            client.get("/v1/slate/git/previews/prev-1")
        _, args, _ = _permissions.mock_calls[0]
        assert args[3] == "view"

    def test_recording_checks_requires_publish(self, _permissions):
        with patch("app.slate_git_preview_routes.record_checks", return_value=preview_row()):
            client.post("/v1/slate/git/previews/prev-1/checks", json={"passed": True})
        _, args, _ = _permissions.mock_calls[0]
        assert args[3] == "publish"

    def test_cleanup_requires_publish(self, _permissions):
        with patch("app.slate_git_preview_routes.get_connection", return_value=connection_public()), \
             patch("app.slate_git_preview_routes.reap_expired_previews", return_value=0):
            client.post("/v1/slate/git/connections/conn-1/cleanup")
        _, args, _ = _permissions.mock_calls[0]
        assert args[3] == "publish"


class TestConnectionSecretsAreWriteOnly:
    def test_the_connection_response_never_carries_the_secret_or_token(self):
        with patch("app.slate_git_preview_routes.upsert_connection", return_value=connection_public()):
            response = client.post(
                "/v1/slate/git/connections",
                json={
                    "siteId": "site-1",
                    "repoOwner": "acme",
                    "repoName": "docs",
                    "previewHost": "previews.apiome.dev",
                    "webhookSecret": "s3cr3t",
                    "token": "ghp_secret",
                },
            )
        assert response.status_code == 201
        body = response.json()
        assert body["hasWebhookSecret"] is True
        assert body["hasToken"] is True
        # No secret material is echoed back, under any key.
        serialized = json.dumps(body)
        assert "s3cr3t" not in serialized
        assert "ghp_secret" not in serialized
        assert "webhookSecret" not in body
        assert "token" not in body


class TestScopeMisses:
    def test_an_unknown_preview_answers_404(self):
        with patch("app.slate_git_preview_routes.get_preview", return_value=None):
            response = client.get("/v1/slate/git/previews/missing")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "preview_not_found"

    def test_cleanup_on_an_unknown_connection_answers_404(self):
        with patch("app.slate_git_preview_routes.get_connection", return_value=None):
            response = client.post("/v1/slate/git/connections/nope/cleanup")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "connection_not_found"


class TestPreviewBodyHonesty:
    def test_every_preview_admits_it_was_not_built_or_dispatched(self):
        with patch("app.slate_git_preview_routes.get_preview", return_value=preview_row()):
            body = client.get("/v1/slate/git/previews/prev-1").json()
        assert body["buildDispatched"] is False
        assert body["providerStatus"]["delivery"]["buildDispatched"] is False
        assert body["providerStatus"]["delivery"]["statusDispatched"] is False


class TestWebhookReceiver:
    def _sign(self, secret: str, body: bytes) -> str:
        return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    def test_a_ping_is_acknowledged_and_ignored(self):
        response = client.post(
            "/v1/slate/git/events",
            content=b"{}",
            headers={"X-GitHub-Event": "ping"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["accepted"] is True
        assert body["ignored"] is True

    def test_a_non_push_event_is_ignored(self):
        response = client.post(
            "/v1/slate/git/events",
            content=b"{}",
            headers={"X-GitHub-Event": "issues"},
        )
        assert response.json()["ignored"] is True

    def test_a_malformed_body_answers_400(self):
        response = client.post(
            "/v1/slate/git/events", content=b"not json", headers={"X-GitHub-Event": "push"}
        )
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "malformed_payload"

    def test_a_payload_with_no_repository_answers_400(self):
        response = client.post(
            "/v1/slate/git/events",
            content=json.dumps({"ref": "refs/heads/main"}).encode(),
            headers={"X-GitHub-Event": "push"},
        )
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "missing_repository"

    def test_an_unconnected_repository_is_ignored(self):
        with patch("app.slate_git_preview_routes.find_connections_by_repo", return_value=[]):
            response = client.post(
                "/v1/slate/git/events",
                content=json.dumps({"repository": {"full_name": "acme/docs"}}).encode(),
                headers={"X-GitHub-Event": "push"},
            )
        assert response.status_code == 200
        assert response.json()["ignored"] is True

    def test_a_bad_signature_answers_401(self):
        body = json.dumps({"repository": {"full_name": "acme/docs"}}).encode()
        conn = {"id": "conn-1", "tenant_id": "t1", "webhook_secret_enc": b"blob"}
        with patch("app.slate_git_preview_routes.find_connections_by_repo", return_value=[conn]), \
             patch("app.slate_git_preview_routes.decrypt_signing_secret", return_value="realsecret"):
            response = client.post(
                "/v1/slate/git/events",
                content=body,
                headers={
                    "X-GitHub-Event": "push",
                    "X-Hub-Signature-256": self._sign("WRONG", body),
                },
            )
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "signature_invalid"

    def test_a_valid_signature_over_the_raw_body_creates_a_preview(self):
        secret = "realsecret"
        payload = {
            "ref": "refs/heads/main",
            "after": COMMIT,
            "repository": {"full_name": "acme/docs"},
            "head_commit": {"id": COMMIT, "message": "Document invoices"},
        }
        body = json.dumps(payload).encode()
        conn = {"id": "conn-1", "tenant_id": "t1", "site_id": "site-1",
                "preview_host": "previews.apiome.dev", "webhook_secret_enc": b"blob"}
        with patch("app.slate_git_preview_routes.find_connections_by_repo", return_value=[conn]), \
             patch("app.slate_git_preview_routes.decrypt_signing_secret", return_value=secret), \
             patch("app.slate_git_preview_routes.ingest_preview_event", return_value=(preview_row(), True)) as ingest, \
             patch("app.slate_git_preview_routes.get_preview", return_value=preview_row()):
            response = client.post(
                "/v1/slate/git/events",
                content=body,
                headers={
                    "X-GitHub-Event": "push",
                    "X-GitHub-Delivery": "delivery-1",
                    "X-Hub-Signature-256": self._sign(secret, body),
                },
            )
        assert response.status_code == 200
        result = response.json()
        assert result["accepted"] is True
        assert result["created"] is True
        assert result["preview"]["immutableUrl"].endswith("/commit/a1b2c3d4e5f6")
        # The delivery id is threaded to the store for the audit trail.
        assert ingest.call_args.kwargs["delivery_id"] == "delivery-1"

    def test_a_redelivered_event_reports_created_false(self):
        secret = "realsecret"
        payload = {
            "ref": "refs/heads/main",
            "after": COMMIT,
            "repository": {"full_name": "acme/docs"},
            "head_commit": {"id": COMMIT, "message": "x"},
        }
        body = json.dumps(payload).encode()
        conn = {"id": "conn-1", "tenant_id": "t1", "site_id": "site-1",
                "preview_host": "h", "webhook_secret_enc": b"blob"}
        with patch("app.slate_git_preview_routes.find_connections_by_repo", return_value=[conn]), \
             patch("app.slate_git_preview_routes.decrypt_signing_secret", return_value=secret), \
             patch("app.slate_git_preview_routes.ingest_preview_event", return_value=(preview_row(), False)), \
             patch("app.slate_git_preview_routes.get_preview", return_value=preview_row()):
            response = client.post(
                "/v1/slate/git/events",
                content=body,
                headers={"X-GitHub-Event": "push", "X-Hub-Signature-256": self._sign(secret, body)},
            )
        assert response.json()["created"] is False

    def test_a_tag_push_is_accepted_and_ignored(self):
        secret = "realsecret"
        payload = {"ref": "refs/tags/v1.0.0", "repository": {"full_name": "acme/docs"}}
        body = json.dumps(payload).encode()
        conn = {"id": "conn-1", "tenant_id": "t1", "webhook_secret_enc": b"blob"}
        with patch("app.slate_git_preview_routes.find_connections_by_repo", return_value=[conn]), \
             patch("app.slate_git_preview_routes.decrypt_signing_secret", return_value=secret):
            response = client.post(
                "/v1/slate/git/events",
                content=body,
                headers={"X-GitHub-Event": "push", "X-Hub-Signature-256": self._sign(secret, body)},
            )
        assert response.status_code == 200
        assert response.json()["ignored"] is True
