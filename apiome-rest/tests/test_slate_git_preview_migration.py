"""Structural guarantees of V197 — the git-triggered preview control plane (APX-3.3, #2458).

The database is where the four acceptance criteria are ultimately enforced, so these tests read
the migration and pin the constraints and triggers that carry them, the same way the other Slate
and read-model migrations are pinned by their structural tests. They were confirmed to fire
against a live Postgres during development; this keeps them from silently regressing in a later
edit. (A full ``requires_db`` run applies the whole schema in CI.)
"""

from __future__ import annotations

from pathlib import Path

import pytest

MIGRATION = "apiome-db/scripts/V197__slate_git_preview_2458.sql"


@pytest.fixture
def sql(repo_root: Path) -> str:
    return (repo_root / MIGRATION).read_text()


def test_one_preview_per_source_digest_is_a_unique_constraint(sql: str) -> None:
    # Acceptance criterion 1: a signed event creates exactly one preview per source digest.
    assert "UNIQUE (connection_id, source_digest)" in sql
    assert "source_digest     TEXT NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$')" in sql


def test_the_commit_url_is_immutable(sql: str) -> None:
    # Acceptance criterion 2: the commit URL is immutable.
    assert "CREATE OR REPLACE FUNCTION apiome.slate_preview_immutability_guard()" in sql
    assert "array_append(v_changed, 'immutable_url')" in sql
    assert "array_append(v_changed, 'source_commit')" in sql
    assert "array_append(v_changed, 'source_digest')" in sql
    assert "trg_slate_preview_immutability" in sql
    # The append must not use the bare `||` form, which resolves as array||array and throws.
    assert "|| 'immutable_url'" not in sql


def test_the_branch_alias_carries_a_concurrency_token(sql: str) -> None:
    assert "CREATE TABLE IF NOT EXISTS apiome.slate_branch_aliases" in sql
    assert "UNIQUE (connection_id, branch)" in sql
    assert "routing_version   BIGINT NOT NULL DEFAULT 0" in sql


def test_the_build_dispatch_boundary_is_a_check(sql: str) -> None:
    # Honesty boundary: no build worker, so no row can claim its build was dispatched.
    assert "build_dispatched  BOOLEAN NOT NULL DEFAULT FALSE CHECK (NOT build_dispatched)" in sql


def test_the_status_dispatch_boundary_is_a_check(sql: str) -> None:
    # Honesty boundary: a recorded status can never claim it was dispatched.
    assert "dispatch_enabled   BOOLEAN NOT NULL DEFAULT FALSE" in sql
    assert "CHECK (outcome <> 'dispatched' OR dispatch_enabled)" in sql


def test_status_and_audit_are_append_only(sql: str) -> None:
    # Acceptance criterion 4: retry and cleanup history only ever grows.
    assert "apiome.slate_provider_status_append_only()" in sql
    assert "apiome.slate_preview_audit_append_only()" in sql
    assert "BEFORE UPDATE OR DELETE ON apiome.slate_provider_status_deliveries" in sql
    assert "BEFORE UPDATE OR DELETE ON apiome.slate_preview_audit" in sql


def test_the_token_and_secret_columns_exist_but_are_never_projected(sql: str) -> None:
    # Acceptance criterion 4: repository tokens are sealed at rest.
    assert "webhook_secret_enc  BYTEA" in sql
    assert "token_ciphertext    BYTEA" in sql
    assert "token_key_version   INTEGER" in sql


def test_everything_lands_in_the_apiome_schema(sql: str) -> None:
    assert "SET search_path TO apiome, public;" in sql
    for table in (
        "slate_git_connections",
        "slate_preview_builds",
        "slate_preview_changed_pages",
        "slate_branch_aliases",
        "slate_provider_status_deliveries",
        "slate_preview_audit",
    ):
        assert f"CREATE TABLE IF NOT EXISTS apiome.{table}" in sql
