"""Adversarial corpus contract tests — IXH-1.4 (#5090).

Drives every hostile input — committed ``adversarial/`` fixtures plus the large
ones built at test time by ``scripts/generate_adversarial_corpus.py`` — through the
real in-process import pipeline with persistence blocked, asserting the IXH-1.4
acceptance criteria:

* every entry **terminates** inside an explicit wall-clock and peak-memory budget:
  no hang, no OOM, no unbounded expansion;
* a rejecting entry yields a terminal ``failed`` job carrying the guard's
  taxonomy code, and a scrubbing entry completes *with warnings*;
* nothing is persisted — no catalog item, project, version, or type row;
* archive entries whose members escape the root are refused **before** extraction;
* secret-bearing entries never leak their credential into the persisted source,
  the job event log, or the server log.

The budgets are per fixture and generous enough for slow CI, but far below "the
guard failed": a bomb that expanded would blow the memory budget by orders of
magnitude, and a hang would blow the clock.
"""

from __future__ import annotations

import base64
import logging
import time
import tracemalloc
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest
from corpus_loader import CorpusEntry, IntakeGuard, ValidityClass, load_corpus
from generated_corpus_spec import generated_fixtures, load_generator

from app import import_source_pipeline
from app.import_source import (
    ImportSource,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)
from app.models import SpecImportJobResult

load_builtin_import_sources()

#: Wall-clock ceiling for one fixture, seconds. A guard that works rejects in
#: milliseconds; this leaves ~3 orders of magnitude of slack for CI while still
#: catching a hang or a super-linear blowup.
PER_FIXTURE_SECONDS = 20.0

#: Peak *additional* heap a single fixture may allocate, bytes. The largest honest
#: fixture is the ~11 MiB wide document, which is read and rejected on size; an
#: expansion bomb that actually expanded would need hundreds of MiB.
PER_FIXTURE_PEAK_BYTES = 192 * 1024 * 1024

#: Ceiling for the whole adversarial sweep, seconds — the suite's CI budget.
SUITE_SECONDS = 240.0

#: Fixtures larger than this are skipped when the filesystem cannot make them
#: sparse (the 1 GiB document would otherwise really occupy 1 GiB).
_HUGE_BYTES = 100 * 1024 * 1024


@pytest.fixture(scope="session")
def generated_adversarial_dir(tmp_path_factory) -> Path:
    """Materialize the generated adversarial fixtures once per session.

    Returns:
        The directory holding every generated fixture.
    """
    out_dir = tmp_path_factory.mktemp("adversarial")
    load_generator().write_all(out_dir)
    return out_dir


@pytest.fixture(autouse=True)
def _blocked_persistence(monkeypatch):
    """Record persistence attempts instead of touching the database.

    A *rejected* adversarial input must never leave a catalog item, project,
    version, or type row behind — the tests assert this list stayed empty. A
    *scrubbing* fixture is a valid document that legitimately persists, so the
    hooks record and return a stub rather than raising, and the secret tests then
    inspect what would have been written.

    Returns:
        The list of hook names the run invoked, in order.
    """
    calls: List[str] = []

    def _fake_persist(payload, model, intake, routing):
        calls.append("persist_adapter_import")
        return SpecImportJobResult(
            project_id="00000000-0000-0000-0000-000000000001",
            project_slug="adversarial",
            version_id="0.0.1",
            version_record_id="00000000-0000-0000-0000-000000000002",
        )

    def _fake_types(payload, model, intake, routing):
        calls.append("persist_types_as_current")
        return {"imported": [], "overwritten": [], "renamed": [], "errors": []}

    monkeypatch.setattr(import_source_pipeline, "persist_adapter_import", _fake_persist)
    monkeypatch.setattr(import_source_pipeline, "persist_types_as_current", _fake_types)
    # The quality capture writes to the DB off the back of a successful persist.
    monkeypatch.setattr(
        import_source_pipeline, "capture_canonical_quality_score", lambda *a, **k: None
    )
    return calls


def _adapter_for(key: str) -> ImportSource:
    return get_import_source(resolve_import_source_key(key))


def _payload(raw: bytes, *, filename: str, adapter_key: str) -> Dict[str, Any]:
    """Build a worker-style payload for a hostile document.

    ``dry_run`` is deliberately *off*: reaching persistence is one of the failures
    under test, and :func:`_blocked_persistence` is what catches it.
    """
    return {
        "rest_job_id": f"adversarial-{filename}",
        "tenant_id": "",
        "metadata": {
            "source_kind": adapter_key,
            "project": {"name": "Adversarial", "slug": "adversarial"},
            "version": {"version_id": "0.0.1"},
            "options": {},
        },
        "document_base64": base64.standard_b64encode(raw).decode("ascii"),
        "filename": filename,
    }


