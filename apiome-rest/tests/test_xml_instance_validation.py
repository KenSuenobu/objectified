"""Tests for XML instance validation through the external-linter seam — IXH-5.1 (#5113).

``xmllint`` is not bundled, so these tests never depend on it being installed: the runner is
faked with recorded stdout/stderr/exit codes, which is also the only way to assert the
*unavailable* and *schema-did-not-compile* paths deterministically. The three contracts under
test are the diagnostic parser, the adapter's argv/workspace discipline, and the promise that a
non-run is reported as "not checked" rather than as a pass or a failure.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.external_linter_adapter import (
    AdapterInput,
    InputFormat,
    ScanMode,
    adapters_for_format,
    get_adapter,
)
from app.external_linter_runner import (
    FAILURE_TIMEOUT,
    FAILURE_UNAVAILABLE,
    RestrictedRunFailure,
    RestrictedRunSuccess,
)
from app.xml_instance_validation import (
    XML_SCHEMA_SOURCE_FORMATS,
    XMLLINT_ADAPTER_ID,
    XmllintValidateAdapter,
    parse_xmllint_diagnostics,
    validate_xml_instance,
)

_SCHEMA = """<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="note">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="to" type="xs:string"/>
        <xs:element name="priority" type="xs:integer"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>
"""

_INSTANCE = "<note><to>Ada</to><priority>1</priority></note>"

#: A real libxml2 rejection, reproduced verbatim so the parser is tested against the shape the
#: tool actually emits rather than against an idealized one.
_REJECTION_STDERR = (
    "instance.xml:1: element priority: Schemas validity error : Element 'priority': "
    "'high' is not a valid value of the atomic type 'xs:integer'.\n"
    "instance.xml fails to validate\n"
)


class _FakeRunner:
    """A :class:`RestrictedRunner` stand-in returning a scripted outcome.

    Records the spec and args it was handed so the argv discipline can be asserted without
    executing anything.
    """

    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome
        self.calls: List[Dict[str, Any]] = []

    async def run_spec(
        self,
        spec: Any,
        args: Sequence[str] = (),
        *,
        stdin: Optional[str] = None,
        timeout: Optional[float] = None,
        cwd: Optional[str] = None,
        extra_env: Optional[Dict[str, str]] = None,
        policy: Any = None,
        accept_exit_codes: Sequence[int] = (),
    ) -> Any:
        self.calls.append(
            {
                "spec": spec,
                "args": list(args),
                "cwd": cwd,
                "accept_exit_codes": tuple(accept_exit_codes),
            }
        )
        return self.outcome


def _success(exit_code: int, stderr: str = "") -> RestrictedRunSuccess:
    return RestrictedRunSuccess(
        key="xmllint",
        argv=("xmllint",),
        exit_code=exit_code,
        stdout="",
        stderr=stderr,
        duration_ms=1,
    )


# ===========================================================================
# Diagnostic parsing
# ===========================================================================


def test_parses_a_real_libxml2_rejection() -> None:
    """The element, line, domain, and message are all recovered from one stderr line."""
    findings = parse_xmllint_diagnostics(_REJECTION_STDERR)

    assert len(findings) == 1
    assert findings[0]["path"] == "priority"
    assert findings[0]["line"] == 1
    assert findings[0]["rule_id"] == "Schemas validity error"
    assert findings[0]["severity"] == "error"
    assert "not a valid value" in findings[0]["message"]


def test_summary_lines_are_not_double_counted() -> None:
    """``… fails to validate`` restates the verdict and must not become a second finding."""
    findings = parse_xmllint_diagnostics(
        "instance.xml:3: Schemas validity error : Element 'to': missing\n"
        "instance.xml fails to validate\n"
    )

    assert len(findings) == 1


def test_unrecognized_stderr_lines_are_kept_not_dropped() -> None:
    """A line the parser cannot decompose still reaches the caller as a finding."""
    findings = parse_xmllint_diagnostics("something entirely unexpected\n")

    assert findings == [
        {"rule_id": "xmllint", "message": "something entirely unexpected", "severity": "error"}
    ]


def test_empty_stderr_yields_no_findings() -> None:
    """A clean run reports nothing."""
    assert parse_xmllint_diagnostics("") == []
    assert parse_xmllint_diagnostics("\n  \n") == []


# ===========================================================================
# Adapter registration and argv discipline
# ===========================================================================


def test_adapter_is_registered_under_the_xml_format() -> None:
    """The adapter is discoverable through the seam's registry, like every other adapter."""
    assert get_adapter(XMLLINT_ADAPTER_ID) is XmllintValidateAdapter
    assert XmllintValidateAdapter in adapters_for_format(InputFormat.XML)

    declaration = XmllintValidateAdapter.declaration()
    assert declaration.scan_modes == (ScanMode.VALIDATE,)
    assert declaration.tool_key == "xmllint"


