"""Tests for the export preview manifest — IXH-4.1 (#5109).

Pins the ticket's acceptance criteria on the REST side:

* **every entity, with provenance + fidelity** — the manifest lists every canonical
  entity (services → operations, channels, types → fields) with its stable canonical
  key and a status/reason from the shared CPDO-1.3 taxonomy;
* **drop reasons** — an entity the artifact does not carry states its reason, and a
  non-preserved status never rides without one;
* **artifact-derived locations** — every claimed line resolves inside the emitted
  file's download-serialized text and points at the entity's declaration, across the
  five MVP target families (OpenAPI, proto3, GraphQL SDL, AsyncAPI 3, Avro);
* **determinism** — identical (source, target, options) yield an identical
  ``manifest_hash``; a different option set is a different snapshot;
* **bounded output** — entities page deterministically with the shared cursor codec,
  truncation is declared, and a malformed cursor is rejected;
* **read-only orchestration** — the run caches full manifests per (tenant, revision,
  target, options) so paging re-emits nothing;
* **route wiring** — auth required, loader errors map to 404/422, unknown target to
  400, malformed cursor to 400.

The JSON pointer→line walker is additionally property-tested against the real
serializer: for every pointer it records, the recorded line's text must contain the
pointed key.
"""

from __future__ import annotations

from typing import Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    EnumValue,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import get_emitter, load_builtin_emitters
from app.export_job_engine import serialize_file_content
from app.export_preview_manifest import (
    DEFAULT_ENTITY_PAGE_SIZE,
    MAX_ENTITY_PAGE_SIZE,
    ExportPreviewManifestRequest,
    _index_json_lines,
    build_export_preview_manifest,
    clear_export_manifest_cache,
    export_manifest_cache_size,
    paginate_export_preview_manifest,
    run_export_preview_manifest,
)
from app.export_projection import decode_page_cursor, encode_page_cursor
from app.export_service import emit_canonical, resolve_emit_format
from app.export_source import ExportSource, ExportSourceError
from app.main import app
from app.projection_taxonomy import ProjectionReason, ProjectionStatus

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}

#: Statuses that require a reason (the shared taxonomy's contract).
_REASON_REQUIRED = {
    ProjectionStatus.DROPPED,
    ProjectionStatus.UNAVAILABLE,
    ProjectionStatus.APPROXIMATED,
    ProjectionStatus.SYNTHESIZED,
}

#: The five MVP target families the artifact locators cover.
_MVP_TARGETS = ["openapi-3.1", "proto3", "graphql", "asyncapi-3", "avro"]


def _override_auth():
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _fresh_state() -> None:
    """Registered emitters + an empty manifest cache for every test."""
    load_builtin_emitters()
    clear_export_manifest_cache()


def _rich_api() -> CanonicalApi:
    """A REST source exercising service, operation, channel, record, union, enum."""
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
    )
    service = Service(key="Users", name="Users", operations=[get_user])
    channel = Channel(key="user/signedup", address="user/signedup", protocol="kafka")
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="User.id", name="id", type=TypeRef(name="string", nullable=False)),
            CanonicalField(
                key="User.age",
                name="age",
                type=TypeRef(name="integer", nullable=True),
                constraints=Constraints(minimum=0, maximum=120),
            ),
        ],
    )
    org = Type(
        key="Org",
        name="Org",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="Org.id", name="id", type=TypeRef(name="string", nullable=False)),
        ],
    )
    contact = Type(key="Contact", name="Contact", kind=TypeKind.UNION, union_members=["User", "Org"])
    status = Type(
        key="Status",
        name="Status",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Status.ACTIVE", name="ACTIVE"),
            EnumValue(key="Status.CLOSED", name="CLOSED"),
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Demo", namespace="acme"),
        services=[service],
        channels=[channel],
        types=[user, org, contact, status],
    )


def _avro_api() -> CanonicalApi:
    """A records-only source the Avro emitter can validate (no cross-file unions)."""
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="User.id", name="id", type=TypeRef(name="string", nullable=False)),
            CanonicalField(
                key="User.age",
                name="age",
                type=TypeRef(name="integer", nullable=True),
                constraints=Constraints(minimum=0, maximum=120),
            ),
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="AvroDemo", namespace="acme"),
        types=[user],
    )


