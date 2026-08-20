"""Health, readiness, and the minimal ops dashboard (RC1-3.2, #3617).

Two planes of endpoints:

* **Probes** (unauthenticated, used by compose/deploy orchestration):
    - ``GET /livez``  — liveness: the process is up and serving. Never touches the database, so a
      transient DB outage does not get the container killed.
    - ``GET /readyz`` — readiness: dependencies (the database) are reachable. Returns 503 when not,
      so a load balancer / ``depends_on … condition: service_healthy`` holds traffic until ready.
    - ``GET /health`` — retained for backward compatibility (existing compose healthcheck); behaves
      like readiness, and additionally reports the **bundled-toolchain** verdict (FMT-1.3): which
      hard-required tools resolved and the version each reported, so a deployment that lost a
      shipped format is visible without an authenticated call.

* **Ops dashboard** (platform-admin only — it exposes operational internals and backup metadata):
    - ``GET /v1/ops/metrics``  — request rate, error rate, latency percentiles, uptime, in-flight.
    - ``GET /v1/ops/backups``  — latest backup status read from RC1-1.3 manifests.
    - ``GET /v1/ops/status``   — combined metrics + backup status (one call for the dashboard).
    - ``GET /v1/ops/dashboard``— a tiny self-contained HTML view of the above.
    - ``GET /v1/ops/toolchain``— bundled tool packaging/availability (MFI-5.2, #3751) plus the
      active sandbox posture every tool runs under (MFI-5.3, #3752) and, per gated tool, the
      formats it gates and whether it is a hard dependency (FMT-1.3, #5414).
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .analysis_telemetry import analysis_telemetry
from .auth import validate_authentication
from .backup_status import collect_backup_status
from .config import settings
from .database import db
from .import_export_metrics import import_export_metrics
from .observability import metrics
from .permissions import enforce_platform_admin
from .toolchain_packaging import probe_all, verify_tool
from .toolchain_runner import default_runner
from .toolchain_selfcheck import (
    REQUIRED_TOOL_KEYS,
    latest_toolchain_selfcheck,
    run_toolchain_selfcheck,
    toolchain_health_detail,
)

# Liveness/readiness probes live at the root (no /v1 prefix) so orchestration health checks stay
# stable and unauthenticated.
health_router = APIRouter(tags=["ops"])
# The dashboard plane is platform-admin gated.
ops_router = APIRouter(prefix="/v1/ops", tags=["ops"])


@health_router.get("/livez")
async def liveness() -> JSONResponse:
    """Liveness probe: confirms the process is up. Deliberately does not check the database."""
    return JSONResponse(content={"status": "alive"})


def _readiness_payload() -> tuple[int, Dict[str, Any]]:
    """Shared readiness check: report DB reachability with an appropriate status code."""
    try:
        # A trivial round-trip proves the connection is actually usable, not merely opened.
        db.execute_query("SELECT 1 AS ok")
        return 200, {"status": "ready", "database": "connected"}
    except Exception as exc:  # noqa: BLE001 - report any failure as not-ready
        return 503, {"status": "not_ready", "database": "unavailable", "error": str(exc)}


@health_router.get("/readyz")
async def readiness() -> JSONResponse:
    """Readiness probe: 200 when the database is reachable, 503 otherwise."""
    status_code, payload = _readiness_payload()
    return JSONResponse(status_code=status_code, content=payload)


@health_router.get("/health")
async def health_check() -> JSONResponse:
    """Backward-compatible health endpoint (compose healthcheck). Equivalent to readiness.

    The ``status``/``database`` keys are unchanged. The response additionally carries a
    ``toolchain`` block (FMT-1.3) reporting the bundled-toolchain verdict this runtime booted
    with: ``status`` (``ok`` / ``degraded`` / ``failed``), whether the deployment ``enforced``
    the toolchain, how many hard-required tools there are, how many resolved, and the keys of
    any that are ``missing``. Availability only — resolved paths, the optional tools and the
    exact third-party versions stay on the platform-admin ``GET /v1/ops/toolchain``, because
    this endpoint is unauthenticated.

    The HTTP status reflects readiness only: an enforcing deployment cannot serve at all with a
    required tool missing (startup refuses), and a non-enforcing one is degraded deliberately.
    """
    status_code, payload = _readiness_payload()
    # Preserve the historical key shape while reporting the same readiness signal.
    body = {
        "status": "healthy" if status_code == 200 else "unhealthy",
        "database": payload["database"],
        # Bundled-toolchain verdict (FMT-1.3): the startup self-check's cached result, or a
        # resolution-only probe before startup ran one. Counts and missing keys only — no paths
        # and no third-party versions, which stay on the platform-admin ``/v1/ops/toolchain``.
        # The HTTP status is deliberately unchanged: an enforcing deployment never reaches here
        # with a missing tool (startup refuses), and a non-enforcing one is degraded on purpose,
        # not unready.
        "toolchain": toolchain_health_detail(),
    }
    if "error" in payload:
        body["error"] = payload["error"]
    return JSONResponse(status_code=status_code, content=body)


def _metrics_payload() -> Dict[str, Any]:
    """Render the in-process metrics snapshot as a plain dict."""
    snap = metrics.snapshot()
    return {
        "uptime_seconds": snap.uptime_seconds,
        "total_requests": snap.total_requests,
        "requests_per_second": snap.requests_per_second,
        "requests_by_status_class": snap.requests_by_status_class,
        "error_count": snap.error_count,
        "error_rate": snap.error_rate,
        "in_flight": snap.in_flight,
        "latency_ms": snap.latency_ms,
        # Catalog analysis guardrail counters (CPDO-4.2): analyzer completions/failures by
        # reason category, sensitive reads, page serves. Counts only — never payload content —
        # so the ops dashboard can reveal analyzer failures without seeing what was analysed.
        "catalog_analysis": analysis_telemetry.snapshot(),
        # Import/export pipeline observability (IXH-6.6): per-stage duration histograms and
        # byte totals, job totals by adapter/target×format×outcome, and failure counters by
        # taxonomy code. Closed-vocabulary tags only — never a tenant, job, or free-text tag.
        "import_export": import_export_metrics.snapshot(),
    }


def _backup_payload() -> Dict[str, Any]:
    """Render backup status from the configured manifest directory."""
    return collect_backup_status(
        settings.backup_dir,
        stale_after_hours=settings.backup_stale_after_hours,
    )


@ops_router.get("/metrics")
async def ops_metrics(auth_data: Dict[str, Any] = Depends(validate_authentication)) -> JSONResponse:
    """Operational request metrics (request rate, error rate, latency). Platform-admin only."""
    enforce_platform_admin(db, auth_data)
    return JSONResponse(content=_metrics_payload())


@ops_router.get("/import-export")
async def ops_import_export(
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> JSONResponse:
    """Import/export pipeline observability aggregates (IXH-6.6). Platform-admin only.

    The full operator view of the three metric families — per-stage duration histograms
    and byte totals, terminal job totals keyed by adapter/target × format × outcome, and
    failure counters keyed by the IXH-6.4 taxonomy code — plus the complete documented
    tag set every key is drawn from. Aggregates are in-process: per replica, reset on
    restart (same posture as ``/v1/ops/metrics``); durable per-job timing evidence lives
    in each job's ``PHASE_TIMING`` events in the shared job store.
    """
    enforce_platform_admin(db, auth_data)
    return JSONResponse(
        content={
            "import_export": import_export_metrics.snapshot(),
            "documented_tags": import_export_metrics.documented_tags(),
            "scope": {"per_replica": True, "resets_on_restart": True},
        }
    )


@ops_router.get("/backups")
async def ops_backups(auth_data: Dict[str, Any] = Depends(validate_authentication)) -> JSONResponse:
    """Latest backup status (from RC1-1.3 manifests). Platform-admin only."""
    enforce_platform_admin(db, auth_data)
    return JSONResponse(content=_backup_payload())


@ops_router.get("/status")
async def ops_status(auth_data: Dict[str, Any] = Depends(validate_authentication)) -> JSONResponse:
    """Combined metrics + backup status — one call backing the dashboard. Platform-admin only."""
    enforce_platform_admin(db, auth_data)
    return JSONResponse(content={"metrics": _metrics_payload(), "backups": _backup_payload()})


@ops_router.get("/toolchain")
async def ops_toolchain(
    verify: bool = Query(
        default=False,
        description="Also invoke each available tool's version probe to confirm it runs "
        "(slower — spawns one subprocess per available tool).",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> JSONResponse:
    """Bundled toolchain packaging & availability + sandbox posture. Platform-admin only.

    Reports every declared external tool (buf, tsp, smithy, drafter, amf, asyncapi, rover),
    its pinned version, and whether its binary resolves in this runtime — the "format
    unavailable" signal a missing tool produces (MFI-5.2). Each tool additionally carries
    ``required`` (is it a hard dependency of this runtime?) and ``gated_formats`` (which
    registered import/export formats vanish without it), so the answer to "what did this
    deployment lose?" is on the same response as "what is missing?" (FMT-1.3). With
    ``?verify=true`` each *available* tool is additionally invoked with its version probe to
    confirm it actually runs. The ``sandbox`` block reports the active security/resource posture
    (MFI-5.3) every tool subprocess runs under (no-network default, rlimit clamps, input/output
    caps).
    """
    enforce_platform_admin(db, auth_data)
    availability = probe_all()
    tools = [a.model_dump() for a in availability]
    by_key = {t["key"]: t for t in tools}

    # Per gated tool (FMT-1.3): whether it is a hard dependency of this runtime and which
    # registered formats disappear without it. The startup self-check already computed both, so
    # reuse its cached verdict rather than walking the registries again; before startup has run
    # one (a bare TestClient), fall back to a resolution-only pass so the fields are still there.
    selfcheck = latest_toolchain_selfcheck()
    if selfcheck is None:
        selfcheck = await run_toolchain_selfcheck(verify=False)
    for status in selfcheck.tools:
        entry = by_key.get(status.key)
        if entry is None:
            continue
        entry["required"] = status.required
        entry["gated_formats"] = list(status.gated_formats)
        if status.reported_version is not None:
            entry["reported_version"] = status.reported_version

    if verify:
        # Only bother spawning version probes for tools that resolve; an unavailable tool is
        # already known to be non-invocable.
        for entry in availability:
            if not entry.available:
                continue
            report = await verify_tool(entry.key)
            if report is not None:
                by_key[entry.key]["verification"] = report.model_dump()
    summary = {
        "total": len(tools),
        "available": sum(1 for t in tools if t["available"]),
        "unavailable": sum(1 for t in tools if not t["available"]),
        # The hard-dependency slice: what a missing entry here costs is a shipped format, not a
        # degraded one, so it is summarized separately from the optional tools.
        "required": len(REQUIRED_TOOL_KEYS),
        "required_missing": list(selfcheck.missing_required),
        "toolchain_status": selfcheck.status,
        "enforced": selfcheck.enforced,
    }
    # Surface the active sandbox posture (MFI-5.3) every tool subprocess runs under.
    sandbox = default_runner.default_policy.describe()
    return JSONResponse(content={"summary": summary, "sandbox": sandbox, "tools": tools})


@ops_router.get("/dashboard", response_class=HTMLResponse)
async def ops_dashboard(
    request: Request,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> HTMLResponse:
    """A minimal, self-contained HTML ops dashboard. Platform-admin only.

    The page server-renders the current metrics + backup status and polls ``/v1/ops/status`` for
    live refresh. It is intentionally dependency-free (no external JS/CSS) so it works in locked-down
    environments and never reaches out to a CDN.
    """
    enforce_platform_admin(db, auth_data)
    snapshot = {"metrics": _metrics_payload(), "backups": _backup_payload()}
    return HTMLResponse(content=_render_dashboard_html(snapshot, settings.request_id_header))


def _render_dashboard_html(snapshot: Dict[str, Any], request_id_header: str) -> str:
    """Render the minimal dashboard HTML. Kept inline to avoid a templating dependency."""
    import html
    import json

    initial = html.escape(json.dumps(snapshot))
    rid_header = html.escape(request_id_header)
    # The client-side script re-renders from JSON it fetches; all dynamic values go through
    # textContent (never innerHTML) so backup ids / error strings cannot inject markup.
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apiome — Ops Dashboard</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; background: #0f172a; color: #e2e8f0; }}
  h1 {{ font-size: 1.25rem; margin: 0 0 1rem; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }}
  .card {{ background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1rem; }}
  .card h2 {{ font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em;
              color: #94a3b8; margin: 0 0 0.5rem; }}
  .metric {{ font-size: 1.75rem; font-weight: 600; }}
  .row {{ display: flex; justify-content: space-between; padding: 0.15rem 0; font-size: 0.9rem; }}
  .row span:first-child {{ color: #94a3b8; }}
  .badge {{ display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
            font-size: 0.75rem; font-weight: 600; }}
  .ok {{ background: #14532d; color: #bbf7d0; }}
  .warn {{ background: #713f12; color: #fde68a; }}
  .bad {{ background: #7f1d1d; color: #fecaca; }}
  footer {{ margin-top: 1.5rem; font-size: 0.75rem; color: #64748b; }}
</style>
</head>
<body>
  <h1>Apiome — Ops Dashboard</h1>
  <div class="grid" id="cards"></div>
  <footer>Auto-refreshes every 5s · request id header: <code>{rid_header}</code></footer>
<script>
  const INITIAL = JSON.parse("{initial}"
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));
  function badgeClass(status) {{
    if (status === 'ok' || status === 'ready' || status === 'alive') return 'ok';
    if (status === 'stale' || status === 'empty' || status === 'unconfigured') return 'warn';
    return 'bad';
  }}
  function card(title, bodyNodes) {{
    const c = document.createElement('div'); c.className = 'card';
    const h = document.createElement('h2'); h.textContent = title; c.appendChild(h);
    bodyNodes.forEach(n => c.appendChild(n)); return c;
  }}
  function row(label, value) {{
    const r = document.createElement('div'); r.className = 'row';
    const a = document.createElement('span'); a.textContent = label;
    const b = document.createElement('span'); b.textContent = value;
    r.appendChild(a); r.appendChild(b); return r;
  }}
  function bigMetric(value) {{
    const d = document.createElement('div'); d.className = 'metric'; d.textContent = value; return d;
  }}
  function render(data) {{
    const m = data.metrics || {{}}, b = data.backups || {{}}, lat = m.latency_ms || {{}};
    const cards = document.getElementById('cards'); cards.textContent = '';
    cards.appendChild(card('Requests', [bigMetric(m.total_requests ?? 0),
      row('per second', (m.requests_per_second ?? 0).toFixed(2)), row('in flight', m.in_flight ?? 0)]));
    cards.appendChild(card('Errors (5xx)', [bigMetric(((m.error_rate ?? 0) * 100).toFixed(2) + '%'),
      row('count', m.error_count ?? 0)]));
    cards.appendChild(card('Latency (ms)', [row('p50', lat.p50 ?? 0), row('p95', lat.p95 ?? 0),
      row('p99', lat.p99 ?? 0), row('max', lat.max ?? 0)]));
    const backupNodes = [];
    const badge = document.createElement('span');
    badge.className = 'badge ' + badgeClass(b.status); badge.textContent = b.status || 'unknown';
    backupNodes.push(badge);
    backupNodes.push(row('count', b.backup_count ?? 0));
    if (b.latest_age_seconds != null) backupNodes.push(row('latest age (h)', (b.latest_age_seconds / 3600).toFixed(1)));
    if (b.latest && b.latest.created_at) backupNodes.push(row('latest', b.latest.created_at));
    cards.appendChild(card('Backups', backupNodes));
    cards.appendChild(card('Uptime', [bigMetric(Math.round((m.uptime_seconds ?? 0)) + 's')]));
    // Import/export pipeline aggregates (IXH-6.6): job counts by kind and outcome, byte
    // totals, and the top failure codes. All values via textContent, like every card above.
    const ie = m.import_export || {{}};
    const jobNodes = [];
    let jobTotal = 0;
    for (const kind of ['import', 'export']) {{
      const outcomes = {{}};
      let bytesIn = 0, bytesOut = 0;
      for (const byFormat of Object.values((ie.jobs || {{}})[kind] || {{}})) {{
        for (const byOutcome of Object.values(byFormat)) {{
          for (const [outcome, cell] of Object.entries(byOutcome)) {{
            outcomes[outcome] = (outcomes[outcome] || 0) + (cell.count || 0);
            jobTotal += cell.count || 0;
            bytesIn += cell.bytes_in_total || 0;
            bytesOut += cell.bytes_out_total || 0;
          }}
        }}
      }}
      for (const [outcome, count] of Object.entries(outcomes)) {{
        jobNodes.push(row(kind + ' ' + outcome, count));
      }}
      if (bytesIn) jobNodes.push(row(kind + ' bytes in', bytesIn));
      if (bytesOut) jobNodes.push(row(kind + ' bytes out', bytesOut));
    }}
    cards.appendChild(card('Import/Export jobs', [bigMetric(jobTotal), ...jobNodes]));
    const failNodes = [];
    const failCounts = [];
    for (const kind of ['import', 'export']) {{
      for (const [code, byAdapter] of Object.entries((ie.failures || {{}})[kind] || {{}})) {{
        const total = Object.values(byAdapter).reduce((a, b) => a + b, 0);
        failCounts.push([kind + ' ' + code, total]);
      }}
    }}
    failCounts.sort((a, b) => b[1] - a[1]);
    for (const [label, total] of failCounts.slice(0, 8)) failNodes.push(row(label, total));
    const failTotal = failCounts.reduce((a, [, n]) => a + n, 0);
    cards.appendChild(card('Import/Export failures', [bigMetric(failTotal), ...failNodes]));
  }}
  render(INITIAL);
  async function refresh() {{
    try {{ const r = await fetch('/v1/ops/status', {{ headers: {{ 'Accept': 'application/json' }} }});
      if (r.ok) render(await r.json()); }} catch (e) {{ /* keep last good render */ }}
  }}
  setInterval(refresh, 5000);
</script>
</body>
</html>
"""
