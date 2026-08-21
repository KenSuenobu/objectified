"""Unit tests for the fidelity rule-pack SPI — MFX-2.3 (#3840).

Pins the ticket's acceptance criteria and the SPI's contract:

* the **SPI drives the walk** — a :class:`FidelityRulePack` visits every construct,
  keys each verdict by the construct's canonical key, and assembles a sorted report;
* the **reference default** (:class:`CapabilityRulePack`) derives every verdict from
  the target's :class:`CapabilityProfile` (the six axes: operations, events, unions,
  nullability, constraints, field identity);
* the **engine consumes packs** — an emitter's declared pack
  (:meth:`Emitter.fidelity_rule_pack`) is honoured, and a custom pack refines a
  verdict the profile alone could not express;
* the **reference OpenAPI pack** upgrades a source field number from ``DROP`` to a
  lossless ``APPROX`` (preserved as an ``x-field-number`` extension), and (MFX-9.2,
  #3867) reports the event/RPC losses OpenAPI's flat ``events``/``operations`` axes
  hide: an event channel and a pub/sub or RPC-streaming operation are documented-only
  ``APPROX``\\es, a GraphQL subscription is a ``DROP``;
* a pack is **pure and deterministic** — same inputs yield an equal, byte-identically
  serialized report, and evaluation never mutates the source model.
"""

from copy import deepcopy
from typing import List

import pytest

from app.avro_emitter import AvroEmitter, AvroFidelityRulePack
from app.asyncapi_emitter import AsyncApiEmitter, AsyncApiFidelityRulePack
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
    Parameter,
    ParameterLocation,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import CapabilityProfile, Emitter
from app.export_fidelity import ExportFidelityTier, build_export_fidelity
from app.fidelity_engine import compute_lossiness, compute_lossiness_for_emitter
from app.fidelity_rulepack import (
    ROOT_CONSTRUCT_KEY,
    CapabilityRulePack,
    FidelityRulePack,
    FidelityVerdict,
)
from app.lossiness import LossinessKind, LossinessReport, LossinessSeverity
from app.graphql_emitter import GraphQlEmitter, GraphQlFidelityRulePack
from app.openapi_emitter import X_FIELD_NUMBER, OpenApiEmitter, OpenApiFidelityRulePack
from app.proto_emitter import ProtoEmitter, ProtoFidelityRulePack
from app.sample_emitter import SampleEmitter

# ---------------------------------------------------------------------------
# Profiles + model helpers (mirror the engine tests so behaviour lines up)
# ---------------------------------------------------------------------------

OPENAPI_PROFILE = CapabilityProfile(
    operations=True,
    events=True,
    unions=True,
    nullability=True,
    constraints=True,
    field_identity=False,
)

PROTOBUF_PROFILE = CapabilityProfile(
    operations=False,
    events=False,
    unions=False,
    nullability=False,
    constraints=False,
    field_identity=True,
)


def _rich_api() -> CanonicalApi:
    """A REST source touching every construct class the SPI reports on."""
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
    )
    service = Service(key="Users", name="Users", operations=[get_user])
    channel = Channel(key="user/signedup", address="user/signedup", protocol="kafka")
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="User.id", name="id", type=TypeRef(name="string", nullable=False)
            ),
            CanonicalField(
                key="User.age",
                name="age",
                type=TypeRef(name="integer", nullable=True),
                constraints=Constraints(minimum=0, maximum=120),
            ),
        ],
    )
    contact = Type(
        key="Contact", name="Contact", kind=TypeKind.UNION, union_members=["User", "Org"]
    )
    money = Type(
        key="Money",
        name="Money",
        kind=TypeKind.SCALAR,
        constraints=Constraints(pattern=r"^\d+\.\d{2}$"),
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Users API"),
        services=[service],
        channels=[channel],
        types=[user, contact, money],
    )


def _numbered_api() -> CanonicalApi:
    """A model whose one record field carries a source field number."""
    typed = Type(
        key="Msg",
        name="Msg",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Msg.a",
                name="a",
                type=TypeRef(name="string", nullable=True),
                field_number=7,
            )
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="grpc",
        identity=ApiIdentity(name="Svc"),
        types=[typed],
    )


def _items_for(report: LossinessReport, construct: str) -> list:
    return [item for item in report.items if item.construct_key == construct]


# ---------------------------------------------------------------------------
# FidelityVerdict value type
# ---------------------------------------------------------------------------


def test_verdict_constructors_name_the_four_outcomes():
    """The four classmethods set the expected kind and default severity."""
    ok = FidelityVerdict.ok("carried")
    assert ok.kind is LossinessKind.OK and ok.severity is LossinessSeverity.INFO

    drop = FidelityVerdict.drop("gone")
    assert drop.kind is LossinessKind.DROP
    assert drop.severity is LossinessSeverity.CRITICAL  # default for a drop

    approx = FidelityVerdict.approx("demoted")
    assert approx.kind is LossinessKind.APPROX
    assert approx.severity is LossinessSeverity.WARN  # default for approx

    synth = FidelityVerdict.synth("invented")
    assert synth.kind is LossinessKind.SYNTH
    assert synth.severity is LossinessSeverity.WARN  # default for synth


def test_verdict_severity_and_mapping_overridable():
    """A caller can override the default severity and attach a target mapping."""
    v = FidelityVerdict.drop(
        "cosmetic", severity=LossinessSeverity.INFO, target_mapping="x → y"
    )
    assert v.severity is LossinessSeverity.INFO
    assert v.target_mapping == "x → y"


