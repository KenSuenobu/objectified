"""Contract tests for specification import REST surface (#3329)."""

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.models import SpecImportJobStatus

client = TestClient(app)

_MOCK_AUTH = {
    "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}


@pytest.fixture(autouse=True)
def _auth_override():
    def _fake_auth(tenant_slug: str):
        return {**_MOCK_AUTH, "tenant_slug": tenant_slug}

    app.dependency_overrides[validate_authentication] = _fake_auth
    app.openapi_schema = None
    yield
    app.dependency_overrides.pop(validate_authentication, None)
    app.openapi_schema = None


@pytest.fixture(autouse=True)
def _clear_spec_import_jobs_between_tests():
    from app import spec_import_engine as sie

    sie._jobs.clear()
    yield
    sie._jobs.clear()


@pytest.fixture
def spec_import_fake_worker(monkeypatch):
    async def _fake(payload: dict) -> dict:
        jid = payload["rest_job_id"]
        md = payload["metadata"]
        return {
            "ok": True,
            "job_id": jid,
            "status": {
                "job_id": jid,
                "state": "completed",
                "percent": 100,
                "events": [],
                "summary": {},
                "result": {
                    "project_id": "550e8400-e29b-41d4-a716-446655440099",
                    "project_slug": md["project"]["slug"],
                    "version_id": md["version"]["version_id"],
                    "version_record_id": "660e8400-e29b-41d4-a716-446655440088",
                },
            },
        }

    monkeypatch.setattr("app.spec_import_engine._worker_runner", _fake)


@pytest.fixture
def spec_import_pending_worker(monkeypatch):
    async def _fake(payload: dict) -> dict:
        jid = payload["rest_job_id"]
        md = payload["metadata"]
        return {
            "ok": True,
            "job_id": jid,
            "status": {
                "job_id": jid,
                "state": "pending-approval",
                "percent": 100,
                "events": [],
                "summary": {},
                "result": {
                    "project_id": "550e8400-e29b-41d4-a716-446655440099",
                    "project_slug": md["project"]["slug"],
                    "version_id": md["version"]["version_id"],
                    "version_record_id": "660e8400-e29b-41d4-a716-446655440088",
                },
            },
        }

    monkeypatch.setattr("app.spec_import_engine._worker_runner", _fake)


def _wait_completed(job_id: str) -> dict:
    for _ in range(200):
        r = client.get(f"/v1/tenants/acme/imports/{job_id}")
        assert r.status_code == 200, r.text
        body = r.json()
        if body["state"] in ("completed", "failed", "pending-approval", "canceled", "rolled-back"):
            return body
        time.sleep(0.01)
    raise AssertionError("import job did not reach a gate state")


def test_openapi_lists_spec_import_paths_and_operations():
    spec = app.openapi()
    paths = spec["paths"]
    base = "/v1/tenants/{tenant_slug}/imports"
    upload = f"{base}/upload"
    job = f"{base}/{{job_id}}"
    assert base in paths
    assert "get" in paths[base]
    assert "post" in paths[base]
    assert upload in paths
    assert job in paths
    assert "get" in paths[job]
    assert "delete" in paths[job]
    assert f"{job}/commit" in paths
    assert f"{job}/rollback" in paths


def test_list_spec_import_jobs_empty():
    r = client.get("/v1/tenants/acme/imports")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["jobs"] == []
    assert body["total"] == 0
    assert body["limit"] == 50
    assert body["offset"] == 0


def test_list_spec_import_jobs_includes_started_job(spec_import_fake_worker):
    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "b3BlbmFwaTogMy4xLjA=",
        "filename": "spec.yaml",
    }
    started = client.post("/v1/tenants/acme/imports", json=body)
    assert started.status_code == 202, started.text
    job_id = started.json()["job_id"]

    listed = client.get("/v1/tenants/acme/imports?limit=10&offset=0")
    assert listed.status_code == 200, listed.text
    payload = listed.json()
    rows = payload["jobs"]
    assert payload["total"] >= 1
    assert payload["limit"] == 10
    assert payload["offset"] == 0
    assert any(j["job_id"] == job_id for j in rows)
    match = next(j for j in rows if j["job_id"] == job_id)
    assert match["status_path"].endswith(f"/imports/{job_id}")
    assert "state" in match and "percent" in match

    _wait_completed(job_id)


