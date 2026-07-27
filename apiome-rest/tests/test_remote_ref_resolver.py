"""SSRF-guarded remote ``$ref`` resolver — MFI-29.4 (#4391).

Covers the ticket's acceptance criteria against
:mod:`app.remote_ref_resolver`:

* a document with external references imports **fully resolved** when enabled (including
  chained references inside fetched documents), and is left untouched when disabled;
* **budgets terminate a hostile ref-chain** — reference count, depth, byte ceiling, and the
  wall-clock deadline each stop resolution without raising;
* **disabled mode lists unresolved externals as findings**, with registered rule ids;
* **every fetch passes the SSRF guard**, redirects included — a disallowed scheme never
  reaches a client, and a redirect to an internal address is refused mid-chain;
* the content-addressed cache means a re-import does not re-fetch.

The network is never touched: unit tests inject a fetcher callable, and the tests that
exercise the real HTTP path drive the guarded client through an ``httpx.MockTransport``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List
from unittest.mock import patch

import httpx
import pytest

from app import remote_ref_resolver, ssrf_guard
from app.import_source import LintFinding, LintReport
from app.intake_lint_rules import RULE_BLOCKED_EXTERNAL_REF, RULE_UNRESOLVED_EXTERNAL_REF
from app.lint_rule_registry import builtin_rule_ids
from app.remote_ref_resolver import (
    REASON_BLOCKED,
    REASON_BUDGET_BYTES,
    REASON_BUDGET_DEPTH,
    REASON_BUDGET_REFS,
    REASON_BUDGET_TIME,
    REASON_CIRCULAR,
    REASON_DISABLED,
    REASON_FETCH_FAILED,
    REASON_POINTER_NOT_FOUND,
    REASON_UNPARSEABLE,
    RemoteRefBudget,
    RemoteRefCache,
    resolve_remote_refs,
    scan_external_refs,
)

MSGS_URL = "https://schemas.example.com/messages.json"
COMMON_URL = "https://schemas.example.com/common.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Fetcher:
    """A recording stand-in for the HTTP fetcher.

    Serves documents from an in-memory ``url → bytes`` store and records every call, so a
    test can assert *what* was fetched (and that a cache hit fetched nothing).
    """

    def __init__(self, store: Dict[str, bytes]) -> None:
        self.store = store
        self.calls: List[str] = []

    def __call__(self, url: str, *, max_bytes: int, timeout: float) -> bytes:
        self.calls.append(url)
        if url not in self.store:
            raise remote_ref_resolver._FetchError(REASON_FETCH_FAILED, f"HTTP 404 from {url}")
        return self.store[url]


def _doc(**payload: Any) -> bytes:
    """Serialize a document the fetcher should serve."""
    return json.dumps(payload).encode("utf-8")


def _asyncapi_root(ref: str = f"{MSGS_URL}#/Signup") -> Dict[str, Any]:
    """A minimal AsyncAPI-shaped root whose message points at a remote library."""
    return {
        "asyncapi": "3.0.0",
        "info": {"title": "Accounts", "version": "1.0.0"},
        "channels": {"user/signedup": {"messages": {"signup": {"$ref": ref}}}},
    }


def _cache() -> RemoteRefCache:
    """A private cache, so tests never share the process-wide one."""
    return RemoteRefCache(max_entries=8, max_bytes=1_000_000, ttl_seconds=0.0)


# ---------------------------------------------------------------------------
# Scanning: what counts as an external reference
# ---------------------------------------------------------------------------


def test_scan_finds_absolute_http_refs_only() -> None:
    documents = {
        "": {
            "a": {"$ref": f"{MSGS_URL}#/Signup"},
            "b": {"$ref": "#/components/schemas/Local"},  # in-document: the adapter's job
            "c": {"$ref": "./sibling.yaml#/Thing"},  # relative: the fileset bundler's job
            "d": [{"$ref": "http://plain.example/x.json"}],
        }
    }
    refs = scan_external_refs(documents)

    assert [r.url for r in refs] == ["https://schemas.example.com/messages.json", "http://plain.example/x.json"]
    assert [r.location for r in refs] == ["#/a", "#/d/0"]


def test_scan_labels_fileset_members_and_sorts() -> None:
    documents = {
        "b.yaml": {"x": {"$ref": f"{COMMON_URL}#/Id"}},
        "a.yaml": {"y": {"$ref": f"{MSGS_URL}#/Signup"}},
    }
    refs = scan_external_refs(documents)

    assert [r.location for r in refs] == ["a.yaml#/y", "b.yaml#/x"]


def test_scan_is_pure() -> None:
    root = _asyncapi_root()
    before = json.dumps(root, sort_keys=True)
    scan_external_refs({"": root})
    assert json.dumps(root, sort_keys=True) == before


# ---------------------------------------------------------------------------
# Disabled mode: report, never fetch
# ---------------------------------------------------------------------------


def test_disabled_reports_every_external_ref_and_fetches_nothing() -> None:
    fetcher = _Fetcher({})
    root = _asyncapi_root()

    outcome = resolve_remote_refs({"": root}, enabled=False, fetcher=fetcher, cache=_cache())

    assert fetcher.calls == []
    assert outcome.enabled is False
    assert outcome.documents[""] is root  # untouched, same object
    assert [(r.reason, r.url) for r in outcome.unresolved] == [(REASON_DISABLED, MSGS_URL)]
    assert outcome.resolved == ()


def test_disabled_findings_use_registered_rule_ids() -> None:
    outcome = resolve_remote_refs({"": _asyncapi_root()}, enabled=False)
    findings = outcome.findings()

    assert [f.rule for f in findings] == [RULE_UNRESOLVED_EXTERNAL_REF]
    assert findings[0].severity == "warning"
    assert findings[0].path == "#/channels/user~1signedup/messages/signup"
    assert MSGS_URL in findings[0].message
    # GOV-1.2: every emitted rule id is a registered, documented rule.
    assert set(f.rule for f in findings) <= set(builtin_rule_ids())


def test_report_shape_for_disabled_run() -> None:
    report = resolve_remote_refs({"": _asyncapi_root()}, enabled=False).report()

    assert report["enabled"] is False
    assert report["resolved"] == 0
    assert report["unresolved"] == 1
    assert report["blocked"] == 0
    assert report["budget_exhausted"] is False
    assert report["refs"][0]["reason"] == REASON_DISABLED
    assert report["refs_truncated"] is False


def test_no_external_refs_produces_an_empty_outcome() -> None:
    outcome = resolve_remote_refs({"": {"asyncapi": "3.0.0"}}, enabled=False)
    assert outcome.resolved == () and outcome.unresolved == ()
    assert outcome.findings() == []


# ---------------------------------------------------------------------------
# Enabled mode: fetch, inline, chain
# ---------------------------------------------------------------------------


def test_enabled_inlines_the_referenced_fragment() -> None:
    fetcher = _Fetcher({MSGS_URL: _doc(Signup={"payload": {"type": "object"}})})
    root = _asyncapi_root()

    outcome = resolve_remote_refs({"": root}, enabled=True, fetcher=fetcher, cache=_cache())

    assert fetcher.calls == [MSGS_URL]
    assert outcome.documents[""]["channels"]["user/signedup"]["messages"]["signup"] == {
        "payload": {"type": "object"}
    }
    assert outcome.unresolved == ()
    assert outcome.changed_documents == ("",)
    assert outcome.resolved[0].url == MSGS_URL
    assert outcome.resolved[0].digest and outcome.resolved[0].bytes_fetched > 0


def test_enabled_does_not_mutate_the_caller_document() -> None:
    fetcher = _Fetcher({MSGS_URL: _doc(Signup={"payload": {"type": "object"}})})
    root = _asyncapi_root()
    before = json.dumps(root, sort_keys=True)

    resolve_remote_refs({"": root}, enabled=True, fetcher=fetcher, cache=_cache())

    assert json.dumps(root, sort_keys=True) == before


def test_relative_ref_inside_a_fetched_document_resolves_against_its_url() -> None:
    fetcher = _Fetcher(
        {
            MSGS_URL: _doc(Signup={"payload": {"$ref": "./common.json#/Id"}}),
            COMMON_URL: _doc(Id={"type": "string", "format": "uuid"}),
        }
    )

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    assert fetcher.calls == [MSGS_URL, COMMON_URL]
    message = outcome.documents[""]["channels"]["user/signedup"]["messages"]["signup"]
    assert message == {"payload": {"type": "string", "format": "uuid"}}
    assert len(outcome.resolved) == 2


def test_fragment_ref_inside_a_fetched_document_addresses_that_document() -> None:
    fetcher = _Fetcher(
        {MSGS_URL: _doc(Signup={"payload": {"$ref": "#/Id"}}, Id={"type": "string"})}
    )

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    message = outcome.documents[""]["channels"]["user/signedup"]["messages"]["signup"]
    assert message == {"payload": {"type": "string"}}
    assert fetcher.calls == [MSGS_URL]  # the second hop is the same, cached document


def test_whole_document_ref_without_a_fragment() -> None:
    fetcher = _Fetcher({COMMON_URL: _doc(type="string")})

    outcome = resolve_remote_refs(
        {"": {"x": {"$ref": COMMON_URL}}}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    assert outcome.documents[""]["x"] == {"type": "string"}


def test_fileset_members_share_one_run() -> None:
    fetcher = _Fetcher({COMMON_URL: _doc(Id={"type": "string"})})
    documents = {
        "root.yaml": {"a": {"$ref": f"{COMMON_URL}#/Id"}},
        "other.yaml": {"b": {"$ref": f"{COMMON_URL}#/Id"}},
        "readme.md": {"no": "refs"},
    }

    outcome = resolve_remote_refs(documents, enabled=True, fetcher=fetcher, cache=_cache())

    assert fetcher.calls == [COMMON_URL]  # fetched once, reused for the second member
    assert sorted(outcome.changed_documents) == ["other.yaml", "root.yaml"]
    assert outcome.documents["readme.md"] is documents["readme.md"]
    assert outcome.cache_hits == 1


# ---------------------------------------------------------------------------
# Failure handling: one bad reference degrades its subtree only
# ---------------------------------------------------------------------------


def test_missing_pointer_leaves_the_ref_in_place() -> None:
    fetcher = _Fetcher({MSGS_URL: _doc(Other={})})

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    assert [r.reason for r in outcome.unresolved] == [REASON_POINTER_NOT_FOUND]
    assert outcome.documents[""]["channels"]["user/signedup"]["messages"]["signup"] == {
        "$ref": f"{MSGS_URL}#/Signup"
    }


def test_unparseable_document_is_reported() -> None:
    fetcher = _Fetcher({MSGS_URL: b"{ not json : ["})

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    assert [r.reason for r in outcome.unresolved] == [REASON_UNPARSEABLE]


def test_failed_fetch_is_reported() -> None:
    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=_Fetcher({}), cache=_cache()
    )

    assert [r.reason for r in outcome.unresolved] == [REASON_FETCH_FAILED]


def test_unexpected_fetcher_error_never_escapes() -> None:
    def _boom(url: str, *, max_bytes: int, timeout: float) -> bytes:
        raise RuntimeError("transport exploded")

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=_boom, cache=_cache()
    )

    assert [r.reason for r in outcome.unresolved] == [REASON_FETCH_FAILED]
    assert "RuntimeError" in outcome.unresolved[0].detail


def test_circular_reference_chain_terminates() -> None:
    fetcher = _Fetcher(
        {
            MSGS_URL: _doc(Signup={"$ref": f"{COMMON_URL}#/Loop"}),
            COMMON_URL: _doc(Loop={"$ref": f"{MSGS_URL}#/Signup"}),
        }
    )

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    assert [r.reason for r in outcome.unresolved] == [REASON_CIRCULAR]


def test_unresolved_ref_from_a_fetched_document_is_rewritten_absolute() -> None:
    # ``./nope.json#/Q`` means something different once copied into the root document, so an
    # unresolved reference is rewritten to the document it actually named.
    fetcher = _Fetcher({MSGS_URL: _doc(Signup={"payload": {"$ref": "./nope.json#/Q"}})})

    outcome = resolve_remote_refs(
        {"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    message = outcome.documents[""]["channels"]["user/signedup"]["messages"]["signup"]
    assert message == {"payload": {"$ref": "https://schemas.example.com/nope.json#/Q"}}


# ---------------------------------------------------------------------------
# Budgets terminate a hostile ref-chain
# ---------------------------------------------------------------------------


def _chain_fetcher(length: int = 500) -> _Fetcher:
    """A store whose every document references the next one — an endless chain."""
    store = {
        f"https://hostile.example/{i}.json": _doc(
            Next={"$ref": f"https://hostile.example/{i + 1}.json#/Next"}
        )
        for i in range(length)
    }
    return _Fetcher(store)


def test_max_refs_budget_stops_a_hostile_chain() -> None:
    fetcher = _chain_fetcher()
    root = {"": {"x": {"$ref": "https://hostile.example/0.json#/Next"}}}

    outcome = resolve_remote_refs(
        root,
        enabled=True,
        fetcher=fetcher,
        cache=_cache(),
        budget=RemoteRefBudget(max_refs=3, max_depth=100),
    )

    assert len(outcome.resolved) == 3
    assert len(fetcher.calls) == 3
    assert [r.reason for r in outcome.unresolved] == [REASON_BUDGET_REFS]
    assert outcome.budget_exhausted is True


def test_max_depth_budget_stops_a_hostile_chain() -> None:
    fetcher = _chain_fetcher()
    root = {"": {"x": {"$ref": "https://hostile.example/0.json#/Next"}}}

    outcome = resolve_remote_refs(
        root,
        enabled=True,
        fetcher=fetcher,
        cache=_cache(),
        budget=RemoteRefBudget(max_refs=1000, max_depth=2),
    )

    assert len(outcome.resolved) == 2
    assert [r.reason for r in outcome.unresolved] == [REASON_BUDGET_DEPTH]
    assert outcome.budget_exhausted is True


def test_byte_budget_stops_resolution() -> None:
    big = _doc(Signup={"payload": {"description": "x" * 4096}})
    fetcher = _Fetcher({MSGS_URL: big, COMMON_URL: big})
    documents = {
        "a.yaml": {"x": {"$ref": f"{MSGS_URL}#/Signup"}},
        "b.yaml": {"y": {"$ref": f"{COMMON_URL}#/Signup"}},
    }

    outcome = resolve_remote_refs(
        documents,
        enabled=True,
        fetcher=fetcher,
        cache=_cache(),
        budget=RemoteRefBudget(max_bytes=len(big)),
    )

    assert len(outcome.resolved) == 1
    assert [r.reason for r in outcome.unresolved] == [REASON_BUDGET_BYTES]


def test_an_oversized_response_spends_the_whole_byte_budget() -> None:
    # The bytes crossed the wire even though nothing was kept, so a server serving one
    # oversized body per reference must not be re-downloaded once per reference.
    attempts: List[str] = []

    def _oversized(url: str, *, max_bytes: int, timeout: float) -> bytes:
        attempts.append(url)
        raise remote_ref_resolver._FetchError(
            REASON_BUDGET_BYTES, f"response from {url} exceeds the remaining budget"
        )

    documents = {
        "a.yaml": {"x": {"$ref": f"{MSGS_URL}#/Signup"}},
        "b.yaml": {"y": {"$ref": f"{COMMON_URL}#/Signup"}},
    }
    outcome = resolve_remote_refs(
        documents, enabled=True, fetcher=_oversized, cache=_cache()
    )

    assert attempts == [MSGS_URL]  # the second reference never reached the network
    assert [r.reason for r in outcome.unresolved] == [REASON_BUDGET_BYTES, REASON_BUDGET_BYTES]


def test_byte_budget_is_passed_to_the_fetcher_as_the_remaining_allowance() -> None:
    seen: List[int] = []

    def _fetch(url: str, *, max_bytes: int, timeout: float) -> bytes:
        seen.append(max_bytes)
        return _doc(Signup={"payload": {}})

    resolve_remote_refs(
        {"": _asyncapi_root()},
        enabled=True,
        fetcher=_fetch,
        cache=_cache(),
        budget=RemoteRefBudget(max_bytes=1234),
    )

    assert seen == [1234]


def test_wall_clock_deadline_stops_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 1_000.0}
    monkeypatch.setattr(remote_ref_resolver.time, "monotonic", lambda: clock["now"])

    def _slow(url: str, *, max_bytes: int, timeout: float) -> bytes:
        clock["now"] += 10.0  # each fetch burns ten seconds
        return _doc(Signup={"payload": {}})

    documents = {
        "a.yaml": {"x": {"$ref": f"{MSGS_URL}#/Signup"}},
        "b.yaml": {"y": {"$ref": f"{COMMON_URL}#/Signup"}},
    }
    outcome = resolve_remote_refs(
        documents,
        enabled=True,
        fetcher=_slow,
        cache=_cache(),
        budget=RemoteRefBudget(total_timeout_seconds=5.0),
    )

    assert len(outcome.resolved) == 1
    assert [r.reason for r in outcome.unresolved] == [REASON_BUDGET_TIME]


def test_budget_from_settings_reads_deployment_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(remote_ref_resolver.settings, "remote_ref_max_refs", 7)
    monkeypatch.setattr(remote_ref_resolver.settings, "remote_ref_max_depth", 2)
    monkeypatch.setattr(remote_ref_resolver.settings, "remote_ref_max_bytes", 999)

    budget = RemoteRefBudget.from_settings()

    assert (budget.max_refs, budget.max_depth, budget.max_bytes) == (7, 2, 999)


# ---------------------------------------------------------------------------
# Content-addressed cache
# ---------------------------------------------------------------------------


def test_re_import_is_served_from_the_cache() -> None:
    fetcher = _Fetcher({MSGS_URL: _doc(Signup={"payload": {"type": "object"}})})
    cache = _cache()

    first = resolve_remote_refs({"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=cache)
    second = resolve_remote_refs({"": _asyncapi_root()}, enabled=True, fetcher=fetcher, cache=cache)

    assert fetcher.calls == [MSGS_URL]  # the second import fetched nothing
    assert second.cache_hits == 1
    assert second.fetched_bytes == 0
    assert first.documents[""] == second.documents[""]
    assert first.resolved[0].digest == second.resolved[0].digest


def test_cache_is_content_addressed_across_urls() -> None:
    body = _doc(Id={"type": "string"})
    cache = _cache()

    cache.put(MSGS_URL, body, json.loads(body))
    cache.put(COMMON_URL, body, json.loads(body))

    first = cache.get(MSGS_URL)
    second = cache.get(COMMON_URL)
    assert first is not None and second is not None
    assert first[0] == second[0]  # same digest…
    assert first[1] is second[1]  # …and one shared parsed document


def test_cache_evicts_least_recently_used() -> None:
    cache = RemoteRefCache(max_entries=2, max_bytes=1_000_000, ttl_seconds=0.0)
    cache.put("https://a.example/1", b"{\"a\":1}", {"a": 1})
    cache.put("https://a.example/2", b"{\"b\":2}", {"b": 2})
    cache.get("https://a.example/1")  # refresh 1, so 2 is now the oldest
    cache.put("https://a.example/3", b"{\"c\":3}", {"c": 3})

    assert len(cache) == 2
    assert cache.get("https://a.example/2") is None
    assert cache.get("https://a.example/1") is not None


def test_cache_honors_its_byte_ceiling() -> None:
    cache = RemoteRefCache(max_entries=10, max_bytes=16, ttl_seconds=0.0)
    cache.put("https://a.example/1", b"x" * 10, {"a": 1})
    cache.put("https://a.example/2", b"y" * 10, {"b": 2})

    assert len(cache) == 1
    assert cache.get("https://a.example/1") is None


def test_cache_entry_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 100.0}
    monkeypatch.setattr(remote_ref_resolver.time, "monotonic", lambda: clock["now"])
    cache = RemoteRefCache(max_entries=4, max_bytes=1_000, ttl_seconds=30.0)
    cache.put(MSGS_URL, b"{}", {})

    clock["now"] += 10.0
    assert cache.get(MSGS_URL) is not None
    clock["now"] += 60.0
    assert cache.get(MSGS_URL) is None


def test_cache_clear_drops_everything() -> None:
    cache = _cache()
    cache.put(MSGS_URL, b"{}", {})
    cache.clear()
    assert len(cache) == 0 and cache.get(MSGS_URL) is None


# ---------------------------------------------------------------------------
# SSRF guard: shape checks up front, address checks on every hop
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ref",
    [
        "file:///etc/passwd#/x",
        "data:application/json,{}",
        "https://user:secret@schemas.example.com/messages.json#/Signup",
    ],
)
def test_disallowed_urls_are_blocked_before_any_fetch(ref: str) -> None:
    fetcher = _Fetcher({})

    outcome = resolve_remote_refs(
        {"": {"x": {"$ref": ref}}}, enabled=True, fetcher=fetcher, cache=_cache()
    )

    assert fetcher.calls == []
    assert [r.reason for r in outcome.unresolved] == [REASON_BLOCKED]
    assert outcome.blocked and outcome.blocked[0].blocked is True


@pytest.mark.parametrize(
    "ref",
    ["urn:uuid:2c8f4b1a-0000-4000-8000-000000000000", "tag:example.com,2026:schema#/X"],
)
def test_identifying_schemes_are_left_alone(ref: str) -> None:
    # A urn:/tag: reference names an identity, not a fetchable location — it is a legitimate
    # JSON Schema construct and must not be reported as a refused external reference.
    outcome = resolve_remote_refs(
        {"": {"x": {"$ref": ref}}}, enabled=True, fetcher=_Fetcher({}), cache=_cache()
    )

    assert outcome.unresolved == () and outcome.resolved == ()
    assert scan_external_refs({"": {"x": {"$ref": ref}}}) == []


def test_blocked_ref_uses_its_own_rule_id() -> None:
    outcome = resolve_remote_refs(
        {"": {"x": {"$ref": "file:///etc/passwd"}}},
        enabled=True,
        fetcher=_Fetcher({}),
        cache=_cache(),
    )

    findings = outcome.findings()
    assert [f.rule for f in findings] == [RULE_BLOCKED_EXTERNAL_REF]
    assert set(f.rule for f in findings) <= set(builtin_rule_ids())


def _mock_transport_client(handler):
    """Patch the resolver's client builder to run the *real* guard over a mock transport."""
    real_builder = remote_ref_resolver.build_guarded_client

    def _build(**kwargs):
        return real_builder(transport=httpx.MockTransport(handler), **kwargs)

    return patch.object(remote_ref_resolver, "build_guarded_client", _build)


