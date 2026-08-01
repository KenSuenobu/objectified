"""Source-IP allowlist for webhook ingestion (REPO-7.6, #2804).

The guard in front of the one repository route that has no bearer token. What these tests
pin is the decision itself — which addresses get through, which do not, and what happens in
each of the ways the inputs can be missing — because every one of those is a way to
accidentally build either an open door or an outage.

Four things get most of the attention:

* **Host bits are an error, not a rounding.** ``10.0.0.1/24`` is rejected rather than stored
  as ``10.0.0.0/24``; an operator who meant one machine and silently got 256 would never find
  out from the panel.
* **``X-Forwarded-For`` is worth exactly what the deployment says it is.** With no configured
  proxies the header is ignored entirely, because honouring it would let any caller name its
  own source address and defeat the filter it is supposed to pass.
* **A tenant's own ranges are its own.** They are consulted only for the tenants that
  registered the repository the payload names, so one workspace can never widen the filter
  protecting another's.
* **Nothing here can take a deployment down by accident.** An empty range cache allows and
  warns by default, an empty provider fetch is a failure that leaves yesterday's cache
  standing, and every ledger and audit write on the block path is best-effort.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import httpx
import pytest

from app.config import settings
from app.repository_webhook_ip_allowlist import (
    DECISION_ALLOWED,
    DECISION_BLOCKED,
    MAX_PROVIDER_RANGES,
    PROVIDER_RANGE_SOURCES,
    REASON_CLIENT_IP_UNKNOWN,
    REASON_ENFORCEMENT_DISABLED,
    REASON_NOT_ALLOWED,
    REASON_PROVIDER_RANGE,
    REASON_RANGES_UNAVAILABLE,
    REASON_TENANT_ALLOWLIST,
    REASON_TENANT_BYPASS,
    REFRESH_FAILURE,
    REFRESH_SKIPPED,
    REFRESH_SUCCESS,
    SOURCE_CONFIGURED,
    SOURCE_PROVIDER,
    client_ip_from_request,
    configured_provider_ranges,
    describe_tenant_ip_allowlist,
    evaluate_webhook_source_ip,
    fetch_provider_ip_ranges,
    guard_webhook_delivery,
    match_cidr,
    normalize_cidr,
    parse_ip_address,
    refresh_due_provider_ip_ranges,
    refresh_provider_ip_ranges,
    reset_provider_range_cache,
)

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_OTHER_TENANT = "660e8400-e29b-41d4-a716-446655440001"
_GITHUB_HOOK_RANGE = "192.30.252.0/22"
_GITHUB_HOOK_IP = "192.30.252.7"


@pytest.fixture(autouse=True)
def _no_range_cache(monkeypatch: pytest.MonkeyPatch):
    """Every case reads its own fake database rather than a neighbour's cached ranges."""
    monkeypatch.setattr(settings, "repository_webhook_ip_cache_seconds", 0)
    reset_provider_range_cache()
    yield
    reset_provider_range_cache()


@pytest.fixture
def enforced(monkeypatch: pytest.MonkeyPatch):
    """Turn the (default-off) filter on for a case that is about what it blocks."""
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_enabled", True)
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_strict", False)
    monkeypatch.setattr(settings, "repository_webhook_trusted_proxy_hops", 0)


def _db(
    *,
    provider_ranges: Optional[List[Dict[str, Any]]] = None,
    tenant_ids: Optional[List[str]] = None,
    tenant_entries: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    policies: Optional[Dict[str, Dict[str, Any]]] = None,
) -> MagicMock:
    """A database stand-in holding exactly the rows a case is about."""
    db = MagicMock()
    db.list_webhook_provider_ip_ranges.return_value = provider_ranges or []
    db.list_repository_webhook_tenant_ids.return_value = tenant_ids or []
    entries = tenant_entries or {}
    db.list_tenant_webhook_ip_allowlist.side_effect = (
        lambda tenant_id, enabled_only=False: entries.get(tenant_id, [])
    )
    stored = policies or {}
    db.get_tenant_webhook_ip_policy.side_effect = lambda tenant_id: stored.get(tenant_id)
    return db


def _range(cidr: str, family: int = 4, source: str = SOURCE_PROVIDER) -> Dict[str, Any]:
    return {
        "cidr": cidr,
        "family": family,
        "source": source,
        "refreshed_at": datetime(2026, 8, 1, tzinfo=timezone.utc),
    }


# --- CIDR normalisation ------------------------------------------------------------------


