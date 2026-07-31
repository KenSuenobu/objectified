"""Acceptance tests for REPO-3.4 / #2773 — the Arazzo 1.x workflow importer.

Covers the ticket's acceptance criteria against the **official** Arazzo example bundles in
``tests/fixtures/arazzo`` (copied verbatim from ``OAI/Arazzo-Specification``):

* each ``workflows[]`` entry becomes one Workflow row plus N WorkflowStep rows, in source order;
* ``operationRef`` / ``operationId`` / ``operationPath`` values that name an operation imported
  in the same scan resolve to an internal ``path_operation`` id;
* an unresolved reference keeps its raw string, leaves the FK NULL, and produces a warning;
* the rows survive a persist → load round trip byte-for-byte.

The persistence tests drive a fake cursor that parses each statement's column list and zips it
with the bound parameters, so a column/value mismatch in the INSERTs fails here rather than in
production.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest

from app.arazzo_import_source import ArazzoImportSource
from app.arazzo_workflow_persistence import (
    REASON_AMBIGUOUS,
    REASON_CALLS_WORKFLOW,
    REASON_NO_TARGET,
    REASON_UNKNOWN,
    STATUS_NOT_APPLICABLE,
    STATUS_RESOLVED,
    STATUS_UNRESOLVED,
    OperationIndex,
    WorkflowRow,
    build_workflow_rows,
    load_arazzo_workflows,
    parse_operation_ref,
    persist_arazzo_workflows,
    resolve_workflow_steps,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "arazzo"

_TENANT = "11111111-1111-1111-1111-111111111111"
_PROJECT = "22222222-2222-2222-2222-222222222222"
_VERSION = "33333333-3333-3333-3333-333333333333"
_ARTIFACT = "44444444-4444-4444-4444-444444444444"


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------


def _load_bundle(name: str):
    """Normalize an official bundle fixture into a canonical model."""
    adapter = ArazzoImportSource()
    raw = (_FIXTURES / f"{name}.arazzo.yaml").read_text(encoding="utf-8")
    return adapter.normalize(adapter.parse(raw, source_label=f"{name}.arazzo.yaml"))


def _source_workflows(name: str) -> List[Dict[str, Any]]:
    """Read the fixture's raw ``workflows`` list, for comparing against the mapped rows."""
    import yaml

    document = yaml.safe_load((_FIXTURES / f"{name}.arazzo.yaml").read_text(encoding="utf-8"))
    return document["workflows"]


