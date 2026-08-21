"""Tests for the Kubernetes CustomResourceDefinition emitter — FMT-2.1 (#5419).

Exercises the ticket's acceptance criteria:

* emitted CRDs are ``apiextensions.k8s.io/v1`` documents that satisfy the
  structural-schema rules (checked with the independent
  :func:`~app.k8s_structural_schema.validate_k8s_crd_document`);
* import a CRD → emit a CRD → re-import yields an equivalent canonical model;
* constructs a structural schema disallows — unions, reference cycles,
  ``uniqueItems``, unknown formats, ``deprecated`` — are reported as losses with
  reasons rather than silently dropped;
* emit options cover group, scope, plural/singular naming and served/storage;
* the corpus carries a simple resource, a status-subresource resource and a
  multi-version CRD.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    EnumValue,
    Operation,
    OperationKind,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    EmitOptions,
    LossKind,
    coerce_emit_options,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from app.import_source import canonical_diff
from app.k8s_crd_emitter import (
    K8sCrdEmitOptions,
    K8sCrdEmitter,
    K8sCrdFidelityRulePack,
)
from app.k8s_crd_import_source import K8sCrdImportSource
from app.k8s_structural_schema import (
    CRD_API_VERSION,
    INT_OR_STRING,
    PRESERVE_UNKNOWN_FIELDS,
    structural_schema_violations,
    validate_k8s_crd_document,
)

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "k8s-crd"

#: Every valid CRD fixture in the shared corpus, by file name.
CORPUS_FIXTURES: List[str] = sorted(path.name for path in CORPUS.glob("*.yaml"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _import_fixture(name: str) -> CanonicalApi:
    """Import one corpus CRD fixture to a canonical model (no raw fidelity bag)."""
    adapter = K8sCrdImportSource()
    text = (CORPUS / name).read_text()
    return adapter.normalize(adapter.parse(text), include_raw=False)


def _emit(api: CanonicalApi, **options: Any) -> Any:
    """Emit ``api`` with the given option overrides."""
    return K8sCrdEmitter().emit(api, opts=K8sCrdEmitOptions(**options) if options else None)


def _documents(content: str) -> List[Dict[str, Any]]:
    """Parse emitted YAML into its CustomResourceDefinition mappings."""
    return [doc for doc in yaml.safe_load_all(content) if doc is not None]


def _only_document(result: Any) -> Dict[str, Any]:
    """Return the single emitted CRD mapping, asserting there is exactly one."""
    documents = _documents(result.files[0].content)
    assert len(documents) == 1
    return documents[0]


def _schema(document: Dict[str, Any], index: int = 0) -> Dict[str, Any]:
    """Return one version's ``openAPIV3Schema`` from an emitted document."""
    return document["spec"]["versions"][index]["schema"]["openAPIV3Schema"]


def _subjects(result: Any, kind: LossKind | None = None) -> List[str]:
    """Return the loss subjects recorded by an emit, optionally filtered by kind."""
    return [loss.subject for loss in result.losses if kind is None or loss.kind is kind]


def _api(
    types: List[Type],
    *,
    title: str | None = None,
    version: str | None = None,
    namespace: str | None = None,
    services: List[Service] | None = None,
    channels: List[Channel] | None = None,
    servers: List[Server] | None = None,
) -> CanonicalApi:
    """Build a minimal data-schema canonical model for the derived-identity path."""
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="json-schema",
        identity=ApiIdentity(name=title or "Resource", namespace=namespace),
        title=title,
        version=version,
        types=types,
        services=services or [],
        channels=channels or [],
        servers=servers or [],
    )


def _record(name: str, fields: List[CanonicalField], **kwargs: Any) -> Type:
    """Build a RECORD type keyed by its name."""
    return Type(key=name, name=name, kind=TypeKind.RECORD, fields=fields, **kwargs)


