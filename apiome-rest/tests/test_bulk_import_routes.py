"""REST contract for bulk import of independent specs — MFI-29.5 (#4392).

Drives ``POST /v1/tenants/{tenant}/import/bulk{,/plan,/status}`` with the two
boundaries stubbed: job scheduling (so no worker runs) and the repository client (so
no network is touched). What is under test is the batch contract — the partition, the
per-item payloads, and above all that one bad item never costs the user the rest.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient
from test_bulk_intake import (
    _ASYNCAPI_ORDERS,
    _ASYNCAPI_SHIPPING,
    _OPENAPI,
    _ORDERS_PROTO,
    _TYPES_PROTO,
)
from test_git_intake import _COMMIT, _REPO_URL, FakeRepositoryClient

from app import bulk_import_routes
from app.auth import validate_authentication
from app.bulk_intake import BulkGroup
from app.format_detection import FormatCandidate, FormatDetection
from app.git_intake import GitIntakeError, GitSelector, fetch_git_fileset, pack_fileset_zip
from app.import_export_quality_policy import (
    QualityGateError,
    QualityThresholds,
    QualityVerdict,
)
from app.main import app
from app.models import SpecImportJobAccepted, SpecImportJobError, SpecImportJobResult, SpecImportJobStatus

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "auth_method": "jwt",
}

_PLAN = f"/v1/tenants/{TENANT_SLUG}/import/bulk/plan"
_SUBMIT = f"/v1/tenants/{TENANT_SLUG}/import/bulk"
_STATUS = f"/v1/tenants/{TENANT_SLUG}/import/bulk/status"

_MIXED_MEMBERS = {
    "protos/common/types.proto": _TYPES_PROTO,
    "protos/orders/orders.proto": _ORDERS_PROTO.replace(
        'import "common/types.proto";', 'import "protos/common/types.proto";'
    ),
    "events/orders.asyncapi.yaml": _ASYNCAPI_ORDERS,
    "events/shipping.asyncapi.yaml": _ASYNCAPI_SHIPPING,
    "openapi/orders.yaml": _OPENAPI,
    "README.md": "# Team specs\n",
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
def _no_quality_policy(monkeypatch):
    """Default: the tenant's import policy sets no floor, so nothing is refused."""

    async def _pass(**kwargs: Any) -> None:
        return None

    monkeypatch.setattr(bulk_import_routes, "enforce_import_quality_gate", _pass)


@pytest.fixture
def scheduled(monkeypatch) -> List[Dict[str, Any]]:
    """Capture every job the batch would start, without running a worker."""
    started: List[Dict[str, Any]] = []

    async def _schedule(tenant_slug, tenant_id, user_id, body):
        started.append(
            {
                "tenant_slug": tenant_slug,
                "source_kind": body.metadata.source_kind,
                "name": body.metadata.project.name,
                "slug": body.metadata.project.slug,
                "options": body.metadata.options,
                "filename": body.filename,
                "document": base64.standard_b64decode(body.document_base64),
            }
        )
        job_id = f"job-{len(started)}"
        return SpecImportJobAccepted(
            job_id=job_id, status_path=f"/v1/tenants/{tenant_slug}/imports/{job_id}"
        )

    monkeypatch.setattr(bulk_import_routes, "schedule_spec_import", _schedule)
    return started


def _archive(members: Optional[Dict[str, str]] = None) -> str:
    """Pack members into the base64 archive payload the endpoints accept."""
    return base64.standard_b64encode(pack_fileset_zip(members or _MIXED_MEMBERS)).decode("ascii")


def _use_repository(monkeypatch, files: Dict[str, str]) -> None:
    """Point the batch at an in-memory repository instead of GitHub."""
    repo = FakeRepositoryClient(files)

    def _fetch(selector: GitSelector, *, access_token: Optional[str] = None, **kwargs: Any):
        return fetch_git_fileset(selector, access_token=access_token, client=repo, **kwargs)

    monkeypatch.setattr(bulk_import_routes, "fetch_git_fileset", _fetch)
    monkeypatch.setattr(
        bulk_import_routes, "resolve_stored_git_token", lambda *args, **kwargs: None
    )


def _blocking_verdict() -> QualityVerdict:
    return QualityVerdict(
        verdict="block",
        blocking=True,
        scope="import",
        source="tenant",
        format_key="asyncapi",
        reason="Import scores D, below the tenant floor of B.",
        thresholds=QualityThresholds(
            min_grade="B", min_score=80, block_on_severity=None, enforcement="enforce"
        ),
    )


# --------------------------------------------------------------------------- plan


