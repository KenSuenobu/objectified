"""Tests for the vendored deck declarative-file validator — FMT-2.2 (#5420).

``deck`` is a Go binary this runtime does not carry, so :mod:`app.kong_deck_schema`
is the vendored equivalent the ticket allows and this module is what makes it a
real gate rather than a claim: every rule it enforces is exercised in both
directions — a conforming document produces no violation, and a document breaking
the rule names it.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
import yaml

from app.kong_deck_schema import (
    DECK_FORMAT_VERSIONS,
    KONG_ENTITY_NAME,
    KONG_HTTP_METHODS,
    KONG_PROTOCOLS,
    KONG_TOP_LEVEL_SECTIONS,
    deck_document_violations,
    validate_kong_declarative_document,
)


def _config(**sections: Any) -> Dict[str, Any]:
    """Return a minimal valid declarative config, with ``sections`` merged in."""
    document: Dict[str, Any] = {
        "_format_version": "3.0",
        "services": [
            {
                "name": "users-service",
                "url": "https://users.internal:8443",
                "routes": [{"name": "users", "paths": ["/users"], "methods": ["GET"]}],
            }
        ],
    }
    document.update(sections)
    return document


def _violations(document: Any) -> List[str]:
    """Shorthand for the violation list of one document."""
    return deck_document_violations(document)


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------


def test_a_minimal_config_has_no_violations() -> None:
    assert _violations(_config()) == []


def test_every_corpus_fixture_validates() -> None:
    """The committed Kong corpus is real deck output; the validator must accept it."""
    from pathlib import Path

    corpus = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "kong"
    fixtures = sorted(
        path
        for path in corpus.rglob("*")
        if path.is_file()
        and path.suffix in (".yaml", ".yml", ".json")
        and "negative" not in path.parts
    )
    assert fixtures, "the Kong corpus is missing"
    for fixture in fixtures:
        document = yaml.safe_load(fixture.read_text(encoding="utf-8"))
        assert _violations(document) == [], f"{fixture.name} was rejected"


# ---------------------------------------------------------------------------
# Top level
# ---------------------------------------------------------------------------


def test_a_non_mapping_document_is_a_violation() -> None:
    assert _violations(["not", "a", "mapping"]) == [
        "$: a declarative configuration must be a mapping, got list"
    ]


def test_format_version_is_required() -> None:
    assert "$: `_format_version` is required" in _violations(
        {"services": [{"name": "s", "url": "http://x"}]}
    )


def test_an_unquoted_format_version_is_rejected() -> None:
    document = _config()
    document["_format_version"] = 3.0
    assert "$._format_version: must be a string (quote it in YAML)" in _violations(document)


def test_an_unknown_format_version_is_rejected() -> None:
    document = _config()
    document["_format_version"] = "9.9"
    problems = _violations(document)
    assert any("is not a version deck understands" in problem for problem in problems)


@pytest.mark.parametrize("version", sorted(DECK_FORMAT_VERSIONS))
def test_every_declared_format_version_is_accepted(version: str) -> None:
    document = _config()
    document["_format_version"] = version
    assert _violations(document) == []


def test_an_unknown_top_level_section_is_rejected() -> None:
    """deck rejects unknown top-level keys, which is why the emitter invents none."""
    document = _config(_title="My API")
    assert "$: `_title` is not a declarative-configuration section" in _violations(document)


@pytest.mark.parametrize("section", sorted(KONG_TOP_LEVEL_SECTIONS))
def test_every_known_section_is_accepted(section: str) -> None:
    document = _config()
    document.setdefault(section, [] if not section.startswith("_") else "x")
    assert not any("is not a declarative-configuration section" in p for p in _violations(document))


def test_a_section_that_should_be_a_list_is_checked() -> None:
    assert "$.services: must be a list" in _violations(
        {"_format_version": "3.0", "services": {"name": "x"}}
    )
    assert "$.consumers: must be a list" in _violations(_config(consumers={"a": 1}))


# ---------------------------------------------------------------------------
# Entity names
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["users-service", "v1.users", "a_b~c", "Users9"])
def test_legal_kong_names_are_accepted(name: str) -> None:
    assert KONG_ENTITY_NAME.match(name)


@pytest.mark.parametrize("name", ["users service", "users/service", "", "üsers"])
def test_illegal_kong_names_are_rejected(name: str) -> None:
    assert not KONG_ENTITY_NAME.match(name)


def test_a_service_name_with_a_space_is_a_violation() -> None:
    document = _config()
    document["services"][0]["name"] = "Pet Store"
    problems = _violations(document)
    assert any("contains characters Kong does not allow" in problem for problem in problems)


def test_a_nameless_service_is_a_violation() -> None:
    document = _config()
    del document["services"][0]["name"]
    assert "$.services[0]: must declare a `name`" in _violations(document)


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------


def test_a_service_must_declare_an_upstream() -> None:
    document = _config()
    del document["services"][0]["url"]
    problems = _violations(document)
    assert any("must declare an upstream" in problem for problem in problems)


def test_a_piecewise_upstream_satisfies_the_rule() -> None:
    document = _config()
    del document["services"][0]["url"]
    document["services"][0].update({"protocol": "http", "host": "x.internal", "port": 8080})
    assert _violations(document) == []


@pytest.mark.parametrize("protocol", sorted(KONG_PROTOCOLS))
def test_every_kong_protocol_is_accepted_on_a_service(protocol: str) -> None:
    document = _config()
    document["services"][0]["protocol"] = protocol
    assert _violations(document) == []


def test_an_unknown_service_protocol_is_rejected() -> None:
    document = _config()
    document["services"][0]["protocol"] = "gopher"
    assert "$.services[0].protocol: 'gopher' is not a Kong protocol" in _violations(document)


@pytest.mark.parametrize("port", [0, 65536, "8080", True])
def test_an_out_of_range_or_mistyped_port_is_rejected(port: Any) -> None:
    document = _config()
    document["services"][0]["port"] = port
    assert any("port" in problem for problem in _violations(document))


def test_a_service_path_must_be_absolute() -> None:
    document = _config()
    document["services"][0]["path"] = "v1"
    assert "$.services[0].path: must be a string starting with `/`" in _violations(document)


def test_service_numeric_attributes_are_checked() -> None:
    document = _config()
    document["services"][0]["retries"] = "five"
    assert "$.services[0].retries: must be an integer" in _violations(document)


def test_service_enabled_must_be_boolean() -> None:
    document = _config()
    document["services"][0]["enabled"] = "yes"
    assert "$.services[0].enabled: must be a boolean" in _violations(document)


def test_service_tags_must_be_strings() -> None:
    document = _config()
    document["services"][0]["tags"] = ["ok", 3]
    assert "$.services[0].tags[1]: must be a non-empty string" in _violations(document)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def test_a_route_with_no_matching_rule_is_rejected() -> None:
    """Kong refuses a route that matches nothing; catching it here is the point."""
    document = _config()
    document["services"][0]["routes"] = [{"name": "nothing"}]
    problems = _violations(document)
    assert any("declares no matching rule" in problem for problem in problems)


@pytest.mark.parametrize(
    "field, value",
    [
        ("paths", ["/x"]),
        ("hosts", ["x.example"]),
        ("methods", ["GET"]),
        ("headers", {"x-a": ["b"]}),
        ("snis", ["x.example"]),
    ],
)
def test_any_single_matching_rule_satisfies_the_route(field: str, value: Any) -> None:
    document = _config()
    document["services"][0]["routes"] = [{"name": "one", field: value}]
    assert _violations(document) == []


def test_a_route_path_must_be_a_path_or_a_regex() -> None:
    document = _config()
    document["services"][0]["routes"][0]["paths"] = ["users"]
    problems = _violations(document)
    assert any("must start with `/`" in problem for problem in problems)


def test_a_regex_route_path_is_accepted() -> None:
    document = _config()
    document["services"][0]["routes"][0]["paths"] = ["~/users/(?<id>[0-9]+)$"]
    assert _violations(document) == []


@pytest.mark.parametrize("method", sorted(KONG_HTTP_METHODS))
def test_every_http_method_is_accepted(method: str) -> None:
    document = _config()
    document["services"][0]["routes"][0]["methods"] = [method]
    assert _violations(document) == []


def test_a_lower_cased_method_is_rejected() -> None:
    document = _config()
    document["services"][0]["routes"][0]["methods"] = ["get"]
    assert "$.services[0].routes[0].methods[0]: 'get' is not an HTTP method" in _violations(document)


def test_route_headers_must_map_to_string_lists() -> None:
    document = _config()
    document["services"][0]["routes"][0]["headers"] = {"x-realm": "internal"}
    assert "$.services[0].routes[0].headers.x-realm: must be a list of strings" in _violations(
        document
    )


def test_route_headers_must_be_a_mapping() -> None:
    document = _config()
    document["services"][0]["routes"][0]["headers"] = ["x-realm"]
    assert "$.services[0].routes[0].headers: must be a mapping of name → values" in _violations(
        document
    )


@pytest.mark.parametrize(
    "flag", ["strip_path", "preserve_host", "request_buffering", "response_buffering"]
)
def test_route_boolean_flags_are_checked(flag: str) -> None:
    document = _config()
    document["services"][0]["routes"][0][flag] = "false"
    assert f"$.services[0].routes[0].{flag}: must be a boolean" in _violations(document)


def test_path_handling_is_a_closed_vocabulary() -> None:
    document = _config()
    document["services"][0]["routes"][0]["path_handling"] = "v2"
    problems = _violations(document)
    assert any("path_handling" in problem for problem in problems)


def test_https_redirect_status_code_is_a_closed_vocabulary() -> None:
    document = _config()
    document["services"][0]["routes"][0]["https_redirect_status_code"] = 418
    problems = _violations(document)
    assert any("https_redirect_status_code" in problem for problem in problems)


def test_regex_priority_must_be_an_integer() -> None:
    document = _config()
    document["services"][0]["routes"][0]["regex_priority"] = "high"
    assert "$.services[0].routes[0].regex_priority: must be an integer" in _violations(document)


def test_an_unknown_route_protocol_is_rejected() -> None:
    document = _config()
    document["services"][0]["routes"][0]["protocols"] = ["carrier-pigeon"]
    problems = _violations(document)
    assert any("is not a Kong protocol" in problem for problem in problems)


def test_a_top_level_route_is_validated_too() -> None:
    document = _config(routes=[{"name": "orphan"}])
    assert any("$.routes[0]" in problem for problem in _violations(document))


# ---------------------------------------------------------------------------
# Plugins
# ---------------------------------------------------------------------------


def test_a_plugin_must_name_a_plugin() -> None:
    document = _config(plugins=[{"config": {"minute": 5}}])
    assert "$.plugins[0]: must declare a `name`" in _violations(document)


def test_a_plugin_config_must_be_a_mapping() -> None:
    document = _config(plugins=[{"name": "rate-limiting", "config": [1, 2]}])
    assert "$.plugins[0].config: must be a mapping" in _violations(document)


def test_a_plugin_enabled_flag_must_be_boolean() -> None:
    document = _config(plugins=[{"name": "cors", "enabled": "no"}])
    assert "$.plugins[0].enabled: must be a boolean" in _violations(document)


def test_service_and_route_plugins_are_validated() -> None:
    document = _config()
    document["services"][0]["plugins"] = [{"name": "key auth"}]
    document["services"][0]["routes"][0]["plugins"] = [{}]
    problems = _violations(document)
    assert any("$.services[0].plugins[0]" in problem for problem in problems)
    assert any("$.services[0].routes[0].plugins[0]" in problem for problem in problems)


# ---------------------------------------------------------------------------
# The document-level gate
# ---------------------------------------------------------------------------


def test_validate_accepts_a_real_declarative_config() -> None:
    validate_kong_declarative_document(yaml.safe_dump(_config(), sort_keys=False))


def test_validate_rejects_text_that_is_not_a_kong_config() -> None:
    with pytest.raises(Exception):  # noqa: B017 — the adapter's own error type
        validate_kong_declarative_document("openapi: 3.1.0\n")


def test_validate_names_every_violation() -> None:
    document = _config()
    document["services"][0]["name"] = "Pet Store"
    document["services"][0]["routes"][0]["methods"] = ["get"]
    with pytest.raises(ValueError) as excinfo:
        validate_kong_declarative_document(yaml.safe_dump(document, sort_keys=False))
    message = str(excinfo.value)
    assert "Pet Store" in message
    assert "'get' is not an HTTP method" in message
