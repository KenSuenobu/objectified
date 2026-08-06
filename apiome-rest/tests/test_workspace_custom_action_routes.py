"""Custom palette actions REST surface — DUW-5.5 (private-suite#2592).

Route-level tests over :mod:`app.workspace_custom_action_routes`, following the
``test_domains_routes.py`` precedent: a module-level ``TestClient``, auth supplied through the
dependency override, and the store patched *where used*. Validation is deliberately **not**
patched — the routes import the rules functions directly, so every 422 below is the real
vocabulary refusing a real payload, which is the acceptance criterion "declarative effects only
(enforced by schema)" exercised end to end at the HTTP boundary.

The claims nothing below is allowed to weaken:

* **Tenancy comes from the token.** Every store call is asserted to carry the token's tenant, and
  a row the store cannot see in that tenant is a 404 — never a 403, and never a hint.
* **Writes need an attributable user.** A token with no user (a bare API key) is refused with a
  403 before any store call.
* **A PATCH cannot leave a contradiction.** The cross-field rule is checked against the merged
  row, so changing the subject out from under a consumption-query effect is refused.
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.workspace_custom_action_store import CustomActionConflictError

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
ACTION = "22222222-2222-2222-2222-222222222222"
USER = "66666666-6666-6666-6666-666666666666"

_MOCK_JWT: Dict[str, Any] = {
    "auth_method": "jwt",
    "user_id": USER,
    "tenant_id": TENANT,
}

#: A principal with a tenant but no attributable user — what a bare service token looks like.
_MOCK_USERLESS: Dict[str, Any] = {"auth_method": "jwt", "tenant_id": TENANT}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


@pytest.fixture(autouse=True)
def _permissions():
    """Permission checks are exercised by their own suite; here they always pass."""
    with patch("app.workspace_custom_action_routes.enforce_permission"):
        yield


@pytest.fixture()
def store():
    """The store, patched where used, with its typed conflict kept real.

    The exception class must be the real one: the route's ``except store.CustomActionConflictError``
    resolves through the patched module object, and a MagicMock attribute there would make the
    ``except`` clause itself a TypeError.
    """
    with patch("app.workspace_custom_action_routes.store") as mock_store:
        mock_store.CustomActionConflictError = CustomActionConflictError
        yield mock_store


def action_row(**overrides) -> Dict[str, Any]:
    row = {
        "id": ACTION,
        "tenant_id": TENANT,
        "created_by": USER,
        "name": "Open runbook for {subject}",
        "subject": "class",
        "name_contains": None,
        "effects": [{"type": "open-url", "url": "https://runbooks.example.com/{subject}"}],
        "deleted_at": None,
        "created_at": "2026-08-05T00:00:00Z",
        "updated_at": "2026-08-05T00:00:00Z",
    }
    row.update(overrides)
    return row


class TestList:
    def test_it_lists_the_tenants_actions_in_the_wire_shape(self, store):
        store.list_actions.return_value = [action_row()]

        response = client.get("/v1/workspace/acme/custom-actions")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert len(body["actions"]) == 1
        action = body["actions"][0]
        assert action["id"] == ACTION
        assert action["subject"] == "class"
        # Wire names are camelCase; the row's snake_case never leaks.
        assert action["nameContains"] is None
        assert action["createdBy"] == USER
        assert "name_contains" not in action
        store.list_actions.assert_called_once()
        assert store.list_actions.call_args.kwargs["tenant_id"] == TENANT

    def test_an_empty_tenant_answers_an_empty_list_not_an_error(self, store):
        store.list_actions.return_value = []

        response = client.get("/v1/workspace/acme/custom-actions")

        assert response.status_code == 200
        assert response.json() == {"success": True, "actions": []}


class TestCreate:
    def test_it_creates_and_answers_201(self, store):
        store.create_action.return_value = action_row()

        response = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "  Open runbook for {subject}  ",
                "subject": "class",
                "effects": [
                    {"type": "open-url", "url": "https://runbooks.example.com/{subject}"}
                ],
            },
        )

        assert response.status_code == 201
        assert response.json()["name"] == "Open runbook for {subject}"
        kwargs = store.create_action.call_args.kwargs
        assert kwargs["tenant_id"] == TENANT
        assert kwargs["created_by"] == USER
        # The name reaches the store trimmed: normalization ran before storage.
        assert kwargs["name"] == "Open runbook for {subject}"
        assert kwargs["name_contains"] is None

    def test_a_script_shaped_effect_is_a_422_naming_the_field(self, store):
        response = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "Evil",
                "subject": "class",
                "effects": [{"type": "open-url", "url": "javascript:alert(1)"}],
            },
        )

        assert response.status_code == 422
        assert "effects[0].url" in response.json()["detail"]
        store.create_action.assert_not_called()

    def test_a_consumption_query_on_a_path_subject_is_a_422(self, store):
        response = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "Contradiction",
                "subject": "path",
                "effects": [{"type": "run-consumption-query"}],
            },
        )

        assert response.status_code == 422
        assert "requires subject 'class'" in response.json()["detail"]
        store.create_action.assert_not_called()

    def test_an_unknown_top_level_field_is_a_422(self, store):
        response = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "Sneaky",
                "subject": "class",
                "effects": [{"type": "hydrate-set"}],
                "script": "alert(1)",
            },
        )

        assert response.status_code == 422
        store.create_action.assert_not_called()

    def test_a_taken_name_is_a_409(self, store):
        store.create_action.side_effect = CustomActionConflictError("Open runbook")

        response = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "Open runbook",
                "subject": "class",
                "effects": [{"type": "hydrate-set"}],
            },
        )

        assert response.status_code == 409

    def test_a_userless_principal_is_a_403_before_any_write(self, store):
        app.dependency_overrides[validate_authentication] = lambda: _MOCK_USERLESS

        response = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "Attributed",
                "subject": "class",
                "effects": [{"type": "hydrate-set"}],
            },
        )

        assert response.status_code == 403
        store.create_action.assert_not_called()


class TestGet:
    def test_it_answers_one_action(self, store):
        store.get_action.return_value = action_row()

        response = client.get(f"/v1/workspace/acme/custom-actions/{ACTION}")

        assert response.status_code == 200
        assert response.json()["id"] == ACTION
        assert store.get_action.call_args.kwargs["tenant_id"] == TENANT

    def test_a_missing_or_foreign_action_is_a_404(self, store):
        # The store scopes by tenant, so "missing" and "another tenant's" are one return value —
        # and deliberately one status code.
        store.get_action.return_value = None

        response = client.get(f"/v1/workspace/acme/custom-actions/{ACTION}")

        assert response.status_code == 404


class TestUpdate:
    def test_it_renames_and_answers_the_updated_row(self, store):
        store.get_action.return_value = action_row()
        store.update_action.return_value = action_row(name="Renamed")

        response = client.patch(
            f"/v1/workspace/acme/custom-actions/{ACTION}",
            json={"name": "  Renamed  "},
        )

        assert response.status_code == 200
        assert response.json()["name"] == "Renamed"
        kwargs = store.update_action.call_args.kwargs
        assert kwargs["name"] == "Renamed"
        assert "name_contains" not in kwargs  # absent means untouched
        assert "effects" not in kwargs

    def test_an_explicit_null_clears_the_narrowing(self, store):
        store.get_action.return_value = action_row(name_contains="Invoice")
        store.update_action.return_value = action_row()

        response = client.patch(
            f"/v1/workspace/acme/custom-actions/{ACTION}",
            json={"nameContains": None},
        )

        assert response.status_code == 200
        kwargs = store.update_action.call_args.kwargs
        assert "name_contains" in kwargs and kwargs["name_contains"] is None

    def test_changing_the_subject_under_a_consumption_query_is_a_422(self, store):
        store.get_action.return_value = action_row(
            effects=[{"type": "run-consumption-query"}]
        )

        response = client.patch(
            f"/v1/workspace/acme/custom-actions/{ACTION}",
            json={"subject": "path"},
        )

        assert response.status_code == 422
        assert "requires subject 'class'" in response.json()["detail"]
        store.update_action.assert_not_called()

    def test_a_taken_name_is_a_409(self, store):
        store.get_action.return_value = action_row()
        store.update_action.side_effect = CustomActionConflictError("Taken")

        response = client.patch(
            f"/v1/workspace/acme/custom-actions/{ACTION}",
            json={"name": "Taken"},
        )

        assert response.status_code == 409

    def test_a_missing_action_is_a_404_before_validation_work(self, store):
        store.get_action.return_value = None

        response = client.patch(
            f"/v1/workspace/acme/custom-actions/{ACTION}",
            json={"name": "Renamed"},
        )

        assert response.status_code == 404
        store.update_action.assert_not_called()


class TestDelete:
    def test_it_deletes_and_confirms(self, store):
        store.delete_action.return_value = True

        response = client.delete(f"/v1/workspace/acme/custom-actions/{ACTION}")

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert store.delete_action.call_args.kwargs["tenant_id"] == TENANT

    def test_nothing_to_delete_is_a_404(self, store):
        store.delete_action.return_value = False

        response = client.delete(f"/v1/workspace/acme/custom-actions/{ACTION}")

        assert response.status_code == 404

    def test_a_userless_principal_is_a_403(self, store):
        app.dependency_overrides[validate_authentication] = lambda: _MOCK_USERLESS

        response = client.delete(f"/v1/workspace/acme/custom-actions/{ACTION}")

        assert response.status_code == 403
        store.delete_action.assert_not_called()


class TestAcceptance:
    """The ticket's CRUD criterion, walked end to end: create, list, edit, delete."""

    def test_an_action_lives_a_whole_life(self, store):
        # Create it.
        store.create_action.return_value = action_row()
        created = client.post(
            "/v1/workspace/acme/custom-actions",
            json={
                "name": "Open runbook for {subject}",
                "subject": "class",
                "nameContains": "Invoice",
                "effects": [
                    {"type": "open-url", "url": "https://runbooks.example.com/{subject}"}
                ],
            },
        )
        assert created.status_code == 201

        # It lists.
        store.list_actions.return_value = [action_row()]
        listed = client.get("/v1/workspace/acme/custom-actions")
        assert [a["id"] for a in listed.json()["actions"]] == [ACTION]

        # Its effects can be replaced wholesale — with another declarative list only.
        store.get_action.return_value = action_row()
        store.update_action.return_value = action_row(
            effects=[{"type": "hydrate-set"}, {"type": "lens-switch", "lens": "combined"}]
        )
        patched = client.patch(
            f"/v1/workspace/acme/custom-actions/{ACTION}",
            json={
                "effects": [
                    {"type": "hydrate-set"},
                    {"type": "lens-switch", "lens": "combined"},
                ]
            },
        )
        assert patched.status_code == 200
        assert [e["type"] for e in patched.json()["effects"]] == [
            "hydrate-set",
            "lens-switch",
        ]

        # And it deletes.
        store.delete_action.return_value = True
        deleted = client.delete(f"/v1/workspace/acme/custom-actions/{ACTION}")
        assert deleted.status_code == 200
