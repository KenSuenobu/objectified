"""Tenant import/export quality policy and waivers — IXH-2.3 (#5098).

Quality thresholds already exist for *publishing* (the CLX-1.3 policy packs and their waivers)
and for *style guides* (GOV), but nothing governed **intake** or **delivery**: a tenant could
not say "do not let a D-grade spec into the catalog" or "do not export an artifact whose source
has open error-severity findings". This module is that policy — its storage contract, its
resolution rules, its verdict, and the waiver that lets a named role proceed anyway.

What the policy says
--------------------
Per scope (``import`` / ``export``) a policy carries three independent floors and one
enforcement mode:

* ``min_grade`` — the lowest acceptable letter grade (A is best, F worst).
* ``min_score`` — the lowest acceptable 0-100 lint score.
* ``block_on_severity`` — the severity at or above which findings are unacceptable at all
  (``error`` alone, ``warning`` and worse, or ``info`` and worse).
* ``enforcement`` — ``advisory`` reports a shortfall as a **warn** verdict and lets the work
  proceed; ``block`` refuses it.

Plus the override contract: whether a shortfall may be waived at all (``allow_override``), which
role slugs may waive it (``override_roles``), and how long a granted waiver lives
(``waiver_ttl_hours``).

Resolution
----------
Exactly three tiers, in order, reported on every verdict so nobody has to guess which one won:

1. **format override** — the tenant policy's ``format_overrides[<adapter key>][<scope>]`` block,
   merged field-by-field over the tenant tier (a format may tighten ``min_grade`` without
   restating the severity floor).
2. **tenant** — the tenant's current policy row (the highest ``version_number``).
3. **default** — :data:`DEFAULT_POLICY`: no floors, advisory, override permitted. A tenant with
   no policy row runs this, so existing tenants see no behaviour change on upgrade.

Waivers
-------
A waiver is accepted risk with a deadline, recorded with actor, reason, scope, and expiry — the
same contract CLX-1.3 gives lint findings. It is matched on ``(tenant, scope, subject_key,
format_key)`` and honoured until ``expires_at``; after that the gate simply stops finding it
(the lookup is time-bounded), and the **existing** CLX-4.2 waiver-expiry sweep notifies the
owner as the deadline nears — see :mod:`app.lint_waiver_expiry_sweep`, which claims this table
alongside ``lint_finding_decisions`` rather than running a second sweep.

Where it is used
----------------
* :mod:`app.import_preflight` (IXH-2.1) evaluates it and reports the verdict, so the wizard's
  quality step (IXH-2.2) can render "82 / needs 90" and offer the waiver path.
* :func:`enforce_import_quality_gate` runs at the REST import-start endpoint, so the gate is
  **server-side**: a client that ignores the pre-flight verdict is refused anyway.
* :func:`evaluate_export_quality` is the export half, ready for the IXH-2.4 pre-flight and the
  IXH-2.5 delivery gate to call with a source revision's lint roll-up.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .database import db

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_POLICY",
    "DEFAULT_WAIVER_TTL_HOURS",
    "GRADE_ORDER",
    "QualityGateError",
    "QualityPolicy",
    "QualityThresholds",
    "QualityVerdict",
    "SCOPE_EXPORT",
    "SCOPE_IMPORT",
    "effective_role_slug",
    "enforce_import_quality_gate",
    "evaluate_export_quality",
    "evaluate_quality",
    "find_active_waiver",
    "grade_meets",
    "load_tenant_policy",
    "policy_content_fingerprint",
    "policy_from_row",
    "record_quality_waiver",
    "resolve_thresholds",
    "role_may_override",
    "subject_key_for_document",
]

#: The two gates a policy governs.
SCOPE_IMPORT = "import"
SCOPE_EXPORT = "export"

#: Letter grades from best to worst. Position is the comparison key — ``grade_meets`` never
#: parses a grade back into a score, so a grade floor stays meaningful for an adapter that
#: grades without scoring.
GRADE_ORDER: Tuple[str, ...] = ("A", "B", "C", "D", "F")

#: Severities from most to least severe. ``block_on_severity`` means "this severity or worse".
SEVERITY_ORDER: Tuple[str, ...] = ("error", "warning", "info")

#: Waiver lifetime used when a policy does not state one (7 days).
DEFAULT_WAIVER_TTL_HOURS = 168

#: Role slugs permitted to waive a blocking verdict by default. ``owner`` is what a tenant
#: administrator resolves to (V118 rule), so the default keeps overrides with tenant admins.
DEFAULT_OVERRIDE_ROLES: Tuple[str, ...] = ("owner", "admin")

#: Reason reported when nothing is configured — the documented advisory default.
DEFAULT_POLICY_REASON = (
    "No import/export quality policy is configured for this tenant; the report is advisory "
    "and nothing is blocked."
)


class QualityGateError(Exception):
    """A quality gate refused the operation.

    Carries the machine-readable verdict so a route can turn it into an HTTP error whose body
    states the score, the threshold, the resolution tier, and whether an override exists —
    everything the caller needs to either fix the document or request a waiver.

    Attributes:
        verdict: The blocking :class:`QualityVerdict`.
    """

    def __init__(self, verdict: "QualityVerdict") -> None:
        super().__init__(verdict.reason)
        self.verdict = verdict


@dataclass(frozen=True)
class QualityThresholds:
    """One scope's floors and enforcement mode.

    Attributes:
        min_grade: Lowest acceptable letter grade, or ``None`` for no grade floor.
        min_score: Lowest acceptable 0-100 score, or ``None`` for no score floor.
        block_on_severity: Severity at or above which findings are unacceptable, or ``None``
            when severity is not gated.
        enforcement: ``advisory`` (report only) or ``block`` (refuse).
    """

    min_grade: Optional[str] = None
    min_score: Optional[int] = None
    block_on_severity: Optional[str] = None
    enforcement: str = "advisory"

    @property
    def has_floor(self) -> bool:
        """True when at least one floor is configured (otherwise nothing can fall short)."""
        return (
            self.min_grade is not None
            or self.min_score is not None
            or self.block_on_severity is not None
        )

    def merged_with(self, override: "QualityThresholds", *, override_fields: Sequence[str]) -> "QualityThresholds":
        """Return these thresholds with ``override_fields`` taken from ``override``.

        Field-level merge is what makes a per-format override usable: a format that only wants a
        stricter grade floor states ``minGrade`` and inherits the tenant's severity floor and
        enforcement mode instead of silently resetting them to the defaults.

        Args:
            override: The thresholds parsed from the format override block.
            override_fields: Names of the fields the override actually stated.

        Returns:
            The merged thresholds.
        """
        updates = {field: getattr(override, field) for field in override_fields}
        return replace(self, **updates) if updates else self


@dataclass(frozen=True)
class QualityPolicy:
    """A tenant's quality policy as the gates read it.

    Attributes:
        policy_version_id: Row id of the policy version, or ``None`` for the built-in default.
        version_number: Monotonic version number, or ``0`` for the default.
        content_fingerprint: Fingerprint of the policy body (``"default"`` for the default).
        import_thresholds: Tenant-tier import floors.
        export_thresholds: Tenant-tier export floors.
        format_overrides: Raw ``{adapter key: {scope: {field: value}}}`` override map.
        allow_override: Whether a blocking verdict may be waived at all.
        override_roles: Role slugs permitted to record a waiver.
        waiver_ttl_hours: Lifetime of a granted waiver.
        is_default: True when no tenant policy row exists.
    """

    policy_version_id: Optional[str] = None
    version_number: int = 0
    content_fingerprint: str = "default"
    import_thresholds: QualityThresholds = QualityThresholds()
    export_thresholds: QualityThresholds = QualityThresholds()
    format_overrides: Mapping[str, Any] = None  # type: ignore[assignment]
    allow_override: bool = True
    override_roles: Tuple[str, ...] = DEFAULT_OVERRIDE_ROLES
    waiver_ttl_hours: int = DEFAULT_WAIVER_TTL_HOURS
    is_default: bool = True

    def __post_init__(self) -> None:  # pragma: no cover - trivial normalization
        if self.format_overrides is None:
            object.__setattr__(self, "format_overrides", {})

    def thresholds_for(self, scope: str) -> QualityThresholds:
        """The tenant-tier thresholds for one scope."""
        return self.import_thresholds if scope == SCOPE_IMPORT else self.export_thresholds


#: The documented default: nothing blocked, advisory only, override permitted.
DEFAULT_POLICY = QualityPolicy()


@dataclass(frozen=True)
class QualityVerdict:
    """The answer for one candidate under one policy.

    Attributes:
        verdict: ``pass`` (clears every floor, or none is set), ``warn`` (falls short under an
            advisory policy, or falls short but a waiver is honoured), or ``block``.
        blocking: Whether the operation must be refused.
        scope: ``import`` | ``export``.
        source: Which resolution tier produced the thresholds — ``format_override`` | ``tenant``
            | ``default``.
        format_key: The adapter/target key the verdict was resolved for, when known.
        reason: One human-readable sentence explaining the verdict.
        thresholds: The resolved thresholds that were applied.
        failures: Machine-readable shortfalls (``{"kind", "required", "actual"}``), empty on a
            pass.
        score: The candidate's score, when it had one.
        grade: The candidate's grade, when it had one.
        allow_override: Whether policy permits waiving this verdict.
        override_roles: Role slugs allowed to waive it.
        policy_version_id: Policy version applied, or ``None`` for the default.
        policy_content_fingerprint: Fingerprint of that policy version.
        waiver_id: The honoured waiver, when one downgraded a block.
        waiver_expires_at: That waiver's expiry, ISO-8601.
    """

    verdict: str
    blocking: bool
    scope: str
    source: str
    format_key: Optional[str]
    reason: str
    thresholds: QualityThresholds
    failures: Tuple[Dict[str, Any], ...] = ()
    score: Optional[int] = None
    grade: Optional[str] = None
    allow_override: bool = True
    override_roles: Tuple[str, ...] = DEFAULT_OVERRIDE_ROLES
    policy_version_id: Optional[str] = None
    policy_content_fingerprint: str = "default"
    waiver_id: Optional[str] = None
    waiver_expires_at: Optional[str] = None

    @property
    def threshold_score(self) -> Optional[int]:
        """The score floor applied, for the "82 / needs 90" strip in the wizard."""
        return self.thresholds.min_score

    def as_dict(self) -> Dict[str, Any]:
        """Serialize the verdict for API payloads and audit detail."""
        return {
            "verdict": self.verdict,
            "blocking": self.blocking,
            "scope": self.scope,
            "source": self.source,
            "format_key": self.format_key,
            "reason": self.reason,
            "min_grade": self.thresholds.min_grade,
            "threshold_score": self.thresholds.min_score,
            "block_on_severity": self.thresholds.block_on_severity,
            "enforcement": self.thresholds.enforcement,
            "failures": [dict(f) for f in self.failures],
            "score": self.score,
            "grade": self.grade,
            "allow_override": self.allow_override,
            "override_roles": list(self.override_roles),
            "policy_version_id": self.policy_version_id,
            "policy_content_fingerprint": self.policy_content_fingerprint,
            "waiver_id": self.waiver_id,
            "waiver_expires_at": self.waiver_expires_at,
        }


# ---------------------------------------------------------------------------------------------
# Comparison primitives
# ---------------------------------------------------------------------------------------------


def grade_meets(grade: Optional[str], minimum: Optional[str]) -> bool:
    """Whether ``grade`` is at least as good as ``minimum``.

    Grades are compared by position in :data:`GRADE_ORDER` (A best, F worst). An unknown or
    missing grade **passes**: a policy floor is a statement about known quality, and refusing an
    unscored adapter's output would block formats the linter cannot grade at all.

    Args:
        grade: The candidate's letter grade, or ``None``.
        minimum: The policy floor, or ``None`` for no floor.

    Returns:
        True when the floor is absent, unknown, or satisfied.
    """
    if not minimum or minimum not in GRADE_ORDER:
        return True
    if not grade or grade not in GRADE_ORDER:
        return True
    return GRADE_ORDER.index(grade) <= GRADE_ORDER.index(minimum)


def severities_at_or_above(
    severity_counts: Mapping[str, int], minimum: Optional[str]
) -> int:
    """Count findings at or above ``minimum`` severity.

    Args:
        severity_counts: The lint report's per-severity tally.
        minimum: The gated severity (``error``/``warning``/``info``), or ``None``.

    Returns:
        The number of findings at or above that severity; ``0`` when severity is not gated or
        the severity name is unknown.
    """
    if not minimum or minimum not in SEVERITY_ORDER:
        return 0
    cutoff = SEVERITY_ORDER.index(minimum)
    return sum(
        int(count or 0)
        for severity, count in severity_counts.items()
        if severity in SEVERITY_ORDER and SEVERITY_ORDER.index(severity) <= cutoff
    )


# ---------------------------------------------------------------------------------------------
# Policy loading and resolution
# ---------------------------------------------------------------------------------------------


def _clean_grade(value: Any) -> Optional[str]:
    """Normalize a stored grade into the A-F vocabulary, or ``None``."""
    grade = str(value).strip().upper() if value not in (None, "") else None
    return grade if grade in GRADE_ORDER else None


def _clean_score(value: Any) -> Optional[int]:
    """Normalize a stored score into 0-100, or ``None`` when absent/uninterpretable."""
    if value in (None, ""):
        return None
    try:
        score = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, min(100, score))


def _clean_severity(value: Any) -> Optional[str]:
    """Normalize a stored severity into the error/warning/info vocabulary, or ``None``."""
    severity = str(value).strip().lower() if value not in (None, "") else None
    return severity if severity in SEVERITY_ORDER else None


def _clean_enforcement(value: Any, *, default: str = "advisory") -> str:
    """Normalize a stored enforcement mode; anything unrecognized falls back to advisory."""
    mode = str(value).strip().lower() if value not in (None, "") else default
    return mode if mode in ("advisory", "block") else default


def _thresholds_from_row(row: Mapping[str, Any], scope: str) -> QualityThresholds:
    """Build one scope's tenant-tier thresholds from a policy row."""
    prefix = "import" if scope == SCOPE_IMPORT else "export"
    return QualityThresholds(
        min_grade=_clean_grade(row.get(f"{prefix}_min_grade")),
        min_score=_clean_score(row.get(f"{prefix}_min_score")),
        block_on_severity=_clean_severity(row.get(f"{prefix}_block_on_severity")),
        enforcement=_clean_enforcement(row.get(f"{prefix}_enforcement")),
    )