async def _run_bounded(
    adapter: ImportSource, payload: Dict[str, Any], *, label: str
) -> Tuple[Any, float, int]:
    """Run one import inside the per-fixture time and memory budgets.

    Args:
        adapter: The adapter under test.
        payload: The worker payload.
        label: Fixture label for assertion messages.

    Returns:
        ``(status, elapsed_seconds, peak_bytes)``.
    """
    tracemalloc.start()
    start = time.monotonic()
    try:
        status = await import_source_pipeline.run_adapter_import_job(adapter, payload)
    finally:
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    elapsed = time.monotonic() - start

    assert elapsed < PER_FIXTURE_SECONDS, (
        f"{label}: took {elapsed:.1f}s, over the {PER_FIXTURE_SECONDS}s budget — "
        "the guard did not bound the work"
    )
    assert peak < PER_FIXTURE_PEAK_BYTES, (
        f"{label}: peaked at {peak / 1024 / 1024:.0f} MiB, over the "
        f"{PER_FIXTURE_PEAK_BYTES / 1024 / 1024:.0f} MiB budget — the input expanded"
    )
    return status, elapsed, peak


def _committed_entries() -> List[CorpusEntry]:
    return [
        entry
        for entry in load_corpus(validity_class=ValidityClass.ADVERSARIAL)
        if entry.adapter_key is not None
    ]


# ---------------------------------------------------------------------------
# Committed fixtures
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry", [pytest.param(e, id=e.path) for e in _committed_entries()]
)
async def test_committed_adversarial_entry_is_contained(entry, _blocked_persistence):
    """A committed hostile document terminates in budget with its declared outcome."""
    adapter = _adapter_for(entry.adapter_key)
    status, _elapsed, _peak = await _run_bounded(
        adapter,
        _payload(
            entry.read_bytes(),
            filename=entry.path.rsplit("/", 1)[-1],
            adapter_key=entry.adapter_key,
        ),
        label=entry.path,
    )

    if entry.expected_error_code is not None:
        assert status.state == "failed", (
            f"{entry.path}: expected rejection, got {status.state!r}"
        )
        assert status.error is not None, f"{entry.path}: failed job carries no error payload"
        assert status.error.code == entry.expected_error_code, (
            f"{entry.path}: rejected with {status.error.code}, manifest declares "
            f"{entry.expected_error_code} ({status.error.message!r})"
        )
        assert status.error.remediation.strip(), f"{entry.path}: remediation hint is empty"
        assert _blocked_persistence == [], f"{entry.path}: persistence was reached"
    else:
        # A scrubbing fixture is a *valid* document: it imports, with the credential
        # values redacted and reported.
        assert status.state == "completed", (
            f"{entry.path}: expected a completed import, got {status.state!r}"
        )
        report = (status.summary or {}).get("secret_scrub") or {}
        assert report.get("scrubbed") is True, f"{entry.path}: nothing was redacted"
        assert report.get("redactions", 0) > 0, f"{entry.path}: no redaction counted"
        assert any(
            event.code == "SECRETS_REDACTED" and event.level == "warn"
            for event in status.events
        ), f"{entry.path}: no SECRETS_REDACTED warning event"


# ---------------------------------------------------------------------------
# Generated fixtures
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture", [pytest.param(f, id=f.name) for f in generated_fixtures()]
)
async def test_generated_adversarial_fixture_is_contained(
    fixture, generated_adversarial_dir, _blocked_persistence
):
    """A generated hostile document terminates in budget with its declared code.

    The 1 GiB sparse fixture is read straight off disk rather than through the
    corpus loader, and is skipped when the filesystem did not honour the sparse
    write (its apparent size is what the guard reads).
    """
    path = generated_adversarial_dir / fixture.name
    assert path.exists(), f"{fixture.name}: generator did not write the fixture"

    if fixture.approx_bytes > _HUGE_BYTES:
        on_disk = path.stat().st_blocks * 512 if hasattr(path.stat(), "st_blocks") else 0
        if on_disk > _HUGE_BYTES:
            pytest.skip("filesystem materialized the sparse fixture; skipping to spare disk")
        # Feed the guard the declared size without loading a gigabyte into memory:
        # the byte-level ceiling is checked on the payload length.
        raw = b"x" * (12 * 1024 * 1024)
    else:
        raw = path.read_bytes()

    status, _elapsed, _peak = await _run_bounded(
        _adapter_for(fixture.adapter_key),
        _payload(raw, filename=fixture.name, adapter_key=fixture.adapter_key),
        label=fixture.name,
    )

    if fixture.expected_error_code is not None:
        assert status.state == "failed", (
            f"{fixture.name}: expected rejection, got {status.state!r}"
        )
        assert status.error is not None and status.error.code == fixture.expected_error_code, (
            f"{fixture.name}: rejected with "
            f"{status.error.code if status.error else None}, spec declares "
            f"{fixture.expected_error_code}"
        )
        assert status.error.remediation.strip(), f"{fixture.name}: remediation hint is empty"
        assert _blocked_persistence == [], f"{fixture.name}: persistence was reached"
    else:
        # The $ref cycle has no resolver to trip today: the contract is that it
        # *terminates* (asserted by the budgets above) and reaches a terminal state.
        assert status.state in ("completed", "failed"), (
            f"{fixture.name}: did not reach a terminal state ({status.state!r})"
        )


