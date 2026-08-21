"""Fidelity machinery for the six FMT-EPIC-2 targets — FMT-2.7 (#5425).

FMT-2.1…2.6 landed six emitters — Kubernetes CRD, Kong declarative config, Gateway API
``HTTPRoute``, HTTP request file, LLM tool array and WIT. This suite proves each of them
now carries the same fidelity machinery every other target has, in the ticket's
acceptance-criteria order:

#. **A capability profile that drives an accurate badge before a job runs.** Every one of
   the six declares all six axes explicitly, and the profile a target card reads is the
   one the emitter declares.
#. **A fidelity rule pack enumerating what the target cannot carry.** Each of the six
   declares a pack, and the pack names the constructs the six boolean axes cannot express
   on their own — a structural schema's refusal of ``oneOf``, a routing surface's lack of
   a schema section, a request file's missing title, a tool array's missing envelope.
#. **A post-emit validation gate wired into the export pipeline.** Every one of the six
   resolves a validator through :func:`app.export_validation.validate_emitted_artifact`,
   a real emitted artifact passes it, and a deliberately broken one is caught.
#. **Round-trip matrix rows that pass, or carry a reasoned xfail.** The four native
   round-trips that can close the loop are asserted ``pass``; the two that provably cannot
   — because their formats have no field for the surface's own name — carry a reasoned
   xfail rather than an auto-generated diff dump.
#. **Family placement.** Asserted on the UI side (``apiome-ui/tests/export-studio-view``);
   what is pinned here is the paradigm each descriptor sends, which is what the UI groups
   on.
#. **Public/browse parity.** The anonymous browse export surface reports the same tier,
   preserved-% and advisory for the six as the authenticated surface, because both read
   the one fidelity envelope builder — a regression guard against a gate being added to
   one surface only.

The SPI extension the packs needed — :meth:`app.fidelity_rulepack.FidelityRulePack.root_verdicts`,
the artifact-root hook — is exercised in ``test_fidelity_rulepack.py`` alongside the rest
of the contract.
"""

from __future__ import annotations

import json
from typing import Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    CapabilityProfile,
    EmitResult,
    EmittedFile,
    get_emitter,
    load_builtin_emitters,
)
from app.export_fidelity import build_export_fidelity, build_target_fidelity
from app.export_source import ExportSource
from app.export_validation import validate_emitted_artifact
from app.fidelity_rulepack import ROOT_CONSTRUCT_KEY, CapabilityRulePack
from app.gateway_api_emitter import GatewayApiFidelityRulePack
from app.http_file_emitter import HttpFileFidelityRulePack
from app.k8s_crd_emitter import K8sCrdFidelityRulePack
from app.kong_emitter import KongFidelityRulePack
from app.llm_tools_emitter import LlmToolsFidelityRulePack, detect_tool_mode
from app.lossiness import LossinessKind
from app.main import app
from app.wit_emitter import WitFidelityRulePack

load_builtin_emitters()

client = TestClient(app)

#: The six targets FMT-EPIC-2 shipped, as ``format`` keys. Every assertion below is
#: parametrised over this tuple, so a seventh target added to the epic cannot be given a
#: profile and quietly skipped for a pack or a gate.
FMT_EPIC2_TARGETS = ("k8s-crd", "kong", "gateway-api", "http-file", "llm-tools", "wit")

#: The capability profile each target declares, as the ticket's six axes. Pinned rather
#: than derived: this table is what an Export Studio card's badge is computed from before
#: any job runs, so a change to it is a change to what a user is promised.
EXPECTED_PROFILES: Dict[str, CapabilityProfile] = {
    # A resource definition: schema only. `oneOf` may not carry a `type`, so no unions.
    "k8s-crd": CapabilityProfile(
        operations=False,
        events=False,
        unions=False,
        nullability=True,
        constraints=True,
        field_identity=False,
    ),
    # A routing surface: operations only, and nothing about the payloads they exchange.
    "kong": CapabilityProfile(
        operations=True,
        events=False,
        unions=False,
        nullability=False,
        constraints=False,
        field_identity=False,
    ),
    "gateway-api": CapabilityProfile(
        operations=True,
        events=False,
        unions=False,
        nullability=False,
        constraints=False,
        field_identity=False,
    ),
    # A call surface with no schema vocabulary at all.
    "http-file": CapabilityProfile(
        operations=True,
        events=False,
        unions=False,
        nullability=False,
        constraints=False,
        field_identity=False,
    ),
    # A call surface *with* arguments: its argument schemas are JSON Schema.
    "llm-tools": CapabilityProfile(
        operations=True,
        events=False,
        unions=True,
        nullability=True,
        constraints=True,
        field_identity=False,
    ),
    # An interface description: types and functions, no events and no validation facets.
    "wit": CapabilityProfile(
        operations=True,
        events=False,
        unions=True,
        nullability=True,
        constraints=False,
        field_identity=False,
    ),
}

