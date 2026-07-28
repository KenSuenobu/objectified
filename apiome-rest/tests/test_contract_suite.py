"""Corpus tests for the version contract-suite compiler — ECA-1.1 (#4729).

The acceptance criteria of the ticket are the headings below, and each is asserted against a
model built by the real OpenAPI normalizer rather than a hand-written canonical tree, so the
compiler is exercised through the same shapes an import produces:

* identical version plus options yields a **byte-identical** manifest;
* every case identifies its **operation, source, and expected outcome**;
* unsupported semantics are **reported, never silently skipped**;
* the corpus covers **declared examples, generated values, and invalid requests**.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
)
from app.contract_suite import (
    CASE_SOURCE_DECLARED_EXAMPLE,
    CASE_SOURCE_GENERATED_FULL,
    CASE_SOURCE_GENERATED_MINIMAL,
    CASE_SOURCE_NEGATIVE_BODY_MUTATION,
    CASE_SOURCE_NEGATIVE_MISSING_BODY,
    CASE_SOURCE_NEGATIVE_MISSING_PARAMETER,
    CASE_SOURCE_NEGATIVE_PARAMETER_TYPE,
    CASE_SOURCES,
    CODE_AUTHENTICATION_REQUIRED,
    CODE_EXAMPLE_SCHEMA_MISMATCH,
    CODE_MISSING_HTTP_BINDING,
    CODE_NO_CASES_COMPILED,
    CODE_NO_NEGATIVE_CASES,
    CODE_OPERATION_LIMIT_REACHED,
    CODE_OPERATION_NOT_SELECTED,
    CODE_SERVER_TEMPLATED,
    CODE_STATUS_UNDECLARED,
    CODE_UNDECLARED_PATH_PARAMETER,
    CODE_UNSUPPORTED_MEDIA_TYPE,
    CODE_UNSUPPORTED_PARAMETER_LOCATION,
    CODE_UNSUPPORTED_PARAMETER_SHAPE,
    CODE_UNSUPPORTED_STREAMING,
    CONTRACT_SUITE_COMPILER_VERSION,
    CONTRACT_SUITE_SCHEMA_VERSION,
    FINDING_LEVELS,
    OUTCOME_CLIENT_ERROR,
    OUTCOME_SUCCESS,
    SUITE_FINDING_CODES,
    WRONG_TYPE_PARAMETER_VALUE,
    ContractSuiteManifest,
    ContractSuiteOptions,
    SuiteSourceInfo,
    canonical_manifest_bytes,
    compile_contract_suite,
    manifest_digest,
)
from app.openapi_normalizer import OpenApiNormalizer
from app.schema_instance_validation import validate_json_instance

# ===========================================================================
# Corpus
# ===========================================================================

PET_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["name", "age"],
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 20},
        "age": {"type": "integer", "minimum": 0, "maximum": 30},
        "status": {"type": "string", "enum": ["available", "sold"]},
    },
}

PETSTORE: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Petstore", "version": "1.0.0"},
    "servers": [{"url": "https://api.example.com/{stage}"}],
    "components": {
        "securitySchemes": {"apiKey": {"type": "apiKey", "name": "X-Key", "in": "header"}},
        "schemas": {"Pet": PET_SCHEMA},
    },
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "tags": ["pets"],
                "parameters": [
                    {
                        "name": "limit",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "integer", "minimum": 1, "maximum": 50},
                    },
                    {
                        "name": "sort",
                        "in": "query",
                        "schema": {"type": "string", "enum": ["asc", "desc"]},
                    },
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "array",
                                    "items": {"$ref": "#/components/schemas/Pet"},
                                }
                            }
                        },
                    }
                },
            },
            "post": {
                "operationId": "createPet",
                "tags": ["pets"],
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"},
                            "examples": {
                                "kitten": {"value": {"name": "Mia", "age": 1}},
                                "broken": {"value": {"name": "", "age": "old"}},
                            },
                        }
                    },
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}
                        },
                    },
                    "400": {"description": "invalid"},
                },
            },
        },
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "parameters": [
                    {
                        "name": "petId",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                        "example": 42,
                    }
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}
                        },
                    }
                },
            }
        },
    },
}


def _compile(
    document: Dict[str, Any], **option_overrides: Any
) -> ContractSuiteManifest:
    """Normalize an OpenAPI document and compile its suite."""
    api = OpenApiNormalizer().normalize(document)
    return compile_contract_suite(api, options=ContractSuiteOptions(**option_overrides))


@pytest.fixture(scope="module")
def petstore() -> ContractSuiteManifest:
    """The default suite for the corpus document, compiled once."""
    return _compile(PETSTORE)


def _cases(manifest: ContractSuiteManifest, source: str) -> List[Any]:
    """Every case of one source."""
    return [case for case in manifest.cases if case.source == source]


def _codes(manifest: ContractSuiteManifest) -> List[str]:
    """Every finding code the manifest carries."""
    return [finding.code for finding in manifest.findings]


# ===========================================================================
# Determinism — the criterion the rest of Executable Contract Assurance rests on
# ===========================================================================


def test_the_same_version_and_options_compile_to_byte_identical_manifests() -> None:
    """Two independent compilations of the same document produce the same bytes."""
    first = canonical_manifest_bytes(_compile(PETSTORE))
    second = canonical_manifest_bytes(_compile(PETSTORE))
    assert first == second


def test_the_digest_is_the_hash_of_the_manifests_own_bytes(petstore) -> None:
    """A stored manifest can be re-verified without stripping fields by hand."""
    assert petstore.digest.startswith("sha256:")
    assert manifest_digest(petstore) == petstore.digest


def test_a_different_seed_changes_the_suite(petstore) -> None:
    """The seed is part of the suite's identity, so it moves the digest."""
    other = _compile(PETSTORE, seed=7)
    assert other.digest != petstore.digest


