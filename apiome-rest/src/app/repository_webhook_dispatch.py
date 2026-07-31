"""Webhook delivery → poll dispatch (REPO-4.3, #2781).

This is the ingestion path proper: resolve, verify, parse, decide, record. The pure halves
live next door (:mod:`app.repository_webhook_ingest` verifies and parses;
:mod:`app.repository_webhook_subscriptions` owns the secret), so what remains here is the
part that touches the database and the queues.

**What a delivery actually triggers.** Nothing new. A push on a *tracked* branch — one with
a stored RAR-1.2 import spec, because a branch nobody has imported from has nothing to
refresh — does exactly two things:

1. enqueues a branch scan job (:meth:`Database.enqueue_repository_file_scan_job_if_idle`),
   collapsed onto any in-flight scan of the same branch so a ten-commit push is one walk; and
2. clears the repository's cadence anchor (:meth:`Database.mark_repository_poll_due`) so the
   RAR-3.2 refresh sweep picks it up on its next tick rather than at the end of an interval
   measured in minutes or hours.

That is what "enqueue a ``PollJob`` immediately" means against this codebase's model: the
poll is the sweep, and the sweep polls what is due. Routing the trigger through the existing
workers rather than importing inline is what keeps every gate the refresh path already
enforces — the freshness comparator, the divergence guard, per-tenant quotas, the global kill
switch — in force for a webhook-driven refresh exactly as for a scheduled one. A webhook is
an *accelerator on the cadence*, not a second way into the catalog.

Two things a push deliberately cannot do: re-enable a repository whose tenant turned
auto-refresh off, and un-pause a repository the RAR-3.4 backoff auto-paused. Both are
enforced in :meth:`Database.mark_repository_poll_due`.

**Pull requests** are opt-in per subscription and per deployment. When enabled, an actionable
PR event on a tracked base branch enqueues a preview scan of the PR *head* branch, so the
files a review is about are indexed and inspectable before the merge. It only ever indexes:
no import spec targets a PR head, so no scan of one can produce a version. A PR whose head
lives in a fork is recorded and skipped — the head branch does not exist in this repository's
tree, so there is nothing to walk under the repository's own credentials.

**Two secrets during a rotation (REPO-4.7).** A subscription whose secret was rotated recently
holds an outgoing secret as well as a current one, and a delivery signed with either verifies
until the grace window closes. That is not a weakening of the check: both values are secrets
this repository legitimately issued, and the alternative — a hard cutover — makes every
delivery fail between the moment the store is updated and the moment the provider is. Which
generation verified is recorded on the acceptance audit, so "still on the old secret" is
visible while there is time to fix it.

**Failure is loud in the ledger and quiet on the wire.** Every delivery lands in
``apiome.repository_webhook_event``, including the ones that verify against nothing. A
signature that does not verify is a 401 *and* a ``workflow_audit`` row, per the ticket. A
delivery naming a repository nobody here has registered is accepted-and-ignored rather than
401'd: a 401 there would answer "is this repository registered with you?" for anyone willing
to send an unsigned POST, and would make providers retry forever over a question we do not
want to answer.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .repository_webhook_ingest import (
    EVENT_KIND_PULL_REQUEST,
    EVENT_KIND_PUSH,
    PULL_REQUEST_ACTIONS,
    ParsedWebhookEvent,
    WebhookEventError,
    normalize_provider,
    parse_webhook_event,
    repo_full_name_from_payload,
    verify_signature,
)
from .repository_webhook_subscriptions import (
    SECRET_GENERATION_CURRENT,
    resolve_subscription_secrets,
)

_logger = logging.getLogger(__name__)

__all__ = [
    "OUTCOME_ENQUEUED",
    "OUTCOME_PREVIEW_SCAN",
    "OUTCOME_IGNORED",
    "OUTCOME_DUPLICATE",
    "OUTCOME_REJECTED",
    "WEBHOOK_REJECTED_ACTION",
    "WEBHOOK_ACCEPTED_ACTION",
    "DeliveryHeaders",
    "WebhookIngestResult",
    "WebhookRejectedError",
    "read_delivery_headers",
    "ingest_webhook_delivery",
]

#: A scan was queued and the repository was made due for the refresh sweep.
OUTCOME_ENQUEUED = "enqueued"
#: A PR head branch scan was queued (indexing only; no import can follow).
OUTCOME_PREVIEW_SCAN = "preview-scan"
#: Understood and deliberately not acted on.
OUTCOME_IGNORED = "ignored"
#: A redelivery of a delivery id already processed for this subscription.
OUTCOME_DUPLICATE = "duplicate"
#: The signature did not verify — the 401 path.
OUTCOME_REJECTED = "rejected"

#: Workflow-audit actions. Rejection is audited because the ticket requires it; acceptance is
#: audited because "which push caused this re-import" is the question the ledger exists for.
WEBHOOK_REJECTED_ACTION = "repository.webhook.rejected"
WEBHOOK_ACCEPTED_ACTION = "repository.webhook.accepted"

# Stable reason codes recorded alongside an outcome. Codes, not sentences, so the ledger can
# be grouped and alerted on.
REASON_NO_SUBSCRIPTION = "no-subscription"
REASON_SIGNATURE_INVALID = "signature-invalid"
REASON_BRANCH_NOT_TRACKED = "branch-not-tracked"
REASON_PR_PREVIEW_DISABLED = "pr-preview-disabled"
REASON_PR_ACTION_NOT_ACTIONABLE = "pr-action-not-actionable"
REASON_PR_HEAD_IN_FORK = "pr-head-in-fork"
REASON_PR_HEAD_MISSING = "pr-head-missing"
REASON_SCAN_IN_FLIGHT = "scan-in-flight"
REASON_REPOSITORY_NOT_POLLABLE = "repository-not-pollable"
REASON_WEBHOOKS_DISABLED = "webhooks-disabled"
REASON_MALFORMED_PAYLOAD = "malformed-payload"

# Provider event / delivery-id headers, in the order each provider actually sends them.
_EVENT_HEADERS: Tuple[str, ...] = ("X-GitHub-Event", "X-Gitlab-Event", "X-Event-Key")
_DELIVERY_HEADERS: Tuple[str, ...] = (
    "X-GitHub-Delivery",
    "X-Gitlab-Event-UUID",
    "X-Request-UUID",
    "X-Hook-UUID",
)


class WebhookRejectedError(Exception):
    """The delivery did not verify. The routes layer maps this to a 401.

    Attributes:
        code: Stable machine-readable code for the response body and the ledger.
        message: Human-readable detail, deliberately identical for every rejection cause so
            the response cannot be used to distinguish "wrong secret" from "no secret held".
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class DeliveryHeaders:
    """The provider metadata a delivery carries outside its body.

    Attributes:
        event_type: The provider's event name (``push``, ``pull_request``, ``repo:push``, …).
        delivery_id: The provider's delivery identifier — the redelivery idempotency key.
    """

    event_type: Optional[str]
    delivery_id: Optional[str]


