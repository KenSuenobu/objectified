"""Tests for the fidelity REST surface — ``/export/targets`` + ``/export/preview`` — MFX-2.5 (#3842)
plus the emit surface ``/export/document`` — MFX-11.5 (#3878).

Pins the route contract:

* all three endpoints require authentication and are tenant-scoped;
* ``GET …/targets`` returns every registered target with its per-source fidelity badge
  (tier + preserved-%), and echoes the resolved revision;
* ``POST …/preview`` returns the full fidelity envelope (report + advisory + summary) for one
  target, **without emitting an artifact**;
* ``POST …/document`` emits the chosen target through the Emitter SPI and returns the document
  itself (JSON by default, YAML under ``Accept: application/yaml``), the byte source the OpenAPI
  browse reconstruction cannot supply for non-OpenAPI targets;
* the loader's not-found (404) and no-source (422) errors, and an unknown target (400), map to
  the right HTTP status.

The source loader (:func:`app.export_source.load_export_source`) is faked here — its own DB-backed
logic is exercised in ``test_export_source.py`` — so these tests pin only the route wiring.
"""

from __future__ import annotations

import base64
import hashlib
import json
from unittest.mock import patch

import yaml
from fastapi.testclient import TestClient

from app.auth import validate_authentication
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
from app.export_delivery_gate import (
    DeliveryDecision,
    DeliveryDimension,
    DeliveryGateReport,
    DeliveryOverride,
    DeliveryReason,
    DeliveryReasonCode,
    DeliverySeverity,
)
from app.export_source import ExportSource, ExportSourceError
from app.main import app
from app.models import ImportPreflightPolicy

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


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


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def test_targets_requires_auth():
    response = client.get("/v1/export/test-tenant/targets", params={"artifact": "artifact-1"})
    assert response.status_code == 401


def test_preview_requires_auth():
    response = client.post(
        "/v1/export/test-tenant/preview",
        json={"artifact": "artifact-1", "target": "openapi"},
    )
    assert response.status_code == 401


