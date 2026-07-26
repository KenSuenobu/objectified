"""Engine tests for async export jobs — MFX-3.1 (#3844).

Pins the engine seams and the pipeline outcomes independently of the REST layer:

* the packaging seam (:func:`app.export_job_engine.build_result_manifest`) reduces an
  :class:`~app.emitter.EmitResult` to path/media-type/size metadata (never content);
* the validation event builder (:func:`app.export_job_engine.build_validation_events`)
  renders a passing / skipped / not-applicable emitted-artifact validation (MFX-5.1);
* a scheduled job runs load → fidelity → emit → validate → package to ``completed``,
  with sequenced phase events and the raw emit result retained for delivery (MFX-4.x);
* ``dry_run`` completes with the fidelity report and **no artifact** (the emitter is
  never invoked);
* a source-loader failure surfaces as a ``failed`` state with a structured error event;
* a terminal job is self-describing (MFX-3.4): a completed real export carries a
  ``download_path``, a failed job carries a structured ``error``, a cancel carries neither;
* cancellation is honoured at the next stage boundary; terminal jobs ignore it.

The DB-backed source loader is faked (its own logic is covered in
``test_export_source.py``); the emitter path runs the real registry/SPI.
"""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import patch

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.config import settings
from app.emitter import EmitResult, EmittedFile
from app.export_job_engine import (
    ExportJobStartRequest,
    _jobs,
    build_bundle_manifest,
    build_export_zip,
    build_result_manifest,
    build_validation_events,
    cancel_export_job,
    get_export_job_emit_result,
    get_export_job_status,
    list_export_jobs,
    schedule_export_job,
)
from app.export_source import ExportSource, ExportSourceError
from app.export_validation import EmittedArtifactValidation

TENANT_SLUG = "acme"
TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture(autouse=True)
def _clear_export_jobs_between_tests():
    _jobs.clear()
    yield
    _jobs.clear()


def _source() -> ExportSource:
    """A loaded source: a REST API with one operation + one type, at a fixed revision."""
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Widget.id", name="id", type=TypeRef(name="string"))],
    )
    op = Operation(key="GET /widgets", name="listWidgets", kind=OperationKind.QUERY)
    service = Service(key="widgets", name="widgets", operations=[op])
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        services=[service],
        types=[widget],
    )
    return ExportSource(
        api=api,
        artifact_id="artifact-1",
        version_record_id="rev-uuid-1",
        version_label="1.0.0",
    )


async def _passing_validation(*args, **kwargs) -> EmittedArtifactValidation:
    """Stub emitted-artifact validation (MFX-5.1) as passing.

    The download/packaging tests below mock ``emit_canonical`` with hand-crafted content that
    is deliberately *not* a valid artifact for the ``openapi`` target (proto text, a minimal
    stub document) to isolate delivery mechanics; patching the validation step keeps those
    tests about the download path rather than the emitter's correctness.
    """
    return EmittedArtifactValidation(
        target="openapi-3.1", applicable=True, validated=True, valid=True
    )


async def _wait_terminal(job_id: str, tenant_slug: str = TENANT_SLUG) -> dict:
    """Poll the engine until the job reaches a terminal state; return the status dict.

    Every scheduled job must be drained through here before its test returns —
    a job task that outlives the test's event loop can die while holding the
    engine's job lock and strand every later test.
    """
    for _ in range(500):
        status = await get_export_job_status(tenant_slug, job_id)
        if status.state in ("completed", "failed", "canceled"):
            return status.model_dump()
        await asyncio.sleep(0.01)
    raise AssertionError("export job did not reach a terminal state")