def test_http_fetch_refuses_a_redirect_to_an_internal_address() -> None:
    def _resolve(host: str) -> List[str]:
        return ["127.0.0.1"] if host == "internal.example" else ["93.184.216.34"]

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "internal.example":
            return httpx.Response(200, text='{"leaked": true}')
        return httpx.Response(302, headers={"Location": "http://internal.example/secrets"})

    with patch.object(ssrf_guard, "_resolve_host_ips", _resolve):
        with _mock_transport_client(_handler):
            outcome = resolve_remote_refs(
                {"": {"x": {"$ref": "https://public.example/start.json"}}},
                enabled=True,
                cache=_cache(),
            )

    assert [r.reason for r in outcome.unresolved] == [REASON_BLOCKED]
    assert "non-public" in outcome.unresolved[0].detail


def test_http_fetch_reads_a_public_document() -> None:
    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=json.dumps({"Id": {"type": "string"}}))

    with patch.object(ssrf_guard, "_resolve_host_ips", lambda host: ["93.184.216.34"]):
        with _mock_transport_client(_handler):
            outcome = resolve_remote_refs(
                {"": {"x": {"$ref": "https://public.example/common.json#/Id"}}},
                enabled=True,
                cache=_cache(),
            )

    assert outcome.documents[""]["x"] == {"type": "string"}


