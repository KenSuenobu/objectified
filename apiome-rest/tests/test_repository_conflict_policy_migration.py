"""Guardrails for the conflict-policy migration (RAR-4.5, #3531).

The stored policy tokens are a contract shared by the column CHECK constraints,
``app.repository_conflict_policy.ConflictPolicy`` and the settings API. These
fixtures pin the migration's shape so an accidental edit cannot widen the accepted
values, drop the per-file override's unique key, or — most importantly — change the
default away from hold-for-review, which would silently let refreshes clobber hand
edits across every existing repository.
"""

from pathlib import Path

from app.repository_conflict_policy import DEFAULT_CONFLICT_POLICY, ConflictPolicy

_MIGRATION = "apiome-db/scripts/V235__repository_conflict_policy_rar_4_5.sql"

_REQUIRED_FRAGMENTS = (
    # 1. The repository-wide policy column, defaulting to hold-not-clobber.
    "ALTER TABLE apiome.tenant_repositories",
    "ADD COLUMN IF NOT EXISTS refresh_conflict_policy VARCHAR(32) NOT NULL DEFAULT 'hold-for-review'",
    "ck_tenant_repositories_refresh_conflict_policy",
    "CHECK (refresh_conflict_policy IN ('overwrite', 'hold-for-review', 'new-branch'))",
    # 2. The per-file override table, keyed on the RAR-1.1 file-lineage tuple.
    "CREATE TABLE IF NOT EXISTS apiome.repository_conflict_policy_override",
    "CHECK (policy IN ('overwrite', 'hold-for-review', 'new-branch'))",
    "UNIQUE (repository_id, branch, path)",
    "idx_repository_conflict_policy_override_tenant_repo",
)


def test_migration_defines_both_policy_scopes(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    missing = [frag for frag in _REQUIRED_FRAGMENTS if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_default_is_hold_for_review(repo_root: Path) -> None:
    """AC3: existing repositories keep the RAR-4.4 hold-not-clobber behaviour."""
    text = (repo_root / _MIGRATION).read_text()
    assert "NOT NULL DEFAULT 'hold-for-review'" in text
    assert DEFAULT_CONFLICT_POLICY.value == "hold-for-review"


def test_check_constraints_match_the_application_enum(repo_root: Path) -> None:
    """Every token the application can write must be accepted by both CHECKs."""
    text = (repo_root / _MIGRATION).read_text()
    accepted = "('overwrite', 'hold-for-review', 'new-branch')"
    assert text.count(f"IN {accepted}") == 2
    for policy in ConflictPolicy:
        assert f"'{policy.value}'" in accepted, policy


def test_override_rows_cascade_with_their_repository(repo_root: Path) -> None:
    """Deregistering a repository must not leave orphaned policy rows behind."""
    text = (repo_root / _MIGRATION).read_text()
    assert "REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE" in text
    assert "REFERENCES apiome.tenants(id) ON DELETE CASCADE" in text
    # The author of an override is audit data: deleting the user nulls it rather
    # than deleting the policy the repository still depends on.
    assert "REFERENCES apiome.users(id) ON DELETE SET NULL" in text
