"""Tests for the schema-targets listing — IXH-5.3 (#5115).

``GET /v1/tenants/{tenant_slug}/schemas/{schema_ref}/targets`` feeds the Schema Test Bench's
picker: every named type a revision defines, and every operation request/response body that
resolves to one. Revision resolution itself is covered by ``test_schema_reference``; here the
resolution is faked and what is asserted is the listing's own contract — what is enumerated,
what is honestly skipped, the deterministic ordering, and the HTTP surface (gating, addressing
faults as HTTP errors).
"""

from __future__ import annotations

from typing import List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.main import app
from app.schema_reference import (
    ResolvedRevisionModel,
    SchemaReferenceError,
    parse_schema_reference,
    resolve_revision_model,
)
from app.schema_targets_service import SchemaTargetsResponse, list_schema_targets

client = TestClient(app)

_TENANT = "test-tenant-id"
_MOCK_AUTH = {"tenant_id": _TENANT, "user_id": "test-user-id", "auth_method": "jwt"}


# ===========================================================================
# Fixtures
# ===========================================================================


_PET = Type(key="acme.Pet", name="Pet", kind=TypeKind.RECORD)
_ORDER = Type(key="acme.Order", name="Order", kind=TypeKind.RECORD)
_STATUS = Type(key="acme.Status", name="Status", kind=TypeKind.ENUM)
# Two types sharing the source name "Tag": addressable by key only.
_TAG_A = Type(key="a.Tag", name="Tag", kind=TypeKind.RECORD)
_TAG_B = Type(key="b.Tag", name="Tag", kind=TypeKind.RECORD)


def _api(
    types: List[Type],
    operations: Optional[List[Operation]] = None,
) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="fixture"),
        types=types,
        services=(
            [Service(key="svc", name="svc", operations=operations)] if operations else []
        ),
    )


def _operation(
    key: str,
    messages: List[Message],
    *,
    method: Optional[str] = None,
    path: Optional[str] = None,
) -> Operation:
    return Operation(
        key=key,
        name=key.split("/")[-1] or key,
        kind=OperationKind.REQUEST_RESPONSE,
        http_method=method,
        http_path=path,
        messages=messages,
    )


def _revision(
    api: CanonicalApi,
    *,
    reference: str = "project/petstore/1.0.0",
    xml_schema_text: Optional[str] = None,
) -> ResolvedRevisionModel:
    parsed = parse_schema_reference(reference)
    return ResolvedRevisionModel(
        reference=parsed,
        api=api,
        coordinates={
            "kind": parsed.kind,
            "artifact_id": "artifact-1",
            "artifact_slug": "petstore",
            "revision_id": "revision-1",
            "version_label": "1.0.0",
            "source_format": "openapi",
        },
        source_format="openapi",
        xml_schema_text=xml_schema_text,
    )


def _targets(
    api: CanonicalApi,
    *,
    reference: str = "project/petstore/1.0.0",
    xml_schema_text: Optional[str] = None,
) -> SchemaTargetsResponse:
    with patch(
        "app.schema_targets_service.resolve_revision_model",
        return_value=_revision(api, reference=reference, xml_schema_text=xml_schema_text),
    ):
        return list_schema_targets(reference, tenant_id=_TENANT)


# ===========================================================================
# Types listing
# ===========================================================================


def test_types_are_listed_sorted_by_key_with_their_kind() -> None:
    """Every named type is a target, sorted by stable key, carrying its structural kind."""
    response = _targets(_api([_STATUS, _PET, _ORDER]))

    assert response.ok is True
    assert [(t.key, t.name, t.kind) for t in response.types] == [
        ("acme.Order", "Order", "record"),
        ("acme.Pet", "Pet", "record"),
        ("acme.Status", "Status", "enum"),
    ]


def test_a_revision_with_no_types_lists_nothing_and_is_not_an_error() -> None:
    """An empty listing is a truthful answer, not a failure."""
    response = _targets(_api([]))

    assert response.ok is True
    assert response.types == []
    assert response.operation_bodies == []


def test_source_coordinates_are_echoed_back() -> None:
    """The caller can confirm which revision was enumerated."""
    response = _targets(_api([_PET]))

    assert response.source.kind == "project"
    assert response.source.projected is True
    assert response.source.coordinates["revision_id"] == "revision-1"
    assert response.schema_ref == "project/petstore/1.0.0"


