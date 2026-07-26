"""Validate an XML instance against an XML Schema, via the external-linter seam — IXH-5.1 (#5113).

The instance-validation service accepts JSON **and** XML payloads, but the two are not
symmetric: JSON Schema validation is a pure-Python library call (:mod:`app.schema_instance_validation`),
while XML Schema validation needs a real XSD processor. The IXH-5.1 scope is explicit that this
must "dispatch to the appropriate validator through the existing external-linter adapter seam
rather than inlining a second toolchain", and this module is that dispatch:

* :class:`XmllintValidateAdapter` is an ordinary :class:`~app.external_linter_adapter.ExternalLinterAdapter`
  — declared formats, declared tool key, sandboxed argv through
  :class:`~app.external_linter_runner.RestrictedRunner`, and its diagnostics parsed into the
  same normalized finding shape every other adapter produces. It therefore inherits the seam's
  availability handling, no-network sandbox policy, output caps, and evidence mapping for free.
* :func:`validate_xml_instance` runs it and collapses the result into the same
  :class:`~app.schema_instance_validation.InstanceFinding` /
  :class:`~app.schema_instance_validation.ValidationDiagnostic` vocabulary the JSON path uses,
  so one API response shape covers both media types.

**Honesty about what ran.** ``xmllint`` is not bundled: a deployment without it must not turn a
*valid* payload into a failure. A missing tool yields ``validated=False`` with an
``ADAPTER_UNAVAILABLE`` diagnostic and ``valid=None`` — never ``valid=True`` (a false pass) and
never ``valid=False`` (a false accusation). This is the same contract
:mod:`app.export_validation` uses for its toolchain-backed validators.

**Security.** Both documents pass through :func:`app.secure_xml.parse_xml` *before* the tool is
invoked, so a DTD, an entity definition, an external reference, an XInclude directive, an
oversized document, or an over-deep tree is rejected by our own guard rather than being handed to
libxml2. The argv adds ``--nonet`` as a second line of defence, and the sandbox policy already
denies network access. There is no code path here that fetches a schema location declared inside
the instance.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, ClassVar, Dict, List, Optional, Sequence, Tuple

from .external_linter_adapter import (
    AdapterInput,
    ExternalLinterAdapter,
    InputFormat,
    ScanMode,
    run_adapter,
)
from .external_linter_parsers import OUTPUT_FORMAT_JSON, NormalizedToolFinding
from .external_linter_runner import (
    FAILURE_TIMEOUT,
    FAILURE_UNAVAILABLE,
    RestrictedRunner,
)
from .schema_instance_validation import InstanceFinding, ValidationDiagnostic
from .secure_xml import SecureXmlError, parse_xml
from .toolchain_runner import ToolSpec

__all__ = [
    "XMLLINT_ADAPTER_ID",
    "XMLLINT_ADAPTER_VERSION",
    "XMLLINT_TOOL_KEY",
    "XML_SCHEMA_SOURCE_FORMATS",
    "XmlValidationResult",
    "XmllintValidateAdapter",
    "parse_xmllint_diagnostics",
    "validate_xml_instance",
]

#: Registry id of the adapter, and the toolchain key it needs.
XMLLINT_ADAPTER_ID = "xmllint.validate"
XMLLINT_TOOL_KEY = "xmllint"
XMLLINT_ADAPTER_VERSION = "apiome-xmllint-validate/1"

#: Filenames used inside the scratch workspace. Fixed (not derived from user input) so nothing
#: a caller supplies can influence a path.
_SCHEMA_FILENAME = "schema.xsd"
_INSTANCE_FILENAME = "instance.xml"

#: Import-source format keys whose captured source *is* an XML-schema grammar, and can therefore
#: back XML instance validation. WSDL carries its XSD inline in ``wsdl:types``; ``xmllint
#: --schema`` reads the schema element out of it, so the raw WSDL is a usable schema document.
XML_SCHEMA_SOURCE_FORMATS = frozenset({"xsd", "wsdl"})

#: xmllint exit codes that mean "the tool ran and judged the document", not "the tool broke".
#: 3 and 4 are its two validation-error codes; 5 is a schema-compilation error, which is a fault
#: in the *schema* and is reported as a diagnostic rather than as an instance finding.
_EXIT_VALIDATION_ERROR = (3, 4)
_EXIT_SCHEMA_ERROR = 5

#: ``file:line: element name: Domain Kind : message`` — the shape libxml2 writes to stderr. The
#: element clause and the domain/kind clause are both optional across libxml2 versions, so
#: everything after the line number is matched leniently and split afterwards.
_XMLLINT_LINE_RE = re.compile(
    r"^(?P<file>[^:]*):(?P<line>\d+):\s*(?P<rest>.*)$"
)

#: ``element foo:`` prefix libxml2 puts before the diagnostic proper.
_ELEMENT_CLAUSE_RE = re.compile(r"^element\s+(?P<element>\S+?):\s*(?P<rest>.*)$")

#: ``Schemas validity error :`` / ``Schemas parser error :`` — the domain/kind clause.
_DOMAIN_CLAUSE_RE = re.compile(
    r"^(?P<domain>[A-Za-z][A-Za-z ]*?(?:error|warning))\s*:\s*(?P<rest>.*)$",
    re.IGNORECASE,
)

#: Summary lines libxml2 emits after the diagnostics; they restate the verdict and carry no
#: location, so folding them into findings would double-count every failure.
_SUMMARY_SUFFIXES = (
    "fails to validate",
    "validates",
)


@dataclass
class XmlValidationResult:
    """The outcome of validating one XML instance against one XML schema.

    Mirrors :class:`~app.schema_instance_validation.JsonValidationResult` so the API surface can
    treat both media types uniformly.

    Attributes:
        valid: ``True`` when the tool ran and accepted the instance, ``False`` when it ran and
            rejected it, ``None`` when it could not run (missing tool, unusable schema).
        validated: Whether a validator actually executed over the instance.
        validator: Identifier of the validator (the adapter id, so evidence traces back).
        findings: Ordered findings — instance rejections only.
        diagnostics: Conditions that limited the validation.
        total_findings: Findings produced before ``max_findings`` truncation.
        truncated: Whether ``findings`` was cut short by ``max_findings``.
    """

    valid: Optional[bool]
    validated: bool
    validator: str = XMLLINT_ADAPTER_ID
    findings: List[InstanceFinding] = field(default_factory=list)
    diagnostics: List[ValidationDiagnostic] = field(default_factory=list)
    total_findings: int = 0
    truncated: bool = False


class XmllintValidateAdapter(ExternalLinterAdapter, register=True):
    """``xmllint --schema`` via the restricted runner — XML instance validation.

    Declares :data:`~app.external_linter_adapter.ScanMode.VALIDATE` over
    :data:`~app.external_linter_adapter.InputFormat.XML`. Inputs arrive through
    :attr:`~app.external_linter_adapter.AdapterInput.files` as the fixed pair
    ``schema.xsd`` / ``instance.xml``; the adapter materializes them into a scratch directory and
    invokes the tool with relative paths, so no caller-controlled string ever reaches argv.
    """

    adapter_id: ClassVar[str] = XMLLINT_ADAPTER_ID
    scanner_id: ClassVar[str] = XMLLINT_ADAPTER_ID
    formats: ClassVar[Tuple[str, ...]] = (InputFormat.XML,)
    scan_modes: ClassVar[Tuple[str, ...]] = (ScanMode.VALIDATE,)
    tool_key: ClassVar[str] = XMLLINT_TOOL_KEY
    # Declared for the seam's bookkeeping only: findings come from stderr via parse_streams,
    # never from a JSON stdout document (xmllint has no machine-readable output mode).
    output_format: ClassVar[str] = OUTPUT_FORMAT_JSON
    adapter_version: ClassVar[str] = XMLLINT_ADAPTER_VERSION
    description: ClassVar[str] = (
        "xmllint --schema → XML instance validation findings (IXH-5.1)."
    )
    accept_exit_codes: ClassVar[Tuple[int, ...]] = (*_EXIT_VALIDATION_ERROR, _EXIT_SCHEMA_ERROR)

    def tool_spec(self) -> ToolSpec:
        """Describe the ``xmllint`` invocation (no bundled build; resolved on ``PATH``)."""
        return ToolSpec(
            key=XMLLINT_TOOL_KEY,
            executable="xmllint",
            description=self.description,
            # --noout: we want diagnostics, never a re-serialized copy of the instance.
            # --nonet: never fetch a schemaLocation or DTD over the network.
            base_args=("--noout", "--nonet"),
            default_timeout_seconds=30.0,
            env_override_keys=("APIOME_XMLLINT_PATH",),
            parses_json=False,
        )

    def prepare_workspace(self, inputs: AdapterInput) -> Any:
        """Materialize the schema and instance into a private scratch directory."""
        return _XmlWorkspace(inputs)

    def build_args(
        self, inputs: AdapterInput, *, workspace: Optional[str]
    ) -> Sequence[str]:
        """Return ``--schema schema.xsd instance.xml`` (relative to the scratch workspace)."""
        if not workspace:
            raise ValueError("XmllintValidateAdapter requires a materialized workspace")
        _ = inputs
        return ["--schema", _SCHEMA_FILENAME, _INSTANCE_FILENAME]

    def parse_output(self, stdout: str) -> List[NormalizedToolFinding]:
        """xmllint writes nothing useful to stdout under ``--noout``."""
        _ = stdout
        return []

    def parse_streams(self, stdout: str, stderr: str) -> List[NormalizedToolFinding]:
        """Parse libxml2's stderr diagnostics — the tool's only output channel."""
        _ = stdout
        return parse_xmllint_diagnostics(stderr)


class _XmlWorkspace:
    """Context manager writing the fixed schema/instance pair into a temporary directory."""

    def __init__(self, inputs: AdapterInput) -> None:
        self._inputs = inputs
        self._tmp = TemporaryDirectory(prefix="apiome-xmlvalidate-")

    def __enter__(self) -> str:
        root = Path(self._tmp.__enter__())
        for name in (_SCHEMA_FILENAME, _INSTANCE_FILENAME):
            content = self._inputs.files.get(name)
            if content is None:
                raise ValueError(f"XML validation workspace is missing {name!r}")
            (root / name).write_text(content, encoding="utf-8")
        return str(root)

    def __exit__(self, *exc: Any) -> None:
        self._tmp.__exit__(*exc)


def parse_xmllint_diagnostics(stderr: str) -> List[NormalizedToolFinding]:
    """Parse ``xmllint`` stderr into normalized findings.

    libxml2 writes one diagnostic per line, in the shape
    ``instance.xml:7: element price: Schemas validity error : Element 'price': '-1' is not a
    valid value``. Every clause after the line number is optional across libxml2 versions, so
    the parse degrades gracefully: an unrecognized line still becomes a finding carrying its
    message, rather than being dropped.

    Args:
        stderr: The captured standard error of one ``xmllint`` run.

    Returns:
        Normalized finding mappings in emission order, with ``path`` (the element name when
        libxml2 named one), ``line``, ``rule_id`` (the diagnostic domain, e.g.
        ``Schemas validity error``), and ``message``. Summary lines (``… fails to validate``)
        are excluded — they restate the verdict without adding a location.
    """
    findings: List[NormalizedToolFinding] = []
    for raw_line in (stderr or "").splitlines():
        line = raw_line.strip()
        if not line or _is_summary_line(line):
            continue
        match = _XMLLINT_LINE_RE.match(line)
        if match is None:
            findings.append(
                {"rule_id": "xmllint", "message": line, "severity": "error"}
            )
            continue

        rest = match.group("rest").strip()
        element: Optional[str] = None
        element_match = _ELEMENT_CLAUSE_RE.match(rest)
        if element_match is not None:
            element = element_match.group("element")
            rest = element_match.group("rest").strip()

        domain = "xmllint"
        domain_match = _DOMAIN_CLAUSE_RE.match(rest)
        if domain_match is not None:
            domain = domain_match.group("domain").strip()
            rest = domain_match.group("rest").strip()

        finding: NormalizedToolFinding = {
            "rule_id": domain,
            "message": rest or line,
            "severity": "warning" if domain.lower().endswith("warning") else "error",
            "line": int(match.group("line")),
        }
        if element:
            finding["path"] = element
        findings.append(finding)
    return findings


def _is_summary_line(line: str) -> bool:
    """Return ``True`` for libxml2's trailing verdict lines, which carry no new information."""
    return any(line.endswith(suffix) for suffix in _SUMMARY_SUFFIXES)


