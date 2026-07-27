"""Unit tests for the canonical→catalog persistence hook (MFI-23.7).

:func:`app.import_source_pipeline.persist_adapter_import` is the write that stores a non-OpenAPI
import as a **catalog item**, keeping the *original source verbatim* so it can be converted to
OpenAPI later rather than at import time. These tests drive it against a fake DB and assert the
routed row is non-publishable and the raw bytes land in ``format_metadata.sourceContent``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi
from app.import_routing import ImportRoutingDecision, ImportTarget
from app.import_source_pipeline import _ResolvedIntake, persist_adapter_import


def _text_intake(text: str) -> _ResolvedIntake:
    data = text.encode("utf-8")
    return _ResolvedIntake(raw_bytes=data, text=text, fileset=None, archive_root=None)


class _FakeDb:
    """Records the create/update calls the hook makes, returning plausible rows."""

    def __init__(self) -> None:
        self.created_project: Optional[Dict[str, Any]] = None
        self.created_version: Optional[Dict[str, Any]] = None
        self.source_format_call: Optional[Dict[str, Any]] = None
        self.persisted_canonical: Optional[Dict[str, Any]] = None
        self.created_classes: list = []

    def get_project_by_slug(self, slug: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return None

    def allocate_project_slug(self, tenant_id: str, base_slug: str) -> str:
        return (base_slug or "imported-source").strip().lower() or "imported-source"

    def get_version_by_version_id(self, project_id: str, version_id_str: str, tenant_id: str):
        return None

    def allocate_version_id(self, project_id: str, base_version_id: str) -> str:
        return (base_version_id or "1.0.0").strip() or "1.0.0"

    def create_project(self, tenant_id, creator_id, name, slug, description, metadata, publishable):
        self.created_project = {
            "tenant_id": tenant_id,
            "creator_id": creator_id,
            "name": name,
            "slug": slug,
            "description": description,
            "publishable": publishable,
        }
        return {"id": "proj-1", "slug": slug}

    def create_version(self, project_id, creator_id, version_id, description=None):
        self.created_version = {
            "project_id": project_id,
            "creator_id": creator_id,
            "version_id": version_id,
        }
        return {"id": "ver-1"}

    def set_version_source_format(
        self, version_record_id, tenant_id, source_format=None, protocol=None,
        format_metadata=None, source_tool_versions=None,
    ):
        self.source_format_call = {
            "version_record_id": version_record_id,
            "tenant_id": tenant_id,
            "source_format": source_format,
            "protocol": protocol,
            "format_metadata": format_metadata,
        }
        return True

    def create_class(self, version_id, name, schema, description=None, enabled=True):
        row = {"id": f"class-{len(self.created_classes) + 1}", "name": name, "schema": schema}
        self.created_classes.append(row)
        return row

    def persist_canonical_api(self, *, tenant_id, creator_id, version_id, model):
        self.persisted_canonical = {
            "tenant_id": tenant_id,
            "creator_id": creator_id,
            "version_id": version_id,
            "format": model.format,
            "channel_count": len(model.channels),
            "operation_count": len(model.operations()),
        }
        return "artifact-1"


def _model() -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="Orders"),
    )


def _catalog_routing() -> ImportRoutingDecision:
    return ImportRoutingDecision(
        target=ImportTarget.CATALOG,
        publishable=False,
        schemas_only=False,
        reason="non-OpenAPI format → catalog item",
        source="protobuf",
        paradigm="rpc",
        format="protobuf",
        operation_count=1,
        type_count=2,
        channel_count=0,
    )


def _payload() -> Dict[str, Any]:
    return {
        "tenant_id": "tenant-1",
        "user_id": "user-1",
        "filename": "orders.proto",
        "metadata": {
            "source_kind": "protobuf",
            "project": {"name": "Orders", "slug": "orders"},
            "version": {"version_id": "1.0.0"},
            "options": {"input_kind": "file"},
        },
    }


def test_persists_a_non_publishable_catalog_item_with_raw_source(monkeypatch) -> None:
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)

    result = persist_adapter_import(_payload(), _model(), _text_intake('syntax = "proto3";'), _catalog_routing())

    assert result is not None
    assert (result.project_id, result.version_record_id) == ("proj-1", "ver-1")
    # Routed to the catalog: the project is created non-publishable.
    assert fake.created_project["publishable"] is False
    assert fake.created_project["name"] == "Orders"
    # The original source is stored verbatim, with the detected format/protocol off the model.
    call = fake.source_format_call
    assert call["source_format"] == "protobuf"
    assert call["protocol"] == "rpc"
    assert call["format_metadata"]["sourceContent"] == 'syntax = "proto3";'
    assert call["format_metadata"]["sourceLabel"] == "orders.proto"
    assert call["format_metadata"]["inputKind"] == "file"


def test_records_url_intake_kind_and_source_uri(monkeypatch) -> None:
    """A URL import records inputKind='url' and the URL as the source URI (MFI-26.2)."""
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["filename"] = "https://api.example.com/orders.proto"
    payload["metadata"]["options"] = {"input_kind": "url"}

    result = persist_adapter_import(payload, _model(), _text_intake('syntax = "proto3";'), _catalog_routing())

    assert result is not None
    fmd = fake.source_format_call["format_metadata"]
    # The intake method drives the catalog source-material badge, and the URL is recorded as the
    # retrievable source URI so the detail panel can link/redirect back to it.
    assert fmd["inputKind"] == "url"
    assert fmd["sourceUri"] == "https://api.example.com/orders.proto"


def test_records_paste_intake_kind_without_source_uri(monkeypatch) -> None:
    """A paste import records inputKind='paste' and does not synthesize a source URI (MFI-26.2)."""
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["filename"] = "Pasted source"
    payload["metadata"]["options"] = {"input_kind": "paste"}

    result = persist_adapter_import(payload, _model(), _text_intake('syntax = "proto3";'), _catalog_routing())

    assert result is not None
    fmd = fake.source_format_call["format_metadata"]
    assert fmd["inputKind"] == "paste"
    assert "sourceUri" not in fmd


def test_defaults_input_kind_to_file_when_omitted(monkeypatch) -> None:
    """With no options.input_kind, the recorded intake kind defaults to 'file' (back-compat)."""
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["metadata"]["options"] = {}

    persist_adapter_import(payload, _model(), _text_intake("x"), _catalog_routing())

    assert fake.source_format_call["format_metadata"]["inputKind"] == "file"


def test_returns_none_without_a_tenant(monkeypatch) -> None:
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["tenant_id"] = ""

    result = persist_adapter_import(payload, _model(), _text_intake("x"), _catalog_routing())

    assert result is None
    assert fake.created_project is None


def test_reuses_an_existing_project_when_targeted(monkeypatch) -> None:
    fake = _FakeDb()
    # get_project_by_id is only consulted for the existing-project branch.
    fake.get_project_by_id = lambda pid, tid: {"id": pid, "slug": "orders"}  # type: ignore[attr-defined]
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["metadata"]["existing_project_id"] = "proj-existing"

    result = persist_adapter_import(payload, _model(), _text_intake("x"), _catalog_routing())

    assert result is not None
    assert result.project_id == "proj-existing"
    # No new project is created when attaching to an existing one.
    assert fake.created_project is None
    assert fake.created_version["project_id"] == "proj-existing"


def test_reuses_existing_catalog_item_when_slug_collides(monkeypatch) -> None:
    """A catalog import retry reuses the live catalog item instead of violating slug uniqueness."""
    fake = _FakeDb()
    fake.get_project_by_slug = lambda slug, tenant_id: (
        {"id": "cat-existing", "slug": "orders", "publishable": False}
        if slug == "orders"
        else None
    )
    monkeypatch.setattr("app.database.db", fake)

    result = persist_adapter_import(_payload(), _model(), _text_intake('syntax = "proto3";'), _catalog_routing())

    assert result is not None
    assert result.project_id == "cat-existing"
    assert fake.created_project is None
    assert fake.created_version["project_id"] == "cat-existing"


def test_reuses_existing_catalog_version_when_version_collides(monkeypatch) -> None:
    """A catalog import retry reuses the live revision instead of violating version uniqueness."""
    fake = _FakeDb()
    fake.get_project_by_slug = lambda slug, tenant_id: (
        {"id": "cat-existing", "slug": "orders", "publishable": False}
        if slug == "orders"
        else None
    )
    fake.get_version_by_version_id = lambda project_id, version_id_str, tenant_id: (
        {"id": "ver-existing", "version_id": "1.0.0"}
        if project_id == "cat-existing" and version_id_str == "1.0.0"
        else None
    )
    monkeypatch.setattr("app.database.db", fake)

    result = persist_adapter_import(_payload(), _model(), _text_intake('syntax = "proto3";'), _catalog_routing())

    assert result is not None
    assert result.project_id == "cat-existing"
    assert result.version_record_id == "ver-existing"
    assert result.version_id == "1.0.0"
    assert fake.created_project is None
    assert fake.created_version is None
    assert fake.source_format_call["version_record_id"] == "ver-existing"


def test_allocates_a_unique_slug_when_publishable_slug_is_taken(monkeypatch) -> None:
    fake = _FakeDb()
    fake.allocate_project_slug = lambda tenant_id, base: f"{base}-2"
    fake.allocate_version_id = lambda project_id, base: f"{base}-2"
    monkeypatch.setattr("app.database.db", fake)
    routing = ImportRoutingDecision(
        target=ImportTarget.PROJECT,
        publishable=True,
        schemas_only=False,
        reason="openapi",
        source="openapi",
        paradigm="rest",
        format="openapi-3.1",
        operation_count=1,
        type_count=0,
        channel_count=0,
    )

    result = persist_adapter_import(_payload(), _model(), _text_intake("openapi: 3.1.0"), routing)

    assert result is not None
    assert fake.created_project is not None
    assert fake.created_project["slug"] == "orders-2"
    assert fake.created_version is not None
    assert fake.created_version["version_id"] == "1.0.0-2"


def test_asyncapi_import_promotes_classes_and_persists_canonical(monkeypatch) -> None:
    """REPO-3.3: AsyncAPI catalog import also writes Classes + api_* tree (#2772)."""
    from app.canonical_model import Channel, Message, MessageRole, Operation, OperationKind, Service

    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    model = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="User Events"),
        channels=[
            Channel(
                key="user/signedup",
                address="user/signedup",
                bindings={"kafka": {"partitions": 1}},
            )
        ],
        services=[
            Service(
                key="default",
                name="default",
                operations=[
                    Operation(
                        key="onUserSignedUp",
                        name="onUserSignedUp",
                        kind=OperationKind.SUBSCRIBE,
                        channel_ref="user/signedup",
                        extras={"action": "receive"},
                        messages=[
                            Message(
                                key="onUserSignedUp#event",
                                role=MessageRole.EVENT,
                                name="UserSignedUp",
                                payload_schema={
                                    "type": "object",
                                    "properties": {"userId": {"type": "string"}},
                                },
                            )
                        ],
                    )
                ],
            )
        ],
    )
    routing = ImportRoutingDecision(
        target=ImportTarget.CATALOG,
        publishable=False,
        schemas_only=False,
        reason="asyncapi",
        source="asyncapi",
        paradigm="event",
        format="asyncapi-3",
        operation_count=1,
        type_count=0,
        channel_count=1,
    )
    payload = _payload()
    payload["filename"] = "asyncapi.yaml"
    payload["metadata"]["source_kind"] = "asyncapi"
    payload["metadata"]["project"] = {"name": "User Events", "slug": "user-events"}

    result = persist_adapter_import(
        payload, model, _text_intake("asyncapi: '3.0.0'"), routing
    )

    assert result is not None
    assert fake.source_format_call["source_format"] == "asyncapi-3"
    assert fake.created_classes and fake.created_classes[0]["name"] == "UserSignedUp"
    assert fake.persisted_canonical is not None
    assert fake.persisted_canonical["channel_count"] == 1
    assert fake.persisted_canonical["operation_count"] == 1
    # Class UUID landed on the message extras before relational persist.
    assert model.operations()[0].messages[0].extras["payload_class_id"] == "class-1"


