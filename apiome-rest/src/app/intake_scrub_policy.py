"""Tenant secret-scrub policy for import intake — MFI-29.6 (#4393).

:mod:`app.intake_secret_scrub` decides *what* looks like a credential. This module decides
*what intake does about it*, per tenant:

* **enforce** — the persisted source is the redacted text. This is the shipped default and
  the behaviour every tenant already has (IXH-1.4 scrubbed unconditionally).
* **warn_only** — the findings are reported on the job summary exactly as under ``enforce``,
  and the content persists **unmodified**. The mode a tenant runs while onboarding a corpus,
  to see what redaction would cost before paying it.

Resolution
----------
Four tiers, in order, and the winner is named on every scrub report so nobody has to guess
which one applied:

1. **format override** — the tenant policy's ``format_overrides[<adapter key>]["mode"]``.
   An explicit tenant decision about one format beats everything, including tier 2.
2. **format default** — :data:`ALWAYS_ENFORCED_FORMATS`. HAR, Insomnia, Bruno, Postman and
   ``.http`` request files (MFI-EPIC-32) are recordings of real traffic: a bearer token or a
   session cookie is not an edge case in them, it is the normal content. They resolve to
   ``enforce`` even when the tenant tier says otherwise, which is what MFI-32.5 gates on.
   A tenant that genuinely needs warn-only for one of them must say so per format (tier 1),
   which is a deliberate, auditable act rather than a side effect of a global setting.
3. **tenant** — the tenant's current policy row (the highest ``version_number``).
4. **default** — :data:`DEFAULT_POLICY`: enforce, entropy detection on. A tenant with no
   policy row runs this, so upgrading changes no behaviour.

Entropy detection is a policy field rather than a mode because it is orthogonal: it says
which *detector* runs, not what happens to what it finds. The named credential patterns are
not switchable at all — a tenant may tune a heuristic, not disable credential scrubbing.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Mapping, Optional, Tuple

from .database import db
from .import_export_quality_policy import policy_content_fingerprint

logger = logging.getLogger(__name__)

__all__ = [
    "ALWAYS_ENFORCED_FORMATS",
    "DEFAULT_POLICY",
    "MODE_ENFORCE",
    "MODE_WARN_ONLY",
    "SCRUB_MODES",
    "ScrubPolicy",
    "ScrubResolution",
    "TIER_DEFAULT",
    "TIER_FORMAT_DEFAULT",
    "TIER_FORMAT_OVERRIDE",
    "TIER_TENANT",
    "load_tenant_scrub_policy",
    "normalize_mode",
    "resolve_scrub_mode",
    "scrub_policy_content_fingerprint",
    "scrub_policy_from_row",
]

#: Redact the persisted source in place.
MODE_ENFORCE = "enforce"
#: Report the findings and persist the content unmodified.
MODE_WARN_ONLY = "warn_only"
#: The complete mode vocabulary, in the order the API documents it.
SCRUB_MODES: Tuple[str, ...] = (MODE_ENFORCE, MODE_WARN_ONLY)

#: Resolution tiers, reported as ``policy_tier`` on the scrub report.
TIER_FORMAT_OVERRIDE = "format_override"
TIER_FORMAT_DEFAULT = "format_default"
TIER_TENANT = "tenant"
TIER_DEFAULT = "default"

#: Adapter keys that resolve to :data:`MODE_ENFORCE` unless the tenant overrides that format
#: by name. These are the MFI-EPIC-32 collection and captured-traffic formats plus the
#: request-file adapter that shares their inferred-spec pipeline (IXH-7.4): all of them carry
#: real request material — bearer tokens, cookie jars, signed URLs — as a matter of course.
#: ``kong`` (IXH-7.8) is listed for the same reason: declarative configs routinely embed
#: consumer credentials (key-auth keys, basic-auth passwords, JWT secrets).
#: Keys match :attr:`app.import_source.ImportSource.key`; listing a format that does not exist
#: yet is harmless, and is how 29.6 lands ahead of the adapters it protects.
ALWAYS_ENFORCED_FORMATS: FrozenSet[str] = frozenset(
    {"bruno", "har", "http-file", "insomnia", "kong", "postman"}
)


@dataclass(frozen=True)
class ScrubPolicy:
    """A tenant's intake secret-scrub policy as the pipeline reads it.

    Attributes:
        policy_version_id: Row id of the policy version, or ``None`` for the built-in default.
        version_number: Monotonic version number, or ``0`` for the default.
        content_fingerprint: Fingerprint of the policy body (``"default"`` for the default).
        mode: Tenant-tier mode — :data:`MODE_ENFORCE` or :data:`MODE_WARN_ONLY`.
        entropy_detection: Whether the high-entropy heuristic runs alongside the named
            credential patterns.
        format_overrides: Raw ``{adapter key: {"mode": ...}}`` override map.
        is_default: True when no tenant policy row exists.
    """

    policy_version_id: Optional[str] = None
    version_number: int = 0
    content_fingerprint: str = "default"
    mode: str = MODE_ENFORCE
    entropy_detection: bool = True
    format_overrides: Mapping[str, Any] = None  # type: ignore[assignment]
    is_default: bool = True

    def __post_init__(self) -> None:  # pragma: no cover - trivial normalization
        if self.format_overrides is None:
            object.__setattr__(self, "format_overrides", {})


#: The policy a tenant runs with no saved row: scrub everything, report it, redact it.
DEFAULT_POLICY = ScrubPolicy()


@dataclass(frozen=True)
class ScrubResolution:
    """The mode in force for one import, and where it came from.

    Attributes:
        mode: :data:`MODE_ENFORCE` or :data:`MODE_WARN_ONLY`.
        tier: Which resolution tier produced it — ``format_override`` | ``format_default`` |
            ``tenant`` | ``default``.
        entropy_detection: Whether the entropy heuristic runs for this import.
        format_key: The adapter key the mode was resolved for, when known.
        policy_version_id: Policy version applied, or ``None`` for the default.
        policy_content_fingerprint: Fingerprint of that policy version.
    """

    mode: str = MODE_ENFORCE
    tier: str = TIER_DEFAULT
    entropy_detection: bool = True
    format_key: Optional[str] = None
    policy_version_id: Optional[str] = None
    policy_content_fingerprint: str = "default"

    @property
    def enforced(self) -> bool:
        """Whether the redacted text is the text that gets persisted."""
        return self.mode == MODE_ENFORCE

    def as_report_fields(self) -> Dict[str, Any]:
        """Return the policy provenance block merged into every scrub report."""
        return {
            "mode": self.mode,
            "applied": self.enforced,
            "policy_tier": self.tier,
            "entropy_detection": self.entropy_detection,
            "format_key": self.format_key,
            "policy_version_id": self.policy_version_id,
            "policy_content_fingerprint": self.policy_content_fingerprint,
        }


def normalize_mode(value: Any, *, fallback: str = MODE_ENFORCE) -> str:
    """Coerce a stored or submitted mode into the vocabulary, falling back safely.

    An unrecognized mode resolves to ``fallback`` (enforce, at every call site) rather than
    raising: a policy row that somehow holds a mode this build does not know must not stop
    scrubbing, and must not be read as permission to skip it.

    Args:
        value: The candidate mode.
        fallback: The mode to use when ``value`` is missing or unknown.

    Returns:
        A member of :data:`SCRUB_MODES`.
    """
    candidate = str(value or "").strip().lower().replace("-", "_")
    return candidate if candidate in SCRUB_MODES else fallback


def scrub_policy_from_row(row: Optional[Mapping[str, Any]]) -> ScrubPolicy:
    """Adapt an ``intake_secret_scrub_policies`` row into a :class:`ScrubPolicy`.

    Args:
        row: The stored policy row, or ``None`` when the tenant has none.

    Returns:
        The policy, or :data:`DEFAULT_POLICY` when ``row`` is ``None``.
    """
    if not row:
        return DEFAULT_POLICY
    overrides = row.get("format_overrides")
    return ScrubPolicy(
        policy_version_id=str(row["id"]) if row.get("id") else None,
        version_number=int(row.get("version_number") or 1),
        content_fingerprint=str(row.get("content_fingerprint") or "unknown"),
        mode=normalize_mode(row.get("mode")),
        entropy_detection=bool(row.get("entropy_detection", True)),
        format_overrides=overrides if isinstance(overrides, Mapping) else {},
        is_default=False,
    )


def load_tenant_scrub_policy(tenant_id: Optional[str]) -> ScrubPolicy:
    """Load the scrub policy in force for a tenant.

    Never raises. A store failure degrades to :data:`DEFAULT_POLICY`, which is the *strict*
    end of the range — unlike a quality gate, where failing closed would block work, failing
    closed here only means a credential is redacted from stored material.

    Args:
        tenant_id: The tenant whose policy governs; ``None``/blank yields the default.

    Returns:
        The tenant's current policy, or :data:`DEFAULT_POLICY`.
    """
    if not tenant_id:
        return DEFAULT_POLICY
    try:
        row = db.get_latest_intake_secret_scrub_policy(str(tenant_id))
    except Exception:  # noqa: BLE001 - an unreadable policy must never disable scrubbing
        logger.warning(
            "Could not load the intake secret-scrub policy for tenant %s; "
            "falling back to enforce",
            tenant_id,
            exc_info=True,
        )
        return DEFAULT_POLICY
    return scrub_policy_from_row(row)


def resolve_scrub_mode(
    policy: ScrubPolicy, *, format_key: Optional[str] = None
) -> ScrubResolution:
    """Resolve the mode that governs one import, and name the tier that produced it.

    See the module docstring for the tier order. In short: an explicit per-format override
    wins; failing that, an MFI-EPIC-32 collection/capture format is always enforced; failing
    that, the tenant tier applies; failing that, the default.

    Args:
        policy: The tenant's policy (or :data:`DEFAULT_POLICY`).
        format_key: The adapter key the import is running under, when known. ``None`` skips
            both format tiers.

    Returns:
        The :class:`ScrubResolution` in force.
    """
    key = str(format_key or "").strip().lower() or None
    base = ScrubResolution(
        entropy_detection=policy.entropy_detection,
        format_key=key,
        policy_version_id=policy.policy_version_id,
        policy_content_fingerprint=policy.content_fingerprint,
    )

    override = (policy.format_overrides or {}).get(key) if key else None
    if isinstance(override, Mapping) and override.get("mode") is not None:
        # An unknown mode in an override falls back to the tenant tier rather than to
        # enforce, so a typo does not silently look like a deliberate tightening.
        mode = normalize_mode(override.get("mode"), fallback=policy.mode)
        return _replace_mode(base, mode, TIER_FORMAT_OVERRIDE)

    if key and key in ALWAYS_ENFORCED_FORMATS:
        return _replace_mode(base, MODE_ENFORCE, TIER_FORMAT_DEFAULT)

    if not policy.is_default:
        return _replace_mode(base, normalize_mode(policy.mode), TIER_TENANT)

    return _replace_mode(base, DEFAULT_POLICY.mode, TIER_DEFAULT)


def _replace_mode(base: ScrubResolution, mode: str, tier: str) -> ScrubResolution:
    """Return ``base`` carrying a resolved mode and the tier that decided it."""
    return ScrubResolution(
        mode=mode,
        tier=tier,
        entropy_detection=base.entropy_detection,
        format_key=base.format_key,
        policy_version_id=base.policy_version_id,
        policy_content_fingerprint=base.policy_content_fingerprint,
    )


def scrub_policy_content_fingerprint(
    *, mode: str, entropy_detection: bool, format_overrides: Mapping[str, Any]
) -> str:
    """SHA-256 over the canonicalized scrub-policy body.

    Shares :func:`app.import_export_quality_policy.policy_content_fingerprint` so both
    governance surfaces canonicalize a policy the same way.

    Args:
        mode: The tenant-tier mode.
        entropy_detection: Whether the entropy heuristic is enabled.
        format_overrides: The per-format override map.

    Returns:
        The 64-character hex digest.
    """
    return policy_content_fingerprint(
        {
            "mode": mode,
            "entropyDetection": bool(entropy_detection),
            "formatOverrides": dict(format_overrides or {}),
        }
    )