def test_options_are_echoed_and_hashed_into_the_digest(petstore) -> None:
    """Two suites over one version differ when they were asked for different things."""
    without_negatives = _compile(PETSTORE, include_negative=False)
    assert without_negatives.options.include_negative is False
    assert without_negatives.digest != petstore.digest


def test_an_operations_filter_is_order_independent() -> None:
    """`operations` is a set: asking for the same two in either order is the same suite."""
    forward = _compile(PETSTORE, operations=["GET /pets", "POST /pets"])
    reverse = _compile(PETSTORE, operations=["POST /pets", "GET /pets"])
    assert forward.digest == reverse.digest
    assert forward.options.operations == ["GET /pets", "POST /pets"]


def test_canonical_bytes_are_sorted_and_newline_terminated(petstore) -> None:
    """The artifact is diffable: stable key order, tight separators, trailing newline."""
    raw = canonical_manifest_bytes(petstore)
    assert raw.endswith(b"\n")
    decoded = json.loads(raw)
    assert list(decoded) == sorted(decoded)
    assert b", " not in raw[:200]


def test_the_manifest_declares_its_envelope_and_compiler_versions(petstore) -> None:
    """A stored manifest says which rules produced it, so a stale digest is explainable."""
    assert petstore.schema_version == CONTRACT_SUITE_SCHEMA_VERSION
    assert petstore.compiler_version == CONTRACT_SUITE_COMPILER_VERSION


# ===========================================================================
# Every case identifies its operation, source, and expected outcome
# ===========================================================================


def test_every_case_names_an_operation_a_source_and_an_outcome(petstore) -> None:
    """No anonymous case, and no case whose expectation was left unstated."""
    compiled_keys = {operation.key for operation in petstore.operations}
    for case in petstore.cases:
        assert case.operation_key in compiled_keys
        assert case.source in CASE_SOURCES
        assert case.expect.outcome in {OUTCOME_SUCCESS, OUTCOME_CLIENT_ERROR}
        assert case.expect.status_codes
        assert case.expect.reason
        assert case.title


def test_case_ids_are_unique_and_stable(petstore) -> None:
    """Ids identify a case across runs, so a report can track one case over time."""
    ids = [case.case_id for case in petstore.cases]
    assert len(ids) == len(set(ids))
    assert ids == [case.case_id for case in _compile(PETSTORE).cases]


def test_operation_case_counts_match_the_compiled_cases(petstore) -> None:
    """The per-operation summary is derived from the cases, not asserted separately."""
    for operation in petstore.operations:
        actual = sum(1 for case in petstore.cases if case.operation_key == operation.key)
        assert operation.case_count == actual


def test_counts_summarize_every_source(petstore) -> None:
    """`counts` is the first thing a reviewer reads; it must add up."""
    assert petstore.counts["cases"] == len(petstore.cases)
    for source in CASE_SOURCES:
        assert petstore.counts[source] == len(_cases(petstore, source))
    assert petstore.counts["operations_compiled"] == len(petstore.operations)