def _field(name: str, type_name: str | None, *, required: bool = False, **kwargs: Any) -> CanonicalField:
    """Build a record member; ``required`` maps onto the canonical ``nullable=False``."""
    return CanonicalField(
        key=f"field.{name}",
        name=name,
        type=TypeRef(name=type_name, nullable=not required),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Registry surface
# ---------------------------------------------------------------------------


def test_the_emitter_is_registered_under_the_crd_format() -> None:
    load_builtin_emitters()
    assert get_emitter("k8s-crd") is K8sCrdEmitter


def test_the_descriptor_describes_a_single_file_data_schema_target() -> None:
    descriptor = K8sCrdEmitter.descriptor()
    assert descriptor.key == "k8s-crd"
    assert descriptor.format == "k8s-crd"
    assert descriptor.label == "Kubernetes CRD"
    assert descriptor.paradigm is ApiParadigm.DATA_SCHEMA
    assert descriptor.multi_file is False
    assert descriptor.needs_toolchain is False
    assert descriptor.available is True


def test_the_target_appears_in_the_public_target_list_with_its_options() -> None:
    target = next(t for t in describe_emit_targets() if t.descriptor.key == "k8s-crd")
    assert set(target.default_options) >= {
        "group",
        "scope",
        "plural",
        "singular",
        "served",
        "storage_version",
    }
    assert target.options_schema["properties"]["scope"]["description"]


def test_the_capability_profile_is_honest_about_unions_and_operations() -> None:
    """A structural schema carries records and facets; `oneOf` may not carry a type."""
    profile = K8sCrdEmitter.capability_profile()
    assert profile.operations is False
    assert profile.events is False
    assert profile.unions is False
    assert profile.nullability is True
    assert profile.constraints is True


def test_options_are_coerced_from_a_raw_dict() -> None:
    options = coerce_emit_options(K8sCrdEmitter, {"scope": "Cluster", "group": "acme.io"})
    assert isinstance(options, K8sCrdEmitOptions)
    assert options.resolved_scope() == "Cluster"
    assert options.group == "acme.io"


def test_a_bare_emit_options_envelope_is_accepted() -> None:
    """Callers holding the base envelope (the export service) must still work."""
    result = K8sCrdEmitter().emit(_import_fixture("01-minimal-widget.yaml"), opts=EmitOptions())
    assert _only_document(result)["kind"] == "CustomResourceDefinition"


# ---------------------------------------------------------------------------
# Acceptance: valid, structural output for the whole corpus
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_every_corpus_fixture_emits_a_valid_structural_crd(fixture: str) -> None:
    result = _emit(_import_fixture(fixture))
    content = result.files[0].content
    validate_k8s_crd_document(content)
    for document in _documents(content):
        assert document["apiVersion"] == CRD_API_VERSION
        assert document["kind"] == "CustomResourceDefinition"


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_emission_is_deterministic(fixture: str) -> None:
    api = _import_fixture(fixture)
    first, second = _emit(api), _emit(api)
    assert first.files[0].content == second.files[0].content
    assert [loss.model_dump() for loss in first.losses] == [
        loss.model_dump() for loss in second.losses
    ]
    assert [note.model_dump() for note in first.provenance] == [
        note.model_dump() for note in second.provenance
    ]


def test_the_corpus_covers_the_three_shapes_the_ticket_requires() -> None:
    """A simple resource, a status-subresource resource, and a multi-version CRD."""
    assert "01-minimal-widget.yaml" in CORPUS_FIXTURES
    assert "03-multi-version.yaml" in CORPUS_FIXTURES
    assert "07-status-subresource.yaml" in CORPUS_FIXTURES

    multi = _only_document(_emit(_import_fixture("03-multi-version.yaml")))
    assert len(multi["spec"]["versions"]) == 3

    status = _only_document(_emit(_import_fixture("07-status-subresource.yaml")))
    assert status["spec"]["versions"][0]["subresources"] == {"status": {}}


# ---------------------------------------------------------------------------
# Acceptance: round trip
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture",
    [
        "01-minimal-widget.yaml",
        "02-typical-cronwidget.yaml",
        "03-multi-version.yaml",
        "06-multi-crd-stream.yaml",
        "07-status-subresource.yaml",
    ],
)
def test_import_emit_reimport_yields_the_same_canonical_model(fixture: str) -> None:
    adapter = K8sCrdImportSource()
    api = _import_fixture(fixture)
    emitted = _emit(api).files[0].content
    reimported = adapter.normalize(adapter.parse(emitted), include_raw=False)
    difference = canonical_diff(api, reimported)
    assert difference.entries == [], f"{fixture} did not round-trip: {difference.entries}"


@pytest.mark.parametrize(
    "fixture", ["04-x-kubernetes-extensions.yaml", "05-cert-manager-like.yaml"]
)
def test_deep_vendor_extensions_are_reported_rather_than_silently_lost(fixture: str) -> None:
    """The canonical model keeps only root-level nodes, so nested `x-kubernetes-*`
    bags cannot be re-attached — the emitter says so instead of pretending."""
    result = _emit(_import_fixture(fixture))
    assert "unplaceable-vendor-extension" in _subjects(result, LossKind.NA)


