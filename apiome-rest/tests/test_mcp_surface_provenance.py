"""Declared-vs-observed surface attribution — FMT-1.7 (#5418).

The ticket's third acceptance criterion: *provenance distinguishes declared manifest facts
from observed probe facts.* These tests hold the module to the three honesty rules it
states — absence is never evidence, a conflict is reported rather than resolved, and
equality means exactly what the fingerprint means — plus the storage round trip that makes
a stored fingerprint checkable rather than merely asserted.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from app.mcp_client.discovery import DiscoveryListings
from app.mcp_client.handshake import InitializeResult, ServerInfo
from app.mcp_client.normalize import DiscoverySurface
from app.mcp_manifest_parser import manifest_surface, parse_mcp_manifest
from app.mcp_manifest_store import declared_manifest, surface_from_manifest_row
from app.mcp_surface_provenance import (
    AGREEMENT_AGREES,
    AGREEMENT_CONFLICTS,
    AGREEMENT_UNCONTESTED,
    ORIGIN_BOTH,
    ORIGIN_DECLARED,
    ORIGIN_OBSERVED,
    SURFACE_MATCH_DECLARED_ONLY,
    SURFACE_MATCH_DIVERGENT,
    SURFACE_MATCH_IDENTICAL,
    SURFACE_MATCH_NONE,
    SURFACE_MATCH_OBSERVED_ONLY,
    build_surface_provenance,
    origin_label,
)

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/mcp"
_TYPICAL = (_EXAMPLES / "02-typical-tickets-server.json").read_text(encoding="utf-8")


def _probe(raw: Dict[str, Any]) -> DiscoverySurface:
    """The surface a live probe of this manifest's server would produce."""
    return DiscoverySurface.from_discovery(
        InitializeResult(
            protocol_version=raw["mcpVersion"],
            server_info=ServerInfo.from_dict(raw["server"]),
            capabilities=raw.get("capabilities") or {},
            instructions=raw.get("instructions"),
        ),
        DiscoveryListings(
            tools=raw.get("tools") or [],
            resources=raw.get("resources") or [],
            resource_templates=raw.get("resourceTemplates") or [],
            prompts=raw.get("prompts") or [],
        ),
    )


@pytest.fixture
def declared() -> DiscoverySurface:
    return manifest_surface(parse_mcp_manifest(_TYPICAL))


@pytest.fixture
def observed() -> DiscoverySurface:
    return _probe(json.loads(_TYPICAL))


def _fact(report, scope: str, key: str):
    return next(f for f in report.facts if f.scope == scope and f.key == key)


# ---------------------------------------------------------------------------
# The four relationships between the two surfaces
# ---------------------------------------------------------------------------


def test_neither_surface_reports_none_and_claims_nothing() -> None:
    report = build_surface_provenance()
    assert report.surface_match == SURFACE_MATCH_NONE
    assert report.facts == ()
    assert report.fingerprints_match is False
    assert report.conflict_count == 0


def test_only_a_manifest_reads_as_declared_only(declared: DiscoverySurface) -> None:
    report = build_surface_provenance(declared=declared)
    assert report.surface_match == SURFACE_MATCH_DECLARED_ONLY
    assert report.observed_fingerprint is None
    assert report.fingerprints_match is False
    assert report.origin_counts[ORIGIN_OBSERVED] == 0
    assert all(f.origin == ORIGIN_DECLARED for f in report.facts)


def test_only_a_probe_reads_as_observed_only_never_as_agreement(
    observed: DiscoverySurface,
) -> None:
    report = build_surface_provenance(observed=observed)
    assert report.surface_match == SURFACE_MATCH_OBSERVED_ONLY
    assert report.fingerprints_match is False
    assert report.conflict_count == 0
    assert all(f.agreement == AGREEMENT_UNCONTESTED for f in report.facts)


def test_matching_surfaces_read_as_identical_with_every_fact_corroborated(
    declared: DiscoverySurface, observed: DiscoverySurface
) -> None:
    report = build_surface_provenance(declared=declared, observed=observed)
    assert report.surface_match == SURFACE_MATCH_IDENTICAL
    assert report.fingerprints_match is True
    assert report.conflict_count == 0
    assert report.origin_counts[ORIGIN_BOTH] == len(report.facts)
    assert all(f.agreement == AGREEMENT_AGREES for f in report.facts)


# ---------------------------------------------------------------------------
# Divergence
# ---------------------------------------------------------------------------


def test_a_tool_only_the_manifest_declares_is_attributed_to_the_manifest(
    declared: DiscoverySurface,
) -> None:
    raw = json.loads(_TYPICAL)
    raw["tools"] = raw["tools"][:2]
    report = build_surface_provenance(declared=declared, observed=_probe(raw))

    assert report.surface_match == SURFACE_MATCH_DIVERGENT
    fact = _fact(report, "tool", "close_ticket")
    assert fact.origin == ORIGIN_DECLARED
    assert fact.agreement == AGREEMENT_UNCONTESTED
    assert fact.observed is None
    assert report.conflict_count == 0


def test_a_tool_only_the_probe_saw_is_attributed_to_the_probe(
    declared: DiscoverySurface,
) -> None:
    raw = json.loads(_TYPICAL)
    raw["tools"].append(
        {"name": "escalate_ticket", "inputSchema": {"type": "object", "properties": {}}}
    )
    report = build_surface_provenance(declared=declared, observed=_probe(raw))

    fact = _fact(report, "tool", "escalate_ticket")
    assert fact.origin == ORIGIN_OBSERVED
    assert fact.declared is None