def _override_roles_from(value: Any) -> Tuple[str, ...]:
    """Normalize the stored override-role list into lowercase slugs."""
    if not isinstance(value, (list, tuple)):
        return DEFAULT_OVERRIDE_ROLES
    roles = tuple(
        str(role).strip().lower() for role in value if str(role or "").strip()
    )
    return roles or ()


def policy_from_row(row: Optional[Mapping[str, Any]]) -> QualityPolicy:
    """Adapt an ``import_export_quality_policies`` row into a :class:`QualityPolicy`.

    Args:
        row: The stored policy row, or ``None`` when the tenant has none.

    Returns:
        The policy, or :data:`DEFAULT_POLICY` when ``row`` is ``None``.
    """
    if not row:
        return DEFAULT_POLICY
    overrides = row.get("format_overrides")
    try:
        ttl_hours = int(row.get("waiver_ttl_hours") or DEFAULT_WAIVER_TTL_HOURS)
    except (TypeError, ValueError):
        ttl_hours = DEFAULT_WAIVER_TTL_HOURS
    return QualityPolicy(
        policy_version_id=str(row["id"]) if row.get("id") else None,
        version_number=int(row.get("version_number") or 1),
        content_fingerprint=str(row.get("content_fingerprint") or "unknown"),
        import_thresholds=_thresholds_from_row(row, SCOPE_IMPORT),
        export_thresholds=_thresholds_from_row(row, SCOPE_EXPORT),
        format_overrides=overrides if isinstance(overrides, Mapping) else {},
        allow_override=bool(row.get("allow_override", True)),
        override_roles=_override_roles_from(row.get("override_roles")),
        waiver_ttl_hours=max(1, min(ttl_hours, 8760)),
        is_default=False,
    )