def _api_for(target: str) -> CanonicalApi:
    """The richest source each target family can actually emit."""
    return _avro_api() if target == "avro" else _rich_api()


def _build(api: CanonicalApi, target: str, options: Optional[dict] = None):
    """Emit ``api`` to ``target`` read-only and build the full manifest."""
    fmt = resolve_emit_format(target)
    emitter_cls = get_emitter(fmt)
    emit = emit_canonical(api, fmt, opts=options, persistence=None)
    return build_export_preview_manifest(api, emitter_cls, emit, options=options)


def _source(api: Optional[CanonicalApi] = None) -> ExportSource:
    """A loaded export source at a fixed revision."""
    return ExportSource(
        api=api or _rich_api(),
        artifact_id="artifact-1",
        version_record_id="rev-uuid-1",
        version_label="1.0.0",
    )


# ---------------------------------------------------------------------------
# JSON pointer→line walker: property test against the real serializer
# ---------------------------------------------------------------------------
def test_json_line_index_matches_serializer_layout():
    """Every recorded pointer's line contains its key in the actually serialized text."""
    doc = {
        "a": {"b": [1, {"c": "x"}, []], "empty": {}, "we/ird~key": True},
        "list": [{"name": "first"}, {"name": "second"}],
        "scalar": "value",
    }
    text = serialize_file_content(doc)
    lines = text.splitlines()
    index = _index_json_lines(doc)

    assert index.lines[""] == 1
    for pointer, line in index.lines.items():
        if not pointer:
            continue
        assert 1 <= line <= len(lines)
        last = pointer.rsplit("/", 1)[-1]
        if last.isdigit():
            continue  # a list element's line has no key text to assert on
        key = last.replace("~1", "/").replace("~0", "~")
        assert f'"{key}"' in lines[line - 1], (
            f"pointer {pointer!r} claims line {line} but that line is {lines[line - 1]!r}"
        )
    # String scalars are recorded for name-keyed searches.
    assert index.scalars["/list/0/name"] == "first"
    assert index.scalars["/scalar"] == "value"


# ---------------------------------------------------------------------------
# Every entity, with provenance + fidelity (AC 1) and drop reasons (AC 4)
# ---------------------------------------------------------------------------
def test_manifest_lists_every_canonical_entity():
    """Rows cover services, operations, channels, types, and fields, keyed canonically."""
    api = _rich_api()
    full = _build(api, "openapi-3.1")

    expected_keys = {"Users", "GET /users/{id}", "user/signedup", "User", "User.id",
                     "User.age", "Org", "Org.id", "Contact", "Status"}
    assert {e.key for e in full.entities} == expected_keys
    assert full.total_entities == len(full.entities)

    by_key = {e.key: e for e in full.entities}
    assert by_key["Users"].entity_kind == "service"
    assert by_key["GET /users/{id}"].parent_key == "Users"
    assert by_key["User.id"].parent_key == "User"
    assert by_key["user/signedup"].entity_kind == "channel"
    # Declaration order is stable and the order field matches the list position.
    assert [e.order for e in full.entities] == list(range(full.total_entities))


def test_every_non_preserved_status_carries_a_reason():
    """AC: a dropped/approximated/synthesized/unavailable entity always states why."""
    for target in _MVP_TARGETS:
        full = _build(_api_for(target), target)
        for entity in full.entities:
            if entity.status in _REASON_REQUIRED:
                assert entity.reason is not None, (
                    f"{target}: {entity.key} has status {entity.status} without a reason"
                )


def test_dropped_entities_are_listed_with_drop_reason():
    """proto3 cannot carry a Kafka channel: it must appear, dropped, with its reason."""
    api = _rich_api()
    full = _build(api, "proto3")
    channel = next(e for e in full.entities if e.key == "user/signedup")
    assert channel.status is ProjectionStatus.DROPPED
    assert channel.reason is ProjectionReason.DESTINATION_UNSUPPORTED
    assert channel.emitted is False
    assert channel.location is None
    assert full.dropped_entities >= 1
    assert full.status_counts[ProjectionStatus.DROPPED.value] >= 1


