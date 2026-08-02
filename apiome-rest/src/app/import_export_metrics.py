"""In-process import/export pipeline observability — IXH-6.6 (#5125).

Aggregate metrics for the two job pipelines: per-stage duration histograms and byte
totals, per-job totals keyed by adapter/target and format, and failure counters keyed
by the IXH-6.4 taxonomy code. The registry follows the deployment's established
metrics posture (:mod:`app.observability`, :mod:`app.analysis_telemetry`): in-process,
per-replica, resets on restart — deliberately *not* a Prometheus deployment. Durable
per-job timing evidence exists independently of this module, inside each job's
``PHASE_TIMING`` events mirrored to ``apiome.async_job.status``.

Tag-cardinality contract (acceptance criterion of the ticket):

* Every tag value comes from a **closed vocabulary** — kinds, outcomes, stages, the
  registered import-adapter keys, the registered emit targets, and the two error
  taxonomies. A value outside its vocabulary is clamped to :data:`OTHER`, never
  stored verbatim.
* **No per-tenant, per-job, per-user, or free-text tag is ever accepted.** The
  ``record_*`` signatures have no parameter through which one could arrive; sizes and
  durations are plain numbers.
* A defensive :data:`MAX_KEYS_PER_FAMILY` cap folds pathological growth into
  :data:`OTHER` even if a vocabulary were to misbehave.

Every record also emits exactly one structured log line (``import_export.stage`` /
``import_export.job`` / ``import_export.failure``). The logging pipeline's
``merge_contextvars`` attaches the bound ``request_id`` to those lines, which is the
joint between these aggregates and the correlation-id thread.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, FrozenSet, Optional

from .logging_config import get_logger

_log = get_logger("app.import_export_metrics")

__all__ = [
    "ALLOWED_KINDS",
    "ALLOWED_OUTCOMES",
    "DURATION_BUCKET_UPPER_MS",
    "EXPORT_STAGES",
    "IMPORT_STAGES",
    "IMPORT_WORKER_STAGES",
    "KIND_EXPORT",
    "KIND_IMPORT",
    "MAX_KEYS_PER_FAMILY",
    "OTHER",
    "OUTCOME_CANCELED",
    "OUTCOME_COMPLETED",
    "OUTCOME_FAILED",
    "ImportExportMetrics",
    "import_export_metrics",
]

KIND_IMPORT = "import"
KIND_EXPORT = "export"
ALLOWED_KINDS = frozenset({KIND_IMPORT, KIND_EXPORT})

OUTCOME_COMPLETED = "completed"
OUTCOME_FAILED = "failed"
OUTCOME_CANCELED = "canceled"
ALLOWED_OUTCOMES = frozenset({OUTCOME_COMPLETED, OUTCOME_FAILED, OUTCOME_CANCELED})

#: The clamp bucket every out-of-vocabulary tag value folds into.
OTHER = "other"

#: In-process import pipeline stages (``run_adapter_import_job``).
IMPORT_STAGES = frozenset(
    {
        "intake",
        "remote-refs",
        "parse",
        "analyze",
        "normalize",
        "route",
        "version",
        "lint",
        "persist",
        "finalize",
    }
)

#: Phase names the tsx worker path emits in its ``PHASE_TIMING`` events. A new
#: worker phase clamps to ``other`` until it is added here — a rename never errors.
IMPORT_WORKER_STAGES = frozenset(
    {
        "parse:normalize",
        "phase:buildPropertyLibrary",
        "phase:importPaths",
        "phase:verify",
        "phase:writeClasses",
    }
)

#: Export engine stages — exactly the ``_STAGE_PERCENT`` vocabulary.
EXPORT_STAGES = frozenset(
    {
        "loading-source",
        "analyzing-fidelity",
        "emitting",
        "validating",
        "packaging",
    }
)

#: Histogram bucket upper bounds in milliseconds; one implicit ``inf`` bucket follows.
DURATION_BUCKET_UPPER_MS = (50, 100, 250, 500, 1000, 2500, 5000, 15000, 60000)

#: Defensive cap on distinct keys per metric family. The vocabularies already bound
#: everything; this is belt-and-braces against a misbehaving registry.
MAX_KEYS_PER_FAMILY = 512


def _empty_stage_cell() -> Dict[str, Any]:
    """A fresh accumulator for one (kind, stage, outcome) cell."""
    return {
        "count": 0,
        "total_duration_ms": 0.0,
        "duration_buckets_ms": {str(upper): 0 for upper in DURATION_BUCKET_UPPER_MS}
        | {"inf": 0},
        "bytes_in_total": 0,
        "bytes_out_total": 0,
    }


def _empty_job_cell() -> Dict[str, Any]:
    """A fresh accumulator for one (kind, adapter, format, outcome) cell."""
    return {
        "count": 0,
        "total_duration_ms": 0.0,
        "bytes_in_total": 0,
        "bytes_out_total": 0,
    }


def _bucket_label(duration_ms: float) -> str:
    """The histogram bucket a duration falls into (upper-bound inclusive)."""
    for upper in DURATION_BUCKET_UPPER_MS:
        if duration_ms <= upper:
            return str(upper)
    return "inf"


class ImportExportMetrics:
    """Thread-safe registry for the three import/export metric families."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # (kind, stage, outcome) -> stage cell
        self._stages: Dict[tuple, Dict[str, Any]] = {}
        # (kind, adapter_or_target, format, outcome) -> job cell
        self._jobs: Dict[tuple, Dict[str, Any]] = {}
        # (kind, code, adapter_or_target) -> count
        self._failures: Dict[tuple, int] = {}
        self._adapter_keys: Optional[FrozenSet[str]] = None
        self._target_keys: Optional[FrozenSet[str]] = None

    # ------------------------------------------------------------------
    # Vocabulary resolution (lazy, cached — avoids import cycles at module load)
    # ------------------------------------------------------------------

    def _known_adapters(self) -> FrozenSet[str]:
        """The registered import-adapter keys (loaded once, on first use)."""
        if self._adapter_keys is None:
            try:
                from .import_source import available_import_sources, load_builtin_import_sources

                load_builtin_import_sources()
                self._adapter_keys = frozenset(available_import_sources())
            except Exception:  # noqa: BLE001 - metrics must never fail the caller
                return frozenset()
        return self._adapter_keys

    def _known_targets(self) -> FrozenSet[str]:
        """The registered emit target/format keys (loaded once, on first use)."""
        if self._target_keys is None:
            try:
                from .emitter import available_emit_formats, load_builtin_emitters

                load_builtin_emitters()
                self._target_keys = frozenset(available_emit_formats())
            except Exception:  # noqa: BLE001
                return frozenset()
        return self._target_keys

    def _safe_stage(self, kind: str, stage: Any) -> str:
        """Clamp a stage name to its kind's closed vocabulary."""
        name = str(stage or "")
        if kind == KIND_IMPORT:
            allowed = name in IMPORT_STAGES or name in IMPORT_WORKER_STAGES
        else:
            allowed = name in EXPORT_STAGES
        return name if allowed else OTHER

    def _safe_adapter_or_target(self, kind: str, value: Any) -> str:
        """Clamp an adapter/target key to the registered vocabulary.

        Export targets are submitted as an emitter key, a format key, or a descriptor
        alias (``openapi`` → ``openapi-3.1``); they are normalized through the export
        service's resolver so the metric key is always the canonical format key.
        """
        name = str(value or "")
        if kind == KIND_IMPORT:
            return name if name in self._known_adapters() else OTHER
        if name in self._known_targets():
            return name
        try:
            from .export_service import resolve_emit_format

            return resolve_emit_format(name)
        except Exception:  # noqa: BLE001 - unknown target folds, never raises
            return OTHER

    def _safe_format(self, kind: str, value: Any) -> str:
        """Clamp a format key. Import formats are adapter keys; export formats are
        emit-format keys (alias-normalized) — both closed registries."""
        if value is None:
            return OTHER
        name = str(value)
        if kind == KIND_EXPORT:
            return self._safe_adapter_or_target(kind, name)
        if name in self._known_adapters() or name in self._known_targets():
            return name
        return OTHER

    @staticmethod
    def _safe_code(kind: str, code: Any) -> str:
        """Clamp a failure code to the intake/delivery taxonomy for the kind."""
        name = str(code or "")
        try:
            if kind == KIND_IMPORT:
                from .intake_error_taxonomy import INTAKE_ERROR_TAXONOMY

                return name if name in INTAKE_ERROR_TAXONOMY else OTHER
            from .delivery_error_taxonomy import DELIVERY_ERROR_TAXONOMY

            return name if name in DELIVERY_ERROR_TAXONOMY else OTHER
        except Exception:  # noqa: BLE001
            return OTHER

    @staticmethod
    def _check_kind(kind: str) -> None:
        """A bad kind is a programmer error, not a data problem."""
        if kind not in ALLOWED_KINDS:
            raise ValueError(f"unsupported import/export metric kind: {kind!r}")

    @staticmethod
    def _safe_outcome(outcome: Any) -> str:
        """Clamp an outcome to the closed set (unknown terminal reads as failed)."""
        name = str(outcome or "")
        return name if name in ALLOWED_OUTCOMES else OUTCOME_FAILED

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    def record_stage(
        self,
        *,
        kind: str,
        stage: str,
        duration_ms: float,
        outcome: str = OUTCOME_COMPLETED,
        bytes_in: Optional[int] = None,
        bytes_out: Optional[int] = None,
    ) -> None:
        """Record one stage execution.

        Args:
            kind: ``import`` | ``export`` (anything else raises — programmer error).
            stage: Stage name; clamped to the kind's closed vocabulary.
            duration_ms: Wall-clock stage duration in milliseconds.
            outcome: ``completed`` | ``failed`` | ``canceled``.
            bytes_in: Bytes consumed by the stage, when meaningful.
            bytes_out: Bytes produced by the stage, when meaningful.
        """
        self._check_kind(kind)
        safe_stage = self._safe_stage(kind, stage)
        safe_outcome = self._safe_outcome(outcome)
        duration = max(0.0, float(duration_ms))
        key = (kind, safe_stage, safe_outcome)

        with self._lock:
            cell = self._stages.get(key)
            if cell is None:
                if len(self._stages) >= MAX_KEYS_PER_FAMILY:
                    key = (kind, OTHER, safe_outcome)
                    cell = self._stages.setdefault(key, _empty_stage_cell())
                else:
                    cell = self._stages.setdefault(key, _empty_stage_cell())
            cell["count"] += 1
            cell["total_duration_ms"] = round(cell["total_duration_ms"] + duration, 3)
            cell["duration_buckets_ms"][_bucket_label(duration)] += 1
            if bytes_in is not None:
                cell["bytes_in_total"] += max(0, int(bytes_in))
            if bytes_out is not None:
                cell["bytes_out_total"] += max(0, int(bytes_out))

        payload: Dict[str, Any] = {
            "kind": kind,
            "stage": key[1],
            "outcome": safe_outcome,
            "duration_ms": round(duration, 3),
        }
        if bytes_in is not None:
            payload["bytes_in"] = int(bytes_in)
        if bytes_out is not None:
            payload["bytes_out"] = int(bytes_out)
        _log.info("import_export.stage", **payload)

    def record_job(
        self,
        *,
        kind: str,
        adapter_or_target: str,
        format_key: Optional[str],
        outcome: str,
        duration_ms: Optional[float] = None,
        bytes_in: Optional[int] = None,
        bytes_out: Optional[int] = None,
    ) -> None:
        """Record one terminal job.

        Args:
            kind: ``import`` | ``export``.
            adapter_or_target: Import adapter key or export target key; clamped to
                the registered vocabulary.
            format_key: Format key when known; clamped, ``None`` folds to ``other``.
            outcome: Terminal outcome.
            duration_ms: Whole-job wall-clock duration.
            bytes_in: Source document bytes (imports).
            bytes_out: Artifact bytes produced (exports).
        """
        self._check_kind(kind)
        adapter = self._safe_adapter_or_target(kind, adapter_or_target)
        fmt = self._safe_format(kind, format_key)
        safe_outcome = self._safe_outcome(outcome)
        key = (kind, adapter, fmt, safe_outcome)

        with self._lock:
            cell = self._jobs.get(key)
            if cell is None:
                if len(self._jobs) >= MAX_KEYS_PER_FAMILY:
                    key = (kind, OTHER, OTHER, safe_outcome)
                cell = self._jobs.setdefault(key, _empty_job_cell())
            cell["count"] += 1
            if duration_ms is not None:
                cell["total_duration_ms"] = round(
                    cell["total_duration_ms"] + max(0.0, float(duration_ms)), 3
                )
            if bytes_in is not None:
                cell["bytes_in_total"] += max(0, int(bytes_in))
            if bytes_out is not None:
                cell["bytes_out_total"] += max(0, int(bytes_out))

        payload = {
            "kind": kind,
            "adapter_or_target": key[1],
            "format": key[2],
            "outcome": safe_outcome,
        }
        if duration_ms is not None:
            payload["duration_ms"] = round(max(0.0, float(duration_ms)), 3)
        if bytes_in is not None:
            payload["bytes_in"] = int(bytes_in)
        if bytes_out is not None:
            payload["bytes_out"] = int(bytes_out)
        _log.info("import_export.job", **payload)

    def record_failure(
        self,
        *,
        kind: str,
        code: str,
        adapter_or_target: str,
        format_key: Optional[str] = None,
    ) -> None:
        """Record one job failure keyed by taxonomy code and adapter/target.

        Args:
            kind: ``import`` | ``export``.
            code: IXH-6.4 taxonomy code (intake or delivery); clamped to the taxonomy.
            adapter_or_target: Adapter/target key; clamped.
            format_key: Optional format key, logged (not a counter dimension —
                the counter stays two-dimensional to keep cardinality low).
        """
        self._check_kind(kind)
        safe_code = self._safe_code(kind, code)
        adapter = self._safe_adapter_or_target(kind, adapter_or_target)
        key = (kind, safe_code, adapter)

        with self._lock:
            if key not in self._failures and len(self._failures) >= MAX_KEYS_PER_FAMILY:
                key = (kind, OTHER, OTHER)
            self._failures[key] = self._failures.get(key, 0) + 1

        payload = {"kind": kind, "code": key[1], "adapter_or_target": key[2]}
        if format_key is not None:
            payload["format"] = self._safe_format(kind, format_key)
        _log.info("import_export.failure", **payload)

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        """A JSON-able copy of every aggregate.

        Returns:
            ``{"stages": kind→stage→outcome→cell, "jobs": kind→adapter→format→
            outcome→cell, "failures": kind→code→adapter→count}``.
        """
        with self._lock:
            stages: Dict[str, Any] = {}
            for (kind, stage, outcome), cell in self._stages.items():
                stages.setdefault(kind, {}).setdefault(stage, {})[outcome] = {
                    **cell,
                    "duration_buckets_ms": dict(cell["duration_buckets_ms"]),
                }
            jobs: Dict[str, Any] = {}
            for (kind, adapter, fmt, outcome), cell in self._jobs.items():
                jobs.setdefault(kind, {}).setdefault(adapter, {}).setdefault(fmt, {})[
                    outcome
                ] = dict(cell)
            failures: Dict[str, Any] = {}
            for (kind, code, adapter), count in self._failures.items():
                failures.setdefault(kind, {}).setdefault(code, {})[adapter] = count
        return {"stages": stages, "jobs": jobs, "failures": failures}

    def documented_tags(self) -> Dict[str, Any]:
        """The documented tag set — every value a tag can take, for operators."""
        return {
            "kinds": sorted(ALLOWED_KINDS),
            "outcomes": sorted(ALLOWED_OUTCOMES),
            "stages": {
                "import": sorted(IMPORT_STAGES),
                "import_worker": sorted(IMPORT_WORKER_STAGES),
                "export": sorted(EXPORT_STAGES),
            },
            "adapters": sorted(self._known_adapters()),
            "export_targets": sorted(self._known_targets()),
            "failure_codes": {
                "import": self._taxonomy_codes(KIND_IMPORT),
                "export": self._taxonomy_codes(KIND_EXPORT),
            },
            "duration_bucket_upper_ms": list(DURATION_BUCKET_UPPER_MS),
            "overflow_bucket": OTHER,
        }

    @staticmethod
    def _taxonomy_codes(kind: str) -> list:
        """The sorted taxonomy code list for a kind (empty on import trouble)."""
        try:
            if kind == KIND_IMPORT:
                from .intake_error_taxonomy import INTAKE_ERROR_TAXONOMY

                return sorted(INTAKE_ERROR_TAXONOMY)
            from .delivery_error_taxonomy import DELIVERY_ERROR_TAXONOMY

            return sorted(DELIVERY_ERROR_TAXONOMY)
        except Exception:  # noqa: BLE001
            return []

    def reset(self) -> None:
        """Clear every aggregate (unit tests)."""
        with self._lock:
            self._stages.clear()
            self._jobs.clear()
            self._failures.clear()


#: Process-wide registry for import/export pipeline observability.
import_export_metrics = ImportExportMetrics()
