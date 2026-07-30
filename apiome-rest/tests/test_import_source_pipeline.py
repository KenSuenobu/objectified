"""Unit tests for the in-process import-source job pipeline (MFI-1.2, #3734).

Exercise :func:`app.import_source_pipeline.run_adapter_import_job` directly against
the no-op ``sample`` adapter (and small stub adapters), independent of the REST job
engine, so the parse → normalize → version → lint state machine, its snapshots, and
its failure/cancel handling are covered without spawning a worker.
"""

from __future__ import annotations

import base64
from typing import Any, List, Optional
from unittest.mock import patch

from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi
from app.import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    LintFinding,
    LintReport,
)
from app.import_source_pipeline import _extract_schema_definitions, run_adapter_import_job
from app.models import SpecImportJobResult, SpecImportJobStatus
from app.sample_import_source import SAMPLE_FORMAT, SampleImportSource


def _payload(text: str, *, options: Optional[dict] = None, filename: str = "doc.txt") -> dict:
    """Build a worker-style payload carrying base64 document bytes + metadata."""
    return {
        "rest_job_id": "job-1",
        "metadata": {
            "source_kind": "sample",
            "project": {"name": "P", "slug": "p"},
            "version": {"version_id": "1.0.0"},
            "options": options or {},
        },
        "document_base64": base64.standard_b64encode(text.encode("utf-8")).decode("ascii"),
        "filename": filename,
        "content_type": "text/plain",
    }


async def _collect_snapshots(
    adapter: ImportSource, payload: dict
) -> tuple[SpecImportJobStatus, List[SpecImportJobStatus]]:
    """Run the pipeline, returning ``(final, intermediate_snapshots)``."""
    snaps: List[SpecImportJobStatus] = []

    async def _on(status: SpecImportJobStatus) -> None:
        snaps.append(status)

    final = await run_adapter_import_job(adapter, payload, on_snapshot=_on)
    return final, snaps


async def test_sample_adapter_runs_end_to_end() -> None:
    final, snaps = await _collect_snapshots(SampleImportSource(), _payload("hello"))

    assert final.state == "completed"
    assert final.percent == 100
    assert final.summary is not None
    assert final.summary["source"] == "sample"
    assert final.summary["format"] == SAMPLE_FORMAT
    assert final.summary["paradigm"] == ApiParadigm.DATA_SCHEMA.value
    assert final.summary["fingerprint"].startswith("sha256:")
    assert final.summary["persisted"] is False

    # Each phase emitted an event, accumulated across snapshots (final carries them all).
    codes = [e.code for e in final.events]
    assert codes == [
        "ADAPTER_INIT",
        "PARSE_OK",
        # CPDO-1.2: the native analysis runs between parse and normalize, while the AST exists.
        "PAYLOAD_ANALYZED",
        "NORMALIZE_OK",
        "ROUTING_DECIDED",
        "VERSION_FINGERPRINT",
        "LINT_COMPLETED",
        "IMPORT_COMPLETED",
    ]


async def test_snapshots_report_monotonic_progress() -> None:
    _final, snaps = await _collect_snapshots(SampleImportSource(), _payload("hi"))
    percents = [s.percent for s in snaps]
    assert percents == sorted(percents)
    assert all(s.state == "running" for s in snaps)


async def test_dry_run_flag_recorded_in_summary_and_events() -> None:
    final, _ = await _collect_snapshots(
        SampleImportSource(), _payload("x", options={"dry_run": True})
    )
    assert final.state == "completed"
    assert final.summary["dry_run"] is True
    assert any(e.code == "DRY_RUN" for e in final.events)


async def test_incremental_mode_flag_recorded() -> None:
    final, _ = await _collect_snapshots(
        SampleImportSource(), _payload("x", options={"incremental_mode": True})
    )
    assert final.summary["incremental_mode"] is True
    assert any(e.code == "INCREMENTAL_MODE" for e in final.events)


async def test_fingerprint_is_deterministic_across_runs() -> None:
    a, _ = await _collect_snapshots(SampleImportSource(), _payload("same-bytes"))
    b, _ = await _collect_snapshots(SampleImportSource(), _payload("same-bytes"))
    assert a.summary["fingerprint"] == b.summary["fingerprint"]


async def test_missing_document_fails_cleanly() -> None:
    payload = _payload("x")
    payload["document_base64"] = ""
    final = await run_adapter_import_job(SampleImportSource(), payload)
    assert final.state == "failed"
    assert any(e.code == "PARSE_ERROR" and e.level == "error" for e in final.events)