def test_a_cidr_is_stored_in_its_canonical_form() -> None:
    assert normalize_cidr(" 192.30.252.0/22 ") == (_GITHUB_HOOK_RANGE, 4)


def test_a_bare_address_becomes_its_single_host_network() -> None:
    """"Allow this one machine" is the most common thing an operator types."""
    assert normalize_cidr("203.0.113.9") == ("203.0.113.9/32", 4)
    assert normalize_cidr("2001:db8::1") == ("2001:db8::1/128", 6)


def test_host_bits_are_refused_rather_than_silently_widened() -> None:
    """Storing 10.0.0.1/24 as 10.0.0.0/24 would allow 256 hosts for an operator who asked
    for one, and nothing in the UI would ever say so."""
    with pytest.raises(ValueError, match="host bits"):
        normalize_cidr("10.0.0.1/24")


@pytest.mark.parametrize("value", ["", "   ", None, "not-an-address", "10.0.0.0/64"])
def test_an_unusable_cidr_is_an_error(value: Any) -> None:
    with pytest.raises(ValueError):
        normalize_cidr(value)


def test_an_absurdly_long_value_is_refused_before_it_is_parsed() -> None:
    with pytest.raises(ValueError, match="too long"):
        normalize_cidr("1.2.3.4/32" + "0" * 100)


# --- address parsing ---------------------------------------------------------------------


def test_an_ipv4_mapped_ipv6_address_matches_the_ipv4_ranges() -> None:
    """A dual-stack listener reports ::ffff:1.2.3.4 for a v4 client; it has to match the
    same v4 ranges a v4-only listener would."""
    assert str(parse_ip_address("::ffff:192.30.252.7")) == _GITHUB_HOOK_IP


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("203.0.113.9:8443", "203.0.113.9"),
        (" 203.0.113.9 ", "203.0.113.9"),
    ],
)
def test_a_port_is_stripped_from_the_shapes_proxies_actually_emit(
    raw: str, expected: str
) -> None:
    assert str(parse_ip_address(raw)) == expected


@pytest.mark.parametrize("raw", ["", None, "localhost", "999.1.1.1"])
def test_an_unparseable_address_is_none_rather_than_an_error(raw: Any) -> None:
    """`None` is a decision input — "we cannot identify this client" — not a crash on the
    unauthenticated path."""
    assert parse_ip_address(raw) is None


# --- client address from the request -----------------------------------------------------


def test_with_no_trusted_proxies_the_forwarded_header_is_ignored_entirely() -> None:
    """Honouring an unverified header would let any caller name its own source address,
    which is the whole filter defeated in one line."""
    got = client_ip_from_request(
        {"X-Forwarded-For": _GITHUB_HOOK_IP}, "203.0.113.9", 0
    )
    assert got == "203.0.113.9"


def test_one_trusted_proxy_reads_the_address_that_proxy_received_from() -> None:
    got = client_ip_from_request(
        {"X-Forwarded-For": "203.0.113.9"}, "10.0.0.2", 1
    )
    assert got == "203.0.113.9"


def test_a_longer_chain_is_read_from_the_right_not_the_left() -> None:
    """The leftmost entry is whatever the first hop claimed; only the entries our own
    proxies appended can be trusted, and they are at the end."""
    got = client_ip_from_request(
        {"X-Forwarded-For": "1.1.1.1, 203.0.113.9, 10.0.0.5"}, "10.0.0.2", 2
    )
    assert got == "203.0.113.9"


def test_a_header_shorter_than_the_configured_chain_yields_no_address() -> None:
    """The request did not traverse the proxies the deployment believes in, so every entry
    in the header is attacker-written."""
    assert client_ip_from_request({"X-Forwarded-For": "1.1.1.1"}, "10.0.0.2", 3) is None


def test_a_missing_header_behind_a_proxy_yields_no_address() -> None:
    assert client_ip_from_request({}, "10.0.0.2", 1) is None


def test_the_header_lookup_is_case_insensitive() -> None:
    assert client_ip_from_request({"x-forwarded-for": "203.0.113.9"}, None, 1) == "203.0.113.9"


def test_a_negative_hop_count_is_read_as_no_proxies() -> None:
    assert client_ip_from_request({"X-Forwarded-For": "1.1.1.1"}, "10.0.0.2", -4) == "10.0.0.2"


# --- range matching ----------------------------------------------------------------------


def test_an_address_inside_a_range_matches_it() -> None:
    assert match_cidr(parse_ip_address(_GITHUB_HOOK_IP), [_GITHUB_HOOK_RANGE]) == _GITHUB_HOOK_RANGE


