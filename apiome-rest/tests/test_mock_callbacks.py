"""Mock callback format tests (#4746, PMR-2.3).

The author-time contract is what stops an unusable or unsafe callback from ever reaching a
runtime, so these tests push on all four halves of it: the declared payload schema, the
destination allowlist, the deterministic retry schedule, and the canonical form both sides digest.
"""

from __future__ import annotations

import json

import pytest

from app.mock_callbacks import (
    CALLBACK_FORMAT,
    DEFAULT_BACKOFF_MS,
    MAX_ATTEMPTS,
    MAX_CALLBACKS,
    MAX_DESTINATIONS,
    callback_digest,
    callback_digests,
    callbacks_from_storage,
    callbacks_to_storage,
    canonical_callback,
    match_destination,
    normalize_destination,
    retry_delays,
    validate_mock_callbacks,
)

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Orders", "version": "1.0.0"},
    "paths": {
        "/orders": {
            "post": {"responses": {"201": {"description": "created"}}},
            "get": {"responses": {"200": {"description": "ok"}}},
        }
    },
    "components": {
        "schemas": {
            "OrderEvent": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}},
            }
        }
    },
}

VALID = {
    "description": "POST /orders notifies the consumer's webhook.",
    "trigger": {"operation": "POST /orders", "statuses": [201]},
    "destinations": ["https://hooks.example.com/orders"],
    "request": {
        "method": "POST",
        "headers": {"X-Event": "order.created"},
        "body": {"id": "{{request.body#/id}}"},
    },
    "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
    "retry": {"maxAttempts": 3, "backoffMs": 100, "retryOn": [500, 503]},
}


def _errors(callbacks: dict) -> list[str]:
    return validate_mock_callbacks(callbacks, SPEC)


