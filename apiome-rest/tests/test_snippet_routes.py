"""Route tests for the authenticated SDK-2.3 snippet endpoint (#4487).

Exercises ``GET /v1/versions/{tenant}/{project}/{version}/snippets/{operation_id}`` with the
database and canonical loader patched (no live Postgres): per-language rendering and aliases,
lang/operation validation, the published gate, tenant/project scoping, the missing-canonical
fallback, the non-HTTP-operation 422, and ETag / 304 conditional caching.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    TypeRef,
)
from app.main import app

client = TestClient(app)

_TENANT = "t1"
_PROJECT_ID = "22222222-2222-4222-8222-222222222222"
_VERSION_ID = "11111111-1111-4111-8111-111111111111"
_BASE = f"/v1/versions/acme/{_PROJECT_ID}/{_VERSION_ID}/snippets"
_MOCK_JWT = {"tenant_id": _TENANT, "user_id": "user-a", "email": "a@example.com", "auth_method": "jwt"}


def _project(**overrides):
    row = {"id": _PROJECT_ID, "slug": "pet-store", "name": "Pet Store"}
    row.update(overrides)
    return row


def _version(**overrides):
    row = {
        "id": _VERSION_ID,
        "project_id": _PROJECT_ID,
        "version_id": "1.0.0",
        "published": True,
        "visibility": "public",
    }
    row.update(overrides)
    return row


def _canonical() -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Pet Store"),
        servers=[Server(url="https://api.pets.dev/v1")],
        services=[
            Service(
                key="pets",
                name="pets",
                operations=[
                    Operation(
                        key="GET /pets/{petId}",
                        name="getPet",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="get",
                        http_path="/pets/{petId}",
                        extras={"operationId": "getPet"},
                        parameters=[
                            Parameter(
                                key="GET /pets/{petId}#path.petId",
                                name="petId",
                                location=ParameterLocation.PATH,
                                type=TypeRef(name="string"),
                                required=True,
                            ),
                            Parameter(
                                key="GET /pets/{petId}#header.X-API-Key",
                                name="X-API-Key",
                                location=ParameterLocation.HEADER,
                                type=TypeRef(name="string"),
                                required=True,
                            ),
                        ],
                    ),
                    Operation(
                        key="Query.pets",
                        name="petsQuery",
                        kind=OperationKind.QUERY,
                    ),
                ],
            )
        ],
    )


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: dict(_MOCK_JWT)
    yield
    app.dependency_overrides.pop(validate_authentication, None)


@pytest.fixture
def fake_db():
    """A MagicMock db with the accessors the route uses, patched into the route module."""
    db = MagicMock()
    db.get_project_by_id.return_value = _project()
    db.get_version_by_id.return_value = _version()
    with patch("app.snippet_routes.db", db), patch(
        "app.snippet_routes.load_canonical_api", return_value=_canonical()
    ):
        yield db


# -------------------------------------------------------------------------- happy path


def test_curl_snippet(fake_db) -> None:
    resp = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "private, max-age=300"
    assert resp.headers["etag"].startswith('"')
    body = resp.json()
    assert body["lang"] == "curl"
    assert body["install"] is None
    assert body["code"] == (
        "curl 'https://api.pets.dev/v1/pets/PET_ID' -H 'X-API-Key: $API_KEY'"
    )
    assert body["operation"] == {
        "operation_id": "getPet",
        "name": "getPet",
        "key": "GET /pets/{petId}",
        "method": "GET",
        "path": "/pets/{petId}",
    }
    assert body["request"]["headers"] == {"X-API-Key": "$API_KEY"}
    kinds = {(p["kind"], p["token"]) for p in body["placeholders"]}
    assert ("path", "PET_ID") in kinds
    assert ("secret", "$API_KEY") in kinds


def test_python_snippet_has_install(fake_db) -> None:
    resp = client.get(f"{_BASE}/getPet", params={"lang": "python"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["install"] == "pip install httpx"
    assert body["code"].startswith("import httpx")


def test_ts_snippet(fake_db) -> None:
    resp = client.get(f"{_BASE}/getPet", params={"lang": "ts"})
    assert resp.status_code == 200
    assert resp.json()["code"].startswith("const response = await fetch(")


@pytest.mark.parametrize(("alias", "canonical"), [("fetch", "ts"), ("httpx", "python")])
def test_lang_aliases_echo_canonical(fake_db, alias, canonical) -> None:
    resp = client.get(f"{_BASE}/getPet", params={"lang": alias})
    assert resp.status_code == 200
    assert resp.json()["lang"] == canonical


def test_operation_addressable_by_encoded_key(fake_db) -> None:
    # Canonical keys contain spaces/slashes; `operation_id` is a `:path` parameter, so the
    # URL-encoded key survives routing and resolves for paradigms without operationIds.
    resp = client.get(f"{_BASE}/GET%20%2Fpets%2F%7BpetId%7D", params={"lang": "curl"})
    assert resp.status_code == 200
    assert resp.json()["operation"]["key"] == "GET /pets/{petId}"


# -------------------------------------------------------------------------- validation


def test_missing_lang_is_422(fake_db) -> None:
    resp = client.get(f"{_BASE}/getPet")
    assert resp.status_code == 422


def test_unknown_lang_is_400(fake_db) -> None:
    resp = client.get(f"{_BASE}/getPet", params={"lang": "go"})
    assert resp.status_code == 400
    assert "Unknown lang" in resp.json()["detail"]


def test_unknown_operation_is_404(fake_db) -> None:
    resp = client.get(f"{_BASE}/nope", params={"lang": "curl"})
    assert resp.status_code == 404
    assert "Operation not found" in resp.json()["detail"]


def test_non_http_operation_is_422(fake_db) -> None:
    resp = client.get(f"{_BASE}/petsQuery", params={"lang": "curl"})
    assert resp.status_code == 422
    assert "HTTP" in resp.json()["detail"]


# -------------------------------------------------------------------------- gating


def test_invalid_project_id_is_400(fake_db) -> None:
    resp = client.get(
        f"/v1/versions/acme/not-a-uuid/{_VERSION_ID}/snippets/getPet", params={"lang": "curl"}
    )
    assert resp.status_code == 400


def test_unknown_project_is_404(fake_db) -> None:
    fake_db.get_project_by_id.return_value = None
    resp = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert resp.status_code == 404


def test_non_uuid_version_is_404(fake_db) -> None:
    resp = client.get(
        f"/v1/versions/acme/{_PROJECT_ID}/not-a-uuid/snippets/getPet", params={"lang": "curl"}
    )
    assert resp.status_code == 404


def test_unknown_version_is_404(fake_db) -> None:
    fake_db.get_version_by_id.return_value = None
    resp = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert resp.status_code == 404


def test_cross_project_version_is_404(fake_db) -> None:
    fake_db.get_version_by_id.return_value = _version(
        project_id="33333333-3333-4333-8333-333333333333"
    )
    resp = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert resp.status_code == 404


def test_unpublished_version_is_400(fake_db) -> None:
    fake_db.get_version_by_id.return_value = _version(published=False)
    resp = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert resp.status_code == 400
    assert "published" in resp.json()["detail"]


def test_missing_canonical_is_404(fake_db) -> None:
    with patch("app.snippet_routes.load_canonical_api", return_value=None):
        resp = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert resp.status_code == 404
    assert "Operation not found" in resp.json()["detail"]


# -------------------------------------------------------------------------- caching


def test_etag_roundtrip_304(fake_db) -> None:
    first = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    assert first.status_code == 200
    etag = first.headers["etag"]

    second = client.get(
        f"{_BASE}/getPet", params={"lang": "curl"}, headers={"If-None-Match": etag}
    )
    assert second.status_code == 304
    assert second.headers["etag"] == etag
    assert second.content == b""


def test_etag_weak_prefix_and_list(fake_db) -> None:
    first = client.get(f"{_BASE}/getPet", params={"lang": "curl"})
    etag = first.headers["etag"]
    second = client.get(
        f"{_BASE}/getPet",
        params={"lang": "curl"},
        headers={"If-None-Match": f'W/"other", W/{etag}'},
    )
    assert second.status_code == 304