def test_list_spec_import_jobs_respects_state_filter(spec_import_fake_worker):
    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "b3BlbmFwaTogMy4xLjA=",
        "filename": "spec.yaml",
    }
    started = client.post("/v1/tenants/acme/imports", json=body)
    assert started.status_code == 202, started.text
    job_id = started.json()["job_id"]
    _wait_completed(job_id)

    filtered = client.get("/v1/tenants/acme/imports?state=completed&limit=50")
    assert filtered.status_code == 200, filtered.text
    rows = filtered.json()["jobs"]
    assert any(j["job_id"] == job_id for j in rows)
    assert all(j["state"] == "completed" for j in rows)

    missing = client.get("/v1/tenants/acme/imports?state=failed")
    assert missing.status_code == 200, missing.text
    assert all(j["job_id"] != job_id for j in missing.json()["jobs"])


def test_start_spec_import_json_returns_202(spec_import_fake_worker):
    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "b3BlbmFwaTogMy4xLjA=",
        "filename": "spec.yaml",
    }
    r = client.post("/v1/tenants/acme/imports", json=body)
    assert r.status_code == 202, r.text
    data = r.json()
    assert "job_id" in data and data["job_id"]
    assert data["status_path"].endswith(f"/imports/{data['job_id']}")

    final = _wait_completed(data["job_id"])
    assert final["state"] == "completed"
    assert final["result"]["project_slug"] == "payments-api"


def test_start_spec_import_multipart_returns_202(spec_import_fake_worker):
    meta = json.dumps(
        {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        }
    )
    r = client.post(
        "/v1/tenants/acme/imports/upload",
        files={"file": ("spec.yaml", b"openapi: 3.1.0\n", "application/yaml")},
        data={"metadata": meta},
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    final = _wait_completed(job_id)
    assert final["state"] == "completed"


def test_get_cancel_commit_rollback(spec_import_fake_worker):
    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "e30=",
    }
    r = client.post("/v1/tenants/acme/imports", json=body)
    job_id = r.json()["job_id"]
    _wait_completed(job_id)

    r = client.get(f"/v1/tenants/acme/imports/{job_id}")
    assert r.status_code == 200
    assert r.json()["state"] == "completed"

    r = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert r.status_code == 200
    c = r.json()
    assert c["project_slug"] == "payments-api"
    assert c["version_id"] == "1.0.0"

    r = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert r.status_code == 200

    r = client.post(f"/v1/tenants/acme/imports/{job_id}/rollback")
    assert r.status_code == 409

    r = client.delete(f"/v1/tenants/acme/imports/{job_id}")
    assert r.status_code == 204


def test_commit_returns_501_when_pending_approval(spec_import_pending_worker):
    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "e30=",
    }
    r = client.post("/v1/tenants/acme/imports", json=body)
    job_id = r.json()["job_id"]
    final = _wait_completed(job_id)
    assert final["state"] == "pending-approval"

    r = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert r.status_code == 501
    assert "held_preview_transaction" in r.json()["detail"]

    r = client.post(f"/v1/tenants/acme/imports/{job_id}/rollback")
    assert r.status_code == 501
    assert "held_preview_transaction" in r.json()["detail"]


def test_commit_from_non_owning_instance_via_shared_store(spec_import_fake_worker):
    """Clearing local _jobs (non-owner) still serves commit from the shared store (IXH-6.2)."""
    from app import spec_import_engine as sie

    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "e30=",
    }
    r = client.post("/v1/tenants/acme/imports", json=body)
    job_id = r.json()["job_id"]
    _wait_completed(job_id)

    owner = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert owner.status_code == 200, owner.text
    expected = owner.json()

    sie._jobs.clear()
    assert job_id not in sie._jobs

    remote = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert remote.status_code == 200, remote.text
    assert remote.json() == expected

    again = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert again.status_code == 200
    assert again.json() == expected