# ===========================================================================
# Declared examples come first
# ===========================================================================


def test_a_declared_example_is_compiled_as_a_non_synthetic_case(petstore) -> None:
    """An author's own body is used verbatim and labelled as theirs, not ours."""
    examples = _cases(petstore, CASE_SOURCE_DECLARED_EXAMPLE)
    assert len(examples) == 1
    case = examples[0]
    assert case.synthetic is False
    assert case.request.body == {"name": "Mia", "age": 1}
    assert case.source_detail == "kitten"
    assert case.source_pointer.endswith("/examples/kitten/value")
    assert case.expect.outcome == OUTCOME_SUCCESS


def test_declared_examples_precede_generated_bodies_for_an_operation(petstore) -> None:
    """Order encodes preference: the author's evidence is the first case for the operation."""
    post = [case for case in petstore.cases if case.operation_key == "POST /pets"]
    assert post[0].source == CASE_SOURCE_DECLARED_EXAMPLE


def test_an_example_that_fails_its_own_schema_is_reported_and_not_compiled(petstore) -> None:
    """Compiling it would manufacture a failure that is really a documentation bug."""
    bodies = [case.request.body for case in _cases(petstore, CASE_SOURCE_DECLARED_EXAMPLE)]
    assert {"name": "", "age": "old"} not in bodies
    mismatch = [
        finding
        for finding in petstore.findings
        if finding.code == CODE_EXAMPLE_SCHEMA_MISMATCH
    ]
    assert mismatch and mismatch[0].pointer.endswith("/examples/broken/value")


def test_a_declared_parameter_example_supplies_the_path_value(petstore) -> None:
    """`petId: 42` is the author's value, so the compiled URL is `/pets/42`."""
    case = next(case for case in petstore.cases if case.operation_key == "GET /pets/{petId}")
    assert case.request.path == "/pets/42"
    parameter = next(item for item in case.request.parameters if item.name == "petId")
    assert parameter.origin == "declared_example"


def test_examples_can_be_switched_off() -> None:
    """With examples off, no case claims an author wrote it."""
    manifest = _compile(PETSTORE, include_declared_examples=False)
    assert not _cases(manifest, CASE_SOURCE_DECLARED_EXAMPLE)
    assert all(case.synthetic for case in manifest.cases)


# ===========================================================================
# Generated values
# ===========================================================================


def test_generated_bodies_are_valid_against_the_schema_they_came_from(petstore) -> None:
    """A positive case that does not satisfy the contract would be a false failure."""
    pet_schema = petstore.schemas["type:Pet"]
    for source in (CASE_SOURCE_GENERATED_MINIMAL, CASE_SOURCE_GENERATED_FULL):
        for case in _cases(petstore, source):
            if case.operation_key != "POST /pets":
                continue
            result = validate_json_instance(pet_schema, case.request.body)
            assert result.valid is True, result.findings


def test_the_minimal_body_carries_required_properties_only(petstore) -> None:
    """Minimal and full are different cases because a server may only accept one of them."""
    minimal = next(
        case
        for case in _cases(petstore, CASE_SOURCE_GENERATED_MINIMAL)
        if case.operation_key == "POST /pets"
    )
    full = next(
        case
        for case in _cases(petstore, CASE_SOURCE_GENERATED_FULL)
        if case.operation_key == "POST /pets"
    )
    assert set(minimal.request.body) == {"name", "age"}
    assert "status" in full.request.body


def test_generated_parameter_values_respect_their_constraints(petstore) -> None:
    """A generated `limit` outside 1..50 would test the server's validation, not its contract."""
    case = next(
        case
        for case in petstore.cases
        if case.operation_key == "GET /pets" and case.source == CASE_SOURCE_GENERATED_MINIMAL
    )
    limit = next(item for item in case.request.parameters if item.name == "limit")
    assert 1 <= int(limit.value) <= 50


def test_a_declared_enum_supplies_a_parameter_value_before_anything_is_invented(
    petstore,
) -> None:
    """`sort` has an enum, so the first member is used and recorded as such."""
    case = next(
        case
        for case in petstore.cases
        if case.operation_key == "GET /pets" and case.source == CASE_SOURCE_GENERATED_MINIMAL
    )
    sort = next(item for item in case.request.parameters if item.name == "sort")
    assert (sort.value, sort.origin) == ("asc", "enum")


