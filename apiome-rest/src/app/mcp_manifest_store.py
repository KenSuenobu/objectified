"""Persisting and re-reading a declared MCP surface — FMT-1.7 (#5418).

The mapping between a parsed manifest and its ``apiome.mcp_endpoint_manifests`` row (V245),
in both directions and with no database in sight. Keeping it here rather than in the route
or the DB layer means the one interesting property — *what is stored is enough to re-derive
the fingerprint that was stored beside it* — is a unit test over plain dicts.

That property matters more than it sounds. The row carries a ``surface_fingerprint``, and
the whole declared-vs-observed comparison rests on it. A fingerprint that could not be
recomputed from the row would be an unfalsifiable claim: nothing could ever detect that it
had been written wrongly. So the row stores the *canonical semantic projection* the
fingerprint is taken over (:meth:`~app.mcp_client.normalize.DiscoverySurface.canonical_dict`),
and :func:`surface_from_manifest_row` rebuilds a :class:`~app.mcp_client.normalize.DiscoverySurface`
from it whose fingerprint is the stored one.

The projection is deliberately *not* the verbatim manifest. Volatile fields — the reserved
``_meta`` block, a resource's ``size`` hint, vendor extension keys — are already excluded
from it, and they are excluded here for the same reason: they cannot move the fingerprint,
so storing them would invite a comparison that reports a conflict the fingerprint denies.
The verbatim manifest is preserved elsewhere, on the imported catalog item's fidelity bag.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .mcp_client.handshake import ServerInfo
from .mcp_client.normalize import (
    ITEM_TYPE_PROMPT,
    ITEM_TYPE_RESOURCE,
    ITEM_TYPE_RESOURCE_TEMPLATE,
    ITEM_TYPE_TOOL,
    CapabilityItem,
    DiscoverySurface,
)
from .mcp_manifest_parser import McpManifestDocument, manifest_surface

__all__ = [
    "DeclaredManifest",
    "declared_manifest",
    "surface_from_manifest_row",
]

#: Projection list key → (item type, ``CapabilityItem`` constructor), in surface order.
_PROJECTION_LISTS = (
    ("tools", ITEM_TYPE_TOOL, CapabilityItem.from_tool),
    ("resources", ITEM_TYPE_RESOURCE, CapabilityItem.from_resource),
    ("resourceTemplates", ITEM_TYPE_RESOURCE_TEMPLATE, CapabilityItem.from_resource_template),
    ("prompts", ITEM_TYPE_PROMPT, CapabilityItem.from_prompt),
)


@dataclass(frozen=True)
class DeclaredManifest:
    """A parsed manifest paired with the surface it declares, ready to store.

    Attributes:
        document: The parsed manifest.
        surface: The declared :class:`~app.mcp_client.normalize.DiscoverySurface`.
        source_label: Where the declaration came from — a filename, a URL, or ``"pasted"``.
    """

    document: McpManifestDocument
    surface: DiscoverySurface
    source_label: Optional[str] = None

    @property
    def fingerprint(self) -> str:
        """The declared surface's stable fingerprint."""
        return self.surface.fingerprint()

    def as_row(self) -> Dict[str, Any]:
        """Map this declaration to an ``mcp_endpoint_manifests`` insert payload.

        The DB assigns ``id``, ``tenant_id``, ``endpoint_id``, ``imported_by`` and the
        timestamps; this supplies every column that describes the declaration itself.

        Returns:
            A dict keyed by column name, with ``capabilities`` and ``surface`` as plain
            Python objects (the DB layer serializes them to JSONB).
        """
        return {
            "source_label": self.source_label,
            "surface_fingerprint": self.fingerprint,
            "protocol_version": self.surface.protocol_version,
            "server_name": self.surface.server_info.name,
            "server_title": self.surface.server_info.title,
            "server_version": self.surface.server_info.version,
            "instructions": self.surface.instructions,
            "capabilities": dict(self.surface.capabilities),
            "surface": self.surface.canonical_dict(),
            "tool_count": len(self.surface.tools),
            "resource_count": len(self.surface.resources),
            "resource_template_count": len(self.surface.resource_templates),
            "prompt_count": len(self.surface.prompts),
        }


