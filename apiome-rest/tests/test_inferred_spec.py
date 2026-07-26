"""Unit tests for the shared inferred-spec engine (MFI-32.1 / IXH-7.4)."""

from __future__ import annotations

import json

from app.inferred_spec import HttpObservation, infer_canonical_api


def test_path_templating_from_repeated_numeric_ids() -> None:
    observations = [
        HttpObservation(method="GET", url="https://api.example.com/users/1"),
        HttpObservation(method="GET", url="https://api.example.com/users/2"),
        HttpObservation(method="GET", url="https://api.example.com/users/99"),
    ]
    result = infer_canonical_api(observations, title="Users", format_key="http-file")
    ops = result.api.services[0].operations
    assert len(ops) == 1
    assert ops[0].http_path == "/users/{id}"
    assert ops[0].http_method == "GET"
    assert ops[0].extras["provenance"] == "inferred"
    assert ops[0].extras["sample_count"] == 3
    assert any(p.name == "id" and p.location.value == "path" for p in ops[0].parameters)
    assert len(result.path_inferences) == 1
    evidence = result.path_inferences[0]
    assert evidence.template == "/users/{id}"
    assert set(evidence.sample_urls) == {
        "https://api.example.com/users/1",
        "https://api.example.com/users/2",
        "https://api.example.com/users/99",
    }
    assert any(kind == "param" and value == "id" for _, kind, value in evidence.generalized_segments)


def test_uuid_and_hash_segments_generalize() -> None:
    observations = [
        HttpObservation(
            method="GET",
            url="https://api.example.com/orders/550e8400-e29b-41d4-a716-446655440000",
        ),
        HttpObservation(
            method="GET",
            url="https://api.example.com/orders/6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        ),
    ]
    result = infer_canonical_api(observations, format_key="http-file")
    assert result.api.services[0].operations[0].http_path == "/orders/{id}"


def test_query_param_union_required_when_always_present() -> None:
    observations = [
        HttpObservation(method="GET", url="https://api.example.com/items?limit=10&page=1"),
        HttpObservation(method="GET", url="https://api.example.com/items?limit=20"),
    ]
    result = infer_canonical_api(observations, format_key="http-file")
    op = result.api.services[0].operations[0]
    by_name = {p.name: p for p in op.parameters if p.location.value == "query"}
    assert by_name["limit"].required is True
    assert by_name["page"].required is False
    assert by_name["limit"].extras["provenance"] == "inferred"


def test_schema_widening_across_request_bodies() -> None:
    observations = [
        HttpObservation(
            method="POST",
            url="https://api.example.com/pets",
            request_body=json.dumps({"name": "fido", "age": 3}),
            headers=(("Content-Type", "application/json"),),
        ),
        HttpObservation(
            method="POST",
            url="https://api.example.com/pets",
            request_body=json.dumps({"name": "mittens", "age": 2, "tag": "cat"}),
            headers=(("Content-Type", "application/json"),),
        ),
    ]
    result = infer_canonical_api(observations, format_key="http-file")
    op = result.api.services[0].operations[0]
    assert op.http_path == "/pets"
    req = next(m for m in op.messages if m.role.value == "request")
    assert req.extras["provenance"] == "inferred"
    # Widened schema should include tag as optional (not in required intersection of both)
    type_names = {t.name for t in result.api.types}
    assert any("Pet" in name or "Request" in name for name in type_names)
    pet_type = next(t for t in result.api.types if "Pet" in t.name or "Request" in t.name)
    field_names = {f.name for f in pet_type.fields}
    assert "name" in field_names
    assert "age" in field_names
    assert "tag" in field_names


def test_auth_scheme_inferred_from_authorization_header() -> None:
    observations = [
        HttpObservation(
            method="GET",
            url="https://api.example.com/me",
            headers=(("Authorization", "Bearer tok_abc"),),
        ),
    ]
    result = infer_canonical_api(observations, format_key="http-file")
    assert "bearer" in result.api.extras["inferred_auth_schemes"]


def test_empty_observations_yield_empty_service() -> None:
    result = infer_canonical_api([], title="Empty", format_key="http-file")
    assert result.api.title == "Empty"
    assert result.api.services[0].operations == []
    assert result.path_inferences == ()
    assert result.api.extras["provenance"] == "inferred"


def test_deterministic_for_fixed_input() -> None:
    observations = [
        HttpObservation(method="GET", url="https://api.example.com/users/2", source_location="10:1"),
        HttpObservation(method="POST", url="https://api.example.com/users", request_body='{"n":1}'),
        HttpObservation(method="GET", url="https://api.example.com/users/1", source_location="1:1"),
    ]
    a = infer_canonical_api(observations, format_key="http-file")
    b = infer_canonical_api(list(reversed(observations)), format_key="http-file")
    assert a.api.model_dump() == b.api.model_dump()
    assert a.sample_counts == b.sample_counts
    assert [e.as_dict() for e in a.path_inferences] == [e.as_dict() for e in b.path_inferences]


def test_per_file_provenance_on_operations() -> None:
    observations = [
        HttpObservation(
            method="GET",
            url="https://api.example.com/ping",
            source_file="a.http",
            source_label="a.http",
            source_location="1:1",
        ),
        HttpObservation(
            method="GET",
            url="https://api.example.com/health",
            source_file="b.http",
            source_label="b.http",
            source_location="1:1",
        ),
    ]
    result = infer_canonical_api(observations, format_key="http-file")
    files = {
        op.http_path: op.extras.get("source_files")
        for op in result.api.services[0].operations
    }
    assert files["/ping"] == ["a.http"]
    assert files["/health"] == ["b.http"]


def test_different_methods_do_not_collapse() -> None:
    observations = [
        HttpObservation(method="GET", url="https://api.example.com/users/1"),
        HttpObservation(method="DELETE", url="https://api.example.com/users/1"),
    ]
    result = infer_canonical_api(observations, format_key="http-file")
    methods = sorted(op.http_method for op in result.api.services[0].operations)
    assert methods == ["DELETE", "GET"]
    for op in result.api.services[0].operations:
        assert op.http_path == "/users/{id}"
