"""Tests for the Gateway API ``HTTPRoute`` emitter — FMT-2.3 (#5421).

Exercises the ticket's acceptance criteria:

* **Manifests validate against the Gateway API HTTPRoute schema for the targeted
  API version.** Every corpus fixture, every emit option and every cross-format
  source is checked with
  :func:`~app.gateway_api_schema.validate_httproute_manifest`, which re-parses the
  artifact through the import adapter and then applies the CRD's own field rules
  independently of how it was produced.
* **Round-trip through the importer preserves hostnames, path patterns, methods
  and matches.** Import → emit → re-import over the whole corpus is asserted to
  leave that surface identical, and to leave the *entire* canonical model identical
  for every fixture whose filters the import did not already reduce to names.
* **Path-type mapping is symmetric with import**, proven by a shared table test
  over :data:`~app.gateway_api_parser.PATH_TYPE_KINDS` and its derived reverse, and
  by walking every path kind through a real manifest in both directions.
* **Multi-document output is byte-stable across runs**, and single-document output
  reports what merging changes.

It also covers this target's half of the shared projection in
:mod:`app.gateway_config_emitter` — the :class:`~app.gateway_config_emitter.FlavorRules`
that keep a Kubernetes name out of Kong's character set — and the registry wiring.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
import yaml

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    EmitOptions,
    EmitOptionsError,
    LossKind,
    LossTracker,
    coerce_emit_options,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from app.fileset import IntakeFileset
from app.gateway_api_emitter import (
    DOCUMENT_MODES,
    GatewayApiEmitOptions,
    GatewayApiEmitter,
    GatewayApiFidelityRulePack,
    _parse_reference,
)
from app.gateway_api_import_source import GatewayApiImportSource
from app.gateway_api_parser import PATH_KIND_TYPES, PATH_TYPE_KINDS, ROUTE_EXTRA_KEYS
from app.gateway_api_schema import (
    HTTPROUTE_VERSIONS,
    httproute_document_violations,
    validate_httproute_manifest,
)
from app.gateway_config_emitter import (
    GATEWAY_FLAVOR_RULES,
    SERVICE_NAMING_STRATEGIES,
    flavor_rules,
    plan_gateway_config,
    preserve_name,
    safe_name,
)
from app.gateway_config_model import build_path_pattern
from app.import_source import canonical_diff
from app.kong_import_source import KongImportSource

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "gateway-api"
KONG_CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "kong"

#: Every single-file valid Gateway API fixture in the shared corpus, by name.
CORPUS_FIXTURES: List[str] = sorted(
    path.name for path in CORPUS.iterdir() if path.is_file() and path.suffix == ".yaml"
)

#: The multi-file fixture, which exercises the fileset merge on the way in.
FILESET_DIR = CORPUS / "06-manifest-set"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _import(name: str) -> CanonicalApi:
    """Import one corpus fixture to a canonical model."""
    adapter = GatewayApiImportSource()
    text = (CORPUS / name).read_text(encoding="utf-8")
    return adapter.normalize(
        adapter.parse(text, source_label=f"gateway-api/{name}"), include_raw=False
    )


def _import_fileset() -> CanonicalApi:
    """Import the multi-file corpus fixture to a canonical model."""
    adapter = GatewayApiImportSource()
    fileset = IntakeFileset(
        root="routes-billing.yaml",
        members={
            path.name: path.read_text(encoding="utf-8") for path in FILESET_DIR.iterdir()
        },
    )
    return adapter.normalize(
        adapter.parse_fileset(fileset, source_label="gateway-api/06-manifest-set"),
        include_raw=False,
    )


def _emit(api: CanonicalApi, opts: Optional[GatewayApiEmitOptions] = None) -> str:
    """Emit ``api`` and return the artifact text."""
    return GatewayApiEmitter().emit(api, opts=opts).files[0].content


def _emit_documents(
    api: CanonicalApi, opts: Optional[GatewayApiEmitOptions] = None
) -> List[Dict[str, Any]]:
    """Emit ``api`` and return the parsed manifest stream."""
    return [
        document
        for document in yaml.safe_load_all(_emit(api, opts))
        if document is not None
    ]


def _losses(api: CanonicalApi, opts: Optional[GatewayApiEmitOptions] = None) -> List[Any]:
    """Emit ``api`` and return its fidelity losses."""
    return GatewayApiEmitter().emit(api, opts=opts).losses


def _subjects(api: CanonicalApi, opts: Optional[GatewayApiEmitOptions] = None) -> List[str]:
    """The loss subjects of one emission, de-duplicated and sorted."""
    return sorted({loss.subject for loss in _losses(api, opts)})


def _reimport(text: str, *, source_label: str) -> CanonicalApi:
    """Re-import an emitted artifact to a canonical model."""
    adapter = GatewayApiImportSource()
    return adapter.normalize(
        adapter.parse(text, source_label=source_label), include_raw=False
    )


def _has_filters(api: CanonicalApi) -> bool:
    """Whether any operation records a filter (whose configuration import dropped)."""
    return any(
        "plugins" in operation.extras
        for service in api.services
        for operation in service.operations
    )


def _rest_model(
    *,
    operations: Optional[List[Operation]] = None,
    servers: Optional[List[Server]] = None,
    types: Optional[List[Type]] = None,
    channels: Optional[List[Channel]] = None,
    services: Optional[List[Service]] = None,
    service_name: str = "pets",
    title: str = "Pet Store",
) -> CanonicalApi:
    """Build a hand-written REST model (a source that is *not* a gateway import)."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        protocol="http",
        identity=ApiIdentity(name=title),
        title=title,
        servers=servers if servers is not None else [Server(url="https://api.example.com")],
        services=services
        if services is not None
        else [
            Service(
                key=service_name,
                name=service_name,
                operations=operations
                if operations is not None
                else [
                    Operation(
                        key="GET /pets",
                        name="GET /pets",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path="/pets",
                    )
                ],
            )
        ],
        types=types or [],
        channels=channels or [],
    )