def test_root_and_property_vendor_extensions_are_re_attached() -> None:
    schema = _schema(_only_document(_emit(_import_fixture("04-x-kubernetes-extensions.yaml"))))
    assert schema[PRESERVE_UNKNOWN_FIELDS] is False
    assert schema["properties"]["status"][PRESERVE_UNKNOWN_FIELDS] is True


# ---------------------------------------------------------------------------
# Versions, served / storage and subresources
# ---------------------------------------------------------------------------


def test_version_flags_survive_the_round_trip() -> None:
    document = _only_document(_emit(_import_fixture("03-multi-version.yaml")))
    versions = {entry["name"]: entry for entry in document["spec"]["versions"]}
    assert versions["v1"]["served"] is True and versions["v1"]["storage"] is True
    assert versions["v1alpha1"]["served"] is False
    assert versions["v1beta1"]["deprecated"] is True
    assert versions["v1beta1"]["deprecationWarning"].startswith("storage.example.io/v1beta1")
    assert sum(1 for entry in versions.values() if entry["storage"]) == 1


def test_the_served_option_forces_every_version() -> None:
    document = _only_document(_emit(_import_fixture("03-multi-version.yaml"), served=False))
    assert all(entry["served"] is False for entry in document["spec"]["versions"])


def test_the_storage_version_option_moves_the_storage_flag() -> None:
    result = _emit(_import_fixture("03-multi-version.yaml"), storage_version="v1beta1")
    versions = {e["name"]: e for e in _only_document(result)["spec"]["versions"]}
    assert versions["v1beta1"]["storage"] is True
    assert versions["v1"]["storage"] is False


def test_an_unknown_storage_version_is_reported_and_ignored() -> None:
    result = _emit(_import_fixture("03-multi-version.yaml"), storage_version="v9")
    assert "unknown-storage-version" in _subjects(result, LossKind.INFERRED)
    versions = {e["name"]: e for e in _only_document(result)["spec"]["versions"]}
    assert versions["v1"]["storage"] is True


def test_a_model_without_a_storage_version_gets_one_with_a_recorded_reason() -> None:
    api = _api([_record("Widget", [_field("spec", None)])], title="Widget", version="v1")
    result = _emit(api)
    document = _only_document(result)
    assert document["spec"]["versions"][0]["storage"] is True
    validate_k8s_crd_document(result.files[0].content)


def test_a_status_subresource_is_only_emitted_for_an_object_status() -> None:
    scalar_status = _api(
        [_record("Job", [_field("spec", None), _field("status", "string")])],
        title="Job",
        version="v1",
    )
    document = _only_document(_emit(scalar_status))
    assert "subresources" not in document["spec"]["versions"][0]


def test_the_status_subresource_can_be_disabled() -> None:
    document = _only_document(
        _emit(_import_fixture("07-status-subresource.yaml"), status_subresource=False)
    )
    assert "subresources" not in document["spec"]["versions"][0]


def test_a_version_without_a_schema_emits_no_schema_block() -> None:
    """A CRD version may legitimately declare no `openAPIV3Schema`."""
    adapter = K8sCrdImportSource()
    source = yaml.safe_dump(
        {
            "apiVersion": CRD_API_VERSION,
            "kind": "CustomResourceDefinition",
            "metadata": {"name": "things.example.io"},
            "spec": {
                "group": "example.io",
                "scope": "Namespaced",
                "names": {"kind": "Thing", "plural": "things", "singular": "thing"},
                "versions": [{"name": "v1", "served": True, "storage": True}],
            },
        }
    )
    api = adapter.normalize(adapter.parse(source), include_raw=False)
    result = _emit(api)
    assert "schema" not in _only_document(result)["spec"]["versions"][0]
    validate_k8s_crd_document(result.files[0].content)


# ---------------------------------------------------------------------------
# Multi-document streams
# ---------------------------------------------------------------------------


def test_a_multi_crd_model_emits_one_document_per_resource_in_source_order() -> None:
    result = _emit(_import_fixture("06-multi-crd-stream.yaml"))
    documents = _documents(result.files[0].content)
    assert [doc["metadata"]["name"] for doc in documents] == [
        "frontends.web.example.io",
        "backends.web.example.io",
    ]
    assert result.files[0].path == "Kubernetes-CRDs.crd.yaml"


