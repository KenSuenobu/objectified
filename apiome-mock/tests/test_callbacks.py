"""Runtime callback definition parsing tests (#4746, PMR-2.3).

The runtime is lenient by contract: a stored settings blob can never break serving, so anything
unusable is skipped rather than raised. These tests pin exactly what "unusable" means, and prove
the runtime's digest matches the one the authoring API reported on save.
"""

from __future__ import annotations

import json

from app.mock_callbacks import (
    CALLBACK_FORMAT,
    DEFAULT_RETRY_ON,
    DEFAULT_TIMEOUT_MS,
    MAX_ATTEMPTS,
    MAX_TIMEOUT_MS,
    callback_digest,
)

from apiome_mock.callbacks import callback_summary, parse_callbacks

VALID = {
    "callbackFormat": CALLBACK_FORMAT,
    "callbackFormatVersion": 1,
    "description": "Order created.",
    "trigger": {"operation": "POST /orders", "statuses": [201]},
    "destinations": ["https://hooks.example.com/orders"],
    "request": {
        "method": "POST",
        "headers": {"X-Event": "order.created"},
        "body": {"id": "{{request.body#/id}}"},
    },
    "payloadSchema": {"type": "object"},
    "retry": {"maxAttempts": 3, "backoffMs": 10, "retryOn": [503]},
}


def _settings(callbacks: dict) -> dict:
    return {"callbacks": callbacks}


class TestParseCallbacks:
    def test_parses_a_complete_definition(self) -> None:
        definition = parse_callbacks(_settings({"order-created": VALID}))["order-created"]
        assert definition.name == "order-created"
        assert definition.description == "Order created."
        assert definition.operation_key == "POST /orders"
        assert definition.trigger_statuses == (201,)
        assert definition.destinations == ("https://hooks.example.com/orders",)
        assert definition.method == "POST"
        assert definition.headers == (("X-Event", "order.created"),)
        assert definition.has_body is True
        assert definition.payload_schema == {"type": "object"}
        assert definition.needs_request_body is True

    def test_accepts_json_text_settings(self) -> None:
        assert set(parse_callbacks(json.dumps(_settings({"cb": VALID})))) == {"cb"}

    def test_missing_or_malformed_settings_yield_nothing(self) -> None:
        assert parse_callbacks(None) == {}
        assert parse_callbacks("not json") == {}
        assert parse_callbacks({"callbacks": []}) == {}
        assert parse_callbacks(["nope"]) == {}

    def test_format_defaults_when_omitted(self) -> None:
        minimal = {"destinations": ["https://hooks.example.com/x"]}
        definition = parse_callbacks(_settings({"minimal": minimal}))["minimal"]
        assert definition.format_version == 1
        assert definition.method == "POST"
        assert definition.has_body is False
        assert definition.operation_key is None

    def test_skips_unsupported_format_id_and_version(self) -> None:
        callbacks = {
            "a": {**VALID, "callbackFormat": "apiome.mock.callback/v2"},
            "b": {**VALID, "callbackFormatVersion": 99},
            "c": {**VALID, "callbackFormatVersion": True},
            "ok": VALID,
        }
        assert set(parse_callbacks(_settings(callbacks))) == {"ok"}

    def test_skips_invalid_names_and_non_dict_entries(self) -> None:
        callbacks = {"bad name!": VALID, "": VALID, "list": [1], "ok": VALID}
        assert set(parse_callbacks(_settings(callbacks))) == {"ok"}

    def test_drops_a_definition_with_no_usable_destination(self) -> None:
        callbacks = {
            "none": {**VALID, "destinations": []},
            "unsafe": {**VALID, "destinations": ["file:///etc/passwd", 7]},
            "ok": VALID,
        }
        assert set(parse_callbacks(_settings(callbacks))) == {"ok"}

    def test_normalizes_and_deduplicates_destinations(self) -> None:
        raw = {**VALID, "destinations": ["HTTPS://Hooks.Example.com/orders/", "https://hooks.example.com/orders"]}
        definition = parse_callbacks(_settings({"cb": raw}))["cb"]
        assert definition.destinations == ("https://hooks.example.com/orders",)

    def test_skips_malformed_and_reserved_headers(self) -> None:
        raw = {
            **VALID,
            "request": {
                "headers": {
                    "X-Ok": "fine",
                    "Content-Length": "9",
                    "X-Bad": "line\nbreak",
                    "": "blank",
                    "X-NonString": 7,
                }
            },
        }
        definition = parse_callbacks(_settings({"cb": raw}))["cb"]
        assert definition.headers == (("X-Ok", "fine"),)

    def test_ignores_an_unknown_method(self) -> None:
        raw = {**VALID, "request": {"method": "TRACE"}}
        assert parse_callbacks(_settings({"cb": raw}))["cb"].method == "POST"

    def test_needs_request_body_only_when_a_template_reads_it(self) -> None:
        no_body_ref = {**VALID, "request": {"body": {"id": "{{random.uuid()}}"}}}
        header_ref = {**VALID, "request": {"headers": {"X-Id": "{{request.body#/id}}"}}}
        parsed = parse_callbacks(_settings({"a": no_body_ref, "b": header_ref}))
        assert parsed["a"].needs_request_body is False
        assert parsed["b"].needs_request_body is True

    def test_digest_matches_the_authoring_api(self) -> None:
        definition = parse_callbacks(_settings({"cb": VALID}))["cb"]
        assert definition.digest == callback_digest(VALID)


