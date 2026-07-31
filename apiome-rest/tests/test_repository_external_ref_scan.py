"""Scan-time enforcement of the external ``$ref`` policy (REPO-3.9, #2778).

The policy decision itself is covered in ``test_repository_external_ref_policy.py``. This
file covers what the scanner *does* with it, which is where the ticket's acceptance criteria
live:

* the policy is enforced inside the shared resolver, through its per-URL gate — so ``block``
  never opens a socket, and a document already in the resolver's cache cannot slip past;
* ``inline`` / ``proxy-fetch`` snapshot what they fetch into the scanned document, and every
  reference obtained writes one ``repository.external_ref_fetched`` audit row;
* ``block`` attaches a ``repository_file`` warning listing the unresolved references, and a
  file that stops referencing anything external has its stale warning cleared; and
* nothing here — a store fault, an audit fault, a resolver fault — can fail a scan.

No network: the resolver's fetcher is substituted throughout, and the one test that asserts
"nothing was fetched" proves it by giving the resolver a fetcher that raises.
"""

import json
from typing import Any, Dict, List, Optional

import pytest

from app.remote_ref_resolver import RemoteRefBudget, RemoteRefCache
from app.repository_external_ref_policy import (
    EXTERNAL_REF_FETCHED_ACTION,
    REASON_ALLOWLIST_EMPTY,
    REASON_HOST_NOT_ALLOWLISTED,
    REASON_POLICY_BLOCKED,
    REASON_RESOLUTION_DISABLED,
    ExternalRefMode,
    ExternalRefPolicy,
)
from app.repository_external_ref_scan import (
    apply_external_ref_policy,
    apply_policy_to_document_text,
)

_MONEY = json.dumps({"Money": {"type": "object", "properties": {"amount": {"type": "number"}}}})

_SPEC_TEXT = """
openapi: 3.0.3
info:
  title: Widget API
  version: 1.0.0
paths: {}
components:
  schemas:
    Price:
      $ref: "https://schemas.acme.com/common.json#/Money"
"""


def _documents(url: str = "https://schemas.acme.com/common.json#/Money") -> Dict[str, Any]:
    """One parsed document carrying a single external reference."""
    return {"": {"components": {"schemas": {"Price": {"$ref": url}}}}}


def _policy(mode: ExternalRefMode, *patterns: str) -> ExternalRefPolicy:
    return ExternalRefPolicy(mode=mode, allowlist=tuple(patterns), is_default=False)


