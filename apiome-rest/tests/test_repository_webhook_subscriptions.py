"""Webhook subscription provisioning and projection (REPO-4.3, #2781).

Two guarantees are load-bearing here and each has its own section:

* **Registration is best-effort and honest.** Minting the secret always happens; asking the
  provider to create the hook happens only when there is a token and a public URL to try
  with, and whatever the provider answers is recorded as a state rather than swallowed.
  Registering a repository never fails because of a webhook.

* **The secret does not appear in a REST projection.** ``describe_subscription`` is the one
  function every response goes through, so it is tested against a row that deliberately
  carries secret material to prove none of it survives the projection.
"""

from typing import Any, Dict, List, Optional

import httpx
import pytest

from app.repository_webhook_subscriptions import (
    REGISTRATION_FAILED,
    REGISTRATION_LOCAL,
    REGISTRATION_REGISTERED,
    WEBHOOK_REGISTERED_ACTION,
    describe_subscription,
    provision_repository_webhook,
    register_github_webhook,
    resolve_subscription_secret,
    webhook_endpoint_path,
    webhook_endpoint_url,
)

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_SUB_ID = "990e8400-e29b-41d4-a716-446655440004"


class FakeDb:
    """Records what provisioning wrote, and can be told to refuse an insert."""

    def __init__(self, *, insert_returns: Optional[Dict[str, Any]] = "default") -> None:
        self.inserted: List[Dict[str, Any]] = []
        self.updates: List[Dict[str, Any]] = []
        self.audits: List[Dict[str, Any]] = []
        self._insert_returns = insert_returns

    def insert_repository_webhook_subscription(self, **kwargs):
        self.inserted.append(kwargs)
        if self._insert_returns == "default":
            return {
                "id": _SUB_ID,
                "tenant_id": kwargs["tenant_id"],
                "repository_id": kwargs["repository_id"],
                "provider": kwargs["provider"],
                "repo_full_name": kwargs["repo_full_name"],
                "secret_fingerprint": kwargs["secret_fingerprint"],
                "pr_preview_enabled": True,
                "registration_state": REGISTRATION_LOCAL,
                "event_count": 0,
            }
        return self._insert_returns

    def update_repository_webhook_registration(self, subscription_id, **kwargs):
        self.updates.append({"id": subscription_id, **kwargs})
        return {"id": subscription_id, "provider": "github", **kwargs}

    def insert_workflow_audit(self, tenant_id, project_id, version_id, action, outcome, actor, detail):
        self.audits.append(
            {"tenant_id": tenant_id, "action": action, "outcome": outcome, "detail": detail}
        )


def _client(handler) -> httpx.Client:
    """An httpx client whose every request is answered by ``handler``."""
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def public_base(monkeypatch):
    """Configure a public base URL so hook creation is attempted."""
    from app.config import settings

    monkeypatch.setattr(settings, "repository_webhook_base_url", "https://api.example.test")
    return "https://api.example.test"


# --- Endpoint derivation ----------------------------------------------------------------


def test_the_endpoint_path_names_the_provider() -> None:
    assert webhook_endpoint_path("github") == "/v1/repositories/webhook/github"
    assert webhook_endpoint_path("gitlab") == "/v1/repositories/webhook/gitlab"


def test_a_trailing_slash_on_the_base_url_does_not_double_up() -> None:
    assert (
        webhook_endpoint_url("github", "https://api.example.test/")
        == "https://api.example.test/v1/repositories/webhook/github"
    )


def test_no_configured_base_url_yields_no_absolute_url(monkeypatch) -> None:
    """Better to show an operator the path than to invent a host nothing delivers to."""
    from app.config import settings

    monkeypatch.setattr(settings, "repository_webhook_base_url", "")
    assert webhook_endpoint_url("github") is None


# --- Secret recovery --------------------------------------------------------------------


def test_a_subscription_with_no_ciphertext_recovers_no_secret() -> None:
    assert resolve_subscription_secret({"secret_enc": None}) is None
    assert resolve_subscription_secret({}) is None


