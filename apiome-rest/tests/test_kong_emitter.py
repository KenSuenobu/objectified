"""Tests for the Kong declarative-configuration emitter — FMT-2.2 (#5420).

Exercises the ticket's acceptance criteria:

* **Emitted config is accepted by the vendored ``deck validate``.** Every fixture
  in the shared corpus, every emit option and every cross-format source is checked
  with :func:`~app.kong_deck_schema.validate_kong_declarative_document`, which
  re-parses the artifact through the import adapter and then applies the deck
  entity rules independently of how it was produced.
* **Round-trip through the ``kong`` importer preserves routes, hosts, methods and
  matches.** Import → emit → re-import over the whole corpus is asserted to leave
  every service and operation identical, by canonical key.
* **The security mapping is symmetric with the importer's**, proven by a shared
  table test over :data:`~app.gateway_config_model.KONG_AUTH_PLUGIN_SCHEMES` and
  its derived reverse.
* **Schema loss is declared in the capability profile and reported per construct.**

It also covers the shared projection in :mod:`app.gateway_config_emitter`, which
FMT-2.3's HTTPRoute emitter inherits, and the emitter's registry wiring.
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
    coerce_emit_options,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from app.fileset import IntakeFileset
from app.gateway_config_emitter import (
    PLACEHOLDER_UPSTREAM,
    SERVICE_NAMING_STRATEGIES,
    auth_hints_from_extras,
    plan_gateway_config,
    safe_name,
    server_host_schemes,
    slug_name,
    template_path_pattern,
)
from app.gateway_config_model import (
    KONG_AUTH_PLUGIN_SCHEMES,
    KONG_SCHEME_AUTH_PLUGINS,
    build_path_pattern,
)
from app.import_source import canonical_diff
from app.kong_deck_schema import deck_document_violations, validate_kong_declarative_document
from app.kong_emitter import KongEmitOptions, KongEmitter
from app.kong_import_source import KongImportSource
from app.kong_parser import ROUTE_EXTRA_KEYS, SERVICE_EXTRA_KEYS

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "kong"

#: Every single-file valid Kong fixture in the shared corpus, by relative name.
CORPUS_FIXTURES: List[str] = sorted(
    path.name
    for path in CORPUS.iterdir()
    if path.is_file() and path.suffix in (".yaml", ".yml", ".json")
)

#: The multi-file fixture, which exercises the fileset merge on the way in.
FILESET_DIR = CORPUS / "06-split-set"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _import(name: str) -> CanonicalApi:
    """Import one corpus fixture to a canonical model."""
    adapter = KongImportSource()
    text = (CORPUS / name).read_text(encoding="utf-8")
    return adapter.normalize(
        adapter.parse(text, source_label=f"kong/{name}"), include_raw=False
    )


def _import_fileset() -> CanonicalApi:
    """Import the multi-file corpus fixture to a canonical model."""
    adapter = KongImportSource()
    members = {path.name: path.read_text(encoding="utf-8") for path in FILESET_DIR.iterdir()}
    fileset = IntakeFileset.from_members(members, root="kong-services.yaml")
    return adapter.normalize(
        adapter.parse_fileset(fileset, source_label="kong/06-split-set"), include_raw=False
    )


def _emit(api: CanonicalApi, opts: Optional[KongEmitOptions] = None) -> str:
    """Emit ``api`` and return the artifact text."""
    return KongEmitter().emit(api, opts=opts).files[0].content


def _emit_document(api: CanonicalApi, opts: Optional[KongEmitOptions] = None) -> Dict[str, Any]:
    """Emit ``api`` and return the parsed artifact."""
    return yaml.safe_load(_emit(api, opts))


def _reimport(text: str, *, source_label: str) -> CanonicalApi:
    """Re-import an emitted artifact to a canonical model."""
    adapter = KongImportSource()
    return adapter.normalize(
        adapter.parse(text, source_label=source_label), include_raw=False
    )


def _rest_model(
    *,
    operations: Optional[List[Operation]] = None,
    servers: Optional[List[Server]] = None,
    types: Optional[List[Type]] = None,
    channels: Optional[List[Channel]] = None,
    service_name: str = "pets",
    service_extras: Optional[Dict[str, Any]] = None,
    title: str = "Pet API",
    description: Optional[str] = None,
    version: Optional[str] = None,
) -> CanonicalApi:
    """Build a hand-written REST model (a source that is *not* a gateway import)."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        protocol="http",
        identity=ApiIdentity(name=title),
        title=title,
        description=description,
        version=version,
        servers=servers if servers is not None else [Server(url="https://api.example.com")],
        services=[
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
                extras=service_extras or {},
            )
        ],
        types=types or [],
        channels=channels or [],
    )


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------


def test_the_emitter_is_registered_under_the_kong_format_key() -> None:
    load_builtin_emitters()
    assert get_emitter("kong") is KongEmitter


def test_the_emitter_describes_itself_as_an_export_target() -> None:
    load_builtin_emitters()
    target = next(t for t in describe_emit_targets() if t.descriptor.key == "kong")
    assert target.descriptor.format == "kong"
    assert target.descriptor.paradigm is ApiParadigm.REST
    assert target.descriptor.multi_file is False
    assert target.descriptor.needs_toolchain is False
    assert target.descriptor.available is True