def test_non_asyncapi_skips_canonical_persist(monkeypatch) -> None:
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)

    persist_adapter_import(_payload(), _model(), _text_intake('syntax = "proto3";'), _catalog_routing())

    assert fake.persisted_canonical is None
    assert fake.created_classes == []


# ---------------------------------------------------------------------------
# Git-sourced provenance (MFI-29.3, #4390)
# ---------------------------------------------------------------------------


def _git_source() -> Dict[str, Any]:
    return {
        "provider": "github",
        "repo_url": "https://github.com/acme/specs",
        "owner": "acme",
        "repo": "specs",
        "ref": "main",
        "commit_sha": "9f1c0de5b4a37821cc0d4f3a6a5b0e2d1c8a7b60",
        "path": "protos/**",
        "browse_url": "https://github.com/acme/specs/tree/9f1c0de5b4a37821cc0d4f3a6a5b0e2d1c8a7b60/protos",
    }


def _fileset_intake(members: Dict[str, str], root: str) -> _ResolvedIntake:
    """A resolved fileset intake, as a packed git selection produces."""
    from app.fileset import IntakeFileset
    from app.git_intake import pack_fileset_zip

    return _ResolvedIntake(
        raw_bytes=pack_fileset_zip(members),
        text=None,
        fileset=IntakeFileset.from_members(members, root=root),
        archive_root=root,
    )


