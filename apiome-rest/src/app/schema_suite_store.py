"""Persistence for saved schema test suites — IXH-5.7 (#5119).

:mod:`app.schema_suite_service` defines what a suite *is* and how a run is judged; this module
is the only place one is read or written. It sits between the service and the four
``apiome.schema_test_suite*`` tables (apiome-db V240) so every caller meets the store through
one door with the invariants applied once.

What that door enforces
-----------------------

**Identifiers are guarded before they reach the driver.** Every id is checked for UUID shape
first (the columns are UUID-typed, and the tests run against a live Postgres), so a garbage id
reads as "not found" instead of surfacing an opaque ``InvalidTextRepresentation``.

**A duplicate name is a conflict, not a stack trace.** The ``UNIQUE (tenant_id, name)``
violation is caught here and re-raised as :class:`SuiteNameConflictError`, so the route can
answer 409 with the name that collided.

**Reads degrade, writes do not.** A driver fault during a read (listing suites for a badge,
loading history) logs and returns empty — the surfaces those reads feed must not take a page
down with them. A fault during a write propagates: the caller asked for a mutation and must
learn it did not happen.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import psycopg2
import psycopg2.errors

from .config import settings
from .database import db

logger = logging.getLogger(__name__)

__all__ = [
    "SuiteNameConflictError",
    "create_suite",
    "delete_suite",
    "get_run",
    "get_suite",
    "insert_run",
    "latest_completed_run",
    "list_run_results",
    "list_runs",
    "list_suites",
    "prune_schema_suite_runs",
    "prune_runs_over_cap",
    "replace_payloads",
    "update_suite_meta",
]


class SuiteNameConflictError(Exception):
    """A suite with this name already exists for the tenant (maps to HTTP 409)."""

    def __init__(self, name: str) -> None:
        super().__init__(f"A test suite named {name!r} already exists for this tenant.")
        self.name = name


def create_suite(
    *,
    tenant_id: str,
    name: str,
    description: Optional[str],
    ref_kind: str,
    ref_artifact: str,
    ref_artifact_id: Optional[str],
    ref_type: Optional[str],
    payloads: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Insert a suite and its payloads atomically.

    Args:
        tenant_id: Owning tenant.
        name: Suite name, unique per tenant.
        description: Optional description.
        ref_kind: ``project`` | ``catalog``.
        ref_artifact: Artifact segment of the stable reference.
        ref_artifact_id: Best-effort resolved artifact id, or ``None``.
        ref_type: Optional type segment.
        payloads: Payload dicts (see :meth:`app.database.Database.create_schema_test_suite`).

    Returns:
        The inserted suite row, or ``None`` when the tenant id is malformed.

    Raises:
        SuiteNameConflictError: When the tenant already has a suite with this name.
    """
    try:
        return db.create_schema_test_suite(
            tenant_id=tenant_id,
            name=name,
            description=description,
            ref_kind=ref_kind,
            ref_artifact=ref_artifact,
            ref_artifact_id=ref_artifact_id,
            ref_type=ref_type,
            payloads=payloads,
        )
    except psycopg2.errors.UniqueViolation as exc:
        raise SuiteNameConflictError(name) from exc


