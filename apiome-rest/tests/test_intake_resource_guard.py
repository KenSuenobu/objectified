"""Intake resource-guard tests — IXH-1.4 (#5090).

Pins the size, alias-expansion, and depth bounds the import intake now applies, and
that the bounds come from the published resource-limits artifact rather than from
constants restated here (``oas_resource_limits.json`` lists ``import`` in its
``appliesTo``).

The corpus-level proof that hostile documents *terminate* lives in
:mod:`tests.test_corpus_adversarial`; this module covers the guard's own edges.
"""

from __future__ import annotations

import json
import time

import pytest

from app.import_ingestion import IngestionError, parse_document
from app.intake_resource_guard import (
    IntakeLimitError,
    IntakeLimits,
    effective_intake_limits,
    guard_document_size,
    guard_document_text,
    guard_parsed_document,
    guard_payload_bytes,
)
from app.oas_resource_limits import resource_limit_values

#: Tight bounds for edge tests, so a fixture need not be megabytes to trip them.
TIGHT = IntakeLimits(max_bytes=512, max_alias_cost=10, max_depth=8)


def test_limits_mirror_the_published_artifact():
    limits = effective_intake_limits()
    values = resource_limit_values()
    assert limits.max_bytes == values.max_document_bytes
    assert limits.max_alias_cost == values.max_alias_count
    assert limits.max_depth == values.max_nesting_depth


# ---------------------------------------------------------------------------
# Size
# ---------------------------------------------------------------------------


def test_document_within_the_size_limit_passes():
    guard_document_size("x" * 100, limits=TIGHT)


def test_oversized_document_is_rejected():
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_document_size("x" * 1000, source_label="big.json", limits=TIGHT)
    assert excinfo.value.code == "INPUT_TOO_LARGE"
    assert "big.json" in str(excinfo.value)


def test_size_is_measured_in_utf8_bytes_not_characters():
    """A multi-byte document is measured by its encoded length."""
    text = "é" * 300  # 600 UTF-8 bytes, 300 characters
    with pytest.raises(IntakeLimitError):
        guard_document_size(text, limits=TIGHT)


def test_payload_bytes_guard_rejects_before_decoding():
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_payload_bytes(b"x" * 1000, source_label="big.bin", limits=TIGHT)
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_payload_bytes_guard_accepts_a_small_upload():
    guard_payload_bytes(b"{}", limits=TIGHT)


# ---------------------------------------------------------------------------
# Alias expansion
# ---------------------------------------------------------------------------


def test_alias_bomb_is_rejected_quickly():
    """A billion-laughs YAML stream is refused, and refused *fast*."""
    lines = ["a: &a [x, x, x, x, x, x, x, x, x]"]
    for level, prev in zip("bcdef", "abcde"):
        lines.append(f"{level}: &{level} [" + ", ".join([f"*{prev}"] * 9) + "]")
    lines.append("boom: [" + ", ".join(["*f"] * 9) + "]")
    text = "\n".join(lines)

    start = time.monotonic()
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_document_text(text)
    elapsed = time.monotonic() - start
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"
    assert elapsed < 2.0, f"alias scan took {elapsed:.2f}s (generous CI margin)"


def test_modest_alias_use_is_allowed():
    """Anchors are a legitimate YAML feature; only runaway expansion is refused."""
    text = "defaults: &d {timeout: 30}\na: *d\nb: *d\nc: *d\n"
    guard_document_text(text)


def test_non_yaml_text_skips_the_alias_check():
    """A stream that does not scan as YAML is left to the caller's syntax handling."""
    guard_document_text("{not: valid: yaml: at: all", limits=TIGHT)


# ---------------------------------------------------------------------------
# Depth
# ---------------------------------------------------------------------------


def test_deeply_nested_flow_document_is_rejected_pre_parse():
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_document_text("[" * 200 + "]" * 200, limits=TIGHT)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_exact_depth_is_enforced_post_parse():
    parsed = json.loads("[" * 12 + "]" * 12)
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_parsed_document(parsed, limits=TIGHT)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_document_at_the_depth_limit_passes():
    guard_parsed_document(json.loads("[" * 8 + "]" * 8), limits=TIGHT)


def test_self_referential_alias_cycle_is_rejected():
    """A YAML alias pointing at its own ancestor cannot be walked by any consumer."""
    with pytest.raises(IntakeLimitError) as excinfo:
        parse_document("a: &a\n  b: *a\n")
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"
    assert "circular" in str(excinfo.value)


def test_depth_analysis_allows_shared_subtrees():
    """A diamond (shared, non-cyclic) subtree is legitimate and must not be refused."""
    shared = {"x": 1}
    guard_parsed_document({"a": shared, "b": shared}, limits=TIGHT)


# ---------------------------------------------------------------------------
# parse_document wiring
# ---------------------------------------------------------------------------


def test_parse_document_still_accepts_ordinary_documents():
    document = parse_document(json.dumps({"openapi": "3.1.0", "paths": {}}))
    assert document["openapi"] == "3.1.0"


def test_parse_document_reports_syntax_faults_as_ingestion_errors():
    """A limit breach and a syntax fault stay distinguishable."""
    with pytest.raises(IngestionError):
        parse_document("{unclosed: [")


def test_parse_document_rejects_an_oversized_document():
    oversized = json.dumps({"pad": "x" * (11 * 1024 * 1024)})
    with pytest.raises(IntakeLimitError) as excinfo:
        parse_document(oversized)
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_parse_document_rejects_deep_nesting_without_recursing():
    with pytest.raises(IntakeLimitError) as excinfo:
        parse_document('{"a":' * 5000 + "1" + "}" * 5000)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_detection_tolerates_a_limit_breaching_document():
    """Format detection is best-effort: a bomb must not make it raise."""
    from app.format_detection import detect_format
    from app.import_source import DetectionInput

    bomb = "a: &a [x, x, x, x, x, x, x, x, x]\n" + "\n".join(
        f"{level}: &{level} [" + ", ".join([f"*{prev}"] * 9) + "]"
        for level, prev in zip("bcdef", "abcde")
    )
    detection = detect_format(DetectionInput(text=bomb, filename="bomb.yaml"))
    assert detection is not None


