"""HTTP contract tests for the payload-synthesis endpoint — IXH-5.2 (#5114).

``POST /v1/tenants/{tenant_slug}/schemas/{schema_ref}/synthesize``. Schema resolution is faked
(``test_schema_reference`` covers it) and generation itself is covered by
``test_schema_instance_synthesis``; what is asserted here is the endpoint's own contract — auth
and permission gating, the path-shaped reference reaching the service intact, the response
shape, the synthetic labelling a UI reads, the "a schema we cannot generate from is a 200 with
``ok: false``" rule, the "an addressing fault is an HTTP error" rule, and the request bounds.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.schema_instance_synthesis import (
    MUTATION_KINDS,
    MUTATION_REQUIRED_MISSING,
    SYNTHETIC_NOTICE,
)
from app.schema_instance_validation import ValidationDiagnostic
from app.schema_reference import ResolvedSchema, SchemaReference, SchemaReferenceError

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}

_PERSON_SCHEMA: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "firstName": {"type": "string", "minLength": 1},
        "age": {"type": "integer", "minimum": 0, "maximum": 120},
    },
    "required": ["firstName"],
}

_XSD = """<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="note" type="xs:string"/>
</xs:schema>
"""


def _url(reference: str) -> str:
    return f"/v1/tenants/acme/schemas/{reference}/synthesize"


def _resolved(
    *,
    document: Optional[Dict[str, Any]] = None,
    xml_schema_text: Optional[str] = None,
    diagnostics: Optional[List[ValidationDiagnostic]] = None,
) -> ResolvedSchema:
    return ResolvedSchema(
        reference=SchemaReference(kind="project", raw="project/petstore/1.0.0/Person"),
        document=_PERSON_SCHEMA if document is None and xml_schema_text is None else document,
        dialect="2020-12",
        xml_schema_text=xml_schema_text,
        source_format="openapi",
        coordinates={"kind": "project", "type_key": "Person"},
        diagnostics=diagnostics or [],
    )


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request and grant the permission the route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch("app.schema_synthesis_routes.enforce_permission", return_value="test-user-id"):
        yield
    app.dependency_overrides.clear()


# ===========================================================================
# Happy path
# ===========================================================================


def test_an_empty_body_generates_the_whole_set() -> None:
    """Every option has a usable default: no body still returns valid instances and mutants."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        response = client.post(_url("project/petstore/1.0.0/Person"), json={})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["schema_ref"] == "project/petstore/1.0.0/Person"
    assert body["dialect"] == "2020-12"
    assert body["seed"] == 0
    assert body["verified"] is True
    assert body["source"]["kind"] == "project"
    assert body["source"]["coordinates"]["type_key"] == "Person"
    assert body["counts"]["minimal"] == 1
    assert body["counts"]["full"] == 1
    assert body["counts"]["mutant"] >= 1


def test_the_response_is_labelled_synthetic_everywhere_a_ui_can_read_it() -> None:
    """The label is on the response, on every instance, and on every invented value."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        body = client.post(_url("project/petstore/1.0.0/Person"), json={}).json()

    assert body["synthetic"] is True
    assert body["notice"] == SYNTHETIC_NOTICE
    assert all(instance["synthetic"] is True for instance in body["instances"])
    minimal = next(i for i in body["instances"] if i["kind"] == "minimal")
    assert minimal["provenance"]
    assert all("synthetic" in entry for entry in minimal["provenance"])


def test_valid_instances_and_mutants_are_distinguishable() -> None:
    """A caller can tell a payload meant to pass from one meant to fail, without guessing."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        body = client.post(_url("project/petstore/1.0.0/Person"), json={}).json()

    for instance in body["instances"]:
        if instance["kind"] == "mutant":
            assert instance["expected_valid"] is False
            assert instance["valid"] is False
            assert instance["mutation"]["keyword"]
            # The root itself is a legitimate mutation site, and its pointer is "".
            assert isinstance(instance["mutation"]["pointer"], str)
            assert instance["mutation"]["description"]
            assert instance["derived_from"] == "full"
        else:
            assert instance["expected_valid"] is True
            assert instance["valid"] is True
            assert instance["mutation"] is None


def test_the_same_seed_returns_the_same_payloads() -> None:
    """Determinism survives the API boundary, so a generated fixture can be committed."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        first = client.post(_url("project/petstore/1.0.0/Person"), json={"seed": 99}).json()
        second = client.post(_url("project/petstore/1.0.0/Person"), json={"seed": 99}).json()

    assert first["instances"] == second["instances"]


def test_selection_flags_are_honoured() -> None:
    """A caller can ask for one kind of payload and get only that."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        body = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={
                "include_full": False,
                "include_branches": False,
                "mutation_kinds": [MUTATION_REQUIRED_MISSING],
                "max_mutants": 1,
            },
        ).json()

    kinds = {instance["kind"] for instance in body["instances"]}
    assert kinds == {"minimal", "mutant"}
    assert body["counts"]["mutant"] == 1