def _gateway_model(operations: List[Operation], *, service_name: str = "shop/orders") -> CanonicalApi:
    """Build a model that *claims* a gateway import, so parameters are match conditions."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="gateway-api",
        protocol="http",
        identity=ApiIdentity(name="orders"),
        title="orders",
        servers=[Server(url="https://shop.example.com")],
        services=[Service(key=service_name, name=service_name, operations=operations)],
        extras={"gateway": {"flavor": "gateway-api", "route_count": len(operations)}},
    )


def _surface(model: CanonicalApi) -> List[Dict[str, Any]]:
    """The routing surface the ticket names: hostnames, path patterns, methods, matches."""
    return sorted(
        (
            {
                "hosts": operation.extras.get("hosts"),
                "path": operation.http_path,
                "pattern": operation.extras.get("path_match"),
                "method": operation.http_method,
                "any_method": operation.extras.get("methods_unrestricted"),
                "matches": sorted(
                    f"{parameter.location.value}:{parameter.name}="
                    f"{parameter.extras.get('match_value', '')}"
                    for parameter in operation.parameters
                    if parameter.location
                    in (ParameterLocation.HEADER, ParameterLocation.QUERY)
                ),
                "backends": operation.extras.get("backends"),
            }
            for service in model.services
            for operation in service.operations
        ),
        key=lambda row: json.dumps(row, sort_keys=True, default=str),
    )


#: Fixtures whose filters the *import* already reduced to names: their filters are a
#: declared emit loss, so they round-trip the routing surface but not the whole model.
FILTERED_FIXTURES: List[str] = [name for name in CORPUS_FIXTURES if _has_filters(_import(name))]

#: Fixtures that must round-trip to a zero canonical diff.
FILTERLESS_FIXTURES: List[str] = [
    name for name in CORPUS_FIXTURES if name not in FILTERED_FIXTURES
]


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------


def test_the_emitter_is_registered_under_the_gateway_api_format_key() -> None:
    load_builtin_emitters()
    assert get_emitter("gateway-api") is GatewayApiEmitter


def test_the_emitter_describes_itself_as_an_export_target() -> None:
    load_builtin_emitters()
    target = next(t for t in describe_emit_targets() if t.descriptor.key == "gateway-api")
    assert target.descriptor.format == "gateway-api"
    assert target.descriptor.paradigm is ApiParadigm.REST
    assert target.descriptor.multi_file is False
    assert target.descriptor.needs_toolchain is False
    assert target.descriptor.available is True


def test_the_options_schema_documents_every_option() -> None:
    load_builtin_emitters()
    schema = GatewayApiEmitOptions.model_json_schema()
    assert set(schema["properties"]) == {
        "api_version",
        "document_mode",
        "parent_refs",
        "backend_refs",
        "namespace",
        "service_naming",
        "pretty_print",
    }
    assert all(
        field.get("description") for field in schema["properties"].values()
    ), schema["properties"]


def test_the_capability_profile_carries_operations_and_no_type_fidelity() -> None:
    profile = GatewayApiEmitter.capability_profile()
    assert profile.operations is True
    assert profile.events is False
    assert profile.unions is False
    assert profile.nullability is False
    assert profile.constraints is False
    assert profile.field_identity is False


def test_options_coerce_through_the_shared_registry_helper() -> None:
    load_builtin_emitters()
    options = coerce_emit_options(get_emitter("gateway-api"), {"document_mode": "single"})
    assert isinstance(options, GatewayApiEmitOptions)
    assert options.document_mode == "single"


# ---------------------------------------------------------------------------
# Path-type symmetry with the importer
# ---------------------------------------------------------------------------


def test_the_reverse_path_type_table_is_derived_from_the_forward_one() -> None:
    assert PATH_KIND_TYPES == {kind: name for name, kind in PATH_TYPE_KINDS.items()}


@pytest.mark.parametrize("path_type,kind", sorted(PATH_TYPE_KINDS.items()))
def test_the_path_type_table_round_trips_in_both_directions(path_type: str, kind: str) -> None:
    assert PATH_KIND_TYPES[kind] == path_type
    assert PATH_TYPE_KINDS[PATH_KIND_TYPES[kind]] == kind


@pytest.mark.parametrize(
    "path_type,value",
    [
        ("Exact", "/ping"),
        ("PathPrefix", "/users"),
        ("RegularExpression", "/users/(?<userId>[0-9]+)"),
    ],
)
def test_every_path_type_survives_an_import_export_import(path_type: str, value: str) -> None:
    manifest = yaml.safe_dump(
        {
            "apiVersion": "gateway.networking.k8s.io/v1",
            "kind": "HTTPRoute",
            "metadata": {"name": "paths"},
            "spec": {
                "rules": [
                    {
                        "matches": [{"path": {"type": path_type, "value": value}}],
                        "backendRefs": [{"name": "svc", "port": 80}],
                    }
                ]
            },
        }
    )
    api = _reimport(manifest, source_label="paths")
    emitted = yaml.safe_load(_emit(api))
    path = emitted["spec"]["rules"][0]["matches"][0]["path"]
    assert path == {"type": path_type, "value": value}
    assert canonical_diff(api, _reimport(yaml.safe_dump(emitted), source_label="paths")).entries == []


def test_a_parameterized_template_becomes_a_named_capture_regular_expression() -> None:
    """A foreign model's `/pets/{petId}` has to become a pattern the importer reads back."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets/{petId}",
                name="GET /pets/{petId}",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets/{petId}",
            )
        ]
    )
    path = _emit_documents(api)[0]["spec"]["rules"][0]["matches"][0]["path"]
    assert path["type"] == "RegularExpression"
    assert path["value"] == "/pets/(?<petId>[^\\x2f]+)$"
    assert build_path_pattern(path["value"], "regex").template == "/pets/{petId}"