def test_argv_names_only_fixed_workspace_relative_files() -> None:
    """No caller-controlled string ever reaches argv; the tool sees two fixed filenames."""
    adapter = XmllintValidateAdapter()
    inputs = AdapterInput(files={"schema.xsd": _SCHEMA, "instance.xml": _INSTANCE})

    args = adapter.build_args(inputs, workspace="/tmp/scratch")

    assert list(args) == ["--schema", "schema.xsd", "instance.xml"]
    assert adapter.tool_spec().base_args == ("--noout", "--nonet")


def test_build_args_refuses_to_run_without_a_workspace() -> None:
    """The tool reads files; running it with nothing materialized is a programming error."""
    with pytest.raises(ValueError):
        XmllintValidateAdapter().build_args(AdapterInput(), workspace=None)


def test_workspace_materializes_both_documents() -> None:
    """The scratch directory holds exactly the schema and the instance the caller supplied."""
    from pathlib import Path

    adapter = XmllintValidateAdapter()
    inputs = AdapterInput(files={"schema.xsd": _SCHEMA, "instance.xml": _INSTANCE})

    with adapter.prepare_workspace(inputs) as workspace:
        root = Path(workspace)
        assert (root / "schema.xsd").read_text(encoding="utf-8") == _SCHEMA
        assert (root / "instance.xml").read_text(encoding="utf-8") == _INSTANCE

    assert not Path(workspace).exists()


# ===========================================================================
# Verdicts
# ===========================================================================


@pytest.mark.asyncio
async def test_clean_run_reports_valid() -> None:
    """Exit 0 with no diagnostics is the only thing that produces ``valid = True``."""
    runner = _FakeRunner(_success(0))

    result = await validate_xml_instance(
        _SCHEMA, _INSTANCE, max_findings=100, runner=runner
    )

    assert result.valid is True
    assert result.validated is True
    assert result.findings == []
    assert runner.calls[0]["args"] == ["--schema", "schema.xsd", "instance.xml"]


@pytest.mark.asyncio
async def test_validation_error_exit_becomes_findings() -> None:
    """libxml2's validation-error exit is a verdict, not a crash."""
    runner = _FakeRunner(_success(3, _REJECTION_STDERR))

    result = await validate_xml_instance(
        _SCHEMA, _INSTANCE, max_findings=100, runner=runner
    )

    assert result.valid is False
    assert result.validated is True
    assert len(result.findings) == 1
    finding = result.findings[0]
    assert finding.pointer == "/priority"
    assert finding.line == 1
    assert finding.keyword == "Schemas validity error"
    assert 3 in XmllintValidateAdapter.accept_exit_codes