def test_the_options_schema_documents_every_option() -> None:
    load_builtin_emitters()
    target = next(t for t in describe_emit_targets() if t.descriptor.key == "kong")
    properties = target.options_schema["properties"]
    assert set(properties) == {
        "format_version",
        "emit_plugins",
        "service_naming",
        "output_format",
        "pretty_print",
    }
    assert all(properties[name].get("description") for name in properties)
    assert target.default_options["format_version"] == "3.0"
    assert target.default_options["service_naming"] == "preserve"


# ---------------------------------------------------------------------------
# The capability profile states the schema loss
# ---------------------------------------------------------------------------


def test_the_capability_profile_carries_operations_and_no_type_fidelity() -> None:
    """A routing surface carries operations and nothing about their payloads."""
    profile = KongEmitter.capability_profile()
    assert profile.operations is True
    assert profile.events is False
    assert profile.unions is False
    assert profile.nullability is False
    assert profile.constraints is False
    assert profile.field_identity is False


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
                    Message(key="POST /pets#request", role=MessageRole.REQUEST),
                    Message(
                        key="POST /pets#response.200",
                        role=MessageRole.RESPONSE,
                        status_code="200",
                    ),
                ],
            )
        ]
    )
    losses = KongEmitter().emit(api).losses
    bodies = [loss for loss in losses if loss.subject == "message-schema"]
    assert {loss.pointer for loss in bodies} == {"POST /pets#request", "POST /pets#response.200"}
    assert all(loss.kind is LossKind.NA for loss in bodies)


def test_named_types_and_channels_are_reported_as_losses() -> None:
    api = _rest_model(
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
        channels=[Channel(key="pets/created", address="pets/created")],
    )
    subjects = {loss.subject for loss in KongEmitter().emit(api).losses}
    assert "named-type" in subjects
    assert "event-channel" in subjects


def test_the_artifact_title_is_a_declared_loss() -> None:
    """deck has no title field, and the emitter says so instead of inventing one."""
    losses = KongEmitter().emit(_import(CORPUS_FIXTURES[0])).losses
    title_loss = next(loss for loss in losses if loss.subject == "artifact-title")
    assert title_loss.kind is LossKind.NA
    assert "no field for the artifact title" in title_loss.detail


def test_the_description_and_version_are_declared_losses() -> None:
    api = _rest_model(description="A pet store", version="1.4.0")
    subjects = {loss.subject for loss in KongEmitter().emit(api).losses}
    assert "artifact-description" in subjects
    assert "artifact-version" in subjects


def test_losses_are_deterministic() -> None:
    api = _import("04-stress-plugin-heavy.yaml")
    first = KongEmitter().emit(api).losses
    second = KongEmitter().emit(api).losses
    assert [loss.model_dump() for loss in first] == [loss.model_dump() for loss in second]


# ---------------------------------------------------------------------------
# The security mapping is symmetric with the importer's
# ---------------------------------------------------------------------------


def test_the_reverse_plugin_table_is_derived_from_the_forward_one() -> None:
    """The shared-table test: neither direction may name a mapping the other lacks."""
    mappable = {
        scheme for scheme in KONG_AUTH_PLUGIN_SCHEMES.values() if scheme is not None
    }
    assert set(KONG_SCHEME_AUTH_PLUGINS) == mappable
    for scheme, plugin in KONG_SCHEME_AUTH_PLUGINS.items():
        assert KONG_AUTH_PLUGIN_SCHEMES[plugin] == scheme


def test_the_reverse_table_prefers_the_first_declared_plugin() -> None:
    """Two plugins map to ``apiKey``; the reverse direction must pick one, stably."""
    assert KONG_SCHEME_AUTH_PLUGINS["apiKey"] == "key-auth"


def test_unmapped_auth_plugins_have_no_reverse_entry() -> None:
    """`hmac-auth`/`ldap-auth` are auth mechanisms with no canonical scheme."""
    unmapped = {
        plugin for plugin, scheme in KONG_AUTH_PLUGIN_SCHEMES.items() if scheme is None
    }
    assert unmapped
    assert not (unmapped & set(KONG_SCHEME_AUTH_PLUGINS.values()))


@pytest.mark.parametrize("plugin, scheme", sorted(KONG_AUTH_PLUGIN_SCHEMES.items()))
def test_every_auth_plugin_survives_an_import_export_import(
    plugin: str, scheme: Optional[str]
) -> None:
    """Each row of the mapping table, exercised end to end through a real config."""
    config = {
        "_format_version": "3.0",
        "services": [
            {
                "name": "svc",
                "url": "http://svc.internal",
                "plugins": [{"name": plugin}],
                "routes": [{"name": "r", "paths": ["/r"], "methods": ["GET"]}],
            }
        ],
    }
    adapter = KongImportSource()
    api = adapter.normalize(
        adapter.parse(yaml.safe_dump(config), source_label="table"), include_raw=False
    )
    security = api.services[0].operations[0].extras["security"]
    assert security[0]["plugin"] == plugin
    assert security[0]["scheme"] == scheme

    emitted = _emit(api)
    back = _reimport(emitted, source_label="table")
    assert back.services[0].operations[0].extras["security"] == security


def test_a_scheme_only_security_entry_resolves_through_the_reverse_table() -> None:
    """The documented shape for a normalizer that records a scheme but no plugin."""
    hints, unreadable = auth_hints_from_extras(
        ["apiKey", {"scheme": "oauth2"}],
        default_scope="route",
        default_attached_to="r",
    )
    assert unreadable == []
    assert [hint.plugin for hint in hints] == ["key-auth", "oauth2"]
    assert [hint.scope for hint in hints] == ["route", "route"]