def test_a_literal_template_stays_a_prefix_path() -> None:
    path = _emit_documents(_rest_model())[0]["spec"]["rules"][0]["matches"][0]["path"]
    assert path == {"type": "PathPrefix", "value": "/pets"}


def test_a_kong_regex_marker_is_stripped_and_reported() -> None:
    """Kong spells a regex `~/users/…`; a Gateway API path value has no such marker."""
    text = (KONG_CORPUS / "02-typical-single-service-auth.yaml").read_text(encoding="utf-8")
    adapter = KongImportSource()
    api = adapter.normalize(adapter.parse(text, source_label="kong"), include_raw=False)

    values = [
        match["path"]["value"]
        for document in _emit_documents(api)
        for rule in document["spec"]["rules"]
        for match in rule["matches"]
    ]
    assert values and not any(value.startswith("~") for value in values)
    assert "normalized-path-regex" in _subjects(api)


# ---------------------------------------------------------------------------
# Round trip: hostnames, path patterns, methods and matches
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_every_corpus_fixture_preserves_hostnames_paths_methods_and_matches(
    fixture: str,
) -> None:
    """The ticket's criterion, stated in its own terms rather than as a diff count."""
    api = _import(fixture)
    back = _reimport(_emit(api), source_label=f"gateway-api/{fixture}")
    assert _surface(api) == _surface(back)


@pytest.mark.parametrize("fixture", FILTERLESS_FIXTURES)
def test_every_filterless_corpus_fixture_round_trips_without_a_canonical_diff(
    fixture: str,
) -> None:
    api = _import(fixture)
    back = _reimport(_emit(api), source_label=f"gateway-api/{fixture}")
    diff = canonical_diff(api, back)
    assert diff.entries == [], [entry.model_dump() for entry in diff.entries]


def test_the_corpus_exercises_both_the_filtered_and_the_filterless_case() -> None:
    assert FILTERED_FIXTURES and FILTERLESS_FIXTURES
    assert sorted(FILTERED_FIXTURES + FILTERLESS_FIXTURES) == CORPUS_FIXTURES


def test_a_fixture_with_filters_loses_only_the_operations_that_carried_them() -> None:
    api = _import("04-stress-filters-matches.yaml")
    back = _reimport(_emit(api), source_label="gateway-api/04-stress-filters-matches.yaml")

    filtered = {
        operation.key
        for service in api.services
        for operation in service.operations
        if "plugins" in operation.extras
    }
    assert filtered
    assert {entry.key for entry in canonical_diff(api, back).entries} == filtered
    assert "filter-configuration" in _subjects(api)


def test_the_multi_file_fixture_round_trips_into_one_manifest_stream() -> None:
    """A manifest directory merges on import; the emitter writes it back as one file."""
    api = _import_fileset()
    emitted = _emit(api)
    assert len(_emit_documents(api)) == 2
    back = _reimport(emitted, source_label="gateway-api/06-manifest-set")
    assert canonical_diff(api, back).entries == []


def test_a_namespaced_resource_splits_back_into_metadata() -> None:
    document = _emit_documents(_import("02-typical-hostnames-methods.yaml"))[0]
    assert document["metadata"] == {"name": "users", "namespace": "identity"}


def test_hostnames_and_parent_refs_are_written_back_verbatim() -> None:
    document = _emit_documents(_import("02-typical-hostnames-methods.yaml"))[0]
    assert document["spec"]["hostnames"] == ["api.example.com"]
    assert document["spec"]["parentRefs"] == [
        {"name": "main-gateway", "namespace": "gateway-system"}
    ]


def test_backend_weights_and_ports_are_written_back_verbatim() -> None:
    document = next(
        doc
        for doc in _emit_documents(_import("04-stress-filters-matches.yaml"))
        for rule in doc["spec"]["rules"]
        if len(rule.get("backendRefs", [])) > 1
    )
    backends = document["spec"]["rules"][0]["backendRefs"]
    assert backends == [
        {"name": "reports-svc", "port": 8080, "weight": 90},
        {"name": "reports-canary", "port": 8080, "weight": 10},
    ]


