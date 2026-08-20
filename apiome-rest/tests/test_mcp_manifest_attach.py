"""Where a manifest import lands — FMT-1.7 (#5418).

The ticket's fifth acceptance criterion: *importing a manifest does not create a duplicate
endpoint when one already exists from probing; it attaches as a source of the same
endpoint.* The decision is pure, so these tests drive it with plain endpoint rows rather
than through a live catalog.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.mcp_manifest_attach import (
    MATCH_ADDRESS,
    MATCH_NONE,
    MATCH_SURFACE,
    ManifestTargetError,
    plan_manifest_attach,
    resolve_manifest_target,
    slugify_endpoint_name,
)
from app.mcp_manifest_parser import manifest_surface, parse_mcp_manifest

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/mcp"
_MINIMAL = (_EXAMPLES / "01-minimal-echo-tool.json").read_text(encoding="utf-8")
_TYPICAL = (_EXAMPLES / "02-typical-tickets-server.json").read_text(encoding="utf-8")
_STRESS = (_EXAMPLES / "04-stress-grammar-corners.json").read_text(encoding="utf-8")


def _target(text: str = _TYPICAL, **overrides: Any):
    document = parse_mcp_manifest(text)
    return resolve_manifest_target(
        document, manifest_surface(document).fingerprint(), **overrides
    )


def _endpoint(endpoint_id: str, url: str, transport: str = "streamable_http") -> Dict[str, Any]:
    return {"id": endpoint_id, "endpoint_url": url, "transport": transport}


# ---------------------------------------------------------------------------
# Resolving the address
# ---------------------------------------------------------------------------


def test_the_manifest_transport_supplies_the_address() -> None:
    target = _target()
    assert target.endpoint_url == "https://mcp.example.com/tickets"
    assert target.transport == "streamable_http"
    assert target.name == "Acme Support Tickets"
    assert target.slug == "acme-support-tickets"


def test_a_stdio_manifest_resolves_to_its_command_line() -> None:
    target = _target(_STRESS)
    assert target.transport == "stdio"
    assert target.endpoint_url == "acme-lab-mcp --profile readonly"


def test_an_explicit_address_overrides_the_manifest() -> None:
    target = _target(endpoint_url="https://internal.example/mcp", transport="sse")
    assert target.endpoint_url == "https://internal.example/mcp"
    assert target.transport == "sse"


def test_a_manifest_with_no_transport_needs_an_explicit_address() -> None:
    with pytest.raises(ManifestTargetError):
        _target(_MINIMAL)


def test_a_manifest_with_no_transport_accepts_a_supplied_address() -> None:
    target = _target(_MINIMAL, endpoint_url="https://echo.example.com/mcp")
    assert target.endpoint_url == "https://echo.example.com/mcp"
    assert target.transport == "streamable_http"


def test_a_supplied_command_line_defaults_to_the_stdio_transport() -> None:
    target = _target(_MINIMAL, endpoint_url="npx -y @acme/echo-server")
    assert target.transport == "stdio"


def test_a_redirected_address_does_not_inherit_the_manifests_transport() -> None:
    """A stdio manifest re-pointed at a URL is reached over HTTP, not by running a command."""
    target = _target(_STRESS, endpoint_url="https://lab.example.com/mcp")
    assert target.endpoint_url == "https://lab.example.com/mcp"
    assert target.transport == "streamable_http"


def test_a_redirected_address_still_honours_an_explicit_transport() -> None:
    target = _target(_STRESS, endpoint_url="https://lab.example.com/mcp", transport="sse")
    assert target.transport == "sse"


def test_slugify_matches_the_manual_registration_rule() -> None:
    assert slugify_endpoint_name("Acme Support Tickets") == "acme-support-tickets"
    assert slugify_endpoint_name("  A/B  ") == "a-b"
    assert slugify_endpoint_name("!!!") == "endpoint"


# ---------------------------------------------------------------------------
# Planning the attach
# ---------------------------------------------------------------------------


def test_an_empty_catalog_creates_an_endpoint() -> None:
    plan = plan_manifest_attach(_target(), [])
    assert plan.created is True
    assert plan.match == MATCH_NONE
    assert plan.endpoint_id is None
    assert plan.reason


def test_a_matching_url_attaches_instead_of_creating() -> None:
    plan = plan_manifest_attach(
        _target(), [_endpoint("e1", "https://mcp.example.com/tickets")]
    )
    assert plan.created is False
    assert plan.match == MATCH_ADDRESS
    assert plan.endpoint_id == "e1"


@pytest.mark.parametrize(
    "stored",
    [
        "https://MCP.EXAMPLE.COM/tickets",
        "https://mcp.example.com/tickets/",
        "https://mcp.example.com:443/tickets",
        "https://mcp.example.com/tickets#fragment",
    ],
)
def test_the_address_match_uses_the_catalogs_own_url_canonicalization(stored: str) -> None:
    """Same rule as the duplicate report, so "the same server" means one thing."""
    plan = plan_manifest_attach(_target(), [_endpoint("e1", stored)])
    assert plan.endpoint_id == "e1"
    assert plan.match == MATCH_ADDRESS


def test_a_different_path_on_the_same_host_is_a_different_server() -> None:
    """A shared host is an advisory hint in the duplicate report, never a match here."""
    plan = plan_manifest_attach(_target(), [_endpoint("e1", "https://mcp.example.com/billing")])
    assert plan.created is True
    assert plan.match == MATCH_NONE


def test_an_identical_surface_matches_even_with_no_address_in_common() -> None:
    target = _target()
    plan = plan_manifest_attach(
        target,
        [_endpoint("e1", "https://elsewhere.example/mcp")],
        observed_fingerprints={"e1": target.declared_fingerprint},
    )
    assert plan.match == MATCH_SURFACE
    assert plan.endpoint_id == "e1"
    assert plan.surface_conflict is False


def test_the_address_rule_wins_over_the_surface_rule() -> None:
    """A stale manifest still belongs to the server it addresses."""
    target = _target()
    plan = plan_manifest_attach(
        target,
        [
            _endpoint("surface-twin", "https://elsewhere.example/mcp"),
            _endpoint("addressed", "https://mcp.example.com/tickets"),
        ],
        observed_fingerprints={
            "surface-twin": target.declared_fingerprint,
            "addressed": "a-different-fingerprint",
        },
    )
    assert plan.endpoint_id == "addressed"
    assert plan.match == MATCH_ADDRESS


def test_a_matched_endpoint_with_a_different_surface_reports_a_conflict() -> None:
    target = _target()
    plan = plan_manifest_attach(
        target,
        [_endpoint("e1", "https://mcp.example.com/tickets")],
        observed_fingerprints={"e1": "something-else"},
    )
    assert plan.created is False
    assert plan.surface_conflict is True
    assert plan.observed_fingerprint == "something-else"
    assert "differs" in plan.reason


def test_a_never_discovered_endpoint_is_an_absence_not_a_conflict() -> None:
    plan = plan_manifest_attach(
        _target(),
        [_endpoint("e1", "https://mcp.example.com/tickets")],
        observed_fingerprints={"e1": None},
    )
    assert plan.surface_conflict is False
    assert plan.observed_fingerprint is None


def test_rows_without_an_id_are_skipped_rather_than_matched() -> None:
    plan = plan_manifest_attach(
        _target(), [{"endpoint_url": "https://mcp.example.com/tickets", "transport": "sse"}]
    )
    assert plan.created is True


def test_a_stdio_endpoint_matches_on_its_exact_command_line() -> None:
    target = _target(_STRESS)
    plan = plan_manifest_attach(
        target, [_endpoint("e1", "acme-lab-mcp --profile readonly", transport="stdio")]
    )
    assert plan.match == MATCH_ADDRESS
    assert plan.endpoint_id == "e1"


def test_a_stdio_endpoint_with_different_arguments_does_not_match() -> None:
    target = _target(_STRESS)
    plan = plan_manifest_attach(
        target, [_endpoint("e1", "acme-lab-mcp --profile write", transport="stdio")]
    )
    assert plan.created is True


def test_re_importing_the_same_manifest_lands_on_the_same_endpoint() -> None:
    """Idempotence: the second import of an unchanged manifest attaches, never duplicates."""
    target = _target()
    endpoints: List[Dict[str, Any]] = [_endpoint("e1", "https://mcp.example.com/tickets")]
    first = plan_manifest_attach(target, endpoints)
    second = plan_manifest_attach(target, endpoints)
    assert first == second
    assert second.created is False