def test_single_resource_options_are_declined_for_a_stream_rather_than_colliding() -> None:
    """`kind`/`plural` name one resource; obeying them across a stream would give every
    document the same `metadata.name`, which Kubernetes rejects."""
    result = _emit(_import_fixture("06-multi-crd-stream.yaml"), kind="Gadget", plural="gadgets")
    names = [doc["metadata"]["name"] for doc in _documents(result.files[0].content)]
    assert names == ["frontends.web.example.io", "backends.web.example.io"]
    assert "per-resource-option-ignored" in _subjects(result, LossKind.NA)
    validate_k8s_crd_document(result.files[0].content)


def test_stream_wide_options_still_apply_to_every_document() -> None:
    result = _emit(_import_fixture("06-multi-crd-stream.yaml"), group="acme.io", scope="Cluster")
    documents = _documents(result.files[0].content)
    assert [doc["metadata"]["name"] for doc in documents] == [
        "frontends.acme.io",
        "backends.acme.io",
    ]
    assert all(doc["spec"]["scope"] == "Cluster" for doc in documents)
    validate_k8s_crd_document(result.files[0].content)


def test_a_single_crd_is_named_after_the_resource() -> None:
    result = _emit(_import_fixture("01-minimal-widget.yaml"))
    assert result.files[0].path == "widgets.example.io.crd.yaml"
    assert result.files[0].media_type == "application/yaml"
    assert result.media_type == "application/yaml"


# ---------------------------------------------------------------------------
# Emit options: identity and naming
# ---------------------------------------------------------------------------


def test_identity_options_override_the_source_crd() -> None:
    result = _emit(
        _import_fixture("01-minimal-widget.yaml"),
        group="acme.io",
        kind="Gadget",
        plural="gadgets",
        singular="gadget",
        short_names=["gd", "gdt"],
        scope="Cluster",
    )
    document = _only_document(result)
    assert document["metadata"]["name"] == "gadgets.acme.io"
    assert document["spec"]["group"] == "acme.io"
    assert document["spec"]["scope"] == "Cluster"
    assert document["spec"]["names"] == {
        "kind": "Gadget",
        "plural": "gadgets",
        "singular": "gadget",
        "shortNames": ["gd", "gdt"],
    }
    validate_k8s_crd_document(result.files[0].content)


def test_an_empty_short_names_option_emits_none() -> None:
    document = _only_document(_emit(_import_fixture("01-minimal-widget.yaml"), short_names=[]))
    assert "shortNames" not in document["spec"]["names"]


@pytest.mark.parametrize("spelling", ["cluster", "Cluster", "CLUSTER"])
def test_the_scope_option_is_case_insensitive(spelling: str) -> None:
    document = _only_document(_emit(_import_fixture("01-minimal-widget.yaml"), scope=spelling))
    assert document["spec"]["scope"] == "Cluster"


@pytest.mark.parametrize(
    ("kind", "plural"),
    [("Widget", "widgets"), ("Box", "boxes"), ("Policy", "policies"), ("Mesh", "meshes")],
)
def test_plural_names_are_derived_with_regular_english_rules(kind: str, plural: str) -> None:
    api = _api([_record(kind, [_field("spec", None)])], title=kind, version="v1")
    document = _only_document(_emit(api, group="example.io"))
    assert document["spec"]["names"]["plural"] == plural
    assert document["spec"]["names"]["singular"] == kind.lower()


def test_a_dns_shaped_namespace_becomes_the_api_group() -> None:
    api = _api([_record("Widget", [_field("spec", None)])], title="Widget", namespace="acme.io")
    document = _only_document(_emit(api))
    assert document["spec"]["group"] == "acme.io"


def test_a_model_without_a_group_falls_back_and_says_so() -> None:
    api = _api([_record("Widget", [_field("spec", None)])], title="Widget")
    result = _emit(api)
    assert _only_document(result)["spec"]["group"] == "example.com"
    assert "synthesized-group" in _subjects(result, LossKind.INFERRED)


def test_a_non_kubernetes_version_is_replaced_and_reported() -> None:
    api = _api([_record("Widget", [_field("spec", None)])], title="Widget", version="1.0.0")
    result = _emit(api, group="acme.io")
    assert _only_document(result)["spec"]["versions"][0]["name"] == "v1"
    assert "synthesized-version-name" in _subjects(result, LossKind.INFERRED)


def test_the_version_option_names_the_emitted_version() -> None:
    api = _api([_record("Widget", [_field("spec", None)])], title="Widget")
    document = _only_document(_emit(api, group="acme.io", version="v2beta1"))
    assert document["spec"]["versions"][0]["name"] == "v2beta1"