def list_suites(
    tenant_id: str,
    *,
    ref_kind: Optional[str] = None,
    ref_artifact: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Suites for a tenant with their newest run summary; degrades to ``[]`` on a DB fault."""
    try:
        return db.list_schema_test_suites(
            tenant_id, ref_kind=ref_kind, ref_artifact=ref_artifact
        )
    except psycopg2.Error:
        logger.exception("Listing schema test suites failed; returning none")
        return []


def get_suite(tenant_id: str, suite_id: str) -> Optional[Dict[str, Any]]:
    """One suite row, or ``None`` when absent, malformed, or unreadable."""
    try:
        return db.get_schema_test_suite(tenant_id, suite_id)
    except psycopg2.Error:
        logger.exception("Loading schema test suite %s failed", suite_id)
        return None


def list_payloads(tenant_id: str, suite_id: str) -> List[Dict[str, Any]]:
    """A suite's payloads in execution order; degrades to ``[]`` on a DB fault."""
    try:
        return db.list_schema_test_suite_payloads(tenant_id, suite_id)
    except psycopg2.Error:
        logger.exception("Loading payloads for suite %s failed", suite_id)
        return []


def update_suite_meta(
    tenant_id: str,
    suite_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    clear_description: bool = False,
) -> Optional[Dict[str, Any]]:
    """Rename or re-describe a suite.

    Raises:
        SuiteNameConflictError: When renaming to a name another suite already holds.
    """
    try:
        return db.update_schema_test_suite_meta(
            tenant_id,
            suite_id,
            name=name,
            description=description,
            clear_description=clear_description,
        )
    except psycopg2.errors.UniqueViolation as exc:
        raise SuiteNameConflictError(name or "") from exc


def delete_suite(tenant_id: str, suite_id: str) -> bool:
    """Delete a suite (payloads/runs/results CASCADE). Returns whether a row was removed."""
    return db.delete_schema_test_suite(tenant_id, suite_id) > 0


def replace_payloads(
    tenant_id: str, suite_id: str, payloads: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Replace a suite's payload set, bumping ``suite_version``. ``None`` when not found."""
    return db.replace_schema_test_suite_payloads(tenant_id, suite_id, payloads)


def latest_completed_run(tenant_id: str, suite_id: str) -> Optional[Dict[str, Any]]:
    """The newest completed run — the regression baseline; ``None`` on absence or fault."""
    try:
        return db.get_latest_completed_schema_suite_run(tenant_id, suite_id)
    except psycopg2.Error:
        logger.exception("Loading baseline run for suite %s failed", suite_id)
        return None


def insert_run(**kwargs: Any) -> Optional[Dict[str, Any]]:
    """Insert a run plus results atomically, then prune that suite's history over the cap.

    Accepts :meth:`app.database.Database.insert_schema_test_suite_run` keyword arguments.
    The prune is best-effort: the run is already durable, so a prune fault only logs.
    """
    run = db.insert_schema_test_suite_run(**kwargs)
    if run is not None:
        prune_runs_over_cap(str(run["suite_id"]))
    return run


def prune_runs_over_cap(suite_id: str) -> int:
    """Prune one suite's oldest runs beyond ``schema_suite_run_max_per_suite`` (best-effort)."""
    cap = settings.schema_suite_run_max_per_suite
    if cap <= 0:
        return 0
    try:
        return db.prune_schema_suite_runs_over_cap(suite_id, cap)
    except psycopg2.Error:
        logger.exception("Pruning runs over cap for suite %s failed", suite_id)
        return 0


def list_runs(
    tenant_id: str, suite_id: str, *, limit: int = 20, offset: int = 0
) -> List[Dict[str, Any]]:
    """A suite's run history, newest first; degrades to ``[]`` on a DB fault."""
    try:
        return db.list_schema_test_suite_runs(tenant_id, suite_id, limit=limit, offset=offset)
    except psycopg2.Error:
        logger.exception("Listing runs for suite %s failed", suite_id)
        return []


def get_run(tenant_id: str, suite_id: str, run_id: str) -> Optional[Dict[str, Any]]:
    """One run row, or ``None`` when absent, malformed, or unreadable."""
    try:
        return db.get_schema_test_suite_run(tenant_id, suite_id, run_id)
    except psycopg2.Error:
        logger.exception("Loading run %s failed", run_id)
        return None


def list_run_results(run_id: str) -> List[Dict[str, Any]]:
    """A run's per-payload results in payload order; degrades to ``[]`` on a DB fault."""
    try:
        return db.list_schema_suite_run_results(run_id)
    except psycopg2.Error:
        logger.exception("Loading results for run %s failed", run_id)
        return []


def prune_schema_suite_runs(
    database: Any = None,
    *,
    now: Optional[datetime] = None,
    retention_days: Optional[int] = None,
    keep_min: Optional[int] = None,
) -> int:
    """Prune suite runs by age — the IXH-6.3 sweep hook.

    Deletes runs older than the retention window while always keeping each suite's newest
    ``keep_min`` (so a rarely-run suite never loses its regression baseline). A window of 0
    or below disables the age prune entirely.

    Args:
        database: The database handle (defaults to the module-level ``db``; the sweep passes
            its own, matching the other prune hooks' signature).
        now: The sweep's clock, defaulting to :func:`datetime.now`.
        retention_days: Override for ``schema_suite_run_retention_days``.
        keep_min: Override for ``schema_suite_run_keep_min``.

    Returns:
        The number of runs deleted (0 on fault — the sweep must survive a bad tick).
    """
    handle = database if database is not None else db
    days = settings.schema_suite_run_retention_days if retention_days is None else retention_days
    if days <= 0:
        return 0
    immune = settings.schema_suite_run_keep_min if keep_min is None else keep_min
    clock = now or datetime.now(timezone.utc)
    try:
        return handle.prune_schema_suite_runs_by_age(
            clock - timedelta(days=days), max(0, int(immune))
        )
    except Exception:  # noqa: BLE001 - the sweep must survive a bad tick and retry
        logger.exception("Age-pruning schema suite runs failed; will retry next tick")
        return 0