def test_a_corrupt_ciphertext_column_recovers_no_secret() -> None:
    """A broken subscription must fail verification, not raise out of the ingest path."""
    assert resolve_subscription_secret({"secret_enc": "not-bytes-at-all"}) is None


# --- Acceptance criterion 4: the secret is not in a REST projection ----------------------


def test_the_projection_carries_a_fingerprint_and_never_the_secret() -> None:
    row = {
        "id": _SUB_ID,
        "provider": "github",
        "repo_full_name": "octocat/hello-world",
        "secret_enc": b"super-secret-ciphertext",
        "secret_fingerprint": "0123456789abcdef",
        "registration_state": REGISTRATION_REGISTERED,
        "provider_hook_id": "1234",
        "pr_preview_enabled": True,
        "event_count": 3,
    }

    projected = describe_subscription(row)

    assert projected["secretFingerprint"] == "0123456789abcdef"
    flattened = repr(projected)
    assert "secret_enc" not in projected
    assert "secret" not in {k for k in projected if k != "secretFingerprint"}
    assert "super-secret-ciphertext" not in flattened


def test_the_projection_is_built_from_an_explicit_field_list() -> None:
    """A column added to the table later must be absent by default, not leak by default."""
    row = {
        "id": _SUB_ID,
        "provider": "github",
        "registration_state": REGISTRATION_LOCAL,
        "secret_enc": b"x",
        "some_future_sensitive_column": "leak-me",
    }

    projected = describe_subscription(row)

    assert "some_future_sensitive_column" not in projected
    assert "leak-me" not in repr(projected)


def test_the_projection_tells_an_operator_which_header_to_configure() -> None:
    projected = describe_subscription(
        {"id": _SUB_ID, "provider": "gitlab", "registration_state": REGISTRATION_LOCAL}
    )
    assert projected["signatureHeader"] == "X-Gitlab-Token"
    assert projected["endpointPath"] == "/v1/repositories/webhook/gitlab"


def test_no_subscription_projects_to_nothing() -> None:
    assert describe_subscription(None) is None


# --- Provider hook creation -------------------------------------------------------------


def test_a_created_hook_returns_its_provider_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octocat/hello-world/hooks"
        body = request.read().decode()
        assert "pull_request" in body and "push" in body
        return httpx.Response(201, json={"id": 4242})

    with _client(handler) as client:
        outcome = register_github_webhook(
            access_token="t",
            owner="octocat",
            repo="hello-world",
            delivery_url="https://api.example.test/v1/repositories/webhook/github",
            secret="s",
            client=client,
        )

    assert outcome == {"ok": True, "hook_id": "4242"}