def test_verdict_is_frozen():
    """Verdicts are immutable so a shared instance cannot be mutated in place."""
    v = FidelityVerdict.ok("carried")
    with pytest.raises(Exception):
        v.message = "changed"


# ---------------------------------------------------------------------------
# The SPI drive loop keys verdicts by construct
# ---------------------------------------------------------------------------


class _StubPack(FidelityRulePack):
    """A minimal pack whose verdicts are fixed, to exercise the drive loop alone."""

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        return FidelityVerdict.drop("op dropped")

    def channel_verdict(self, channel: Channel) -> FidelityVerdict:
        return FidelityVerdict.ok("channel kept")

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        return FidelityVerdict.ok("type kept")

    def field_verdicts(self, field: CanonicalField) -> List[FidelityVerdict]:
        # Two independent losses on every field, to prove lists are supported.
        return [
            FidelityVerdict.approx("aspect one"),
            FidelityVerdict.synth("aspect two"),
        ]


def test_drive_loop_keys_each_verdict_by_construct():
    """`evaluate` records one item per verdict, keyed by the construct's canonical key."""
    report = _StubPack(PROTOBUF_PROFILE).evaluate(_rich_api())

    # Operation, channel, and each named type each produced their single verdict.
    assert _items_for(report, "GET /users/{id}")[0].kind is LossinessKind.DROP
    assert _items_for(report, "user/signedup")[0].kind is LossinessKind.OK
    assert _items_for(report, "Contact")[0].kind is LossinessKind.OK
    # Each of the RECORD's two fields produced two verdicts, keyed by the field key.
    for field_key in ("User.id", "User.age"):
        kinds = sorted(i.kind.value for i in _items_for(report, field_key))
        assert kinds == ["approx", "synth"]
    # A non-record type (union/scalar) has no fields walked.
    assert len(_items_for(report, "Money")) == 1


def test_abstract_pack_cannot_be_instantiated():
    """`FidelityRulePack` is abstract — a concrete pack must implement the hooks."""
    with pytest.raises(TypeError):
        FidelityRulePack(PROTOBUF_PROFILE)  # type: ignore[abstract]


# ---------------------------------------------------------------------------
# The artifact-root hook — FMT-2.7 (#5425)
# ---------------------------------------------------------------------------


def test_the_root_hook_says_nothing_by_default():
    """Most destinations have a document envelope of their own, so silence is the default.

    An unconditional root verdict would make every target claim a loss it does not incur
    and would shift every preserved-% in the product; the hook exists for the formats that
    genuinely have nowhere to put the artifact's identity.
    """
    assert _StubPack(PROTOBUF_PROFILE).root_verdicts(_rich_api()) == []
    assert CapabilityRulePack(PROTOBUF_PROFILE).root_verdicts(_rich_api()) == []
    assert _items_for(_StubPack(PROTOBUF_PROFILE).evaluate(_rich_api()), ROOT_CONSTRUCT_KEY) == []


class _RootPack(_StubPack):
    """A pack that declares two independent root losses, to prove the list is walked."""

    def root_verdicts(self, api: CanonicalApi) -> List[FidelityVerdict]:
        return [
            FidelityVerdict.approx("title has no field"),
            FidelityVerdict.drop("servers have no field"),
        ]


def test_the_drive_loop_records_every_root_verdict_under_the_root_key():
    """Root verdicts land on the empty key — the one a `canonical_diff` gives the root."""
    report = _RootPack(PROTOBUF_PROFILE).evaluate(_rich_api())
    items = _items_for(report, ROOT_CONSTRUCT_KEY)
    assert sorted(item.kind.value for item in items) == ["approx", "drop"]
    assert ROOT_CONSTRUCT_KEY == ""


def test_the_root_key_is_what_a_canonical_diff_calls_the_root():
    """The hook is only useful if its key reconciles against a real `changed root` entry.

    `app.roundtrip_matrix.reconcile` relates a construct to a diff entity by key, and the
    root entity's key is the empty string — so a root verdict recorded anywhere else would
    never explain the difference it exists to explain.
    """
    from app.import_source import canonical_diff

    api = _rich_api()
    renamed = api.model_copy(update={"title": "Something else"})
    entries = canonical_diff(api, renamed).entries
    assert [(e.entity, e.key) for e in entries] == [("root", ROOT_CONSTRUCT_KEY)]


# ---------------------------------------------------------------------------
# CapabilityRulePack: the profile-derived default
# ---------------------------------------------------------------------------


def test_capability_pack_openapi_is_lossless():
    """The rich REST source is carried cleanly by the OpenAPI profile."""
    report = CapabilityRulePack(OPENAPI_PROFILE, "OpenAPI 3.1").evaluate(_rich_api())
    assert report.is_lossless
    assert all(item.kind is LossinessKind.OK for item in report.items)


def test_capability_pack_protobuf_reports_all_losses():
    """The lossy Protobuf profile drops operations/channel/union and degrades fields."""
    report = CapabilityRulePack(PROTOBUF_PROFILE, "Protobuf").evaluate(_rich_api())

    assert _items_for(report, "GET /users/{id}")[0].kind is LossinessKind.DROP
    assert _items_for(report, "user/signedup")[0].kind is LossinessKind.DROP
    assert _items_for(report, "Contact")[0].kind is LossinessKind.DROP
    # Scalar constraint demoted.
    assert _items_for(report, "Money")[0].kind is LossinessKind.APPROX
    # Required, unnumbered field: non-null lost (APPROX) + field number synthesized.
    id_kinds = {i.kind for i in _items_for(report, "User.id")}
    assert id_kinds == {LossinessKind.APPROX, LossinessKind.SYNTH}


