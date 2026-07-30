"""API tests for the type-registry Namespace CRUD endpoints (#3451).

Covers list / create / update for ``/v1/types/{tenant_slug}/namespaces``: auth requirements,
tenant scoping, scope rules (system-core read-only; tenant-admin writes), validation, conflict
handling, base-uri/version-root derivation, and the default flag.
"""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

# ---------------------------------------------------------------------------
# Shared auth fixtures
# ---------------------------------------------------------------------------

_JWT_ADMIN = {"tenant_id": "t1", "user_id": "admin-user", "auth_method": "jwt"}
_JWT_NON_ADMIN = {"tenant_id": "t1", "user_id": "plain-user", "auth_method": "jwt"}

_NOW = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)

_SYSTEM_NS_ROW = {
    "id": "ns-sys",
    "tenant_id": None,
    "namespace": "std/v0/types",
    "base_uri": "https://api.apiome.dev/types/std/v0/types/",
    "version_root": "v0",
    "description": "std types",
    "is_system": True,
    "is_public": True,
    "is_default": True,
    "created_by": None,
    "created_at": _NOW,
    "updated_at": _NOW,
    "type_count": 9,
}

_TENANT_NS_ROW = {
    "id": "ns-acme",
    "tenant_id": "t1",
    "namespace": "tenant/acme/v1/types",
    "base_uri": "https://api.apiome.dev/types/tenant/acme/v1/types/",
    "version_root": "v1",
    "description": None,
    "is_system": False,
    "is_public": False,
    "is_default": False,
    "created_by": "admin-user",
    "created_at": _NOW,
    "updated_at": _NOW,
    "type_count": 3,
}


@pytest.fixture(autouse=True)
def _default_auth():
    """Default to JWT admin; individual tests may override."""
    app.dependency_overrides[validate_authentication] = lambda: _JWT_ADMIN
    yield
    app.dependency_overrides.pop(validate_authentication, None)


# ===========================================================================
# LIST
# ===========================================================================


def test_list_namespaces_ok():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.list_type_namespaces.return_value = [_SYSTEM_NS_ROW, _TENANT_NS_ROW]
        r = client.get("/v1/types/acme/namespaces")
    assert r.status_code == 200
    items = r.json()
    assert [i["namespace"] for i in items] == ["std/v0/types", "tenant/acme/v1/types"]
    assert items[0]["scope"] == "system"
    assert items[0]["type_count"] == 9
    assert items[1]["scope"] == "tenant"
    assert items[1]["tenant_id"] == "t1"


def test_list_namespaces_scoped_to_caller_tenant():
    """The DB layer is called with the tenant_id from the token, not the URL slug."""
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.list_type_namespaces.return_value = []
        client.get("/v1/types/some-other-slug/namespaces")
        mdb.list_type_namespaces.assert_called_once_with("t1")


def test_list_namespaces_requires_authentication():
    app.dependency_overrides.pop(validate_authentication, None)
    r = client.get("/v1/types/acme/namespaces")
    assert r.status_code == 401


# ===========================================================================
# CREATE
# ===========================================================================