def test_http_fetch_reports_a_non_2xx_status() -> None:
    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    with patch.object(ssrf_guard, "_resolve_host_ips", lambda host: ["93.184.216.34"]):
        with _mock_transport_client(_handler):
            outcome = resolve_remote_refs(
                {"": {"x": {"$ref": "https://public.example/common.json#/Id"}}},
                enabled=True,
                cache=_cache(),
            )

    assert [r.reason for r in outcome.unresolved] == [REASON_FETCH_FAILED]
    assert "503" in outcome.unresolved[0].detail


def test_http_fetch_stops_reading_an_oversized_body() -> None:
    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="x" * 100_000)

    with patch.object(ssrf_guard, "_resolve_host_ips", lambda host: ["93.184.216.34"]):
        with _mock_transport_client(_handler):
            outcome = resolve_remote_refs(
                {"": {"x": {"$ref": "https://public.example/big.json"}}},
                enabled=True,
                cache=_cache(),
                budget=RemoteRefBudget(max_bytes=1_000),
            )

    assert [r.reason for r in outcome.unresolved] == [REASON_BUDGET_BYTES]


def test_http_fetch_reports_a_transport_error() -> None:
    def _handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with patch.object(ssrf_guard, "_resolve_host_ips", lambda host: ["93.184.216.34"]):
        with _mock_transport_client(_handler):
            outcome = resolve_remote_refs(
                {"": {"x": {"$ref": "https://public.example/x.json"}}},
                enabled=True,
                cache=_cache(),
            )

    assert [r.reason for r in outcome.unresolved] == [REASON_FETCH_FAILED]


