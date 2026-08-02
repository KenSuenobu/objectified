"""Unit tests for the pure ``apiome schema test`` logic (IXH-5.5 / #5117)."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SCHEMA_TEST_FAILED, EXIT_SUCCESS
from apiome_cli.schema_test import (
    MEDIA_TYPE_JSON,
    MEDIA_TYPE_XML,
    SOURCE_PAYLOAD,
    SOURCE_SUITE,
    STATUS_ERROR,
    STATUS_FAILED,
    STATUS_PASSED,
    SchemaTestCase,
    SuiteLoadError,
    SuitePayload,
    build_report,
    case_from_validation,
    cases_from_synthesis,
    exit_code_for_cases,
    load_payload_file,
    load_suite,
    media_type_for_path,
    render_human,
    render_junit,
    summarize_cases,
)

_REF = "project/petstore/1.0.0/Pet"


def _payload(name: str = "pet", expected_valid: bool = True) -> SuitePayload:
    return SuitePayload(
        name=name,
        path=f"/tmp/{name}.json",
        payload_text="{}",
        media_type=MEDIA_TYPE_JSON,
        expected_valid=expected_valid,
    )


def _validate_response(**overrides: object) -> dict:
    response: dict = {
        "ok": True,
        "valid": True,
        "validated": True,
        "validator": "jsonschema/2020-12",
        "schema_ref": _REF,
        "media_type": MEDIA_TYPE_JSON,
        "source": {"kind": "project", "projected": True, "coordinates": {}},
        "findings": [],
        "total_findings": 0,
        "truncated": False,
        "diagnostics": [],
        "error": None,
    }
    response.update(overrides)
    return response


_TYPE_FINDING = {
    "pointer": "/age",
    "keyword": "type",
    "schema_pointer": "/properties/age/type",
    "expected": "integer",
    "actual": "'x'",
    "message": "'x' is not of type 'integer'",
}


# ===========================================================================
# Suite discovery
# ===========================================================================


class TestSuiteDiscovery:
    def test_media_type_by_suffix(self) -> None:
        assert media_type_for_path(Path("a.json")) == MEDIA_TYPE_JSON
        assert media_type_for_path(Path("a.XML")) == MEDIA_TYPE_XML

    def test_load_payload_file_reads_text(self, tmp_path: Path) -> None:
        file = tmp_path / "pet.json"
        file.write_text('{"name": "Rex"}', encoding="utf-8")
        loaded = load_payload_file(file)
        assert loaded.name == "pet"
        assert loaded.payload_text == '{"name": "Rex"}'
        assert loaded.media_type == MEDIA_TYPE_JSON
        assert loaded.expected_valid is True

    def test_load_payload_file_missing_is_usage_error(self, tmp_path: Path) -> None:
        with pytest.raises(SuiteLoadError, match="cannot read payload file"):
            load_payload_file(tmp_path / "nope.json")

    def test_directory_suite_is_sorted_and_recursive(self, tmp_path: Path) -> None:
        (tmp_path / "nested").mkdir()
        (tmp_path / "b.json").write_text("{}", encoding="utf-8")
        (tmp_path / "nested" / "a.json").write_text("{}", encoding="utf-8")
        (tmp_path / "a.xml").write_text("<pet/>", encoding="utf-8")
        (tmp_path / "README.md").write_text("not a payload", encoding="utf-8")
        payloads = load_suite(tmp_path)
        assert [p.name for p in payloads] == ["a.xml", "b.json", "nested/a.json"]
        assert all(p.expected_valid for p in payloads)
        assert payloads[0].media_type == MEDIA_TYPE_XML

    def test_empty_directory_is_usage_error(self, tmp_path: Path) -> None:
        with pytest.raises(SuiteLoadError, match="contains no .json or .xml payloads"):
            load_suite(tmp_path)

    def test_missing_path_is_usage_error(self, tmp_path: Path) -> None:
        with pytest.raises(SuiteLoadError, match="neither a directory nor a manifest"):
            load_suite(tmp_path / "nope")

    def test_manifest_selects_instance_payload_entries(self, tmp_path: Path) -> None:
        (tmp_path / "payloads").mkdir()
        (tmp_path / "payloads" / "good.json").write_text('{"ok": 1}', encoding="utf-8")
        (tmp_path / "payloads" / "bad.json").write_text('{"ok": "x"}', encoding="utf-8")
        manifest = {
            "manifest_version": 1,
            "entries": [
                {
                    "path": "payloads/good.json",
                    "validity_class": "valid",
                    "features": ["instance-payload", "test-bench"],
                },
                {
                    "path": "payloads/bad.json",
                    "validity_class": "invalid",
                    "features": ["instance-payload"],
                },
                # A spec document entry: no instance-payload feature, never selected.
                {"path": "openapi/petstore.yaml", "features": ["responses"]},
            ],
        }
        manifest_path = tmp_path / "corpus.manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        payloads = load_suite(manifest_path)
        assert [(p.name, p.expected_valid) for p in payloads] == [
            ("payloads/good.json", True),
            ("payloads/bad.json", False),
        ]

    def test_manifest_without_entries_is_usage_error(self, tmp_path: Path) -> None:
        manifest_path = tmp_path / "corpus.manifest.json"
        manifest_path.write_text("{}", encoding="utf-8")
        with pytest.raises(SuiteLoadError, match="no 'entries' list"):
            load_suite(manifest_path)

    def test_manifest_without_instance_payloads_is_usage_error(self, tmp_path: Path) -> None:
        manifest_path = tmp_path / "corpus.manifest.json"
        manifest_path.write_text(
            json.dumps({"entries": [{"path": "a.yaml", "features": ["responses"]}]}),
            encoding="utf-8",
        )
        with pytest.raises(SuiteLoadError, match="names no 'instance-payload' entries"):
            load_suite(manifest_path)

    def test_manifest_naming_missing_file_is_usage_error(self, tmp_path: Path) -> None:
        manifest_path = tmp_path / "corpus.manifest.json"
        manifest_path.write_text(
            json.dumps(
                {"entries": [{"path": "gone.json", "features": ["instance-payload"]}]}
            ),
            encoding="utf-8",
        )
        with pytest.raises(SuiteLoadError, match="cannot read payload file"):
            load_suite(manifest_path)


# ===========================================================================
# Case judging — validate responses
# ===========================================================================


class TestCaseFromValidation:
    def test_expected_valid_and_valid_passes(self) -> None:
        case = case_from_validation(_payload(), _validate_response(), source=SOURCE_PAYLOAD)
        assert case.status == STATUS_PASSED
        assert case.id == "payload:pet"
        assert case.valid is True and case.validated is True

    def test_expected_valid_but_invalid_fails_with_findings(self) -> None:
        response = _validate_response(
            valid=False, findings=[_TYPE_FINDING], total_findings=1
        )
        case = case_from_validation(_payload(), response, source=SOURCE_SUITE)
        assert case.status == STATUS_FAILED
        assert case.id == "suite:pet"
        assert "failed 'type' at '/age'" in case.message
        assert case.findings == [_TYPE_FINDING]

    def test_expected_invalid_and_invalid_passes(self) -> None:
        response = _validate_response(valid=False, findings=[_TYPE_FINDING])
        case = case_from_validation(
            _payload(expected_valid=False), response, source=SOURCE_SUITE
        )
        assert case.status == STATUS_PASSED
        assert case.message == "invalid, as expected"

    def test_expected_invalid_but_valid_fails(self) -> None:
        case = case_from_validation(
            _payload(expected_valid=False), _validate_response(), source=SOURCE_SUITE
        )
        assert case.status == STATUS_FAILED
        assert "expected invalid" in case.message

    def test_unserviceable_response_is_error(self) -> None:
        response = _validate_response(
            ok=False,
            valid=None,
            validated=False,
            error={
                "code": "INPUT_TOO_LARGE",
                "category": "resource",
                "message": "too big",
                "remediation": "shrink it",
            },
        )
        case = case_from_validation(_payload(), response, source=SOURCE_PAYLOAD)
        assert case.status == STATUS_ERROR
        assert "[INPUT_TOO_LARGE] too big — shrink it" == case.message

    def test_null_verdict_is_error_naming_the_diagnostic(self) -> None:
        response = _validate_response(
            valid=None,
            validated=False,
            diagnostics=[{"code": "ADAPTER_UNAVAILABLE", "message": "xmllint missing"}],
        )
        case = case_from_validation(_payload(), response, source=SOURCE_PAYLOAD)
        assert case.status == STATUS_ERROR
        assert "no validator ran — [ADAPTER_UNAVAILABLE] xmllint missing" == case.message


# ===========================================================================
# Case judging — synthesize responses
# ===========================================================================


def _synthesis_response(instances: list[dict], **overrides: object) -> dict:
    response: dict = {
        "ok": True,
        "synthetic": True,
        "notice": "synthetic payloads",
        "schema_ref": _REF,
        "seed": 0,
        "depth_limit": 6,
        "verified": True,
        "instances": instances,
        "counts": {},
        "rejected_mutants": 0,
        "truncated": False,
        "diagnostics": [],
        "error": None,
    }
    response.update(overrides)
    return response


def _mutant(valid: bool | None = False, **detail: object) -> dict:
    mutation = {
        "kind": "type-wrong",
        "keyword": "type",
        "pointer": "/age",
        "reported_keyword": "type",
        "description": "Replace /age with a string.",
    }
    mutation.update(detail)
    return {
        "id": "mutant:type-wrong:type:/age",
        "kind": "mutant",
        "title": "type wrong at /age",
        "description": "violates type",
        "instance": {"age": "x"},
        "synthetic": True,
        "expected_valid": False,
        "valid": valid,
        "findings": [_TYPE_FINDING] if valid is False else [],
        "mutation": mutation,
    }


class TestCasesFromSynthesis:
    def test_valid_instance_and_working_mutant_pass(self) -> None:
        minimal = {
            "id": "minimal",
            "kind": "minimal",
            "title": "minimal valid instance",
            "description": "",
            "instance": {},
            "synthetic": True,
            "expected_valid": True,
            "valid": True,
            "findings": [],
        }
        cases = cases_from_synthesis(_synthesis_response([minimal, _mutant()]))
        assert [c.status for c in cases] == [STATUS_PASSED, STATUS_PASSED]
        mutant_case = cases[1]
        assert mutant_case.kind == "mutant"
        assert "intended to violate 'type' — violated (reported 'type')" == mutant_case.message
        assert mutant_case.mutation is not None
        assert mutant_case.mutation["keyword"] == "type"

    def test_mutant_that_validates_cleanly_fails(self) -> None:
        cases = cases_from_synthesis(_synthesis_response([_mutant(valid=True)]))
        assert cases[0].status == STATUS_FAILED
        assert "did not: the mutant validated cleanly" in cases[0].message

    def test_valid_instance_that_fails_validation_fails(self) -> None:
        broken = {
            "id": "full",
            "kind": "full",
            "title": "full valid instance",
            "description": "",
            "instance": {},
            "synthetic": True,
            "expected_valid": True,
            "valid": False,
            "findings": [_TYPE_FINDING],
        }
        cases = cases_from_synthesis(_synthesis_response([broken]))
        assert cases[0].status == STATUS_FAILED
        assert "generated instance expected valid but failed 'type'" in cases[0].message

    def test_unverified_instance_is_error(self) -> None:
        cases = cases_from_synthesis(_synthesis_response([_mutant(valid=None)]))
        assert cases[0].status == STATUS_ERROR
        assert cases[0].validated is False

    def test_unserviceable_synthesis_is_one_error_case(self) -> None:
        response = _synthesis_response(
            [],
            ok=False,
            error={
                "code": "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                "category": "capability",
                "message": "cannot generate",
                "remediation": "simplify the schema",
            },
        )
        cases = cases_from_synthesis(response)
        assert len(cases) == 1
        assert cases[0].status == STATUS_ERROR
        assert cases[0].id == "generated:synthesis"
        assert "[SYNTHESIS_UNSUPPORTED_CONSTRUCT]" in cases[0].message


# ===========================================================================
# Summary, exit codes, report
# ===========================================================================


def _case(status: str) -> SchemaTestCase:
    return SchemaTestCase(
        id=f"payload:{status}",
        name=status,
        source=SOURCE_PAYLOAD,
        kind="payload",
        path=None,
        expected_valid=True,
        valid=status == STATUS_PASSED,
        validated=status != STATUS_ERROR,
        status=status,
        message=status,
    )


class TestVerdicts:
    def test_summary_counts(self) -> None:
        cases = [_case(STATUS_PASSED), _case(STATUS_FAILED), _case(STATUS_ERROR)]
        assert summarize_cases(cases) == {
            "total": 3,
            "passed": 1,
            "failed": 1,
            "errors": 1,
        }

    def test_failures_dominate_errors(self) -> None:
        cases = [_case(STATUS_FAILED), _case(STATUS_ERROR)]
        assert exit_code_for_cases(cases) == EXIT_SCHEMA_TEST_FAILED

    def test_errors_without_failures_exit_error(self) -> None:
        assert exit_code_for_cases([_case(STATUS_ERROR)]) == EXIT_ERROR

    def test_all_passed_exits_success(self) -> None:
        assert exit_code_for_cases([_case(STATUS_PASSED)]) == EXIT_SUCCESS

    def test_empty_run_is_never_green(self) -> None:
        assert exit_code_for_cases([]) == EXIT_ERROR


# ===========================================================================
# Renderings
# ===========================================================================


def _report() -> dict:
    passed = _case(STATUS_PASSED)
    failed = SchemaTestCase(
        id="suite:bad",
        name="bad",
        source=SOURCE_SUITE,
        kind="payload",
        path="/tmp/bad.json",
        expected_valid=True,
        valid=False,
        validated=True,
        status=STATUS_FAILED,
        message="expected valid but failed 'type' at '/age'",
        findings=[_TYPE_FINDING],
    )
    errored = _case(STATUS_ERROR)
    return build_report(
        schema_ref=_REF,
        seed=7,
        cases=[passed, failed, errored],
        source={"kind": "project", "projected": True},
        rejected_mutants=2,
        diagnostics=[{"code": "X", "message": "limited"}],
    )


class TestRenderings:
    def test_report_shape_is_stable(self) -> None:
        report = _report()
        assert report["command"] == "schema test"
        assert report["schema_ref"] == _REF
        assert report["seed"] == 7
        assert report["summary"] == {"total": 3, "passed": 1, "failed": 1, "errors": 1}
        assert {c["status"] for c in report["cases"]} == {
            STATUS_PASSED,
            STATUS_FAILED,
            STATUS_ERROR,
        }
        assert report["rejected_mutants"] == 2
        # The whole report must be JSON-serializable as-is.
        json.dumps(report)

    def test_junit_is_valid_xml_with_counts_and_properties(self) -> None:
        text = render_junit(_report())
        root = ET.fromstring(text)
        assert root.tag == "testsuite"
        assert root.attrib["tests"] == "3"
        assert root.attrib["failures"] == "1"
        assert root.attrib["errors"] == "1"
        assert root.attrib["skipped"] == "0"
        properties = {
            p.attrib["name"]: p.attrib["value"] for p in root.iter("property")
        }
        assert properties == {"schema_ref": _REF, "seed": "7"}
        failures = list(root.iter("failure"))
        assert len(failures) == 1
        assert "failed 'type'" in failures[0].attrib["message"]
        assert "/age [type] 'x' is not of type 'integer'" in (failures[0].text or "")
        assert len(list(root.iter("error"))) == 1

    def test_junit_is_deterministic(self) -> None:
        assert render_junit(_report()) == render_junit(_report())

    def test_junit_escapes_hostile_text(self) -> None:
        case = SchemaTestCase(
            id='payload:<evil>"name"',
            name="evil",
            source=SOURCE_PAYLOAD,
            kind="payload",
            path=None,
            expected_valid=True,
            valid=False,
            validated=True,
            status=STATUS_FAILED,
            message='broke <tag> & "quotes"',
            findings=[{"pointer": "/a<b", "keyword": "type", "message": "x < y & z"}],
        )
        report = build_report(
            schema_ref="project/x/1.0.0",
            seed=0,
            cases=[case],
            source=None,
            rejected_mutants=0,
            diagnostics=[],
        )
        root = ET.fromstring(render_junit(report))
        testcase = next(iter(root.iter("testcase")))
        assert testcase.attrib["name"] == 'payload:<evil>"name"'
        failure = next(iter(root.iter("failure")))
        assert failure.attrib["message"] == 'broke <tag> & "quotes"'
        assert "x < y & z" in (failure.text or "")

    def test_human_rendering_names_non_passing_cases(self) -> None:
        lines = render_human(_report())
        assert lines[0] == f"Schema test for {_REF} — FAILED"
        assert "3 total, 1 passed, 1 failed, 1 errors" in lines[1]
        assert any("2 generated mutant candidate(s)" in line for line in lines)
        assert any("[failed] suite:bad" in line for line in lines)
        assert any("[error] payload:error" in line for line in lines)

    def test_human_rendering_all_green(self) -> None:
        report = build_report(
            schema_ref=_REF,
            seed=0,
            cases=[_case(STATUS_PASSED)],
            source=None,
            rejected_mutants=0,
            diagnostics=[],
        )
        lines = render_human(report)
        assert lines[0].endswith("— passed")
        assert len(lines) == 2