# ---------------------------------------------------------------------------
# Schema construction from canonical types
# ---------------------------------------------------------------------------


def test_a_resource_shaped_record_is_emitted_as_the_root_schema() -> None:
    api = _api(
        [_record("Widget", [_field("spec", None), _field("status", None)])],
        title="Widget",
        version="v1",
    )
    result = _emit(api, group="acme.io")
    schema = _schema(_only_document(result))
    assert sorted(schema["properties"]) == ["spec", "status"]
    assert "synthesized-spec-wrapper" not in _subjects(result)


def test_a_plain_record_is_nested_under_spec_and_the_wrapping_is_reported() -> None:
    person = _record(
        "Person",
        [
            _field("firstName", "string", required=True, description="Given name."),
            _field("age", "integer", constraints=Constraints(minimum=0, maximum=150)),
        ],
        description="A person.",
    )
    result = _emit(_api([person], title="Person", version="v1"), group="acme.io")
    schema = _schema(_only_document(result))

    assert schema["required"] == ["spec"]
    spec = schema["properties"]["spec"]
    assert spec["description"] == "A person."
    assert spec["properties"]["firstName"] == {
        "type": "string",
        "description": "Given name.",
    }
    assert spec["properties"]["age"] == {"type": "integer", "minimum": 0, "maximum": 150}
    assert spec["required"] == ["firstName"]
    assert "synthesized-spec-wrapper" in _subjects(result, LossKind.INFERRED)
    validate_k8s_crd_document(result.files[0].content)


def test_named_types_are_inlined_because_structural_schemas_have_no_ref() -> None:
    address = _record("Address", [_field("city", "string", required=True)])
    person = _record("Person", [_field("spec", None), _field("address", "Address")])
    result = _emit(_api([person, address], title="Person", version="v1"), group="acme.io")
    schema = _schema(_only_document(result))
    assert schema["properties"]["address"] == {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    }
    assert "$ref" not in yaml.safe_dump(schema)


def test_a_reference_cycle_becomes_a_free_form_node_with_a_reason() -> None:
    node = _record("Node", [_field("spec", None), _field("parent", "Node")])
    result = _emit(_api([node], title="Node", version="v1"), group="acme.io")
    assert "reference-cycle" in _subjects(result, LossKind.NA)
    assert _schema(_only_document(result))["properties"]["parent"]["type"] == "object"
    validate_k8s_crd_document(result.files[0].content)


def test_an_unresolved_reference_is_reported() -> None:
    orphan = _record("Widget", [_field("spec", None), _field("owner", "Missing")])
    result = _emit(_api([orphan], title="Widget", version="v1"), group="acme.io")
    assert "unresolved-type-reference" in _subjects(result, LossKind.NA)


def test_a_union_cannot_be_expressed_and_is_reported() -> None:
    union = Type(
        key="Method",
        name="Method",
        kind=TypeKind.UNION,
        union_members=["Card", "Bank"],
    )
    payment = _record("Payment", [_field("spec", None), _field("method", "Method")])
    result = _emit(_api([payment, union], title="Payment", version="v1"), group="acme.io")
    assert "structural-union" in _subjects(result, LossKind.NA)
    detail = next(loss for loss in result.losses if loss.subject == "structural-union").detail
    assert "Card" in detail and "oneOf" in detail
    validate_k8s_crd_document(result.files[0].content)


def test_enums_arrays_and_maps_map_onto_structural_nodes() -> None:
    phase = Type(
        key="Phase",
        name="Phase",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Phase.Ready", name="Ready", value="Ready"),
            EnumValue(key="Phase.Failed", name="Failed", value="Failed"),
        ],
    )
    labels = Type(
        key="Labels",
        name="Labels",
        kind=TypeKind.MAP,
        key_type=TypeRef(name="string", nullable=False),
        value_type=TypeRef(name="string", nullable=False),
    )
    queue = _record(
        "Queue",
        [
            _field("spec", None),
            _field("phase", "Phase"),
            _field("labels", "Labels"),
            CanonicalField(
                key="field.peers",
                name="peers",
                type=TypeRef(item=TypeRef(name="string", nullable=False), nullable=True),
            ),
        ],
    )
    result = _emit(_api([queue, phase, labels], title="Queue", version="v1"), group="acme.io")
    properties = _schema(_only_document(result))["properties"]
    assert properties["phase"] == {"type": "string", "enum": ["Ready", "Failed"]}
    assert properties["labels"] == {"type": "object", "additionalProperties": {"type": "string"}}
    assert properties["peers"] == {"type": "array", "items": {"type": "string"}}
    validate_k8s_crd_document(result.files[0].content)


