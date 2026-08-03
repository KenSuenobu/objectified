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

import io
import zipfile
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Any, Dict, List

from corpus_loader import CorpusEntry, FilesetRole, ValidityClass, load_corpus

from app.fileset import IntakeFileset
from app.import_source import (
    DetectionInput,
    ImportSource,
    get_import_source,
    resolve_import_source_key,
)
from app.proto_descriptor import DESCRIPTOR_SET_SUFFIXES
from app.toolchain_packaging import probe_tool

__all__ = [
    "KNOWN_DETECTION_BUGS",
    "KNOWN_IMPORT_BUGS",
    "adapter_for",
    "build_fileset",
    "build_fileset_archive",
    "detection_input_for",
    "is_binary_entry",
    "missing_tools",
    "parse_native",
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


def is_binary_entry(entry: CorpusEntry) -> bool:
    """Whether a corpus entry is a *binary* artifact rather than source text (IXH-7.5).

    Binary entries (a serialized protobuf ``FileDescriptorSet`` / buf image) are not
    UTF-8 decodable, so the corpus suites must read their bytes and drive the adapter's
    binary seam (``parse_bytes``) instead of ``read_text()``/``parse()``.

    Args:
        entry: The manifest entry.

    Returns:
        ``True`` when the entry's path carries a conventional descriptor-set suffix.
    """
    return entry.path.lower().endswith(DESCRIPTOR_SET_SUFFIXES)


def detection_input_for(entry: CorpusEntry) -> DetectionInput:
    """Build the :class:`DetectionInput` a corpus entry's detection contract runs on.

    Text entries carry their decoded ``text`` exactly as before; binary entries carry
    their undecoded ``data`` bytes instead (IXH-7.5), matching what the intake pipeline
    hands detection for each shape.

    Args:
        entry: The manifest entry.

    Returns:
        The detection payload with the entry's own filename as the hint.
    """
    filename = PurePosixPath(entry.path).name
    if is_binary_entry(entry):
        return DetectionInput(data=entry.read_bytes(), filename=filename)
    return DetectionInput(text=entry.read_text(), filename=filename)


def parse_native(adapter: ImportSource, entry: CorpusEntry) -> Any:
    """Parse a valid corpus entry through the adapter seam its shape requires.

    Multi-file set roots go through ``parse_fileset`` with their per-set siblings;
    binary entries (IXH-7.5) go through ``parse_bytes`` with their raw bytes; every
    other entry parses its own text through ``parse``.

    Args:
        adapter: The entry's resolved adapter.
        entry: The manifest entry.

    Returns:
        The adapter's native AST for the entry.
    """
    if entry.fileset_role is FilesetRole.ROOT:
        return adapter.parse_fileset(build_fileset(entry), source_label=entry.path)
    if is_binary_entry(entry):
        return adapter.parse_bytes(entry.read_bytes(), source_label=entry.path)
    return adapter.parse(entry.read_text(), source_label=entry.path)


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


def build_fileset_archive(entry: CorpusEntry) -> bytes:
    """Zip a multi-file set into the archive bytes an intake endpoint would receive.

    :func:`build_fileset` hands an adapter the already-assembled fileset; a *transport*
    (the import job, the IXH-2.1 pre-flight endpoint) instead receives one blob and unpacks
    it itself. This produces that blob for the same per-set subdirectory.

    Member timestamps are pinned so the archive is byte-identical across runs — a
    ``ZipInfo`` built from the filesystem would embed each file's mtime and make any
    content-hash assertion (such as the pre-flight cache key) flaky.

    Args:
        entry: The set's ``root`` entry; every file beside it becomes an archive member.

    Returns:
        The ``.zip`` bytes, whose root document is the entry's own filename.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(entry.absolute_path.parent.iterdir()):
            if not path.is_file():
                continue
            info = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
            archive.writestr(info, path.read_bytes())
    return buffer.getvalue()
