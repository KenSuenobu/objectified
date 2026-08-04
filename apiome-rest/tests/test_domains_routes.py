"""Domain folder REST surface — DUW-1.1 (private-suite#2568).

Route-level tests over :mod:`app.domains_routes`, following the ``test_project_tags_api.py``
precedent: a module-level ``TestClient``, auth supplied through the dependency override, and the
store and database patched *where used*.

The ticket's acceptance criteria are proven by :class:`TestAcceptance`, which walks a domain
through its whole life — create, rename, fill, delete — and checks the one thing the roadmap says
must never happen: that deleting a folder deletes what was in it.

The claims nothing below is allowed to weaken:

* **Tenancy is resolved through the version, on every route.** A domain in another tenant's catalog
  is a 404, not a 403 — this API does not confirm that another tenant's version exists.
* **A cross-version move is refused before it reaches the database.** V242's guard would catch it
  anyway, but as a 500; the caller is owed a 404 that says which assumption was wrong.
* **`shared/` is always listed and never editable.** It is the folder every unassigned item is in,
  including in a version that has no domains at all.
* **`domain_id: null` and `"shared"` are the same request.**
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication

# The store is patched wholesale so route logic is tested in isolation, but its pure helpers carry
# rules the routes depend on (what a legal slug is, what `shared` means). The real ones are
# substituted back into the mock so those rules cannot be mocked into always agreeing.
from app.domains_store import DomainConflictError, DomainScopeError
from app.domains_store import is_valid_slug as _real_is_valid_slug
from app.domains_store import resolve_domain_id as _real_resolve_domain_id
from app.domains_store import shared_bucket as _real_shared_bucket
from app.domains_store import slugify as _real_slugify
from app.main import app

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
VERSION = "22222222-2222-2222-2222-222222222222"
OTHER_VERSION = "22222222-2222-2222-2222-2222222222ff"
DOMAIN = "33333333-3333-3333-3333-333333333333"
CLASS = "44444444-4444-4444-4444-444444444444"
PATH = "55555555-5555-5555-5555-555555555555"

_MOCK_JWT: Dict[str, Any] = {
    "auth_method": "jwt",
    "user_id": "66666666-6666-6666-6666-666666666666",
    "tenant_id": TENANT,
}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


@pytest.fixture(autouse=True)
def _permissions():
    """Permission checks are exercised by their own suite; here they always pass."""
    with patch("app.domains_routes.enforce_permission"):
        yield


def domain_row(**overrides) -> Dict[str, Any]:
    row = {
        "id": DOMAIN,
        "version_id": VERSION,
        "name": "customers",
        "slug": "customers",
        "sort_order": 0,
        "deleted_at": None,
        "created_at": "2026-08-04T00:00:00Z",
        "updated_at": "2026-08-04T00:00:00Z",
    }
    row.update(overrides)
    return row


class TestListDomains:
    def test_it_appends_the_virtual_shared_bucket_last(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.list_domains.return_value = [
                domain_row(),
                domain_row(slug="billing", name="billing", sort_order=1),
            ]
            mock_store.shared_bucket.side_effect = _real_shared_bucket
            response = client.get(f"/v1/domains/acme/version/{VERSION}")

        assert response.status_code == 200
        body = response.json()
        assert [d["slug"] for d in body] == ["customers", "billing", "shared"]

        shared = body[-1]
        assert shared["id"] is None
        assert shared["virtual"] is True
        # It sorts after every real domain, where the mockup draws it.
        assert shared["sort_order"] == 2

    def test_real_domains_are_not_flagged_virtual(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.list_domains.return_value = [domain_row()]
            mock_store.shared_bucket.side_effect = _real_shared_bucket
            body = client.get(f"/v1/domains/acme/version/{VERSION}").json()

        assert body[0]["virtual"] is False
        assert body[0]["id"] == DOMAIN

    def test_shared_sorts_past_sparse_explicit_orders(self):
        # Sort orders are caller-supplied and need not be dense. Using the row count would give
        # shared/ a sort_order of 2 here and a client re-sorting the list would hoist it above
        # `billing`.
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.list_domains.return_value = [
                domain_row(sort_order=0),
                domain_row(slug="billing", name="billing", sort_order=9),
            ]
            mock_store.shared_bucket.side_effect = _real_shared_bucket
            body = client.get(f"/v1/domains/acme/version/{VERSION}").json()

        assert body[-1]["slug"] == "shared"
        assert body[-1]["sort_order"] == 10
        assert body[-1]["sort_order"] > max(d["sort_order"] for d in body[:-1])

    def test_a_version_with_no_domains_is_all_shared(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.list_domains.return_value = []
            mock_store.shared_bucket.side_effect = _real_shared_bucket
            body = client.get(f"/v1/domains/acme/version/{VERSION}").json()

        assert len(body) == 1
        assert body[0]["slug"] == "shared"

    def test_another_tenants_version_is_not_found(self):
        with patch("app.domains_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = None
            response = client.get(f"/v1/domains/acme/version/{VERSION}")

        assert response.status_code == 404
        # The tenant is what scopes the lookup, not a separate authorization step.
        mock_db.get_version_by_id.assert_called_once_with(VERSION, TENANT)


class TestCreateDomain:
    def test_it_creates_and_returns_201(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.next_sort_order.return_value = 3
            mock_store.create_domain.return_value = domain_row(sort_order=3)
            mock_store.slugify.side_effect = _real_slugify
            mock_store.is_valid_slug.side_effect = _real_is_valid_slug
            response = client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": "Customers"})

        assert response.status_code == 201
        _, kwargs = mock_store.create_domain.call_args
        # The slug is derived from the name when none is supplied.
        assert kwargs["slug"] == "customers"
        assert kwargs["sort_order"] == 3

    def test_an_explicit_sort_order_wins_over_the_computed_one(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.create_domain.return_value = domain_row(sort_order=0)
            mock_store.slugify.side_effect = _real_slugify
            mock_store.is_valid_slug.side_effect = _real_is_valid_slug
            client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": "Customers", "sort_order": 0})

        _, kwargs = mock_store.create_domain.call_args
        assert kwargs["sort_order"] == 0
        mock_store.next_sort_order.assert_not_called()

    @pytest.mark.parametrize("name", ["", "   "])
    def test_a_blank_name_is_rejected(self, name: str):
        with patch("app.domains_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": name})

        assert response.status_code == 400
        assert "required" in response.json()["detail"].lower()

    def test_a_name_that_yields_no_slug_is_rejected(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.slugify.side_effect = _real_slugify
            response = client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": "!!!"})

        assert response.status_code == 400
        assert "slug" in response.json()["detail"].lower()

    @pytest.mark.parametrize("slug", ["shared", "Not A Slug", "under_score", "-leading"])
    def test_a_malformed_or_reserved_slug_is_rejected(self, slug: str):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.is_valid_slug.side_effect = _real_is_valid_slug
            response = client.post(
                f"/v1/domains/acme/version/{VERSION}", json={"name": "Anything", "slug": slug}
            )

        assert response.status_code == 400

    def test_naming_a_domain_shared_is_rejected(self):
        # `shared/` is the derived bucket; a stored domain claiming it would draw two different
        # memberships as one folder.
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.slugify.side_effect = _real_slugify
            response = client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": "Shared"})

        assert response.status_code == 400

    def test_a_duplicate_is_a_409(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.next_sort_order.return_value = 0
            mock_store.slugify.side_effect = _real_slugify
            mock_store.is_valid_slug.side_effect = _real_is_valid_slug
            mock_store.DomainConflictError = DomainConflictError
            mock_store.create_domain.side_effect = DomainConflictError("slug", "customers")
            response = client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": "Customers"})

        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]


class TestUpdateDomain:
    def test_it_renames(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            mock_store.update_domain.return_value = domain_row(name="Customer accounts")
            response = client.patch(f"/v1/domains/acme/{DOMAIN}", json={"name": "Customer accounts"})

        assert response.status_code == 200
        assert response.json()["name"] == "Customer accounts"
        _, kwargs = mock_store.update_domain.call_args
        # A rename supplies no slug, so the URL the slug forms does not move underneath anyone.
        assert kwargs["slug"] is None

    def test_a_blank_rename_is_rejected(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            response = client.patch(f"/v1/domains/acme/{DOMAIN}", json={"name": "   "})

        assert response.status_code == 400

    def test_an_explicit_slug_is_validated(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            mock_store.is_valid_slug.side_effect = _real_is_valid_slug
            response = client.patch(f"/v1/domains/acme/{DOMAIN}", json={"slug": "shared"})

        assert response.status_code == 400

    def test_another_tenants_domain_is_not_found(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = None
            mock_store.get_domain.return_value = domain_row()
            response = client.patch(f"/v1/domains/acme/{DOMAIN}", json={"name": "Mine now"})

        assert response.status_code == 404
        mock_store.update_domain.assert_not_called()

    def test_a_deleted_domain_is_not_found(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = None
            response = client.patch(f"/v1/domains/acme/{DOMAIN}", json={"name": "Ghost"})

        assert response.status_code == 404


class TestDeleteDomain:
    def test_it_reports_what_moved_to_shared(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            mock_store.count_members.return_value = {"class_count": 3, "path_count": 4}
            mock_store.delete_domain.return_value = domain_row(deleted_at="2026-08-04T00:00:00Z")
            mock_store.SHARED_DOMAIN_ID = "shared"
            response = client.delete(f"/v1/domains/acme/{DOMAIN}")

        assert response.status_code == 200
        assert response.json() == {
            "success": True,
            "reassigned_to": "shared",
            "classes_reassigned": 3,
            "paths_reassigned": 4,
        }

    def test_members_are_counted_before_the_delete(self):
        # Afterwards they are in shared/ and indistinguishable from what was already there.
        calls = []
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            mock_store.count_members.side_effect = lambda *a, **k: (
                calls.append("count") or {"class_count": 1, "path_count": 0}
            )
            mock_store.delete_domain.side_effect = lambda *a, **k: (calls.append("delete") or domain_row())
            mock_store.SHARED_DOMAIN_ID = "shared"
            client.delete(f"/v1/domains/acme/{DOMAIN}")

        assert calls == ["count", "delete"]

    def test_deleting_a_folder_needs_edit_not_delete_on_versions(self):
        # Removing a folder removes no content, so it is gated as editing work. Requiring "may
        # delete a version" would stop an editor undoing a folder they were allowed to create.
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store, patch(
            "app.domains_routes.enforce_permission"
        ) as mock_enforce:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            mock_store.count_members.return_value = {"class_count": 0, "path_count": 0}
            mock_store.delete_domain.return_value = domain_row()
            mock_store.SHARED_DOMAIN_ID = "shared"
            client.delete(f"/v1/domains/acme/{DOMAIN}")

        _, resource, action = mock_enforce.call_args[0][1:]
        assert (resource, action) == ("versions", "edit")

    def test_deleting_twice_is_not_found(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_domain.return_value = domain_row()
            mock_store.count_members.return_value = {"class_count": 0, "path_count": 0}
            mock_store.delete_domain.return_value = None
            response = client.delete(f"/v1/domains/acme/{DOMAIN}")

        assert response.status_code == 404


class TestAssignment:
    def _member_patches(self, mock_store, mock_db, *, member, version_id=VERSION):
        mock_db.get_version_by_id.return_value = {"id": version_id}
        mock_store.get_class.return_value = member
        mock_store.get_path.return_value = member
        mock_store.get_domain.return_value = domain_row()
        mock_store.resolve_domain_id.side_effect = _real_resolve_domain_id

    def test_a_class_moves_into_a_domain(self):
        member = {"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None}
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            self._member_patches(mock_store, mock_db, member=member)
            mock_store.assign_class.return_value = {**member, "domain_id": DOMAIN}
            response = client.put(f"/v1/domains/acme/classes/{CLASS}", json={"domain_id": DOMAIN})

        assert response.status_code == 200
        assert response.json() == {
            "id": CLASS,
            "version_id": VERSION,
            "name": "Customer",
            "domain_id": DOMAIN,
            "kind": "class",
        }

    def test_a_path_moves_into_a_domain_and_reports_its_pathname(self):
        member = {"id": PATH, "version_id": VERSION, "pathname": "/v1/customers", "domain_id": None}
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            self._member_patches(mock_store, mock_db, member=member)
            mock_store.assign_path.return_value = {**member, "domain_id": DOMAIN}
            response = client.put(f"/v1/domains/acme/paths/{PATH}", json={"domain_id": DOMAIN})

        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "/v1/customers"
        assert body["kind"] == "path"

    @pytest.mark.parametrize("payload", [{"domain_id": None}, {"domain_id": "shared"}])
    def test_both_spellings_of_shared_release_the_member(self, payload):
        member = {"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": DOMAIN}
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            self._member_patches(mock_store, mock_db, member=member)
            mock_store.assign_class.return_value = {**member, "domain_id": None}
            response = client.put(f"/v1/domains/acme/classes/{CLASS}", json=payload)

        assert response.status_code == 200
        assert response.json()["domain_id"] is None
        _, kwargs = mock_store.assign_class.call_args
        assert kwargs["domain_id"] is None

    def test_omitting_domain_id_is_a_validation_error_not_a_move_to_shared(self):
        # Required rather than optional, so a client that forgot the field is told, instead of
        # silently emptying a folder.
        response = client.put(f"/v1/domains/acme/classes/{CLASS}", json={})
        assert response.status_code == 422

    def test_a_cross_version_move_is_refused_with_404(self):
        member = {"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None}
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            self._member_patches(mock_store, mock_db, member=member)
            # The destination domain lives in a different version of the same tenant.
            mock_store.get_domain.return_value = domain_row(version_id=OTHER_VERSION)
            response = client.put(f"/v1/domains/acme/classes/{CLASS}", json={"domain_id": DOMAIN})

        assert response.status_code == 404
        assert "different version" in response.json()["detail"]
        mock_store.assign_class.assert_not_called()

    def test_a_missing_class_is_not_found(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_class.return_value = None
            response = client.put(f"/v1/domains/acme/classes/{CLASS}", json={"domain_id": None})

        assert response.status_code == 404

    def test_a_missing_path_is_not_found(self):
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.get_path.return_value = None
            response = client.put(f"/v1/domains/acme/paths/{PATH}", json={"domain_id": None})

        assert response.status_code == 404

    def test_another_tenants_class_is_not_found(self):
        member = {"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None}
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = None
            mock_store.get_class.return_value = member
            response = client.put(f"/v1/domains/acme/classes/{CLASS}", json={"domain_id": None})

        assert response.status_code == 404
        mock_store.assign_class.assert_not_called()

    def test_the_database_guard_surfaces_as_404_not_500(self):
        member = {"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None}
        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            self._member_patches(mock_store, mock_db, member=member)
            mock_store.DomainScopeError = DomainScopeError
            mock_store.assign_class.side_effect = DomainScopeError("That domain does not exist.")
            response = client.put(f"/v1/domains/acme/classes/{CLASS}", json={"domain_id": DOMAIN})

        assert response.status_code == 404


class TestAcceptance:
    """The ticket's round trip: domains CRUD and reassignment, with content never lost."""

    def test_a_domain_lives_and_dies_without_taking_its_contents(self):
        catalog = {"classes": {CLASS: None}, "paths": {PATH: None}}

        with patch("app.domains_routes.db") as mock_db, patch("app.domains_routes.store") as mock_store:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_store.slugify.side_effect = _real_slugify
            mock_store.is_valid_slug.side_effect = _real_is_valid_slug
            mock_store.resolve_domain_id.side_effect = _real_resolve_domain_id
            mock_store.shared_bucket.side_effect = _real_shared_bucket
            mock_store.SHARED_DOMAIN_ID = "shared"
            mock_store.next_sort_order.return_value = 0

            # 1. Nothing but shared/ to begin with.
            mock_store.list_domains.return_value = []
            assert [d["slug"] for d in client.get(f"/v1/domains/acme/version/{VERSION}").json()] == ["shared"]

            # 2. Create `customers/`.
            mock_store.create_domain.return_value = domain_row()
            created = client.post(f"/v1/domains/acme/version/{VERSION}", json={"name": "Customers"})
            assert created.status_code == 201
            domain_id = created.json()["id"]

            # 3. Rename it; the id and therefore every membership survives.
            mock_store.get_domain.return_value = domain_row()
            mock_store.update_domain.return_value = domain_row(name="Customer accounts")
            renamed = client.patch(f"/v1/domains/acme/{domain_id}", json={"name": "Customer accounts"})
            assert renamed.json()["id"] == domain_id

            # 4. File one class and one path under it.
            mock_store.get_class.return_value = {
                "id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None,
            }
            mock_store.assign_class.side_effect = lambda db, *, class_id, domain_id: (
                catalog["classes"].__setitem__(class_id, domain_id)
                or {"id": class_id, "version_id": VERSION, "name": "Customer", "domain_id": domain_id}
            )
            mock_store.get_path.return_value = {
                "id": PATH, "version_id": VERSION, "pathname": "/v1/customers", "domain_id": None,
            }
            mock_store.assign_path.side_effect = lambda db, *, path_id, domain_id: (
                catalog["paths"].__setitem__(path_id, domain_id)
                or {"id": path_id, "version_id": VERSION, "pathname": "/v1/customers", "domain_id": domain_id}
            )

            assert client.put(f"/v1/domains/acme/classes/{CLASS}", json={"domain_id": domain_id}).status_code == 200
            assert client.put(f"/v1/domains/acme/paths/{PATH}", json={"domain_id": domain_id}).status_code == 200
            assert catalog == {"classes": {CLASS: domain_id}, "paths": {PATH: domain_id}}

            # 5. Delete the domain. V242's release trigger nulls the memberships; the API reports
            #    the count, and the members themselves still exist.
            mock_store.count_members.return_value = {"class_count": 1, "path_count": 1}

            def _release(db, *, domain_id):
                for bucket in catalog.values():
                    for key, value in bucket.items():
                        if value == domain_id:
                            bucket[key] = None
                return domain_row(deleted_at="2026-08-04T00:00:00Z")

            mock_store.delete_domain.side_effect = _release
            deleted = client.delete(f"/v1/domains/acme/{domain_id}")

            assert deleted.status_code == 200
            assert deleted.json()["classes_reassigned"] == 1
            assert deleted.json()["paths_reassigned"] == 1

            # The members are still here — in shared/, not gone.
            assert set(catalog["classes"]) == {CLASS}
            assert set(catalog["paths"]) == {PATH}
            assert catalog == {"classes": {CLASS: None}, "paths": {PATH: None}}
