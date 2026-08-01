"""
Per-repository / per-file refresh conflict policy (RAR-4.5, #3531).

The RAR-4.4 divergence guard (:mod:`app.repository_divergence_guard`) answers one
question — *has the imported version been hand-edited since?* — and applies the
safe default: hold, do not clobber. That default is right for most teams and
wrong for some. A team whose repository is the single source of truth wants the
refresh to win. A team with a review process wants the refresh parked. A team
that wants neither side to lose wants the refresh on a side branch.

This module is the policy layer that makes that choice configurable::

    diverged ──► policy: overwrite | hold-for-review | new-branch

and resolves which policy applies to a given file::

    per-file override ──► repository policy ──► hold-for-review (default)

Two decisions live here, both pure and DB-free so they can be exercised by
deterministic fixtures (the same shape as the RAR-2.2 comparator, the RAR-2.4
idempotency guard and the RAR-4.4 divergence guard):

* :func:`resolve_conflict_policy` — which policy applies, and where it came from.
* :func:`decide_conflict` — what the refresh should actually *do*, by running the
  RAR-4.4 guard under the resolved policy and mapping its verdict to a
  :class:`ConflictAction`.

Persisting the policy (``tenant_repositories.refresh_conflict_policy`` and
``apiome.repository_conflict_policy_override``, migration
``V235__repository_conflict_policy_rar_4_5.sql``) is the DAO's job; acting on the
returned :class:`ConflictAction` — superseding the version, flagging ``diverged``
and firing the RAR-5.4 notification, or creating the side branch — is the EPIC-4
dispatcher's, mirroring how RAR-4.1/4.2/4.3/4.4 deferred their wiring.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from .repository_divergence_guard import (
    DivergenceDecision,
    DivergencePolicy,
    DivergenceReason,
    evaluate_divergence,
)


class ConflictPolicy(str, Enum):
    """What to do when an auto-refresh meets a hand-edited (diverged) version.

    These are the stored, wire-visible policy tokens: the values match the
    ``CHECK`` constraints on ``tenant_repositories.refresh_conflict_policy`` and
    ``repository_conflict_policy_override.policy``, and are what the settings API
    accepts and returns.
    """

    #: The repository wins: the refresh supersedes the hand-edited version. The
    #: divergence is still *detected* and reported (so audit and notifications
    #: reflect reality) — it just does not stop the refresh.
    OVERWRITE = "overwrite"
    #: Hold-not-clobber (default, the RAR-4.4 behaviour): the refresh is skipped,
    #: the file is flagged ``diverged``, and a human resolves it.
    HOLD_FOR_REVIEW = "hold-for-review"
    #: Neither side loses: the current version is left untouched and the refresh
    #: lands on a new branch/version for review and merge.
    NEW_BRANCH = "new-branch"


#: The policy in force when neither the file nor the repository specifies one.
#: RAR-4.5 keeps the RAR-4.4 hold-not-clobber default: opting into a policy that
#: can lose a hand edit must be an explicit act.
DEFAULT_CONFLICT_POLICY = ConflictPolicy.HOLD_FOR_REVIEW


class ConflictPolicySource(str, Enum):
    """Where the applied policy came from (surfaced in the UI and the audit trail)."""

    #: A per-file override row (``repository_conflict_policy_override``).
    FILE = "file"
    #: The repository-wide ``tenant_repositories.refresh_conflict_policy``.
    REPOSITORY = "repository"
    #: Neither was set (or both were unrecognised) -> the built-in default.
    DEFAULT = "default"


class ConflictAction(str, Enum):
    """What the refresh executor should do with this file on this tick."""

    #: Apply the refresh to the current version, superseding it. Either nothing
    #: diverged, or the policy is :attr:`ConflictPolicy.OVERWRITE`.
    APPLY = "apply"
    #: Do not apply: skip the overwrite, flag the file ``diverged``, notify
    #: (RAR-5.4) and wait for a human.
    HOLD = "hold"
    #: Do not touch the current version: land the refresh on a new branch so both
    #: the hand edit and the upstream change survive.
    NEW_BRANCH = "new-branch"


#: How each policy maps onto the RAR-4.4 guard's policy input. ``hold-for-review``
#: and ``new-branch`` both *protect* the current version (the guard holds the
#: overwrite); they differ only in what the executor does next, which
#: :func:`decide_conflict` decides from the policy itself.
_GUARD_POLICY = {
    ConflictPolicy.OVERWRITE: DivergencePolicy.OVERWRITE,
    ConflictPolicy.HOLD_FOR_REVIEW: DivergencePolicy.HOLD,
    ConflictPolicy.NEW_BRANCH: DivergencePolicy.HOLD,
}

#: Tolerated spellings of the stored tokens. The API and the DB agree on the
#: hyphenated forms; these aliases mean a hand-written config or an older caller
#: using the RAR-4.4 guard's internal ``"hold"`` token still resolves correctly
#: instead of silently falling back to the default.
_POLICY_ALIASES = {
    "hold": ConflictPolicy.HOLD_FOR_REVIEW,
    "hold_for_review": ConflictPolicy.HOLD_FOR_REVIEW,
    "holdforreview": ConflictPolicy.HOLD_FOR_REVIEW,
    "review": ConflictPolicy.HOLD_FOR_REVIEW,
    "new_branch": ConflictPolicy.NEW_BRANCH,
    "newbranch": ConflictPolicy.NEW_BRANCH,
    "branch": ConflictPolicy.NEW_BRANCH,
    "clobber": ConflictPolicy.OVERWRITE,
}

#: Characters a git ref may not carry, collapsed to ``-`` when building a branch
#: name. Deliberately conservative: anything outside the safe set is replaced.
_UNSAFE_REF_CHARS = re.compile(r"[^A-Za-z0-9._/-]+")


def parse_conflict_policy(
    value: Optional[object],
    *,
    default: Optional[ConflictPolicy] = None,
) -> Optional[ConflictPolicy]:
    """Parse a stored/submitted policy token into a :class:`ConflictPolicy`.

    Accepts the canonical tokens (``overwrite`` / ``hold-for-review`` /
    ``new-branch``) case-insensitively, plus the underscore and legacy spellings
    in :data:`_POLICY_ALIASES`, so a value written by an older caller or typed by
    hand still resolves. Anything unrecognised — including ``None`` and blank —
    yields ``default``.

    Args:
        value: The raw policy token (typically a DB column or a request field),
            or ``None``.
        default: What to return when ``value`` is missing or unrecognised.
            Defaults to ``None`` so a caller can distinguish "not set" from "set
            to the default"; :func:`resolve_conflict_policy` relies on that.

    Returns:
        The parsed :class:`ConflictPolicy`, or ``default``.
    """
    if isinstance(value, ConflictPolicy):
        return value
    if not isinstance(value, str):
        return default
    token = value.strip().lower()
    if not token:
        return default
    try:
        return ConflictPolicy(token)
    except ValueError:
        return _POLICY_ALIASES.get(token.replace("-", "_"), default)


@dataclass(frozen=True)
class ResolvedConflictPolicy:
    """Which conflict policy applies to one file, and where it came from.

    Attributes:
        policy: The :class:`ConflictPolicy` in force for this file.
        source: The :class:`ConflictPolicySource` the policy was read from —
            ``file`` when a per-file override won, ``repository`` when the
            repository-wide setting did, ``default`` when neither was usable.
    """

    policy: ConflictPolicy
    source: ConflictPolicySource


def resolve_conflict_policy(
    *,
    file_policy: Optional[object] = None,
    repository_policy: Optional[object] = None,
    default: ConflictPolicy = DEFAULT_CONFLICT_POLICY,
) -> ResolvedConflictPolicy:
    """Resolve the conflict policy for one file (RAR-4.5).

    Applies the precedence the ticket specifies — the per-file override is the
    most specific statement of intent, the repository setting is the fallback,
    and the built-in default backs both::

        per-file override ──► repository policy ──► hold-for-review

    An unrecognised value at either level is treated as *not set* rather than as
    an error, so one bad row degrades to the next-broadest policy instead of
    failing the refresh. Because the broadest fallback is hold-not-clobber, every
    degradation path is the safe one.

    Args:
        file_policy: The per-file override token, or ``None`` when the file has no
            override row.
        repository_policy: The repository-wide token
            (``tenant_repositories.refresh_conflict_policy``), or ``None``.
        default: The policy backing both levels. Defaults to
            :data:`DEFAULT_CONFLICT_POLICY` (hold-for-review).

    Returns:
        A :class:`ResolvedConflictPolicy` carrying the policy and its source.
    """
    parsed_file = parse_conflict_policy(file_policy)
    if parsed_file is not None:
        return ResolvedConflictPolicy(
            policy=parsed_file, source=ConflictPolicySource.FILE
        )

    parsed_repo = parse_conflict_policy(repository_policy)
    if parsed_repo is not None:
        return ResolvedConflictPolicy(
            policy=parsed_repo, source=ConflictPolicySource.REPOSITORY
        )

    return ResolvedConflictPolicy(policy=default, source=ConflictPolicySource.DEFAULT)


@dataclass(frozen=True)
class ConflictOutcome:
    """What a refresh should do with one file, under the policy that applies.

    Attributes:
        action: The :class:`ConflictAction` the executor must take — apply the
            refresh, hold it, or divert it to a new branch.
        diverged: True when a manual edit was *detected*. Independent of the
            action: an ``overwrite`` policy still reports the divergence it
            clobbered, so audit and notifications reflect reality.
        reason: The RAR-4.4 :class:`DivergenceReason` behind the verdict.
        policy: The :class:`ConflictPolicy` the decision was made under.
        source: Where that policy came from (:class:`ConflictPolicySource`).
        branch_name: The branch the refresh should land on, set only when
            ``action`` is :attr:`ConflictAction.NEW_BRANCH` and enough context was
            supplied to name one; ``None`` otherwise.
    """

    action: ConflictAction
    diverged: bool
    reason: DivergenceReason
    policy: ConflictPolicy
    source: ConflictPolicySource
    branch_name: Optional[str] = None


def refresh_branch_name(
    *,
    base_branch: Optional[str],
    path: Optional[str] = None,
    commit_sha: Optional[str] = None,
) -> Optional[str]:
    """Build the branch name a ``new-branch`` refresh lands on.

    Deterministic — the same inputs always name the same branch — so a refresh
    that runs twice for one commit targets one branch rather than accumulating
    near-duplicates. The shape is::

        apiome-refresh/<base branch>/<file stem>-<short sha>

    Unsafe ref characters are collapsed to ``-`` and the sha is shortened to 12
    characters, which is unambiguous in practice and keeps the name readable.

    Args:
        base_branch: The branch the file was imported from. ``None``/blank means
            the caller has no branch context and no name can be built.
        path: The repository path of the refreshed file; its file stem
            disambiguates two files refreshed from the same commit. Optional.
        commit_sha: The source commit driving the refresh (RAR-2.1). Optional;
            omitted when the caller has no commit signal.

    Returns:
        The branch name, or ``None`` when ``base_branch`` is missing/blank (the
        caller then has to name the branch itself).
    """
    base = (base_branch or "").strip().strip("/")
    if not base:
        return None

    segments = [_safe_ref_segment(base)]

    leaf = ""
    if path:
        tail = str(path).strip().rstrip("/").rsplit("/", 1)[-1]
        leaf = _safe_ref_segment(tail.rsplit(".", 1)[0])
    sha = _safe_ref_segment((commit_sha or "").strip())[:12]

    suffix = "-".join(part for part in (leaf, sha) if part)
    if suffix:
        segments.append(suffix)

    return "apiome-refresh/" + "/".join(part for part in segments if part)


def _safe_ref_segment(value: str) -> str:
    """Reduce a string to characters that are safe inside a git ref segment."""
    cleaned = _UNSAFE_REF_CHARS.sub("-", value).strip("-./")
    return cleaned


def decide_conflict(
    *,
    post_import_checksum: Optional[str],
    current_checksum: Optional[str],
    file_policy: Optional[object] = None,
    repository_policy: Optional[object] = None,
    base_branch: Optional[str] = None,
    path: Optional[str] = None,
    commit_sha: Optional[str] = None,
) -> ConflictOutcome:
    """Decide what a refresh does with one file, under its conflict policy (RAR-4.5).

    Resolves the applicable policy (:func:`resolve_conflict_policy`), runs the
    RAR-4.4 divergence guard under it (:func:`~app.repository_divergence_guard.
    evaluate_divergence`), and maps the verdict to the action the executor takes:

    ==================  ================  ===========================================
    Divergence          Policy            Action
    ==================  ================  ===========================================
    none                any               ``apply``
    detected            ``overwrite``     ``apply``   (divergence reported, not held)
    detected            ``hold-for-review``  ``hold``  (default: no clobber)
    detected            ``new-branch``    ``new-branch`` (current version untouched)
    ==================  ================  ===========================================

    Divergence detection itself is unchanged from RAR-4.4: no baseline fails open,
    an identical checksum applies, and a missing current checksum with a baseline
    present counts as a difference.

    Args:
        post_import_checksum: Content checksum captured right after the original
            import (the snapshot baseline), or ``None`` when none was captured.
        current_checksum: Content checksum of the version as it stands now.
        file_policy: The per-file override token, or ``None``.
        repository_policy: The repository-wide policy token, or ``None``.
        base_branch: The branch the file was imported from, used to name the
            branch when the action is ``new-branch``. Optional.
        path: The repository path of the file, used in the branch name. Optional.
        commit_sha: The source commit driving the refresh, used in the branch
            name. Optional.

    Returns:
        A :class:`ConflictOutcome` describing the action, the divergence verdict,
        the policy applied and its source.
    """
    resolved = resolve_conflict_policy(
        file_policy=file_policy, repository_policy=repository_policy
    )
    decision: DivergenceDecision = evaluate_divergence(
        post_import_checksum=post_import_checksum,
        current_checksum=current_checksum,
        policy=_GUARD_POLICY[resolved.policy],
    )

    if not decision.should_hold:
        # Either nothing diverged, or the policy is OVERWRITE and the refresh is
        # allowed to supersede the hand edit. Both apply; `diverged` still carries
        # whether an edit was clobbered.
        action = ConflictAction.APPLY
        branch_name = None
    elif resolved.policy is ConflictPolicy.NEW_BRANCH:
        # The current version is protected (the guard held the overwrite) and the
        # refresh is diverted rather than dropped.
        action = ConflictAction.NEW_BRANCH
        branch_name = refresh_branch_name(
            base_branch=base_branch, path=path, commit_sha=commit_sha
        )
    else:
        action = ConflictAction.HOLD
        branch_name = None

    return ConflictOutcome(
        action=action,
        diverged=decision.diverged,
        reason=decision.reason,
        policy=resolved.policy,
        source=resolved.source,
        branch_name=branch_name,
    )