def test_xml_backed_revision_is_flagged() -> None:
    """An XSD-backed revision validates whole documents at the bare reference."""
    assert _targets(_api([_PET]), xml_schema_text="<xs:schema/>").xml_document is True
    assert _targets(_api([_PET])).xml_document is False


# ===========================================================================
# Operation bodies
# ===========================================================================


def test_request_and_response_bodies_resolve_to_their_named_types() -> None:
    """Bodies referencing a named type are addressable targets with their HTTP coordinates."""
    operation = _operation(
        "POST /orders",
        [
            Message(key="POST /orders#request", role=MessageRole.REQUEST, payload=TypeRef(name="Order")),
            Message(
                key="POST /orders#response.201",
                role=MessageRole.RESPONSE,
                status_code="201",
                payload=TypeRef(name="acme.Order"),
            ),
        ],
        method="POST",
        path="/orders",
    )
    response = _targets(_api([_ORDER, _PET], [operation]))

    assert [(b.role, b.type_key, b.status_code) for b in response.operation_bodies] == [
        ("request", "acme.Order", None),
        ("response", "acme.Order", "201"),
    ]
    body = response.operation_bodies[0]
    assert (body.http_method, body.http_path) == ("POST", "/orders")
    assert body.operation_key == "POST /orders"


def test_a_list_wrapped_body_unwraps_to_its_element_type_and_says_so() -> None:
    """``[Pet]`` is addressable as ``Pet``, flagged so the UI can label the wrapper."""
    operation = _operation(
        "GET /pets",
        [
            Message(
                key="GET /pets#response.200",
                role=MessageRole.RESPONSE,
                status_code="200",
                payload=TypeRef(item=TypeRef(name="Pet", nullable=False)),
            )
        ],
    )
    response = _targets(_api([_PET], [operation]))

    assert len(response.operation_bodies) == 1
    body = response.operation_bodies[0]
    assert (body.type_key, body.list_wrapped) == ("acme.Pet", True)


def test_error_and_event_messages_are_not_operation_bodies() -> None:
    """The Test Bench scope is request/response; other roles are neither listed nor counted."""
    operation = _operation(
        "POST /orders",
        [
            Message(key="e", role=MessageRole.ERROR, payload=TypeRef(name="Order")),
            Message(key="v", role=MessageRole.EVENT, payload=TypeRef(name="Order")),
        ],
    )
    response = _targets(_api([_ORDER], [operation]))

    assert response.operation_bodies == []
    assert response.diagnostics == []


def test_inline_and_primitive_bodies_are_counted_not_invented() -> None:
    """A body with no addressable named type is skipped and reported in a diagnostic."""
    operation = _operation(
        "POST /notes",
        [
            # Inline schema only — the grammar cannot address it.
            Message(key="r1", role=MessageRole.REQUEST, payload_schema={"type": "object"}),
            # A primitive ref resolves to no named type.
            Message(key="r2", role=MessageRole.RESPONSE, payload=TypeRef(name="string")),
            # No payload at all (204-style) — not a body, not counted.
            Message(key="r3", role=MessageRole.RESPONSE, status_code="204"),
        ],
    )
    response = _targets(_api([_ORDER], [operation]))

    assert response.operation_bodies == []
    assert len(response.diagnostics) == 1
    assert "2 operation bodies" in response.diagnostics[0].message


def test_an_ambiguous_source_name_is_only_addressable_by_key() -> None:
    """Two types named ``Tag``: a name ref is refused (counted), a key ref resolves."""
    operation = _operation(
        "GET /tags",
        [
            Message(key="r1", role=MessageRole.RESPONSE, payload=TypeRef(name="Tag")),
            Message(key="r2", role=MessageRole.REQUEST, payload=TypeRef(name="a.Tag")),
        ],
    )
    response = _targets(_api([_TAG_A, _TAG_B], [operation]))

    assert [(b.role, b.type_key) for b in response.operation_bodies] == [("request", "a.Tag")]
    assert len(response.diagnostics) == 1
    assert "1 operation body is" in response.diagnostics[0].message


