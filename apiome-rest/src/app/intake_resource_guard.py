"""Resource guards for import intake — IXH-1.4 (#5090), IXH-6.5 (#5124).

Import intake parsed every uploaded document with a bare ``json.loads`` /
``yaml.safe_load`` (:func:`app.import_ingestion.parse_document`) — no size cap,
no alias-expansion cap, no depth cap. A YAML alias bomb was therefore a straight
out-of-memory, and a 10^5-deep flow document a stack exhaustion, on a code path
that runs during *format detection* for every document and for every member of an
uploaded archive.

IXH-1.4 applied the DCW-0.2 resource-limits artifact
(``src/app/data/oas_resource_limits.json``) at the intake seam via
:mod:`app.safe_oas_parse` primitives:

* **size** — UTF-8 byte ceiling, checked before any parse;
* **expansion** — YAML alias-expansion cost, bounding billion-laughs blowups
  before materialization;
* **depth** — a cheap pre-parse bound, then an exact iterative check on the
  parsed value, which also rejects self-referential alias cycles.

IXH-6.5 extends that into a documented :class:`GuardProfile` with additional
dimensions (raw vs decoded bytes, expansion ratio, entity count, ``$ref`` /
include depth and fan-out, per-stage wall-clock, per-job memory ceiling, archive
compression ratio), per-tenant-tier resolution (``default`` / ``elevated``), and
messages that name the limit and its configured value. The OAS artifact remains
the DCW field-for-field mirror; IXH-6.5-only dimensions live in
``src/app/data/intake_guard_profile.json`` (provisional until IXH-1.5 measurements).

Violations raise :class:`IntakeLimitError` carrying a resource-category taxonomy
code so a hostile document fails the job fast with actionable remediation.
Observability / metrics for these trips belong to IXH-6.6 (#5125), not here.
"""

from __future__ import annotations

import json
import os
import time
import tracemalloc
from contextlib import contextmanager
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterator, Mapping, Optional, Union

from .oas_resource_limits import resource_limit_values
from .safe_oas_parse import (
    PRE_SCAN_DEPTH_SLACK,
    analyze_nesting,
    pre_scan_depth_bound,
    yaml_alias_expansion_cost,
)

__all__ = [
    "GuardProfile",
    "IntakeLimits",
    "IntakeLimitError",
    "effective_intake_limits",
    "guard_document_size",
    "guard_document_text",
    "guard_expansion_ratio",
    "guard_parsed_document",
    "guard_payload_bytes",
    "guard_stage_memory",
    "load_guard_profile_artifact",
    "resolve_guard_profile",
    "stage_memory_tracker",
    "stage_wall_clock",
]

_DATA_DIR = Path(__file__).parent / "data"
INTAKE_GUARD_PROFILE_PATH = _DATA_DIR / "intake_guard_profile.json"

#: Known tier names. ``elevated`` multiplies selected ceilings by the artifact's
#: ``scaleFactor`` (default 2).
_DEFAULT_PROFILE = "default"
_ELEVATED_PROFILE = "elevated"
_ELEVATED_LICENSE_HINTS = frozenset(
    {
        "pro",
        "professional",
        "team",
        "business",
        "enterprise",
        "sponsor",
        "elevated",
        "paid",
    }
)


