"""Canonical ``apiome-rest`` URL paths (relative to ``base_url``)."""

from __future__ import annotations

from uuid import UUID

V1 = "/v1"


def health() -> str:
    return "/health"


def tenants_me() -> str:
    return f"{V1}/tenants/me"


def tenant(tenant_slug: str) -> str:
    return f"{V1}/tenants/{tenant_slug}"


def import_sources() -> str:
    """Registry of import-source adapters (MFI-1.1/1.4); drives ``import --list``."""
    return f"{V1}/import/sources"


def format_matrix() -> str:
    """The format support matrix (FMT-1.5); drives ``apiome formats``.

    Non-tenant reference data: one row per registered format, with its import/export support,
    declared version coverage, file extensions, toolchain gate and capability boundary summary.
    Accepts optional ``paradigm`` and ``direction`` query filters.
    """
    return f"{V1}/formats/matrix"


def export_targets(tenant_slug: str) -> str:
    """Emitter registry targets + per-source fidelity for an artifact (MFX-2.5/9.4).

    Drives ``export targets``: ``GET`` with ``?artifact=&version=`` returns each emitter's
    descriptor, capability profile, options schema, and a cheap fidelity badge (no artifact emitted).
    """
    return f"{V1}/export/{tenant_slug}/targets"


def export_preview(tenant_slug: str) -> str:
    """Dry-run fidelity preview for one (artifact, target) export (MFX-2.5/9.4).

    Drives the ``export openapi`` fidelity surface: ``POST`` a source revision + chosen target and
    receive the full fidelity envelope (tier, per-construct report, advisory) with no artifact emitted.
    """
    return f"{V1}/export/{tenant_slug}/preview"


def export_projection_evidence(tenant_slug: str) -> str:
    """Bounded, cursor-paginated projection evidence for one configured export (EFP-2.1).

    Drives ``export evidence``: ``POST`` a source revision + target + options (+ cursor/limit)
    and receive one page of source→target outcome edges with the snapshot summary the
    preview/verify envelopes reference. No artifact is emitted.
    """
    return f"{V1}/export/{tenant_slug}/projection-evidence"


def export_document(tenant_slug: str) -> str:
    """Emit one (artifact, target) export document through the Emitter SPI (MFX-11.5).

    Drives ``export asyncapi``: ``POST`` a source revision + chosen target and receive the emitted
    document itself — JSON by default, YAML under ``Accept: application/yaml``. The byte source the
    OpenAPI-only browse reconstruction (``GET /v1/schema/…``) cannot supply for non-OpenAPI targets.
    """
    return f"{V1}/export/{tenant_slug}/document"


def export_jobs(tenant_slug: str) -> str:
    """Async export job collection (MFX-3.1 / MFX-8.1).

    ``POST`` submits a job (202 + ``{job_id, status_path}``); ``GET`` lists in-memory jobs for the tenant.
    """
    return f"{V1}/export/{tenant_slug}/jobs"


def export_job(tenant_slug: str, job_id: str) -> str:
    """Poll one async export job's status (MFX-3.1 / MFX-8.1)."""
    return f"{export_jobs(tenant_slug)}/{job_id}"


def export_job_download(tenant_slug: str, job_id: str) -> str:
    """Download a completed export job's artifact bytes (MFX-4.1/4.2 / MFX-8.1)."""
    return f"{export_job(tenant_slug, job_id)}/download"


def tenant_imports(tenant_slug: str) -> str:
    return f"{V1}/tenants/{tenant_slug}/imports"


def tenant_import(tenant_slug: str, job_id: str) -> str:
    return f"{V1}/tenants/{tenant_slug}/imports/{job_id}"


def tenant_imports_upload(tenant_slug: str) -> str:
    return f"{V1}/tenants/{tenant_slug}/imports/upload"


def import_git_fileset(tenant_slug: str) -> str:
    """Fetch a git repository path/glob at a ref as an importable fileset (MFI-29.3).

    Drives ``apiome import git``: ``POST`` the repository selection and receive the
    selected files packed as an archive (``document_base64``), the resolved root
    document, the detected format, and the commit the files were read at — the payload
    the normal import flow (pre-flight, then ``POST …/imports``) already accepts.
    """
    return f"{V1}/tenants/{tenant_slug}/import/git/fileset"