def _operation_row(
    row_id: str,
    *,
    pathname: str,
    method: str,
    operation_id: Optional[str] = None,
    source_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Build one path-operation index record the way the DB query returns it."""
    return {
        "id": row_id,
        "pathname": pathname,
        "operation": method,
        "operation_id": operation_id,
        "project_id": _PROJECT,
        "version_id": _VERSION,
        "source_path": source_path,
    }


_INSERT_RE = re.compile(
    r"INSERT INTO apiome\.(?P<table>\w+)\s*\((?P<columns>[^)]*)\)", re.IGNORECASE
)
_SELECT_RE = re.compile(
    r"SELECT\s+(?P<columns>.*?)\s+FROM apiome\.(?P<table>\w+)", re.IGNORECASE | re.DOTALL
)
_UPDATE_RE = re.compile(r"UPDATE\s+apiome\.(?P<table>\w+)", re.IGNORECASE)


class _FakeCursor:
    """Cursor that stores INSERTs as column→value dicts and replays them for SELECTs.

    Deliberately literal about the SQL: the column list is parsed out of each statement and
    zipped with the bound parameters, so an INSERT whose columns and values drift apart raises
    here instead of writing shuffled data.
    """

    def __init__(self, store: Dict[str, List[Dict[str, Any]]]) -> None:
        self._store = store
        self._result: List[Dict[str, Any]] = []

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        return None

    def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        statement = " ".join(sql.split())
        insert = _INSERT_RE.search(statement)
        if insert:
            self._insert(insert.group("table"), insert.group("columns"), params)
            return
        update = _UPDATE_RE.match(statement)
        if update:
            for row in self._store.get(update.group("table"), []):
                row["deleted_at"] = "now"
            self._result = []
            return
        select = _SELECT_RE.search(statement)
        if select:
            self._select(select.group("table"), select.group("columns"), params)
            return
        raise AssertionError(f"unexpected statement: {statement}")

    def _insert(self, table: str, columns: str, params: Sequence[Any]) -> None:
        names = [name.strip() for name in columns.split(",") if name.strip()]
        assert len(names) == len(params), (
            f"{table}: {len(names)} columns but {len(params)} bound values"
        )
        row = dict(zip(names, params))
        row["id"] = f"{table}-{len(self._store.setdefault(table, [])) + 1}"
        row["deleted_at"] = None
        self._store[table].append(row)
        self._result = [{"id": row["id"]}]

    def _select(self, table: str, columns: str, params: Sequence[Any]) -> None:
        names = [name.strip() for name in columns.split(",") if name.strip()]
        rows = [row for row in self._store.get(table, []) if row.get("deleted_at") is None]
        if table == "api_workflow_steps":
            rows = [row for row in rows if row.get("workflow_id") == params[0]]
            rows.sort(key=lambda row: row["order_index"])
        else:
            rows.sort(key=lambda row: (row["ordinal"], row["workflow_id"]))
        self._result = [{name: row.get(name) for name in names} for row in rows]

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self._result[0] if self._result else None

    def fetchall(self) -> List[Dict[str, Any]]:
        return list(self._result)


class _FakeConnection:
    """Connection handing out :class:`_FakeCursor`, tracking commit/rollback."""

    def __init__(self, store: Dict[str, List[Dict[str, Any]]]) -> None:
        self._store = store
        self.commits = 0
        self.rollbacks = 0

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self._store)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class _FakeDb:
    """Database handle over one in-memory store, shared across connections."""

    def __init__(self) -> None:
        self.store: Dict[str, List[Dict[str, Any]]] = {}
        self.connection = _FakeConnection(self.store)

    def connect(self) -> _FakeConnection:
        return self.connection


def _persist(model, index: Optional[OperationIndex] = None) -> Tuple[_FakeDb, Any]:
    """Persist ``model``'s workflows into a fake DB; return the handle and the result."""
    db = _FakeDb()
    result = persist_arazzo_workflows(
        db,
        tenant_id=_TENANT,
        project_id=_PROJECT,
        version_id=_VERSION,
        artifact_id=_ARTIFACT,
        model=model,
        index=index,
    )
    return db, result


# --------------------------------------------------------------------------------------------
# AC 1 — each Arazzo workflow becomes one Workflow row plus N WorkflowStep rows
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bundle", ["pet-coupons", "login-and-retrieve-pets", "oauth"]
)
def test_each_workflow_becomes_one_row_with_its_steps(bundle: str) -> None:
    result = build_workflow_rows(_load_bundle(bundle))
    source = _source_workflows(bundle)

    assert len(result.workflows) == len(source)
    for mapped, raw in zip(result.workflows, source):
        assert mapped.workflow_id == raw["workflowId"]
        assert len(mapped.steps) == len(raw["steps"])
        # Steps keep the document's order, not the canonical model's sorted-by-key order.
        assert [step.step_id for step in mapped.steps] == [
            step["stepId"] for step in raw["steps"]
        ]
        assert [step.order_index for step in mapped.steps] == list(
            range(len(raw["steps"]))
        )


def test_workflow_columns_carry_summary_inputs_and_outputs() -> None:
    workflows = {w.workflow_id: w for w in build_workflow_rows(_load_bundle("pet-coupons")).workflows}
    apply_coupon = workflows["apply-coupon"]

    assert apply_coupon.summary == "Apply a coupon to a pet order."
    assert apply_coupon.description.startswith("This is how you can find a pet")
    # `inputs` is a $ref in this bundle and is stored exactly as written.
    assert apply_coupon.inputs == {"$ref": "#/components/inputs/apply_coupon_input"}
    assert apply_coupon.outputs == {
        "apply_coupon_pet_order_id": "$steps.place-order.outputs.my_order_id"
    }


def test_step_payloads_are_stored_verbatim() -> None:
    workflows = {w.workflow_id: w for w in build_workflow_rows(_load_bundle("pet-coupons")).workflows}
    find_pet = workflows["apply-coupon"].steps[0]
    raw = _source_workflows("pet-coupons")[0]["steps"][0]

    assert find_pet.parameters == raw["parameters"]
    assert find_pet.success_criteria == raw["successCriteria"]
    assert find_pet.outputs == raw["outputs"]