def test_resolution_diagnostics_reach_the_response() -> None:
    """A projection that could not constrain everything says so on the payloads it produced."""
    resolved = _resolved(
        diagnostics=[ValidationDiagnostic(code="INPUT_SEMANTIC_INVALID", message="Money")]
    )
    with patch("app.schema_synthesis_service.resolve_schema_reference", return_value=resolved):
        body = client.post(_url("project/petstore/1.0.0/Person"), json={}).json()

    assert "INPUT_SEMANTIC_INVALID" in [d["code"] for d in body["diagnostics"]]


def test_verification_can_be_switched_off_over_the_api() -> None:
    """With ``verify: false`` nothing is checked, and nothing claims to have been."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        body = client.post(
            _url("project/petstore/1.0.0/Person"), json={"verify": False}
        ).json()

    assert body["verified"] is False
    assert all(instance["valid"] is None for instance in body["instances"])


# ===========================================================================
# Requests that cannot be serviced are 200s with ok: false
# ===========================================================================


def test_an_xml_only_reference_is_not_serviceable() -> None:
    """An XSD-backed revision has no JSON payloads to generate; the code says exactly that."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference",
        return_value=_resolved(document=None, xml_schema_text=_XSD),
    ):
        response = client.post(_url("project/petstore/1.0.0/Note"), json={})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "FORMAT_MISMATCH"
    assert body["error"]["remediation"]
    assert body["instances"] == []


def test_an_unknown_mutation_kind_is_reported_not_ignored() -> None:
    """Asking for a kind that does not exist is a stated fault, never a silent empty set."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        response = client.post(
            _url("project/petstore/1.0.0/Person"), json={"mutation_kinds": ["off-by-one"]}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_SEMANTIC_INVALID"
    assert "off-by-one" in body["error"]["message"]
    assert all(kind in body["error"]["message"] for kind in MUTATION_KINDS)


# ===========================================================================
# Addressing faults are HTTP errors
# ===========================================================================


@pytest.mark.parametrize("status", [400, 404, 422])
def test_addressing_faults_map_straight_through(status: int) -> None:
    """A malformed, invisible, or underivable reference is an HTTP error, not an ``ok: false``."""
    error = SchemaReferenceError("nope", status_code=status, candidates=["Pet"])
    with patch("app.schema_synthesis_service.parse_schema_reference", side_effect=error):
        response = client.post(_url("project/petstore/1.0.0/Ghost"), json={})

    assert response.status_code == status
    assert response.json()["detail"]["message"] == "nope"
    assert response.json()["detail"]["candidates"] == ["Pet"]


def test_a_path_shaped_reference_reaches_the_service_intact() -> None:
    """The whole tail up to ``/synthesize`` is the reference, slashes and all."""
    seen: Dict[str, Any] = {}

    def _capture(reference, **_kwargs):
        seen["raw"] = reference.raw
        return _resolved()

    with patch("app.schema_synthesis_service.resolve_schema_reference", side_effect=_capture):
        response = client.post(_url("registry/std/v0/primitives/email"), json={})

    assert response.status_code == 200
    assert seen["raw"] == "registry/std/v0/primitives/email"
    assert response.json()["schema_ref"] == "registry/std/v0/primitives/email"


# ===========================================================================
# Request validation and gating
# ===========================================================================


@pytest.mark.parametrize(
    "body",
    [
        {"seed": -1},
        {"max_mutants": 0},
        {"max_mutants": 10**6},
        {"max_branch_instances": 0},
        {"unknown_field": True},
    ],
)
def test_out_of_range_requests_are_rejected(body: Dict[str, Any]) -> None:
    """Bounds are enforced at the contract, so no request can ask for unbounded work."""
    with patch(
        "app.schema_synthesis_service.resolve_schema_reference", return_value=_resolved()
    ):
        response = client.post(_url("project/petstore/1.0.0/Person"), json=body)

    assert response.status_code == 422


def test_the_endpoint_requires_authentication() -> None:
    """Without a credential there is no tenant, and nothing is generated."""
    app.dependency_overrides.clear()
    response = client.post(_url("project/petstore/1.0.0/Person"), json={})
    assert response.status_code in (401, 403)


def test_a_credential_without_a_tenant_is_refused() -> None:
    """Every lookup is tenant-scoped; a credential with no tenant cannot be scoped at all."""
    app.dependency_overrides[validate_authentication] = lambda: {"user_id": "u"}
    response = client.post(_url("project/petstore/1.0.0/Person"), json={})
    assert response.status_code == 403


def test_the_endpoint_is_gated_on_types_view() -> None:
    """Generating payloads reads a schema, so it needs the permission to see one."""
    from fastapi import HTTPException

    with patch(
        "app.schema_synthesis_routes.enforce_permission",
        side_effect=HTTPException(status_code=403, detail="denied"),
    ):
        response = client.post(_url("project/petstore/1.0.0/Person"), json={})

    assert response.status_code == 403