#: The rule-pack class each target declares.
EXPECTED_PACKS = {
    "k8s-crd": K8sCrdFidelityRulePack,
    "kong": KongFidelityRulePack,
    "gateway-api": GatewayApiFidelityRulePack,
    "http-file": HttpFileFidelityRulePack,
    "llm-tools": LlmToolsFidelityRulePack,
    "wit": WitFidelityRulePack,
}

#: The paradigm each target's card is grouped under in the Studio's family grid.
EXPECTED_PARADIGMS = {
    "k8s-crd": ApiParadigm.DATA_SCHEMA,
    "kong": ApiParadigm.REST,
    "gateway-api": ApiParadigm.REST,
    "http-file": ApiParadigm.REST,
    "llm-tools": ApiParadigm.AGENT,
    "wit": ApiParadigm.RPC,
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _rich_api() -> CanonicalApi:
    """A model exercising every axis: an operation, a channel, a union and a record.

    Deliberately over-provided relative to any one target, so each pack has something to
    say about every construct rather than being asked only about the ones it carries.
    """
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Widget.id",
                name="id",
                type=TypeRef(name="string", nullable=False),
                constraints=Constraints(min_length=1),
            ),
            CanonicalField(
                key="Widget.tags",
                name="tags",
                type=TypeRef(name="string"),
                constraints=Constraints(unique_items=True, format="widget-urn"),
            ),
        ],
    )
    shape = Type(
        key="Shape",
        name="Shape",
        kind=TypeKind.UNION,
        union_members=["Widget"],
    )
    op = Operation(
        key="GET /widgets",
        name="listWidgets",
        kind=OperationKind.QUERY,
        http_method="GET",
        http_path="/widgets",
        messages=[Message(key="GET /widgets#response.200", role=MessageRole.RESPONSE)],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        title="Widget API",
        identity=ApiIdentity(name="widgets"),
        servers=[Server(url="https://api.example.com")],
        services=[Service(key="widgets", name="widgets", operations=[op])],
        types=[widget, shape],
        channels=[Channel(key="widget/created", address="widget/created")],
    )


def _anonymous_api() -> CanonicalApi:
    """The same model with no title and no identity name — nothing for a root to lose."""
    api = _rich_api()
    return api.model_copy(update={"title": None, "identity": ApiIdentity(name="")})


def _report_for(target: str, api: CanonicalApi):
    """The prediction report for exporting ``api`` through ``target``'s rule pack."""
    from app.fidelity_engine import compute_lossiness_for_emitter

    return compute_lossiness_for_emitter(api, get_emitter(target))


def _items_for(target: str, api: CanonicalApi, construct_key: str) -> List:
    """Every report item recorded against one construct key."""
    return [
        item for item in _report_for(target, api).items if item.construct_key == construct_key
    ]


# ---------------------------------------------------------------------------
# AC 1 — an accurate badge before any job runs
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_every_target_declares_the_six_capability_axes(target: str) -> None:
    """The profile a card's badge reads is the reviewed one, axis by axis."""
    assert get_emitter(target).capability_profile() == EXPECTED_PROFILES[target]


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_target_badge_is_computable_without_emitting(target: str) -> None:
    """A tier + preserved-% is available from the model alone — no artifact is produced."""
    emitter = get_emitter(target)
    with patch.object(emitter, "emit", side_effect=AssertionError("emit must not run")):
        summary = build_target_fidelity(_rich_api(), emitter)
    assert summary.tier.value in {"lossless", "lossy", "types-only"}
    assert 0 <= summary.preserved_percent <= 100
    assert summary.total == (
        summary.preserved + summary.dropped + summary.approximated + summary.synthesized
    )


