"""Unit tests for mock scenario settings validation/canonicalization (#4454, SIM-4.2)."""

from __future__ import annotations

from app.mock_scenario_settings import (
    MAX_SCENARIOS,
    normalize_operation_key,
    scenarios_from_storage,
    scenarios_to_storage,
    validate_mock_scenarios,
)
from app.models import MockScenarioSpec

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
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
                    },
                    "429": {"description": "throttled (no content)"},
                }
            }
        },
        "/pets/{petId}": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                }
            }
        },
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                },
                "additionalProperties": False,
            }
        }
    },
}


def _scenarios(raw: dict) -> dict[str, MockScenarioSpec]:
    return {name: MockScenarioSpec.model_validate(value) for name, value in raw.items()}


def test_valid_scenario_passes() -> None:
    scenarios = _scenarios(
        {
            "happy-path": {
                "description": "All good.",
                "operations": {
                    "GET /pets": {
                        "responses": [{"status": 200, "body": [{"id": 1, "name": "Rex"}]}]
                    }
                },
            }
        }
    )
    assert validate_mock_scenarios(scenarios, SPEC) == []


def test_unknown_operation_is_rejected() -> None:
    scenarios = _scenarios(
        {"s": {"operations": {"DELETE /pets": {"responses": [{"status": 200}]}}}}
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 1
    assert "no operation DELETE /pets exists" in errors[0]


def test_malformed_operation_key_is_rejected() -> None:
    scenarios = _scenarios({"s": {"operations": {"pets": {"responses": [{"status": 200}]}}}})
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 1
    assert "GET /pets/{petId}" in errors[0]


def test_undefined_status_requires_off_spec() -> None:
    scenarios = _scenarios(
        {"s": {"operations": {"GET /pets": {"responses": [{"status": 503}]}}}}
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 1
    assert "status 503 is not defined" in errors[0]

    off_spec = _scenarios(
        {"s": {"operations": {"GET /pets": {"responses": [{"status": 503, "offSpec": True}]}}}}
    )
    assert validate_mock_scenarios(off_spec, SPEC) == []


def test_body_schema_mismatch_requires_off_spec() -> None:
    bad_body = {"operations": {"GET /pets": {"responses": [{"status": 200, "body": [{"id": "x"}]}]}}}
    errors = validate_mock_scenarios(_scenarios({"s": bad_body}), SPEC)
    assert len(errors) == 1
    assert "does not match" in errors[0]

    bad_body["operations"]["GET /pets"]["responses"][0]["offSpec"] = True
    assert validate_mock_scenarios(_scenarios({"s": bad_body}), SPEC) == []


def test_body_on_contentless_response_requires_off_spec() -> None:
    scenarios = _scenarios(
        {"s": {"operations": {"GET /pets": {"responses": [{"status": 429, "body": {"error": "quota"}}]}}}}
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 1
    assert "declares no response content" in errors[0]


def test_headerless_status_only_response_on_contentless_status_passes() -> None:
    scenarios = _scenarios(
        {"s": {"operations": {"GET /pets": {"responses": [{"status": 429, "headers": {"Retry-After": "60"}}]}}}}
    )
    assert validate_mock_scenarios(scenarios, SPEC) == []


def test_undeclared_media_type_requires_off_spec() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "responses": [{"status": 200, "body": "id,name", "mediaType": "text/csv"}]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 1
    assert "media type 'text/csv' is not declared" in errors[0]


def test_scenario_name_shape_is_enforced() -> None:
    scenarios = _scenarios({"bad name!": {"operations": {}}})
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 1
    assert "Scenario name 'bad name!' is invalid" in errors[0]


def test_reserved_and_malformed_headers_are_rejected() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "responses": [
                            {
                                "status": 200,
                                "headers": {
                                    "Content-Length": "5",
                                    "Bad Header": "x",
                                    "X-Evil": "a\r\nSet-Cookie: pwn",
                                },
                                "offSpec": True,
                            }
                        ]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert len(errors) == 3
    assert any("managed by the server" in e for e in errors)
    assert any("invalid header name" in e for e in errors)
    assert any("CR/LF" in e for e in errors)


def test_scenario_count_limit() -> None:
    scenarios = _scenarios({f"s{i}": {"operations": {}} for i in range(MAX_SCENARIOS + 1)})
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("At most" in e for e in errors)


def test_storage_canonicalization() -> None:
    scenarios = _scenarios(
        {
            "quota-exceeded": {
                "description": "Throttled.",
                "operations": {
                    "get /pets": {
                        "responses": [
                            {"status": 429, "headers": {"Retry-After": "60"}, "offSpec": True},
                            {"status": 200, "body": None, "mediaType": "application/json"},
                        ]
                    }
                },
            }
        }
    )
    storage = scenarios_to_storage(scenarios)
    ops = storage["quota-exceeded"]["operations"]
    assert set(ops) == {"GET /pets"}
    first, second = ops["GET /pets"]["responses"]
    assert first == {"status": 429, "headers": {"Retry-After": "60"}, "offSpec": True}
    assert "body" not in first
    assert second == {"status": 200, "body": None, "mediaType": "application/json"}
    assert storage["quota-exceeded"]["description"] == "Throttled."


def test_scenarios_from_storage_variants() -> None:
    assert scenarios_from_storage(None) == ({}, True)
    assert scenarios_from_storage({}) == ({}, True)
    assert scenarios_from_storage({"mode": "private"}) == ({}, True)
    assert scenarios_from_storage('{"scenarios": {"s": {}}}') == ({"s": {}}, True)
    assert scenarios_from_storage("not json") == ({}, False)
    assert scenarios_from_storage({"scenarios": "nope"}) == ({}, False)


def test_normalize_operation_key() -> None:
    assert normalize_operation_key("get /pets") == "GET /pets"
    assert normalize_operation_key("GET") is None
    assert normalize_operation_key("GET pets") is None


# ---------------------------------------------------------------------------
# Declarative rules and templates (#4744, PMR-2.1)
# ---------------------------------------------------------------------------


def test_valid_rules_and_templates_pass() -> None:
    scenarios = _scenarios(
        {
            "personalized": {
                "operations": {
                    "GET /pets/{petId}": {
                        "rules": [
                            {
                                "when": {"path": {"petId": {"equals": "42"}}},
                                "responses": [
                                    {
                                        "status": 200,
                                        "headers": {"X-Trace": "{{random.hex(8)}}"},
                                        "body": {
                                            "id": "{{request.path.petId}}",
                                            "name": "{{random.choice('Rex', 'Ada')}}",
                                        },
                                    }
                                ],
                            }
                        ],
                        "responses": [{"status": 200, "body": {"id": 1, "name": "Rex"}}],
                    }
                }
            }
        }
    )
    assert validate_mock_scenarios(scenarios, SPEC) == []


def test_rule_with_invalid_regex_reports_context() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"tag": {"matches": "("}}},
                                "responses": [{"status": 429}],
                            }
                        ]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("rule 1 when" in error and "regular expression" in error for error in errors)