def load_tenant_policy(tenant_id: str) -> QualityPolicy:
    """Load the policy in force for a tenant.

    Never raises: a store failure degrades to the advisory default rather than blocking work on
    a policy that could not be read — a gate that fails closed on an infrastructure fault would
    stop every import in the tenant.

    Args:
        tenant_id: The tenant whose policy governs.

    Returns:
        The tenant's current policy, or :data:`DEFAULT_POLICY`.
    """
    if not tenant_id:
        return DEFAULT_POLICY
    try:
        row = db.get_latest_import_export_quality_policy(tenant_id)
    except Exception:  # noqa: BLE001 - an unreadable policy must not block the work it governs
        logger.warning(
            "Could not load the import/export quality policy for tenant %s; "
            "falling back to the advisory default",
            tenant_id,
            exc_info=True,
        )
        return DEFAULT_POLICY
    return policy_from_row(row)


#: Fields a per-format override block may state, in camelCase as stored.
_OVERRIDE_FIELDS: Mapping[str, str] = {
    "minGrade": "min_grade",
    "minScore": "min_score",
    "blockOnSeverity": "block_on_severity",
    "enforcement": "enforcement",
}


def resolve_thresholds(
    policy: QualityPolicy, *, scope: str, format_key: Optional[str]
) -> Tuple[QualityThresholds, str]:
    """Resolve the thresholds that apply, and name the tier that produced them.

    Resolution is deterministic and has exactly three tiers: a per-format override merged over
    the tenant tier, the tenant tier, then the built-in default.

    Args:
        policy: The tenant's policy (or the default).
        scope: ``import`` | ``export``.
        format_key: Adapter key (import) or export target, or ``None`` when unknown.

    Returns:
        ``(thresholds, source)`` where ``source`` is ``format_override`` | ``tenant`` |
        ``default``.
    """
    base = policy.thresholds_for(scope)
    source = "default" if policy.is_default else "tenant"

    # Keys are lowercased on save, but a policy row written by hand (or by an older client)
    # may not be, and "OpenAPI" must not silently stop gating "openapi".
    key = (format_key or "").strip().lower()
    override_block = (
        next(
            (
                block
                for stored, block in policy.format_overrides.items()
                if str(stored).strip().lower() == key
            ),
            None,
        )
        if key
        else None
    )
    if not isinstance(override_block, Mapping):
        return base, source
    scoped = override_block.get(scope)
    if not isinstance(scoped, Mapping):
        return base, source

    stated: List[str] = []
    values: Dict[str, Any] = {}
    for camel, field in _OVERRIDE_FIELDS.items():
        if camel not in scoped and field not in scoped:
            continue
        raw = scoped.get(camel, scoped.get(field))
        if field == "min_grade":
            values[field] = _clean_grade(raw)
        elif field == "min_score":
            values[field] = _clean_score(raw)
        elif field == "block_on_severity":
            values[field] = _clean_severity(raw)
        else:
            values[field] = _clean_enforcement(raw, default=base.enforcement)
        stated.append(field)
    if not stated:
        return base, source
    return base.merged_with(QualityThresholds(**values), override_fields=stated), "format_override"