def test_the_schema_only_target_badges_types_only_and_the_routing_ones_do_not() -> None:
    """The tier separates a schema-only destination from an operation-bearing one.

    A CRD carries no operations at all, so an operation-bearing source badges
    ``types-only``; Kong carries operations and loses the schemas, which is ``lossy``.
    The distinction is the whole point of the badge, so it is asserted rather than assumed.
    """
    api = _rich_api()
    assert build_target_fidelity(api, get_emitter("k8s-crd")).tier.value == "types-only"
    assert build_target_fidelity(api, get_emitter("kong")).tier.value == "lossy"


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_descriptor_paradigm_places_the_card_in_its_family(target: str) -> None:
    """The paradigm the Studio's family grid groups on is the reviewed one."""
    assert get_emitter(target).descriptor().paradigm is EXPECTED_PARADIGMS[target]


# ---------------------------------------------------------------------------
# AC 2a — a fidelity rule pack per target
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_every_target_declares_a_fidelity_rule_pack(target: str) -> None:
    """No FMT-EPIC-2 target falls back to the profile-derived default."""
    pack = get_emitter(target).fidelity_rule_pack()
    assert pack is EXPECTED_PACKS[target]
    assert pack is not CapabilityRulePack
    assert issubclass(pack, CapabilityRulePack)


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_every_pack_drops_the_event_channel_none_of_them_can_carry(target: str) -> None:
    """``events=False`` on all six, and each says so in its own words for a real channel."""
    items = _items_for(target, _rich_api(), "widget/created")
    assert [item.kind for item in items] == [LossinessKind.DROP]


@pytest.mark.parametrize("target", ("kong", "gateway-api"))
def test_a_routing_surface_drops_every_named_type(target: str) -> None:
    """A config that says where a request goes has no schema section to declare a type in.

    The profile-derived default would call a record ``OK`` on the strength of
    ``operations=True``; that is an over-claim, and the pack is what corrects it.
    """
    api = _rich_api()
    assert [item.kind for item in _items_for(target, api, "Widget")] == [LossinessKind.DROP]
    # …and it does not then restate the same loss once per field.
    assert _items_for(target, api, "Widget.id") == []


def test_a_request_file_carries_a_type_only_as_an_example_body() -> None:
    """A request file has no schema vocabulary, so the type is approximated, not declared."""
    items = _items_for("http-file", _rich_api(), "Widget")
    assert [item.kind for item in items] == [LossinessKind.APPROX]
    assert "example body" in items[0].message


def test_a_structural_schema_cannot_express_a_union() -> None:
    """Kubernetes' ``oneOf`` may not carry a ``type``, so a union drops to a free-form node."""
    items = _items_for("k8s-crd", _rich_api(), "Shape")
    assert [item.kind for item in items] == [LossinessKind.DROP]
    assert items[0].target_mapping == "union → free-form node"


def test_the_crd_pack_names_the_two_validation_facets_kubernetes_refuses() -> None:
    """``constraints=True`` is true only of the facets the API server actually knows.

    ``uniqueItems: true`` is rejected outright and an unknown ``format`` validates nothing,
    so both are reported against the field that carries them — before the emit drops the
    keyword rather than after.
    """
    messages = [item.message for item in _items_for("k8s-crd", _rich_api(), "Widget.tags")]
    assert any("uniqueItems" in message for message in messages)
    assert any("widget-urn" in message for message in messages)


def test_the_crd_pack_leaves_a_facet_kubernetes_does_know_alone() -> None:
    """A ``minLength`` survives, so it is not reported as a loss."""
    assert _items_for("k8s-crd", _rich_api(), "Widget.id") == []