@pytest.mark.parametrize("status", [403, 404])
def test_a_missing_scope_is_reported_as_a_scope_problem(status: int) -> None:
    """GitHub answers 404 rather than 403 for a token without admin:repo_hook."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={})

    with _client(handler) as client:
        outcome = register_github_webhook(
            access_token="t",
            owner="o",
            repo="r",
            delivery_url="https://x/y",
            secret="s",
            client=client,
        )

    assert outcome["ok"] is False
    assert "admin:repo_hook" in outcome["error"]


def test_a_network_failure_is_a_recorded_error_not_an_exception() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with _client(handler) as client:
        outcome = register_github_webhook(
            access_token="t",
            owner="o",
            repo="r",
            delivery_url="https://x/y",
            secret="s",
            client=client,
        )

    assert outcome["ok"] is False
    assert "failed" in outcome["error"]


def test_an_unexpected_status_is_reported_verbatim() -> None:
    with _client(lambda r: httpx.Response(500, json={})) as client:
        outcome = register_github_webhook(
            access_token="t",
            owner="o",
            repo="r",
            delivery_url="https://x/y",
            secret="s",
            client=client,
        )
    assert outcome["ok"] is False
    assert "HTTP 500" in outcome["error"]


# --- Provisioning at registration time --------------------------------------------------


def test_provisioning_always_stores_a_secret_even_with_no_token() -> None:
    """A repository is ready to accept signed deliveries the moment it exists."""
    db = FakeDb()

    result = provision_repository_webhook(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="OctoCat/Hello-World",
    )

    assert result.state == REGISTRATION_LOCAL
    assert result.subscription is not None
    assert result.secret and len(result.secret) == 64
    assert db.inserted[0]["repo_full_name"] == "octocat/hello-world"
    assert db.inserted[0]["secret_fingerprint"]
    assert "no linked-account token" in result.error


def test_provisioning_registers_the_hook_when_a_token_and_url_exist(public_base) -> None:
    db = FakeDb()

    with _client(lambda r: httpx.Response(201, json={"id": 99})) as client:
        result = provision_repository_webhook(
            db,
            tenant_id=_TENANT,
            repository_id=_REPO_ID,
            provider="github",
            repo_full_name="octocat/hello-world",
            access_token="tok",
            actor_id="user-1",
            client=client,
        )

    assert result.state == REGISTRATION_REGISTERED
    assert db.updates[0]["registration_state"] == REGISTRATION_REGISTERED
    assert db.updates[0]["provider_hook_id"] == "99"
    audit = next(a for a in db.audits if a["action"] == WEBHOOK_REGISTERED_ACTION)
    assert audit["outcome"] == "success"


def test_a_provider_refusal_is_recorded_and_registration_still_succeeds(public_base) -> None:
    db = FakeDb()

    with _client(lambda r: httpx.Response(404, json={})) as client:
        result = provision_repository_webhook(
            db,
            tenant_id=_TENANT,
            repository_id=_REPO_ID,
            provider="github",
            repo_full_name="octocat/hello-world",
            access_token="tok",
            client=client,
        )

    assert result.state == REGISTRATION_FAILED
    assert result.error and "admin:repo_hook" in result.error
    # The secret was still minted, so a manual hook will work.
    assert result.secret
    audit = next(a for a in db.audits if a["action"] == WEBHOOK_REGISTERED_ACTION)
    assert audit["outcome"] == "failure"


def test_without_a_public_base_url_no_hook_is_attempted(monkeypatch) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "repository_webhook_base_url", "")
    db = FakeDb()

    result = provision_repository_webhook(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="octocat/hello-world",
        access_token="tok",
    )

    assert result.state == REGISTRATION_LOCAL
    assert "APIOME_REPOSITORY_WEBHOOK_BASE_URL" in result.error
    assert db.updates == []


def test_a_non_github_provider_stores_a_secret_but_creates_no_hook(public_base) -> None:
    db = FakeDb()

    result = provision_repository_webhook(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="gitlab",
        repo_full_name="group/proj",
        access_token="tok",
    )

    assert result.state == REGISTRATION_LOCAL
    assert db.inserted[0]["provider"] == "gitlab"
    assert "not implemented for gitlab" in result.error


def test_an_existing_subscription_is_never_overwritten() -> None:
    """The secret is write-once; re-provisioning must not mint a second live secret."""
    db = FakeDb(insert_returns=None)

    result = provision_repository_webhook(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="octocat/hello-world",
    )

    assert result.subscription is None
    assert result.secret is None
    assert "already exists" in result.error


@pytest.mark.parametrize(
    "provider,full_name",
    [("gogs", "o/r"), ("github", ""), ("github", None)],
)
def test_a_repository_we_cannot_resolve_deliveries_for_stores_nothing(provider, full_name) -> None:
    db = FakeDb()

    result = provision_repository_webhook(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider=provider,
        repo_full_name=full_name,
    )

    assert result.subscription is None
    assert db.inserted == []
    assert result.error


def test_a_store_failure_never_fails_repository_registration() -> None:
    class BrokenDb(FakeDb):
        def insert_repository_webhook_subscription(self, **kwargs):
            raise RuntimeError("relation does not exist")

    result = provision_repository_webhook(
        BrokenDb(),
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="octocat/hello-world",
    )

    assert result.subscription is None
    assert result.state == REGISTRATION_LOCAL
    assert "relation does not exist" in result.error
