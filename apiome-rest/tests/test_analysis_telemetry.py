"""Privacy-safe catalog analysis telemetry unit tests — CPDO-4.2 (#4805)."""

from __future__ import annotations

import logging

import pytest

from app.analysis_telemetry import (
    ALLOWED_METRIC_KINDS,
    ALLOWED_REASON_CATEGORIES,
    ALLOWED_STATUSES,
    ALLOWED_UI_SURFACES,
    AnalysisTelemetry,
    analysis_telemetry,
)


@pytest.fixture(autouse=True)
def _reset_telemetry() -> None:
    analysis_telemetry.reset()
    yield
    analysis_telemetry.reset()


def test_record_increments_kind_and_category_counters() -> None:
    analysis_telemetry.record("analysis_failure", reason_category="analyzer_failed")
    analysis_telemetry.record("analysis_completed", status="partial")
    analysis_telemetry.record("ui_latency", surface="format_tab", latency_ms=42.0)
    analysis_telemetry.record("source_access", access_mode="inline")
    snap = analysis_telemetry.snapshot()
    assert snap["analysis_failure"] == 1
    assert snap["analysis_failure:analyzer_failed"] == 1
    assert snap["analysis_completed"] == 1
    assert snap["analysis_completed:partial"] == 1
    assert snap["ui_latency:format_tab"] == 1
    assert snap["source_access:inline"] == 1


def test_record_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError, match="unsupported analysis metric kind"):
        analysis_telemetry.record("leak_payload_values")


def test_record_drops_unknown_categories_without_logging_them(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A non-allowlisted category never becomes a counter key or a log field."""
    with caplog.at_level(logging.INFO, logger="app.analysis_telemetry"):
        analysis_telemetry.record(
            "analysis_failure",
            reason_category="SECRET-SENTINEL-reason",
            status="SECRET-SENTINEL-status",
            surface="SECRET-SENTINEL-surface",
            access_mode="SECRET-SENTINEL-mode",
        )
    snap = analysis_telemetry.snapshot()
    assert snap["analysis_failure"] == 1
    assert all("SECRET-SENTINEL" not in key for key in snap)
    joined = " ".join(record.getMessage() for record in caplog.records)
    assert "SECRET-SENTINEL" not in joined


def test_status_counts_keep_only_ints() -> None:
    """The conversion status distribution keeps ints; non-int values are dropped."""
    tel = AnalysisTelemetry()
    tel.record(
        "projection_page",
        status_counts={"retained": 3, "dropped": "ISA*00*leak"},
        page_total=10,
    )
    assert tel.snapshot()["projection_page"] == 1


def test_batch_increments_by_n() -> None:
    analysis_telemetry.record("evidence_page", n=4)
    assert analysis_telemetry.snapshot()["evidence_page"] == 4


def test_vocabularies_are_frozen_and_content_free() -> None:
    """The whitelists are the whole vocabulary — nothing free-form can enter a counter key."""
    assert "ui_latency" in ALLOWED_METRIC_KINDS
    assert "analyzer_failed" in ALLOWED_REASON_CATEGORIES
    assert ALLOWED_STATUSES == frozenset({"available", "partial", "unavailable", "failed"})
    assert "format_tab" in ALLOWED_UI_SURFACES
