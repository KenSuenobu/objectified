"""Guardrails for the webhook subscription migration (REPO-4.3, #2781).

The Python side runs against fakes, so these fragments are what pin the real schema to the
contract the code assumes: the columns the DAO reads and writes, the write-once trigger that
makes the ticket's "secret stored write-once" a database fact rather than a convention, the
append-only trigger on the ledger, and the unique index the redelivery path relies on
returning ``None`` from.
"""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V227__repository_webhook_subscriptions_repo_4_3.sql"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


# --- Subscription table -----------------------------------------------------------------


def test_the_subscription_columns_the_dao_reads_exist(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "CREATE TABLE IF NOT EXISTS apiome.repository_webhook_subscription" in text
    for column in (
        "secret_enc",
        "secret_fingerprint",
        "pr_preview_enabled",
        "provider_hook_id",
        "registration_state",
        "registration_error",
        "last_event_at",
        "last_delivery_id",
        "event_count",
    ):
        assert column in text, f"missing column {column}"


def test_one_subscription_per_repository(repo_root: Path) -> None:
    """Two live secrets for one repository would make "which is authoritative" unanswerable."""
    text = _migration_text(repo_root)
    assert "repository_id       UUID NOT NULL UNIQUE" in text


def test_only_supported_providers_are_storable(repo_root: Path) -> None:
    assert "CHECK (provider IN ('github', 'gitlab', 'bitbucket'))" in _migration_text(repo_root)


def test_only_the_three_registration_states_are_storable(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "CHECK (registration_state IN ('local', 'registered', 'failed'))" in text
    assert "DEFAULT 'local'" in text


def test_the_ingestion_lookup_is_indexed(repo_root: Path) -> None:
    """The unauthenticated endpoint resolves by (provider, repo_full_name) on every delivery."""
    text = _migration_text(repo_root)
    assert "idx_repository_webhook_subscription_repo" in text
    assert "(provider, repo_full_name)" in text


# --- The write-once guarantee -----------------------------------------------------------


def test_the_secret_cannot_be_rewritten_by_update(repo_root: Path) -> None:
    """Acceptance criterion 4: write-once, enforced by trigger rather than by convention."""
    text = _migration_text(repo_root)
    assert "apiome.repository_webhook_secret_guard()" in text
    assert "OLD.secret_enc IS NOT NULL AND NEW.secret_enc IS DISTINCT FROM OLD.secret_enc" in text
    assert "trg_repository_webhook_secret_guard" in text
    assert "BEFORE UPDATE ON apiome.repository_webhook_subscription" in text


def test_a_subscription_cannot_be_repointed_at_another_repository(repo_root: Path) -> None:
    """Repointing would let one tenant's deliveries drive another tenant's imports."""
    text = _migration_text(repo_root)
    for column in ("tenant_id", "repository_id", "id", "created_at"):
        assert f"NEW.{column}" in text and f"OLD.{column}" in text


def test_a_row_created_without_an_encryption_key_may_still_be_given_a_secret(
    repo_root: Path,
) -> None:
    """Write-once starts once the secret exists; NULL → non-NULL is a fix, not a rewrite."""
    assert "OLD.secret_enc IS NOT NULL AND" in _migration_text(repo_root)


# --- Delivery ledger --------------------------------------------------------------------


def test_the_ledger_columns_the_dao_writes_exist(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "CREATE TABLE IF NOT EXISTS apiome.repository_webhook_event" in text
    for column in (
        "delivery_id",
        "event_type",
        "action",
        "repo_full_name",
        "branch",
        "head_sha",
        "pr_number",
        "outcome",
        "reason",
        "jobs_enqueued",
        "received_at",
    ):
        assert column in text, f"missing column {column}"


def test_the_ledger_holds_no_secret_column(repo_root: Path) -> None:
    """An append-only table holding key material would be a key history nobody can redact."""
    text = _migration_text(repo_root)
    body = text.split("CREATE TABLE IF NOT EXISTS apiome.repository_webhook_event", 1)[1]
    body = body.split("\n);", 1)[0]  # the column list only, not the trailing COMMENTs
    assert "secret" not in body


def test_only_the_five_documented_outcomes_are_storable(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert (
        "CHECK (outcome IN ('enqueued', 'preview-scan', 'ignored', 'duplicate', 'rejected'))"
        in text
    )


def test_an_unattributable_delivery_is_still_recordable(repo_root: Path) -> None:
    """A delivery for an unregistered repository has no tenant; the row must not be lost."""
    text = _migration_text(repo_root)
    ledger = text.split("CREATE TABLE IF NOT EXISTS apiome.repository_webhook_event", 1)[1]
    assert "tenant_id         UUID REFERENCES apiome.tenants(id)" in ledger
    assert "tenant_id         UUID NOT NULL" not in ledger


def test_a_redelivery_collides_instead_of_enqueuing_twice(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "uq_repository_webhook_event_delivery" in text
    assert "ON apiome.repository_webhook_event (subscription_id, delivery_id)" in text
    # Partial, so a provider that sends no delivery id still gets its deliveries recorded.
    assert "WHERE subscription_id IS NOT NULL AND delivery_id IS NOT NULL" in text


def test_the_ledger_is_append_only(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "apiome.repository_webhook_event_append_only()" in text
    assert "BEFORE UPDATE OR DELETE ON apiome.repository_webhook_event" in text


def test_rejected_deliveries_are_indexed_for_incident_response(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "idx_repository_webhook_event_rejected" in text
    assert "WHERE outcome = 'rejected'" in text


def test_the_migration_is_rerunnable(repo_root: Path) -> None:
    """Every object is IF NOT EXISTS / OR REPLACE, so a replayed migration is a no-op."""
    text = _migration_text(repo_root)
    assert text.count("CREATE TABLE IF NOT EXISTS") == 2
    assert text.count("CREATE OR REPLACE FUNCTION") == 2
    assert "CREATE TABLE apiome." not in text
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("CREATE INDEX") or stripped.startswith("CREATE UNIQUE INDEX"):
            assert "IF NOT EXISTS" in stripped, stripped
