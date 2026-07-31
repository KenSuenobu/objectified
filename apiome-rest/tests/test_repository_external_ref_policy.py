"""The tenant external ``$ref`` policy itself (REPO-3.9, #2778).

This file covers the *decision*: how a stored mode and allowlist are normalized, which hosts
a pattern covers, what verdict each mode returns, and the two side effects the policy owes
the rest of the system — the audit row a fetch writes and the warning a file carries. The
scan-time wiring that drives all of it lives in ``test_repository_external_ref_scan.py``.

Pure: no database, no network. The one store interaction (:func:`load_tenant_policy`) is
exercised through an injected handle.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pytest

from app.repository_external_ref_policy import (
    DEFAULT_POLICY,
    EXTERNAL_REF_FETCHED_ACTION,
    MAX_WARNING_REFS,
    REASON_ALLOWLIST_EMPTY,
    REASON_HOST_NOT_ALLOWLISTED,
    REASON_INVALID_URL,
    REASON_POLICY_BLOCKED,
    REASON_RESOLUTION_DISABLED,
    REASON_UNSUPPORTED_SCHEME,
    ExternalRefMode,
    ExternalRefPolicy,
    build_gate,
    build_warning,
    decide,
    host_allowed,
    hostname_matches,
    load_tenant_policy,
    normalize_allowlist,
    normalize_mode,
    policy_from_row,
    record_external_ref_fetched,
)


def _policy(mode: ExternalRefMode, *patterns: str) -> ExternalRefPolicy:
    """A policy in ``mode`` with ``patterns`` already normalized."""
    return ExternalRefPolicy(mode=mode, allowlist=tuple(patterns), is_default=False)


class _Ref:
    """Stand-in for an ``UnresolvedRef``: the warning reads by attribute, not by type."""

    def __init__(self, url: str, reason: str = REASON_POLICY_BLOCKED) -> None:
        self.location = "#/components/schemas/Money"
        self.ref = f"{url}#/Money"
        self.url = url
        self.reason = reason
        self.detail = "nothing was fetched"


# --- Mode normalization ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("block", ExternalRefMode.BLOCK),
        ("inline", ExternalRefMode.INLINE),
        ("proxy-fetch", ExternalRefMode.PROXY_FETCH),
        ("  INLINE  ", ExternalRefMode.INLINE),
        ("proxy_fetch", ExternalRefMode.PROXY_FETCH),
    ],
)
def test_a_stored_mode_is_recognized_in_every_reasonable_spelling(raw, expected) -> None:
    assert normalize_mode(raw) is expected


@pytest.mark.parametrize("raw", [None, "", "   ", "allow", "inlin", "yes", 7])
def test_an_unrecognized_mode_falls_back_to_block(raw) -> None:
    """A typo must fail closed: it can never be the thing that switches fetching on."""
    assert normalize_mode(raw) is ExternalRefMode.BLOCK


def test_an_explicit_fallback_is_honoured_for_a_missing_mode() -> None:
    assert normalize_mode(None, fallback=ExternalRefMode.INLINE) is ExternalRefMode.INLINE


# --- Allowlist normalization ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (["schemas.acme.com"], ("schemas.acme.com",)),
        (["  SCHEMAS.Acme.COM  "], ("schemas.acme.com",)),
        (["schemas.acme.com."], ("schemas.acme.com",)),
        (["*.acme.com"], ("*.acme.com",)),
        (["*"], ("*",)),
        (["https://schemas.acme.com/v1/common.json"], ("schemas.acme.com",)),
        (["schemas.acme.com:8443"], ("schemas.acme.com",)),
        (["user:pass@schemas.acme.com"], ("schemas.acme.com",)),
        ("schemas.acme.com, *.acme.io", ("schemas.acme.com", "*.acme.io")),
        (["a.com", "a.com", "A.com"], ("a.com",)),
    ],
)
def test_allowlist_entries_are_reduced_to_bare_hostname_patterns(raw, expected) -> None:
    assert normalize_allowlist(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [None, [], "", ["   "], ["*bad*"], ["a b"], ["oops!"], ["acme.com|evil.io"], 42, {"host": "a.com"}],
)
def test_an_unusable_allowlist_entry_is_dropped_rather_than_stored(raw) -> None:
    """A dud pattern would never match; keeping it would only mislead an operator."""
    assert normalize_allowlist(raw) == ()


def test_one_bad_pattern_does_not_discard_the_good_ones() -> None:
    """Losing the whole list would *widen* an inline tenant — the opposite of intent."""
    assert normalize_allowlist(["*.acme.com", "a b", "acme.io"]) == ("*.acme.com", "acme.io")


# --- Hostname matching ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("host", "pattern", "matches"),
    [
        ("acme.com", "acme.com", True),
        ("ACME.com", "acme.com", True),
        ("acme.com.", "acme.com", True),
        ("acme.com", "*.acme.com", False),
        ("a.acme.com", "*.acme.com", True),
        ("a.b.c.acme.com", "*.acme.com", True),
        ("notacme.com", "*.acme.com", False),
        ("evil-acme.com", "*.acme.com", False),
        ("acme.com.evil.io", "*.acme.com", False),
        ("anything.example", "*", True),
        ("", "*", False),
        ("a.com", "", False),
    ],
)
def test_a_wildcard_pattern_covers_subdomains_but_never_the_apex(host, pattern, matches) -> None:
    assert hostname_matches(host, pattern) is matches


def test_a_suffix_lookalike_host_is_not_a_subdomain() -> None:
    """``evilacme.com`` ends with ``acme.com`` textually; it is not under it."""
    assert not hostname_matches("evilacme.com", "*.acme.com")


def test_host_allowed_is_an_or_across_patterns() -> None:
    allowlist = ("acme.com", "*.acme.io")
    assert host_allowed("acme.com", allowlist)
    assert host_allowed("schemas.acme.io", allowlist)
    assert not host_allowed("acme.dev", allowlist)
    assert not host_allowed("acme.com", ())


# --- Decisions ------------------------------------------------------------------------------


def test_block_is_the_default_and_refuses_everything() -> None:
    assert DEFAULT_POLICY.mode is ExternalRefMode.BLOCK
    assert DEFAULT_POLICY.is_default
    verdict = decide("https://schemas.acme.com/common.json", DEFAULT_POLICY)
    assert not verdict.allowed
    assert verdict.reason == REASON_POLICY_BLOCKED
    assert verdict.host == "schemas.acme.com"


def test_inline_with_no_allowlist_permits_any_public_host() -> None:
    verdict = decide("https://schemas.acme.com/c.json", _policy(ExternalRefMode.INLINE))
    assert verdict.allowed
    assert verdict.reason == "inline"


def test_inline_with_an_allowlist_still_narrows_to_it() -> None:
    """Tightening a tenant must never require a mode change."""
    policy = _policy(ExternalRefMode.INLINE, "*.acme.com")
    assert decide("https://schemas.acme.com/c.json", policy).allowed
    refused = decide("https://cdn.evil.io/c.json", policy)
    assert not refused.allowed
    assert refused.reason == REASON_HOST_NOT_ALLOWLISTED


def test_proxy_fetch_permits_only_allowlisted_hosts() -> None:
    policy = _policy(ExternalRefMode.PROXY_FETCH, "*.acme.com")
    assert decide("https://schemas.acme.com/c.json", policy).allowed
    assert decide("https://acme.com/c.json", policy).reason == REASON_HOST_NOT_ALLOWLISTED


def test_proxy_fetch_with_an_empty_allowlist_fetches_nothing() -> None:
    """Fail closed, with its own reason so a misconfiguration is not read as a block."""
    policy = _policy(ExternalRefMode.PROXY_FETCH)
    assert not policy.fetches
    verdict = decide("https://schemas.acme.com/c.json", policy)
    assert not verdict.allowed
    assert verdict.reason == REASON_ALLOWLIST_EMPTY


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "data:application/json,{}",
        "ftp://acme.com/c.json",
        "gopher://acme.com/c.json",
    ],
)
def test_a_non_http_scheme_is_refused_whatever_the_mode(url) -> None:
    """Reported as an unsupported scheme, not masked as "the tenant turned this off"."""
    verdict = decide(url, _policy(ExternalRefMode.INLINE, "*"))
    assert not verdict.allowed
    assert verdict.reason == REASON_UNSUPPORTED_SCHEME


@pytest.mark.parametrize("url", ["", "   ", "not a url", "https://", "/relative/path.json"])
def test_a_url_with_no_fetchable_host_is_refused(url) -> None:
    verdict = decide(url, _policy(ExternalRefMode.INLINE, "*"))
    assert not verdict.allowed
    assert verdict.reason == REASON_INVALID_URL


def test_the_fetches_property_reflects_whether_anything_could_ever_be_fetched() -> None:
    assert not DEFAULT_POLICY.fetches
    assert _policy(ExternalRefMode.INLINE).fetches
    assert _policy(ExternalRefMode.PROXY_FETCH, "acme.com").fetches
    assert not _policy(ExternalRefMode.PROXY_FETCH).fetches


# --- The resolver gate ----------------------------------------------------------------------


def test_the_gate_returns_none_for_a_permitted_url_and_a_reason_pair_otherwise() -> None:
    gate = build_gate(_policy(ExternalRefMode.PROXY_FETCH, "*.acme.com"))
    assert gate("https://schemas.acme.com/c.json") is None
    refusal = gate("https://cdn.evil.io/c.json")
    assert refusal is not None
    assert refusal[0] == REASON_HOST_NOT_ALLOWLISTED
    assert "allowlist" in refusal[1]


def test_the_deployment_kill_switch_overrides_every_tenant_policy() -> None:
    gate = build_gate(_policy(ExternalRefMode.INLINE, "*"), resolution_allowed=False)
    refusal = gate("https://schemas.acme.com/c.json")
    assert refusal is not None
    assert refusal[0] == REASON_RESOLUTION_DISABLED


def test_the_gate_reports_every_decision_to_an_observer() -> None:
    seen: List[Any] = []
    gate = build_gate(
        _policy(ExternalRefMode.INLINE, "acme.com"),
        on_decision=lambda url, decision: seen.append((url, decision.allowed, decision.reason)),
    )
    gate("https://acme.com/a.json")
    gate("https://evil.io/b.json")
    assert seen == [
        ("https://acme.com/a.json", True, "inline"),
        ("https://evil.io/b.json", False, REASON_HOST_NOT_ALLOWLISTED),
    ]


def test_an_observer_that_raises_cannot_break_the_gate() -> None:
    def boom(url: str, decision: Any) -> None:
        raise RuntimeError("observer exploded")

    gate = build_gate(_policy(ExternalRefMode.INLINE), on_decision=boom)
    assert gate("https://acme.com/a.json") is None


# --- Loading a tenant's policy --------------------------------------------------------------


class _Store:
    """Handle exposing only what :func:`load_tenant_policy` reads."""

    def __init__(self, row: Optional[Dict[str, Any]], error: Optional[Exception] = None) -> None:
        self.row = row
        self.error = error
        self.calls: List[str] = []

    def get_tenant_external_ref_policy(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        self.calls.append(tenant_id)
        if self.error is not None:
            raise self.error
        return self.row


def test_a_stored_row_becomes_a_normalized_policy() -> None:
    store = _Store(
        {
            "repository_external_ref_policy": "proxy-fetch",
            "repository_external_ref_allowlist": ["*.ACME.com", "https://schemas.acme.io/v1"],
        }
    )
    policy = load_tenant_policy("t-1", db=store)
    assert policy.mode is ExternalRefMode.PROXY_FETCH
    assert policy.allowlist == ("*.acme.com", "schemas.acme.io")
    assert not policy.is_default
    assert store.calls == ["t-1"]


def test_a_tenant_with_no_row_gets_the_default() -> None:
    assert load_tenant_policy("t-1", db=_Store(None)) == DEFAULT_POLICY


@pytest.mark.parametrize("tenant_id", [None, ""])
def test_a_missing_tenant_id_never_reaches_the_store(tenant_id) -> None:
    store = _Store({"repository_external_ref_policy": "inline"})
    assert load_tenant_policy(tenant_id, db=store) == DEFAULT_POLICY
    assert store.calls == []


def test_an_unreadable_store_degrades_to_block_rather_than_raising() -> None:
    """A database problem can only ever make the scanner fetch *less*."""
    policy = load_tenant_policy("t-1", db=_Store(None, error=RuntimeError("connection refused")))
    assert policy == DEFAULT_POLICY


def test_policy_from_row_handles_a_missing_row_and_a_junk_allowlist() -> None:
    assert policy_from_row(None) == DEFAULT_POLICY
    policy = policy_from_row(
        {"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": "oops!"}
    )
    assert policy.mode is ExternalRefMode.INLINE
    assert policy.allowlist == ()


# --- The audit row --------------------------------------------------------------------------


class _AuditDb:
    """Captures ``insert_workflow_audit`` calls; optionally fails them."""

    def __init__(self, error: Optional[Exception] = None) -> None:
        self.rows: List[Dict[str, Any]] = []
        self.error = error

    def insert_workflow_audit(
        self, tenant_id, project_id, version_id, action, outcome, actor_id, detail=None
    ) -> None:
        if self.error is not None:
            raise self.error
        self.rows.append(
            {
                "tenant_id": tenant_id,
                "project_id": project_id,
                "version_id": version_id,
                "action": action,
                "outcome": outcome,
                "actor_id": actor_id,
                "detail": detail,
            }
        )


def test_a_fetch_writes_one_audit_row_naming_the_file_and_the_host() -> None:
    db = _AuditDb()
    policy = _policy(ExternalRefMode.PROXY_FETCH, "*.acme.com")

    detail = record_external_ref_fetched(
        db,
        tenant_id="t-1",
        repository_id="r-1",
        branch="main",
        path="api/openapi.yaml",
        url="https://schemas.acme.com/common.json",
        policy=policy,
        digest="sha-1",
        bytes_fetched=2048,
        file_id="f-1",
        actor_id="u-1",
    )

    assert len(db.rows) == 1
    row = db.rows[0]
    assert row["action"] == EXTERNAL_REF_FETCHED_ACTION
    assert row["outcome"] == "success"
    assert row["tenant_id"] == "t-1"
    assert row["actor_id"] == "u-1"
    assert row["detail"] == detail
    assert detail["repositoryId"] == "r-1"
    assert detail["branch"] == "main"
    assert detail["path"] == "api/openapi.yaml"
    assert detail["fileId"] == "f-1"
    assert detail["host"] == "schemas.acme.com"
    assert detail["policy"] == "proxy-fetch"
    assert detail["allowlist"] == ["*.acme.com"]
    assert detail["bytes"] == 2048
    assert detail["digest"] == "sha-1"
    assert detail["cached"] is False


def test_a_cache_hit_is_audited_too_and_says_so() -> None:
    """Cached material entered the model just as surely as downloaded material."""
    db = _AuditDb()
    detail = record_external_ref_fetched(
        db,
        tenant_id="t-1",
        repository_id="r-1",
        branch="main",
        path="a.yaml",
        url="https://schemas.acme.com/c.json",
        policy=_policy(ExternalRefMode.INLINE),
        digest="sha-1",
        bytes_fetched=0,
        from_cache=True,
    )
    assert detail["cached"] is True
    assert detail["bytes"] == 0
    assert "fileId" not in detail
    assert len(db.rows) == 1


def test_an_audit_failure_never_escapes() -> None:
    db = _AuditDb(error=RuntimeError("ledger down"))
    detail = record_external_ref_fetched(
        db,
        tenant_id="t-1",
        repository_id="r-1",
        branch="main",
        path="a.yaml",
        url="https://acme.com/c.json",
        policy=_policy(ExternalRefMode.INLINE),
    )
    assert detail["url"] == "https://acme.com/c.json"


# --- The file warning -----------------------------------------------------------------------


def test_nothing_unresolved_yields_no_warning_which_is_what_clears_a_stale_one() -> None:
    assert build_warning(DEFAULT_POLICY, []) is None
    assert build_warning(DEFAULT_POLICY, ()) is None


def test_the_warning_names_the_policy_and_itemizes_every_unresolved_reference() -> None:
    stamp = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)
    warning = build_warning(
        DEFAULT_POLICY,
        [_Ref("https://schemas.acme.com/a.json"), _Ref("https://schemas.acme.com/b.json")],
        recorded_at=stamp,
    )

    assert warning is not None
    assert warning["policy"] == "block"
    assert warning["recorded_at"] == "2026-07-31T12:00:00+00:00"
    assert warning["unresolved_count"] == 2
    assert warning["truncated"] is False
    assert [entry["url"] for entry in warning["unresolved"]] == [
        "https://schemas.acme.com/a.json",
        "https://schemas.acme.com/b.json",
    ]
    assert warning["unresolved"][0]["reason"] == REASON_POLICY_BLOCKED
    assert warning["unresolved"][0]["location"] == "#/components/schemas/Money"


def test_a_pathological_document_reports_an_exact_count_but_a_capped_list() -> None:
    refs = [_Ref(f"https://schemas.acme.com/{n}.json") for n in range(MAX_WARNING_REFS + 10)]
    warning = build_warning(DEFAULT_POLICY, refs)

    assert warning is not None
    assert warning["unresolved_count"] == MAX_WARNING_REFS + 10
    assert warning["truncated"] is True
    assert len(warning["unresolved"]) == MAX_WARNING_REFS


def test_the_warning_records_the_allowlist_that_applied() -> None:
    warning = build_warning(
        _policy(ExternalRefMode.PROXY_FETCH, "*.acme.com"),
        [_Ref("https://cdn.evil.io/a.json", reason=REASON_HOST_NOT_ALLOWLISTED)],
    )
    assert warning is not None
    assert warning["policy"] == "proxy-fetch"
    assert warning["allowlist"] == ["*.acme.com"]
