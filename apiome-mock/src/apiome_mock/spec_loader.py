"""Load and compile OpenAPI specs from Postgres (apiome-mcp read path)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Mapping
from uuid import UUID

from apiome_mcp.spec_openapi_loaders import fetch_openapi_generation_inputs_async
from app.mock_engine import MockOperation, extract_operations
from app.openapi_generator import generate_openapi_spec
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from apiome_mock.api_key import ValidatedApiKey, is_private_mock_mode
from apiome_mock.callbacks import CallbackDefinition, parse_callbacks
from apiome_mock.chaos import EMPTY_CHAOS, ChaosConfig, parse_chaos
from apiome_mock.fixture_data import parse_fixtures
from apiome_mock.fixture_packs import FixturePack, merged_template_data, parse_fixture_packs
from apiome_mock.scenarios import Scenario, parse_scenarios

MockAccessStatus = Literal["ok", "disabled", "missing"]

_RESOLVE_MOCK_ACCESS = """
    SELECT
      v.mock_enabled,
      v.published,
      v.mock_settings,
      s.id IS NOT NULL AS is_public_spec
    FROM apiome.versions v
    INNER JOIN apiome.projects p ON p.id = v.project_id AND p.deleted_at IS NULL
    INNER JOIN apiome.tenants t ON t.id = p.tenant_id AND t.deleted_at IS NULL AND t.enabled IS TRUE
    LEFT JOIN apiome.mcp_v_public_specs s ON s.id = v.id
    WHERE t.slug = %(tenant)s
      AND p.slug = %(project)s
      AND v.version_id = %(version)s
      AND v.deleted_at IS NULL
    LIMIT 1
"""

_RESOLVE_PUBLISHED_SPEC = """
    SELECT
      s.id,
      s.updated_at,
      t.slug AS tenant_slug,
      p.slug AS project_slug,
      v.version_id AS version_label,
      p.description AS project_description,
      v.metadata
    FROM apiome.mcp_v_public_specs s
    INNER JOIN apiome.versions v ON v.id = s.id AND v.deleted_at IS NULL
    INNER JOIN apiome.projects p ON p.id = v.project_id AND p.deleted_at IS NULL
    INNER JOIN apiome.tenants t ON t.id = p.tenant_id AND t.deleted_at IS NULL AND t.enabled IS TRUE
    WHERE t.slug = %(tenant)s
      AND p.slug = %(project)s
      AND v.version_id = %(version)s
      AND v.mock_enabled IS TRUE
    LIMIT 1
"""

_RESOLVE_DRAFT_SPEC = """
    SELECT
      v.id,
      v.updated_at,
      t.slug AS tenant_slug,
      p.slug AS project_slug,
      v.version_id AS version_label,
      p.description AS project_description,
      v.metadata
    FROM apiome.versions v
    INNER JOIN apiome.projects p ON p.id = v.project_id AND p.deleted_at IS NULL
    INNER JOIN apiome.tenants t ON t.id = p.tenant_id AND t.deleted_at IS NULL AND t.enabled IS TRUE
    WHERE t.slug = %(tenant)s
      AND p.slug = %(project)s
      AND v.version_id = %(version)s
      AND v.deleted_at IS NULL
      AND v.published IS FALSE
      AND v.mock_enabled IS TRUE
      AND COALESCE(v.mock_settings->>'mode', '') = 'private'
    LIMIT 1