class _ParseBoomSource(ImportSource):
    """Adapter whose parse() rejects the document with a clean ImportSourceError."""

    key = "parse-boom"
    label = "Parse Boom"
    description = "test"
    icon = "x"
    paradigm = ApiParadigm.DATA_SCHEMA
    formats = ("boom",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        raise ImportSourceError("cannot parse this")

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        # Never reached: parse() fails first.
        raise AssertionError("normalize should not run after a parse failure")


async def test_parse_error_yields_failed_status() -> None:
    final = await run_adapter_import_job(_ParseBoomSource(), _payload("x"))
    assert final.state == "failed"
    assert any(e.code == "PARSE_ERROR" and "cannot parse" in e.message for e in final.events)


class _NormalizeBoomSource(_ParseBoomSource):
    """Adapter that parses but cannot normalize (e.g. format has no normalizer)."""

    key = "normalize-boom"

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        return {"text": raw}

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        raise ImportSourceError("no normalizer for this format")


async def test_normalize_error_yields_failed_status() -> None:
    final = await run_adapter_import_job(_NormalizeBoomSource(), _payload("x"))
    assert final.state == "failed"
    codes = [e.code for e in final.events]
    assert "PARSE_OK" in codes
    assert any(e.code == "NORMALIZE_ERROR" for e in final.events)


class _LintingSource(_NormalizeBoomSource):
    """Adapter that produces a model and a non-empty lint report."""

    key = "linting"

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        return CanonicalApi(
            paradigm=ApiParadigm.DATA_SCHEMA,
            format="linting-1",
            identity=ApiIdentity(name="Lint Me"),
        )

    def lint(self, model: CanonicalApi) -> LintReport:
        return LintReport(
            findings=[LintFinding(path="$", rule="r1", severity="warning", message="m")],
            score=82,
            grade="B",
            report_fingerprint="fp-test",
            rule_hits={"r1": 1},
            severity_counts={"error": 0, "warning": 1, "info": 0},
        )


async def test_lint_summary_carries_score_grade_and_count() -> None:
    final = await run_adapter_import_job(_LintingSource(), _payload("x"))
    assert final.state == "completed"
    # MFI-4.2: the summary carries the full roll-up — score, grade, fingerprint, and tally.
    assert final.summary["lint"] == {
        "score": 82,
        "grade": "B",
        "report_fingerprint": "fp-test",
        "findings": 1,
        "severity_counts": {"error": 0, "warning": 1, "info": 0},
    }


#: A fake result the patched persistence hook returns, standing in for a real DB write.
_FAKE_RESULT = SpecImportJobResult(
    project_id="proj-9",
    project_slug="lint-me",
    version_id="1.0.0",
    version_record_id="ver-9",
)


async def test_non_dry_run_persists_and_carries_result() -> None:
    # MFI-23.7: a non-dry-run import stores its routed artifact and the terminal status carries the
    # produced ids. Persistence is patched (no DB in unit tests) but its call args are asserted.
    payload = _payload("x")
    payload["tenant_id"] = "tenant-1"
    payload["user_id"] = "user-1"
    with patch(
        "app.import_source_pipeline.persist_adapter_import", return_value=_FAKE_RESULT
    ) as m_persist:
        final = await run_adapter_import_job(_LintingSource(), payload)

    assert final.state == "completed"
    m_persist.assert_called_once()
    # The pipeline hands the decoded source + normalized model + routing to the hook.
    args = m_persist.call_args.args
    assert args[0] is payload  # payload
    intake = args[2]
    assert intake.text == "x"
    assert intake.fileset is None
    assert final.result == _FAKE_RESULT
    assert final.summary["persisted"] is True
    assert any(e.code == "PERSISTED" for e in final.events)


async def test_quality_capture_runs_after_persistence() -> None:
    # MFI-4.2: once the import persisted a revision, the pipeline captures the rolled-up score onto
    # it (using the ids the persistence hook produced) and records a QUALITY_CAPTURED event.
    payload = _payload("x")
    payload["tenant_id"] = "tenant-1"
    with patch(
        "app.import_source_pipeline.persist_adapter_import", return_value=_FAKE_RESULT
    ), patch(
        "app.import_source_pipeline.capture_canonical_quality_score"
    ) as m_capture:
        final = await run_adapter_import_job(_LintingSource(), payload)

    assert final.state == "completed"
    m_capture.assert_called_once()
    version_id, tenant_id, report = m_capture.call_args.args
    assert (version_id, tenant_id) == ("ver-9", "tenant-1")
    # The already-computed roll-up is persisted, so the stored score equals the surfaced one.
    assert (report.score, report.grade, report.report_fingerprint) == (82, "B", "fp-test")
    assert any(e.code == "QUALITY_CAPTURED" for e in final.events)


async def test_persistence_failure_fails_the_job() -> None:
    # A persistence fault is fatal (unlike best-effort quality capture): without a stored artifact
    # the import produced nothing, so the job fails with a PERSIST_ERROR rather than reporting success.
    payload = _payload("x")
    payload["tenant_id"] = "tenant-1"
    with patch(
        "app.import_source_pipeline.persist_adapter_import",
        side_effect=RuntimeError("db down"),
    ):
        final = await run_adapter_import_job(_LintingSource(), payload)

    assert final.state == "failed"
    assert any(e.code == "PERSIST_ERROR" for e in final.events)


async def test_dry_run_never_persists_or_captures() -> None:
    # A dry run previews only: it must not persist the artifact nor capture a score.
    payload = _payload("x", options={"dry_run": True})
    payload["tenant_id"] = "tenant-1"
    with patch(
        "app.import_source_pipeline.persist_adapter_import"
    ) as m_persist, patch(
        "app.import_source_pipeline.capture_canonical_quality_score"
    ) as m_capture:
        final = await run_adapter_import_job(_LintingSource(), payload)

    assert final.state == "completed"
    m_persist.assert_not_called()
    m_capture.assert_not_called()
    assert final.summary["persisted"] is False
    assert final.result is None
    assert not any(e.code == "QUALITY_CAPTURED" for e in final.events)


async def test_persistence_skipped_without_a_tenant() -> None:
    # With no tenant on the payload there is nothing to write under: the hook returns None, the job
    # still completes (preview), and nothing is captured.
    with patch(
        "app.import_source_pipeline.capture_canonical_quality_score"
    ) as m_capture:
        final = await run_adapter_import_job(_LintingSource(), _payload("x"))

    assert final.state == "completed"
    assert final.summary["persisted"] is False
    m_capture.assert_not_called()
    assert not any(e.code == "QUALITY_CAPTURED" for e in final.events)


async def test_cancel_between_phases_stops_run() -> None:
    flag = {"canceled": False}

    async def _on(status: SpecImportJobStatus) -> None:
        # Request cancellation as soon as the first running snapshot is published.
        flag["canceled"] = True

    final = await run_adapter_import_job(
        SampleImportSource(),
        _payload("x"),
        on_snapshot=_on,
        is_canceled=lambda: flag["canceled"],
    )
    assert final.state == "canceled"
    assert final.percent < 100


# =========================================================================== #
# JSON Schema definition resolution for an "as current" type import
# =========================================================================== #


def test_extract_schema_definitions_keeps_the_root_alongside_its_defs() -> None:
    """A document that is itself a schema is a type too, not just a bag of $defs.

    Mirrors :func:`app.primitives_routes._resolve_import_definitions` so an "as current"
    import lands the same types the primitives ``/import`` endpoint would.
    """
    document = {
        "$id": "https://acme.test/list/response.json",
        "title": "Response",
        "type": "object",
        "properties": {"policies": {"$ref": "#/$defs/policies"}},
        "$defs": {"policies": {"type": "array"}},
    }

    definitions = _extract_schema_definitions(document)

    # Root first, and its container stripped — each member is imported as its own type.
    assert list(definitions) == ["Response", "policies"]
    assert "$defs" not in definitions["Response"]
    assert definitions["Response"]["properties"] == {"policies": {"$ref": "#/$defs/policies"}}


def test_extract_schema_definitions_suffixes_a_root_colliding_with_a_def() -> None:
    document = {"title": "policies", "type": "object", "$defs": {"policies": {"type": "array"}}}
    assert list(_extract_schema_definitions(document)) == ["policies-root", "policies"]


def test_extract_schema_definitions_adds_no_root_for_a_pure_container() -> None:
    """A document that asserts nothing about itself contributes no root type."""
    document = {"$defs": {"Money": {"type": "object"}}}
    assert list(_extract_schema_definitions(document)) == ["Money"]


def test_extract_schema_definitions_keeps_a_bare_schema_whole() -> None:
    """With no container there is nothing to strip, so the document is its own single type."""
    document = {"$id": "https://acme.test/money", "type": "object"}
    assert _extract_schema_definitions(document) == {"money": document}


def test_extract_schema_definitions_keeps_an_annotation_only_schema() -> None:
    """A schema that constrains nothing is the empty schema — still the document's one type."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://acme.test/api/evaluate/request",
        "title": "Evaluate API Request",
        "description": "The JSON instance to validate.",
        "examples": ["hello world", 42, None],
    }
    assert _extract_schema_definitions(document) == {"Evaluate API Request": document}


def test_extract_schema_definitions_ignores_arbitrary_json() -> None:
    """Object-shaped JSON carrying no JSON Schema keyword describes no type."""
    assert _extract_schema_definitions({"name": "acme-tools", "version": "1.4.0"}) == {}
