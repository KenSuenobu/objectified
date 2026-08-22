"""Swagger 1.2 import — FMT-3.6 (#5431).

The OpenAPI adapter read 3.x and 2.0 only, so the version *below* 2.0 bounced.
Swagger 1.2 is a different document shape as well as a different vocabulary: a
*resource listing* naming N resources plus one *API declaration* per resource,
with ``models`` for ``definitions``, ``nickname`` for ``operationId`` and
``subTypes``/``discriminator`` where 2.0 has ``allOf``. This suite pins the
acceptance criteria of that ticket:

#. a resource listing plus its declarations imports as **one** API, projected onto
   the existing Swagger 2.0 canonical path (so it stays publishable and lintable
   exactly like a 2.0 upload) with the source version recorded in provenance;
#. every 1.2 construct the corpus exercises lands somewhere real — parameter
   forms, ``File`` uploads, ``allowMultiple``, model inheritance, authorizations —
   and the two constructs 2.0 cannot hold are declared on a capability ledger
   rather than silently dropped;
#. Swagger **2.0** is not mis-read by the new reader: it still detects as
   ``swagger-2.0`` and normalizes through the same path it always did (the fact the
   corpus cannot state as a negative, because one adapter owns both versions);
#. the negative corpus covers a listing whose declaration is missing — the case
   the ticket names explicitly.

Fixtures are selected through :mod:`tests.corpus_loader` by manifest tag rather
than by path, so a corpus rename cannot silently re-point an assertion at a
different document.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest
from corpus_loader import ValidityClass, load_corpus, unique_corpus_entry

from app.canonical_model import CanonicalApi, ParameterLocation
from app.fileset import IntakeFileset
from app.format_lint_capabilities import normalize_format_key
from app.import_routing import PUBLISHABLE_FORMATS, ImportTarget, decide_import_routing
from app.import_source import DetectionInput, ImportSourceError
from app.openapi_import_source import SWAGGER_12_EXTRA_KEY, OpenApiImportSource
from app.swagger12_projection import (
    Swagger12Error,
    is_resource_listing,
    is_swagger12_document,
    project_swagger12,
    swagger12_version,
)


@pytest.fixture()
def adapter() -> OpenApiImportSource:
    return OpenApiImportSource()


def _entry(*features: str):
    """The one valid 1.2 corpus fixture carrying every given feature tag."""
    return unique_corpus_entry(format="swagger-1.2", features=features)


def _text(*features: str) -> str:
    return _entry(*features).read_text()


def _document(*features: str) -> Dict[str, Any]:
    return json.loads(_text(*features))


def _petstore_set() -> IntakeFileset:
    """The resource-listing set: ``api-docs.json`` plus its two declarations."""
    root = _entry("multi-file", "resource-listing")
    set_dir = root.absolute_path.parent
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(set_dir.iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root=root.absolute_path.name)


def _project(*features: str) -> Dict[str, Any]:
    """The projected Swagger 2.0 document for one 1.2 corpus fixture."""
    return dict(project_swagger12(_document(*features)))


# ---------------------------------------------------------------------------
# Recognition
# ---------------------------------------------------------------------------


def test_a_declaration_is_claimed_as_swagger_1_2(adapter: OpenApiImportSource) -> None:
    result = adapter.detect(DetectionInput(text=_text("responseMessages")))
    assert result.matched
    assert result.format == "swagger-1.2"
    assert result.confidence >= 0.95
    assert "API declaration" in (result.reason or "")


def test_a_resource_listing_is_claimed_and_named_as_one(
    adapter: OpenApiImportSource,
) -> None:
    result = adapter.detect(DetectionInput(text=_text("multi-file", "resource-listing")))
    assert result.format == "swagger-1.2"
    assert "resource listing" in (result.reason or "")


def test_the_declaration_and_listing_shapes_are_told_apart() -> None:
    assert is_resource_listing(_document("multi-file", "resource-listing"))
    assert not is_resource_listing(_document("responseMessages"))


def test_a_swagger_2_0_document_is_not_read_as_1_2(adapter: OpenApiImportSource) -> None:
    """The routing the corpus cannot assert as a negative: one adapter owns both.

    A Swagger 2.0 upload must keep detecting as ``swagger-2.0`` and normalizing
    through the 2.0 normalizer — the 1.2 reader must never claim it.
    """
    text = load_corpus(format="swagger", validity_class=ValidityClass.VALID)[0].read_text()
    result = adapter.detect(DetectionInput(text=text))

    assert result.format == "swagger-2.0"
    assert swagger12_version(adapter.parse(text)) is None
    model = adapter.normalize(adapter.parse(text), include_raw=False)
    assert model.format == "swagger-2.0"
    assert SWAGGER_12_EXTRA_KEY not in (model.extras or {})


def test_an_older_swagger_1_x_revision_is_rejected_by_version(
    adapter: OpenApiImportSource,
) -> None:
    """1.0/1.1 carry the same marker but not the grammar, so they are named, not guessed."""
    document = _document("responseMessages")
    document["swaggerVersion"] = "1.1"

    assert not is_swagger12_document(document)
    assert adapter.detect(DetectionInput(document=document)).format is None

    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(json.dumps(document))
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"
    assert "Swagger 1.1" in str(excinfo.value)


# ---------------------------------------------------------------------------
# The acceptance criterion: a listing plus declarations is one API
# ---------------------------------------------------------------------------


@pytest.fixture()
def petstore(adapter: OpenApiImportSource) -> CanonicalApi:
    return adapter.normalize(
        adapter.parse_fileset(_petstore_set(), source_label="05-petstore-set"),
        include_raw=False,
    )


def test_a_listing_plus_its_declarations_imports_as_one_api(
    petstore: CanonicalApi,
) -> None:
    assert petstore.title == "Storefront API"
    assert {service.key for service in petstore.services} == {"products", "carts"}
    assert {type_.name for type_ in petstore.types} == {"Cart", "CartItem", "Product"}
    assert {
        (operation.http_method, operation.http_path)
        for service in petstore.services
        for operation in service.operations
    } == {
        ("GET", "/products"),
        ("GET", "/products/{sku}"),
        ("POST", "/carts"),
        ("POST", "/carts/{cartId}/items"),
    }


def test_the_import_lands_on_the_swagger_2_0_canonical_path(
    adapter: OpenApiImportSource,
    petstore: CanonicalApi,
) -> None:
    """Which is what keeps a 1.2 upload publishable and lintable like a 2.0 one.

    Routing branches on ``model.format``, so the projection is what makes a 1.2
    upload mint a publishable Project instead of a catalog item.
    """
    assert petstore.format == "swagger-2.0"
    assert petstore.format in PUBLISHABLE_FORMATS
    assert decide_import_routing(adapter, petstore).target is ImportTarget.PROJECT


def test_the_source_version_is_recorded_in_provenance(petstore: CanonicalApi) -> None:
    provenance = petstore.extras[SWAGGER_12_EXTRA_KEY]
    assert provenance["source_version"] == "1.2"
    assert provenance["api_version"] == "1.0.0"
    assert provenance["resource_listing"] == "api-docs.json"
    assert sorted(provenance["declarations"]) == ["/carts", "/products"]


def test_a_declaration_imported_alone_records_no_listing(
    adapter: OpenApiImportSource,
) -> None:
    model = adapter.normalize(
        adapter.parse(_text("responseMessages"), source_label="orders.json"),
        include_raw=False,
    )
    provenance = model.extras[SWAGGER_12_EXTRA_KEY]
    assert provenance["source_version"] == "1.2"
    assert "resource_listing" not in provenance


def test_the_listings_base_path_splits_into_scheme_host_and_base(
    petstore: CanonicalApi,
) -> None:
    assert [server.url for server in petstore.servers] == ["https://api.example.com/store"]


# ---------------------------------------------------------------------------
# The negative cases the pipeline has to name
# ---------------------------------------------------------------------------


def _negative_text(*features: str) -> str:
    """The one invalid 1.2 corpus fixture carrying every given feature tag."""
    matches = [
        entry
        for entry in load_corpus(format="swagger-1.2", validity_class=ValidityClass.INVALID)
        if set(features) <= set(entry.features)
    ]
    assert len(matches) == 1, f"{features}: expected one negative fixture, got {len(matches)}"
    return matches[0].read_text()


def test_a_resource_listing_alone_is_an_unresolved_reference(
    adapter: OpenApiImportSource,
) -> None:
    """A listing only *names* its declarations, so importing one alone asks for them."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative_text("unresolvable-ref"), source_label="api-docs.json")
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "/orders" in str(excinfo.value)