def test_unreported_constructs_default_to_retained_and_say_so():
    """A construct the report is silent about is retained with ``reported`` false."""
    api = _rich_api()
    full = _build(api, "openapi-3.1")
    field = next(e for e in full.entities if e.key == "User.id")
    assert field.reported is False
    assert field.status is ProjectionStatus.RETAINED
    assert field.reason is None
    # An explicitly reported construct keeps the flag true.
    operation = next(e for e in full.entities if e.key == "GET /users/{id}")
    assert operation.reported is True


def test_service_status_aggregates_operations():
    """A service row aggregates the worst of its operations and is marked aggregated."""
    api = _rich_api()
    full = _build(api, "graphql")
    service = next(e for e in full.entities if e.key == "Users")
    operation = next(e for e in full.entities if e.key == "GET /users/{id}")
    assert service.aggregated is True
    assert service.status is operation.status


# ---------------------------------------------------------------------------
# Artifact-derived locations (AC 1: "location in the bundle")
# ---------------------------------------------------------------------------
def _serialized_texts(api: CanonicalApi, target: str) -> dict:
    fmt = resolve_emit_format(target)
    emit = emit_canonical(api, fmt, opts=None, persistence=None)
    return {f.path: serialize_file_content(f.content) for f in emit.files}


def _token(name: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]", "", name.casefold())


@pytest.mark.parametrize("target", _MVP_TARGETS)
def test_locations_resolve_in_the_emitted_text(target: str):
    """Every claimed location names a real file and a line containing the entity's name."""
    api = _api_for(target)
    full = _build(api, target)
    texts = _serialized_texts(api, target)
    file_paths = {f.path for f in full.files}

    located = 0
    for entity in full.entities:
        if entity.location is None:
            continue
        located += 1
        assert entity.location.file in file_paths
        assert entity.location.file in texts
        text = texts[entity.location.file]
        lines = text.splitlines()
        if entity.location.line is not None:
            assert 1 <= entity.location.line <= len(lines), (
                f"{target}: {entity.key} claims line {entity.location.line} of "
                f"{entity.location.file} which has {len(lines)} lines"
            )
            line_text = lines[entity.location.line - 1]
            if entity.location.pointer is not None:
                # JSON target: the claimed line must carry the pointed key (or be the
                # document root), and the pointer must resolve in the parsed document.
                last = entity.location.pointer.rsplit("/", 1)[-1]
                key = last.replace("~1", "/").replace("~0", "~")
                assert not key or key.isdigit() or f'"{key}"' in line_text, (
                    f"{target}: {entity.key} claims {entity.location.file}:"
                    f"{entity.location.line} for pointer {entity.location.pointer!r} "
                    f"but that line is {line_text!r}"
                )
                value = __import__("json").loads(text)
                for raw in entity.location.pointer.split("/")[1:]:
                    token = raw.replace("~1", "/").replace("~0", "~")
                    value = value[int(token)] if isinstance(value, list) else value[token]
            elif text.lstrip().startswith("{"):
                # JSON target located without a derivable pointer (e.g. an Avro record
                # whose declaration is the document root): the range check above holds.
                pass
            else:
                # Text target (proto3 / GraphQL SDL): the declaration line must name
                # the entity.
                assert _token(entity.name) in _token(line_text), (
                    f"{target}: {entity.key} claims {entity.location.file}:"
                    f"{entity.location.line} but that line is {line_text!r}"
                )
    # Each MVP family must actually locate something for this source (not vacuous).
    assert located > 0, f"{target}: no entity located at all"


def test_openapi_pointer_locations_resolve_in_the_document():
    """OpenAPI locations carry a JSON Pointer that resolves in the emitted document."""
    api = _rich_api()
    fmt = resolve_emit_format("openapi-3.1")
    emit = emit_canonical(api, fmt, opts=None, persistence=None)
    full = build_export_preview_manifest(api, get_emitter(fmt), emit, options=None)
    document = emit.files[0].content

    def resolve(pointer: str):
        value = document
        for raw in pointer.split("/")[1:]:
            token = raw.replace("~1", "/").replace("~0", "~")
            value = value[int(token)] if isinstance(value, list) else value[token]
        return value

    pointered = [e for e in full.entities if e.location is not None and e.location.pointer]
    assert pointered, "openapi produced no pointered locations"
    for entity in pointered:
        resolve(entity.location.pointer)  # KeyError/IndexError = failure