def test_an_address_outside_every_range_matches_nothing() -> None:
    assert match_cidr(parse_ip_address("203.0.113.9"), [_GITHUB_HOOK_RANGE]) is None


def test_families_never_cross_match() -> None:
    assert match_cidr(parse_ip_address("2001:db8::1"), ["0.0.0.0/0"]) is None


def test_one_corrupt_stored_range_does_not_disable_the_rest() -> None:
    """A single unparseable row must not be able to reject every delivery the other rows
    would have allowed."""
    matched = match_cidr(
        parse_ip_address(_GITHUB_HOOK_IP), ["not-a-cidr", _GITHUB_HOOK_RANGE]
    )
    assert matched == _GITHUB_HOOK_RANGE


def test_no_address_matches_nothing() -> None:
    assert match_cidr(None, ["0.0.0.0/0"]) is None


# --- the decision ------------------------------------------------------------------------


def test_the_filter_is_off_by_default_and_says_so() -> None:
    """Enforcement that switched itself on during an upgrade would 403 every existing
    deployment's deliveries, and providers retrying into a 403 is a near-silent failure."""
    decision = evaluate_webhook_source_ip(
        _db(), provider="github", client_ip="203.0.113.9"
    )
    assert decision.allowed is True
    assert decision.decision == DECISION_ALLOWED
    assert decision.reason == REASON_ENFORCEMENT_DISABLED


def test_an_address_in_the_providers_published_range_is_allowed(enforced) -> None:
    decision = evaluate_webhook_source_ip(
        _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)]),
        provider="github",
        client_ip=_GITHUB_HOOK_IP,
    )
    assert decision.allowed is True
    assert decision.reason == REASON_PROVIDER_RANGE
    assert decision.matched_cidr == _GITHUB_HOOK_RANGE


def test_an_address_nobody_vouches_for_is_blocked(enforced) -> None:
    decision = evaluate_webhook_source_ip(
        _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)]),
        provider="github",
        client_ip="203.0.113.9",
        repo_full_name="octocat/hello-world",
    )
    assert decision.allowed is False
    assert decision.decision == DECISION_BLOCKED
    assert decision.reason == REASON_NOT_ALLOWED


def test_a_provider_range_lookup_never_needs_the_repository_name(enforced) -> None:
    """The common case must not cost a tenant resolution: an address GitHub itself
    delivers from is allowed before the payload is consulted at all."""
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)])
    evaluate_webhook_source_ip(db, provider="github", client_ip=_GITHUB_HOOK_IP)
    db.list_repository_webhook_tenant_ids.assert_not_called()


def test_a_client_address_that_cannot_be_established_is_blocked(enforced) -> None:
    decision = evaluate_webhook_source_ip(
        _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)]),
        provider="github",
        client_ip=None,
    )
    assert decision.allowed is False
    assert decision.reason == REASON_CLIENT_IP_UNKNOWN


def test_a_tenants_own_range_allows_a_delivery_for_that_tenants_repository(enforced) -> None:
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        tenant_entries={_TENANT: [{"cidr": "203.0.113.0/24", "enabled": True}]},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name="octocat/hello-world"
    )
    assert decision.allowed is True
    assert decision.reason == REASON_TENANT_ALLOWLIST
    assert decision.tenant_ids == (_TENANT,)


def test_the_delivery_path_asks_only_for_enabled_tenant_entries(enforced) -> None:
    """A disabled entry is an entry an operator has deliberately taken out of service."""
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        tenant_entries={_TENANT: []},
    )
    evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name="octocat/hello-world"
    )
    db.list_tenant_webhook_ip_allowlist.assert_called_once_with(_TENANT, enabled_only=True)


def test_one_tenants_range_never_widens_another_tenants_filter(enforced) -> None:
    """The whole reason the repository name is resolved: a union across tenants would let
    any workspace open the filter protecting all the others."""
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        tenant_entries={_OTHER_TENANT: [{"cidr": "203.0.113.0/24", "enabled": True}]},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name="octocat/hello-world"
    )
    assert decision.allowed is False


def test_a_tenant_that_has_bypassed_enforcement_accepts_any_address(enforced) -> None:
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        policies={_TENANT: {"enforcement_enabled": False, "bypass_reason": "vendor relay"}},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name="octocat/hello-world"
    )
    assert decision.allowed is True
    assert decision.reason == REASON_TENANT_BYPASS


