"""Declared-vs-observed attribution for one MCP endpoint's surface — FMT-1.7 (#5418).

Once a server can enter the catalog two ways, every fact about it acquires a second
question. "This tool takes a ``ticketId``" is no longer one statement — it is either
something Apiome *watched the server say* during discovery, or something an operator
*told Apiome* in a manifest, or both. Those are not the same claim, and a detail view that
renders them identically has quietly turned a description into an observation.

This module answers "how do we know this?" for every fact on an endpoint's surface. It
takes the declared surface (from :func:`app.mcp_manifest_parser.manifest_surface`) and the
observed one (from :func:`app.mcp_discovery_engine.reconstruct_surface`), either of which
may be absent, and attributes each fact to one of three origins:

``declared``
    Only the manifest carries it. Nothing has watched the server offer it.
``observed``
    Only a probe saw it. The manifest is silent — either older than the fact, or wrong.
``both``
    Both sources carry it, and then the *agreement* matters: identical values corroborate
    each other, differing values are a **conflict** the reader has to resolve and Apiome
    must not resolve for them by picking a winner.

Pure: no database, no network, no clock. :func:`build_surface_provenance` is a
deterministic function of the two surfaces handed to it, so it is unit-testable with plain
fixtures and produces the same answer on every host.

Honesty rules, inherited from the MCP provenance strip (:mod:`app.mcp_provenance`)
----------------------------------------------------------------------------------
* **Absence is never evidence.** An endpoint with no manifest reads as "no declared
  source", never as "the manifest agrees".
* **A conflict is reported, never resolved.** Where the two disagree, both values are
  carried and the fact is marked ``conflicts``. Nothing here decides which is right.
* **Comparison uses the fingerprint projection.** Two facts count as equal exactly when
  the surface fingerprint would treat them as equal — the same semantic projection, with
  volatile fields (``_meta``, a resource's ``size`` hint, vendor keys) already excluded.
  So a fact cannot be reported as conflicting while the two surfaces fingerprint alike,
  and it cannot be reported as agreeing while they do not.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .mcp_client.normalize import ITEM_TYPES, CapabilityItem, DiscoverySurface

__all__ = [
    "AGREEMENTS",
    "AGREEMENT_AGREES",
    "AGREEMENT_CONFLICTS",
    "AGREEMENT_UNCONTESTED",
    "ORIGINS",
    "ORIGIN_BOTH",
    "ORIGIN_DECLARED",
    "ORIGIN_OBSERVED",
    "SURFACE_FIELD_LABELS",
    "SURFACE_MATCH_DECLARED_ONLY",
    "SURFACE_MATCH_DIVERGENT",
    "SURFACE_MATCH_IDENTICAL",
    "SURFACE_MATCH_NONE",
    "SURFACE_MATCH_OBSERVED_ONLY",
    "SurfaceFact",
    "SurfaceProvenance",
    "build_surface_provenance",
    "origin_label",
]

#: The fact came only from a declared manifest.
ORIGIN_DECLARED = "declared"

#: The fact came only from a live probe.
ORIGIN_OBSERVED = "observed"

#: Both sources carry the fact (see the fact's ``agreement`` for whether they concur).
ORIGIN_BOTH = "both"

#: Every origin, in the order a summary counts them.
ORIGINS: Tuple[str, ...] = (ORIGIN_OBSERVED, ORIGIN_DECLARED, ORIGIN_BOTH)

#: Human labels for each origin, spelled once so REST and UI cannot drift.
ORIGIN_LABELS: Dict[str, str] = {
    ORIGIN_DECLARED: "Declared in a manifest",
    ORIGIN_OBSERVED: "Observed during discovery",
    ORIGIN_BOTH: "Declared and observed",
}

#: Only one source carries the fact, so there is nothing to agree or disagree with.
AGREEMENT_UNCONTESTED = "uncontested"

#: Both sources carry the fact and their values are semantically identical.
AGREEMENT_AGREES = "agrees"

#: Both sources carry the fact and their values differ.
AGREEMENT_CONFLICTS = "conflicts"

#: Every agreement state, in stable order.
AGREEMENTS: Tuple[str, ...] = (AGREEMENT_UNCONTESTED, AGREEMENT_AGREES, AGREEMENT_CONFLICTS)

#: Neither a manifest nor a probe has produced a surface for this endpoint.
SURFACE_MATCH_NONE = "none"

#: Only a manifest has; nothing has been observed.
SURFACE_MATCH_DECLARED_ONLY = "declared_only"

#: Only a probe has; no manifest is attached.
SURFACE_MATCH_OBSERVED_ONLY = "observed_only"

#: Both exist and their surface fingerprints are equal — the manifest describes exactly
#: what discovery saw.
SURFACE_MATCH_IDENTICAL = "identical"

#: Both exist and their fingerprints differ — at least one fact conflicts or is missing
#: from one side.
SURFACE_MATCH_DIVERGENT = "divergent"

#: The surface-level (non-item) facts, in render order, with the label a reader sees.
#: These mirror :data:`app.mcp_client.normalize.FINGERPRINT_SURFACE_FIELDS`, with
#: ``serverInfo`` expanded into the three fields a reader actually compares.
SURFACE_FIELD_LABELS: Tuple[Tuple[str, str], ...] = (
    ("protocolVersion", "Protocol version"),
    ("serverInfo.name", "Server name"),
    ("serverInfo.title", "Server title"),
    ("serverInfo.version", "Server version"),
    ("instructions", "Instructions"),
    ("capabilities", "Declared capabilities"),
)

#: Human labels for each capability kind, for the fact's ``kind_label``.
_ITEM_TYPE_LABELS: Dict[str, str] = {
    "tool": "Tool",
    "resource": "Resource",
    "resource_template": "Resource template",
    "prompt": "Prompt",
}


def origin_label(origin: Optional[str]) -> str:
    """Human label for a fact's origin.

    Args:
        origin: One of :data:`ORIGINS`, or ``None``/unknown.

    Returns:
        The display label; an unknown or missing origin reads as ``"Unrecorded"`` rather
        than being presented as any concrete source.
    """
    if origin is None:
        return "Unrecorded"
    return ORIGIN_LABELS.get(str(origin), "Unrecorded")


@dataclass(frozen=True)
class SurfaceFact:
    """One attributable fact about an endpoint's surface.

    Attributes:
        scope: ``surface`` for an identity/capability field, or the capability kind
            (``tool`` / ``resource`` / ``resource_template`` / ``prompt``) for an item.
        key: Stable identifier within the scope — the field path
            (``serverInfo.version``) or the item's ``name``.
        label: What a reader sees for this fact.
        kind_label: Human label for the fact's scope (``Tool``, ``Server version``, …).
        origin: One of :data:`ORIGINS`.
        agreement: One of :data:`AGREEMENTS`.
        declared: The declared value, or ``None`` when the manifest is silent.
        observed: The observed value, or ``None`` when no probe saw it.
    """

    scope: str
    key: str
    label: str
    kind_label: str
    origin: str
    agreement: str
    declared: Any = None
    observed: Any = None

    def to_dict(self) -> Dict[str, Any]:
        """Return the serializable form used by the REST response and the UI."""
        return {
            "scope": self.scope,
            "key": self.key,
            "label": self.label,
            "kind_label": self.kind_label,
            "origin": self.origin,
            "origin_label": origin_label(self.origin),
            "agreement": self.agreement,
            "declared": self.declared,
            "observed": self.observed,
        }


@dataclass(frozen=True)
class SurfaceProvenance:
    """The full declared-vs-observed attribution for one endpoint.

    Attributes:
        surface_match: One of the ``SURFACE_MATCH_*`` constants.
        declared_fingerprint: The manifest surface's fingerprint, when one exists.
        observed_fingerprint: The probed surface's fingerprint, when one exists.
        fingerprints_match: ``True`` only when both exist and are equal.
        facts: Every attributable fact, surface-level first then items in canonical
            (kind, name) order.
        origin_counts: Fact count per origin.
        conflict_count: Number of facts whose two sources disagree.
    """

    surface_match: str
    declared_fingerprint: Optional[str] = None
    observed_fingerprint: Optional[str] = None
    fingerprints_match: bool = False
    facts: Tuple[SurfaceFact, ...] = ()
    origin_counts: Dict[str, int] = field(default_factory=dict)
    conflict_count: int = 0

    def conflicts(self) -> Tuple[SurfaceFact, ...]:
        """Every fact whose declared and observed values disagree, in fact order."""
        return tuple(fact for fact in self.facts if fact.agreement == AGREEMENT_CONFLICTS)

    def to_dict(self) -> Dict[str, Any]:
        """Return the serializable form used by the REST response and the UI."""
        return {
            "surface_match": self.surface_match,
            "declared_fingerprint": self.declared_fingerprint,
            "observed_fingerprint": self.observed_fingerprint,
            "fingerprints_match": self.fingerprints_match,
            "origin_counts": dict(self.origin_counts),
            "conflict_count": self.conflict_count,
            "facts": [fact.to_dict() for fact in self.facts],
        }


def build_surface_provenance(
    *,
    declared: Optional[DiscoverySurface] = None,
    observed: Optional[DiscoverySurface] = None,
) -> SurfaceProvenance:
    """Attribute every fact on an endpoint's surface to the source(s) that carry it.

    Args:
        declared: The surface a manifest declares, or ``None`` when none is attached.
        observed: The surface a probe recorded, or ``None`` when the endpoint has never
            been discovered.

    Returns:
        The :class:`SurfaceProvenance`. With neither surface the result is an empty
        report whose ``surface_match`` is :data:`SURFACE_MATCH_NONE` — never a claim that
        the two agree.
    """
    declared_fingerprint = declared.fingerprint() if declared is not None else None
    observed_fingerprint = observed.fingerprint() if observed is not None else None
    fingerprints_match = (
        declared_fingerprint is not None
        and observed_fingerprint is not None
        and declared_fingerprint == observed_fingerprint
    )

    facts: List[SurfaceFact] = []
    facts.extend(_surface_field_facts(declared, observed))
    facts.extend(_item_facts(declared, observed))

    origin_counts = {origin: 0 for origin in ORIGINS}
    for fact in facts:
        origin_counts[fact.origin] = origin_counts.get(fact.origin, 0) + 1

    return SurfaceProvenance(
        surface_match=_surface_match(declared, observed, fingerprints_match),
        declared_fingerprint=declared_fingerprint,
        observed_fingerprint=observed_fingerprint,
        fingerprints_match=fingerprints_match,
        facts=tuple(facts),
        origin_counts=origin_counts,
        conflict_count=sum(1 for fact in facts if fact.agreement == AGREEMENT_CONFLICTS),
    )


def _surface_match(
    declared: Optional[DiscoverySurface],
    observed: Optional[DiscoverySurface],
    fingerprints_match: bool,
) -> str:
    """Classify the relationship between the two surfaces.

    Args:
        declared: The declared surface, if any.
        observed: The observed surface, if any.
        fingerprints_match: Whether both exist and fingerprint identically.

    Returns:
        One of the ``SURFACE_MATCH_*`` constants.
    """
    if declared is None and observed is None:
        return SURFACE_MATCH_NONE
    if observed is None:
        return SURFACE_MATCH_DECLARED_ONLY
    if declared is None:
        return SURFACE_MATCH_OBSERVED_ONLY
    return SURFACE_MATCH_IDENTICAL if fingerprints_match else SURFACE_MATCH_DIVERGENT


def _surface_field_facts(
    declared: Optional[DiscoverySurface],
    observed: Optional[DiscoverySurface],
) -> List[SurfaceFact]:
    """Attribute the surface-level identity fields.

    Args:
        declared: The declared surface, if any.
        observed: The observed surface, if any.

    Returns:
        One fact per field in :data:`SURFACE_FIELD_LABELS` that at least one side carries.
        A field neither side states is omitted entirely rather than reported as an empty
        agreement.
    """
    declared_values = _surface_field_values(declared)
    observed_values = _surface_field_values(observed)

    facts: List[SurfaceFact] = []
    for key, label in SURFACE_FIELD_LABELS:
        declared_value = declared_values.get(key)
        observed_value = observed_values.get(key)
        if _is_absent(declared_value) and _is_absent(observed_value):
            continue
        facts.append(
            _fact(
                scope="surface",
                key=key,
                label=label,
                kind_label="Server identity",
                declared_value=declared_value,
                observed_value=observed_value,
            )
        )
    return facts


def _surface_field_values(surface: Optional[DiscoverySurface]) -> Dict[str, Any]:
    """Project a surface onto the flat field map :data:`SURFACE_FIELD_LABELS` indexes.

    Reads from :meth:`~app.mcp_client.normalize.DiscoverySurface.canonical_dict` — the same
    semantic projection the fingerprint is taken over — so a field that cannot move the
    fingerprint cannot show up here as a conflict.

    Args:
        surface: The surface to project, or ``None``.

    Returns:
        Field path → value; empty for ``None``.
    """
    if surface is None:
        return {}
    canonical = surface.canonical_dict()
    server_info = canonical.get("serverInfo") or {}
    return {
        "protocolVersion": canonical.get("protocolVersion"),
        "serverInfo.name": server_info.get("name"),
        "serverInfo.title": server_info.get("title"),
        "serverInfo.version": server_info.get("version"),
        "instructions": canonical.get("instructions"),
        "capabilities": canonical.get("capabilities"),
    }


def _item_facts(
    declared: Optional[DiscoverySurface],
    observed: Optional[DiscoverySurface],
) -> List[SurfaceFact]:
    """Attribute every capability item across both surfaces.

    Items are matched by ``(item_type, name)`` — the identity MCP itself uses, and the one
    the surface diff engine lines versions up by — so a tool whose schema changed is one
    conflicting fact rather than an addition beside a removal.

    Args:
        declared: The declared surface, if any.
        observed: The observed surface, if any.

    Returns:
        One fact per distinct item, in canonical (kind, name) order.
    """
    declared_items = _items_by_identity(declared)
    observed_items = _items_by_identity(observed)

    facts: List[SurfaceFact] = []
    for item_type in ITEM_TYPES:
        names = sorted(
            {
                name
                for (kind, name) in (*declared_items, *observed_items)
                if kind == item_type
            }
        )
        for name in names:
            declared_item = declared_items.get((item_type, name))
            observed_item = observed_items.get((item_type, name))
            facts.append(
                _fact(
                    scope=item_type,
                    key=name,
                    label=name,
                    kind_label=_ITEM_TYPE_LABELS.get(item_type, item_type),
                    declared_value=declared_item.fingerprint_projection()
                    if declared_item is not None
                    else None,
                    observed_value=observed_item.fingerprint_projection()
                    if observed_item is not None
                    else None,
                )
            )
    return facts


def _items_by_identity(
    surface: Optional[DiscoverySurface],
) -> Dict[Tuple[str, str], CapabilityItem]:
    """Index a surface's items by ``(item_type, name)``.

    Args:
        surface: The surface to index, or ``None``.

    Returns:
        The index; empty for ``None``. A duplicate ``(kind, name)`` — which a
        well-behaved server never emits — keeps the first occurrence, so the report is
        deterministic rather than dependent on iteration order.
    """
    if surface is None:
        return {}
    indexed: Dict[Tuple[str, str], CapabilityItem] = {}
    for item in surface.all_items():
        indexed.setdefault((item.item_type, item.name), item)
    return indexed


def _fact(
    *,
    scope: str,
    key: str,
    label: str,
    kind_label: str,
    declared_value: Any,
    observed_value: Any,
) -> SurfaceFact:
    """Build one fact, deriving its origin and agreement from the two values.

    Args:
        scope: ``surface`` or the capability kind.
        key: Stable identifier within the scope.
        label: Display label.
        kind_label: Display label for the scope.
        declared_value: The manifest's value, or ``None``/absent.
        observed_value: The probe's value, or ``None``/absent.

    Returns:
        The :class:`SurfaceFact`.
    """
    has_declared = not _is_absent(declared_value)
    has_observed = not _is_absent(observed_value)

    if has_declared and has_observed:
        origin = ORIGIN_BOTH
        agreement = (
            AGREEMENT_AGREES
            if _canonical(declared_value) == _canonical(observed_value)
            else AGREEMENT_CONFLICTS
        )
    elif has_declared:
        origin, agreement = ORIGIN_DECLARED, AGREEMENT_UNCONTESTED
    else:
        origin, agreement = ORIGIN_OBSERVED, AGREEMENT_UNCONTESTED

    return SurfaceFact(
        scope=scope,
        key=key,
        label=label,
        kind_label=kind_label,
        origin=origin,
        agreement=agreement,
        declared=declared_value if has_declared else None,
        observed=observed_value if has_observed else None,
    )


def _is_absent(value: Any) -> bool:
    """Return ``True`` when a side does not state this fact at all.

    ``None`` is absence. An empty mapping or sequence is *also* absence for this purpose:
    a manifest that omits ``capabilities`` and one that writes ``{}`` say the same nothing,
    and reporting the pair as a conflict would be noise.

    Args:
        value: The candidate value.

    Returns:
        ``True`` when the value carries no statement.
    """
    if value is None:
        return True
    if isinstance(value, (Mapping, Sequence)) and not isinstance(value, (str, bytes)):
        return len(value) == 0
    if isinstance(value, str):
        return value == ""
    return False


def _canonical(value: Any) -> str:
    """Serialize a value to its byte-stable canonical JSON form for comparison.

    Object keys are sorted recursively, so two values that differ only in wire map ordering
    compare equal — exactly as
    :meth:`~app.mcp_client.normalize.DiscoverySurface.canonical_json` does for the
    fingerprint.

    Args:
        value: Any JSON-shaped value.

    Returns:
        The canonical JSON text.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
