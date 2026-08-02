"""REST integration for the transcoding guard — preview + dispatch — MFX-3.3 (#3846).

Pins how the guard reaches the export surface:

* ``POST /export/preview`` carries the :class:`~app.transcoding_guards.TranscodeGuard` so the
  UI/CLI can warn (near-empty) or plan a confirmation (severe) before dispatching;
* ``POST /export/dispatch`` **refuses a severe conversion with 409** unless ``confirm: true``,
  handing the guard back in the error body; with ``confirm: true`` the same conversion emits;
* a near-empty conversion (operations → Avro) dispatches without a gate but carries the warning
  guard;
* a clean conversion carries a ``clean`` guard and never blocks.

The source loader is faked; the emitter path runs the real registry/SPI.
"""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.export_source import ExportSource
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


def _record(key: str) -> Type:
    return Type(
        key=key,
        name=key,
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key=f"{key}.id", name="id", type=TypeRef(name="string"))],
    )


def _rest_source() -> ExportSource:
    """An operation-bearing REST source (one operation + one schema)."""
    op = Operation(key="GET /widgets", name="listWidgets", kind=OperationKind.QUERY)
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        services=[Service(key="widgets", name="widgets", operations=[op])],
        types=[_record("Widget")],
    )
    return ExportSource(
        api=api, artifact_id="artifact-1", version_record_id="rev-uuid-1", version_label="1.0.0"
    )


def _event_source() -> ExportSource:
    """An event-only source (one channel + one message schema)."""
    api = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="signup"),
        channels=[Channel(key="user/signedup", address="user/signedup")],
        types=[_record("Signup")],
    )
    return ExportSource(
        api=api, artifact_id="artifact-2", version_record_id="rev-uuid-2", version_label="2.0.0"
    )


# ---------------------------------------------------------------------------
# POST /export/preview — the guard is surfaced for pre-flight
# ---------------------------------------------------------------------------
def test_preview_carries_a_clean_guard_for_a_lossless_conversion():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_rest_source()):
            response = client.post(
                "/v1/export/test-tenant/preview",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    guard = response.json()["guard"]
    assert guard["verdict"] == "clean"
    assert guard["requires_confirmation"] is False


def test_preview_flags_a_severe_conversion_for_confirmation():
    """Event-only → Protobuf previews as ``severe`` with ``requires_confirmation``."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_event_source()):
            response = client.post(
                "/v1/export/test-tenant/preview",
                json={"artifact": "artifact-2", "target": "protobuf"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    guard = response.json()["guard"]
    assert guard["verdict"] == "severe"
    assert guard["requires_confirmation"] is True
    assert guard["dropped_events"] == 1
    assert guard["reasons"]


# ---------------------------------------------------------------------------
# POST /export/dispatch — severe is gated behind confirm
# ---------------------------------------------------------------------------
def test_dispatch_blocks_severe_conversion_with_409():
    """A severe conversion without ``confirm`` is refused with 409 and the guard in the body."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_event_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-2", "target": "protobuf"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["guard"]["verdict"] == "severe"
    assert detail["guard"]["requires_confirmation"] is True
    assert "message" in detail


def test_dispatch_emits_severe_conversion_when_confirmed():
    """A severe conversion emits once ``confirm: true`` is set, carrying the guard.

    Uses event-only → GraphQL (also severe: GraphQL carries operations, not events) because its
    emit needs no field-identity persistence, keeping the test free of a live database.
    """
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_event_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-2", "target": "graphql", "confirm": True},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["dry_run"] is False
    assert body["files"]  # the emitter ran
    assert body["guard"]["verdict"] == "severe"
    assert body["guard"]["requires_confirmation"] is True


def test_dispatch_dry_run_never_blocks_a_severe_conversion():
    """A dry-run of a severe conversion returns the report + guard, never 409."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_event_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-2", "target": "protobuf", "dry_run": True},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["dry_run"] is True
    assert body["files"] == []
    assert body["guard"]["verdict"] == "severe"


def test_dispatch_near_empty_conversion_warns_but_does_not_block():
    """Operations → Avro dispatches (no gate) and carries the near-empty warning guard."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_rest_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "avro"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["guard"]["verdict"] == "near-empty"
    assert body["guard"]["requires_confirmation"] is False
    assert body["files"]  # schemas were emitted
