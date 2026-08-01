"""Tests for the super-admin provider-config REST surface (OLO-8.4, #4970).

Pin the route contract of :mod:`app.auth_provider_config_routes`:

* the surface is gated by the signed super-admin session — no session ⇒ ``401``, bad session
  ⇒ ``403`` (issue AC: non-admin callers get 401/403);
* **secrets are never present in any response** — GET or PUT — only a "set / not set" flag;
* PUT seals and persists a write-only secret, and reports masked state back;
* enabling a provider that is ``coming-soon`` or missing a required field is rejected with a
  structured ``422``; an unknown provider id is ``404``; a secret supplied without configured
  encryption is ``503``.

The data layer is mocked (``patch('app.auth_provider_config_routes.db')``) so these assert route
behaviour, not Postgres; the crypto is exercised for real against a test KEK so the seal path is
covered end-to-end.
"""

import base64
import json
import os
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.admin_session import verify_admin_session_token  # noqa: F401 (import sanity)
from app.config import settings
from app.main import app

client = TestClient(app)

_MAX_AGE_MS = 8 * 60 * 60 * 1000
_ADMIN_SECRET = "test-admin-session-secret"


def _b64url(raw: bytes) -> str:
    """Unpadded base64url, matching Node's ``Buffer.toString('base64url')``."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _mint_admin_token(key: str = _ADMIN_SECRET) -> str:
    """Mint a super-admin session token valid against the real clock.

    The dependency under test verifies expiry against wall-clock ``now`` (it does not accept an
    injected time), so the token carries a far-future ``exp`` — the routes only assert the gate
    accepts/rejects, not the 8h boundary (that is covered against an injected clock in
    ``test_admin_session.py``).
    """
    import hmac
    from hashlib import sha256

    payload = {"v": 1, "sub": "admin", "iat": 0, "exp": 9_999_999_999_999}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = _b64url(hmac.new(key.encode(), encoded.encode(), sha256).digest())
    return f"{encoded}.{sig}"


@pytest.fixture
def admin_headers(monkeypatch):
    """Configure the admin signing key and return a header carrying a valid session token.

    Also freezes ``verify_admin_session_token``'s clock indirectly: the token's 8h window comfortably
    contains real 'now', so no time-freeze is needed for these tests.
    """
    monkeypatch.setattr(settings, "admin_session_secret", _ADMIN_SECRET)
    monkeypatch.setattr(settings, "admin_password", None)
    return {"X-Admin-Session": _mint_admin_token()}


@pytest.fixture
def enc_key(monkeypatch):
    """Configure a real single KEK so the seal path runs for real; return it."""
    key = base64.b64encode(os.urandom(32)).decode()
    monkeypatch.setattr(settings, "auth_config_enc_key", key)
    monkeypatch.setattr(settings, "auth_config_enc_active_key_id", None)
    return key


@pytest.fixture
def no_enc(monkeypatch):
    """Ensure secret encryption is NOT configured."""
    monkeypatch.setattr(settings, "auth_config_enc_key", None)
    monkeypatch.setattr(settings, "auth_config_enc_active_key_id", None)


def _row(**overrides):
    """A stored auth_provider_config read-row (as the DB layer returns it)."""
    base = {
        "provider_id": "github",
        "enabled": True,
        "client_id": "gh-client-id",
        "enc_key_id": "default",  # a secret is stored
        "config": {"base_url": "https://github.example"},
        "updated_at": datetime(2026, 7, 22, tzinfo=timezone.utc),
        "updated_by": "admin",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_list_requires_session():
    """No session credential ⇒ 401."""
    resp = client.get("/v1/admin/auth-providers")
    assert resp.status_code == 401


def test_put_requires_session():
    """No session credential ⇒ 401 on PUT too."""
    resp = client.put("/v1/admin/auth-providers/github", json={"enabled": False})
    assert resp.status_code == 401


def test_invalid_session_forbidden(monkeypatch):
    """A present-but-invalid session ⇒ 403 (forged/expired token)."""
    monkeypatch.setattr(settings, "admin_session_secret", _ADMIN_SECRET)
    monkeypatch.setattr(settings, "admin_password", None)
    forged = _mint_admin_token(key="the-wrong-key")
    resp = client.get("/v1/admin/auth-providers", headers={"X-Admin-Session": forged})
    assert resp.status_code == 403


def test_session_via_cookie(admin_headers):
    """The session is also accepted via the ``admin_session`` cookie (what the UI forwards)."""
    token = admin_headers["X-Admin-Session"]
    cookie_client = TestClient(app, cookies={"admin_session": token})
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.list_auth_provider_config.return_value = []
        resp = cookie_client.get("/v1/admin/auth-providers")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# GET listing
# ---------------------------------------------------------------------------


def test_list_returns_all_registry_providers(admin_headers):
    """Every registry provider is listed, in order, even with no stored rows."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.list_auth_provider_config.return_value = []
        resp = client.get("/v1/admin/auth-providers", headers=admin_headers)
    assert resp.status_code == 200
    providers = resp.json()["providers"]
    ids = [p["provider_id"] for p in providers]
    assert ids == ["github", "gitlab", "azure", "google", "okta", "aws", "keycloak", "oidc", "auth0", "line", "vk", "wechat"]
    # With no rows, every field falls back to env and nothing is enabled/stored.
    gh = providers[0]
    assert gh["enabled"] is None
    assert gh["enabled_source"] == "env-fallback"
    assert gh["client_id"] is None
    assert gh["client_id_source"] == "env-fallback"
    assert gh["secret_set"] is False
    assert gh["secret_source"] == "env-fallback"
    # Issuer-based Okta / Cognito list issuer among required fields (OLO-9.3 / OLO-9.4).
    okta = next(p for p in providers if p["provider_id"] == "okta")
    assert okta["status"] == "available"
    assert okta["required_fields"] == ["client_id", "client_secret", "issuer"]
    assert okta["can_enable"] is False
    assert "issuer" in okta["missing_for_enable"]
    aws = next(p for p in providers if p["provider_id"] == "aws")
    assert aws["status"] == "available"
    assert aws["required_fields"] == ["client_id", "client_secret", "issuer"]
    assert aws["can_enable"] is False
    assert "issuer" in aws["missing_for_enable"]
    keycloak = next(p for p in providers if p["provider_id"] == "keycloak")
    assert keycloak["status"] == "available"
    assert keycloak["required_fields"] == ["client_id", "client_secret", "issuer"]
    assert keycloak["can_enable"] is False
    assert "issuer" in keycloak["missing_for_enable"]
    oidc = next(p for p in providers if p["provider_id"] == "oidc")
    assert oidc["status"] == "available"
    assert oidc["required_fields"] == ["client_id", "client_secret", "issuer"]
    assert oidc["can_enable"] is False
    assert "issuer" in oidc["missing_for_enable"]
    auth0 = next(p for p in providers if p["provider_id"] == "auth0")
    assert auth0["status"] == "available"
    assert auth0["required_fields"] == ["client_id", "client_secret", "issuer"]
    assert auth0["can_enable"] is False
    assert "issuer" in auth0["missing_for_enable"]
    line = next(p for p in providers if p["provider_id"] == "line")
    assert line["status"] == "available"
    assert line["required_fields"] == ["client_id", "client_secret"]
    assert line["can_enable"] is False
    vk = next(p for p in providers if p["provider_id"] == "vk")
    wechat = next(p for p in providers if p["provider_id"] == "wechat")
    assert vk["status"] == "available"
    assert vk["required_fields"] == ["client_id", "client_secret"]
    assert vk["can_enable"] is False
    assert wechat["status"] == "available"
    assert wechat["required_fields"] == ["client_id", "client_secret"]
    assert wechat["can_enable"] is False


