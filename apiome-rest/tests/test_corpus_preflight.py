"""Corpus-wide pre-flight contract tests — IXH-2.1 (#5096).

The acceptance criterion "the endpoint is covered by the corpus runner" in two sweeps:

* **every valid entry pre-flights** — the report comes back ``ok`` with a fingerprint, a
  routing decision, a resolved style guide, and a lint verdict whose findings are ranked;
* **every negative entry returns a taxonomy code** — ``ok`` is false and the reported
  ``error.code`` is exactly the manifest's ``expected_error_code``, the same code the
  committing import job produces (:mod:`tests.test_corpus_negative`), because pre-flight
  drives the same pipeline.

Persistence is booby-trapped for the whole module: a pre-flight that reaches a store call
fails the test that triggered it, whatever else the report says.

Entry selection, tool gating, the known-adapter-bug map, and multi-file assembly are the
shared corpus knowledge in :mod:`tests.corpus_adapter_support` — a known-bug entry is a
**strict** xfail here too, so fixing the adapter forces its removal from the map.
"""

from __future__ import annotations

import base64
from typing import Any, List

import pytest
from corpus_adapter_support import (
    KNOWN_IMPORT_BUGS,
    build_fileset_archive,
    missing_tools,
    valid_entries,
)
from corpus_loader import CorpusEntry, FilesetRole, ValidityClass, load_corpus

from app import import_source_pipeline
from app.import_preflight import clear_preflight_cache, run_import_preflight
from app.import_source import load_builtin_import_sources
from app.models import ImportPreflightRequest
from app.schema_lint import SEVERITY_PENALTY

load_builtin_import_sources()

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"

#: Size ceiling for an adversarial fixture submitted through the pre-flight body — the
#: tier's generated multi-gigabyte fixtures belong to the job-API smoke, not here.
_MAX_ADVERSARIAL_BYTES = 1_000_000


def _negative_entries() -> List[CorpusEntry]:
    """Every ``invalid`` manifest entry owned by an adapter."""
    return [
        entry
        for entry in load_corpus(validity_class=ValidityClass.INVALID)
        if entry.adapter_key is not None
    ]


def _param(entry: CorpusEntry, *, xfail_known_bugs: bool) -> "pytest.param":
    """Build the parametrization for one entry, with its tool/known-bug marks."""
    marks = []
    if xfail_known_bugs and entry.path in KNOWN_IMPORT_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_IMPORT_BUGS[entry.path], strict=True))
    missing = missing_tools(entry.adapter_key or "")
    if missing:
        marks.append(
            pytest.mark.skip(
                reason=f"bundled {', '.join(missing)} not resolvable in this environment"
            )
        )
    return pytest.param(entry, id=entry.path, marks=marks)


def _request_for(entry: CorpusEntry) -> ImportPreflightRequest:
    """Build the pre-flight request that submits a corpus entry over the wire.

    Single-file entries submit their own bytes. A multi-file set's *root* entry submits
    the whole set as a zip with the root named explicitly — the transport shape a caller
    must use, since pre-flight receives one blob rather than an assembled fileset.

    Args:
        entry: The manifest entry to submit.

    Returns:
        The request, with ``source_kind`` pinned to the entry's declared adapter so a
        detection deviation (tracked separately in the manifest ``notes``) cannot change
        which importer the pre-flight exercises.
    """
    if entry.fileset_role is FilesetRole.ROOT:
        raw = build_fileset_archive(entry)
        filename = entry.absolute_path.parent.name + ".zip"
        archive_root: Any = entry.absolute_path.name
    else:
        raw = entry.read_bytes()
        filename = entry.path.rsplit("/", 1)[-1]
        archive_root = None
    return ImportPreflightRequest(
        document_base64=base64.standard_b64encode(raw).decode("ascii"),
        source_kind=entry.adapter_key,
        filename=filename,
        archive_root=archive_root,
    )


