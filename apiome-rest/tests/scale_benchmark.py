"""Scale-corpus benchmark harness and budget store — IXH-1.5 (#5091).

Runs one generated scale fixture (``scripts/generate_scale_corpus.py``) through the
ten pipeline stages the import and export paths are actually built from, recording
wall-clock and peak memory for each, and compares the result against a **committed
baseline** with a configurable regression margin.

Stages measured
---------------

Import — ``parse`` → ``normalize`` → ``fingerprint`` → ``lint`` → ``persist``.
Export — ``load-source`` → ``analyze-fidelity`` → ``emit`` → ``validate`` →
``package``.

Each stage calls the same function the running pipeline calls
(:mod:`app.import_source_pipeline` and :mod:`app.export_job_engine` respectively),
so a regression in the product is a regression here. Two stages need a note, because
in production they straddle the database:

* **persist** measures :func:`app.import_source_pipeline.scrub_intake_source` — the
  source capture and secret scrub that ``persist_adapter_import`` performs on the
  whole document before it writes anything. The row write itself is excluded: its
  cost belongs to Postgres, varies with the machine, and cannot be attributed to a
  code change, which is the only thing this suite exists to catch.
* **load-source** measures :func:`app.catalog_conversion.build_conversion_source`
  over the item dict a revision row projects into — which is the entire CPU half of
  :func:`app.export_source.load_export_source` (re-parse + re-normalize the captured
  source). Only the single row fetch is left out.

How memory is measured
----------------------

Per stage, the figure is the :mod:`tracemalloc` peak: the high-water mark of Python
allocations *made by that stage*, which is attributable and comparable across runs.
The process-wide peak RSS (``resource.getrusage``) is recorded once per fixture as
:attr:`FixtureMeasurement.process_peak_rss_bytes`; it is a monotonic high-water mark
for the whole process, so it cannot be split per stage — it is reported for context
(and for IXH-6.5, which sizes its per-job ceiling from these numbers) rather than
budgeted.

Budgets and the regression margin
---------------------------------

:data:`BUDGETS_PATH` is the single committed place a baseline lives. A stage fails
when it is **both** over ``baseline × margin`` and over an absolute noise floor, so a
fast stage drifting from 2 ms to 4 ms is not a build failure while a 30 % slowdown of
a two-second stage is. Margins are read from the budget file and can be overridden
per run with ``SCALE_REGRESSION_MARGIN`` / ``SCALE_MEMORY_MARGIN``.

Regenerate the baseline in one command::

    RUN_SCALE_SUITE=1 pytest tests/test_scale_corpus.py --update-scale-budgets
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import platform
import resource
import sys
import time
import tracemalloc
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, TypeVar

from app.canonical_model import CanonicalApi
from app.catalog_conversion import build_conversion_source
from app.emitter import load_builtin_emitters
from app.export_fidelity import build_export_fidelity
from app.export_job_engine import build_export_zip
from app.export_service import emit_canonical, resolve_emit_format, resolve_emitter
from app.export_validation import validate_emitted_artifact
from app.import_source import (
    canonical_fingerprint,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)

__all__ = [
    "ABSOLUTE_STAGE_PEAK_BYTES",
    "ABSOLUTE_STAGE_SECONDS",
    "BUDGETS_PATH",
    "BUDGET_VERSION",
    "DEFAULT_PEAK_FLOOR_BYTES",
    "DEFAULT_PEAK_MARGIN",
    "DEFAULT_WALL_FLOOR_MS",
    "DEFAULT_WALL_MARGIN",
    "EXPORT_STAGES",
    "IMPORT_STAGES",
    "PEAK_MARGIN_ENV",
    "REPORT_PATH_ENV",
    "REPORT_VERSION",
    "STAGE_ORDER",
    "WALL_MARGIN_ENV",
    "Breach",
    "FixtureMeasurement",
    "Regression",
    "StageMeasurement",
    "benchmark_fixture",
    "budgets_from_measurements",
    "build_report",
    "ceiling_breaches",
    "compare",
    "default_report_path",
    "describe_breach",
    "describe_regression",
    "load_budgets",
    "measure",
    "peak_margin",
    "render_budgets",
    "report_path",
    "save_budgets",
    "wall_margin",
    "write_report",
]

# ===========================================================================
# Stage vocabulary
# ===========================================================================

#: Import-side stages, in pipeline order.
IMPORT_STAGES: Tuple[str, ...] = ("parse", "normalize", "fingerprint", "lint", "persist")

#: Export-side stages, in pipeline order (the names the export job publishes,
#: minus the ``-ing`` progress suffix).
EXPORT_STAGES: Tuple[str, ...] = (
    "load-source",
    "analyze-fidelity",
    "emit",
    "validate",
    "package",
)

#: Every measured stage, in the order a document flows through them.
STAGE_ORDER: Tuple[str, ...] = IMPORT_STAGES + EXPORT_STAGES

# ===========================================================================
# Budget store
# ===========================================================================

#: Envelope version of the budget file. Bump only when its *shape* changes, so a
#: wholesale regeneration is distinguishable in review from a measurement refresh.
BUDGET_VERSION = 1

#: Envelope version of the machine-readable benchmark report.
REPORT_VERSION = 1

#: The one committed place a baseline lives.
BUDGETS_PATH = Path(__file__).resolve().parent / "scale" / "scale_budgets.json"

#: Environment variable that redirects the report artifact.
REPORT_PATH_ENV = "SCALE_REPORT_PATH"

#: Per-run overrides for the budget file's margins.
WALL_MARGIN_ENV = "SCALE_REGRESSION_MARGIN"
PEAK_MARGIN_ENV = "SCALE_MEMORY_MARGIN"

#: Absolute ceilings, independent of any baseline. A stage over these has not
#: "regressed against a budget" — it has broken, and it fails even on a machine
#: with no usable baseline (a fresh checkout, a new runner).
ABSOLUTE_STAGE_SECONDS = 180.0
ABSOLUTE_STAGE_PEAK_BYTES = 1024 * 1024 * 1024

#: Defaults used when the budget file omits them.
DEFAULT_WALL_MARGIN = 1.6
DEFAULT_PEAK_MARGIN = 1.5
DEFAULT_WALL_FLOOR_MS = 100.0
DEFAULT_PEAK_FLOOR_BYTES = 16 * 1024 * 1024


# ===========================================================================
# Measurement
# ===========================================================================


T = TypeVar("T")


@dataclass(frozen=True)
class StageMeasurement:
    """One stage's cost.

    Attributes:
        stage: The stage name (a member of :data:`STAGE_ORDER`).
        wall_ms: Wall-clock duration in milliseconds.
        peak_bytes: Peak Python heap allocated *by this stage* (tracemalloc).
    """

    stage: str
    wall_ms: float
    peak_bytes: int

    def as_dict(self) -> Dict[str, Any]:
        """Return the JSON-serializable form used by the report and the budget file."""
        return {"wall_ms": round(self.wall_ms, 1), "peak_bytes": int(self.peak_bytes)}


@dataclass(frozen=True)
class FixtureMeasurement:
    """Every stage measurement for one scale fixture, plus what it produced.

    Attributes:
        name: The fixture's spec name (its key in the budget file).
        paradigm: Canonical paradigm the fixture covers.
        adapter_key: ImportSource registry key the import half ran through.
        export_target: Emitter key the export half emitted to.
        source_bytes: Size of the generated document.
        stages: Stage name → measurement, in :data:`STAGE_ORDER`.
        process_peak_rss_bytes: Process-wide peak RSS after the fixture ran (a
            monotonic high-water mark; see the module docstring).
        detail: What the run produced (entity counts, emitted files, bundle size,
            validation verdict) — context that makes a timing number interpretable.
    """

    name: str
    paradigm: str
    adapter_key: str
    export_target: str
    source_bytes: int
    stages: Dict[str, StageMeasurement]
    process_peak_rss_bytes: int
    detail: Dict[str, Any] = field(default_factory=dict)

    @property
    def total_wall_ms(self) -> float:
        """Summed wall-clock across every stage."""
        return sum(stage.wall_ms for stage in self.stages.values())

    def as_dict(self) -> Dict[str, Any]:
        """Return the JSON-serializable form used by the report."""
        return {
            "name": self.name,
            "paradigm": self.paradigm,
            "adapter_key": self.adapter_key,
            "export_target": self.export_target,
            "source_bytes": self.source_bytes,
            "process_peak_rss_bytes": self.process_peak_rss_bytes,
            "total_wall_ms": round(self.total_wall_ms, 1),
            "detail": self.detail,
            "stages": {name: stage.as_dict() for name, stage in self.stages.items()},
        }


def measure(stage: str, call: Callable[[], T]) -> Tuple[T, StageMeasurement]:
    """Run ``call`` and record its wall-clock and peak allocation.

    Args:
        stage: The stage name to label the measurement with.
        call: The zero-argument callable to measure.

    Returns:
        ``(value, measurement)`` — the callable's return value and its cost.
    """
    tracemalloc.start()
    started = time.perf_counter()
    try:
        value = call()
    finally:
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return value, StageMeasurement(stage=stage, wall_ms=elapsed_ms, peak_bytes=peak)


def _process_peak_rss_bytes() -> int:
    """Return the process's peak resident set size in bytes.

    ``ru_maxrss`` is kilobytes on Linux and bytes on macOS — the one platform
    difference in this module, normalized here so the report carries one unit.

    Returns:
        Peak RSS in bytes.
    """
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak) if sys.platform == "darwin" else int(peak) * 1024


# ===========================================================================
# The benchmark
# ===========================================================================


def _import_payload(text: str, *, filename: str, adapter_key: str) -> Dict[str, Any]:
    """Build the worker payload the import pipeline resolves an intake from.

    Args:
        text: The document source.
        filename: The upload's filename (adapters use it as the source label).
        adapter_key: ImportSource registry key.

    Returns:
        A payload shaped like the one the spec-import worker receives.
    """
    return {
        "rest_job_id": f"scale-{filename}",
        "tenant_id": "",
        "metadata": {
            "source_kind": adapter_key,
            "project": {"name": "Scale corpus", "slug": "scale-corpus"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": base64.standard_b64encode(text.encode("utf-8")).decode("ascii"),
        "filename": filename,
    }


def _export_item(model: CanonicalApi, text: str, *, filename: str, adapter_key: str) -> Dict[str, Any]:
    """Build the catalog-item dict a stored revision projects into for export.

    :func:`app.export_source.load_export_source` fetches one row and hands exactly
    this shape to :func:`app.catalog_conversion.build_conversion_source`; building it
    here measures that loader's whole CPU half without a database.

    Args:
        model: The canonical model the import half produced (its ``format`` is what a
            revision records, and what the export loader resolves its adapter from).
        text: The captured source, stored verbatim on the revision.
        filename: The captured source label.
        adapter_key: Registry key, used as the format fallback for adapters whose
            canonical ``format`` is not itself a registry key.

    Returns:
        The item dict.
    """
    return {
        "id": "00000000-0000-0000-0000-00000000c0de",
        "slug": "scale-corpus",
        "source_format": model.format or adapter_key,
        "protocol": model.paradigm.value,
        "format_metadata": {"sourceContent": text, "sourceLabel": filename},
        "tool_versions": {},
        "metadata": {},
    }


def benchmark_fixture(fixture: Any, path: Path) -> FixtureMeasurement:
    """Run one scale fixture through all ten stages and return the measurements.

    Synchronous by design: the one asynchronous stage (export validation) is driven
    with :func:`asyncio.run`, so this must not be called from inside a running event
    loop.

    Args:
        fixture: A ``ScaleFixture`` spec entry from the committed generator.
        path: The materialized fixture file.

    Returns:
        The :class:`FixtureMeasurement` for the fixture.

    Raises:
        Exception: Whatever a stage raises. A scale fixture is a *valid* document, so
            a failure is a real defect and must surface, not be swallowed into a
            missing measurement.
    """
    load_builtin_import_sources()
    load_builtin_emitters()

    from app import import_source_pipeline

    text = path.read_text(encoding="utf-8")
    source_bytes = path.stat().st_size
    adapter = get_import_source(resolve_import_source_key(fixture.adapter_key))
    assert adapter is not None, f"{fixture.name}: unknown adapter {fixture.adapter_key!r}"
    stages: Dict[str, StageMeasurement] = {}

    # --- Import half --------------------------------------------------------
    native_ast, stages["parse"] = measure(
        "parse", lambda: adapter.parse(text, source_label=fixture.name)
    )
    model, stages["normalize"] = measure(
        "normalize", lambda: adapter.normalize(native_ast, include_raw=True)
    )
    _fingerprint, stages["fingerprint"] = measure(
        "fingerprint", lambda: canonical_fingerprint(model)
    )
    lint_report, stages["lint"] = measure("lint", lambda: adapter.lint(model))

    payload = _import_payload(text, filename=fixture.name, adapter_key=fixture.adapter_key)
    # Resolving the intake is the pipeline's own private step (decode, unpack an archive,
    # pick the root); it is setup for the persist stage, not part of what is timed. The
    # adversarial suite reaches for the same helper for the same reason.
    intake = import_source_pipeline._resolve_intake(payload, {})
    _persisted, stages["persist"] = measure(
        "persist", lambda: import_source_pipeline.scrub_intake_source(intake)
    )

    # --- Export half --------------------------------------------------------
    item = _export_item(model, text, filename=fixture.name, adapter_key=fixture.adapter_key)
    source, stages["load-source"] = measure(
        "load-source",
        lambda: build_conversion_source(
            item, source_version_id="00000000-0000-0000-0000-00000000beef"
        ),
    )
    api = source.api
    emitter_cls = type(resolve_emitter(fixture.export_target))
    target_format = resolve_emit_format(fixture.export_target)

    fidelity, stages["analyze-fidelity"] = measure(
        "analyze-fidelity", lambda: build_export_fidelity(api, emitter_cls)
    )
    emit_result, stages["emit"] = measure(
        "emit", lambda: emit_canonical(api, fixture.export_target)
    )
    validation, stages["validate"] = measure(
        "validate",
        lambda: asyncio.run(validate_emitted_artifact(target_format, emit_result, api=api)),
    )
    bundle, stages["package"] = measure(
        "package", lambda: build_export_zip(emit_result, target_format)
    )

    return FixtureMeasurement(
        name=fixture.name,
        paradigm=fixture.paradigm,
        adapter_key=fixture.adapter_key,
        export_target=target_format,
        source_bytes=source_bytes,
        stages={name: stages[name] for name in STAGE_ORDER},
        process_peak_rss_bytes=_process_peak_rss_bytes(),
        detail={
            "types": len(model.types),
            "services": len(model.services),
            "operations": sum(len(service.operations) for service in model.services),
            "channels": len(model.channels),
            "lint_findings": len(lint_report.findings),
            "fidelity_tier": fidelity.summary.tier.value,
            "emitted_files": len(emit_result.files),
            "bundle_bytes": len(bundle),
            "validated": bool(validation.validated),
            "valid": bool(validation.valid),
        },
    )


# ===========================================================================
# Budgets
# ===========================================================================


def load_budgets(path: Path = BUDGETS_PATH) -> Dict[str, Any]:
    """Load the committed budget document.

    Args:
        path: The budget file (defaults to :data:`BUDGETS_PATH`).

    Returns:
        The parsed document, or an empty skeleton when the file does not exist yet
        (a first run regenerates it rather than failing on a missing file).
    """
    if not path.exists():
        return {"budget_version": BUDGET_VERSION, "fixtures": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def render_budgets(document: Dict[str, Any]) -> str:
    """Serialize a budget document deterministically.

    Sorted keys, two-space indent, newline-terminated — the same convention every
    other committed artifact in ``tests/`` uses, so a refreshed baseline reads as a
    reviewable numeric diff.

    Args:
        document: The budget document.

    Returns:
        The canonical JSON text.
    """
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def save_budgets(document: Dict[str, Any], path: Path = BUDGETS_PATH) -> Path:
    """Write a budget document to disk, creating parent directories.

    Args:
        document: The budget document.
        path: Destination (defaults to :data:`BUDGETS_PATH`).

    Returns:
        The path written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_budgets(document), encoding="utf-8")
    return path