def test_an_unmappable_security_entry_is_reported_not_guessed() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
                extras={"security": ["kerberos", 17]},
            )
        ]
    )
    losses = KongEmitter().emit(api).losses
    unmappable = [loss for loss in losses if loss.subject == "unmappable-security-scheme"]
    assert len(unmappable) == 2
    assert all(loss.kind is LossKind.NA for loss in unmappable)


def test_key_auth_key_names_survive_the_round_trip() -> None:
    api = _import("02-typical-single-service-auth.yaml")
    document = _emit_document(api)
    plugin = document["services"][0]["plugins"][0]
    assert plugin == {"name": "key-auth", "config": {"key_names": ["x-api-key"]}}


def test_oauth2_scopes_and_flows_survive_the_round_trip() -> None:
    api = _import("04-stress-plugin-heavy.yaml")
    document = _emit_document(api)
    billing = next(s for s in document["services"] if s["name"] == "billing-service")
    assert billing["plugins"] == [
        {
            "name": "oauth2",
            "config": {
                "scopes": ["billing.read", "billing.write"],
                "enable_client_credentials": True,
            },
        }
    ]


def test_no_credential_value_reaches_the_emitted_configuration() -> None:
    """The importer redacts credentials; the emitter must not resurrect a placeholder."""
    text = _emit(_import("04-stress-plugin-heavy.yaml"))
    assert "provision_key" not in text
    assert "***" not in text
    assert "fixture-only" not in text


def test_redacted_credentials_are_reported_as_a_loss() -> None:
    losses = KongEmitter().emit(_import("04-stress-plugin-heavy.yaml")).losses
    assert any(loss.subject == "redacted-credential" for loss in losses)


def test_ignored_import_constructs_are_reported_as_losses() -> None:
    losses = KongEmitter().emit(_import("04-stress-plugin-heavy.yaml")).losses
    unimported = {
        loss.detail for loss in losses if loss.subject == "unimported-construct"
    }
    assert any("'consumers'" in detail for detail in unimported)


def test_a_disabled_auth_plugin_stays_disabled() -> None:
    """A disabled auth plugin reaches the canonical model as a plain plugin name; the
    emitter must not re-enable it by emitting it bare."""
    config = {
        "_format_version": "3.0",
        "services": [
            {
                "name": "svc",
                "url": "http://svc.internal",
                "plugins": [{"name": "key-auth", "enabled": False}],
                "routes": [{"name": "r", "paths": ["/r"], "methods": ["GET"]}],
            }
        ],
    }
    adapter = KongImportSource()
    api = adapter.normalize(
        adapter.parse(yaml.safe_dump(config), source_label="disabled"), include_raw=False
    )
    assert api.services[0].operations[0].extras["plugins"] == ["key-auth"]
    assert "security" not in api.services[0].operations[0].extras

    emitted = _emit(api)
    assert {"name": "key-auth", "enabled": False} in yaml.safe_load(emitted)["services"][0][
        "routes"
    ][0]["plugins"]
    back = _reimport(emitted, source_label="disabled")
    assert canonical_diff(api, back).entries == []


# ---------------------------------------------------------------------------
# Round trip: routes, hosts, methods and matches
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_every_corpus_fixture_round_trips_without_a_canonical_diff(fixture: str) -> None:
    api = _import(fixture)
    back = _reimport(_emit(api), source_label=f"kong/{fixture}")
    diff = canonical_diff(api, back)
    assert diff.entries == [], [entry.model_dump() for entry in diff.entries]


def test_the_multi_file_fixture_round_trips_into_one_document() -> None:
    """A `deck` split set merges on import; the emitter writes it back as one file."""
    api = _import_fileset()
    emitted = _emit(api)
    assert len(yaml.safe_load(emitted)["services"]) == 1
    back = _reimport(emitted, source_label="kong/06-split-set")
    assert canonical_diff(api, back).entries == []


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_every_corpus_fixture_preserves_routes_hosts_methods_and_matches(
    fixture: str,
) -> None:
    """The ticket's criterion, stated in its own terms rather than as a diff count."""
    api = _import(fixture)
    back = _reimport(_emit(api), source_label=f"kong/{fixture}")

    def surface(model: CanonicalApi) -> List[Dict[str, Any]]:
        return sorted(
            (
                {
                    "route": operation.extras.get("gateway_route"),
                    "hosts": operation.extras.get("hosts"),
                    "method": operation.http_method,
                    "path": operation.http_path,
                    "match": operation.extras.get("path_match"),
                    "headers": operation.extras.get("headers"),
                }
                for service in model.services
                for operation in service.operations
            ),
            key=lambda row: json.dumps(row, sort_keys=True, default=str),
        )

    assert surface(api) == surface(back)


def test_the_paths_by_methods_cross_product_is_rebuilt_as_one_route() -> None:
    """Two paths × two methods import as four operations and must emit as one route."""
    api = _import("04-stress-plugin-heavy.yaml")
    billing = next(s for s in api.services if s.name == "billing-service")
    assert len(billing.operations) == 4

    document = _emit_document(api)
    service = next(s for s in document["services"] if s["name"] == "billing-service")
    assert len(service["routes"]) == 1
    assert sorted(service["routes"][0]["paths"]) == [
        "/billing/invoices",
        "~/billing/invoices/(?<invoiceId>[0-9a-f-]+)$",
    ]
    assert service["routes"][0]["methods"] == ["GET", "POST"]


