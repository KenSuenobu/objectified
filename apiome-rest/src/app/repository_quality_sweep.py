"""Background sweep that fills in per-spec quality scores (REPO-2.8, #2769).

:mod:`app.repository_spec_quality` knows how to score one already-fetched document. This
module is the worker that feeds it: each tick it claims a bounded batch of *classified* spec
rows whose stored score is missing or stale, downloads each blob from the provider, scores it,
and writes the result back onto ``apiome.tenant_repository_files``.

Scoring deliberately does **not** run inside the REPO-2.5 tree walk. The walk indexes paths
from one Trees call and is already bounded by a wall-clock budget; adding one blob download per
candidate would make a monorepo scan an order of magnitude slower for a signal nobody is
blocked on. Draining the backlog separately keeps the scan's cost where it was and lets the
scoring rate be tuned (``APIOME_REPOSITORY_QUALITY_BATCH_SIZE``) — or turned off entirely
(``APIOME_REPOSITORY_QUALITY_SCORING=false``) — without touching the scanner.

Every claimed row is stamped with the blob sha the attempt read, success or not, so:

* each ``(file, blob)`` pair costs at most one download;
* a file that cannot be scored (unsupported provider, private repo with no token, unparseable
  document) settles instead of being retried on every tick; and
* editing the file gives it a new sha, which makes it due again and re-scores it.

Nothing here can fail a scan, a refresh, or an import: a per-row failure is recorded on the row
and the sweep moves on, and a batch-level failure is logged and retried next tick.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, NamedTuple, Optional

from .config import settings
from .database import Database
from .repository_file_scan import _github_owner_repo, fetch_github_repository_file_text
from .repository_spec_quality import (
    MAX_SCORE_BYTES,
    REASON_FETCH_FAILED,
    REASON_PROVIDER_UNSUPPORTED,
    REASON_TOO_LARGE,
    STATUS_ERROR,
    SpecQualityOutcome,
    failed,
    score_spec_text,
    skipped,
)

_logger = logging.getLogger(__name__)

#: Reason recorded when a private repository has no usable linked-account token. Kept local to
#: the sweep because it describes an access problem, not a property of the document.
REASON_NO_TOKEN = "no-token"


class QualitySweepResult(NamedTuple):
    """Tally of one sweep tick.

    Attributes:
        claimed: Rows claimed for scoring this tick.
        scored: Rows that came back with a usable 0-100 score.
        skipped: Rows deliberately not scored (unsupported provider, too large, ...).
        errored: Rows where scoring was attempted and failed.
    """

    claimed: int
    scored: int
    skipped: int
    errored: int


def _resolve_access_token(db: Database, row: Dict[str, Any]) -> Optional[str]:
    """Return the OAuth token for this repository's linked account, when there is one.

    Mirrors the file-content endpoint's resolution so the sweep can read exactly the files an
    operator could open by hand — no more.

    Args:
        db: Database handle.
        row: A claimed file row joined to its repository.

    Returns:
        The access token, or ``None`` when the repository has no linked account (public repos
        need none) or the link carries no token.
    """
    linked = row.get("linked_account_id")
    created_by = row.get("created_by")
    if not linked or not created_by:
        return None
    try:
        oauth = db.get_external_auth_provider_for_user(str(linked), str(created_by))
    except Exception:  # noqa: BLE001 - a lookup failure just means "no token"
        _logger.warning("repository quality sweep: token lookup failed", exc_info=True)
        return None
    if oauth and oauth.get("access_token"):
        return str(oauth["access_token"])
    return None


def score_repository_file_row(db: Database, row: Dict[str, Any]) -> SpecQualityOutcome:
    """Download and score one claimed file row, never raising.

    Args:
        db: Database handle (used only to resolve the repository's access token).
        row: A claimed row from
            :meth:`app.database.Database.claim_repository_files_for_quality_scoring`.

    Returns:
        The :class:`~app.repository_spec_quality.SpecQualityOutcome` for the row.
    """
    path = str(row.get("path") or "").strip()
    branch = str(row.get("branch") or "").strip()
    detected_kind = row.get("detected_kind")
    detected_kind_s = str(detected_kind) if detected_kind is not None else None

    provider = str(row.get("provider") or "").lower()
    if provider != "github":
        # GitHub is the only provider with a content reader today (same limit the
        # file-content endpoint reports as 501).
        return skipped(REASON_PROVIDER_UNSUPPORTED)
    if not path or not branch:
        return skipped(REASON_PROVIDER_UNSUPPORTED)

    size = row.get("size_bytes")
    if isinstance(size, int) and size > MAX_SCORE_BYTES:
        # Cheap pre-check on the indexed size so an oversized blob is never downloaded.
        return skipped(REASON_TOO_LARGE)

    token = _resolve_access_token(db, row)
    if str(row.get("visibility") or "").lower() == "private" and not token:
        return skipped(REASON_NO_TOKEN)

    try:
        owner, repo = _github_owner_repo(row)
        text, truncated = fetch_github_repository_file_text(
            owner, repo, path, branch, token, max_bytes=MAX_SCORE_BYTES
        )
    except Exception:  # noqa: BLE001 - provider errors are ordinary here, not exceptional
        _logger.info("repository quality sweep: content fetch failed for %s", path, exc_info=True)
        return failed(REASON_FETCH_FAILED)

    return score_spec_text(detected_kind_s, path, text, truncated=truncated)


def process_repository_spec_quality_batch(
    db: Database, *, limit: Optional[int] = None
) -> QualitySweepResult:
    """Score one bounded batch of discovered specs (one sweep tick).

    Args:
        db: Database handle.
        limit: Rows to claim this tick. Defaults to
            ``settings.repository_quality_batch_size``.

    Returns:
        The :class:`QualitySweepResult` tally. An all-zero result means there was nothing due
        (or scoring is disabled), which is the steady state.
    """
    if not settings.repository_quality_scoring_enabled:
        return QualitySweepResult(claimed=0, scored=0, skipped=0, errored=0)

    batch = max(1, int(limit if limit is not None else settings.repository_quality_batch_size))
    rows = db.claim_repository_files_for_quality_scoring(batch)
    if not rows:
        return QualitySweepResult(claimed=0, scored=0, skipped=0, errored=0)

    scored = 0
    skipped_count = 0
    errored = 0
    for row in rows:
        file_id = str(row.get("id") or "")
        if not file_id:
            continue
        outcome = score_repository_file_row(db, row)
        try:
            db.set_repository_file_quality(
                file_id,
                status=outcome.status,
                score=outcome.score,
                grade=outcome.grade,
                reason=outcome.reason,
                blob_sha=str(row.get("blob_sha")) if row.get("blob_sha") else None,
            )
        except Exception:  # noqa: BLE001 - a write failure just leaves the row due next tick
            _logger.warning(
                "repository quality sweep: could not persist score for file %s", file_id, exc_info=True
            )
            continue
        if outcome.scored:
            scored += 1
        elif outcome.status == STATUS_ERROR:
            errored += 1
        else:
            skipped_count += 1

    return QualitySweepResult(
        claimed=len(rows), scored=scored, skipped=skipped_count, errored=errored
    )
