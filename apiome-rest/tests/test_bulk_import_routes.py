"""REST contract for bulk import of independent specs — MFI-29.5 (#4392).

Drives ``POST /v1/tenants/{tenant}/import/bulk{,/plan,/status}`` with the two
boundaries stubbed: job scheduling (so no worker runs) and the repository client (so
no network is touched). What is under test is the batch contract — the partition, the
per-item payloads, and above all that one bad item never costs the user the rest.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional, Tuple

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


class FakeCatalog:
    """The tenant's existing projects, for the BLK-1.2 reconciliation reads.

    The plan endpoint asks the database four questions before it can say whether an item is a
    new version of something that already exists. This stands in for all four, so a route test
    can seed "this project was imported from that repository path" without a database. It also
    counts writes: every mutating method of the real handle raises here, which is how
    :func:`test_plan_writes_nothing_while_reconciling` proves the endpoint stays read-only.

    Attributes:
        projects: Seeded project rows, keyed by id.
        provenance: ``git_path -> (project_id, repo_url)`` for repository-provenance matches.
        labels: ``project_id -> [version label]`` for the proposed-version derivation.
        tenant_policy: The stored tenant default, or ``None``.
        repository_policy: The stored per-repository override, or ``None``.
    """

    def __init__(self) -> None:
        self.projects: Dict[str, Dict[str, Any]] = {}
        self.provenance: Dict[str, Tuple[str, str]] = {}
        self.labels: Dict[str, List[str]] = {}
        self.tenant_policy: Optional[str] = None
        self.repository_policy: Optional[str] = None

    def add_project(
        self,
        project_id: str,
        *,
        name: str,
        slug: str,
        versions: Optional[List[str]] = None,
        git_path: Optional[str] = None,
        repo_url: str = _REPO_URL,
        publishable: bool = True,
    ) -> None:
        """Seed one existing project, optionally with the repository path it came from."""
        self.projects[project_id] = {
            "id": project_id,
            "name": name,
            "slug": slug,
            "publishable": publishable,
        }
        self.labels[project_id] = list(versions or [])
        if git_path is not None:
            self.provenance[git_path] = (project_id, repo_url)

    # --- the reads the reconciler makes -------------------------------------------------

    def find_projects_by_git_path(self, tenant_id: str, git_path: str) -> List[Dict[str, Any]]:
        entry = self.provenance.get(git_path)
        if not entry:
            return []
        project_id, repo_url = entry
        return [{**self.projects[project_id], "git_repo_url": repo_url}]

    def get_project_by_slug(self, slug: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return next(
            (dict(row) for row in self.projects.values() if row["slug"] == slug), None
        )

    def find_project_by_name(self, tenant_id: str, name: str) -> Optional[Dict[str, Any]]:
        folded = name.casefold()
        return next(
            (dict(row) for row in self.projects.values() if row["name"].casefold() == folded),
            None,
        )

    def list_project_version_labels(self, project_id: str, tenant_id: str) -> List[str]:
        return list(self.labels.get(project_id, []))

    def get_tenant_bulk_import_version_policy(self, tenant_id: str) -> Optional[str]:
        return self.tenant_policy

    def get_tenant_repository(
        self, tenant_id: str, repository_id: str
    ) -> Optional[Dict[str, Any]]:
        return {"id": repository_id, "bulk_import_version_policy": self.repository_policy}


#: Every ``db`` method a bulk plan must never call. Named rather than pattern-matched so the
#: guard cannot quietly stop covering a write when the DAO grows one.
_FORBIDDEN_PLAN_WRITES = (
    "create_project",
    "create_version",
    "allocate_project_slug",
    "allocate_version_id",
    "execute_update",
)


@pytest.fixture(autouse=True)
def catalog(monkeypatch) -> FakeCatalog:
    """Default: an empty tenant, so every item is new unless a test seeds otherwise."""
    fake = FakeCatalog()
    module = __import__("app.database", fromlist=["db"])
    for name in (
        "find_projects_by_git_path",
        "get_project_by_slug",
        "find_project_by_name",
        "list_project_version_labels",
        "get_tenant_bulk_import_version_policy",
        "get_tenant_repository",
    ):
        monkeypatch.setattr(module.db, name, getattr(fake, name))

    def _refuse_write(name: str):
        def _raise(*args: Any, **kwargs: Any):
            raise AssertionError(f"the plan endpoint wrote: db.{name}()")

        return _raise

    for name in _FORBIDDEN_PLAN_WRITES:
        monkeypatch.setattr(module.db, name, _refuse_write(name), raising=False)
    return fake


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
        "by_resolution": {"create-project": 4},
        "matched": 0,
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


# ------------------------------------------------------------ plan: reconciliation (BLK-1.2)

_ORDERS_PROJECT = "770e8400-e29b-41d4-a716-446655440010"

#: The mixed repository with ``openapi/orders.yaml`` moved one directory down — the same
#: document at a path no earlier import recorded, which is what makes provenance miss.
_MOVED_MEMBERS = {
    **{key: value for key, value in _MIXED_MEMBERS.items() if key != "openapi/orders.yaml"},
    "openapi/v2/orders.yaml": _OPENAPI,
}


def _plan_repository(monkeypatch, members=None, **selector: Any) -> Dict[str, Any]:
    """Plan a repository selection against the in-memory repository client."""
    _use_repository(monkeypatch, members or _MIXED_MEMBERS)
    response = client.post(
        _PLAN, json={"git": {"repo_url": _REPO_URL, "ref": "main", **selector}}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _item(body: Dict[str, Any], key: str) -> Dict[str, Any]:
    return next(item for item in body["items"] if item["key"] == key)


def test_plan_resolves_a_re_imported_repository_folder_to_append_version(
    monkeypatch, catalog
) -> None:
    """The whole point: a folder imported once must not look like a first-time import."""
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=["1.0.0"],
        git_path="openapi/orders.yaml",
    )

    item = _item(_plan_repository(monkeypatch), "openapi/orders.yaml")

    assert item["resolution"] == "append-version"
    assert item["matched_project"] == {
        "project_id": _ORDERS_PROJECT,
        "name": "Orders API",
        "slug": "orders-api",
    }
    assert item["match_basis"] == "repository-provenance"
    assert item["match_confidence"] == 1.0
    assert "openapi/orders.yaml" in item["match_detail"]
    assert item["proposed_version"] == {
        "version_id": "1.1.0",
        "derived_from": "version-bump",
        "previous_version_id": "1.0.0",
    }


def test_a_genuinely_new_spec_in_the_same_plan_still_creates_a_project(
    monkeypatch, catalog
) -> None:
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=["1.0.0"],
        git_path="openapi/orders.yaml",
    )

    body = _plan_repository(monkeypatch)
    fresh = _item(body, "events/shipping.asyncapi.yaml")

    assert fresh["resolution"] == "create-project"
    assert fresh["matched_project"] is None
    assert fresh["match_basis"] is None
    assert fresh["match_confidence"] is None
    assert fresh["proposed_version"] == {
        "version_id": "1.0.0",
        "derived_from": "default",
        "previous_version_id": None,
    }
    assert body["summary"]["by_resolution"] == {"append-version": 1, "create-project": 3}
    assert body["summary"]["matched"] == 1


def test_a_moved_file_still_matches_its_project_through_spec_identity(
    monkeypatch, catalog
) -> None:
    """Its path no longer resolves and its slug was suffixed — the title still identifies it."""
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api-2",
        versions=["1.0.0", "1.3.0"],
        git_path="openapi/orders.yaml",
    )

    item = _item(_plan_repository(monkeypatch, _MOVED_MEMBERS), "openapi/v2/orders.yaml")

    assert item["resolution"] == "append-version"
    assert item["match_basis"] == "spec-identity"
    assert item["matched_project"]["project_id"] == _ORDERS_PROJECT
    assert item["match_confidence"] < 1.0
    assert item["proposed_version"]["version_id"] == "1.4.0"


def test_an_archive_upload_matches_on_slug_since_it_has_no_repository(catalog) -> None:
    catalog.add_project(
        _ORDERS_PROJECT, name="Something Else", slug="orders-api", versions=["2.0.0"]
    )

    body = client.post(_PLAN, json={"document_base64": _archive()}).json()
    item = _item(body, "openapi/orders.yaml")

    assert item["match_basis"] == "slug"
    assert item["resolution"] == "append-version"
    assert item["proposed_version"]["version_id"] == "2.1.0"


def test_the_default_policy_is_append_when_matched_and_says_so(catalog) -> None:
    body = client.post(_PLAN, json={"document_base64": _archive()}).json()

    assert body["version_policy"] == "append-when-matched"
    assert body["version_policy_source"] == "default"


def test_always_create_reports_the_matches_it_is_ignoring(monkeypatch, catalog) -> None:
    """A plan that hid the match would be asserting the tenant is empty."""
    catalog.tenant_policy = "always-create"
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=["1.0.0"],
        git_path="openapi/orders.yaml",
    )

    body = _plan_repository(monkeypatch)
    item = _item(body, "openapi/orders.yaml")

    assert body["version_policy"] == "always-create"
    assert body["version_policy_source"] == "tenant"
    assert item["resolution"] == "create-project"
    assert item["matched_project"]["project_id"] == _ORDERS_PROJECT
    assert item["match_basis"] == "repository-provenance"
    # It creates, so it reports the version creating would take — not the append it declined.
    assert item["proposed_version"] == {
        "version_id": "1.0.0",
        "derived_from": "default",
        "previous_version_id": None,
    }
    assert body["summary"]["by_resolution"] == {"create-project": 4}
    assert body["summary"]["matched"] == 1


def test_always_ask_marks_every_item_unresolved(monkeypatch, catalog) -> None:
    catalog.tenant_policy = "always-ask"
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=["1.0.0"],
        git_path="openapi/orders.yaml",
    )

    body = _plan_repository(monkeypatch)

    assert body["version_policy"] == "always-ask"
    assert {item["resolution"] for item in body["items"]} == {"unresolved"}
    assert body["summary"]["by_resolution"] == {"unresolved": 4}
    # Unresolved is a question, not silence: the match and what appending would mean are both
    # still on the row, because that is what the user is being asked to confirm.
    matched = _item(body, "openapi/orders.yaml")
    assert matched["matched_project"]["project_id"] == _ORDERS_PROJECT
    assert matched["proposed_version"]["version_id"] == "1.1.0"


def test_a_registered_repository_overrides_the_tenant_default(monkeypatch, catalog) -> None:
    catalog.tenant_policy = "always-ask"
    catalog.repository_policy = "always-create"

    body = _plan_repository(monkeypatch, repository_id="880e8400-e29b-41d4-a716-446655440020")

    assert body["version_policy"] == "always-create"
    assert body["version_policy_source"] == "repository"


def test_by_resolution_counts_reconcile_with_the_per_item_rows(monkeypatch, catalog) -> None:
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=["1.0.0"],
        git_path="openapi/orders.yaml",
    )
    catalog.add_project(
        "770e8400-e29b-41d4-a716-446655440011", name="orders", slug="orders", versions=[]
    )

    body = _plan_repository(monkeypatch)
    summary = body["summary"]

    counted: Dict[str, int] = {}
    for item in body["items"]:
        counted[item["resolution"]] = counted.get(item["resolution"], 0) + 1
    assert summary["by_resolution"] == counted
    assert sum(summary["by_resolution"].values()) == summary["items"] == len(body["items"])
    assert summary["matched"] == sum(1 for item in body["items"] if item["matched_project"])


def test_a_matched_project_with_no_revisions_proposes_the_default_version(
    monkeypatch, catalog
) -> None:
    """An empty project is a match, and its first version is the batch default — not a bump."""
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=[],
        git_path="openapi/orders.yaml",
    )

    item = _item(_plan_repository(monkeypatch), "openapi/orders.yaml")

    assert item["resolution"] == "append-version"
    assert item["proposed_version"]["derived_from"] == "default"
    assert item["proposed_version"]["version_id"] == "1.0.0"


def test_plan_writes_nothing_while_reconciling(monkeypatch, catalog) -> None:
    """The read-only guarantee predates BLK-1.2 and reconciliation must not have cost it.

    The ``catalog`` fixture replaces every write on the ``db`` handle with a raise, so this
    passing means the endpoint took none of them.
    """
    catalog.add_project(
        _ORDERS_PROJECT,
        name="Orders API",
        slug="orders-api",
        versions=["1.0.0"],
        git_path="openapi/orders.yaml",
    )
    _use_repository(monkeypatch, _MIXED_MEMBERS)

    response = client.post(
        _PLAN, json={"git": {"repo_url": _REPO_URL, "ref": "main"}, "include_documents": True}
    )

    assert response.status_code == 200, response.text
    assert response.json()["summary"]["matched"] == 1


def test_every_unchanged_item_of_a_re_imported_folder_appends(monkeypatch, catalog) -> None:
    """Not just the one the test picked: a tracked folder re-plans as all-appends."""
    for index, (key, name, slug) in enumerate(
        [
            ("events/orders.asyncapi.yaml", "Orders Events", "orders-events"),
            ("events/shipping.asyncapi.yaml", "Shipping Events", "shipping-events"),
            ("openapi/orders.yaml", "Orders API", "orders-api"),
            ("protos/orders/orders.proto", "orders", "orders"),
        ]
    ):
        catalog.add_project(
            f"770e8400-e29b-41d4-a716-4466554400{index:02d}",
            name=name,
            slug=slug,
            versions=["1.0.0"],
            git_path=key,
        )

    body = _plan_repository(monkeypatch)

    assert body["summary"]["by_resolution"] == {"append-version": 4}
    assert {item["match_basis"] for item in body["items"]} == {"repository-provenance"}
    assert {item["proposed_version"]["version_id"] for item in body["items"]} == {"1.1.0"}


def test_an_unimportable_item_is_reconciled_like_any_other(catalog) -> None:
    """Its resolution is still reported, so by_resolution and the rows cannot disagree.

    A sniffer-only format is the one shape that reaches the plan as an *item* nothing can
    import, and it is not producible from an archive fixture, so the group is built directly.
    """
    catalog.add_project(
        _ORDERS_PROJECT, name="Future Spec", slug="future-spec", versions=["1.0.0"]
    )
    group = BulkGroup(
        key="future/spec.yaml",
        root_path="future/spec.yaml",
        members={"future/spec.yaml": "info:\n  title: Future Spec\n"},
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

    resolutions = bulk_import_routes._reconcile_groups(
        [group],
        tenant_id=TENANT_ID,
        policy=bulk_import_routes.VersionPolicy.APPEND_WHEN_MATCHED,
        git_result=None,
    )
    row = bulk_import_routes._plan_item(group, resolutions[0], include_document=False)

    assert row.importable is False
    assert row.resolution == "append-version"
    assert row.matched_project is not None
    assert bulk_import_routes._plan_summary([row], 0).by_resolution == {"append-version": 1}


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
