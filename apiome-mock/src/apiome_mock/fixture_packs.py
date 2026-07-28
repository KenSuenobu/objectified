"""Runtime fixture pack loading (#4745, PMR-2.2).

Fixture packs are the versioned, digestible seed-data units defined in
:mod:`app.mock_fixture_packs`. This module is the *runtime* half: it turns the
``fixturePacks`` key of stored mock settings (hosted: ``versions.mock_settings``;
portable: the bundled settings document) into immutable :class:`FixturePack`
objects the lifecycle endpoints serve from.

Parsing follows the runtime's leniency rule (like :mod:`apiome_mock.scenarios`):
a malformed pack, collection, or resource is skipped, never raised, so a stored
blob can never break serving. A pack that declares an *unsupported* format id or
version is skipped whole — misreading a future pack shape would be worse than
ignoring it.

Each parsed pack carries the same digest the authoring API computed on save
(:func:`app.mock_fixture_packs.fixture_pack_digest` over the canonicalized
surviving content), so a test can assert the exact data it reset to.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.mock_fixture_packs import (
    PACK_FORMAT,
    PACK_FORMAT_VERSION,
    PACK_NAME_PATTERN,
    SUPPORTED_PACK_FORMAT_VERSIONS,
    collection_resource_id,
    fixture_pack_digest,
)

__all__ = [
    "FixturePack",
    "merged_template_data",
    "pack_summary",
    "parse_fixture_packs",
]


@dataclass(frozen=True)
class FixturePack:
    """One parsed fixture pack, ready for session seeding and listing.

    Attributes:
        name: The pack's name (the key it is stored under).
        description: Author-provided description ("" when absent).
        digest: ``sha256:<hex>`` over the pack's canonical content — its stable identity.
        format_version: The declared ``packFormatVersion``.
        data: Template fixture values by name (the pack's ``data`` section).
        collections: Seed resources per collection path, as ordered
            ``(resource_id, resource)`` pairs — exactly what
            ``SessionStore.replace_session`` consumes.
    """

    name: str
    description: str
    digest: str
    format_version: int
    data: Mapping[str, Any] = field(default_factory=dict)
    collections: Mapping[str, tuple[tuple[str, dict[str, Any]], ...]] = field(default_factory=dict)

    @property
    def resource_count(self) -> int:
        """Total seed resources across every collection."""
        return sum(len(items) for items in self.collections.values())


def _parse_collections(raw: Any) -> dict[str, tuple[tuple[str, dict[str, Any]], ...]]:
    """Parse a pack's ``collections`` section, skipping malformed entries.

    Resource ids derive from :func:`app.mock_fixture_packs.collection_resource_id`
    (the resource's own ``id`` when usable, else its 1-based position). A duplicate
    id within one collection keeps the *last* occurrence, matching session-store
    put semantics.
    """
    if not isinstance(raw, dict):
        return {}
    collections: dict[str, tuple[tuple[str, dict[str, Any]], ...]] = {}
    for path, resources in raw.items():
        if not isinstance(path, str) or not path.startswith("/") or any(ch.isspace() for ch in path):
            continue
        if not isinstance(resources, list):
            continue
        by_id: dict[str, dict[str, Any]] = {}
        for index, resource in enumerate(resources):
            if not isinstance(resource, dict):
                continue
            by_id[collection_resource_id(resource, index)] = dict(resource)
        if by_id:
            collections[path] = tuple(by_id.items())
    return collections


def _parse_data(raw: Any) -> dict[str, Any]:
    """Parse a pack's ``data`` section: fixture values under non-blank string names."""
    if not isinstance(raw, dict):
        return {}
    return {name: value for name, value in raw.items() if isinstance(name, str) and name.strip()}


def _parse_pack(name: str, raw: Any) -> FixturePack | None:
    """Build one :class:`FixturePack`; ``None`` when the entry is unusable."""
    if not isinstance(raw, dict):
        return None
    declared_format = raw.get("packFormat", PACK_FORMAT)
    if declared_format != PACK_FORMAT:
        return None
    declared_version = raw.get("packFormatVersion", PACK_FORMAT_VERSION)
    if isinstance(declared_version, bool) or declared_version not in SUPPORTED_PACK_FORMAT_VERSIONS:
        return None

    data = _parse_data(raw.get("data"))
    collections = _parse_collections(raw.get("collections"))
    description = raw.get("description")

    # Digest the *surviving* content in the shared canonical shape, so a fully valid stored
    # pack digests identically to what the authoring API reported on save.
    surviving: dict[str, Any] = {}
    if isinstance(description, str) and description.strip():
        surviving["description"] = description
    if data:
        surviving["data"] = data
    if collections:
        surviving["collections"] = {path: [resource for _, resource in items] for path, items in collections.items()}

    return FixturePack(
        name=name,
        description=description if isinstance(description, str) else "",
        digest=fixture_pack_digest(surviving),
        format_version=int(declared_version),
        data=data,
        collections=collections,
    )


def parse_fixture_packs(mock_settings: Any) -> dict[str, FixturePack]:
    """Parse the ``fixturePacks`` key of raw mock settings into packs by name.

    Accepts the raw settings value (dict, JSON text, or ``None``) and never raises;
    unusable packs are skipped. Pack names must match the author-time name pattern —
    anything else could not have been saved through the API and is not trusted.
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return {}
    if not isinstance(settings, dict):
        return {}
    raw_packs = settings.get("fixturePacks")
    if not isinstance(raw_packs, dict):
        return {}

    packs: dict[str, FixturePack] = {}
    for name, raw in raw_packs.items():
        if not isinstance(name, str) or not PACK_NAME_PATTERN.match(name):
            continue
        pack = _parse_pack(name, raw)
        if pack is not None:
            packs[pack.name] = pack
    return packs


def merged_template_data(packs: Mapping[str, FixturePack]) -> dict[str, Any]:
    """Merge every pack's ``data`` into one template-fixture mapping.

    Packs merge in sorted-name order (deterministic; later names win on collision).
    The caller overlays this onto the flat ``mock_settings.fixtures`` map so pack
    data is readable by response templates (#4744, PMR-2.1).
    """
    merged: dict[str, Any] = {}
    for name in sorted(packs):
        merged.update(packs[name].data)
    return merged


def pack_summary(pack: FixturePack) -> dict[str, Any]:
    """Describe one pack for the ``__mock__/fixture-packs`` listing endpoint.

    The summary carries identity and shape (names, counts, digest) but no resource
    bodies, so it is always small and safe to log.
    """
    return {
        "name": pack.name,
        "description": pack.description,
        "digest": pack.digest,
        "packFormat": PACK_FORMAT,
        "packFormatVersion": pack.format_version,
        "fixtures": sorted(pack.data),
        "collections": {path: len(items) for path, items in sorted(pack.collections.items())},
        "resources": pack.resource_count,
    }
