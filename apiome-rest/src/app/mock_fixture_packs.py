"""Mock fixture pack format (PMR-2.2, #4745).

A **fixture pack** is a named, versioned, digestible unit of deterministic mock data. It gives
tests a portable, reviewable way to seed the stateful mock (SIM-4.1 CRUD sessions) and to feed
template fixture data (PMR-2.1) without hand-crafting per-test state.

Packs live in ``versions.mock_settings`` under the ``"fixturePacks"`` key::

    {
      "fixturePacks": {
        "smoke": {
          "packFormat": "apiome.mock.fixture-pack/v1",
          "packFormatVersion": 1,
          "description": "Two pets and one order.",
          "data": {"pets": [{"id": 1, "name": "Rex"}]},
          "collections": {
            "/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}],
            "/orders": [{"id": 1, "petId": 2}]
          }
        }
      }
    }

The two payload sections serve the two runtime consumers:

* ``data`` — template fixture values, readable as ``{{fixture.<name>...}}`` in scenario
  response templates (#4744, PMR-2.1).
* ``collections`` — seed resources for the session store, applied when a session resets to the
  pack (``POST .../__mock__/session/reset``). Keys are CRUD collection paths (``/pets``); values
  are ordered lists of resource objects.

**Versioning and digests.** Every pack declares :data:`PACK_FORMAT` and
:data:`PACK_FORMAT_VERSION`; a runtime skips packs whose version it does not support rather than
misreading them. A pack's **digest** is SHA-256 over the canonical JSON of its canonicalized
document (:func:`fixture_pack_digest`), so the same pack content always produces the same digest
— author-side on save, runtime-side on load, and inside a portable bundle. That digest is what a
test asserts to pin the exact data it seeded.

This module owns the *author-time* contract (strict validation on save) and the canonical shape
both sides digest. The runtime's lenient loader lives in ``apiome_mock.fixture_packs`` and
reuses the canonicalization and digest helpers here so the two can never drift.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Tuple

from .mock_bundle import canonical_json, content_digest
from .mock_settings_util import parse_mock_settings

__all__ = [
    "MAX_COLLECTIONS_PER_PACK",
    "MAX_DESCRIPTION_LENGTH",
    "MAX_PACKS",
    "MAX_PACK_BYTES",
    "MAX_RESOURCES_PER_COLLECTION",
    "PACK_FORMAT",
    "PACK_FORMAT_VERSION",
    "PACK_NAME_PATTERN",
    "SUPPORTED_PACK_FORMAT_VERSIONS",
    "canonical_fixture_pack",
    "collection_resource_id",
    "fixture_pack_digest",
    "fixture_pack_digests",
    "fixture_packs_from_storage",
    "fixture_packs_to_storage",
    "merged_pack_data",
    "validate_fixture_packs",
]

#: Media-type-shaped identifier of the fixture pack document family. A breaking change to the
#: layout mints a new one (``/v2``) rather than reusing this id with a different meaning.
PACK_FORMAT = "apiome.mock.fixture-pack/v1"

#: Additive revision of :data:`PACK_FORMAT`. Bumped when new *optional* fields appear; a runtime
#: skips packs whose version is not in :data:`SUPPORTED_PACK_FORMAT_VERSIONS`.
PACK_FORMAT_VERSION = 1

#: Format versions this build can produce and consume.
SUPPORTED_PACK_FORMAT_VERSIONS: Tuple[int, ...] = (1,)

#: Maximum named packs per version.
MAX_PACKS = 20

#: Maximum canonical JSON size (bytes) of one pack (128 KiB).
MAX_PACK_BYTES = 131_072

#: Maximum seed collections in one pack.
MAX_COLLECTIONS_PER_PACK = 50

#: Maximum seed resources in one collection.
MAX_RESOURCES_PER_COLLECTION = 500

#: Maximum length of a pack description.
MAX_DESCRIPTION_LENGTH = 500

#: Header/URL-safe pack and fixture-data names: alphanumeric start, then ``[A-Za-z0-9._-]``,
#: max 64 chars — the same shape as scenario names, so a name is always safe to echo in JSON
#: responses and log lines.
PACK_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: Top-level keys a pack document may carry; anything else fails author-time validation so a typo
#: (``"collecitons"``) is an error rather than silently dead data.
_ALLOWED_PACK_KEYS = frozenset(
    {"packFormat", "packFormatVersion", "description", "data", "collections"}
)

_MAX_COLLECTION_PATH_LENGTH = 200


def collection_resource_id(resource: Mapping[str, Any], index: int) -> str:
    """Return the session-store resource id one seed resource is stored under.

    The resource's own ``id`` field wins when it is a string or integer (booleans excluded);
    otherwise the 1-based list position is used, so every resource has a deterministic,
    documented id even without an explicit one.

    Args:
        resource: The seed resource object.
        index: The resource's 0-based position in its collection list.

    Returns:
        The string resource id.
    """
    raw = resource.get("id")
    if isinstance(raw, bool):
        return str(index + 1)
    if isinstance(raw, (str, int)):
        text = str(raw).strip()
        if text:
            return text
    return str(index + 1)


def _validate_collection(
    pack_name: str, path: Any, resources: Any, errors: List[str]
) -> None:
    """Validate one seed collection entry (path key + resource list)."""
    label = f"Pack '{pack_name}' collection {path!r}"
    if not isinstance(path, str) or not path.startswith("/") or len(path) > _MAX_COLLECTION_PATH_LENGTH:
        errors.append(
            f"{label}: collection keys must be paths starting with '/' "
            f"(max {_MAX_COLLECTION_PATH_LENGTH} chars)."
        )
        return
    if any(ch.isspace() for ch in path):
        errors.append(f"{label}: collection paths cannot contain whitespace.")
        return
    if not isinstance(resources, list):
        errors.append(f"{label}: must be a list of resource objects.")
        return
    if len(resources) > MAX_RESOURCES_PER_COLLECTION:
        errors.append(
            f"{label}: at most {MAX_RESOURCES_PER_COLLECTION} resources per collection."
        )
        return
    seen_ids: Dict[str, int] = {}
    for index, resource in enumerate(resources):
        if not isinstance(resource, dict):
            errors.append(f"{label}[{index}]: each resource must be a JSON object.")
            continue
        raw_id = resource.get("id")
        if raw_id is not None and (isinstance(raw_id, bool) or not isinstance(raw_id, (str, int))):
            errors.append(f"{label}[{index}]: 'id' must be a string or integer when present.")
            continue
        resource_id = collection_resource_id(resource, index)
        if resource_id in seen_ids:
            errors.append(
                f"{label}[{index}]: duplicate resource id {resource_id!r} "
                f"(first used at index {seen_ids[resource_id]})."
            )
            continue
        seen_ids[resource_id] = index


def _validate_pack(name: str, pack: Any, errors: List[str]) -> None:
    """Validate one pack document against the v1 schema."""
    if not isinstance(name, str) or not PACK_NAME_PATTERN.match(name):
        errors.append(
            f"Pack name {name!r} is invalid: names must match {PACK_NAME_PATTERN.pattern}."
        )
        return
    if not isinstance(pack, dict):
        errors.append(f"Pack '{name}' must be a JSON object.")
        return

    unknown = sorted(set(pack) - _ALLOWED_PACK_KEYS)
    if unknown:
        errors.append(f"Pack '{name}' has unknown keys: {', '.join(unknown)}.")

    declared_format = pack.get("packFormat", PACK_FORMAT)
    if declared_format != PACK_FORMAT:
        errors.append(
            f"Pack '{name}' declares packFormat {declared_format!r}; expected '{PACK_FORMAT}'."
        )
    declared_version = pack.get("packFormatVersion", PACK_FORMAT_VERSION)
    if isinstance(declared_version, bool) or declared_version not in SUPPORTED_PACK_FORMAT_VERSIONS:
        errors.append(
            f"Pack '{name}' declares packFormatVersion {declared_version!r}; "
            f"supported: {', '.join(str(v) for v in SUPPORTED_PACK_FORMAT_VERSIONS)}."
        )

    description = pack.get("description")
    if description is not None:
        if not isinstance(description, str):
            errors.append(f"Pack '{name}': description must be a string.")
        elif len(description) > MAX_DESCRIPTION_LENGTH:
            errors.append(
                f"Pack '{name}': description exceeds {MAX_DESCRIPTION_LENGTH} characters."
            )

    data = pack.get("data")
    if data is not None:
        if not isinstance(data, dict):
            errors.append(f"Pack '{name}': data must be an object of fixture values by name.")
        else:
            for fixture_name in data:
                if not isinstance(fixture_name, str) or not PACK_NAME_PATTERN.match(fixture_name):
                    errors.append(
                        f"Pack '{name}': fixture data name {fixture_name!r} is invalid: "
                        f"names must match {PACK_NAME_PATTERN.pattern}."
                    )

    collections = pack.get("collections")
    if collections is not None:
        if not isinstance(collections, dict):
            errors.append(f"Pack '{name}': collections must be an object of resource lists by path.")
        else:
            if len(collections) > MAX_COLLECTIONS_PER_PACK:
                errors.append(
                    f"Pack '{name}': at most {MAX_COLLECTIONS_PER_PACK} collections per pack."
                )
            for path, resources in collections.items():
                _validate_collection(name, path, resources, errors)

    canonical = canonical_fixture_pack(pack)
    if len(canonical_json(canonical).encode("utf-8")) > MAX_PACK_BYTES:
        errors.append(f"Pack '{name}' exceeds the {MAX_PACK_BYTES} byte size limit.")


def validate_fixture_packs(packs: Any) -> List[str]:
    """Validate a ``{name: pack}`` mapping against the v1 schema (author-time, strict).

    Args:
        packs: The proposed fixture packs, keyed by pack name.

    Returns:
        Every validation error found (empty when the packs are valid). Errors are stable,
        human-readable sentences suitable for a 422 response body.
    """
    errors: List[str] = []
    if not isinstance(packs, dict):
        return ["Fixture packs must be an object keyed by pack name."]
    if len(packs) > MAX_PACKS:
        errors.append(f"At most {MAX_PACKS} fixture packs are allowed per version.")
    for name, pack in packs.items():
        _validate_pack(name, pack, errors)
    return errors


def canonical_fixture_pack(pack: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the canonical (digestible, storable) form of one pack document.

    The canonical form always declares the format id and version, keeps ``description`` /
    ``data`` / ``collections`` only when non-empty, and drops every unknown key. Digesting this
    shape — rather than the raw input — means cosmetic differences (an omitted-vs-explicit
    format id, an empty ``data`` object) never change a pack's digest.

    Args:
        pack: A pack document (validated author-side, or lenient-parsed runtime-side).

    Returns:
        The canonical pack document.
    """
    canonical: Dict[str, Any] = {
        "packFormat": PACK_FORMAT,
        "packFormatVersion": PACK_FORMAT_VERSION,
    }
    description = pack.get("description")
    if isinstance(description, str) and description.strip():
        canonical["description"] = description
    data = pack.get("data")
    if isinstance(data, Mapping) and data:
        canonical["data"] = dict(data)
    collections = pack.get("collections")
    if isinstance(collections, Mapping) and collections:
        canonical["collections"] = {path: list(resources) for path, resources in collections.items()}
    return canonical


