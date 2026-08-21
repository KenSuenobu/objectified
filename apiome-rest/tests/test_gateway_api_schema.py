"""Tests for the vendored Gateway API ``HTTPRoute`` schema — FMT-2.3 (#5421).

The gate every emitted manifest passes through, so it is worth proving twice over:

* it **accepts the whole committed Gateway API corpus** unchanged, which is the
  evidence that the encoded rules describe real manifests rather than this
  emitter's habits;
* it **rejects one manifest per rule** — the envelope, the object names, every
  list bound, every closed vocabulary, each of the ``path`` CEL rules and the
  filter companion-field rules — so a rule that silently stops being enforced
  fails a test rather than shipping.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

from app.gateway_api_schema import (
    FILTER_COMPANION_FIELDS,
    GATEWAY_API_GROUP,
    HTTP_METHODS,
    HTTPROUTE_API_VERSIONS,
    HTTPROUTE_VERSIONS,
    MAX_BACKEND_REFS,
    MAX_FILTERS,
    MAX_HEADER_MATCHES,
    MAX_HOSTNAMES,
    MAX_MATCHES,
    MAX_PARENT_REFS,
    MAX_QUERY_MATCHES,
    MAX_RULES,
    PATH_MATCH_TYPES,
    hostname_violations,
    httproute_document_violations,
    httproute_stream_violations,
    validate_httproute_manifest,
)

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "gateway-api"


def _valid() -> Dict[str, Any]:
    """A minimal manifest every test mutates one field of."""
    return {
        "apiVersion": f"{GATEWAY_API_GROUP}/v1",
        "kind": "HTTPRoute",
        "metadata": {"name": "users", "namespace": "identity"},
        "spec": {
            "parentRefs": [{"name": "main-gateway", "namespace": "gateway-system"}],
            "hostnames": ["api.example.com"],
            "rules": [
                {
                    "matches": [
                        {
                            "path": {"type": "PathPrefix", "value": "/users"},
                            "method": "GET",
                            "headers": [{"name": "x-tenant", "value": "acme"}],
                            "queryParams": [{"name": "window", "value": "30d"}],
                        }
                    ],
                    "backendRefs": [{"name": "users-svc", "port": 8080, "weight": 100}],
                }
            ],
        },
    }


def _with(**spec: Any) -> Dict[str, Any]:
    """The valid manifest with ``spec`` fields replaced."""
    document = _valid()
    document["spec"].update(spec)
    return document


def _first_rule(document: Dict[str, Any]) -> Dict[str, Any]:
    """The manifest's only rule, for tests that mutate it in place."""
    return document["spec"]["rules"][0]


def _corpus_documents() -> List[Any]:
    """Every ``HTTPRoute`` in the committed corpus, single files and the manifest set."""
    documents: List[Any] = []
    for path in sorted(CORPUS.rglob("*.yaml")):
        if "negative" in path.parts:
            continue
        for document in yaml.safe_load_all(path.read_text(encoding="utf-8")):
            if isinstance(document, dict) and document.get("kind") == "HTTPRoute":
                documents.append(document)
    return documents


# ---------------------------------------------------------------------------
# The corpus is the evidence the rules are real
# ---------------------------------------------------------------------------


def test_the_corpus_contains_manifests_to_check() -> None:
    assert len(_corpus_documents()) >= 8


@pytest.mark.parametrize("document", _corpus_documents())
def test_every_committed_httproute_passes_the_gate(document: Dict[str, Any]) -> None:
    assert httproute_document_violations(document) == []


def test_the_minimal_fixture_validates_as_a_manifest_stream() -> None:
    text = (CORPUS / "01-minimal-httproute.yaml").read_text(encoding="utf-8")
    validate_httproute_manifest(text, source_label="corpus")


def test_a_multi_document_fixture_validates_as_a_manifest_stream() -> None:
    text = (CORPUS / "05-real-world-microservices.yaml").read_text(encoding="utf-8")
    validate_httproute_manifest(text, source_label="corpus")


# ---------------------------------------------------------------------------
# Vocabulary tables
# ---------------------------------------------------------------------------


def test_every_served_version_is_spelled_as_a_full_api_version() -> None:
    assert HTTPROUTE_API_VERSIONS == {
        f"{GATEWAY_API_GROUP}/{version}" for version in HTTPROUTE_VERSIONS
    }


