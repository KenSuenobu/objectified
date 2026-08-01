"""Repository auto-refresh sweep — enqueue stale files (RAR-3.2, #3523).

RAR-3.1 made the refresh cadence configurable and gave the sweep its due-selection
primitives (``list_due_repositories`` / ``mark_repository_refreshed``). This module
is the sweep itself: the worker that ties freshness gating and the stored import
spec into a periodic enqueue. Per the roadmap
(``docs/ROADMAP_REPOSITORY_AUTOREFRESH.md``), for each *due* repository it:

1. takes a per-repo advisory lock so two ticks / workers never overlap on one repo
   (single-flight);
2. rescans the branches that have a stored import spec, reusing the REPO-2 walker
   (:func:`repository_file_scan.scan_repository_branch_into_index`);
3. computes the stale + newer files via the RAR-2.2 newer-than comparator
   (:func:`repository_refresh_comparator.evaluate_refresh`) — a file is a candidate
   exactly when it is ``stale`` (RAR-2.3);
4. loads each stale file's stored spec (RAR-1.5) and enqueues a self-contained,
   spec-faithful re-import job for the EPIC-4 executor (RAR-4.1); and
5. advances ``last_refreshed_at`` for the repo each tick.

The freshness gate here runs on the branch-tip ``committed_at`` and the file
``blob_sha`` — the signals the rescan captures. The finer REPO-8.3 content-checksum
idempotency (RAR-2.4) needs the file *content*, which only the EPIC-4 executor
downloads, so it is applied there; this sweep deliberately enqueues on the
blob-level newer-than verdict and lets the executor suppress no-op churn.

``last_refreshed_at`` is advanced for every processed repo, success or failure, so
a repository that errors on the GitHub walk does not stay perpetually "due" and
hammer the provider every tick.

Backoff + auto-pause (RAR-3.4, #3525, extending REPO-4.5): each tick additionally
records the repo's outcome. A failed tick (any branch rescan error) increments the
repo's consecutive-failure counter and defers it exponentially
(``refresh_backoff_until``); after ``APIOME_REFRESH_AUTO_PAUSE_THRESHOLD``
consecutive failures the repo auto-pauses (excluded from due-selection until a
manual resume) and a RAR-5.4 notification fires exactly once, on the transition.
A successful tick resets the counter so recovered repos return to their normal
cadence. All of this bookkeeping is best-effort: a failure recording problem never
aborts the sweep.

Per-tenant quotas + fairness (REPO-4.6 #2784, RAR-3.5 #3526): the sweep
round-robins the due list across tenants (one repo per tenant per round, via
:func:`repository_refresh_quota.interleave_due_rows_by_tenant`) and bounds the
poll (refresh) jobs each tenant may enqueue per rolling window. The bound is
persisted per tenant on ``apiome.tenants.repository_polls_per_hour`` (default
60, elevated/enterprise 600, ``0`` = unlimited), with
``APIOME_REFRESH_TENANT_QUOTA`` as the deployment fallback and kill switch and
``APIOME_REFRESH_TENANT_QUOTA_WINDOW`` as the window length. A tenant over its
quota has its remaining due repos *deferred*: skipped without advancing the
cadence anchor and without counting as a failure, so they stay due and are
picked up once the window rolls. Every dispatch and deferral is counted in
:mod:`app.repository_polling_telemetry` for the REPO-7.3 dashboard. Manual
"Refresh Now" (RAR-5.2) bypasses the sweep and is never quota-limited.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, NamedTuple, Optional

from .database import Database
from .repository_file_scan import scan_repository_branch_into_index
from .repository_refresh_comparator import evaluate_refresh

_logger = logging.getLogger(__name__)


class BranchEnqueueResult(NamedTuple):
    """Outcome of a single-branch rescan + enqueue pass.

    Attributes:
        enqueued: Number of refresh jobs actually inserted.
        skipped: Candidates considered but not enqueued — either not newer than
            the last import (RAR-2.2 freshness gate) or already covered by an
            active (queued/running) job for the same lineage (idempotent no-op).
        deferred: Stale + newer candidates that were *not* enqueued because the
            caller's ``max_enqueues`` budget ran out (RAR-3.5 tenant quota).
            They remain stale, so a later tick re-evaluates and enqueues them
            once the tenant's quota window rolls. Always 0 on the unlimited
            (manual "Refresh Now") path.
    """

    enqueued: int
    skipped: int
    deferred: int = 0


def enqueue_stale_files_for_branch(
    db: Database,
    repo_row: Dict[str, Any],
    branch: str,
    *,
    path_filter: Optional[str] = None,
    max_enqueues: Optional[int] = None,
) -> BranchEnqueueResult:
    """Rescan one branch and enqueue a re-import job per stale + newer file.

    This is the shared core used by both the periodic auto-refresh sweep
    (:func:`process_repository_refresh_sweep`) and the manual one-shot
    "Refresh Now" path (RAR-5.2, ``repository_manual_refresh``). It always applies
    the RAR-2.2 newer-than freshness gate, so a file is enqueued only when its
    remote commit is genuinely newer than the last import; the divergence guard
    (RAR-4.4) is applied later by the EPIC-4 executor when it processes the job.

    Args:
        db: Database handle.
        repo_row: The repository row (from ``get_tenant_repository``).
        branch: The branch to rescan and evaluate.
        path_filter: When set, only the file at this repository-relative path is
            considered (the rest of the branch's candidates are ignored). Used by
            per-file "Refresh Now"; ``None`` evaluates every candidate on the
            branch.
        max_enqueues: When set, at most this many jobs are inserted; further
            stale + newer candidates are counted as ``deferred`` instead
            (REPO-4.6 per-tenant polling quota). ``None`` (the manual-refresh
            default, and the value used for an unlimited tenant) applies no
            bound.

    Returns:
        A :class:`BranchEnqueueResult` with the enqueued, skipped, and deferred
        counts.
    """
    repository_id = str(repo_row["id"])
    tenant_id = str(repo_row["tenant_id"])

    # Reindex the branch so the candidate query sees current remote signals. On a
    # large monorepo the walk is bounded (REPO-2.5): a pass that runs out of its
    # wall-clock budget stores a resume cursor and comes back incomplete, so this
    # tick evaluates the portion indexed so far and the next tick continues.
    scan = scan_repository_branch_into_index(db, repo_row, branch)
    if not scan.completed:
        _logger.info(
            "repository refresh evaluating a partially indexed branch (scan resumes next tick) "
            "repository_id=%s branch=%s files_so_far=%s",
            repository_id,
            branch,
            scan.total_files,
        )

    enqueued = 0
    skipped = 0
    deferred = 0
    for cand in db.list_repository_refresh_candidates(repository_id, branch):
        if path_filter is not None and str(cand.get("path")) != path_filter:
            continue

        decision = evaluate_refresh(
            remote_committed_at=cand.get("remote_committed_at"),
            last_imported_committed_at=cand.get("last_imported_committed_at"),
            remote_checksum=cand.get("remote_blob_sha"),
            last_imported_checksum=cand.get("last_imported_blob_sha"),
        )
        if not decision.should_refresh:
            # Up-to-date / stale-guarded: honors the freshness gate (RAR-2.2).
            skipped += 1
            continue

        if max_enqueues is not None and enqueued >= max_enqueues:
            # Tenant quota budget spent (REPO-4.6): the candidate stays stale
            # and a later tick enqueues it once the window rolls.
            deferred += 1
            continue

        job = db.enqueue_repository_refresh_job(
            tenant_id=tenant_id,
            repository_id=repository_id,
            branch=branch,
            path=str(cand["path"]),
            import_spec_id=cand.get("import_spec_id"),
            project_id=cand.get("project_id"),
            source_kind=cand.get("source_kind"),
            format_override=cand.get("format_override"),
            content_type=cand.get("content_type"),
            options_json=cand.get("options_json"),
            spec_schema_version=int(cand.get("spec_schema_version") or 1),
            created_by=cand.get("created_by"),
            remote_commit_sha=cand.get("remote_commit_sha"),
            remote_committed_at=cand.get("remote_committed_at"),
            remote_blob_sha=cand.get("remote_blob_sha"),
            refresh_reason=decision.reason.value,
        )
        if job is not None:
            enqueued += 1
        else:
            # Active job already exists for this lineage (idempotent no-op).
            skipped += 1
    return BranchEnqueueResult(enqueued=enqueued, skipped=skipped, deferred=deferred)


class RepositoryRefreshResult(NamedTuple):
    """Outcome of one repository's rescan + enqueue tick.

    Attributes:
        enqueued: Number of refresh jobs inserted across the repo's spec branches.
        failed: True when at least one branch rescan raised — the tick counts as a
            failed refresh for the RAR-3.4 backoff/auto-pause bookkeeping.
        error: A short diagnostic from the last branch failure (pause reason).
        deferred: Stale + newer files not enqueued because the tenant's quota
            budget ran out mid-repo (REPO-4.6). Deferral is a scheduling
            decision, never a failure: the files stay stale and a later tick
            enqueues them once the quota window rolls.
    """

    enqueued: int
    failed: bool
    error: Optional[str]
    deferred: int = 0


def _refresh_one_repository(
    db: Database,
    due_row: Dict[str, Any],
    *,
    max_enqueues: Optional[int] = None,
) -> RepositoryRefreshResult:
    """Rescan + enqueue for a single due repository (already holding its lock).

    Args:
        db: Database handle.
        due_row: A row from ``list_due_repositories``.
        max_enqueues: Remaining tenant quota budget for this repo's tick
            (REPO-4.6); at most this many jobs are enqueued across all branches,
            further stale files are deferred. ``None`` applies no bound (an
            unlimited tenant, or quotas disabled deployment-wide).

    Returns:
        A :class:`RepositoryRefreshResult` with the enqueued / deferred counts
        and whether any branch rescan failed (feeding the RAR-3.4 failure
        bookkeeping).
    """
    repository_id = str(due_row["id"])
    tenant_id = str(due_row["tenant_id"])

    branches = db.list_repository_import_spec_branches(repository_id)
    if not branches:
        # No captured spec for any branch -> nothing to refresh; skip the GitHub
        # walk entirely. The anchor still advances (caller's finally block).
        return RepositoryRefreshResult(enqueued=0, failed=False, error=None)

    # The due row lacks created_by (needed for private-repo token resolution);
    # fetch the full row.
    repo_row = db.get_tenant_repository(tenant_id, repository_id)
    if not repo_row:
        return RepositoryRefreshResult(enqueued=0, failed=False, error=None)

    enqueued = 0
    deferred = 0
    failed = False
    last_error: Optional[str] = None
    for branch in branches:
        remaining: Optional[int] = None
        if max_enqueues is not None:
            remaining = max(0, max_enqueues - enqueued)
            if remaining == 0:
                # Budget spent on the earlier branches: walking further
                # branches could only defer more files, and avoiding the
                # provider calls is the whole point of the quota (REPO-4.6).
                # Any stale files there remain stale, so a later tick finishes
                # the job once the tenant's window rolls.
                _logger.info(
                    "repository refresh skipping remaining branches "
                    "(tenant quota spent, REPO-4.6) repository_id=%s branch=%s",
                    repository_id,
                    branch,
                )
                break
        try:
            result = enqueue_stale_files_for_branch(
                db, repo_row, branch, max_enqueues=remaining
            )
            enqueued += result.enqueued
            deferred += result.deferred
        except Exception as exc:
            # One bad branch (GitHub error, etc.) must not abort the others, but it
            # does make this tick count as a failed refresh (RAR-3.4).
            failed = True
            last_error = f"branch {branch}: {exc}"
            _logger.exception(
                "repository refresh rescan failed repository_id=%s branch=%s",
                repository_id,
                branch,
            )
    return RepositoryRefreshResult(
        enqueued=enqueued, failed=failed, error=last_error, deferred=deferred
    )


def _record_poll_telemetry(
    quota: Any, due_row: Dict[str, Any], result: RepositoryRefreshResult
) -> None:
    """Count one polled repository for the REPO-4.6 / REPO-7.3 dashboard.

    Emits a ``poll_dispatched`` event for the poll itself and, when the tenant's
    budget ran out part-way through the repo, a ``files_deferred`` event for the
    stale files left unenqueued.

    Best-effort by contract, like the RAR-3.4 bookkeeping beside it: a counter
    problem is logged and swallowed. Telemetry must never be able to turn a
    healthy poll into a recorded refresh failure.

    Args:
        quota: The tick's :class:`repository_refresh_quota.TenantRefreshQuotaTracker`,
            or None when quotas are disabled for this tick.
        due_row: The repository's row from ``list_due_repositories``.
        result: The tick outcome from :func:`_refresh_one_repository`.
    """
    from .repository_polling_telemetry import (
        KIND_FILES_DEFERRED,
        KIND_POLL_DISPATCHED,
        polling_telemetry,
    )

    tenant_id = str(due_row["tenant_id"])
    repository_id = str(due_row["id"])
    tenant_quota = quota.quota_for(tenant_id) if quota is not None else None

    try:
        polling_telemetry.record(
            KIND_POLL_DISPATCHED,
            tenant_id=tenant_id,
            repository_id=repository_id,
            quota=tenant_quota,
            remaining=quota.remaining(tenant_id) if quota is not None else None,
            jobs=result.enqueued,
        )
        if result.deferred:
            # Budget ran out part-way through this repo: the stale files stay
            # stale (never a failure) and a later tick enqueues them.
            polling_telemetry.record(
                KIND_FILES_DEFERRED,
                tenant_id=tenant_id,
                repository_id=repository_id,
                quota=tenant_quota,
                remaining=0,
                jobs=result.deferred,
            )
    except Exception:
        _logger.exception(
            "repository polling telemetry failed repository_id=%s", repository_id
        )


def _record_refresh_outcome(
    db: Database, due_row: Dict[str, Any], result: RepositoryRefreshResult
) -> None:
    """Record one repo tick's outcome for the RAR-3.4 backoff/auto-pause policy.

    On failure, increments the consecutive-failure counter, stamps the exponential
    backoff anchor, and — exactly once, on the transition into the auto-pause —
    fires the RAR-5.4 ``repository.refresh.auto_paused`` notification. On success,
    resets the counter so the repo returns to its normal cadence (skipped when the
    counter is already 0, saving a write for the common healthy case).

    Best-effort by contract: any bookkeeping or notification error is logged and
    swallowed so it can never abort the sweep tick.

    Args:
        db: Database handle.
        due_row: The repository's row from ``list_due_repositories``.
        result: The tick outcome from :func:`_refresh_one_repository`.
    """
    from .config import settings

    repository_id = str(due_row["id"])
    try:
        if not result.failed:
            if int(due_row.get("refresh_consecutive_failures") or 0) > 0:
                db.record_repository_refresh_success(repository_id)
            return

        outcome = db.record_repository_refresh_failure(
            repository_id, error=result.error
        )
        if not outcome:
            return
        _logger.warning(
            "repository refresh failure recorded repository_id=%s "
            "consecutive_failures=%s backoff_seconds=%s paused=%s",
            repository_id,
            outcome.get("consecutive_failures"),
            outcome.get("backoff_seconds"),
            outcome.get("paused"),
        )
        if outcome.get("newly_paused"):
            from .repository_refresh_notifications import notify_refresh_auto_paused

            notify_refresh_auto_paused(
                db,
                tenant_id=str(due_row["tenant_id"]),
                repository_id=repository_id,
                repository_full_name=due_row.get("repository_full_name"),
                consecutive_failures=int(outcome.get("consecutive_failures") or 0),
                threshold=settings.refresh_auto_pause_threshold,
                error=result.error,
            )
    except Exception:
        _logger.exception(
            "repository refresh outcome bookkeeping failed repository_id=%s",
            repository_id,
        )


def process_repository_refresh_sweep(db: Database) -> int:
    """Run one auto-refresh sweep tick over all due repositories (RAR-3.2).

    Iterates the repositories due for a refresh (RAR-3.1 cadence), serializing each
    behind a per-repo advisory lock, rescanning its spec branches, and enqueuing a
    spec-faithful re-import for every stale + newer file. ``last_refreshed_at`` is
    advanced for each repository whose lock was acquired — even when its rescan
    fails — so the cadence keeps moving and a broken repo cannot monopolize the
    sweep.

    The global ``APIOME_REFRESH_ENABLED`` kill switch (RAR-3.3) short-circuits
    the whole tick: when it is disabled the sweep halts immediately without touching
    any repository (no rescan, no enqueue, no anchor advance), so operators can stop
    all auto-refresh for incident response. The per-repo ``auto_refresh_enabled``
    opt-out is enforced earlier, in ``list_due_repositories``. Neither gate affects
    manual "Refresh Now" (RAR-5.2), which does not run through this sweep.

    Each repo tick's outcome also feeds the RAR-3.4 backoff/auto-pause bookkeeping
    (:func:`_record_refresh_outcome`): failures back the repo off exponentially and
    can auto-pause it (with a one-time RAR-5.4 notification); a success resets the
    failure counter. Paused / backed-off repos are excluded by
    ``list_due_repositories`` until resumed / due again.

    Per-tenant quotas + fairness (REPO-4.6): the due list is round-robin
    interleaved across tenants so one tenant's backlog cannot occupy the head
    of every tick, and each tenant's poll (refresh) jobs are bounded per rolling
    window by its persisted ``apiome.tenants.repository_polls_per_hour``
    (``APIOME_REFRESH_TENANT_QUOTA`` is the fallback and the deployment-wide
    kill switch; ``APIOME_REFRESH_TENANT_QUOTA_WINDOW`` sets the window). A repo
    whose tenant is over quota is *deferred*: skipped before its lock is taken,
    without advancing its cadence anchor and without touching the RAR-3.4
    failure bookkeeping, so it stays due and a later tick picks it up once the
    window rolls. The quota is best-effort protective: if the window usage
    cannot be read the tick proceeds unlimited rather than halting refresh.

    Every dispatch and deferral is recorded in
    :mod:`app.repository_polling_telemetry` — the counters REPO-7.3 renders —
    so quota pressure is visible without reading sweep logs line by line.

    Args:
        db: Database handle for this tick (one connection holds the advisory
            locks; the caller uses a dedicated ``Database`` per tick).

    Returns:
        The total number of refresh jobs enqueued this tick (0 when the global
        kill switch is disabled).
    """
    from .config import settings

    if not settings.refresh_enabled:
        # Global kill switch (RAR-3.3): halt all auto-refresh for this tick.
        _logger.info(
            "repository refresh sweep halted: APIOME_REFRESH_ENABLED is disabled"
        )
        return 0

    from .repository_polling_telemetry import (
        KIND_REPOSITORY_DEFERRED,
        polling_telemetry,
    )
    from .repository_refresh_quota import (
        interleave_due_rows_by_tenant,
        load_tenant_refresh_quota_tracker,
    )

    quota = load_tenant_refresh_quota_tracker(db)

    enqueued_total = 0
    for due_row in interleave_due_rows_by_tenant(db.list_due_repositories()):
        repository_id = str(due_row["id"])
        tenant_id = str(due_row["tenant_id"])

        if quota is not None and quota.is_exhausted(tenant_id):
            # Tenant over its polling quota (REPO-4.6): defer this repo — no
            # lock, no anchor advance, no failure bookkeeping — so it stays due
            # and is retried once the window rolls. The telemetry record carries
            # the structured log line, so the deferral is visible per repo
            # without a second hand-rolled log statement. Counting is
            # best-effort: a telemetry problem must not change what the sweep
            # does with the repository.
            try:
                polling_telemetry.record(
                    KIND_REPOSITORY_DEFERRED,
                    tenant_id=tenant_id,
                    repository_id=repository_id,
                    quota=quota.quota_for(tenant_id),
                    remaining=0,
                )
            except Exception:
                _logger.exception(
                    "repository polling telemetry failed repository_id=%s",
                    repository_id,
                )
            continue

        if not db.try_acquire_repository_refresh_lock(repository_id):
            # Another worker / overlapping tick owns this repo right now.
            _logger.debug(
                "repository refresh skipped (lock held) repository_id=%s",
                repository_id,
            )
            continue

        try:
            result = _refresh_one_repository(
                db,
                due_row,
                max_enqueues=(
                    quota.remaining(tenant_id) if quota is not None else None
                ),
            )
            enqueued_total += result.enqueued
            if quota is not None:
                quota.consume(tenant_id, result.enqueued)
            _record_poll_telemetry(quota, due_row, result)
        except Exception as exc:
            # A repo-level error (candidate query, branch listing, …) counts as a
            # failed tick for the RAR-3.4 bookkeeping, like a branch rescan error.
            result = RepositoryRefreshResult(enqueued=0, failed=True, error=str(exc))
            _logger.exception(
                "repository refresh sweep failed repository_id=%s", repository_id
            )
        try:
            _record_refresh_outcome(db, due_row, result)
        finally:
            # Advance the cadence anchor each tick (success or failure) so the repo
            # is not immediately due again, then release the lock.
            try:
                db.mark_repository_refreshed(repository_id)
            except Exception:
                _logger.exception(
                    "repository refresh anchor advance failed repository_id=%s",
                    repository_id,
                )
            db.release_repository_refresh_lock(repository_id)

    return enqueued_total
