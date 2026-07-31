"""Signing-secret rotation (REPO-4.7, #2785).

The ticket's three acceptance criteria, stated as tests:

1. two active secrets per repository during the window, and verification accepts either —
   :func:`app.repository_webhook_subscriptions.resolve_subscription_secrets`;
2. the provider hook is updated to the new secret before the window closes — the rotation
   attempts it inline, and records honestly when it could not;
3. an audit row ``repository.webhook_secret_rotated`` for every rotation.

Plus the property that outranks all three: a rotation must never leave the deployment unable
to verify anything. Every path that could produce that state — no encryption key, a
subscription that never held a secret, a store that refused the write — raises before
anything is changed.

Driven against fakes; the schema-side half of the contract (the guard trigger that makes the
rotation shape mandatory) is pinned by ``test_repository_webhook_migration.py``.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
import pytest

from app.repository_webhook_rotation import (
    WEBHOOK_SECRET_ROTATED_ACTION,
    RotationError,
    resolve_grace_seconds,
    rotate_repository_webhook_secret,
    sync_provider_secret,
)
from app.repository_webhook_subscriptions import (
    SECRET_GENERATION_CURRENT,
    SECRET_GENERATION_PREVIOUS,
    describe_subscription,
    previous_secret_is_live,
    resolve_subscription_secrets,
    update_github_webhook_secret,
)

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_SUB_ID = "990e8400-e29b-41d4-a716-446655440004"
_USER = "660e8400-e29b-41d4-a716-446655440001"


def _now() -> datetime:
    return datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)


def _subscription(**overrides: Any) -> Dict[str, Any]:
    row = {
        "id": _SUB_ID,
        "tenant_id": _TENANT,
        "repository_id": _REPO_ID,
        "provider": "github",
        "repo_full_name": "octocat/hello-world",
        "secret_fingerprint": "0123456789abcdef",
        "provider_hook_id": "4242",
        "registration_state": "registered",
        "pr_preview_enabled": True,
        "previous_secret_fingerprint": None,
        "previous_secret_expires_at": None,
        "rotated_at": None,
        "rotation_count": 0,
        "provider_secret_synced": True,
        "rotation_error": None,
        "event_count": 0,
    }
    row.update(overrides)
    return row


#: Distinguishes "the test did not specify a subscription" from "there is no subscription",
#: which is itself a case under test.
_UNSET = object()


class FakeDb:
    """The ``Database`` surface the rotation path touches, and nothing else."""

    def __init__(
        self,
        *,
        subscription: Any = _UNSET,
        rotate_returns: Optional[Dict[str, Any]] = None,
        rotate_raises: Optional[Exception] = None,
    ) -> None:
        self.subscription = _subscription() if subscription is _UNSET else subscription
        self.rotate_returns = rotate_returns
        self.rotate_raises = rotate_raises
        self.rotations: List[Dict[str, Any]] = []
        self.sync_states: List[Dict[str, Any]] = []
        self.audits: List[Dict[str, Any]] = []

    def get_repository_webhook_subscription(self, tenant_id, repository_id):
        if self.subscription is None:
            return None
        return dict(self.subscription)

    def rotate_repository_webhook_secret(
        self, subscription_id, *, secret_enc, secret_fingerprint, grace_seconds
    ):
        if self.rotate_raises is not None:
            raise self.rotate_raises
        self.rotations.append(
            {
                "subscription_id": subscription_id,
                "secret_enc": secret_enc,
                "secret_fingerprint": secret_fingerprint,
                "grace_seconds": grace_seconds,
            }
        )
        if self.rotate_returns is not None:
            return dict(self.rotate_returns) if self.rotate_returns else None
        # Built from the subscription under test, not from the defaults: a rotation returns
        # *this* subscription with new secret facets, and a test that set `provider_hook_id`
        # to None must still see None afterwards.
        rotated = dict(self.subscription)
        rotated.update(
            {
                "secret_fingerprint": secret_fingerprint,
                "previous_secret_fingerprint": self.subscription.get("secret_fingerprint"),
                "previous_secret_expires_at": _now() + timedelta(seconds=grace_seconds),
                "rotated_at": _now(),
                "rotation_count": int(self.subscription.get("rotation_count") or 0) + 1,
                "provider_secret_synced": False,
                "rotation_error": None,
            }
        )
        return rotated

    def set_repository_webhook_provider_secret_synced(
        self, subscription_id, *, synced, error=None
    ):
        self.sync_states.append(
            {"subscription_id": subscription_id, "synced": synced, "error": error}
        )
        return _subscription(provider_secret_synced=synced, rotation_error=error)

    def insert_workflow_audit(
        self, tenant_id, project_id, version_id, action, outcome, actor, detail
    ):
        self.audits.append(
            {
                "tenant_id": tenant_id,
                "action": action,
                "outcome": outcome,
                "actor": actor,
                "detail": detail,
            }
        )


@pytest.fixture(autouse=True)
def _encryption_configured(monkeypatch):
    """A deployment with a working key, so rotation is possible unless a test says otherwise."""
    monkeypatch.setattr(
        "app.repository_webhook_rotation.encrypt_signing_secret",
        lambda plain: plain.encode("utf-8"),
    )


@pytest.fixture
def _delivery_url(monkeypatch):
    """A deployment with a public base URL, so the provider hook is addressable."""
    monkeypatch.setattr(
        "app.repository_webhook_rotation.webhook_endpoint_url",
        lambda provider: "https://api.example.test/v1/repositories/webhook/github",
    )


@pytest.fixture
def _hook_update_succeeds(monkeypatch, _delivery_url):
    """GitHub accepts the hook update; records the calls it received."""
    calls: List[Dict[str, Any]] = []

    def _update(**kwargs):
        calls.append(kwargs)
        return {"ok": True}

    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret", _update
    )
    return calls


def _rotate(db: FakeDb, **kwargs: Any):
    """Rotate with the arguments a real request supplies, unless a test overrides them."""
    kwargs.setdefault("tenant_id", _TENANT)
    kwargs.setdefault("repository_id", _REPO_ID)
    kwargs.setdefault("access_token", "linked-account-token")
    return rotate_repository_webhook_secret(db, **kwargs)


# --- Acceptance criterion 1: two secrets, either verifies -------------------------------


def _rotating_row(*, expires_in: timedelta) -> Dict[str, Any]:
    return {
        "secret_enc": b"new-secret",
        "previous_secret_enc": b"old-secret",
        "previous_secret_expires_at": _now() + expires_in,
    }


def _decrypt_map(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.repository_webhook_subscriptions.decrypt_signing_secret",
        lambda blob: bytes(blob).decode("utf-8"),
    )


def test_both_secrets_are_offered_during_the_grace_window(monkeypatch) -> None:
    """Acceptance criterion 1: verification accepts either secret while the window is open."""
    _decrypt_map(monkeypatch)

    secrets = resolve_subscription_secrets(
        _rotating_row(expires_in=timedelta(hours=6)), now=_now()
    )

    assert secrets == [
        ("new-secret", SECRET_GENERATION_CURRENT),
        ("old-secret", SECRET_GENERATION_PREVIOUS),
    ]


def test_the_current_secret_is_tried_first(monkeypatch) -> None:
    """The steady state must not pay for the exception; one HMAC, not two."""
    _decrypt_map(monkeypatch)

    secrets = resolve_subscription_secrets(
        _rotating_row(expires_in=timedelta(hours=6)), now=_now()
    )

    assert secrets[0][1] == SECRET_GENERATION_CURRENT


def test_the_old_secret_stops_being_offered_when_the_window_closes(monkeypatch) -> None:
    """Acceptance criterion 2: expiry is automatic, not a state somebody has to notice."""
    _decrypt_map(monkeypatch)

    secrets = resolve_subscription_secrets(
        _rotating_row(expires_in=timedelta(seconds=-1)), now=_now()
    )

    assert secrets == [("new-secret", SECRET_GENERATION_CURRENT)]


def test_a_subscription_with_no_rotation_offers_exactly_one_secret(monkeypatch) -> None:
    _decrypt_map(monkeypatch)

    secrets = resolve_subscription_secrets({"secret_enc": b"only-secret"}, now=_now())

    assert secrets == [("only-secret", SECRET_GENERATION_CURRENT)]


def test_an_undecryptable_current_secret_still_allows_the_previous_one(monkeypatch) -> None:
    """A key rotation that stranded the newest ciphertext must not strand the whole hook."""
    monkeypatch.setattr(
        "app.repository_webhook_subscriptions.decrypt_signing_secret",
        lambda blob: None if bytes(blob) == b"new-secret" else "old-secret",
    )

    secrets = resolve_subscription_secrets(
        _rotating_row(expires_in=timedelta(hours=1)), now=_now()
    )

    assert secrets == [("old-secret", SECRET_GENERATION_PREVIOUS)]


def test_nothing_recoverable_means_nothing_verifies(monkeypatch) -> None:
    """Fail closed: an unrecoverable secret is never an excuse to accept a delivery."""
    monkeypatch.setattr(
        "app.repository_webhook_subscriptions.decrypt_signing_secret", lambda blob: None
    )

    assert resolve_subscription_secrets(_rotating_row(expires_in=timedelta(hours=1))) == []


def test_a_previous_secret_equal_to_the_current_one_is_not_offered_twice(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.repository_webhook_subscriptions.decrypt_signing_secret",
        lambda blob: "same",
    )

    secrets = resolve_subscription_secrets(
        _rotating_row(expires_in=timedelta(hours=1)), now=_now()
    )

    assert secrets == [("same", SECRET_GENERATION_CURRENT)]


@pytest.mark.parametrize(
    "row",
    [
        {"previous_secret_enc": None, "previous_secret_expires_at": _now()},
        {"previous_secret_enc": b"old", "previous_secret_expires_at": None},
        {"previous_secret_enc": b"old", "previous_secret_expires_at": "not a timestamp"},
    ],
    ids=["no-secret", "no-deadline", "unusable-deadline"],
)
def test_a_malformed_grace_window_reads_as_expired(row) -> None:
    """A window that cannot be judged is treated as closed, never as open forever."""
    assert previous_secret_is_live(row, now=_now()) is False


def test_a_naive_deadline_is_read_as_utc() -> None:
    """The column is TIMESTAMPTZ; only a fake can be naive, and UTC is what it means."""
    row = {
        "previous_secret_enc": b"old",
        "previous_secret_expires_at": _now().replace(tzinfo=None) + timedelta(hours=1),
    }

    assert previous_secret_is_live(row, now=_now()) is True


# --- The grace window itself ------------------------------------------------------------


def test_the_default_grace_window_is_twenty_four_hours() -> None:
    """The ticket's default, stated once so a config drift fails here."""
    assert resolve_grace_seconds() == 86400


