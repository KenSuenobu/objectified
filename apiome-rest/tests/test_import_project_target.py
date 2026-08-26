"""Unit tests for the existing-project import target (BLK-1.1, #5523).

:func:`app.import_project_target.resolve_import_project_target` is the seam that turns a
``project.project_id`` on a start request into an authorized append-a-version target — or into
a typed refusal. These drive it directly against a fake DB so the branch logic is covered
without a database or a scheduled job.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Set, Tuple

import pytest

from app.import_project_target import (
    TARGET_NOT_PUBLISHABLE,
    TARGET_PROJECT_NOT_FOUND,
    TARGET_VERSION_EXISTS,
    ImportProjectTargetError,
    resolve_import_project_target,
)
from app.models import (
    SpecImportOptions,
    SpecImportProjectTarget,
    SpecImportStartMetadata,
    SpecImportVersionTarget,
)

TENANT = "550e8400-e29b-41d4-a716-446655440000"
OTHER_TENANT = "550e8400-e29b-41d4-a716-4466554400ff"
PROJECT = "660e8400-e29b-41d4-a716-446655440001"


class _FakeDb:
    """Minimal stand-in for the two tenant-scoped reads the resolver makes."""

    def __init__(
        self,
        *,
        projects: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
        versions: Optional[Set[Tuple[str, str, str]]] = None,
    ) -> None:
        self.projects = projects or {}
        self.versions = versions or set()
        self.project_lookups: list = []
        self.version_lookups: list = []

    def get_project_by_id(self, project_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        self.project_lookups.append((project_id, tenant_id))
        row = self.projects.get((project_id, tenant_id))
        return dict(row) if row else None

    def get_version_by_version_id(
        self, project_id: str, version_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        self.version_lookups.append((project_id, version_id, tenant_id))
        if (project_id, version_id, tenant_id) in self.versions:
            return {"id": "version-record-1", "version_id": version_id}
        return None


def _publishable_project(**overrides: Any) -> Dict[str, Any]:
    row = {"id": PROJECT, "name": "Payments", "slug": "payments-api", "publishable": True}
    row.update(overrides)
    return row


def _metadata(
    project: SpecImportProjectTarget,
    *,
    version_id: str = "2.0.0",
    options: Optional[SpecImportOptions] = None,
) -> SpecImportStartMetadata:
    return SpecImportStartMetadata(
        source_kind="openapi-3",
        project=project,
        version=SpecImportVersionTarget(version_id=version_id),
        options=options or SpecImportOptions(),
    )


def _install(monkeypatch, fake: _FakeDb) -> None:
    monkeypatch.setattr("app.database.db", fake)


def test_create_a_project_request_is_passed_through_untouched(monkeypatch) -> None:
    """No ``project_id`` is today's behaviour: no lookup, no normalization."""
    fake = _FakeDb()
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(name="Payments", slug="payments-api"))

    resolved = resolve_import_project_target(metadata, tenant_id=TENANT)

    assert resolved is metadata
    assert resolved.existing_project_id is None
    assert fake.project_lookups == []


def test_blank_project_id_is_treated_as_absent(monkeypatch) -> None:
    fake = _FakeDb()
    _install(monkeypatch, fake)
    metadata = _metadata(
        SpecImportProjectTarget(project_id="   ", name="Payments", slug="payments-api")
    )

    resolved = resolve_import_project_target(metadata, tenant_id=TENANT)

    assert resolved is metadata
    assert fake.project_lookups == []


def test_project_id_normalizes_onto_existing_project_id(monkeypatch) -> None:
    """The resolved target becomes the append-a-version instruction the worker paths read."""
    fake = _FakeDb(projects={(PROJECT, TENANT): _publishable_project()})
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id=PROJECT))

    resolved = resolve_import_project_target(metadata, tenant_id=TENANT)

    assert resolved.existing_project_id == PROJECT
    assert resolved.project.project_id == PROJECT
    assert fake.project_lookups == [(PROJECT, TENANT)]
    assert fake.version_lookups == [(PROJECT, "2.0.0", TENANT)]


def test_resolved_target_backfills_the_projects_own_name_and_slug(monkeypatch) -> None:
    """Job results report the project the revision lands in, not the caller's guess."""
    fake = _FakeDb(projects={(PROJECT, TENANT): _publishable_project()})
    _install(monkeypatch, fake)
    metadata = _metadata(
        SpecImportProjectTarget(project_id=PROJECT, name="Wrong Name", slug="wrong-slug")
    )

    resolved = resolve_import_project_target(metadata, tenant_id=TENANT)

    assert resolved.project.name == "Payments"
    assert resolved.project.slug == "payments-api"
    # The caller's metadata is not mutated in place.
    assert metadata.project.slug == "wrong-slug"


def test_unknown_project_id_is_not_found(monkeypatch) -> None:
    fake = _FakeDb()
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id=PROJECT))

    with pytest.raises(ImportProjectTargetError) as excinfo:
        resolve_import_project_target(metadata, tenant_id=TENANT)

    assert excinfo.value.code == TARGET_PROJECT_NOT_FOUND
    assert excinfo.value.status_code == 404