async def validate_xml_instance(
    schema_text: str,
    instance_text: str,
    *,
    max_findings: int,
    runner: Optional[RestrictedRunner] = None,
) -> XmlValidationResult:
    """Validate an XML instance against an XML-schema document.

    Args:
        schema_text: The XML-schema grammar (an XSD, or a WSDL carrying one inline).
        instance_text: The XML payload to check.
        max_findings: Cap on returned findings.
        runner: Restricted runner override (tests inject a fake; production uses the default).

    Returns:
        The :class:`XmlValidationResult`. ``valid`` is ``None`` whenever the tool did not
        actually judge the instance — a missing ``xmllint``, a timeout, an unsafe document, or
        a schema that failed to compile — so a caller can never read a non-run as a pass.
    """
    diagnostics: List[ValidationDiagnostic] = []

    # Guard both documents with the IXH-1.4 hardened parser before libxml2 ever sees them.
    for label, text in (("schema", schema_text), ("instance", instance_text)):
        try:
            parse_xml(text, source_label=label)
        except SecureXmlError as exc:
            return XmlValidationResult(
                valid=None,
                validated=False,
                diagnostics=[
                    ValidationDiagnostic(
                        code=exc.code,
                        message=f"The XML {label} was rejected before validation: {exc}",
                    )
                ],
            )

    result = await run_adapter(
        XmllintValidateAdapter(),
        AdapterInput(
            files={_SCHEMA_FILENAME: schema_text, _INSTANCE_FILENAME: instance_text},
            format=InputFormat.XML,
            scan_mode=ScanMode.VALIDATE,
        ),
        runner=runner,
    )

    if not result.outcome_ready:
        diagnostics.append(_failure_diagnostic(result.failure_kind, result.diagnostics))
        return XmlValidationResult(
            valid=None, validated=False, diagnostics=diagnostics
        )

    if result.exit_code == _EXIT_SCHEMA_ERROR:
        # The grammar itself did not compile. Reporting the instance as invalid here would
        # blame the payload for the schema's fault.
        detail = "; ".join(
            str(item.get("message", "")).strip()
            for item in result.raw_findings
            if item.get("message")
        )
        diagnostics.append(
            ValidationDiagnostic(
                code="INPUT_SEMANTIC_INVALID",
                message=(
                    "The stored XML schema could not be compiled and cannot validate "
                    "anything" + (f": {detail}" if detail else ".")
                ),
            )
        )
        return XmlValidationResult(
            valid=None, validated=False, diagnostics=diagnostics
        )

    findings = [_to_finding(item) for item in result.raw_findings]
    return XmlValidationResult(
        valid=not findings,
        validated=True,
        findings=findings[:max_findings],
        diagnostics=diagnostics,
        total_findings=len(findings),
        truncated=len(findings) > max_findings,
    )