def test_a_requested_window_is_honoured_within_bounds() -> None:
    assert resolve_grace_seconds(3600) == 3600


def test_an_absurd_window_is_clamped_not_rejected() -> None:
    """A rotation refused on a technicality is a rotation that does not happen."""
    from app.config import settings

    assert resolve_grace_seconds(10**9) == settings.repository_webhook_secret_max_grace_seconds
    assert resolve_grace_seconds(0) == settings.repository_webhook_secret_min_grace_seconds


# --- The rotation itself ----------------------------------------------------------------


def test_a_rotation_stores_a_new_secret_and_a_grace_window(_hook_update_succeeds) -> None:
    db = FakeDb()

    result = _rotate(db, grace_seconds=3600)

    assert db.rotations[0]["subscription_id"] == _SUB_ID
    assert db.rotations[0]["grace_seconds"] == 3600
    assert result.grace_seconds == 3600
    assert result.subscription["rotation_count"] == 1


def test_the_new_secret_is_freshly_minted_and_never_the_old_one(_hook_update_succeeds) -> None:
    db = FakeDb()

    _rotate(db)

    stored = db.rotations[0]
    assert len(stored["secret_enc"]) == 64  # the encrypt fake is identity over 64 hex chars
    assert stored["secret_fingerprint"] != "0123456789abcdef"