def test_a_set_missing_one_declaration_names_the_missing_resource(
    adapter: OpenApiImportSource,
) -> None:
    full = _petstore_set()
    trimmed = IntakeFileset.from_members(
        {
            path: content
            for path, content in full.members.items()
            if "carts" not in path
        },
        root=full.root,
    )
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(trimmed)
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "/carts" in str(excinfo.value)


def test_an_empty_resource_listing_is_semantically_invalid() -> None:
    with pytest.raises(Swagger12Error) as excinfo:
        project_swagger12({"swaggerVersion": "1.2", "apis": []})
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_non_swagger_document_is_a_format_mismatch() -> None:
    with pytest.raises(Swagger12Error) as excinfo:
        project_swagger12({"paths": {}})
    assert excinfo.value.code == "FORMAT_MISMATCH"


# ---------------------------------------------------------------------------
# The projection, construct by construct
# ---------------------------------------------------------------------------


def test_nickname_notes_and_summary_take_their_2_0_spellings() -> None:
    projected = _project("responseMessages")
    listing = projected["paths"]["/orders"]["get"]

    assert listing["operationId"] == "listOrders"
    assert listing["summary"] == "List orders"
    assert listing["description"] == "Returns the caller's orders, newest first."


def test_the_operation_type_becomes_the_success_response_schema() -> None:
    projected = _project("responseMessages")
    responses = projected["paths"]["/orders"]["get"]["responses"]

    assert responses["200"]["schema"] == {
        "type": "array",
        "items": {"$ref": "#/definitions/Order"},
    }
    assert responses["401"]["description"] == "Not authenticated"
    assert "schema" not in responses["401"]