class FakeDb:
    """Stand-in for :class:`app.database.Database` on this module's call surface."""

    def __init__(
        self,
        row: Optional[Dict[str, Any]] = None,
        *,
        warning_error: Optional[Exception] = None,
        audit_error: Optional[Exception] = None,
    ) -> None:
        self.row = row
        self.warning_error = warning_error
        self.audit_error = audit_error
        self.audits: List[Dict[str, Any]] = []
        self.warnings: List[Any] = []

    def get_tenant_external_ref_policy(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        return self.row

    def insert_workflow_audit(
        self, tenant_id, project_id, version_id, action, outcome, actor_id, detail=None
    ) -> None:
        if self.audit_error is not None:
            raise self.audit_error
        self.audits.append({"action": action, "tenant_id": tenant_id, "detail": detail})

    def set_repository_file_external_ref_warning(self, file_id: str, warning) -> int:
        if self.warning_error is not None:
            raise self.warning_error
        self.warnings.append(warning)
        return 1


def _fetcher(payload: str = _MONEY):
    """A fetcher returning ``payload`` and logging every URL it was asked for."""
    calls: List[str] = []

    def fetch(url: str, *, max_bytes: int, timeout: float) -> bytes:
        calls.append(url)
        return payload.encode("utf-8")

    return fetch, calls


def _exploding_fetcher():
    """A fetcher that fails the test if it is ever called."""

    def fetch(url: str, *, max_bytes: int, timeout: float) -> bytes:  # pragma: no cover
        raise AssertionError(f"the policy allowed a fetch it should have refused: {url}")

    return fetch


def _apply(db: FakeDb, **overrides: Any):
    """Run the policy over the standard one-reference document."""
    kwargs: Dict[str, Any] = {
        "tenant_id": "t-1",
        "repository_id": "r-1",
        "branch": "main",
        "path": "api/openapi.yaml",
        "documents": _documents(),
        "file_id": "f-1",
        "cache": RemoteRefCache(),
    }
    kwargs.update(overrides)
    return apply_external_ref_policy(db, **kwargs)


# --- block: the default ---------------------------------------------------------------------


def test_block_fetches_nothing_and_records_why() -> None:
    db = FakeDb()  # no stored row -> the fail-closed default

    outcome = _apply(db, fetcher=_exploding_fetcher())

    assert outcome.policy.mode is ExternalRefMode.BLOCK
    assert outcome.resolved_count == 0
    assert outcome.unresolved_count == 1
    assert outcome.audited_count == 0
    assert not outcome.changed
    assert db.audits == []


def test_block_attaches_a_file_warning_listing_the_unresolved_refs() -> None:
    db = FakeDb()

    outcome = _apply(db, fetcher=_exploding_fetcher())

    assert db.warnings == [outcome.warning]
    warning = outcome.warning
    assert warning is not None
    assert warning["policy"] == "block"
    assert warning["unresolved_count"] == 1
    assert warning["unresolved"][0]["url"] == "https://schemas.acme.com/common.json"
    assert warning["unresolved"][0]["reason"] == REASON_POLICY_BLOCKED
    assert warning["unresolved"][0]["location"] == "#/components/schemas/Price"


def test_block_leaves_the_document_exactly_as_it_was() -> None:
    db = FakeDb()
    documents = _documents()

    outcome = _apply(db, documents=documents, fetcher=_exploding_fetcher())

    assert outcome.documents[""] == documents[""]
    assert outcome.changed_documents == ()


# --- inline: snapshot at scan time ------------------------------------------------------------


def test_inline_fetches_the_reference_and_snapshots_it_into_the_document() -> None:
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, calls = _fetcher()

    outcome = _apply(db, fetcher=fetch)

    assert calls == ["https://schemas.acme.com/common.json"]
    assert outcome.resolved_count == 1
    assert outcome.unresolved_count == 0
    assert outcome.changed
    price = outcome.documents[""]["components"]["schemas"]["Price"]
    assert price == {"type": "object", "properties": {"amount": {"type": "number"}}}


def test_a_fully_resolved_file_has_its_warning_cleared() -> None:
    """A warning that outlives the thing it warned about is worse than no warning."""
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, _ = _fetcher()

    outcome = _apply(db, fetcher=fetch)

    assert outcome.warning is None
    assert db.warnings == [None]


def test_every_fetch_writes_one_external_ref_fetched_audit_row() -> None:
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, _ = _fetcher()

    outcome = _apply(db, fetcher=fetch, actor_id="u-1", project_id="p-1")

    assert outcome.audited_count == 1
    assert len(db.audits) == 1
    audit = db.audits[0]
    assert audit["action"] == EXTERNAL_REF_FETCHED_ACTION
    assert audit["tenant_id"] == "t-1"
    assert audit["detail"]["url"] == "https://schemas.acme.com/common.json"
    assert audit["detail"]["host"] == "schemas.acme.com"
    assert audit["detail"]["policy"] == "inline"
    assert audit["detail"]["path"] == "api/openapi.yaml"
    assert audit["detail"]["fileId"] == "f-1"
    assert audit["detail"]["cached"] is False


def test_a_cached_document_is_audited_and_still_passes_the_gate() -> None:
    """Second scan, one download: the audit still records that the material was used."""
    cache = RemoteRefCache()
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, calls = _fetcher()

    _apply(db, fetcher=fetch, cache=cache)
    _apply(db, fetcher=fetch, cache=cache)

    assert calls == ["https://schemas.acme.com/common.json"]  # fetched once
    assert len(db.audits) == 2  # audited twice
    assert db.audits[1]["detail"]["cached"] is True
    assert db.audits[1]["detail"]["bytes"] == 0


def test_a_cached_document_cannot_slip_past_a_blocking_policy() -> None:
    """The gate runs before the cache — the leak this ticket exists to close."""
    cache = RemoteRefCache()
    allowed = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, _ = _fetcher()
    _apply(allowed, fetcher=fetch, cache=cache)

    blocked = FakeDb()  # a different tenant, on the default block policy
    outcome = _apply(blocked, tenant_id="t-2", fetcher=_exploding_fetcher(), cache=cache)

    assert outcome.resolved_count == 0
    assert outcome.unresolved_count == 1
    assert blocked.audits == []


# --- proxy-fetch: allowlisted hosts only --------------------------------------------------------


def test_proxy_fetch_resolves_an_allowlisted_host() -> None:
    db = FakeDb(
        {
            "repository_external_ref_policy": "proxy-fetch",
            "repository_external_ref_allowlist": ["*.acme.com"],
        }
    )
    fetch, calls = _fetcher()

    outcome = _apply(db, fetcher=fetch)

    assert calls == ["https://schemas.acme.com/common.json"]
    assert outcome.resolved_count == 1
    assert outcome.warning is None


def test_proxy_fetch_refuses_a_host_that_is_not_allowlisted() -> None:
    db = FakeDb(
        {
            "repository_external_ref_policy": "proxy-fetch",
            "repository_external_ref_allowlist": ["*.acme.com"],
        }
    )

    outcome = _apply(
        db,
        documents=_documents("https://cdn.evil.io/common.json#/Money"),
        fetcher=_exploding_fetcher(),
    )

    assert outcome.resolved_count == 0
    assert outcome.warning is not None
    assert outcome.warning["unresolved"][0]["reason"] == REASON_HOST_NOT_ALLOWLISTED
    assert outcome.warning["allowlist"] == ["*.acme.com"]
    assert db.audits == []


def test_proxy_fetch_with_an_empty_allowlist_fetches_nothing() -> None:
    db = FakeDb(
        {"repository_external_ref_policy": "proxy-fetch", "repository_external_ref_allowlist": []}
    )

    outcome = _apply(db, fetcher=_exploding_fetcher())

    assert outcome.resolved_count == 0
    assert outcome.warning is not None
    assert outcome.warning["unresolved"][0]["reason"] == REASON_ALLOWLIST_EMPTY


def test_a_mixed_document_resolves_what_it_may_and_warns_about_the_rest() -> None:
    db = FakeDb(
        {
            "repository_external_ref_policy": "proxy-fetch",
            "repository_external_ref_allowlist": ["*.acme.com"],
        }
    )
    fetch, calls = _fetcher()
    documents = {
        "": {
            "components": {
                "schemas": {
                    "Price": {"$ref": "https://schemas.acme.com/common.json#/Money"},
                    "Other": {"$ref": "https://cdn.evil.io/common.json#/Money"},
                }
            }
        }
    }

    outcome = _apply(db, documents=documents, fetcher=fetch)

    assert calls == ["https://schemas.acme.com/common.json"]
    assert outcome.resolved_count == 1
    assert outcome.unresolved_count == 1
    assert outcome.audited_count == 1
    assert outcome.warning is not None
    assert outcome.warning["unresolved"][0]["url"] == "https://cdn.evil.io/common.json"


# --- The deployment kill switch -----------------------------------------------------------------


def test_the_operator_kill_switch_overrides_a_permissive_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import repository_external_ref_scan as scan

    monkeypatch.setattr(scan.settings, "remote_ref_resolution_allowed", False)
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": ["*"]})

    outcome = _apply(db, fetcher=_exploding_fetcher())

    assert outcome.resolved_count == 0
    assert outcome.warning is not None
    assert outcome.warning["unresolved"][0]["reason"] == REASON_RESOLUTION_DISABLED
    assert db.audits == []


# --- Documents with nothing to do ----------------------------------------------------------------


def test_a_document_with_no_external_refs_costs_nothing_and_clears_any_warning() -> None:
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})

    outcome = _apply(
        db,
        documents={"": {"components": {"schemas": {"Price": {"$ref": "#/components/schemas/Money"}}}}},
        fetcher=_exploding_fetcher(),
    )

    assert outcome.skipped_reason == "no-refs"
    assert outcome.warning is None
    assert db.warnings == [None]