# ---------------------------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------------------------


def _failures(
    thresholds: QualityThresholds,
    *,
    score: Optional[int],
    grade: Optional[str],
    severity_counts: Mapping[str, int],
) -> List[Dict[str, Any]]:
    """Every floor the candidate falls short of, in the order the UI reads them."""
    failures: List[Dict[str, Any]] = []
    if thresholds.min_score is not None and score is not None and score < thresholds.min_score:
        failures.append({"kind": "score", "required": thresholds.min_score, "actual": score})
    if not grade_meets(grade, thresholds.min_grade):
        failures.append({"kind": "grade", "required": thresholds.min_grade, "actual": grade})
    if thresholds.block_on_severity is not None:
        hits = severities_at_or_above(severity_counts, thresholds.block_on_severity)
        if hits > 0:
            failures.append(
                {"kind": "severity", "required": thresholds.block_on_severity, "actual": hits}
            )
    return failures


def _describe(failures: Sequence[Mapping[str, Any]]) -> str:
    """Render the shortfalls as one readable clause."""
    parts: List[str] = []
    for failure in failures:
        kind = failure.get("kind")
        if kind == "score":
            parts.append(f"score {failure['actual']} is below the required {failure['required']}")
        elif kind == "grade":
            actual = failure.get("actual") or "ungraded"
            parts.append(f"grade {actual} is below the required {failure['required']}")
        elif kind == "severity":
            parts.append(
                f"{failure['actual']} finding(s) at or above {failure['required']} severity"
            )
    return "; ".join(parts)