def test_file_table_describes_the_bundle():
    """The file table lists every emitted file with line and located-entity counts."""
    api = _rich_api()
    full = _build(api, "openapi-3.1")
    texts = _serialized_texts(api, "openapi-3.1")
    assert {f.path for f in full.files} == set(texts)
    for file in full.files:
        assert file.line_count == len(texts[file.path].splitlines())
    located_total = sum(1 for e in full.entities if e.location is not None)
    assert sum(f.entity_count for f in full.files) == located_total


# ---------------------------------------------------------------------------
# Determinism (AC 3)
# ---------------------------------------------------------------------------
def test_manifest_hash_is_deterministic():
    api = _rich_api()
    first = _build(api, "proto3")
    second = _build(api, "proto3")
    assert first.manifest_hash == second.manifest_hash
    assert [e.model_dump() for e in first.entities] == [e.model_dump() for e in second.entities]


def test_different_options_are_a_different_snapshot():
    api = _rich_api()
    default = _build(api, "proto3")
    overridden = _build(api, "proto3", options={"package": "custom.pkg"})
    assert default.manifest_hash != overridden.manifest_hash


def test_different_target_is_a_different_snapshot():
    api = _rich_api()
    assert _build(api, "openapi-3.1").manifest_hash != _build(api, "asyncapi-3").manifest_hash


