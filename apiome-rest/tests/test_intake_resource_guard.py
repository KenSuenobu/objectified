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
