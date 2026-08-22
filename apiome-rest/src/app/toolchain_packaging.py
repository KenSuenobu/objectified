"""Tool runtime packaging — MFI-5.2 (#3751).

MFI-5.1 (:mod:`app.toolchain_runner`) built the *seam* for shelling out to non-Python
parser/linter/diff CLIs and getting structured JSON back. It deliberately bundled **no
real binaries** — only a portable ``sample-echo`` reference tool. This module is the other
half: it **declares the external tools the deployment ships**, pins each to a reproducible
version, registers them into the runner's by-key registry, and exposes a **non-raising
availability probe** so a format adapter (or an ops endpoint) can ask "is this tool here?"
and *degrade to "unavailable"* instead of failing a request mid-flight.

What lives here:

* :class:`BundledTool` — one declared tool: registry key, the executable name the runtime
  puts on ``PATH``, a **pinned version** string (the single source of truth the Dockerfile
  mirrors via build args), the ``APIOME_<KEY>_BIN`` override env var a deployment can
  point at a custom binary, default leading args, a version-probe argument, and whether the
  tool's stdout is JSON.
* :data:`BUNDLED_TOOLS` — the pinned set: ``buf``, ``tsp``, ``smithy``, ``drafter``,
  ``amf``, ``asyncapi``, ``asyncapi-parser``, ``asyncapi-diff``, ``rover``,
  ``graphql-inspector-diff``, ``spectral``, ``vacuum``, ``redocly``, ``oasdiff``,
  ``openapi-changes``.
* :func:`register_bundled_tools` — register every bundled tool into the runner registry
  (idempotent; safe to call repeatedly / on re-import).
* :func:`probe_tool` / :func:`probe_all` — **cheap, lazy** availability resolution (a
  ``PATH``/override lookup, *no subprocess*): the "format unavailable" status MFI-5.2's
  acceptance criteria call for.
* :func:`verify_tool` — an **optional, heavier** check that actually invokes the tool's
  version probe through the runner to confirm it is executable (used by the ops route only
  when explicitly asked).

The actual binaries are laid into the image by ``apiome-rest/Dockerfile``; their
on-disk footprint is documented in ``docs/toolchain_packaging.md``. Tools are *optional* by
construction: if a binary is absent, :func:`probe_tool` reports ``available=False`` and the
runner raises :class:`~app.toolchain_runner.ToolNotAvailableError` at call time — nothing
crashes at startup.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from typing import List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .toolchain_runner import (
    ToolchainError,
    ToolSpec,
    default_runner,
    register_tool,
    resolve_executable,
)

logger = logging.getLogger(__name__)

__all__ = [
    "BundledTool",
    "ToolAvailability",
    "ToolVerification",
    "BUNDLED_TOOLS",
    "bundled_tool",
    "register_bundled_tools",
    "probe_tool",
    "probe_all",
    "verify_tool",
]


# ===========================================================================
# Declared bundled tool
# ===========================================================================


@dataclass(frozen=True)
class BundledTool:
    """One external CLI the runtime image ships, pinned to a reproducible version.

    A :class:`BundledTool` converts to a :class:`~app.toolchain_runner.ToolSpec` for the
    runner, but additionally carries the **packaging** facts MFI-5.2 owns: the pinned
    version (the Dockerfile installs exactly this), how the deployment may override the
    binary location, and a version-probe argument used by :func:`verify_tool`.

    Attributes:
        key: Stable registry key the runner resolves on (e.g. ``"buf"``).
        executable: Program name the runtime puts on ``PATH`` (a wrapper for the JVM tools).
        version: The **pinned** version the image installs — the single source of truth the
            Dockerfile mirrors and ``docs/toolchain_packaging.md`` documents.
        description: One-line human description for tool/format listings.
        env_override_key: Environment variable a deployment sets to an absolute path to use
            its own binary instead of the bundled one (e.g. ``APIOME_BUF_BIN``).
        base_args: Leading arguments always prepended before a caller's per-call args.
        version_probe_args: Arguments that make the tool print its version (used by
            :func:`verify_tool` to confirm the binary actually runs).
        default_timeout_seconds: Per-call timeout the spec pins (``None`` → service default).
        parses_json: Whether the tool's *normal* stdout is JSON the runner should parse.
        runtime: Human label for the underlying runtime — ``native`` / ``node`` / ``jvm`` —
            shown in the footprint docs and availability surface.
    """

    key: str
    executable: str
    version: str
    description: str
    env_override_key: str
    base_args: Tuple[str, ...] = ()
    version_probe_args: Tuple[str, ...] = ("--version",)
    default_timeout_seconds: Optional[float] = 60.0
    parses_json: bool = True
    runtime: str = "native"

    def to_spec(self) -> ToolSpec:
        """Build the runner :class:`~app.toolchain_runner.ToolSpec` for this tool."""
        return ToolSpec(
            key=self.key,
            executable=self.executable,
            description=self.description,
            base_args=self.base_args,
            default_timeout_seconds=self.default_timeout_seconds,
            env_override_keys=(self.env_override_key,),
            parses_json=self.parses_json,
        )


# ===========================================================================
# The pinned tool set
# ===========================================================================
#
# Versions here are the SINGLE SOURCE OF TRUTH. The Dockerfile installs these exact versions
# via build args (kept in sync — see docs/toolchain_packaging.md) and a release should bump
# both together. Each tool is reachable as a bare ``executable`` on PATH; the JVM tools
# (``smithy``, ``amf``) are launched by a thin wrapper the image drops on PATH so they look
# identical to the native tools to the runner. ``base_args`` is left empty: the format
# adapters (later epics) own each tool's sub-command, so we do not bake a default verb here.

BUNDLED_TOOLS: Tuple[BundledTool, ...] = (
    BundledTool(
        key="buf",
        executable="buf",
        # 1.72.0 is the floor for Protobuf **Edition 2024** (FMT-3.7, #5432): 1.50.0 rejects
        # `edition = "2024"` outright with `should be one of ["2023"]`.
        version="1.72.0",
        description="Protobuf/gRPC build, lint and breaking-change tool (bufbuild/buf).",
        env_override_key="APIOME_BUF_BIN",
        runtime="native",
    ),
    BundledTool(
        key="tsp",
        executable="tsp",
        version="0.65.0",
        description="TypeSpec compiler CLI (@typespec/compiler).",
        env_override_key="APIOME_TSP_BIN",
        runtime="node",
    ),
    BundledTool(
        key="smithy",
        executable="smithy",
        version="1.53.0",
        description="Smithy IDL model build/validate CLI (smithy-lang/smithy, JVM).",
        env_override_key="APIOME_SMITHY_BIN",
        runtime="jvm",
    ),
    BundledTool(
        key="drafter",
        executable="drafter",
        version="4.0.0",
        description="API Blueprint parser → JSON (apiaryio/drafter, native).",
        env_override_key="APIOME_DRAFTER_BIN",
        # drafter emits a Refract/JSON parse result, but its --version banner is plain text.
        parses_json=True,
        runtime="native",
    ),
    BundledTool(
        key="amf",
        executable="amf",
        version="5.7.1",
        description="AML Modeling Framework CLI for RAML/OAS (aml-org/amf, JVM).",
        env_override_key="APIOME_AMF_BIN",
        runtime="jvm",
    ),
    BundledTool(
        key="asyncapi",
        executable="asyncapi",
        version="2.16.0",
        description="AsyncAPI document validate/convert/diff CLI (@asyncapi/cli).",
        env_override_key="APIOME_ASYNCAPI_BIN",
        runtime="node",
    ),
    BundledTool(
        key="asyncapi-parser",
        executable="asyncapi-parser",
        version="3.6.0",
        description="AsyncAPI parse/validate/dereference → canonical JSON (@asyncapi/parser, "
        "MFI-8.1).",
        env_override_key="APIOME_ASYNCAPI_PARSER_BIN",
        runtime="node",
    ),
    BundledTool(
        key="asyncapi-diff",
        executable="asyncapi-diff",
        version="0.5.0",
        description="AsyncAPI diff → breaking/non-breaking/unclassified (@asyncapi/diff, "
        "MFI-8.4).",
        env_override_key="APIOME_ASYNCAPI_DIFF_BIN",
        runtime="node",
    ),
    BundledTool(
        key="rover",
        executable="rover",
        version="0.27.0",
        description="Apollo GraphQL schema/supergraph CLI (apollographql/rover, native).",
        env_override_key="APIOME_ROVER_BIN",
        runtime="native",
    ),
    BundledTool(
        key="graphql-inspector-diff",
        executable="graphql-inspector-diff",
        version="6.2.0",
        description="GraphQL schema diff → breaking/dangerous/non-breaking "
        "(@graphql-inspector/core, MFI-10.5).",
        env_override_key="APIOME_GRAPHQL_INSPECTOR_DIFF_BIN",
        runtime="node",
    ),
    BundledTool(
        key="spectral",
        executable="spectral",
        version="6.16.1",
        description="OpenAPI/AsyncAPI lint CLI (@stoplight/spectral-cli, CLX-2.2).",
        env_override_key="APIOME_SPECTRAL_BIN",
        parses_json=False,
        runtime="node",
    ),
    BundledTool(
        key="vacuum",
        executable="vacuum",
        version="0.29.9",
        description="OpenAPI lint CLI (daveshanley/vacuum, CLX-2.2).",
        env_override_key="APIOME_VACUUM_BIN",
        parses_json=False,
        runtime="native",
    ),
    BundledTool(
        key="redocly",
        executable="redocly",
        version="2.39.0",
        description="OpenAPI lint/resolve CLI (@redocly/cli, CLX-2.2).",
        env_override_key="APIOME_REDOCLY_BIN",
        parses_json=False,
        runtime="node",
    ),
    BundledTool(
        key="oasdiff",
        executable="oasdiff",
        version="1.23.0",
        description="OpenAPI compatibility changelog/breaking-change CLI (oasdiff/oasdiff, CLX-2.3).",
        env_override_key="APIOME_OASDIFF_BIN",
        parses_json=False,
        runtime="native",
    ),
    BundledTool(
        key="openapi-changes",
        executable="openapi-changes",
        version="0.0.78",
        description="Optional OpenAPI HTML/Markdown change renderer (pb33f/openapi-changes, CLX-2.3).",
        env_override_key="APIOME_OPENAPI_CHANGES_BIN",
        parses_json=False,
        runtime="native",
    ),
)

# Fast key → BundledTool lookup.
_BY_KEY = {t.key: t for t in BUNDLED_TOOLS}


def bundled_tool(key: str) -> Optional[BundledTool]:
    """Return the :class:`BundledTool` declared under ``key``, or ``None``."""
    return _BY_KEY.get(key)


# ===========================================================================
# Registration
# ===========================================================================

_registered = False


def register_bundled_tools() -> List[str]:
    """Register every :data:`BUNDLED_TOOLS` entry into the runner registry.

    Idempotent: registering an equal spec twice is a no-op (the runner's
    :func:`~app.toolchain_runner.register_tool` rejects only *conflicting* re-registration),
    and this function short-circuits after the first successful pass so repeated imports /
    startup calls are cheap.

    Returns:
        The list of tool keys that are now registered (in declaration order).
    """
    global _registered
    if not _registered:
        for tool in BUNDLED_TOOLS:
            register_tool(tool.to_spec())
        _registered = True
    return [t.key for t in BUNDLED_TOOLS]


# ===========================================================================
# Availability probe (lazy — resolution only, no subprocess)
# ===========================================================================


class ToolAvailability(BaseModel):
    """Serializable availability of one bundled tool — the "format unavailable" signal.

    Resolution is *lazy*: it is a ``PATH``/override lookup only, never a subprocess, so it
    is safe to call on a hot path or for every tool at once.
    """

    model_config = ConfigDict(frozen=True)

    key: str = Field(description="Registry key of the tool.")
    executable: str = Field(description="Executable name the runtime expects on PATH.")
    pinned_version: str = Field(description="The version the runtime image is built to ship.")
    runtime: str = Field(description="Underlying runtime: native / node / jvm.")
    available: bool = Field(description="True when the executable resolves on this host.")
    resolved_path: Optional[str] = Field(
        default=None, description="Absolute path the executable resolved to (when available)."
    )
    override_env: str = Field(
        description="Env var that overrides the binary path (APIOME_<KEY>_BIN)."
    )
    detail: str = Field(description="Human-readable availability detail / unavailable reason.")


def _availability_for(tool: BundledTool) -> ToolAvailability:
    """Resolve one tool's executable (no subprocess) and build its availability record."""
    spec = tool.to_spec()
    resolved = resolve_executable(spec)
    # An env override may point at a path that does not exist; only treat the tool as
    # available when the resolved target is an actual executable file (PATH lookups already
    # guarantee that; an override path may not).
    if resolved and (shutil.which(resolved) or _is_executable_file(resolved)):
        return ToolAvailability(
            key=tool.key,
            executable=tool.executable,
            pinned_version=tool.version,
            runtime=tool.runtime,
            available=True,
            resolved_path=resolved,
            override_env=tool.env_override_key,
            detail=f"resolved to {resolved}",
        )

    reason = (
        f"executable {tool.executable!r} not found on PATH "
        f"(set {tool.env_override_key} to a bundled binary, or the format is unavailable)"
    )
    if resolved:
        # Override was set but the target is not an executable file.
        reason = (
            f"{tool.env_override_key}={resolved!r} does not point at an executable file; "
            "the format is unavailable"
        )
    return ToolAvailability(
        key=tool.key,
        executable=tool.executable,
        pinned_version=tool.version,
        runtime=tool.runtime,
        available=False,
        resolved_path=None,
        override_env=tool.env_override_key,
        detail=reason,
    )