def test_list_overlays_stored_row_and_masks_secret(admin_headers):
    """A stored row overlays env; the secret is reported only as a flag, never echoed."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.list_auth_provider_config.return_value = [_row()]
        resp = client.get("/v1/admin/auth-providers", headers=admin_headers)
    assert resp.status_code == 200
    gh = next(p for p in resp.json()["providers"] if p["provider_id"] == "github")
    assert gh["enabled"] is True
    assert gh["enabled_source"] == "db"
    assert gh["client_id"] == "gh-client-id"
    assert gh["client_id_source"] == "db"
    assert gh["secret_set"] is True
    assert gh["secret_source"] == "db"
    assert gh["config"] == {"base_url": "https://github.example"}
    assert gh["can_enable"] is True
    assert gh["missing_for_enable"] == []
    # The response must never carry a secret value nor the ciphertext / key id.
    assert "client_secret" not in gh
    assert "client_secret_encrypted" not in gh
    assert "enc_key_id" not in gh


def test_list_reports_missing_fields_for_partial_row(admin_headers):
    """A row with client_id but no stored secret reports the secret as missing-for-enable."""
    partial = _row(enabled=None, enc_key_id=None)  # no secret stored
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.list_auth_provider_config.return_value = [partial]
        resp = client.get("/v1/admin/auth-providers", headers=admin_headers)
    gh = next(p for p in resp.json()["providers"] if p["provider_id"] == "github")
    assert gh["secret_set"] is False
    assert gh["missing_for_enable"] == ["client_secret"]
    assert gh["can_enable"] is False


# ---------------------------------------------------------------------------
# PUT validation
# ---------------------------------------------------------------------------


def test_put_unknown_provider_404(admin_headers):
    """An id outside the registry is a 404."""
    with patch("app.auth_provider_config_routes.db"):
        resp = client.put(
            "/v1/admin/auth-providers/not-a-provider",
            json={"enabled": False},
            headers=admin_headers,
        )
    assert resp.status_code == 404


def test_put_extra_field_rejected(admin_headers):
    """Unknown body fields are rejected (extra=forbid) before any work."""
    with patch("app.auth_provider_config_routes.db"):
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"enabled": True, "surprise": 1},
            headers=admin_headers,
        )
    assert resp.status_code == 422


def test_put_enable_incomplete_rejected(admin_headers):
    """Enabling a provider with no client_id/secret is a structured 422."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = None
        resp = client.put(
            "/v1/admin/auth-providers/github", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert set(detail["missing_fields"]) == {"client_id", "client_secret"}
    # No write happened.
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_okta_incomplete_names_issuer(admin_headers):
    """Enabling Okta with credentials but no issuer is a structured 422 naming issuer (OLO-9.3)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(
            provider_id="okta",
            enabled=None,
            client_id="ok-id",
            enc_key_id="k1",
            config={},
        )
        resp = client.put(
            "/v1/admin/auth-providers/okta", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert detail["missing_fields"] == ["issuer"]
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_aws_incomplete_names_issuer(admin_headers):
    """Enabling Cognito with credentials but no issuer is a structured 422 naming issuer (OLO-9.4)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(
            provider_id="aws",
            enabled=None,
            client_id="cg-id",
            enc_key_id="k1",
            config={},
        )
        resp = client.put(
            "/v1/admin/auth-providers/aws", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert detail["missing_fields"] == ["issuer"]
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_keycloak_incomplete_names_issuer(admin_headers):
    """Enabling Keycloak with credentials but no issuer is a structured 422 naming issuer (OLO-9.5)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(
            provider_id="keycloak",
            enabled=None,
            client_id="kc-id",
            enc_key_id="k1",
            config={},
        )
        resp = client.put(
            "/v1/admin/auth-providers/keycloak", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert detail["missing_fields"] == ["issuer"]
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_oidc_incomplete_names_issuer(admin_headers):
    """Enabling OIDC with credentials but no issuer is a structured 422 naming issuer (OLO-9.6)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(
            provider_id="oidc",
            enabled=None,
            client_id="oidc-id",
            enc_key_id="k1",
            config={},
        )
        resp = client.put(
            "/v1/admin/auth-providers/oidc", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert detail["missing_fields"] == ["issuer"]
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_auth0_incomplete_names_issuer(admin_headers):
    """Enabling Auth0 with credentials but no issuer is a structured 422 naming issuer (OLO-9.7)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(
            provider_id="auth0",
            enabled=None,
            client_id="a0-id",
            enc_key_id="k1",
            config={},
        )
        resp = client.put(
            "/v1/admin/auth-providers/auth0", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert detail["missing_fields"] == ["issuer"]
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_coming_soon_rejected(admin_headers):
    """Enabling a coming-soon provider is a structured 422 (not_available)."""
    from app.auth_provider_registry import ProviderDescriptor, STATUS_COMING_SOON

    fake = ProviderDescriptor("atlassian", "Atlassian", STATUS_COMING_SOON, ())
    with (
        patch(
            "app.auth_provider_config_routes.get_provider_descriptor",
            return_value=fake,
        ),
        patch("app.auth_provider_config_routes.db") as mock_db,
    ):
        mock_db.get_auth_provider_config.return_value = None
        resp = client.put(
            "/v1/admin/auth-providers/atlassian",
            json={"enabled": True},
            headers=admin_headers,
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "provider_not_available"
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_enable_complete_in_one_request(admin_headers, enc_key):
    """Enable + client_id + secret in a single PUT succeeds and persists the sealed pair."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = None
        mock_db.upsert_auth_provider_config.return_value = _row()
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"enabled": True, "client_id": "gh-client-id", "client_secret": "s3cr3t"},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    # The upsert received a sealed secret pair (both columns), never the plaintext.
    _, kwargs_or_args = mock_db.upsert_auth_provider_config.call_args
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert updates["enabled"] is True
    assert updates["client_id"] == "gh-client-id"
    assert isinstance(updates["client_secret_encrypted"], (bytes, bytearray))
    assert updates["enc_key_id"] is not None
    assert b"s3cr3t" not in bytes(updates["client_secret_encrypted"])  # ciphertext, not plaintext
    # Response is masked.
    body = resp.json()
    assert body["secret_set"] is True
    assert "client_secret" not in body


def test_put_enable_with_existing_stored_creds(admin_headers):
    """Enabling succeeds when client_id + secret already exist on the stored row."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(enabled=False)
        mock_db.upsert_auth_provider_config.return_value = _row(enabled=True)
        resp = client.put(
            "/v1/admin/auth-providers/github", json={"enabled": True}, headers=admin_headers
        )
    assert resp.status_code == 200
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert updates == {"enabled": True}  # only the toggled field is written


def test_put_secret_without_encryption_503(admin_headers, no_enc):
    """Supplying a secret with encryption unconfigured is a 503 and writes nothing."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = None
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"client_id": "x", "client_secret": "s3cr3t"},
            headers=admin_headers,
        )
    assert resp.status_code == 503
    assert resp.json()["detail"]["error"] == "encryption_not_configured"
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_clear_secret_on_unenabled_provider(admin_headers):
    """An explicit null secret clears both secret columns when the provider is not force-enabled."""
    # enabled is null (env-derived), so clearing the DB secret to fall back to env is allowed.
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(enabled=None)
        mock_db.upsert_auth_provider_config.return_value = _row(enabled=None, enc_key_id=None)
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"client_secret": None},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert updates["client_secret_encrypted"] is None
    assert updates["enc_key_id"] is None
    assert resp.json()["secret_set"] is False