class TestRetryPolicyParsing:
    def test_defaults_when_no_retry_block(self) -> None:
        raw = {"destinations": ["https://hooks.example.com/x"]}
        retry = parse_callbacks(_settings({"cb": raw}))["cb"].retry
        assert retry.max_attempts == 3
        assert retry.delays_ms == (100, 200)
        assert retry.retry_on == frozenset(DEFAULT_RETRY_ON)
        assert retry.timeout_ms == DEFAULT_TIMEOUT_MS

    def test_uses_the_declared_schedule(self) -> None:
        raw = {**VALID, "retry": {"maxAttempts": 4, "backoffMs": 20, "backoffMultiplier": 3.0}}
        retry = parse_callbacks(_settings({"cb": raw}))["cb"].retry
        assert retry.max_attempts == 4
        assert retry.delays_ms == (20, 60, 180)

    def test_clamps_out_of_range_knobs(self) -> None:
        raw = {**VALID, "retry": {"maxAttempts": 999, "timeoutMs": 10_000_000}}
        retry = parse_callbacks(_settings({"cb": raw}))["cb"].retry
        assert retry.max_attempts == MAX_ATTEMPTS
        assert retry.timeout_ms == MAX_TIMEOUT_MS

    def test_should_retry_covers_declared_statuses_and_transport_failures(self) -> None:
        retry = parse_callbacks(_settings({"cb": VALID}))["cb"].retry
        assert retry.should_retry(503) is True
        assert retry.should_retry(None) is True
        assert retry.should_retry(500) is False
        assert retry.should_retry(200) is False


class TestFiringAndAuthorization:
    def test_fires_only_for_its_operation_and_statuses(self) -> None:
        definition = parse_callbacks(_settings({"cb": VALID}))["cb"]
        assert definition.fires_for("POST /orders", 201) is True
        assert definition.fires_for("POST /orders", 200) is False
        assert definition.fires_for("GET /orders", 201) is False

    def test_without_declared_statuses_any_2xx_fires(self) -> None:
        raw = {**VALID, "trigger": {"operation": "POST /orders"}}
        definition = parse_callbacks(_settings({"cb": raw}))["cb"]
        assert definition.fires_for("POST /orders", 200) is True
        assert definition.fires_for("POST /orders", 299) is True
        assert definition.fires_for("POST /orders", 404) is False

    def test_without_a_trigger_operation_it_never_fires_automatically(self) -> None:
        raw = {"destinations": ["https://hooks.example.com/x"]}
        definition = parse_callbacks(_settings({"cb": raw}))["cb"]
        assert definition.fires_for("POST /orders", 201) is False

    def test_authorized_destination_defaults_to_the_first_entry(self) -> None:
        definition = parse_callbacks(_settings({"cb": VALID}))["cb"]
        assert definition.authorized_destination(None) == "https://hooks.example.com/orders"

    def test_authorized_destination_accepts_a_descendant_and_preserves_the_query(self) -> None:
        definition = parse_callbacks(_settings({"cb": VALID}))["cb"]
        requested = "https://hooks.example.com/orders/42?token=abc"
        assert definition.authorized_destination(requested) == requested

    def test_authorized_destination_rejects_anything_outside_the_allowlist(self) -> None:
        definition = parse_callbacks(_settings({"cb": VALID}))["cb"]
        assert definition.authorized_destination("https://evil.example.com/orders") is None
        assert definition.authorized_destination("http://hooks.example.com/orders") is None
        assert definition.authorized_destination("file:///etc/passwd") is None


def test_callback_summary_describes_shape_without_leaking_values() -> None:
    definition = parse_callbacks(_settings({"order-created": VALID}))["order-created"]
    summary = callback_summary(definition)
    assert summary["name"] == "order-created"
    assert summary["digest"] == callback_digest(VALID)
    assert summary["callbackFormat"] == CALLBACK_FORMAT
    assert summary["trigger"] == {"operation": "POST /orders", "statuses": [201]}
    assert summary["destinations"] == ["https://hooks.example.com/orders"]
    assert summary["hasPayloadSchema"] is True
    assert summary["retry"]["delaysMs"] == [10, 20]
    # Header *names* travel; their (possibly templated, possibly secret-bearing) values do not.
    assert summary["headers"] == ["X-Event"]
    assert "body" not in json.dumps(summary)
    assert "order.created" not in json.dumps(summary)