def test_an_operation_with_no_body_still_gets_a_positive_case(petstore) -> None:
    """For a GET, "call it and check the response" is the whole contract."""
    case = next(case for case in petstore.cases if case.operation_key == "GET /pets/{petId}")
    assert case.expect.outcome == OUTCOME_SUCCESS
    assert case.request.has_body is False
    assert case.request.body is None


def test_polymorphic_bodies_are_covered_alternative_by_alternative() -> None:
    """A `oneOf` body is covered, not sampled: every alternative reaches a case."""
    document = _document_with_body(
        {
            "oneOf": [
                {
                    "type": "object",
                    "required": ["card"],
                    "properties": {"card": {"type": "string"}},
                },
                {
                    "type": "object",
                    "required": ["iban"],
                    "properties": {"iban": {"type": "string"}},
                },
            ]
        }
    )
    manifest = _compile(document, include_negative=False)
    bodies = [case.request.body for case in manifest.cases if case.request.has_body]
    # One alternative is already covered by the minimal body; the branch case exists to reach
    # the one that would otherwise never be sent.
    assert any("card" in body for body in bodies)
    assert any("iban" in body for body in bodies)
    branches = [case for case in manifest.cases if case.source == "generated_branch"]
    assert branches
    assert all(case.source_detail for case in branches)


# ===========================================================================
# Invalid requests — the cases that make a suite worth running
# ===========================================================================


def test_a_required_body_omitted_is_a_client_error_case(petstore) -> None:
    """The contract says the body is required; a conforming server rejects a request without it."""
    case = next(iter(_cases(petstore, CASE_SOURCE_NEGATIVE_MISSING_BODY)))
    assert case.operation_key == "POST /pets"
    assert case.request.has_body is False
    assert case.expect.outcome == OUTCOME_CLIENT_ERROR
    assert case.expect.status_codes == ["400"]
    assert case.expect.status_declared is True


def test_a_required_query_parameter_omitted_is_a_client_error_case(petstore) -> None:
    """Only the targeted parameter is dropped; everything else stays valid."""
    case = next(iter(_cases(petstore, CASE_SOURCE_NEGATIVE_MISSING_PARAMETER)))
    assert case.source_detail == "limit"
    assert all(item.name != "limit" for item in case.request.parameters)
    assert any(item.name == "sort" for item in case.request.parameters)
    assert case.expect.outcome == OUTCOME_CLIENT_ERROR


def test_a_wrong_typed_parameter_is_only_produced_where_it_actually_violates(
    petstore,
) -> None:
    """A string is a valid value for a string parameter, so only typed ones are targeted."""
    cases = _cases(petstore, CASE_SOURCE_NEGATIVE_PARAMETER_TYPE)
    assert {case.source_detail for case in cases} == {"limit", "petId"}
    for case in cases:
        offending = next(
            item for item in case.request.parameters if item.name == case.source_detail
        )
        assert offending.value == WRONG_TYPE_PARAMETER_VALUE
        assert case.expect.outcome == OUTCOME_CLIENT_ERROR


def test_body_mutations_each_break_exactly_one_constraint(petstore) -> None:
    """Every mutant is rejected by the schema it was derived from — a negative that fails for
    the wrong reason is a broken test."""
    pet_schema = petstore.schemas["type:Pet"]
    mutants = _cases(petstore, CASE_SOURCE_NEGATIVE_BODY_MUTATION)
    assert mutants
    for case in mutants:
        result = validate_json_instance(pet_schema, case.request.body)
        assert result.valid is False
        assert case.source_detail
        assert case.expect.outcome == OUTCOME_CLIENT_ERROR


def test_a_negative_parameter_case_keeps_a_valid_body() -> None:
    """A negative case must isolate one fault, or its rejection proves nothing."""
    document = json.loads(json.dumps(PETSTORE))
    document["paths"]["/pets"]["post"]["parameters"] = [
        {"name": "dry_run", "in": "query", "required": True, "schema": {"type": "boolean"}}
    ]
    manifest = _compile(document)
    case = next(
        case
        for case in manifest.cases
        if case.operation_key == "POST /pets"
        and case.source == CASE_SOURCE_NEGATIVE_MISSING_PARAMETER
    )
    assert case.request.has_body is True
    result = validate_json_instance(manifest.schemas["type:Pet"], case.request.body)
    assert result.valid is True


