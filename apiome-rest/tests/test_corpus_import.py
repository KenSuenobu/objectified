"""Corpus-wide import contract tests — IXH-1.2 (#5088).

Every valid corpus entry must (a) be claimed by its own adapter's ``detect()``
at the confidence the manifest records, and (b) run parse → normalize → lint
without an unhandled exception. Known adapter bugs are recorded explicitly in
:data:`KNOWN_DETECTION_BUGS` / :data:`KNOWN_IMPORT_BUGS` (strict xfail, so a
fixed adapter forces the entry's removal) rather than silently skipped —
mirroring the manifest's ``notes`` convention from IXH-1.1.

Multi-file sets are exercised through their root via
:meth:`~app.import_source.ImportSource.parse_fileset`; member files are not
parsed standalone (they only exist to be referenced by their set's root).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import PurePosixPath
from typing import Dict, List

import pytest
from corpus_loader import (
    CorpusEntry,
    FilesetRole,
    ValidityClass,
    load_corpus,
)

from app.fileset import IntakeFileset
from app.import_source import (
    DetectionInput,
    get_import_source,
    load_builtin_import_sources,
)
from app.toolchain_packaging import probe_tool

load_builtin_import_sources()

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
def _tool_available(tool: str) -> bool:
    """Whether an adapter-required external tool resolves in this runtime."""
    return bool(getattr(probe_tool(tool), "available", False))


def _missing_tools(adapter_key: str) -> List[str]:
    """The adapter's ``required_tools`` that are unavailable in this runtime.

    Mirrors test_grpc_import_source's buf gate: parse steps that shell out to
    a bundled tool (buf, asyncapi-parser, ...) are skipped, not failed, when
    the tool cannot resolve.
    """
    adapter = get_import_source(adapter_key)
    return [
        tool
        for tool in getattr(adapter, "required_tools", ())
        if not _tool_available(tool)
    ]


def _valid_entries() -> List[CorpusEntry]:
    """Valid entries owned by an adapter, excluding fileset members."""
    return [
        entry
        for entry in load_corpus(validity_class=ValidityClass.VALID)
        if entry.adapter_key is not None
        and entry.fileset_role is not FilesetRole.MEMBER
    ]


def _detection_param(entry: CorpusEntry) -> "pytest.param":
    marks = []
    if entry.path in KNOWN_DETECTION_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_DETECTION_BUGS[entry.path], strict=True))
    return pytest.param(entry, id=entry.path, marks=marks)


def _import_param(entry: CorpusEntry) -> "pytest.param":
    marks = []
    if entry.path in KNOWN_IMPORT_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_IMPORT_BUGS[entry.path], strict=True))
    missing = _missing_tools(entry.adapter_key or "")
    if missing:
        marks.append(
            pytest.mark.skip(
                reason=f"bundled {', '.join(missing)} not resolvable in this environment"
            )
        )
    return pytest.param(entry, id=entry.path, marks=marks)


def _build_fileset(entry: CorpusEntry) -> IntakeFileset:
    """Assemble the IntakeFileset for a multi-file set's root entry."""
    set_dir = entry.absolute_path.parent
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(set_dir.iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root=entry.absolute_path.name)


@pytest.mark.parametrize("entry", [_detection_param(e) for e in _valid_entries()])
def test_adapter_claims_example_at_recorded_confidence(entry: CorpusEntry) -> None:
    adapter = get_import_source(entry.adapter_key)
    result = adapter.detect(
        DetectionInput(
            text=entry.read_text(),
            filename=PurePosixPath(entry.path).name,
        )
    )
    expected = entry.expected_detection
    assert result.matched, (
        f"{entry.adapter_key} did not claim {entry.path} "
        f"(expected {expected.format} >= {expected.min_confidence})"
    )
    assert result.confidence >= expected.min_confidence, (
        f"{entry.adapter_key} claimed {entry.path} at {result.confidence}, "
        f"below the manifest's {expected.min_confidence}"
    )


@pytest.mark.parametrize("entry", [_import_param(e) for e in _valid_entries()])
def test_example_parses_normalizes_and_lints(entry: CorpusEntry) -> None:
    adapter = get_import_source(entry.adapter_key)
    if entry.fileset_role is FilesetRole.ROOT:
        native_ast = adapter.parse_fileset(_build_fileset(entry), source_label=entry.path)
    else:
        native_ast = adapter.parse(entry.read_text(), source_label=entry.path)
    model = adapter.normalize(native_ast)
    assert model is not None, f"{entry.path}: normalize returned no canonical model"
    report = adapter.lint(model)
    assert report is not None, f"{entry.path}: lint returned no report"
