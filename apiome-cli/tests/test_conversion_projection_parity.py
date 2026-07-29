"""Conversion projection-manifest parity for the CLI — CPDO-4.1 (#4804).

``apiome convert --projection-out`` walks the server's projection cursor stream and reassembles
one machine-readable manifest; ``format_projection_summary`` renders the dry-run's snapshot line.
The CLI leg of the cross-surface parity contract is therefore: given the exact wire conversation
the REST routes produce, the assembler must reconstruct the manifest the summary declares — same
edge count, same status totals, same snapshot hash — and refuse to fabricate completeness when the
walk cannot finish.

The fixture (``fixtures/conversion-projection-parity.json``) is a checked-in copy of the
apiome-rest recorded envelope ``tests/fixtures/conversion_projection_parity.json`` — the real
dry-run + projection responses for the multi-group X12 corpus fixture, analysis attached.
Regenerate both together when the contract changes: in apiome-rest run
``pytest tests/test_conversion_manifest_golden.py --update-golden``, then re-copy the file here
and to ``apiome-ui/tests/fixtures/conversionProjectionParity.json``.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from apiome_cli.client.conversion_output import (
    assemble_projection_manifest,
    format_projection_summary,
)

_FIXTURES = Path(__file__).resolve().parent / "fixtures"
_ENVELOPE = json.loads((_FIXTURES / "conversion-projection-parity.json").read_text())


def _envelope() -> dict[str, Any]:
    """A deep copy of the recorded envelope, safe to tamper per-test."""
    return copy.deepcopy(_ENVELOPE)


def _fetch_page_from(responses: list[Mapping[str, Any]]):
    """Build the ``fetch_page`` callable the assembler takes, serving the recorded responses.

    Pages are keyed by the cursor that reaches them, exactly as the live client would request
    them: ``None`` for the first page, then each page's ``next_cursor``.
    """
    by_cursor: dict[Any, Mapping[str, Any]] = {}
    cursor = None
    for response in responses:
        by_cursor[cursor] = response
        cursor = response["page"]["next_cursor"]

    def fetch_page(requested: str | None) -> Mapping[str, Any]:
        return by_cursor[requested]

    return fetch_page


def test_recorded_walk_reassembles_the_declared_manifest() -> None:
    """Walking the recorded responses reproduces exactly what the summary declares: every edge
    once, in server order, nodes de-duplicated, and the summary's own snapshot hash."""
    envelope = _envelope()
    expected = envelope["expected"]

    assembled = assemble_projection_manifest(_fetch_page_from(envelope["responses"]))

    assert assembled["pagesTruncated"] is False
    assert assembled["summary"]["manifest_hash"] == expected["manifest_hash"]
    assert len(assembled["edges"]) == expected["edge_count"]
    assert len({edge["id"] for edge in assembled["edges"]}) == expected["edge_count"]

    recorded_order = [
        edge["id"]
        for response in envelope["responses"]
        for edge in response["page"]["edges"]
    ]
    assert [edge["id"] for edge in assembled["edges"]] == recorded_order

    node_ids = [node["id"] for node in assembled["nodes"]]
    assert len(node_ids) == len(set(node_ids)), "nodes must be de-duplicated across pages"
    assert len(node_ids) == expected["node_count"]


def test_assembled_status_totals_match_the_summary() -> None:
    """The reassembled edges recount to the envelope's declared status totals — the same
    reconciliation the UI's graph panel performs before it trusts a walk."""
    envelope = _envelope()
    assembled = assemble_projection_manifest(_fetch_page_from(envelope["responses"]))

    recount: dict[str, int] = {}
    for edge in assembled["edges"]:
        recount[edge["status"]] = recount.get(edge["status"], 0) + 1
    assert recount == envelope["expected"]["status_totals"]

    declared = {
        status: count
        for status, count in assembled["summary"]["status_counts"].items()
        if count
    }
    assert recount == declared


def test_every_recorded_non_retained_edge_names_its_cause() -> None:
    """The wire contract the evidence drawer depends on, asserted over the recorded pages."""
    for response in _envelope()["responses"]:
        for edge in response["page"]["edges"]:
            assert edge["status"] == "retained" or edge["reason"], edge["id"]


def test_dry_run_summary_renders_the_snapshot_line() -> None:
    """The dry-run's ``projection`` block renders to the snapshot line scripts key off: the
    12-char hash prefix and the count of constructs not carried faithfully."""
    projection = _envelope()["dry_run_projection"]
    lines = format_projection_summary(projection)

    assert lines, "a dry-run with a manifest must render a snapshot line"
    assert projection["manifest_hash"][:12] in lines[0]
    unfaithful = sum(
        projection["status_counts"].get(status, 0)
        for status in ("transformed", "inferred", "dropped", "unavailable")
    )
    assert f"{unfaithful} not carried faithfully" in lines[0]


def test_a_cursor_loop_is_declared_truncated_not_complete() -> None:
    """A server that keeps returning the same cursor must yield ``pagesTruncated`` — the CLI
    never silently claims a complete manifest it could not finish walking."""
    envelope = _envelope()
    first = envelope["responses"][0]
    looping = dict(first)
    looping["page"] = dict(first["page"])
    looping["page"]["next_cursor"] = "cursor-loop"

    assembled = assemble_projection_manifest(lambda cursor: looping)

    assert assembled["pagesTruncated"] is True