def test_a_response_message_with_its_own_model_keeps_it() -> None:
    projected = _project("responseMessages")
    responses = projected["paths"]["/orders"]["post"]["responses"]

    assert responses["201"]["schema"] == {"$ref": "#/definitions/Order"}
    assert responses["422"]["schema"] == {"$ref": "#/definitions/ErrorModel"}


def test_a_void_operation_with_no_messages_gets_a_204() -> None:
    projected = _project("responseMessages")
    # `cancelOrder` documents a 204 of its own, so the projection must not add a 200.
    assert set(projected["paths"]["/orders/{orderId}"]["delete"]["responses"]) == {"204"}


def test_an_undocumented_operation_gets_a_synthesized_success() -> None:
    projected = _project("api-declaration", "operations")
    responses = projected["paths"]["/ping"]["get"]["responses"]
    assert responses == {"200": {"description": "Successful response", "schema": {"type": "string"}}}


def test_stringly_typed_bounds_and_defaults_are_coerced() -> None:
    projected = _project("responseMessages")
    limit = next(
        parameter
        for parameter in projected["paths"]["/orders"]["get"]["parameters"]
        if parameter["name"] == "limit"
    )

    assert limit["minimum"] == 1
    assert limit["maximum"] == 100
    assert limit["default"] == 25
    assert projected["definitions"]["OrderLine"]["properties"]["quantity"]["minimum"] == 1


def test_sub_types_and_discriminator_become_all_of() -> None:
    projected = _project("subTypes", "discriminator")

    assert projected["definitions"]["Vehicle"]["discriminator"] == "kind"
    assert "subTypes" not in projected["definitions"]["Vehicle"]
    assert projected["definitions"]["Truck"]["allOf"][0] == {"$ref": "#/definitions/Vehicle"}
    assert "payloadKg" in projected["definitions"]["Truck"]["allOf"][1]["properties"]


def test_inheritance_normalizes_exactly_as_the_equivalent_2_0_document(
    adapter: OpenApiImportSource,
) -> None:
    """1.2's inheritance must reach the canonical model by the 2.0 route, not beside it.

    Whatever the shared schema coercion makes of ``allOf`` — today it does not
    flatten a parent's properties into the child, a limitation the OpenAPI and
    Swagger 2.0 paths already have — a projected 1.2 document must land in exactly
    the same place a hand-written 2.0 document with the same ``allOf`` does.
    """
    projected = _project("subTypes", "discriminator")
    equivalent = {
        "swagger": "2.0",
        "info": {"title": projected["info"]["title"], "version": projected["info"]["version"]},
        "paths": projected["paths"],
        "definitions": projected["definitions"],
    }

    from_1_2 = adapter.normalize(adapter.parse(_text("subTypes", "discriminator")), include_raw=False)
    from_2_0 = adapter.normalize(equivalent, include_raw=False)

    assert [type_.model_dump() for type_ in from_1_2.types] == [
        type_.model_dump() for type_ in from_2_0.types
    ]


def test_form_parameters_and_file_uploads_become_form_data() -> None:
    projected = _project("form-parameter", "File")
    upload = projected["paths"]["/samples"]["post"]
    by_name = {parameter["name"]: parameter for parameter in upload["parameters"]}

    assert {parameter["in"] for parameter in upload["parameters"]} == {"formData"}
    assert by_name["attachment"]["type"] == "file"
    assert upload["consumes"] == ["multipart/form-data"]


