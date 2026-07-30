"""API tests for the per-tenant publish/save validation gate (#3479).

The draft 2020-12 validator (#3452) is always available; this gate decides *whether* a
schema's meta-schema errors block persistence, driven by the tenant's type-registry
settings (#3472):

* ``validate_on_save`` — run the meta-schema check at all.
* ``block_publish_on_errors`` — reject (422) when that check finds errors.

Default (no saved settings) keeps the gate fully on, so invalid types are rejected exactly
as before the gate existed. Relaxing either toggle lets an invalid schema persist.
"""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.primitives_routes import load_publish_gate

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}
_NOW = datetime(2026, 6, 23, 12, 0, 0, tzinfo=timezone.utc)

# A schema that is *not* a valid draft 2020-12 document (unknown ``type`` value).
_INVALID_SCHEMA = {"type": "stringg"}


def _row(**overrides):
    """A representative apiome.primitives row as returned by the DB layer."""
    row = {
        "id": "p1",
        "tenant_id": "t1",
        "name": "My Type",
        "description": None,
        "category": "string",
        "schema": _INVALID_SCHEMA,
        "tags": [],
        "created_by": "u1",
        "is_system": False,
        "is_public": False,
        "usage_count": 0,
        "source": "human",
        "schema_id": "https://api.apiome.dev/types/tenant/acme/my-type",
        "draft": "2020-12",
        "namespace": None,
        "base_uri": "https://api.apiome.dev/types/tenant/acme/",
        "created_at": _NOW,
        "updated_at": _NOW,
        "enabled": True,
    }
    row.update(overrides)
    return row


def _settings(**overrides):
    """A type-registry settings row with the gate fully on, overridable per test."""
    settings = {"validate_on_save": True, "block_publish_on_errors": True}
    settings.update(overrides)
    return settings


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


# ===========================================================================
# load_publish_gate — settings resolution
# ===========================================================================


def test_gate_defaults_to_on_when_no_settings_row():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = None
        assert load_publish_gate("t1") == (True, True)


def test_gate_reads_persisted_toggles():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings(
            validate_on_save=False, block_publish_on_errors=False
        )
        assert load_publish_gate("t1") == (False, False)


# ===========================================================================
# CREATE — gate on (default) still blocks invalid schemas
# ===========================================================================


def test_create_blocks_invalid_when_gate_on():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings()
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "Bad", "category": "string", "schema": _INVALID_SCHEMA},
        )
    assert r.status_code == 422
    assert "draft 2020-12" in r.json()["detail"]["message"]
    mdb.create_primitive.assert_not_called()


def test_create_blocks_invalid_with_no_settings_row():
    # No saved settings → defaults → gate on → invalid is rejected (pre-gate behavior).
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = None
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "Bad", "category": "string", "schema": _INVALID_SCHEMA},
        )
    assert r.status_code == 422
    mdb.create_primitive.assert_not_called()


# ===========================================================================
# CREATE — gate relaxed lets an invalid schema persist
# ===========================================================================


def test_create_allows_invalid_when_block_disabled():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings(block_publish_on_errors=False)
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "My Type", "category": "string", "schema": _INVALID_SCHEMA},
        )
    assert r.status_code == 200
    # The invalid schema reached the database (identity still derived/stamped).
    mdb.create_primitive.assert_called_once()
    kwargs = mdb.create_primitive.call_args.kwargs
    assert kwargs["schema"]["type"] == "stringg"
    assert kwargs["schema_id"] == "https://api.apiome.dev/types/tenant/acme/my-type"


def test_create_allows_invalid_when_validate_disabled():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings(validate_on_save=False)
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "My Type", "category": "string", "schema": _INVALID_SCHEMA},
        )
    assert r.status_code == 200
    mdb.create_primitive.assert_called_once()


def test_create_still_rejects_non_object_schema_when_gate_off():
    # Structural reachability is not part of the gate: a non-object schema can never carry a
    # derived $id, so it is rejected even with both toggles off.
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings(
            validate_on_save=False, block_publish_on_errors=False
        )
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "Bad", "category": "string", "schema": True},
        )
    assert r.status_code == 422
    mdb.create_primitive.assert_not_called()


# ===========================================================================
# UPDATE — gate applies to re-validation on schema change
# ===========================================================================


def test_update_blocks_invalid_when_gate_on():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings()
        mdb.get_primitive_by_id.return_value = _row(schema={"type": "string"})
        r = client.put(
            "/v1/primitives/acme/p1",
            json={"schema": _INVALID_SCHEMA},
        )
    assert r.status_code == 422
    mdb.update_primitive.assert_not_called()


def test_update_allows_invalid_when_block_disabled():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings(block_publish_on_errors=False)
        mdb.get_primitive_by_id.return_value = _row(schema={"type": "string"})
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.update_primitive.return_value = _row()
        r = client.put(
            "/v1/primitives/acme/p1",
            json={"schema": _INVALID_SCHEMA},
        )
    assert r.status_code == 200
    mdb.update_primitive.assert_called_once()
    updates = mdb.update_primitive.call_args.args[2]
    assert updates["schema"]["type"] == "stringg"


# ===========================================================================
# Valid schemas are unaffected by the gate
# ===========================================================================


def test_create_valid_schema_succeeds_regardless_of_gate():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = _settings(
            validate_on_save=False, block_publish_on_errors=False
        )
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row(schema={"type": "string"})
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "My Type", "category": "string", "schema": {"type": "string"}},
        )
    assert r.status_code == 200
    mdb.create_primitive.assert_called_once()