class IntakeLimitError(Exception):
    """An intake resource limit was exceeded.

    Attributes:
        code: The intake-taxonomy code for the breached limit.
        limit_name: Stable snake_case name of the dimension that tripped
            (e.g. ``max_decoded_bytes``), when known.
        limit_value: The configured ceiling for that dimension, when known.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str,
        limit_name: Optional[str] = None,
        limit_value: Any = None,
    ) -> None:
        if (
            limit_name is not None
            and limit_value is not None
            and f"{limit_name}=" not in message
        ):
            message = f"{message} (limit {limit_name}={limit_value})"
        super().__init__(message)
        self.code = code
        self.limit_name = limit_name
        self.limit_value = limit_value


@dataclass(frozen=True)
class IntakeLimits:
    """Numeric intake bounds in force for one document / stage.

    The first three fields are the IXH-1.4 / DCW-0.2 ceilings. The remaining
    fields are IXH-6.5 extensions; they carry provisional defaults so existing
    call sites that construct a tight three-field fixture still type-check.
    """

    max_bytes: int
    max_alias_cost: int
    max_depth: int
    max_raw_bytes: Optional[int] = None
    max_decoded_bytes: Optional[int] = None
    max_expansion_ratio: float = 10.0
    max_entity_count: int = 50_000
    max_ref_depth: int = 32
    max_ref_fanout: int = 64
    stage_wall_clock_seconds: float = 20.0
    job_memory_ceiling_bytes: int = 201_326_592  # 192 MiB
    archive_max_compression_ratio: float = 100.0

    def effective_raw_bytes(self) -> int:
        """Return the raw-upload ceiling (falls back to ``max_bytes``)."""
        return self.max_raw_bytes if self.max_raw_bytes is not None else self.max_bytes

    def effective_decoded_bytes(self) -> int:
        """Return the decoded-text ceiling (falls back to ``max_bytes``)."""
        return (
            self.max_decoded_bytes if self.max_decoded_bytes is not None else self.max_bytes
        )


@dataclass(frozen=True)
class GuardProfile:
    """Full documented guard profile for one tenant tier (IXH-6.5).

    Attributes:
        name: Tier name (``default`` or ``elevated``).
        limits: The numeric bounds applied at every intake stage.
        archive_max_entries: Archive entry-count ceiling (from deployment settings).
        archive_max_total_bytes: Uncompressed archive total ceiling.
        archive_max_file_bytes: Per-member uncompressed ceiling.
        archive_max_depth: Archive member path-depth ceiling.
    """

    name: str
    limits: IntakeLimits
    archive_max_entries: int = 500
    archive_max_total_bytes: int = 33_554_432
    archive_max_file_bytes: int = 8_388_608
    archive_max_depth: int = 32


@lru_cache(maxsize=1)
def load_guard_profile_artifact() -> Dict[str, Any]:
    """Load and cache the IXH-6.5 guard-profile artifact.

    Returns:
        The parsed artifact dict.

    Raises:
        ValueError: If the artifact is missing required structure.
    """
    artifact = json.loads(INTAKE_GUARD_PROFILE_PATH.read_text(encoding="utf-8"))
    for field in ("profileVersion", "profiles", "onViolation"):
        if field not in artifact:
            raise ValueError(f"intake_guard_profile.json is missing required field {field!r}")
    if _DEFAULT_PROFILE not in artifact["profiles"]:
        raise ValueError("intake_guard_profile.json is missing the 'default' profile")
    return artifact


def _int_limit(profile: Mapping[str, Any], key: str) -> int:
    entry = profile[key]
    value = entry["value"] if isinstance(entry, Mapping) else entry
    return int(value)


def _float_limit(profile: Mapping[str, Any], key: str) -> float:
    entry = profile[key]
    value = entry["value"] if isinstance(entry, Mapping) else entry
    return float(value)


def _base_limits_from_artifacts() -> IntakeLimits:
    """Compose OAS (DCW) ceilings with IXH-6.5 default profile dimensions."""
    oas = resource_limit_values()
    artifact = load_guard_profile_artifact()
    default = artifact["profiles"][_DEFAULT_PROFILE]
    return IntakeLimits(
        max_bytes=oas.max_document_bytes,
        max_alias_cost=oas.max_alias_count,
        max_depth=oas.max_nesting_depth,
        max_raw_bytes=oas.max_document_bytes,
        max_decoded_bytes=oas.max_document_bytes,
        max_expansion_ratio=_float_limit(default, "maxExpansionRatio"),
        max_entity_count=_int_limit(default, "maxEntityCount"),
        max_ref_depth=_int_limit(default, "maxRefDepth"),
        max_ref_fanout=_int_limit(default, "maxRefFanout"),
        stage_wall_clock_seconds=_float_limit(default, "stageWallClockSeconds"),
        job_memory_ceiling_bytes=_int_limit(default, "jobMemoryCeilingBytes"),
        archive_max_compression_ratio=_float_limit(default, "archiveMaxCompressionRatio"),
    )


def _archive_settings() -> Dict[str, int]:
    """Read archive ceilings from deployment settings when available."""
    try:
        from .config import settings

        return {
            "archive_max_entries": int(settings.archive_max_entries),
            "archive_max_total_bytes": int(settings.archive_max_total_bytes),
            "archive_max_file_bytes": int(settings.archive_max_file_bytes),
            "archive_max_depth": int(settings.archive_max_depth),
        }
    except Exception:
        return {
            "archive_max_entries": 500,
            "archive_max_total_bytes": 33_554_432,
            "archive_max_file_bytes": 8_388_608,
            "archive_max_depth": 32,
        }


def _env_profile_name() -> Optional[str]:
    try:
        from .config import settings

        name = getattr(settings, "intake_guard_profile", None)
        if isinstance(name, str) and name.strip():
            return name.strip().lower()
    except Exception:
        pass
    raw = os.environ.get("APIOME_GUARD_PROFILE", "").strip().lower()
    return raw or None


def _license_profile_hint(tenant_id: Optional[str]) -> Optional[str]:
    """Map a license seat plan name to ``elevated`` when it looks paid.

    Best-effort: missing license / DB must not block intake — fall back to
    ``default``. ``tenant_id`` is reserved for future per-tenant overrides.
    """
    del tenant_id  # reserved; resolution is deployment/license-scoped today
    try:
        from .config import settings

        plan = getattr(settings, "license_plan_hint", None)
        if isinstance(plan, str) and plan.strip().lower() in _ELEVATED_LICENSE_HINTS:
            return _ELEVATED_PROFILE
    except Exception:
        pass
    hint = os.environ.get("APIOME_LICENSE_PLAN_HINT", "").strip().lower()
    if hint in _ELEVATED_LICENSE_HINTS:
        return _ELEVATED_PROFILE
    return None


def resolve_guard_profile(
    *,
    tenant_id: Optional[str] = None,
    profile_name: Optional[str] = None,
) -> GuardProfile:
    """Resolve the effective :class:`GuardProfile` for a request.

    Resolution order (IXH-6.5):
      1. Explicit ``profile_name`` argument.
      2. ``APIOME_GUARD_PROFILE`` / settings override.
      3. License seat plan hint → ``elevated`` when paid-looking.
      4. ``default``.

    ``elevated`` multiplies byte, entity, wall-clock, and memory ceilings by the
    artifact ``scaleFactor`` (default 2). Expansion ratio, ref depth/fan-out, and
    archive compression ratio stay at the default values.
    """
    artifact = load_guard_profile_artifact()
    chosen = (profile_name or _env_profile_name() or _license_profile_hint(tenant_id) or _DEFAULT_PROFILE)
    chosen = chosen.strip().lower()
    if chosen not in artifact["profiles"]:
        chosen = _DEFAULT_PROFILE

    base = _base_limits_from_artifacts()
    if chosen == _ELEVATED_PROFILE:
        elevated = artifact["profiles"][_ELEVATED_PROFILE]
        factor = float(elevated.get("scaleFactor", 2))
        base = replace(
            base,
            max_bytes=int(base.max_bytes * factor),
            max_raw_bytes=int((base.max_raw_bytes or base.max_bytes) * factor),
            max_decoded_bytes=int((base.max_decoded_bytes or base.max_bytes) * factor),
            max_entity_count=int(base.max_entity_count * factor),
            stage_wall_clock_seconds=float(base.stage_wall_clock_seconds * factor),
            job_memory_ceiling_bytes=int(base.job_memory_ceiling_bytes * factor),
        )

    archive = _archive_settings()
    return GuardProfile(name=chosen, limits=base, **archive)


def effective_intake_limits() -> IntakeLimits:
    """Return the intake limits from the resolved default :class:`GuardProfile`.

    Returns:
        The :class:`IntakeLimits` for the default (or env-overridden) profile —
        OAS document ceilings plus IXH-6.5 dimensions.
    """
    return resolve_guard_profile().limits


def _where(source_label: Optional[str]) -> str:
    return f" ({source_label})" if source_label else ""


def _bounds(limits: Optional[Union[IntakeLimits, GuardProfile]]) -> IntakeLimits:
    if limits is None:
        return effective_intake_limits()
    if isinstance(limits, GuardProfile):
        return limits.limits
    return limits


def guard_document_size(
    text: str,
    *,
    source_label: Optional[str] = None,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
) -> None:
    """Reject a document larger than the decoded-byte ceiling.

    Args:
        text: Raw document text.
        source_label: Optional label used to make the error specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: ``INPUT_TOO_LARGE`` when the text exceeds the ceiling.
    """
    bounds = _bounds(limits)
    ceiling = bounds.effective_decoded_bytes()
    size = len(text.encode("utf-8", errors="replace"))
    if size > ceiling:
        raise IntakeLimitError(
            f"Source document is too large{_where(source_label)}: {size} bytes "
            f"exceeds limit max_decoded_bytes={ceiling}",
            code="INPUT_TOO_LARGE",
            limit_name="max_decoded_bytes",
            limit_value=ceiling,
        )


def guard_payload_bytes(
    raw: bytes,
    *,
    source_label: Optional[str] = None,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
) -> None:
    """Reject an oversized payload by byte length, before it is decoded to text.

    The bytes-level twin of :func:`guard_document_size`. Decoding a payload to
    ``str`` roughly doubles its footprint, and text-only formats (protobuf,
    GraphQL, IDLs) never reach the JSON/YAML guard, so the ceiling is applied to
    the raw upload first.

    Args:
        raw: The decoded upload bytes.
        source_label: Optional label used to make the error specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: ``INPUT_TOO_LARGE`` when the payload exceeds the ceiling.
    """
    bounds = _bounds(limits)
    ceiling = bounds.effective_raw_bytes()
    if len(raw) > ceiling:
        raise IntakeLimitError(
            f"Source document is too large{_where(source_label)}: {len(raw)} bytes "
            f"exceeds limit max_raw_bytes={ceiling}",
            code="INPUT_TOO_LARGE",
            limit_name="max_raw_bytes",
            limit_value=ceiling,
        )


def guard_expansion_ratio(
    *,
    raw_bytes: int,
    expanded_bytes: int,
    source_label: Optional[str] = None,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
) -> None:
    """Reject when expanded/decoded size exceeds the configured ratio of raw size.

    Args:
        raw_bytes: Source / compressed / encoded size.
        expanded_bytes: Decoded or expanded size.
        source_label: Optional label used to make the error specific.
        limits: Override bounds.

    Raises:
        IntakeLimitError: ``INPUT_EXPANSION_LIMIT`` when the ratio is exceeded.
    """
    bounds = _bounds(limits)
    if raw_bytes <= 0:
        return
    ratio = expanded_bytes / raw_bytes
    if ratio > bounds.max_expansion_ratio:
        raise IntakeLimitError(
            f"Source document expands too far{_where(source_label)}: ratio "
            f"{ratio:.1f}:1 exceeds limit max_expansion_ratio={bounds.max_expansion_ratio}",
            code="INPUT_EXPANSION_LIMIT",
            limit_name="max_expansion_ratio",
            limit_value=bounds.max_expansion_ratio,
        )


def _count_entities_and_refs(parsed: Any) -> tuple[int, int, int]:
    """Walk a parsed JSON/YAML value.

    Returns:
        ``(entity_count, max_ref_depth, max_ref_fanout)`` where entity_count is
        the number of dict/list nodes, ``max_ref_depth`` is the deepest chain of
        ``$ref`` / ``include`` edges along the walk, and ``max_ref_fanout`` is
        the largest number of ``$ref`` / ``include`` edges leaving one node
        (direct keys on a mapping, or ref-bearing children of a list).
    """
    entities = 0
    max_ref_depth = 0
    max_ref_fanout = 0
    stack: list[tuple[Any, int]] = [(parsed, 0)]
    seen: set[int] = set()

    def _is_ref_key(key: Any) -> bool:
        return key in ("$ref", "include")

    def _child_is_ref_object(value: Any) -> bool:
        return isinstance(value, dict) and (
            (isinstance(value.get("$ref"), str)) or (isinstance(value.get("include"), str))
        )

    while stack:
        node, ref_depth = stack.pop()
        node_id = id(node)
        if node_id in seen:
            continue
        if isinstance(node, (dict, list)):
            seen.add(node_id)
            entities += 1

        if isinstance(node, dict):
            fanout = 0
            for key, value in node.items():
                child_ref = ref_depth
                if _is_ref_key(key) and isinstance(value, str):
                    fanout += 1
                    child_ref = ref_depth + 1
                    if child_ref > max_ref_depth:
                        max_ref_depth = child_ref
                elif _child_is_ref_object(value):
                    fanout += 1
                if isinstance(value, (dict, list)):
                    # If this value itself carries $ref, deepen the chain for its walk.
                    next_ref = child_ref
                    if _child_is_ref_object(value) and not (
                        _is_ref_key(key) and isinstance(value, str)
                    ):
                        next_ref = ref_depth + 1
                        if next_ref > max_ref_depth:
                            max_ref_depth = next_ref
                    stack.append((value, next_ref if _child_is_ref_object(value) else child_ref))
            if fanout > max_ref_fanout:
                max_ref_fanout = fanout
        elif isinstance(node, list):
            fanout = sum(1 for item in node if _child_is_ref_object(item))
            if fanout > max_ref_fanout:
                max_ref_fanout = fanout
            for item in node:
                next_ref = ref_depth + 1 if _child_is_ref_object(item) else ref_depth
                if next_ref > max_ref_depth:
                    max_ref_depth = next_ref
                if isinstance(item, (dict, list)):
                    stack.append((item, next_ref))

    return entities, max_ref_depth, max_ref_fanout


def guard_document_text(
    text: str,
    *,
    source_label: Optional[str] = None,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
) -> None:
    """Run every pre-parse guard over raw document text.

    Checks size, YAML alias-expansion cost, expansion ratio against alias cost,
    and a conservative depth bound — all without materializing the document.

    Args:
        text: Raw document text.
        source_label: Optional label used to make errors specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: For an oversized, over-expanding, or too-deep document.
    """
    bounds = _bounds(limits)
    guard_document_size(text, source_label=source_label, limits=bounds)

    _documents, alias_cost, scan_failed = yaml_alias_expansion_cost(
        text, bounds.max_alias_cost
    )
    if not scan_failed and alias_cost > bounds.max_alias_cost:
        raise IntakeLimitError(
            f"Source document's aliases expand too far{_where(source_label)}: "
            f"expansion cost {alias_cost} exceeds limit max_alias_cost={bounds.max_alias_cost}",
            code="INPUT_EXPANSION_LIMIT",
            limit_name="max_alias_cost",
            limit_value=bounds.max_alias_cost,
        )

    bound = pre_scan_depth_bound(text)
    if bound > bounds.max_depth * PRE_SCAN_DEPTH_SLACK:
        raise IntakeLimitError(
            f"Source document nests too deeply{_where(source_label)}: at least "
            f"{bound} levels far exceeds limit max_nesting_depth={bounds.max_depth}",
            code="INPUT_DEPTH_LIMIT",
            limit_name="max_nesting_depth",
            limit_value=bounds.max_depth,
        )


def guard_parsed_document(
    parsed: Any,
    *,
    source_label: Optional[str] = None,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
) -> None:
    """Run post-parse depth, cycle, entity-count, and ``$ref`` guards.

    Args:
        parsed: The parsed JSON/YAML value.
        source_label: Optional label used to make errors specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: When depth, entities, or ``$ref``/include bounds trip.
    """
    bounds = _bounds(limits)
    depth, circular = analyze_nesting(parsed)
    if circular:
        raise IntakeLimitError(
            f"Source document contains a circular reference{_where(source_label)}: "
            "a YAML alias points at one of its own ancestors",
            code="INPUT_DEPTH_LIMIT",
            limit_name="max_nesting_depth",
            limit_value=bounds.max_depth,
        )
    if depth > bounds.max_depth:
        raise IntakeLimitError(
            f"Source document nests too deeply{_where(source_label)}: {depth} "
            f"levels exceeds limit max_nesting_depth={bounds.max_depth}",
            code="INPUT_DEPTH_LIMIT",
            limit_name="max_nesting_depth",
            limit_value=bounds.max_depth,
        )

    entities, ref_depth, ref_fanout = _count_entities_and_refs(parsed)
    if entities > bounds.max_entity_count:
        raise IntakeLimitError(
            f"Source document has too many entities{_where(source_label)}: "
            f"{entities} exceeds limit max_entity_count={bounds.max_entity_count}",
            code="INPUT_ENTITY_LIMIT",
            limit_name="max_entity_count",
            limit_value=bounds.max_entity_count,
        )
    if ref_depth > bounds.max_ref_depth:
        raise IntakeLimitError(
            f"Source document's $ref/include chain is too deep{_where(source_label)}: "
            f"{ref_depth} exceeds limit max_ref_depth={bounds.max_ref_depth}",
            code="INPUT_REF_LIMIT",
            limit_name="max_ref_depth",
            limit_value=bounds.max_ref_depth,
        )
    if ref_fanout > bounds.max_ref_fanout:
        raise IntakeLimitError(
            f"Source document's $ref/include fan-out is too wide{_where(source_label)}: "
            f"{ref_fanout} exceeds limit max_ref_fanout={bounds.max_ref_fanout}",
            code="INPUT_REF_LIMIT",
            limit_name="max_ref_fanout",
            limit_value=bounds.max_ref_fanout,
        )


@contextmanager
def stage_wall_clock(
    stage: str,
    *,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
    source_label: Optional[str] = None,
) -> Iterator[None]:
    """Context manager that enforces the per-stage wall-clock ceiling.

    Args:
        stage: Human-readable stage name (``detect``, ``parse``, …).
        limits: Override bounds.
        source_label: Optional label used to make the error specific.

    Raises:
        IntakeLimitError: ``INPUT_TIME_LIMIT`` when the stage overruns.
    """
    bounds = _bounds(limits)
    started = time.monotonic()
    yield
    elapsed = time.monotonic() - started
    if elapsed > bounds.stage_wall_clock_seconds:
        raise IntakeLimitError(
            f"Intake stage {stage!r} exceeded its wall-clock budget"
            f"{_where(source_label)}: {elapsed:.2f}s exceeds limit "
            f"stage_wall_clock_seconds={bounds.stage_wall_clock_seconds}",
            code="INPUT_TIME_LIMIT",
            limit_name="stage_wall_clock_seconds",
            limit_value=bounds.stage_wall_clock_seconds,
        )


def guard_stage_memory(
    *,
    peak_bytes: int,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
    source_label: Optional[str] = None,
) -> None:
    """Reject when a measured peak heap exceeds the per-job memory ceiling.

    Args:
        peak_bytes: Measured peak additional bytes (e.g. from ``tracemalloc``).
        limits: Override bounds.
        source_label: Optional label used to make the error specific.

    Raises:
        IntakeLimitError: ``INPUT_MEMORY_LIMIT`` when the ceiling is exceeded.
    """
    bounds = _bounds(limits)
    if peak_bytes > bounds.job_memory_ceiling_bytes:
        raise IntakeLimitError(
            f"Intake job exceeded its memory ceiling{_where(source_label)}: "
            f"{peak_bytes} bytes exceeds limit "
            f"job_memory_ceiling_bytes={bounds.job_memory_ceiling_bytes}",
            code="INPUT_MEMORY_LIMIT",
            limit_name="job_memory_ceiling_bytes",
            limit_value=bounds.job_memory_ceiling_bytes,
        )


@contextmanager
def stage_memory_tracker(
    *,
    limits: Optional[Union[IntakeLimits, GuardProfile]] = None,
    source_label: Optional[str] = None,
) -> Iterator[None]:
    """Track peak allocated bytes across a stage and enforce the memory ceiling.

    Starts ``tracemalloc`` if it is not already tracing. Nested use measures the
    *additional* peak observed during the stage (``peak_after - peak_before``).
    """
    started_here = False
    if not tracemalloc.is_tracing():
        tracemalloc.start()
        started_here = True
    _current, peak_before = tracemalloc.get_traced_memory()
    try:
        yield
        _current_after, peak_after = tracemalloc.get_traced_memory()
        guard_stage_memory(
            peak_bytes=max(0, peak_after - peak_before),
            limits=limits,
            source_label=source_label,
        )
    finally:
        if started_here:
            tracemalloc.stop()
