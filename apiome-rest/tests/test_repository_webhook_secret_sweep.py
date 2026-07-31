"""The rotation grace-window sweep (REPO-4.7, #2785).

Two halves of the ticket's second acceptance criterion live here:

* the provider hook is updated to the new secret **before** expiration — retried on every
  tick for as long as the window is open, because the reason it failed the first time (a
  token without ``admin:repo_hook``, a provider having a bad afternoon) is often gone by the
  next one; and
* the old secret expires **automatically** at the end of the window — a grace window that
  only ends when somebody remembers to end it is the long-lived-secret finding wearing a hat.

The order of the two passes is itself a rule: retry first, so a window closing in the next
few seconds gets its last attempt before its old secret stops working.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.repository_webhook_rotation import WEBHOOK_SECRET_EXPIRED_ACTION
from app.repository_webhook_secret_sweep import process_repository_webhook_secret_sweep

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_SUB_ID = "990e8400-e29b-41d4-a716-446655440004"
_USER = "660e8400-e29b-41d4-a716-446655440001"


def _pending(**overrides: Any) -> Dict[str, Any]:
    """A rotated subscription whose provider hook has not caught up yet."""
    row = {
        "id": _SUB_ID,
        "tenant_id": _TENANT,
        "repository_id": _REPO_ID,
        "provider": "github",
        "repo_full_name": "octocat/hello-world",
        "secret_enc": b"cipher",
        "secret_fingerprint": "0123456789abcdef",
        "provider_hook_id": "4242",
        "registration_state": "registered",
        "rotation_count": 1,
        "linked_account_id": "aa0e8400-e29b-41d4-a716-44665544000a",
        "created_by": _USER,
        "visibility": "private",
    }
    row.update(overrides)
    return row


def _retired(**overrides: Any) -> Dict[str, Any]:
    """A subscription the claim has just cleared an outgoing secret from."""
    row = {
        "id": _SUB_ID,
        "tenant_id": _TENANT,
        "repository_id": _REPO_ID,
        "provider": "github",
        "repo_full_name": "octocat/hello-world",
        "secret_fingerprint": "0123456789abcdef",
        "retired_secret_fingerprint": "fedcba9876543210",
        "provider_secret_synced": True,
        "rotation_error": None,
        "rotation_count": 1,
    }
    row.update(overrides)
    return row


class FakeDb:
    """The ``Database`` surface the sweep touches, and nothing else."""

    def __init__(
        self,
        *,
        pending: Optional[List[Dict[str, Any]]] = None,
        retired: Optional[List[Dict[str, Any]]] = None,
        token: Optional[str] = "linked-account-token",
        pending_raises: Optional[Exception] = None,
        claim_raises: Optional[Exception] = None,
    ) -> None:
        self.pending = pending if pending is not None else []
        self.retired = retired if retired is not None else []
        self.token = token
        self.pending_raises = pending_raises
        self.claim_raises = claim_raises

        self.calls: List[str] = []
        self.sync_states: List[Dict[str, Any]] = []
        self.audits: List[Dict[str, Any]] = []
        self.claim_limits: List[int] = []

    def list_repository_webhook_subscriptions_pending_provider_secret(self, limit):
        self.calls.append("pending")
        if self.pending_raises is not None:
            raise self.pending_raises
        return [dict(r) for r in self.pending]

    def claim_expired_repository_webhook_secrets(self, limit):
        self.calls.append("claim")
        self.claim_limits.append(limit)
        if self.claim_raises is not None:
            raise self.claim_raises
        return [dict(r) for r in self.retired]

    def get_external_auth_provider_for_user(self, linked_account_id, user_id):
        return {"access_token": self.token} if self.token else None

    def set_repository_webhook_provider_secret_synced(
        self, subscription_id, *, synced, error=None
    ):
        self.sync_states.append(
            {"subscription_id": subscription_id, "synced": synced, "error": error}
        )
        return None

    def insert_workflow_audit(
        self, tenant_id, project_id, version_id, action, outcome, actor, detail
    ):
        self.audits.append(
            {
                "tenant_id": tenant_id,
                "action": action,
                "outcome": outcome,
                "detail": detail,
            }
        )


@pytest.fixture(autouse=True)
def _secret_recovers(monkeypatch):
    """The stored ciphertext decrypts, so the sweep has something to hand the provider."""
    monkeypatch.setattr(
        "app.repository_webhook_subscriptions.decrypt_signing_secret",
        lambda blob: "current-secret",
    )


@pytest.fixture
def _hook_update(monkeypatch):
    """Provider hook updates succeed; records what was sent."""
    calls: List[Dict[str, Any]] = []

    def _update(**kwargs):
        calls.append(kwargs)
        return {"ok": True}

    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret", _update
    )
    monkeypatch.setattr(
        "app.repository_webhook_rotation.webhook_endpoint_url",
        lambda provider: "https://api.example.test/v1/repositories/webhook/github",
    )
    return calls


# --- Pass 1: the provider catches up ----------------------------------------------------


def test_an_unsynced_rotation_is_retried_against_the_provider(_hook_update) -> None:
    """Acceptance criterion 2: the hook is updated before the window closes."""
    db = FakeDb(pending=[_pending()])

    result = process_repository_webhook_secret_sweep(db)

    assert result["synced"] == 1
    assert _hook_update[0]["hook_id"] == "4242"
    assert _hook_update[0]["secret"] == "current-secret"
    assert db.sync_states[-1]["synced"] is True


def test_the_retry_uses_the_registering_users_linked_account(_hook_update) -> None:
    """A hook created under one account cannot be edited with another account's token."""
    db = FakeDb(pending=[_pending()])

    process_repository_webhook_secret_sweep(db)

    assert _hook_update[0]["access_token"] == "linked-account-token"