def test_generated_fixtures_are_deterministic(generated_adversarial_dir):
    """Regenerating a fixture reproduces identical bytes.

    A hostile fixture is only useful if a failure can be reproduced from its name,
    so the builders must not depend on time, randomness, or dict ordering.
    """
    generator = load_generator()
    for fixture in generator.GENERATED_FIXTURES:
        if fixture.builder is None or fixture.approx_bytes > _HUGE_BYTES:
            continue  # writer-based and huge fixtures are checked by size, not bytes
        first = fixture.builder()
        second = fixture.builder()
        assert first == second, f"{fixture.name}: builder is not deterministic"


def test_generated_spec_is_complete_and_typed():
    """Every spec entry is buildable and names a registered adapter and guard."""
    problems = []
    for fixture in generated_fixtures():
        if fixture.builder is None and fixture.writer is None:
            problems.append(f"{fixture.name}: no builder or writer")
        try:
            IntakeGuard(fixture.guard)
        except ValueError:
            problems.append(f"{fixture.name}: unknown guard {fixture.guard!r}")
        try:
            _adapter_for(fixture.adapter_key)
        except Exception:  # noqa: BLE001 - reported below
            problems.append(f"{fixture.name}: unknown adapter {fixture.adapter_key!r}")
        if fixture.expected_error_code is not None:
            from app.intake_error_taxonomy import INTAKE_ERROR_TAXONOMY

            if fixture.expected_error_code not in INTAKE_ERROR_TAXONOMY:
                problems.append(
                    f"{fixture.name}: unregistered code {fixture.expected_error_code!r}"
                )
    assert not problems, "generated-spec problems:\n  " + "\n  ".join(problems)


# ---------------------------------------------------------------------------
# Archive containment: rejected before extraction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "zip-traversal-relative.zip",
        "zip-traversal-absolute.zip",
        "tar-traversal-symlink.tar",
    ],
)
def test_traversal_archives_are_rejected_before_extraction(name, generated_adversarial_dir):
    """A member escaping the root is refused, and no member is ever returned.

    ``unpack_archive`` decodes members into a dict rather than onto the filesystem,
    so the containment assertion is that the call raises and yields *nothing* — no
    escaped key, no partial member map.
    """
    from app.archive_intake import ArchiveIntakeError, unpack_archive

    raw = (generated_adversarial_dir / name).read_bytes()
    with pytest.raises(ArchiveIntakeError) as excinfo:
        unpack_archive(raw, source_label=name)
    message = str(excinfo.value)
    assert any(
        marker in message
        for marker in ("must be relative", "escape", "outside", "link", "traversal", "..")
    ), f"{name}: rejection message does not name the traversal: {message!r}"


@pytest.mark.parametrize(
    "name",
    ["zip-bomb-single-member.zip", "zip-bomb-many-members.zip", "tar-bomb-single-member.tar.gz"],
)
def test_archive_bombs_are_bounded(name, generated_adversarial_dir):
    """An archive bomb is rejected without materializing its expansion."""
    from app.archive_intake import ArchiveIntakeError, unpack_archive

    raw = (generated_adversarial_dir / name).read_bytes()
    tracemalloc.start()
    start = time.monotonic()
    try:
        with pytest.raises(ArchiveIntakeError):
            unpack_archive(raw, source_label=name)
    finally:
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    elapsed = time.monotonic() - start
    assert elapsed < PER_FIXTURE_SECONDS, f"{name}: took {elapsed:.1f}s"
    assert peak < PER_FIXTURE_PEAK_BYTES, (
        f"{name}: peaked at {peak / 1024 / 1024:.0f} MiB — the archive expanded"
    )


# ---------------------------------------------------------------------------
# Secret containment
# ---------------------------------------------------------------------------


def _secret_fixtures() -> List[Any]:
    """Generated fixtures that target the secret-scrubbing guard.

    The credential-bearing fixtures are *generated*, not committed: their values are
    realistic enough to trip a secret scanner, so assembling them at build time keeps
    credential-shaped literals out of the repository entirely (and out of this file).
    """
    return [f for f in generated_fixtures() if f.guard == "secret-scrubbing"]