class TestValidateMockCallbacks:
    def test_accepts_a_complete_definition(self) -> None:
        assert _errors({"order-created": VALID}) == []

    def test_accepts_a_minimal_definition(self) -> None:
        assert _errors({"ping": {"destinations": ["https://hooks.example.com/ping"]}}) == []

    def test_rejects_a_non_object_mapping(self) -> None:
        assert validate_mock_callbacks([], SPEC) == ["Callbacks must be an object keyed by callback name."]

    def test_rejects_invalid_names(self) -> None:
        errors = _errors({"not a name!": VALID})
        assert any("is invalid" in error for error in errors)

    def test_rejects_unknown_keys(self) -> None:
        errors = _errors({"cb": {**VALID, "webhook": True}})
        assert any("unknown keys: webhook" in error for error in errors)

    def test_rejects_unsupported_format_id_and_version(self) -> None:
        wrong_id = _errors({"cb": {**VALID, "callbackFormat": "apiome.mock.callback/v2"}})
        wrong_version = _errors({"cb": {**VALID, "callbackFormatVersion": 99}})
        assert any("callbackFormat" in error for error in wrong_id)
        assert any("callbackFormatVersion" in error for error in wrong_version)

    def test_requires_at_least_one_destination(self) -> None:
        errors = _errors({"cb": {"trigger": {"operation": "POST /orders"}}})
        assert any("at least one allowlisted destination" in error for error in errors)

    def test_rejects_unsafe_destinations(self) -> None:
        for bad in ("file:///etc/passwd", "https://user:pass@hooks.example.com/x", "not-a-url"):
            errors = _errors({"cb": {"destinations": [bad]}})
            assert errors, f"{bad} should have been rejected"

    def test_rejects_too_many_destinations(self) -> None:
        many = [f"https://hooks.example.com/{index}" for index in range(MAX_DESTINATIONS + 1)]
        errors = _errors({"cb": {"destinations": many}})
        assert any(f"at most {MAX_DESTINATIONS} destinations" in error for error in errors)

    def test_rejects_more_callbacks_than_the_cap(self) -> None:
        callbacks = {
            f"cb{index}": {"destinations": ["https://hooks.example.com/x"]}
            for index in range(MAX_CALLBACKS + 1)
        }
        errors = _errors(callbacks)
        assert any(f"At most {MAX_CALLBACKS} callbacks" in error for error in errors)

    def test_rejects_a_trigger_naming_an_unknown_operation(self) -> None:
        errors = _errors({"cb": {**VALID, "trigger": {"operation": "POST /nope"}}})
        assert any("no operation POST /nope exists" in error for error in errors)

    def test_rejects_a_malformed_trigger_operation(self) -> None:
        errors = _errors({"cb": {**VALID, "trigger": {"operation": "orders"}}})
        assert any("operation keys must look like" in error for error in errors)

    def test_rejects_out_of_range_trigger_statuses(self) -> None:
        errors = _errors({"cb": {**VALID, "trigger": {"operation": "POST /orders", "statuses": [42]}}})
        assert any("between 100 and 599" in error for error in errors)

    def test_rejects_an_unresolvable_payload_schema_ref(self) -> None:
        errors = _errors({"cb": {**VALID, "payloadSchema": {"$ref": "#/components/schemas/Nope"}}})
        assert any("does not resolve" in error for error in errors)

    def test_accepts_an_inline_payload_schema(self) -> None:
        assert _errors({"cb": {**VALID, "payloadSchema": {"type": "object"}}}) == []

    def test_rejects_reserved_and_malformed_headers(self) -> None:
        errors = _errors({"cb": {**VALID, "request": {"headers": {"Content-Length": "5"}}}})
        assert any("managed by the runtime" in error for error in errors)
        errors = _errors({"cb": {**VALID, "request": {"headers": {"X-Bad": "line\rbreak"}}}})
        assert any("CR/LF" in error for error in errors)

    def test_rejects_an_unknown_method(self) -> None:
        errors = _errors({"cb": {**VALID, "request": {"method": "TRACE"}}})
        assert any("method must be one of" in error for error in errors)

    def test_rejects_malformed_templates_in_body_and_headers(self) -> None:
        errors = _errors({"cb": {**VALID, "request": {"body": {"id": "{{nope.thing}}"}}}})
        assert errors
        errors = _errors({"cb": {**VALID, "request": {"headers": {"X-Event": "{{nope.thing}}"}}}})
        assert errors

    def test_rejects_out_of_range_retry_knobs(self) -> None:
        assert _errors({"cb": {**VALID, "retry": {"maxAttempts": MAX_ATTEMPTS + 1}}})
        assert _errors({"cb": {**VALID, "retry": {"backoffMs": -1}}})
        assert _errors({"cb": {**VALID, "retry": {"backoffMultiplier": 0.5}}})
        assert _errors({"cb": {**VALID, "retry": {"timeoutMs": 0}}})
        assert _errors({"cb": {**VALID, "retry": {"nope": 1}}})

    def test_rejects_a_retry_schedule_that_could_take_too_long(self) -> None:
        errors = _errors(
            {"cb": {**VALID, "retry": {"maxAttempts": 10, "backoffMs": 60_000, "backoffMultiplier": 1.0}}}
        )
        assert any("in the worst case" in error for error in errors)

    def test_the_cost_ceiling_is_checked_even_when_another_callback_is_invalid(self) -> None:
        """The cost check must not be skipped just because the error list is already non-empty."""
        callbacks = {
            "broken": {"destinations": []},
            "expensive": {**VALID, "retry": {"maxAttempts": 10, "timeoutMs": 30_000}},
        }
        errors = _errors(callbacks)
        assert any("in the worst case" in error for error in errors)

    def test_counts_attempt_timeouts_not_only_backoff(self) -> None:
        # Four attempts of 20 s cannot fit the 60 s ceiling even with no backoff at all.
        errors = _errors({"cb": {**VALID, "retry": {"maxAttempts": 4, "backoffMs": 0, "timeoutMs": 20_000}}})
        assert any("in the worst case" in error for error in errors)


class TestRetryDelays:
    def test_defaults_to_two_growing_retries(self) -> None:
        assert retry_delays(None) == (DEFAULT_BACKOFF_MS, DEFAULT_BACKOFF_MS * 2)

    def test_is_a_pure_function_of_the_knobs(self) -> None:
        block = {"maxAttempts": 4, "backoffMs": 50, "backoffMultiplier": 3.0}
        assert retry_delays(block) == retry_delays(dict(block)) == (50, 150, 450)

    def test_single_attempt_never_waits(self) -> None:
        assert retry_delays({"maxAttempts": 1}) == ()

    def test_clamps_out_of_range_knobs(self) -> None:
        assert retry_delays({"maxAttempts": 99, "backoffMs": 0}) == (0,) * (MAX_ATTEMPTS - 1)
        assert retry_delays({"maxAttempts": 2, "backoffMultiplier": 0.1, "backoffMs": 10}) == (10,)

    def test_ignores_boolean_knobs(self) -> None:
        assert retry_delays({"maxAttempts": True}) == retry_delays({})


