"""Corpus-wide import contract tests — IXH-1.2 (#5088).

Every valid corpus entry must (a) be claimed by its own adapter's ``detect()``
at the confidence the manifest records, and (b) run parse → normalize → lint
without an unhandled exception. Known adapter bugs are recorded explicitly in
:data:`~tests.corpus_adapter_support.KNOWN_DETECTION_BUGS` /
:data:`~tests.corpus_adapter_support.KNOWN_IMPORT_BUGS` (strict xfail, so a fixed
adapter forces the entry's removal) rather than silently skipped — mirroring the
manifest's ``notes`` convention from IXH-1.1.

Multi-file sets are exercised through their root via
:meth:`~app.import_source.ImportSource.parse_fileset`; member files are not
parsed standalone (they only exist to be referenced by their set's root).

The entry selection, tool gating, known-bug maps, and fileset assembly live in
:mod:`tests.corpus_adapter_support`, shared with the IXH-1.6 golden runner
(:mod:`tests.test_corpus_golden`) so both suites gate on the same knowledge.
"""

from __future__ import annotations

from pathlib import PurePosixPath

import pytest
from corpus_adapter_support import (
    KNOWN_DETECTION_BUGS,
    KNOWN_IMPORT_BUGS,
    adapter_for,
    build_fileset,
    missing_tools,
    valid_entries,
)
from corpus_loader import CorpusEntry, FilesetRole

from app.import_source import DetectionInput, load_builtin_import_sources

load_builtin_import_sources()


def _detection_param(entry: CorpusEntry) -> "pytest.param":
    marks = []
    if entry.path in KNOWN_DETECTION_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_DETECTION_BUGS[entry.path], strict=True))
    return pytest.param(entry, id=entry.path, marks=marks)


def _import_param(entry: CorpusEntry) -> "pytest.param":
    marks = []
    if entry.path in KNOWN_IMPORT_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_IMPORT_BUGS[entry.path], strict=True))
    missing = missing_tools(entry.adapter_key or "")
    if missing:
        marks.append(
            pytest.mark.skip(
                reason=f"bundled {', '.join(missing)} not resolvable in this environment"
            )
        )
    return pytest.param(entry, id=entry.path, marks=marks)


@pytest.mark.parametrize("entry", [_detection_param(e) for e in valid_entries()])
def test_adapter_claims_example_at_recorded_confidence(entry: CorpusEntry) -> None:
    adapter = adapter_for(entry)
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


@pytest.mark.parametrize("entry", [_import_param(e) for e in valid_entries()])
def test_example_parses_normalizes_and_lints(entry: CorpusEntry) -> None:
    adapter = adapter_for(entry)
    if entry.fileset_role is FilesetRole.ROOT:
        native_ast = adapter.parse_fileset(build_fileset(entry), source_label=entry.path)
    else:
        native_ast = adapter.parse(entry.read_text(), source_label=entry.path)
    model = adapter.normalize(native_ast)
    assert model is not None, f"{entry.path}: normalize returned no canonical model"
    report = adapter.lint(model)
    assert report is not None, f"{entry.path}: lint returned no report"
