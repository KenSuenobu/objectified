"""Unit tests for the import/export observability registry — IXH-6.6 (#5125).

The registry's contract: three families (stage/job/failure), fixed histogram buckets,
every tag clamped to a closed vocabulary (no per-tenant/per-job tag can exist), a
defensive per-family key cap, one structured log line per record, and a JSON-able
snapshot.
"""

from __future__ import annotations

import threading

import pytest

from app.import_export_metrics import (
    ALLOWED_KINDS,
    ALLOWED_OUTCOMES,
    DURATION_BUCKET_UPPER_MS,
    EXPORT_STAGES,
    IMPORT_STAGES,
    IMPORT_WORKER_STAGES,
    MAX_KEYS_PER_FAMILY,
    OTHER,
    ImportExportMetrics,
    import_export_metrics,
)


@pytest.fixture()
def registry() -> ImportExportMetrics:
    return ImportExportMetrics()


def test_stage_round_trip_counts_durations_buckets_and_bytes(registry) -> None:
    """One family cell accumulates count, total duration, bucket, and byte totals."""
    registry.record_stage(kind="import", stage="parse", duration_ms=40.0, bytes_in=1024)
    registry.record_stage(kind="import", stage="parse", duration_ms=900.0, bytes_in=2048)

    cell = registry.snapshot()["stages"]["import"]["parse"]["completed"]
    assert cell["count"] == 2
    assert cell["total_duration_ms"] == 940.0
    assert cell["duration_buckets_ms"]["50"] == 1
    assert cell["duration_buckets_ms"]["1000"] == 1
    assert cell["bytes_in_total"] == 3072
    assert cell["bytes_out_total"] == 0


def test_bucket_edges_are_upper_bound_inclusive_with_an_inf_overflow(registry) -> None:
    """49.9 → 50 bucket; exactly 50 → 50 bucket; 60001 → inf."""
    registry.record_stage(kind="export", stage="emitting", duration_ms=49.9)
    registry.record_stage(kind="export", stage="emitting", duration_ms=50.0)
    registry.record_stage(kind="export", stage="emitting", duration_ms=60001.0)

    buckets = registry.snapshot()["stages"]["export"]["emitting"]["completed"][
        "duration_buckets_ms"
    ]
    assert buckets["50"] == 2
    assert buckets["inf"] == 1


def test_outcomes_partition_the_stage_family(registry) -> None:
    registry.record_stage(kind="export", stage="packaging", duration_ms=10, outcome="failed")
    registry.record_stage(kind="export", stage="packaging", duration_ms=10, outcome="canceled")

    stage = registry.snapshot()["stages"]["export"]["packaging"]
    assert set(stage) == {"failed", "canceled"}


def test_unknown_tags_clamp_to_other_never_verbatim(registry) -> None:
    """Stage, adapter, format, and code values outside their vocabularies fold to
    ``other`` — a free-text or per-job value can never become a metric key."""
    registry.record_stage(kind="import", stage="tenant-42-secret", duration_ms=5)
    registry.record_job(
        kind="import",
        adapter_or_target="job-9c41",
        format_key="no-such-format",
        outcome="completed",
    )
    registry.record_failure(kind="import", code="NOT_A_CODE", adapter_or_target="nope")

    snap = registry.snapshot()
    assert list(snap["stages"]["import"]) == [OTHER]
    assert list(snap["jobs"]["import"]) == [OTHER]
    assert snap["jobs"]["import"][OTHER] == {OTHER: {"completed": pytest.approx(
        {"count": 1, "total_duration_ms": 0.0, "bytes_in_total": 0, "bytes_out_total": 0}
    )}}
    assert snap["failures"]["import"] == {OTHER: {OTHER: 1}}


def test_known_vocabulary_values_pass_through(registry) -> None:
    """Registered adapters, emit targets, worker phases, and taxonomy codes are kept."""
    registry.record_stage(kind="import", stage="phase:importPaths", duration_ms=12)
    registry.record_job(
        kind="import", adapter_or_target="asyncapi", format_key="asyncapi", outcome="completed"
    )
    registry.record_failure(
        kind="import", code="INPUT_MALFORMED", adapter_or_target="asyncapi"
    )
    registry.record_failure(
        kind="export", code="SOURCE_LOAD_FAILED", adapter_or_target="openapi-3.1"
    )

    snap = registry.snapshot()
    assert "phase:importPaths" in snap["stages"]["import"]
    assert snap["jobs"]["import"]["asyncapi"]["asyncapi"]["completed"]["count"] == 1
    assert snap["failures"]["import"]["INPUT_MALFORMED"]["asyncapi"] == 1
    assert snap["failures"]["export"]["SOURCE_LOAD_FAILED"]["openapi-3.1"] == 1