def test_cross_tenant_project_id_is_not_found(monkeypatch) -> None:
    """A project of another tenant is indistinguishable from a missing one (404, never 403)."""
    fake = _FakeDb(projects={(PROJECT, OTHER_TENANT): _publishable_project()})
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id=PROJECT))

    with pytest.raises(ImportProjectTargetError) as excinfo:
        resolve_import_project_target(metadata, tenant_id=TENANT)

    assert excinfo.value.code == TARGET_PROJECT_NOT_FOUND
    assert excinfo.value.status_code == 404
    # The lookup is tenant-scoped, so the foreign row is never even read.
    assert fake.project_lookups == [(PROJECT, TENANT)]


def test_malformed_project_id_is_not_found_without_touching_the_database(monkeypatch) -> None:
    """A non-UUID id would make the driver raise; it answers 'no such project' instead."""
    fake = _FakeDb()
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id="not-a-uuid"))

    with pytest.raises(ImportProjectTargetError) as excinfo:
        resolve_import_project_target(metadata, tenant_id=TENANT)

    assert excinfo.value.code == TARGET_PROJECT_NOT_FOUND
    assert fake.project_lookups == []


def test_non_publishable_catalog_item_is_refused_naming_the_convert_flow(monkeypatch) -> None:
    fake = _FakeDb(projects={(PROJECT, TENANT): _publishable_project(publishable=False)})
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id=PROJECT))

    with pytest.raises(ImportProjectTargetError) as excinfo:
        resolve_import_project_target(metadata, tenant_id=TENANT)

    error = excinfo.value
    assert error.code == TARGET_NOT_PUBLISHABLE
    assert error.status_code == 409
    assert "Convert" in error.message or "convert" in error.message
    assert "Convert to OpenAPI" in error.as_detail()["remediation"]
    # Refused before the version line is even considered.
    assert fake.version_lookups == []


def test_existing_version_on_the_target_is_refused(monkeypatch) -> None:
    fake = _FakeDb(
        projects={(PROJECT, TENANT): _publishable_project()},
        versions={(PROJECT, "2.0.0", TENANT)},
    )
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id=PROJECT), version_id="2.0.0")

    with pytest.raises(ImportProjectTargetError) as excinfo:
        resolve_import_project_target(metadata, tenant_id=TENANT)

    assert excinfo.value.code == TARGET_VERSION_EXISTS
    assert excinfo.value.status_code == 409
    assert "2.0.0" in excinfo.value.message


def test_unused_version_on_the_target_is_accepted(monkeypatch) -> None:
    fake = _FakeDb(
        projects={(PROJECT, TENANT): _publishable_project()},
        versions={(PROJECT, "1.0.0", TENANT)},
    )
    _install(monkeypatch, fake)
    metadata = _metadata(SpecImportProjectTarget(project_id=PROJECT), version_id="2.0.0")

    resolved = resolve_import_project_target(metadata, tenant_id=TENANT)

    assert resolved.existing_project_id == PROJECT


def test_skip_duplicate_versions_tolerates_the_collision(monkeypatch) -> None:
    """That option's documented contract is 'a repeat import is an idempotent no-op'."""
    fake = _FakeDb(
        projects={(PROJECT, TENANT): _publishable_project()},
        versions={(PROJECT, "2.0.0", TENANT)},
    )
    _install(monkeypatch, fake)
    metadata = _metadata(
        SpecImportProjectTarget(project_id=PROJECT),
        options=SpecImportOptions(skip_duplicate_versions=True),
    )

    resolved = resolve_import_project_target(metadata, tenant_id=TENANT)

    assert resolved.existing_project_id == PROJECT
    assert fake.version_lookups == []


def test_typed_detail_carries_the_taxonomy_metadata() -> None:
    error = ImportProjectTargetError(
        code=TARGET_VERSION_EXISTS, message="already there", status_code=409
    )
    detail = error.as_detail()

    assert detail["code"] == TARGET_VERSION_EXISTS
    assert detail["category"] == "input"
    assert detail["message"] == "already there"
    assert detail["remediation"]
    assert detail["retriable"] is False

    http_error = error.as_http_exception()
    assert http_error.status_code == 409
    assert http_error.detail == detail


def test_conflicting_project_ids_are_rejected_by_the_contract() -> None:
    """``project.project_id`` and ``existing_project_id`` may not name different projects."""
    with pytest.raises(ValueError):
        SpecImportStartMetadata(
            source_kind="openapi-3",
            project=SpecImportProjectTarget(project_id=PROJECT),
            version=SpecImportVersionTarget(version_id="2.0.0"),
            existing_project_id=OTHER_TENANT,
        )


def test_matching_project_ids_are_accepted() -> None:
    metadata = SpecImportStartMetadata(
        source_kind="openapi-3",
        project=SpecImportProjectTarget(project_id=PROJECT),
        version=SpecImportVersionTarget(version_id="2.0.0"),
        existing_project_id=PROJECT,
    )
    assert metadata.existing_project_id == PROJECT


def test_project_target_still_requires_name_and_slug_without_an_id() -> None:
    with pytest.raises(ValueError):
        SpecImportProjectTarget(name="Payments")
    with pytest.raises(ValueError):
        SpecImportProjectTarget(slug="payments-api")