@pytest.mark.asyncio
async def test_rollback_idempotent_from_non_owning_instance_via_shared_store():
    """A rolled-back job's prior result is served from the shared store after _jobs.clear()."""
    import uuid

    from app import spec_import_engine as sie
    from app.models import SpecImportJobStatus, SpecImportRollbackResponse

    job_id = str(uuid.uuid4())
    status = SpecImportJobStatus(job_id=job_id, state="rolled-back", percent=100)
    response = SpecImportRollbackResponse(
        job_id=job_id,
        state="rolled-back",
        project_id="550e8400-e29b-41d4-a716-446655440099",
        version_record_id="660e8400-e29b-41d4-a716-446655440088",
    )
    sie._jobs[job_id] = sie._JobRecord(
        tenant_slug="acme",
        job_id=job_id,
        state="rolled-back",
        status=status,
        rollback_response=response,
    )
    await sie._mirror_job(job_id)
    sie._jobs.clear()
    assert job_id not in sie._jobs

    remote = await sie.rollback_spec_import_job("acme", job_id)
    assert remote.state == "rolled-back"
    assert remote.project_id == response.project_id
    assert remote.version_record_id == response.version_record_id

    again = await sie.rollback_spec_import_job("acme", job_id)
    assert again.model_dump() == remote.model_dump()


def test_preview_constraint_from_non_owning_instance_is_501_not_404(
    spec_import_pending_worker,
):
    """pending-approval on a non-owner returns the constraint-named 501, never a bare 404."""
    from app import spec_import_engine as sie

    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "e30=",
    }
    r = client.post("/v1/tenants/acme/imports", json=body)
    job_id = r.json()["job_id"]
    final = _wait_completed(job_id)
    assert final["state"] == "pending-approval"

    sie._jobs.clear()
    assert job_id not in sie._jobs

    commit = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert commit.status_code == 501, commit.text
    assert "held_preview_transaction" in commit.json()["detail"]

    rollback = client.post(f"/v1/tenants/acme/imports/{job_id}/rollback")
    assert rollback.status_code == 501, rollback.text
    assert "held_preview_transaction" in rollback.json()["detail"]