def test_one_rule_carries_every_match_of_its_group() -> None:
    """Two methods on one path import as two operations and must emit as one rule."""
    rules = _emit_documents(_import("02-typical-hostnames-methods.yaml"))[0]["spec"]["rules"]
    assert len(rules) == 2
    assert [match["method"] for match in rules[0]["matches"]] == ["GET", "POST"]


def test_the_source_rule_order_is_restored_from_the_route_names() -> None:
    """Canonical operations sort by key, so rule order has to come from the route names."""
    manifest = yaml.safe_dump(
        {
            "apiVersion": "gateway.networking.k8s.io/v1",
            "kind": "HTTPRoute",
            "metadata": {"name": "ordered"},
            "spec": {
                "rules": [
                    {
                        "matches": [{"path": {"type": "PathPrefix", "value": "/zebra"}}],
                        "backendRefs": [{"name": "zebra", "port": 80}],
                    },
                    {
                        "matches": [{"path": {"type": "PathPrefix", "value": "/apple"}}],
                        "backendRefs": [{"name": "apple", "port": 80}],
                    },
                ]
            },
        }
    )
    api = _reimport(manifest, source_label="ordered")
    rules = _emit_documents(api)[0]["spec"]["rules"]
    assert [rule["matches"][0]["path"]["value"] for rule in rules] == ["/zebra", "/apple"]
    assert canonical_diff(api, _reimport(_emit(api), source_label="ordered")).entries == []


def test_a_rule_that_matches_any_method_emits_no_method() -> None:
    documents = _emit_documents(_import("05-real-world-microservices.yaml"))
    checkout = next(doc for doc in documents if doc["metadata"]["name"] == "checkout")
    assert "method" not in checkout["spec"]["rules"][0]["matches"][0]


def test_header_and_query_matches_survive_the_round_trip() -> None:
    document = _emit_documents(_import("04-stress-filters-matches.yaml"))[0]
    match = document["spec"]["rules"][0]["matches"][0]
    assert match["headers"] == [{"name": "x-tenant", "value": "acme"}]
    assert match["queryParams"] == [{"name": "window", "value": "30d"}]


@pytest.mark.parametrize("key", ROUTE_EXTRA_KEYS)
def test_every_readable_route_attribute_is_also_writable(key: str) -> None:
    """A key the parser reads but the emitter cannot write would vanish silently."""
    api = _import("02-typical-hostnames-methods.yaml")
    recorded = {
        key
        for service in api.services
        for operation in service.operations
        for key in operation.extras
    }
    assert key in recorded, f"the fixture does not exercise {key!r}"
    back = _reimport(
        _emit(api), source_label="gateway-api/02-typical-hostnames-methods.yaml"
    )
    assert canonical_diff(api, back).entries == []


# ---------------------------------------------------------------------------
# Schema validation of every emitted artifact
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_every_emitted_corpus_fixture_passes_schema_validation(fixture: str) -> None:
    validate_httproute_manifest(_emit(_import(fixture)), source_label=fixture)


def test_the_multi_file_fixture_emits_a_valid_manifest() -> None:
    validate_httproute_manifest(_emit(_import_fileset()), source_label="manifest-set")


def test_a_cross_format_model_emits_a_valid_manifest() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
                messages=[
                    Message(
                        key="GET /pets#response",
                        role=MessageRole.RESPONSE,
                        payload=TypeRef(name="Pet"),
                    )
                ],
            )
        ],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    validate_httproute_manifest(_emit(api), source_label="cross-format")


def test_a_kong_model_emits_a_valid_manifest() -> None:
    adapter = KongImportSource()
    for path in sorted(KONG_CORPUS.glob("*.yaml")):
        text = path.read_text(encoding="utf-8")
        api = adapter.normalize(adapter.parse(text, source_label=path.name), include_raw=False)
        validate_httproute_manifest(_emit(api), source_label=path.name)


@pytest.mark.parametrize("version", HTTPROUTE_VERSIONS)
def test_every_targeted_api_version_emits_a_valid_manifest(version: str) -> None:
    api = _import("02-typical-hostnames-methods.yaml")
    options = GatewayApiEmitOptions(api_version=version)
    emitted = _emit(api, options)
    assert f"gateway.networking.k8s.io/{version}" in emitted
    validate_httproute_manifest(emitted, source_label=version)


# ---------------------------------------------------------------------------
# Output layout and determinism
# ---------------------------------------------------------------------------


def test_a_single_resource_emits_one_document_without_a_separator() -> None:
    emitted = _emit(_import("01-minimal-httproute.yaml"))
    assert not emitted.startswith("---")
    assert len(_emit_documents(_import("01-minimal-httproute.yaml"))) == 1


def test_several_resources_emit_a_separated_document_stream() -> None:
    emitted = _emit(_import("03-multi-route-stream.yaml"))
    assert emitted.startswith("---")
    assert len(_emit_documents(_import("03-multi-route-stream.yaml"))) == 2


