"""Bundled-toolchain startup self-check — FMT-1.3 (#5414).

MFI-5.2 (:mod:`app.toolchain_packaging`) made every bundled CLI *optional by construction*:
an absent binary is reported as ``available: false`` and the format that needs it degrades to
"unavailable". That posture is right for the tools that gate a niche format, and wrong for the
one tool that gates a **headline shipped format**: ``asyncapi-parser``. Without it the AsyncAPI
adapter — a format the product advertises, documents and ships fixtures for — silently vanishes
from a deployment, and nothing says so until a user tries to import an event-driven API.

This module draws the line. It declares which bundled tools are **hard dependencies**
(:data:`REQUIRED_TOOL_KEYS`), runs a self-check at startup that resolves *and actually invokes*
each of them, logs the version it resolved, and — when enforcement is on — refuses to start
rather than serving a runtime that quietly lost a format. Everything it learns is cached so the
health surface can report it without paying for another subprocess.

The policy, in one line: **a required tool that is missing fails loudly; every other bundled
tool stays optional and degrades exactly as before.**

What lives here:

* :data:`REQUIRED_TOOL_KEYS` — the hard-dependency set. Adding a key here makes that tool's
  absence a startup failure in an enforcing deployment; it is deliberately short.
* :class:`ToolchainToolStatus` / :class:`ToolchainSelfCheck` — the serializable result, carrying
  per-tool availability, the *reported* version (from the tool's own ``--version`` probe), the
  pinned version it should be, and which registered formats each tool gates.
* :func:`run_toolchain_selfcheck` — run the check (probe every bundled tool; invoke the required
  ones).
* :func:`enforce_toolchain_selfcheck` — the startup entry point: run, log, and raise
  :class:`ToolchainUnavailableError` when a required tool is missing and enforcement is on.
* :func:`latest_toolchain_selfcheck` / :func:`toolchain_health_detail` — the cached result and
  the compact block ``GET /health`` reports.

Enforcement is controlled by ``APIOME_REQUIRE_TOOLCHAIN`` (see
:attr:`app.config.Settings.enforce_bundled_toolchain`): unset it follows the deployment
environment, so a container fails loudly while a developer laptop keeps working with a warning.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .config import settings
from .toolchain_packaging import BUNDLED_TOOLS, bundled_tool, probe_tool, verify_tool

logger = logging.getLogger(__name__)

__all__ = [
    "REQUIRED_NPM_PACKAGES",
    "REQUIRED_TOOL_KEYS",
    "TOOLCHAIN_MANIFEST_PATH",
    "ToolchainSelfCheck",
    "ToolchainToolStatus",
    "ToolchainUnavailableError",
    "enforce_toolchain_selfcheck",
    "latest_toolchain_selfcheck",
    "main",
    "manifest_pins",
    "missing_required_tools",
    "run_toolchain_selfcheck",
    "toolchain_health_detail",
]


#: Bundled tools this runtime treats as **hard dependencies**: their absence is a startup
#: failure in an enforcing deployment, not a degraded format.
#:
#: ``asyncapi-parser`` is here because the AsyncAPI adapter has *no* fallback — there is no
#: pure-Python AsyncAPI 2.x/3.x parser behind it — and AsyncAPI is a shipped, documented,
#: fixture-covered format. Losing it is losing a product surface, so a deployment that cannot
#: run the parser must say so at boot rather than at the first import.
#:
#: Every other bundled tool stays optional: ``buf``, ``tsp``, ``smithy``, the linters and the
#: diff CLIs gate formats or advisory checks that degrade to a stated "unavailable" instead.
REQUIRED_TOOL_KEYS: Tuple[str, ...] = ("asyncapi-parser",)

#: Required tool key → the npm package the toolchain manifest pins for it. Only the tools whose
#: runtime *is* an npm package appear here; a required native binary would have no entry.
REQUIRED_NPM_PACKAGES: Dict[str, str] = {"asyncapi-parser": "@asyncapi/parser"}

#: The toolchain manifest: ``apiome-rest/toolchain/package.json``, which pins the exact version
#: of every hard Node dependency. It is a **build-and-CI** artifact — the container build and
#: ``scripts/install_dev_toolchain.sh`` install from it — so it may be absent from a runtime
#: image; :func:`manifest_pins` returns an empty mapping rather than raising when it is.
TOOLCHAIN_MANIFEST_PATH = Path(__file__).resolve().parents[2] / "toolchain" / "package.json"


def manifest_pins() -> Dict[str, str]:
    """Read the toolchain manifest's exact dependency pins.

    Returns:
        ``npm package name -> exact version``, or ``{}`` when the manifest is not present in
        this runtime (it ships with the source tree, not necessarily with the image).
    """
    try:
        raw = json.loads(TOOLCHAIN_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    dependencies = raw.get("dependencies")
    if not isinstance(dependencies, dict):
        return {}
    return {str(name): str(version) for name, version in dependencies.items()}


#: Trailing semantic-version token of a tool's ``--version`` banner (e.g. the ``3.6.0`` in
#: ``asyncapi-parse (apiome) @asyncapi/parser 3.6.0``). Pre-release / build metadata is kept.
_VERSION_RE = re.compile(r"(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?)\s*$")

#: The most recent :func:`run_toolchain_selfcheck` result, so the health surface can report the
#: startup verdict without re-spawning one subprocess per required tool on every probe.
_latest: Optional["ToolchainSelfCheck"] = None


class ToolchainUnavailableError(RuntimeError):
    """A required bundled tool is missing and this deployment enforces the toolchain.

    Raised from :func:`enforce_toolchain_selfcheck` during startup. The message names every
    missing tool, the executable it looked for, and the override env var that can point at a
    sidecar binary — everything an operator needs to fix it without reading this module.
    """


class ToolchainToolStatus(BaseModel):
    """Availability of one bundled tool, plus what the tool itself reported.

    :attr:`available` is the cheap resolution (a ``PATH``/override lookup);
    :attr:`invocable` is the heavier truth — the tool was actually spawned with its version
    probe and exited cleanly. Only required tools are invoked, so :attr:`invocable` is ``None``
    for the optional ones.
    """

    model_config = ConfigDict(frozen=True)

    key: str = Field(description="Registry key of the bundled tool.")
    required: bool = Field(
        description="True when this tool is a hard dependency (:data:`REQUIRED_TOOL_KEYS`)."
    )
    available: bool = Field(description="True when the executable resolves in this runtime.")
    invocable: Optional[bool] = Field(
        default=None,
        description="True when the tool's version probe ran and exited cleanly; ``null`` when "
        "the probe was not attempted (optional tools are not invoked).",
    )
    pinned_version: str = Field(description="The version the runtime image is built to ship.")
    reported_version: Optional[str] = Field(
        default=None,
        description="Version parsed out of the tool's own ``--version`` banner, when it ran.",
    )
    version_banner: Optional[str] = Field(
        default=None, description="The raw first line of the tool's ``--version`` output."
    )
    gated_formats: List[str] = Field(
        default_factory=list,
        description="Registered import-source / emitter format keys that hard-require this "
        "tool, i.e. the surfaces that disappear with it.",
    )
    detail: str = Field(description="Human-readable availability detail / failure reason.")

    @property
    def ok(self) -> bool:
        """Whether this tool satisfies its own contract (optional tools are always ``True``)."""
        if not self.required:
            return True
        return self.available and self.invocable is not False

    @property
    def version_matches_pin(self) -> bool:
        """Whether the tool reported exactly the version this runtime pins.

        ``True`` when nothing was reported: an unverified tool makes no claim to contradict.
        """
        return self.reported_version is None or self.reported_version == self.pinned_version


class ToolchainSelfCheck(BaseModel):
    """The verdict of one self-check run over the bundled toolchain.

    :attr:`status` is the single value an operator reads:

    * ``ok`` — every required tool resolved and ran;
    * ``degraded`` — a required tool is missing, but this deployment does not enforce the
      toolchain, so the service started with the format unavailable (a development posture);
    * ``failed`` — a required tool is missing in an enforcing deployment; startup refuses.
    """

    model_config = ConfigDict(frozen=True)

    status: str = Field(description="ok / degraded / failed.")
    enforced: bool = Field(
        description="Whether this deployment refuses to start with a required tool missing."
    )
    verified: bool = Field(
        description="Whether required tools were actually invoked (vs resolution only)."
    )
    required_keys: List[str] = Field(description="The hard-dependency tool keys, in order.")
    missing_required: List[str] = Field(
        default_factory=list, description="Required tool keys that are absent or not invocable."
    )
    tools: List[ToolchainToolStatus] = Field(
        default_factory=list, description="Per-tool status, in bundled-declaration order."
    )

    @property
    def ok(self) -> bool:
        """Whether every required tool is present and usable."""
        return not self.missing_required

    def tool(self, key: str) -> Optional[ToolchainToolStatus]:
        """Return the status recorded for ``key``, or ``None`` when not declared."""
        for entry in self.tools:
            if entry.key == key:
                return entry
        return None

    def health_detail(self) -> Dict[str, Any]:
        """Render the compact block ``GET /health`` embeds.

        Deliberately *availability only*. ``/health`` is unauthenticated and rate-limit exempt,
        so it reports whether the required tools resolved and which did not — enough for an
        orchestrator or an on-call operator to see that a shipped format has gone missing — and
        nothing that fingerprints the runtime. Resolved paths and the **exact third-party
        versions** stay behind the platform-admin ``GET /v1/ops/toolchain`` and the startup log,
        because publishing "this replica runs @asyncapi/parser 3.6.0" to anonymous callers hands
        out a dependency-CVE shopping list for no operational gain.

        Returns:
            ``{"status", "enforced", "required", "available", "missing"}``.
        """
        required = [entry for entry in self.tools if entry.required]
        return {
            "status": self.status,
            "enforced": self.enforced,
            "required": len(required),
            "available": sum(1 for entry in required if entry.available),
            "missing": list(self.missing_required),
        }


def _parse_version(banner: Optional[str]) -> Optional[str]:
    """Extract the trailing semantic version from a tool's ``--version`` banner.

    Args:
        banner: The first line the tool printed, or ``None``.

    Returns:
        The version string (``"3.6.0"``), or ``None`` when the banner is absent or carries no
        recognizable version.
    """
    if not banner:
        return None
    match = _VERSION_RE.search(banner.strip())
    return match.group(1) if match else None


def _gated_formats() -> Dict[str, List[str]]:
    """Map each bundled tool key to the registered formats that hard-require it.

    Reads the live import-source and emitter registries rather than a hand-kept table, so a new
    adapter that declares ``required_tools`` shows up here — and on the health/ops surfaces —
    with no edit to this module.

    Returns:
        ``tool key -> sorted format keys``; a tool nothing requires is simply absent.
    """
    # Imported lazily: the registries import the toolchain packaging layer, and this module is
    # imported from the startup path, so a module-level import would close a cycle.
    from .emitter import available_emit_formats, get_emitter, load_builtin_emitters
    from .import_source import (
        available_import_sources,
        get_import_source,
        load_builtin_import_sources,
    )

    load_builtin_import_sources()
    load_builtin_emitters()

    gated: Dict[str, set] = {}
    for key in available_import_sources():
        adapter = get_import_source(key)
        for tool in getattr(adapter, "required_tools", ()):
            gated.setdefault(tool, set()).add(key)
    for format_key in available_emit_formats():
        emitter = get_emitter(format_key)
        for tool in getattr(emitter, "required_tools", ()):
            gated.setdefault(tool, set()).add(format_key)
    return {tool: sorted(keys) for tool, keys in gated.items()}


async def run_toolchain_selfcheck(*, verify: bool = True) -> ToolchainSelfCheck:
    """Probe every bundled tool and invoke the required ones, returning the verdict.

    Resolution (a ``PATH``/override lookup) runs for every bundled tool so the result can back
    the whole ops surface. Only the :data:`REQUIRED_TOOL_KEYS` are actually *spawned* — that is
    where the version comes from, and where a binary that resolves but cannot run (a broken
    Node install, a wrapper pointing at a deleted ``node_modules``) is caught.

    A **verified** run is cached for :func:`latest_toolchain_selfcheck`, so the health surface
    reports the startup verdict rather than re-spawning subprocesses per request. A
    resolution-only run is deliberately *not* cached: it knows less (no reported versions, no
    "resolves but cannot run" detection), and letting a cheap ops probe replace the authoritative
    startup verdict would quietly downgrade what ``/health`` reports.

    Args:
        verify: When ``False``, skip the subprocess probes and report resolution only. Used by
            callers that must stay cheap; :attr:`ToolchainSelfCheck.verified` says which
            happened.

    Returns:
        The :class:`ToolchainSelfCheck` for this runtime.
    """
    global _latest

    gated = _gated_formats()
    statuses: List[ToolchainToolStatus] = []
    missing: List[str] = []

    for tool in BUNDLED_TOOLS:
        required = tool.key in REQUIRED_TOOL_KEYS
        availability = probe_tool(tool.key)
        assert availability is not None  # BUNDLED_TOOLS is the source probe_tool reads
        invocable: Optional[bool] = None
        banner: Optional[str] = None
        detail = availability.detail

        if required and verify and availability.available:
            verification = await verify_tool(tool.key)
            if verification is not None:
                invocable = verification.invocable
                banner = verification.reported
                if not verification.invocable:
                    detail = (
                        f"{tool.executable!r} resolved to {availability.resolved_path} but its "
                        f"version probe failed: {verification.error}"
                    )

        status = ToolchainToolStatus(
            key=tool.key,
            required=required,
            available=availability.available,
            invocable=invocable,
            pinned_version=tool.version,
            reported_version=_parse_version(banner),
            version_banner=banner,
            gated_formats=gated.get(tool.key, []),
            detail=detail,
        )
        statuses.append(status)
        if not status.ok:
            missing.append(tool.key)

    enforced = settings.enforce_bundled_toolchain
    if not missing:
        status_value = "ok"
    else:
        status_value = "failed" if enforced else "degraded"

    result = ToolchainSelfCheck(
        status=status_value,
        enforced=enforced,
        verified=verify,
        required_keys=list(REQUIRED_TOOL_KEYS),
        missing_required=missing,
        tools=statuses,
    )
    if verify:
        _latest = result
    return result


def missing_required_tools() -> List[str]:
    """Required tool keys that do not resolve in this runtime — resolution only, no subprocess.

    The cheap question ("is the hard toolchain installed here?") without running the full
    self-check. Suites whose checked-in artifacts describe a runtime that *has* the toolchain
    use it to skip with an actionable message instead of failing a developer machine that never
    ran ``scripts/install_dev_toolchain.sh``.

    Returns:
        The unresolvable required tool keys, in declaration order; empty when all are present.
    """
    return [
        key
        for key in REQUIRED_TOOL_KEYS
        if not getattr(probe_tool(key), "available", False)
    ]


def latest_toolchain_selfcheck() -> Optional[ToolchainSelfCheck]:
    """Return the most recent self-check result, or ``None`` before startup has run one."""
    return _latest


def _describe_missing(status: ToolchainToolStatus) -> str:
    """Render one missing required tool as an operator-actionable line."""
    tool = bundled_tool(status.key)
    override = tool.env_override_key if tool else f"APIOME_{status.key.upper()}_BIN"
    executable = tool.executable if tool else status.key
    gated = ", ".join(status.gated_formats) or "no registered format"
    return (
        f"  - {status.key} (pinned {status.pinned_version}, executable {executable!r}): "
        f"{status.detail}. Gates: {gated}. Point {override} at a working binary, or rebuild "
        "the image so the bundled toolchain is installed."
    )


async def enforce_toolchain_selfcheck(
    *, log: Optional[logging.Logger] = None
) -> ToolchainSelfCheck:
    """Run the startup self-check: log the resolved versions, refuse to start when required.

    This is the whole "no silent degradation" contract in one call:

    * every required tool that resolves is **invoked**, and the version it reports is logged —
      so a deployment's logs always name the ``@asyncapi/parser`` it is actually running;
    * a version that disagrees with the pinned one is logged as a warning (the tool still
      works, but the image installed something other than what it declares);
    * a required tool that is missing or not invocable raises
      :class:`ToolchainUnavailableError` when this deployment enforces the toolchain, and is
      logged as a loud ``ERROR`` naming the lost formats when it does not.

    Args:
        log: Logger to write to; defaults to this module's. The startup path passes the
            uvicorn error logger so the lines land beside the rest of the boot output.

    Returns:
        The :class:`ToolchainSelfCheck` (also cached for the health surface).

    Raises:
        ToolchainUnavailableError: When a required tool is unusable and
            :attr:`app.config.Settings.enforce_bundled_toolchain` is on.
    """
    out = log if log is not None else logger
    result = await run_toolchain_selfcheck(verify=True)

    for status in result.tools:
        if not status.required or not status.available:
            continue
        out.info(
            "bundled toolchain: %s resolved (%s), pinned %s",
            status.key,
            status.version_banner or f"version {status.reported_version or 'unknown'}",
            status.pinned_version,
        )
        if not status.version_matches_pin:
            out.warning(
                "bundled toolchain: %s reports version %s but this runtime pins %s; the image "
                "installed something other than what it declares (see "
                "apiome-rest/toolchain/package.json and BUNDLED_TOOLS)",
                status.key,
                status.reported_version,
                status.pinned_version,
            )

    if result.ok:
        return result

    broken = [status for status in result.tools if status.key in result.missing_required]
    detail = "\n".join(_describe_missing(status) for status in broken)
    headline = (
        f"{len(broken)} required bundled tool(s) are unusable in this runtime:\n{detail}"
    )
    if result.enforced:
        out.error("bundled toolchain self-check failed; refusing to start. %s", headline)
        raise ToolchainUnavailableError(headline)
    out.error(
        "bundled toolchain self-check degraded: %s\nThe service is starting anyway because "
        "APIOME_REQUIRE_TOOLCHAIN is off; the formats above are unavailable in this runtime.",
        headline,
    )
    return result


def toolchain_health_detail() -> Dict[str, Any]:
    """Return the toolchain block ``GET /health`` embeds.

    Uses the cached startup verdict when there is one — that is the run that actually invoked
    the tools. Before startup has run (a bare ``TestClient`` import, a worker process that
    never booted the app) it falls back to a resolution-only check so the block is still
    truthful rather than absent.

    Returns:
        The compact ``{"status", "enforced", "required", "available", "missing"}`` mapping
        described by :meth:`ToolchainSelfCheck.health_detail`.
    """
    cached = latest_toolchain_selfcheck()
    if cached is not None:
        return cached.health_detail()

    gated = _gated_formats()
    statuses = [
        ToolchainToolStatus(
            key=tool.key,
            required=True,
            available=bool(getattr(probe_tool(tool.key), "available", False)),
            pinned_version=tool.version,
            gated_formats=gated.get(tool.key, []),
            detail=getattr(probe_tool(tool.key), "detail", "not declared"),
        )
        for tool in BUNDLED_TOOLS
        if tool.key in REQUIRED_TOOL_KEYS
    ]
    missing = [status.key for status in statuses if not status.available]
    enforced = settings.enforce_bundled_toolchain
    return ToolchainSelfCheck(
        status="ok" if not missing else ("failed" if enforced else "degraded"),
        enforced=enforced,
        verified=False,
        required_keys=list(REQUIRED_TOOL_KEYS),
        missing_required=missing,
        tools=statuses,
    ).health_detail()


def _render_report(result: ToolchainSelfCheck) -> str:
    """Render the self-check as a short operator-readable report (the CLI's output)."""
    lines = [f"bundled toolchain self-check: {result.status} (enforced={result.enforced})"]
    for status in result.tools:
        if not status.required:
            continue
        mark = "ok " if status.ok else "MISSING"
        version = status.reported_version or status.pinned_version
        lines.append(f"  [{mark}] {status.key} {version} — {status.detail}")
        if status.gated_formats:
            lines.append(f"          gates: {', '.join(status.gated_formats)}")
    return "\n".join(lines)


def main() -> int:
    """Run the self-check from the command line and exit non-zero when it fails.

    ``python -m app.toolchain_selfcheck`` is the gate CI and a container's own smoke test use:
    it prints one line per required tool with the version that tool reported, and exits ``1``
    when any of them is unusable — regardless of ``APIOME_REQUIRE_TOOLCHAIN``, because someone
    running the check explicitly is asking whether the toolchain is intact, not whether this
    deployment tolerates it being broken.

    Returns:
        ``0`` when every required tool resolved and ran, ``1`` otherwise.
    """
    import asyncio

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    result = asyncio.run(run_toolchain_selfcheck(verify=True))
    print(_render_report(result))
    return 0 if result.ok else 1


if __name__ == "__main__":  # pragma: no cover - exercised as a subprocess by CI
    raise SystemExit(main())
