"""Bounded, resumable repository-walk primitives (REPO-2.5, #2766).

The REPO-2 walker read a whole branch tree in one ``recursive=1`` GitHub Trees
call, buffered every blob in memory, and rewrote the file index in one statement.
On a monorepo with >25k entries that blows the memory and time budgets, and
GitHub answers with ``truncated: true`` — which the old walker turned into a hard
failure.

This module is the provider-agnostic, side-effect-free policy layer the GitHub
walk (``repository_file_scan``) and the DAO build on. It owns three things:

* :class:`ScanBudget` — a monotonic wall-clock budget for one scan *pass*,
  resolved per tenant by :func:`resolve_scan_budget_seconds` (default 300s).
* :class:`ScanCursor` — the stored resume token: the pinned tree SHA, the branch
  tip recency anchors, the walk mode, the pending sub-tree queue, and how many
  entries have already been emitted. It round-trips through JSONB
  (``apiome.tenant_repository_scan_cursors.cursor_json``).
* Chunking rules — :func:`resolve_chunk_size` and :func:`chunked`, which cap the
  walker's in-memory buffer at :data:`MAX_WALK_CHUNK_SIZE` (1000) entries.

Keeping the policy here (rather than inline in the walker) means the clamping,
expiry, and attempt-cap rules are deterministic and unit-testable without a
network or a database, exactly like ``repository_refresh_cadence`` does for the
auto-refresh cadence.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence

_log = logging.getLogger(__name__)

#: Default per-tenant wall-clock budget for a single scan pass (5 minutes).
DEFAULT_SCAN_BUDGET_SECONDS = 300
#: Floor a configured budget is clamped up to; a sub-second budget would make no
#: forward progress at all (every pass would pause before its first chunk).
DEFAULT_MIN_SCAN_BUDGET_SECONDS = 5
#: Ceiling a configured budget is clamped down to (1 hour), so one tenant cannot
#: park a scan worker indefinitely on a single repository.
DEFAULT_MAX_SCAN_BUDGET_SECONDS = 3600

#: Hard cap on how many entries the walker may hold before flushing them
#: (acceptance criterion: "chunks of <= 1000").
MAX_WALK_CHUNK_SIZE = 1000
#: Chunk size used when nothing is configured.
DEFAULT_WALK_CHUNK_SIZE = 1000

#: How many *consecutive passes that indexed nothing new* a cursor may take before
#: it is abandoned and the scan is failed outright. A pass that made progress
#: resets the count, so a long monorepo walk is never penalized for taking many
#: passes; this only trips when a walk is genuinely wedged (e.g. a sub-tree the
#: provider keeps 500ing on).
MAX_SCAN_RESUME_ATTEMPTS = 20

#: A cursor older than this is treated as expired: the branch has almost certainly
#: moved on, so resuming would splice two different trees together. An expired
#: cursor is dropped and the branch is walked from scratch.
DEFAULT_CURSOR_MAX_AGE_SECONDS = 86_400

#: Walk modes stored in the cursor.
WALK_MODE_RECURSIVE = "recursive"
WALK_MODE_SPARSE = "sparse"
_WALK_MODES = (WALK_MODE_RECURSIVE, WALK_MODE_SPARSE)

#: Version stamped into every serialized cursor. A cursor whose version this
#: build does not understand is discarded rather than mis-read.
CURSOR_SCHEMA_VERSION = 1


class TransientScanError(Exception):
    """A scan pass was interrupted by a retryable provider failure.

    Carries the walker position at the moment of the failure so the caller can
    store it and resume, instead of restarting the walk from the beginning.

    Attributes:
        cursor: The resume cursor covering everything already persisted, or None
            when the failure happened before any position was established.
    """

    def __init__(self, message: str, cursor: Optional["ScanCursor"] = None) -> None:
        super().__init__(message)
        self.cursor = cursor


def resolve_scan_budget_seconds(
    configured_seconds: Optional[int],
    *,
    default_seconds: int = DEFAULT_SCAN_BUDGET_SECONDS,
    floor_seconds: int = DEFAULT_MIN_SCAN_BUDGET_SECONDS,
    ceiling_seconds: int = DEFAULT_MAX_SCAN_BUDGET_SECONDS,
) -> int:
    """Resolve a tenant's effective per-scan wall-clock budget in seconds.

    Applies the default when the tenant has no explicit budget (or a non-positive
    one, which is treated as unset), then clamps into ``[floor, ceiling]``. A
    clamp is logged at WARNING so operators can see it took effect.

    The floor is itself forced to at least 1 second, and the ceiling to at least
    the floor, so a misconfigured environment cannot produce an empty range.

    Args:
        configured_seconds: The tenant's ``repository_scan_budget_seconds``, or
            None when unset. Non-positive values are treated as unset.
        default_seconds: Budget applied when ``configured_seconds`` is unset.
        floor_seconds: Minimum budget; smaller values are clamped up.
        ceiling_seconds: Maximum budget; larger values are clamped down.

    Returns:
        The effective budget in seconds (always within the clamped range).
    """
    floor = floor_seconds if floor_seconds >= 1 else 1
    ceiling = ceiling_seconds if ceiling_seconds >= floor else floor

    if configured_seconds is None or configured_seconds <= 0:
        budget = default_seconds
    else:
        budget = int(configured_seconds)

    if budget < floor:
        _log.warning(
            "repository scan budget %ss is below the floor %ss; clamping to %ss",
            budget,
            floor,
            floor,
        )
        return floor
    if budget > ceiling:
        _log.warning(
            "repository scan budget %ss exceeds the ceiling %ss; clamping to %ss",
            budget,
            ceiling,
            ceiling,
        )
        return ceiling
    return budget


def resolve_chunk_size(configured: Optional[int]) -> int:
    """Resolve the walker's flush size, capped at :data:`MAX_WALK_CHUNK_SIZE`.

    The acceptance criterion for #2766 is that the walker streams entries in
    chunks of at most 1000, so an oversized configuration is silently capped
    rather than honored.

    Args:
        configured: A requested chunk size, or None for the default. Non-positive
            values fall back to :data:`DEFAULT_WALK_CHUNK_SIZE`.

    Returns:
        A chunk size in ``[1, MAX_WALK_CHUNK_SIZE]``.
    """
    if configured is None or configured <= 0:
        size = DEFAULT_WALK_CHUNK_SIZE
    else:
        size = int(configured)
    return min(size, MAX_WALK_CHUNK_SIZE)


def chunked(items: Iterable[Any], size: int) -> Iterator[List[Any]]:
    """Yield ``items`` in lists of at most ``size`` entries.

    Consumes ``items`` lazily so a generator source is never fully materialized;
    only one chunk is held at a time.

    Args:
        items: Any iterable of entries.
        size: Maximum entries per yielded chunk; clamped through
            :func:`resolve_chunk_size`, so it can never exceed 1000.

    Yields:
        Non-empty lists of at most ``resolve_chunk_size(size)`` entries.
    """
    limit = resolve_chunk_size(size)
    buffer: List[Any] = []
    for item in items:
        buffer.append(item)
        if len(buffer) >= limit:
            yield buffer
            buffer = []
    if buffer:
        yield buffer


class ScanBudget:
    """A monotonic wall-clock budget for one repository scan pass.

    The walker checks :meth:`exhausted` between chunks; when it returns True the
    pass stops, persists what it has, and stores a resume cursor. Uses
    :func:`time.monotonic` so a system clock adjustment mid-scan cannot make a
    budget appear expired (or infinite).

    Args:
        seconds: The budget for this pass. Non-positive means "no budget" — the
            pass runs to completion (used by callers that cannot resume).
        clock: Monotonic time source, injectable for tests. Defaults to
            :func:`time.monotonic`, looked up at construction time.
    """

    def __init__(self, seconds: Optional[int], *, clock: Optional[Callable[[], float]] = None) -> None:
        self._clock: Callable[[], float] = clock if clock is not None else time.monotonic
        self._seconds = int(seconds) if seconds and seconds > 0 else 0
        self._started_at = float(self._clock())

    @property
    def seconds(self) -> int:
        """The budget in seconds; 0 means unbounded."""
        return self._seconds

    def elapsed_seconds(self) -> float:
        """Seconds of wall clock consumed since the pass started."""
        return float(self._clock()) - self._started_at

    def remaining_seconds(self) -> float:
        """Seconds left before the budget is spent (``inf`` when unbounded)."""
        if self._seconds <= 0:
            return float("inf")
        return self._seconds - self.elapsed_seconds()

    def exhausted(self) -> bool:
        """Whether the pass must stop now and store a resume cursor."""
        if self._seconds <= 0:
            return False
        return self.elapsed_seconds() >= self._seconds


class ScanCursor:
    """A resumable position in a repository tree walk (REPO-2.5).

    The cursor pins the *tree* being walked, so a resumed pass keeps indexing the
    same snapshot even if the branch moves in between; the branch-tip recency
    anchors captured on the first pass (RAR-2.1) are carried along so every entry
    written across all passes is stamped consistently.

    Attributes:
        tree_sha: The root tree SHA pinned on the first pass.
        mode: ``recursive`` while the provider's single-call sparse primitive is
            still viable, ``sparse`` once the response came back truncated and the
            walk fell back to a per-directory breadth-first descent.
        emitted: How many blobs have already been handed to the sink. In
            ``recursive`` mode this is the offset to skip on resume; in ``sparse``
            mode it is informational (``pending`` is the real position).
        pending: Breadth-first queue of not-yet-visited sub-trees, each a
            ``{"sha": ..., "prefix": ...}`` mapping. Only used in ``sparse`` mode.
            This queue is what bounds the walk's memory: it holds one small entry
            per *directory* still to visit, never one per file.
        tip_commit_sha: Branch tip commit SHA captured on the first pass.
        tip_committed_at: Branch tip commit timestamp captured on the first pass.
        truncated_prefixes: Directories the provider itself truncated; recorded so
            an incomplete index is visible rather than silent.
    """

    __slots__ = (
        "tree_sha",
        "mode",
        "emitted",
        "pending",
        "tip_commit_sha",
        "tip_committed_at",
        "truncated_prefixes",
    )

    def __init__(
        self,
        *,
        tree_sha: str,
        mode: str = WALK_MODE_RECURSIVE,
        emitted: int = 0,
        pending: Optional[Sequence[Dict[str, str]]] = None,
        tip_commit_sha: Optional[str] = None,
        tip_committed_at: Optional[str] = None,
        truncated_prefixes: Optional[Sequence[str]] = None,
    ) -> None:
        self.tree_sha = str(tree_sha)
        self.mode = mode if mode in _WALK_MODES else WALK_MODE_RECURSIVE
        self.emitted = max(0, int(emitted))
        self.pending: List[Dict[str, str]] = [dict(p) for p in (pending or [])]
        self.tip_commit_sha = tip_commit_sha
        self.tip_committed_at = tip_committed_at
        self.truncated_prefixes: List[str] = [str(p) for p in (truncated_prefixes or [])]

    def to_json(self) -> Dict[str, Any]:
        """Serialize to the JSONB shape stored in ``cursor_json``."""
        return {
            "version": CURSOR_SCHEMA_VERSION,
            "tree_sha": self.tree_sha,
            "mode": self.mode,
            "emitted": self.emitted,
            "pending": self.pending,
            "tip_commit_sha": self.tip_commit_sha,
            "tip_committed_at": self.tip_committed_at,
            "truncated_prefixes": self.truncated_prefixes,
        }

    @classmethod
    def from_json(cls, payload: Optional[Dict[str, Any]]) -> Optional["ScanCursor"]:
        """Rebuild a cursor from stored JSON, or None when it is unusable.

        Anything malformed — not a mapping, an unknown schema version, a missing
        tree SHA, a non-list ``pending`` — yields None so the caller restarts the
        walk from scratch rather than resuming from a position it cannot trust.

        Args:
            payload: The stored ``cursor_json`` value (or None).

        Returns:
            The parsed cursor, or None when it cannot be trusted.
        """
        if not isinstance(payload, dict):
            return None
        if int(payload.get("version") or 0) != CURSOR_SCHEMA_VERSION:
            _log.warning("discarding repository scan cursor with unknown version")
            return None
        tree_sha = str(payload.get("tree_sha") or "").strip()
        if not tree_sha:
            return None

        raw_pending = payload.get("pending")
        pending: List[Dict[str, str]] = []
        if isinstance(raw_pending, list):
            for entry in raw_pending:
                if not isinstance(entry, dict):
                    continue
                sha = str(entry.get("sha") or "").strip()
                if not sha:
                    continue
                pending.append({"sha": sha, "prefix": str(entry.get("prefix") or "")})
        elif raw_pending is not None:
            return None

        raw_truncated = payload.get("truncated_prefixes")
        truncated = [str(p) for p in raw_truncated] if isinstance(raw_truncated, list) else []

        return cls(
            tree_sha=tree_sha,
            mode=str(payload.get("mode") or WALK_MODE_RECURSIVE),
            emitted=int(payload.get("emitted") or 0),
            pending=pending,
            tip_commit_sha=payload.get("tip_commit_sha") or None,
            tip_committed_at=payload.get("tip_committed_at") or None,
            truncated_prefixes=truncated,
        )


def _as_utc(value: Optional[object]) -> Optional[datetime]:
    """Coerce a timestamp to an aware UTC ``datetime``, or None when unparseable.

    Accepts an aware/naive :class:`datetime` or an ISO-8601 string (including a
    trailing ``Z``). Naive datetimes are assumed to be UTC.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if raw.endswith(("Z", "z")):
            raw = raw[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def is_cursor_expired(
    updated_at: Optional[object],
    *,
    now: Optional[object] = None,
    max_age_seconds: int = DEFAULT_CURSOR_MAX_AGE_SECONDS,
) -> bool:
    """Whether a stored cursor is too old to resume from.

    A stale cursor points at a tree the branch has long moved past; resuming from
    it would leave the index a mixture of two snapshots. Callers drop an expired
    cursor and walk the branch from scratch.

    Args:
        updated_at: When the cursor was last written (datetime / ISO string). An
            unparseable or missing value is treated as expired — the safe side.
        now: Reference "current" time; defaults to the current UTC time.
        max_age_seconds: Maximum age before expiry. Non-positive disables expiry.

    Returns:
        True when the cursor must not be resumed.
    """
    if max_age_seconds <= 0:
        return False
    written = _as_utc(updated_at)
    if written is None:
        return True
    current = _as_utc(now) or datetime.now(timezone.utc)
    return (current - written).total_seconds() >= max_age_seconds


def should_abandon_cursor(attempt_count: Optional[int], *, max_attempts: int = MAX_SCAN_RESUME_ATTEMPTS) -> bool:
    """Whether a walk is wedged and must stop retrying.

    Args:
        attempt_count: Consecutive no-progress passes recorded on the stored
            cursor row (the DAO resets this to 0 whenever a pass indexes
            something new).
        max_attempts: Cap after which the cursor is abandoned.

    Returns:
        True when the caller must drop the cursor and fail the scan.
    """
    return int(attempt_count or 0) >= max(1, max_attempts)