def evaluate_quality(
    *,
    policy: QualityPolicy,
    scope: str,
    format_key: Optional[str],
    score: Optional[int],
    grade: Optional[str],
    severity_counts: Optional[Mapping[str, int]] = None,
    waiver: Optional[Mapping[str, Any]] = None,
) -> QualityVerdict:
    """Evaluate one candidate against a policy.

    The rules, in order:

    1. No floor configured for this scope → ``pass``. This is the default policy's behaviour and
       the reason an upgrade changes nothing for an existing tenant.
    2. Every floor met → ``pass``.
    3. A floor missed under ``advisory`` enforcement → ``warn``, not blocking. The shortfall is
       reported so the tenant can see what a future ``block`` would cost them.
    4. A floor missed under ``block`` enforcement → ``block``, unless a waiver is supplied, in
       which case the verdict is ``warn`` and names the waiver.

    Args:
        policy: The tenant's policy (or the default).
        scope: ``import`` | ``export``.
        format_key: Adapter key (import) or export target, for override resolution.
        score: The candidate's 0-100 lint score, or ``None`` when unscored.
        grade: The candidate's letter grade, or ``None`` when ungraded.
        severity_counts: The candidate's per-severity finding tally.
        waiver: An active waiver row that covers this subject, or ``None``.

    Returns:
        The :class:`QualityVerdict`.
    """
    thresholds, source = resolve_thresholds(policy, scope=scope, format_key=format_key)
    counts = severity_counts or {}
    common = {
        "scope": scope,
        "source": source,
        "format_key": format_key,
        "thresholds": thresholds,
        "score": score,
        "grade": grade,
        "allow_override": policy.allow_override,
        "override_roles": policy.override_roles,
        "policy_version_id": policy.policy_version_id,
        "policy_content_fingerprint": policy.content_fingerprint,
    }

    if not thresholds.has_floor:
        return QualityVerdict(
            verdict="pass",
            blocking=False,
            reason=(
                DEFAULT_POLICY_REASON
                if policy.is_default
                else f"The tenant quality policy sets no {scope} floor, so nothing is blocked."
            ),
            **common,
        )

    failures = _failures(thresholds, score=score, grade=grade, severity_counts=counts)
    if not failures:
        return QualityVerdict(
            verdict="pass",
            blocking=False,
            reason=f"The candidate meets every {scope} quality floor this tenant requires.",
            **common,
        )

    detail = _describe(failures)
    if thresholds.enforcement != "block":
        return QualityVerdict(
            verdict="warn",
            blocking=False,
            reason=(
                f"Quality policy records a shortfall ({detail}) but is advisory for {scope}, "
                "so it does not block."
            ),
            failures=tuple(failures),
            **common,
        )

    if waiver:
        expires_at = waiver.get("expires_at")
        return QualityVerdict(
            verdict="warn",
            blocking=False,
            reason=(
                f"Quality policy would block this {scope} ({detail}), but an active waiver "
                "recorded by "
                f"{waiver.get('actor_label') or 'a permitted role'} covers it."
            ),
            failures=tuple(failures),
            waiver_id=str(waiver.get("id")) if waiver.get("id") else None,
            waiver_expires_at=str(expires_at) if expires_at else None,
            **common,
        )

    override_clause = (
        f" A waiver may be recorded by: {', '.join(policy.override_roles)}."
        if policy.allow_override and policy.override_roles
        else " This policy does not permit an override."
    )
    return QualityVerdict(
        verdict="block",
        blocking=True,
        reason=f"Quality policy blocks this {scope}: {detail}.{override_clause}",
        failures=tuple(failures),
        **common,
    )