def test_a_file_upload_reaches_the_canonical_request_message(
    adapter: OpenApiImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(_text("form-parameter", "File")), include_raw=False)
    upload = next(
        operation
        for service in model.services
        for operation in service.operations
        if operation.http_path == "/samples" and operation.http_method == "POST"
    )
    [request] = [message for message in upload.messages if message.role.value == "request"]
    assert request.content_types == ["multipart/form-data"]
    assert "attachment" in (request.payload_schema or {}).get("properties", {})


def test_allow_multiple_becomes_a_multi_collection_array() -> None:
    projected = _project("form-parameter", "allowMultiple")
    tags = next(
        parameter
        for parameter in projected["paths"]["/samples"]["get"]["parameters"]
        if parameter["name"] == "tags"
    )

    assert tags["type"] == "array"
    assert tags["collectionFormat"] == "multi"
    assert tags["items"] == {"type": "string"}


def test_header_and_query_parameters_keep_their_locations(
    adapter: OpenApiImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(_text("form-parameter", "header-parameter")), include_raw=False)
    search = next(
        operation
        for service in model.services
        for operation in service.operations
        if operation.http_method == "GET"
    )
    locations = {parameter.name: parameter.location for parameter in search.parameters}
    assert locations["X-Request-Id"] is ParameterLocation.HEADER
    assert locations["status"] is ParameterLocation.QUERY


def test_a_body_parameter_becomes_a_schema_reference() -> None:
    projected = _project("responseMessages")
    [body] = projected["paths"]["/orders"]["post"]["parameters"]

    assert body["in"] == "body"
    assert body["schema"] == {"$ref": "#/definitions/NewOrder"}


def test_authorizations_become_security_definitions() -> None:
    projected = _project("form-parameter", "oauth2")

    assert projected["securityDefinitions"]["apiKey"] == {
        "type": "apiKey",
        "name": "X-Api-Key",
        "in": "header",
    }
    oauth2 = projected["securityDefinitions"]["oauth2"]
    assert oauth2["flow"] == "implicit"
    assert oauth2["authorizationUrl"] == "https://auth.example.com/oauth/authorize"
    assert set(oauth2["scopes"]) == {"samples:read", "samples:write"}


def test_a_second_oauth2_grant_becomes_a_sibling_definition_and_a_ledger_line() -> None:
    """Swagger 2.0 admits one flow per definition; 1.2 declares every grant."""
    projection = project_swagger12(_document("form-parameter", "grantTypes"))

    assert projection["securityDefinitions"]["oauth2_accessCode"]["flow"] == "accessCode"
    limits = projection.swagger12_provenance.limits
    assert any("more than one OAuth2 grant type" in limit for limit in limits)


def test_per_operation_authorizations_become_a_security_requirement() -> None:
    projected = _project("form-parameter", "oauth2")
    assert projected["paths"]["/samples"]["get"]["security"] == [{"oauth2": ["samples:read"]}]


def test_declarations_that_disagree_about_base_path_declare_the_limit() -> None:
    first = _document("responseMessages")
    second = json.loads(json.dumps(first))
    second["resourcePath"] = "/other"
    second["basePath"] = "https://elsewhere.example.com/v9"
    second["apis"] = [
        {"path": "/other", "operations": [{"method": "GET", "nickname": "other", "type": "string"}]}
    ]

    projection = project_swagger12(first, declarations=[("other.json", second)])
    assert any("different basePath" in limit for limit in projection.swagger12_provenance.limits)
    assert projection["host"] == "api.example.com"


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------


def test_the_adapter_declares_1_2_in_its_version_coverage() -> None:
    """Which is what the capability registry serves as this format's coverage."""
    assert "swagger-1.2" in OpenApiImportSource.formats
    assert "swagger-1.2" in OpenApiImportSource.descriptor().formats


def test_lint_capability_folds_1_2_onto_the_2_0_key() -> None:
    """A 1.2 import *is* a 2.0 model, so the rules that apply to it are the 2.0 rules."""
    assert normalize_format_key("swagger-1.2") == "swagger-2.0"


# ---------------------------------------------------------------------------
# Corpus contract
# ---------------------------------------------------------------------------


def test_every_1_2_corpus_entry_is_owned_by_the_openapi_adapter() -> None:
    entries = load_corpus(format="swagger-1.2")
    assert entries, "the swagger-1.2 corpus directory has no manifest entries"
    assert {entry.adapter_key for entry in entries} == {"openapi"}
    assert not any("pending-adapter" in entry.features for entry in entries)


def test_the_1_2_corpus_covers_the_constructs_the_ticket_names() -> None:
    features: List[str] = [
        feature
        for entry in load_corpus(format="swagger-1.2", validity_class=ValidityClass.VALID)
        for feature in entry.features
    ]
    assert {"resource-listing", "subTypes", "discriminator", "form-parameter", "File"} <= set(
        features
    )