class TestDestinations:
    def test_normalizes_scheme_host_port_and_path(self) -> None:
        assert normalize_destination("HTTPS://Hooks.Example.COM:443/orders/") == "https://hooks.example.com/orders"
        assert normalize_destination("http://hooks.example.com:8080/x?a=1#f") == "http://hooks.example.com:8080/x"
        assert normalize_destination("https://hooks.example.com") == "https://hooks.example.com/"

    def test_rejects_unusable_destinations(self) -> None:
        for bad in ("", "  ", "ftp://hooks.example.com/x", "https://user:pw@h.example.com/x", 7, None):
            assert normalize_destination(bad) is None

    def test_matches_the_entry_and_its_descendants(self) -> None:
        allowlist = ["https://hooks.example.com/orders"]
        assert match_destination("https://hooks.example.com/orders", allowlist) == allowlist[0]
        assert match_destination("https://hooks.example.com/orders/42", allowlist) == allowlist[0]
        assert match_destination("https://hooks.example.com/orders?token=x", allowlist) == allowlist[0]

    def test_does_not_match_a_sibling_path_sharing_a_string_prefix(self) -> None:
        allowlist = ["https://hooks.example.com/orders"]
        assert match_destination("https://hooks.example.com/orders-archive", allowlist) is None
        assert match_destination("https://hooks.example.com/", allowlist) is None

    def test_does_not_match_a_different_origin(self) -> None:
        allowlist = ["https://hooks.example.com/orders"]
        assert match_destination("https://evil.example.com/orders", allowlist) is None
        assert match_destination("http://hooks.example.com/orders", allowlist) is None
        assert match_destination("https://hooks.example.com:8443/orders", allowlist) is None

    def test_a_root_entry_authorizes_the_whole_origin(self) -> None:
        allowlist = ["https://hooks.example.com/"]
        assert match_destination("https://hooks.example.com/anything/at/all", allowlist) == allowlist[0]


class TestCanonicalAndDigest:
    def test_canonical_form_declares_format_and_normalizes_destinations(self) -> None:
        canonical = canonical_callback({**VALID, "destinations": ["HTTPS://Hooks.Example.com/orders/"]})
        assert canonical["callbackFormat"] == CALLBACK_FORMAT
        assert canonical["callbackFormatVersion"] == 1
        assert canonical["destinations"] == ["https://hooks.example.com/orders"]
        assert canonical["trigger"] == {"operation": "POST /orders", "statuses": [201]}

    def test_canonical_form_drops_unknown_and_empty_blocks(self) -> None:
        canonical = canonical_callback(
            {"destinations": ["https://hooks.example.com/x"], "nope": 1, "request": {}, "description": "  "}
        )
        assert set(canonical) == {"callbackFormat", "callbackFormatVersion", "destinations"}

    def test_canonical_form_deduplicates_destinations(self) -> None:
        canonical = canonical_callback(
            {"destinations": ["https://hooks.example.com/x", "https://hooks.example.com/x/"]}
        )
        assert canonical["destinations"] == ["https://hooks.example.com/x"]

    def test_digest_is_stable_across_cosmetic_differences(self) -> None:
        explicit = {**VALID, "callbackFormat": CALLBACK_FORMAT, "callbackFormatVersion": 1}
        assert callback_digest(VALID) == callback_digest(explicit)
        assert callback_digest(VALID).startswith("sha256:")

    def test_digest_changes_with_content(self) -> None:
        other = {**VALID, "destinations": ["https://hooks.example.com/other"]}
        assert callback_digest(VALID) != callback_digest(other)

    def test_digests_maps_every_name(self) -> None:
        assert set(callback_digests({"a": VALID, "b": VALID})) == {"a", "b"}


class TestStorage:
    def test_round_trips_through_storage(self) -> None:
        storage = callbacks_to_storage({"order-created": VALID})
        settings = {"mode": "private", "callbacks": storage}
        assert callbacks_from_storage(settings) == storage

    def test_reads_json_text_settings(self) -> None:
        storage = callbacks_to_storage({"cb": VALID})
        assert callbacks_from_storage(json.dumps({"callbacks": storage})) == storage

    def test_missing_or_malformed_settings_yield_nothing(self) -> None:
        assert callbacks_from_storage(None) == {}
        assert callbacks_from_storage({"callbacks": []}) == {}
        assert callbacks_from_storage("not json") == {}

    def test_storage_skips_non_object_entries(self) -> None:
        assert callbacks_to_storage({"cb": VALID, "bad": ["nope"]}) == {"cb": canonical_callback(VALID)}


@pytest.mark.parametrize("status", [201, 200])
def test_trigger_statuses_are_sorted_and_deduplicated(status: int) -> None:
    canonical = canonical_callback(
        {"destinations": ["https://hooks.example.com/x"], "trigger": {"operation": "post /orders", "statuses": [status, status, 500]}}
    )
    assert canonical["trigger"]["statuses"] == sorted({status, 500})
    assert canonical["trigger"]["operation"] == "POST /orders"