# ---------------------------------------------------------------------------
# Pagination (bounded output)
# ---------------------------------------------------------------------------
def test_pagination_covers_every_entity_exactly_once():
    api = _rich_api()
    full = _build(api, "openapi-3.1")

    seen = []
    cursor = None
    pages = 0
    while True:
        page = paginate_export_preview_manifest(full, cursor=cursor, page_size=3)
        assert page.manifest_hash == full.manifest_hash
        assert page.page_size == 3
        assert page.total_entities == full.total_entities
        seen.extend(e.key for e in page.entities)
        pages += 1
        if page.next_cursor is None:
            break
        assert page.truncated is True
        cursor = page.next_cursor
    assert seen == [e.key for e in full.entities]
    assert pages == -(-full.total_entities // 3)


def test_pagination_clamps_and_declares_truncation():
    api = _rich_api()
    full = _build(api, "openapi-3.1")
    page = paginate_export_preview_manifest(full, page_size=10**9)
    assert page.page_size == MAX_ENTITY_PAGE_SIZE
    assert page.truncated is False
    assert page.next_cursor is None

    later = paginate_export_preview_manifest(
        full, cursor=encode_page_cursor(1), page_size=MAX_ENTITY_PAGE_SIZE
    )
    assert later.truncated is True  # rows before the cursor were omitted


def test_malformed_cursor_raises_value_error():
    api = _rich_api()
    full = _build(api, "openapi-3.1")
    with pytest.raises(ValueError):
        paginate_export_preview_manifest(full, cursor="not-a-cursor!")


def test_cursor_codec_is_the_shared_one():
    assert decode_page_cursor(encode_page_cursor(7)) == 7


# ---------------------------------------------------------------------------
# Orchestration: read-only emit + cache
# ---------------------------------------------------------------------------
def test_run_caches_full_manifest_per_revision_target_options():
    """Paging re-emits nothing: the second request is served from the cache."""
    source = _source()
    request = ExportPreviewManifestRequest(
        artifact="artifact-1", target="openapi", page_size=3
    )

    calls = {"count": 0}
    from app import export_preview_manifest as module

    real_dispatch = module.dispatch_from_source

    def counting_dispatch(*args, **kwargs):
        calls["count"] += 1
        # The manifest emit must be read-only and never block a severe conversion.
        assert kwargs.get("persistence") is None
        assert kwargs.get("confirm") is True
        return real_dispatch(*args, **kwargs)

    with patch.object(module, "dispatch_from_source", side_effect=counting_dispatch):
        first = run_export_preview_manifest(source, request, tenant_id="tenant-a")
        assert calls["count"] == 1
        assert export_manifest_cache_size() == 1

        follow_up = ExportPreviewManifestRequest(
            artifact="artifact-1",
            target="openapi",
            cursor=first.manifest.next_cursor,
            page_size=3,
        )
        second = run_export_preview_manifest(source, follow_up, tenant_id="tenant-a")
        assert calls["count"] == 1  # cache hit — no re-emit
        assert second.manifest.manifest_hash == first.manifest.manifest_hash

        # A different option set is a different cache entry (and a different snapshot).
        other = ExportPreviewManifestRequest(
            artifact="artifact-1", target="proto3", page_size=3
        )
        run_export_preview_manifest(source, other, tenant_id="tenant-a")
        assert calls["count"] == 2
        assert export_manifest_cache_size() == 2


def test_run_echoes_resolved_source_coordinates():
    source = _source()
    request = ExportPreviewManifestRequest(artifact="artifact-1", version="1.0.0", target="openapi")
    response = run_export_preview_manifest(source, request, tenant_id="tenant-a")
    assert response.artifact == "artifact-1"
    assert response.version == "1.0.0"
    assert response.version_record_id == "rev-uuid-1"
    assert response.version_label == "1.0.0"
    assert response.manifest.total_entities > 0


def test_default_page_size_matches_import_manifest():
    """Both manifest surfaces page identically (CPDO-1.3 parity)."""
    from app.import_preview_manifest import (
        DEFAULT_ENTITY_PAGE_SIZE as IMPORT_DEFAULT,
        MAX_ENTITY_PAGE_SIZE as IMPORT_MAX,
    )

    assert DEFAULT_ENTITY_PAGE_SIZE == IMPORT_DEFAULT
    assert MAX_ENTITY_PAGE_SIZE == IMPORT_MAX


# ---------------------------------------------------------------------------
# Route wiring
# ---------------------------------------------------------------------------
def test_preview_manifest_requires_auth():
    response = client.post(
        "/v1/export/test-tenant/preview-manifest",
        json={"artifact": "artifact-1", "target": "openapi"},
    )
    assert response.status_code == 401


def test_preview_manifest_route_returns_manifest_page():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/preview-manifest",
                json={"artifact": "artifact-1", "version": "1.0.0", "target": "openapi",
                      "page_size": 4},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["artifact"] == "artifact-1"
    assert body["version_record_id"] == "rev-uuid-1"
    manifest = body["manifest"]
    assert manifest["manifest_hash"]
    assert manifest["target"]["format"] == "openapi-3.1"
    assert manifest["total_entities"] > 4
    assert len(manifest["entities"]) == 4
    assert manifest["truncated"] is True
    assert manifest["next_cursor"]
    assert manifest["files"], "the file table must ride on every page"
    first = manifest["entities"][0]
    for field in ("key", "entity_kind", "status", "detail", "order", "emitted"):
        assert field in first


def test_preview_manifest_route_maps_loader_errors():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("unknown artifact", status_code=404),
        ):
            missing = client.post(
                "/v1/export/test-tenant/preview-manifest",
                json={"artifact": "nope", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert missing.status_code == 404


def test_preview_manifest_route_rejects_unknown_target_and_bad_cursor():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            unknown = client.post(
                "/v1/export/test-tenant/preview-manifest",
                json={"artifact": "artifact-1", "target": "not-a-target"},
            )
            bad_cursor = client.post(
                "/v1/export/test-tenant/preview-manifest",
                json={"artifact": "artifact-1", "target": "openapi", "cursor": "!!bad!!"},
            )
    finally:
        app.dependency_overrides.clear()
    assert unknown.status_code == 400
    assert bad_cursor.status_code == 400


def test_openapi_exposes_the_preview_manifest_operation():
    spec = app.openapi()
    path = "/v1/export/{tenant_slug}/preview-manifest"
    assert path in spec["paths"], "preview-manifest route missing from the OpenAPI contract"
    schema_ref = spec["paths"][path]["post"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    assert schema_ref.endswith("ExportPreviewManifestResponse")