def test_a_bypassing_tenant_is_honoured_even_with_no_usable_client_address(
    enforced,
) -> None:
    """The bypass exists for deployments whose addressing this service cannot see; a hole
    in the one escape hatch the feature provides would make it useless in exactly the
    situation it was added for."""
    db = _db(
        tenant_ids=[_TENANT],
        policies={_TENANT: {"enforcement_enabled": False}},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip=None, repo_full_name="octocat/hello-world"
    )
    assert decision.allowed is True
    assert decision.reason == REASON_TENANT_BYPASS


def test_an_unknown_address_is_blocked_for_an_enforcing_tenant(enforced) -> None:
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        tenant_entries={_TENANT: [{"cidr": "203.0.113.0/24", "enabled": True}]},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="not-an-address",
        repo_full_name="octocat/hello-world",
    )
    assert decision.allowed is False
    assert decision.reason == REASON_CLIENT_IP_UNKNOWN


def test_a_tenant_with_no_stored_policy_is_enforced(enforced) -> None:
    """"No row" means "the deployment default applies", not "unknown, so allow"."""
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        policies={},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name="octocat/hello-world"
    )
    assert decision.allowed is False


def test_an_unparseable_payload_leaves_the_tenant_halves_unconsulted(enforced) -> None:
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)])
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name=None
    )
    assert decision.allowed is False
    db.list_repository_webhook_tenant_ids.assert_not_called()


# --- the empty-cache posture -------------------------------------------------------------


def test_an_empty_range_cache_allows_and_warns_by_default(enforced, caplog) -> None:
    """A fresh deployment, or an upstream that has never answered, must not reject every
    delivery for the provider on the strength of a cache we failed to fill."""
    with caplog.at_level("WARNING"):
        decision = evaluate_webhook_source_ip(
            _db(), provider="github", client_ip="203.0.113.9"
        )
    assert decision.allowed is True
    assert decision.reason == REASON_RANGES_UNAVAILABLE
    assert "no cached ranges" in caplog.text


def test_strict_mode_turns_an_empty_range_cache_into_a_block(
    enforced, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "repository_webhook_ip_allowlist_strict", True)
    decision = evaluate_webhook_source_ip(
        _db(), provider="github", client_ip="203.0.113.9"
    )
    assert decision.allowed is False
    assert decision.reason == REASON_RANGES_UNAVAILABLE


def test_a_tenant_range_still_wins_over_an_empty_provider_cache(enforced) -> None:
    """The tenant half is checked before the unavailable-ranges verdict, so a workspace
    that has listed its own relay keeps working through an upstream outage."""
    db = _db(
        tenant_ids=[_TENANT],
        tenant_entries={_TENANT: [{"cidr": "203.0.113.0/24", "enabled": True}]},
    )
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip="203.0.113.9", repo_full_name="octocat/hello-world"
    )
    assert decision.reason == REASON_TENANT_ALLOWLIST


def test_a_database_failure_reading_ranges_does_not_raise(enforced) -> None:
    """The unauthenticated route must answer something even when the store is down; with
    no ranges to filter on, that is the default (non-strict) posture."""
    db = _db()
    db.list_webhook_provider_ip_ranges.side_effect = RuntimeError("connection refused")
    decision = evaluate_webhook_source_ip(db, provider="github", client_ip="203.0.113.9")
    assert decision.allowed is True
    assert decision.reason == REASON_RANGES_UNAVAILABLE


# --- the process-local cache -------------------------------------------------------------


