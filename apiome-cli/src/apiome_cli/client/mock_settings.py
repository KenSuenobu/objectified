"""Hosted-mock settings client helpers and output for ``apiome mock`` (SIM-2.4).

The CLI mirrors the SIM-2.1 REST control plane: the mock flag lives on the
version record (``VersionSchema.mockEnabled`` / ``mockBaseUrl``), the toggle is
``PUT /v1/versions/{tenant}/{project}/{version_record_id}/mock``, and the
best-effort usage summary comes from ``GET /v1/mocks/{tenant}/usage`` (SIM-1.5).

The configuration surface (#5530, MSC-1.4) lives here too rather than in a client of its own,
because it addresses the same version and the same routes: ``mock config pull`` reads the three
mock-settings routes, ``push`` writes them, and ``preview`` posts to the MSC-1.2 dry-run render.
Validation is never duplicated on this side — every push is validated by the server first, through
the ``?dryRun=true`` branch of the very routes that would store it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlencode
from uuid import UUID

import httpx
import typer

from apiome_cli.client import api_paths
from apiome_cli.client.errors import exit_on_api_error
from apiome_cli.client.http import RestClient
from apiome_cli.mock_config import ConfigError, build_document, locate_errors
from apiome_cli.output import RecordField, emit_json, emit_record_table


def _format_optional(value: Any) -> str:
    """Render an optional scalar cell, showing booleans as ``True``/``False``."""
    return "" if value is None else str(value)


# Field rows for the version-record table printed by status/enable/disable.
MOCK_RECORD_FIELDS: tuple[RecordField, ...] = (
    ("ID", "id", None),
    ("Project ID", "project_id", None),
    ("Version", "version_id", None),
    ("Published", "published", _format_optional),
    ("Mock Enabled", "mockEnabled", _format_optional),
    ("Mock Base URL", "mockBaseUrl", _format_optional),
)


def fetch_version_record(
    client: RestClient,
    tenant_slug: str,
    project_id: UUID,
    version_id: UUID,
) -> dict[str, Any]:
    """Fetch one version record (``GET /v1/versions/{tenant}/{project}/{id}``).

    Parameters
    ----------
    client:
        Authenticated REST client.
    tenant_slug:
        Tenant scope for the route.
    project_id:
        Parent project UUID.
    version_id:
        Version record UUID.

    Returns
    -------
    dict[str, Any]
        The ``VersionSchema`` payload (``mockEnabled``, ``mockBaseUrl``, …);
        exits the CLI on HTTP or transport errors.
    """
    payload = client.get(api_paths.version_record(tenant_slug, project_id, version_id)).json()
    return payload if isinstance(payload, dict) else {}


def set_version_mock(
    client: RestClient,
    tenant_slug: str,
    project_id: UUID,
    version_id: UUID,
    *,
    enabled: bool,
) -> dict[str, Any]:
    """Enable or disable the hosted mock (``PUT …/mock``, SIM-2.1).

    Parameters
    ----------
    client:
        Authenticated REST client.
    tenant_slug:
        Tenant scope for the route.
    project_id:
        Parent project UUID.
    version_id:
        Version record UUID.
    enabled:
        ``True`` to enable the mock, ``False`` to disable it.

    Returns
    -------
    dict[str, Any]
        The updated ``VersionSchema`` payload. REST eligibility errors (draft
        version, insufficient role) exit the CLI with a readable message and a
        non-zero exit code via the shared error mapping.
    """
    response = client.put(
        api_paths.version_mock(tenant_slug, project_id, version_id),
        json={"enabled": enabled},
    )
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def fetch_project_slug(
    client: RestClient,
    tenant_slug: str,
    project_id: UUID,
) -> str:
    """Best-effort lookup of a project's slug for usage filtering.

    Returns an empty string instead of failing so a usage-summary lookup never
    breaks ``mock status`` — usage is optional decoration on the status output.
    """
    response = client.get_raw(api_paths.project(tenant_slug, project_id))
    if not response.is_success:
        return ""
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(payload, dict):
        return ""
    slug = payload.get("slug")
    return slug if isinstance(slug, str) else ""


def fetch_mock_usage(
    client: RestClient,
    tenant_slug: str,
    *,
    project_slug: str,
    version_label: str,
    days: int,
) -> dict[str, Any] | None:
    """Best-effort mock usage summary (``GET /v1/mocks/{tenant}/usage``, SIM-1.5).

    Parameters
    ----------
    client:
        Authenticated REST client.
    tenant_slug:
        Tenant scope for the route.
    project_slug:
        Filters the daily rollups to one project.
    version_label:
        Filters the daily rollups to one version label (e.g. ``1.0.0``).
    days:
        Rollup window in days.

    Returns
    -------
    dict[str, Any] | None
        The ``MockUsageResponse`` payload, or ``None`` when usage is
        unavailable (mock server disabled, older REST service, or a
        malformed body). Never exits the CLI: the issue scope treats usage
        as "when available" data.
    """
    query = urlencode(
        {"days": days, "project_slug": project_slug, "version_label": version_label}
    )
    response = client.get_raw(f"{api_paths.mock_usage(tenant_slug)}?{query}")
    if not response.is_success:
        return None
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def version_usage_request_count(usage: dict[str, Any]) -> int:
    """Sum the filtered daily rollup request counts for one version."""
    rollups = usage.get("dailyRollups")
    if not isinstance(rollups, list):
        return 0
    total = 0
    for rollup in rollups:
        if isinstance(rollup, dict) and isinstance(rollup.get("requestCount"), int):
            total += rollup["requestCount"]
    return total


def emit_mock_status(
    record: dict[str, Any],
    usage: dict[str, Any] | None,
    *,
    days: int,
    json_mode: bool,
) -> None:
    """Print the mock status for one version (human table or stable JSON).

    Parameters
    ----------
    record:
        The raw ``VersionSchema`` payload for the version.
    usage:
        The raw ``MockUsageResponse`` payload, or ``None`` when unavailable.
    days:
        Usage window used for the rollup heading.
    json_mode:
        When ``True`` emit ``{"version": <VersionSchema>, "usage":
        <MockUsageResponse|null>}`` on stdout — a stable envelope of raw API
        payloads for scripting.
    """
    if json_mode:
        emit_json({"version": record, "usage": usage})
        return

    emit_record_table(record, MOCK_RECORD_FIELDS)
    if usage is None:
        return

    typer.echo(f"Usage (last {days} days):")
    typer.echo(f"  Requests (this version): {version_usage_request_count(usage)}")
    monthly = usage.get("monthlyRequestCount")
    quota = usage.get("monthlyQuota")
    if isinstance(monthly, int) and isinstance(quota, int):
        typer.echo(f"  Tenant monthly usage: {monthly} / {quota}")
    rps = usage.get("mockRps")
    if isinstance(rps, (int, float)):
        typer.echo(f"  Rate limit: {rps} rps")


def emit_mock_toggle_result(record: dict[str, Any], *, json_mode: bool) -> None:
    """Print the updated version record after an enable/disable toggle."""
    if json_mode:
        emit_json(record)
        return
    emit_record_table(record, MOCK_RECORD_FIELDS)


# ---------------------------------------------------------------------------
# Mock configuration documents (#5530, MSC-1.4)
# ---------------------------------------------------------------------------

#: The three write routes a configuration document is applied through, in the order ``push``
#: applies them, each paired with the sections it carries and the request body it takes. The
#: scenarios route owns three sections because the server stores and validates them together — an
#: ``activeScenario`` is only meaningful against the scenarios saved with it (#5531, MSC-2.1).
_PUSH_ROUTES: tuple[tuple[tuple[str, ...], Callable[..., str], Callable[[Mapping[str, Any]], dict[str, Any]]], ...] = (
    (
        ("scenarios", "activeScenario", "chaos"),
        api_paths.version_mock_scenarios,
        lambda document: {
            "scenarios": document.get("scenarios") or {},
            "chaos": document.get("chaos"),
            # Always sent, never omitted: the route keeps the stored value for a caller that omits
            # the field, and a whole-document push must clear what the file leaves out.
            "activeScenario": document.get("activeScenario"),
        },
    ),
    (
        ("correlation",),
        api_paths.version_mock_correlation,
        lambda document: {"correlation": document.get("correlation")},
    ),
    (
        ("fixturePacks",),
        api_paths.version_mock_fixture_packs,
        lambda document: {"packs": document.get("fixturePacks") or {}},
    ),
)


@dataclass(frozen=True)
class SectionResult:
    """The server's verdict on one write route's worth of a configuration document.

    Attributes:
        sections: The document sections this route carries.
        errors: The validation errors it reported, already placed at their document paths.
    """

    sections: tuple[str, ...]
    errors: tuple[ConfigError, ...]

    @property
    def ok(self) -> bool:
        """Whether the server accepted this part of the document."""
        return not self.errors


@dataclass(frozen=True)
class PushOutcome:
    """What a push (or a ``--dry-run`` validation) found and did.

    Attributes:
        results: One entry per write route, in the order they were checked.
        applied: Whether the document was actually written.
    """

    results: tuple[SectionResult, ...]
    applied: bool

    @property
    def errors(self) -> tuple[ConfigError, ...]:
        """Every validation error, across every section, in the order reported."""
        return tuple(error for result in self.results for error in result.errors)

    @property
    def valid(self) -> bool:
        """Whether the whole document validates."""
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        """Render the outcome for ``--json`` output."""
        return {
            "valid": self.valid,
            "applied": self.applied,
            "errors": [error.as_dict() for error in self.errors],
        }


def _rejection_errors(response: httpx.Response) -> list[ConfigError] | None:
    """Extract a validation error list from a rejected mock-settings response.

    A mock-settings route reports a failed document as ``422`` with
    ``{"message": …, "errors": [sentence, …]}``; FastAPI reports a malformed *body* as a ``422``
    whose detail is a list of its own error objects. Both are the caller's file being wrong, so
    both are rendered against the file rather than mapped through the shared HTTP error surface.

    Args:
        response: The raw response.

    Returns:
        The located errors, or ``None`` when this is not a document rejection (the caller should
        fall back to the shared error mapping).
    """
    if response.status_code != 422:
        return None
    try:
        detail = response.json().get("detail")
    except (json.JSONDecodeError, ValueError, AttributeError):
        return None
    if isinstance(detail, dict) and isinstance(detail.get("errors"), list):
        return locate_errors(detail["errors"])
    if isinstance(detail, list):
        return locate_errors(detail)
    if isinstance(detail, str):
        return locate_errors([detail])
    return None


def fetch_mock_config(
    client: RestClient,
    tenant_slug: str,
    project_id: UUID,
    version_id: UUID,
) -> dict[str, Any]:
    """Read a version's whole mock configuration as one document (#5530, MSC-1.4).

    Three reads, because the control plane stores the settings under three routes; one document,
    because that is what a reviewer wants to look at. Nothing is reshaped: the sections are the
    server's canonical form verbatim, so pushing the document back is a no-op.

    Args:
        client: Authenticated REST client.
        tenant_slug: Tenant scope for the routes.
        project_id: Parent project UUID.
        version_id: Version record UUID.

    Returns:
        The configuration document; exits the CLI on HTTP or transport errors.
    """
    scenarios_payload = client.get(
        api_paths.version_mock_scenarios(tenant_slug, project_id, version_id)
    ).json()
    correlation_payload = client.get(
        api_paths.version_mock_correlation(tenant_slug, project_id, version_id)
    ).json()
    packs_payload = client.get(
        api_paths.version_mock_fixture_packs(tenant_slug, project_id, version_id)
    ).json()

    scenarios = scenarios_payload if isinstance(scenarios_payload, dict) else {}
    correlation = correlation_payload if isinstance(correlation_payload, dict) else {}
    packs = packs_payload if isinstance(packs_payload, dict) else {}
    return build_document(
        correlation=correlation.get("correlation"),
        scenarios=scenarios.get("scenarios") or {},
        chaos=scenarios.get("chaos"),
        # ``digests`` are derived from the packs and are reported alongside them; they are not
        # settings, so they never enter a document that gets pushed back.
        fixture_packs=packs.get("packs") or {},
        active_scenario=scenarios.get("activeScenario"),
    )


def push_mock_config(
    client: RestClient,
    tenant_slug: str,
    project_id: UUID,
    version_id: UUID,
    *,
    document: Mapping[str, Any],
    dry_run: bool,
) -> PushOutcome:
    """Validate a configuration document server-side and, unless dry-running, apply it.

    Every push validates first — all three routes, with ``?dryRun=true`` — and only then writes.
    That is what makes a rejected document leave the version untouched: a scenario block accepted
    while a correlation block is refused would otherwise leave the mock half-configured, and it is
    also the only way to report *every* problem in the file at once rather than the first one.

    Args:
        client: Authenticated REST client.
        tenant_slug: Tenant scope for the routes.
        project_id: Parent project UUID.
        version_id: Version record UUID.
        document: The parsed configuration document.
        dry_run: Validate and report without writing anything.

    Returns:
        The outcome. A rejected document yields ``valid=False`` and never writes.
    """
    results: list[SectionResult] = []
    for sections, path_for, body_for in _PUSH_ROUTES:
        path = path_for(tenant_slug, project_id, version_id)
        response = client.put_raw(f"{path}?dryRun=true", json=body_for(document))
        errors = _rejection_errors(response)
        if errors is None:
            exit_on_api_error(response)
            errors = []
        results.append(SectionResult(sections, tuple(errors)))

    outcome = PushOutcome(tuple(results), applied=False)
    if dry_run or not outcome.valid:
        return outcome

    written: list[str] = []
    for sections, path_for, body_for in _PUSH_ROUTES:
        try:
            client.put(path_for(tenant_slug, project_id, version_id), json=body_for(document))
        except typer.Exit:
            # Validation already passed for every section, so reaching here means the write itself
            # failed — the version's ownership gate, or the service. The caller is about to see the
            # server's own message; what only this loop knows is how far it got, and leaving that
            # unsaid would send someone to re-run a push without knowing what is already stored.
            if written:
                typer.secho(
                    f"Already applied before the failure: {', '.join(written)}. "
                    "Re-run the push once the cause is fixed.",
                    err=True,
                    fg="yellow",
                )
            raise
        written.extend(sections)
    return PushOutcome(tuple(results), applied=True)


def request_hosted_preview(
    client: RestClient,
    tenant_slug: str,
    project_id: UUID,
    version_id: UUID,
    *,
    request: Mapping[str, Any],
    settings: Mapping[str, Any] | None,
) -> tuple[dict[str, Any] | None, Sequence[ConfigError]]:
    """Render one synthetic request against the version's mock (``POST …/mock/preview``, MSC-1.2).

    Args:
        client: Authenticated REST client.
        tenant_slug: Tenant scope for the route.
        project_id: Parent project UUID.
        version_id: Version record UUID.
        request: The synthetic request.
        settings: An unsaved configuration to render against instead of the stored one, or
            ``None`` to preview what is stored.

    Returns:
        ``(result, errors)``. When a supplied draft configuration fails validation the result is
        ``None`` and the errors are placed against the document's own paths; every other failure
        exits the CLI through the shared HTTP error mapping.
    """
    payload: dict[str, Any] = {"request": dict(request)}
    if settings is not None:
        payload["settings"] = dict(settings)
    response = client.post_raw(
        api_paths.version_mock_preview(tenant_slug, project_id, version_id),
        json=payload,
    )
    errors = _rejection_errors(response)
    if errors:
        return None, errors
    exit_on_api_error(response)
    result = response.json()
    return (result if isinstance(result, dict) else {}), ()