def evaluate_export_quality(
    *,
    tenant_id: str,
    target_key: Optional[str],
    score: Optional[int],
    grade: Optional[str],
    severity_counts: Optional[Mapping[str, int]] = None,
    subject_key: Optional[str] = None,
) -> QualityVerdict:
    """Evaluate a source revision's quality against the tenant's **export** policy.

    The export half of the gate, kept here so the pre-flight ranking (IXH-2.4) and the delivery
    gate (IXH-2.5) share one implementation with import rather than growing a lookalike. Loads
    the tenant policy, honours an active export waiver for ``subject_key``, and returns the
    verdict; it neither reads nor writes any export state itself.

    Args:
        tenant_id: The tenant whose policy governs.
        target_key: The export target (``openapi``, ``grpc``, …) for override resolution.
        score: The source revision's lint score.
        grade: The source revision's lint grade.
        severity_counts: The source revision's per-severity tally.
        subject_key: Identity of the delivery subject (revision id + target), for waiver match.

    Returns:
        The :class:`QualityVerdict` for the delivery.
    """
    policy = load_tenant_policy(tenant_id)
    waiver = (
        find_active_waiver(
            tenant_id=tenant_id,
            scope=SCOPE_EXPORT,
            subject_key=subject_key,
            format_key=target_key,
        )
        if subject_key
        else None
    )
    return evaluate_quality(
        policy=policy,
        scope=SCOPE_EXPORT,
        format_key=target_key,
        score=score,
        grade=grade,
        severity_counts=severity_counts,
        waiver=waiver,
    )


# ---------------------------------------------------------------------------------------------
# Waivers
# ---------------------------------------------------------------------------------------------


def subject_key_for_document(raw: bytes) -> str:
    """The waiver match key for an import candidate: the SHA-256 of its bytes.

    The same value the pre-flight cache reports as ``content_hash``, so the wizard can record a
    waiver from the report it already has and the gate can match it on the commit without the
    client re-deriving anything.
    """
    return hashlib.sha256(raw).hexdigest()


