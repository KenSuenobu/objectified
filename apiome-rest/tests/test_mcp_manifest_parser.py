"""Static MCP server manifest parser and surface — FMT-1.7 (#5418).

Covers the two properties the ticket rests on and the classification rules that make a
bad manifest actionable:

* **Fingerprint parity.** A manifest and a live probe of the same server produce the same
  ``surface_fingerprint`` — asserted against a surface built the way discovery builds one,
  not against a recorded constant.
* **Reference inlining.** Document-level ``$defs`` and cross-file ``$ref``s resolve into
  the schemas that use them, so a factored manifest and an inline one are the same surface.
* **Failure classification.** Every rejection carries the intake-taxonomy code the corpus
  manifest declares for it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from app.mcp_client.discovery import DiscoveryListings
from app.mcp_client.handshake import InitializeResult, ServerInfo
from app.mcp_client.normalize import DiscoverySurface
from app.mcp_manifest_parser import (
    MAX_REF_DEPTH,
    McpManifestDocument,
    McpManifestParseError,
    dumps_manifest_for_raw,
    is_mcp_manifest,
    is_mcp_manifest_document,
    manifest_surface,
    parse_mcp_manifest,
    parse_mcp_manifest_fileset,
)

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/mcp"


def _read(name: str) -> str:
    return (_EXAMPLES / name).read_text(encoding="utf-8")


_MINIMAL = _read("01-minimal-echo-tool.json")
_TYPICAL = _read("02-typical-tickets-server.json")
_COMPOSITION = _read("03-composition-shared-schemas.json")
_STRESS = _read("04-stress-grammar-corners.json")


def _probe_surface(raw: Dict[str, Any], *, instructions: Any = None) -> DiscoverySurface:
    """Build the surface a live probe of this manifest's server would produce.

    Mirrors the discovery path exactly: an ``initialize`` result plus the four fully-paged
    listings, handed to the same constructor. Nothing about the manifest parser is used, so
    a parity assertion against this is a real comparison rather than a tautology.
    """
    return DiscoverySurface.from_discovery(
        InitializeResult(
            protocol_version=raw["mcpVersion"],
            server_info=ServerInfo.from_dict(raw["server"]),
            capabilities=raw.get("capabilities") or {},
            instructions=instructions,
        ),
        DiscoveryListings(
            tools=raw.get("tools") or [],
            resources=raw.get("resources") or [],
            resource_templates=raw.get("resourceTemplates") or [],
            prompts=raw.get("prompts") or [],
        ),
    )


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def test_detects_every_valid_corpus_manifest() -> None:
    for name in (
        "01-minimal-echo-tool.json",
        "02-typical-tickets-server.json",
        "03-composition-shared-schemas.json",
        "04-stress-grammar-corners.json",
        "05-real-world-filesystem-server.json",
    ):
        assert is_mcp_manifest(_read(name)), name


def test_declines_a_bare_llm_tool_bundle() -> None:
    """A tool array with no protocol-version marker is an LLM bundle, not a manifest."""
    bundle = json.dumps({"tools": [{"name": "echo", "parameters": {"type": "object"}}]})
    assert not is_mcp_manifest(bundle)


def test_declines_an_initialize_result_with_no_capabilities() -> None:
    """The marker is a version *beside* a capability array; a handshake alone is not one."""
    handshake = json.dumps(
        {"protocolVersion": "2025-06-18", "serverInfo": {"name": "x"}, "capabilities": {}}
    )
    assert not is_mcp_manifest(handshake)


def test_declines_an_api_description() -> None:
    assert not is_mcp_manifest('{"openapi":"3.1.0","info":{},"paths":{}}')
    assert not is_mcp_manifest_document({"asyncapi": "3.0.0", "tools": [{"name": "x"}]})


def test_detection_never_raises_on_hostile_input() -> None:
    assert not is_mcp_manifest("")
    assert not is_mcp_manifest("{{{{")
    assert not is_mcp_manifest("\x00\x00\x00")


# ---------------------------------------------------------------------------
# Fingerprint parity with a live probe (the ticket's second acceptance criterion)
# ---------------------------------------------------------------------------


def test_manifest_and_probe_of_the_same_server_fingerprint_identically() -> None:
    raw = json.loads(_TYPICAL)
    declared = manifest_surface(parse_mcp_manifest(_TYPICAL))
    assert declared.fingerprint() == _probe_surface(raw).fingerprint()


def test_parity_holds_for_the_stress_manifest_including_meta_and_size() -> None:
    """``_meta`` and a resource ``size`` are excluded from the fingerprint on both paths."""
    raw = json.loads(_STRESS)
    declared = manifest_surface(parse_mcp_manifest(_STRESS))
    probe = _probe_surface(raw, instructions=raw["server"]["instructions"])
    assert declared.fingerprint() == probe.fingerprint()


def test_instructions_are_read_from_either_level() -> None:
    """A manifest may nest ``instructions`` under ``server``; a probe has one place for it."""
    nested = parse_mcp_manifest(_STRESS)
    top_level = json.loads(_STRESS)
    top_level["instructions"] = top_level["server"].pop("instructions")
    assert (
        manifest_surface(nested).fingerprint()
        == manifest_surface(parse_mcp_manifest(json.dumps(top_level))).fingerprint()
    )


def test_key_order_does_not_move_the_fingerprint() -> None:
    raw = json.loads(_TYPICAL)
    reversed_keys = {key: raw[key] for key in reversed(list(raw))}
    assert (
        manifest_surface(parse_mcp_manifest(json.dumps(reversed_keys))).fingerprint()
        == manifest_surface(parse_mcp_manifest(_TYPICAL)).fingerprint()
    )


def test_a_changed_tool_description_moves_the_fingerprint() -> None:
    """Parity would be worthless if the fingerprint ignored real changes."""
    raw = json.loads(_TYPICAL)
    baseline = manifest_surface(parse_mcp_manifest(_TYPICAL)).fingerprint()
    raw["tools"][0]["description"] = "Something else entirely."
    assert manifest_surface(parse_mcp_manifest(json.dumps(raw))).fingerprint() != baseline


def test_both_version_marker_spellings_land_on_the_same_surface_field() -> None:
    """``mcpVersion`` and ``protocolVersion`` are aliases; a probe has only one spelling."""
    raw = json.loads(_MINIMAL)
    raw["protocolVersion"] = raw.pop("mcpVersion")
    aliased = manifest_surface(parse_mcp_manifest(json.dumps(raw)))
    assert aliased.protocol_version == "2025-06-18"
    assert aliased.fingerprint() == manifest_surface(parse_mcp_manifest(_MINIMAL)).fingerprint()


def test_a_document_with_no_protocol_version_surfaces_none_not_empty_string() -> None:
    """A probe that never negotiated a version leaves the field ``None``; so does this.

    Unreachable through :func:`parse_mcp_manifest` (a manifest with no version marker is a
    ``FORMAT_MISMATCH`` before it gets here), so the document is built directly — the point
    is that the surface field cannot be an empty string, which would fingerprint differently
    from an absent one.
    """
    document = McpManifestDocument(
        server_info=ServerInfo(name="x"),
        tools=({"name": "echo", "inputSchema": {"type": "object"}},),
    )
    assert manifest_surface(document).protocol_version is None


# ---------------------------------------------------------------------------
# Reference inlining
# ---------------------------------------------------------------------------


def test_local_defs_are_inlined_into_the_schemas_that_use_them() -> None:
    document = parse_mcp_manifest(_COMPOSITION)
    check_stock = next(t for t in document.tools if t["name"] == "check_stock")
    sku = check_stock["inputSchema"]["properties"]["sku"]
    assert "$ref" not in sku
    assert sku["pattern"] == "^[A-Z]{3}-[0-9]{4}$"
    # The definition map itself is authoring sugar and does not reach the surface.
    assert "$defs" not in check_stock["inputSchema"]


def test_an_inlined_manifest_matches_a_factored_one() -> None:
    """The whole point of Rule 2: factoring shared schemas out changes no fact."""
    factored = manifest_surface(parse_mcp_manifest(_COMPOSITION))
    raw = json.loads(_COMPOSITION)
    defs = raw.pop("$defs")

    def inline(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                return inline(defs[ref[len("#/$defs/") :]])
            return {key: inline(value) for key, value in node.items()}
        if isinstance(node, list):
            return [inline(item) for item in node]
        return node

    hand_inlined = manifest_surface(parse_mcp_manifest(json.dumps(inline(raw))))
    assert factored.fingerprint() == hand_inlined.fingerprint()


def test_cross_file_refs_resolve_from_the_fileset() -> None:
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((_EXAMPLES / "06-split-set").iterdir())
    }
    document = parse_mcp_manifest_fileset(members, root="manifest.json")
    get_invoice = next(t for t in document.tools if t["name"] == "get_invoice")
    assert get_invoice["inputSchema"]["properties"]["invoiceId"]["pattern"] == "^INV-[0-9]{8}$"
    assert get_invoice["outputSchema"]["required"] == [
        "invoiceId",
        "issuedOn",
        "currency",
        "total",
    ]


def test_a_fileset_root_outside_the_members_is_rejected() -> None:
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest_fileset({"a.json": _MINIMAL}, root="missing.json")
    assert exc.value.code == "INPUT_MALFORMED"


def test_an_undefined_shared_reference_is_reported_against_the_reference() -> None:
    raw = json.loads(_COMPOSITION)
    del raw["$defs"]["Sku"]
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(json.dumps(raw))
    assert exc.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "#/$defs/Sku" in str(exc.value)


def test_a_recursive_shared_reference_is_rejected_rather_than_expanded() -> None:
    raw = json.loads(_MINIMAL)
    raw["$defs"] = {"Node": {"type": "object", "properties": {"next": {"$ref": "#/$defs/Node"}}}}
    raw["tools"][0]["inputSchema"] = {"$ref": "#/$defs/Node"}
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(json.dumps(raw))
    assert exc.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_deeply_chained_references_hit_the_depth_ceiling() -> None:
    depth = MAX_REF_DEPTH + 5
    raw = json.loads(_MINIMAL)
    raw["$defs"] = {f"D{i}": {"$ref": f"#/$defs/D{i + 1}"} for i in range(depth)}
    raw["$defs"][f"D{depth}"] = {"type": "object"}
    raw["tools"][0]["inputSchema"] = {"$ref": "#/$defs/D0"}
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(json.dumps(raw))
    assert exc.value.code == "INPUT_REF_LIMIT"


def test_an_absolute_url_reference_is_not_fetched() -> None:
    """A parser that resolved a URL would be a way to make Apiome reach out."""
    raw = json.loads(_MINIMAL)
    raw["tools"][0]["inputSchema"] = {"$ref": "https://example.com/schema.json#/Thing"}
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(json.dumps(raw))
    assert exc.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_sibling_keys_beside_a_ref_override_the_resolved_definition() -> None:
    raw = json.loads(_MINIMAL)
    raw["$defs"] = {"Text": {"type": "string", "maxLength": 10}}
    raw["tools"][0]["inputSchema"] = {
        "type": "object",
        "properties": {"message": {"$ref": "#/$defs/Text", "maxLength": 99}},
    }
    document = parse_mcp_manifest(json.dumps(raw))
    message = document.tools[0]["inputSchema"]["properties"]["message"]
    assert message == {"type": "string", "maxLength": 99}


# ---------------------------------------------------------------------------
# Failure classification (matching the corpus manifest's declared codes)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fixture", "code"),
    [
        ("negative/01-syntactic-trailing-comma.json", "INPUT_MALFORMED"),
        ("negative/02-semantic-tool-without-input-schema.json", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-tool.json", "INPUT_TRUNCATED"),
        ("negative/04-wrong-format-openapi.yaml", "FORMAT_MISMATCH"),
        ("negative/05-encoding-utf16.json", "INPUT_ENCODING_INVALID"),
    ],
)
def test_negative_corpus_entries_carry_their_declared_code(fixture: str, code: str) -> None:
    text = (_EXAMPLES / fixture).read_bytes().decode("utf-8", errors="replace")
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(text, source_label=fixture)
    assert exc.value.code == code


def test_a_trailing_comma_is_malformed_not_accepted_as_yaml() -> None:
    """The reason this parser has no YAML fallback: YAML accepts this document."""
    import yaml

    text = (_EXAMPLES / "negative/01-syntactic-trailing-comma.json").read_text(encoding="utf-8")
    assert isinstance(yaml.safe_load(text), dict)  # YAML would have taken it
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(text)
    assert exc.value.code == "INPUT_MALFORMED"


def test_an_empty_document_is_empty_not_malformed() -> None:
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest("   \n  ")
    assert exc.value.code == "INPUT_EMPTY"


def test_a_manifest_with_no_capabilities_at_all_is_semantically_invalid() -> None:
    empty = json.dumps({"mcpVersion": "2025-06-18", "server": {"name": "x"}, "tools": []})
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(empty)
    assert exc.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_capability_entry_without_a_name_is_rejected() -> None:
    raw = json.loads(_MINIMAL)
    del raw["tools"][0]["name"]
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(json.dumps(raw))
    assert exc.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_capability_array_of_the_wrong_shape_is_rejected() -> None:
    raw = json.loads(_MINIMAL)
    raw["resources"] = {"not": "an array"}
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest(json.dumps(raw))
    assert exc.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_json_array_document_is_a_format_mismatch() -> None:
    with pytest.raises(McpManifestParseError) as exc:
        parse_mcp_manifest("[]")
    assert exc.value.code == "FORMAT_MISMATCH"


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


def test_http_transport_yields_its_url_as_the_endpoint_target() -> None:
    document = parse_mcp_manifest(_TYPICAL)
    assert document.transport.kind == "streamable_http"
    assert document.transport.endpoint_target() == "https://mcp.example.com/tickets"


def test_stdio_transport_yields_its_command_line() -> None:
    document = parse_mcp_manifest(_STRESS)
    assert document.transport.kind == "stdio"
    assert document.transport.endpoint_target() == "acme-lab-mcp --profile readonly"


def test_a_manifest_with_no_transport_names_no_target() -> None:
    document = parse_mcp_manifest(_MINIMAL)
    assert document.transport.kind is None
    assert document.transport.endpoint_target() is None


# ---------------------------------------------------------------------------
# Incidentals
# ---------------------------------------------------------------------------


def test_item_count_totals_all_four_kinds() -> None:
    document = parse_mcp_manifest(_TYPICAL)
    assert document.item_count() == 6


def test_title_falls_back_through_title_name_then_label() -> None:
    assert parse_mcp_manifest(_TYPICAL).title == "Acme Support Tickets"
    assert parse_mcp_manifest(_MINIMAL).title == "echo"
    raw = json.loads(_MINIMAL)
    raw.pop("server")
    assert parse_mcp_manifest(json.dumps(raw), source_label="dir/acme.mcp.json").title == "acme"


def test_raw_round_trips_for_the_fidelity_bag() -> None:
    document = parse_mcp_manifest(_TYPICAL)
    assert dumps_manifest_for_raw(document) == json.loads(_TYPICAL)
