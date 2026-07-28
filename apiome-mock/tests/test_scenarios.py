"""Unit tests for scenario override parsing and serialization (#4454, SIM-4.2)."""

from __future__ import annotations

from apiome_mock.scenarios import (
    ScenarioResponse,
    _build_response,
    normalize_operation_key,
    parse_scenarios,
)


def test_normalize_operation_key_canonicalizes_method_case() -> None:
    assert normalize_operation_key("get /pets") == "GET /pets"
    assert normalize_operation_key("  POST   /pets/{petId}  ") == "POST /pets/{petId}"


def test_normalize_operation_key_rejects_malformed_keys() -> None:
    assert normalize_operation_key("GET") is None
    assert normalize_operation_key("GET pets") is None
    assert normalize_operation_key("G3T /pets") is None
    assert normalize_operation_key(42) is None
    assert normalize_operation_key(None) is None


def test_parse_scenarios_reads_valid_definitions() -> None:
    settings = {
        "mode": "private",
        "scenarios": {
            "quota-exceeded": {
                "description": "Throttle list calls.",
                "operations": {
                    "get /pets": {
                        "responses": [
                            {
                                "status": 429,
                                "headers": {"Retry-After": "60"},
                                "body": {"error": "quota"},
                            }
                        ]
                    }
                },
            }
        },
    }
    scenarios = parse_scenarios(settings)
    assert set(scenarios) == {"quota-exceeded"}
    scenario = scenarios["quota-exceeded"]
    assert scenario.description == "Throttle list calls."
    override = scenario.operations["GET /pets"]
    assert override.rules == ()
    responses = override.responses
    assert len(responses) == 1
    assert responses[0].status == 429
    assert responses[0].headers == (("Retry-After", "60"),)
    assert responses[0].body == {"error": "quota"}
    assert responses[0].has_body is True
    assert responses[0].media_type == "application/json"


def test_parse_scenarios_accepts_json_text_and_empty_settings() -> None:
    text = '{"scenarios": {"s": {"operations": {"GET /x": {"responses": [{"status": 204}]}}}}}'
    assert set(parse_scenarios(text)) == {"s"}
    assert parse_scenarios(None) == {}
    assert parse_scenarios({}) == {}
    assert parse_scenarios({"mode": "private"}) == {}
    assert parse_scenarios("not json") == {}
    assert parse_scenarios(["nope"]) == {}


def test_parse_scenarios_skips_malformed_entries() -> None:
    settings = {
        "scenarios": {
            "": {"operations": {}},
            "bad-shape": "nope",
            "bad-status": {"operations": {"GET /pets": {"responses": [{"status": 999}, {"status": True}]}}},
            "bad-op-key": {"operations": {"pets": {"responses": [{"status": 200}]}}},
            "bad-responses": {"operations": {"GET /pets": {"responses": "nope"}}},
            "ok": {"operations": {"GET /pets": {"responses": [{"status": 503}]}}},
        }
    }
    scenarios = parse_scenarios(settings)
    # Scenarios with no usable responses still resolve (they just override nothing).
    assert set(scenarios) == {"bad-status", "bad-op-key", "bad-responses", "ok"}
    assert scenarios["bad-status"].operations == {}
    assert scenarios["bad-op-key"].operations == {}
    assert scenarios["bad-responses"].operations == {}
    assert scenarios["ok"].operations["GET /pets"].responses[0].status == 503


def test_parse_response_media_type_falls_back_to_content_type_header() -> None:
    settings = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {
                        "responses": [
                            {
                                "status": 200,
                                "headers": {"Content-Type": "text/csv"},
                                "body": "id,name\n1,Rex",
                            }
                        ]
                    }
                }
            }
        }
    }
    response = parse_scenarios(settings)["s"].operations["GET /pets"].responses[0]
    assert response.media_type == "text/csv"


def test_parse_response_filters_reserved_headers() -> None:
    settings = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {
                        "responses": [
                            {
                                "status": 200,
                                "headers": {
                                    "Content-Length": "5",
                                    "Transfer-Encoding": "chunked",
                                    "X-Ok": "yes",
                                    "": "blank",
                                    "X-Bad": 42,
                                    "X-Evil": "a\r\nSet-Cookie: pwn",
                                },
                                "body": {},
                            }
                        ]
                    }
                }
            }
        }
    }
    response = parse_scenarios(settings)["s"].operations["GET /pets"].responses[0]
    assert response.headers == (("X-Ok", "yes"),)


def test_build_response_serializes_json_and_text_bodies() -> None:
    json_response = _build_response(
        ScenarioResponse(
            status=429,
            headers=(("Retry-After", "60"),),
            body={"error": "quota"},
            has_body=True,
            media_type="application/json",
        )
    )
    assert json_response.status_code == 429
    assert json_response.headers["retry-after"] == "60"
    assert json_response.body == b'{"error":"quota"}'

    text_response = _build_response(
        ScenarioResponse(
            status=200,
            headers=(),
            body="plain text",
            has_body=True,
            media_type="text/plain",
        )
    )
    assert text_response.body == b"plain text"
    assert text_response.headers["content-type"].startswith("text/plain")

    empty_response = _build_response(
        ScenarioResponse(status=204, headers=(), body=None, has_body=False, media_type="application/json")
    )
    assert empty_response.status_code == 204
    assert empty_response.body == b""

    null_body_response = _build_response(
        ScenarioResponse(status=200, headers=(), body=None, has_body=True, media_type="application/json")
    )
    assert null_body_response.body == b"null"


def test_parse_scenarios_reads_rules() -> None:
    settings = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"limit": {"gt": 10}}},
                                "responses": [{"status": 429}],
                            }
                        ],
                        "responses": [{"status": 200, "body": []}],
                    }
                }
            }
        }
    }
    override = parse_scenarios(settings)["s"].operations["GET /pets"]
    assert len(override.rules) == 1
    assert override.rules[0].responses[0].status == 429
    assert override.responses[0].status == 200
    assert override.needs_body is False


def test_parse_scenarios_drops_rules_with_invalid_when() -> None:
    settings = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {"when": {}, "responses": [{"status": 429}]},
                            {"when": {"query": {"a": {"like": "x"}}}, "responses": [{"status": 429}]},
                            {"when": {"query": {"a": {"equals": "x"}}}, "responses": []},
                            {"when": {"query": {"a": {"equals": "x"}}}, "responses": [{"status": 503}]},
                        ]
                    }
                }
            }
        }
    }
    override = parse_scenarios(settings)["s"].operations["GET /pets"]
    # Only the last rule is valid: empty when, unknown operator, and empty
    # responses all drop the whole rule rather than matching more broadly.
    assert len(override.rules) == 1
    assert override.rules[0].responses[0].status == 503
    assert override.responses == ()


def test_parse_scenarios_flags_body_needs() -> None:
    settings = {
        "scenarios": {
            "predicate": {
                "operations": {
                    "POST /pets": {
                        "rules": [
                            {
                                "when": {"body": {"/name": {"exists": True}}},
                                "responses": [{"status": 201}],
                            }
                        ]
                    }
                }
            },
            "template": {
                "operations": {
                    "POST /pets": {"responses": [{"status": 201, "body": {"echo": "{{request.body#/name}}"}}]}
                }
            },
        }
    }
    scenarios = parse_scenarios(settings)
    assert scenarios["predicate"].operations["POST /pets"].needs_body is True
    assert scenarios["template"].operations["POST /pets"].needs_body is True