def find_active_waiver(
    *,
    tenant_id: str,
    scope: str,
    subject_key: Optional[str],
    format_key: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """The newest unexpired waiver covering a subject, or ``None``.

    A waiver granted for one format never covers another format's gate for the same bytes, so a
    stored ``format_key`` must match the one being gated; a waiver stored without a format
    (recorded before the format was known) covers any.

    Never raises: a store failure means "no waiver", which is the safe direction — the gate then
    blocks rather than letting an unverifiable waiver through.

    Args:
        tenant_id: Tenant scope.
        scope: ``import`` | ``export``.
        subject_key: The subject identity to match.
        format_key: The adapter/target being gated.
        now: Instant to evaluate expiry against (injectable for tests).

    Returns:
        The waiver row, or ``None``.
    """
    if not tenant_id or not subject_key:
        return None
    instant = now or datetime.now(timezone.utc)
    try:
        rows = db.list_active_import_export_quality_waivers(
            tenant_id, scope=scope, subject_key=subject_key, now=instant
        )
    except Exception:  # noqa: BLE001 - an unreadable waiver ledger means "no waiver"
        logger.warning(
            "Could not read import/export quality waivers for tenant %s", tenant_id, exc_info=True
        )
        return None
    wanted = (format_key or "").strip().lower()
    for row in rows:
        stored = str(row.get("format_key") or "").strip().lower()
        if not stored or not wanted or stored == wanted:
            return dict(row)
    return None


def effective_role_slug(tenant_id: str, user_id: Optional[str]) -> Optional[str]:
    """The caller's effective role slug, resolved exactly like the permission guard.

    A ``tenant_administrators`` row is Owner-equivalent (the V118 rule the RBAC guard uses);
    otherwise the assigned ``tenant_user_roles`` slug wins; a member with no explicit role
    inherits ``editor``. A non-member has no role at all.

    Args:
        tenant_id: The tenant to resolve within.
        user_id: The acting user, or ``None`` for an unattributable (API key) call.

    Returns:
        The role slug, or ``None`` when the user is not a member.
    """
    if not tenant_id or not user_id:
        return None
    try:
        return db.get_effective_role_slug(tenant_id, user_id)
    except Exception:  # noqa: BLE001 - an unresolvable role is not an override
        logger.warning(
            "Could not resolve the effective role for user %s in tenant %s",
            user_id,
            tenant_id,
            exc_info=True,
        )
        return None


def role_may_override(policy: QualityPolicy, role: Optional[str]) -> bool:
    """Whether a role may record a waiver under this policy.

    Args:
        policy: The tenant's policy.
        role: The actor's effective role slug, or ``None``.

    Returns:
        True only when the policy permits overrides **and** names the actor's role. An empty
        role list means "nobody", not "everybody" — a tenant that clears the list has said no
        role may override.
    """
    if not policy.allow_override:
        return False
    return bool(role) and role in policy.override_roles


def record_quality_waiver(
    *,
    tenant_id: str,
    scope: str,
    subject_key: str,
    reason: str,
    policy: QualityPolicy,
    actor_user_id: Optional[str],
    actor_label: Optional[str],
    actor_role: Optional[str],
    subject_label: Optional[str] = None,
    format_key: Optional[str] = None,
    report_fingerprint: Optional[str] = None,
    score: Optional[int] = None,
    grade: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Persist one waiver with actor, reason, scope, and expiry.

    Expiry is ``now + policy.waiver_ttl_hours``; the shared CLX-4.2 sweep notifies the tenant as
    it approaches, and the gate stops honouring the waiver once it passes.

    Args:
        tenant_id: Tenant granting the waiver.
        scope: ``import`` | ``export``.
        subject_key: Subject identity the waiver covers (content hash / delivery subject).
        reason: The actor's stated justification (required, non-empty).
        policy: The policy in force, recorded on the row and supplying the TTL.
        actor_user_id: Granting user.
        actor_label: Human-readable actor label.
        actor_role: The actor's effective role at grant time.
        subject_label: Display label for the subject.
        format_key: Adapter key / export target the waiver applies to.
        report_fingerprint: Fingerprint of the waived lint report.
        score: Score at waiver time.
        grade: Grade at waiver time.
        now: Grant instant (injectable for tests).

    Returns:
        The inserted waiver row.

    Raises:
        ValueError: When the reason is blank.
    """
    justification = (reason or "").strip()
    if not justification:
        raise ValueError("A waiver requires a stated reason.")
    granted_at = now or datetime.now(timezone.utc)
    expires_at = granted_at + timedelta(hours=policy.waiver_ttl_hours)
    return db.insert_import_export_quality_waiver(
        tenant_id=tenant_id,
        scope=scope,
        subject_key=subject_key,
        subject_label=subject_label,
        format_key=(format_key or None),
        report_fingerprint=report_fingerprint,
        score=score,
        grade=grade,
        policy_version_id=policy.policy_version_id,
        policy_content_fingerprint=policy.content_fingerprint,
        reason=justification,
        expires_at=expires_at,
        actor_user_id=actor_user_id,
        actor_label=actor_label,
        actor_role=actor_role,
    )


# ---------------------------------------------------------------------------------------------
# Server-side import gate
# ---------------------------------------------------------------------------------------------


def policy_content_fingerprint(body: Mapping[str, Any]) -> str:
    """SHA-256 over the canonicalized policy body.

    Canonicalization is ``json.dumps(sort_keys=True, separators=(",", ":"))`` — the same shape
    the CLX-1.3 packs use — so the same policy content always fingerprints identically and a
    verdict can name the exact content it was produced under.

    Args:
        body: The policy body (thresholds, overrides, override contract).

    Returns:
        The 64-character hex digest.
    """
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def enforce_import_quality_gate(
    *,
    tenant_id: str,
    tenant_slug: str,
    user_id: Optional[str],
    raw: bytes,
    filename: Optional[str],
    content_type: Optional[str],
    source_kind: Optional[str],
    import_target: Optional[str],
    input_kind: Optional[str] = None,
    archive_root: Optional[str] = None,
) -> Optional[QualityVerdict]:
    """Refuse an import the tenant's policy blocks — server-side, before the job is created.

    The wizard's quality step (IXH-2.2) already shows the verdict, but a policy enforced only in
    a client is not enforced: the CLI, a script, and a stale browser tab all reach the same
    endpoint. This runs at the import-start route and is the actual gate.

    Cost is bounded by the *policy*, not by the document: a tenant whose import policy sets no
    floor (the default, and therefore every tenant on upgrade) returns immediately without
    touching the document. Only a tenant that configured a floor pays for a pre-flight run, and
    that run is served from the IXH-2.1 cache when the wizard just scored the same bytes.

    Args:
        tenant_id: The importing tenant.
        tenant_slug: Its slug (pre-flight provenance).
        user_id: The acting user.
        raw: The candidate document bytes.
        filename: Upload filename, when known.
        content_type: Upload content type, when known.
        source_kind: Explicitly requested adapter key, when the caller named one.
        import_target: Requested import target (catalog/types/project).
        input_kind: How the document arrived (file/url/paste/…).
        archive_root: Selected member of an archive payload, when applicable.

    Returns:
        The non-blocking verdict when the gate ran, or ``None`` when no policy applied (nothing
        was evaluated).

    Raises:
        QualityGateError: When policy blocks the import and no active waiver covers it.
    """
    policy = load_tenant_policy(tenant_id)
    if policy.is_default:
        return None

    # Resolution can tighten per format, so a tenant with no tenant-tier floor may still have a
    # format override that blocks. Skip only when *nothing* in the policy could ever block.
    if not _import_policy_can_block(policy):
        return None

    # Imported here rather than at module import: import_preflight imports the pipeline, which
    # imports every adapter, and this module is imported by the routes at startup.
    from .import_preflight import run_import_preflight  # noqa: PLC0415
    from .models import ImportPreflightRequest  # noqa: PLC0415

    request = ImportPreflightRequest(
        document_base64=base64.standard_b64encode(raw).decode("ascii"),
        source_kind=source_kind,
        filename=filename,
        content_type=content_type,
        input_kind=input_kind,
        import_target=import_target,
        archive_root=archive_root,
    )
    report = await run_import_preflight(
        request, tenant_id=tenant_id, tenant_slug=tenant_slug, user_id=user_id
    )
    if not report.ok or report.lint is None:
        # An unimportable candidate is not a policy problem — the pipeline will fail the job
        # with its own taxonomy code, which is a better error than "quality policy".
        return None

    subject_key = subject_key_for_document(raw)
    format_key = report.detection.adapter_key or source_kind
    waiver = find_active_waiver(
        tenant_id=tenant_id,
        scope=SCOPE_IMPORT,
        subject_key=subject_key,
        format_key=format_key,
    )
    verdict = evaluate_quality(
        policy=policy,
        scope=SCOPE_IMPORT,
        format_key=format_key,
        score=report.lint.score,
        grade=report.lint.grade,
        severity_counts=report.lint.severity_counts,
        waiver=waiver,
    )
    if verdict.blocking:
        raise QualityGateError(verdict)
    return verdict


def _import_policy_can_block(policy: QualityPolicy) -> bool:
    """Whether any import tier of this policy could produce a blocking verdict.

    Cheap pre-check so a tenant whose policy is configured but advisory (or configured only for
    export) never pays for a pre-flight run on the import path.
    """
    tenant_tier = policy.import_thresholds
    if tenant_tier.has_floor and tenant_tier.enforcement == "block":
        return True
    for key in policy.format_overrides:
        thresholds, _ = resolve_thresholds(policy, scope=SCOPE_IMPORT, format_key=str(key))
        if thresholds.has_floor and thresholds.enforcement == "block":
            return True
    return False