def test_negative_cases_can_be_switched_off(petstore) -> None:
    """Some callers only want the positive suite; the option is honoured exactly."""
    manifest = _compile(PETSTORE, include_negative=False)
    assert manifest.counts["negative_cases"] == 0
    assert petstore.counts["negative_cases"] > 0


def test_an_operation_with_nothing_to_violate_reports_that_it_has_no_negatives() -> None:
    """Partial coverage is stated, never implied."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Ping", "version": "1.0.0"},
        "paths": {"/ping": {"get": {"responses": {"200": {"description": "ok"}}}}},
    }
    manifest = _compile(document)
    assert CODE_NO_NEGATIVE_CASES in _codes(manifest)


# ===========================================================================
# Expectations
# ===========================================================================


def test_a_success_case_asserts_the_declared_status_and_response_schema(petstore) -> None:
    """The expectation comes from the contract, and points at a schema carried in the manifest."""
    case = next(
        case for case in petstore.cases if case.operation_key == "POST /pets" and case.synthetic
    )
    assert case.expect.status_codes == ["201"]
    assert case.expect.status_declared is True
    assert case.expect.response_schema_id == "type:Pet"
    assert petstore.schemas["type:Pet"]["title"] == "Pet"


def test_an_undeclared_success_status_degrades_to_a_range_and_says_so() -> None:
    """A weaker assertion is visible rather than implied."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Ping", "version": "1.0.0"},
        "paths": {"/ping": {"get": {"responses": {}}}},
    }
    manifest = _compile(document)
    case = manifest.cases[0]
    assert case.expect.status_codes == ["2XX"]
    assert case.expect.status_declared is False
    assert CODE_STATUS_UNDECLARED in _codes(manifest)


def test_a_named_response_type_is_carried_once_however_many_operations_return_it(
    petstore,
) -> None:
    """`schemas` is keyed by type so a fifty-operation suite does not carry fifty copies."""
    referenced = {
        case.expect.response_schema_id
        for case in petstore.cases
        if case.expect.response_schema_id
    }
    assert "type:Pet" in referenced
    assert set(petstore.schemas) >= referenced


def test_response_schemas_can_be_left_out() -> None:
    """A runner that resolves schemas itself does not need them inlined."""
    manifest = _compile(PETSTORE, include_response_schemas=False)
    assert manifest.schemas == {}
    assert all(case.expect.response_schema_id is None for case in manifest.cases)


# ===========================================================================
# Unsupported semantics are reported, never silently skipped
# ===========================================================================


def test_every_finding_uses_a_declared_code_and_level(petstore) -> None:
    """Findings are machine-readable, so a gate can allow one condition and fail another."""
    for finding in petstore.findings:
        assert finding.code in SUITE_FINDING_CODES
        assert finding.level in FINDING_LEVELS
        assert finding.message


def test_findings_are_sorted_and_deduplicated(petstore) -> None:
    """Two operations hitting one document-level condition report it once."""
    identities = [
        (f.code, f.operation_key or "", f.pointer or "", f.message) for f in petstore.findings
    ]
    assert identities == sorted(identities)
    assert len(identities) == len(set(identities))


def test_security_requirements_are_reported_because_a_suite_carries_no_credentials(
    petstore,
) -> None:
    """Otherwise every case would fail on authentication rather than on the contract."""
    assert CODE_AUTHENTICATION_REQUIRED in _codes(petstore)


def test_a_templated_server_is_reported(petstore) -> None:
    """The suite describes relative paths; resolving the base URL is the runner's job."""
    assert CODE_SERVER_TEMPLATED in _codes(petstore)


def test_a_streaming_operation_is_reported_and_not_compiled() -> None:
    """A request/response case cannot express a stream, and pretending otherwise is worse."""
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="grpc",
        identity=ApiIdentity(name="pets"),
        services=[
            Service(
                key="acme.PetService",
                name="PetService",
                operations=[
                    Operation(
                        key="acme.PetService.Watch",
                        name="Watch",
                        kind=OperationKind.REQUEST_RESPONSE,
                        streaming=StreamingMode.SERVER,
                        http_method="GET",
                        http_path="/watch",
                    )
                ],
            )
        ],
    )
    manifest = compile_contract_suite(api)
    assert manifest.cases == []
    assert CODE_UNSUPPORTED_STREAMING in _codes(manifest)
    assert manifest.counts["operations_skipped"] == 1