def test_git_import_records_repo_ref_and_commit_provenance(monkeypatch) -> None:
    """A git-sourced import is labelled 'git' and carries its commit (MFI-29.3)."""
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["filename"] = "specs-main-9f1c0de.zip"
    payload["metadata"]["options"] = {
        "input_kind": "fileset",
        "archive_root": "user/user_service.proto",
        "git_source": _git_source(),
    }
    intake = _fileset_intake(
        {
            "user/user_service.proto": 'syntax = "proto3";\nservice Users {}\n',
            "common/types.proto": 'syntax = "proto3";\n',
        },
        "user/user_service.proto",
    )

    result = persist_adapter_import(payload, _model(), intake, _catalog_routing())

    assert result is not None
    fmd = fake.source_format_call["format_metadata"]
    # 'git' rather than 'archive': the bytes are a packed selection, not an upload.
    assert fmd["intakeKind"] == "git"
    assert fmd["inputKind"] == "fileset"
    assert fmd["gitRepoUrl"] == "https://github.com/acme/specs"
    assert fmd["gitRef"] == "main"
    assert fmd["gitCommit"] == "9f1c0de5b4a37821cc0d4f3a6a5b0e2d1c8a7b60"
    assert fmd["gitPath"] == "protos/**"
    assert fmd["sourceUri"].endswith("/protos")
    # The fileset bookkeeping the archive path records is preserved.
    assert fmd["filesetRoot"] == "user/user_service.proto"
    assert fmd["filesetMembers"] == ["common/types.proto", "user/user_service.proto"]
    assert fmd["sourceEncoding"] == "base64"


def test_archive_import_without_git_source_stays_an_archive(monkeypatch) -> None:
    """No git_source option leaves the MFI-29.1 archive labelling untouched."""
    fake = _FakeDb()
    monkeypatch.setattr("app.database.db", fake)
    payload = _payload()
    payload["metadata"]["options"] = {"input_kind": "fileset"}
    intake = _fileset_intake({"a.proto": 'syntax = "proto3";\n'}, "a.proto")

    persist_adapter_import(payload, _model(), intake, _catalog_routing())

    fmd = fake.source_format_call["format_metadata"]
    assert fmd["intakeKind"] == "archive"
    assert "gitCommit" not in fmd