def test_a_repository_with_no_linked_account_is_left_for_an_operator(_hook_update) -> None:
    db = FakeDb(pending=[_pending(linked_account_id=None, created_by=None)])

    result = process_repository_webhook_secret_sweep(db)

    assert _hook_update == []
    assert result["synced"] == 0
    assert db.sync_states[-1]["synced"] is False


def test_a_provider_that_refuses_again_stays_unsynced(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret",
        lambda **kwargs: {"ok": False, "error": "still no"},
    )
    monkeypatch.setattr(
        "app.repository_webhook_rotation.webhook_endpoint_url",
        lambda provider: "https://api.example.test/hook",
    )
    db = FakeDb(pending=[_pending()])

    result = process_repository_webhook_secret_sweep(db)

    assert result["synced"] == 0
    assert db.sync_states[-1] == {
        "subscription_id": _SUB_ID,
        "synced": False,
        "error": "still no",
    }


def test_an_unrecoverable_secret_is_never_pushed_to_the_provider(monkeypatch) -> None:
    """Handing over a secret we cannot verify with would break the hook for good."""
    monkeypatch.setattr(
        "app.repository_webhook_subscriptions.decrypt_signing_secret", lambda blob: None
    )
    called: List[Any] = []
    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret",
        lambda **kwargs: called.append(kwargs) or {"ok": True},
    )
    db = FakeDb(pending=[_pending()])

    result = process_repository_webhook_secret_sweep(db)

    assert called == []
    assert result["synced"] == 0
    assert db.sync_states == []


def test_a_token_lookup_failure_does_not_stop_the_tick(_hook_update) -> None:
    db = FakeDb(pending=[_pending()])
    db.get_external_auth_provider_for_user = lambda *a, **k: (_ for _ in ()).throw(
        RuntimeError("down")
    )

    result = process_repository_webhook_secret_sweep(db)

    assert result["synced"] == 0
    assert "claim" in db.calls  # the expiry pass still ran


def test_a_failed_pending_lookup_still_lets_expiry_run() -> None:
    """The two passes protect different things; neither may take the other down."""
    db = FakeDb(pending_raises=RuntimeError("boom"), retired=[_retired()])

    result = process_repository_webhook_secret_sweep(db)

    assert result == {"synced": 0, "retired": 1}


# --- Pass 2: the window closes ----------------------------------------------------------


def test_an_expired_secret_is_retired_and_audited() -> None:
    db = FakeDb(retired=[_retired()])

    result = process_repository_webhook_secret_sweep(db)

    assert result["retired"] == 1
    audit = db.audits[0]
    assert audit["action"] == WEBHOOK_SECRET_EXPIRED_ACTION
    assert audit["outcome"] == "success"
    assert audit["detail"]["retiredSecretFingerprint"] == "fedcba9876543210"
    assert audit["tenant_id"] == _TENANT


def test_a_window_that_closed_on_an_unsynced_provider_is_audited_as_a_failure() -> None:
    """From now on that provider's deliveries are 401s; the audit row must say so."""
    db = FakeDb(
        retired=[_retired(provider_secret_synced=False, rotation_error="GitHub said no")]
    )

    process_repository_webhook_secret_sweep(db)

    audit = db.audits[0]
    assert audit["outcome"] == "failure"
    assert "fail signature verification" in audit["detail"]["warning"]
    assert audit["detail"]["providerError"] == "GitHub said no"


def test_a_retirement_audit_never_carries_a_secret() -> None:
    db = FakeDb(retired=[_retired()])

    process_repository_webhook_secret_sweep(db)

    rendered = repr(db.audits[0]["detail"])
    assert "secret_enc" not in rendered
    assert "previousSecretEnc" not in rendered


def test_an_unattributable_retirement_writes_no_audit_row() -> None:
    """A row no tenant can ever read is not evidence; the claim itself is the record."""
    db = FakeDb(retired=[_retired(tenant_id=None)])

    result = process_repository_webhook_secret_sweep(db)

    assert result["retired"] == 1
    assert db.audits == []


def test_an_audit_failure_never_undoes_a_retirement() -> None:
    db = FakeDb(retired=[_retired()])
    db.insert_workflow_audit = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))

    result = process_repository_webhook_secret_sweep(db)

    assert result["retired"] == 1


def test_a_failed_claim_is_a_quiet_tick_not_a_crash() -> None:
    db = FakeDb(claim_raises=RuntimeError("boom"))

    assert process_repository_webhook_secret_sweep(db) == {"synced": 0, "retired": 0}


# --- Tick shape -------------------------------------------------------------------------


def test_the_provider_retry_runs_before_the_expiry() -> None:
    """A window closing in seconds gets its last attempt before the old secret dies."""
    db = FakeDb(pending=[_pending()], retired=[_retired()])

    process_repository_webhook_secret_sweep(db)

    assert db.calls == ["pending", "claim"]


def test_an_idle_deployment_does_nothing() -> None:
    db = FakeDb()

    assert process_repository_webhook_secret_sweep(db) == {"synced": 0, "retired": 0}
    assert db.audits == []


@pytest.mark.parametrize(
    "requested,expected", [(0, 1), (None, 50), (10, 10), (10_000, 500)]
)
def test_the_per_tick_limit_is_bounded(requested, expected) -> None:
    """One deployment-wide rotation must not become a several-thousand-call tick."""
    db = FakeDb()

    process_repository_webhook_secret_sweep(db, limit=requested)

    assert db.claim_limits == [expected]
