"""Public dereference of a registry type at its ``$id`` (``GET /types/{path}``).

A registry ``$id`` looks like a URL (``https://api.apiome.dev/types/std/v0/primitives/array``) and is
what relative ``$ref`` edges resolve against, but nothing served it — so following a ``$ref`` from
outside the product 404'd. This endpoint serves those documents.

It is unauthenticated, so the tests below concentrate on the boundary: **only** ``is_system`` AND
``is_public`` rows are servable, and every miss is indistinguishable from every other miss so the
route cannot be used to enumerate what a tenant owns.
"""

from typing import Any, Dict, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.public_types_routes import SCHEMA_MEDIA_TYPE
from app.schema_validation import REGISTRY_BASE_URL

client = TestClient(app)

_ARRAY_ID = f"{REGISTRY_BASE_URL}std/v0/primitives/array"
_ARRAY_DOC = {
    "$id": _ARRAY_ID,
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "array",
    "title": "Array",
}

_PUBLIC_ROW: Dict[str, Any] = {
    "id": "11111111-1111-1111-1111-111111111111",
    "tenant_id": "22222222-2222-2222-2222-222222222222",
    "name": "array",
    "namespace": "std/v0/primitives",
    "schema_id": _ARRAY_ID,
    "schema": _ARRAY_DOC,
    "is_system": True,
    "is_public": True,
}


def _only_array(schema_id: str) -> Optional[Dict[str, Any]]:
    """Stand in for the DB gate: the array core type is public, nothing else resolves."""
    return _PUBLIC_ROW if schema_id == _ARRAY_ID else None


class TestServingAPublicType:
    def test_serves_the_stored_document_at_its_id_path(self):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get("/types/std/v0/primitives/array")

        assert response.status_code == 200
        assert response.json() == _ARRAY_DOC

    def test_rebuilds_the_exact_id_the_registry_derived(self):
        """The lookup key must be the ``$id``, so this agrees with ``$ref`` resolution by construction."""
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            client.get("/types/std/v0/primitives/array")

        mdb.get_public_type_by_schema_id.assert_called_once_with(_ARRAY_ID)

    def test_uses_the_json_schema_media_type(self):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get("/types/std/v0/primitives/array")

        assert response.headers["content-type"].startswith(SCHEMA_MEDIA_TYPE)

    def test_is_cacheable_since_core_types_are_identical_for_every_caller(self):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get("/types/std/v0/primitives/array")

        assert "max-age" in response.headers["cache-control"]

    def test_needs_no_authentication(self):
        """No Authorization header, no API key — the whole point of the route."""
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get("/types/std/v0/primitives/array", headers={})

        assert response.status_code == 200

    def test_tolerates_a_trailing_slash(self):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get("/types/std/v0/primitives/array/")

        assert response.status_code == 200


class TestTheVisibilityBoundary:
    """An unauthenticated route: what it refuses matters more than what it serves."""

    @pytest.mark.parametrize(
        "row",
        [
            pytest.param({**_PUBLIC_ROW, "is_system": False}, id="tenant-owned"),
            pytest.param({**_PUBLIC_ROW, "is_public": False}, id="private-system"),
            pytest.param({**_PUBLIC_ROW, "is_system": False, "is_public": False}, id="tenant-private"),
        ],
    )
    def test_only_the_db_gate_decides_visibility(self, row):
        """The route trusts the gated accessor; a row failing either flag never reaches it.

        This pins the contract between the two halves: the accessor filters on
        ``is_system AND is_public``, so a non-public row simply is not returned. The route must not
        add a second, weaker rule of its own that could serve one.
        """
        with patch("app.public_types_routes.db") as mdb:
            # Simulate the accessor honouring its filter for this row.
            mdb.get_public_type_by_schema_id.return_value = (
                row if row["is_system"] and row["is_public"] else None
            )
            response = client.get("/types/std/v0/primitives/array")

        assert response.status_code == 404

    def test_a_tenant_namespace_is_never_servable(self):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get("/types/tenant/acme/v1/types/charge")

        assert response.status_code == 404

    def test_a_tenant_path_is_indistinguishable_from_a_nonexistent_one(self):
        """Different 404 bodies would leak whether a given ``$id`` exists."""
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.return_value = None
            tenant = client.get("/types/tenant/acme/v1/types/charge")
            bogus = client.get("/types/tenant/acme/v1/types/does-not-exist")

        assert tenant.status_code == bogus.status_code == 404
        # Only the echoed path differs; no field says "exists but forbidden".
        assert set(tenant.json()) == set(bogus.json())
        assert "forbidden" not in tenant.text.lower()

    @pytest.mark.parametrize("path", ["", "/", "///"])
    def test_an_empty_path_resolves_to_nothing(self, path):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            response = client.get(f"/types/{path}")

        assert response.status_code == 404
        # No lookup is attempted for a path that cannot name a type.
        mdb.get_public_type_by_schema_id.assert_not_called()

    def test_does_not_expose_the_row_beyond_its_schema_document(self):
        """Only the document is returned — not tenant_id, usage counts, or other columns."""
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.side_effect = _only_array
            body = client.get("/types/std/v0/primitives/array").json()

        assert body == _ARRAY_DOC
        assert "tenant_id" not in body
        assert "is_system" not in body

    def test_reports_a_data_fault_rather_than_serving_a_non_document(self):
        with patch("app.public_types_routes.db") as mdb:
            mdb.get_public_type_by_schema_id.return_value = {**_PUBLIC_ROW, "schema": None}
            response = client.get("/types/std/v0/primitives/array")

        assert response.status_code == 500


class TestItDoesNotShadowTheAuthenticatedApi:
    def test_the_tenant_scoped_types_api_is_untouched(self):
        """``/v1/types/...`` must still route to the authenticated management endpoints."""
        paths = [route.path for route in app.routes]
        assert "/v1/types/{tenant_slug}/namespaces" in paths
        # The public route is mounted at the bare prefix so it matches an `$id` byte for byte.
        assert "/types/{schema_path:path}" in paths