def test_document_requires_auth():
    response = client.post(
        "/v1/export/test-tenant/document",
        json={"artifact": "artifact-1", "target": "asyncapi"},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /export/{tenant}/targets
# ---------------------------------------------------------------------------
def test_targets_returns_per_target_fidelity():
    """Every registered target is listed with a tier + preserved-% badge; the revision is echoed."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.get(
                "/v1/export/test-tenant/targets",
                params={"artifact": "artifact-1", "version": "1.0.0"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["artifact"] == "artifact-1"
    assert body["version"] == "1.0.0"
    assert body["version_record_id"] == "rev-uuid-1"
    assert body["version_label"] == "1.0.0"

    by_key = {t["descriptor"]["key"]: t for t in body["targets"]}
    # The built-in emitters are present, each with a fidelity badge.
    assert "openapi" in by_key and "sample" in by_key
    assert by_key["openapi"]["fidelity"]["tier"] == "lossless"
    assert by_key["openapi"]["fidelity"]["preserved_percent"] == 100
    # A schema-only target drops the operation → types-only.
    assert by_key["sample"]["fidelity"]["tier"] == "types-only"
    # The registry's descriptor + options are surfaced alongside the badge.
    assert "options_schema" in by_key["openapi"]
    assert "capability_profile" in by_key["openapi"]


def test_targets_404_when_source_not_found():
    """The loader's 404 (unknown artifact/version) surfaces as an HTTP 404."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("Artifact 'nope' was not found.", status_code=404),
        ):
            response = client.get(
                "/v1/export/test-tenant/targets", params={"artifact": "nope"}
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_targets_requires_artifact_param():
    """``artifact`` is a required query parameter."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        response = client.get("/v1/export/test-tenant/targets")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422  # FastAPI validation for the missing query param


# ---------------------------------------------------------------------------
# POST /export/{tenant}/preview
# ---------------------------------------------------------------------------
def test_preview_returns_full_envelope():
    """The preview returns the full report + advisory + summary for the chosen target, no artifact."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/preview",
                json={"artifact": "artifact-1", "version": "1.0.0", "target": "sample"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["artifact"] == "artifact-1"
    assert body["version_record_id"] == "rev-uuid-1"
    fidelity = body["fidelity"]
    assert fidelity["target"]["key"] == "sample"
    # Full per-construct report is present and the advisory shows (operation dropped).
    assert len(fidelity["report"]["items"]) == 2
    assert fidelity["summary"]["total"] == 2
    assert fidelity["report"]["kind_counts"]["drop"] == 1
    assert fidelity["advisory"]["show"] is True
    assert fidelity["summary"]["tier"] == "types-only"


def test_preview_lossless_target_hides_advisory():
    """OpenAPI → OpenAPI is lossless, so the advisory is suppressed."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/preview",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    fidelity = response.json()["fidelity"]
    assert fidelity["summary"]["tier"] == "lossless"
    assert fidelity["advisory"]["show"] is False


def test_preview_400_for_unknown_target():
    """An unresolvable target is a 400 (the export service's status)."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/preview",
                json={"artifact": "artifact-1", "target": "no-such-target"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 400
    assert "unsupported export target" in response.json()["detail"].lower()


def test_preview_422_when_source_unreconstructable():
    """The loader's 422 (a revision with no captured source) surfaces as an HTTP 422."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("no captured source", status_code=422),
        ):
            response = client.post(
                "/v1/export/test-tenant/preview",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# POST /export/{tenant}/document
# ---------------------------------------------------------------------------
def test_document_emits_asyncapi_json():
    """The emit route returns the AsyncAPI document as JSON by default, with a filename hint."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "version": "1.0.0", "target": "asyncapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert 'filename="asyncapi.json"' in response.headers["content-disposition"]
    body = response.json()
    # A real, schema-shaped AsyncAPI 3 document (the REST source is reframed onto channels).
    assert body["asyncapi"] == "3.1.0"
    assert body["info"]["title"] == "widgets"
    assert "operations" in body


def test_document_emits_yaml_with_accept():
    """``Accept: application/yaml`` serializes the same document as YAML with a .yaml filename."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "target": "asyncapi"},
                headers={"Accept": "application/yaml"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert "yaml" in response.headers["content-type"]
    assert 'filename="asyncapi.yaml"' in response.headers["content-disposition"]
    document = yaml.safe_load(response.text)
    assert document["asyncapi"] == "3.1.0"


def test_document_target_generic_openapi():
    """The route is target-generic: ``openapi`` emits an OpenAPI document through the same SPI."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert str(body.get("openapi", "")).startswith("3.")


def test_document_400_for_unknown_target():
    """An unresolvable target is a 400 (the export service's status)."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "target": "no-such-target"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 400
    assert "unsupported export target" in response.json()["detail"].lower()


def test_document_applies_emit_options():
    """Per-target emit options flow through: ``include_channels=false`` yields a schemas-only doc."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={
                    "artifact": "artifact-1",
                    "target": "asyncapi",
                    "options": {"include_channels": False},
                },
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    body = response.json()
    assert body["asyncapi"] == "3.1.0"
    # With channels/operations suppressed, only the declaration + info remain.
    assert "operations" not in body
    assert "channels" not in body


def test_document_404_when_source_not_found():
    """The loader's 404 (unknown artifact/version) surfaces as an HTTP 404."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("Artifact 'nope' was not found.", status_code=404),
        ):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "nope", "target": "asyncapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 404


def test_document_422_when_source_unreconstructable():
    """The loader's 422 (a revision with no captured source) surfaces as an HTTP 422."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("no captured source", status_code=422),
        ):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "target": "asyncapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Delivery gate on the synchronous export routes — IXH-2.5 (#5100)
# ---------------------------------------------------------------------------
def _blocking_delivery() -> DeliveryGateReport:
    """A delivery decision blocked by the tenant's export policy, with its override path."""
    return DeliveryGateReport(
        decision=DeliveryDecision.BLOCK,
        blocks_delivery=True,
        warns=False,
        headline="Delivery blocked",
        message="Quality policy blocks this export: score 40 is below the required 90.",
        reasons=[
            DeliveryReason(
                code=DeliveryReasonCode.SOURCE_BELOW_FLOOR,
                dimension=DeliveryDimension.LINT,
                severity=DeliverySeverity.BLOCKING,
                message="The source lint score is 40, below the required 90.",
            )
        ],
        target="asyncapi-3",
        policy=ImportPreflightPolicy(
            verdict="block", blocking=True, scope="export", reason="score floor missed"
        ),
        override=DeliveryOverride(
            available=True,
            endpoint="/v1/tenants/test-tenant/governance/quality-waivers",
            subject_key="rev-uuid-1",
            format_key="asyncapi",
            roles=["owner"],
            instructions="Record an export waiver for this revision.",
        ),
    )


def test_document_attaches_a_signed_delivery_attestation_header():
    """An allowed delivery names its decision and carries the attestation for its exact bytes."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.headers["X-Apiome-Delivery-Decision"] in {"allow", "allow_with_warning"}

    envelope = json.loads(
        base64.b64decode(response.headers["X-Apiome-Delivery-Attestation"], validate=True)
    )
    statement = json.loads(base64.b64decode(envelope["payload"], validate=True))
    assert statement["predicateType"].endswith("/export-delivery/v1")
    # The subject digests the bytes the client actually received.
    assert statement["subject"][0]["digest"]["sha256"] == hashlib.sha256(
        response.content
    ).hexdigest()
    assert statement["subject"][0]["name"] == "openapi.json"
    assert statement["predicate"]["delivery"]["versionRecordId"] == "rev-uuid-1"


def test_document_409_when_the_delivery_gate_blocks_and_emits_nothing():
    """A blocked delivery returns the reasons and the override path — and never emits."""
    app.dependency_overrides[validate_authentication] = _override_auth

    def _must_not_emit(*_args, **_kwargs):
        raise AssertionError("a blocked delivery must not emit an artifact")

    try:
        with patch("app.export_routes.load_export_source", return_value=_source()), patch(
            "app.export_routes.emit_canonical", side_effect=_must_not_emit
        ), patch(
            "app.export_routes.evaluate_delivery", return_value=_blocking_delivery()
        ):
            response = client.post(
                "/v1/export/test-tenant/document",
                json={"artifact": "artifact-1", "target": "asyncapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["delivery"]["decision"] == "block"
    assert detail["delivery"]["reasons"][0]["code"] == "DELIVERY_SOURCE_BELOW_FLOOR"
    assert detail["delivery"]["override"]["available"] is True
    assert detail["delivery"]["override"]["subject_key"] == "rev-uuid-1"
    assert "X-Apiome-Delivery-Attestation" not in response.headers


def test_dispatch_carries_the_delivery_decision_and_attestation():
    """A dispatched export returns its decision inline, attested over the inline files."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    delivery = response.json()["delivery"]
    assert delivery["decision"] in {"allow", "allow_with_warning"}
    assert delivery["blocks_delivery"] is False
    assert delivery["attestation"]["predicate_type"].endswith("/export-delivery/v1")


def test_dispatch_409_when_the_delivery_gate_blocks_and_never_runs_the_emitter():
    """The gate runs before the dispatch, so no emit (and no field-identity write) happens."""
    app.dependency_overrides[validate_authentication] = _override_auth

    def _must_not_dispatch(*_args, **_kwargs):
        raise AssertionError("a blocked delivery must not run the emitter")

    try:
        with patch("app.export_routes.load_export_source", return_value=_source()), patch(
            "app.export_routes.dispatch_from_source", side_effect=_must_not_dispatch
        ), patch(
            "app.export_routes.evaluate_delivery", return_value=_blocking_delivery()
        ):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 409
    assert response.json()["detail"]["delivery"]["blocks_delivery"] is True


def test_dispatch_dry_run_is_not_gated():
    """A dry-run delivers nothing, so it is neither gated nor attested."""
    app.dependency_overrides[validate_authentication] = _override_auth

    def _must_not_gate(*_args, **_kwargs):
        raise AssertionError("a dry-run must not run the delivery gate")

    try:
        with patch("app.export_routes.load_export_source", return_value=_source()), patch(
            "app.export_routes.evaluate_delivery", side_effect=_must_not_gate
        ):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "openapi", "dry_run": True},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dry_run"] is True
    assert body["delivery"] is None
    assert body["files"] == []