# ---------------------------------------------------------------------------
# Reporting caps and lint-report merging
# ---------------------------------------------------------------------------


def test_findings_and_summary_are_capped_but_counts_are_exact() -> None:
    document = {
        f"k{i}": {"$ref": f"https://schemas.example.com/{i}.json#/X"} for i in range(60)
    }

    outcome = resolve_remote_refs({"": document}, enabled=False)
    report = outcome.report()
    findings = outcome.findings()

    assert report["unresolved"] == 60
    assert len(report["refs"]) == 25 and report["refs_truncated"] is True
    assert len(findings) == 26  # 25 itemized + one roll-up
    assert "35 further external $ref(s)" in findings[-1].message


def test_with_extra_findings_rescores_the_report() -> None:
    base = LintReport(
        findings=[
            LintFinding(
                path="Order",
                rule="common.type-missing-description",
                severity="warning",
                message="no description",
                category="documentation",
            )
        ],
        score=95,
        grade="A",
        report_fingerprint="sha256:base",
        rule_hits={"common.type-missing-description": 1},
        severity_counts={"warning": 1},
    )
    extra = resolve_remote_refs({"": _asyncapi_root()}, enabled=False).findings()

    merged = base.with_extra_findings(extra)

    assert len(merged.findings) == 2
    assert merged.rule_hits[RULE_UNRESOLVED_EXTERNAL_REF] == 1
    assert merged.score is not None and merged.score < 95
    assert merged.report_fingerprint != base.report_fingerprint
    # Deterministic: the same merge twice yields the same roll-up.
    assert base.with_extra_findings(extra).report_fingerprint == merged.report_fingerprint


def test_with_extra_findings_is_a_no_op_without_findings() -> None:
    base = LintReport(score=100, grade="A")
    assert base.with_extra_findings([]) is base


def test_with_extra_findings_keeps_an_unscored_report_unscored() -> None:
    base = LintReport()
    extra = resolve_remote_refs({"": _asyncapi_root()}, enabled=False).findings()

    merged = base.with_extra_findings(extra)

    assert merged.score is None
    assert len(merged.findings) == 1