def test_an_operation_with_no_http_binding_is_reported() -> None:
    """A GraphQL field or an event subscription has no request to send."""
    api = CanonicalApi(
        paradigm=ApiParadigm.GRAPH,
        format="graphql",
        identity=ApiIdentity(name="graph"),
        services=[
            Service(
                key="Query",
                name="Query",
                operations=[
                    Operation(key="Query.user", name="user", kind=OperationKind.QUERY)
                ],
            )
        ],
    )
    manifest = compile_contract_suite(api)
    assert manifest.cases == []
    assert CODE_MISSING_HTTP_BINDING in _codes(manifest)


def test_an_xml_only_body_is_reported_rather_than_sent_as_json() -> None:
    """The compiler builds JSON bodies; claiming to cover an XML endpoint would be a lie."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Soapish", "version": "1.0.0"},
        "paths": {
            "/orders": {
                "post": {
                    "requestBody": {
                        "required": True,
                        "content": {"application/xml": {"schema": {"type": "object"}}},
                    },
                    "responses": {"200": {"description": "ok"}},
                }
            }
        },
    }
    manifest = _compile(document)
    assert CODE_UNSUPPORTED_MEDIA_TYPE in _codes(manifest)
    # The operation *declares* a required body, so a bodyless "positive" case would fail for a
    # reason the suite invented. Compiling nothing, loudly, is the honest answer.
    assert manifest.cases == []
    assert CODE_NO_CASES_COMPILED in _codes(manifest)


def test_a_cookie_parameter_is_reported_and_not_sent() -> None:
    """A contract suite exercises the contract, not session state."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Cookies", "version": "1.0.0"},
        "paths": {
            "/me": {
                "get": {
                    "parameters": [
                        {"name": "session", "in": "cookie", "schema": {"type": "string"}}
                    ],
                    "responses": {"200": {"description": "ok"}},
                }
            }
        },
    }
    manifest = _compile(document)
    assert CODE_UNSUPPORTED_PARAMETER_LOCATION in _codes(manifest)
    assert all(
        item.location != "cookie" for case in manifest.cases for item in case.request.parameters
    )


def test_a_structured_parameter_is_reported_because_its_serialization_is_unknown() -> None:
    """Without the source's style/explode rules an array parameter cannot be put in a URL."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Tags", "version": "1.0.0"},
        "paths": {
            "/pets": {
                "get": {
                    "parameters": [
                        {
                            "name": "tags",
                            "in": "query",
                            "schema": {"type": "array", "items": {"type": "string"}},
                        }
                    ],
                    "responses": {"200": {"description": "ok"}},
                }
            }
        },
    }
    manifest = _compile(document)
    assert CODE_UNSUPPORTED_PARAMETER_SHAPE in _codes(manifest)
    # It is optional, so the operation is still covered — without that parameter.
    assert manifest.cases
    assert all(
        item.name != "tags" for case in manifest.cases for item in case.request.parameters
    )


def test_a_required_parameter_with_no_expressible_value_blocks_the_operation() -> None:
    """A case missing a required input tests the suite's gaps, not the implementation."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Tags", "version": "1.0.0"},
        "paths": {
            "/pets": {
                "get": {
                    "parameters": [
                        {
                            "name": "tags",
                            "in": "query",
                            "required": True,
                            "schema": {"type": "array", "items": {"type": "string"}},
                        }
                    ],
                    "responses": {"200": {"description": "ok"}},
                }
            }
        },
    }
    manifest = _compile(document)
    assert manifest.cases == []
    unsupported = [
        finding
        for finding in manifest.findings
        if finding.code == CODE_UNSUPPORTED_PARAMETER_SHAPE
    ]
    assert unsupported and unsupported[0].level == "unsupported"
    assert manifest.counts["operations_skipped"] == 1