@pytest.mark.parametrize("target", ("kong", "gateway-api", "http-file", "llm-tools"))
def test_the_envelope_less_targets_declare_the_artifact_title_before_the_emit(
    target: str,
) -> None:
    """None of these four file formats has a title field, and each says so up front.

    The loss is recorded against the artifact root (:data:`ROOT_CONSTRUCT_KEY`), which is
    the canonical key the root entity carries in a diff — so the prediction reconciles
    against the ``changed root`` a re-import really produces.
    """
    items = _items_for(target, _rich_api(), ROOT_CONSTRUCT_KEY)
    assert any(item.kind is LossinessKind.APPROX for item in items)
    assert any("file" in item.message for item in items)


@pytest.mark.parametrize("target", ("kong", "gateway-api", "http-file", "llm-tools"))
def test_no_title_loss_is_claimed_when_there_is_no_title_to_lose(target: str) -> None:
    """A model with neither a title nor an identity name loses no *title* at the root.

    An unconditional root loss would be a lie for a model that never had a title, and it
    would drag every such export's preserved-% down for nothing. (The tool array's
    separate ``servers`` verdict is gated independently and still fires here, which is
    why this asserts on the title verdict rather than on an empty root.)
    """
    titles = [
        item
        for item in _items_for(target, _anonymous_api(), ROOT_CONSTRUCT_KEY)
        if item.kind is LossinessKind.APPROX
    ]
    assert titles == []


def test_the_tool_array_reports_the_servers_it_has_no_field_for() -> None:
    """A tool entry names a callable and its arguments, never the transport."""
    items = _items_for("llm-tools", _rich_api(), ROOT_CONSTRUCT_KEY)
    dropped = [item for item in items if item.kind is LossinessKind.DROP]
    assert len(dropped) == 1
    assert "server" in dropped[0].message


@pytest.mark.parametrize("target", ("k8s-crd", "wit"))
def test_a_target_whose_format_names_itself_declares_no_root_loss(target: str) -> None:
    """A CRD's ``metadata`` and a WIT ``package`` declaration both survive a round trip.

    These two are the counter-example that keeps the root hook honest: it exists for the
    formats that genuinely have nowhere to put the artifact's identity, not as a blanket
    apology every target makes.
    """
    assert _items_for(target, _rich_api(), ROOT_CONSTRUCT_KEY) == []


# ---------------------------------------------------------------------------
# AC 2b — the post-emit validation gate
# ---------------------------------------------------------------------------


def _emitted(target: str) -> EmitResult:
    """Emit a model this target accepts, so the gate has a real artifact to check."""
    from corpus_roundtrip import representatives_by_format

    from app.import_source import load_builtin_import_sources

    load_builtin_import_sources()
    entry = representatives_by_format().get(target)
    assert entry is not None, f"no corpus representative for {target!r}"
    from corpus_roundtrip import _import_entry

    return get_emitter(target)().emit(_import_entry(entry))


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
@pytest.mark.asyncio
async def test_a_real_emitted_artifact_passes_its_gate(target: str) -> None:
    """Valid output passes: every one of the six resolves a validator and clears it."""
    api = _rich_api()
    verdict = await validate_emitted_artifact(target, _emitted(target), api=api)
    assert verdict.applicable, verdict.detail
    assert verdict.validated, verdict.detail
    assert verdict.valid, verdict.errors
    assert not verdict.failed