@pytest.mark.asyncio
async def test_schema_compilation_error_blames_the_schema_not_the_payload() -> None:
    """A grammar that will not compile yields ``valid = None``, never ``valid = False``."""
    runner = _FakeRunner(
        _success(5, "schema.xsd:2: Schemas parser error : element decl: bad type\n")
    )

    result = await validate_xml_instance(
        _SCHEMA, _INSTANCE, max_findings=100, runner=runner
    )

    assert result.valid is None
    assert result.validated is False
    assert result.findings == []
    assert [d.code for d in result.diagnostics] == ["INPUT_SEMANTIC_INVALID"]
    assert "could not be compiled" in result.diagnostics[0].message


@pytest.mark.asyncio
async def test_missing_toolchain_reports_not_checked() -> None:
    """Without ``xmllint`` a valid payload is never failed and never silently passed."""
    runner = _FakeRunner(
        RestrictedRunFailure(
            key="xmllint",
            argv=("xmllint",),
            kind=FAILURE_UNAVAILABLE,
            message="tool 'xmllint' is not available",
        )
    )

    result = await validate_xml_instance(
        _SCHEMA, _INSTANCE, max_findings=100, runner=runner
    )

    assert result.valid is None
    assert result.validated is False
    assert [d.code for d in result.diagnostics] == ["ADAPTER_UNAVAILABLE"]


@pytest.mark.asyncio
async def test_timeout_reports_not_checked() -> None:
    """A timeout is an operational fault, not a verdict about the payload."""
    runner = _FakeRunner(
        RestrictedRunFailure(
            key="xmllint", argv=("xmllint",), kind=FAILURE_TIMEOUT, message="timed out"
        )
    )

    result = await validate_xml_instance(
        _SCHEMA, _INSTANCE, max_findings=100, runner=runner
    )

    assert result.valid is None
    assert result.validated is False
    assert [d.code for d in result.diagnostics] == ["INTERNAL_ADAPTER_FAULT"]


@pytest.mark.asyncio
async def test_findings_are_capped_but_the_total_is_reported() -> None:
    """The XML path honours ``max_findings`` the same way the JSON path does."""
    stderr = "".join(
        f"instance.xml:{n}: element e{n}: Schemas validity error : bad\n" for n in range(1, 8)
    )
    runner = _FakeRunner(_success(3, stderr))

    result = await validate_xml_instance(_SCHEMA, _INSTANCE, max_findings=3, runner=runner)

    assert len(result.findings) == 3
    assert result.total_findings == 7
    assert result.truncated is True


# ===========================================================================
# Security guards run before the tool does
# ===========================================================================


@pytest.mark.asyncio
async def test_instance_with_a_dtd_is_rejected_before_the_tool_runs() -> None:
    """An entity-expansion payload never reaches libxml2 — our own guard stops it."""
    runner = _FakeRunner(_success(0))
    hostile = (
        '<?xml version="1.0"?>'
        '<!DOCTYPE note [<!ENTITY lol "lollolol">]>'
        "<note><to>&lol;</to></note>"
    )

    result = await validate_xml_instance(
        _SCHEMA, hostile, max_findings=100, runner=runner
    )

    assert result.valid is None
    assert result.validated is False
    assert [d.code for d in result.diagnostics] == ["INPUT_UNSAFE_CONSTRUCT"]
    assert runner.calls == []


@pytest.mark.asyncio
async def test_malformed_instance_is_rejected_before_the_tool_runs() -> None:
    """Syntactically broken XML fails our parser, with the malformed-input code."""
    runner = _FakeRunner(_success(0))

    result = await validate_xml_instance(
        _SCHEMA, "<note><to>unclosed", max_findings=100, runner=runner
    )

    assert result.valid is None
    assert result.validated is False
    assert [d.code for d in result.diagnostics] == ["INPUT_MALFORMED"]
    assert runner.calls == []


def test_xml_schema_source_formats_are_the_xml_grammar_families() -> None:
    """Only formats whose captured source *is* an XML grammar may back XML validation."""
    assert XML_SCHEMA_SOURCE_FORMATS == frozenset({"xsd", "wsdl"})
