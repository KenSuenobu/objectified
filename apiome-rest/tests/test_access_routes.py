"""API tests for the Access & IAM routes (#3611): roles, members, audit, platform override."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication, validate_session_credentials
from app.main import app

client = TestClient(app)

_AUTH = {
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "user_id": "22222222-2222-2222-2222-222222222222",
    "auth_method": "jwt",
    "user_email": "owner@acme.io",
}

_ROLE_EDITOR = {
    "id": "role-editor",
    "slug": "editor",
    "name": "Editor",
    "description": "Edit content",
    "is_builtin": True,
    "member_count": 12,
}
_ROLE_CUSTOM = {
    "id": "role-rm",
    "slug": "release-manager",
    "name": "Release Manager",
    "description": "Publish versions",
    "is_builtin": False,
    "member_count": 2,
}


@pytest.fixture(autouse=True)
def _auth_override():
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    app.dependency_overrides[validate_session_credentials] = lambda: _AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)
    app.dependency_overrides.pop(validate_session_credentials, None)


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


def test_list_roles_returns_grids_and_counts():
    with patch("app.access_routes.db") as mdb:
        mdb.list_roles.return_value = [_ROLE_EDITOR, _ROLE_CUSTOM]
        mdb.get_role_permissions.return_value = [
            {"resource": "versions", "action": "view"},
            {"resource": "versions", "action": "publish"},
        ]
        r = client.get("/v1/access/acme/roles")
    assert r.status_code == 200
    body = r.json()
    assert [x["slug"] for x in body] == ["editor", "release-manager"]
    assert body[0]["member_count"] == 12
    assert {"resource": "versions", "action": "publish"} in body[0]["permissions"]
    mdb.ensure_builtin_roles.assert_called_once_with(_AUTH["tenant_id"])


def test_create_role_rejects_invalid_permission():
    with patch("app.access_routes.db") as mdb:
        r = client.post(
            "/v1/access/acme/roles",
            json={"name": "Bad", "permissions": [{"resource": "versions", "action": "frobnicate"}]},
        )
    assert r.status_code == 400
    mdb.create_role.assert_not_called()


def test_create_role_persists_grid_and_audits():
    with patch("app.access_routes.db") as mdb:
        mdb.create_role.return_value = {**_ROLE_CUSTOM}
        mdb.get_role_permissions.return_value = [{"resource": "versions", "action": "publish"}]
        r = client.post(
            "/v1/access/acme/roles",
            json={
                "name": "Release Manager",
                "description": "Publish versions",
                "permissions": [
                    {"resource": "versions", "action": "publish"},
                    {"resource": "versions", "action": "view"},
                ],
            },
        )
    assert r.status_code == 200
    assert r.json()["slug"] == "release-manager"
    # Slug derived from the name.
    args = mdb.create_role.call_args.args
    assert args[1] == "release-manager"
    mdb.set_role_permissions.assert_called_once()
    assert mdb.write_access_audit.call_args.kwargs["action"] == "role.created"


def test_update_builtin_role_keeps_name_and_logs_permission_change():
    with patch("app.access_routes.db") as mdb:
        mdb.get_role.return_value = {**_ROLE_EDITOR}
        # Existing grid has view+create; request drops create, adds delete.
        mdb.get_role_permissions.return_value = [
            {"resource": "classes", "action": "view"},
            {"resource": "classes", "action": "create"},
        ]
        mdb.update_role.return_value = {**_ROLE_EDITOR}
        r = client.put(
            "/v1/access/acme/roles/role-editor",
            json={
                "name": "Renamed (ignored for builtin)",
                "permissions": [
                    {"resource": "classes", "action": "view"},
                    {"resource": "classes", "action": "delete"},
                ],
            },
        )
    assert r.status_code == 200
    # Built-in name is immutable: update_role called with the original name.
    assert mdb.update_role.call_args.args[2] == "Editor"
    audit = mdb.write_access_audit.call_args.kwargs
    assert audit["action"] == "permission.changed"
    assert audit["detail"]["granted"] == ["classes:delete"]
    assert audit["detail"]["revoked"] == ["classes:create"]


def test_delete_builtin_role_forbidden():
    with patch("app.access_routes.db") as mdb:
        mdb.get_role.return_value = {**_ROLE_EDITOR}
        r = client.delete("/v1/access/acme/roles/role-editor")
    assert r.status_code == 400
    mdb.delete_role.assert_not_called()


def test_delete_custom_role_ok():
    with patch("app.access_routes.db") as mdb:
        mdb.get_role.return_value = {**_ROLE_CUSTOM}
        r = client.delete("/v1/access/acme/roles/role-rm")
    assert r.status_code == 204
    mdb.delete_role.assert_called_once()


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


def _seat_available(ldb, used=1, limit=5):
    """Configure the license-capacity db mock with `used` of `limit` seats occupied."""
    ldb.get_tenant_license_seats.return_value = {"max_users_per_tenant": limit}
    ldb.count_member_seats_in_use.return_value = used


def test_invite_unknown_account_404():
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        _seat_available(ldb)
        mdb.get_user_by_email.return_value = None
        r = client.post("/v1/access/acme/members", json={"email": "ghost@nowhere.com"})
    assert r.status_code == 404
    mdb.add_member.assert_not_called()


def test_invite_existing_account_assigns_role():
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        _seat_available(ldb)
        mdb.get_user_by_email.return_value = {"id": "u-9", "email": "noah@partner.com"}
        mdb.get_role.return_value = {**_ROLE_CUSTOM}
        r = client.post(
            "/v1/access/acme/members",
            json={"email": "noah@partner.com", "role_id": "role-rm"},
        )
    assert r.status_code == 200
    mdb.add_member.assert_called_once()
    mdb.assign_member_role.assert_called_once()
    assert mdb.write_access_audit.call_args.kwargs["action"] == "member.invited"


def test_invite_blocked_when_seats_exhausted():
    # OLO-5.3 (#4213): the 6th non-suspended member on a 5-seat license is refused
    # with the structured code before any lookup or membership write happens.
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        _seat_available(ldb, used=5, limit=5)
        r = client.post("/v1/access/acme/members", json={"email": "noah@partner.com"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "license-seats-exhausted"
    mdb.get_user_by_email.assert_not_called()
    mdb.add_member.assert_not_called()


def test_suspend_member_audits():
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        mdb.set_member_status.return_value = 1
        r = client.patch("/v1/access/acme/members/u-9", json={"status": "suspended"})
    assert r.status_code == 200
    mdb.set_member_status.assert_called_once_with(_AUTH["tenant_id"], "u-9", "suspended")
    assert mdb.write_access_audit.call_args.kwargs["action"] == "member.suspended"
    # Suspending frees a seat; it must never consult the capacity guard.
    ldb.count_member_seats_in_use.assert_not_called()


def test_reinstate_blocked_when_seats_exhausted():
    # OLO-5.3 (#4213): a suspended member doesn't hold a seat, so reinstating one
    # consumes a seat and is refused at capacity (blocks the suspend → invite →
    # reinstate bypass).
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        _seat_available(ldb, used=5, limit=5)
        mdb.get_member_status.return_value = "suspended"
        r = client.patch("/v1/access/acme/members/u-9", json={"status": "active"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "license-seats-exhausted"
    mdb.set_member_status.assert_not_called()


def test_reinstate_allowed_with_free_seat():
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        _seat_available(ldb, used=4, limit=5)
        mdb.get_member_status.return_value = "suspended"
        mdb.set_member_status.return_value = 1
        r = client.patch("/v1/access/acme/members/u-9", json={"status": "active"})
    assert r.status_code == 200
    mdb.set_member_status.assert_called_once_with(_AUTH["tenant_id"], "u-9", "active")
    assert mdb.write_access_audit.call_args.kwargs["action"] == "member.reinstated"


def test_status_change_between_seated_states_skips_capacity_check():
    # active → pending (or re-asserting active) never consumes a new seat, so the
    # guard is not consulted even when the tenant is at capacity.
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        _seat_available(ldb, used=5, limit=5)
        mdb.get_member_status.return_value = "active"
        mdb.set_member_status.return_value = 1
        r = client.patch("/v1/access/acme/members/u-9", json={"status": "pending"})
    assert r.status_code == 200
    ldb.count_member_seats_in_use.assert_not_called()


def test_update_member_rejects_bad_status():
    with patch("app.access_routes.db") as mdb:
        r = client.patch("/v1/access/acme/members/u-9", json={"status": "banished"})
    assert r.status_code == 400
    mdb.set_member_status.assert_not_called()


def test_resend_invite_restamps_pending_membership_and_audits():
    # HIVE-5.2 (#5305): re-issuing renews the pending row and records who renewed it.
    with patch("app.access_routes.db") as mdb, patch("app.license_capacity.db") as ldb:
        mdb.touch_pending_membership.return_value = 1
        r = client.post("/v1/access/acme/members/u-9/resend-invite")
    assert r.status_code == 200
    assert r.json() == {"user_id": "u-9", "status": "pending"}
    mdb.touch_pending_membership.assert_called_once_with(_AUTH["tenant_id"], "u-9")
    assert mdb.write_access_audit.call_args.kwargs["action"] == "member.invite_resent"
    # The pending membership already holds its seat, so no capacity check is owed.
    ldb.count_member_seats_in_use.assert_not_called()


def test_resend_invite_404_when_not_a_member():
    with patch("app.access_routes.db") as mdb:
        mdb.touch_pending_membership.return_value = 0
        mdb.get_member_status.return_value = None
        r = client.post("/v1/access/acme/members/u-nope/resend-invite")
    assert r.status_code == 404
    mdb.write_access_audit.assert_not_called()


def test_resend_invite_409_when_membership_is_not_pending():
    # An already-accepted invitation has nothing outstanding to renew, and saying so is
    # a different message from "no such member".
    with patch("app.access_routes.db") as mdb:
        mdb.touch_pending_membership.return_value = 0
        mdb.get_member_status.return_value = "active"
        r = client.post("/v1/access/acme/members/u-9/resend-invite")
    assert r.status_code == 409
    assert "no outstanding invitation" in r.json()["detail"]
    mdb.write_access_audit.assert_not_called()


def test_offboard_member_ok():
    with patch("app.access_routes.db") as mdb:
        mdb.remove_member.return_value = 1
        r = client.delete("/v1/access/acme/members/u-9")
    assert r.status_code == 204
    assert mdb.write_access_audit.call_args.kwargs["action"] == "member.offboarded"


# ---------------------------------------------------------------------------
# Audit + self permissions
# ---------------------------------------------------------------------------


def test_list_audit_filter_maps_to_prefix():
    with patch("app.access_routes.db") as mdb:
        mdb.list_access_audit.return_value = []
        client.get("/v1/access/acme/audit?filter=role")
        assert mdb.list_access_audit.call_args.kwargs["action_prefix"] == "role."


def test_export_audit_csv():
    with patch("app.access_routes.db") as mdb:
        mdb.list_access_audit.return_value = [
            {
                "created_at": "2026-06-23T10:00:00Z",
                "actor_label": "dana@acme.io",
                "action": "role.assigned",
                "target": "priya@acme.io",
                "source": "web",
            }
        ]
        r = client.get("/v1/access/acme/audit/export")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "role.assigned" in r.text
    assert "when,actor,event,target,source" in r.text


def test_permissions_me_admin_sees_everything():
    with patch("app.access_routes.db") as mdb:
        mdb.is_user_tenant_admin.return_value = True
        r = client.get("/v1/access/acme/permissions/me")
    assert r.status_code == 200
    body = r.json()
    assert body["is_admin"] is True
    assert "versions:publish" in body["permissions"]


def test_denied_when_guard_rejects():
    with patch("app.access_routes.db") as mdb:
        mdb.user_has_permission.return_value = False
        mdb.is_user_tenant_admin.return_value = False
        r = client.post("/v1/access/acme/roles", json={"name": "X", "permissions": []})
    assert r.status_code == 403
    mdb.create_role.assert_not_called()


# ---------------------------------------------------------------------------
# Platform-admin plane
# ---------------------------------------------------------------------------


def test_platform_override_requires_platform_admin():
    with patch("app.access_routes.db") as mdb:
        mdb.is_platform_admin.return_value = False
        r = client.post(
            "/v1/platform/access-overrides",
            json={"tenant_id": _AUTH["tenant_id"], "target": "billing@1.0.0"},
        )
    assert r.status_code == 403
    mdb.write_access_audit.assert_not_called()


def test_platform_override_records_admin_override():
    with patch("app.access_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.post(
            "/v1/platform/access-overrides",
            json={"tenant_id": _AUTH["tenant_id"], "target": "billing@1.0.0", "detail": {"why": "support"}},
        )
    assert r.status_code == 201
    kwargs = mdb.write_access_audit.call_args.kwargs
    assert kwargs["action"] == "admin.override"
    assert kwargs["source"] == "admin"
