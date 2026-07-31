"""Delivery → poll dispatch (REPO-4.3, #2781).

The decisions under test are the acceptance criteria of the ticket:

* a push on a *tracked* branch enqueues a poll immediately;
* a PR event optionally enqueues a preview scan against the PR head;
* a signature that does not verify is a rejection **and** an audit row;
* every delivery — accepted, ignored, or rejected — lands in the ledger.

Driven against a fake store rather than Postgres, so each test states one rule and a failure
names that rule. The fake implements exactly the ``Database`` surface the dispatcher calls;
its own contract with the real schema is pinned by ``test_repository_webhook_migration.py``.
"""

import hashlib
import hmac
import json
from typing import Any, Dict, List, Optional

import pytest

from app.repository_webhook_dispatch import (
    OUTCOME_DUPLICATE,
    OUTCOME_ENQUEUED,
    OUTCOME_IGNORED,
    OUTCOME_PREVIEW_SCAN,
    OUTCOME_REJECTED,
    REASON_BRANCH_NOT_TRACKED,
    REASON_NO_SUBSCRIPTION,
    REASON_PR_ACTION_NOT_ACTIONABLE,
    REASON_PR_HEAD_IN_FORK,
    REASON_PR_PREVIEW_DISABLED,
    REASON_REPOSITORY_NOT_POLLABLE,
    REASON_SCAN_IN_FLIGHT,
    REASON_SIGNATURE_INVALID,
    REASON_WEBHOOKS_DISABLED,
    WEBHOOK_ACCEPTED_ACTION,
    WEBHOOK_REJECTED_ACTION,
    WebhookRejectedError,
    ingest_webhook_delivery,
    read_delivery_headers,
)

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_SUB_ID = "990e8400-e29b-41d4-a716-446655440004"
_REPO = "octocat/hello-world"
_SECRET = "signing-secret"


class FakeDb:
    """In-memory stand-in for the ``Database`` surface the dispatcher touches."""

    def __init__(
        self,
        *,
        subscriptions: Optional[List[Dict[str, Any]]] = None,
        tracked_branches: Optional[List[str]] = None,
        scan_in_flight: bool = False,
        pollable: bool = True,
        duplicate_delivery_ids: Optional[List[str]] = None,
    ) -> None:
        self.subscriptions = (
            subscriptions
            if subscriptions is not None
            else [
                {
                    "id": _SUB_ID,
                    "tenant_id": _TENANT,
                    "repository_id": _REPO_ID,
                    "provider": "github",
                    "repo_full_name": _REPO,
                    # Not real ciphertext: resolve_subscription_secret is patched per test.
                    "secret_enc": b"ciphertext",
                    "pr_preview_enabled": True,
                }
            ]
        )
        self.tracked_branches = tracked_branches if tracked_branches is not None else ["main"]
        self.scan_in_flight = scan_in_flight
        self.pollable = pollable
        self.duplicate_delivery_ids = set(duplicate_delivery_ids or [])

        self.events: List[Dict[str, Any]] = []
        self.audits: List[Dict[str, Any]] = []
        self.scan_jobs: List[tuple] = []
        self.polls_due: List[str] = []
        self.touched: List[tuple] = []

    # -- reads ---------------------------------------------------------------------------

    def find_repository_webhook_subscriptions(self, provider, repo_full_name):
        return [
            dict(s)
            for s in self.subscriptions
            if s["provider"] == provider and s["repo_full_name"] == repo_full_name
        ]

    def list_repository_import_spec_branches(self, repository_id):
        return list(self.tracked_branches)

    # -- writes --------------------------------------------------------------------------

    def record_repository_webhook_event(self, **kwargs):
        delivery_id = kwargs.get("delivery_id")
        if delivery_id and delivery_id in self.duplicate_delivery_ids:
            return None  # unique-index collision: a redelivery
        row = {"id": f"evt-{len(self.events)}", **kwargs}
        self.events.append(row)
        return row

    def insert_workflow_audit(self, tenant_id, project_id, version_id, action, outcome, actor, detail):
        self.audits.append(
            {
                "tenant_id": tenant_id,
                "action": action,
                "outcome": outcome,
                "detail": detail,
            }
        )

    def enqueue_repository_file_scan_job_if_idle(self, tenant_id, repository_id, branch):
        if self.scan_in_flight:
            return None
        self.scan_jobs.append((tenant_id, repository_id, branch))
        return f"job-{len(self.scan_jobs)}"

    def mark_repository_poll_due(self, repository_id):
        if not self.pollable:
            return False
        self.polls_due.append(repository_id)
        return True

    def touch_repository_webhook_subscription(self, subscription_id, delivery_id=None):
        self.touched.append((subscription_id, delivery_id))

    # -- helpers -------------------------------------------------------------------------

    def outcomes(self) -> List[str]:
        return [e["outcome"] for e in self.events]


