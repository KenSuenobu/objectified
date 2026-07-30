"""Preview control-plane persistence — APX-3.3 (private-suite#2458).

Drives :mod:`app.slate_git_preview_store` against a scripted fake connection, the same instinct
as ``test_slate_activation``: what needs pinning is the *shape* of the statements the store
issues — that a redelivered event writes no second build, that a new event seals the lane and
build together, that the branch alias is touched only when checks pass, that a retry increments
and audits, and that a secret and token are sealed (never stored as plaintext) before the write.

The database-enforced guarantees these statements rely on — the ``UNIQUE (connection_id,
source_digest)`` idempotency constraint, the immutability trigger on the commit URL, the
append-only status/audit triggers and the ``CHECK (NOT build_dispatched)`` boundary — are pinned
structurally in ``test_slate_git_preview_migration.py`` and were confirmed to fire against a live
Postgres during development.

The fake here consumes a scripted result only on a *fetch*, so an interleaved no-fetch INSERT
never shifts the queue — a small robustness improvement over the positional fake so the branchy
transactions below stay legible.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence

import pytest

import app.slate_git_preview_store as store
from app.slate_git_preview import ParsedGitEvent

COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"
DIGEST = "sha256:" + "d" * 64


class FakeCursor:
    def __init__(self, conn: "FakeConnection"):
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self.conn._next()

    def fetchall(self) -> List[Dict[str, Any]]:
        value = self.conn._next()
        if isinstance(value, list):
            return value
        return [] if value is None else [value]

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeConnection:
    """A psycopg2-shaped connection whose fetches replay a scripted result queue in order."""

    def __init__(self, results: Optional[List[Any]] = None):
        self.results = list(results or [])
        self.statements: List[tuple] = []
        self.commits = 0
        self.rollbacks = 0

    def _next(self) -> Any:
        return self.results.pop(0) if self.results else None

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakeDb:
    def __init__(self, conn: FakeConnection):
        self._conn = conn

    def connect(self) -> FakeConnection:
        return self._conn


def statements_matching(conn: FakeConnection, pattern: str) -> List[tuple]:
    return [s for s in conn.statements if re.search(pattern, s[0], re.IGNORECASE)]


def connection_row(**overrides) -> Dict[str, Any]:
    base = {
        "id": "conn-1",
        "tenant_id": "t1",
        "site_id": "site-1",
        "provider": "github",
        "repo_owner": "acme",
        "repo_name": "docs",
        "repo_full_name": "acme/docs",
        "default_branch": "main",
        "preview_host": "previews.apiome.dev",
    }
    return {**base, **overrides}


def push_event(**overrides) -> ParsedGitEvent:
    base = dict(
        repo_full_name="acme/docs",
        branch="main",
        commit=COMMIT,
        message="Document invoices",
        changed_files_added=("docs/paths/invoices.md",),
        changed_files_modified=(),
        changed_files_removed=(),
    )
    return ParsedGitEvent(**{**base, **overrides})


# ─── Connection sealing ──────────────────────────────────────────────────────


class TestConnectionSealing:
    def test_the_secret_and_token_are_sealed_before_the_write(self, monkeypatch):
        # The secret goes through Fernet, the token through the envelope sealer. We assert the
        # bytes written are the sealed values, never the plaintext.
        monkeypatch.setattr(store, "encrypt_signing_secret", lambda plain: b"SEALED_SECRET")
        monkeypatch.setattr(store, "credential_encryption_configured", lambda: True)
        monkeypatch.setattr(store, "seal_credential_payload", lambda payload: (b"SEALED_TOKEN", 2))

        conn = FakeConnection(results=[{"id": "conn-1", "has_webhook_secret": True, "has_token": True}])
        store.upsert_connection(
            FakeDb(conn),
            tenant_id="t1",
            site_id="site-1",
            repo_owner="acme",
            repo_name="Docs",
            default_branch="main",
            preview_host="previews.apiome.dev",
            webhook_secret="plain-secret",
            token="ghp_plaintext",
        )
        insert = statements_matching(conn, "INSERT INTO apiome.slate_git_connections")[0]
        query, params = insert
        assert "ON CONFLICT" in query
        assert b"SEALED_SECRET" in params
        assert b"SEALED_TOKEN" in params
        assert 2 in params  # the key version
        # The plaintext never appears in the statement parameters.
        assert "plain-secret" not in params
        assert "ghp_plaintext" not in params
        # repo_full_name is lowercased.
        assert "acme/docs" in params

    def test_no_token_when_encryption_is_unconfigured(self, monkeypatch):
        monkeypatch.setattr(store, "encrypt_signing_secret", lambda plain: b"SEALED_SECRET")
        monkeypatch.setattr(store, "credential_encryption_configured", lambda: False)
        called = {"sealed": False}
        monkeypatch.setattr(
            store,
            "seal_credential_payload",
            lambda payload: called.__setitem__("sealed", True) or (b"x", 1),
        )
        conn = FakeConnection(results=[{"id": "conn-1"}])
        store.upsert_connection(
            FakeDb(conn),
            tenant_id="t1",
            site_id="site-1",
            repo_owner="acme",
            repo_name="docs",
            default_branch="main",
            preview_host="host",
            webhook_secret="s",
            token="ghp_plaintext",
        )
        assert called["sealed"] is False  # sealing is not attempted when unconfigured
        _, params = statements_matching(conn, "INSERT INTO apiome.slate_git_connections")[0]
        assert None in params  # token_ciphertext stored NULL


class TestConnectionReadsHideSecrets:
    def test_the_public_projection_never_selects_the_secret_or_token(self):
        conn = FakeConnection(results=[[connection_row()]])
        store.list_connections(FakeDb(conn), tenant_id="t1")
        select = statements_matching(conn, "FROM apiome.slate_git_connections")[0][0]
        # Only the derived booleans leave; the ciphertext columns are never returned as values.
        assert "IS NOT NULL) AS has_webhook_secret" in select
        assert "IS NOT NULL) AS has_token" in select
        assert re.search(r"SELECT\s+webhook_secret_enc", select) is None
        assert re.search(r",\s*token_ciphertext\b", select) is None

    def test_the_receiver_lookup_returns_the_encrypted_secret(self):
        conn = FakeConnection(results=[[connection_row(webhook_secret_enc=b"SEALED")]])
        rows = store.find_connections_by_repo(
            FakeDb(conn), provider="github", repo_full_name="Acme/Docs"
        )
        select = statements_matching(conn, "FROM apiome.slate_git_connections")[0]
        assert "webhook_secret_enc" in select[0]
        assert "acme/docs" in select[1]  # lookup lowercases
        assert rows[0]["webhook_secret_enc"] == b"SEALED"


# ─── Ingestion (one preview per source digest) ────────────────────────────────


class TestIngestion:
    def test_a_redelivered_event_creates_no_second_build(self):
        existing = {"id": "prev-1", "source_ref": "main", "connection_id": "conn-1"}
        conn = FakeConnection(results=[existing])
        build, created = store.ingest_preview_event(
            FakeDb(conn), connection_row(), push_event(), delivery_id="d-2", ttl_hours=168
        )
        assert created is False
        assert build["id"] == "prev-1"
        # No build INSERT — the only write is the redelivery audit trail.
        assert statements_matching(conn, "INSERT INTO apiome.slate_preview_builds") == []
        audit = statements_matching(conn, "INSERT INTO apiome.slate_preview_audit")
        assert len(audit) == 1
        assert "Redelivered" in audit[0][0] or "d-2" in str(audit[0][1])

    def test_a_new_event_seals_the_lane_and_build_and_changed_pages(self):
        # Scripted fetches in order: existing(None), site slug, lane id, build row.
        build_row = {"id": "prev-9", "source_ref": "main"}
        conn = FakeConnection(
            results=[None, {"slug": "acme-docs"}, {"id": "lane-1"}, build_row]
        )
        build, created = store.ingest_preview_event(
            FakeDb(conn), connection_row(), push_event(), delivery_id="d-1", ttl_hours=168
        )
        assert created is True
        assert build["id"] == "prev-9"

        # The build INSERT is idempotent at the database level.
        build_insert = statements_matching(conn, "INSERT INTO apiome.slate_preview_builds")[0]
        assert "ON CONFLICT (connection_id, source_digest) DO NOTHING" in build_insert[0]
        assert COMMIT in build_insert[1]

        # A preview lane was created (robots-excluded preview environment).
        lane_insert = statements_matching(conn, "INSERT INTO apiome.slate_environments")[0]
        assert "'preview'" in lane_insert[0]

        # The changed page carries a deep link into the immutable URL.
        page_insert = statements_matching(conn, "INSERT INTO apiome.slate_preview_changed_pages")[0]
        assert any("commit/" in str(p) and "/paths/invoices" in str(p) for p in page_insert[1])

        # A first pending provider status is recorded.
        status_insert = statements_matching(
            conn, "INSERT INTO apiome.slate_provider_status_deliveries"
        )[0]
        assert "pending" in str(status_insert[1])

    def test_a_lost_idempotency_race_returns_the_winning_row(self):
        # existing(None) then the build INSERT ... DO NOTHING returns nothing (a concurrent
        # delivery won); the store rolls back and re-selects the winner.
        winner = {"id": "prev-win", "source_ref": "main"}
        conn = FakeConnection(
            results=[None, {"slug": "s"}, {"id": "lane-1"}, None, winner]
        )
        build, created = store.ingest_preview_event(
            FakeDb(conn), connection_row(), push_event(), delivery_id="d", ttl_hours=1
        )
        assert created is False
        assert build["id"] == "prev-win"
        assert conn.rollbacks >= 1


# ─── Checks and alias advance ─────────────────────────────────────────────────


class TestChecks:
    def _build_join(self, **overrides):
        base = {
            "id": "prev-1",
            "tenant_id": "t1",
            "connection_id": "conn-1",
            "site_id": "site-1",
            "source_ref": "main",
            "source_commit": COMMIT,
            "status": "queued",
            "checks_state": "pending",
            "immutable_url": "https://p/acme-docs/commit/a1b2c3d4e5f6",
            "cleaned_up_at": None,
            "preview_host": "previews.apiome.dev",
            "site_slug": "acme-docs",
        }
        return {**base, **overrides}

    def test_passing_checks_advance_the_branch_alias(self):
        # record_checks fetches: build-join, changed-pages; then get_preview fetches:
        # build, changed-pages, alias.
        conn = FakeConnection(
            results=[
                self._build_join(),  # build-join in record_checks
                [],                  # changed pages in record_checks
                self._build_join(checks_state="passed"),  # get_preview build
                [],                  # get_preview changed pages
                {"alias_url": "https://p/acme-docs/branch/main"},  # get_preview alias
            ]
        )
        result = store.record_checks(
            FakeDb(conn), tenant_id="t1", build_id="prev-1", passed=True
        )
        alias = statements_matching(conn, "INSERT INTO apiome.slate_branch_aliases")
        assert len(alias) == 1
        assert "routing_version + 1" in alias[0][0]
        # A success status was recorded.
        status = statements_matching(conn, "INSERT INTO apiome.slate_provider_status_deliveries")
        assert "success" in str(status[0][1])
        assert result["alias_url"] == "https://p/acme-docs/branch/main"

    def test_failing_checks_never_touch_the_alias(self):
        conn = FakeConnection(
            results=[
                self._build_join(),  # build-join
                [],                  # changed pages
                self._build_join(checks_state="failed"),  # get_preview build
                [],                  # get_preview changed pages
                None,                # get_preview alias (none)
            ]
        )
        store.record_checks(
            FakeDb(conn),
            tenant_id="t1",
            build_id="prev-1",
            passed=False,
            failure_evidence={"reason": "link check failed"},
        )
        assert statements_matching(conn, "INSERT INTO apiome.slate_branch_aliases") == []
        # The build's checks_state is set to failed with its evidence.
        update = statements_matching(conn, "UPDATE apiome.slate_preview_builds")[0]
        assert "failed" in str(update[1])
        status = statements_matching(conn, "INSERT INTO apiome.slate_provider_status_deliveries")
        assert "failure" in str(status[0][1])

    def test_an_unknown_preview_is_refused(self):
        conn = FakeConnection(results=[None])
        with pytest.raises(store.SlatePreviewStoreError) as exc:
            store.record_checks(FakeDb(conn), tenant_id="t1", build_id="nope", passed=True)
        assert exc.value.code == "preview_not_found"


# ─── Retry and cleanup (audited) ──────────────────────────────────────────────


class TestRetryAndCleanup:
    def test_a_retry_increments_the_counter_and_audits(self):
        conn = FakeConnection(results=[{"id": "prev-1", "retry_count": 2}])
        store.retry_build(FakeDb(conn), tenant_id="t1", build_id="prev-1", actor_name="dana")
        update = statements_matching(conn, "UPDATE apiome.slate_preview_builds")[0][0]
        assert "retry_count = retry_count + 1" in update
        assert "checks_state = 'pending'" in update
        audit = statements_matching(conn, "INSERT INTO apiome.slate_preview_audit")
        assert len(audit) == 1
        assert "retry" in str(audit[0][1]).lower()

    def test_a_retry_on_an_unknown_preview_is_refused(self):
        conn = FakeConnection(results=[None])
        with pytest.raises(store.SlatePreviewStoreError) as exc:
            store.retry_build(FakeDb(conn), tenant_id="t1", build_id="nope", actor_name="x")
        assert exc.value.code == "preview_not_found"

    def test_cleanup_marks_each_expired_preview_and_audits_it(self):
        conn = FakeConnection(results=[[{"id": "prev-1"}, {"id": "prev-2"}]])
        reaped = store.reap_expired_previews(FakeDb(conn), tenant_id="t1")
        assert reaped == 2
        updates = statements_matching(conn, "UPDATE apiome.slate_preview_builds")
        assert len(updates) == 2
        assert all("status = 'expired'" in u[0] for u in updates)
        audit = statements_matching(conn, "INSERT INTO apiome.slate_preview_audit")
        assert len(audit) == 2

    def test_cleanup_with_nothing_due_is_a_no_op(self):
        conn = FakeConnection(results=[[]])
        assert store.reap_expired_previews(FakeDb(conn), tenant_id="t1") == 0
        assert statements_matching(conn, "UPDATE apiome.slate_preview_builds") == []
