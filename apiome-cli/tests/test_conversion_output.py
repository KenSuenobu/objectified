"""Tests for the conversion result formatter (MFI-22.6) and projection assembler (CPDO-1.3).

Pins the pure presentation helpers the ``convert`` command uses: the fidelity headline + the
mandatory warning, the gap listing, the commit ids line, the low-tier detection that drives the
command's non-zero exit hint, and the projection-manifest summary line + cursor walk. No HTTP, no
typer.
"""

from __future__ import annotations

from apiome_cli.client.conversion_output import (
    CONVERSION_WARNING_SENTENCE,
    MAX_PROJECTION_PAGES,
    assemble_projection_manifest,
    format_conversion_summary,
    format_projection_summary,
    is_low_tier,
    report_tier,
)


def _report(tier: str = "medium", *, items=None, losses=None) -> dict:
    return {
        "score": 74,
        "grade": "C",
        "tier": tier,
        "items": items or [],
        "losses": losses or [],
        "coverage_counts": {},
        "penalty": 26,
    }


def test_report_tier_and_low_tier_detection():
    assert report_tier({"tier": "LOW"}) == "low"
    assert is_low_tier(_report("low")) is True
    assert is_low_tier(_report("medium")) is False
    assert is_low_tier({}) is False


def test_summary_headline_and_warning_for_dry_run():
    lines = format_conversion_summary(
        {"report": _report(), "target": "openapi", "sourceFormat": "graphql"},
        committed=False,
    )
    assert any("fidelity C (74/100), tier medium" in line for line in lines)
    assert CONVERSION_WARNING_SENTENCE in lines
    # A dry-run never claims a project was created.
    assert not any("into project" in line for line in lines)


def test_summary_lists_gap_constructs_only():
    report = _report(
        items=[
            {"title": "Responses", "coverage": "present", "reason": "carried"},
            {"title": "Servers", "coverage": "missing", "reason": "source declares no servers"},
            {"title": "Security", "coverage": "n/a", "reason": "no OpenAPI form"},
        ],
    )
    lines = format_conversion_summary({"report": report, "target": "openapi"}, committed=False)
    text = "\n".join(lines)
    assert "Servers [missing]" in text
    assert "Security [n/a]" in text
    # 'present' constructs are not listed as gaps.
    assert "Responses" not in text


def test_summary_reports_projection_losses_count():
    report = _report(losses=[{"kind": "n/a", "subject": "graphql-subscription", "detail": "x"}])
    lines = format_conversion_summary({"report": report, "target": "openapi"}, committed=False)
    assert any("Projection losses: 1" in line for line in lines)


def test_summary_commit_reports_created_ids():
    response = {
        "report": _report(),
        "projectId": "proj-9",
        "versionId": "1.0.0",
        "reconverted": False,
    }
    lines = format_conversion_summary(response, committed=True)
    assert any("Converted into project proj-9 version 1.0.0" in line for line in lines)


def test_summary_commit_reconvert_wording():
    response = {"report": _report(), "projectId": "p", "versionId": "1.0.1", "reconverted": True}
    lines = format_conversion_summary(response, committed=True)
    assert any(line.startswith("Re-converted into project") for line in lines)


def test_summary_low_tier_adds_force_hint():
    lines = format_conversion_summary({"report": _report("low"), "target": "openapi"}, committed=False)
    assert any("Low fidelity" in line and "--force" in line for line in lines)


def test_summary_without_report_is_graceful():
    lines = format_conversion_summary({"projectId": "p"}, committed=True)
    assert lines == ["Conversion completed, but no fidelity report was returned."]


# ---------------------------------------------------------------------------
# Projection manifest helpers (CPDO-1.3)
# ---------------------------------------------------------------------------


def test_format_projection_summary_counts_the_unfaithful_statuses() -> None:
    """Everything that is not ``retained`` or ``not-applicable`` counts as not carried faithfully."""
    lines = format_projection_summary(
        {
            "manifest_hash": "0123456789abcdef",
            "total_constructs": 9,
            "status_counts": {
                "retained": 5,
                "not-applicable": 3,
                "transformed": 1,
                "inferred": 2,
                "dropped": 1,
                "unavailable": 4,
            },
        }
    )
    assert lines == ["Projection manifest 0123456789ab: 9 source construct(s), 8 not carried faithfully."]


def test_format_projection_summary_is_silent_without_a_manifest() -> None:
    """No manifest means no line — never a fabricated hash or a zeroed summary."""
    assert format_projection_summary(None) == []
    assert format_projection_summary({}) == []
    assert format_projection_summary({"manifest_hash": ""}) == []
    assert format_projection_summary("not-a-mapping") == []


def test_assemble_projection_manifest_walks_every_cursor() -> None:
    """Cursors are followed to the end and the pages reassembled in order."""
    pages = {
        None: {
            "summary": {"manifest_hash": "h"},
            "page": {"nodes": [{"id": "a"}], "edges": [{"id": "e1"}], "next_cursor": "c1"},
        },
        "c1": {
            "summary": {"manifest_hash": "h"},
            "page": {"nodes": [{"id": "a"}, {"id": "b"}], "edges": [{"id": "e2"}], "next_cursor": None},
        },
    }
    manifest = assemble_projection_manifest(lambda cursor: pages[cursor])
    assert manifest["summary"] == {"manifest_hash": "h"}
    assert [e["id"] for e in manifest["edges"]] == ["e1", "e2"]
    assert [n["id"] for n in manifest["nodes"]] == ["a", "b"]
    assert manifest["pagesTruncated"] is False


def test_assemble_projection_manifest_refuses_a_cursor_loop() -> None:
    """A server that keeps handing back the same cursor stops the walk, flagged rather than hung."""
    page = {
        "summary": {"manifest_hash": "h"},
        "page": {"nodes": [], "edges": [{"id": "e"}], "next_cursor": "same"},
    }
    manifest = assemble_projection_manifest(lambda _cursor: page)
    assert manifest["pagesTruncated"] is True
    assert len(manifest["edges"]) == 2  # the first page, then the repeat that detected the loop


def test_assemble_projection_manifest_caps_the_page_walk() -> None:
    """An endless stream of *distinct* cursors is bounded by MAX_PROJECTION_PAGES."""
    calls = {"n": 0}

    def _fetch(_cursor):
        calls["n"] += 1
        return {
            "summary": {"manifest_hash": "h"},
            "page": {"nodes": [], "edges": [], "next_cursor": f"c{calls['n']}"},
        }

    manifest = assemble_projection_manifest(_fetch)
    assert calls["n"] == MAX_PROJECTION_PAGES
    assert manifest["pagesTruncated"] is True


def test_assemble_projection_manifest_tolerates_a_malformed_page() -> None:
    """A response missing its ``page`` object yields an empty manifest, not an exception."""
    manifest = assemble_projection_manifest(lambda _cursor: {"summary": {"manifest_hash": "h"}})
    assert manifest == {"summary": {"manifest_hash": "h"}, "nodes": [], "edges": [], "pagesTruncated": False}