def test_a_route_that_matches_any_method_emits_no_methods() -> None:
    api = _import("04-stress-plugin-heavy.yaml")
    document = _emit_document(api)
    partner = next(s for s in document["services"] if s["name"] == "partner-service")
    assert "methods" not in partner["routes"][0]
    assert partner["routes"][0]["paths"] == ["/feed"]


def test_route_header_matches_survive_as_a_route_attribute() -> None:
    api = _import("04-stress-plugin-heavy.yaml")
    document = _emit_document(api)
    admin = next(s for s in document["services"] if s["name"] == "admin-service")
    assert admin["routes"][0]["headers"] == {"x-admin-realm": ["internal"]}


def test_route_attributes_the_importer_preserves_are_written_back() -> None:
    api = _import("02-typical-single-service-auth.yaml")
    document = _emit_document(api)
    assert all(route["strip_path"] is False for route in document["services"][0]["routes"])


@pytest.mark.parametrize("key", ROUTE_EXTRA_KEYS)
def test_every_readable_route_attribute_is_also_writable(key: str) -> None:
    """A key the parser reads but the emitter cannot write would vanish silently."""
    values: Dict[str, Any] = {
        "strip_path": False,
        "preserve_host": True,
        "path_handling": "v1",
        "regex_priority": 5,
        "https_redirect_status_code": 301,
        "request_buffering": False,
        "response_buffering": False,
        "tags": ["team-a"],
        "headers": {"x-realm": ["internal"]},
        "snis": ["api.example.com"],
        "expression": 'http.path == "/x"',
        "priority": 10,
    }
    config = {
        "_format_version": "3.0",
        "services": [
            {
                "name": "svc",
                "url": "http://svc.internal",
                "routes": [
                    {"name": "r", "paths": ["/r"], "methods": ["GET"], key: values[key]}
                ],
            }
        ],
    }
    adapter = KongImportSource()
    api = adapter.normalize(
        adapter.parse(yaml.safe_dump(config), source_label="attrs"), include_raw=False
    )
    emitted = _emit(api)
    assert yaml.safe_load(emitted)["services"][0]["routes"][0][key] == values[key]
    assert canonical_diff(api, _reimport(emitted, source_label="attrs")).entries == []


@pytest.mark.parametrize("key", SERVICE_EXTRA_KEYS)
def test_every_readable_service_attribute_is_also_writable(key: str) -> None:
    values: Dict[str, Any] = {
        "tags": ["team-a"],
        "retries": 3,
        "connect_timeout": 1000,
        "read_timeout": 2000,
        "write_timeout": 3000,
        "enabled": False,
    }
    config = {
        "_format_version": "3.0",
        "services": [
            {
                "name": "svc",
                "url": "http://svc.internal",
                key: values[key],
                "routes": [{"name": "r", "paths": ["/r"], "methods": ["GET"]}],
            }
        ],
    }
    adapter = KongImportSource()
    api = adapter.normalize(
        adapter.parse(yaml.safe_dump(config), source_label="attrs"), include_raw=False
    )
    emitted = _emit(api)
    assert yaml.safe_load(emitted)["services"][0][key] == values[key]
    assert canonical_diff(api, _reimport(emitted, source_label="attrs")).entries == []


def test_a_piecewise_upstream_survives_the_round_trip() -> None:
    api = _import("03-multi-service.yaml")
    document = _emit_document(api)
    catalog = next(s for s in document["services"] if s["name"] == "catalog-service")
    assert catalog["protocol"] == "http"
    assert catalog["host"] == "catalog.internal"
    assert catalog["port"] == 8080
    assert catalog["path"] == "/v1"


def test_an_unattached_route_stays_at_the_top_level() -> None:
    config = {
        "_format_version": "3.0",
        "routes": [{"name": "orphan", "paths": ["/orphan"], "methods": ["GET"]}],
    }
    adapter = KongImportSource()
    api = adapter.normalize(
        adapter.parse(yaml.safe_dump(config), source_label="orphan"), include_raw=False
    )
    document = _emit_document(api)
    assert "services" not in document
    assert document["routes"][0]["name"] == "orphan"
    assert canonical_diff(api, _reimport(_emit(api), source_label="orphan")).entries == []


def test_servers_are_reproduced_through_route_protocols() -> None:
    """The importer derives servers from hosts + protocols, so both must be emitted."""
    config = {
        "_format_version": "3.0",
        "services": [
            {
                "name": "svc",
                "url": "http://svc.internal",
                "routes": [
                    {
                        "name": "plain",
                        "hosts": ["plain.example.com"],
                        "paths": ["/p"],
                        "methods": ["GET"],
                        "protocols": ["http"],
                    }
                ],
            }
        ],
    }
    adapter = KongImportSource()
    api = adapter.normalize(
        adapter.parse(yaml.safe_dump(config), source_label="proto"), include_raw=False
    )
    assert [server.url for server in api.servers] == ["http://plain.example.com"]
    back = _reimport(_emit(api), source_label="proto")
    assert [server.url for server in back.servers] == ["http://plain.example.com"]


# ---------------------------------------------------------------------------
# The emitted artifact is a valid deck file
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_every_emitted_corpus_fixture_passes_deck_validation(fixture: str) -> None:
    validate_kong_declarative_document(_emit(_import(fixture)))


def test_the_multi_file_fixture_emits_a_valid_document() -> None:
    validate_kong_declarative_document(_emit(_import_fileset()))