def budgets_from_measurements(
    measurements: List[FixtureMeasurement], previous: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Build a budget document from a completed run.

    The margins and floors are carried over from ``previous`` when it has them, so
    regenerating measurements never silently resets the *policy* — only the numbers.
    ``measured_on`` is always overwritten: a baseline only means something alongside
    the machine that produced it, and a reviewer seeing the runner change knows why
    the numbers moved.

    Args:
        measurements: One entry per fixture, from :func:`benchmark_fixture`.
        previous: The budget document being replaced, if any.

    Returns:
        The new budget document, ready for :func:`save_budgets`.
    """
    prior = previous or {}
    return {
        "budget_version": BUDGET_VERSION,
        "regression_margin": prior.get("regression_margin", DEFAULT_WALL_MARGIN),
        "memory_margin": prior.get("memory_margin", DEFAULT_PEAK_MARGIN),
        "wall_floor_ms": prior.get("wall_floor_ms", DEFAULT_WALL_FLOOR_MS),
        "peak_floor_bytes": prior.get("peak_floor_bytes", DEFAULT_PEAK_FLOOR_BYTES),
        "measured_on": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
        },
        "fixtures": {
            measurement.name: {
                "paradigm": measurement.paradigm,
                "source_bytes": measurement.source_bytes,
                "stages": {
                    name: stage.as_dict() for name, stage in measurement.stages.items()
                },
            }
            for measurement in measurements
        },
    }


def _margin(document: Dict[str, Any], key: str, env: str, fallback: float) -> float:
    """Resolve one margin from the environment, then the budget file, then a default.

    Args:
        document: The budget document.
        key: The budget document's key for this margin.
        env: Environment variable that overrides it for this run.
        fallback: Value used when neither is set.

    Returns:
        The resolved margin (a multiplier, always >= 1.0).

    Raises:
        ValueError: If the environment override is not a number >= 1.0 — a typo that
            silently disabled the gate would be worse than a failed run.
    """
    override = os.environ.get(env)
    if override is not None and override.strip():
        value = float(override)
        if value < 1.0:
            raise ValueError(f"{env}={override!r} must be a multiplier >= 1.0")
        return value
    return float(document.get(key, fallback))


def wall_margin(document: Dict[str, Any]) -> float:
    """The wall-clock regression margin for this run."""
    return _margin(document, "regression_margin", WALL_MARGIN_ENV, DEFAULT_WALL_MARGIN)


def peak_margin(document: Dict[str, Any]) -> float:
    """The peak-memory regression margin for this run."""
    return _margin(document, "memory_margin", PEAK_MARGIN_ENV, DEFAULT_PEAK_MARGIN)


# ===========================================================================
# Comparison
# ===========================================================================


@dataclass(frozen=True)
class Regression:
    """One stage metric that exceeded its budget.

    Attributes:
        fixture: The fixture name.
        stage: The stage name.
        metric: ``wall_ms`` or ``peak_bytes``.
        baseline: The committed budget value.
        measured: What this run measured.
        margin: The multiplier that was allowed.
    """

    fixture: str
    stage: str
    metric: str
    baseline: float
    measured: float
    margin: float

    @property
    def ratio(self) -> float:
        """Measured over baseline (``inf`` when the baseline is zero)."""
        return self.measured / self.baseline if self.baseline else float("inf")

    def as_dict(self) -> Dict[str, Any]:
        """Return the JSON-serializable form used by the report."""
        return {
            "fixture": self.fixture,
            "stage": self.stage,
            "metric": self.metric,
            "baseline": self.baseline,
            "measured": self.measured,
            "margin": self.margin,
            "ratio": round(self.ratio, 2),
        }


@dataclass(frozen=True)
class Breach:
    """One stage metric that exceeded an absolute ceiling (no baseline involved).

    Attributes:
        fixture: The fixture name.
        stage: The stage name.
        metric: ``wall_ms`` or ``peak_bytes``.
        limit: The absolute ceiling.
        measured: What this run measured.
    """

    fixture: str
    stage: str
    metric: str
    limit: float
    measured: float

    def as_dict(self) -> Dict[str, Any]:
        """Return the JSON-serializable form used by the report."""
        return {
            "fixture": self.fixture,
            "stage": self.stage,
            "metric": self.metric,
            "limit": self.limit,
            "measured": self.measured,
        }


def _over(measured: float, baseline: float, margin: float, floor: float) -> bool:
    """Whether ``measured`` counts as a regression against ``baseline``.

    Both conditions must hold: the *relative* rule (over ``baseline × margin``) and
    the *absolute* rule (the excess is bigger than the noise floor). The floor is what
    keeps a millisecond stage from failing the build every time the runner hiccups,
    without weakening the gate on the stages that actually cost something.

    Args:
        measured: This run's value.
        baseline: The committed budget value.
        margin: Allowed multiplier.
        floor: Minimum absolute excess before a ratio counts.

    Returns:
        ``True`` when the value has regressed.
    """
    return measured > baseline * margin and (measured - baseline) > floor


def compare(
    measurements: List[FixtureMeasurement], document: Dict[str, Any]
) -> Tuple[List[Regression], List[str]]:
    """Compare a run against the committed budgets.

    Args:
        measurements: One entry per fixture, from :func:`benchmark_fixture`.
        document: The budget document.

    Returns:
        ``(regressions, problems)`` — the stage metrics over budget, and structural
        problems with the budget file itself (a measured fixture or stage with no
        budget, or a budget entry for a fixture the spec no longer has). Both are
        failures; they are returned apart because they are fixed differently: a
        regression is investigated, a problem is a one-command baseline refresh.
    """
    budgets = document.get("fixtures") or {}
    allowed_wall = wall_margin(document)
    allowed_peak = peak_margin(document)
    wall_floor = float(document.get("wall_floor_ms", DEFAULT_WALL_FLOOR_MS))
    peak_floor = float(document.get("peak_floor_bytes", DEFAULT_PEAK_FLOOR_BYTES))

    regressions: List[Regression] = []
    problems: List[str] = []

    for measurement in measurements:
        entry = budgets.get(measurement.name)
        if entry is None:
            problems.append(
                f"{measurement.name}: no committed budget — regenerate with "
                "`pytest tests/test_scale_corpus.py --update-scale-budgets`"
            )
            continue
        stage_budgets = entry.get("stages") or {}
        for name, stage in measurement.stages.items():
            budget = stage_budgets.get(name)
            if budget is None:
                problems.append(f"{measurement.name}: stage {name!r} has no committed budget")
                continue
            if _over(stage.wall_ms, float(budget["wall_ms"]), allowed_wall, wall_floor):
                regressions.append(
                    Regression(
                        fixture=measurement.name,
                        stage=name,
                        metric="wall_ms",
                        baseline=float(budget["wall_ms"]),
                        measured=round(stage.wall_ms, 1),
                        margin=allowed_wall,
                    )
                )
            if _over(stage.peak_bytes, float(budget["peak_bytes"]), allowed_peak, peak_floor):
                regressions.append(
                    Regression(
                        fixture=measurement.name,
                        stage=name,
                        metric="peak_bytes",
                        baseline=float(budget["peak_bytes"]),
                        measured=float(stage.peak_bytes),
                        margin=allowed_peak,
                    )
                )

    measured_names = {measurement.name for measurement in measurements}
    for name in sorted(set(budgets) - measured_names):
        problems.append(
            f"{name}: budgeted but not measured — the fixture left the generator spec; "
            "refresh the baseline"
        )
    return regressions, problems


def ceiling_breaches(measurements: List[FixtureMeasurement]) -> List[Breach]:
    """Return stage metrics over the absolute ceilings.

    Independent of any baseline, so a fresh checkout with no usable budgets still
    fails on a pipeline that hangs or eats a gigabyte.

    Args:
        measurements: One entry per fixture.

    Returns:
        The breaches, in fixture then stage order.
    """
    breaches: List[Breach] = []
    for measurement in measurements:
        for name, stage in measurement.stages.items():
            if stage.wall_ms > ABSOLUTE_STAGE_SECONDS * 1000.0:
                breaches.append(
                    Breach(
                        fixture=measurement.name,
                        stage=name,
                        metric="wall_ms",
                        limit=ABSOLUTE_STAGE_SECONDS * 1000.0,
                        measured=round(stage.wall_ms, 1),
                    )
                )
            if stage.peak_bytes > ABSOLUTE_STAGE_PEAK_BYTES:
                breaches.append(
                    Breach(
                        fixture=measurement.name,
                        stage=name,
                        metric="peak_bytes",
                        limit=float(ABSOLUTE_STAGE_PEAK_BYTES),
                        measured=float(stage.peak_bytes),
                    )
                )
    return breaches


def _human(metric: str, value: float) -> str:
    """Render a metric value in the unit a reader thinks in."""
    if metric == "peak_bytes":
        return f"{value / 1024 / 1024:.1f} MiB"
    return f"{value:.1f} ms"


def describe_regression(regression: Regression) -> str:
    """Render a regression as a one-line, reviewer-readable failure.

    Args:
        regression: The regression to describe.

    Returns:
        A line naming the fixture, stage, metric, and by how much it moved.
    """
    return (
        f"{regression.fixture} · {regression.stage} · {regression.metric}: "
        f"{_human(regression.metric, regression.measured)} vs budget "
        f"{_human(regression.metric, regression.baseline)} "
        f"({regression.ratio:.2f}x, margin {regression.margin:.2f}x)"
    )


def describe_breach(breach: Breach) -> str:
    """Render an absolute-ceiling breach as a one-line failure.

    Args:
        breach: The breach to describe.

    Returns:
        A line naming the fixture, stage, metric, and the ceiling it passed.
    """
    return (
        f"{breach.fixture} · {breach.stage} · {breach.metric}: "
        f"{_human(breach.metric, breach.measured)} is over the absolute ceiling "
        f"{_human(breach.metric, breach.limit)}"
    )


# ===========================================================================
# Report artifact
# ===========================================================================


def default_report_path() -> Path:
    """The report artifact's default location (``apiome-rest/reports/``)."""
    return Path(__file__).resolve().parents[1] / "reports" / "scale-benchmark.json"


def report_path() -> Path:
    """Where this run writes its report artifact.

    Returns:
        :data:`REPORT_PATH_ENV` when set, else :func:`default_report_path`.
    """
    override = os.environ.get(REPORT_PATH_ENV)
    return Path(override) if override and override.strip() else default_report_path()


def build_report(
    measurements: List[FixtureMeasurement],
    document: Dict[str, Any],
    regressions: List[Regression],
    problems: List[str],
    breaches: List[Breach],
) -> Dict[str, Any]:
    """Assemble the machine-readable benchmark report.

    The artifact is the deliverable a scheduled CI run uploads: every stage's numbers
    with the budget it was held to, plus the environment they were measured in —
    without which two runs' timings are not comparable.

    Args:
        measurements: One entry per fixture.
        document: The budget document the run was compared against.
        regressions: Stage metrics over budget.
        problems: Structural problems with the budget file.
        breaches: Stage metrics over the absolute ceilings.

    Returns:
        The report payload.
    """
    budgets = document.get("fixtures") or {}
    fixtures: List[Dict[str, Any]] = []
    for measurement in measurements:
        payload = measurement.as_dict()
        stage_budgets = (budgets.get(measurement.name) or {}).get("stages") or {}
        for name, stage in payload["stages"].items():
            budget = stage_budgets.get(name)
            stage["budget"] = budget
            if budget:
                stage["wall_ratio"] = (
                    round(stage["wall_ms"] / budget["wall_ms"], 2) if budget["wall_ms"] else None
                )
                stage["peak_ratio"] = (
                    round(stage["peak_bytes"] / budget["peak_bytes"], 2)
                    if budget["peak_bytes"]
                    else None
                )
        fixtures.append(payload)

    return {
        "report_version": REPORT_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
        },
        "policy": {
            "budget_version": document.get("budget_version"),
            "regression_margin": wall_margin(document),
            "memory_margin": peak_margin(document),
            "wall_floor_ms": float(document.get("wall_floor_ms", DEFAULT_WALL_FLOOR_MS)),
            "peak_floor_bytes": float(
                document.get("peak_floor_bytes", DEFAULT_PEAK_FLOOR_BYTES)
            ),
            "absolute_stage_seconds": ABSOLUTE_STAGE_SECONDS,
            "absolute_stage_peak_bytes": ABSOLUTE_STAGE_PEAK_BYTES,
        },
        "totals": {
            "fixtures": len(measurements),
            "stages": len(STAGE_ORDER),
            "wall_ms": round(sum(m.total_wall_ms for m in measurements), 1),
            "peak_rss_bytes": max(
                (m.process_peak_rss_bytes for m in measurements), default=0
            ),
        },
        "fixtures": fixtures,
        "regressions": [regression.as_dict() for regression in regressions],
        "breaches": [breach.as_dict() for breach in breaches],
        "problems": list(problems),
        "passed": not regressions and not problems and not breaches,
    }


def write_report(report: Dict[str, Any], path: Optional[Path] = None) -> Path:
    """Write the report artifact, creating parent directories.

    Keys are written in insertion order rather than sorted: the report's value is
    that a reader scans a fixture's stages in the order a document flows through
    them. The committed budget file sorts instead, because there the priority is a
    reviewable diff.

    Args:
        report: The report payload from :func:`build_report`.
        path: Destination; defaults to :func:`report_path`.

    Returns:
        The path written.
    """
    target = path or report_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return target


