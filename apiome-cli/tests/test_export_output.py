"""Unit tests for export fidelity presentation (MFX-8.2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import typer

from apiome_cli.export_output import (
    enforce_export_fidelity_gate,
    format_export_fidelity_summary,
    format_loss_table_lines,
    format_projection_snapshot_lines,
    is_lossy,
    kind_label,
    sort_report_items_worst_first,
)

_FIXTURES = Path(__file__).resolve().parent / "fixtures"
_PREVIEW_LOSSY = json.loads((_FIXTURES / "export-preview-lossy.json").read_text())
_PREVIEW_LOSSLESS = json.loads((_FIXTURES / "export-preview-lossless.json").read_text())


def test_kind_label_uppercases() -> None:
    assert kind_label("drop") == "DROP"
    assert kind_label("approx") == "APPROX"


def test_sort_report_items_worst_first() -> None:
    items = [
        {"kind": "ok", "severity": "info", "construct": "zebra"},
        {"kind": "drop", "severity": "critical", "construct": "alpha"},
        {"kind": "approx", "severity": "warn", "construct": "beta"},
    ]
    ordered = sort_report_items_worst_first(items)
    assert [item["kind"] for item in ordered] == ["drop", "approx", "ok"]


def test_format_loss_table_skips_ok_rows() -> None:
    fidelity = _PREVIEW_LOSSY["fidelity"]
    lines = format_loss_table_lines(fidelity)
    assert lines[0] == "Per-construct losses:"
    assert any("DROP   event channel" in line for line in lines)
    assert any("APPROX pub/sub action" in line for line in lines)
    assert not any("OK" in line for line in lines)


def test_format_export_fidelity_summary_includes_advisory_and_table() -> None:
    lines = format_export_fidelity_summary(_PREVIEW_LOSSY["fidelity"], target="openapi")
    joined = "\n".join(lines)
    assert "fidelity lossy (60% preserved)" in joined
    assert "OpenAPI may lose fidelity" in joined
    assert "drops 1 construct" in joined
    assert "Per-construct losses:" in joined
    assert "event channel" in joined


def test_format_export_fidelity_summary_lossless_is_clean() -> None:
    lines = format_export_fidelity_summary(_PREVIEW_LOSSLESS["fidelity"], target="openapi")
    joined = "\n".join(lines)
    assert "fidelity lossless (100% preserved)" in joined
    assert "Per-construct losses:" not in joined
    assert is_lossy(_PREVIEW_LOSSLESS["fidelity"]) is False


def test_enforce_export_fidelity_gate_force_accepts_lossy() -> None:
    enforce_export_fidelity_gate(_PREVIEW_LOSSY["fidelity"], force=True)


def test_enforce_export_fidelity_gate_lossless_is_noop() -> None:
    enforce_export_fidelity_gate(_PREVIEW_LOSSLESS["fidelity"], force=False)


def test_enforce_export_fidelity_gate_exits_when_not_acknowledged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("apiome_cli.export_output.interactive_enabled", lambda: False)
    with pytest.raises(typer.Exit) as exc:
        enforce_export_fidelity_gate(_PREVIEW_LOSSY["fidelity"], force=False)
    assert exc.value.exit_code == 1


def test_enforce_export_fidelity_gate_interactive_confirm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("apiome_cli.export_output.interactive_enabled", lambda: True)
    monkeypatch.setattr("typer.confirm", lambda *args, **kwargs: True)
    enforce_export_fidelity_gate(_PREVIEW_LOSSY["fidelity"], force=False)


# ---------------------------------------------------------------------------
# Projection snapshot line (EFP-1.1)
# ---------------------------------------------------------------------------


def test_projection_snapshot_line_when_present() -> None:
    fidelity = {
        "projection": {
            "manifest_hash": "abcdef0123456789",
            "total_constructs": 7,
            "evidence_count": 12,
        }
    }
    lines = format_projection_snapshot_lines(fidelity)
    assert lines == ["Projection snapshot abcdef012345 — 7 constructs, 12 evidence rows"]


def test_projection_snapshot_line_absent_without_projection() -> None:
    assert format_projection_snapshot_lines({"summary": {}}) == []
    assert format_projection_snapshot_lines(None) == []
    assert format_projection_snapshot_lines({"projection": {"manifest_hash": ""}}) == []


def test_fidelity_summary_includes_projection_line() -> None:
    fidelity = dict(_PREVIEW_LOSSY["fidelity"])
    fidelity["projection"] = {
        "manifest_hash": "deadbeefcafebabe",
        "total_constructs": 3,
        "evidence_count": 4,
    }
    lines = format_export_fidelity_summary(fidelity, target="openapi")
    assert any(line.startswith("Projection snapshot deadbeefcafe") for line in lines)