def test_the_method_vocabulary_is_the_crd_enum_not_the_iana_registry() -> None:
    assert "PURGE" not in HTTP_METHODS
    assert "PATCH" in HTTP_METHODS and "CONNECT" in HTTP_METHODS


def test_every_filter_type_names_a_distinct_companion_field() -> None:
    assert len(set(FILTER_COMPANION_FIELDS.values())) == len(FILTER_COMPANION_FIELDS)


# ---------------------------------------------------------------------------
# The resource envelope
# ---------------------------------------------------------------------------


def test_the_valid_manifest_is_valid() -> None:
    assert httproute_document_violations(_valid()) == []


@pytest.mark.parametrize("version", HTTPROUTE_VERSIONS)
def test_every_served_version_is_accepted(version: str) -> None:
    document = _valid()
    document["apiVersion"] = f"{GATEWAY_API_GROUP}/{version}"
    assert httproute_document_violations(document) == []


def test_an_unserved_api_version_is_rejected() -> None:
    document = _valid()
    document["apiVersion"] = f"{GATEWAY_API_GROUP}/v1alpha2"
    assert any("apiVersion" in problem for problem in httproute_document_violations(document))


def test_another_kind_is_rejected() -> None:
    document = _valid()
    document["kind"] = "GRPCRoute"
    assert any("kind" in problem for problem in httproute_document_violations(document))


def test_a_manifest_that_is_not_a_mapping_is_rejected() -> None:
    assert httproute_document_violations(["not", "a", "resource"]) == [
        "$: a manifest must be a mapping, got list"
    ]


def test_a_missing_name_is_rejected() -> None:
    document = _valid()
    document["metadata"] = {}
    assert "$.metadata.name: is required" in httproute_document_violations(document)


@pytest.mark.parametrize("name", ["Users", "users/v1", "-users", "users_v1", "a" * 254])
def test_an_illegal_object_name_is_rejected(name: str) -> None:
    document = _valid()
    document["metadata"]["name"] = name
    assert any(
        "metadata.name" in problem for problem in httproute_document_violations(document)
    )