def test_capability_pack_matches_engine_entrypoint():
    """`compute_lossiness` with no explicit pack builds exactly a CapabilityRulePack."""
    api = _rich_api()
    via_engine = compute_lossiness(api, PROTOBUF_PROFILE, target_label="Protobuf")
    via_pack = CapabilityRulePack(PROTOBUF_PROFILE, "Protobuf").evaluate(api)
    assert via_engine.model_dump() == via_pack.model_dump()


# ---------------------------------------------------------------------------
# Emitter wiring: an emitter declares (or omits) a pack
# ---------------------------------------------------------------------------


def test_base_and_sample_emitters_declare_no_pack():
    """A target with no special rules declares no pack; the engine uses the default."""
    assert Emitter.fidelity_rule_pack() is None
    assert SampleEmitter.fidelity_rule_pack() is None


def test_openapi_emitter_declares_reference_pack():
    """The OpenAPI emitter ships its reference pack alongside itself."""
    assert OpenApiEmitter.fidelity_rule_pack() is OpenApiFidelityRulePack
    assert issubclass(OpenApiFidelityRulePack, CapabilityRulePack)


# ---------------------------------------------------------------------------
# Reference OpenAPI pack refines the field-number verdict
# ---------------------------------------------------------------------------


def test_openapi_pack_preserves_field_number_as_extension():
    """A source field number is an APPROX (info), not a DROP, on the OpenAPI target."""
    report = compute_lossiness_for_emitter(_numbered_api(), OpenApiEmitter)
    item = _items_for(report, "Msg.a")[0]
    assert item.kind is LossinessKind.APPROX
    assert item.severity is LossinessSeverity.INFO
    assert X_FIELD_NUMBER in (item.target_mapping or "")


def test_default_pack_drops_field_number_that_openapi_pack_keeps():
    """The refinement is the pack's: the raw profile default still DROPs the number."""
    api = _numbered_api()
    # Raw profile path → CapabilityRulePack → DROP (info).
    default = compute_lossiness(api, OPENAPI_PROFILE)
    assert _items_for(default, "Msg.a")[0].kind is LossinessKind.DROP
    # Emitter path → OpenApiFidelityRulePack → APPROX. The engine consumed the pack.
    via_pack = compute_lossiness_for_emitter(api, OpenApiEmitter)
    assert _items_for(via_pack, "Msg.a")[0].kind is LossinessKind.APPROX


def test_openapi_pack_leaves_faithful_verdicts_unchanged():
    """A unary REST source with no event/RPC constructs still reports lossless.

    The MFX-9.2 refinements only fire for event channels, pub/sub, subscription, and
    streaming operations. A plain REST model that has none of those (no channels, no
    field numbers) must still defer to the capability-derived default and stay
    lossless, so the pack never over-reports loss on a faithful export.
    """
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Users API"),
        services=[Service(key="Users", name="Users", operations=[get_user])],
        types=[
            Type(
                key="User",
                name="User",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="User.id",
                        name="id",
                        type=TypeRef(name="string", nullable=False),
                    )
                ],
            )
        ],
    )
    via_pack = compute_lossiness_for_emitter(api, OpenApiEmitter)
    via_default = compute_lossiness(
        api, OpenApiEmitter.capability_profile(), target_label=OpenApiEmitter.label
    )
    assert via_pack.model_dump() == via_default.model_dump()
    assert via_pack.is_lossless


# ---------------------------------------------------------------------------
# Reference OpenAPI pack reports event / RPC source losses (MFX-9.2, #3867)
# ---------------------------------------------------------------------------


def _event_api() -> CanonicalApi:
    """An AsyncAPI-shaped source: a channel plus a publish and a subscribe op."""
    channel = Channel(
        key="user/signedup",
        address="user/signedup",
        protocol="kafka",
        bindings={"kafka": {"partitions": 3}},
    )
    publish = Operation(
        key="user/signedup#publish",
        name="onUserSignedUp",
        kind=OperationKind.PUBLISH,
        channel_ref="user/signedup",
    )
    subscribe = Operation(
        key="user/signedup#subscribe",
        name="receiveUserSignedUp",
        kind=OperationKind.SUBSCRIBE,
        channel_ref="user/signedup",
    )
    return CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3.0",
        identity=ApiIdentity(name="Events API"),
        services=[Service(key="Events", name="Events", operations=[publish, subscribe])],
        channels=[channel],
    )


def test_openapi_pack_approximates_event_channel():
    """An event channel is a documented-only APPROX, not the profile's clean OK."""
    report = compute_lossiness_for_emitter(_event_api(), OpenApiEmitter)
    item = _items_for(report, "user/signedup")[0]
    assert item.kind is LossinessKind.APPROX
    assert item.severity is LossinessSeverity.WARN
    assert "documentation" in item.message


def test_openapi_pack_approximates_pubsub_operations():
    """Both pub/sub actions are APPROX'd with an x-apiome-event-action mapping."""
    report = compute_lossiness_for_emitter(_event_api(), OpenApiEmitter)
    for key in ("user/signedup#publish", "user/signedup#subscribe"):
        item = _items_for(report, key)[0]
        assert item.kind is LossinessKind.APPROX
        assert "x-apiome-event-action" in (item.target_mapping or "")
    # The event source is reported as lossy (the acceptance criterion), never silent.
    assert not report.is_lossless


