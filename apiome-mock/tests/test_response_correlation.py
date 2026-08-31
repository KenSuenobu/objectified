"""Request-correlated responses on the default path (#5527, MSC-1.1).

Two layers are covered here: the pure passes in :mod:`apiome_mock.correlation` (name matching,
request-body echo, explicit pointer bindings, seed derivation, lenient parsing) and the served
behaviour end to end through the hosted application — including the precedence rules that say a
scenario override and stateful CRUD still win, and the ``mode: "off"`` default that leaves today's
behaviour byte-identical.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_match import MatchContext
from app.mock_routing import extract_operations
from app.mock_template import RenderBudget, RenderEnv, TemplateLimitError, make_rng
from fastapi.testclient import TestClient

from apiome_mock.correlation import (
    EMPTY_CORRELATION,
    CorrelationConfig,
    correlate_response_body,
    derive_request_seed,
    normalize_property_name,
    parse_response_correlation,
    path_parameter_aliases,
)
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.scenarios import parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

_PET = {
    "type": "object",
    "properties": {
        "id": {"type": "integer"},
        "name": {"type": "string"},
    },
}

PETSTORE_SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Correlation Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"type": "array", "items": _PET},
                                "example": [{"id": 1, "name": "Rex"}],
                            }
                        },
                    }
                },
            },
            "post": {
                "operationId": "createPet",
                # Carries id/name so the stateful-CRUD precedence test can address a created
                # resource by its own id rather than a synthesized one.
                "requestBody": {"content": {"application/json": {"schema": _PET}}},
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "integer"},
                                        "name": {"type": "string"},
                                        "createdAt": {"type": "string"},
                                        "owner": {
                                            "type": "object",
                                            "properties": {"name": {"type": "string"}},
                                        },
                                    },
                                },
                                "example": {
                                    "id": 9,
                                    "name": "Nym",
                                    "createdAt": "2020-01-01T00:00:00Z",
                                    "owner": {"name": "Ada"},
                                },
                            }
                        },
                    }
                },
            },
        },
        "/pets/{petId}": {
            "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "string"}}],
            "get": {
                "operationId": "getPet",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "integer"},
                                        "name": {"type": "string"},
                                        "ref": {"type": "string"},
                                        "tags": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "petId": {"type": "integer"},
                                                    "label": {"type": "string"},
                                                },
                                            },
                                        },
                                    },
                                },
                                "example": {
                                    "id": 1,
                                    "name": "Rex",
                                    "ref": "unset",
                                    "tags": [{"petId": 1, "label": "good"}],
                                },
                            }
                        },
                    }
                },
            },
        },
        "/pets/{petId}/tags": {
            "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "string"}}],
            "get": {
                "operationId": "listPetTags",
                "responses": {
                    "200": {
                        "description": "synthesized on purpose (no example)",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["tags"],
                                    "properties": {"tags": {"type": "array", "items": {"type": "string"}}},
                                }
                            }
                        },
                    }
                },
            },
        },
    },
}

SCENARIO_SETTINGS = {
    "scenarios": {
        "canned": {
            "operations": {"GET /pets/{petId}": {"responses": [{"status": 200, "body": {"id": 1, "name": "Canned"}}]}}
        }
    }
}

BASE = "/demo/petstore/1.0.0"


def _env(
    *,
    method: str = "GET",
    path_params: dict[str, str] | None = None,
    query: dict[str, tuple[str, ...]] | None = None,
    headers: dict[str, str] | None = None,
    body: Any = None,
    body_present: bool = False,
    fixtures: dict[str, Any] | None = None,
    seed: int = 0,
) -> RenderEnv:
    """Build a render environment for the pure-pass tests."""
    ctx = MatchContext(
        method=method,
        path_params=path_params or {},
        query=query or {},
        headers=headers or {},
        body=body,
        body_present=body_present,
    )
    return RenderEnv(ctx=ctx, rng=make_rng(seed, "test"), fixtures=fixtures or {})


def _correlate(
    value: Any,
    config: CorrelationConfig,
    *,
    operation_key: str = "GET /pets/{petId}",
    **kwargs: Any,
) -> Any:
    """Correlate ``value`` with a request described by ``kwargs`` and return the outcome."""
    return correlate_response_body(
        value,
        config=config,
        operation_key=operation_key,
        env=_env(**kwargs),
        budget=RenderBudget(),
    )


# ---------------------------------------------------------------------------
# Parsing (lenient by contract)
# ---------------------------------------------------------------------------


def test_a_full_block_parses_into_modes_and_pointer_bindings() -> None:
    config = parse_response_correlation(
        {
            "responseCorrelation": {
                "mode": "inferred",
                "operations": {"get /pets/{petId}": {"/id": "{{request.path.petId}}"}},
            }
        }
    )

    assert config.mode == "inferred"
    assert config.binds_path_params and config.echoes_request_body
    assert config.pointers_for("GET /pets/{petId}") == (("/id", "{{request.path.petId}}"),)


def test_json_text_settings_parse_the_same_as_a_dict() -> None:
    config = parse_response_correlation('{"responseCorrelation": {"mode": "path-params"}}')

    assert config.mode == "path-params"
    assert config.binds_path_params and not config.echoes_request_body


@pytest.mark.parametrize(
    "settings",
    [
        None,
        "not json",
        [],
        {},
        {"responseCorrelation": "nope"},
        {"responseCorrelation": {}},
        {"responseCorrelation": {"mode": "off"}},
        {"responseCorrelation": {"mode": "guess"}},
        {"responseCorrelation": {"mode": 7}},
    ],
)
def test_a_malformed_or_off_block_is_skipped_never_raised(settings: Any) -> None:
    assert parse_response_correlation(settings) == EMPTY_CORRELATION


def test_unusable_operation_entries_are_dropped_without_losing_the_good_ones() -> None:
    config = parse_response_correlation(
        {
            "responseCorrelation": {
                "mode": "explicit",
                "operations": {
                    "not an operation": {"/id": "x"},
                    "GET /pets": {"bad-pointer": "x", "/ok": "y", "/num": 7},
                    "GET /pets/{petId}": "not a map",
                },
            }
        }
    )

    assert config.pointers_for("GET /pets") == (("/ok", "y"),)
    assert config.pointers_for("GET /pets/{petId}") == ()


def test_explicit_mode_runs_no_inference_pass() -> None:
    config = parse_response_correlation({"responseCorrelation": {"mode": "explicit"}})

    assert config.enabled
    assert not config.binds_path_params
    assert not config.echoes_request_body


def test_needs_request_body_follows_the_method_the_mode_and_the_expressions() -> None:
    inferred = CorrelationConfig(mode="inferred")
    explicit_body = CorrelationConfig(mode="explicit", operations={"GET /pets": (("/id", "{{request.body#/id}}"),)})
    explicit_path = CorrelationConfig(mode="explicit", operations={"GET /pets": (("/id", "{{request.path.petId}}"),)})

    assert inferred.needs_request_body("POST /pets")
    assert not inferred.needs_request_body("GET /pets")
    assert explicit_body.needs_request_body("GET /pets")
    assert not explicit_path.needs_request_body("GET /pets")
    assert not EMPTY_CORRELATION.needs_request_body("GET /pets")


# ---------------------------------------------------------------------------
# Name matching
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("petId", "petid"), ("pet_id", "petid"), ("Pet-Id", "petid"), ("id", "id"), ("__", "")],
)
def test_property_names_normalize_to_one_comparison_form(raw: str, expected: str) -> None:
    assert normalize_property_name(raw) == expected


def test_a_suffixed_parameter_also_claims_the_bare_id() -> None:
    assert path_parameter_aliases({"petId": "42"}) == {"petid": "42", "id": "42"}


def test_the_last_parameter_wins_the_bare_id() -> None:
    aliases = path_parameter_aliases({"userId": "7", "petId": "42"})

    assert aliases == {"userid": "7", "petid": "42", "id": "42"}


def test_a_parameter_that_is_not_an_identifier_claims_only_its_own_name() -> None:
    assert path_parameter_aliases({"slug": "rex"}) == {"slug": "rex"}


# ---------------------------------------------------------------------------
# The path-parameter pass
# ---------------------------------------------------------------------------


def test_path_params_bind_at_every_depth_and_inside_arrays() -> None:
    body = {"id": 1, "name": "Rex", "tags": [{"petId": 1, "label": "good"}], "owner": {"pet_id": 1}}

    outcome = _correlate(body, CorrelationConfig(mode="path-params"), path_params={"petId": "42"})

    assert outcome.body == {
        "id": 42,
        "name": "Rex",
        "tags": [{"petId": 42, "label": "good"}],
        "owner": {"pet_id": 42},
    }
    assert outcome.applied == ("path-params",)


def test_a_bound_value_takes_the_json_type_of_the_value_it_replaces() -> None:
    body = {"id": 1, "ref": "unset", "ratio": 0.5, "flag": False}
    config = CorrelationConfig(mode="path-params")

    integer = _correlate(body, config, path_params={"id": "42"}).body
    text = _correlate({"slug": "old"}, config, path_params={"slug": "rex"}).body
    ratio = _correlate({"ratio": 0.5}, config, path_params={"ratio": "1.5"}).body
    flag = _correlate({"flag": False}, config, path_params={"flag": "true"}).body

    assert integer["id"] == 42 and isinstance(integer["id"], int)
    assert text == {"slug": "rex"}
    assert ratio == {"ratio": 1.5}
    assert flag == {"flag": True}


def test_an_unconvertible_value_stays_text_rather_than_being_dropped() -> None:
    outcome = _correlate({"id": 1}, CorrelationConfig(mode="path-params"), path_params={"id": "abc"})

    assert outcome.body == {"id": "abc"}


def test_a_container_property_is_never_clobbered_by_a_path_parameter() -> None:
    body = {"id": {"value": 1}}

    outcome = _correlate(body, CorrelationConfig(mode="path-params"), path_params={"id": "42"})

    assert outcome.body == {"id": {"value": 1}}
    assert outcome.applied == ()


def test_nothing_is_reported_when_no_property_matches() -> None:
    outcome = _correlate({"name": "Rex"}, CorrelationConfig(mode="path-params"), path_params={"petId": "42"})

    assert outcome.applied == ()
    assert outcome.header_value() == "none"


# ---------------------------------------------------------------------------
# The request-body echo pass
# ---------------------------------------------------------------------------


def _echo(response: Any, request_body: Any, method: str = "POST") -> Any:
    return _correlate(
        response,
        CorrelationConfig(mode="inferred"),
        operation_key="POST /pets",
        method=method,
        body=request_body,
        body_present=True,
    )


def test_what_was_sent_comes_back_while_server_owned_fields_stay_synthesized() -> None:
    outcome = _echo(
        {"id": 9, "name": "Nym", "createdAt": "2020-01-01T00:00:00Z"},
        {"id": 5, "name": "Rex", "createdAt": "1999-01-01T00:00:00Z"},
    )

    assert outcome.body == {"id": 9, "name": "Rex", "createdAt": "2020-01-01T00:00:00Z"}
    assert outcome.applied == ("inferred",)


def test_a_field_absent_from_the_request_stays_synthesized() -> None:
    outcome = _echo({"name": "Nym", "colour": "grey"}, {"name": "Rex"})

    assert outcome.body == {"name": "Rex", "colour": "grey"}


def test_nested_objects_align_by_name() -> None:
    outcome = _echo(
        {"name": "Nym", "owner": {"name": "Ada", "city": "Paris"}},
        {"name": "Rex", "owner": {"name": "Bo"}},
    )

    assert outcome.body == {"name": "Rex", "owner": {"name": "Bo", "city": "Paris"}}


def test_an_envelope_that_matches_nothing_offers_the_same_request_to_its_children() -> None:
    outcome = _echo({"data": {"name": "Nym"}}, {"name": "Rex"})

    assert outcome.body == {"data": {"name": "Rex"}}


def test_a_matched_level_does_not_leak_its_fields_into_unmatched_siblings() -> None:
    outcome = _echo({"name": "Nym", "owner": {"name": "Ada"}}, {"name": "Rex"})

    assert outcome.body == {"name": "Rex", "owner": {"name": "Ada"}}


def test_a_shape_disagreement_keeps_the_synthesized_value() -> None:
    outcome = _echo({"owner": {"name": "Ada"}}, {"owner": "just-a-string"})

    assert outcome.body == {"owner": {"name": "Ada"}}
    assert outcome.applied == ()


def test_a_list_field_is_echoed_whole() -> None:
    outcome = _echo({"tags": ["a"]}, {"tags": ["x", "y"]})

    assert outcome.body == {"tags": ["x", "y"]}


def test_reads_are_never_echoed() -> None:
    outcome = _echo({"name": "Nym"}, {"name": "Rex"}, method="GET")

    assert outcome.body == {"name": "Nym"}
    assert outcome.applied == ()


# ---------------------------------------------------------------------------
# The explicit pointer map
# ---------------------------------------------------------------------------


def test_an_explicit_binding_targets_exactly_the_pointer_it_names() -> None:
    config = CorrelationConfig(
        mode="explicit", operations={"GET /pets/{petId}": (("/ref", "pet-{{request.path.petId}}"),)}
    )

    outcome = _correlate({"id": 1, "ref": "unset"}, config, path_params={"petId": "42"})

    assert outcome.body == {"id": 1, "ref": "pet-42"}
    assert outcome.applied == ("explicit",)


def test_explicit_wins_over_an_inferred_binding_for_the_same_pointer() -> None:
    config = CorrelationConfig(
        mode="inferred", operations={"GET /pets/{petId}": (("/id", "{{request.query.override}}"),)}
    )

    outcome = _correlate(
        {"id": 1},
        config,
        path_params={"petId": "42"},
        query={"override": ("99",)},
    )

    assert outcome.body == {"id": "99"}
    assert outcome.applied == ("path-params", "explicit")


def test_an_unresolvable_expression_binds_null_rather_than_failing() -> None:
    config = CorrelationConfig(
        mode="explicit", operations={"GET /pets/{petId}": (("/ref", "{{request.query.missing}}"),)}
    )

    outcome = _correlate({"ref": "unset"}, config)

    assert outcome.body == {"ref": None}


def test_a_pointer_may_address_the_whole_body() -> None:
    config = CorrelationConfig(mode="explicit", operations={"GET /pets/{petId}": (("", "{{request.body}}"),)})

    outcome = _correlate({"id": 1}, config, body={"replaced": True}, body_present=True)

    assert outcome.body == {"replaced": True}


def test_a_final_missing_key_is_created_but_a_missing_container_is_not() -> None:
    creates = CorrelationConfig(mode="explicit", operations={"GET /pets/{petId}": (("/added", "yes"),)})
    skips = CorrelationConfig(mode="explicit", operations={"GET /pets/{petId}": (("/absent/deep", "yes"),)})

    assert _correlate({"id": 1}, creates).body == {"id": 1, "added": "yes"}
    assert _correlate({"id": 1}, skips).body == {"id": 1}


def test_an_array_index_binds_in_range_and_is_skipped_out_of_range() -> None:
    inside = CorrelationConfig(mode="explicit", operations={"GET /pets/{petId}": (("/tags/0", "first"),)})
    outside = CorrelationConfig(mode="explicit", operations={"GET /pets/{petId}": (("/tags/9", "nope"),)})

    assert _correlate({"tags": ["a", "b"]}, inside).body == {"tags": ["first", "b"]}
    assert _correlate({"tags": ["a", "b"]}, outside).body == {"tags": ["a", "b"]}


def test_bindings_apply_in_stored_order_so_the_outcome_is_deterministic() -> None:
    config = CorrelationConfig(
        mode="explicit", operations={"GET /pets/{petId}": (("/ref", "first"), ("/ref", "second"))}
    )

    assert _correlate({"ref": "unset"}, config).body == {"ref": "second"}


def test_an_oversized_render_raises_the_shared_template_limit_error() -> None:
    config = CorrelationConfig(mode="explicit", operations={"GET /pets/{petId}": (("/ref", "{{fixture.big}}"),)})

    with pytest.raises(TemplateLimitError):
        correlate_response_body(
            {"ref": "unset"},
            config=config,
            operation_key="GET /pets/{petId}",
            env=_env(fixtures={"big": "x" * 400_000}),
            budget=RenderBudget(),
        )


def test_a_body_that_is_absent_is_left_alone() -> None:
    outcome = _correlate(None, CorrelationConfig(mode="inferred"), path_params={"petId": "42"})

    assert outcome.body is None
    assert outcome.applied == ()


# ---------------------------------------------------------------------------
# Seed derivation
# ---------------------------------------------------------------------------


def test_the_derived_seed_is_stable_for_one_request_and_differs_across_path_parameters() -> None:
    first = derive_request_seed("GET", "/pets/{petId}", {"petId": "42"})
    again = derive_request_seed("GET", "/pets/{petId}", {"petId": "42"})
    other = derive_request_seed("GET", "/pets/{petId}", {"petId": "43"})

    assert first == again
    assert first != other
    assert first >= 0


def test_the_derived_seed_separates_methods_and_operations() -> None:
    get = derive_request_seed("GET", "/pets/{petId}", {"petId": "42"})
    delete = derive_request_seed("DELETE", "/pets/{petId}", {"petId": "42"})
    tags = derive_request_seed("GET", "/pets/{petId}/tags", {"petId": "42"})

    assert len({get, delete, tags}) == 3


# ---------------------------------------------------------------------------
# Served behaviour
# ---------------------------------------------------------------------------


def _compiled(settings: dict[str, Any]) -> CompiledSpec:
    """Compile the test spec with one ``mock_settings`` blob."""
    from apiome_mock.correlation import parse_response_correlation as parse

    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
        scenarios=parse_scenarios(settings),
        correlation=parse(settings),
    )


ClientFactory = Callable[[dict[str, Any]], Any]


@pytest.fixture
def serving(monkeypatch: pytest.MonkeyPatch, mock_pool: Any) -> Iterator[ClientFactory]:
    """A factory yielding a hosted-runtime client for one ``mock_settings`` blob.

    Only spec *resolution* is stubbed (access status and the Postgres read); routing, validation,
    scenarios, sessions, and correlation are the application's own code path.
    """
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()

    @contextmanager
    def build(settings: dict[str, Any]) -> Iterator[TestClient]:
        from apiome_mock.server import create_app

        with (
            patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
            patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
            patch("apiome_mock.server.record_mock_request"),
            patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
            patch("apiome_mock.handler.load_compiled_spec", new=AsyncMock(return_value=_compiled(settings))),
        ):
            app = create_app()
            with TestClient(app, raise_server_exceptions=False) as client:
                app.state.db_pool = mock_pool
                app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
                app.state.session_store = InMemorySessionStore(
                    SessionCaps(
                        ttl_seconds=3600.0,
                        max_resources=50,
                        max_bytes=1_048_576,
                        max_sessions=100,
                    )
                )
                yield client

    yield build
    get_settings.cache_clear()


def test_correlation_is_off_by_default_and_changes_nothing(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.get(f"{BASE}/pets/42")

    assert response.status_code == 200
    assert response.json() == {"id": 1, "name": "Rex", "ref": "unset", "tags": [{"petId": 1, "label": "good"}]}
    assert "X-Mock-Correlation" not in response.headers
    assert "X-Mock-Schema-Valid" not in response.headers


def test_path_params_mode_answers_with_the_id_that_was_asked_for(serving: ClientFactory) -> None:
    with serving({"responseCorrelation": {"mode": "path-params"}}) as client:
        response = client.get(f"{BASE}/pets/42")

    assert response.json() == {"id": 42, "name": "Rex", "ref": "unset", "tags": [{"petId": 42, "label": "good"}]}
    assert response.headers["X-Mock-Correlation"] == "path-params"
    assert response.headers["X-Mock-Schema-Valid"] == "true"


def test_inferred_mode_echoes_the_created_resource_and_synthesizes_the_rest(serving: ClientFactory) -> None:
    with serving({"responseCorrelation": {"mode": "inferred"}}) as client:
        response = client.post(f"{BASE}/pets", json={"name": "Rex", "owner": {"name": "Bo"}})

    assert response.status_code == 201
    assert response.json() == {
        "id": 9,
        "name": "Rex",
        "createdAt": "2020-01-01T00:00:00Z",
        "owner": {"name": "Bo"},
    }
    assert response.headers["X-Mock-Correlation"] == "inferred"


def test_explicit_mode_binds_exactly_the_pointers_it_names(serving: ClientFactory) -> None:
    settings = {
        "responseCorrelation": {
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/ref": "{{request.query.owner}}"}},
        }
    }

    with serving(settings) as client:
        response = client.get(f"{BASE}/pets/42", params={"owner": "ada"})

    assert response.json() == {"id": 1, "name": "Rex", "ref": "ada", "tags": [{"petId": 1, "label": "good"}]}
    assert response.headers["X-Mock-Correlation"] == "explicit"


def test_two_unseeded_requests_differ_by_path_parameter_and_each_repeats(serving: ClientFactory) -> None:
    with serving({"responseCorrelation": {"mode": "path-params"}}) as client:
        first = client.get(f"{BASE}/pets/42/tags").json()
        again = client.get(f"{BASE}/pets/42/tags").json()
        other = client.get(f"{BASE}/pets/43/tags").json()

    assert first == again
    assert first != other


def test_an_explicit_seed_still_wins_over_the_derived_one(serving: ClientFactory) -> None:
    with serving({"responseCorrelation": {"mode": "path-params"}}) as client:
        correlated = client.get(f"{BASE}/pets/42/tags", params={"__seed": "7"}).json()
    with serving({}) as plain:
        uncorrelated = plain.get(f"{BASE}/pets/42/tags", params={"__seed": "7"}).json()

    assert correlated == uncorrelated


def test_a_correlated_body_that_violates_the_response_schema_is_surfaced(serving: ClientFactory) -> None:
    settings = {
        "responseCorrelation": {
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/id": "{{request.header.x-pet-id}}"}},
        }
    }

    with serving(settings) as client:
        response = client.get(f"{BASE}/pets/42", headers={"X-Pet-Id": "not-a-number"})

    assert response.status_code == 200
    assert response.json()["id"] == "not-a-number"
    assert response.headers["X-Mock-Schema-Valid"] == "false"


def test_a_malformed_stored_block_is_skipped_never_raised(serving: ClientFactory) -> None:
    with serving({"responseCorrelation": {"mode": "sideways", "operations": 7}}) as client:
        response = client.get(f"{BASE}/pets/42")

    assert response.status_code == 200
    assert response.json()["id"] == 1
    assert "X-Mock-Correlation" not in response.headers


def test_a_scenario_override_still_wins_over_correlation(serving: ClientFactory) -> None:
    settings = {**SCENARIO_SETTINGS, "responseCorrelation": {"mode": "path-params"}}

    with serving(settings) as client:
        response = client.get(f"{BASE}/pets/42", headers={"X-Mock-Scenario": "canned"})

    assert response.json() == {"id": 1, "name": "Canned"}
    assert "X-Mock-Correlation" not in response.headers


def test_stateful_crud_still_wins_over_correlation(serving: ClientFactory) -> None:
    session = {"X-Mock-Session": "correlation-crud"}

    with serving({"responseCorrelation": {"mode": "inferred"}}) as client:
        client.post(f"{BASE}/pets", json={"id": 7, "name": "Stored"}, headers=session)
        response = client.get(f"{BASE}/pets/7", headers=session)

    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "Stored"}
    assert "X-Mock-Correlation" not in response.headers


def test_a_forced_status_is_not_correlated(serving: ClientFactory) -> None:
    with serving({"responseCorrelation": {"mode": "path-params"}}) as client:
        response = client.get(f"{BASE}/pets/42", params={"__status": "200"})

    assert response.json()["id"] == 1
    assert "X-Mock-Correlation" not in response.headers