def test_a_map_without_a_value_type_preserves_unknown_fields() -> None:
    free = Type(key="Free", name="Free", kind=TypeKind.MAP)
    holder = _record("Holder", [_field("spec", None), _field("bag", "Free")])
    result = _emit(_api([holder, free], title="Holder", version="v1"), group="acme.io")
    assert _schema(_only_document(result))["properties"]["bag"] == {
        "type": "object",
        PRESERVE_UNKNOWN_FIELDS: True,
    }


def test_defaults_and_descriptions_are_carried() -> None:
    widget = _record(
        "Widget",
        [
            _field("spec", None),
            _field("replicas", "integer", default=3, description="How many."),
        ],
    )
    schema = _schema(_only_document(_emit(_api([widget], title="Widget"), group="acme.io")))
    assert schema["properties"]["replicas"] == {
        "type": "integer",
        "description": "How many.",
        "default": 3,
    }


# ---------------------------------------------------------------------------
# Structural restrictions reported as losses
# ---------------------------------------------------------------------------


def test_unique_items_is_dropped_with_a_reason() -> None:
    widget = _record(
        "Widget",
        [
            _field("spec", None),
            CanonicalField(
                key="field.tags",
                name="tags",
                type=TypeRef(item=TypeRef(name="string", nullable=False), nullable=True),
                constraints=Constraints(unique_items=True, min_items=1),
            ),
        ],
    )
    result = _emit(_api([widget], title="Widget"), group="acme.io")
    tags = _schema(_only_document(result))["properties"]["tags"]
    assert "uniqueItems" not in tags
    assert tags["minItems"] == 1
    assert "unique-items" in _subjects(result, LossKind.NA)
    validate_k8s_crd_document(result.files[0].content)


def test_a_format_kubernetes_does_not_know_is_dropped_with_a_reason() -> None:
    widget = _record(
        "Widget",
        [
            _field("spec", None),
            _field("iban", "string", constraints=Constraints(format="iso-13616-iban")),
            _field("home", "string", constraints=Constraints(format="hostname")),
        ],
    )
    result = _emit(_api([widget], title="Widget"), group="acme.io")
    properties = _schema(_only_document(result))["properties"]
    assert "format" not in properties["iban"]
    assert properties["home"]["format"] == "hostname"
    assert "unsupported-format" in _subjects(result, LossKind.NA)
    validate_k8s_crd_document(result.files[0].content)


def test_the_deprecated_keyword_has_no_structural_equivalent() -> None:
    widget = _record(
        "Widget",
        [_field("spec", None), _field("legacy", "string", deprecated=True)],
        deprecated=True,
    )
    result = _emit(_api([widget], title="Widget"), group="acme.io")
    assert "deprecated" not in yaml.safe_dump(_schema(_only_document(result)))
    assert _subjects(result, LossKind.NA).count("deprecated-keyword") == 2


def test_required_names_without_a_property_are_dropped_with_a_reason() -> None:
    widget = _record(
        "Widget",
        [_field("spec", None)],
        extras={"required_names": ["spec", "ghost"]},
    )
    result = _emit(_api([widget], title="Widget"), group="acme.io")
    assert _schema(_only_document(result))["required"] == ["spec"]
    assert "required-without-property" in _subjects(result, LossKind.NA)


def test_int_or_string_nodes_do_not_declare_a_type() -> None:
    widget = _record(
        "Widget",
        [
            _field("spec", None),
            _field("port", None, extras={"x_kubernetes": {INT_OR_STRING: True}}),
        ],
    )
    result = _emit(_api([widget], title="Widget"), group="acme.io")
    port = _schema(_only_document(result))["properties"]["port"]
    assert port == {INT_OR_STRING: True}
    validate_k8s_crd_document(result.files[0].content)


# ---------------------------------------------------------------------------
# Free-form nodes and the preserve-unknown-fields option
# ---------------------------------------------------------------------------


def test_free_form_nodes_prune_by_default_and_the_pruning_is_recorded() -> None:
    result = _emit(_import_fixture("02-typical-cronwidget.yaml"))
    schema = _schema(_only_document(result))
    assert schema["properties"]["spec"] == {"type": "object"}
    free_form = [loss for loss in result.losses if loss.subject == "free-form-node"]
    assert len(free_form) == 2
    assert all(loss.kind is LossKind.INFERRED for loss in free_form)
    assert "preserve_unknown_fields" in free_form[0].detail