@pytest.fixture(autouse=True)
def _secret_always_recovers(monkeypatch):
    """Decrypt the fake ciphertext to the known secret, so tests exercise verification."""
    monkeypatch.setattr(
        "app.repository_webhook_dispatch.resolve_subscription_secret",
        lambda row: (_SECRET if row.get("secret_enc") else None),
    )


def _body(payload: dict) -> bytes:
    return json.dumps(payload).encode("utf-8")


def _signed(payload: dict, secret: str = _SECRET, delivery_id: str = "d-1") -> tuple:
    body = _body(payload)
    sig = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    headers = {
        "X-GitHub-Event": (
            "pull_request" if "pull_request" in payload else "push"
        ),
        "X-GitHub-Delivery": delivery_id,
        "X-Hub-Signature-256": sig,
    }
    return body, headers


def _push(branch: str = "main", sha: str = "a" * 40) -> dict:
    return {
        "ref": f"refs/heads/{branch}",
        "after": sha,
        "repository": {"full_name": _REPO},
        "head_commit": {"id": sha},
    }


def _pull_request(action: str = "synchronize", head_repo: str = _REPO) -> dict:
    return {
        "action": action,
        "number": 42,
        "repository": {"full_name": _REPO},
        "pull_request": {
            "number": 42,
            "base": {"ref": "main"},
            "head": {"ref": "feature/x", "sha": "c" * 40, "repo": {"full_name": head_repo}},
        },
    }


# --- Delivery headers -------------------------------------------------------------------


def test_delivery_headers_are_read_per_provider() -> None:
    assert read_delivery_headers(
        {"X-GitHub-Event": "push", "X-GitHub-Delivery": "abc"}
    ) == read_delivery_headers({"x-github-event": "push", "x-github-delivery": "abc"})
    gitlab = read_delivery_headers(
        {"X-Gitlab-Event": "Push Hook", "X-Gitlab-Event-UUID": "u-1"}
    )
    assert gitlab.event_type == "Push Hook"
    assert gitlab.delivery_id == "u-1"


def test_a_delivery_with_no_identifying_headers_still_parses() -> None:
    parsed = read_delivery_headers({})
    assert parsed.event_type is None
    assert parsed.delivery_id is None


# --- Acceptance criterion 1: a push on a tracked branch enqueues a poll ------------------


def test_a_push_on_a_tracked_branch_enqueues_a_poll_immediately() -> None:
    db = FakeDb()
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_ENQUEUED
    assert result.jobs_enqueued == 1
    assert result.poll_due is True
    assert db.scan_jobs == [(_TENANT, _REPO_ID, "main")]
    assert db.polls_due == [_REPO_ID]
    assert db.outcomes() == [OUTCOME_ENQUEUED]
    assert db.touched == [(_SUB_ID, "d-1")]


def test_an_accepted_push_is_audited_with_its_lineage() -> None:
    db = FakeDb()
    body, headers = _signed(_push(sha="b" * 40))

    ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    audit = next(a for a in db.audits if a["action"] == WEBHOOK_ACCEPTED_ACTION)
    assert audit["outcome"] == "success"
    assert audit["detail"]["branch"] == "main"
    assert audit["detail"]["headSha"] == "b" * 40
    assert audit["detail"]["pollDue"] is True


def test_a_push_on_an_untracked_branch_enqueues_nothing() -> None:
    """A branch nobody has imported from has nothing to refresh."""
    db = FakeDb(tracked_branches=["main"])
    body, headers = _signed(_push(branch="scratch"))

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_BRANCH_NOT_TRACKED
    assert db.scan_jobs == []
    assert db.polls_due == []
    assert db.outcomes() == [OUTCOME_IGNORED]