def test_a_rotation_updates_the_provider_hook(_hook_update_succeeds) -> None:
    """Acceptance criterion 2: the provider gets the new secret, not a promise of one."""
    db = FakeDb()

    result = _rotate(db)

    call = _hook_update_succeeds[0]
    assert call["hook_id"] == "4242"
    assert call["owner"] == "octocat"
    assert call["repo"] == "hello-world"
    assert result.provider_synced is True
    assert db.sync_states[-1]["synced"] is True


def test_the_database_is_written_before_the_provider(monkeypatch, _delivery_url) -> None:
    """The other order can leave the provider signing with a secret nobody stored."""
    db = FakeDb()
    order: List[str] = []
    original = db.rotate_repository_webhook_secret

    def _store(*args, **kwargs):
        order.append("store")
        return original(*args, **kwargs)

    db.rotate_repository_webhook_secret = _store

    def _update(**kwargs):
        order.append("provider")
        return {"ok": True}

    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret", _update
    )
    _rotate(db)

    assert order == ["store", "provider"]


def test_a_rotation_writes_the_audit_row_the_ticket_names(_hook_update_succeeds) -> None:
    """Acceptance criterion 3, by exact action name."""
    db = FakeDb()

    _rotate(db, actor_id=_USER, grace_seconds=3600)

    audit = db.audits[0]
    assert audit["action"] == WEBHOOK_SECRET_ROTATED_ACTION
    assert audit["action"] == "repository.webhook_secret_rotated"
    assert audit["tenant_id"] == _TENANT
    assert audit["actor"] == _USER
    assert audit["outcome"] == "success"
    assert audit["detail"]["graceSeconds"] == 3600
    assert audit["detail"]["previousSecretFingerprint"] == "0123456789abcdef"
    assert audit["detail"]["providerSecretSynced"] is True