def _is_executable_file(path: str) -> bool:
    """True when ``path`` is an existing file with the executable bit set."""
    return os.path.isfile(path) and os.access(path, os.X_OK)


def probe_tool(key: str) -> Optional[ToolAvailability]:
    """Return the availability of the bundled tool ``key``, or ``None`` if not declared."""
    tool = _BY_KEY.get(key)
    if tool is None:
        return None
    return _availability_for(tool)


def probe_all() -> List[ToolAvailability]:
    """Return availability for every bundled tool, in declaration order."""
    return [_availability_for(tool) for tool in BUNDLED_TOOLS]


# ===========================================================================
# Verification (optional — actually runs the tool's version probe)
# ===========================================================================


class ToolVerification(BaseModel):
    """Outcome of actually invoking a tool's version probe (a real subprocess)."""

    model_config = ConfigDict(frozen=True)

    key: str = Field(description="Registry key of the tool.")
    pinned_version: str = Field(description="The version the runtime image is built to ship.")
    invocable: bool = Field(description="True when the version probe ran and exited cleanly.")
    reported: Optional[str] = Field(
        default=None, description="First line of the tool's version output (when invocable)."
    )
    error: Optional[str] = Field(
        default=None, description="Failure detail when the probe did not run cleanly."
    )


async def verify_tool(key: str, *, timeout: Optional[float] = None) -> Optional[ToolVerification]:
    """Confirm a bundled tool is actually invocable by running its version probe.

    Unlike :func:`probe_tool` (a cheap resolution), this spawns the tool with its
    ``version_probe_args`` through the shared runner. The version banner is **not** JSON, so
    the run is forced to skip JSON parsing regardless of the tool's normal ``parses_json``.

    Args:
        key: The bundled tool key to verify.
        timeout: Optional per-call timeout (seconds); falls back to the spec/service default.

    Returns:
        A :class:`ToolVerification`, or ``None`` if ``key`` is not a declared bundled tool.
    """
    tool = _BY_KEY.get(key)
    if tool is None:
        return None

    # Force JSON parsing off for the version banner (plain text), but keep all other facts.
    probe_spec = ToolSpec(
        key=tool.key,
        executable=tool.executable,
        description=tool.description,
        base_args=tool.base_args,
        default_timeout_seconds=tool.default_timeout_seconds,
        env_override_keys=(tool.env_override_key,),
        parses_json=False,
    )
    try:
        result = await default_runner.run_spec(
            probe_spec, list(tool.version_probe_args), timeout=timeout
        )
    except ToolchainError as exc:
        return ToolVerification(
            key=tool.key, pinned_version=tool.version, invocable=False, error=str(exc)
        )

    reported = (result.stdout.strip() or result.stderr.strip() or "").splitlines()
    return ToolVerification(
        key=tool.key,
        pinned_version=tool.version,
        invocable=True,
        reported=reported[0] if reported else None,
    )


# Register on import so any consumer that imports this module (the app, the ops route, the
# tests) immediately sees the bundled tools in the runner registry.
register_bundled_tools()