def test_single_document_mode_merges_every_rule_into_one_resource() -> None:
    api = _import("03-multi-route-stream.yaml")
    documents = _emit_documents(api, GatewayApiEmitOptions(document_mode="single"))
    assert len(documents) == 1
    assert len(documents[0]["spec"]["rules"]) == 2
    validate_httproute_manifest(
        _emit(api, GatewayApiEmitOptions(document_mode="single")), source_label="single"
    )


def test_single_document_mode_reports_the_hostnames_it_widens() -> None:
    api = _import("05-real-world-microservices.yaml")
    options = GatewayApiEmitOptions(document_mode="single")
    document = _emit_documents(api, options)[0]
    assert sorted(document["spec"]["hostnames"]) == [
        "api.internal.acme-shop.example",
        "www.acme-shop.example",
    ]
    assert "widened-hostnames" in _subjects(api, options)


def test_single_document_mode_leaves_a_lone_resource_alone() -> None:
    api = _import("01-minimal-httproute.yaml")
    assert _emit(api, GatewayApiEmitOptions(document_mode="single")) == _emit(api)


@pytest.mark.parametrize("mode", DOCUMENT_MODES)
@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_emission_is_byte_stable(fixture: str, mode: str) -> None:
    api = _import(fixture)
    options = GatewayApiEmitOptions(document_mode=mode)
    assert _emit(api, options) == _emit(_import(fixture), options)


def test_compact_output_is_still_re_importable() -> None:
    api = _import("02-typical-hostnames-methods.yaml")
    emitted = _emit(api, GatewayApiEmitOptions(pretty_print=False))
    back = _reimport(
        emitted, source_label="gateway-api/02-typical-hostnames-methods.yaml"
    )
    assert canonical_diff(api, back).entries == []


def test_the_output_file_is_named_after_a_lone_resource() -> None:
    result = GatewayApiEmitter().emit(_import("01-minimal-httproute.yaml"))
    assert result.files[0].path == "ping.httproute.yaml"
    assert result.files[0].media_type == "application/yaml"
    assert result.media_type == "application/yaml"


def test_the_output_file_is_named_after_the_artifact_for_a_stream() -> None:
    result = GatewayApiEmitter().emit(_import("03-multi-route-stream.yaml"))
    assert result.files[0].path == "gateway-api-03-multi-route-stream.httproute.yaml"


def test_provenance_is_sorted_and_deterministic() -> None:
    api = _import("05-real-world-microservices.yaml")
    first = GatewayApiEmitter().emit(api).provenance
    second = GatewayApiEmitter().emit(api).provenance
    assert [record.model_dump() for record in first] == [
        record.model_dump() for record in second
    ]
    assert [record.pointer for record in first] == sorted(
        record.pointer for record in first
    )


def test_the_api_version_is_recorded_as_a_default() -> None:
    records = GatewayApiEmitter().emit(_import(CORPUS_FIXTURES[0])).provenance
    version = next(r for r in records if r.pointer.endswith("/apiVersion"))
    assert version.provenance.value == "default"


def test_resource_names_recovered_from_a_gateway_import_are_source_provenance() -> None:
    records = GatewayApiEmitter().emit(_import(CORPUS_FIXTURES[0])).provenance
    names = [r for r in records if r.pointer.endswith("/metadata/name")]
    assert names and all(record.provenance.value == "source" for record in names)


def test_resource_names_derived_for_a_foreign_model_are_inferred_provenance() -> None:
    records = GatewayApiEmitter().emit(_rest_model()).provenance
    names = [r for r in records if r.pointer.endswith("/metadata/name")]
    assert names and all(record.provenance.value == "inferred" for record in names)


def test_losses_are_deterministic() -> None:
    api = _import("04-stress-filters-matches.yaml")
    first = [loss.model_dump() for loss in _losses(api)]
    second = [loss.model_dump() for loss in _losses(api)]
    assert first == second


# ---------------------------------------------------------------------------
# Emit options
# ---------------------------------------------------------------------------


def test_parent_refs_from_the_options_reach_a_model_that_declares_none() -> None:
    api = _import("01-minimal-httproute.yaml")
    options = GatewayApiEmitOptions(parent_refs=["gateway-system/main-gateway:https"])
    document = _emit_documents(api, options)[0]
    assert document["spec"]["parentRefs"] == [
        {"name": "main-gateway", "namespace": "gateway-system", "sectionName": "https"}
    ]
    validate_httproute_manifest(_emit(api, options), source_label="parents")


def test_a_declared_parent_ref_wins_over_the_option() -> None:
    api = _import("02-typical-hostnames-methods.yaml")
    options = GatewayApiEmitOptions(parent_refs=["other-gateway"])
    document = _emit_documents(api, options)[0]
    assert document["spec"]["parentRefs"] == [
        {"name": "main-gateway", "namespace": "gateway-system"}
    ]


def test_a_numeric_parent_ref_section_is_read_as_a_port() -> None:
    api = _import("01-minimal-httproute.yaml")
    options = GatewayApiEmitOptions(parent_refs=["main-gateway:443"])
    document = _emit_documents(api, options)[0]
    assert document["spec"]["parentRefs"] == [{"name": "main-gateway", "port": 443}]


