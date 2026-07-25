"""Shared adapter-support helpers for the corpus test suites — IXH-1.6 (#5092).

Selecting corpus entries and running them through their adapter needs the same four
pieces of knowledge in every corpus suite: which entries an adapter owns, which
adapters need an external tool that may not resolve here, which entries fail on a
*known* adapter bug, and how to assemble a multi-file set. IXH-1.2 established that
knowledge inside :mod:`tests.test_corpus_import`; the IXH-1.6 golden runner needs
exactly the same, so it lives here rather than being duplicated (or imported from a
test module).

The known-bug maps are the single source of truth for both suites: an entry listed
here is a **strict** xfail, so fixing the adapter fails the suite until the entry is
removed from the map. That is deliberate — it keeps the maps from silently rotting
into a list of permanently-skipped fixtures, and it mirrors the manifest ``notes``
convention from IXH-1.1.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Dict, List

from corpus_loader import CorpusEntry, FilesetRole, ValidityClass, load_corpus

from app.fileset import IntakeFileset
from app.import_source import (
    ImportSource,
    get_import_source,
    resolve_import_source_key,
)
from app.toolchain_packaging import probe_tool

__all__ = [
    "KNOWN_DETECTION_BUGS",
    "KNOWN_IMPORT_BUGS",
    "adapter_for",
    "build_fileset",
    "missing_tools",
    "tool_available",
    "valid_entries",
]

#: Corpus entries whose own adapter cannot claim them yet. Path -> reason.
#: Keep in sync with the entry's manifest ``notes``; strict xfail means a
#: fixed adapter fails the suite until the entry is removed from this map.
KNOWN_DETECTION_BUGS: Dict[str, str] = {
    "fix/02-orchestra.xml": (
        "FIX Orchestra XML is not yet recognized by the fix adapter "
        "(no Orchestra parser); the manifest records the intended contract."
    ),
    "cloudevents/03-order-lifecycle-batch.json": (
        "The cloudevents adapter's detect delegates to parse_document, which "
        "rejects top-level JSON arrays, so a spec-valid CloudEvents batch "
        "returns NO_MATCH even though is_cloudevents_document accepts lists."
    ),
}

#: Corpus entries whose import (parse/normalize/lint) crashes on a known
#: adapter bug. Path -> reason. Same strict-xfail convention as above.
KNOWN_IMPORT_BUGS: Dict[str, str] = {
    "fix/02-orchestra.xml": (
        "The fix adapter has no Orchestra parser; parse raises until the "
        "detection-hardening epic adds one."
    ),
    "asn1/07-scalar-alias-typedefs.asn1": (
        "asn1_normalizer builds Type(scalar=...) / Type(alias_of=...) for "
        "top-level scalar and SEQUENCE OF typedefs, but canonical Type has "
        "no such fields, so normalize raises a pydantic ValidationError."
    ),
    "cloudevents/03-order-lifecycle-batch.json": (
        "parse_cloudevents documents a batch-array mode, but it delegates to "
        "parse_document, which raises IngestionError for top-level arrays, "
        "making the batch branch unreachable."
    ),
}


@lru_cache(maxsize=None)
def tool_available(tool: str) -> bool:
    """Whether an adapter-required external tool resolves in this runtime.

    Args:
        tool: The bundled tool name (for example ``buf``, ``asyncapi-parser``).

    Returns:
        ``True`` when the tool can be resolved and run here.
    """
    return bool(getattr(probe_tool(tool), "available", False))


def missing_tools(adapter_key: str) -> List[str]:
    """The adapter's ``required_tools`` that are unavailable in this runtime.

    Mirrors test_grpc_import_source's buf gate: parse steps that shell out to a
    bundled tool (buf, asyncapi-parser, ...) are skipped, not failed, when the tool
    cannot resolve.

    Args:
        adapter_key: The ImportSource registry key.

    Returns:
        The unresolvable tool names; empty when the adapter is fully runnable.
    """
    adapter = get_import_source(adapter_key)
    return [tool for tool in getattr(adapter, "required_tools", ()) if not tool_available(tool)]


def adapter_for(entry: CorpusEntry) -> ImportSource:
    """Resolve the :class:`ImportSource` a corpus entry declares.

    Args:
        entry: The manifest entry (its ``adapter_key`` must be set).

    Returns:
        The adapter instance, resolved through the registry's alias map (so the
        manifest's ``grpc`` for ``protobuf/`` fixtures works).
    """
    assert entry.adapter_key is not None, f"{entry.path}: entry declares no adapter_key"
    return get_import_source(resolve_import_source_key(entry.adapter_key))


def valid_entries() -> List[CorpusEntry]:
    """Valid entries owned by an adapter, excluding fileset members.

    Returns:
        Every ``valid`` manifest entry with an ``adapter_key``, minus multi-file set
        *members* — a member exists only to be referenced by its set's root, which
        is imported as a whole through ``parse_fileset``.
    """
    return [
        entry
        for entry in load_corpus(validity_class=ValidityClass.VALID)
        if entry.adapter_key is not None and entry.fileset_role is not FilesetRole.MEMBER
    ]


def build_fileset(entry: CorpusEntry) -> IntakeFileset:
    """Assemble the :class:`IntakeFileset` for a multi-file set's root entry.

    Args:
        entry: The set's ``root`` entry; every file beside it in the per-set
            subdirectory becomes a member.

    Returns:
        The fileset, rooted at the entry's own filename.
    """
    set_dir = entry.absolute_path.parent
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(set_dir.iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root=entry.absolute_path.name)