@dataclass(frozen=True)
class WebhookIngestResult:
    """What one delivery did.

    Attributes:
        outcome: One of the ``OUTCOME_*`` constants.
        reason: Stable code explaining the outcome, or ``None`` for a plain success.
        jobs_enqueued: Scan jobs actually queued (0 or 1 today).
        repository_id: The repository the delivery drove, when it resolved to one.
        branch: The branch the delivery was about, when parsed.
        poll_due: True when the repository was made due for the refresh sweep.
    """

    outcome: str
    reason: Optional[str] = None
    jobs_enqueued: int = 0
    repository_id: Optional[str] = None
    branch: Optional[str] = None
    poll_due: bool = False


def _first_header(headers: Mapping[str, Any], names: Tuple[str, ...]) -> Optional[str]:
    """Return the first present, non-blank value among ``names`` (case-insensitive)."""
    lowered = {str(k).lower(): v for k, v in headers.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def read_delivery_headers(headers: Mapping[str, Any]) -> DeliveryHeaders:
    """Extract the event name and delivery id from a request's headers.

    Each provider names these differently and none of them is required to be present, so
    both fields are optional and a missing delivery id simply means this delivery gets no
    redelivery idempotency.

    Args:
        headers: The request headers.

    Returns:
        The parsed :class:`DeliveryHeaders`.
    """
    return DeliveryHeaders(
        event_type=_first_header(headers, _EVENT_HEADERS),
        delivery_id=_first_header(headers, _DELIVERY_HEADERS),
    )


def _record(
    db: Any,
    *,
    provider: str,
    outcome: str,
    delivery: DeliveryHeaders,
    subscription: Optional[Mapping[str, Any]] = None,
    event: Optional[ParsedWebhookEvent] = None,
    repo_full_name: Optional[str] = None,
    reason: Optional[str] = None,
    jobs_enqueued: int = 0,
) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Append one ledger row; best-effort, never raises.

    Returns:
        ``(row, stored)``. ``stored`` is False only when the store itself failed — which must
        not be confused with the ``(None, True)`` a redelivery produces when the insert
        collides on the delivery-id unique index. A ledger outage is an evidence problem; a
        collision is a decision.
    """
    try:
        return db.record_repository_webhook_event(
            provider=provider,
            outcome=outcome,
            tenant_id=(str(subscription["tenant_id"]) if subscription else None),
            subscription_id=(str(subscription["id"]) if subscription else None),
            repository_id=(str(subscription["repository_id"]) if subscription else None),
            delivery_id=delivery.delivery_id,
            event_type=delivery.event_type,
            action=(event.action or None) if event else None,
            repo_full_name=(event.repo_full_name if event else repo_full_name),
            branch=(event.branch if event else None),
            head_sha=(event.head_sha or None) if event else None,
            pr_number=(event.pr_number if event else None),
            reason=reason,
            jobs_enqueued=jobs_enqueued,
        ), True
    except Exception:
        _logger.exception(
            "repository webhook ledger write failed provider=%s outcome=%s", provider, outcome
        )
        return None, False


def _audit(
    db: Any,
    *,
    action: str,
    outcome: str,
    tenant_id: Optional[str],
    detail: Dict[str, Any],
) -> None:
    """Write one ``workflow_audit`` row; best-effort, never raises.

    Skipped entirely when there is no tenant to attribute the row to — an unattributable
    audit row would be a row no tenant can ever see. Those deliveries are still visible in
    the webhook ledger, which allows a NULL tenant precisely for this case.
    """
    if not tenant_id:
        return
    try:
        db.insert_workflow_audit(
            tenant_id, None, None, action, outcome, None, detail
        )
    except Exception:
        _logger.exception("repository webhook audit failed action=%s", action)


def _touch(
    db: Any, subscription: Mapping[str, Any], delivery: DeliveryHeaders
) -> None:
    """Advance a verified subscription's delivery counters; best-effort, never raises.

    Called for every delivery that verified, including the inert ones. ``event_count`` and
    ``last_event_at`` answer "is the hook I configured actually firing", and a ping — which
    does nothing else — is the clearest possible evidence that it is.
    """
    try:
        db.touch_repository_webhook_subscription(
            str(subscription["id"]), delivery.delivery_id
        )
    except Exception:
        _logger.exception(
            "repository webhook subscription counters not advanced subscription_id=%s",
            subscription.get("id"),
        )


def _resolve_verified_subscription(
    db: Any,
    *,
    provider: str,
    repo_full_name: str,
    raw_body: bytes,
    headers: Mapping[str, Any],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Find the subscription whose secret verifies this delivery.

    The same repository may be registered by more than one tenant, so every candidate is
    tried and the first whose secret verifies owns the delivery. A candidate whose secret
    cannot be recovered (no encryption key configured, or a corrupt column) never verifies —
    the failure is closed, not permissive.

    Each candidate may offer **two** secrets while a REPO-4.7 rotation grace window is open:
    the current one and the outgoing one. Both are genuine secrets of this repository — the
    provider may not have been updated yet, and a delivery signed before the rotation may
    still be in flight — so accepting either is correct, and which one verified is reported
    back so the acceptance audit can say so.

    Args:
        db: Database handle.
        provider: Normalized provider id.
        repo_full_name: Lowercased ``owner/name`` from the payload.
        raw_body: The exact received bytes, which is what the provider signed.
        headers: The request headers.

    Returns:
        ``(verified_subscription_or_None, all_candidates, secret_generation)``, where the
        generation is ``current`` / ``previous`` for a verified delivery and ``current`` when
        nothing verified (there is no generation to name).
    """
    try:
        candidates = db.find_repository_webhook_subscriptions(provider, repo_full_name)
    except Exception:
        _logger.exception(
            "repository webhook subscription lookup failed repo=%s", repo_full_name
        )
        return None, [], SECRET_GENERATION_CURRENT

    for candidate in candidates or []:
        for secret, generation in resolve_subscription_secrets(candidate):
            if verify_signature(provider, secret, raw_body, headers):
                return dict(candidate), list(candidates), generation
    return None, list(candidates or []), SECRET_GENERATION_CURRENT


def _tracked_branches(db: Any, repository_id: str) -> List[str]:
    """Branches with a stored import spec — the only ones a push can refresh."""
    try:
        return list(db.list_repository_import_spec_branches(repository_id) or [])
    except Exception:
        _logger.exception(
            "repository webhook tracked-branch lookup failed repository_id=%s", repository_id
        )
        return []


def _dispatch_push(
    db: Any, subscription: Mapping[str, Any], event: ParsedWebhookEvent
) -> WebhookIngestResult:
    """Enqueue the poll for a verified push on a tracked branch."""
    repository_id = str(subscription["repository_id"])
    tenant_id = str(subscription["tenant_id"])

    if event.branch not in _tracked_branches(db, repository_id):
        # Nothing has ever been imported from this branch, so there is nothing to refresh.
        return WebhookIngestResult(
            outcome=OUTCOME_IGNORED,
            reason=REASON_BRANCH_NOT_TRACKED,
            repository_id=repository_id,
            branch=event.branch,
        )

    job_id: Optional[str] = None
    try:
        job_id = db.enqueue_repository_file_scan_job_if_idle(
            tenant_id, repository_id, event.branch
        )
    except Exception:
        _logger.exception(
            "repository webhook scan enqueue failed repository_id=%s branch=%s",
            repository_id,
            event.branch,
        )

    poll_due = False
    try:
        poll_due = bool(db.mark_repository_poll_due(repository_id))
    except Exception:
        _logger.exception(
            "repository webhook poll-due update failed repository_id=%s", repository_id
        )

    if not poll_due and job_id is None:
        # Neither half took effect: the repository has auto-refresh off or is auto-paused,
        # and a scan of this branch was already in flight. Recorded, not silently dropped.
        return WebhookIngestResult(
            outcome=OUTCOME_IGNORED,
            reason=REASON_REPOSITORY_NOT_POLLABLE,
            repository_id=repository_id,
            branch=event.branch,
        )

    return WebhookIngestResult(
        outcome=OUTCOME_ENQUEUED,
        reason=(REASON_SCAN_IN_FLIGHT if job_id is None else None),
        jobs_enqueued=(1 if job_id else 0),
        repository_id=repository_id,
        branch=event.branch,
        poll_due=poll_due,
    )


def _dispatch_pull_request(
    db: Any, subscription: Mapping[str, Any], event: ParsedWebhookEvent
) -> WebhookIngestResult:
    """Enqueue a preview scan of a pull request's head branch, when permitted."""
    from .config import settings

    repository_id = str(subscription["repository_id"])
    tenant_id = str(subscription["tenant_id"])

    def ignored(reason: str) -> WebhookIngestResult:
        return WebhookIngestResult(
            outcome=OUTCOME_IGNORED,
            reason=reason,
            repository_id=repository_id,
            branch=event.branch,
        )

    if not settings.repository_webhook_pr_preview_enabled or not subscription.get(
        "pr_preview_enabled", True
    ):
        return ignored(REASON_PR_PREVIEW_DISABLED)
    if event.action and event.action not in PULL_REQUEST_ACTIONS:
        # A closed / labelled / assigned PR moves no code.
        return ignored(REASON_PR_ACTION_NOT_ACTIONABLE)
    if event.branch not in _tracked_branches(db, repository_id):
        return ignored(REASON_BRANCH_NOT_TRACKED)
    if not event.pr_head_in_repo:
        # A fork's branch does not exist in this repository's tree, so the walker — which
        # addresses branches by name under this repository's credentials — cannot reach it.
        return ignored(REASON_PR_HEAD_IN_FORK)
    if not event.pr_head_branch:
        return ignored(REASON_PR_HEAD_MISSING)

    job_id: Optional[str] = None
    try:
        job_id = db.enqueue_repository_file_scan_job_if_idle(
            tenant_id, repository_id, event.pr_head_branch
        )
    except Exception:
        _logger.exception(
            "repository webhook PR preview scan enqueue failed repository_id=%s branch=%s",
            repository_id,
            event.pr_head_branch,
        )

    # Deliberately no mark_repository_poll_due: indexing a PR head must never feed the
    # refresh sweep, which would re-import a branch the tenant has not merged.
    return WebhookIngestResult(
        outcome=OUTCOME_PREVIEW_SCAN,
        reason=(REASON_SCAN_IN_FLIGHT if job_id is None else None),
        jobs_enqueued=(1 if job_id else 0),
        repository_id=repository_id,
        branch=event.pr_head_branch,
    )


def ingest_webhook_delivery(
    db: Any, *, provider: str, raw_body: bytes, headers: Mapping[str, Any]
) -> WebhookIngestResult:
    """Verify, parse and dispatch one provider webhook delivery (REPO-4.3).

    Args:
        db: Database handle.
        provider: The provider id from the URL path.
        raw_body: The exact bytes of the received request body — the provider signed these,
            so verification must not see a re-serialisation.
        headers: The request headers.

    Returns:
        A :class:`WebhookIngestResult` describing what the delivery did. Every return path
        has already written its ledger row.

    Raises:
        WebhookRejectedError: When the signature does not verify. The routes layer maps this to a
            401; the ledger row and the audit row are written before it is raised.
        ValueError: When the body is not a JSON object, or names no repository — a 400, not
            an authentication failure.
    """
    from .config import settings

    key = normalize_provider(provider)
    if not key:
        raise ValueError(f"provider {provider!r} is not supported")

    delivery = read_delivery_headers(headers)

    if not settings.repository_webhook_enabled:
        # Global kill switch: accept the delivery so the provider stops retrying, do nothing,
        # and leave a ledger row saying so. Verification is skipped because there is nothing
        # to protect — no work is dispatched on this path.
        _record(
            db,
            provider=key,
            outcome=OUTCOME_IGNORED,
            delivery=delivery,
            reason=REASON_WEBHOOKS_DISABLED,
        )
        return WebhookIngestResult(
            outcome=OUTCOME_IGNORED, reason=REASON_WEBHOOKS_DISABLED
        )

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("body is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("body is not a JSON object")

    repo_full_name = repo_full_name_from_payload(key, payload)
    if not repo_full_name:
        raise ValueError("delivery does not name a repository")

    subscription, candidates, secret_generation = _resolve_verified_subscription(
        db,
        provider=key,
        repo_full_name=repo_full_name,
        raw_body=raw_body,
        headers=headers,
    )

    if subscription is None:
        if not candidates:
            # Not registered here. Accepted-and-ignored rather than 401'd, so the endpoint is
            # not an oracle for "which repositories does this deployment track".
            _record(
                db,
                provider=key,
                outcome=OUTCOME_IGNORED,
                delivery=delivery,
                repo_full_name=repo_full_name,
                reason=REASON_NO_SUBSCRIPTION,
            )
            return WebhookIngestResult(
                outcome=OUTCOME_IGNORED, reason=REASON_NO_SUBSCRIPTION
            )

        # Registered, but nothing verified: the ticket's 401 path. Recorded against every
        # candidate tenant, since we cannot tell which one the sender was aiming at.
        for candidate in candidates:
            _record(
                db,
                provider=key,
                outcome=OUTCOME_REJECTED,
                delivery=delivery,
                subscription=candidate,
                repo_full_name=repo_full_name,
                reason=REASON_SIGNATURE_INVALID,
            )
            _audit(
                db,
                action=WEBHOOK_REJECTED_ACTION,
                outcome="failure",
                tenant_id=str(candidate.get("tenant_id") or ""),
                detail={
                    "repositoryId": str(candidate.get("repository_id") or ""),
                    "provider": key,
                    "repositoryFullName": repo_full_name,
                    "eventType": delivery.event_type,
                    "deliveryId": delivery.delivery_id,
                    "reason": REASON_SIGNATURE_INVALID,
                },
            )
        raise WebhookRejectedError(
            "signature_invalid",
            "The delivery signature did not verify for this repository.",
        )

    if secret_generation != SECRET_GENERATION_CURRENT:
        # Logged as well as audited: an ignored delivery writes no audit row, and "the
        # provider is still on the old secret" is worth knowing before the window closes even
        # when the delivery itself did nothing.
        _logger.info(
            "repository webhook delivery verified with the outgoing secret repository_id=%s "
            "provider=%s — the provider hook has not been updated since the last rotation",
            subscription.get("repository_id"),
            key,
        )

    try:
        event = parse_webhook_event(key, delivery.event_type, payload)
    except WebhookEventError as exc:
        # A ping, a tag push, a closed-branch delivery: understood, and deliberately inert.
        # The counters still advance — a delivery that verified is proof the hook is wired
        # up, which is exactly what an operator staring at a ping is trying to confirm — but
        # only for a delivery the ledger actually accepted, so a redelivered ping counts once.
        row, stored = _record(
            db,
            provider=key,
            outcome=OUTCOME_IGNORED,
            delivery=delivery,
            subscription=subscription,
            repo_full_name=repo_full_name,
            reason=exc.code,
        )
        if stored and row is None and delivery.delivery_id:
            return WebhookIngestResult(
                outcome=OUTCOME_DUPLICATE,
                repository_id=str(subscription["repository_id"]),
            )
        _touch(db, subscription, delivery)
        return WebhookIngestResult(
            outcome=OUTCOME_IGNORED,
            reason=exc.code,
            repository_id=str(subscription["repository_id"]),
        )

    if event.kind == EVENT_KIND_PUSH:
        result = _dispatch_push(db, subscription, event)
    elif event.kind == EVENT_KIND_PULL_REQUEST:
        result = _dispatch_pull_request(db, subscription, event)
    else:  # pragma: no cover - parse_webhook_event only produces the two kinds above
        result = WebhookIngestResult(
            outcome=OUTCOME_IGNORED,
            reason=REASON_MALFORMED_PAYLOAD,
            repository_id=str(subscription["repository_id"]),
        )

    row, stored = _record(
        db,
        provider=key,
        outcome=result.outcome,
        delivery=delivery,
        subscription=subscription,
        event=event,
        reason=result.reason,
        jobs_enqueued=result.jobs_enqueued,
    )
    if stored and row is None and delivery.delivery_id:
        # The ledger refused the insert on the delivery-id unique index: this is a
        # redelivery. The dispatch above is idempotent by construction — the scan job
        # collapses onto the in-flight one and "make due" is a set, not an increment — so
        # nothing needs undoing; the caller is simply told it was a duplicate.
        return WebhookIngestResult(
            outcome=OUTCOME_DUPLICATE,
            reason=None,
            repository_id=result.repository_id,
            branch=result.branch,
        )

    # Any delivery that got this far verified, so it counts towards "the hook is firing"
    # whether or not it turned into work. Only the *accepted* ones are audited, because the
    # audit answers "which push caused this re-import" and an ignored delivery caused none.
    _touch(db, subscription, delivery)

    if result.outcome in (OUTCOME_ENQUEUED, OUTCOME_PREVIEW_SCAN):
        _audit(
            db,
            action=WEBHOOK_ACCEPTED_ACTION,
            outcome="success",
            tenant_id=str(subscription.get("tenant_id") or ""),
            detail={
                "repositoryId": str(subscription.get("repository_id") or ""),
                "provider": key,
                "repositoryFullName": repo_full_name,
                "eventType": delivery.event_type,
                "deliveryId": delivery.delivery_id,
                "branch": result.branch,
                "headSha": event.head_sha or None,
                "prNumber": event.pr_number,
                "outcome": result.outcome,
                "jobsEnqueued": result.jobs_enqueued,
                "pollDue": result.poll_due,
                # Which of the subscription's two secrets verified this delivery (REPO-4.7).
                # `previous` means the provider is still signing with the outgoing secret and
                # this delivery only worked because the grace window is open — the audit trail
                # says so while there is still time to do something about it.
                "secretGeneration": secret_generation,
            },
        )

    return result