def test_step_calling_a_sibling_workflow_is_not_applicable() -> None:
    """`place-order` in pet-coupons targets a workflow, so there is no operation to resolve."""
    workflows = {w.workflow_id: w for w in build_workflow_rows(_load_bundle("pet-coupons")).workflows}
    step = workflows["apply-coupon"].steps[2]

    assert step.step_id == "place-order"
    assert step.resolution_status == STATUS_NOT_APPLICABLE
    assert step.resolution_reason == REASON_CALLS_WORKFLOW
    assert step.extras["workflowId"] == "place-order"


# --------------------------------------------------------------------------------------------
# AC 2 — operationRef resolution, and unresolved refs keep the raw string with a warning
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reference", "expected"),
    [
        ("openapi:cart#/createCart", {"operation_id": "createCart", "document_hint": "cart"}),
        (
            "$sourceDescriptions.petStore.url#/paths/~1pets~1{petId}/get",
            {"http_path": "/pets/{petId}", "http_method": "GET", "document_hint": "petStore"},
        ),
        (
            "./specs/petstore.yaml#/paths/~1pets/post",
            {"http_path": "/pets", "http_method": "POST", "document_hint": "petstore.yaml"},
        ),
        (
            "{$sourceDescriptions.petStoreDescription.url}#/paths/~1pet~1findByStatus",
            {
                "http_path": "/pet/findByStatus",
                "http_method": None,
                "document_hint": "petStoreDescription",
            },
        ),
    ],
)
def test_parse_operation_ref_handles_every_spelling(
    reference: str, expected: Dict[str, Any]
) -> None:
    target = parse_operation_ref(operation_ref=reference)
    for attribute, value in expected.items():
        assert getattr(target, attribute) == value


def test_parse_operation_id_strips_source_description_prefix() -> None:
    target = parse_operation_ref(
        operation_id="$sourceDescriptions.petStoreDescription.loginUser"
    )
    assert target.operation_id == "loginUser"
    assert target.document_hint == "petStoreDescription"


def test_operation_ids_resolve_to_internal_path_operation_ids() -> None:
    """The pet-coupons steps resolve once the petstore operations exist in the scan."""
    index = OperationIndex(
        [
            _operation_row("op-find-tags", pathname="/pet/findByTags", method="GET",
                           operation_id="findPetsByTags"),
            _operation_row("op-find-status", pathname="/pet/findByStatus", method="GET",
                           operation_id="findPetsByStatus"),
            _operation_row("op-coupons", pathname="/pet/{pet_id}/coupons", method="GET",
                           operation_id="getPetCoupons"),
            _operation_row("op-place-order", pathname="/store/order", method="POST",
                           operation_id="placeOrder"),
        ]
    )
    result = resolve_workflow_steps(build_workflow_rows(_load_bundle("pet-coupons")), index)
    by_workflow = {w.workflow_id: w for w in result.workflows}

    assert by_workflow["apply-coupon"].steps[0].resolved_path_operation_id == "op-find-tags"
    assert by_workflow["apply-coupon"].steps[1].resolved_path_operation_id == "op-coupons"
    assert by_workflow["place-order"].steps[0].resolved_path_operation_id == "op-place-order"
    assert all(
        step.resolution_status == STATUS_RESOLVED and step.resolution_reason is None
        for workflow in result.workflows
        for step in workflow.steps
        if step.operation_id
    )
    assert result.resolved_count == 4


def test_route_pointer_resolves_and_route_only_pointer_needs_a_unique_operation() -> None:
    """`operationPath` names a route with no verb: unique → resolved, multiple → ambiguous."""
    model = _load_bundle("login-and-retrieve-pets")

    unique = OperationIndex(
        [
            _operation_row("op-login", pathname="/user/login", method="GET",
                           operation_id="loginUser"),
            _operation_row("op-by-status", pathname="/pet/findByStatus", method="GET"),
        ]
    )
    resolved = resolve_workflow_steps(build_workflow_rows(model), unique)
    assert [step.resolved_path_operation_id for step in resolved.workflows[0].steps] == [
        "op-login",
        "op-by-status",
    ]

    ambiguous = OperationIndex(
        [
            _operation_row("op-login", pathname="/user/login", method="GET",
                           operation_id="loginUser"),
            _operation_row("op-by-status", pathname="/pet/findByStatus", method="GET"),
            _operation_row("op-by-status-post", pathname="/pet/findByStatus", method="POST"),
        ]
    )
    result = resolve_workflow_steps(build_workflow_rows(model), ambiguous)
    get_pet_step = result.workflows[0].steps[1]
    assert get_pet_step.resolution_status == STATUS_UNRESOLVED
    assert get_pet_step.resolution_reason == REASON_AMBIGUOUS
    assert get_pet_step.resolved_path_operation_id is None