# ---------------------------------------------------------------------------
# Seams
# ---------------------------------------------------------------------------
def test_build_result_manifest_reports_paths_and_serialized_sizes():
    """The manifest carries per-file metadata with the size of the serialized content."""
    doc = {"openapi": "3.1.0", "info": {"title": "t", "version": "1"}}
    text = "syntax = \"proto3\";\n"
    result = EmitResult(
        files=[
            EmittedFile(path="openapi.json", content=doc, media_type="application/json"),
            EmittedFile(path="widgets.proto", content=text, media_type="text/plain"),
        ],
        media_type="application/json",
    )

    manifest = build_result_manifest(result)

    assert [f.path for f in manifest] == ["openapi.json", "widgets.proto"]
    expected_doc_size = len(json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8"))
    assert manifest[0].size_bytes == expected_doc_size
    assert manifest[0].media_type == "application/json"
    assert manifest[1].size_bytes == len(text.encode("utf-8"))
    # Metadata only — the manifest model has no content field at all.
    assert "content" not in manifest[0].model_dump()


def test_build_bundle_manifest_records_provenance_when_provided():
    """The zip manifest carries snapshot + version provenance without source content (EFP-3.1)."""
    result = EmitResult(
        files=[EmittedFile(path="a.avsc", content='{"type":"record"}', media_type="application/json")],
        media_type="application/json",
    )
    provenance = {
        "snapshot_hash": "abc123",
        "version_record_id": "rev-1",
        "version_label": "1.0.0",
        "options": {"namespace": "test"},
        "emitter_version": "1.0",
        "registry_version": "2.0",
        "apiome_version": "3.0",
    }
    manifest = build_bundle_manifest(result, "avro", provenance=provenance)
    assert manifest["provenance"] == provenance
    assert "source" not in json.dumps(manifest)


def test_build_export_zip_bundles_every_file_and_a_manifest():
    """The zip seam (MFX-4.2) packages each emitted file plus a root manifest.json."""
    import io
    import zipfile

    from app.export_job_engine import serialize_file_content

    doc = {"openapi": "3.1.0"}
    result = EmitResult(
        files=[
            EmittedFile(path="openapi.json", content=doc, media_type="application/json"),
            EmittedFile(path="schemas/widget.avsc", content='{"type":"record"}',
                        media_type="application/json", subject="widget-value"),
        ],
        media_type="application/json",
    )

    blob = build_export_zip(result, "avro")

    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert set(archive.namelist()) == {"openapi.json", "schemas/widget.avsc", "manifest.json"}
        # Each file's bytes are its canonical serialization (pretty JSON for a dict).
        assert archive.read("openapi.json").decode("utf-8") == serialize_file_content(doc)
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))

    assert manifest["target"] == "avro"
    assert manifest["media_type"] == "application/json"
    assert manifest["manifest"] == "manifest.json"
    assert manifest["file_count"] == 2
    # The Schema Registry subject rides through into the manifest entry.
    subjects = {f["path"]: f["subject"] for f in manifest["files"]}
    assert subjects["schemas/widget.avsc"] == "widget-value"


def test_build_export_zip_is_deterministic():
    """The same emit result packages to byte-identical bundle bytes (pinned timestamps)."""
    result = EmitResult(
        files=[
            EmittedFile(path="a.proto", content='syntax = "proto3";\n', media_type="text/plain"),
            EmittedFile(path="b.proto", content='syntax = "proto3";\n', media_type="text/plain"),
        ],
        media_type="text/plain",
    )
    assert build_export_zip(result, "protobuf-3") == build_export_zip(result, "protobuf-3")


def test_build_bundle_manifest_disambiguates_a_colliding_manifest_name():
    """When a target emits its own manifest.json, the bundle manifest takes a distinct name."""
    import io
    import zipfile

    result = EmitResult(
        files=[
            EmittedFile(path="manifest.json", content={"i-am": "an emitted file"},
                        media_type="application/json"),
        ],
        media_type="application/json",
    )

    manifest = build_bundle_manifest(result, "smithy", manifest_name="whatever")
    # build_export_zip picks the real, non-colliding name and records it in the manifest.
    with zipfile.ZipFile(io.BytesIO(build_export_zip(result, "smithy"))) as archive:
        names = set(archive.namelist())
    assert "manifest.json" in names  # the emitted file keeps its path
    assert "export-manifest.json" in names  # the bundle manifest is renamed out of the way
    assert len(names) == 2
    # The manifest builder always describes the emitted files, never itself.
    assert [f["path"] for f in manifest["files"]] == ["manifest.json"]


def test_build_validation_events_reports_a_passing_validation():
    """A validated, valid artifact yields a single ARTIFACT_VALIDATED info event."""
    validation = EmittedArtifactValidation(
        target="openapi-3.1", applicable=True, validated=True, valid=True
    )
    events = build_validation_events(validation)
    assert len(events) == 1
    level, code, message, context = events[0]
    assert level == "info"
    assert code == "ARTIFACT_VALIDATED"
    assert "re-parsed cleanly" in message
    assert context == {"target": "openapi-3.1"}


def test_build_validation_events_warns_when_validation_is_skipped():
    """A matching parser whose toolchain is missing is a warn, not a silent pass."""
    validation = EmittedArtifactValidation(
        target="asyncapi-3",
        applicable=True,
        validated=False,
        valid=True,
        detail="The 'asyncapi-parser' toolchain is unavailable in this runtime; ...",
    )
    events = build_validation_events(validation)
    level, code, message, _context = events[0]
    assert level == "warn"
    assert code == "VALIDATION_SKIPPED"
    assert "unavailable" in message


def test_build_validation_events_notes_a_not_applicable_target():
    """A target with no importer (the sample no-op) is reported not-applicable, never failed."""
    validation = EmittedArtifactValidation(
        target="sample-noop",
        applicable=False,
        validated=False,
        valid=True,
        detail="No import parser matches the 'sample-noop' target; ...",
    )
    events = build_validation_events(validation)
    _level, code, _message, _context = events[0]
    assert code == "VALIDATION_NOT_APPLICABLE"