def test_plan_partitions_a_mixed_archive_into_one_item_per_spec() -> None:
    response = client.post(_PLAN, json={"document_base64": _archive(), "filename": "specs.zip"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["key"] for item in body["items"]] == [
        "events/orders.asyncapi.yaml",
        "events/shipping.asyncapi.yaml",
        "openapi/orders.yaml",
        "protos/orders/orders.proto",
    ]
    assert body["total_items"] == 4
    assert body["truncated"] is False
    assert body["source_label"] == "specs.zip"


def test_plan_routes_items_and_counts_them_by_destination() -> None:
    body = client.post(_PLAN, json={"document_base64": _archive()}).json()

    targets = {item["key"]: item["predicted_target"] for item in body["items"]}
    assert targets["openapi/orders.yaml"] == "project"
    assert targets["protos/orders/orders.proto"] == "catalog"
    assert body["summary"] == {
        "items": 4,
        "importable": 4,
        "unimportable": 0,
        "skipped_files": 1,
        "by_target": {"catalog": 3, "project": 1},
        "by_format": {"asyncapi-2": 2, "openapi-3.0": 1, "protobuf": 1},
    }


def test_plan_describes_each_item_enough_to_render_a_list() -> None:
    body = client.post(_PLAN, json={"document_base64": _archive()}).json()
    proto = next(item for item in body["items"] if item["key"].endswith("orders.proto"))

    assert proto["members"] == ["protos/common/types.proto", "protos/orders/orders.proto"]
    assert proto["source_kind"] == "grpc"
    assert proto["input_kind"] == "fileset"
    assert proto["importable"] is True
    assert proto["suggested_name"] == "orders"
    assert proto["suggested_slug"] == "orders"
    assert proto["total_bytes"] > 0
    assert proto["reason"]
    # Bytes cost money to pack, so they are opt-in.
    assert proto["document_base64"] is None


def test_plan_returns_item_bytes_only_when_asked() -> None:
    body = client.post(
        _PLAN, json={"document_base64": _archive(), "include_documents": True}
    ).json()

    single = next(item for item in body["items"] if item["key"] == "openapi/orders.yaml")
    assert base64.standard_b64decode(single["document_base64"]).decode("utf-8") == _OPENAPI


def test_plan_reports_files_that_join_no_item() -> None:
    body = client.post(_PLAN, json={"document_base64": _archive()}).json()

    assert body["skipped"] == [{"path": "README.md", "reason": "no-recognisable-format"}]


def test_plan_states_truncation_rather_than_importing_a_silent_prefix(monkeypatch) -> None:
    monkeypatch.setattr(bulk_import_routes.settings, "bulk_import_max_items", 2)
    members = {f"spec-{index}.asyncapi.yaml": _ASYNCAPI_ORDERS for index in range(4)}

    body = client.post(_PLAN, json={"document_base64": _archive(members)}).json()

    assert len(body["items"]) == 2
    assert body["truncated"] is True
    assert body["total_items"] == 4
    assert body["max_items"] == 2
    assert {entry["reason"] for entry in body["skipped"]} == {"over-item-limit"}


def test_plan_refuses_a_single_document_payload() -> None:
    response = client.post(
        _PLAN,
        json={
            "document_base64": base64.standard_b64encode(_OPENAPI.encode()).decode(),
            "filename": "openapi.yaml",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INPUT_ARCHIVE_INVALID"


def test_plan_requires_exactly_one_source() -> None:
    both = client.post(
        _PLAN,
        json={"document_base64": _archive(), "git": {"repo_url": _REPO_URL}},
    )
    neither = client.post(_PLAN, json={})

    assert both.status_code == 422
    assert neither.status_code == 422


def test_plan_reads_a_repository_selection(monkeypatch) -> None:
    _use_repository(monkeypatch, _MIXED_MEMBERS)

    body = client.post(_PLAN, json={"git": {"repo_url": _REPO_URL, "ref": "main"}}).json()

    assert len(body["items"]) == 4
    assert body["git_source"]["commit_sha"] == _COMMIT
    assert body["git_source"]["repo_url"] == _REPO_URL


def test_plan_maps_a_repository_failure_onto_its_taxonomy_code(monkeypatch) -> None:
    def _fetch(*args: Any, **kwargs: Any):
        raise GitIntakeError("repository not found", code="SOURCE_NOT_FOUND")

    monkeypatch.setattr(bulk_import_routes, "fetch_git_fileset", _fetch)
    monkeypatch.setattr(
        bulk_import_routes, "resolve_stored_git_token", lambda *args, **kwargs: None
    )

    response = client.post(_PLAN, json={"git": {"repo_url": _REPO_URL}})

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SOURCE_NOT_FOUND"


# --------------------------------------------------------------------------- submit


def test_submit_starts_one_job_per_item(scheduled) -> None:
    response = client.post(_SUBMIT, json={"document_base64": _archive(), "filename": "specs.zip"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["summary"] == {"requested": 4, "accepted": 4, "failed": 0}
    assert [item["state"] for item in body["items"]] == ["accepted"] * 4
    assert [item["job_id"] for item in body["items"]] == ["job-1", "job-2", "job-3", "job-4"]
    assert len(scheduled) == 4
    assert body["batch_id"]


def test_submit_sends_each_item_as_the_payload_its_shape_implies(scheduled) -> None:
    client.post(_SUBMIT, json={"document_base64": _archive(), "filename": "specs.zip"})

    by_slug = {job["slug"]: job for job in scheduled}
    single = by_slug["orders-api"]
    assert single["source_kind"] == "openapi"
    assert single["options"].input_kind == "file"
    assert single["options"].archive_root is None
    assert single["document"].decode("utf-8") == _OPENAPI

    tree = by_slug["orders"]
    assert tree["source_kind"] == "grpc"
    assert tree["options"].input_kind == "fileset"
    assert tree["options"].archive_root == "protos/orders/orders.proto"


def test_submit_names_each_item_after_its_own_document(scheduled) -> None:
    client.post(_SUBMIT, json={"document_base64": _archive()})

    assert sorted(job["name"] for job in scheduled) == [
        "Orders API",
        "Orders Events",
        "Shipping Events",
        "orders",
    ]


def test_submit_imports_only_the_selected_keys(scheduled) -> None:
    body = client.post(
        _SUBMIT,
        json={"document_base64": _archive(), "keys": ["openapi/orders.yaml"]},
    ).json()

    assert body["summary"] == {"requested": 1, "accepted": 1, "failed": 0}
    assert [job["slug"] for job in scheduled] == ["orders-api"]


def test_submit_forwards_the_dry_run_flag_to_every_item(scheduled) -> None:
    client.post(_SUBMIT, json={"document_base64": _archive(), "dry_run": True})

    assert all(job["options"].dry_run for job in scheduled)


def test_an_unknown_key_fails_only_its_own_row(scheduled) -> None:
    body = client.post(
        _SUBMIT,
        json={"document_base64": _archive(), "keys": ["openapi/orders.yaml", "nope.yaml"]},
    ).json()

    assert body["summary"] == {"requested": 2, "accepted": 1, "failed": 1}
    failed = next(item for item in body["items"] if item["state"] == "failed")
    assert failed["key"] == "nope.yaml"
    assert failed["error"]["code"] == "FORMAT_UNRECOGNIZED"
    assert len(scheduled) == 1


def test_a_policy_block_fails_only_its_own_row(monkeypatch, scheduled) -> None:
    async def _gate(*, source_kind: str, **kwargs: Any) -> None:
        if source_kind == "asyncapi":
            raise QualityGateError(_blocking_verdict())

    monkeypatch.setattr(bulk_import_routes, "enforce_import_quality_gate", _gate)

    body = client.post(_SUBMIT, json={"document_base64": _archive()}).json()

    assert body["summary"] == {"requested": 4, "accepted": 2, "failed": 2}
    blocked = [item for item in body["items"] if item["state"] == "failed"]
    assert {item["key"] for item in blocked} == {
        "events/orders.asyncapi.yaml",
        "events/shipping.asyncapi.yaml",
    }
    assert blocked[0]["error"]["code"] == "QUALITY_POLICY_BLOCKED"
    assert "below the tenant floor" in blocked[0]["error"]["message"]
    # The other two still started — a partial failure does not abort the batch.
    assert len(scheduled) == 2


@pytest.mark.anyio
async def test_an_item_no_adapter_can_import_fails_without_a_job(monkeypatch) -> None:
    """A sniffer-only format is a failed row, not a job that dies in the worker."""

    async def _never(*args: Any, **kwargs: Any):
        raise AssertionError("an unimportable item must not schedule a job")

    monkeypatch.setattr(bulk_import_routes, "schedule_spec_import", _never)
    group = BulkGroup(
        key="future/spec.yaml",
        root_path="future/spec.yaml",
        members={"future/spec.yaml": "some: document\n"},
        detection=FormatDetection(
            detected=FormatCandidate(
                format="future-format",
                confidence=0.9,
                reason="sniffed",
                source_key=None,
                importable=False,
            ),
            candidates=[],
            ambiguous=False,
            ambiguous_candidates=[],
        ),
        reason="independent document",
    )

    row = await bulk_import_routes._start_bulk_item(
        group.key,
        group,
        tenant_slug=TENANT_SLUG,
        tenant_id=TENANT_ID,
        user_id=USER_ID,
        source_label="specs.zip",
        dry_run=False,
        git_result=None,
    )

    assert row.state == "failed"
    assert row.job_id is None
    assert row.error is not None and row.error.code == "FORMAT_UNRECOGNIZED"
    assert "future-format" in row.error.message


def test_a_file_nothing_recognises_never_becomes_an_item(scheduled) -> None:
    members = dict(_MIXED_MEMBERS)
    members["notes/plan.txt"] = "just some notes\n"

    body = client.post(_SUBMIT, json={"document_base64": _archive(members)}).json()

    assert {entry["path"] for entry in body["skipped"]} == {"README.md", "notes/plan.txt"}
    assert all(item["state"] == "accepted" for item in body["items"])


def test_submit_records_per_item_repository_provenance(monkeypatch, scheduled) -> None:
    _use_repository(monkeypatch, _MIXED_MEMBERS)

    client.post(_SUBMIT, json={"git": {"repo_url": _REPO_URL, "ref": "main"}})

    sources = {job["slug"]: job["options"].git_source for job in scheduled}
    assert sources["orders-api"].commit_sha == _COMMIT
    # Each item points at its own document, not at the batch's selection.
    assert sources["orders-api"].path == "openapi/orders.yaml"
    assert sources["orders"].path == "protos/orders/orders.proto"


def test_submit_reports_skipped_files_alongside_the_started_items(scheduled) -> None:
    body = client.post(_SUBMIT, json={"document_base64": _archive()}).json()

    assert body["skipped"] == [{"path": "README.md", "reason": "no-recognisable-format"}]


# --------------------------------------------------------------------------- status


def _status(job_id: str, state: str, **extra: Any) -> SpecImportJobStatus:
    return SpecImportJobStatus(job_id=job_id, state=state, percent=100 if state == "completed" else 40, **extra)


def test_status_rolls_up_a_batch(monkeypatch) -> None:
    statuses = {
        "job-1": _status(
            "job-1",
            "completed",
            summary={"routing": {"target": "catalog"}},
            result=SpecImportJobResult(project_id="p1", project_slug="orders-events"),
        ),
        "job-2": _status(
            "job-2",
            "failed",
            error=SpecImportJobError(
                code="PARSE_FAILED",
                category="format",
                message="broken",
                remediation="fix it",
                retriable=False,
            ),
        ),
        "job-3": _status("job-3", "running"),
    }

    async def _get(tenant_slug: str, job_id: str) -> SpecImportJobStatus:
        return statuses[job_id]

    monkeypatch.setattr(bulk_import_routes, "engine_get_spec_import_status", _get)

    body = client.post(
        _STATUS,
        json={
            "items": [
                {"key": "a", "job_id": "job-1"},
                {"key": "b", "job_id": "job-2"},
                {"key": "c", "job_id": "job-3"},
            ]
        },
    ).json()

    assert body["summary"] == {
        "total": 3,
        "completed": 1,
        "failed": 1,
        "running": 1,
        "not_found": 0,
    }
    assert body["done"] is False
    assert body["items"][0]["target"] == "catalog"
    assert body["items"][0]["project_slug"] == "orders-events"
    assert body["items"][1]["error"]["code"] == "PARSE_FAILED"


def test_status_is_done_when_every_item_is_terminal(monkeypatch) -> None:
    async def _get(tenant_slug: str, job_id: str) -> SpecImportJobStatus:
        return _status(job_id, "completed")

    monkeypatch.setattr(bulk_import_routes, "engine_get_spec_import_status", _get)

    body = client.post(
        _STATUS, json={"items": [{"key": "a", "job_id": "job-1"}]}
    ).json()

    assert body["done"] is True
    assert body["summary"]["completed"] == 1


def test_an_unknown_job_id_does_not_blind_the_rest_of_the_batch(monkeypatch) -> None:
    from fastapi import HTTPException

    async def _get(tenant_slug: str, job_id: str) -> SpecImportJobStatus:
        if job_id == "missing":
            raise HTTPException(status_code=404, detail="Import job not found")
        return _status(job_id, "completed")

    monkeypatch.setattr(bulk_import_routes, "engine_get_spec_import_status", _get)

    body = client.post(
        _STATUS,
        json={"items": [{"key": "a", "job_id": "job-1"}, {"key": "b", "job_id": "missing"}]},
    ).json()

    assert body["summary"] == {
        "total": 2,
        "completed": 1,
        "failed": 0,
        "running": 0,
        "not_found": 1,
    }
    assert body["items"][1]["state"] == "not-found"
    assert body["done"] is True


def test_status_of_an_empty_batch_is_done() -> None:
    body = client.post(_STATUS, json={"items": []}).json()

    assert body["summary"]["total"] == 0
    assert body["done"] is True
