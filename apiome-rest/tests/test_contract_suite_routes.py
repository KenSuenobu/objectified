"""HTTP contract tests for the contract-suite endpoint — ECA-1.1 (#4729).

``POST /v1/tenants/{tenant_slug}/contracts/{version_ref}/suite``. The service is faked (its own
tests cover it); what is asserted here is the endpoint's own contract — auth and permission
gating, the path-shaped reference reaching the service intact, the response shape a client
parses, the "a version that yields no suite is a 200 with ``ok: false``" rule, the "an addressing
fault is an HTTP error" rule, and rejection of an unknown option.
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.contract_suite import (
    ContractSuiteManifest,
    ContractSuiteOptions,
    SuiteApiInfo,
    compile_contract_suite,
)
from app.contract_suite_service import ContractSuiteResponse
from app.import_source_pipeline import build_job_error
from app.main import app
from app.openapi_normalizer import OpenApiNormalizer
from app.schema_reference import SchemaReferenceError

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}

_DOCUMENT: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Petstore", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {"200": {"description": "ok"}},
            }
        }
    },
}


def _url(reference: str) -> str:
    return f"/v1/tenants/acme/contracts/{reference}/suite"


def _manifest() -> ContractSuiteManifest:
    """A real compiled manifest, so the response model is exercised end to end."""
    return compile_contract_suite(OpenApiNormalizer().normalize(_DOCUMENT))


def _response(ok: bool = True) -> ContractSuiteResponse:
    return ContractSuiteResponse(
        ok=ok,
        version_ref="project/petstore/1.0.0",
        manifest=_manifest() if ok else None,
    )


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request and grant the permission the route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch("app.contract_suite_routes.enforce_permission", return_value="test-user-id"):
        yield
    app.dependency_overrides.clear()


# ===========================================================================
# Happy path
# ===========================================================================


def test_an_empty_body_compiles_the_whole_suite() -> None:
    """Every option has a usable default, so a bare POST is a valid request."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite", return_value=_response()
    ) as service:
        response = client.post(_url("project/petstore/1.0.0"), json={})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["manifest"]["digest"].startswith("sha256:")
    assert body["manifest"]["cases"]
    assert service.call_args.args[0] == "project/petstore/1.0.0"


def test_the_path_shaped_reference_reaches_the_service_intact() -> None:
    """The reference spans several path segments; the `:path` converter must keep them."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite", return_value=_response()
    ) as service:
        client.post(_url("catalog/legacy-orders/latest"), json={})

    assert service.call_args.args[0] == "catalog/legacy-orders/latest"


def test_options_are_forwarded_as_given() -> None:
    """The options are the suite's identity; the route must not reshape them."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite", return_value=_response()
    ) as service:
        client.post(
            _url("project/petstore/1.0.0"),
            json={"options": {"seed": 5, "include_negative": False, "operations": ["GET /pets"]}},
        )

    forwarded = service.call_args.args[1].options
    assert forwarded.seed == 5
    assert forwarded.include_negative is False
    assert forwarded.operations == ["GET /pets"]


def test_the_response_carries_every_field_a_runner_reads() -> None:
    """A runner must be able to execute from the response alone."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite", return_value=_response()
    ):
        body = client.post(_url("project/petstore/1.0.0"), json={}).json()

    case = body["manifest"]["cases"][0]
    assert set(case) >= {
        "case_id",
        "operation_key",
        "source",
        "synthetic",
        "request",
        "expect",
    }
    assert set(case["request"]) >= {"method", "path", "path_template", "has_body"}
    assert set(case["expect"]) >= {"outcome", "status_codes", "status_declared"}


# ===========================================================================
# Failure shapes
# ===========================================================================


def test_a_version_that_yields_no_suite_is_a_200_with_ok_false() -> None:
    """The intake convention: not-serviceable is an answer, not a server error."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite",
        return_value=ContractSuiteResponse(
            ok=False,
            version_ref="project/events/1.0.0",
            manifest=None,
            error=build_job_error("FORMAT_MISMATCH", "This version declares no operations."),
        ),
    ):
        response = client.post(_url("project/events/1.0.0"), json={})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["manifest"] is None
    assert body["error"]["code"] == "FORMAT_MISMATCH"


@pytest.mark.parametrize("status", [400, 404, 422])
def test_an_addressing_fault_is_an_http_error(status: int) -> None:
    """Malformed, invisible, and underivable references keep their own status codes."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite",
        side_effect=SchemaReferenceError("nope", status_code=status),
    ):
        response = client.post(_url("project/petstore/1.0.0"), json={})

    assert response.status_code == status
    assert response.json()["detail"]["message"] == "nope"


def test_reference_candidates_are_surfaced_for_a_near_miss() -> None:
    """"Did you mean" guidance beats a bare 404."""
    with patch(
        "app.contract_suite_routes.compile_version_contract_suite",
        side_effect=SchemaReferenceError("nope", status_code=404, candidates=["1.0.0"]),
    ):
        response = client.post(_url("project/petstore/9.9.9"), json={})

    assert response.json()["detail"]["candidates"] == ["1.0.0"]


def test_an_unknown_option_is_rejected_rather_than_ignored() -> None:
    """Silently ignoring an option would produce a suite the caller did not ask for."""
    response = client.post(
        _url("project/petstore/1.0.0"), json={"options": {"include_everything": True}}
    )
    assert response.status_code == 422


def test_an_out_of_range_option_is_rejected() -> None:
    """The bounds on the options are part of the contract, enforced before compilation."""
    response = client.post(
        _url("project/petstore/1.0.0"), json={"options": {"max_operations": 0}}
    )
    assert response.status_code == 422


# ===========================================================================
# Gating
# ===========================================================================


def test_the_endpoint_requires_the_versions_view_permission() -> None:
    """Compiling a contract reads a version; a caller who may not see it may not compile it."""
    from fastapi import HTTPException

    with patch(
        "app.contract_suite_routes.enforce_permission",
        side_effect=HTTPException(status_code=403, detail="forbidden"),
    ):
        response = client.post(_url("project/petstore/1.0.0"), json={})

    assert response.status_code == 403


def test_a_credential_with_no_tenant_context_is_refused() -> None:
    """Every lookup is tenant-scoped, so a tenant-less principal cannot compile anything."""
    app.dependency_overrides[validate_authentication] = lambda: {"user_id": "u"}
    response = client.post(_url("project/petstore/1.0.0"), json={})
    assert response.status_code == 403


def test_the_route_is_documented_in_the_openapi_surface() -> None:
    """The CLI and CI clients are generated against the committed contract."""
    schema = app.openapi()
    path = "/v1/tenants/{tenant_slug}/contracts/{version_ref}/suite"
    assert path in schema["paths"]
    assert "contract-assurance" in schema["paths"][path]["post"]["tags"]


def test_the_options_model_is_the_documented_request_shape() -> None:
    """A client generated from the spec must be able to send every option."""
    fields = set(ContractSuiteOptions.model_fields)
    assert {"seed", "include_declared_examples", "include_negative", "operations"} <= fields
    assert SuiteApiInfo.model_fields["servers"].description