def test_the_audit_row_never_carries_either_secret(_hook_update_succeeds) -> None:
    db = FakeDb()

    _rotate(db)

    rendered = repr(db.audits[0]["detail"])
    minted = db.rotations[0]["secret_enc"].decode("utf-8")
    assert minted not in rendered
    assert "secret_enc" not in rendered


def test_a_rotation_the_provider_refused_still_happened(monkeypatch, _delivery_url) -> None:
    """The window is what protects deliveries; rolling back would leave an aging secret."""
    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret",
        lambda **kwargs: {"ok": False, "error": "GitHub said no"},
    )
    db = FakeDb()

    result = _rotate(db)

    assert len(db.rotations) == 1
    assert result.provider_synced is False
    assert result.provider_error == "GitHub said no"
    assert db.sync_states[-1] == {
        "subscription_id": _SUB_ID,
        "synced": False,
        "error": "GitHub said no",
    }
    assert db.audits[0]["outcome"] == "failure"
    assert db.audits[0]["detail"]["providerError"] == "GitHub said no"


def test_a_rotation_without_a_provider_token_is_recorded_not_refused(_delivery_url) -> None:
    db = FakeDb()

    result = _rotate(db, access_token=None)

    assert len(db.rotations) == 1
    assert result.provider_synced is False
    assert "no linked-account token" in (result.provider_error or "")


