"""
Protocol / format facet vocabulary for the public browse directory (MFI-6.1).

The browse surfaces (``/v1/browse/*`` and the ``apiome-browse`` app) let a visitor narrow the
directory by **protocol** — the canonical :class:`~app.canonical_model.ApiParadigm` an artifact was
imported as (REST, RPC, event-driven, graph, data-schema, agent) — and by **specific format** (the
``source_format`` key an adapter recorded at import: ``openapi-3.1``, ``protobuf``, ``graphql``, …).

Both facet axes read the columns MFI-7.1 added to ``apiome.versions`` (``protocol`` /
``source_format``, backed by the partial facet indexes that migration created). This module owns the
two things SQL should not: **normalizing a caller-supplied filter value** to the stored vocabulary,
and **labelling** a stored value for display. Everything here is pure and side-effect free, so the
route layer and the tests can share one definition of "what is a valid protocol".

Labels reuse the existing registries rather than inventing a third one: protocol labels come from a
small table keyed by ``ApiParadigm`` values, and format labels come from the import-source registry
(which already names every adapter and the format keys it emits — "gRPC / Protobuf",
``openapi-3.1``), falling back to :mod:`~app.format_capability_registry`. A versioned key is
labelled from its adapter's name plus the version suffix ("OpenAPI 3.1", "Swagger 2.0"), and
anything still unrecognised degrades to the raw key — a facet never renders an empty chip and never
raises.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from .canonical_model import ApiParadigm

__all__ = [
    "BROWSE_PROTOCOL_VALUES",
    "MAX_FACET_VALUE_LENGTH",
    "format_label",
    "normalize_format_filter",
    "normalize_protocol_filter",
    "protocol_label",
    "sort_format_counts",
    "sort_protocol_counts",
]


#: Longest facet value accepted from a caller. ``versions.source_format`` is ``VARCHAR(128)`` and
#: ``versions.protocol`` is ``VARCHAR(64)``, so anything longer cannot match a stored row; capping
#: keeps an oversized query string out of the SQL parameters entirely.
MAX_FACET_VALUE_LENGTH = 128


#: The protocol facet values, in the order they are presented. This is exactly the canonical
#: paradigm vocabulary — a browse facet must never offer a protocol an import cannot produce.
BROWSE_PROTOCOL_VALUES: Tuple[str, ...] = tuple(p.value for p in ApiParadigm)


#: Display labels for the protocol facet. Keyed by the stored ``versions.protocol`` value.
_PROTOCOL_LABELS: Mapping[str, str] = {
    ApiParadigm.REST.value: "REST",
    ApiParadigm.RPC.value: "RPC",
    ApiParadigm.EVENT.value: "Event-driven",
    ApiParadigm.GRAPH.value: "Graph",
    ApiParadigm.DATA_SCHEMA.value: "Data schema",
    ApiParadigm.AGENT.value: "Agent",
}


#: Spellings a caller may reasonably send for a protocol, mapped to the stored value. Punctuation
#: is stripped before lookup, so ``data-schema``/``data schema``/``dataschema`` all arrive as
#: ``dataschema`` here. Mirrors ``resolveCatalogProtocol`` in the UI's catalog format registry.
_PROTOCOL_ALIASES: Mapping[str, str] = {
    "rest": ApiParadigm.REST.value,
    "http": ApiParadigm.REST.value,
    "rpc": ApiParadigm.RPC.value,
    "grpc": ApiParadigm.RPC.value,
    "event": ApiParadigm.EVENT.value,
    "events": ApiParadigm.EVENT.value,
    "eventdriven": ApiParadigm.EVENT.value,
    "messaging": ApiParadigm.EVENT.value,
    "graph": ApiParadigm.GRAPH.value,
    "graphql": ApiParadigm.GRAPH.value,
    "dataschema": ApiParadigm.DATA_SCHEMA.value,
    "dataschemas": ApiParadigm.DATA_SCHEMA.value,
    "schema": ApiParadigm.DATA_SCHEMA.value,
    "data": ApiParadigm.DATA_SCHEMA.value,
    "agent": ApiParadigm.AGENT.value,
    "agentic": ApiParadigm.AGENT.value,
    "mcp": ApiParadigm.AGENT.value,
}


#: Splits a versioned format key into its base key and version suffix (``openapi-3.1`` →
#: ``openapi`` + ``3.1``). The version may itself be multi-part (``json-schema-2020-12`` →
#: ``json-schema`` + ``2020-12``), and it must be separated from the base, so ``hl7v2``,
#: ``iso20022`` and ``asn1`` — whole keys that merely end in digits — are left alone.
_VERSIONED_FORMAT_RE = re.compile(r"^(?P<base>.+?)[-_.](?P<version>\d+(?:[.-]\d+)*)$")


def _strip_punctuation(value: str) -> str:
    """Reduce a token to its lower-case alphanumerics (``Data-Schema`` → ``dataschema``)."""
    return re.sub(r"[^a-z0-9]", "", value.strip().lower())


def normalize_protocol_filter(value: Optional[str]) -> Optional[str]:
    """Normalize a caller-supplied protocol filter to the stored ``versions.protocol`` vocabulary.

    Matching is punctuation- and case-insensitive and accepts the common spellings a client might
    send (``data-schema``, ``event-driven``, ``graphql``). A value that is not a known protocol is
    returned in its normalized lower-case form rather than rejected, so an unknown filter yields an
    empty, well-formed result set instead of a 4xx — the same "filters never fail, they only narrow"
    contract the existing ``search``/``domain`` browse filters have.

    Args:
        value: The raw ``protocol`` query parameter, or None.

    Returns:
        The stored protocol value (e.g. ``data_schema``), a normalized unknown token, or None when
        the input is absent or blank.
    """
    if value is None:
        return None
    raw = value.strip().lower()
    if not raw:
        return None
    alias = _PROTOCOL_ALIASES.get(_strip_punctuation(raw))
    if alias is not None:
        return alias
    return raw[:MAX_FACET_VALUE_LENGTH]


def normalize_format_filter(value: Optional[str]) -> Optional[str]:
    """Normalize a caller-supplied format filter to the stored ``versions.source_format`` form.

    Stored format keys are already lower-case adapter/normalizer keys (``openapi-3.1``,
    ``protobuf``), so normalization is a trim + lower-case + length cap. As with
    :func:`normalize_protocol_filter`, an unrecognised key narrows to nothing rather than erroring.

    Args:
        value: The raw ``format`` query parameter, or None.

    Returns:
        The normalized format key, or None when the input is absent or blank.
    """
    if value is None:
        return None
    raw = value.strip().lower()
    if not raw:
        return None
    return raw[:MAX_FACET_VALUE_LENGTH]


def protocol_label(value: Optional[str]) -> str:
    """Human label for a stored protocol value (``data_schema`` → ``Data schema``).

    Args:
        value: The stored ``versions.protocol`` value.

    Returns:
        The display label, falling back to the raw value for a protocol outside the canonical
        paradigm vocabulary (which can only appear in data written before this vocabulary existed).
    """
    key = (value or "").strip().lower()
    return _PROTOCOL_LABELS.get(key, (value or "").strip())


@lru_cache(maxsize=1)
def _adapter_format_labels() -> Mapping[str, str]:
    """Map every adapter key and emitted format key to that adapter's label, built once.

    The import-source registry already names each adapter for its source card ("OpenAPI / Swagger",
    "gRPC / Protobuf") and declares which format keys it emits (``openapi-3.1``, ``swagger-2.0``, …),
    which is exactly the lookup a format facet needs. Reusing it means a newly registered adapter
    labels its facet chips with no change here.

    Returns:
        A lower-cased key → label mapping; empty if the registry cannot be loaded, in which case
        labelling falls back to the capability registry and then to the raw key.
    """
    try:
        from .import_source import describe_import_sources

        descriptors = describe_import_sources()
    except Exception:  # pragma: no cover - defensive; browse must never 500 over a label
        return {}
    labels: Dict[str, str] = {}
    for descriptor in descriptors:
        for key in (descriptor.key, *descriptor.formats):
            token = (key or "").strip().lower()
            if token:
                labels.setdefault(token, descriptor.label)
    return labels


def _capability_label(format_key: str) -> Optional[str]:
    """Look up a format key's label in the capability registry, or None when it has none.

    The registry answers for *every* key — an unregistered one echoes the key back as its label —
    so "no label" here means "the registry knows nothing about this key". Any registry failure is
    swallowed: a browse listing must not 500 because a label could not be resolved.
    """
    try:
        from .format_capability_registry import capability_for

        label = capability_for(format_key).label
    except Exception:  # pragma: no cover - defensive; the registry is pure data
        return None
    # The registry echoes an unregistered key back verbatim as its label; a *registered* key always
    # differs in case or spelling ("asyncapi" → "AsyncAPI"), so an exact match means "not known".
    if not label or label.strip() == format_key:
        return None
    return label


def _name_for_base(label: str, base: str) -> str:
    """Pick the part of a multi-name adapter label that names ``base``.

    One adapter can cover several named formats ("OpenAPI / Swagger"), so a versioned key must be
    labelled with the right half: ``swagger-2.0`` is "Swagger 2.0", not "OpenAPI 2.0". When no part
    matches, the first is used — still better than repeating every name before the version.

    Args:
        label: The adapter label, possibly of the form ``A / B``.
        base: The format key with its version suffix removed.

    Returns:
        The single format name to prefix the version with.
    """
    parts = [p.strip() for p in label.split("/") if p.strip()]
    if not parts:
        return label
    target = _strip_punctuation(base)
    for part in parts:
        if _strip_punctuation(part) == target:
            return part
    return parts[0]


def format_label(format_key: Optional[str]) -> str:
    """Human label for a stored source-format key (``openapi-3.1`` → ``OpenAPI 3.1``).

    Resolution order:

    1. The import-source registry's adapter label for the key verbatim — this covers every emitted
       format key, so ``protobuf`` becomes "gRPC / Protobuf".
    2. For a versioned key, the adapter label for the whole key (or, failing that, for its base)
       narrowed to the name that matches the base, plus the version: "Swagger 2.0", "AsyncAPI 3".
    3. The capability registry's label, which also answers for reviewed formats no adapter emits.
    4. The raw key, so an unknown format still renders a usable chip.

    Args:
        format_key: The stored ``versions.source_format`` value.

    Returns:
        The display label; never empty for a non-empty key.
    """
    key = (format_key or "").strip().lower()
    if not key:
        return ""
    adapter_labels = _adapter_format_labels()
    match = _VERSIONED_FORMAT_RE.match(key)
    if match:
        base, version = match.group("base"), match.group("version")
        label = adapter_labels.get(key) or adapter_labels.get(base) or _capability_label(base)
        if label:
            return f"{_name_for_base(label, base)} {version}"
    direct = adapter_labels.get(key) or _capability_label(key)
    if direct:
        return direct
    return format_key.strip()


def sort_protocol_counts(counts: Dict[str, int]) -> List[Tuple[str, str, int]]:
    """Order protocol facet counts by the canonical paradigm order.

    Args:
        counts: Stored protocol value → number of matching directory entries.

    Returns:
        ``(value, label, count)`` triples: the canonical paradigms first, in
        :data:`BROWSE_PROTOCOL_VALUES` order, then any non-canonical value alphabetically.
    """
    known = [v for v in BROWSE_PROTOCOL_VALUES if v in counts]
    unknown = sorted(v for v in counts if v not in _PROTOCOL_LABELS)
    return [(v, protocol_label(v), counts[v]) for v in [*known, *unknown]]


def sort_format_counts(counts: Dict[str, int]) -> List[Tuple[str, str, int]]:
    """Order format facet counts by popularity, then key, for a stable, useful chip row.

    Args:
        counts: Stored ``source_format`` key → number of matching directory entries.

    Returns:
        ``(value, label, count)`` triples, highest count first and ties broken by key so the order
        never depends on database row order.
    """
    ordered: Sequence[str] = sorted(counts, key=lambda k: (-counts[k], k))
    return [(v, format_label(v), counts[v]) for v in ordered]