def test_a_burst_of_pushes_collapses_onto_the_in_flight_scan() -> None:
    """Ten commits in a minute must not become ten identical walks of one branch."""
    db = FakeDb(scan_in_flight=True)
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_ENQUEUED
    assert result.reason == REASON_SCAN_IN_FLIGHT
    assert result.jobs_enqueued == 0
    # The poll is still made due: the queued walk will observe the newest tip.
    assert db.polls_due == [_REPO_ID]


def test_a_push_to_a_repository_that_cannot_be_polled_is_recorded_not_dropped() -> None:
    """Auto-refresh off or auto-paused, and a scan already running: nothing left to do."""
    db = FakeDb(scan_in_flight=True, pollable=False)
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_REPOSITORY_NOT_POLLABLE
    assert db.outcomes() == [OUTCOME_IGNORED]


def test_a_tag_push_is_accepted_and_inert() -> None:
    db = FakeDb()
    body, headers = _signed(
        {"ref": "refs/tags/v1", "after": "a" * 40, "repository": {"full_name": _REPO}}
    )

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == "not_a_branch"
    assert db.scan_jobs == []


def test_a_ping_is_accepted_and_inert_but_still_proves_the_hook_fires() -> None:
    """`event_count` is how an operator confirms a hook is wired up; a ping is the proof."""
    db = FakeDb()
    body = _body({"zen": "Design for failure.", "repository": {"full_name": _REPO}})
    sig = "sha256=" + hmac.new(_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    headers = {"X-GitHub-Event": "ping", "X-Hub-Signature-256": sig}

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == "unsupported_event"
    assert db.scan_jobs == []
    assert db.touched == [(_SUB_ID, None)]


def test_an_ignored_but_verified_delivery_advances_the_counters() -> None:
    db = FakeDb(tracked_branches=["main"])
    body, headers = _signed(_push(branch="scratch"))

    ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert db.touched == [(_SUB_ID, "d-1")]
    # ...but an ignored delivery caused no re-import, so it is not audited as an acceptance.
    assert [a for a in db.audits if a["action"] == WEBHOOK_ACCEPTED_ACTION] == []


def test_a_rejected_delivery_never_advances_the_counters() -> None:
    """Nothing verified, so nothing about this delivery says the hook is working."""
    db = FakeDb()
    body, headers = _signed(_push(), secret="attacker")

    with pytest.raises(WebhookRejectedError):
        ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert db.touched == []


# --- Acceptance criterion 2: PR events optionally preview-scan the head ------------------


def test_a_pull_request_enqueues_a_scan_of_its_head_branch() -> None:
    db = FakeDb()
    body, headers = _signed(_pull_request())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_PREVIEW_SCAN
    assert result.branch == "feature/x"
    assert db.scan_jobs == [(_TENANT, _REPO_ID, "feature/x")]


def test_a_pull_request_never_makes_the_repository_due_for_refresh() -> None:
    """Indexing a PR head must not feed the sweep — the tenant has not merged it."""
    db = FakeDb()
    body, headers = _signed(_pull_request())

    ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert db.polls_due == []


def test_a_pull_request_records_the_head_sha_it_was_scanned_against() -> None:
    db = FakeDb()
    body, headers = _signed(_pull_request())

    ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert db.events[0]["head_sha"] == "c" * 40
    assert db.events[0]["pr_number"] == 42


def test_a_fork_pull_request_is_skipped_with_a_named_reason() -> None:
    db = FakeDb()
    body, headers = _signed(_pull_request(head_repo="someone/fork"))

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_PR_HEAD_IN_FORK
    assert db.scan_jobs == []


@pytest.mark.parametrize("action", ["closed", "labeled", "assigned", "edited"])
def test_a_pull_request_action_that_moves_no_code_is_skipped(action: str) -> None:
    """``edited`` fires on a title change; none of these is worth walking the tree for."""
    db = FakeDb()
    body, headers = _signed(_pull_request(action=action))

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_PR_ACTION_NOT_ACTIONABLE


@pytest.mark.parametrize("action", ["opened", "reopened", "synchronize", "ready_for_review"])
def test_every_actionable_pull_request_action_scans_the_head(action: str) -> None:
    db = FakeDb()
    body, headers = _signed(_pull_request(action=action))

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_PREVIEW_SCAN


def test_a_pull_request_against_an_untracked_base_branch_is_skipped() -> None:
    db = FakeDb(tracked_branches=["release"])
    body, headers = _signed(_pull_request())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_BRANCH_NOT_TRACKED


def test_a_subscription_can_opt_out_of_pr_previews() -> None:
    db = FakeDb()
    db.subscriptions[0]["pr_preview_enabled"] = False
    body, headers = _signed(_pull_request())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_PR_PREVIEW_DISABLED


def test_the_deployment_can_disable_pr_previews_for_every_subscription(monkeypatch) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "repository_webhook_pr_preview_enabled", False)
    db = FakeDb()
    body, headers = _signed(_pull_request())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_PR_PREVIEW_DISABLED