def test_a_cross_format_model_emits_a_valid_document() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets/{petId}",
                name="GET /pets/{petId}",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets/{petId}",
                parameters=[
                    Parameter(
                        key="GET /pets/{petId}#path.petId",
                        name="petId",
                        location=ParameterLocation.PATH,
                        required=True,
                        type=TypeRef(name="string"),
                    )
                ],
            )
        ]
    )
    validate_kong_declarative_document(_emit(api))


def test_a_service_name_kong_forbids_is_sanitized_and_reported() -> None:
    api = _rest_model(service_name="Pet Store")
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert document["services"][0]["name"] == "Pet-Store"
    assert deck_document_violations(document) == []
    assert any(loss.subject == "sanitized-service-name" for loss in result.losses)


def test_two_services_that_slug_to_one_name_are_de_duplicated() -> None:
    api = _rest_model(service_name="Pets")
    api.services.append(
        Service(
            key="pets",
            name="pets",
            operations=[
                Operation(
                    key="GET /other",
                    name="GET /other",
                    kind=OperationKind.REQUEST_RESPONSE,
                    http_method="GET",
                    http_path="/other",
                )
            ],
        )
    )
    result = KongEmitter().emit(api, opts=KongEmitOptions(service_naming="slug"))
    names = [service["name"] for service in yaml.safe_load(result.files[0].content)["services"]]
    assert names == ["pets", "pets-2"]
    assert any(loss.subject == "deduplicated-service-name" for loss in result.losses)


def test_a_model_with_no_operations_is_refused_rather_than_emitted_empty() -> None:
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="json-schema",
        identity=ApiIdentity(name="Pet"),
        title="Pet",
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    with pytest.raises(ValueError, match="at least one HTTP operation"):
        KongEmitter().emit(api)


def test_a_root_path_operation_emits_the_catch_all_prefix() -> None:
    """Kong rejects a route with no matching rule, so every route declares a path."""
    api = _rest_model(
        operations=[
            Operation(
                key="ANY /",
                name="ANY /",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="ANY",
                http_path="/",
            )
        ],
        servers=[],
    )
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert document["services"][0]["routes"][0]["paths"] == ["/"]
    assert deck_document_violations(document) == []


# ---------------------------------------------------------------------------
# Path-pattern symmetry
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "template",
    [
        "/users",
        "/users/{userId}",
        "/orgs/{orgId}/members/{memberId}",
        "/",
    ],
)
def test_a_template_survives_the_trip_through_a_kong_path(template: str) -> None:
    """`template_path_pattern` is the exact inverse of `build_path_pattern`."""
    pattern = template_path_pattern(template)
    recovered = build_path_pattern(pattern.raw, pattern.kind)
    assert recovered.template == template


def test_a_literal_template_stays_a_prefix_path() -> None:
    pattern = template_path_pattern("/users")
    assert pattern.kind == "prefix"
    assert pattern.raw == "/users"


def test_a_parameterized_template_becomes_an_anchored_named_capture_regex() -> None:
    pattern = template_path_pattern("/users/{userId}")
    assert pattern.kind == "regex"
    assert pattern.raw.startswith("~/users/(?<userId>")
    assert pattern.raw.endswith("$")


def test_a_dot_in_a_literal_segment_is_escaped() -> None:
    assert template_path_pattern("/files/{name}.json").raw == "~/files/(?<name>[^\\x2f]+)\\.json$"


def test_a_path_parameter_matches_anything_but_a_separator() -> None:
    """Written as a hex escape: a literal `/` would break the importer's segment split."""
    assert template_path_pattern("/users/{userId}").raw == "~/users/(?<userId>[^\\x2f]+)$"