def test_a_local_subscription_rotates_without_a_provider_hook(_delivery_url) -> None:
    """Nobody has pointed the provider at us; the secret still ages and still rotates."""
    db = FakeDb(subscription=_subscription(provider_hook_id=None, registration_state="local"))

    result = _rotate(db)

    assert len(db.rotations) == 1
    assert result.provider_synced is False
    assert "no provider hook" in (result.provider_error or "")


def test_no_delivery_url_refuses_to_touch_the_hook(monkeypatch) -> None:
    """GitHub replaces the config wholesale; a PATCH without the URL detaches the hook."""
    monkeypatch.setattr(
        "app.repository_webhook_rotation.webhook_endpoint_url", lambda provider: None
    )
    called: List[Any] = []
    monkeypatch.setattr(
        "app.repository_webhook_rotation.update_github_webhook_secret",
        lambda **kwargs: called.append(kwargs) or {"ok": True},
    )
    db = FakeDb()

    result = _rotate(db)

    assert called == []
    assert result.provider_synced is False
    assert "BASE_URL" in (result.provider_error or "")


def test_a_non_github_provider_rotates_locally(_delivery_url) -> None:
    db = FakeDb(subscription=_subscription(provider="gitlab"))

    result = _rotate(db)

    assert len(db.rotations) == 1
    assert result.provider_synced is False
    assert "gitlab" in (result.provider_error or "")


# --- Refusals: nothing changed ----------------------------------------------------------


def test_a_repository_with_no_subscription_cannot_be_rotated() -> None:
    db = FakeDb(subscription=None)

    with pytest.raises(RotationError) as exc:
        _rotate(db)

    assert exc.value.code == "no_subscription"
    assert db.rotations == []


def test_a_deployment_with_no_encryption_key_refuses_rather_than_storing_nothing(
    monkeypatch,
) -> None:
    """Storing NULL ciphertext would make every delivery for this repository a 401."""
    monkeypatch.setattr(
        "app.repository_webhook_rotation.encrypt_signing_secret", lambda plain: None
    )
    db = FakeDb()

    with pytest.raises(RotationError) as exc:
        _rotate(db)

    assert exc.value.code == "no_encryption_key"
    assert db.rotations == []
    assert db.audits == []


def test_a_subscription_that_never_held_a_secret_cannot_be_rotated() -> None:
    db = FakeDb(subscription=_subscription(secret_fingerprint=None))

    with pytest.raises(RotationError) as exc:
        _rotate(db)

    assert exc.value.code == "no_secret_to_rotate"
    assert db.rotations == []


def test_a_store_that_refused_the_write_is_not_reported_as_a_rotation() -> None:
    db = FakeDb(rotate_raises=RuntimeError("guard trigger refused"))

    with pytest.raises(RotationError) as exc:
        _rotate(db)

    assert exc.value.code == "store_failed"
    assert db.audits == []


def test_a_vanished_subscription_between_read_and_write_is_not_a_silent_success() -> None:
    db = FakeDb(rotate_returns={})

    with pytest.raises(RotationError) as exc:
        _rotate(db)

    assert exc.value.code == "no_secret_to_rotate"


def test_an_audit_failure_never_fails_the_rotation(_hook_update_succeeds) -> None:
    """The rotation already happened; losing its audit row must not undo it."""
    db = FakeDb()
    db.insert_workflow_audit = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))

    result = _rotate(db)

    assert result.provider_synced is True


def test_a_sync_state_write_failure_never_fails_the_rotation(_hook_update_succeeds) -> None:
    db = FakeDb()
    db.set_repository_webhook_provider_secret_synced = lambda *a, **k: (
        _ for _ in ()
    ).throw(RuntimeError("down"))

    result = _rotate(db)

    assert result.provider_synced is True