# --- Acceptance criterion 3: verification failure is 401 + audit -------------------------


def test_an_unsigned_delivery_for_a_registered_repository_is_rejected() -> None:
    db = FakeDb()
    body = _body(_push())

    with pytest.raises(WebhookRejectedError) as exc:
        ingest_webhook_delivery(
            db, provider="github", raw_body=body, headers={"X-GitHub-Event": "push"}
        )

    assert exc.value.code == "signature_invalid"
    assert db.scan_jobs == []
    assert db.polls_due == []


def test_a_wrongly_signed_delivery_is_rejected_and_audited() -> None:
    db = FakeDb()
    body, headers = _signed(_push(), secret="attacker-secret")

    with pytest.raises(WebhookRejectedError):
        ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert db.outcomes() == [OUTCOME_REJECTED]
    assert db.events[0]["reason"] == REASON_SIGNATURE_INVALID
    audit = next(a for a in db.audits if a["action"] == WEBHOOK_REJECTED_ACTION)
    assert audit["outcome"] == "failure"
    assert audit["tenant_id"] == _TENANT
    assert audit["detail"]["reason"] == REASON_SIGNATURE_INVALID


def test_a_tampered_body_does_not_verify_against_its_own_signature() -> None:
    db = FakeDb()
    body, headers = _signed(_push())

    with pytest.raises(WebhookRejectedError):
        ingest_webhook_delivery(
            db, provider="github", raw_body=body + b"\n", headers=headers
        )


def test_a_subscription_whose_secret_cannot_be_recovered_never_verifies(monkeypatch) -> None:
    """A deployment with no encryption key rejects deliveries rather than trusting them."""
    monkeypatch.setattr(
        "app.repository_webhook_dispatch.resolve_subscription_secret", lambda row: None
    )
    db = FakeDb()
    body, headers = _signed(_push())

    with pytest.raises(WebhookRejectedError):
        ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)


def test_the_first_matching_secret_owns_a_delivery_for_a_doubly_registered_repository(
    monkeypatch,
) -> None:
    """Two tenants may register the same repository; the signature decides which one it is."""
    other_tenant = "550e8400-e29b-41d4-a716-4466554400ff"
    db = FakeDb(
        subscriptions=[
            {
                "id": "sub-other",
                "tenant_id": other_tenant,
                "repository_id": "repo-other",
                "provider": "github",
                "repo_full_name": _REPO,
                "secret_enc": b"other",
                "pr_preview_enabled": True,
            },
            {
                "id": _SUB_ID,
                "tenant_id": _TENANT,
                "repository_id": _REPO_ID,
                "provider": "github",
                "repo_full_name": _REPO,
                "secret_enc": b"ours",
                "pr_preview_enabled": True,
            },
        ]
    )
    monkeypatch.setattr(
        "app.repository_webhook_dispatch.resolve_subscription_secret",
        lambda row: (_SECRET if row["secret_enc"] == b"ours" else "different"),
    )
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.repository_id == _REPO_ID
    assert db.scan_jobs == [(_TENANT, _REPO_ID, "main")]