def declared_manifest(
    document: McpManifestDocument,
    *,
    source_label: Optional[str] = None,
) -> DeclaredManifest:
    """Pair a parsed manifest with the surface it declares.

    Args:
        document: The parsed manifest.
        source_label: Override for where the declaration came from; defaults to the
            manifest's own source label, else ``"pasted"``.

    Returns:
        The :class:`DeclaredManifest`.
    """
    return DeclaredManifest(
        document=document,
        surface=manifest_surface(document),
        source_label=source_label or document.source_label or "pasted",
    )


def surface_from_manifest_row(row: Optional[Mapping[str, Any]]) -> Optional[DiscoverySurface]:
    """Rebuild the declared surface from a stored ``mcp_endpoint_manifests`` row.

    The inverse of :meth:`DeclaredManifest.as_row` for everything the fingerprint depends
    on: the rebuilt surface's
    :meth:`~app.mcp_client.normalize.DiscoverySurface.fingerprint` equals the row's stored
    ``surface_fingerprint``.

    Args:
        row: The stored row, or ``None``.

    Returns:
        The reconstructed surface, or ``None`` when ``row`` is ``None`` or carries no
        usable ``surface`` projection. ``None`` is the honest answer for a row that cannot
        be read back — it makes the endpoint read as "no declared source" rather than as a
        declaration that agrees with everything.
    """
    if row is None:
        return None
    projection = row.get("surface")
    if not isinstance(projection, Mapping):
        return None

    server_info_payload = projection.get("serverInfo")
    server_info = ServerInfo.from_dict(
        server_info_payload if isinstance(server_info_payload, Mapping) else None
    )

    items: Dict[str, List[CapabilityItem]] = {}
    for list_key, item_type, constructor in _PROJECTION_LISTS:
        items[item_type] = _items_from_projection(projection.get(list_key), constructor)

    capabilities = projection.get("capabilities")
    return DiscoverySurface(
        protocol_version=_optional_str(projection.get("protocolVersion")),
        server_info=server_info,
        capabilities=dict(capabilities) if isinstance(capabilities, Mapping) else {},
        instructions=_optional_str(projection.get("instructions")),
        tools=tuple(items[ITEM_TYPE_TOOL]),
        resources=tuple(items[ITEM_TYPE_RESOURCE]),
        resource_templates=tuple(items[ITEM_TYPE_RESOURCE_TEMPLATE]),
        prompts=tuple(items[ITEM_TYPE_PROMPT]),
    )


def _items_from_projection(payload: Any, constructor: Any) -> List[CapabilityItem]:
    """Rebuild one kind's items from its stored projection entries.

    Each stored entry is a :meth:`~app.mcp_client.normalize.CapabilityItem.fingerprint_projection`
    — wire-spelled, allow-listed fields only — so feeding it back to the same constructor
    reproduces an item whose own projection is identical. Fields with no promoted column
    (a resource's ``mimeType``, a prompt's ``arguments``) round-trip through ``raw``,
    which the constructor fills from the entry.

    Args:
        payload: The stored list value (anything else yields no items).
        constructor: The ``CapabilityItem.from_*`` classmethod for this kind.

    Returns:
        The rebuilt items, ordinals reassigned in stored order.
    """
    if not isinstance(payload, Sequence) or isinstance(payload, (str, bytes)):
        return []
    rebuilt: List[CapabilityItem] = []
    for ordinal, entry in enumerate(payload):
        if isinstance(entry, Mapping):
            rebuilt.append(constructor(entry, ordinal))
    return rebuilt


def _optional_str(value: Any) -> Optional[str]:
    """Return ``value`` when it is a non-empty string, else ``None``."""
    return value if isinstance(value, str) and value != "" else None