def test_preserve_unknown_fields_keeps_contents_and_stops_reporting_pruning() -> None:
    result = _emit(_import_fixture("02-typical-cronwidget.yaml"), preserve_unknown_fields=True)
    schema = _schema(_only_document(result))
    assert schema["properties"]["spec"] == {"type": "object", PRESERVE_UNKNOWN_FIELDS: True}
    assert "free-form-node" not in _subjects(result)
    validate_k8s_crd_document(result.files[0].content)


# ---------------------------------------------------------------------------
# Printer columns
# ---------------------------------------------------------------------------


def _queue_with_marked_fields() -> CanonicalApi:
    """A record whose fields carry `printer_column` marks in three spellings."""
    queue = _record(
        "Queue",
        [
            _field("topic", "string", extras={"printer_column": True}, description="The topic."),
            _field(
                "replicas",
                "integer",
                extras={"printer_column": {"name": "Replicas", "priority": 1}},
            ),
            _field(
                "createdAt",
                "string",
                constraints=Constraints(format="date-time"),
                extras={"printer_column": True},
            ),
            _field("untouched", "string"),
        ],
    )
    return _api([queue], title="Queue", version="v1")


def test_marked_fields_become_printer_columns() -> None:
    result = _emit(_queue_with_marked_fields(), group="acme.io")
    columns = _only_document(result)["spec"]["versions"][0]["additionalPrinterColumns"]
    assert columns == [
        {"name": "topic", "type": "string", "jsonPath": ".spec.topic", "description": "The topic."},
        {"name": "Replicas", "type": "integer", "jsonPath": ".spec.replicas", "priority": 1},
        {"name": "createdAt", "type": "date", "jsonPath": ".spec.createdAt"},
    ]
    validate_k8s_crd_document(result.files[0].content)


def test_printer_columns_can_be_disabled() -> None:
    document = _only_document(_emit(_queue_with_marked_fields(), group="acme.io", printer_columns=False))
    assert "additionalPrinterColumns" not in document["spec"]["versions"][0]


def test_a_marked_field_kubernetes_cannot_render_is_reported_and_skipped() -> None:
    queue = _record(
        "Queue",
        [
            _field("spec", None),
            _field("payload", None, extras={"printer_column": True}),
        ],
    )
    result = _emit(_api([queue], title="Queue", version="v1"), group="acme.io")
    assert "printer-column-untyped" in _subjects(result, LossKind.NA)
    assert "additionalPrinterColumns" not in _only_document(result)["spec"]["versions"][0]


def test_a_column_type_kubernetes_cannot_render_is_refused() -> None:
    """A caller-declared column type is checked, not trusted onto an invalid CRD."""
    queue = _record(
        "Queue",
        [
            _field("spec", None),
            _field("payload", "string", extras={"printer_column": {"type": "object"}}),
        ],
    )
    result = _emit(_api([queue], title="Queue", version="v1"), group="acme.io")
    assert "printer-column-untyped" in _subjects(result, LossKind.NA)
    assert "additionalPrinterColumns" not in _only_document(result)["spec"]["versions"][0]


def test_a_resource_shaped_record_uses_an_unprefixed_json_path() -> None:
    queue = _record(
        "Queue",
        [
            _field("spec", None),
            _field("status", None),
            _field("phase", "string", extras={"printer_column": True}),
        ],
    )
    result = _emit(_api([queue], title="Queue", version="v1"), group="acme.io")
    columns = _only_document(result)["spec"]["versions"][0]["additionalPrinterColumns"]
    assert columns[0]["jsonPath"] == ".phase"


# ---------------------------------------------------------------------------
# Constructs a resource definition has no place for
# ---------------------------------------------------------------------------


def test_operations_channels_and_servers_are_reported_as_dropped() -> None:
    service = Service(
        key="svc",
        name="svc",
        operations=[Operation(key="op", name="op", kind=OperationKind.QUERY)],
    )
    api = _api(
        [_record("Widget", [_field("spec", None)])],
        title="Widget",
        version="v1",
        services=[service],
        channels=[Channel(key="ch", name="ch", address="events.ch")],
        servers=[Server(name="prod", url="https://api.example.com")],
    )
    subjects = _subjects(_emit(api, group="acme.io"), LossKind.NA)
    assert {"operations-dropped", "channels-dropped", "servers-dropped"} <= set(subjects)