def test_create_namespace_ok_derives_base_uri_and_version_root():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_path.return_value = None
        created = {**_TENANT_NS_ROW, "namespace": "tenant/acme/v2/payments",
                   "base_uri": "https://api.apiome.dev/types/tenant/acme/v2/payments/",
                   "version_root": "v2", "type_count": 0}
        mdb.create_type_namespace.return_value = created
        r = client.post(
            "/v1/types/acme/namespaces",
            json={"namespace": "tenant/acme/v2/payments"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["namespace"] == "tenant/acme/v2/payments"
    # Derived when omitted by the client.
    kwargs = mdb.create_type_namespace.call_args.kwargs
    assert kwargs["base_uri"] == "https://api.apiome.dev/types/tenant/acme/v2/payments/"
    assert kwargs["version_root"] == "v2"
    assert kwargs["is_system"] is False
    assert kwargs["is_public"] is False
    assert kwargs["tenant_id"] == "t1"


def test_create_namespace_requires_admin():
    app.dependency_overrides[validate_authentication] = lambda: _JWT_NON_ADMIN
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = False
        r = client.post("/v1/types/acme/namespaces", json={"namespace": "tenant/acme/v1/x"})
    assert r.status_code == 403
    mdb.create_type_namespace.assert_not_called()


def test_create_system_namespace_forbidden():
    """No platform-admin role exists; system namespaces cannot be created via the API."""
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        r = client.post(
            "/v1/types/acme/namespaces",
            json={"namespace": "std/v2/types", "scope": "system"},
        )
    assert r.status_code == 403
    mdb.create_type_namespace.assert_not_called()


def test_create_tenant_namespace_in_std_root_forbidden():
    """The std/* root is reserved for system-core; a tenant create there is rejected."""
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_path.return_value = None
        r = client.post("/v1/types/acme/namespaces", json={"namespace": "std/v9/types"})
    assert r.status_code == 403
    mdb.create_type_namespace.assert_not_called()


def test_create_namespace_invalid_path_400():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        r = client.post("/v1/types/acme/namespaces", json={"namespace": "Bad Namespace!"})
    assert r.status_code == 400
    mdb.create_type_namespace.assert_not_called()


def test_create_namespace_duplicate_409():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_path.return_value = _TENANT_NS_ROW
        r = client.post(
            "/v1/types/acme/namespaces",
            json={"namespace": "tenant/acme/v1/types"},
        )
    assert r.status_code == 409
    mdb.create_type_namespace.assert_not_called()


def test_create_namespace_default_passed_through():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_path.return_value = None
        mdb.create_type_namespace.return_value = {**_TENANT_NS_ROW, "is_default": True}
        r = client.post(
            "/v1/types/acme/namespaces",
            json={"namespace": "tenant/acme/v1/types", "is_default": True},
        )
    assert r.status_code == 200
    assert mdb.create_type_namespace.call_args.kwargs["is_default"] is True


# ===========================================================================
# UPDATE
# ===========================================================================


def test_update_namespace_ok():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _TENANT_NS_ROW
        mdb.update_type_namespace.return_value = {**_TENANT_NS_ROW, "description": "updated"}
        r = client.put(
            "/v1/types/acme/namespaces/ns-acme",
            json={"description": "updated", "is_default": True},
        )
    assert r.status_code == 200
    assert r.json()["description"] == "updated"
    updates = mdb.update_type_namespace.call_args.args[2]
    assert updates.get("is_default") is True


def test_update_namespace_requires_admin():
    app.dependency_overrides[validate_authentication] = lambda: _JWT_NON_ADMIN
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = False
        r = client.put("/v1/types/acme/namespaces/ns-acme", json={"description": "x"})
    assert r.status_code == 403
    mdb.update_type_namespace.assert_not_called()


def test_update_system_namespace_forbidden():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _SYSTEM_NS_ROW
        r = client.put("/v1/types/acme/namespaces/ns-sys", json={"description": "x"})
    assert r.status_code == 403
    mdb.update_type_namespace.assert_not_called()


def test_update_namespace_not_found_404():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = None
        r = client.put("/v1/types/acme/namespaces/missing", json={"description": "x"})
    assert r.status_code == 404
    mdb.update_type_namespace.assert_not_called()


def test_update_namespace_empty_base_uri_400():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _TENANT_NS_ROW
        r = client.put("/v1/types/acme/namespaces/ns-acme", json={"base_uri": "   "})
    assert r.status_code == 400
    mdb.update_type_namespace.assert_not_called()


# ===========================================================================
# DELETE
# ===========================================================================


def test_delete_namespace_ok_reports_unregistered_types():
    """Removing a registration leaves its types in place, and says how many that is."""
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _TENANT_NS_ROW
        mdb.delete_type_namespace.return_value = True
        r = client.delete("/v1/types/acme/namespaces/ns-acme")
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["namespace"] == "tenant/acme/v1/types"
    assert body["unregistered_type_count"] == 3
    # The write is scoped by the token's tenant, not the URL slug.
    assert mdb.delete_type_namespace.call_args.args == ("ns-acme", "t1")


def test_delete_namespace_does_not_touch_its_types():
    """The list is referential: no primitive is deleted or rewritten by removing a namespace."""
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _TENANT_NS_ROW
        mdb.delete_type_namespace.return_value = True
        r = client.delete("/v1/types/acme/namespaces/ns-acme")
    assert r.status_code == 200
    mdb.delete_primitive.assert_not_called()
    mdb.update_primitive.assert_not_called()


def test_delete_namespace_requires_admin():
    app.dependency_overrides[validate_authentication] = lambda: _JWT_NON_ADMIN
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = False
        r = client.delete("/v1/types/acme/namespaces/ns-acme")
    assert r.status_code == 403
    mdb.delete_type_namespace.assert_not_called()


def test_delete_system_namespace_forbidden():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _SYSTEM_NS_ROW
        r = client.delete("/v1/types/acme/namespaces/ns-sys")
    assert r.status_code == 403
    mdb.delete_type_namespace.assert_not_called()


def test_delete_namespace_not_found_404():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = None
        r = client.delete("/v1/types/acme/namespaces/missing")
    assert r.status_code == 404
    mdb.delete_type_namespace.assert_not_called()


def test_delete_namespace_vanished_between_read_and_write_404():
    """A concurrent delete leaves the row gone by the time the write runs."""
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        mdb.get_type_namespace_by_id.return_value = _TENANT_NS_ROW
        mdb.delete_type_namespace.return_value = False
        r = client.delete("/v1/types/acme/namespaces/ns-acme")
    assert r.status_code == 404