def test_a_parameter_inside_a_segment_is_emitted_and_reported_as_lossy() -> None:
    """`/files/{name}.json` matches the same requests but cannot be read back."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /files/{name}.json",
                name="GET /files/{name}.json",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/files/{name}.json",
            )
        ]
    )
    result = KongEmitter().emit(api)
    lossy = next(loss for loss in result.losses if loss.subject == "lossy-path-template")
    assert "/files/{name}" in lossy.detail
    validate_kong_declarative_document(result.files[0].content)


def test_a_parameter_name_illegal_in_a_capture_group_is_normalized() -> None:
    pattern = template_path_pattern("/users/{user-id}")
    assert "(?<user_id>" in pattern.raw


def test_a_relative_template_is_made_absolute() -> None:
    assert template_path_pattern("users").raw == "/users"


# ---------------------------------------------------------------------------
# Emit options
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("version", ["1.1", "2.1", "3.0"])
def test_the_format_version_option_is_honoured(version: str) -> None:
    document = _emit_document(
        _import(CORPUS_FIXTURES[0]), KongEmitOptions(format_version=version)
    )
    assert document["_format_version"] == version


def test_an_unknown_format_version_is_refused() -> None:
    with pytest.raises(ValueError):
        KongEmitOptions(format_version="9.9")


def test_disabling_plugins_emits_a_routing_only_configuration() -> None:
    document = _emit_document(
        _import("04-stress-plugin-heavy.yaml"), KongEmitOptions(emit_plugins=False)
    )
    assert "plugins" not in document
    assert all("plugins" not in service for service in document["services"])
    assert all(
        "plugins" not in route
        for service in document["services"]
        for route in service["routes"]
    )
    assert deck_document_violations(document) == []


@pytest.mark.parametrize("strategy", SERVICE_NAMING_STRATEGIES)
def test_every_service_naming_strategy_emits_a_valid_configuration(strategy: str) -> None:
    api = _import("03-multi-service.yaml")
    document = _emit_document(api, KongEmitOptions(service_naming=strategy))
    assert deck_document_violations(document) == []


def test_the_host_naming_strategy_names_services_after_their_upstream() -> None:
    document = _emit_document(
        _import("03-multi-service.yaml"), KongEmitOptions(service_naming="host")
    )
    assert [service["name"] for service in document["services"]] == [
        "catalog.internal",
        "orders.internal",
        "payments.internal",
    ]


def test_the_preserve_strategy_keeps_the_canonical_names() -> None:
    document = _emit_document(_import("03-multi-service.yaml"))
    assert [service["name"] for service in document["services"]] == [
        "catalog-service",
        "orders-service",
        "payments-service",
    ]


def test_an_unknown_service_naming_strategy_is_refused() -> None:
    with pytest.raises(ValueError):
        KongEmitOptions(service_naming="whatever")


def test_json_output_is_valid_and_re_importable() -> None:
    api = _import("05-real-world-ecommerce.json")
    result = KongEmitter().emit(api, opts=KongEmitOptions(output_format="json"))
    assert result.files[0].path == "kong.json"
    assert result.media_type == "application/json"
    document = json.loads(result.files[0].content)
    assert deck_document_violations(document) == []
    assert (
        canonical_diff(
            api, _reimport(result.files[0].content, source_label="kong/05-real-world-ecommerce.json")
        ).entries
        == []
    )


def test_an_unknown_output_format_is_refused() -> None:
    with pytest.raises(ValueError):
        KongEmitOptions(output_format="toml")


def test_compact_output_is_still_re_importable() -> None:
    api = _import("01-minimal-single-service.yaml")
    text = _emit(api, KongEmitOptions(pretty_print=False))
    assert (
        canonical_diff(
            api, _reimport(text, source_label="kong/01-minimal-single-service.yaml")
        ).entries
        == []
    )


def test_yaml_output_defaults_to_the_deck_filename_and_media_type() -> None:
    result = KongEmitter().emit(_import(CORPUS_FIXTURES[0]))
    assert result.files[0].path == "kong.yaml"
    assert result.media_type == "application/yaml"


def test_invalid_options_raise_an_emit_options_error() -> None:
    class _Foreign(EmitOptions):
        format_version: str = "9.9"

    with pytest.raises(EmitOptionsError):
        KongEmitter().emit(_import(CORPUS_FIXTURES[0]), opts=_Foreign())


def test_options_coerce_through_the_shared_registry_helper() -> None:
    load_builtin_emitters()
    options = coerce_emit_options(get_emitter("kong"), {"service_naming": "slug"})
    assert isinstance(options, KongEmitOptions)
    assert options.service_naming == "slug"


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", CORPUS_FIXTURES)
def test_emission_is_byte_stable(fixture: str) -> None:
    api = _import(fixture)
    assert _emit(api) == _emit(api)


def test_provenance_is_sorted_and_deterministic() -> None:
    api = _import("03-multi-service.yaml")
    first = KongEmitter().emit(api).provenance
    second = KongEmitter().emit(api).provenance
    assert [record.model_dump() for record in first] == [
        record.model_dump() for record in second
    ]
    assert [record.pointer for record in first] == sorted(
        record.pointer for record in first
    )


def test_the_format_version_is_recorded_as_a_default() -> None:
    records = KongEmitter().emit(_import(CORPUS_FIXTURES[0])).provenance
    version = next(r for r in records if r.pointer == "/_format_version")
    assert version.provenance.value == "default"


def test_route_names_recovered_from_a_gateway_import_are_source_provenance() -> None:
    records = KongEmitter().emit(_import(CORPUS_FIXTURES[0])).provenance
    names = [r for r in records if r.pointer.endswith("/name")]
    assert names and all(record.provenance.value == "source" for record in names)


def test_route_names_derived_for_a_foreign_model_are_inferred_provenance() -> None:
    records = KongEmitter().emit(_rest_model()).provenance
    names = [r for r in records if r.pointer.endswith("/name")]
    assert names and any(record.provenance.value == "inferred" for record in names)


# ---------------------------------------------------------------------------
# The shared projection (reused by FMT-2.3)
# ---------------------------------------------------------------------------


def test_the_projection_produces_the_same_document_shape_the_parsers_do() -> None:
    from app.emitter import LossTracker

    api = _import("03-multi-service.yaml")
    document = plan_gateway_config(api, flavor="kong", losses=LossTracker())
    assert document.flavor == "kong"
    assert document.title == api.title
    assert [service.name for service in document.services] == [
        "catalog-service",
        "orders-service",
        "payments-service",
    ]
    assert {route.name for route in document.routes} == {
        "catalog-browse",
        "orders",
        "payments-webhook",
    }


def test_the_projection_rejects_an_unknown_naming_strategy() -> None:
    from app.emitter import LossTracker

    with pytest.raises(ValueError, match="Unknown service-naming strategy"):
        plan_gateway_config(
            _rest_model(), flavor="kong", losses=LossTracker(), service_naming="nope"
        )


def test_a_service_with_no_recorded_upstream_gets_a_reported_placeholder() -> None:
    api = _rest_model(servers=[])
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert document["services"][0]["url"] == PLACEHOLDER_UPSTREAM
    synthesized = next(loss for loss in result.losses if loss.subject == "synthesized-upstream")
    assert synthesized.kind is LossKind.INFERRED
    assert "replace it before applying" in synthesized.detail


def test_request_parameters_are_not_turned_into_match_conditions() -> None:
    """A header a caller *may* send is not a condition for routing the request."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
                parameters=[
                    Parameter(
                        key="GET /pets#header.X-Trace",
                        name="X-Trace",
                        location=ParameterLocation.HEADER,
                        type=TypeRef(name="string"),
                    )
                ],
            )
        ]
    )
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert "headers" not in document["services"][0]["routes"][0]
    assert any(loss.subject == "request-parameter" for loss in result.losses)