def test_source_document_hint_disambiguates_duplicate_operation_ids() -> None:
    """oauth reuses `get-token` across workflows; the source path picks the right spec."""
    index = OperationIndex(
        [
            _operation_row("op-auth-token", pathname="/token", method="POST",
                           operation_id="get-token", source_path="specs/auth.openapi.yaml"),
            _operation_row("op-other-token", pathname="/v2/token", method="POST",
                           operation_id="get-token", source_path="specs/legacy.openapi.yaml"),
        ]
    )
    # Without a hint the two candidates are indistinguishable.
    plain = index.resolve(parse_operation_ref(operation_id="get-token"))
    assert plain == (None, STATUS_UNRESOLVED, REASON_AMBIGUOUS)

    # With one, the matching source file wins.
    hinted = index.resolve(
        parse_operation_ref(operation_ref="./specs/auth.openapi.yaml#/get-token")
    )
    assert hinted == ("op-auth-token", STATUS_RESOLVED, None)


def test_unresolved_reference_keeps_raw_string_and_warns() -> None:
    """AC: an unresolved ref retains the raw string; the import records a warning."""
    result = resolve_workflow_steps(
        build_workflow_rows(_load_bundle("pet-coupons")), OperationIndex()
    )
    step = result.workflows[0].steps[0]

    assert step.operation_id == "findPetsByTags"  # raw string retained
    assert step.resolved_path_operation_id is None
    assert step.resolution_status == STATUS_UNRESOLVED
    assert step.resolution_reason == REASON_UNKNOWN
    assert any(
        "findPetsByTags" in warning and "raw reference was kept" in warning
        for warning in result.warnings
    )
    # Steps that call a sibling workflow are not reported as failures. (`place-order` is both a
    # step id in `apply-coupon` and a workflow id in its own right, so match the pair.)
    assert not any(
        "Step 'place-order' of workflow 'apply-coupon'" in warning
        for warning in result.warnings
    )
    # One warning per step that named a target and missed — no more, no less.
    assert len(result.warnings) == sum(
        1
        for workflow in result.workflows
        for step in workflow.steps
        if step.resolution_status == STATUS_UNRESOLVED
    )


def test_step_without_any_target_is_reported_as_no_target() -> None:
    from app.arazzo_normalizer import ArazzoNormalizer

    model = ArazzoNormalizer().normalize(
        {
            "arazzo": "1.0.1",
            "info": {"title": "Bare", "version": "1.0.0"},
            "workflows": [{"workflowId": "bare", "steps": [{"stepId": "nothing"}]}],
        }
    )
    result = resolve_workflow_steps(build_workflow_rows(model), OperationIndex())
    step = result.workflows[0].steps[0]

    assert step.resolution_status == STATUS_UNRESOLVED
    assert step.resolution_reason == REASON_NO_TARGET
    assert any("nothing" in warning for warning in result.warnings)


def test_missing_index_leaves_every_reference_unresolved_without_raising() -> None:
    db, result = _persist(_load_bundle("oauth"), index=None)

    assert result.resolved_count == 0
    assert db.connection.commits == 1
    assert db.connection.rollbacks == 0
    assert all(
        row["resolution_status"] in {STATUS_UNRESOLVED, STATUS_NOT_APPLICABLE}
        for row in db.store["api_workflow_steps"]
    )


# --------------------------------------------------------------------------------------------
# AC 3 — round-trip against the official Arazzo example bundles
# --------------------------------------------------------------------------------------------