def test_operation_bodies_are_deterministically_ordered() -> None:
    """Sorted by operation key, then role, then status code — byte-identical across calls."""
    op_b = _operation(
        "GET /b",
        [
            Message(key="b200", role=MessageRole.RESPONSE, status_code="200", payload=TypeRef(name="Pet")),
            Message(key="breq", role=MessageRole.REQUEST, payload=TypeRef(name="Pet")),
        ],
    )
    op_a = _operation(
        "GET /a",
        [
            Message(key="a404", role=MessageRole.RESPONSE, status_code="404", payload=TypeRef(name="Pet")),
            Message(key="a200", role=MessageRole.RESPONSE, status_code="200", payload=TypeRef(name="Pet")),
        ],
    )
    response = _targets(_api([_PET], [op_b, op_a]))

    assert [(b.operation_key, b.role, b.status_code) for b in response.operation_bodies] == [
        ("GET /a", "response", "200"),
        ("GET /a", "response", "404"),
        ("GET /b", "request", None),
        ("GET /b", "response", "200"),
    ]


# ===========================================================================
# Addressing rules
# ===========================================================================


def test_a_type_qualified_reference_is_a_400() -> None:
    """Targets enumerate a whole revision; a type segment is the caller's mistake, said plainly."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        list_schema_targets("project/petstore/1.0.0/Pet", tenant_id=_TENANT)

    assert excinfo.value.status_code == 400
    assert "drop the trailing type segment" in str(excinfo.value)


def test_a_registry_reference_is_a_400() -> None:
    """A registry type is one stored schema, already enumerated by the type-registry API."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        list_schema_targets("registry/std/v0/primitives/email", tenant_id=_TENANT)

    assert excinfo.value.status_code == 400


def test_resolve_revision_model_rejects_registry_references() -> None:
    """The revision-model seam itself refuses registry references, not just the service."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        resolve_revision_model(
            parse_schema_reference("registry/std/v0/primitives/email"), tenant_id=_TENANT
        )

    assert excinfo.value.status_code == 400


# ===========================================================================
# HTTP contract
# ===========================================================================


@pytest.fixture()
def _auth():
    """Authenticate every request and grant the permission the route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch("app.schema_targets_routes.enforce_permission", return_value="test-user-id"):
        yield
    app.dependency_overrides.clear()


def _url(reference: str) -> str:
    return f"/v1/tenants/acme/schemas/{reference}/targets"


def test_route_returns_the_listing(_auth: None) -> None:
    """The path-shaped reference reaches the service intact and the listing comes back."""
    operation = _operation(
        "GET /pets",
        [Message(key="r", role=MessageRole.RESPONSE, status_code="200", payload=TypeRef(name="Pet"))],
    )
    with patch(
        "app.schema_targets_service.resolve_revision_model",
        return_value=_revision(_api([_PET], [operation]), reference="catalog/legacy/latest"),
    ) as resolver:
        response = client.get(_url("catalog/legacy/latest"))

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["schema_ref"] == "catalog/legacy/latest"
    assert [t["key"] for t in payload["types"]] == ["acme.Pet"]
    assert payload["operation_bodies"][0]["type_key"] == "acme.Pet"
    assert resolver.call_args.args[0].raw == "catalog/legacy/latest"


def test_addressing_faults_are_http_errors_with_candidates(_auth: None) -> None:
    """400/404/422 map through, and candidates ride along in the detail."""
    assert client.get(_url("registry/std/v0/primitives/email")).status_code == 400
    assert client.get(_url("project/petstore/1.0.0/Pet")).status_code == 400

    with patch(
        "app.schema_targets_service.resolve_revision_model",
        side_effect=SchemaReferenceError(
            "gone", status_code=404, candidates=["Pet", "Owner"]
        ),
    ):
        response = client.get(_url("project/ghost/latest"))

    assert response.status_code == 404
    assert response.json()["detail"]["candidates"] == ["Pet", "Owner"]


def test_route_requires_a_tenant_context(_auth: None) -> None:
    """A credential with no tenant cannot enumerate anything."""
    app.dependency_overrides[validate_authentication] = lambda: {"user_id": "u"}
    try:
        response = client.get(_url("project/petstore/latest"))
    finally:
        app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH

    assert response.status_code == 403


def test_route_is_gated_on_types_view() -> None:
    """Without ``types:view`` the route refuses before resolving anything."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    try:
        from fastapi import HTTPException

        with patch(
            "app.schema_targets_routes.enforce_permission",
            side_effect=HTTPException(status_code=403, detail="forbidden"),
        ):
            response = client.get(_url("project/petstore/latest"))
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 403