def test_backend_refs_from_the_options_reach_a_model_that_declares_none() -> None:
    api = _rest_model()
    options = GatewayApiEmitOptions(backend_refs=["commerce/orders:8080@90", "canary:8080@10"])
    rule = _emit_documents(api, options)[0]["spec"]["rules"][0]
    assert rule["backendRefs"] == [
        {"name": "orders", "namespace": "commerce", "port": 8080, "weight": 90},
        {"name": "canary", "port": 8080, "weight": 10},
    ]
    validate_httproute_manifest(_emit(api, options), source_label="backends")


def test_a_declared_backend_wins_over_the_option() -> None:
    api = _import("01-minimal-httproute.yaml")
    options = GatewayApiEmitOptions(backend_refs=["other-svc:9090"])
    rule = _emit_documents(api, options)[0]["spec"]["rules"][0]
    assert rule["backendRefs"] == [{"name": "ping-svc", "port": 8080}]


def test_a_reference_the_grammar_cannot_read_is_refused_by_the_parser() -> None:
    """The option validator rejects it first; the reader refuses it too, for direct callers."""
    with pytest.raises(EmitOptionsError):
        _parse_reference("a/b/c", port_from_section=True)


def test_a_backend_ref_section_that_is_not_a_port_is_refused() -> None:
    with pytest.raises(EmitOptionsError):
        GatewayApiEmitter().emit(
            _rest_model(), opts=GatewayApiEmitOptions(backend_refs=["svc:https"])
        )


def test_the_namespace_option_reaches_a_model_that_declares_none() -> None:
    api = _import("01-minimal-httproute.yaml")
    options = GatewayApiEmitOptions(namespace="platform")
    assert _emit_documents(api, options)[0]["metadata"]["namespace"] == "platform"


def test_a_declared_namespace_wins_over_the_option() -> None:
    api = _import("02-typical-hostnames-methods.yaml")
    options = GatewayApiEmitOptions(namespace="platform")
    assert _emit_documents(api, options)[0]["metadata"]["namespace"] == "identity"


def test_no_namespace_is_emitted_when_nothing_names_one() -> None:
    assert "namespace" not in _emit_documents(_import("01-minimal-httproute.yaml"))[0]["metadata"]


@pytest.mark.parametrize("strategy", SERVICE_NAMING_STRATEGIES)
def test_every_service_naming_strategy_emits_a_valid_manifest(strategy: str) -> None:
    api = _import("05-real-world-microservices.yaml")
    validate_httproute_manifest(
        _emit(api, GatewayApiEmitOptions(service_naming=strategy)), source_label=strategy
    )


def test_the_slug_strategy_lower_cases_a_prose_service_name() -> None:
    api = _rest_model(service_name="Pet Store", title="Pet Store")
    options = GatewayApiEmitOptions(service_naming="slug")
    assert _emit_documents(api, options)[0]["metadata"]["name"] == "pet-store"


@pytest.mark.parametrize(
    "field,value",
    [
        ("api_version", "v1alpha2"),
        ("document_mode", "per-file"),
        ("service_naming", "namespace"),
        ("parent_refs", ["a/b/c"]),
        ("backend_refs", ["svc:80:90"]),
    ],
)
def test_an_unknown_option_value_is_refused(field: str, value: Any) -> None:
    with pytest.raises(ValueError):
        GatewayApiEmitOptions(**{field: value})


def test_invalid_options_raise_an_emit_options_error() -> None:
    class _Foreign(EmitOptions):
        document_mode: str = "per-file"

    with pytest.raises(EmitOptionsError):
        GatewayApiEmitter().emit(_rest_model(), opts=_Foreign())


# ---------------------------------------------------------------------------
# Fidelity: what a routing surface cannot carry
# ---------------------------------------------------------------------------


def test_every_message_body_is_reported_as_a_loss() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="POST /pets",
                name="POST /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="POST",
                http_path="/pets",
                messages=[
                    Message(
                        key="POST /pets#request",
                        role=MessageRole.REQUEST,
                        payload=TypeRef(name="Pet"),
                    ),
                    Message(
                        key="POST /pets#response",
                        role=MessageRole.RESPONSE,
                        payload=TypeRef(name="Pet"),
                    ),
                ],
            )
        ]
    )
    bodies = [loss for loss in _losses(api) if loss.subject == "message-schema"]
    assert len(bodies) == 2
    assert all(loss.kind is LossKind.NA for loss in bodies)


def test_named_types_and_channels_are_reported_as_losses() -> None:
    api = _rest_model(
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
        channels=[Channel(key="pets", address="pets")],
    )
    assert {"named-type", "event-channel"} <= set(_subjects(api))


def test_the_artifact_title_is_a_declared_loss() -> None:
    assert "artifact-title" in _subjects(_import("01-minimal-httproute.yaml"))


def test_a_filter_is_reported_rather_than_emitted_without_its_configuration() -> None:
    api = _import("04-stress-filters-matches.yaml")
    filters = [loss for loss in _losses(api) if loss.subject == "filter-configuration"]
    assert filters and all(loss.kind is LossKind.NA for loss in filters)
    assert all(
        "filters" not in rule
        for document in _emit_documents(api)
        for rule in document["spec"]["rules"]
    )