@pytest.fixture(autouse=True)
def _no_persistence(monkeypatch):
    """Fail any pre-flight that reaches a persistence hook."""

    def _trap(name: str):
        def _hook(*args: Any, **kwargs: Any):
            raise AssertionError(f"pre-flight reached {name}")

        return _hook

    monkeypatch.setattr(
        import_source_pipeline, "persist_adapter_import", _trap("persist_adapter_import")
    )
    monkeypatch.setattr(
        import_source_pipeline, "persist_types_as_current", _trap("persist_types_as_current")
    )


@pytest.fixture(autouse=True)
def _isolated_cache():
    """Each entry is pre-flighted cold, so a report can never come from a sibling test."""
    clear_preflight_cache()
    yield
    clear_preflight_cache()


@pytest.mark.parametrize(
    "entry", [_param(e, xfail_known_bugs=True) for e in valid_entries()]
)
async def test_valid_entry_preflights_with_a_ranked_lint_verdict(entry: CorpusEntry) -> None:
    report = await run_import_preflight(
        _request_for(entry), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )

    assert report.ok, (
        f"{entry.path}: pre-flight failed with "
        f"{report.error.code if report.error else 'no error payload'}"
    )
    assert report.error is None, f"{entry.path}: an ok report must carry no error"
    assert report.detection.adapter_key == report.detection.requested_adapter_key
    assert report.fingerprint, f"{entry.path}: no revision fingerprint"
    assert report.routing is not None, f"{entry.path}: no routing decision"
    assert report.style_guide is not None, f"{entry.path}: no resolved style guide"
    assert report.lint is not None, f"{entry.path}: no lint verdict"

    findings = report.lint.findings
    assert [f.rank for f in findings] == list(range(1, len(findings) + 1)), entry.path
    keys = [(-SEVERITY_PENALTY.get(f.severity, 0.0), -f.rule_penalty) for f in findings]
    assert keys == sorted(keys), f"{entry.path}: findings are not ranked"
    for finding in findings:
        assert finding.rule and finding.message.strip(), entry.path
        assert finding.severity in {"error", "warning", "info"}, entry.path


def _small_adversarial_entries() -> List[CorpusEntry]:
    """Committed adversarial entries small enough to submit as a pre-flight body.

    The tier's generated fixtures are deliberately enormous (a sparse gibibyte); they are
    covered where they belong — the job API's never-a-5xx smoke — and base64-inflating one
    into a request body here would buy nothing. What matters for pre-flight is that the
    intake *guards* fire on the same path, which the small committed fixtures prove.
    """
    return [
        entry
        for entry in load_corpus(validity_class=ValidityClass.ADVERSARIAL)
        if entry.adapter_key is not None
        and entry.expected_error_code is not None
        and entry.absolute_path.exists()
        and entry.absolute_path.stat().st_size <= _MAX_ADVERSARIAL_BYTES
    ]


@pytest.mark.parametrize(
    "entry", [_param(e, xfail_known_bugs=False) for e in _small_adversarial_entries()]
)
async def test_adversarial_entry_preflights_to_its_guard_code(entry: CorpusEntry) -> None:
    """IXH-1.4 guards bound pre-flight too, reported as their own taxonomy codes."""
    report = await run_import_preflight(
        _request_for(entry), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert not report.ok, f"{entry.path}: a guarded document pre-flighted as importable"
    assert report.error is not None, f"{entry.path}: failed report carries no error"
    assert report.error.code == entry.expected_error_code, entry.path


@pytest.mark.parametrize(
    "entry", [_param(e, xfail_known_bugs=False) for e in _negative_entries()]
)
async def test_negative_entry_preflights_to_its_taxonomy_code(entry: CorpusEntry) -> None:
    report = await run_import_preflight(
        _request_for(entry), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )

    assert not report.ok, f"{entry.path}: an invalid entry pre-flighted as importable"
    assert report.error is not None, f"{entry.path}: failed report carries no error"
    assert report.error.code == entry.expected_error_code, entry.path
    assert report.error.remediation.strip(), f"{entry.path}: empty remediation"
    assert report.lint is None, f"{entry.path}: a failed candidate must carry no lint verdict"