# ---------------------------------------------------------------------------
# IXH-6.5 GuardProfile + new dimensions
# ---------------------------------------------------------------------------


def test_guard_profile_composes_oas_and_ixh_defaults():
    from app.intake_resource_guard import resolve_guard_profile

    profile = resolve_guard_profile(profile_name="default")
    assert profile.name == "default"
    values = resource_limit_values()
    assert profile.limits.max_bytes == values.max_document_bytes
    assert profile.limits.max_raw_bytes == values.max_document_bytes
    assert profile.limits.max_entity_count == 50_000
    assert profile.limits.max_ref_depth == 32
    assert profile.limits.max_ref_fanout == 64
    assert profile.limits.stage_wall_clock_seconds == 20.0
    assert profile.limits.job_memory_ceiling_bytes == 201_326_592
    assert profile.limits.max_expansion_ratio == 10.0


def test_elevated_profile_scales_selected_ceilings():
    from app.intake_resource_guard import resolve_guard_profile

    default = resolve_guard_profile(profile_name="default")
    elevated = resolve_guard_profile(profile_name="elevated")
    assert elevated.name == "elevated"
    assert elevated.limits.max_bytes == default.limits.max_bytes * 2
    assert elevated.limits.max_entity_count == default.limits.max_entity_count * 2
    assert elevated.limits.stage_wall_clock_seconds == default.limits.stage_wall_clock_seconds * 2
    assert elevated.limits.job_memory_ceiling_bytes == default.limits.job_memory_ceiling_bytes * 2
    # Ratio / ref geometry stay at default.
    assert elevated.limits.max_expansion_ratio == default.limits.max_expansion_ratio
    assert elevated.limits.max_ref_depth == default.limits.max_ref_depth


def test_limit_error_names_the_limit_and_value():
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_payload_bytes(b"x" * 1000, source_label="big.bin", limits=TIGHT)
    err = excinfo.value
    assert err.code == "INPUT_TOO_LARGE"
    assert err.limit_name == "max_raw_bytes"
    assert err.limit_value == TIGHT.effective_raw_bytes()
    assert "max_raw_bytes=" in str(err)


def test_entity_count_limit_trips():
    tight = IntakeLimits(max_bytes=10_000, max_alias_cost=100, max_depth=64, max_entity_count=3)
    # Four dict/list nodes: root + a + b + c
    parsed = {"a": {"x": 1}, "b": {"y": 2}, "c": {"z": 3}}
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_parsed_document(parsed, limits=tight)
    assert excinfo.value.code == "INPUT_ENTITY_LIMIT"
    assert excinfo.value.limit_name == "max_entity_count"
    assert "max_entity_count=" in str(excinfo.value)


def test_ref_depth_limit_trips():
    tight = IntakeLimits(max_bytes=10_000, max_alias_cost=100, max_depth=64, max_ref_depth=2)
    parsed = {
        "$ref": "#/a",
        "a": {"$ref": "#/b", "b": {"$ref": "#/c", "c": {"type": "string"}}},
    }
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_parsed_document(parsed, limits=tight)
    assert excinfo.value.code == "INPUT_REF_LIMIT"
    assert excinfo.value.limit_name == "max_ref_depth"


def test_ref_fanout_limit_trips():
    tight = IntakeLimits(max_bytes=10_000, max_alias_cost=100, max_depth=64, max_ref_fanout=2)
    parsed = {
        "allOf": [
            {"$ref": "#/components/schemas/A"},
            {"$ref": "#/components/schemas/B"},
            {"$ref": "#/components/schemas/C"},
        ]
    }
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_parsed_document(parsed, limits=tight)
    assert excinfo.value.code == "INPUT_REF_LIMIT"
    assert excinfo.value.limit_name == "max_ref_fanout"
    assert "max_ref_fanout=" in str(excinfo.value)


def test_expansion_ratio_limit_trips():
    from app.intake_resource_guard import guard_expansion_ratio

    tight = IntakeLimits(
        max_bytes=10_000, max_alias_cost=100, max_depth=64, max_expansion_ratio=2.0
    )
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_expansion_ratio(raw_bytes=100, expanded_bytes=500, limits=tight)
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"
    assert excinfo.value.limit_name == "max_expansion_ratio"


def test_wall_clock_limit_trips():
    import time

    from app.intake_resource_guard import stage_wall_clock

    tight = IntakeLimits(
        max_bytes=10_000, max_alias_cost=100, max_depth=64, stage_wall_clock_seconds=0.01
    )
    with pytest.raises(IntakeLimitError) as excinfo:
        with stage_wall_clock("parse", limits=tight):
            time.sleep(0.05)
    assert excinfo.value.code == "INPUT_TIME_LIMIT"
    assert excinfo.value.limit_name == "stage_wall_clock_seconds"


def test_memory_limit_trips():
    from app.intake_resource_guard import guard_stage_memory

    tight = IntakeLimits(
        max_bytes=10_000, max_alias_cost=100, max_depth=64, job_memory_ceiling_bytes=1024
    )
    with pytest.raises(IntakeLimitError) as excinfo:
        guard_stage_memory(peak_bytes=4096, limits=tight)
    assert excinfo.value.code == "INPUT_MEMORY_LIMIT"
    assert excinfo.value.limit_name == "job_memory_ceiling_bytes"
