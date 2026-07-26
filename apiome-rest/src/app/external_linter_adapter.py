"""External-linter adapter SPI — sandboxed tool integrations (CLX-2.1, #4851).

Generalizes the Buf lint pattern into a restricted adapter registry: each adapter
declares the formats / scan modes it covers, the toolchain tool it needs, and the
output format it emits. Commands always run through :class:`RestrictedRunner`
(bounded I/O/resources, no-network default, no secrets in logs). Tool output is
parsed by :mod:`app.external_linter_parsers` (JSON / JSONL / SARIF), and
operational failures (timeout, unavailable, malformed, crash) become coverage
evidence via :mod:`app.external_linter_evidence`.

This module refines MFI-4.3 (#3748) rather than replacing format-specific merge
helpers: :func:`run_buf_lint` in :mod:`app.proto_lint` delegates here so callers
keep their existing API while sharing the SPI.
"""

from __future__ import annotations

import tempfile
from abc import ABC, abstractmethod
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field
from typing import Any, ClassVar, Dict, List, Mapping, Optional, Sequence, Tuple

from .external_linter_evidence import adapter_evidence_run
from .external_linter_parsers import (
    OUTPUT_FORMAT_JSON,
    OUTPUT_FORMAT_JSONL,
    OUTPUT_FORMAT_SARIF,
    AdapterOutputError,
    NormalizedToolFinding,
    envelope_from_tool_finding,
    parse_jsonl_tolerant,
    parse_tool_output,
)
from .external_linter_runner import (
    FAILURE_CRASH,
    FAILURE_MALFORMED,
    FAILURE_UNAVAILABLE,
    AdapterFailureKind,
    RestrictedRunFailure,
    RestrictedRunSuccess,
    RestrictedRunner,
    default_restricted_runner,
)
from .lint_evidence import SUBJECT_CATALOG_REVISION
from .schema_lint import LintFinding, Severity
from .toolchain_runner import ToolSpec
from .toolchain_sandbox import SandboxPolicy

__all__ = [
    "InputFormat",
    "ScanMode",
    "OUTPUT_FORMAT_JSON",
    "OUTPUT_FORMAT_JSONL",
    "OUTPUT_FORMAT_SARIF",
    "AdapterDeclaration",
    "AdapterInput",
    "AdapterRunResult",
    "ExternalLinterAdapter",
    "BufLintAdapter",
    "register_adapter",
    "get_adapter",
    "available_adapters",
    "adapters_for_format",
    "run_adapter",
    "load_builtin_adapters",
    "BUF_LINT_ADAPTER_ID",
    "BUF_LINT_SCANNER_ID",
    "BUF_LINT_ADAPTER_VERSION",
]


# ===========================================================================
# Vocabulary
# ===========================================================================


class InputFormat:
    """Supported input format tokens adapters may declare."""

    PROTOBUF = "protobuf"
    OPENAPI = "openapi"
    ASYNCAPI = "asyncapi"
    GRAPHQL = "graphql"
    #: XML documents checked against an XML-schema-backed grammar (XSD, and the XSD embedded
    #: in a WSDL). Added by IXH-5.1 (#5113) so instance validation dispatches XML through this
    #: seam rather than inlining a second toolchain.
    XML = "xml"
    GENERIC = "generic"


class ScanMode:
    """Supported scan / lint mode tokens."""

    LINT = "lint"
    BREAKING = "breaking"
    VALIDATE = "validate"


@dataclass(frozen=True)
class AdapterDeclaration:
    """Static declaration an adapter publishes for discovery and availability.

    Attributes:
        adapter_id: Stable adapter id (registry key), e.g. ``buf.lint``.
        scanner_id: Evidence scanner id written on evidence runs.
        formats: Input formats this adapter accepts.
        scan_modes: Scan modes this adapter implements.
        tool_key: Toolchain tool key (MFI-5.1/5.2) required to run.
        output_format: ``json`` / ``jsonl`` / ``sarif``.
        adapter_version: Version string stamped on evidence (parser/adapter).
        description: One-line human description.
        required_tools: Tool keys that must be available (defaults to ``tool_key``).
    """

    adapter_id: str
    scanner_id: str
    formats: Tuple[str, ...]
    scan_modes: Tuple[str, ...]
    tool_key: str
    output_format: str
    adapter_version: str
    description: str = ""
    required_tools: Tuple[str, ...] = ()

    def availability_tools(self) -> Tuple[str, ...]:
        """Tool keys that must resolve for this adapter to be available."""
        if self.required_tools:
            return self.required_tools
        return (self.tool_key,) if self.tool_key else ()


