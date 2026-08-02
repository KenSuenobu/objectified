"""Scale corpus performance budgets — IXH-1.5 (#5091).

Drives every generated scale fixture (``scripts/generate_scale_corpus.py``) through
the ten import and export stages, records per-stage wall-clock and peak memory, and
holds each number to the committed baseline in ``tests/scale/scale_budgets.json``
with a configurable regression margin.

**Opt-in.** The suite builds ~7 MiB of documents and runs minutes of real pipeline
work, so it does not run on every PR. Enable it with::

    RUN_SCALE_SUITE=1 pytest tests/test_scale_corpus.py
    pytest tests/test_scale_corpus.py --scale

CI runs it on a schedule (``.github/workflows/apiome-rest-scale.yml``), not per PR.
The harness itself — the comparison rules, the budget file, the generator spec — is
covered by :mod:`tests.test_scale_harness`, which *does* run on every PR, so a
change that breaks the gate is caught immediately even though the measurements are
not taken.

**Refreshing the baseline.** One command, one file::

    RUN_SCALE_SUITE=1 pytest tests/test_scale_corpus.py --update-scale-budgets

**The report artifact.** Every run writes a machine-readable report to
``apiome-rest/reports/scale-benchmark.json`` (override with ``SCALE_REPORT_PATH``)
carrying each stage's numbers, the budget it was held to, and the environment they
were measured in. The scheduled workflow uploads it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest
from scale_benchmark import (
    ABSOLUTE_STAGE_PEAK_BYTES,
    ABSOLUTE_STAGE_SECONDS,
    BUDGETS_PATH,
    STAGE_ORDER,
    FixtureMeasurement,
    benchmark_fixture,
    budgets_from_measurements,
    build_report,
    ceiling_breaches,
    compare,
    describe_breach,
    describe_regression,
    load_budgets,
    report_path,
    save_budgets,
    write_report,
)
from scale_corpus_spec import load_generator, scale_fixtures, scale_paradigms


@pytest.fixture(scope="session")
def scale_corpus_dir(tmp_path_factory) -> Path:
    """Materialize every generated scale fixture once per session.

    Returns:
        The directory holding the generated documents.
    """
    out_dir = tmp_path_factory.mktemp("scale")
    load_generator().write_all(out_dir)
    return out_dir


@pytest.fixture(scope="session")
def benchmark_run(request, scale_corpus_dir) -> Dict[str, Any]:
    """Run the whole benchmark once and return everything the tests assert on.

    Running every fixture in one session-scoped fixture (rather than one per test)
    keeps the expensive work to a single pass and lets the report artifact describe
    the run as a whole. ``--update-scale-budgets`` rewrites the baseline here, before
    any assertion runs, so a refresh always succeeds and lands as a reviewable diff.

    Returns:
        A dict with the ``measurements``, the ``budgets`` document, the
        ``regressions`` / ``problems`` / ``breaches`` the comparison found, the
        ``report`` payload, and the ``report_path`` it was written to.
    """
    fixtures = scale_fixtures()
    measurements: List[FixtureMeasurement] = [
        benchmark_fixture(fixture, scale_corpus_dir / fixture.name) for fixture in fixtures
    ]

    updating = bool(request.config.getoption("--update-scale-budgets", default=False))
    if updating:
        save_budgets(budgets_from_measurements(measurements, load_budgets()))

    document = load_budgets()
    regressions, problems = compare(measurements, document)
    breaches = ceiling_breaches(measurements)
    report = build_report(measurements, document, regressions, problems, breaches)
    written = write_report(report)

    return {
        "measurements": measurements,
        "budgets": document,
        "regressions": regressions,
        "problems": problems,
        "breaches": breaches,
        "report": report,
        "report_path": written,
        "updating": updating,
    }


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------


def test_every_paradigm_has_a_scale_fixture(benchmark_run):
    """Every required paradigm is represented by at least one measured fixture.

    The first acceptance criterion: REST, RPC, event, data-schema, and
    EDI/mainframe each need a document at scale, or the tier is measuring only the
    formats someone happened to think of.
    """
    measured = {measurement.paradigm for measurement in benchmark_run["measurements"]}
    missing = sorted(set(scale_paradigms()) - measured)
    assert not missing, f"no scale fixture covers paradigm(s): {missing}"


def test_every_stage_is_measured_for_every_fixture(benchmark_run):
    """All ten stages produce a number for every fixture.

    A stage that silently produced nothing would leave a hole in the budget file
    that no regression could ever fail against.
    """
    for measurement in benchmark_run["measurements"]:
        assert tuple(measurement.stages) == STAGE_ORDER, (
            f"{measurement.name}: measured stages {tuple(measurement.stages)} "
            f"do not match the pipeline's {STAGE_ORDER}"
        )
        for name, stage in measurement.stages.items():
            assert stage.wall_ms > 0, f"{measurement.name}: stage {name} recorded no time"
            assert stage.peak_bytes >= 0, f"{measurement.name}: stage {name} peak is negative"


def test_fixtures_import_and_export_cleanly(benchmark_run):
    """Each scale document really imported and really emitted something.

    A scale fixture is a *valid* document: if it produced an empty canonical model or
    an empty bundle, the timings would be measuring a no-op and the budgets would be
    meaningless.
    """
    for measurement in benchmark_run["measurements"]:
        detail = measurement.detail
        assert detail["types"] or detail["operations"] or detail["channels"], (
            f"{measurement.name}: import produced an empty canonical model"
        )
        assert detail["emitted_files"] > 0, f"{measurement.name}: export emitted no files"
        assert detail["bundle_bytes"] > 0, f"{measurement.name}: packaged bundle is empty"
        assert detail["valid"], (
            f"{measurement.name}: the emitted artifact failed re-validation "
            f"({measurement.export_target})"
        )


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_no_stage_exceeds_its_committed_budget(benchmark_run):
    """No stage regressed past the committed baseline by more than the margin.

    The failure names each fixture, stage, and metric with its before/after and the
    ratio, so a reviewer sees *what* got slower rather than that "the scale suite
    failed".
    """
    if benchmark_run["updating"]:
        pytest.skip("baseline was refreshed in this run; comparison is vacuous")
    regressions = benchmark_run["regressions"]
    assert not regressions, "scale budget regressions:\n  " + "\n  ".join(
        describe_regression(regression) for regression in regressions
    )


def test_budget_file_covers_exactly_the_measured_fixtures(benchmark_run):
    """The committed baseline has an entry for every fixture and no stale ones.

    A fixture with no budget could never fail, and a budget for a fixture that no
    longer exists is a rotting number nobody will notice.
    """
    problems = benchmark_run["problems"]
    assert not problems, "scale budget file problems:\n  " + "\n  ".join(problems)


def test_no_stage_exceeds_the_absolute_ceilings(benchmark_run):
    """No stage passed the baseline-independent ceilings.

    The backstop for a run with no usable budgets (a new runner, a fresh checkout):
    a stage that hangs or allocates a gigabyte fails regardless of what the committed
    numbers say.
    """
    breaches = benchmark_run["breaches"]
    assert not breaches, (
        f"stages over the absolute ceilings ({ABSOLUTE_STAGE_SECONDS}s / "
        f"{ABSOLUTE_STAGE_PEAK_BYTES / 1024 / 1024:.0f} MiB):\n  "
        + "\n  ".join(describe_breach(breach) for breach in breaches)
    )


# ---------------------------------------------------------------------------
# The artifact
# ---------------------------------------------------------------------------


def test_report_artifact_is_written_and_machine_readable(benchmark_run):
    """The run emits a parseable report carrying every stage number and its budget.

    The second acceptance criterion. Asserted by re-reading the file from disk, so
    the test covers serialization rather than the in-memory payload.
    """
    written: Path = benchmark_run["report_path"]
    assert written.exists(), f"no report artifact at {written}"

    payload = json.loads(written.read_text(encoding="utf-8"))
    assert payload["report_version"] >= 1
    assert payload["environment"]["python"], "the report does not record the runtime"
    assert payload["policy"]["regression_margin"] >= 1.0
    assert len(payload["fixtures"]) == len(benchmark_run["measurements"])

    for fixture in payload["fixtures"]:
        assert tuple(fixture["stages"]) == STAGE_ORDER, (
            f"{fixture['name']}: report stages are not in pipeline order"
        )
        for name, stage in fixture["stages"].items():
            assert isinstance(stage["wall_ms"], (int, float)), f"{name}: wall_ms is not a number"
            assert isinstance(stage["peak_bytes"], int), f"{name}: peak_bytes is not an integer"


def test_report_states_the_verdict_consistently(benchmark_run):
    """The report's ``passed`` flag agrees with the findings it lists."""
    report = benchmark_run["report"]
    expected = not (report["regressions"] or report["problems"] or report["breaches"])
    assert report["passed"] is expected, (
        "the report's verdict contradicts its own findings: "
        f"passed={report['passed']} with {len(report['regressions'])} regression(s), "
        f"{len(report['problems'])} problem(s), {len(report['breaches'])} breach(es)"
    )


def test_budgets_are_committed_in_one_place(benchmark_run):
    """The baseline lives in exactly one committed file, and this run used it.

    The third acceptance criterion's "updatable in one place" half: the file the
    comparison read is the file ``--update-scale-budgets`` writes.
    """
    assert BUDGETS_PATH.exists(), f"the committed baseline is missing: {BUDGETS_PATH}"
    on_disk = json.loads(BUDGETS_PATH.read_text(encoding="utf-8"))
    assert on_disk == benchmark_run["budgets"], (
        "the run compared against a budget document that is not the committed file"
    )
    assert report_path() != BUDGETS_PATH, (
        "the report artifact must not overwrite the committed baseline"
    )