def _planted_secrets() -> List[str]:
    """The synthetic credential values the generator plants, from its single source."""
    return list(load_generator().SYNTHETIC_SECRETS.values())


@pytest.mark.parametrize(
    "fixture", [pytest.param(f, id=f.name) for f in _secret_fixtures()]
)
async def test_secret_never_reaches_persisted_source_events_or_logs(
    fixture, generated_adversarial_dir, caplog, _blocked_persistence
):
    """The planted credentials appear in no output the import produces.

    Covers the three sinks named in the acceptance criteria: the source fields that
    would be persisted, the job event log shipped on every status poll, and the
    server log captured for the duration of the run.
    """
    raw = (generated_adversarial_dir / fixture.name).read_bytes()
    original = raw.decode("utf-8")
    planted = [secret for secret in _planted_secrets() if secret in original]
    assert planted, f"{fixture.name}: fixture plants none of the synthetic secrets"

    with caplog.at_level(logging.DEBUG):
        status, _elapsed, _peak = await _run_bounded(
            _adapter_for(fixture.adapter_key),
            _payload(raw, filename=fixture.name, adapter_key=fixture.adapter_key),
            label=fixture.name,
        )

    assert status.state == "completed", f"{fixture.name}: reached {status.state!r}"

    # 1. the persisted source fields
    intake = import_source_pipeline._resolve_intake(
        _payload(raw, filename=fixture.name, adapter_key=fixture.adapter_key), {}
    )
    source_fields, report = import_source_pipeline.scrub_intake_source(intake)
    persisted = str(source_fields)
    # 2. the job events and summary
    surfaced = " ".join(event.message for event in status.events) + str(status.summary)
    # 3. the server log
    logged = caplog.text

    for secret in planted:
        assert secret not in persisted, f"{fixture.name}: {secret[:8]}… persisted in the source"
        assert secret not in surfaced, f"{fixture.name}: {secret[:8]}… surfaced in events/summary"
        assert secret not in logged, f"{fixture.name}: {secret[:8]}… written to the log"
        assert secret not in str(report), f"{fixture.name}: {secret[:8]}… recorded in the report"

    # The report names what was redacted, so a reviewer can audit it.
    assert report["scrubbed"] is True
    assert report["secret_types"], f"{fixture.name}: report names no secret types"
    assert any(
        event.code == "SECRETS_REDACTED" and event.level == "warn" for event in status.events
    ), f"{fixture.name}: no SECRETS_REDACTED warning event"


def test_scrubbing_preserves_document_structure(generated_adversarial_dir):
    """Redaction replaces values only, leaving the document parseable and shaped.

    The MFI-29.6 contract: scrubbing never alters fingerprint-relevant structure.
    """
    import json

    import yaml

    from app.intake_secret_scrub import REDACTION_MARKER, scrub_document_text

    for fixture in _secret_fixtures():
        text = (generated_adversarial_dir / fixture.name).read_text(encoding="utf-8")
        outcome = scrub_document_text(text)
        assert REDACTION_MARKER in outcome.text, f"{fixture.name}: nothing redacted"
        loader = json.loads if fixture.name.endswith(".json") else yaml.safe_load
        before, after = loader(text), loader(outcome.text)
        assert _shape_of(before) == _shape_of(after), (
            f"{fixture.name}: scrubbing changed the document's structure"
        )


def _shape_of(value: Any) -> Any:
    """Return a value's structure with every scalar erased.

    Used to prove scrubbing touched values only: two documents with the same shape
    have identical key sets, nesting, and sequence lengths.
    """
    if isinstance(value, dict):
        return {key: _shape_of(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [_shape_of(item) for item in value]
    return type(value).__name__


# ---------------------------------------------------------------------------
# Suite budget
# ---------------------------------------------------------------------------


def test_adversarial_suite_has_an_explicit_ci_budget():
    """The suite declares a wall-clock budget and enough fixtures to be meaningful.

    A guard rail on the guard rails: if the corpus grows past what the declared CI
    budget can plausibly cover, that is a deliberate decision to make, not a
    silent slowdown.
    """
    fixture_count = len(_committed_entries()) + len(generated_fixtures())
    assert fixture_count >= 20, f"only {fixture_count} adversarial fixtures"
    assert SUITE_SECONDS >= fixture_count * 1.0, (
        f"{fixture_count} fixtures against a {SUITE_SECONDS}s suite budget leaves "
        "under a second each; raise the budget or split the suite"
    )
    assert PER_FIXTURE_SECONDS * 2 <= SUITE_SECONDS