@dataclass
class AdapterInput:
    """Inputs handed to an adapter for one run.

    Attributes:
        files: Mapping of relative path → text content (multi-file tools).
        document: Single-document payload (text or mapping) when the tool accepts
            stdin / one file.
        format: Declared input format for this run.
        scan_mode: Declared scan mode for this run.
        metadata: Adapter-specific extras (not logged).
    """

    files: Dict[str, str] = field(default_factory=dict)
    document: Optional[Any] = None
    format: str = InputFormat.GENERIC
    scan_mode: str = ScanMode.LINT
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AdapterRunResult:
    """Outcome of one :func:`run_adapter` invocation.

    Attributes:
        adapter_id: Adapter that ran.
        scanner_id: Evidence scanner id.
        adapter_version: Adapter version stamped on evidence.
        outcome_ready: Whether the run completed enough to parse findings.
        failure_kind: Operational failure kind when not successful.
        diagnostics: Short diagnostic message.
        raw_findings: Parser-normalized tool findings (pre-envelope).
        envelope_findings: CLX-1.1 envelope findings.
        lint_findings: Optional score-merge :class:`LintFinding` list.
        exit_code: Tool exit code when known.
        stdout: Captured stdout (not for logging).
        stderr: Captured stderr (not for logging).
        duration_ms: Wall-clock duration when known.
    """

    adapter_id: str
    scanner_id: str
    adapter_version: str
    outcome_ready: bool
    failure_kind: Optional[AdapterFailureKind] = None
    diagnostics: Optional[str] = None
    raw_findings: List[NormalizedToolFinding] = field(default_factory=list)
    envelope_findings: List[Dict[str, Any]] = field(default_factory=list)
    lint_findings: List[LintFinding] = field(default_factory=list)
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: Optional[int] = None

    def to_evidence_run(
        self,
        *,
        subject_type: str = SUBJECT_CATALOG_REVISION,
        subject_id: str,
        profile: str = "adapter-run",
        input_fingerprint: Optional[str] = None,
        config: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build a CLX-1.1 evidence-run dict for this result."""
        return adapter_evidence_run(
            subject_type=subject_type,
            subject_id=subject_id,
            scanner_id=self.scanner_id,
            adapter_version=self.adapter_version,
            findings=self.envelope_findings,
            failure_kind=self.failure_kind,
            profile=profile,
            input_fingerprint=input_fingerprint,
            config=config,
            diagnostics=self.diagnostics,
        )


# ===========================================================================
# Registry
# ===========================================================================

_ADAPTER_REGISTRY: Dict[str, type["ExternalLinterAdapter"]] = {}
_builtin_adapters_loaded = False


def register_adapter(cls: type["ExternalLinterAdapter"]) -> type["ExternalLinterAdapter"]:
    """Register a concrete :class:`ExternalLinterAdapter` under its ``adapter_id``.

    Args:
        cls: A concrete adapter subclass with a non-empty ``adapter_id``.

    Returns:
        ``cls`` unchanged (usable as a decorator).

    Raises:
        ValueError: Empty ``adapter_id``, or a different class already registered.
    """
    key = cls.adapter_id
    if not key:
        raise ValueError(f"{cls.__name__} must set a non-empty adapter_id to register")
    existing = _ADAPTER_REGISTRY.get(key)
    if existing is not None and existing is not cls:
        raise ValueError(
            f"adapter {key!r} already registered to {existing.__name__}; "
            f"cannot re-register to {cls.__name__}"
        )
    _ADAPTER_REGISTRY[key] = cls
    return cls


def get_adapter(adapter_id: str) -> Optional[type["ExternalLinterAdapter"]]:
    """Return the adapter class registered under ``adapter_id``, or ``None``."""
    load_builtin_adapters()
    return _ADAPTER_REGISTRY.get(adapter_id)


def available_adapters() -> List[str]:
    """Return sorted registered adapter ids."""
    load_builtin_adapters()
    return sorted(_ADAPTER_REGISTRY)


def adapters_for_format(format_key: str) -> List[type["ExternalLinterAdapter"]]:
    """Return adapter classes that declare ``format_key`` in their formats."""
    load_builtin_adapters()
    return [
        cls
        for cls in _ADAPTER_REGISTRY.values()
        if format_key in cls.declaration().formats
    ]


def load_builtin_adapters() -> None:
    """Ensure built-in adapters have self-registered (idempotent)."""
    global _builtin_adapters_loaded
    if _builtin_adapters_loaded:
        return
    # BufLintAdapter is defined in this module; importing this function after the
    # class body has executed is enough. Touching the registry force-loads it.
    _ = BufLintAdapter
    # CLX-2.2 (#4852): Spectral / Vacuum / Redocly OAS packs register on import.
    from . import openapi_validation_adapters as _oas_packs  # noqa: F401

    # CLX-2.3 (#4853): oasdiff OpenAPI compatibility adapter.
    from . import openapi_compatibility_adapters as _oas_compat  # noqa: F401

    # CLX-2.4 (#4854): GraphQL ESLint adapter (evidence contract migration).
    from . import graphql_eslint_adapter as _gql_eslint  # noqa: F401

    # IXH-5.1 (#5113): xmllint XML instance validation.
    from . import xml_instance_validation as _xml_validate  # noqa: F401

    _ = (
        _oas_packs.SpectralOasAdapter,
        _oas_packs.VacuumOasAdapter,
        _oas_packs.RedoclyOasAdapter,
        _oas_compat.OasdiffAdapter,
        _gql_eslint.GraphqlEslintAdapter,
        _xml_validate.XmllintValidateAdapter,
    )
    _builtin_adapters_loaded = True


class ExternalLinterAdapter(ABC):
    """Service-provider contract for one sandboxed external linter.

    Subclasses self-register via ``register=True``::

        class BufLintAdapter(ExternalLinterAdapter, register=True):
            adapter_id = "buf.lint"
            ...
    """

    adapter_id: ClassVar[str] = ""
    scanner_id: ClassVar[str] = ""
    formats: ClassVar[Tuple[str, ...]] = ()
    scan_modes: ClassVar[Tuple[str, ...]] = (ScanMode.LINT,)
    tool_key: ClassVar[str] = ""
    output_format: ClassVar[str] = OUTPUT_FORMAT_JSONL
    adapter_version: ClassVar[str] = "1"
    description: ClassVar[str] = ""
    required_tools: ClassVar[Tuple[str, ...]] = ()
    #: Non-zero exit codes that still carry parseable findings (e.g. Buf ``100``).
    accept_exit_codes: ClassVar[Tuple[int, ...]] = ()

    def __init_subclass__(cls, *, register: bool = False, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if register:
            register_adapter(cls)

    @classmethod
    def declaration(cls) -> AdapterDeclaration:
        """Return this adapter's static declaration."""
        return AdapterDeclaration(
            adapter_id=cls.adapter_id,
            scanner_id=cls.scanner_id or cls.adapter_id,
            formats=tuple(cls.formats),
            scan_modes=tuple(cls.scan_modes),
            tool_key=cls.tool_key,
            output_format=cls.output_format,
            adapter_version=cls.adapter_version,
            description=cls.description,
            required_tools=tuple(cls.required_tools) if cls.required_tools else (),
        )

    @abstractmethod
    def tool_spec(self) -> ToolSpec:
        """Build the :class:`ToolSpec` used for this adapter's command."""
        raise NotImplementedError

    def prepare_workspace(
        self, inputs: AdapterInput
    ) -> AbstractContextManager[Optional[str]]:
        """Optionally materialize inputs into a scratch directory.

        Returns:
            A context manager yielding a working-directory path (or ``None``).
        """
        _ = inputs
        return nullcontext(None)

    @abstractmethod
    def build_args(
        self, inputs: AdapterInput, *, workspace: Optional[str]
    ) -> Sequence[str]:
        """Return per-call argv args after ``ToolSpec.base_args``."""
        raise NotImplementedError

    def stdin_for(self, inputs: AdapterInput) -> Optional[str]:
        """Optional stdin payload; default is none."""
        _ = inputs
        return None

    def parse_output(self, stdout: str) -> List[NormalizedToolFinding]:
        """Parse tool stdout using this adapter's declared output format."""
        return parse_tool_output(stdout, self.output_format)

    def parse_streams(self, stdout: str, stderr: str) -> List[NormalizedToolFinding]:
        """Parse a completed run's output streams into findings.

        The hook :func:`run_adapter` actually calls. It defaults to
        :meth:`parse_output` over stdout — the shape every machine-readable linter here uses —
        and exists for tools whose diagnostics are written to **stderr** instead, which is the
        POSIX convention that ``xmllint`` (IXH-5.1, #5113) follows. Overriding this keeps such
        an adapter self-contained rather than making its caller reach into
        :attr:`AdapterRunResult.stderr` and re-parse it.

        Args:
            stdout: The run's captured standard output.
            stderr: The run's captured standard error.

        Returns:
            The adapter's normalized findings.
        """
        _ = stderr
        return self.parse_output(stdout)

    def map_envelope(
        self, raw_findings: Sequence[NormalizedToolFinding]
    ) -> List[Dict[str, Any]]:
        """Map raw tool findings into CLX-1.1 envelope findings."""
        return [
            envelope_from_tool_finding(f, category=self.adapter_id)
            for f in raw_findings
        ]

    def map_lint_findings(
        self, raw_findings: Sequence[NormalizedToolFinding]
    ) -> List[LintFinding]:
        """Optional map into score-merge :class:`LintFinding` objects.

        Default: empty — adapters that merge into native scores override this.
        """
        _ = raw_findings
        return []


# ===========================================================================
# run_adapter
# ===========================================================================


async def run_adapter(
    adapter: ExternalLinterAdapter,
    inputs: AdapterInput,
    *,
    runner: Optional[RestrictedRunner] = None,
    timeout: Optional[float] = None,
    policy: Optional[SandboxPolicy] = None,
) -> AdapterRunResult:
    """Execute one adapter under the restricted runner and normalize its output.

    Args:
        adapter: Concrete adapter instance.
        inputs: Files / document / mode for this run.
        runner: Restricted runner (defaults to the process-wide instance).
        timeout: Optional wall-clock timeout.
        policy: Optional sandbox policy override.

    Returns:
        An :class:`AdapterRunResult` with findings or a classified failure kind.
    """
    active = runner if runner is not None else default_restricted_runner
    decl = adapter.declaration()
    base = AdapterRunResult(
        adapter_id=decl.adapter_id,
        scanner_id=decl.scanner_id,
        adapter_version=decl.adapter_version,
        outcome_ready=False,
    )

    with adapter.prepare_workspace(inputs) as workspace:
        args = list(adapter.build_args(inputs, workspace=workspace))
        stdin = adapter.stdin_for(inputs)
        try:
            spec = adapter.tool_spec()
        except Exception as exc:  # noqa: BLE001 — surface as unavailable
            base.failure_kind = FAILURE_UNAVAILABLE
            base.diagnostics = str(exc)
            return base

        outcome = await active.run_spec(
            spec,
            args,
            stdin=stdin,
            timeout=timeout,
            cwd=workspace,
            policy=policy,
            accept_exit_codes=adapter.accept_exit_codes,
        )

        if isinstance(outcome, RestrictedRunFailure):
            # Some tools (Buf) put findings on a non-zero exit that was *not*
            # listed in accept_exit_codes only if the inner runner raised before
            # we could accept it. RestrictedRunner already accepts listed codes;
            # here we only handle true failures — but try parsing crash stdout
            # when the adapter says those exits are findings-shaped.
            if (
                outcome.kind == FAILURE_CRASH
                and outcome.exit_code in adapter.accept_exit_codes
            ):
                return _parse_success(
                    adapter,
                    base,
                    RestrictedRunSuccess(
                        key=outcome.key,
                        argv=outcome.argv,
                        exit_code=outcome.exit_code or 0,
                        stdout=outcome.stdout,
                        stderr=outcome.stderr,
                        duration_ms=0,
                    ),
                )
            base.failure_kind = outcome.kind
            base.diagnostics = outcome.message
            base.exit_code = outcome.exit_code
            base.stdout = outcome.stdout
            base.stderr = outcome.stderr
            return base

        return _parse_success(adapter, base, outcome)


def _parse_success(
    adapter: ExternalLinterAdapter,
    base: AdapterRunResult,
    outcome: RestrictedRunSuccess,
) -> AdapterRunResult:
    base.exit_code = outcome.exit_code
    base.stdout = outcome.stdout
    base.stderr = outcome.stderr
    base.duration_ms = outcome.duration_ms
    try:
        raw = adapter.parse_streams(outcome.stdout, outcome.stderr)
    except AdapterOutputError as exc:
        base.failure_kind = FAILURE_MALFORMED
        base.diagnostics = str(exc)
        return base
    base.raw_findings = list(raw)
    base.envelope_findings = adapter.map_envelope(raw)
    base.lint_findings = adapter.map_lint_findings(raw)
    base.outcome_ready = True
    return base


# ===========================================================================
# Buf lint adapter (real-tool conformance target)
# ===========================================================================

BUF_LINT_ADAPTER_ID = "buf.lint"
BUF_LINT_SCANNER_ID = "buf.lint"
BUF_LINT_ADAPTER_VERSION = "apiome-buf-lint/1"
BUF_LINT_RULE_PREFIX = "protobuf.buf"
_BUF_LINT_VIOLATIONS_EXIT = 100
_BUF_SEVERITY: Severity = "warning"


class BufLintAdapter(ExternalLinterAdapter, register=True):
    """``buf lint`` via the restricted runner — authoritative protobuf style rules."""

    adapter_id = BUF_LINT_ADAPTER_ID
    scanner_id = BUF_LINT_SCANNER_ID
    formats = (InputFormat.PROTOBUF,)
    scan_modes = (ScanMode.LINT,)
    tool_key = "buf"
    output_format = OUTPUT_FORMAT_JSONL
    adapter_version = BUF_LINT_ADAPTER_VERSION
    description = "buf lint → findings over a scratch protobuf module (CLX-2.1)."
    accept_exit_codes = (_BUF_LINT_VIOLATIONS_EXIT,)

    def tool_spec(self) -> ToolSpec:
        from .toolchain_packaging import bundled_tool
        from .proto_descriptor import BUF_TOOL_KEY

        tool = bundled_tool(BUF_TOOL_KEY)
        executable = tool.executable if tool is not None else "buf"
        env_override_keys = (tool.env_override_key,) if tool is not None else ()
        default_timeout = tool.default_timeout_seconds if tool is not None else 60.0
        return ToolSpec(
            key=BUF_TOOL_KEY,
            executable=executable,
            description=self.description,
            base_args=("lint",),
            default_timeout_seconds=default_timeout,
            env_override_keys=env_override_keys,
            parses_json=False,
        )

    def prepare_workspace(
        self, inputs: AdapterInput
    ) -> AbstractContextManager[Optional[str]]:
        from .proto_descriptor import ProtoFile, materialize_proto_module
        from .proto_lint import BUF_LINT_MODULE_YAML

        files = [
            ProtoFile(path=path, content=content)
            for path, content in sorted(inputs.files.items())
        ]
        if not files:
            raise ValueError("BufLintAdapter requires at least one .proto file in inputs.files")

        class _Scratch:
            def __enter__(self_inner) -> str:
                self_inner._tmp = tempfile.TemporaryDirectory(prefix="apiome-proto-lint-")
                root = self_inner._tmp.__enter__()
                materialize_proto_module(root, files, buf_yaml=BUF_LINT_MODULE_YAML)
                return root

            def __exit__(self_inner, *exc: Any) -> None:
                self_inner._tmp.__exit__(*exc)

        return _Scratch()

    def build_args(
        self, inputs: AdapterInput, *, workspace: Optional[str]
    ) -> Sequence[str]:
        _ = inputs
        if not workspace:
            raise ValueError("BufLintAdapter requires a materialized workspace")
        return [workspace, "--error-format=json"]

    def parse_output(self, stdout: str) -> List[NormalizedToolFinding]:
        # Buf may emit banners; keep the historical tolerant parser for JSONL.
        return parse_jsonl_tolerant(stdout)

    def map_lint_findings(
        self, raw_findings: Sequence[NormalizedToolFinding]
    ) -> List[LintFinding]:
        findings: List[LintFinding] = []
        for finding in raw_findings:
            if not isinstance(finding, dict):
                continue
            findings.append(
                LintFinding(
                    path=_buf_path(finding),
                    category="buf-lint",
                    rule=_buf_rule_id(finding.get("type")),
                    severity=_BUF_SEVERITY,
                    message=str(finding.get("message", "") or ""),
                )
            )
        return findings

    def map_envelope(
        self, raw_findings: Sequence[NormalizedToolFinding]
    ) -> List[Dict[str, Any]]:
        envelopes: List[Dict[str, Any]] = []
        for finding in raw_findings:
            if not isinstance(finding, dict):
                continue
            normalized = {
                "rule_id": _buf_rule_id(finding.get("type")),
                "message": finding.get("message"),
                "severity": _BUF_SEVERITY,
                "path": finding.get("path"),
                "start_line": finding.get("start_line"),
                "start_column": finding.get("start_column"),
                "category": "buf-lint",
            }
            envelopes.append(
                envelope_from_tool_finding(
                    normalized, default_severity=_BUF_SEVERITY, category="buf-lint"
                )
            )
        return envelopes


def _buf_rule_id(raw_type: Any) -> str:
    rule = str(raw_type).strip().lower() if raw_type is not None else ""
    return f"{BUF_LINT_RULE_PREFIX}.{rule or 'unknown'}"


def _buf_path(finding: Mapping[str, Any]) -> str:
    base = finding.get("path")
    base = base.strip() if isinstance(base, str) and base.strip() else "(proto)"
    line = finding.get("start_line")
    column = finding.get("start_column")
    if isinstance(line, int):
        if isinstance(column, int):
            return f"{base}:{line}:{column}"
        return f"{base}:{line}"
    return base


async def run_buf_lint_via_adapter(
    files: Sequence[Any],
    *,
    runner: Any = None,
    timeout: Optional[float] = None,
    policy: Any = None,
) -> List[Dict[str, Any]]:
    """Run Buf lint through the SPI and return raw finding dicts (proto_lint bridge).

    Args:
        files: Sequence of objects with ``path`` and ``content`` (``ProtoFile``).
        runner: Optional toolchain runner (wrapped in :class:`RestrictedRunner`).
        timeout: Optional timeout.
        policy: Optional sandbox policy.

    Returns:
        Parsed buf finding dicts (empty when clean).

    Raises:
        ValueError: When ``files`` is empty.
        RuntimeError: When the adapter fails operationally (caller maps to ProtoLintError).
    """
    file_map = {str(f.path): str(f.content) for f in files}
    if not file_map:
        raise ValueError("At least one .proto file is required to lint")

    restricted: RestrictedRunner
    if runner is None:
        restricted = default_restricted_runner
    elif isinstance(runner, RestrictedRunner):
        restricted = runner
    else:
        restricted = RestrictedRunner(inner=runner)

    result = await run_adapter(
        BufLintAdapter(),
        AdapterInput(files=file_map, format=InputFormat.PROTOBUF, scan_mode=ScanMode.LINT),
        runner=restricted,
        timeout=timeout,
        policy=policy,
    )
    if result.failure_kind:
        raise RuntimeError(result.diagnostics or result.failure_kind)
    return list(result.raw_findings)