def test_an_empty_document_set_is_a_no_op() -> None:
    db = FakeDb()
    outcome = apply_external_ref_policy(
        db,
        tenant_id="t-1",
        repository_id="r-1",
        branch="main",
        path="a.yaml",
        documents={},
    )
    assert outcome.skipped_reason == "no-documents"
    assert db.warnings == []


# --- Nothing may fail a scan -----------------------------------------------------------------------


def test_a_warning_write_failure_never_escapes() -> None:
    db = FakeDb(warning_error=RuntimeError("write failed"))

    outcome = _apply(db, fetcher=_exploding_fetcher())

    assert outcome.unresolved_count == 1
    assert outcome.warning is not None


def test_an_audit_failure_never_escapes_and_the_reference_still_resolves() -> None:
    db = FakeDb(
        {"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []},
        audit_error=RuntimeError("ledger down"),
    )
    fetch, _ = _fetcher()

    outcome = _apply(db, fetcher=fetch)

    assert outcome.resolved_count == 1
    assert outcome.changed


def test_a_resolver_fault_degrades_to_leaving_the_document_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import remote_ref_resolver

    def boom(*args: Any, **kwargs: Any):
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr(remote_ref_resolver, "resolve_remote_refs", boom)
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    documents = _documents()

    outcome = apply_external_ref_policy(
        db,
        tenant_id="t-1",
        repository_id="r-1",
        branch="main",
        path="a.yaml",
        documents=documents,
        file_id="f-1",
    )

    assert outcome.skipped_reason == "error"
    assert outcome.documents[""] == documents[""]


def test_an_unreadable_policy_falls_back_to_block() -> None:
    class Broken(FakeDb):
        def get_tenant_external_ref_policy(self, tenant_id: str):
            raise RuntimeError("connection refused")

    db = Broken()
    outcome = _apply(db, fetcher=_exploding_fetcher())

    assert outcome.policy.mode is ExternalRefMode.BLOCK
    assert outcome.unresolved_count == 1


def test_persist_warning_false_computes_the_warning_without_touching_the_store() -> None:
    db = FakeDb()
    outcome = _apply(db, fetcher=_exploding_fetcher(), persist_warning=False)
    assert outcome.warning is not None
    assert db.warnings == []


# --- The text wrapper the scanner uses -------------------------------------------------------------


def _apply_text(db: FakeDb, text: str = _SPEC_TEXT, **overrides: Any):
    kwargs: Dict[str, Any] = {
        "tenant_id": "t-1",
        "repository_id": "r-1",
        "branch": "main",
        "path": "api/openapi.yaml",
        "text": text,
        "file_id": "f-1",
        "cache": RemoteRefCache(),
    }
    kwargs.update(overrides)
    return apply_policy_to_document_text(db, **kwargs)


def test_the_text_wrapper_returns_the_original_text_under_block() -> None:
    db = FakeDb()

    text, outcome = _apply_text(db, fetcher=_exploding_fetcher())

    assert text == _SPEC_TEXT
    assert outcome.warning is not None
    assert outcome.warning["policy"] == "block"


def test_the_text_wrapper_returns_the_snapshot_under_inline() -> None:
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, _ = _fetcher()

    text, outcome = _apply_text(db, fetcher=fetch)

    assert text != _SPEC_TEXT
    assert outcome.changed
    snapshot = json.loads(text)
    assert snapshot["components"]["schemas"]["Price"]["properties"]["amount"] == {"type": "number"}
    # The rest of the document survives the round-trip untouched.
    assert snapshot["info"]["title"] == "Widget API"


@pytest.mark.parametrize("text", ["", "   ", "\n"])
def test_the_text_wrapper_ignores_an_empty_file(text) -> None:
    db = FakeDb()
    out, outcome = _apply_text(db, text=text)
    assert out == text
    assert outcome.skipped_reason == "no-documents"


def test_the_text_wrapper_leaves_an_unparseable_file_to_the_scoring_engine() -> None:
    db = FakeDb()
    text = "\tthis: is: not: yaml: [unclosed"

    out, outcome = _apply_text(db, text=text)

    assert out == text
    assert outcome.skipped_reason == "no-documents"
    assert db.warnings == []


def test_the_resolver_budget_is_honoured_end_to_end() -> None:
    """A ceiling of zero references means nothing is inlined, and the file is warned."""
    db = FakeDb({"repository_external_ref_policy": "inline", "repository_external_ref_allowlist": []})
    fetch, calls = _fetcher()

    outcome = _apply(db, fetcher=fetch, budget=RemoteRefBudget(max_refs=0))

    assert calls == []
    assert outcome.resolved_count == 0
    assert outcome.warning is not None


# --- The store surface the policy reads and writes ---------------------------------------------


class _RecordingDatabase:
    """A :class:`app.database.Database` with its two SQL entry points recorded.

    Built with ``__new__`` so no connection is opened; the accessors under test are pure query
    builders above ``execute_query`` / ``_execute_write``.
    """

    @staticmethod
    def build():
        from app.database import Database

        db = Database.__new__(Database)
        db.queries = []  # type: ignore[attr-defined]
        db.writes = []  # type: ignore[attr-defined]

        def _execute_query(query: str, params: tuple = None):
            db.queries.append((query, params))  # type: ignore[attr-defined]
            return []

        def _execute_write(query: str, params: tuple = None) -> int:
            db.writes.append((query, params))  # type: ignore[attr-defined]
            return 1

        db.execute_query = _execute_query  # type: ignore[assignment]
        db._execute_write = _execute_write  # type: ignore[assignment]
        return db


def test_the_policy_read_is_tenant_scoped_and_skips_deleted_tenants() -> None:
    db = _RecordingDatabase.build()
    assert db.get_tenant_external_ref_policy("t-1") is None

    query, params = db.queries[0]
    assert "repository_external_ref_policy" in query
    assert "repository_external_ref_allowlist" in query
    assert "deleted_at IS NULL" in query
    assert params == ("t-1",)


@pytest.mark.parametrize("mode", ["block", "inline", "proxy-fetch", "PROXY_FETCH"])
def test_the_policy_write_accepts_the_documented_modes(mode) -> None:
    db = _RecordingDatabase.build()
    assert db.set_tenant_external_ref_policy("t-1", policy=mode, allowlist=["*.acme.com", "  "])

    query, params = db.writes[0]
    assert "UPDATE apiome.tenants" in query
    assert params[0] == mode.lower().replace("_", "-")
    assert json.loads(params[1]) == ["*.acme.com"]
    assert params[2] == "t-1"


@pytest.mark.parametrize("mode", ["", "allow", "off", None])
def test_the_policy_write_rejects_an_unknown_mode_at_the_call_site(mode) -> None:
    db = _RecordingDatabase.build()
    with pytest.raises(ValueError):
        db.set_tenant_external_ref_policy("t-1", policy=mode)
    assert db.writes == []


def test_clearing_a_warning_writes_sql_null_not_the_string_null() -> None:
    db = _RecordingDatabase.build()
    db.set_repository_file_external_ref_warning("f-1", None)

    query, params = db.writes[0]
    assert "UPDATE apiome.tenant_repository_files" in query
    assert "external_ref_warning = %s::jsonb" in query
    assert params == (None, "f-1")


def test_a_warning_is_written_as_json() -> None:
    db = _RecordingDatabase.build()
    db.set_repository_file_external_ref_warning("f-1", {"policy": "block", "unresolved_count": 2})

    _query, params = db.writes[0]
    assert json.loads(params[0]) == {"policy": "block", "unresolved_count": 2}


def test_the_files_listing_page_selects_the_warning_column() -> None:
    """The Files tab can only show what the page query selects."""
    import inspect

    from app.database import Database

    source = inspect.getsource(Database.tenant_repository_files_stats_and_page)
    assert "f.external_ref_warning" in source


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        ({"policy": "block", "unresolved_count": 3}, ("block", 3)),
        ('{"policy": "inline", "unresolved_count": 1}', ("inline", 1)),
        (None, (None, None)),
        ("not json", (None, None)),
        ([], (None, None)),
        ({"policy": "block"}, ("block", None)),
        ({"unresolved_count": -1, "policy": "block"}, ("block", None)),
    ],
)
def test_the_listing_summary_degrades_rather_than_failing_the_page(stored, expected) -> None:
    from app.tenant_repositories_routes import _external_ref_summary

    assert _external_ref_summary(stored) == expected
