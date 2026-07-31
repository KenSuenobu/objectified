"""Guardrails for the Arazzo workflow-entity migration (REPO-3.4, #2773).

The Python side is exercised against a fake cursor, so these fragments are what pins the real
schema to the contract that code assumes: the column names it INSERTs into, the scoping columns
every canonical child carries, and the two invariants a reader relies on — a resolved step has
an FK and an unresolved one does not, and a deleted target degrades a step rather than deleting
it.
"""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V225__arazzo_workflow_entities_repo_3_4.sql"

# Columns the persistence layer binds by name; a rename here breaks the INSERTs.
_WORKFLOW_COLUMNS = (
    "workflow_id VARCHAR(512) NOT NULL",
    "summary VARCHAR(4096)",
    "description TEXT",
    "inputs JSONB NOT NULL DEFAULT '{}'::jsonb",
    "outputs JSONB NOT NULL DEFAULT '{}'::jsonb",
    "ordinal INTEGER NOT NULL DEFAULT 0",
)
_STEP_COLUMNS = (
    "step_id VARCHAR(512) NOT NULL",
    "order_index INTEGER NOT NULL DEFAULT 0",
    "operation_ref TEXT",
    "operation_id VARCHAR(512)",
    "resolution_status VARCHAR(32) NOT NULL DEFAULT 'unresolved'",
    "resolution_reason VARCHAR(64)",
    "parameters JSONB NOT NULL DEFAULT '[]'::jsonb",
    "success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb",
    "on_failure JSONB NOT NULL DEFAULT '[]'::jsonb",
    "outputs JSONB NOT NULL DEFAULT '{}'::jsonb",
    "depends_on JSONB NOT NULL DEFAULT '[]'::jsonb",
)


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


def test_creates_both_workflow_tables(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "CREATE TABLE IF NOT EXISTS api_workflows" in text
    assert "CREATE TABLE IF NOT EXISTS api_workflow_steps" in text


def test_workflow_table_carries_the_ticket_columns(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    missing = [column for column in _WORKFLOW_COLUMNS if column not in text]
    assert not missing, f"api_workflows missing columns: {missing}"


def test_step_table_carries_the_ticket_columns(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    missing = [column for column in _STEP_COLUMNS if column not in text]
    assert not missing, f"api_workflow_steps missing columns: {missing}"


def test_rows_are_tenant_version_and_artifact_scoped(repo_root: Path) -> None:
    """Every canonical child is scoped the way V135 established."""
    text = _migration_text(repo_root)
    for fragment in (
        "tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE",
        "version_id UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE",
        "artifact_id UUID NOT NULL REFERENCES api_artifacts(id) ON DELETE CASCADE",
        "project_id UUID REFERENCES projects(id) ON DELETE CASCADE",
        "workflow_id UUID NOT NULL REFERENCES api_workflows(id) ON DELETE CASCADE",
    ):
        assert fragment in text, f"missing scoping column: {fragment}"


def test_losing_the_target_operation_degrades_a_step_instead_of_deleting_it(
    repo_root: Path,
) -> None:
    """SET NULL, never CASCADE — a workflow must survive its target being removed."""
    text = _migration_text(repo_root)
    assert (
        "resolved_path_operation_id UUID REFERENCES path_operation(id) ON DELETE SET NULL"
        in text
    )
    assert "REFERENCES path_operation(id) ON DELETE CASCADE" not in text


def test_resolution_status_and_fk_cannot_disagree(repo_root: Path) -> None:
    """`resolution_status = 'resolved'` iff the FK is set, so readers can trust either."""
    text = _migration_text(repo_root)
    assert "CHECK (resolution_status IN ('resolved', 'unresolved', 'not_applicable', 'parse_error'))" in text
    assert (
        "CHECK ((resolution_status = 'resolved') = (resolved_path_operation_id IS NOT NULL))"
        in text
    )


def test_identity_is_unique_among_live_rows_only(repo_root: Path) -> None:
    """Soft-deleting a re-imported version must not collide with the new rows."""
    text = _migration_text(repo_root)
    assert (
        "ON api_workflows(artifact_id, workflow_id) WHERE deleted_at IS NULL" in text
    )
    assert (
        "ON api_workflow_steps(workflow_id, step_id) WHERE deleted_at IS NULL" in text
    )


def test_reverse_lookup_from_an_operation_is_indexed(repo_root: Path) -> None:
    """"Which workflows call this operation?" is the payoff for resolving refs at all."""
    text = _migration_text(repo_root)
    assert "ON api_workflow_steps(resolved_path_operation_id)" in text
