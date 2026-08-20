"""REST surface for static MCP manifests — FMT-1.7 (#5418).

Drives the three endpoints against a stubbed catalog: the manifest import (attach vs
create, and the intake-taxonomy codes a bad manifest returns), the declaration listing,
and the declared-vs-observed attribution the detail view renders.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication, validate_session_credentials
from app.main import app
from app.mcp_manifest_parser import manifest_surface, parse_mcp_manifest
from app.mcp_manifest_store import declared_manifest

client = TestClient(app)

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/mcp"
_TYPICAL = (_EXAMPLES / "02-typical-tickets-server.json").read_text(encoding="utf-8")
_MINIMAL = (_EXAMPLES / "01-minimal-echo-tool.json").read_text(encoding="utf-8")

_NOW = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)
_EP = "11111111-1111-1111-1111-111111111111"
_V1 = "22222222-2222-2222-2222-222222222222"
_MANIFEST_ID = "33333333-3333-3333-3333-333333333333"
_JWT_T1 = {"tenant_id": "t1", "user_id": "user-1", "auth_method": "jwt"}

_DECLARED = declared_manifest(parse_mcp_manifest(_TYPICAL), source_label="tickets.json")
_BASE = "/v1/mcp/acme/endpoints"


@pytest.fixture(autouse=True)
def _default_auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT_T1
    app.dependency_overrides[validate_session_credentials] = lambda: _JWT_T1
    yield
    app.dependency_overrides.pop(validate_authentication, None)
    app.dependency_overrides.pop(validate_session_credentials, None)


def _endpoint_row(**overrides: Any) -> Dict[str, Any]:
    row = {
        "id": _EP,
        "tenant_id": "t1",
        "name": "Acme Support Tickets",
        "slug": "acme-support-tickets",
        "endpoint_url": "https://mcp.example.com/tickets",
        "transport": "streamable_http",
        "description": None,
        "category": None,
        "visibility": "private",
        "published": False,
        "enabled": True,
        "discovery_cadence_seconds": None,
        "last_discovered_at": None,
        "last_discovery_status": None,
        "consecutive_failures": 0,
        "next_discovery_after": None,
        "quarantined_at": None,
        "quarantine_reason": None,
        "current_version_id": None,
        "transport_metadata": None,
        "transport_metadata_at": None,
        "added_via": "manual",
        "created_at": _NOW,
        "updated_at": _NOW,
    }
    row.update(overrides)
    return row


def _manifest_row(**overrides: Any) -> Dict[str, Any]:
    row = dict(_DECLARED.as_row())
    row.update(
        {
            "id": _MANIFEST_ID,
            "tenant_id": "t1",
            "endpoint_id": _EP,
            "imported_by": "user-1",
            "retired_at": None,
            "created_at": _NOW,
            "updated_at": _NOW,
        }
    )
    row.update(overrides)
    return row


def _version_row(**overrides: Any) -> Dict[str, Any]:
    surface = manifest_surface(parse_mcp_manifest(_TYPICAL))
    row = {
        "id": _V1,
        "endpoint_id": _EP,
        "version_seq": 1,
        "discovered_at": _NOW,
        "created_at": _NOW,
    }
    row.update(surface.to_version_row())
    row.update(overrides)
    return row


def _capability_rows() -> List[Dict[str, Any]]:
    return manifest_surface(parse_mcp_manifest(_TYPICAL)).to_capability_rows(_V1)


def _import(**body: Any):
    payload = {"manifest": _TYPICAL, "source_label": "tickets.json"}
    payload.update(body)
    return client.post(f"{_BASE}/manifest-import", json=payload)


# ---------------------------------------------------------------------------
# Import: attaching vs creating
# ---------------------------------------------------------------------------


def test_import_attaches_to_an_endpoint_a_probe_already_created() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.list_mcp_endpoints.return_value = [_endpoint_row()]
        mdb.map_mcp_endpoint_surface_fingerprints.return_value = {
            _EP: _DECLARED.fingerprint
        }
        mdb.get_mcp_endpoint.return_value = _endpoint_row()
        mdb.upsert_mcp_endpoint_manifest.return_value = _manifest_row()
        mdb.retire_other_mcp_endpoint_manifests.return_value = 0

        response = _import()

    assert response.status_code == 200
    body = response.json()
    assert body["endpoint_created"] is False
    assert body["match"] == "address"
    assert body["endpoint"]["id"] == _EP
    assert body["surface_conflict"] is False
    mdb.insert_mcp_endpoint.assert_not_called()


def test_import_registers_an_endpoint_when_nothing_matches() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.list_mcp_endpoints.return_value = []
        mdb.map_mcp_endpoint_surface_fingerprints.return_value = {}
        mdb.insert_mcp_endpoint.return_value = _endpoint_row(added_via="import")
        mdb.upsert_mcp_endpoint_manifest.return_value = _manifest_row()
        mdb.retire_other_mcp_endpoint_manifests.return_value = 0

        response = _import()

    assert response.status_code == 200
    body = response.json()
    assert body["endpoint_created"] is True
    assert body["match"] == "none"
    kwargs = mdb.insert_mcp_endpoint.call_args.kwargs
    assert kwargs["added_via"] == "import"
    assert kwargs["endpoint_url"] == "https://mcp.example.com/tickets"
    assert kwargs["transport"] == "streamable_http"


def test_import_reports_a_surface_conflict_without_refusing_the_attach() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.list_mcp_endpoints.return_value = [_endpoint_row()]
        mdb.map_mcp_endpoint_surface_fingerprints.return_value = {_EP: "an-older-fingerprint"}
        mdb.get_mcp_endpoint.return_value = _endpoint_row()
        mdb.upsert_mcp_endpoint_manifest.return_value = _manifest_row()
        mdb.retire_other_mcp_endpoint_manifests.return_value = 0

        response = _import()

    body = response.json()
    assert response.status_code == 200
    assert body["endpoint_created"] is False
    assert body["surface_conflict"] is True
    assert body["observed_fingerprint"] == "an-older-fingerprint"


def test_import_reports_how_many_earlier_declarations_it_superseded() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.list_mcp_endpoints.return_value = [_endpoint_row()]
        mdb.map_mcp_endpoint_surface_fingerprints.return_value = {}
        mdb.get_mcp_endpoint.return_value = _endpoint_row()
        mdb.upsert_mcp_endpoint_manifest.return_value = _manifest_row()
        mdb.retire_other_mcp_endpoint_manifests.return_value = 2

        body = _import().json()

    assert body["superseded_manifests"] == 2


def test_import_stores_the_declared_surface_and_its_fingerprint() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.list_mcp_endpoints.return_value = [_endpoint_row()]
        mdb.map_mcp_endpoint_surface_fingerprints.return_value = {}
        mdb.get_mcp_endpoint.return_value = _endpoint_row()
        mdb.upsert_mcp_endpoint_manifest.return_value = _manifest_row()
        mdb.retire_other_mcp_endpoint_manifests.return_value = 0

        _import()

    stored = mdb.upsert_mcp_endpoint_manifest.call_args.kwargs["manifest"]
    assert stored["surface_fingerprint"] == _DECLARED.fingerprint
    assert stored["surface"]["serverInfo"]["name"] == "acme-tickets"
    assert stored["tool_count"] == 3


def test_import_accepts_an_explicit_address_for_a_transportless_manifest() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.list_mcp_endpoints.return_value = []
        mdb.map_mcp_endpoint_surface_fingerprints.return_value = {}
        mdb.insert_mcp_endpoint.return_value = _endpoint_row()
        mdb.upsert_mcp_endpoint_manifest.return_value = _manifest_row()
        mdb.retire_other_mcp_endpoint_manifests.return_value = 0

        response = _import(
            manifest=_MINIMAL, endpoint_url="https://echo.example.com/mcp", transport="sse"
        )

    assert response.status_code == 200
    assert mdb.insert_mcp_endpoint.call_args.kwargs["transport"] == "sse"


# ---------------------------------------------------------------------------
# Import: rejections
# ---------------------------------------------------------------------------


def test_a_transportless_manifest_with_no_address_is_rejected_not_guessed() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        response = _import(manifest=_MINIMAL)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INPUT_SEMANTIC_INVALID"
    mdb.insert_mcp_endpoint.assert_not_called()


@pytest.mark.parametrize(
    ("fixture", "code"),
    [
        ("negative/01-syntactic-trailing-comma.json", "INPUT_MALFORMED"),
        ("negative/02-semantic-tool-without-input-schema.json", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-tool.json", "INPUT_TRUNCATED"),
        ("negative/04-wrong-format-openapi.yaml", "FORMAT_MISMATCH"),
    ],
)
def test_a_broken_manifest_returns_its_taxonomy_code(fixture: str, code: str) -> None:
    text = (_EXAMPLES / fixture).read_text(encoding="utf-8")
    with patch("app.mcp_manifest_routes.db") as mdb:
        response = _import(manifest=text)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == code
    mdb.upsert_mcp_endpoint_manifest.assert_not_called()


def test_an_unknown_transport_is_rejected_at_the_boundary() -> None:
    with patch("app.mcp_manifest_routes.db"):
        response = _import(transport="carrier-pigeon")
    assert response.status_code == 400


def test_the_import_requires_authentication() -> None:
    app.dependency_overrides.pop(validate_authentication, None)
    response = client.post(f"{_BASE}/manifest-import", json={"manifest": _TYPICAL})
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Listing declarations
# ---------------------------------------------------------------------------


def test_listing_returns_an_endpoints_declarations() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row()
        mdb.list_mcp_endpoint_manifests.return_value = [_manifest_row()]

        body = client.get(f"{_BASE}/{_EP}/manifests").json()

    assert body["manifests"][0]["surface_fingerprint"] == _DECLARED.fingerprint
    assert body["manifests"][0]["source_label"] == "tickets.json"
    assert body["manifests"][0]["tool_count"] == 3
    assert mdb.list_mcp_endpoint_manifests.call_args.kwargs["include_retired"] is False


def test_listing_can_include_superseded_declarations() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row()
        mdb.list_mcp_endpoint_manifests.return_value = []

        client.get(f"{_BASE}/{_EP}/manifests", params={"include_retired": True})

    assert mdb.list_mcp_endpoint_manifests.call_args.kwargs["include_retired"] is True


def test_a_cross_tenant_endpoint_is_not_found() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = None
        response = client.get(f"{_BASE}/{_EP}/manifests")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Surface provenance
# ---------------------------------------------------------------------------


def test_provenance_reports_identical_when_manifest_and_probe_agree() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row(current_version_id=_V1)
        mdb.get_mcp_endpoint_version.return_value = _version_row()
        mdb.get_mcp_capability_items.return_value = _capability_rows()
        mdb.get_current_mcp_endpoint_manifest.return_value = _manifest_row()

        body = client.get(f"{_BASE}/{_EP}/surface-provenance").json()

    assert body["surface_match"] == "identical"
    assert body["fingerprints_match"] is True
    assert body["conflict_count"] == 0
    assert body["origin_counts"]["both"] == len(body["facts"])


def test_provenance_reports_observed_only_when_no_manifest_is_attached() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row(current_version_id=_V1)
        mdb.get_mcp_endpoint_version.return_value = _version_row()
        mdb.get_mcp_capability_items.return_value = _capability_rows()
        mdb.get_current_mcp_endpoint_manifest.return_value = None

        body = client.get(f"{_BASE}/{_EP}/surface-provenance").json()

    assert body["surface_match"] == "observed_only"
    assert body["declared_fingerprint"] is None
    assert all(fact["origin"] == "observed" for fact in body["facts"])


def test_provenance_reports_declared_only_for_a_never_discovered_endpoint() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row(current_version_id=None)
        mdb.get_current_mcp_endpoint_manifest.return_value = _manifest_row()

        body = client.get(f"{_BASE}/{_EP}/surface-provenance").json()

    assert body["surface_match"] == "declared_only"
    assert body["observed_fingerprint"] is None
    mdb.get_mcp_endpoint_version.assert_not_called()


def test_provenance_names_the_conflicting_fact_and_carries_both_values() -> None:
    divergent = json.loads(_TYPICAL)
    divergent["server"]["version"] = "9.9.9"
    observed = manifest_surface(parse_mcp_manifest(json.dumps(divergent)))

    version_row = dict(_version_row())
    version_row.update(observed.to_version_row())

    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row(current_version_id=_V1)
        mdb.get_mcp_endpoint_version.return_value = version_row
        mdb.get_mcp_capability_items.return_value = observed.to_capability_rows(_V1)
        mdb.get_current_mcp_endpoint_manifest.return_value = _manifest_row()

        body = client.get(f"{_BASE}/{_EP}/surface-provenance").json()

    assert body["surface_match"] == "divergent"
    conflict = next(f for f in body["facts"] if f["agreement"] == "conflicts")
    assert conflict["key"] == "serverInfo.version"
    assert conflict["declared"] == "1.4.0"
    assert conflict["observed"] == "9.9.9"


def test_provenance_reports_none_for_an_endpoint_with_neither_source() -> None:
    with patch("app.mcp_manifest_routes.db") as mdb:
        mdb.get_mcp_endpoint.return_value = _endpoint_row(current_version_id=None)
        mdb.get_current_mcp_endpoint_manifest.return_value = None

        body = client.get(f"{_BASE}/{_EP}/surface-provenance").json()

    assert body["surface_match"] == "none"
    assert body["facts"] == []


def test_provenance_requires_authentication() -> None:
    app.dependency_overrides.pop(validate_authentication, None)
    assert client.get(f"{_BASE}/{_EP}/surface-provenance").status_code == 401