def test_a_rejection_is_recorded_against_every_candidate_tenant() -> None:
    """We cannot tell which of two registrations a forged delivery was aimed at."""
    db = FakeDb(
        subscriptions=[
            {
                "id": "sub-a",
                "tenant_id": _TENANT,
                "repository_id": _REPO_ID,
                "provider": "github",
                "repo_full_name": _REPO,
                "secret_enc": b"a",
                "pr_preview_enabled": True,
            },
            {
                "id": "sub-b",
                "tenant_id": "550e8400-e29b-41d4-a716-4466554400bb",
                "repository_id": "repo-b",
                "provider": "github",
                "repo_full_name": _REPO,
                "secret_enc": b"b",
                "pr_preview_enabled": True,
            },
        ]
    )
    body, headers = _signed(_push(), secret="attacker")

    with pytest.raises(WebhookRejectedError):
        ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert db.outcomes() == [OUTCOME_REJECTED, OUTCOME_REJECTED]
    assert len([a for a in db.audits if a["action"] == WEBHOOK_REJECTED_ACTION]) == 2


def test_an_unregistered_repository_is_ignored_not_rejected() -> None:
    """A 401 here would answer "do you track this repository?" for an unsigned POST."""
    db = FakeDb(subscriptions=[])
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_NO_SUBSCRIPTION
    assert db.outcomes() == [OUTCOME_IGNORED]
    assert db.audits == []  # no tenant to attribute an audit row to


# --- Acceptance criterion 4 support: the ledger records everything -----------------------


def test_a_redelivered_ping_counts_once() -> None:
    """An inert delivery advances the counters, but a redelivery of it must not."""
    db = FakeDb(duplicate_delivery_ids=["d-ping"])
    body = _body({"zen": "Non-blocking is better.", "repository": {"full_name": _REPO}})
    sig = "sha256=" + hmac.new(_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    headers = {
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "d-ping",
        "X-Hub-Signature-256": sig,
    }

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_DUPLICATE
    assert db.touched == []


def test_a_redelivery_is_reported_as_a_duplicate() -> None:
    db = FakeDb(duplicate_delivery_ids=["d-1"])
    body, headers = _signed(_push(), delivery_id="d-1")

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_DUPLICATE
    # The dispatch itself is idempotent, so nothing needs undoing; the counters are not
    # advanced a second time for the same delivery.
    assert db.touched == []


def test_the_global_kill_switch_accepts_and_dispatches_nothing(monkeypatch) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "repository_webhook_enabled", False)
    db = FakeDb()
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_WEBHOOKS_DISABLED
    assert db.scan_jobs == []
    assert db.polls_due == []
    assert db.outcomes() == [OUTCOME_IGNORED]


@pytest.mark.parametrize("raw", [b"not json", b"[]", b'"a string"', b"\xff\xfe"])
def test_an_unusable_body_is_a_value_error_not_an_authentication_failure(raw: bytes) -> None:
    db = FakeDb()
    with pytest.raises(ValueError):
        ingest_webhook_delivery(
            db, provider="github", raw_body=raw, headers={"X-GitHub-Event": "push"}
        )


def test_a_body_naming_no_repository_is_a_value_error() -> None:
    db = FakeDb()
    with pytest.raises(ValueError):
        ingest_webhook_delivery(
            db,
            provider="github",
            raw_body=_body({"ref": "refs/heads/main"}),
            headers={"X-GitHub-Event": "push"},
        )


def test_an_unsupported_provider_is_a_value_error() -> None:
    db = FakeDb()
    with pytest.raises(ValueError):
        ingest_webhook_delivery(
            db, provider="gogs", raw_body=_body(_push()), headers={}
        )


def test_a_ledger_write_failure_never_breaks_the_dispatch() -> None:
    """Recording is evidence, not a gate: losing the row must not lose the poll."""

    class BrokenLedger(FakeDb):
        def record_repository_webhook_event(self, **kwargs):
            raise RuntimeError("ledger down")

    db = BrokenLedger()
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_ENQUEUED
    assert db.scan_jobs == [(_TENANT, _REPO_ID, "main")]


def test_a_subscription_lookup_failure_degrades_to_ignoring_the_delivery() -> None:
    """A store outage must not turn into a 401 storm the provider retries forever."""

    class BrokenLookup(FakeDb):
        def find_repository_webhook_subscriptions(self, provider, repo_full_name):
            raise RuntimeError("store down")

    db = BrokenLookup()
    body, headers = _signed(_push())

    result = ingest_webhook_delivery(db, provider="github", raw_body=body, headers=headers)

    assert result.outcome == OUTCOME_IGNORED
    assert result.reason == REASON_NO_SUBSCRIPTION