def test_server_host_schemes_reads_the_scheme_of_each_server() -> None:
    api = _rest_model(
        servers=[Server(url="http://a.example.com"), Server(url="https://b.example.com/v1")]
    )
    assert server_host_schemes(api) == {
        "a.example.com": "http",
        "b.example.com": "https",
    }


def test_a_server_with_no_scheme_is_ignored_rather_than_guessed() -> None:
    api = _rest_model(servers=[Server(url="/relative/base")])
    assert server_host_schemes(api) == {}


@pytest.mark.parametrize(
    "value, expected",
    [
        ("users-service", "users-service"),
        ("Pet Store", "Pet-Store"),
        ("a/b", "a-b"),
        ("...", "route"),
        ("", "route"),
    ],
)
def test_safe_name_preserves_what_kong_already_accepts(value: str, expected: str) -> None:
    assert safe_name(value) == expected


def test_slug_name_lower_cases_a_synthesized_name() -> None:
    assert slug_name("GET /pet/{petId}") == "get-pet-petid"


def test_a_split_route_group_is_reported_rather_than_merged() -> None:
    """Two operations naming one route but disagreeing on hosts must not be merged."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /a",
                name="GET /a",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/a",
                extras={"gateway_route": "shared", "hosts": ["a.example.com"]},
            ),
            Operation(
                key="GET /b",
                name="GET /b",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/b",
                extras={"gateway_route": "shared", "hosts": ["b.example.com"]},
            ),
        ]
    )
    result = KongEmitter().emit(api)
    names = [route["name"] for route in yaml.safe_load(result.files[0].content)["services"][0]["routes"]]
    assert names == ["shared", "shared-2"]
    assert any(loss.subject == "split-route" for loss in result.losses)


def test_a_service_scoped_plugin_that_is_not_universal_is_narrowed_to_its_route() -> None:
    """Re-emitting it on the service would give a route authentication it never had."""
    security = [
        {
            "scheme": "apiKey",
            "plugin": "key-auth",
            "scope": "service",
            "attached_to": "pets",
            "detail": {},
        }
    ]
    api = _rest_model(
        operations=[
            Operation(
                key="GET /a",
                name="GET /a",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/a",
                extras={"gateway_route": "guarded", "security": security},
            ),
            Operation(
                key="GET /b",
                name="GET /b",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/b",
                extras={"gateway_route": "open"},
            ),
        ]
    )
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    service = document["services"][0]
    assert "plugins" not in service
    guarded = next(route for route in service["routes"] if route["name"] == "guarded")
    open_route = next(route for route in service["routes"] if route["name"] == "open")
    assert guarded["plugins"] == [{"name": "key-auth"}]
    assert "plugins" not in open_route
    assert any(loss.subject == "narrowed-auth-scope" for loss in result.losses)


def test_a_universal_service_scoped_plugin_stays_on_the_service() -> None:
    api = _import("02-typical-single-service-auth.yaml")
    document = _emit_document(api)
    assert document["services"][0]["plugins"] == [
        {"name": "key-auth", "config": {"key_names": ["x-api-key"]}}
    ]
    assert all("plugins" not in route for route in document["services"][0]["routes"])


def test_a_query_match_condition_is_reported_as_unrepresentable() -> None:
    """Kong routes cannot match on query parameters; the condition is not dropped silently."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
                parameters=[
                    Parameter(
                        key="GET /pets#query.mode",
                        name="mode",
                        location=ParameterLocation.QUERY,
                        type=TypeRef(name="string"),
                        extras={"match_value": "fast"},
                    )
                ],
                extras={"gateway_route": "pets"},
            )
        ],
        service_extras={"backend": {"url": "http://pets.internal"}},
    )
    api.extras["gateway"] = {"flavor": "gateway-api"}
    result = KongEmitter().emit(api)
    assert any(loss.subject == "query-match" for loss in result.losses)


def test_a_gateway_sourced_header_match_becomes_a_route_header() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
                parameters=[
                    Parameter(
                        key="GET /pets#header.X-Realm",
                        name="X-Realm",
                        location=ParameterLocation.HEADER,
                        type=TypeRef(name="string"),
                        extras={"match_value": "internal"},
                    )
                ],
                extras={"gateway_route": "pets"},
            )
        ],
    )
    api.extras["gateway"] = {"flavor": "gateway-api"}
    document = yaml.safe_load(KongEmitter().emit(api).files[0].content)
    assert document["services"][0]["routes"][0]["headers"] == {"X-Realm": ["internal"]}


def test_a_service_attribute_kong_cannot_carry_is_reported() -> None:
    api = _rest_model(service_extras={"backend": {"url": "http://x"}, "owner": "team-a"})
    losses = KongEmitter().emit(api).losses
    assert any(loss.subject == "unmapped-service-attribute" for loss in losses)