def test_default_pack_would_call_event_source_lossless():
    """The refinement is the pack's: the raw OpenAPI profile still reports OK.

    Contrasts the honest MFX-9.2 pack against the flat capability profile, which —
    because OpenAPI advertises ``events=True`` — would call an AsyncAPI export
    lossless and hide exactly the losses the fidelity pack exists to surface.
    """
    api = _event_api()
    default = compute_lossiness(api, OpenApiEmitter.capability_profile())
    assert default.is_lossless
    via_pack = compute_lossiness_for_emitter(api, OpenApiEmitter)
    assert not via_pack.is_lossless


def test_openapi_pack_approximates_rpc_streaming_operation():
    """An RPC streaming method is an APPROX surfaced via x-apiome-streaming."""
    stream = Operation(
        key="acme.Chat.Stream",
        name="Stream",
        kind=OperationKind.REQUEST_RESPONSE,
        streaming=StreamingMode.BIDIRECTIONAL,
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="grpc",
        identity=ApiIdentity(name="Chat"),
        services=[Service(key="acme.Chat", name="Chat", operations=[stream])],
    )
    item = _items_for(compute_lossiness_for_emitter(api, OpenApiEmitter), "acme.Chat.Stream")[0]
    assert item.kind is LossinessKind.APPROX
    assert "bidirectional" in item.message
    assert "x-apiome-streaming" in (item.target_mapping or "")


def test_openapi_pack_carries_unary_rpc_operation_cleanly():
    """A unary (non-streaming) RPC method is still a clean OK — only streams degrade."""
    unary = Operation(
        key="acme.Chat.Send",
        name="Send",
        kind=OperationKind.REQUEST_RESPONSE,
        streaming=StreamingMode.NONE,
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="grpc",
        identity=ApiIdentity(name="Chat"),
        services=[Service(key="acme.Chat", name="Chat", operations=[unary])],
    )
    item = _items_for(compute_lossiness_for_emitter(api, OpenApiEmitter), "acme.Chat.Send")[0]
    assert item.kind is LossinessKind.OK


def test_openapi_pack_drops_graphql_subscription():
    """A GraphQL subscription has no OpenAPI projection and is a critical DROP."""
    sub = Operation(
        key="Subscription.messageAdded",
        name="messageAdded",
        kind=OperationKind.SUBSCRIPTION,
        streaming=StreamingMode.SERVER,
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.GRAPH,
        format="graphql",
        identity=ApiIdentity(name="Chat"),
        services=[Service(key="Subscription", name="Subscription", operations=[sub])],
    )
    item = _items_for(
        compute_lossiness_for_emitter(api, OpenApiEmitter), "Subscription.messageAdded"
    )[0]
    assert item.kind is LossinessKind.DROP
    assert item.severity is LossinessSeverity.CRITICAL


# ---------------------------------------------------------------------------
# The engine consumes a caller-supplied pack
# ---------------------------------------------------------------------------


def test_compute_lossiness_honours_explicit_rule_pack():
    """An explicit `rule_pack` overrides the profile-derived default in the engine."""

    class _AllOkPack(CapabilityRulePack):
        def type_verdict(self, type_: Type) -> FidelityVerdict:
            return FidelityVerdict.ok("forced ok")

    api = _rich_api()
    pack = _AllOkPack(PROTOBUF_PROFILE, "Protobuf")
    report = compute_lossiness(api, PROTOBUF_PROFILE, rule_pack=pack)
    # Every named type is OK despite the lossy profile, because the pack said so.
    for key in ("User", "Contact", "Money"):
        assert _items_for(report, key)[0].kind is LossinessKind.OK


# ---------------------------------------------------------------------------
# Purity / determinism
# ---------------------------------------------------------------------------


def test_pack_is_deterministic_and_serializes_identically():
    """Two evaluations over the same inputs are equal and serialize byte-identically."""
    api = _rich_api()
    pack = CapabilityRulePack(PROTOBUF_PROFILE, "Protobuf")
    a = pack.evaluate(api)
    b = CapabilityRulePack(PROTOBUF_PROFILE, "Protobuf").evaluate(api)
    assert a.model_dump_json() == b.model_dump_json()


def test_pack_does_not_mutate_source_model():
    """Evaluating a pack leaves the source model untouched (pure)."""
    api = _rich_api()
    before = deepcopy(api).model_dump()
    CapabilityRulePack(PROTOBUF_PROFILE, "Protobuf").evaluate(api)
    assert api.model_dump() == before


# ---------------------------------------------------------------------------
# Reference AsyncAPI pack reports REST/RPC → message reframing losses
# (MFX-11.2, #3875)
# ---------------------------------------------------------------------------


def _rest_operation_api() -> CanonicalApi:
    """A REST source: one GET operation carrying method, path, and a 200 response."""
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
        messages=[
            Message(
                key="GET /users/{id}#response.200",
                role=MessageRole.RESPONSE,
                status_code="200",
            )
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Users API"),
        services=[Service(key="Users", name="Users", operations=[get_user])],
        types=[
            Type(
                key="User",
                name="User",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="User.id",
                        name="id",
                        type=TypeRef(name="string", nullable=False),
                    )
                ],
            )
        ],
    )


def test_asyncapi_emitter_declares_reference_pack():
    """The AsyncAPI emitter advertises its own pack, a CapabilityRulePack refinement."""
    assert AsyncApiEmitter.fidelity_rule_pack() is AsyncApiFidelityRulePack
    assert issubclass(AsyncApiFidelityRulePack, CapabilityRulePack)