#: A deliberately broken artifact per target, paired with the emitted path its emitter
#: uses. Each is *syntactically* plausible for its format and fails the rule the gate is
#: there to catch, so a gate that merely checked "is this text" would still pass it.
BROKEN_ARTIFACTS: Dict[str, tuple[str, str]] = {
    # A CRD whose metadata.name is not `<plural>.<group>` — rejected on apply.
    "k8s-crd": (
        "widgets.crd.yaml",
        "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n"
        "metadata:\n  name: wrong-name\nspec:\n  group: example.com\n  scope: Namespaced\n"
        "  names:\n    kind: Widget\n    plural: widgets\n    singular: widget\n"
        "  versions:\n    - name: v1\n      served: true\n      storage: true\n"
        "      schema:\n        openAPIV3Schema:\n          type: object\n",
    ),
    # A route that declares no paths, hosts, methods, headers or snis matches nothing.
    "kong": (
        "kong.yaml",
        "_format_version: '3.0'\nservices:\n  - name: widgets\n"
        "    url: https://api.example.com\n    routes:\n      - name: nothing\n",
    ),
    # An HTTPRoute with a method outside the Gateway API's vocabulary.
    "gateway-api": (
        "httproute.yaml",
        "apiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\n"
        "metadata:\n  name: widgets\nspec:\n  rules:\n    - matches:\n"
        "        - method: FETCH\n          path:\n            type: PathPrefix\n"
        "            value: /widgets\n",
    ),
    # Prose, not a request file: no request line anywhere in it.
    "http-file": ("requests.http", "# just a comment\n# and another\n"),
    # A tool whose argument schema is not an object schema.
    "llm-tools": (
        "tools.json",
        json.dumps([{"name": "list_widgets", "description": "d", "input_schema": []}]),
    ),
    # A WIT package with an unterminated interface body.
    "wit": ("api.wit", "package apiome:widgets@1.0.0;\ninterface widgets {\n"),
}


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
@pytest.mark.asyncio
async def test_deliberately_broken_output_is_caught(target: str) -> None:
    """Broken output fails the gate, with the parser's own detail attached."""
    path, content = BROKEN_ARTIFACTS[target]
    result = EmitResult(files=[EmittedFile(path=path, content=content)])
    verdict = await validate_emitted_artifact(target, result, api=_rich_api())
    assert verdict.failed, f"{target}: broken artifact was accepted"
    assert verdict.errors
    assert verdict.findings[0].file == path


@pytest.mark.asyncio
async def test_the_request_file_curl_script_is_not_applicable_rather_than_a_failure() -> None:
    """The ``curl`` output mode is a shell script, and no importer reads a script.

    Reporting it *not applicable* is the honest verdict: the artifact was never proven
    invalid, so a legal export must not be failed on it.
    """
    emitter_cls = get_emitter("http-file")
    api = _rich_api()
    result = emitter_cls().emit(api, opts=emitter_cls.options_model(output="curl"))
    verdict = await validate_emitted_artifact("http-file", result, api=api)
    assert not verdict.applicable
    assert not verdict.failed
    assert "script" in (verdict.detail or "")


def test_the_tool_mode_is_detected_from_the_artifact_not_the_emit_options() -> None:
    """Each dialect is validated against its own provider rules, whoever wrote it."""
    assert detect_tool_mode([{"type": "function", "function": {"name": "a"}}]) == "openai"
    assert detect_tool_mode([{"name": "a", "input_schema": {"type": "object"}}]) == "anthropic"
    assert detect_tool_mode([{"name": "a", "parameters": {"type": "object"}}]) == "bare"
    # A wrapper object and an unclassifiable document both resolve without raising.
    assert detect_tool_mode({"tools": [{"name": "a", "parameters": {"type": "object"}}]}) == "bare"
    assert detect_tool_mode([]) == "bare"


# ---------------------------------------------------------------------------
# AC 3 — round-trip matrix rows
# ---------------------------------------------------------------------------

#: The native round-trips that close the loop with a zero unexplained diff. Their cells
#: must be ``pass`` in the published matrix — an entry appearing in the xfail map for one
#: of these is a regression, which ``test_roundtrip_matrix`` catches as "marked xfail but
#: passed".
PASSING_NATIVE_ROUNDTRIPS = ("k8s-crd", "kong", "gateway-api", "wit")

#: The two whose formats have no field for the surface's own name, so a re-import must
#: name the model after the file it read: the source's service disappears and one named
#: for the emitted file appears. That is not something a rule pack can predict — the new
#: name is chosen by the *re-import*, not by the export — so these carry a reasoned xfail.
REASONED_XFAIL_ROUNDTRIPS = ("http-file", "llm-tools")


@pytest.mark.parametrize("target", PASSING_NATIVE_ROUNDTRIPS)
def test_the_native_round_trip_passes_in_the_published_matrix(target: str) -> None:
    """``<format> → <format>`` reconciles with no unexplained diff and no over-claim."""
    from corpus_roundtrip import ARTIFACT_PATH

    matrix = json.loads(ARTIFACT_PATH.read_text())
    cell = next(
        c
        for c in matrix["cells"]
        if c["source_format"] == target and c["emit_key"] == target
    )
    assert cell["status"] == "pass", cell.get("reason")