def test_an_illegal_namespace_is_rejected() -> None:
    document = _valid()
    document["metadata"]["namespace"] = "Identity.Team"
    assert any(
        "metadata.namespace" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_spec_less_manifest_is_rejected() -> None:
    document = _valid()
    document.pop("spec")
    assert any("$.spec" in problem for problem in httproute_document_violations(document))


def test_a_manifest_with_no_rules_is_rejected() -> None:
    assert any(
        "routes nothing" in problem
        for problem in httproute_document_violations(_with(rules=[]))
    )


# ---------------------------------------------------------------------------
# List bounds
# ---------------------------------------------------------------------------


def test_too_many_hostnames_are_rejected() -> None:
    hostnames = [f"host-{index}.example.com" for index in range(MAX_HOSTNAMES + 1)]
    assert any(
        f"the maximum is {MAX_HOSTNAMES}" in problem
        for problem in httproute_document_violations(_with(hostnames=hostnames))
    )


def test_too_many_parent_refs_are_rejected() -> None:
    parents = [{"name": f"gw-{index}"} for index in range(MAX_PARENT_REFS + 1)]
    assert any(
        f"the maximum is {MAX_PARENT_REFS}" in problem
        for problem in httproute_document_violations(_with(parentRefs=parents))
    )


def test_too_many_rules_are_rejected() -> None:
    rule = _first_rule(_valid())
    assert any(
        f"the maximum is {MAX_RULES}" in problem
        for problem in httproute_document_violations(
            _with(rules=[copy.deepcopy(rule) for _ in range(MAX_RULES + 1)])
        )
    )


def test_too_many_matches_are_rejected() -> None:
    document = _valid()
    match = _first_rule(document)["matches"][0]
    _first_rule(document)["matches"] = [copy.deepcopy(match) for _ in range(MAX_MATCHES + 1)]
    assert any(
        f"the maximum is {MAX_MATCHES}" in problem
        for problem in httproute_document_violations(document)
    )


def test_too_many_header_matches_are_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["headers"] = [
        {"name": f"x-{index}", "value": "v"} for index in range(MAX_HEADER_MATCHES + 1)
    ]
    assert any(
        f"the maximum is {MAX_HEADER_MATCHES}" in problem
        for problem in httproute_document_violations(document)
    )


def test_too_many_query_matches_are_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["queryParams"] = [
        {"name": f"q{index}", "value": "v"} for index in range(MAX_QUERY_MATCHES + 1)
    ]
    assert any(
        f"the maximum is {MAX_QUERY_MATCHES}" in problem
        for problem in httproute_document_violations(document)
    )


def test_too_many_backend_refs_are_rejected() -> None:
    document = _valid()
    _first_rule(document)["backendRefs"] = [
        {"name": f"svc-{index}"} for index in range(MAX_BACKEND_REFS + 1)
    ]
    assert any(
        f"the maximum is {MAX_BACKEND_REFS}" in problem
        for problem in httproute_document_violations(document)
    )


def test_too_many_filters_are_rejected() -> None:
    document = _valid()
    _first_rule(document)["filters"] = [
        {"type": "RequestHeaderModifier", "requestHeaderModifier": {"add": []}}
        for _ in range(MAX_FILTERS + 1)
    ]
    assert any(
        f"the maximum is {MAX_FILTERS}" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_list_field_that_is_not_a_list_is_rejected() -> None:
    assert any(
        "must be a list" in problem
        for problem in httproute_document_violations(_with(hostnames="api.example.com"))
    )


# ---------------------------------------------------------------------------
# Matches: paths, methods, headers, query parameters
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path_type", sorted(PATH_MATCH_TYPES))
def test_every_path_match_type_is_accepted(path_type: str) -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["path"] = {"type": path_type, "value": "/users"}
    assert httproute_document_violations(document) == []


def test_an_unknown_path_match_type_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["path"] = {"type": "Glob", "value": "/users/*"}
    assert any(
        "is not a path match type" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_relative_exact_path_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["path"] = {"type": "Exact", "value": "users"}
    assert any(
        "must be an absolute path" in problem
        for problem in httproute_document_violations(document)
    )


@pytest.mark.parametrize(
    "value", ["/users//1", "/users/./1", "/users/../1", "/users/%2f", "/users/%2F", "/u#1"]
)
def test_the_path_cel_rules_are_enforced(value: str) -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["path"] = {"type": "PathPrefix", "value": value}
    assert any(
        "must not contain" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_regular_expression_path_is_not_held_to_the_absolute_path_rule() -> None:
    """A regex is a pattern, not a path — the CEL rules are scoped to the literal types."""
    document = _valid()
    _first_rule(document)["matches"][0]["path"] = {
        "type": "RegularExpression",
        "value": "/users/(?<id>[0-9]+)$",
    }
    assert httproute_document_violations(document) == []


def test_an_unknown_path_field_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["path"] = {
        "type": "Exact",
        "value": "/users",
        "prefix": "/v1",
    }
    assert any(
        "is not a path match field" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_method_outside_the_enum_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["method"] = "PURGE"
    assert any(
        "is not an HTTP method" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_valueless_header_match_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["headers"] = [{"name": "x-tenant", "value": ""}]
    assert any(
        "headers[0].value" in problem
        for problem in httproute_document_violations(document)
    )


def test_an_illegal_header_name_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["headers"] = [{"name": "x tenant", "value": "a"}]
    assert any(
        "is not a valid header name" in problem
        for problem in httproute_document_violations(document)
    )


def test_an_unknown_header_match_type_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["matches"][0]["headers"] = [
        {"name": "x-tenant", "value": "a", "type": "Prefix"}
    ]
    assert any(
        "is not a match type" in problem
        for problem in httproute_document_violations(document)
    )


# ---------------------------------------------------------------------------
# References
# ---------------------------------------------------------------------------


def test_a_backend_ref_must_name_something() -> None:
    document = _valid()
    _first_rule(document)["backendRefs"] = [{"port": 8080}]
    assert any(
        "backendRefs[0].name: is required" in problem
        for problem in httproute_document_violations(document)
    )


@pytest.mark.parametrize("port", [0, 65536, "8080", True])
def test_an_out_of_range_port_is_rejected(port: Any) -> None:
    document = _valid()
    _first_rule(document)["backendRefs"] = [{"name": "svc", "port": port}]
    assert any(
        "port" in problem for problem in httproute_document_violations(document)
    )


def test_an_out_of_range_weight_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["backendRefs"] = [{"name": "svc", "weight": 1_000_001}]
    assert any(
        "weight" in problem for problem in httproute_document_violations(document)
    )


def test_a_dotted_backend_name_is_rejected() -> None:
    """``ObjectName`` has no dots — a fully-qualified service address is not one."""
    document = _valid()
    _first_rule(document)["backendRefs"] = [{"name": "svc.cluster.local"}]
    assert any(
        "is not a valid object name" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_parent_ref_section_name_is_checked() -> None:
    document = _with(parentRefs=[{"name": "gw", "sectionName": "https listener"}])
    assert any(
        "sectionName" in problem for problem in httproute_document_violations(document)
    )


def test_a_parent_ref_group_may_be_the_core_group() -> None:
    assert httproute_document_violations(_with(parentRefs=[{"name": "gw", "group": ""}])) == []


def test_an_illegal_parent_ref_kind_is_rejected() -> None:
    document = _with(parentRefs=[{"name": "gw", "kind": "1Gateway"}])
    assert any("kind" in problem for problem in httproute_document_violations(document))


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("filter_type,companion", sorted(FILTER_COMPANION_FIELDS.items()))
def test_every_filter_type_is_accepted_with_its_companion(
    filter_type: str, companion: str
) -> None:
    document = _valid()
    _first_rule(document)["filters"] = [{"type": filter_type, companion: {}}]
    assert httproute_document_violations(document) == []


def test_a_filter_without_its_companion_field_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["filters"] = [{"type": "RequestHeaderModifier"}]
    assert any(
        "must be specified for a RequestHeaderModifier filter" in problem
        for problem in httproute_document_violations(document)
    )


def test_a_filter_carrying_another_types_field_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["filters"] = [
        {"type": "URLRewrite", "urlRewrite": {}, "requestRedirect": {}}
    ]
    assert any(
        "must not be set on a URLRewrite filter" in problem
        for problem in httproute_document_violations(document)
    )


def test_an_unknown_filter_type_is_rejected() -> None:
    document = _valid()
    _first_rule(document)["filters"] = [{"type": "Authenticate"}]
    assert any(
        "is not a filter type" in problem
        for problem in httproute_document_violations(document)
    )


# ---------------------------------------------------------------------------
# Streams
# ---------------------------------------------------------------------------


def test_a_stream_reports_the_document_a_violation_came_from() -> None:
    broken = _valid()
    broken["metadata"] = {"name": "Bad Name"}
    problems = httproute_stream_violations([_valid(), broken])
    assert problems and all(problem.startswith("document[1]") for problem in problems)


def test_an_empty_stream_is_rejected() -> None:
    assert httproute_stream_violations([]) == ["$: the manifest stream contains no documents"]


def test_a_stream_that_is_not_a_list_is_rejected() -> None:
    assert httproute_stream_violations({"kind": "HTTPRoute"}) == [
        "$: a manifest stream must be a list of documents"
    ]


def test_validation_refuses_text_the_importer_cannot_read() -> None:
    with pytest.raises(ValueError):
        validate_httproute_manifest("kind: Deployment\n", source_label="not-a-route")


def test_validation_names_every_violation_it_found() -> None:
    text = yaml.safe_dump(
        {
            "apiVersion": f"{GATEWAY_API_GROUP}/v1",
            "kind": "HTTPRoute",
            "metadata": {"name": "Bad Name"},
            "spec": {"rules": [{"matches": [{"method": "PURGE"}]}]},
        }
    )
    with pytest.raises(ValueError) as exc_info:
        validate_httproute_manifest(text)
    assert "metadata.name" in str(exc_info.value)
    assert "is not an HTTP method" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Hostname spelling (used by the emitter)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("host", ["api.example.com", "*.apps.example.com", "localhost"])
def test_a_legal_hostname_has_no_violation(host: str) -> None:
    assert hostname_violations(host) is None


@pytest.mark.parametrize("host", ["API.example.com", "api.example.com:8080", "", "-api"])
def test_an_illegal_hostname_reports_why(host: str) -> None:
    assert hostname_violations(host) is not None