def test_a_tool_both_carry_with_different_schemas_is_a_conflict(
    declared: DiscoverySurface,
) -> None:
    raw = json.loads(_TYPICAL)
    raw["tools"][0]["inputSchema"]["properties"]["query"] = {"type": "integer"}
    report = build_surface_provenance(declared=declared, observed=_probe(raw))

    fact = _fact(report, "tool", "search_tickets")
    assert fact.origin == ORIGIN_BOTH
    assert fact.agreement == AGREEMENT_CONFLICTS
    # Both values are carried; nothing here decides which is right.
    assert fact.declared["inputSchema"]["properties"]["query"]["type"] == "string"
    assert fact.observed["inputSchema"]["properties"]["query"]["type"] == "integer"
    assert report.conflict_count == 1
    assert report.conflicts() == (fact,)


def test_a_changed_server_version_is_a_surface_level_conflict(
    declared: DiscoverySurface,
) -> None:
    raw = json.loads(_TYPICAL)
    raw["server"]["version"] = "9.9.9"
    report = build_surface_provenance(declared=declared, observed=_probe(raw))

    fact = _fact(report, "surface", "serverInfo.version")
    assert fact.agreement == AGREEMENT_CONFLICTS
    assert fact.declared == "1.4.0"
    assert fact.observed == "9.9.9"


def test_a_volatile_field_never_becomes_a_conflict(declared: DiscoverySurface) -> None:
    """``_meta`` and a resource ``size`` cannot move the fingerprint, so they cannot conflict."""
    raw = json.loads(_TYPICAL)
    raw["tools"][0]["_meta"] = {"vendor.io/cost": "metered"}
    raw["resources"][0]["size"] = 4096
    report = build_surface_provenance(declared=declared, observed=_probe(raw))

    assert report.fingerprints_match is True
    assert report.surface_match == SURFACE_MATCH_IDENTICAL
    assert report.conflict_count == 0


def test_map_key_order_never_becomes_a_conflict(declared: DiscoverySurface) -> None:
    raw = json.loads(_TYPICAL)
    raw["tools"] = [{key: tool[key] for key in reversed(list(tool))} for tool in raw["tools"]]
    report = build_surface_provenance(declared=declared, observed=_probe(raw))
    assert report.conflict_count == 0
    assert report.surface_match == SURFACE_MATCH_IDENTICAL


def test_a_field_neither_side_states_is_omitted_rather_than_reported_as_agreement(
    declared: DiscoverySurface, observed: DiscoverySurface
) -> None:
    """Neither the manifest nor the probe states `instructions` for this server."""
    report = build_surface_provenance(declared=declared, observed=observed)
    assert not any(f.key == "instructions" for f in report.facts)


def test_a_conflict_is_reported_but_the_fingerprints_disagree_together(
    declared: DiscoverySurface,
) -> None:
    """The report and the fingerprint can never tell different stories."""
    raw = json.loads(_TYPICAL)
    raw["prompts"][0]["description"] = "Different."
    report = build_surface_provenance(declared=declared, observed=_probe(raw))
    assert report.conflict_count == 1
    assert report.fingerprints_match is False


# ---------------------------------------------------------------------------
# Serialization and labels
# ---------------------------------------------------------------------------


def test_the_report_serializes_with_labelled_origins(
    declared: DiscoverySurface, observed: DiscoverySurface
) -> None:
    payload = build_surface_provenance(declared=declared, observed=observed).to_dict()
    assert payload["surface_match"] == SURFACE_MATCH_IDENTICAL
    assert payload["facts"]
    assert all(fact["origin_label"] for fact in payload["facts"])
    assert json.dumps(payload)  # JSON-serializable end to end


def test_an_unknown_origin_never_reads_as_a_concrete_source() -> None:
    assert origin_label(None) == "Unrecorded"
    assert origin_label("wishful") == "Unrecorded"
    assert origin_label(ORIGIN_DECLARED) != origin_label(ORIGIN_OBSERVED)


# ---------------------------------------------------------------------------
# Storage round trip
# ---------------------------------------------------------------------------


def test_a_stored_manifest_row_re_derives_its_own_fingerprint() -> None:
    for name in sorted(_EXAMPLES.glob("*.json")):
        document = parse_mcp_manifest(name.read_text(encoding="utf-8"), source_label=name.name)
        row = declared_manifest(document).as_row()
        rebuilt = surface_from_manifest_row(row)
        assert rebuilt is not None, name.name
        assert rebuilt.fingerprint() == row["surface_fingerprint"], name.name


def test_a_rebuilt_row_still_corroborates_the_probe_it_matched(
    observed: DiscoverySurface,
) -> None:
    row = declared_manifest(parse_mcp_manifest(_TYPICAL)).as_row()
    report = build_surface_provenance(
        declared=surface_from_manifest_row(row), observed=observed
    )
    assert report.surface_match == SURFACE_MATCH_IDENTICAL


def test_the_row_records_the_declared_counts_and_identity() -> None:
    row = declared_manifest(parse_mcp_manifest(_TYPICAL), source_label="tickets.json").as_row()
    assert row["source_label"] == "tickets.json"
    assert row["server_name"] == "acme-tickets"
    assert row["server_title"] == "Acme Support Tickets"
    assert row["server_version"] == "1.4.0"
    assert row["protocol_version"] == "2025-06-18"
    assert row["tool_count"] == 3
    assert row["resource_count"] == 1
    assert row["resource_template_count"] == 1
    assert row["prompt_count"] == 1


def test_an_unreadable_row_reads_as_no_declaration_not_as_an_empty_one() -> None:
    assert surface_from_manifest_row(None) is None
    assert surface_from_manifest_row({"surface": "not a projection"}) is None


def test_a_row_with_no_source_label_defaults_to_pasted() -> None:
    row = declared_manifest(parse_mcp_manifest(_TYPICAL)).as_row()
    assert row["source_label"] == "pasted"