def test_a_model_with_no_types_still_emits_an_applicable_crd() -> None:
    result = _emit(_api([], title="Empty"), group="acme.io")
    schema = _schema(_only_document(result))
    assert schema == {"type": "object", PRESERVE_UNKNOWN_FIELDS: True}
    assert "no-schema" in _subjects(result, LossKind.INFERRED)
    validate_k8s_crd_document(result.files[0].content)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def test_compact_rendering_still_produces_a_valid_crd() -> None:
    result = _emit(_import_fixture("02-typical-cronwidget.yaml"), pretty_print=False)
    validate_k8s_crd_document(result.files[0].content)


def test_provenance_marks_the_synthesized_and_defaulted_values() -> None:
    result = _emit(_import_fixture("01-minimal-widget.yaml"))
    notes = {note.pointer: note.provenance.value for note in result.provenance}
    assert notes["/apiVersion"] == "default"
    assert notes["/metadata/name"] == "inferred"
    assert notes["/spec/group"] == "source"
    assert [note.pointer for note in result.provenance] == sorted(
        note.pointer for note in result.provenance
    )


def test_every_emitted_schema_passes_the_independent_structural_checker() -> None:
    """Belt and braces: the builder's output is checked node by node, not just parsed."""
    for fixture in CORPUS_FIXTURES:
        content = _emit(_import_fixture(fixture)).files[0].content
        for document in _documents(content):
            for version in document["spec"]["versions"]:
                schema = version.get("schema", {}).get("openAPIV3Schema")
                if schema is not None:
                    assert structural_schema_violations(schema) == []


# ---------------------------------------------------------------------------
# The fidelity rule pack — FMT-2.7 (#5425)
# ---------------------------------------------------------------------------


def _pack() -> K8sCrdFidelityRulePack:
    return K8sCrdFidelityRulePack(K8sCrdEmitter.capability_profile(), K8sCrdEmitter.label)


def test_the_emitter_declares_the_crd_pack() -> None:
    assert K8sCrdEmitter.fidelity_rule_pack() is K8sCrdFidelityRulePack


def test_the_pack_drops_a_union_because_one_of_may_not_carry_a_type() -> None:
    verdict = _pack().type_verdict(
        Type(key="Shape", name="Shape", kind=TypeKind.UNION, union_members=["Widget"])
    )
    assert verdict.kind.value == "drop"
    assert verdict.target_mapping == "union → free-form node"


def test_the_pack_approximates_a_scalar_with_no_inferable_json_type() -> None:
    """The emitter writes a free-form node for it, so the pack says so first."""
    untyped = Type(key="Opaque", name="Opaque", kind=TypeKind.SCALAR)
    assert _pack().type_verdict(untyped).kind.value == "approx"
    typed = Type(
        key="Name",
        name="Name",
        kind=TypeKind.SCALAR,
        constraints=Constraints(min_length=1),
    )
    assert _pack().type_verdict(typed).kind.value == "ok"


def test_the_pack_names_the_two_validation_facets_kubernetes_refuses() -> None:
    """``constraints=True`` holds only for the facets the API server actually knows."""
    pack = _pack()
    unique = CanonicalField(
        key="Widget.tags",
        name="tags",
        type=TypeRef(name="string"),
        constraints=Constraints(unique_items=True),
    )
    assert [verdict.kind.value for verdict in pack.field_verdicts(unique)] == ["drop"]
    unknown_format = CanonicalField(
        key="Widget.urn",
        name="urn",
        type=TypeRef(name="string"),
        constraints=Constraints(format="widget-urn"),
    )
    assert [verdict.kind.value for verdict in pack.field_verdicts(unknown_format)] == ["drop"]
    known = CanonicalField(
        key="Widget.at",
        name="at",
        type=TypeRef(name="string"),
        constraints=Constraints(format="date-time"),
    )
    assert pack.field_verdicts(known) == []


def test_the_pack_drops_operations_and_channels_a_resource_definition_cannot_hold() -> None:
    pack = _pack()
    op = Operation(key="GET /widgets", name="list", kind=OperationKind.REQUEST_RESPONSE)
    assert pack.operation_verdict(op).kind.value == "drop"
    assert pack.channel_verdict(Channel(key="c", address="c")).kind.value == "drop"


def test_the_pack_declares_no_root_loss_because_a_crd_names_itself() -> None:
    """``metadata.name`` and ``spec.group`` carry the identity, so nothing is lost there."""
    assert _pack().root_verdicts(_import_fixture("02-typical-cronwidget.yaml")) == []