def test_asyncapi_pack_reframes_rest_operation_as_approx():
    """A REST operation is a reframing APPROX enumerating the dropped HTTP semantics."""
    report = compute_lossiness_for_emitter(_rest_operation_api(), AsyncApiEmitter)
    item = _items_for(report, "GET /users/{id}")[0]
    assert item.kind is LossinessKind.APPROX
    assert item.severity is LossinessSeverity.WARN
    # All three HTTP facets the operation carries are named in the loss.
    assert "HTTP method" in item.message
    assert "path" in item.message
    assert "response status" in item.message
    assert "send + reply" in (item.target_mapping or "")


def test_default_pack_would_drop_rest_operation_the_asyncapi_pack_reframes():
    """The refinement is the pack's: the flat profile would call the reframe a DROP.

    Contrasts the honest MFX-11.2 pack (APPROX — the operation is carried, reframed)
    against the capability profile, which — because AsyncAPI advertises
    ``operations=False`` — predicts a critical ``DROP`` and overstates the loss.
    """
    api = _rest_operation_api()
    default = compute_lossiness(api, AsyncApiEmitter.capability_profile())
    assert _items_for(default, "GET /users/{id}")[0].kind is LossinessKind.DROP
    via_pack = compute_lossiness_for_emitter(api, AsyncApiEmitter)
    assert _items_for(via_pack, "GET /users/{id}")[0].kind is LossinessKind.APPROX


def test_asyncapi_pack_reframes_operation_without_http_semantics():
    """An abstract operation (no verb/path/status) still reframes to an APPROX, no loss list."""
    op = Operation(
        key="doThing",
        name="doThing",
        kind=OperationKind.REQUEST_RESPONSE,
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="grpc",
        identity=ApiIdentity(name="Svc"),
        services=[Service(key="Svc", name="Svc", operations=[op])],
    )
    item = _items_for(compute_lossiness_for_emitter(api, AsyncApiEmitter), "doThing")[0]
    assert item.kind is LossinessKind.APPROX
    assert "send + reply" in item.message
    # No HTTP facets to enumerate → the message carries no "are dropped" clause.
    assert "are dropped" not in item.message


def test_asyncapi_pack_approximates_rpc_streaming_operation():
    """An RPC streaming method is an APPROX whose streaming cardinality is dropped."""
    stream = Operation(
        key="acme.Chat.Stream",
        name="Stream",
        kind=OperationKind.REQUEST_RESPONSE,
        streaming=StreamingMode.BIDIRECTIONAL,
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="grpc",
        identity=ApiIdentity(name="Chat"),
        services=[Service(key="acme.Chat", name="Chat", operations=[stream])],
    )
    item = _items_for(
        compute_lossiness_for_emitter(api, AsyncApiEmitter), "acme.Chat.Stream"
    )[0]
    assert item.kind is LossinessKind.APPROX
    assert "bidirectional" in item.message
    assert "cardinality" in (item.target_mapping or "")


def test_asyncapi_pack_carries_native_pubsub_and_channel_cleanly():
    """Native pub/sub operations and their channel are AsyncAPI's home turf — clean OK."""
    report = compute_lossiness_for_emitter(_event_api(), AsyncApiEmitter)
    assert _items_for(report, "user/signedup")[0].kind is LossinessKind.OK
    for key in ("user/signedup#publish", "user/signedup#subscribe"):
        assert _items_for(report, key)[0].kind is LossinessKind.OK


def test_asyncapi_pack_carries_named_types_to_components():
    """Every named type lands in components.schemas — records/unions/scalars stay OK."""
    report = compute_lossiness_for_emitter(_rich_api(), AsyncApiEmitter)
    for key in ("User", "Contact", "Money"):
        assert _items_for(report, key)[0].kind is LossinessKind.OK


def test_asyncapi_event_source_is_lossless_but_rest_source_is_not():
    """An event source round-trips cleanly; a REST source is honestly reported lossy."""
    assert compute_lossiness_for_emitter(_event_api(), AsyncApiEmitter).is_lossless
    assert not compute_lossiness_for_emitter(
        _rest_operation_api(), AsyncApiEmitter
    ).is_lossless


# ---------------------------------------------------------------------------
# Reference Protobuf pack reports OpenAPI/GraphQL losses (MFX-12.3, #3881)
# ---------------------------------------------------------------------------


def test_proto_emitter_declares_reference_pack():
    """The Protobuf emitter ships its reference pack alongside itself."""
    assert ProtoEmitter.fidelity_rule_pack() is ProtoFidelityRulePack
    assert issubclass(ProtoFidelityRulePack, CapabilityRulePack)


