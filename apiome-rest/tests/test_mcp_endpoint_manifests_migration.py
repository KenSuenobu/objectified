"""Guardrails for the declared-manifest migration — FMT-1.7 (#5418).

`database.py`'s SQL is not exercised by the route tests (they mock the whole ``db``), so
the one thing a cheap test *can* prove is that the DDL and the queries written against it
still agree: every column the DB layer writes exists in the migration, and the constraints
that make the acceptance criteria hold — the live-uniqueness that stops a re-import
duplicating a declaration, the endpoint cascade that ties a manifest to one endpoint — are
still there.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_MIGRATION = "apiome-db/scripts/V245__mcp_endpoint_manifests_5418.sql"

#: Every column the table must carry. The DB layer's ``_MCP_MANIFEST_COLUMNS`` projection is
#: checked against this list below, so adding a column to one and not the other fails here
#: rather than at runtime against a real database.
_COLUMNS = (
    "id",
    "tenant_id",
    "endpoint_id",
    "source_label",
    "surface_fingerprint",
    "protocol_version",
    "server_name",
    "server_title",
    "server_version",
    "instructions",
    "capabilities",
    "surface",
    "tool_count",
    "resource_count",
    "resource_template_count",
    "prompt_count",
    "imported_by",
    "retired_at",
    "created_at",
    "updated_at",
)

_REQUIRED_FRAGMENTS = (
    "CREATE TABLE IF NOT EXISTS mcp_endpoint_manifests",
    "tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE",
    "endpoint_id UUID NOT NULL REFERENCES mcp_endpoints (id) ON DELETE CASCADE",
    "imported_by UUID REFERENCES users (id) ON DELETE RESTRICT",
    "surface_fingerprint TEXT NOT NULL",
    "surface JSONB NOT NULL",
    "mcp_endpoint_manifests_counts_check",
    "mcp_endpoint_manifests_fingerprint_check",
    "idx_mcp_endpoint_manifests_live_fingerprint",
    "idx_mcp_endpoint_manifests_endpoint",
    "idx_mcp_endpoint_manifests_tenant",
)


@pytest.fixture(name="migration_text")
def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text(encoding="utf-8")


def test_migration_creates_the_declared_manifest_table(migration_text: str) -> None:
    missing = [fragment for fragment in _REQUIRED_FRAGMENTS if fragment not in migration_text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_declares_every_column_the_db_layer_writes(migration_text: str) -> None:
    missing = [column for column in _COLUMNS if not re.search(rf"^\s+{column}\s", migration_text, re.M)]
    assert not missing, f"Migration declares no column for: {missing}"


def test_re_importing_an_unchanged_manifest_cannot_duplicate_a_row(migration_text: str) -> None:
    """The live partial unique index is what makes the upsert an upsert."""
    assert (
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_endpoint_manifests_live_fingerprint"
        in migration_text
    )
    assert "ON mcp_endpoint_manifests (endpoint_id, surface_fingerprint)" in migration_text
    assert "WHERE retired_at IS NULL" in migration_text


def test_migration_sets_the_apiome_search_path(migration_text: str) -> None:
    assert "SET search_path TO apiome, public;" in migration_text


def test_migration_documents_its_rollback(migration_text: str) -> None:
    assert "DROP TABLE IF EXISTS apiome.mcp_endpoint_manifests;" in migration_text


def test_migration_does_not_touch_the_version_snapshot_tables(migration_text: str) -> None:
    """A declaration is never a version snapshot — no observed table may be altered.

    Checked over the executable statements only; the header explains the separation at
    length and naming those tables there is the point.
    """
    statements = "\n".join(
        line for line in migration_text.splitlines() if not line.lstrip().startswith("--")
    )
    for observed_table in ("mcp_endpoint_versions", "mcp_capability_items", "mcp_endpoints"):
        assert f"ALTER TABLE {observed_table}" not in statements
        assert f"INSERT INTO {observed_table}" not in statements
        assert f"UPDATE {observed_table}" not in statements


def test_the_db_layer_projection_matches_the_migration(repo_root: Path) -> None:
    """``_MCP_MANIFEST_COLUMNS`` and the DDL name the same columns, in the same set."""
    from app.database import Database

    projected = {
        column.strip()
        for column in Database._MCP_MANIFEST_COLUMNS.replace("\n", " ").split(",")
        if column.strip()
    }
    assert projected == set(_COLUMNS)


def test_the_endpoint_insert_accepts_the_import_origin() -> None:
    """A manifest-created endpoint records ``added_via = import`` (the V148 domain)."""
    import inspect

    from app.database import Database

    signature = inspect.signature(Database.insert_mcp_endpoint)
    assert signature.parameters["added_via"].default == "manual"

    source = inspect.getsource(Database.insert_mcp_endpoint)
    assert "added_via" in source.split("INSERT INTO apiome.mcp_endpoints")[1]