def import_bulk_plan(tenant_slug: str) -> str:
    """Partition one archive/repository into the independent specs it holds (MFI-29.5).

    Drives ``apiome import auto --bulk``: ``POST`` the payload and receive one row per
    independent spec — root document, members, detected adapter, predicted destination,
    and a suggested catalog identity. Nothing is persisted.
    """
    return f"{V1}/tenants/{tenant_slug}/import/bulk/plan"


def import_bulk(tenant_slug: str) -> str:
    """Start one ordinary import job per independent spec in a bulk payload (MFI-29.5).

    The server re-plans the payload and schedules a job per selected item; an item that
    cannot start is a failed row, never a failed batch.
    """
    return f"{V1}/tenants/{tenant_slug}/import/bulk"


def import_bulk_status(tenant_slug: str) -> str:
    """Roll up one batch's jobs into a per-item result list (MFI-29.5)."""
    return f"{V1}/tenants/{tenant_slug}/import/bulk/status"


def import_preflight(tenant_slug: str) -> str:
    """Score a candidate document before importing it (IXH-2.1).

    Drives ``import preflight`` and the ``--min-grade`` / ``--fail-on`` gate on the import
    commands: ``POST`` the same intake payload the import job takes and receive an
    ``ImportPreflightReport`` — detection, counts, the full lint verdict, and the tenant
    quality-policy verdict. Nothing is persisted and no job is created.
    """
    return f"{V1}/tenants/{tenant_slug}/import/preflight"


def export_preflight(tenant_slug: str) -> str:
    """Rank every export target for one source revision before a job exists (IXH-2.4).

    Drives ``export preflight`` and the ``--min-grade`` / ``--fail-on`` gate on the export
    commands: ``POST`` the source coordinates (+ optional target filter) and receive an
    ``ExportPreflightReport`` — the source lint verdict plus every target with its projected
    fidelity, capability verdict, policy verdict, and readiness band. Nothing is emitted.

    Mounted under ``/v1/tenants`` (not the historical ``/v1/export/{tenant}`` prefix) so it
    sits beside :func:`import_preflight`.
    """
    return f"{V1}/tenants/{tenant_slug}/export/preflight"


def catalog_convert(tenant_slug: str, item_id: str, *, dry_run: bool) -> str:
    """Catalog item → OpenAPI conversion (MFI-22.6).

    ``dryRun=true`` returns the fidelity report + would-be document with no side effects; ``false``
    commits the convert-to-project/version job. The query flag is authoritative for the side effect.
    """
    flag = "true" if dry_run else "false"
    return f"{V1}/catalog/{tenant_slug}/{item_id}/convert?dryRun={flag}"


def catalog_projection(tenant_slug: str, item_id: str) -> str:
    """Catalog item conversion projection manifest, page by page (CPDO-1.3).

    Read-only despite the POST verb: the body carries the gap-filling ``defaults``, which are folded
    into the snapshot hash, plus the page window (``scope`` / ``cursor`` / ``limit``).
    """
    return f"{V1}/catalog/{tenant_slug}/{item_id}/projection"


def tenant_repositories(tenant_slug: str) -> str:
    return f"{V1}/tenants/{tenant_slug}/repositories"


def tenant_repository(tenant_slug: str, repository_id: str | UUID) -> str:
    return f"{V1}/tenants/{tenant_slug}/repositories/{repository_id}"


def tenant_repository_files(tenant_slug: str, repository_id: str | UUID) -> str:
    return f"{tenant_repository(tenant_slug, repository_id)}/files"


def tenant_repository_file_content(
    tenant_slug: str,
    repository_id: str | UUID,
    file_id: str | UUID,
) -> str:
    return f"{tenant_repository_files(tenant_slug, repository_id)}/{file_id}/content"