def test_canonical_security_is_reported_rather_than_invented() -> None:
    """The Gateway API core has no auth filter, so a Kong auth plugin has nowhere to go."""
    text = (KONG_CORPUS / "02-typical-single-service-auth.yaml").read_text(encoding="utf-8")
    adapter = KongImportSource()
    api = adapter.normalize(adapter.parse(text, source_label="kong"), include_raw=False)
    assert "unsupported-auth" in _subjects(api)
    assert "filters" not in _emit(api)


def test_a_route_attribute_the_manifest_cannot_carry_is_reported() -> None:
    """Kong's `strip_path` and friends have no HTTPRoute field."""
    text = (KONG_CORPUS / "02-typical-single-service-auth.yaml").read_text(encoding="utf-8")
    adapter = KongImportSource()
    api = adapter.normalize(adapter.parse(text, source_label="kong"), include_raw=False)
    losses = [loss for loss in _losses(api) if loss.subject == "unmapped-route-attribute"]
    assert losses and any("strip_path" in loss.detail for loss in losses)


def test_a_host_carrying_a_port_is_normalized_and_reported() -> None:
    api = _rest_model(servers=[Server(url="http://Localhost:8000")])
    document = _emit_documents(api)[0]
    assert document["spec"]["hostnames"] == ["localhost"]
    assert "normalized-hostname" in _subjects(api)


def test_a_host_that_cannot_be_a_hostname_is_dropped_and_reported() -> None:
    api = _rest_model(servers=[Server(url="http://[2001:db8::1]:8080")])
    document = _emit_documents(api)[0]
    assert "hostnames" not in document["spec"]
    assert "unroutable-host" in _subjects(api)


def test_a_synthesized_backend_reference_is_reported() -> None:
    api = _rest_model()
    rule = _emit_documents(api)[0]["spec"]["rules"][0]
    assert rule["backendRefs"] == [{"name": "pets"}]
    assert "synthesized-backend-ref" in _subjects(api)


def test_a_method_outside_the_gateway_api_vocabulary_drops_its_match_not_its_verb() -> None:
    """Emitting the match without the method would route every verb to that rule."""
    api = _rest_model(
        operations=[
            Operation(
                key="PURGE /cache",
                name="PURGE /cache",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="PURGE",
                http_path="/cache",
            ),
            Operation(
                key="GET /cache",
                name="GET /cache",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/cache",
            ),
        ]
    )
    rules = _emit_documents(api)[0]["spec"]["rules"]
    assert [match["method"] for rule in rules for match in rule["matches"]] == ["GET"]
    assert {"unsupported-method", "unroutable-rule"} <= set(_subjects(api))


def test_a_valueless_match_condition_is_reported_rather_than_invented() -> None:
    """A Gateway API match value has minLength 1; "header present" has no spelling."""
    api = _gateway_model(
        [
            Operation(
                key="GET /orders",
                name="GET /orders",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/orders",
                parameters=[
                    Parameter(
                        key="GET /orders#header.x-tenant",
                        name="x-tenant",
                        location=ParameterLocation.HEADER,
                        required=True,
                        type=TypeRef(name="string"),
                    )
                ],
                extras={"gateway_route": "orders", "hosts": ["shop.example.com"]},
            )
        ]
    )
    match = _emit_documents(api)[0]["spec"]["rules"][0]["matches"][0]
    assert "headers" not in match
    assert "valueless-match" in _subjects(api)


def test_an_operation_with_no_http_path_is_reported_as_unroutable() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="Pets.Watch",
                name="Watch",
                kind=OperationKind.REQUEST_RESPONSE,
            ),
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
            ),
        ]
    )
    assert "unroutable-operation" in _subjects(api)


def test_a_model_with_no_routable_operation_is_refused_rather_than_emitted_empty() -> None:
    api = _rest_model(
        operations=[
            Operation(key="Pets.Watch", name="Watch", kind=OperationKind.REQUEST_RESPONSE)
        ]
    )
    with pytest.raises(ValueError, match="at least one HTTP operation"):
        GatewayApiEmitter().emit(api)


def test_a_model_whose_every_match_is_unrepresentable_is_refused() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="PURGE /cache",
                name="PURGE /cache",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="PURGE",
                http_path="/cache",
            )
        ]
    )
    with pytest.raises(ValueError, match="no HTTPRoute"):
        GatewayApiEmitter().emit(api)


# ---------------------------------------------------------------------------
# Kubernetes name spelling
# ---------------------------------------------------------------------------


def test_a_service_name_kubernetes_forbids_is_sanitized_and_reported() -> None:
    api = _rest_model(service_name="Pet Store", title="Pet Store")
    document = _emit_documents(api)[0]
    assert document["metadata"]["name"] == "pet-store"
    assert httproute_document_violations(document) == []
    assert "sanitized-resource-name" in _subjects(api)