def test_put_clear_secret_while_force_enabled_rejected(admin_headers):
    """Clearing the secret while enabled=true is rejected — it would break the enabled invariant.

    ``enabled=true`` in the DB is an explicit override that must carry complete DB creds; an operator
    wanting env fallback sets ``enabled=null`` instead. So clearing the secret without disabling is a
    structured 422 (and nothing is written).
    """
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(enabled=True)
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"client_secret": None},
            headers=admin_headers,
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "provider_incomplete"
    assert detail["missing_fields"] == ["client_secret"]
    mock_db.upsert_auth_provider_config.assert_not_called()


def test_put_clear_secret_and_disable_together(admin_headers):
    """Clearing the secret AND setting enabled=null in one PUT is allowed (env fallback)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(enabled=True)
        mock_db.upsert_auth_provider_config.return_value = _row(enabled=None, enc_key_id=None)
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"enabled": None, "client_secret": None},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert updates["enabled"] is None
    assert updates["client_secret_encrypted"] is None


def test_put_omitted_secret_left_untouched(admin_headers):
    """Omitting client_secret leaves the stored secret alone (no secret columns written)."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row()
        mock_db.upsert_auth_provider_config.return_value = _row(client_id="new-id")
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"client_id": "new-id"},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert "client_secret_encrypted" not in updates
    assert "enc_key_id" not in updates
    assert updates == {"client_id": "new-id"}


