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
    """

    enqueued: int
    skipped: int


def enqueue_stale_files_for_branch(
    db: Database,
    repo_row: Dict[str, Any],
    branch: str,
    *,
    path_filter: Optional[str] = None,
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

    Returns:
        A :class:`BranchEnqueueResult` with the enqueued and skipped counts.
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
    return BranchEnqueueResult(enqueued=enqueued, skipped=skipped)


def _refresh_one_repository(db: Database, due_row: Dict[str, Any]) -> int:
    """Rescan + enqueue for a single due repository (already holding its lock).

    Args:
        db: Database handle.
        due_row: A row from ``list_due_repositories``.

    Returns:
        The number of refresh jobs enqueued across the repo's spec branches.
    """
    repository_id = str(due_row["id"])
    tenant_id = str(due_row["tenant_id"])

    branches = db.list_repository_import_spec_branches(repository_id)
    if not branches:
        # No captured spec for any branch -> nothing to refresh; skip the GitHub
        # walk entirely. The anchor still advances (caller's finally block).
        return 0

    # The due row lacks created_by (needed for private-repo token resolution);
    # fetch the full row.
    repo_row = db.get_tenant_repository(tenant_id, repository_id)
    if not repo_row:
        return 0

    enqueued = 0
    for branch in branches:
        try:
            enqueued += enqueue_stale_files_for_branch(db, repo_row, branch).enqueued
        except Exception:
            # One bad branch (GitHub error, etc.) must not abort the others.
            _logger.exception(
                "repository refresh rescan failed repository_id=%s branch=%s",
                repository_id,
                branch,
            )
    return enqueued


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

    enqueued_total = 0
    for due_row in db.list_due_repositories():
        repository_id = str(due_row["id"])

        if not db.try_acquire_repository_refresh_lock(repository_id):
            # Another worker / overlapping tick owns this repo right now.
            _logger.debug(
                "repository refresh skipped (lock held) repository_id=%s",
                repository_id,
            )
            continue

        try:
            enqueued_total += _refresh_one_repository(db, due_row)
        except Exception:
            _logger.exception(
                "repository refresh sweep failed repository_id=%s", repository_id
            )
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