def test_two_services_that_sanitize_to_one_name_are_de_duplicated() -> None:
    api = _rest_model(
        services=[
            Service(
                key=name,
                name=name,
                operations=[
                    Operation(
                        key=f"GET /{index}",
                        name=f"GET /{index}",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path=f"/{index}",
                    )
                ],
            )
            for index, name in enumerate(["Pet Store", "pet.store"])
        ]
    )
    names = [document["metadata"]["name"] for document in _emit_documents(api)]
    assert sorted(names) == ["pet-store", "pet.store"]

    collide = _rest_model(
        services=[
            Service(
                key=key,
                name=name,
                operations=[
                    Operation(
                        key=f"GET /{key}",
                        name=f"GET /{key}",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path=f"/{key}",
                    )
                ],
            )
            for key, name in [("a", "Pet Store"), ("b", "pet store")]
        ]
    )
    assert [doc["metadata"]["name"] for doc in _emit_documents(collide)] == [
        "pet-store",
        "pet-store-2",
    ]
    assert "deduplicated-resource-name" in _subjects(collide)


def test_a_namespace_kubernetes_forbids_is_sanitized_and_reported() -> None:
    api = _import("02-typical-hostnames-methods.yaml")
    options = GatewayApiEmitOptions(namespace="Platform Team")
    other = _rest_model()
    assert _emit_documents(other, options)[0]["metadata"]["namespace"] == "platform-team"
    assert "sanitized-namespace" in _subjects(other, options)
    # A declared namespace is already legal and is untouched.
    assert _emit_documents(api)[0]["metadata"]["namespace"] == "identity"


# ---------------------------------------------------------------------------
# The shared projection's flavor rules
# ---------------------------------------------------------------------------


def test_the_gateway_api_flavor_keeps_the_names_the_renderer_has_to_split() -> None:
    rules = flavor_rules("gateway-api")
    assert rules.entity_name is preserve_name
    assert rules.require_upstream is False


def test_the_kong_flavor_still_sanitizes_names_and_needs_an_upstream() -> None:
    rules = flavor_rules("kong")
    assert rules.entity_name is safe_name
    assert rules.require_upstream is True


def test_an_unknown_flavor_gets_the_conservative_default() -> None:
    assert flavor_rules("not-a-flavor") == GATEWAY_FLAVOR_RULES["kong"]


def test_every_flavor_the_parsers_produce_has_rules() -> None:
    assert set(GATEWAY_FLAVOR_RULES) == {"kong", "gateway-api"}


def test_the_projection_keeps_a_namespaced_service_name_intact() -> None:
    api = _import("02-typical-hostnames-methods.yaml")
    document = plan_gateway_config(api, flavor="gateway-api", losses=LossTracker())
    assert [route.service_name for route in document.routes] == [
        "identity/users",
        "identity/users",
    ]
    assert [route.name for route in document.routes] == ["users#rule-0", "users#rule-1"]


def test_the_projection_invents_no_upstream_for_a_flavor_that_needs_none() -> None:
    losses = LossTracker()
    document = plan_gateway_config(
        _rest_model(), flavor="gateway-api", losses=losses
    )
    assert all(service.url is None for service in document.services)
    assert "synthesized-upstream" not in {loss.subject for loss in losses.records()}


# ---------------------------------------------------------------------------
# The fidelity rule pack — FMT-2.7 (#5425)
# ---------------------------------------------------------------------------


def _pack() -> GatewayApiFidelityRulePack:
    return GatewayApiFidelityRulePack(
        GatewayApiEmitter.capability_profile(), GatewayApiEmitter.label
    )


def test_the_emitter_declares_the_httproute_pack() -> None:
    assert GatewayApiEmitter.fidelity_rule_pack() is GatewayApiFidelityRulePack


def test_the_pack_declares_the_artifact_title_a_manifest_has_no_field_for() -> None:
    """``metadata.name`` names the resource, so it cannot stand in for the title."""
    verdicts = _pack().root_verdicts(_rest_model(title="Pet Store"))
    assert [verdict.kind.value for verdict in verdicts] == ["approx"]
    assert "metadata.name" in verdicts[0].message


def test_the_pack_claims_no_title_loss_when_the_model_has_no_title() -> None:
    assert _pack().root_verdicts(_rest_model(title="")) == []


def test_the_pack_drops_every_named_type_and_says_nothing_per_field() -> None:
    pack = _pack()
    assert pack.type_verdict(Type(key="Pet", name="Pet", kind=TypeKind.RECORD)).kind.value == (
        "drop"
    )
    field = CanonicalField(key="Pet.id", name="id", type=TypeRef(name="string", nullable=False))
    assert pack.field_verdicts(field) == []


def test_the_pack_approximates_a_method_outside_the_gateway_api_vocabulary() -> None:
    """An unknown method's match is not emitted, so the rule widens to the whole path."""
    pack = _pack()
    fetch = Operation(
        key="FETCH /pets",
        name="FETCH /pets",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="FETCH",
        http_path="/pets",
    )
    verdict = pack.operation_verdict(fetch)
    assert verdict.kind.value == "approx"
    assert verdict.target_mapping == "unknown method → path-only match"


def test_the_pack_keeps_a_routable_operation_and_drops_the_rest() -> None:
    pack = _pack()
    routed = Operation(
        key="GET /pets",
        name="GET /pets",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/pets",
    )
    assert pack.operation_verdict(routed).kind.value == "ok"
    rpc = Operation(key="Rpc.call", name="call", kind=OperationKind.REQUEST_RESPONSE)
    assert pack.operation_verdict(rpc).kind.value == "drop"
    assert pack.channel_verdict(Channel(key="c", address="c")).kind.value == "drop"