def _failure_diagnostic(
    failure_kind: Optional[str], detail: Optional[str]
) -> ValidationDiagnostic:
    """Map an adapter operational failure onto an intake-taxonomy diagnostic."""
    suffix = f" ({detail})" if detail else ""
    if failure_kind == FAILURE_UNAVAILABLE:
        return ValidationDiagnostic(
            code="ADAPTER_UNAVAILABLE",
            message=(
                "XML instance validation needs the `xmllint` tool, which is not available on "
                "this server, so the payload was not checked" + suffix + "."
            ),
        )
    if failure_kind == FAILURE_TIMEOUT:
        return ValidationDiagnostic(
            code="INTERNAL_ADAPTER_FAULT",
            message="XML validation timed out before the validator reached a verdict" + suffix + ".",
        )
    return ValidationDiagnostic(
        code="INTERNAL_ADAPTER_FAULT",
        message="The XML validator failed to produce a verdict" + suffix + ".",
    )


def _to_finding(item: Dict[str, Any]) -> InstanceFinding:
    """Project one normalized xmllint finding into the shared :class:`InstanceFinding` shape.

    XML has no JSON Pointer, so the element name libxml2 reports becomes the pointer's single
    token (``/price``) and the document root stays ``""`` — the same convention the JSON path
    uses, which keeps one renderer able to display both.
    """
    element = item.get("path")
    return InstanceFinding(
        pointer=f"/{element}" if element else "",
        keyword=str(item.get("rule_id") or "xmllint"),
        schema_pointer="",
        expected=None,
        actual=None,
        message=str(item.get("message") or "").strip() or "XML schema validation failed.",
        line=item.get("line") if isinstance(item.get("line"), int) else None,
    )