"""


def _project_description(row: dict[str, Any]) -> str | None:
    description = row.get("project_description")
    if description is None:
        return None
    text = str(description).strip()
    return text if text else None


@dataclass(frozen=True)
class CompiledSpec:
    """Routing table compiled from an OpenAPI document."""

    revision_id: UUID
    tenant_slug: str
    project_slug: str
    version_label: str
    updated_at: datetime
    spec: dict[str, Any]
    operations: tuple[MockOperation, ...]
    scenarios: Mapping[str, Scenario] = field(default_factory=dict)
    """Scenario overrides parsed from ``versions.mock_settings`` (#4454, SIM-4.2)."""
    chaos: ChaosConfig = EMPTY_CHAOS
    """Version-level chaos knobs parsed from ``versions.mock_settings`` (#4455, SIM-4.3)."""
    fixtures: Mapping[str, Any] = field(default_factory=dict)
    """Fixture data readable by response templates (#4744, PMR-2.1)."""
    fixture_packs: Mapping[str, FixturePack] = field(default_factory=dict)
    """Versioned fixture packs sessions can reset to (#4745, PMR-2.2)."""
    callbacks: Mapping[str, CallbackDefinition] = field(default_factory=dict)
    """Outbound callback/webhook definitions this version simulates (#4746, PMR-2.3)."""

    @property
    def cache_key(self) -> tuple[str, str, str]:
        return (self.tenant_slug, self.project_slug, self.version_label)


async def _fetch_access_row(
    pool: AsyncConnectionPool,
    *,
    tenant: str,
    project: str,
    version: str,
) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                _RESOLVE_MOCK_ACCESS,
                {"tenant": tenant, "project": project, "version": version},
            )
            return await cur.fetchone()


async def get_mock_access_status(
    pool: AsyncConnectionPool,
    *,
    tenant: str,
    project: str,
    version: str,
    api_key: ValidatedApiKey | None = None,
) -> MockAccessStatus:
    """Return whether mock serving is allowed for the slug coordinates."""
    row = await _fetch_access_row(pool, tenant=tenant, project=project, version=version)
    if row is None:
        return "missing"
    if not row.get("mock_enabled"):
        return "disabled"

    published = bool(row.get("published"))
    if published:
        if not row.get("is_public_spec"):
            return "missing"
        return "ok"

    if not is_private_mock_mode(row.get("mock_settings"), published=False):
        return "missing"
    if api_key is None or api_key.tenant_slug != tenant:
        return "missing"
    return "ok"


async def _compile_from_row(
    conn: Any,
    row: dict[str, Any],
    *,
    mock_settings: Any = None,
) -> CompiledSpec:
    revision_id = row["id"]
    inputs = await fetch_openapi_generation_inputs_async(conn, revision_id)
    classes, all_properties, paths_data, security_rows, server_rows = inputs

    spec = generate_openapi_spec(
        str(row["tenant_slug"]),
        str(row["project_slug"]),
        str(row["version_label"]),
        classes,
        all_properties,
        project_description=_project_description(row),
        version_db_id=str(row["id"]),
        revision_metadata=row.get("metadata"),
        paths_data=paths_data,
        security_scheme_rows=security_rows,
        server_rows=server_rows,
    )
    operations = tuple(extract_operations(spec))
    updated_at = row["updated_at"]
    if not isinstance(updated_at, datetime):
        raise TypeError("expected versions.updated_at to be a datetime")

    fixture_packs = parse_fixture_packs(mock_settings)
    return CompiledSpec(
        revision_id=revision_id,
        tenant_slug=str(row["tenant_slug"]),
        project_slug=str(row["project_slug"]),
        version_label=str(row["version_label"]),
        updated_at=updated_at,
        spec=spec,
        operations=operations,
        scenarios=parse_scenarios(mock_settings),
        chaos=parse_chaos(mock_settings),
        # Pack data overlays the flat fixtures map, so templates can read both (#4745).
        fixtures={**parse_fixtures(mock_settings), **merged_template_data(fixture_packs)},
        fixture_packs=fixture_packs,
        callbacks=parse_callbacks(mock_settings),
    )


async def load_compiled_spec(
    pool: AsyncConnectionPool,
    *,
    tenant: str,
    project: str,
    version: str,
    api_key: ValidatedApiKey | None = None,
) -> CompiledSpec | None:
    """Resolve a spec by slug coordinates and compile its routing table."""
    access_row = await _fetch_access_row(pool, tenant=tenant, project=project, version=version)
    if access_row is None or not access_row.get("mock_enabled"):
        return None

    published = bool(access_row.get("published"))
    if published:
        query = _RESOLVE_PUBLISHED_SPEC
    else:
        if api_key is None or not is_private_mock_mode(access_row.get("mock_settings"), published=False):
            return None
        query = _RESOLVE_DRAFT_SPEC

    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(query, {"tenant": tenant, "project": project, "version": version})
            row = await cur.fetchone()
            if row is None:
                return None
            return await _compile_from_row(conn, row, mock_settings=access_row.get("mock_settings"))