def test_a_route_attribute_kong_cannot_carry_is_reported() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
                extras={"gateway_route": "pets", "sla": "gold"},
            )
        ]
    )
    losses = KongEmitter().emit(api).losses
    assert any(loss.subject == "unmapped-route-attribute" for loss in losses)


def test_gateway_wide_plugins_are_emitted_by_name_and_the_gap_is_reported() -> None:
    api = _import("04-stress-plugin-heavy.yaml")
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert [plugin["name"] for plugin in document["plugins"]] == [
        "cors",
        "prometheus",
        "rate-limiting",
    ]
    assert any(loss.subject == "plugin-configuration" for loss in result.losses)


# ---------------------------------------------------------------------------
# Kong's two path types
# ---------------------------------------------------------------------------


def test_a_regex_pattern_is_emitted_with_kongs_tilde_marker() -> None:
    """Without `~`, Kong reads the pattern as a literal prefix path."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /users/{userId}",
                name="GET /users/{userId}",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/users/{userId}",
                extras={
                    "gateway_route": "users",
                    "path_match": {"kind": "regex", "raw": "/users/(?<userId>[0-9]+)"},
                },
            )
        ]
    )
    document = yaml.safe_load(KongEmitter().emit(api).files[0].content)
    assert document["services"][0]["routes"][0]["paths"] == ["~/users/(?<userId>[0-9]+)"]


def test_an_exact_path_match_becomes_an_anchored_regex() -> None:
    """Kong has no exact path type; a prefix would widen the route, so it anchors."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /users",
                name="GET /users",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/users",
                extras={
                    "gateway_route": "users",
                    "path_match": {"kind": "exact", "raw": "/users"},
                },
            )
        ]
    )
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert document["services"][0]["routes"][0]["paths"] == ["~/users$"]
    assert any(loss.subject == "exact-path-match" for loss in result.losses)
    assert deck_document_violations(document) == []


def test_an_exact_path_with_a_regex_metacharacter_is_escaped() -> None:
    api = _rest_model(
        operations=[
            Operation(
                key="GET /v1.0/users",
                name="GET /v1.0/users",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/v1.0/users",
                extras={
                    "gateway_route": "users",
                    "path_match": {"kind": "exact", "raw": "/v1.0/users"},
                },
            )
        ]
    )
    document = yaml.safe_load(KongEmitter().emit(api).files[0].content)
    assert document["services"][0]["routes"][0]["paths"] == ["~/v1\\.0/users$"]


def test_a_gateway_api_surface_keeps_its_path_templates_through_kong() -> None:
    """The two gateway adapters share a middle; a transcode must not lose the paths."""
    from app.gateway_api_import_source import GatewayApiImportSource

    manifest = """
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: users
spec:
  hostnames: [api.example.com]
  rules:
    - matches:
        - path:
            type: RegularExpression
            value: "/users/(?<userId>[0-9]+)"
          method: GET
      backendRefs:
        - name: users-svc
          port: 8080
"""
    adapter = GatewayApiImportSource()
    api = adapter.normalize(
        adapter.parse(manifest, source_label="users.yaml"), include_raw=False
    )
    before = [operation.http_path for operation in api.operations()]
    emitted = _emit(api)
    validate_kong_declarative_document(emitted)
    after = [
        operation.http_path
        for operation in _reimport(emitted, source_label="users.yaml").operations()
    ]
    assert before == after == ["/users/{userId}"]


# ---------------------------------------------------------------------------
# Operations a gateway cannot route
# ---------------------------------------------------------------------------


def test_an_operation_with_no_http_path_is_reported_not_routed() -> None:
    """An RPC method has no address; inventing one would be a fabrication."""
    api = _rest_model(
        operations=[
            Operation(
                key="Query.products",
                name="Query.products",
                kind=OperationKind.QUERY,
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
    result = KongEmitter().emit(api)
    unroutable = next(loss for loss in result.losses if loss.subject == "unroutable-operation")
    assert unroutable.pointer == "Query.products"
    assert unroutable.kind is LossKind.NA
    document = yaml.safe_load(result.files[0].content)
    assert [route["name"] for route in document["services"][0]["routes"]] == ["get-pets"]


def test_a_model_of_only_unroutable_operations_is_refused() -> None:
    api = _rest_model(
        operations=[
            Operation(key="Query.products", name="Query.products", kind=OperationKind.QUERY)
        ]
    )
    with pytest.raises(ValueError, match="at least one HTTP operation"):
        KongEmitter().emit(api)


def test_a_service_whose_operations_are_all_unroutable_emits_no_upstream() -> None:
    """A Kong service with no route is dead configuration, not fidelity."""
    api = _rest_model(
        operations=[
            Operation(
                key="GET /pets",
                name="GET /pets",
                kind=OperationKind.REQUEST_RESPONSE,
                http_method="GET",
                http_path="/pets",
            )
        ]
    )
    api.services.append(
        Service(
            key="rpc",
            name="rpc",
            operations=[
                Operation(key="Rpc.call", name="Rpc.call", kind=OperationKind.REQUEST_RESPONSE)
            ],
        )
    )
    result = KongEmitter().emit(api)
    document = yaml.safe_load(result.files[0].content)
    assert [service["name"] for service in document["services"]] == ["pets"]
    assert any(loss.subject == "unrouted-service" for loss in result.losses)
    assert deck_document_violations(document) == []
