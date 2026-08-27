"""Guarded proxy capture rule-set tests (#4747, PMR-2.4).

Covers the four things :mod:`app.mock_capture` owns — the capture policy contract, the upstream
allowlist, the redaction engine, and the review-before-publish conversion — plus the last-gate
credential re-scan that decides whether a finished record may be persisted at all.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import pytest
from app.mock_capture import (
    ALWAYS_REDACTED_HEADERS,
    CAPTURE_FORMAT,
    CAPTURE_POLICY_FORMAT,
    MAX_AUTHORIZATION_HOURS,
    MAX_CAPTURE_BODY_BYTES,
    MAX_UPSTREAMS,
    CaptureProvenance,
    authorization_block,
    build_capture_record,
    canonical_capture_policy,
    capture_authorization_state,
    capture_policy_digest,
    capture_policy_from_storage,
    capture_policy_to_storage,
    capture_record_digest,
    fixture_pack_from_captures,
    redact_exchange,
    redaction_rules_from_policy,
    residual_credential_pointers,
    resolve_capture_upstream,
    validate_capture_policy,
)
from app.mock_fixture_packs import validate_fixture_packs

NOW = datetime(2026, 8, 26, 18, 0, 0, tzinfo=timezone.utc)
UPSTREAM = "https://api.example.com/v1"


def _policy(**overrides: Any) -> Dict[str, Any]:
    """Build a valid, live capture policy with optional overrides."""
    policy: Dict[str, Any] = {
        "enabled": True,
        "upstreams": [UPSTREAM],
        "authorization": authorization_block(authorized_by="user-1", now=NOW, ttl_hours=24),
        "validateResponses": True,
    }
    policy.update(overrides)
    return policy


# ---------------------------------------------------------------------------
# Policy validation
# ---------------------------------------------------------------------------


class TestPolicyValidation:
    def test_valid_policy_has_no_errors(self) -> None:
        assert validate_capture_policy(_policy()) == []

    def test_policy_must_be_an_object(self) -> None:
        assert validate_capture_policy(["nope"]) == ["Capture policy must be a JSON object."]

    def test_unknown_keys_are_errors(self) -> None:
        errors = validate_capture_policy(_policy(record_everything=True))
        assert any("unknown keys" in error for error in errors)

    def test_wrong_format_id_is_rejected(self) -> None:
        errors = validate_capture_policy(_policy(policyFormat="apiome.mock.capture-policy/v9"))
        assert any(CAPTURE_POLICY_FORMAT in error for error in errors)

    def test_unsupported_format_version_is_rejected(self) -> None:
        errors = validate_capture_policy(_policy(policyFormatVersion=99))
        assert any("policyFormatVersion" in error for error in errors)

    def test_upstreams_are_required(self) -> None:
        errors = validate_capture_policy(_policy(upstreams=[]))
        assert any("non-empty list" in error for error in errors)

    def test_too_many_upstreams_is_rejected(self) -> None:
        errors = validate_capture_policy(
            _policy(upstreams=[f"https://api{i}.example.com" for i in range(MAX_UPSTREAMS + 1)])
        )
        assert any(str(MAX_UPSTREAMS) in error for error in errors)

    @pytest.mark.parametrize(
        "bad",
        [
            "file:///etc/passwd",
            "not-a-url",
            "https://user:pass@api.example.com/v1",
            "ftp://api.example.com/v1",
        ],
    )
    def test_unsafe_upstreams_are_rejected(self, bad: str) -> None:
        errors = validate_capture_policy(_policy(upstreams=[bad]))
        assert any("not a usable absolute" in error for error in errors)

    def test_authorization_is_required(self) -> None:
        policy = _policy()
        policy.pop("authorization")
        errors = validate_capture_policy(policy)
        assert any("authorization" in error for error in errors)

    def test_authorization_must_name_a_user(self) -> None:
        errors = validate_capture_policy(
            _policy(
                authorization={
                    "authorizedBy": "  ",
                    "authorizedAt": "2026-08-26T18:00:00Z",
                    "expiresAt": "2026-08-27T18:00:00Z",
                }
            )
        )
        assert any("authorizedBy" in error for error in errors)

    def test_authorization_may_not_outlive_the_ceiling(self) -> None:
        errors = validate_capture_policy(
            _policy(
                authorization={
                    "authorizedBy": "user-1",
                    "authorizedAt": "2026-08-26T18:00:00Z",
                    "expiresAt": "2026-12-26T18:00:00Z",
                }
            )
        )
        assert any(str(MAX_AUTHORIZATION_HOURS) in error for error in errors)

    def test_expiry_must_follow_the_grant(self) -> None:
        errors = validate_capture_policy(
            _policy(
                authorization={
                    "authorizedBy": "user-1",
                    "authorizedAt": "2026-08-26T18:00:00Z",
                    "expiresAt": "2026-08-25T18:00:00Z",
                }
            )
        )
        assert any("must be after" in error for error in errors)

    def test_unknown_redaction_pattern_is_rejected(self) -> None:
        errors = validate_capture_policy(_policy(redaction={"patterns": ["astrology"]}))
        assert any("not a known detector" in error for error in errors)

    def test_redaction_lists_must_hold_names(self) -> None:
        errors = validate_capture_policy(_policy(redaction={"headers": [""]}))
        assert any("non-blank name" in error for error in errors)


class TestPolicyCanonicalization:
    def test_canonical_form_declares_identity_and_sorts_rules(self) -> None:
        canonical = canonical_capture_policy(
            _policy(redaction={"headers": ["X-B", "X-A", "X-B"], "patterns": ["email", "nope"]})
        )
        assert canonical["policyFormat"] == CAPTURE_POLICY_FORMAT
        assert canonical["policyFormatVersion"] == 1
        assert canonical["redaction"]["headers"] == ["X-A", "X-B"]
        assert canonical["redaction"]["patterns"] == ["email"]

    def test_upstreams_normalize_and_deduplicate(self) -> None:
        canonical = canonical_capture_policy(
            _policy(upstreams=["HTTPS://API.example.com:443/v1/", "https://api.example.com/v1"])
        )
        assert canonical["upstreams"] == ["https://api.example.com/v1"]

    def test_cosmetic_differences_do_not_change_the_digest(self) -> None:
        a = capture_policy_digest(_policy())
        b = capture_policy_digest(_policy(policyFormat=CAPTURE_POLICY_FORMAT, policyFormatVersion=1))
        assert a == b

    def test_storage_round_trip(self) -> None:
        stored = {"proxyCapture": capture_policy_to_storage(_policy())}
        assert capture_policy_from_storage(stored)["upstreams"] == [UPSTREAM]

    def test_storage_ignores_a_malformed_blob(self) -> None:
        assert capture_policy_from_storage({"proxyCapture": "nope"}) == {}
        assert capture_policy_from_storage(None) == {}


class TestAuthorizationState:
    def test_a_live_grant_is_authorized(self) -> None:
        assert capture_authorization_state(_policy(), now=NOW) == "authorized"

    def test_no_policy_is_unconfigured(self) -> None:
        assert capture_authorization_state({}, now=NOW) == "unconfigured"

    def test_switched_off_is_disabled(self) -> None:
        assert capture_authorization_state(_policy(enabled=False), now=NOW) == "disabled"

    def test_empty_allowlist_has_no_upstreams(self) -> None:
        assert capture_authorization_state(_policy(upstreams=[]), now=NOW) == "no-upstreams"

    def test_missing_authorization_is_unauthorized(self) -> None:
        policy = _policy()
        policy.pop("authorization")
        assert capture_authorization_state(policy, now=NOW) == "unauthorized"

    def test_a_lapsed_grant_expires_on_its_own(self) -> None:
        assert capture_authorization_state(_policy(), now=NOW + timedelta(days=2)) == "expired"

    def test_authorization_block_clamps_the_lifetime(self) -> None:
        block = authorization_block(authorized_by="user-1", now=NOW, ttl_hours=100_000)
        granted = datetime.fromisoformat(block["authorizedAt"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(block["expiresAt"].replace("Z", "+00:00"))
        assert expires - granted == timedelta(hours=MAX_AUTHORIZATION_HOURS)


# ---------------------------------------------------------------------------
# Upstream allowlist
# ---------------------------------------------------------------------------


class TestUpstreamResolution:
    def test_an_allowlisted_path_resolves_under_its_entry(self) -> None:
        target = resolve_capture_upstream(_policy(), relative_path="/pets/7")
        assert target is not None
        assert target.url == "https://api.example.com/v1/pets/7"
        assert target.allowlist_entry == UPSTREAM

    def test_the_query_string_travels_but_is_not_logged(self) -> None:
        target = resolve_capture_upstream(_policy(), relative_path="/pets", query_string="token=abc&limit=2")
        assert target is not None
        assert target.url.endswith("?token=abc&limit=2")
        assert target.logged_url == "https://api.example.com/v1/pets"

    def test_a_request_hangs_off_the_entry_it_matched(self) -> None:
        policy = _policy(upstreams=["https://api.example.com/v1/pets"])
        target = resolve_capture_upstream(policy, relative_path="/7")
        assert target is not None
        assert target.url == "https://api.example.com/v1/pets/7"

    @pytest.mark.parametrize("escape", ["/../../admin", "/../orders", "/7/../../admin"])
    def test_traversal_cannot_escape_the_entry(self, escape: str) -> None:
        policy = _policy(upstreams=["https://api.example.com/v1/pets"])
        assert resolve_capture_upstream(policy, relative_path=escape) is None

    def test_harmless_dot_segments_resolve_rather_than_refuse(self) -> None:
        policy = _policy(upstreams=["https://api.example.com/v1/pets"])
        target = resolve_capture_upstream(policy, relative_path="/7/../8")
        assert target is not None
        assert target.url == "https://api.example.com/v1/pets/8"

    def test_the_first_matching_entry_wins(self) -> None:
        policy = _policy(upstreams=["https://api.example.com/v1", "https://other.example.com"])
        target = resolve_capture_upstream(policy, relative_path="/pets")
        assert target is not None
        assert target.allowlist_entry == "https://api.example.com/v1"

    def test_no_allowlist_resolves_to_nothing(self) -> None:
        assert resolve_capture_upstream({}, relative_path="/pets") is None


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def _exchange(**overrides: Any):
    """Redact one representative exchange, with overrides for the piece under test."""
    kwargs: Dict[str, Any] = {
        "policy": _policy(),
        "method": "get",
        "path": "/pets/7",
        "query_params": [("limit", "2")],
        "request_headers": {"Accept": "application/json"},
        "status": 200,
        "response_headers": {"Content-Type": "application/json"},
        "response_body": {"id": 7, "name": "Rex"},
        "response_media_type": "application/json",
    }
    kwargs.update(overrides)
    return redact_exchange(**kwargs)


class TestRedaction:
    def test_a_clean_exchange_records_no_decisions(self) -> None:
        exchange = _exchange()
        assert exchange.clean
        assert exchange.response["body"] == {"id": 7, "name": "Rex"}
        assert exchange.request["method"] == "GET"

    @pytest.mark.parametrize("header", sorted(ALWAYS_REDACTED_HEADERS))
    def test_every_always_on_header_is_removed(self, header: str) -> None:
        exchange = _exchange(request_headers={header: "s3cret", "Accept": "application/json"})
        assert header not in exchange.request["headers"]
        assert exchange.request["headers"] == {"accept": "application/json"}
        assert [d.rule for d in exchange.decisions] == ["always-header"]

    def test_credentials_in_the_query_string_are_removed(self) -> None:
        exchange = _exchange(query_params=[("limit", "2"), ("access_token", "abc")])
        assert exchange.request["query"] == [{"name": "limit", "value": "2"}]
        assert any(d.rule == "always-query" for d in exchange.decisions)

    def test_credential_shaped_body_fields_are_removed(self) -> None:
        exchange = _exchange(response_body={"id": 7, "apiKey": "live-key", "nested": {"password": "hunter2"}})
        assert exchange.response["body"] == {"id": 7, "nested": {}}
        pointers = {d.pointer for d in exchange.decisions}
        assert "/response/body/apiKey" in pointers
        assert "/response/body/nested/password" in pointers

    def test_jwt_values_are_removed_wherever_they_appear(self) -> None:
        token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"
        exchange = _exchange(response_body={"id": 7, "handoff": token})
        assert exchange.response["body"] == {"id": 7}
        assert any(d.rule == "jwt-value" for d in exchange.decisions)

    def test_policy_headers_are_removed_and_attributed_to_the_policy(self) -> None:
        exchange = _exchange(
            policy=_policy(redaction={"headers": ["X-Internal-Trace"]}),
            request_headers={"X-Internal-Trace": "abc", "Accept": "application/json"},
        )
        assert exchange.request["headers"] == {"accept": "application/json"}
        assert [d.rule for d in exchange.decisions] == ["policy-header"]

    def test_policy_body_fields_match_by_name_at_any_depth(self) -> None:
        exchange = _exchange(
            policy=_policy(redaction={"bodyFields": ["ssn"]}),
            response_body={"ssn": "1", "customer": {"ssn": "2", "name": "Ada"}},
        )
        assert exchange.response["body"] == {"customer": {"name": "Ada"}}
        assert len(exchange.decisions) == 2

    def test_policy_body_pointers_are_body_relative(self) -> None:
        exchange = _exchange(
            policy=_policy(redaction={"bodyFields": ["/customer/dob"]}),
            response_body={"dob": "keep", "customer": {"dob": "drop", "name": "Ada"}},
        )
        assert exchange.response["body"] == {"dob": "keep", "customer": {"name": "Ada"}}
        assert exchange.decisions[0].pointer == "/response/body/customer/dob"

    def test_opt_in_pattern_detectors_remove_personal_data(self) -> None:
        exchange = _exchange(
            policy=_policy(redaction={"patterns": ["email"]}),
            response_body={"email": "ada@example.com", "name": "Ada"},
        )
        assert exchange.response["body"] == {"name": "Ada"}
        assert exchange.decisions[0].rule == "pattern:email"

    def test_patterns_are_off_unless_selected(self) -> None:
        exchange = _exchange(response_body={"email": "ada@example.com"})
        assert exchange.response["body"] == {"email": "ada@example.com"}

    def test_an_oversize_body_is_dropped_whole(self) -> None:
        exchange = _exchange(response_body={"blob": "x"}, response_body_oversize=True)
        assert exchange.response["body"] is None
        assert exchange.decisions[0].rule == "body-too-large"
        assert str(MAX_CAPTURE_BODY_BYTES) in exchange.decisions[0].reason

    def test_a_binary_body_is_not_stored(self) -> None:
        exchange = _exchange(
            response_body="\x00\x01",
            response_media_type="image/png",
            response_body_textual=False,
        )
        assert exchange.response["body"] is None
        assert exchange.decisions[0].rule == "body-not-textual"

    def test_request_bodies_are_redacted_too(self) -> None:
        exchange = _exchange(
            method="post",
            request_body={"name": "Rex", "password": "hunter2"},
            request_media_type="application/json",
        )
        assert exchange.request["body"] == {"name": "Rex"}
        assert exchange.decisions[0].pointer == "/request/body/password"

    def test_decisions_carry_a_pointer_rule_and_reason(self) -> None:
        exchange = _exchange(request_headers={"Authorization": "Bearer x"})
        decision = exchange.decisions_as_json()[0]
        assert set(decision) == {"pointer", "rule", "reason"}
        assert decision["pointer"] == "/request/headers/authorization"

    def test_a_policy_can_never_subtract_from_the_always_on_rules(self) -> None:
        rules = redaction_rules_from_policy(_policy(redaction={"headers": ["X-Trace"]}))
        assert "authorization" in rules.header_keys
        assert "xtrace" in rules.header_keys


# ---------------------------------------------------------------------------
# Capture records
# ---------------------------------------------------------------------------


def _provenance(**overrides: Any) -> CaptureProvenance:
    fields: Dict[str, Any] = {
        "tenant": "demo",
        "project": "petstore",
        "version": "1.0.0",
        "upstream": "https://api.example.com/v1/pets/7",
        "allowlist_entry": UPSTREAM,
        "policy_digest": capture_policy_digest(_policy()),
        "captured_at": "2026-08-26T18:00:00Z",
        "captured_by": "key-1",
        "operation_key": "GET /pets/{petId}",
        "path_template": "/pets/{petId}",
    }
    fields.update(overrides)
    return CaptureProvenance(**fields)


class TestCaptureRecord:
    def test_record_carries_provenance_redaction_and_validation(self) -> None:
        record = build_capture_record(exchange=_exchange(), provenance=_provenance())
        assert record["captureFormat"] == CAPTURE_FORMAT
        assert record["provenance"]["allowlistEntry"] == UPSTREAM
        assert record["provenance"]["operationKey"] == "GET /pets/{petId}"
        assert record["redaction"] == {"clean": True, "count": 0, "decisions": []}
        assert record["validation"] == {"checked": True, "valid": True, "errors": []}

    def test_validation_errors_are_retained(self) -> None:
        record = build_capture_record(
            exchange=_exchange(), provenance=_provenance(), validation_errors=["id: not an integer"]
        )
        assert record["validation"]["valid"] is False
        assert record["validation"]["errors"] == ["id: not an integer"]

    def test_the_same_record_always_digests_the_same(self) -> None:
        first = build_capture_record(exchange=_exchange(), provenance=_provenance())
        second = build_capture_record(exchange=_exchange(), provenance=_provenance())
        assert capture_record_digest(first) == capture_record_digest(second)

    def test_a_redacted_record_survives_the_final_credential_scan(self) -> None:
        exchange = _exchange(
            request_headers={"Authorization": "Bearer live"},
            response_body={"id": 7, "apiKey": "live"},
        )
        record = build_capture_record(exchange=exchange, provenance=_provenance())
        assert residual_credential_pointers(record) == []

    def test_the_scan_flags_a_credential_the_rules_missed(self) -> None:
        record = build_capture_record(exchange=_exchange(), provenance=_provenance())
        record["response"]["body"] = {"id": 7, "secretToken": "live"}
        assert residual_credential_pointers(record) == ["/response/body/secretToken"]

    def test_the_decision_list_is_not_mistaken_for_a_credential(self) -> None:
        exchange = _exchange(request_headers={"Authorization": "Bearer live"})
        record = build_capture_record(exchange=exchange, provenance=_provenance())
        assert record["redaction"]["count"] == 1
        assert residual_credential_pointers(record) == []


# ---------------------------------------------------------------------------
# Review-before-publish conversion
# ---------------------------------------------------------------------------


def _record(*, status: int = 200, body: Any, path_template: str | None = "/pets/{petId}", path: str = "/pets/7"):
    exchange = _exchange(path=path, status=status, response_body=body)
    return build_capture_record(exchange=exchange, provenance=_provenance(path_template=path_template))


class TestFixturePackConversion:
    def test_item_responses_seed_their_parent_collection(self) -> None:
        pack, notes = fixture_pack_from_captures(
            [_record(body={"id": 7, "name": "Rex"})],
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert pack["collections"] == {"/pets": [{"id": 7, "name": "Rex"}]}
        assert notes == []

    def test_collection_responses_seed_every_resource(self) -> None:
        pack, _ = fixture_pack_from_captures(
            [_record(body=[{"id": 1}, {"id": 2}], path_template="/pets", path="/pets")],
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert pack["collections"] == {"/pets": [{"id": 1}, {"id": 2}]}

    def test_duplicate_resource_ids_are_seeded_once(self) -> None:
        pack, _ = fixture_pack_from_captures(
            [_record(body={"id": 7, "name": "Rex"}), _record(body={"id": 7, "name": "Rex again"})],
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert pack["collections"]["/pets"] == [{"id": 7, "name": "Rex"}]

    def test_a_response_without_a_collection_becomes_named_fixture_data(self) -> None:
        pack, _ = fixture_pack_from_captures(
            [_record(body={"total": 3}, path_template=None, path="/reports/summary")],
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert pack["data"] == {"get-reports-summary": {"total": 3}}

    def test_non_success_captures_are_skipped_with_a_note(self) -> None:
        pack, notes = fixture_pack_from_captures(
            [_record(status=503, body={"error": "down"})],
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert "collections" not in pack
        assert notes and "not a success" in notes[0]

    def test_a_body_lost_to_redaction_is_skipped_with_a_note(self) -> None:
        exchange = _exchange(response_body=None, response_body_oversize=True)
        record = build_capture_record(exchange=exchange, provenance=_provenance())
        _, notes = fixture_pack_from_captures(
            [record], approved_by="user-1", approved_at="2026-08-26T19:00:00Z"
        )
        assert notes and "no response body survived" in notes[0]

    def test_provenance_names_the_allowlist_entry_not_every_url(self) -> None:
        pack, _ = fixture_pack_from_captures(
            [_record(body={"id": 1}), _record(body={"id": 2}, path="/pets/2")],
            description="Two pets from staging.",
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert pack["provenance"]["capturedFrom"] == [UPSTREAM]
        assert pack["provenance"]["source"] == "capture"
        assert pack["provenance"]["captures"] == 2
        assert pack["provenance"]["approvedBy"] == "user-1"
        assert pack["description"] == "Two pets from staging."

    def test_provenance_counts_every_redaction_that_was_applied(self) -> None:
        exchange = _exchange(
            request_headers={"Authorization": "Bearer live"},
            response_body={"id": 7, "apiKey": "live"},
        )
        record = build_capture_record(exchange=exchange, provenance=_provenance())
        pack, _ = fixture_pack_from_captures(
            [record], approved_by="user-1", approved_at="2026-08-26T19:00:00Z"
        )
        assert pack["provenance"]["redactions"] == 2

    def test_the_converted_pack_passes_fixture_pack_validation(self) -> None:
        pack, _ = fixture_pack_from_captures(
            [_record(body={"id": 7, "name": "Rex"})],
            approved_by="user-1",
            approved_at="2026-08-26T19:00:00Z",
        )
        assert validate_fixture_packs({"from-capture": pack}) == []