def tenant_repository_refresh(tenant_slug: str, repository_id: str | UUID) -> str:
    """One-shot manual "Refresh Now" for a repository or a single file (RAR-5.2).

    ``POST`` with an optional ``{"path": …, "branch": …}`` body: a spec-faithful
    re-import that honours the freshness gate and the divergence guard but bypasses
    the auto-refresh cadence and opt-outs.
    """
    return f"{tenant_repository(tenant_slug, repository_id)}/refresh"


def tenant_repository_refresh_history(tenant_slug: str, repository_id: str | UUID) -> str:
    """Refresh-cycle audit history for a repository (RAR-5.3).

    ``GET`` newest-first, offset-paginated; ``?path=`` narrows it to one file lineage.
    """
    return f"{tenant_repository(tenant_slug, repository_id)}/refresh-history"


def tenant_repository_spec_catalog(tenant_slug: str) -> str:
    """Tenant-wide catalog of discovered specs (REPO-6.4), filterable by repository."""
    return f"{V1}/tenants/{tenant_slug}/repository-files"


def tenant_repository_import_spec(tenant_slug: str, import_id: str | UUID) -> str:
    """Stored import spec and materialized refresh status for one file lineage (RAR-1.5).

    ``import_id`` is the import-spec row id by default; with ``?path=`` it is
    reinterpreted as the *repository* id and the lineage is resolved by path
    (optionally scoped with ``&branch=``).
    """
    return f"{V1}/tenants/{tenant_slug}/repository-imports/{import_id}/spec"


def tenant_mcp_policy(tenant_slug: str) -> str:
    """Tenant MCP governance policy (GET/PUT; MTG-3.1 / MTG-5.3)."""
    return f"{V1}/tenants/{tenant_slug}/mcp-policy"


def tenant_mcp_keys(tenant_slug: str) -> str:
    """MCP API keys collection for a tenant (MTG-3.2)."""
    return f"{V1}/tenants/{tenant_slug}/mcp-keys"


def tenant_mcp_key(tenant_slug: str, key_id: str | UUID) -> str:
    """One MCP API key's public metadata (MTG-3.2)."""
    return f"{tenant_mcp_keys(tenant_slug)}/{key_id}"


def tenant_mcp_key_capabilities(tenant_slug: str, key_id: str | UUID) -> str:
    """Per-key capability grants (PUT; MTG-3.3 / MTG-5.3)."""
    return f"{tenant_mcp_key(tenant_slug, key_id)}/capabilities"


def mcp_endpoints(tenant_slug: str) -> str:
    """MCP catalog endpoints collection (list / register)."""
    return f"{V1}/mcp/{tenant_slug}/endpoints"