def test_shared_store_commit_rollback_are_tenant_scoped(spec_import_fake_worker):
    """Cross-tenant commit/rollback against a shared-store job is refused (404)."""
    from app import spec_import_engine as sie

    body = {
        "metadata": {
            "source_kind": "openapi-3",
            "project": {"name": "Payments", "slug": "payments-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "e30=",
    }
    r = client.post("/v1/tenants/acme/imports", json=body)
    job_id = r.json()["job_id"]
    _wait_completed(job_id)
    sie._jobs.clear()

    assert client.post(f"/v1/tenants/other/imports/{job_id}/commit").status_code == 404
    assert client.post(f"/v1/tenants/other/imports/{job_id}/rollback").status_code == 404


def test_format_adapter_runs_end_to_end_through_job_api():
    """MFI-1.2 acceptance: a registered format adapter runs end-to-end via the job API.

    The no-op ``sample`` source resolves to the in-process ImportSource pipeline (no
    ``tsx`` worker, no monkeypatch), exercising submit → poll → terminal status through
    the same REST surface OpenAPI uses.
    """
    body = {
        "metadata": {
            "source_kind": "sample",
            "project": {"name": "Sample", "slug": "sample-api"},
            "version": {"version_id": "1.0.0"},
            "options": {},
        },
        "document_base64": "aGVsbG8gc2FtcGxl",  # "hello sample"
        "filename": "sample.txt",
    }
    started = client.post("/v1/tenants/acme/imports", json=body)
    assert started.status_code == 202, started.text
    job_id = started.json()["job_id"]

    final = _wait_completed(job_id)
    assert final["state"] == "completed"
    assert final["percent"] == 100
    assert final["summary"]["source"] == "sample"
    assert final["summary"]["fingerprint"].startswith("sha256:")
    assert final["summary"]["persisted"] is False
    codes = [e["code"] for e in final["events"]]
    assert "PARSE_OK" in codes and "NORMALIZE_OK" in codes and "IMPORT_COMPLETED" in codes

    # The in-process preview path writes no catalog version, so there is nothing to commit.
    commit = client.post(f"/v1/tenants/acme/imports/{job_id}/commit")
    assert commit.status_code == 409, commit.text


def test_adapter_job_appears_in_list_and_is_cancelable():
    """An adapter-driven job is visible in the tenant job list like a worker job."""
    body = {
        "metadata": {
            "source_kind": "sample",
            "project": {"name": "Sample", "slug": "sample-api"},
            "version": {"version_id": "2.0.0"},
            "options": {"dry_run": True},
        },
        "document_base64": "ZHJ5LXJ1bg==",  # "dry-run"
    }
    started = client.post("/v1/tenants/acme/imports", json=body)
    assert started.status_code == 202, started.text
    job_id = started.json()["job_id"]
    final = _wait_completed(job_id)
    assert final["state"] == "completed"
    assert final["summary"]["dry_run"] is True

    listed = client.get("/v1/tenants/acme/imports")
    assert listed.status_code == 200, listed.text
    assert any(j["job_id"] == job_id for j in listed.json()["jobs"])

    # Cancel after a terminal state is a no-op 204 (mirrors the worker path).
    assert client.delete(f"/v1/tenants/acme/imports/{job_id}").status_code == 204


def test_spec_import_options_accepts_skip_duplicate_versions():
    from app.models import SpecImportOptions

    assert SpecImportOptions().skip_duplicate_versions is False
    assert SpecImportOptions(skip_duplicate_versions=True).skip_duplicate_versions is True


def test_spec_import_options_accepts_input_kind():
    """The intake method (file/url/paste) is accepted and validated (MFI-26.2)."""
    import pytest
    from pydantic import ValidationError

    from app.models import SpecImportOptions

    # Omitted → None (the pipeline defaults the recorded inputKind to 'file').
    assert SpecImportOptions().input_kind is None
    for kind in ("file", "url", "paste", "discovery", "fileset"):
        assert SpecImportOptions(input_kind=kind).input_kind == kind
    # An unrecognized intake token is rejected rather than silently stored.
    with pytest.raises(ValidationError):
        SpecImportOptions(input_kind="carrier-pigeon")


def test_resolve_spec_import_worker_argv_env_json(monkeypatch):
    monkeypatch.setenv("SPEC_IMPORT_WORKER_ARGV", '["/bin/true"]')
    from app.spec_import_engine import resolve_spec_import_worker_argv

    assert resolve_spec_import_worker_argv() == ["/bin/true"]


def test_resolve_worker_subprocess_stream_limit_default(monkeypatch):
    monkeypatch.delenv("SPEC_IMPORT_WORKER_STREAM_LIMIT", raising=False)
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_STREAM_LIMIT", raising=False)
    from app.spec_import_engine import (
        _DEFAULT_WORKER_STREAM_LIMIT,
        _resolve_worker_subprocess_stream_limit,
    )

    assert _resolve_worker_subprocess_stream_limit() == _DEFAULT_WORKER_STREAM_LIMIT


def test_resolve_worker_subprocess_stream_limit_from_env(monkeypatch):
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_STREAM_LIMIT", raising=False)
    monkeypatch.setenv("SPEC_IMPORT_WORKER_STREAM_LIMIT", "2097152")
    from app.spec_import_engine import _resolve_worker_subprocess_stream_limit

    assert _resolve_worker_subprocess_stream_limit() == 2097152


def test_resolve_worker_subprocess_stream_limit_prefers_first_env(monkeypatch):
    monkeypatch.setenv("SPEC_IMPORT_WORKER_STREAM_LIMIT", "131072")
    monkeypatch.setenv("APIOME_SPEC_IMPORT_WORKER_STREAM_LIMIT", "262144")
    from app.spec_import_engine import _resolve_worker_subprocess_stream_limit

    assert _resolve_worker_subprocess_stream_limit() == 131072


def test_resolve_worker_subprocess_stream_limit_invalid_falls_back(monkeypatch):
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_STREAM_LIMIT", raising=False)
    monkeypatch.setenv("SPEC_IMPORT_WORKER_STREAM_LIMIT", "not-int")
    from app.spec_import_engine import (
        _DEFAULT_WORKER_STREAM_LIMIT,
        _resolve_worker_subprocess_stream_limit,
    )

    assert _resolve_worker_subprocess_stream_limit() == _DEFAULT_WORKER_STREAM_LIMIT


def test_resolve_worker_subprocess_stream_limit_below_min_ignored(monkeypatch):
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_STREAM_LIMIT", raising=False)
    monkeypatch.setenv("SPEC_IMPORT_WORKER_STREAM_LIMIT", "1000")
    from app.spec_import_engine import (
        _DEFAULT_WORKER_STREAM_LIMIT,
        _resolve_worker_subprocess_stream_limit,
    )

    assert _resolve_worker_subprocess_stream_limit() == _DEFAULT_WORKER_STREAM_LIMIT


def test_resolve_spec_import_worker_argv_prefers_yarn_when_on_path(monkeypatch):
    monkeypatch.delenv("SPEC_IMPORT_WORKER_ARGV", raising=False)
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_ARGV", raising=False)

    def _which(cmd: str):
        return f"/fake/{cmd}" if cmd == "yarn" else None

    monkeypatch.setattr("app.spec_import_engine.shutil.which", _which)
    from app.spec_import_engine import resolve_spec_import_worker_argv

    argv = resolve_spec_import_worker_argv()
    assert argv[:4] == ["yarn", "workspace", "apiome-ui", "exec"]


async def test_apply_streaming_spec_import_status_updates_percent():
    """Partial worker lines should refresh poll-visible percent/progress before the job finishes."""
    from app import spec_import_engine as sie

    jid = "11111111-1111-1111-1111-111111111111"
    sie._jobs[jid] = sie._JobRecord(
        tenant_slug="acme",
        job_id=jid,
        state="running",
        status=SpecImportJobStatus(job_id=jid, state="running", percent=0, events=[]),
    )
    await sie._apply_streaming_spec_import_status(
        jid,
        {
            "job_id": jid,
            "state": "running",
            "percent": 37,
            "events": [],
            "progress": {
                "phase": "creating-classes",
                "total": 10,
                "completed": 3,
                "current_item": "Pet",
            },
        },
    )
    assert sie._jobs[jid].status.percent == 37
    assert sie._jobs[jid].status.progress is not None
    assert sie._jobs[jid].status.progress.completed == 3

    await sie._apply_streaming_spec_import_status(
        jid,
        {"job_id": "wrong-id", "state": "running", "percent": 99, "events": []},
    )
    assert sie._jobs[jid].status.percent == 37


def test_resolve_spec_import_worker_argv_falls_back_to_npm(monkeypatch):
    monkeypatch.delenv("SPEC_IMPORT_WORKER_ARGV", raising=False)
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_ARGV", raising=False)

    def _which(cmd: str):
        return f"/fake/{cmd}" if cmd == "npm" else None

    monkeypatch.setattr("app.spec_import_engine.shutil.which", _which)
    from app.spec_import_engine import resolve_spec_import_worker_argv

    argv = resolve_spec_import_worker_argv()
    assert argv[:3] == ["npm", "exec", "--workspace=apiome-ui"]


def test_resolve_spec_import_worker_invocation_uses_local_tsx_bin(monkeypatch, tmp_path):
    monkeypatch.delenv("SPEC_IMPORT_WORKER_ARGV", raising=False)
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_ARGV", raising=False)
    repo = tmp_path
    ui = repo / "apiome-ui"
    scripts = ui / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "rest-spec-import-worker.ts").write_text("//", encoding="utf-8")
    bin_dir = ui / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    tsx_sh = bin_dir / "tsx"
    tsx_sh.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setattr("app.spec_import_engine._REPO_ROOT", repo)
    monkeypatch.setattr("app.spec_import_engine.shutil.which", lambda _: None)

    from app.spec_import_engine import resolve_spec_import_worker_invocation

    argv, cwd = resolve_spec_import_worker_invocation()
    assert cwd == ui
    assert argv[0] == str(tsx_sh)
    assert argv[1] == "scripts/rest-spec-import-worker.ts"


def test_resolve_spec_import_worker_invocation_raises_without_runner(monkeypatch, tmp_path):
    monkeypatch.delenv("SPEC_IMPORT_WORKER_ARGV", raising=False)
    monkeypatch.delenv("APIOME_SPEC_IMPORT_WORKER_ARGV", raising=False)
    repo = tmp_path
    ui = repo / "apiome-ui"
    scripts = ui / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "rest-spec-import-worker.ts").write_text("//", encoding="utf-8")
    monkeypatch.setattr("app.spec_import_engine._REPO_ROOT", repo)
    monkeypatch.setattr("app.spec_import_engine.shutil.which", lambda _: None)

    from app.spec_import_engine import resolve_spec_import_worker_invocation

    with pytest.raises(RuntimeError, match="SPEC_IMPORT_WORKER_ARGV"):
        resolve_spec_import_worker_invocation()