def test_an_example_declared_for_a_media_type_we_do_not_send_is_reported() -> None:
    """Sending an XML example as JSON would be a case nobody wrote."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Mixed", "version": "1.0.0"},
        "paths": {
            "/orders": {
                "post": {
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                                "example": {"total": 1},
                            },
                            # Schema-conformant, so it is excluded for its media type alone.
                            "application/xml": {
                                "schema": {"type": "object"},
                                "example": {"total": 2},
                            },
                        },
                    },
                    "responses": {"201": {"description": "created"}},
                }
            }
        },
    }
    manifest = _compile(document)
    bodies = [case.request.body for case in _cases(manifest, CASE_SOURCE_DECLARED_EXAMPLE)]
    assert bodies == [{"total": 1}]
    assert CODE_UNSUPPORTED_MEDIA_TYPE in _codes(manifest)


def test_a_route_placeholder_with_no_declared_parameter_blocks_the_operation() -> None:
    """No URL can be built, so the operation is skipped — loudly."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Broken", "version": "1.0.0"},
        "paths": {
            "/pets/{petId}": {"get": {"responses": {"200": {"description": "ok"}}}}
        },
    }
    manifest = _compile(document)
    assert manifest.cases == []
    assert CODE_UNDECLARED_PATH_PARAMETER in _codes(manifest)
    assert manifest.counts["operations_skipped"] == 1


def test_an_operation_filter_that_matches_nothing_is_reported() -> None:
    """A typo in a CI filter must not read as "that operation is fine"."""
    manifest = _compile(PETSTORE, operations=["GET /nope"])
    assert manifest.cases == []
    assert CODE_OPERATION_NOT_SELECTED in _codes(manifest)


def test_the_operation_cap_reports_its_truncation() -> None:
    """A silently capped suite would claim coverage it does not have."""
    manifest = _compile(PETSTORE, max_operations=1)
    assert len(manifest.operations) == 1
    assert CODE_OPERATION_LIMIT_REACHED in _codes(manifest)
    assert manifest.counts["operations_skipped"] >= 2


# ===========================================================================
# Requests
# ===========================================================================


def test_path_parameters_are_substituted_and_percent_encoded() -> None:
    """A slash in a value must not invent a path segment."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Files", "version": "1.0.0"},
        "paths": {
            "/files/{path}": {
                "get": {
                    "parameters": [
                        {
                            "name": "path",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"},
                            "example": "a/b c",
                        }
                    ],
                    "responses": {"200": {"description": "ok"}},
                }
            }
        },
    }
    manifest = _compile(document)
    case = manifest.cases[0]
    assert case.request.path == "/files/a%2Fb%20c"
    assert case.request.path_template == "/files/{path}"


def test_parameters_are_ordered_deterministically(petstore) -> None:
    """Parameter order is part of the bytes, so it is sorted rather than incidental."""
    for case in petstore.cases:
        ordered = [(item.location, item.name) for item in case.request.parameters]
        assert ordered == sorted(ordered)


def test_a_body_carrying_case_declares_its_media_type(petstore) -> None:
    """A runner needs the Content-Type, and "no body" is distinct from "a null body"."""
    for case in petstore.cases:
        if case.request.has_body:
            assert case.request.media_type == "application/json"
        else:
            assert case.request.media_type is None
            assert case.request.body is None


# ===========================================================================
# Provenance
# ===========================================================================


def test_source_information_is_echoed_verbatim() -> None:
    """The compiler resolves nothing; whatever the caller establishes is what is recorded."""
    api = OpenApiNormalizer().normalize(PETSTORE)
    source = SuiteSourceInfo(
        kind="project",
        reference="project/petstore/1.0.0",
        artifact_slug="petstore",
        version_label="1.0.0",
        published=True,
    )
    manifest = compile_contract_suite(api, source=source)
    assert manifest.source is not None
    assert manifest.source.published is True
    assert manifest.source.reference == "project/petstore/1.0.0"


def test_publication_state_is_never_assumed() -> None:
    """`published` stays null when nobody checked — a suite must not imply agreement."""
    manifest = _compile(PETSTORE)
    assert manifest.source is None


def test_api_identity_is_projected_from_the_model(petstore) -> None:
    """A manifest identifies the API it was compiled from without a second lookup."""
    assert petstore.api.title == "Petstore"
    assert petstore.api.version == "1.0.0"
    assert petstore.api.paradigm == "rest"
    assert petstore.api.servers == ["https://api.example.com/{stage}"]


# ===========================================================================
# Helpers
# ===========================================================================


def _document_with_body(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Return a one-operation document whose POST body is ``schema``."""
    return {
        "openapi": "3.1.0",
        "info": {"title": "Payments", "version": "1.0.0"},
        "paths": {
            "/payments": {
                "post": {
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": schema}},
                    },
                    "responses": {"201": {"description": "created"}},
                }
            }
        },
    }
