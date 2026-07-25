"""Guardrails for the WeChat vocabulary widen (V204, OLO-9.43, #5056).

DB-free: asserts the migration re-creates both provider CHECK constraints and admits ``wechat``
while keeping every prior V203 slug (including ``vk``).
"""

from pathlib import Path

import pytest

_MIGRATION = "V204__auth_provider_vocabulary_wechat_5056.sql"

_PRIOR_SLUGS = (
    "github",
    "gitlab",
    "azure",
    "google",
    "aws",
    "gcp",
    "bitbucket",
    "okta",
    "keycloak",
    "auth0",
    "oidc",
    "atlassian",
    "line",
    "vk",
)


@pytest.fixture
def migration_text(repo_root: Path) -> str:
    path = repo_root / "apiome-db" / "scripts" / _MIGRATION
    assert path.exists(), f"Migration {_MIGRATION} not found at {path}"
    return path.read_text()


def test_widens_both_provider_check_constraints(migration_text: str) -> None:
    assert "DROP CONSTRAINT IF EXISTS external_auth_providers_provider_supported_ck" in migration_text
    assert "ADD CONSTRAINT external_auth_providers_provider_supported_ck" in migration_text
    assert "DROP CONSTRAINT IF EXISTS auth_provider_config_provider_id_check" in migration_text
    assert "ADD CONSTRAINT auth_provider_config_provider_id_check" in migration_text


def test_admits_wechat_and_keeps_prior_slugs(migration_text: str) -> None:
    assert "'wechat'" in migration_text
    for slug in _PRIOR_SLUGS:
        assert f"'{slug}'" in migration_text, f"vocabulary migration omits prior slug {slug!r}"