def test_put_blank_client_id_clears_to_null(admin_headers):
    """A blank client_id is treated as cleared (env fallback), matching the UI's blank-is-unset."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row(enabled=None)
        mock_db.upsert_auth_provider_config.return_value = _row(client_id=None, enabled=None)
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"client_id": "   "},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert updates["client_id"] is None


def test_put_config_only(admin_headers):
    """Updating just the config JSONB writes only that column."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = _row()
        mock_db.upsert_auth_provider_config.return_value = _row(config={"authority": "https://login"})
        resp = client.put(
            "/v1/admin/auth-providers/azure",
            json={"config": {"authority": "https://login"}},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    updates = mock_db.upsert_auth_provider_config.call_args.args[1]
    assert updates == {"config": {"authority": "https://login"}}


def test_put_disable_never_completeness_checked(admin_headers):
    """Disabling (or setting enabled=false) never triggers the completeness gate."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = None
        mock_db.upsert_auth_provider_config.return_value = _row(enabled=False, client_id=None, enc_key_id=None)
        resp = client.put(
            "/v1/admin/auth-providers/github", json={"enabled": False}, headers=admin_headers
        )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# DELETE removal
# ---------------------------------------------------------------------------


def test_delete_requires_session():
    """No session credential ⇒ 401 on DELETE too."""
    resp = client.delete("/v1/admin/auth-providers/github")
    assert resp.status_code == 401


def test_delete_invalid_session_forbidden(monkeypatch):
    """A present-but-invalid session ⇒ 403; removal is never reachable without a real session."""
    monkeypatch.setattr(settings, "admin_session_secret", _ADMIN_SECRET)
    monkeypatch.setattr(settings, "admin_password", None)
    forged = _mint_admin_token(key="the-wrong-key")
    with patch("app.auth_provider_config_routes.db") as mock_db:
        resp = client.delete(
            "/v1/admin/auth-providers/github", headers={"X-Admin-Session": forged}
        )
    assert resp.status_code == 403
    mock_db.delete_auth_provider_config.assert_not_called()


def test_delete_removes_the_row(admin_headers):
    """A stored provider's row is deleted and the post-delete (env-fallback) view returned."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.delete_auth_provider_config.return_value = True
        resp = client.delete("/v1/admin/auth-providers/github", headers=admin_headers)

    assert resp.status_code == 200
    mock_db.delete_auth_provider_config.assert_called_once_with("github")
    body = resp.json()
    # Every field reports env-fallback again — as if the provider had never been configured.
    assert body["provider_id"] == "github"
    assert body["enabled"] is None
    assert body["enabled_source"] == "env-fallback"
    assert body["client_id"] is None
    assert body["client_id_source"] == "env-fallback"
    assert body["secret_set"] is False
    assert body["secret_source"] == "env-fallback"
    assert body["config"] == {}
    assert body["updated_at"] is None
    assert body["updated_by"] is None
    assert body["can_enable"] is False


def test_delete_unknown_provider_404(admin_headers):
    """A slug outside the registry is a caller error (404) and never reaches the data layer."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        resp = client.delete("/v1/admin/auth-providers/not-a-provider", headers=admin_headers)
    assert resp.status_code == 404
    mock_db.delete_auth_provider_config.assert_not_called()


def test_delete_is_idempotent(admin_headers):
    """Deleting a provider with no stored row succeeds — it is already in the requested state."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.delete_auth_provider_config.return_value = False
        resp = client.delete("/v1/admin/auth-providers/gitlab", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["provider_id"] == "gitlab"


def test_delete_coming_soon_provider_allowed(admin_headers):
    """A coming-soon provider can hold a stored row (PUT blocks only *enabling* it), so removal
    must work for it too — otherwise that row would be unreachable from the admin surface.

    The registry has no coming-soon entry at present, so one is injected via the descriptor lookup
    rather than skipping (which would silently stop covering this path).
    """
    from app.auth_provider_registry import ProviderDescriptor, STATUS_COMING_SOON

    descriptor = ProviderDescriptor("atlassian", "Atlassian", STATUS_COMING_SOON, ())

    with patch("app.auth_provider_config_routes.db") as mock_db, patch(
        "app.auth_provider_config_routes.get_provider_descriptor", return_value=descriptor
    ):
        mock_db.delete_auth_provider_config.return_value = True
        resp = client.delete("/v1/admin/auth-providers/atlassian", headers=admin_headers)

    assert resp.status_code == 200
    mock_db.delete_auth_provider_config.assert_called_once_with("atlassian")
    body = resp.json()
    assert body["status"] == "coming-soon"
    assert body["can_enable"] is False


def test_delete_response_carries_no_secret(admin_headers):
    """The removal response reports only masked state — never a secret or ciphertext."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.delete_auth_provider_config.return_value = True
        resp = client.delete("/v1/admin/auth-providers/github", headers=admin_headers)
    assert resp.status_code == 200
    assert "client_secret" not in resp.json()
    assert "client_secret_encrypted" not in resp.text


def test_no_response_ever_leaks_secret(admin_headers, enc_key):
    """Belt-and-braces: the raw PUT response text never contains the plaintext secret."""
    with patch("app.auth_provider_config_routes.db") as mock_db:
        mock_db.get_auth_provider_config.return_value = None
        mock_db.upsert_auth_provider_config.return_value = _row()
        resp = client.put(
            "/v1/admin/auth-providers/github",
            json={"enabled": True, "client_id": "gh-client-id", "client_secret": "TOP-SECRET-VALUE"},
            headers=admin_headers,
        )
    assert resp.status_code == 200
    assert "TOP-SECRET-VALUE" not in resp.text