def test_negative_corpus_never_yields_5xx_through_job_api():
    """IXH-1.3 acceptance: adversarial input never surfaces as an HTTP 5xx.

    Drives one negative corpus fixture per failure class (from tool-free,
    in-process adapters) through submit -> poll: submission is a 202, every
    poll is a 200, and the terminal state is ``failed`` with a taxonomy error
    payload. ``dry_run`` keeps an unexpectedly-parsing fixture from writing.
    """
    import base64

    from corpus_loader import ValidityClass, load_corpus

    from app.import_source import get_import_source, load_builtin_import_sources

    load_builtin_import_sources()

    picked = {}
    for entry in load_corpus(validity_class=ValidityClass.INVALID):
        if entry.adapter_key is None or entry.adapter_key == "openapi":
            continue  # the OpenAPI source_kind routes to the tsx worker
        if get_import_source(entry.adapter_key).required_tools:
            continue
        picked.setdefault(entry.failure_class, entry)
    assert picked, "no eligible negative corpus entries"

    for entry in picked.values():
        body = {
            "metadata": {
                "source_kind": entry.adapter_key,
                "project": {"name": "Negative", "slug": "negative-smoke"},
                "version": {"version_id": "0.0.1"},
                "options": {"dry_run": True},
            },
            "document_base64": base64.standard_b64encode(entry.read_bytes()).decode("ascii"),
            "filename": entry.path.rsplit("/", 1)[-1],
        }
        started = client.post("/v1/tenants/acme/imports", json=body)
        assert started.status_code == 202, f"{entry.path}: {started.status_code} {started.text}"
        final = _wait_completed(started.json()["job_id"])  # asserts 200 on every poll
        assert final["state"] == "failed", f"{entry.path}: reached {final['state']}"
        assert final.get("error"), f"{entry.path}: failed job carries no error payload"
        assert final["error"]["code"] == entry.expected_error_code, entry.path
        assert final["error"]["remediation"].strip(), entry.path


