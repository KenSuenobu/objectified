"""Fixture data for template rendering (#4744, PMR-2.1).

Templates may reference fixture values by name (``{{fixture.pets#/0/name}}``). This module owns
the two lenient loaders that turn stored fixture content into the ``name -> JSON value`` mapping
carried on :class:`~apiome_mock.spec_loader.CompiledSpec`:

* :func:`parse_fixtures` — hosted path: reads the ``"fixtures"`` key of ``versions.mock_settings``
  (the storage home the PMR-2.2 fixture-pack work will formalize; absent today, so this simply
  returns an empty mapping until packs exist).
* :func:`decode_bundle_fixtures` — portable path: decodes the base64 fixture payloads a PMR-1.1
  bundle embeds, keyed by the manifest's fixture entries.

Both loaders follow the runtime's leniency rule: malformed entries are skipped, never raised, so
stored blobs can never break serving. JSON-typed fixtures are parsed into native values; anything
else is kept as text.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Mapping

MAX_FIXTURE_BYTES = 1_048_576
"""Per-fixture size cap (1 MiB): larger payloads are skipped rather than loaded."""


def _is_json_media_type(media_type: str) -> bool:
    """Whether a fixture media type should be parsed as JSON."""
    primary = media_type.split(";", 1)[0].strip().lower()
    return primary.endswith("/json") or primary.endswith("+json")


def parse_fixtures(mock_settings: Any) -> dict[str, Any]:
    """Extract fixture data from a raw ``mock_settings`` value (hosted path).

    Accepts the raw JSONB value (dict, JSON text, or ``None``) and never raises. The expected
    shape is ``{"fixtures": {"<name>": <json value>, ...}}``; non-string names are skipped.
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return {}
    if not isinstance(settings, dict):
        return {}
    raw = settings.get("fixtures")
    if not isinstance(raw, dict):
        return {}
    return {name: value for name, value in raw.items() if isinstance(name, str) and name.strip()}


def decode_bundle_fixtures(
    entries: tuple[Mapping[str, Any], ...],
    payloads: Any,
) -> dict[str, Any]:
    """Decode a bundle's embedded fixture payloads (portable path).

    Args:
        entries: The manifest's fixture entries (``name``, ``mediaType``, ...).
        payloads: The bundle document's ``fixtures`` map of ``name -> base64 content``.

    Returns:
        Fixture values by name. JSON media types are parsed; other content is kept as UTF-8 text.
        Entries with missing, oversized, or undecodable payloads are skipped.
    """
    if not isinstance(payloads, Mapping):
        return {}
    fixtures: dict[str, Any] = {}
    for entry in entries:
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        encoded = payloads.get(name)
        if not isinstance(encoded, str):
            continue
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            continue
        if len(raw) > MAX_FIXTURE_BYTES:
            continue
        media_type = str(entry.get("mediaType") or "application/json")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if _is_json_media_type(media_type):
            try:
                fixtures[name] = json.loads(text)
            except json.JSONDecodeError:
                continue
        else:
            fixtures[name] = text
    return fixtures