@pytest.mark.parametrize("target", REASONED_XFAIL_ROUNDTRIPS)
def test_the_unclosable_native_round_trip_carries_a_reasoned_xfail(target: str) -> None:
    """Its xfail explains *why* the loop cannot close, rather than dumping the diff."""
    from corpus_roundtrip import KNOWN_ROUNDTRIP_XFAILS

    reason = KNOWN_ROUNDTRIP_XFAILS.get((target, target))
    assert reason is not None
    assert not reason.startswith("unexplained:"), "an auto-generated dump is not a reason"
    assert not reason.startswith("Empirical canonical_diff")
    assert "re-import" in reason


# ---------------------------------------------------------------------------
# AC 4 — public/browse export honours the same gates
# ---------------------------------------------------------------------------

_PUBLIC_BASE = "/v1/browse/tenants/acme/projects/widgets/versions/1.0.0/export"
_PUBLIC_LOADER = "app.browse_export_routes.load_public_export_source"
_PRIVATE_LOADER = "app.export_routes.load_export_source"
_MOCK_AUTH = {"tenant_id": "tenant-1", "tenant_slug": "acme"}


def _export_source() -> ExportSource:
    """The same loaded source for both surfaces, so only the surface differs."""
    return ExportSource(
        api=_rich_api(),
        artifact_id="artifact-1",
        version_record_id="rev-uuid-1",
        version_label="1.0.0",
    )


def _public_targets() -> Dict[str, dict]:
    with patch(_PUBLIC_LOADER, return_value=_export_source()):
        response = client.get(f"{_PUBLIC_BASE}/targets")
    assert response.status_code == 200
    return {entry["descriptor"]["key"]: entry for entry in response.json()["targets"]}


def _authenticated_targets() -> Dict[str, dict]:
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    try:
        with patch(_PRIVATE_LOADER, return_value=_export_source()):
            response = client.get(
                "/v1/export/acme/targets", params={"artifact": "artifact-1"}
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    return {entry["descriptor"]["key"]: entry for entry in response.json()["targets"]}


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_public_and_authenticated_target_cards_agree(target: str) -> None:
    """An anonymous visitor sees the same badge as a signed-in one, for the same source."""
    public = _public_targets()
    private = _authenticated_targets()
    assert target in public, "the target is missing from the public grid"
    assert public[target]["fidelity"] == private[target]["fidelity"]
    assert public[target]["capability_profile"] == private[target]["capability_profile"]


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_public_preview_matches_the_authenticated_envelope(target: str) -> None:
    """The full preview envelope — report, advisory and projection — is byte-identical.

    Both surfaces call :func:`app.export_fidelity.build_export_fidelity`, so this is a
    guard against a future gate being wired into one route and not the other rather than a
    claim about two separate implementations.
    """
    with patch(_PUBLIC_LOADER, return_value=_export_source()):
        public = client.post(f"{_PUBLIC_BASE}/preview", json={"target": target})
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    try:
        with patch(_PRIVATE_LOADER, return_value=_export_source()):
            private = client.post(
                "/v1/export/acme/preview",
                json={"artifact": "artifact-1", "target": target},
            )
    finally:
        app.dependency_overrides.clear()

    assert public.status_code == 200, public.text
    assert private.status_code == 200, private.text
    assert public.json()["fidelity"] == private.json()["fidelity"]


@pytest.mark.parametrize("target", FMT_EPIC2_TARGETS)
def test_the_public_envelope_carries_the_pack_s_verdicts(target: str) -> None:
    """The public advisory is computed from the rule pack, not from the bare profile."""
    with patch(_PUBLIC_LOADER, return_value=_export_source()):
        response = client.post(f"{_PUBLIC_BASE}/preview", json={"target": target})
    assert response.status_code == 200
    envelope = response.json()["fidelity"]
    expected = build_export_fidelity(_rich_api(), get_emitter(target))
    assert envelope["report"] == expected.report.model_dump(mode="json")
