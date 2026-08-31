"""Unit tests for the export test-drive mock binding — MFX-44.5 (#4371).

Covers the DB-free half of :mod:`app.export_mock`: which targets the mock engine can serve (derived
from the emitter registry, not a hand-kept list), the capability signal the Studio hides its tab on,
TTL clamping, the emitted-document guard, and the bounded request-log ring buffer.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from app.config import settings
from app.emitter import EmitResult, EmittedFile
from app.export_mock import (
    EXPORT_MOCK_ORIGIN,
    ExportMockError,
    ExportMockRequestLog,
    clamp_ttl_minutes,
    document_from_emit,
    expiry_from_now,
    export_mock_availability,
    instance_is_export_mock,
    is_mock_servable_target,
    mock_servable_targets,
    operation_summaries,
)
from app.mock_routing import extract_operations

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Widgets", "version": "1.0.0"},
    "paths": {
        "/widgets": {
            "get": {
                "operationId": "listWidgets",
                "responses": {"200": {"description": "ok"}},
            },
            "post": {"responses": {"201": {"description": "created"}}},
        },
        "/widgets/{widgetId}": {
            "get": {
                "operationId": "getWidget",
                "responses": {"200": {"description": "ok"}},
            }
        },
    },
}


def _emit(content, path="openapi.json"):
    """An EmitResult carrying one file with ``content``."""
    return EmitResult(files=[EmittedFile(path=path, content=content)])


# --------------------------------------------------------------------------- #
# Which targets can be mocked
# --------------------------------------------------------------------------- #


def test_mock_servable_targets_are_derived_from_the_emitter_registry():
    """The list comes from registered emitters, so a new OpenAPI emitter needs no edit here."""
    targets = mock_servable_targets()
    assert "openapi" in targets
    # Sorted + de-duplicated, and nothing the engine cannot replay.
    assert targets == sorted(set(targets))
    assert "protobuf" not in targets
    assert "graphql" not in targets


@pytest.mark.parametrize(
    "target_format,expected",
    [
        ("openapi-3.1", True),
        ("openapi-3.0", True),
        ("OpenAPI-3.2", True),
        ("swagger-2.0", True),
        ("proto3", False),
        ("graphql", False),
        ("", False),
    ],
)
def test_is_mock_servable_target(target_format, expected):
    """Only the OpenAPI family (and its Swagger ancestor) is serve-able by the engine."""
    assert is_mock_servable_target(target_format) is expected


# --------------------------------------------------------------------------- #
# Capability
# --------------------------------------------------------------------------- #


def test_availability_is_true_with_both_switches_on():
    """A server with the engine deployed and the binding enabled reports available, no reason."""
    availability = export_mock_availability()
    assert availability.available is True
    assert availability.reason is None
    assert "openapi" in availability.supported_targets
    assert availability.default_ttl_minutes >= 1
    assert availability.max_ttl_minutes >= availability.default_ttl_minutes


def test_absent_mock_engine_reports_unavailable_with_a_reason(monkeypatch):
    """No engine deployed → the Studio hides the tab, and the reason names the missing piece."""
    monkeypatch.setattr(settings, "mock_server_enabled", False)
    availability = export_mock_availability()
    assert availability.available is False
    assert "Mock Server" in (availability.reason or "")
    # The bounds are still reported so a disabled panel can explain the terms it would apply.
    assert availability.default_ttl_minutes >= 1


def test_disabled_export_binding_reports_its_own_reason(monkeypatch):
    """The engine can be up while the export binding is off; the reason distinguishes them."""
    monkeypatch.setattr(settings, "mock_server_enabled", True)
    monkeypatch.setattr(settings, "export_mock_enabled", False)
    availability = export_mock_availability()
    assert availability.available is False
    assert "Export test-drive" in (availability.reason or "")


# --------------------------------------------------------------------------- #
# TTL
# --------------------------------------------------------------------------- #


def test_ttl_defaults_to_the_configured_value(monkeypatch):
    """No TTL requested → the configured default."""
    monkeypatch.setattr(settings, "export_mock_default_ttl_minutes", 30)
    assert clamp_ttl_minutes(None) == 30


def test_ttl_is_clamped_to_the_configured_ceiling(monkeypatch):
    """A caller cannot hold a test-drive mock open past the configured maximum."""
    monkeypatch.setattr(settings, "export_mock_max_ttl_minutes", 60)
    assert clamp_ttl_minutes(6000) == 60
    assert clamp_ttl_minutes(45) == 45


def test_ttl_never_falls_below_one_minute():
    """Zero or negative minutes would provision an already-dead mock."""
    assert clamp_ttl_minutes(0) == 1
    assert clamp_ttl_minutes(-10) == 1


def test_expiry_is_ttl_minutes_from_the_reference_time():
    """The auto-teardown instant is exactly the TTL past 'now'."""
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert expiry_from_now(15, now=now) == now + timedelta(minutes=15)


# --------------------------------------------------------------------------- #
# The emitted document
# --------------------------------------------------------------------------- #


def test_document_from_emit_returns_the_structured_document():
    """A single-file structured emit is exactly what gets frozen into the instance."""
    assert document_from_emit(_emit(SPEC), target_label="OpenAPI 3.1") == SPEC


def test_an_empty_emit_is_refused_as_unprocessable():
    """Nothing emitted → nothing to mock, stated as 422 rather than an empty mock."""
    with pytest.raises(ExportMockError) as exc:
        document_from_emit(EmitResult(files=[]), target_label="OpenAPI 3.1")
    assert exc.value.status_code == 422
    with pytest.raises(ExportMockError):
        document_from_emit(None, target_label="OpenAPI 3.1")


def test_a_multi_file_bundle_is_refused_rather_than_partially_mocked():
    """Mocking the first file of a bundle would misrepresent the artifact."""
    emit = EmitResult(
        files=[
            EmittedFile(path="a.json", content=SPEC),
            EmittedFile(path="b.json", content=SPEC),
        ]
    )
    with pytest.raises(ExportMockError) as exc:
        document_from_emit(emit, target_label="OpenAPI 3.1")
    assert exc.value.status_code == 422
    assert "2-file bundle" in str(exc.value)


def test_a_text_only_emit_is_refused():
    """The engine replays a structured document; plain text has no operations to match."""
    with pytest.raises(ExportMockError) as exc:
        document_from_emit(_emit("syntax = \"proto3\";", path="a.proto"), target_label="Proto")
    assert exc.value.status_code == 422
    assert "text" in str(exc.value)


def test_a_document_without_paths_is_refused():
    """A path-less document would provision a mock that serves nothing but 404s."""
    with pytest.raises(ExportMockError) as exc:
        document_from_emit(
            _emit({"openapi": "3.1.0", "info": {"title": "x", "version": "1"}}),
            target_label="OpenAPI 3.1",
        )
    assert exc.value.status_code == 422
    assert "no paths" in str(exc.value)


def test_an_over_large_document_is_refused_with_413(monkeypatch):
    """The frozen-spec column (and the engine's per-request walk) is size-capped."""
    monkeypatch.setattr(settings, "export_mock_max_document_bytes", 32)
    with pytest.raises(ExportMockError) as exc:
        document_from_emit(_emit(SPEC), target_label="OpenAPI 3.1")
    assert exc.value.status_code == 413


# --------------------------------------------------------------------------- #
# Operations
# --------------------------------------------------------------------------- #


def test_operation_summaries_are_ordered_and_carry_operation_ids():
    """The try-it list is stable across refreshes and names each operation where the doc does."""
    summaries = operation_summaries(extract_operations(SPEC))
    assert [(s["method"], s["path"]) for s in summaries] == [
        ("GET", "/widgets"),
        ("POST", "/widgets"),
        ("GET", "/widgets/{widgetId}"),
    ]
    assert summaries[0]["operation_id"] == "listWidgets"
    # An operation without an operationId reports null rather than an empty string.
    assert summaries[1]["operation_id"] is None


# --------------------------------------------------------------------------- #
# Instance classification
# --------------------------------------------------------------------------- #


def test_only_rows_carrying_the_origin_marker_are_export_mocks():
    """A hosted mock (#3615) must stay invisible to (and unmanaged by) the export surface."""
    assert instance_is_export_mock({"config": {"origin": EXPORT_MOCK_ORIGIN}}) is True
    assert instance_is_export_mock({"config": {"origin": "something-else"}}) is False
    assert instance_is_export_mock({"config": {}}) is False
    assert instance_is_export_mock({"config": None}) is False
    assert instance_is_export_mock({}) is False


# --------------------------------------------------------------------------- #
# The request log
# --------------------------------------------------------------------------- #


def _record(log: ExportMockRequestLog, mock_id: str, path: str, **overrides):
    """Record one entry with representative defaults."""
    payload = {
        "method": "get",
        "path": path,
        "status": 200,
        "matched": True,
        "scenario": "happy-path",
        "operation_key": f"GET {path}",
        "schema_valid": True,
        "duration_ms": 3,
    }
    payload.update(overrides)
    log.record(mock_id, **payload)


def test_the_log_returns_entries_newest_first():
    """The panel reads top-down, so the most recent request is the first row."""
    log = ExportMockRequestLog()
    _record(log, "m1", "/a")
    _record(log, "m1", "/b")
    assert [entry.path for entry in log.entries("m1")] == ["/b", "/a"]


def test_the_log_upper_cases_the_method_and_floors_the_duration():
    """Normalized once at write time so the panel never has to."""
    log = ExportMockRequestLog()
    _record(log, "m1", "/a", method="post", duration_ms=-5)
    entry = log.entries("m1")[0]
    assert entry.method == "POST"
    assert entry.duration_ms == 0


def test_the_log_is_bounded_by_the_configured_capacity(monkeypatch):
    """A chatty mock cannot grow the buffer without bound; oldest entries fall off."""
    monkeypatch.setattr(settings, "export_mock_request_log_size", 3)
    log = ExportMockRequestLog()
    for index in range(10):
        _record(log, "m1", f"/{index}")
    assert [entry.path for entry in log.entries("m1")] == ["/9", "/8", "/7"]


def test_shrinking_the_capacity_keeps_the_newest_entries(monkeypatch):
    """A re-configured capacity rebuilds the buffer rather than dropping the log entirely."""
    monkeypatch.setattr(settings, "export_mock_request_log_size", 5)
    log = ExportMockRequestLog()
    for index in range(5):
        _record(log, "m1", f"/{index}")
    monkeypatch.setattr(settings, "export_mock_request_log_size", 2)
    _record(log, "m1", "/new")
    assert [entry.path for entry in log.entries("m1")] == ["/new", "/4"]


def test_limit_caps_what_a_read_returns():
    """The route's `limit` is honoured without discarding what the buffer still holds."""
    log = ExportMockRequestLog()
    for index in range(5):
        _record(log, "m1", f"/{index}")
    assert len(log.entries("m1", limit=2)) == 2
    assert len(log.entries("m1")) == 5


def test_logs_are_scoped_per_instance():
    """One mock's traffic never appears in another's panel."""
    log = ExportMockRequestLog()
    _record(log, "m1", "/a")
    _record(log, "m2", "/b")
    assert [entry.path for entry in log.entries("m1")] == ["/a"]
    assert [entry.path for entry in log.entries("m2")] == ["/b"]
    assert log.entries("unknown") == []


def test_forget_drops_one_instances_log():
    """Tearing a mock down discards its traffic; siblings are untouched."""
    log = ExportMockRequestLog()
    _record(log, "m1", "/a")
    _record(log, "m2", "/b")
    log.forget("m1")
    assert log.entries("m1") == []
    assert len(log.entries("m2")) == 1


def test_the_store_evicts_the_least_recently_written_instance(monkeypatch):
    """Instance count is bounded too, so a long-lived process cannot leak one buffer per mock."""
    monkeypatch.setattr(ExportMockRequestLog, "MAX_TRACKED_INSTANCES", 3)
    log = ExportMockRequestLog()
    for index in range(4):
        _record(log, f"m{index}", "/a")
    assert log.entries("m0") == []
    assert len(log.entries("m3")) == 1


def test_recording_accepts_an_injected_timestamp():
    """Tests (and any replay) can pin the clock rather than depending on wall time."""
    log = ExportMockRequestLog()
    at = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    _record(log, "m1", "/a", at=at)
    assert log.entries("m1")[0].at == at