def test_adversarial_corpus_never_yields_5xx_through_job_api():
    """IXH-1.4: hostile documents fail cleanly over HTTP, never as a 5xx.

    Submits one committed adversarial fixture per guard through the real job API and
    asserts submission is a 202, every poll is a 200, and the terminal state carries
    the guard's taxonomy code (or completes with a scrub report). ``dry_run`` keeps a
    scrubbing fixture from writing to the catalog.
    """
    import base64

    from corpus_loader import ValidityClass, load_corpus

    from app.import_source import get_import_source, load_builtin_import_sources

    load_builtin_import_sources()

    picked = {}
    for entry in load_corpus(validity_class=ValidityClass.ADVERSARIAL):
        if entry.adapter_key is None or entry.adapter_key == "openapi":
            continue  # the OpenAPI source_kind routes to the tsx worker
        if get_import_source(entry.adapter_key).required_tools:
            continue
        picked.setdefault(entry.guard, entry)
    assert picked, "no eligible adversarial corpus entries"

    for entry in picked.values():
        body = {
            "metadata": {
                "source_kind": entry.adapter_key,
                "project": {"name": "Adversarial", "slug": "adversarial-smoke"},
                "version": {"version_id": "0.0.1"},
                "options": {"dry_run": True},
            },
            "document_base64": base64.standard_b64encode(entry.read_bytes()).decode("ascii"),
            "filename": entry.path.rsplit("/", 1)[-1],
        }
        started = client.post("/v1/tenants/acme/imports", json=body)
        assert started.status_code == 202, f"{entry.path}: {started.status_code} {started.text}"
        final = _wait_completed(started.json()["job_id"])  # asserts 200 on every poll
        if entry.expected_error_code is not None:
            assert final["state"] == "failed", f"{entry.path}: reached {final['state']}"
            assert final.get("error"), f"{entry.path}: no error payload"
            assert final["error"]["code"] == entry.expected_error_code, entry.path
            assert final["error"]["remediation"].strip(), entry.path
        else:
            assert final["state"] == "completed", f"{entry.path}: reached {final['state']}"
            assert (final["summary"] or {}).get("secret_scrub", {}).get("scrubbed") is True