def test_the_range_cache_spares_the_database_on_a_flood(
    enforced, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard is on an unauthenticated route: without the cache, a flood of blocked
    deliveries is a flood of queries — the one thing an attacker can still make it do."""
    monkeypatch.setattr(settings, "repository_webhook_ip_cache_seconds", 60)
    reset_provider_range_cache()
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)])
    for _ in range(5):
        evaluate_webhook_source_ip(db, provider="github", client_ip=_GITHUB_HOOK_IP)
    assert db.list_webhook_provider_ip_ranges.call_count == 1


def test_a_failed_range_read_is_not_cached(
    enforced, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A database blip must not pin the guard into its ranges-unavailable posture for the
    whole TTL."""
    monkeypatch.setattr(settings, "repository_webhook_ip_cache_seconds", 60)
    reset_provider_range_cache()
    db = _db()
    db.list_webhook_provider_ip_ranges.side_effect = RuntimeError("connection refused")
    evaluate_webhook_source_ip(db, provider="github", client_ip="203.0.113.9")
    db.list_webhook_provider_ip_ranges.side_effect = None
    db.list_webhook_provider_ip_ranges.return_value = [_range(_GITHUB_HOOK_RANGE)]
    decision = evaluate_webhook_source_ip(
        db, provider="github", client_ip=_GITHUB_HOOK_IP
    )
    assert decision.reason == REASON_PROVIDER_RANGE


# --- provider range fetching -------------------------------------------------------------


def _client_returning(payload: Any, status_code: int = 200):
    """An httpx client factory answering one canned response."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload)

    return lambda: httpx.Client(transport=httpx.MockTransport(handler))


def test_only_githubs_hook_ranges_are_read_from_its_meta_document() -> None:
    """`actions` and `web` are far larger and never deliver a webhook; including them
    would widen the filter to GitHub's entire estate for nothing."""
    factory = _client_returning(
        {"hooks": [_GITHUB_HOOK_RANGE], "actions": ["4.4.4.0/24"], "web": ["5.5.5.0/24"]}
    )
    assert fetch_provider_ip_ranges("github", client_factory=factory) == [_GITHUB_HOOK_RANGE]


def test_bitbucket_ranges_are_filtered_out_of_the_atlassian_document() -> None:
    factory = _client_returning(
        {
            "items": [
                {"cidr": "13.52.5.96/28", "product": ["bitbucket"]},
                {"cidr": "18.205.93.0/25", "product": ["jira"]},
                {"cidr": "1.2.3.0/24"},
            ]
        }
    )
    assert fetch_provider_ip_ranges("bitbucket", client_factory=factory) == ["13.52.5.96/28"]


def test_a_provider_that_publishes_nothing_fetches_nothing() -> None:
    assert PROVIDER_RANGE_SOURCES["gitlab"].url == ""
    assert fetch_provider_ip_ranges("gitlab") == []


def test_a_provider_with_nothing_to_fetch_and_nothing_configured_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`skipped`, not `failure`: GitLab publishing no list is a state the operator has
    already chosen, and a permanently red panel about it teaches people to ignore the
    panel."""
    monkeypatch.setattr(settings, "repository_webhook_ip_ranges_gitlab", "")
    db = MagicMock()
    result = refresh_provider_ip_ranges(db, "gitlab")
    assert result.outcome == REFRESH_SKIPPED
    db.replace_webhook_provider_ip_ranges.assert_not_called()


def test_a_provider_with_only_configured_ranges_still_populates_its_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "repository_webhook_ip_ranges_gitlab", "34.74.90.64/28"
    )
    db = MagicMock()
    db.replace_webhook_provider_ip_ranges.return_value = 0
    result = refresh_provider_ip_ranges(db, "gitlab")
    assert result.outcome == REFRESH_SUCCESS
    stored = db.replace_webhook_provider_ip_ranges.call_args[0][1]
    assert stored == [
        {"cidr": "34.74.90.64/28", "family": 4, "source": SOURCE_CONFIGURED}
    ]


def test_a_non_2xx_answer_is_an_error_not_an_empty_list() -> None:
    """An empty list would be indistinguishable from "the provider withdrew every
    address", which is what makes it dangerous to treat as data."""
    with pytest.raises(RuntimeError, match="503"):
        fetch_provider_ip_ranges("github", client_factory=_client_returning({}, 503))


def test_a_body_that_is_not_json_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    with pytest.raises(RuntimeError, match="did not answer with JSON"):
        fetch_provider_ip_ranges(
            "github",
            client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
        )


def test_an_implausibly_large_answer_is_refused() -> None:
    factory = _client_returning({"hooks": ["1.2.3.0/24"] * (MAX_PROVIDER_RANGES + 1)})
    with pytest.raises(RuntimeError, match="more than"):
        fetch_provider_ip_ranges("github", client_factory=factory)


# --- configured ranges -------------------------------------------------------------------


def test_configured_ranges_are_canonicalised_and_deduplicated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings,
        "repository_webhook_ip_ranges_gitlab",
        " 34.74.90.64/28 , 34.74.90.64/28 ; 203.0.113.9 ",
    )
    assert configured_provider_ranges("gitlab") == ["34.74.90.64/28", "203.0.113.9/32"]


def test_one_typo_does_not_cost_the_other_configured_ranges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "repository_webhook_ip_ranges_gitlab", "not-a-cidr,34.74.90.64/28"
    )
    assert configured_provider_ranges("gitlab") == ["34.74.90.64/28"]