def fixture_pack_digest(pack: Mapping[str, Any]) -> str:
    """Return ``sha256:<hex>`` over the canonical JSON of the canonicalized pack.

    This is the pack's stable identity: the value the authoring API returns on save, the
    runtime reports from its lifecycle endpoints, and a test asserts to pin its seed data.

    Args:
        pack: A pack document.

    Returns:
        The prefixed digest string.
    """
    return content_digest(canonical_fixture_pack(pack))


def fixture_packs_from_storage(mock_settings: Any) -> Dict[str, Any]:
    """Extract the stored ``fixturePacks`` mapping from raw ``versions.mock_settings``.

    Accepts the raw JSONB value (dict, JSON text, or ``None``) and never raises; a malformed
    blob yields an empty mapping. Entries are returned as stored — callers validate or
    lenient-parse as their context requires.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value.

    Returns:
        The ``{name: pack}`` mapping (possibly empty).
    """
    settings = parse_mock_settings(mock_settings)
    raw = settings.get("fixturePacks")
    if not isinstance(raw, dict):
        return {}
    return {name: pack for name, pack in raw.items() if isinstance(name, str)}


def fixture_packs_to_storage(packs: Mapping[str, Any]) -> Dict[str, Any]:
    """Canonicalize validated packs into the shape stored under ``fixturePacks``.

    Args:
        packs: Validated packs keyed by name.

    Returns:
        The canonical ``{name: pack}`` mapping to persist.
    """
    return {name: canonical_fixture_pack(pack) for name, pack in packs.items()}


def fixture_pack_digests(packs: Mapping[str, Any]) -> Dict[str, str]:
    """Return the digest of every pack in a mapping, keyed by pack name.

    Args:
        packs: Packs keyed by name.

    Returns:
        ``{name: "sha256:<hex>"}`` for every pack.
    """
    return {name: fixture_pack_digest(pack) for name, pack in packs.items()}


def merged_pack_data(packs: Mapping[str, Any]) -> Dict[str, Any]:
    """Merge every pack's ``data`` section into one template-fixture mapping.

    Packs merge in sorted-name order, so the result is deterministic: when two packs define the
    same fixture name, the lexicographically later pack wins. This mapping overlays the flat
    ``mock_settings.fixtures`` map (PMR-2.1) when the runtime builds template fixture data.

    Args:
        packs: Packs keyed by name (stored or canonical shape).

    Returns:
        Fixture values by name from every pack's ``data``.
    """
    merged: Dict[str, Any] = {}
    for name in sorted(packs):
        pack = packs[name]
        if not isinstance(pack, Mapping):
            continue
        data = pack.get("data")
        if isinstance(data, Mapping):
            merged.update({k: v for k, v in data.items() if isinstance(k, str) and k.strip()})
    return merged