# ---------------------------------------------------------------------------
# Pipeline outcomes
# ---------------------------------------------------------------------------
async def test_job_runs_end_to_end_to_completed():
    """A real (non-dry-run) job completes with fidelity + manifest + retained emit result."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    assert status["percent"] == 100

    result = status["result"]
    assert result is not None
    assert result["artifact"] == "artifact-1"
    assert result["version_record_id"] == "rev-uuid-1"
    assert result["version_label"] == "1.0.0"
    assert result["dry_run"] is False
    assert result["target"].startswith("openapi")
    assert result["media_type"] == "application/vnd.oai.openapi+json"
    assert len(result["files"]) == 1
    assert result["files"][0]["size_bytes"] > 0

    # MFX-3.4: a real export exposes a download ref for pollers and no structured error.
    assert result["download_path"] == f"/v1/export/{TENANT_SLUG}/jobs/{accepted.job_id}/download"
    assert status["error"] is None

    # The fidelity envelope matches what /export/preview computes: lossless REST→OpenAPI.
    assert result["fidelity"]["summary"]["tier"] == "lossless"
    assert result["fidelity"]["summary"]["preserved_percent"] == 100
    assert result["fidelity"]["advisory"] is not None

    # Phase events are sequenced and cover the whole pipeline.
    codes = [e["code"] for e in status["events"]]
    assert codes == [
        "EXPORT_STARTED",
        "SOURCE_LOADED",
        "FIDELITY_COMPUTED",
        "EMITTED",
        "ARTIFACT_VALIDATED",
        "EXPORT_COMPLETED",
    ]
    assert [e["id"] for e in status["events"]] == [f"export-{i}" for i in range(1, 7)]

    # The raw emit result is retained for the delivery epics.
    emit_result = get_export_job_emit_result(TENANT_SLUG, accepted.job_id)
    assert emit_result is not None
    assert emit_result.files[0].path == result["files"][0]["path"]


async def test_dry_run_completes_with_report_and_no_artifact():
    """Dry-run stops after the fidelity report: no files, no emit, no retained result."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi", dry_run=True)

    def _must_not_emit(*args, **kwargs):
        raise AssertionError("emit_canonical must not run for a dry-run job")

    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_must_not_emit
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    result = status["result"]
    assert result["dry_run"] is True
    assert result["files"] == []
    assert result["media_type"] is None
    # MFX-3.4: a dry-run emits no artifact, so it carries no download ref.
    assert result["download_path"] is None
    assert result["fidelity"]["summary"]["tier"] == "lossless"
    assert get_export_job_emit_result(TENANT_SLUG, accepted.job_id) is None
    codes = [e["code"] for e in status["events"]]
    assert codes[-1] == "DRY_RUN_COMPLETED"
    assert "EMITTED" not in codes