# --- the refresh -------------------------------------------------------------------------


def test_a_successful_refresh_replaces_the_cache_and_records_the_success() -> None:
    db = MagicMock()
    db.replace_webhook_provider_ip_ranges.return_value = 2
    result = refresh_provider_ip_ranges(
        db, "github", client_factory=_client_returning({"hooks": [_GITHUB_HOOK_RANGE]})
    )
    assert result.outcome == REFRESH_SUCCESS
    assert result.stored == 1
    assert result.removed == 2
    stored = db.replace_webhook_provider_ip_ranges.call_args[0][1]
    assert stored == [{"cidr": _GITHUB_HOOK_RANGE, "family": 4, "source": SOURCE_PROVIDER}]
    db.record_webhook_provider_ip_refresh.assert_called_once()
    assert db.record_webhook_provider_ip_refresh.call_args.kwargs["outcome"] == REFRESH_SUCCESS


def test_configured_ranges_are_merged_into_the_fetched_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "repository_webhook_ip_ranges_github", "203.0.113.0/24"
    )
    db = MagicMock()
    db.replace_webhook_provider_ip_ranges.return_value = 0
    refresh_provider_ip_ranges(
        db, "github", client_factory=_client_returning({"hooks": [_GITHUB_HOOK_RANGE]})
    )
    stored = db.replace_webhook_provider_ip_ranges.call_args[0][1]
    assert [row["cidr"] for row in stored] == [_GITHUB_HOOK_RANGE, "203.0.113.0/24"]
    assert [row["source"] for row in stored] == [SOURCE_PROVIDER, SOURCE_CONFIGURED]


def test_an_empty_fetch_leaves_the_previous_cache_standing() -> None:
    """An empty answer is far likelier to be an upstream incident than a genuine
    withdrawal of every address; acting on it would open the filter or take deliveries
    down on the strength of one bad response."""
    db = MagicMock()
    result = refresh_provider_ip_ranges(
        db, "github", client_factory=_client_returning({"hooks": []})
    )
    assert result.outcome == REFRESH_FAILURE
    db.replace_webhook_provider_ip_ranges.assert_not_called()


