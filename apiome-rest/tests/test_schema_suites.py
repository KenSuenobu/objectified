"""Contract tests for saved schema test suites — IXH-5.7 (#5119).

``/v1/tenants/{tenant_slug}/schema-suites``. Persistence runs against an in-memory fake of the
V240 tables (patched in at ``app.schema_suite_store.db``) and schema resolution / instance
validation are faked at the service seams, so what is asserted here is the feature's own
contract: the stable-reference grammar, tenant scoping, payload bounds, the CLI-mirroring
verdict judge, the regression rule (previously ``passed``, now ``failed`` — and nothing else),
run pinning, history, and the IXH-1.1 corpus round trip.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import patch
from uuid import uuid4

import psycopg2.errors
import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.revision_deprecation import is_uuid_string
from app.schema_instance_service import SchemaInstanceValidationResponse
from app.schema_instance_validation import InstanceFinding
from app.schema_reference import SchemaReferenceError
from app.schema_suite_service import parse_suite_reference

client = TestClient(app)

TENANT_A = str(uuid4())
TENANT_B = str(uuid4())
ARTIFACT_ID = str(uuid4())
REVISION_1 = str(uuid4())
REVISION_2 = str(uuid4())

_MOCK_AUTH = {"tenant_id": TENANT_A, "user_id": "test-user-id", "auth_method": "jwt"}

CORPUS_SCHEMA_PATH = (
    Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "corpus.schema.json"
)


class FakeSuiteDb:
    """In-memory stand-in for the V240 tables behind ``app.schema_suite_store``.

    Mirrors the real ``Database`` methods' contracts: UUID guards return ``None``/``[]`` for
    garbage ids, the tenant+name unique constraint raises ``UniqueViolation``, rows carry the
    same column names the SQL returns, and the listing join yields ``latest_run_*`` columns.
    """

    def __init__(self) -> None:
        self.suites: Dict[str, Dict[str, Any]] = {}
        self.payloads: Dict[str, List[Dict[str, Any]]] = {}
        self.runs: Dict[str, Dict[str, Any]] = {}
        self.results: Dict[str, List[Dict[str, Any]]] = {}
        self.over_cap_prune_calls: List[Any] = []
        self._clock = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)

    def _tick(self) -> datetime:
        self._clock += timedelta(seconds=1)
        return self._clock

    # -- suites ------------------------------------------------------------

    def create_schema_test_suite(self, *, tenant_id, name, description, ref_kind,
                                 ref_artifact, ref_artifact_id, ref_type, payloads):
        if not is_uuid_string(str(tenant_id)):
            return None
        for suite in self.suites.values():
            if suite["tenant_id"] == tenant_id and suite["name"] == name:
                raise psycopg2.errors.UniqueViolation()
        suite_id = str(uuid4())
        now = self._tick()
        row = {
            "id": suite_id, "tenant_id": tenant_id, "name": name,
            "description": description, "ref_kind": ref_kind,
            "ref_artifact": ref_artifact, "ref_artifact_id": ref_artifact_id,
            "ref_type": ref_type, "suite_version": 1,
            "created_at": now, "updated_at": now,
        }
        self.suites[suite_id] = row
        self._store_payloads(suite_id, tenant_id, payloads)
        return dict(row)

    def _store_payloads(self, suite_id, tenant_id, payloads):
        rows = []
        for index, payload in enumerate(payloads):
            rows.append({
                "id": str(uuid4()), "suite_id": suite_id, "tenant_id": tenant_id,
                "name": payload["name"], "payload_text": payload["payload_text"],
                "media_type": payload.get("media_type") or "application/json",
                "validity_class": payload.get("validity_class") or "valid",
                "synthetic": bool(payload.get("synthetic")),
                "notes": payload.get("notes"),
                "position": int(payload.get("position", index)),
                "created_at": self._tick(),
            })
        self.payloads[suite_id] = rows

    def list_schema_test_suites(self, tenant_id, *, ref_kind=None, ref_artifact=None):
        if not is_uuid_string(str(tenant_id)):
            return []
        out = []
        for suite in sorted(self.suites.values(), key=lambda s: s["created_at"], reverse=True):
            if suite["tenant_id"] != tenant_id:
                continue
            if ref_kind and suite["ref_kind"] != ref_kind:
                continue
            if ref_artifact and suite["ref_artifact"] != ref_artifact:
                continue
            row = dict(suite)
            row["payload_count"] = len(self.payloads.get(suite["id"], []))
            newest = self._newest_run(suite["id"])
            if newest is None:
                row["latest_run_id"] = None
            else:
                for key, value in newest.items():
                    row[f"latest_run_{key}"] = value
            out.append(row)
        return out

    def _newest_run(self, suite_id, *, completed_only=False):
        candidates = [
            run for run in self.runs.values()
            if run["suite_id"] == suite_id and (not completed_only or run["status"] == "completed")
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda run: run["created_at"])

    def get_schema_test_suite(self, tenant_id, suite_id):
        if not (is_uuid_string(str(tenant_id)) and is_uuid_string(str(suite_id))):
            return None
        suite = self.suites.get(suite_id)
        if suite is None or suite["tenant_id"] != tenant_id:
            return None
        return dict(suite)

    def list_schema_test_suite_payloads(self, tenant_id, suite_id):
        if not (is_uuid_string(str(tenant_id)) and is_uuid_string(str(suite_id))):
            return []
        suite = self.suites.get(suite_id)
        if suite is None or suite["tenant_id"] != tenant_id:
            return []
        return [dict(row) for row in sorted(
            self.payloads.get(suite_id, []), key=lambda r: (r["position"], r["created_at"])
        )]

    def update_schema_test_suite_meta(self, tenant_id, suite_id, *, name=None,
                                      description=None, clear_description=False):
        suite = self.suites.get(suite_id) if is_uuid_string(str(suite_id)) else None
        if suite is None or suite["tenant_id"] != tenant_id:
            return None
        if name is not None:
            for other in self.suites.values():
                if other["id"] != suite_id and other["tenant_id"] == tenant_id and other["name"] == name:
                    raise psycopg2.errors.UniqueViolation()
            suite["name"] = name
        if clear_description:
            suite["description"] = None
        elif description is not None:
            suite["description"] = description
        suite["updated_at"] = self._tick()
        return dict(suite)

    def delete_schema_test_suite(self, tenant_id, suite_id):
        suite = self.suites.get(suite_id) if is_uuid_string(str(suite_id)) else None
        if suite is None or suite["tenant_id"] != tenant_id:
            return 0
        del self.suites[suite_id]
        self.payloads.pop(suite_id, None)
        run_ids = [run_id for run_id, run in self.runs.items() if run["suite_id"] == suite_id]
        for run_id in run_ids:
            del self.runs[run_id]
            self.results.pop(run_id, None)
        return 1

    def replace_schema_test_suite_payloads(self, tenant_id, suite_id, payloads):
        suite = self.suites.get(suite_id) if is_uuid_string(str(suite_id)) else None
        if suite is None or suite["tenant_id"] != tenant_id:
            return None
        suite["suite_version"] += 1
        suite["updated_at"] = self._tick()
        self._store_payloads(suite_id, tenant_id, payloads)
        return dict(suite)

    # -- runs --------------------------------------------------------------

    def get_latest_completed_schema_suite_run(self, tenant_id, suite_id):
        if not (is_uuid_string(str(tenant_id)) and is_uuid_string(str(suite_id))):
            return None
        newest = self._newest_run(suite_id, completed_only=True)
        return dict(newest) if newest and newest["tenant_id"] == tenant_id else None

    def insert_schema_test_suite_run(self, *, suite_id, tenant_id, suite_version,
                                     requested_ref, resolved_revision_id,
                                     resolved_version_label, trigger, status, total,
                                     passed, failed, errored, regression,
                                     baseline_run_id, message, results):
        if not (is_uuid_string(str(tenant_id)) and is_uuid_string(str(suite_id))):
            return None
        run_id = str(uuid4())
        row = {
            "id": run_id, "suite_id": suite_id, "tenant_id": tenant_id,
            "suite_version": suite_version, "requested_ref": requested_ref,
            "resolved_revision_id": resolved_revision_id,
            "resolved_version_label": resolved_version_label, "trigger": trigger,
            "status": status, "total": total, "passed": passed, "failed": failed,
            "errored": errored, "regression": regression,
            "baseline_run_id": baseline_run_id, "message": message,
            "created_at": self._tick(),
        }
        self.runs[run_id] = row
        self.results[run_id] = [
            {"id": str(uuid4()), "run_id": run_id, "position": index, **result}
            for index, result in enumerate(results)
        ]
        return dict(row)

    def list_schema_test_suite_runs(self, tenant_id, suite_id, *, limit=20, offset=0):
        if not (is_uuid_string(str(tenant_id)) and is_uuid_string(str(suite_id))):
            return []
        rows = sorted(
            (run for run in self.runs.values()
             if run["suite_id"] == suite_id and run["tenant_id"] == tenant_id),
            key=lambda run: run["created_at"], reverse=True,
        )
        limit = max(1, min(int(limit), 100))
        return [dict(row) for row in rows[offset:offset + limit]]

    def get_schema_test_suite_run(self, tenant_id, suite_id, run_id):
        if not (is_uuid_string(str(tenant_id)) and is_uuid_string(str(suite_id))
                and is_uuid_string(str(run_id))):
            return None
        run = self.runs.get(run_id)
        if run is None or run["tenant_id"] != tenant_id or run["suite_id"] != suite_id:
            return None
        return dict(run)

    def list_schema_suite_run_results(self, run_id):
        if not is_uuid_string(str(run_id)):
            return []
        return [dict(row) for row in sorted(
            self.results.get(run_id, []), key=lambda r: r["position"]
        )]

    def prune_schema_suite_runs_over_cap(self, suite_id, max_per_suite):
        self.over_cap_prune_calls.append((suite_id, max_per_suite))
        rows = sorted(
            (run for run in self.runs.values() if run["suite_id"] == suite_id),
            key=lambda run: run["created_at"], reverse=True,
        )
        pruned = 0
        for run in rows[max_per_suite:]:
            del self.runs[run["id"]]
            self.results.pop(run["id"], None)
            pruned += 1
        return pruned


# ===========================================================================
# Fakes for the service seams
# ===========================================================================


def _fake_resolution(revision_id: str = REVISION_1, version_label: str = "1.0.0"):
    """A ``resolve_revision_model`` stand-in pinning the given revision."""

    def _resolve(reference, *, tenant_id):
        return SimpleNamespace(
            coordinates={
                "kind": reference.kind,
                "artifact_id": ARTIFACT_ID,
                "artifact_slug": reference.artifact,
                "revision_id": revision_id,
                "version_label": version_label,
            }
        )

    return _resolve


def _validation_response(
    ref: str,
    *,
    valid: Optional[bool],
    ok: bool = True,
    findings: Optional[List[InstanceFinding]] = None,
) -> SchemaInstanceValidationResponse:
    return SchemaInstanceValidationResponse(
        ok=ok,
        valid=valid,
        validated=valid is not None,
        validator="jsonschema/2020-12" if valid is not None else None,
        schema_ref=ref,
        media_type="application/json",
        findings=findings or [],
        total_findings=len(findings or []),
    )


def _fake_validator(verdicts: Dict[str, Optional[bool]], calls: Optional[List[str]] = None):
    """A ``validate_schema_instance`` stand-in judging by payload text.

    ``verdicts`` maps payload text to the ``valid`` tri-state it should report.
    """

    async def _validate(schema_ref, request, *, tenant_id):
        if calls is not None:
            calls.append(schema_ref)
        valid = verdicts.get(request.instance_text, True)
        findings = []
        if valid is False:
            findings = [InstanceFinding(
                pointer="/x", keyword="type", schema_pointer="/properties/x/type",
                expected="string", actual=1, message="1 is not of type 'string'",
            )]
        return _validation_response(schema_ref, valid=valid, findings=findings)

    return _validate


@pytest.fixture()
def fake_db():
    db = FakeSuiteDb()
    with patch("app.schema_suite_store.db", db):
        yield db


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request and grant the permission the routes check."""
    app.dependency_overrides[validate_authentication] = lambda: dict(_MOCK_AUTH)
    with patch("app.schema_suite_routes.enforce_permission", return_value="test-user-id"):
        yield
    app.dependency_overrides.clear()