def _protobuf_rich_api() -> CanonicalApi:
    """An OpenAPI-shaped source exercising every protobuf fidelity loss class."""
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
    )
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="User.id",
                name="id",
                type=TypeRef(name="string", nullable=False),
            ),
            CanonicalField(
                key="User.age",
                name="age",
                type=TypeRef(name="integer", nullable=True),
                constraints=Constraints(minimum=0, maximum=120),
            ),
            CanonicalField(
                key="User.email",
                name="email",
                type=TypeRef(name="string", nullable=False),
                constraints=Constraints(pattern=r".+@.+"),
            ),
            CanonicalField(
                key="User.metadata",
                name="metadata",
                type=TypeRef(nullable=True),
            ),
        ],
    )
    contact = Type(
        key="Contact",
        name="Contact",
        kind=TypeKind.UNION,
        union_members=["User", "Org"],
    )
    empty_union = Type(
        key="Loose",
        name="Loose",
        kind=TypeKind.UNION,
        union_members=[],
    )
    derived = Type(
        key="Employee",
        name="Employee",
        kind=TypeKind.RECORD,
        extras={"allOf": [{"$ref": "#/components/schemas/Person"}]},
        fields=[
            CanonicalField(
                key="Employee.badge",
                name="badge",
                type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    graph_user = Type(
        key="GraphUser",
        name="GraphUser",
        kind=TypeKind.RECORD,
        extras={"graphql_type": "object", "interfaces": ["Node"]},
        fields=[
            CanonicalField(
                key="GraphUser.id",
                name="id",
                type=TypeRef(name="ID", nullable=False),
            )
        ],
    )
    money = Type(
        key="Money",
        name="Money",
        kind=TypeKind.SCALAR,
        constraints=Constraints(pattern=r"^\d+\.\d{2}$"),
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Users API"),
        services=[Service(key="Users", name="Users", operations=[get_user])],
        channels=[Channel(key="user/signedup", address="user/signedup", protocol="kafka")],
        types=[user, contact, empty_union, derived, graph_user, money],
    )


def test_proto_pack_enumerates_rich_openapi_losses():
    """Rich OpenAPI source → Protobuf: every loss class reports kind + reason."""
    report = compute_lossiness_for_emitter(_protobuf_rich_api(), ProtoEmitter)
    assert not report.is_lossless

    union_item = _items_for(report, "Contact")[0]
    assert union_item.kind is LossinessKind.APPROX
    assert "oneof" in (union_item.target_mapping or "")

    bad_union = _items_for(report, "Loose")[0]
    assert bad_union.kind is LossinessKind.APPROX
    assert "google.protobuf.Any" in (bad_union.target_mapping or "")

    inheritance = _items_for(report, "Employee")[0]
    assert inheritance.kind is LossinessKind.APPROX
    assert "flatten" in (inheritance.target_mapping or "").lower()

    graph_iface = _items_for(report, "GraphUser")[0]
    assert graph_iface.kind is LossinessKind.APPROX
    assert "flatten" in (graph_iface.message or "").lower()

    metadata = _items_for(report, "User.metadata")[0]
    assert metadata.kind is LossinessKind.APPROX
    assert "google.protobuf.Struct" in (metadata.target_mapping or "")

    id_kinds = {item.kind for item in _items_for(report, "User.id")}
    assert id_kinds == {LossinessKind.APPROX, LossinessKind.SYNTH}

    age_kinds = {item.kind for item in _items_for(report, "User.age")}
    assert age_kinds == {LossinessKind.APPROX, LossinessKind.SYNTH}

    email_kinds = sorted(i.kind.value for i in _items_for(report, "User.email"))
    assert email_kinds == ["approx", "approx", "synth"]

    assert _items_for(report, "Money")[0].kind is LossinessKind.APPROX
    assert _items_for(report, "user/signedup")[0].kind is LossinessKind.DROP
    assert _items_for(report, "GET /users/{id}")[0].kind is LossinessKind.OK


def test_default_pack_drops_union_the_proto_pack_approximates():
    """The refinement is the pack's: the profile default DROPs unions as unrepresentable."""
    api = _protobuf_rich_api()
    default = compute_lossiness(api, ProtoEmitter.capability_profile())
    assert _items_for(default, "Contact")[0].kind is LossinessKind.DROP
    via_pack = compute_lossiness_for_emitter(api, ProtoEmitter)
    assert _items_for(via_pack, "Contact")[0].kind is LossinessKind.APPROX


def test_proto_pack_approximates_pubsub_operation():
    """A pub/sub operation is reframed as a unary rpc APPROX, not a critical DROP."""
    publish = Operation(
        key="user/signedup#publish",
        name="onUserSignedUp",
        kind=OperationKind.PUBLISH,
        channel_ref="user/signedup",
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3.0",
        identity=ApiIdentity(name="Events API"),
        services=[Service(key="Events", name="Events", operations=[publish])],
        channels=[Channel(key="user/signedup", address="user/signedup", protocol="kafka")],
    )
    default = compute_lossiness(api, ProtoEmitter.capability_profile())
    assert _items_for(default, "user/signedup#publish")[0].kind is LossinessKind.DROP
    item = _items_for(compute_lossiness_for_emitter(api, ProtoEmitter), "user/signedup#publish")[0]
    assert item.kind is LossinessKind.APPROX
    assert "unary rpc" in (item.target_mapping or "")


def test_proto_pack_skips_nullability_loss_for_proto3_optional():
    """A proto-sourced optional field round-trips without a nullability APPROX."""
    typed = Type(
        key="Msg",
        name="Msg",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Msg.nick",
                name="nick",
                type=TypeRef(name="string", nullable=True),
                field_number=3,
                extras={"proto3_optional": True},
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="Svc"),
        types=[typed],
    )
    report = compute_lossiness_for_emitter(api, ProtoEmitter)
    assert _items_for(report, "Msg.nick") == []


# ---------------------------------------------------------------------------
# Reference GraphQL pack reports REST/OpenAPI losses (MFX-13.3, #3886)
# ---------------------------------------------------------------------------


def test_graphql_emitter_declares_reference_pack():
    """The GraphQL emitter ships its reference pack alongside itself."""
    assert GraphQlEmitter.fidelity_rule_pack() is GraphQlFidelityRulePack
    assert issubclass(GraphQlFidelityRulePack, CapabilityRulePack)


def _graphql_rich_api() -> CanonicalApi:
    """An OpenAPI-shaped source exercising every GraphQL fidelity loss class."""
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
        parameters=[
            Parameter(
                key="GET /users/{id}#header.X-Request-Id",
                name="X-Request-Id",
                location=ParameterLocation.HEADER,
                type=TypeRef(name="string", nullable=False),
            )
        ],
        messages=[
            Message(
                key="GET /users/{id}#response.200",
                role=MessageRole.RESPONSE,
                status_code="200",
            )
        ],
    )
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="User.email",
                name="email",
                type=TypeRef(name="string", nullable=False),
                constraints=Constraints(pattern=r".+@.+"),
            )
        ],
    )
    contact = Type(
        key="Contact",
        name="Contact",
        kind=TypeKind.UNION,
        union_members=["User", "Org"],
    )
    org = Type(
        key="Org",
        name="Org",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Org.name",
                name="name",
                type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    loose = Type(
        key="Loose",
        name="Loose",
        kind=TypeKind.UNION,
        union_members=[],
    )
    bad_union = Type(
        key="Tag",
        name="Tag",
        kind=TypeKind.UNION,
        union_members=["Money"],
    )
    money = Type(
        key="Money",
        name="Money",
        kind=TypeKind.SCALAR,
        constraints=Constraints(pattern=r"^\d+\.\d{2}$"),
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Users API"),
        services=[Service(key="Users", name="Users", operations=[get_user])],
        channels=[Channel(key="user/signedup", address="user/signedup", protocol="kafka")],
        types=[user, org, contact, loose, bad_union, money],
    )


def test_graphql_pack_enumerates_rich_openapi_losses():
    """Rich OpenAPI source → GraphQL: every loss class reports kind + reason."""
    report = compute_lossiness_for_emitter(_graphql_rich_api(), GraphQlEmitter)
    assert not report.is_lossless

    rest_op = _items_for(report, "GET /users/{id}")[0]
    assert rest_op.kind is LossinessKind.APPROX
    assert "HTTP method" in rest_op.message
    assert "path" in rest_op.message
    assert "response status" in rest_op.message
    assert "headers" in rest_op.message
    assert "Query/Mutation" in (rest_op.target_mapping or "")

    assert _items_for(report, "Contact")[0].kind is LossinessKind.OK
    assert _items_for(report, "Loose")[0].kind is LossinessKind.APPROX
    assert _items_for(report, "Tag")[0].kind is LossinessKind.APPROX

    email = _items_for(report, "User.email")[0]
    assert email.kind is LossinessKind.APPROX
    assert "custom scalar" in (email.target_mapping or "")

    assert _items_for(report, "Money")[0].kind is LossinessKind.APPROX
    assert _items_for(report, "user/signedup")[0].kind is LossinessKind.DROP


def test_default_pack_calls_rest_operation_ok_the_graphql_pack_approximates():
    """The refinement is the pack's: the profile default OK understates HTTP losses."""
    api = _rest_operation_api()
    default = compute_lossiness(api, GraphQlEmitter.capability_profile())
    assert _items_for(default, "GET /users/{id}")[0].kind is LossinessKind.OK
    via_pack = compute_lossiness_for_emitter(api, GraphQlEmitter)
    assert _items_for(via_pack, "GET /users/{id}")[0].kind is LossinessKind.APPROX


def test_graphql_pack_carries_native_graph_operations_cleanly():
    """Native query/mutation operations are GraphQL's home turf — clean OK."""
    query = Operation(
        key="Query.users",
        name="users",
        kind=OperationKind.QUERY,
    )
    mutation = Operation(
        key="Mutation.createUser",
        name="createUser",
        kind=OperationKind.MUTATION,
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.GRAPH,
        format="graphql",
        identity=ApiIdentity(name="Users API"),
        services=[
            Service(key="Query", name="Query", operations=[query]),
            Service(key="Mutation", name="Mutation", operations=[mutation]),
        ],
    )
    report = compute_lossiness_for_emitter(api, GraphQlEmitter)
    assert _items_for(report, "Query.users")[0].kind is LossinessKind.OK
    assert _items_for(report, "Mutation.createUser")[0].kind is LossinessKind.OK


# ---------------------------------------------------------------------------
# Reference Avro pack reports types-only + type losses (MFX-19.2, #3910)
# ---------------------------------------------------------------------------


def test_avro_emitter_declares_reference_pack():
    """The Avro emitter ships its reference pack alongside itself."""
    assert AvroEmitter.fidelity_rule_pack() is AvroFidelityRulePack
    assert issubclass(AvroFidelityRulePack, CapabilityRulePack)


def _avro_rich_api() -> CanonicalApi:
    """An OpenAPI-shaped source exercising every Avro fidelity loss class."""
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
    )
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="User.id",
                name="id",
                type=TypeRef(name="string", nullable=False),
            ),
            CanonicalField(
                key="User.age",
                name="age",
                type=TypeRef(name="integer", nullable=True),
                constraints=Constraints(minimum=0, maximum=120),
            ),
            CanonicalField(
                key="User.email",
                name="email",
                type=TypeRef(name="string", nullable=True),
                constraints=Constraints(pattern=r".+@.+"),
            ),
        ],
    )
    org = Type(
        key="Org",
        name="Org",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Org.name",
                name="name",
                type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    contact = Type(
        key="Contact",
        name="Contact",
        kind=TypeKind.UNION,
        union_members=["User", "Org"],
    )
    loose = Type(
        key="Loose",
        name="Loose",
        kind=TypeKind.UNION,
        union_members=[],
    )
    bad_union = Type(
        key="Tag",
        name="Tag",
        kind=TypeKind.UNION,
        union_members=["MissingType"],
    )
    money = Type(
        key="Money",
        name="Money",
        kind=TypeKind.SCALAR,
        constraints=Constraints(pattern=r"^\d+\.\d{2}$"),
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Users API"),
        services=[Service(key="Users", name="Users", operations=[get_user])],
        channels=[Channel(key="user/signedup", address="user/signedup", protocol="kafka")],
        types=[user, org, contact, loose, bad_union, money],
    )


def test_avro_pack_surfaces_types_only_critical_warning_and_counts():
    """Operation-bearing API → Avro: critical types-only DROP + enumerated type losses."""
    report = compute_lossiness_for_emitter(_avro_rich_api(), AvroEmitter)
    assert not report.is_lossless
    assert report.worst_severity is LossinessSeverity.CRITICAL

    op = _items_for(report, "GET /users/{id}")[0]
    assert op.kind is LossinessKind.DROP
    assert op.severity is LossinessSeverity.CRITICAL
    assert "only data schemas are exported" in op.message

    channel = _items_for(report, "user/signedup")[0]
    assert channel.kind is LossinessKind.DROP
    assert channel.severity is LossinessSeverity.CRITICAL
    assert "only data schemas are exported" in channel.message

    xf = build_export_fidelity(_avro_rich_api(), AvroEmitter)
    assert xf.summary.tier is ExportFidelityTier.TYPES_ONLY
    assert xf.advisory.show is True
    assert xf.advisory.severity is LossinessSeverity.CRITICAL
    assert xf.advisory.requires_ack is True
    assert xf.advisory.dropped >= 2


def test_avro_pack_enumerates_type_losses():
    """Rich OpenAPI source → Avro: unions, constraints, nullability, and defaults."""
    report = compute_lossiness_for_emitter(_avro_rich_api(), AvroEmitter)

    assert _items_for(report, "Contact")[0].kind is LossinessKind.OK
    assert "Avro union" in (_items_for(report, "Contact")[0].target_mapping or "")

    assert _items_for(report, "Loose")[0].kind is LossinessKind.APPROX
    assert _items_for(report, "Tag")[0].kind is LossinessKind.APPROX

    assert _items_for(report, "Money")[0].kind is LossinessKind.DROP
    assert "constraints" in (_items_for(report, "Money")[0].target_mapping or "").lower()

    age_kinds = {item.kind for item in _items_for(report, "User.age")}
    assert age_kinds == {LossinessKind.APPROX, LossinessKind.DROP, LossinessKind.SYNTH}

    email_kinds = sorted(i.kind.value for i in _items_for(report, "User.email"))
    assert email_kinds == ["approx", "drop", "synth"]

    assert _items_for(report, "User.id") == []
    assert _items_for(report, "User")[0].kind is LossinessKind.OK


def test_avro_pack_only_marks_avro_union_members_with_named_branches_as_ok():
    """Maps, nested unions, and non-fixed scalars stay APPROX; fixed scalars remain OK."""
    fixed = Type(
        key="Md5",
        name="Md5",
        kind=TypeKind.SCALAR,
        extras={"avro_type": "fixed", "avro_size": 16},
    )
    logical = Type(
        key="Money",
        name="Money",
        kind=TypeKind.SCALAR,
        constraints=Constraints(format="decimal"),
        extras={"precision": 10, "scale": 2},
    )
    labels = Type(
        key="Labels",
        name="Labels",
        kind=TypeKind.MAP,
        value_type=TypeRef(name="string", nullable=False),
    )
    opt_string = Type(
        key="OptString",
        name="OptString",
        kind=TypeKind.UNION,
        union_members=["null", "string"],
    )
    digest = Type(key="Digest", name="Digest", kind=TypeKind.UNION, union_members=["Md5"])
    amount = Type(key="Amount", name="Amount", kind=TypeKind.UNION, union_members=["Money"])
    metadata = Type(key="Metadata", name="Metadata", kind=TypeKind.UNION, union_members=["Labels"])
    nested = Type(key="Nested", name="Nested", kind=TypeKind.UNION, union_members=["OptString"])

    report = compute_lossiness_for_emitter(
        CanonicalApi(
            paradigm=ApiParadigm.REST,
            format="openapi-3.1",
            identity=ApiIdentity(name="Union members"),
            types=[fixed, logical, labels, opt_string, digest, amount, metadata, nested],
        ),
        AvroEmitter,
    )

    assert _items_for(report, "Digest")[0].kind is LossinessKind.OK
    assert _items_for(report, "Amount")[0].kind is LossinessKind.APPROX
    assert _items_for(report, "Metadata")[0].kind is LossinessKind.APPROX
    assert _items_for(report, "Nested")[0].kind is LossinessKind.APPROX


def test_default_pack_oks_unions_the_avro_pack_approximates_ineligible():
    """The refinement is the pack's: ineligible unions APPROX instead of silent OK."""
    api = _avro_rich_api()
    default = compute_lossiness(api, AvroEmitter.capability_profile(), target_label="Apache Avro")
    assert _items_for(default, "Loose")[0].kind is LossinessKind.OK
    via_pack = compute_lossiness_for_emitter(api, AvroEmitter)
    assert _items_for(via_pack, "Loose")[0].kind is LossinessKind.APPROX


def test_avro_data_schema_source_is_lossless():
    """A types-only Avro source round-trips without fidelity losses."""
    user = Type(
        key="com.example.User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="com.example.User.id",
                name="id",
                type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="avro",
        identity=ApiIdentity(name="Users", namespace="com.example"),
        types=[user],
    )
    report = compute_lossiness_for_emitter(api, AvroEmitter)
    assert report.is_lossless