def test_a_fetch_failure_is_recorded_rather_than_raised() -> None:
    """The caller is a background sweep whose next tick is the retry; raising would only
    turn a provider outage into a sweep crash loop."""
    db = MagicMock()

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure")

    result = refresh_provider_ip_ranges(
        db,
        "github",
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert result.outcome == REFRESH_FAILURE
    assert "ConnectError" in (result.error or "")
    assert db.record_webhook_provider_ip_refresh.call_args.kwargs["outcome"] == REFRESH_FAILURE


def test_configured_ranges_survive_a_failed_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    """A partial success is still a success — there are ranges to filter on — but the
    fetch error is kept so the panel can say the provider has been unreachable."""
    monkeypatch.setattr(
        settings, "repository_webhook_ip_ranges_github", "203.0.113.0/24"
    )
    db = MagicMock()
    db.replace_webhook_provider_ip_ranges.return_value = 0

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure")

    result = refresh_provider_ip_ranges(
        db,
        "github",
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert result.outcome == REFRESH_SUCCESS
    assert "ConnectError" in (result.error or "")


def test_a_store_failure_is_reported_as_a_failed_refresh() -> None:
    db = MagicMock()
    db.replace_webhook_provider_ip_ranges.side_effect = RuntimeError("deadlock")
    result = refresh_provider_ip_ranges(
        db, "github", client_factory=_client_returning({"hooks": [_GITHUB_HOOK_RANGE]})
    )
    assert result.outcome == REFRESH_FAILURE
    assert "deadlock" in (result.error or "")


def test_an_unsupported_provider_is_refused_rather_than_fetched() -> None:
    result = refresh_provider_ip_ranges(MagicMock(), "sourcehut")
    assert result.outcome == REFRESH_FAILURE


def test_a_refresh_is_due_from_the_last_success_not_the_last_attempt() -> None:
    """A provider whose endpoint has been failing must be retried on the next tick, not
    tomorrow — that is the difference between a two-hour gap and a two-day one."""
    now = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    db = MagicMock()
    db.list_webhook_provider_ip_refresh.return_value = [
        {
            "provider": "github",
            "last_attempt_at": now - timedelta(minutes=5),
            "last_success_at": now - timedelta(days=3),
        }
    ]
    db.replace_webhook_provider_ip_ranges.return_value = 0
    results = refresh_due_provider_ip_ranges(
        db,
        interval_seconds=86400,
        now=now,
        client_factory=_client_returning({"hooks": [_GITHUB_HOOK_RANGE]}),
    )
    assert "github" in [r.provider for r in results]


def test_a_provider_refreshed_within_the_cadence_is_left_alone() -> None:
    now = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    db = MagicMock()
    db.list_webhook_provider_ip_refresh.return_value = [
        {"provider": p, "last_success_at": now - timedelta(hours=1)}
        for p in ("github", "gitlab", "bitbucket")
    ]
    assert refresh_due_provider_ip_ranges(db, interval_seconds=86400, now=now) == []


def test_a_provider_never_refreshed_is_due(monkeypatch: pytest.MonkeyPatch) -> None:
    now = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    db = MagicMock()
    db.list_webhook_provider_ip_refresh.return_value = []
    db.replace_webhook_provider_ip_ranges.return_value = 0
    results = refresh_due_provider_ip_ranges(
        db,
        interval_seconds=86400,
        now=now,
        client_factory=_client_returning({"hooks": [_GITHUB_HOOK_RANGE]}),
    )
    assert {r.provider for r in results} == {"github", "gitlab", "bitbucket"}


def test_a_refresh_state_read_failure_still_refreshes_everything() -> None:
    db = MagicMock()
    db.list_webhook_provider_ip_refresh.side_effect = RuntimeError("connection refused")
    db.replace_webhook_provider_ip_ranges.return_value = 0
    results = refresh_due_provider_ip_ranges(
        db,
        interval_seconds=86400,
        now=datetime(2026, 8, 1, tzinfo=timezone.utc),
        client_factory=_client_returning({"hooks": [_GITHUB_HOOK_RANGE]}),
    )
    assert len(results) == 3


# --- the guard the route calls -----------------------------------------------------------


def _body(repo: str = "octocat/Hello-World") -> bytes:
    import json as _json

    return _json.dumps({"repository": {"full_name": repo}}).encode("utf-8")


def test_the_guard_resolves_the_tenant_from_the_payload(enforced) -> None:
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT],
        tenant_entries={_TENANT: [{"cidr": "203.0.113.0/24", "enabled": True}]},
    )
    decision = guard_webhook_delivery(
        db, provider="github", raw_body=_body(), headers={}, peer_ip="203.0.113.9"
    )
    assert decision.allowed is True
    db.list_repository_webhook_tenant_ids.assert_called_once_with(
        "github", "octocat/hello-world"
    )


def test_a_body_the_guard_cannot_read_is_not_a_reason_to_allow(enforced) -> None:
    """The 400 for an unusable body still comes from the ingestion path afterwards — but
    only for the deliveries that get that far."""
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)])
    decision = guard_webhook_delivery(
        db, provider="github", raw_body=b"<not json>", headers={}, peer_ip="203.0.113.9"
    )
    assert decision.allowed is False


def test_a_blocked_delivery_is_written_to_the_webhook_ledger(enforced) -> None:
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)], tenant_ids=[_TENANT])
    guard_webhook_delivery(
        db,
        provider="github",
        raw_body=_body(),
        headers={"X-GitHub-Delivery": "d-1", "X-GitHub-Event": "push"},
        peer_ip="203.0.113.9",
    )
    kwargs = db.record_repository_webhook_event.call_args.kwargs
    assert kwargs["outcome"] == "rejected"
    assert kwargs["reason"] == REASON_NOT_ALLOWED
    assert kwargs["delivery_id"] == "d-1"


def test_a_blocked_delivery_is_audited_for_every_owning_tenant(enforced) -> None:
    """A tenant whose provider changed egress ranges has to be able to see why its
    deliveries stopped."""
    db = _db(
        provider_ranges=[_range(_GITHUB_HOOK_RANGE)],
        tenant_ids=[_TENANT, _OTHER_TENANT],
    )
    guard_webhook_delivery(
        db, provider="github", raw_body=_body(), headers={}, peer_ip="203.0.113.9"
    )
    audited = [call.args[0] for call in db.insert_workflow_audit.call_args_list]
    assert audited == [_TENANT, _OTHER_TENANT]


def test_an_allowed_delivery_writes_no_ledger_row(enforced) -> None:
    """The dispatcher records the delivery it goes on to handle; a second row here would
    double-count every accepted delivery."""
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)])
    guard_webhook_delivery(
        db, provider="github", raw_body=_body(), headers={}, peer_ip=_GITHUB_HOOK_IP
    )
    db.record_repository_webhook_event.assert_not_called()