def _url(path: str = "") -> str:
    return f"/v1/tenants/acme/schema-suites{path}"


def _create(
    name: str = "petstore smoke",
    ref: str = "project/petstore/1.0.0/Pet",
    payloads: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    body = {
        "name": name,
        "ref": ref,
        "payloads": payloads if payloads is not None else [
            {"name": "minimal pet", "payload_text": '{"name": "Rex"}'},
            {
                "name": "missing name",
                "payload_text": '{"age": 3}',
                "validity_class": "invalid",
            },
        ],
    }
    with patch("app.schema_suite_service.resolve_revision_model", _fake_resolution()):
        response = client.post(_url(), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _run(suite_id: str, verdicts: Dict[str, Optional[bool]], *,
         revision: str = REVISION_1, version: str = "latest",
         calls: Optional[List[str]] = None) -> Dict[str, Any]:
    with patch(
        "app.schema_suite_service.resolve_revision_model", _fake_resolution(revision)
    ), patch(
        "app.schema_suite_service.validate_schema_instance", _fake_validator(verdicts, calls)
    ):
        response = client.post(_url(f"/{suite_id}/runs"), json={"version": version})
    assert response.status_code == 201, response.text
    return response.json()


# ===========================================================================
# Reference grammar
# ===========================================================================


def test_stable_reference_parses_with_and_without_version_and_type() -> None:
    """The create grammar accepts the stable form and the 5.1 form, discarding the version."""
    assert parse_suite_reference("project/petstore") == ("project", "petstore", None)
    assert parse_suite_reference("catalog/orders/1.2.0") == ("catalog", "orders", None)
    assert parse_suite_reference("project/petstore/latest/Pet") == ("project", "petstore", "Pet")


@pytest.mark.parametrize(
    "raw",
    ["", "project", "nonsense/thing", "project/a/b/c/d", "registry/std/v0/email"],
)
def test_malformed_or_registry_references_are_rejected(raw: str) -> None:
    """Registry refs have no revisions to regress across; everything else is grammar."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        parse_suite_reference(raw)
    assert excinfo.value.status_code == 400


# ===========================================================================
# CRUD
# ===========================================================================


def test_create_returns_the_suite_with_a_stable_reference(fake_db: FakeSuiteDb) -> None:
    """The version segment is discarded; type and artifact survive; payloads are stored."""
    suite = _create()
    assert suite["ref"] == "project/petstore/Pet"
    assert suite["ref_kind"] == "project"
    assert suite["ref_artifact"] == "petstore"
    assert suite["ref_type"] == "Pet"
    assert suite["ref_artifact_id"] == ARTIFACT_ID
    assert suite["suite_version"] == 1
    assert suite["payload_count"] == 2
    names = [payload["name"] for payload in suite["payloads"]]
    assert names == ["minimal pet", "missing name"]
    assert suite["payloads"][1]["validity_class"] == "invalid"


def test_create_survives_an_unresolvable_reference(fake_db: FakeSuiteDb) -> None:
    """An artifact with no revision yet still gets its suite; the id is just left null."""
    with patch(
        "app.schema_suite_service.resolve_revision_model",
        side_effect=SchemaReferenceError("nothing yet", status_code=404),
    ):
        response = client.post(
            _url(), json={"name": "early bird", "ref": "project/unborn", "payloads": []}
        )
    assert response.status_code == 201
    assert response.json()["ref_artifact_id"] is None


def test_create_rejects_a_registry_reference(fake_db: FakeSuiteDb) -> None:
    response = client.post(
        _url(), json={"name": "x", "ref": "registry/std/v0/primitives/email", "payloads": []}
    )
    assert response.status_code == 400
    assert "registry" in response.json()["detail"]["message"]


def test_create_rejects_a_duplicate_name_with_409(fake_db: FakeSuiteDb) -> None:
    _create(name="dup")
    with patch("app.schema_suite_service.resolve_revision_model", _fake_resolution()):
        response = client.post(
            _url(), json={"name": "dup", "ref": "project/petstore", "payloads": []}
        )
    assert response.status_code == 409


def test_create_bounds_the_payload_set(fake_db: FakeSuiteDb) -> None:
    """Over-cap, duplicate-name, and oversize payload sets are friendly 400s."""
    too_many = [
        {"name": f"p{i}", "payload_text": "{}"} for i in range(51)
    ]
    response = client.post(
        _url(), json={"name": "big", "ref": "project/petstore", "payloads": too_many}
    )
    assert response.status_code == 400
    assert "APIOME_SCHEMA_SUITE_MAX_PAYLOADS" in response.json()["detail"]

    dupes = [
        {"name": "same", "payload_text": "{}"},
        {"name": "same", "payload_text": "[]"},
    ]
    response = client.post(
        _url(), json={"name": "dupes", "ref": "project/petstore", "payloads": dupes}
    )
    assert response.status_code == 400
    assert "Duplicate payload name" in response.json()["detail"]

    oversize = [{"name": "fat", "payload_text": "x" * (262_144 + 1)}]
    response = client.post(
        _url(), json={"name": "fat", "ref": "project/petstore", "payloads": oversize}
    )
    assert response.status_code == 400
    assert "262144" in response.json()["detail"]


def test_listing_filters_by_reference_and_carries_the_latest_run(fake_db: FakeSuiteDb) -> None:
    """One query feeds the list and the badge: each row embeds its newest run summary."""
    suite = _create(name="petstore suite", ref="project/petstore")
    _create(name="orders suite", ref="catalog/orders")
    _run(suite["id"], {'{"age": 3}': False})  # invalid-class payload correctly fails

    response = client.get(_url() + "?ref=project/petstore/9.9.9/IgnoredType")
    assert response.status_code == 200
    rows = response.json()
    assert [row["name"] for row in rows] == ["petstore suite"]
    latest = rows[0]["latest_run"]
    assert latest["status"] == "completed"
    assert latest["regression"] is False
    assert latest["resolved_revision_id"] == REVISION_1

    everything = client.get(_url()).json()
    assert {row["name"] for row in everything} == {"petstore suite", "orders suite"}


def test_suites_are_tenant_scoped(fake_db: FakeSuiteDb) -> None:
    """Another tenant's credential sees neither the listing entry nor the detail."""
    suite = _create()
    app.dependency_overrides[validate_authentication] = lambda: {
        **_MOCK_AUTH, "tenant_id": TENANT_B
    }
    assert client.get(_url()).json() == []
    assert client.get(_url(f"/{suite['id']}")).status_code == 404


def test_detail_misses_are_404_not_500(fake_db: FakeSuiteDb) -> None:
    """Unknown and garbage ids both read as absence (the columns are UUID-typed)."""
    assert client.get(_url(f"/{uuid4()}")).status_code == 404
    assert client.get(_url("/not-a-uuid")).status_code == 404


def test_patch_renames_and_conflicts_cleanly(fake_db: FakeSuiteDb) -> None:
    first = _create(name="first")
    _create(name="second")
    response = client.patch(_url(f"/{first['id']}"), json={"name": "renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "renamed"

    response = client.patch(_url(f"/{first['id']}"), json={"name": "second"})
    assert response.status_code == 409

    response = client.patch(_url(f"/{first['id']}"), json={"clear_description": True})
    assert response.json()["description"] is None


def test_replacing_payloads_bumps_the_suite_version(fake_db: FakeSuiteDb) -> None:
    suite = _create()
    response = client.put(
        _url(f"/{suite['id']}/payloads"),
        json={"payloads": [{"name": "only", "payload_text": "{}"}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["suite_version"] == 2
    assert [payload["name"] for payload in body["payloads"]] == ["only"]


def test_delete_removes_the_suite_and_its_history(fake_db: FakeSuiteDb) -> None:
    suite = _create()
    _run(suite["id"], {})
    assert client.delete(_url(f"/{suite['id']}")).status_code == 204
    assert client.get(_url(f"/{suite['id']}")).status_code == 404
    assert fake_db.runs == {}


def test_authentication_is_required(fake_db: FakeSuiteDb) -> None:
    app.dependency_overrides.clear()
    assert client.get(_url()).status_code in (401, 403)


# ===========================================================================
# Runs and the verdict judge
# ===========================================================================


def test_a_run_pins_one_revision_and_judges_every_payload(fake_db: FakeSuiteDb) -> None:
    """Both payloads meet their expectations; the ref every validation used is pinned."""
    suite = _create()
    calls: List[str] = []
    run = _run(suite["id"], {'{"age": 3}': False}, calls=calls)

    assert run["status"] == "completed"
    assert run["total"] == 2
    assert run["passed"] == 2
    assert run["failed"] == 0
    assert run["regression"] is False
    assert run["resolved_revision_id"] == REVISION_1
    assert run["resolved_version_label"] == "1.0.0"
    assert run["requested_ref"] == "project/petstore/latest/Pet"
    # Every payload validated against the pinned revision id, not the moving token.
    assert calls == [f"project/petstore/{REVISION_1}/Pet"] * 2

    by_name = {result["payload_name"]: result for result in run["results"]}
    assert by_name["minimal pet"]["status"] == "passed"
    assert by_name["minimal pet"]["message"] == "valid"
    assert by_name["missing name"]["status"] == "passed"
    assert by_name["missing name"]["message"] == "invalid, as expected"
    assert by_name["missing name"]["previous_status"] is None


def test_the_judge_mirrors_the_cli(fake_db: FakeSuiteDb) -> None:
    """Expectation mismatches are failures; a missing verdict is an error, never a pass."""
    suite = _create(payloads=[
        {"name": "should pass", "payload_text": '{"a": 1}'},
        {"name": "should fail", "payload_text": '{"b": 2}', "validity_class": "invalid"},
        {"name": "unchecked", "payload_text": '{"c": 3}'},
    ])
    run = _run(suite["id"], {'{"a": 1}': False, '{"b": 2}': True, '{"c": 3}': None})

    by_name = {result["payload_name"]: result for result in run["results"]}
    assert by_name["should pass"]["status"] == "failed"
    assert "expected valid but" in by_name["should pass"]["message"]
    assert by_name["should pass"]["findings"][0]["keyword"] == "type"
    assert by_name["should fail"]["status"] == "failed"
    assert by_name["should fail"]["message"] == "expected invalid but the payload validated cleanly"
    assert by_name["unchecked"]["status"] == "error"
    assert by_name["unchecked"]["valid"] is None
    assert run["passed"] == 0
    assert run["failed"] == 2
    assert run["errored"] == 1


def test_an_unserviceable_validation_is_an_error_verdict(fake_db: FakeSuiteDb) -> None:
    suite = _create(payloads=[{"name": "p", "payload_text": "{}"}])

    async def _unserviceable(schema_ref, request, *, tenant_id):
        return _validation_response(schema_ref, valid=None, ok=False)

    with patch(
        "app.schema_suite_service.resolve_revision_model", _fake_resolution()
    ), patch("app.schema_suite_service.validate_schema_instance", _unserviceable):
        run = client.post(_url(f"/{suite['id']}/runs"), json={}).json()
    assert run["errored"] == 1
    assert run["results"][0]["status"] == "error"


def test_an_unresolvable_reference_records_an_error_run(fake_db: FakeSuiteDb) -> None:
    """That the suite could not run against a revision is history, not an exception."""
    suite = _create()
    with patch(
        "app.schema_suite_service.resolve_revision_model",
        side_effect=SchemaReferenceError("Version '9.9.9' was not found", status_code=404),
    ):
        response = client.post(_url(f"/{suite['id']}/runs"), json={"version": "9.9.9"})
    assert response.status_code == 201
    run = response.json()
    assert run["status"] == "error"
    assert run["total"] == 0
    assert run["results"] == []
    assert "9.9.9" in run["message"]
    assert run["resolved_revision_id"] is None

    history = client.get(_url(f"/{suite['id']}/runs")).json()
    assert [row["status"] for row in history] == ["error"]


def test_running_a_missing_suite_is_a_404(fake_db: FakeSuiteDb) -> None:
    response = client.post(_url(f"/{uuid4()}/runs"), json={})
    assert response.status_code == 404


# ===========================================================================
# Regression tracking
# ===========================================================================


def test_a_newly_failing_payload_flags_a_regression(fake_db: FakeSuiteDb) -> None:
    """passed -> failed flips the result and the run, and names the baseline run."""
    suite = _create()
    first = _run(suite["id"], {'{"age": 3}': False}, revision=REVISION_1)

    # Revision 2 breaks the previously-passing payload.
    second = _run(
        suite["id"], {'{"name": "Rex"}': False, '{"age": 3}': False}, revision=REVISION_2
    )
    assert second["regression"] is True
    assert second["baseline_run_id"] == first["id"]
    by_name = {result["payload_name"]: result for result in second["results"]}
    broken = by_name["minimal pet"]
    assert broken["status"] == "failed"
    assert broken["previous_status"] == "passed"
    assert broken["regression"] is True
    # The verdict diff is visible on the untouched payload too, without a flag.
    assert by_name["missing name"]["previous_status"] == "passed"
    assert by_name["missing name"]["regression"] is False


def test_a_still_failing_payload_is_not_newly_failing(fake_db: FakeSuiteDb) -> None:
    """The flag marks the flip, not the state: the third run is calm again."""
    suite = _create()
    _run(suite["id"], {'{"age": 3}': False}, revision=REVISION_1)
    _run(suite["id"], {'{"name": "Rex"}': False, '{"age": 3}': False}, revision=REVISION_2)
    third = _run(
        suite["id"], {'{"name": "Rex"}': False, '{"age": 3}': False}, revision=REVISION_2
    )
    assert third["regression"] is False
    by_name = {result["payload_name"]: result for result in third["results"]}
    assert by_name["minimal pet"]["previous_status"] == "failed"
    assert by_name["minimal pet"]["regression"] is False


def test_passed_to_error_is_not_a_regression(fake_db: FakeSuiteDb) -> None:
    """No verdict means no evidence the schema broke the payload; the diff stays visible."""
    suite = _create()
    _run(suite["id"], {'{"age": 3}': False}, revision=REVISION_1)
    second = _run(
        suite["id"], {'{"name": "Rex"}': None, '{"age": 3}': False}, revision=REVISION_2
    )
    assert second["regression"] is False
    by_name = {result["payload_name"]: result for result in second["results"]}
    assert by_name["minimal pet"]["status"] == "error"
    assert by_name["minimal pet"]["previous_status"] == "passed"
    assert by_name["minimal pet"]["regression"] is False


def test_a_renamed_payload_has_no_baseline(fake_db: FakeSuiteDb) -> None:
    suite = _create()
    _run(suite["id"], {'{"age": 3}': False})
    client.put(
        _url(f"/{suite['id']}/payloads"),
        json={"payloads": [{"name": "fresh name", "payload_text": '{"name": "Rex"}'}]},
    )
    second = _run(suite["id"], {'{"name": "Rex"}': False})
    result = second["results"][0]
    assert result["previous_status"] is None
    assert result["regression"] is False
    assert second["suite_version"] == 2


def test_an_error_run_never_becomes_the_baseline(fake_db: FakeSuiteDb) -> None:
    """The diff skips over error runs to the last run that actually judged payloads."""
    suite = _create()
    first = _run(suite["id"], {'{"age": 3}': False}, revision=REVISION_1)
    with patch(
        "app.schema_suite_service.resolve_revision_model",
        side_effect=SchemaReferenceError("gone", status_code=404),
    ):
        client.post(_url(f"/{suite['id']}/runs"), json={"version": "ghost"})
    third = _run(
        suite["id"], {'{"name": "Rex"}': False, '{"age": 3}': False}, revision=REVISION_2
    )
    assert third["baseline_run_id"] == first["id"]
    assert third["regression"] is True


# ===========================================================================
# History
# ===========================================================================


def test_history_pages_newest_first_and_details_carry_results(fake_db: FakeSuiteDb) -> None:
    suite = _create(payloads=[{"name": "p", "payload_text": "{}"}])
    runs = [_run(suite["id"], {}) for _ in range(3)]

    history = client.get(_url(f"/{suite['id']}/runs?limit=2")).json()
    assert [row["id"] for row in history] == [runs[2]["id"], runs[1]["id"]]
    rest = client.get(_url(f"/{suite['id']}/runs?limit=2&offset=2")).json()
    assert [row["id"] for row in rest] == [runs[0]["id"]]

    detail = client.get(_url(f"/{suite['id']}/runs/{runs[0]['id']}")).json()
    assert detail["results"][0]["payload_name"] == "p"
    assert client.get(_url(f"/{suite['id']}/runs/{uuid4()}")).status_code == 404


def test_every_run_prunes_that_suites_history_over_the_cap(fake_db: FakeSuiteDb) -> None:
    """Prune-on-write rides the insert: one call per recorded run, at the configured cap."""
    suite = _create(payloads=[{"name": "p", "payload_text": "{}"}])
    _run(suite["id"], {})
    assert fake_db.over_cap_prune_calls == [(suite["id"], 200)]


# ===========================================================================
# Corpus round trip (IXH-1.1)
# ===========================================================================


def test_export_is_a_valid_corpus_manifest(fake_db: FakeSuiteDb) -> None:
    """The envelope's manifest validates against the real corpus schema, entry by entry."""
    import jsonschema

    suite = _create(payloads=[
        {"name": "Minimal Pet", "payload_text": '{"name": "Rex"}', "synthetic": True},
        {
            "name": "Missing Name",
            "payload_text": '{"age": 3}',
            "validity_class": "invalid",
            "notes": "drops the required name",
        },
        {
            "name": "bill of lading",
            "payload_text": "<note>x</note>",
            "media_type": "application/xml",
        },
    ])
    response = client.get(_url(f"/{suite['id']}/export"))
    assert response.status_code == 200
    envelope = response.json()

    corpus_schema = json.loads(CORPUS_SCHEMA_PATH.read_text())
    jsonschema.Draft202012Validator(corpus_schema).validate(envelope["manifest"])

    entries = {entry["path"]: entry for entry in envelope["manifest"]["entries"]}
    files = {file["path"]: file["content"] for file in envelope["files"]}
    assert set(entries) == set(files) == {
        "json-schema/test-bench/minimal-pet.json",
        "json-schema/test-bench/missing-name.json",
        "xsd/test-bench/bill-of-lading.xml",
    }
    minimal = entries["json-schema/test-bench/minimal-pet.json"]
    assert minimal["validity_class"] == "valid"
    assert minimal["expected_outcome"] == "imports"
    assert minimal["source"] == "synthesized"
    assert "instance-payload" in minimal["features"]
    missing = entries["json-schema/test-bench/missing-name.json"]
    assert missing["validity_class"] == "invalid"
    assert missing["expected_outcome"] == "rejects"
    assert missing["notes"] == "drops the required name"
    assert entries["xsd/test-bench/bill-of-lading.xml"]["expected_detection"]["format"] == "xml"
    assert files["json-schema/test-bench/missing-name.json"] == '{"age": 3}'


def test_import_reads_the_export_back_losslessly(fake_db: FakeSuiteDb) -> None:
    """Export -> import round-trips the payload set, including non-valid classes."""
    suite = _create(payloads=[
        {"name": "keeper", "payload_text": '{"name": "Rex"}'},
        {"name": "breaker", "payload_text": '{"age": 3}', "validity_class": "invalid"},
    ])
    envelope = client.get(_url(f"/{suite['id']}/export")).json()

    with patch("app.schema_suite_service.resolve_revision_model", _fake_resolution()):
        response = client.post(_url("/import"), json={
            "name": "reimported",
            "ref": "project/petstore",
            "manifest": envelope["manifest"],
            "files": envelope["files"],
        })
    assert response.status_code == 201, response.text
    imported = response.json()
    by_name = {payload["name"]: payload for payload in imported["payloads"]}
    assert by_name["keeper"]["validity_class"] == "valid"
    assert by_name["keeper"]["payload_text"] == '{"name": "Rex"}'
    assert by_name["breaker"]["validity_class"] == "invalid"


def test_import_refuses_a_manifest_with_a_missing_file(fake_db: FakeSuiteDb) -> None:
    suite = _create(payloads=[{"name": "p", "payload_text": "{}"}])
    envelope = client.get(_url(f"/{suite['id']}/export")).json()
    response = client.post(_url("/import"), json={
        "name": "broken", "ref": "project/petstore",
        "manifest": envelope["manifest"], "files": [],
    })
    assert response.status_code == 400
    assert "no file with that path" in response.json()["detail"]


def test_import_refuses_a_manifest_without_instance_payloads(fake_db: FakeSuiteDb) -> None:
    response = client.post(_url("/import"), json={
        "name": "empty", "ref": "project/petstore",
        "manifest": {"manifest_version": 1, "directories": {}, "entries": []},
        "files": [],
    })
    assert response.status_code == 400
    assert "instance-payload" in response.json()["detail"]