async def test_source_load_failure_fails_the_job_with_structured_event():
    """The loader's typed error becomes a failed state + error event (job API stays 200)."""
    request = ExportJobStartRequest(artifact="missing", target="openapi")
    with patch(
        "app.export_job_engine.load_export_source",
        side_effect=ExportSourceError("Artifact 'missing' was not found.", status_code=404),
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "failed"
    assert status["result"] is None
    errors = [e for e in status["events"] if e["level"] == "error"]
    assert len(errors) == 1
    assert errors[0]["code"] == "SOURCE_LOAD_FAILED"
    assert errors[0]["context"] == {"status_code": 404}

    # MFX-3.4: the same failure is mirrored as a structured error for pollers.
    assert status["error"] == {
        "code": "SOURCE_LOAD_FAILED",
        "message": "Artifact 'missing' was not found.",
        "context": {"status_code": 404},
    }


async def test_unexpected_exception_fails_the_job():
    """Any unclassified fault is converted to a failed job, never a crashed task."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch(
        "app.export_job_engine.load_export_source",
        side_effect=RuntimeError("boom"),
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "failed"
    assert status["events"][-1]["code"] == "EXPORT_EXCEPTION"
    assert "boom" in status["events"][-1]["message"]
    # MFX-3.4: an unclassified crash still yields a structured error.
    assert status["error"]["code"] == "EXPORT_EXCEPTION"
    assert "boom" in status["error"]["message"]


async def test_invalid_emitted_artifact_fails_the_job():
    """MFX-5.1: an emitter that produced an illegal artifact fails the job before delivery."""
    # A 3.1 document missing the OAS-required ``info`` object: emit succeeds but the emitted
    # artifact is not legal OpenAPI, so the validation stage must catch it and fail the job.
    def _emit_broken(*args, **kwargs):
        return EmitResult(
            files=[EmittedFile(path="openapi.json", content={"openapi": "3.1.0", "paths": {}})],
            media_type="application/json",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_emit_broken
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "failed"
    assert status["result"] is None
    # The failure is the validation gate, and it carries the parser detail (MFX-3.4 / MFX-5.3).
    assert status["error"]["code"] == "EMITTED_ARTIFACT_INVALID"
    assert status["error"]["context"]["errors"]
    assert status["error"]["context"]["findings"]
    assert status["error"]["context"]["validation"]["verdict"] == "invalid"
    assert status["error"]["context"]["validation"]["blocks_delivery"] is True
    codes = [e["code"] for e in status["events"]]
    assert codes[-1] == "EMITTED_ARTIFACT_INVALID"
    assert "EXPORT_COMPLETED" not in codes
    # The invalid artifact never becomes downloadable.
    assert get_export_job_emit_result(TENANT_SLUG, accepted.job_id) is None


async def test_cancel_takes_effect_at_next_stage_boundary():
    """A cancel during a blocking stage finalizes the job as canceled, with no result."""
    started = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _slow_loader(*args, **kwargs):
        # Runs in a worker thread; signal the test, then take long enough that the
        # cancel lands before the next stage boundary.
        loop.call_soon_threadsafe(started.set)
        time.sleep(0.1)
        return _source()

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", side_effect=_slow_loader):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await asyncio.wait_for(started.wait(), timeout=5)
        await cancel_export_job(TENANT_SLUG, accepted.job_id)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "canceled"
    assert status["result"] is None
    # MFX-3.4: a cancel is not a failure — no structured error is attached.
    assert status["error"] is None


async def test_cancel_of_terminal_job_is_a_noop():
    """Cancelling a completed job leaves its state and result untouched."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    await cancel_export_job(TENANT_SLUG, accepted.job_id)
    status = await get_export_job_status(TENANT_SLUG, accepted.job_id)
    assert status.state == "completed"
    assert status.result is not None


async def test_list_is_tenant_scoped_and_summarized():
    """The list shows only the tenant's jobs, as summary rows without event logs."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi", dry_run=True)
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        other = await schedule_export_job("other-tenant", "other-tenant-id", request)
        await _wait_terminal(accepted.job_id)
        await _wait_terminal(other.job_id, tenant_slug="other-tenant")

        listing = await list_export_jobs(TENANT_SLUG)

    assert [j.job_id for j in listing.jobs] == [accepted.job_id]
    row = listing.jobs[0]
    assert row.artifact == "artifact-1"
    assert row.target == "openapi"
    assert row.dry_run is True
    assert row.status_path == f"/v1/export/{TENANT_SLUG}/jobs/{accepted.job_id}"


async def test_status_and_emit_result_are_tenant_scoped():
    """A job id from another tenant is a 404 for both status and emit-result lookups."""
    from fastapi import HTTPException

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    with pytest.raises(HTTPException) as excinfo:
        await get_export_job_status("other-tenant", accepted.job_id)
    assert excinfo.value.status_code == 404

    with pytest.raises(HTTPException) as excinfo:
        get_export_job_emit_result("other-tenant", accepted.job_id)
    assert excinfo.value.status_code == 404


async def test_status_lookup_returns_a_snapshot():
    """Mutating a returned status must not mutate the shared in-memory job record."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    status = await get_export_job_status(TENANT_SLUG, accepted.job_id)
    status.events.clear()
    assert status.result is not None
    status.result.artifact = "mutated"

    fresh = await get_export_job_status(TENANT_SLUG, accepted.job_id)
    assert fresh.events
    assert fresh.result is not None
    assert fresh.result.artifact == "artifact-1"


async def test_emit_result_lookup_returns_a_snapshot():
    """Mutating a returned emit result must not mutate the shared in-memory job record."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    emit_result = get_export_job_emit_result(TENANT_SLUG, accepted.job_id)
    assert emit_result is not None
    emit_result.files[0].path = "mutated.json"

    fresh = get_export_job_emit_result(TENANT_SLUG, accepted.job_id)
    assert fresh is not None
    assert fresh.files[0].path != "mutated.json"


# ---------------------------------------------------------------------------
# Transcode guard gate — MFX-3.3 (#3846)
# ---------------------------------------------------------------------------
def _event_source() -> ExportSource:
    """An event-only source (one channel + one message schema), for the guard cases."""
    from app.canonical_model import Channel

    msg = Type(
        key="Signup",
        name="Signup",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Signup.id", name="id", type=TypeRef(name="string"))],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="signup"),
        channels=[Channel(key="user/signedup", address="user/signedup")],
        types=[msg],
    )
    return ExportSource(
        api=api, artifact_id="artifact-2", version_record_id="rev-uuid-2", version_label="2.0.0"
    )


async def test_completed_job_result_carries_the_transcode_guard():
    """A normal completed job attaches the transcoding guard alongside the fidelity envelope."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    guard = status["result"]["guard"]
    assert guard["verdict"] == "clean"
    assert guard["requires_confirmation"] is False


async def test_completed_job_result_carries_the_validation_report():
    """MFX-5.3: a completed real export surfaces the validation gate on the job result."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    validation = status["result"]["validation"]
    assert validation["verdict"] == "valid"
    assert validation["blocks_delivery"] is False
    assert validation["tool"] == "OpenAPI meta-schema + OpenAPI import"
    assert validation["headline"] == "Valid"


async def test_dry_run_result_has_no_validation_report():
    """A dry-run never emits, so no emitted-artifact validation report is attached."""
    request = ExportJobStartRequest(artifact="artifact-1", target="openapi", dry_run=True)
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    assert status["result"]["validation"] is None


async def test_severe_conversion_fails_the_job_without_confirmation():
    """A severe conversion (event-only → GraphQL) with no ``confirm`` fails before emit."""
    request = ExportJobStartRequest(artifact="artifact-2", target="graphql")

    def _must_not_emit(*args, **kwargs):
        raise AssertionError("emit_canonical must not run for an unconfirmed severe job")

    with patch("app.export_job_engine.load_export_source", return_value=_event_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_must_not_emit
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "failed"
    assert status["result"] is None
    errors = [e for e in status["events"] if e["level"] == "error"]
    assert len(errors) == 1
    assert errors[0]["code"] == "TRANSCODE_CONFIRMATION_REQUIRED"
    assert errors[0]["context"]["verdict"] == "severe"

    # MFX-3.4: the guard refusal is a structured error a poller branches on (resubmit
    # with ``confirm``), carrying the same guard context as the terminal event.
    assert status["error"]["code"] == "TRANSCODE_CONFIRMATION_REQUIRED"
    assert status["error"]["context"]["verdict"] == "severe"
    assert "reasons" in status["error"]["context"]


async def test_severe_conversion_completes_when_confirmed():
    """The same severe conversion runs to completion once submitted with ``confirm``."""
    request = ExportJobStartRequest(artifact="artifact-2", target="graphql", confirm=True)
    with patch("app.export_job_engine.load_export_source", return_value=_event_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    result = status["result"]
    assert result["files"]  # the emitter ran
    assert result["guard"]["verdict"] == "severe"
    assert result["guard"]["requires_confirmation"] is True
    # MFX-3.4: a confirmed severe export still resolves to a downloadable artifact.
    assert result["download_path"] == f"/v1/export/{TENANT_SLUG}/jobs/{accepted.job_id}/download"
    assert status["error"] is None


async def test_dry_run_of_severe_conversion_never_blocks():
    """A dry-run of a severe conversion completes with the report + guard, never fails."""
    request = ExportJobStartRequest(artifact="artifact-2", target="graphql", dry_run=True)
    with patch("app.export_job_engine.load_export_source", return_value=_event_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    result = status["result"]
    assert result["dry_run"] is True
    assert result["files"] == []
    assert result["guard"]["verdict"] == "severe"


# ---------------------------------------------------------------------------
# Single-file download — MFX-4.1 (#3848)
# ---------------------------------------------------------------------------
def test_serialize_file_content_is_deterministic_for_dict_and_text():
    """A dict serializes to pretty JSON; any other payload passes through as its string form."""
    from app.export_job_engine import serialize_file_content

    doc = {"openapi": "3.1.0", "info": {"title": "t", "version": "1"}}
    assert serialize_file_content(doc) == json.dumps(doc, indent=2, ensure_ascii=False)

    proto = 'syntax = "proto3";\n'
    assert serialize_file_content(proto) == proto


async def test_resolve_export_download_serves_the_single_emitted_file():
    """A completed single-file job resolves to filename + media type + manifest-sized body."""
    from app.export_job_engine import resolve_export_download, serialize_file_content

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    artifact = resolve_export_download(TENANT_SLUG, accepted.job_id)
    emit_result = get_export_job_emit_result(TENANT_SLUG, accepted.job_id)
    assert emit_result is not None
    primary = emit_result.files[0]

    # Filename is the basename of the emitted path; content type is the file's media type.
    assert artifact.filename == primary.path.rsplit("/", 1)[-1]
    assert artifact.media_type == (primary.media_type or emit_result.media_type)
    # The served body is exactly the canonical serialization the manifest measured.
    assert artifact.body == serialize_file_content(primary.content)
    manifest_size = status["result"]["files"][0]["size_bytes"]
    assert len(artifact.body.encode("utf-8")) == manifest_size


async def test_resolve_export_download_derives_basename_from_nested_path():
    """A nested emitter path is reduced to its filename for the download."""
    from app.export_job_engine import resolve_export_download

    def _nested(*args, **kwargs):
        return EmitResult(
            files=[EmittedFile(path="schemas/openapi.json", content={"openapi": "3.1.0"})],
            media_type="application/json",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_nested
    ), patch("app.export_job_engine.validate_emitted_artifact", _passing_validation):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    artifact = resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert artifact.filename == "openapi.json"


async def test_resolve_export_download_normalizes_windows_path_and_sanitizes_header_chars():
    """Windows separators and header-breaking characters are removed from the filename."""
    from app.export_job_engine import resolve_export_download

    def _unsafe(*args, **kwargs):
        return EmitResult(
            files=[
                EmittedFile(
                    path='schemas\\bad"\r\nopenapi.json',
                    content={"openapi": "3.1.0"},
                )
            ],
            media_type="application/json",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_unsafe
    ), patch("app.export_job_engine.validate_emitted_artifact", _passing_validation):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    artifact = resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert artifact.filename == "badopenapi.json"


async def test_resolve_export_download_409_for_dry_run():
    """A dry-run has no artifact, so a download attempt is a 409 (not a 404)."""
    from fastapi import HTTPException

    from app.export_job_engine import resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi", dry_run=True)
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    with pytest.raises(HTTPException) as excinfo:
        resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert excinfo.value.status_code == 409
    assert "dry-run" in excinfo.value.detail


async def test_resolve_export_download_409_for_failed_job():
    """A job that never completed cannot be downloaded (409, state-aware message)."""
    from fastapi import HTTPException

    from app.export_job_engine import resolve_export_download

    request = ExportJobStartRequest(artifact="missing", target="openapi")
    with patch(
        "app.export_job_engine.load_export_source",
        side_effect=ExportSourceError("nope", status_code=404),
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    with pytest.raises(HTTPException) as excinfo:
        resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert excinfo.value.status_code == 409
    assert "failed" in excinfo.value.detail


async def test_resolve_export_download_serves_zip_bundle_for_multi_file_export():
    """A multi-file export is delivered as an application/zip bundle (MFX-4.2), not a 409."""
    import io
    import zipfile

    from app.export_job_engine import resolve_export_download, serialize_file_content

    def _multi(*args, **kwargs):
        return EmitResult(
            files=[
                EmittedFile(path="a.proto", content='syntax = "proto3";\n', media_type="text/plain"),
                EmittedFile(path="pkg/b.proto", content='syntax = "proto3";\nmessage B {}\n',
                            media_type="text/plain"),
            ],
            media_type="text/plain",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_multi
    ), patch("app.export_job_engine.validate_emitted_artifact", _passing_validation):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    artifact = resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert artifact.media_type == "application/zip"
    assert artifact.filename.endswith(".zip")
    # The resolved target format keys the bundle filename.
    assert artifact.filename == f"{status['result']['target']}.zip"
    assert isinstance(artifact.body, bytes)

    # The bundle is a real zip carrying every emitted file (byte-for-byte) plus a manifest.
    with zipfile.ZipFile(io.BytesIO(artifact.body)) as archive:
        names = archive.namelist()
        assert set(names) == {"a.proto", "pkg/b.proto", "manifest.json"}
        assert archive.read("a.proto").decode("utf-8") == 'syntax = "proto3";\n'
        assert archive.read("pkg/b.proto").decode("utf-8") == serialize_file_content(
            'syntax = "proto3";\nmessage B {}\n'
        )
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))

    # The embedded manifest mirrors the job's file manifest (paths + serialized sizes).
    assert manifest["target"] == status["result"]["target"]
    assert manifest["file_count"] == 2
    assert [f["path"] for f in manifest["files"]] == ["a.proto", "pkg/b.proto"]
    assert manifest["files"][0]["size_bytes"] == status["result"]["files"][0]["size_bytes"]
    # The manifest never lists itself.
    assert "manifest.json" not in [f["path"] for f in manifest["files"]]


async def test_resolve_export_download_is_tenant_scoped():
    """A cross-tenant slug cannot download the artifact (404, like the other lookups)."""
    from fastapi import HTTPException

    from app.export_job_engine import resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    with pytest.raises(HTTPException) as excinfo:
        resolve_export_download("other-tenant", accepted.job_id)
    assert excinfo.value.status_code == 404


async def test_resolve_export_download_serves_plain_text_target():
    """A text (non-dict) file resolves to text/plain by default and passes bytes verbatim."""
    from app.export_job_engine import resolve_export_download

    def _text(*args, **kwargs):
        return EmitResult(
            files=[EmittedFile(path="widgets.proto", content='syntax = "proto3";\n')],
            media_type="text/plain",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_text
    ), patch("app.export_job_engine.validate_emitted_artifact", _passing_validation):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    artifact = resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert artifact.media_type == "text/plain"
    assert artifact.body == 'syntax = "proto3";\n'
    assert artifact.filename == "widgets.proto"


# ---------------------------------------------------------------------------
# Streaming download & temp artifact retention — MFX-4.3 (#3850)
# ---------------------------------------------------------------------------
def test_content_length_measures_str_and_bytes_bodies():
    """content_length is the UTF-8 byte size of a str body and the length of a bytes body."""
    from app.export_job_engine import ExportDownloadArtifact

    # A multibyte character makes the char count and byte count differ, so a naive len() fails.
    text = ExportDownloadArtifact(filename="d.json", media_type="application/json", body=" é")
    assert text.content_length == len(" é".encode("utf-8")) == 3

    raw = ExportDownloadArtifact(filename="b.zip", media_type="application/zip", body=b"PK\x03\x04")
    assert raw.content_length == 4


def test_iter_download_chunks_reassembles_str_and_bytes_bodies():
    """The streamed chunks concatenate back to the exact encoded body, in order."""
    from app.export_job_engine import (
        DOWNLOAD_CHUNK_SIZE,
        ExportDownloadArtifact,
        iter_download_chunks,
    )

    # A str body longer than the chunk size, with a multibyte char, streams as several chunks.
    text = "é" + "x" * (DOWNLOAD_CHUNK_SIZE * 2 + 7)
    art = ExportDownloadArtifact(filename="d.txt", media_type="text/plain", body=text)
    chunks = list(iter_download_chunks(art))
    assert len(chunks) == 3
    assert all(isinstance(c, bytes) for c in chunks)
    assert all(len(c) <= DOWNLOAD_CHUNK_SIZE for c in chunks)
    assert b"".join(chunks) == text.encode("utf-8")

    raw = ExportDownloadArtifact(filename="b.zip", media_type="application/zip", body=b"abcdefgh")
    assert list(iter_download_chunks(raw, chunk_size=3)) == [b"abc", b"def", b"gh"]


def test_iter_download_chunks_of_empty_body_yields_nothing():
    """An empty body streams zero chunks (not one empty chunk)."""
    from app.export_job_engine import ExportDownloadArtifact, iter_download_chunks

    art = ExportDownloadArtifact(filename="empty.txt", media_type="text/plain", body="")
    assert list(iter_download_chunks(art)) == []


def test_iter_download_chunks_rejects_a_non_positive_chunk_size():
    """A zero/negative chunk size is a programming error, not an infinite loop."""
    from app.export_job_engine import ExportDownloadArtifact, iter_download_chunks

    art = ExportDownloadArtifact(filename="d.txt", media_type="text/plain", body="hi")
    with pytest.raises(ValueError):
        list(iter_download_chunks(art, chunk_size=0))


async def test_completed_job_result_advertises_a_download_expiry():
    """A real export records the retention deadline on the result and the record (MFX-4.3)."""
    from app.export_job_engine import _jobs

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch.object(
        settings, "export_artifact_retention_hours", 2
    ):
        before = int(time.time() * 1000)
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)
        after = int(time.time() * 1000)

    expires = status["result"]["download_expires_at"]
    assert expires is not None
    # The deadline is ~2h out (window = 2 * 3_600_000 ms), bracketed by the emit instant.
    window = 2 * 3_600_000
    assert before + window <= expires <= after + window
    # The record carries the same deadline the poller was handed.
    assert _jobs[accepted.job_id].artifact_expires_at_ms == expires


async def test_retention_disabled_leaves_no_expiry_and_still_downloads():
    """A non-positive retention setting keeps the artifact for the process lifetime (MFX-4.3)."""
    from app.export_job_engine import _jobs, resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch.object(
        settings, "export_artifact_retention_hours", 0
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["result"]["download_expires_at"] is None
    assert _jobs[accepted.job_id].artifact_expires_at_ms is None
    # No deadline ⇒ the download resolves normally, never a 410.
    assert resolve_export_download(TENANT_SLUG, accepted.job_id).filename.endswith(".json")


async def test_expired_artifact_download_is_410_and_drops_the_bytes():
    """Past the retention window the download is 410 Gone and the retained bytes are freed."""
    from fastapi import HTTPException

    from app.export_job_engine import _jobs, resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    # Force the deadline into the past — deterministic, no sleeping on a real clock.
    _jobs[accepted.job_id].artifact_expires_at_ms = int(time.time() * 1000) - 1
    assert _jobs[accepted.job_id].emit_result is not None

    with pytest.raises(HTTPException) as excinfo:
        resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert excinfo.value.status_code == 410
    assert "expired" in excinfo.value.detail
    # The heavy bytes are dropped; the record (status, manifest) survives.
    assert _jobs[accepted.job_id].emit_result is None
    assert get_export_job_emit_result(TENANT_SLUG, accepted.job_id) is None


async def test_download_resolve_sweeps_other_expired_artifacts():
    """Resolving one download lazily reaps every other job's expired artifact (MFX-4.3)."""
    from app.export_job_engine import _jobs, resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        first = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(first.job_id)
        second = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(second.job_id)

    # The first job's artifact is stale; the second is fresh. Downloading the second must still
    # reap the first's bytes even though no one asked for it.
    _jobs[first.job_id].artifact_expires_at_ms = int(time.time() * 1000) - 1
    resolve_export_download(TENANT_SLUG, second.job_id)
    assert _jobs[first.job_id].emit_result is None
    assert _jobs[second.job_id].emit_result is not None


async def test_get_emit_result_returns_none_after_expiry():
    """The delivery seam drops and reports None once the artifact's window has elapsed."""
    from app.export_job_engine import _jobs

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    _jobs[accepted.job_id].artifact_expires_at_ms = int(time.time() * 1000) - 1
    assert get_export_job_emit_result(TENANT_SLUG, accepted.job_id) is None
    assert _jobs[accepted.job_id].emit_result is None


async def test_non_owning_instance_serves_download_from_shared_store():
    """Clearing local _jobs (non-owner) still serves the artifact from the shared store (IXH-6.1)."""
    from app.export_artifact_store import body_as_bytes, content_sha256_hex
    from app.export_job_engine import resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "completed"
    owner_artifact = resolve_export_download(TENANT_SLUG, accepted.job_id)
    expected_hash = content_sha256_hex(body_as_bytes(owner_artifact.body))
    assert owner_artifact.content_sha256 == expected_hash

    # Simulate a different REST instance: no in-memory job record.
    _jobs.clear()
    assert accepted.job_id not in _jobs

    remote = resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert remote.filename == owner_artifact.filename
    assert remote.media_type == owner_artifact.media_type
    assert body_as_bytes(remote.body) == body_as_bytes(owner_artifact.body)
    assert remote.content_sha256 == expected_hash


async def test_shared_store_download_is_tenant_scoped():
    """A cross-tenant read of a shared artifact is refused (404), never leaked."""
    from fastapi import HTTPException

    from app.export_job_engine import resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    _jobs.clear()
    with pytest.raises(HTTPException) as excinfo:
        resolve_export_download("other-tenant", accepted.job_id)
    assert excinfo.value.status_code == 404


async def test_shared_store_expired_artifact_is_410():
    """An expired shared-store artifact returns 410 (not a bare 404) on a non-owner."""
    from datetime import datetime, timezone

    from fastapi import HTTPException

    from app.database import db
    from app.export_job_engine import resolve_export_download

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        await _wait_terminal(accepted.job_id)

    row = db.get_export_job_artifact(accepted.job_id, TENANT_SLUG)
    assert row is not None
    # Force expiry on the shared row and drop the local fast path.
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    db.upsert_export_job_artifact(
        job_id=row["job_id"],
        tenant_slug=row["tenant_slug"],
        content_sha256=row["content_sha256"],
        size_bytes=row["size_bytes"],
        media_type=row["media_type"],
        filename=row["filename"],
        backend=row["backend"],
        content=row["content"],
        storage_uri=row["storage_uri"],
        expires_at=past,
    )
    _jobs.clear()

    with pytest.raises(HTTPException) as excinfo:
        resolve_export_download(TENANT_SLUG, accepted.job_id)
    assert excinfo.value.status_code == 410
    assert "expired" in excinfo.value.detail


async def test_export_artifact_size_cap_fails_the_job():
    """An oversize delivery payload fails the job with EXPORT_ARTIFACT_TOO_LARGE (no truncated store)."""
    from app.database import db

    huge = "x" * 1000
    def _huge(*args, **kwargs):
        return EmitResult(
            files=[EmittedFile(path="huge.json", content=huge, media_type="application/json")],
            media_type="application/json",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_huge
    ), patch(
        "app.export_job_engine.validate_emitted_artifact", _passing_validation
    ), patch.object(settings, "export_artifact_max_bytes", 100), patch.object(
        settings, "export_artifact_db_max_bytes", 100
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "failed"
    assert status["error"]["code"] == "EXPORT_ARTIFACT_TOO_LARGE"
    assert db.get_export_job_artifact(accepted.job_id, TENANT_SLUG) is None


async def test_object_store_stub_fails_when_above_db_threshold():
    """Sizes between db_max and hard max select the object-store stub and fail clearly."""
    body = "y" * 200
    def _mid(*args, **kwargs):
        return EmitResult(
            files=[EmittedFile(path="mid.json", content=body, media_type="application/json")],
            media_type="application/json",
        )

    request = ExportJobStartRequest(artifact="artifact-1", target="openapi")
    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_mid
    ), patch(
        "app.export_job_engine.validate_emitted_artifact", _passing_validation
    ), patch.object(settings, "export_artifact_max_bytes", 10_000), patch.object(
        settings, "export_artifact_db_max_bytes", 50
    ):
        accepted = await schedule_export_job(TENANT_SLUG, TENANT_ID, request)
        status = await _wait_terminal(accepted.job_id)

    assert status["state"] == "failed"
    assert status["error"]["code"] == "EXPORT_ARTIFACT_STORE_UNAVAILABLE"
    assert "object-store" in status["error"]["message"].lower() or "not configured" in status[
        "error"
    ]["message"].lower()