def _as_comparable(workflows: Sequence[WorkflowRow]) -> List[Dict[str, Any]]:
    """Reduce workflow rows to a plain structure suitable for equality assertions."""
    return [
        {
            "workflow_id": workflow.workflow_id,
            "summary": workflow.summary,
            "description": workflow.description,
            "inputs": workflow.inputs,
            "outputs": workflow.outputs,
            "ordinal": workflow.ordinal,
            "extras": workflow.extras,
            "steps": [
                {
                    "step_id": step.step_id,
                    "order_index": step.order_index,
                    "description": step.description,
                    "operation_ref": step.operation_ref,
                    "operation_id": step.operation_id,
                    "resolved_path_operation_id": step.resolved_path_operation_id,
                    "resolution_status": step.resolution_status,
                    "resolution_reason": step.resolution_reason,
                    "parameters": step.parameters,
                    "success_criteria": step.success_criteria,
                    "on_failure": step.on_failure,
                    "outputs": step.outputs,
                    "depends_on": step.depends_on,
                    "extras": step.extras,
                }
                for step in workflow.steps
            ],
        }
        for workflow in workflows
    ]


@pytest.mark.parametrize(
    "bundle", ["pet-coupons", "login-and-retrieve-pets", "oauth"]
)
def test_official_bundle_round_trips_through_persistence(bundle: str) -> None:
    """normalize → map → persist → load reproduces the same workflows and steps."""
    model = _load_bundle(bundle)
    written = build_workflow_rows(model)
    resolve_workflow_steps(written, OperationIndex())

    db, _ = _persist(model)
    reloaded = load_arazzo_workflows(db, tenant_id=_TENANT, version_id=_VERSION)

    assert _as_comparable(reloaded) == _as_comparable(written.workflows)


@pytest.mark.parametrize(
    "bundle", ["pet-coupons", "login-and-retrieve-pets", "oauth"]
)
def test_persisted_row_counts_match_the_source_document(bundle: str) -> None:
    db, result = _persist(_load_bundle(bundle))
    source = _source_workflows(bundle)

    assert len(db.store["api_workflows"]) == len(source)
    assert len(db.store["api_workflow_steps"]) == sum(len(w["steps"]) for w in source)
    assert result.step_count == len(db.store["api_workflow_steps"])


def test_persisted_rows_are_tenant_and_version_scoped() -> None:
    db, _ = _persist(_load_bundle("oauth"))

    for row in db.store["api_workflows"]:
        assert row["tenant_id"] == _TENANT
        assert row["project_id"] == _PROJECT
        assert row["version_id"] == _VERSION
        assert row["artifact_id"] == _ARTIFACT
    for row in db.store["api_workflow_steps"]:
        assert row["tenant_id"] == _TENANT
        assert row["version_id"] == _VERSION
        # Steps hang off a workflow row that was just inserted.
        assert row["workflow_id"].startswith("api_workflows-")


def test_json_columns_are_written_as_json_text() -> None:
    """psycopg needs `json.dumps`ed values for `%s::jsonb`; assert we never bind raw dicts."""
    db, _ = _persist(_load_bundle("pet-coupons"))

    for row in db.store["api_workflows"]:
        for column in ("inputs", "outputs", "extras"):
            assert isinstance(row[column], str)
            json.loads(row[column])
    for row in db.store["api_workflow_steps"]:
        for column in (
            "parameters",
            "success_criteria",
            "on_failure",
            "outputs",
            "depends_on",
            "extras",
        ):
            assert isinstance(row[column], str)
            json.loads(row[column])


def test_reimport_replaces_the_previous_workflows() -> None:
    """A second persist for the same version soft-deletes the first, so reads stay clean."""
    model = _load_bundle("oauth")
    db = _FakeDb()
    for _ in range(2):
        persist_arazzo_workflows(
            db,
            tenant_id=_TENANT,
            project_id=_PROJECT,
            version_id=_VERSION,
            artifact_id=_ARTIFACT,
            model=model,
            index=None,
        )

    live = load_arazzo_workflows(db, tenant_id=_TENANT, version_id=_VERSION)
    assert len(live) == len(_source_workflows("oauth"))
    # Both generations are on disk; only the newest is live.
    assert len(db.store["api_workflows"]) == 2 * len(live)


def test_document_with_no_workflows_writes_nothing() -> None:
    from app.arazzo_normalizer import ArazzoNormalizer

    model = ArazzoNormalizer().normalize(
        {"arazzo": "1.0.1", "info": {"title": "Empty", "version": "1.0.0"}, "workflows": []}
    )
    db, result = _persist(model)

    assert result.workflows == []
    assert db.store == {}
    assert db.connection.commits == 0