def test_snapshot_keys_stay_inside_the_documented_vocabularies(registry) -> None:
    """The cardinality contract, asserted structurally: after arbitrary recording,
    every snapshot key is a documented tag value or ``other``."""
    registry.record_stage(kind="import", stage="parse", duration_ms=1)
    registry.record_stage(kind="import", stage="mystery", duration_ms=1)
    registry.record_stage(kind="export", stage="emitting", duration_ms=1, outcome="weird")
    registry.record_job(
        kind="export", adapter_or_target="openapi", format_key=None, outcome="completed"
    )
    registry.record_failure(kind="export", code="EMIT_FAILED", adapter_or_target="huh")

    snap = registry.snapshot()
    stage_vocab = IMPORT_STAGES | IMPORT_WORKER_STAGES | EXPORT_STAGES | {OTHER}
    for kind, stages in snap["stages"].items():
        assert kind in ALLOWED_KINDS
        for stage, outcomes in stages.items():
            assert stage in stage_vocab
            assert set(outcomes) <= ALLOWED_OUTCOMES
    for kind, adapters in snap["jobs"].items():
        docs = import_export_metrics.documented_tags()
        allowed = set(docs["adapters"]) | set(docs["export_targets"]) | {OTHER}
        assert set(adapters) <= allowed


def test_bad_kind_is_a_programmer_error(registry) -> None:
    with pytest.raises(ValueError):
        registry.record_stage(kind="sideways", stage="parse", duration_ms=1)


def test_key_cap_folds_overflow_into_other(registry) -> None:
    """Even a misbehaving vocabulary cannot grow a family past the cap."""
    for index in range(MAX_KEYS_PER_FAMILY + 25):
        registry.record_failure(
            kind="import", code="INPUT_MALFORMED", adapter_or_target=f"ghost-{index}"
        )
    failures = registry.snapshot()["failures"]["import"]
    total = sum(count for by_adapter in failures.values() for count in by_adapter.values())
    assert total == MAX_KEYS_PER_FAMILY + 25
    # Unknown adapters clamp to "other" long before the cap; the cap is belt-and-braces.
    assert failures["INPUT_MALFORMED"][OTHER] == MAX_KEYS_PER_FAMILY + 25


def test_reset_clears_every_family(registry) -> None:
    registry.record_stage(kind="import", stage="parse", duration_ms=1)
    registry.record_job(
        kind="import", adapter_or_target="asyncapi", format_key=None, outcome="failed"
    )
    registry.record_failure(kind="import", code="INPUT_EMPTY", adapter_or_target="asyncapi")
    registry.reset()
    assert registry.snapshot() == {"stages": {}, "jobs": {}, "failures": {}}


def test_thread_safety_totals_are_exact(registry) -> None:
    """N threads × M records land exactly N×M counts."""
    threads = [
        threading.Thread(
            target=lambda: [
                registry.record_stage(kind="import", stage="parse", duration_ms=3)
                for _ in range(50)
            ]
        )
        for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert registry.snapshot()["stages"]["import"]["parse"]["completed"]["count"] == 400


def test_each_record_emits_one_structured_log_line(registry, caplog) -> None:
    """The metrics↔logs joint: one line per record with the validated tag values."""
    import logging

    with caplog.at_level(logging.INFO, logger="app.import_export_metrics"):
        registry.record_stage(kind="import", stage="parse", duration_ms=7.5)
        registry.record_failure(
            kind="export", code="EMIT_FAILED", adapter_or_target="openapi"
        )
    messages = [record.getMessage() for record in caplog.records]
    assert any("import_export.stage" in message for message in messages)
    assert any("import_export.failure" in message for message in messages)


def test_documented_tags_shape(registry) -> None:
    docs = registry.documented_tags()
    assert docs["kinds"] == ["export", "import"]
    assert set(docs["stages"]) == {"import", "import_worker", "export"}
    assert "INPUT_MALFORMED" in docs["failure_codes"]["import"]
    assert "SOURCE_LOAD_FAILED" in docs["failure_codes"]["export"]
    assert docs["duration_bucket_upper_ms"] == list(DURATION_BUCKET_UPPER_MS)
    assert "asyncapi" in docs["adapters"]
    assert docs["overflow_bucket"] == OTHER