# --- The provider conversation ----------------------------------------------------------


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_the_hook_update_resends_the_whole_config() -> None:
    """GitHub replaces config on PATCH; omitting the URL would silently detach the hook."""
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["body"] = request.read().decode("utf-8")
        return httpx.Response(200, json={"id": 4242})

    with _client(handler) as http:
        result = update_github_webhook_secret(
            access_token="t",
            owner="octocat",
            repo="hello-world",
            hook_id="4242",
            delivery_url="https://api.example.test/v1/repositories/webhook/github",
            secret="new-secret",
            client=http,
        )

    assert result == {"ok": True}
    assert seen["method"] == "PATCH"
    assert seen["url"] == "https://api.github.com/repos/octocat/hello-world/hooks/4242"
    assert '"url"' in seen["body"]
    assert '"content_type":"json"' in seen["body"]
    assert '"insecure_ssl":"0"' in seen["body"]
    assert '"secret":"new-secret"' in seen["body"]


@pytest.mark.parametrize("status", [403, 404])
def test_a_token_without_the_hook_scope_is_an_honest_message(status) -> None:
    with _client(lambda request: httpx.Response(status, json={})) as http:
        result = update_github_webhook_secret(
            access_token="t",
            owner="octocat",
            repo="hello-world",
            hook_id="4242",
            delivery_url="https://api.example.test/hook",
            secret="s",
            client=http,
        )

    assert result["ok"] is False
    assert "admin:repo_hook" in result["error"]


def test_a_transport_failure_is_a_recorded_state_not_an_exception() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with _client(handler) as http:
        result = update_github_webhook_secret(
            access_token="t",
            owner="octocat",
            repo="hello-world",
            hook_id="4242",
            delivery_url="https://api.example.test/hook",
            secret="s",
            client=http,
        )

    assert result["ok"] is False
    assert "no route to host" in result["error"]


def test_sync_provider_secret_records_its_verdict() -> None:
    db = FakeDb()

    outcome = sync_provider_secret(
        db, _subscription(provider="bitbucket"), secret="s", access_token="t"
    )

    assert outcome["ok"] is False
    assert db.sync_states[-1]["synced"] is False


# --- The projection ---------------------------------------------------------------------


def test_the_projection_reports_the_rotation_without_revealing_a_secret() -> None:
    row = _subscription(
        secret_enc=b"cipher",
        previous_secret_enc=b"old-cipher",
        previous_secret_fingerprint="fedcba9876543210",
        previous_secret_expires_at=_now() + timedelta(hours=24),
        rotated_at=_now(),
        rotation_count=3,
        provider_secret_synced=False,
        rotation_error="GitHub said no",
    )

    projected = describe_subscription(row)

    assert projected["previousSecretFingerprint"] == "fedcba9876543210"
    assert projected["previousSecretExpiresAt"] == (_now() + timedelta(hours=24)).isoformat()
    assert projected["rotationCount"] == 3
    assert projected["providerSecretSynced"] is False
    assert projected["rotationError"] == "GitHub said no"
    assert "cipher" not in repr(projected)
    assert "secretEnc" not in repr(projected)
    assert "previousSecretEnc" not in repr(projected)


def test_an_unrotated_subscription_projects_empty_rotation_facets() -> None:
    projected = describe_subscription(_subscription())

    assert projected["previousSecretFingerprint"] is None
    assert projected["previousSecretExpiresAt"] is None
    assert projected["rotationCount"] == 0
    assert projected["providerSecretSynced"] is True


def test_rotating_over_an_unsynced_rotation_is_allowed_but_never_silent(
    _hook_update_succeeds,
) -> None:
    """A window holds two secrets: the third one displaces a key the provider may still use."""
    db = FakeDb(subscription=_subscription(provider_secret_synced=False, rotation_count=1))

    _rotate(db)

    assert len(db.rotations) == 1
    assert db.audits[0]["detail"]["displacedUnsyncedSecret"] is True


def test_an_ordinary_rotation_carries_no_displacement_warning(_hook_update_succeeds) -> None:
    db = FakeDb()

    _rotate(db)

    assert "displacedUnsyncedSecret" not in db.audits[0]["detail"]
