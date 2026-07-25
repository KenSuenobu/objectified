"""Endpoint tests for the export pre-flight API — IXH-2.4 (#5099).

``POST /v1/tenants/{tenant_slug}/export/preflight`` is the export twin of the import pre-flight
(IXH-2.1): it ranks every export target for one source revision *before* a job exists. These
tests cover the HTTP contract — auth, source-resolution failures, the response shape, and the
promise that a pre-flight neither emits an artifact nor creates a job — while
:mod:`test_export_preflight` covers the ranking itself.
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
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.export_source import ExportSource, ExportSourceError
from app.import_export_quality_policy import DEFAULT_POLICY, QualityPolicy, QualityThresholds
from app.main import app
from app.style_guide_engine import builtin_fallback_guide

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}
_PREFLIGHT_URL = "/v1/tenants/acme/export/preflight"


def _source() -> ExportSource:
    """A loaded REST source: one operation and one record type."""
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Widget.id", name="id", type=TypeRef(name="string"))],
    )
    operation = Operation(key="GET /widgets", name="listWidgets", kind=OperationKind.QUERY)
    return ExportSource(
        api=CanonicalApi(
            paradigm=ApiParadigm.REST,
            format="openapi-3.1",
            identity=ApiIdentity(name="widgets"),
            services=[Service(key="widgets", name="widgets", operations=[operation])],
            types=[widget],
        ),
        artifact_id="artifact-1",
        version_record_id="rev-uuid-1",
        version_label="1.0.0",
    )


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    yield
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _tenant_state():
    """Pin the tenant-state reads (style guide, policy, waivers) to their documented defaults."""
    with patch("app.export_preflight.resolve_style_guide", return_value=builtin_fallback_guide()), patch(
        "app.export_preflight.load_tenant_policy", return_value=DEFAULT_POLICY
    ), patch("app.import_export_quality_policy.find_active_waiver", return_value=None):
        yield


def _post(body: Optional[dict] = None):
    """POST a pre-flight request with the sample source loaded."""
    with patch("app.export_routes.load_export_source", return_value=_source()):
        return client.post(_PREFLIGHT_URL, json=body or {"artifact": "artifact-1"})


def test_preflight_returns_every_target_ranked():
    response = _post()
    assert response.status_code == 200
    body = response.json()

    assert body["artifact"] == "artifact-1"
    assert body["version_record_id"] == "rev-uuid-1"
    assert body["version_label"] == "1.0.0"
    assert body["paradigm"] == "rest"
    assert body["format"] == "openapi-3.1"
    assert body["ranking_fingerprint"]
    assert body["capability_demand"] == ["operations"]

    targets = body["targets"]
    assert targets
    assert [target["rank"] for target in targets] == list(range(1, len(targets) + 1))
    first = targets[0]
    assert set(first) >= {
        "rank",
        "key",
        "format",
        "descriptor",
        "capability_profile",
        "readiness",
        "band",
        "blocked",
        "selectable",
        "rationale",
        "fidelity",
        "capability",
        "policy",
    }
    assert first["policy"]["scope"] == "export"
    assert first["fidelity"]["preserved_percent"] == 100
    assert first["rationale"]


def test_preflight_reports_the_source_lint_verdict():
    body = _post().json()
    assert body["lint"]["score"] is not None
    assert body["lint"]["grade"]
    assert body["style_guide"]["source"] == "fallback"
    # Findings are ranked densely from 1, the same contract the import pre-flight ships.
    ranks = [finding["rank"] for finding in body["lint"]["findings"]]
    assert ranks == list(range(1, len(ranks) + 1))


def test_preflight_can_omit_findings():
    body = _post({"artifact": "artifact-1", "include_findings": False}).json()
    assert body["lint"]["findings"] == []
    assert body["lint"]["score"] is not None


def test_preflight_target_filter_is_honoured():
    body = _post({"artifact": "artifact-1", "targets": ["avro"]}).json()
    assert [target["key"] for target in body["targets"]] == ["avro"]


def test_preflight_creates_no_job_and_emits_nothing():
    with patch("app.export_job_engine.schedule_export_job") as submit, patch(
        "app.export_service.emit_canonical"
    ) as emit:
        assert _post().status_code == 200
    submit.assert_not_called()
    emit.assert_not_called()


def test_blocked_targets_are_returned_with_their_reason():
    policy = QualityPolicy(
        policy_version_id="policy-1",
        version_number=1,
        content_fingerprint="fp-1",
        export_thresholds=QualityThresholds(min_score=100, enforcement="block"),
        is_default=False,
    )
    with patch("app.export_preflight.load_tenant_policy", return_value=policy):
        body = _post().json()

    assert body["targets"], "a blocked target is ranked, not hidden"
    for target in body["targets"]:
        assert target["blocked"] is True
        assert target["band"] == "blocked"
        assert target["selectable"] is False
        assert target["policy"]["verdict"] == "block"
        assert target["rationale"].startswith("Blocked by the tenant export policy:")


def test_unknown_artifact_is_a_404():
    with patch(
        "app.export_routes.load_export_source",
        side_effect=ExportSourceError("No such artifact", status_code=404),
    ):
        response = client.post(_PREFLIGHT_URL, json={"artifact": "missing"})
    assert response.status_code == 404
    assert "No such artifact" in response.json()["detail"]


def test_unreconstructable_source_is_a_422():
    with patch(
        "app.export_routes.load_export_source",
        side_effect=ExportSourceError("Revision has no captured source", status_code=422),
    ):
        response = client.post(_PREFLIGHT_URL, json={"artifact": "artifact-1"})
    assert response.status_code == 422


def test_missing_artifact_field_is_rejected():
    response = client.post(_PREFLIGHT_URL, json={})
    assert response.status_code == 422


def test_unknown_request_field_is_rejected():
    response = client.post(_PREFLIGHT_URL, json={"artifact": "artifact-1", "nope": True})
    assert response.status_code == 422


def test_preflight_requires_authentication():
    app.dependency_overrides.clear()
    response = client.post(_PREFLIGHT_URL, json={"artifact": "artifact-1"})
    assert response.status_code in {401, 403}