def test_a_ledger_outage_does_not_rescue_a_blocked_delivery(enforced) -> None:
    """Evidence problems must not become availability problems — in either direction."""
    db = _db(provider_ranges=[_range(_GITHUB_HOOK_RANGE)], tenant_ids=[_TENANT])
    db.record_repository_webhook_event.side_effect = RuntimeError("ledger down")
    db.insert_workflow_audit.side_effect = RuntimeError("audit down")
    decision = guard_webhook_delivery(
        db, provider="github", raw_body=_body(), headers={}, peer_ip="203.0.113.9"
    )
    assert decision.allowed is False


# --- the admin projection ----------------------------------------------------------------


def _describe_db() -> MagicMock:
    db = MagicMock()
    db.get_tenant_webhook_ip_policy.return_value = None
    db.list_webhook_provider_ip_refresh.return_value = [
        {
            "provider": "github",
            "last_attempt_at": datetime(2026, 8, 1, 10, tzinfo=timezone.utc),
            "last_success_at": datetime(2026, 8, 1, 10, tzinfo=timezone.utc),
            "last_outcome": "success",
            "last_error": None,
            "range_count": 1,
        }
    ]
    db.list_webhook_provider_ip_ranges.side_effect = (
        lambda provider: [_range(_GITHUB_HOOK_RANGE)] if provider == "github" else []
    )
    db.list_tenant_webhook_ip_allowlist.return_value = [
        {
            "id": "aa0e8400-e29b-41d4-a716-44665544000a",
            "cidr": "203.0.113.0/24",
            "family": 4,
            "description": "vendor relay",
            "enabled": True,
            "created_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
        }
    ]
    return db


def test_the_panel_read_reports_every_provider_even_the_empty_ones() -> None:
    """A provider missing from the list would read as "not supported" rather than "no
    ranges cached yet"."""
    view = describe_tenant_ip_allowlist(
        _describe_db(), _TENANT, now=datetime(2026, 8, 1, 11, tzinfo=timezone.utc)
    )
    assert [p["provider"] for p in view["providers"]] == ["github", "gitlab", "bitbucket"]


def test_a_provider_refreshed_within_two_cadences_is_not_stale() -> None:
    """One cadence would flip the panel to stale every day for a refresh that merely ran
    a minute late."""
    view = describe_tenant_ip_allowlist(
        _describe_db(), _TENANT, now=datetime(2026, 8, 2, 9, tzinfo=timezone.utc)
    )
    github = next(p for p in view["providers"] if p["provider"] == "github")
    assert github["stale"] is False
    assert github["rangeCount"] == 1


def test_a_provider_that_has_never_refreshed_is_stale() -> None:
    view = describe_tenant_ip_allowlist(
        _describe_db(), _TENANT, now=datetime(2026, 8, 1, 11, tzinfo=timezone.utc)
    )
    gitlab = next(p for p in view["providers"] if p["provider"] == "gitlab")
    assert gitlab["stale"] is True
    assert gitlab["lastOutcome"] == "pending"


def test_a_tenant_with_no_policy_row_reads_as_enforced() -> None:
    view = describe_tenant_ip_allowlist(_describe_db(), _TENANT)
    assert view["tenantEnforcementEnabled"] is True
    assert view["bypassReason"] is None


def test_a_bypassing_tenant_reports_its_reason() -> None:
    db = _describe_db()
    db.get_tenant_webhook_ip_policy.return_value = {
        "enforcement_enabled": False,
        "bypass_reason": "vendor relay has no published range",
        "updated_at": datetime(2026, 7, 30, tzinfo=timezone.utc),
    }
    view = describe_tenant_ip_allowlist(db, _TENANT)
    assert view["tenantEnforcementEnabled"] is False
    assert view["bypassReason"] == "vendor relay has no published range"


def test_the_panel_read_shows_disabled_entries_too() -> None:
    """A disabled entry has to be visible for anyone to ever re-enable it."""
    db = _describe_db()
    describe_tenant_ip_allowlist(db, _TENANT)
    db.list_tenant_webhook_ip_allowlist.assert_called_once_with(_TENANT)


def test_one_failing_read_does_not_take_the_whole_panel_down() -> None:
    db = _describe_db()
    db.list_webhook_provider_ip_refresh.side_effect = RuntimeError("connection refused")
    view = describe_tenant_ip_allowlist(db, _TENANT)
    assert len(view["providers"]) == 3
    assert len(view["entries"]) == 1