def test_rule_with_empty_when_is_rejected() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [{"when": {}, "responses": [{"status": 429}]}]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("at least one predicate" in error for error in errors)


def test_templated_body_skips_schema_conformance() -> None:
    # A literal string body would fail the Pet schema; a templated one is
    # request-dependent, so the schema check is skipped (status/media type
    # checks still apply).
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets/{petId}": {
                        "responses": [
                            {"status": 200, "body": {"id": "{{request.path.petId}}", "name": "Rex"}}
                        ]
                    }
                }
            }
        }
    )
    assert validate_mock_scenarios(scenarios, SPEC) == []


def test_untemplated_body_still_schema_checked() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets/{petId}": {
                        "responses": [{"status": 200, "body": {"id": "not-an-int", "name": "Rex"}}]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("does not match" in error for error in errors)


def test_invalid_template_in_body_is_rejected() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "responses": [{"status": 429, "body": {"note": "{{secrets.env}}"}}]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("unknown expression root" in error for error in errors)


def test_invalid_template_in_header_is_rejected() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "responses": [
                            {"status": 429, "headers": {"X-Trace": "{{random.eval('x')}}"}}
                        ]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("header 'X-Trace'" in error for error in errors)


def test_templated_rule_responses_are_validated_too() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"limit": {"exists": True}}},
                                "responses": [{"status": 429, "body": "{{ oops"}],
                            }
                        ]
                    }
                }
            }
        }
    )
    errors = validate_mock_scenarios(scenarios, SPEC)
    assert any("unterminated" in error for error in errors)


def test_rules_storage_round_trip() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "get /pets": {
                        "rules": [
                            {
                                "when": {"query": {"limit": {"gt": 10}}},
                                "responses": [{"status": 429, "offSpec": True}],
                            }
                        ],
                        "responses": [{"status": 200, "body": []}],
                    }
                }
            }
        }
    )
    storage = scenarios_to_storage(scenarios)
    override = storage["s"]["operations"]["GET /pets"]
    assert override["rules"] == [
        {"when": {"query": {"limit": {"gt": 10.0}}}, "responses": [{"status": 429, "offSpec": True}]}
    ]
    assert override["responses"] == [{"status": 200, "body": []}]


def test_rules_only_override_omits_empty_responses() -> None:
    scenarios = _scenarios(
        {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"limit": {"exists": True}}},
                                "responses": [{"status": 429}],
                            }
                        ]
                    }
                }
            }
        }
    )
    override = scenarios_to_storage(scenarios)["s"]["operations"]["GET /pets"]
    assert "responses" not in override
    assert len(override["rules"]) == 1


def test_operation_without_rules_or_responses_is_rejected() -> None:
    try:
        MockScenarioSpec.model_validate({"operations": {"GET /pets": {}}})
    except ValueError as exc:
        assert "at least one response or rule" in str(exc)
    else:  # pragma: no cover - the validation must fail
        raise AssertionError("expected a validation error")