def mcp_endpoint(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """A single MCP catalog endpoint by id (show)."""
    return f"{mcp_endpoints(tenant_slug)}/{endpoint_id}"


def mcp_endpoint_credentials(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """Outbound credential resource for one MCP catalog endpoint (set/clear)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/credentials"


def mcp_endpoint_discover(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """Trigger a discovery run for one MCP catalog endpoint (POST → job)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/discover"


def mcp_endpoint_job(
    tenant_slug: str,
    endpoint_id: str | UUID,
    job_id: str | UUID,
) -> str:
    """Poll one discovery job's status snapshot (state, version_id/error)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/jobs/{job_id}"


def mcp_endpoint_version_lint(
    tenant_slug: str,
    endpoint_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """Stored/recomputed lint score + grade for one version snapshot."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/versions/{version_id}/lint"


def mcp_version_lint_policy(
    tenant_slug: str,
    endpoint_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """Style-guide policy evaluation for one MCP version snapshot."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/versions/{version_id}/lint/policy"


def mcp_endpoint_version_conformance(
    tenant_slug: str,
    endpoint_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """MCP protocol conformance + agent-readiness report for one version snapshot."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/versions/{version_id}/conformance"


def mcp_conformance_rules() -> str:
    """Registry-level MCP conformance rule catalog (no tenant scope)."""
    return f"{V1}/mcp/conformance/rules"


def mcp_endpoint_sources(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """An MCP endpoint's linked source associations (CLX-3.2, #4856)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/sources"


def mcp_endpoint_source(
    tenant_slug: str, endpoint_id: str | UUID, source_id: str | UUID
) -> str:
    """One linked source association."""
    return f"{mcp_endpoint_sources(tenant_slug, endpoint_id)}/{source_id}"


def mcp_endpoint_source_sbom(
    tenant_slug: str, endpoint_id: str | UUID, source_id: str | UUID
) -> str:
    """Attach an SBOM to a linked source."""
    return f"{mcp_endpoint_source(tenant_slug, endpoint_id, source_id)}/sbom"


def mcp_endpoint_version_trust_posture(
    tenant_slug: str,
    endpoint_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """MCP source / supply-chain / trust-posture report for one version snapshot (CLX-3.2)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/versions/{version_id}/trust-posture"


def mcp_trust_posture_rules() -> str:
    """Registry-level MCP trust-posture rule catalog (no tenant scope)."""
    return f"{V1}/mcp/trust-posture/rules"


def mcp_probe_catalog() -> str:
    """Registry-level MCP probe catalog: probes, profiles, classification tiers (CLX-3.3, #4857)."""
    return f"{V1}/mcp/probes/catalog"


def mcp_endpoint_probe_targets(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """An MCP endpoint's active-probe allowlist (CLX-3.3, #4857)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/probe-targets"


def mcp_endpoint_probe_target(
    tenant_slug: str, endpoint_id: str | UUID, target_id: str | UUID
) -> str:
    """One allowlist entry."""
    return f"{mcp_endpoint_probe_targets(tenant_slug, endpoint_id)}/{target_id}"


def mcp_endpoint_version_probe(
    tenant_slug: str, endpoint_id: str | UUID, version_id: str | UUID
) -> str:
    """Run a probe profile against one version snapshot (CLX-3.3, #4857)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/versions/{version_id}/probe"


def mcp_endpoint_probe_runs(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """An MCP endpoint's probe-run audit trail (CLX-3.3, #4857)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/probe-runs"


def mcp_endpoint_trust_baseline(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """An MCP endpoint's approved trust baseline: approve (POST) / read (GET) (CLX-3.4, #4858)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/trust-baseline"


def mcp_endpoint_trust_drift(tenant_slug: str, endpoint_id: str | UUID) -> str:
    """Diff an MCP endpoint's current snapshot against its approved baseline (CLX-3.4, #4858)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/trust-drift"


def mcp_shadowing(tenant_slug: str) -> str:
    """Shadowed/duplicate tool names across a tenant's enabled host scope (CLX-3.4, #4858)."""
    return f"{V1}/mcp/{tenant_slug}/data-quality/shadowing"


def projects(tenant_slug: str) -> str:
    return f"{V1}/projects/{tenant_slug}"


def project(tenant_slug: str, project_id: str | UUID) -> str:
    return f"{V1}/projects/{tenant_slug}/{project_id}"


def project_by_slug(tenant_slug: str, project_slug: str) -> str:
    return f"{V1}/projects/{tenant_slug}/by-slug/{project_slug}"


def versions(tenant_slug: str, project_id: str | UUID) -> str:
    return f"{V1}/versions/{tenant_slug}/{project_id}"


def version_record(
    tenant_slug: str,
    project_id: str | UUID,
    version_record_id: str | UUID,
) -> str:
    return f"{V1}/versions/{tenant_slug}/{project_id}/{version_record_id}"


def version_by_semver(
    tenant_slug: str,
    project_id: str | UUID,
    version_semver: str,
) -> str:
    return f"{V1}/versions/{tenant_slug}/{project_id}/by-version/{version_semver}"


def version_lint(
    tenant_slug: str,
    project_id: str | UUID,
    version_record_id: str | UUID,
) -> str:
    """Quality-scoring / lint report for a version (GET .../lint)."""
    return f"{version_record(tenant_slug, project_id, version_record_id)}/lint"


def classified_diff(tenant_slug: str) -> str:
    """POST classified OpenAPI diff (CTG-1.2 / CTG-2.1 CI gate).

    Body: ``{base: {project, version}, head: {inline}|{project, version}}``.
    Default JSON; ``Accept: text/markdown`` returns the CTG-1.3 changelog.
    """
    return f"{V1}/diff/{tenant_slug}/classified"


def version_compatibility_evidence(
    tenant_slug: str,
    project_id: str | UUID,
) -> str:
    """POST independent oasdiff compatibility evidence for a revision pair."""
    return f"{V1}/versions/{tenant_slug}/{project_id}/compatibility/evidence"


def contract_suite(tenant_slug: str, version_ref: str) -> str:
    """POST a contract-suite compilation for one version (ECA-1.1).

    ``version_ref`` is the path-shaped reference the schema surface uses without a trailing
    type segment — ``project/{slug}/{version}`` or ``catalog/{item}/{version}`` — and is
    carried as multiple path segments, which is why it is interpolated rather than escaped.
    """
    return f"{V1}/tenants/{tenant_slug}/contracts/{version_ref}/suite"


def contract_run(tenant_slug: str, version_ref: str) -> str:
    """POST a contract-suite execution against a verification target (ECA-2.1 / ECA-2.2).

    Compiles the suite, resolves the target, runs cases, and always records ECA-1.3 evidence.
    ``version_ref`` uses the same path-shaped grammar as :func:`contract_suite`.
    """
    return f"{V1}/tenants/{tenant_slug}/contracts/{version_ref}/run"


def schema_validate(tenant_slug: str, schema_ref: str) -> str:
    """POST one payload for validation against a cataloged schema (IXH-5.1).

    ``schema_ref`` is the path-shaped schema reference — ``project/{slug}/{version}[/{type}]``,
    ``catalog/{item}/{version}[/{type}]``, or ``registry/{namespace}/{name}`` — carried as
    multiple path segments, which is why it is interpolated rather than escaped (the server
    route uses a ``:path`` converter; a ``%2F``-encoded reference would be split apart again
    by the ASGI server before routing).
    """
    return f"{V1}/tenants/{tenant_slug}/schemas/{schema_ref}/validate"


def schema_synthesize(tenant_slug: str, schema_ref: str) -> str:
    """POST a sample-payload synthesis request for a cataloged schema (IXH-5.2).

    ``schema_ref`` uses the same path-shaped grammar as :func:`schema_validate`, so a
    payload can be generated and then validated against the very same reference.
    """
    return f"{V1}/tenants/{tenant_slug}/schemas/{schema_ref}/synthesize"


def verification_run_export(tenant_slug: str, run_id: str) -> str:
    """GET one verification run as JSON or JUnit (ECA-1.3 export; used by ECA-2.2 CLI).

    Callers append ``?format=json`` or ``?format=junit``. The server reproduces stored counts
    rather than re-tallying, so the artifact cannot disagree with the evidence record.
    """
    return f"{V1}/tenants/{tenant_slug}/verification-runs/{run_id}/export"


def version_compatibility_evidence_list(
    tenant_slug: str,
    project_id: str | UUID,
    version_record_id: str | UUID,
) -> str:
    """GET persisted oasdiff compatibility evidence for one revision."""
    return (
        f"{version_record(tenant_slug, project_id, version_record_id)}"
        "/compatibility/evidence"
    )


def version_lint_policy(
    tenant_slug: str,
    project_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """Style-guide policy evaluation for a catalog revision (GET .../lint/policy)."""
    return f"{version_record(tenant_slug, project_id, version_id)}/lint/policy"


def version_lint_gate(
    tenant_slug: str,
    project_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """Lint CI gate evaluation + artifact emission for a revision (GET .../lint/gate)."""
    return f"{version_record(tenant_slug, project_id, version_id)}/lint/gate"


def version_lint_evidence(
    tenant_slug: str,
    project_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """Immutable lint evidence runs for a revision (GET .../lint/evidence)."""
    return f"{version_record(tenant_slug, project_id, version_id)}/lint/evidence"


def mcp_endpoint_version_lint_gate(
    tenant_slug: str,
    endpoint_id: str | UUID,
    version_id: str | UUID,
) -> str:
    """Lint CI gate evaluation for an MCP endpoint snapshot (GET .../lint/gate)."""
    return f"{mcp_endpoint(tenant_slug, endpoint_id)}/versions/{version_id}/lint/gate"


def version_publish(
    tenant_slug: str,
    project_id: str | UUID,
    version_record_id: str | UUID,
) -> str:
    return f"{version_record(tenant_slug, project_id, version_record_id)}/publish"


def version_unpublish(
    tenant_slug: str,
    project_id: str | UUID,
    version_record_id: str | UUID,
) -> str:
    return f"{version_record(tenant_slug, project_id, version_record_id)}/unpublish"


def version_mock(
    tenant_slug: str,
    project_id: str | UUID,
    version_record_id: str | UUID,
) -> str:
    """Hosted-mock toggle for a published version (``PUT …/mock``, SIM-2.1/#4422)."""
    return f"{version_record(tenant_slug, project_id, version_record_id)}/mock"


def mock_usage(tenant_slug: str) -> str:
    """Tenant mock usage counters and daily rollups (``GET /v1/mocks/{tenant}/usage``, SIM-1.5)."""
    return f"{V1}/mocks/{tenant_slug}/usage"


def classes(tenant_slug: str) -> str:
    return f"{V1}/classes/{tenant_slug}"


def class_record(tenant_slug: str, class_id: str | UUID) -> str:
    return f"{V1}/classes/{tenant_slug}/{class_id}"


def primitives(tenant_slug: str) -> str:
    return f"{V1}/primitives/{tenant_slug}"


def primitive(tenant_slug: str, primitive_id: str | UUID) -> str:
    return f"{V1}/primitives/{tenant_slug}/{primitive_id}"


def primitives_import(tenant_slug: str) -> str:
    return f"{V1}/primitives/{tenant_slug}/import"


def properties(tenant_slug: str, project_id: str | UUID) -> str:
    return f"{V1}/properties/{tenant_slug}/{project_id}"


def property_record(
    tenant_slug: str,
    project_id: str | UUID,
    property_id: str | UUID,
) -> str:
    return f"{V1}/properties/{tenant_slug}/{project_id}/{property_id}"


def paths(tenant_slug: str, version_record_id: str | UUID) -> str:
    return f"{V1}/paths/{tenant_slug}/{version_record_id}"


def path_record(
    tenant_slug: str,
    version_record_id: str | UUID,
    path_id: str | UUID,
) -> str:
    return f"{paths(tenant_slug, version_record_id)}/{path_id}"


def path_operations(
    tenant_slug: str,
    version_record_id: str | UUID,
    path_id: str | UUID,
) -> str:
    return f"{path_record(tenant_slug, version_record_id, path_id)}/operations"


def path_operation(
    tenant_slug: str,
    version_record_id: str | UUID,
    path_id: str | UUID,
    operation_id: str | UUID,
) -> str:
    return f"{path_operations(tenant_slug, version_record_id, path_id)}/{operation_id}"


def path_full(
    tenant_slug: str,
    version_record_id: str | UUID,
    path_id: str | UUID,
) -> str:
    return f"{path_record(tenant_slug, version_record_id, path_id)}/full"


def browse_tenants() -> str:
    return f"{V1}/browse/tenants"


def browse_projects(tenant_slug: str) -> str:
    return f"{V1}/browse/tenants/{tenant_slug}/projects"


def browse_versions(tenant_slug: str, project_slug: str) -> str:
    return f"{V1}/browse/tenants/{tenant_slug}/projects/{project_slug}/versions"


def schema_export(tenant_slug: str, project_slug: str, version_slug: str) -> str:
    return f"{V1}/schema/{tenant_slug}/{project_slug}/{version_slug}"


def swagger_export(tenant_slug: str, project_slug: str, version_slug: str) -> str:
    return f"{V1}/swagger/{tenant_slug}/{project_slug}/{version_slug}"


def arazzo_export(tenant_slug: str, project_slug: str, version_slug: str) -> str:
    return f"{V1}/arazzo/{tenant_slug}/{project_slug}/{version_slug}"


def json_export(tenant_slug: str, project_slug: str, version_slug: str) -> str:
    return f"{V1}/json/{tenant_slug}/{project_slug}/{version_slug}"
