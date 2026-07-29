"""Tests for cross-format API identity (MFI-6.4, #4410)."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {
    "tenant_id": "test-tenant-id",
    "user_id": "test-user-id",
    "auth_method": "jwt",
}


def _override_auth():
    return _MOCK_AUTH


def test_identity_routes_require_auth():
    response = client.get("/v1/identity/test-tenant/projects/p1/related")
    assert response.status_code == 401


def test_get_related_artifacts():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.identity_routes.db") as mock_db:
            mock_db.get_project_by_id.return_value = {"id": "p1"}
            mock_db.get_related_artifact_rows.return_value = [
                {
                    "project_id": "p2",
                    "name": "Acme OpenAPI",
                    "slug": "acme-openapi",
                    "publishable": True,
                    "source_format": "openapi",
                    "protocol": "rest",
                    "link_source": "conversion",
                    "deleted": False,
                }
            ]
            response = client.get("/v1/identity/test-tenant/projects/p1/related")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["projectId"] == "p2"
        assert data[0]["linkSource"] == "conversion"
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_link_artifacts():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.identity_routes.db") as mock_db:
            mock_db.link_identity_projects.return_value = "group-1"
            mock_db.get_related_artifact_rows.return_value = []
            response = client.post(
                "/v1/identity/test-tenant/link",
                json={"projectId": "p1", "relatedProjectId": "p2"},
            )
        assert response.status_code == 200
        assert response.json()["identityGroupId"] == "group-1"
        mock_db.link_identity_projects.assert_called_once()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_unlink_artifacts():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.identity_routes.db") as mock_db:
            mock_db.get_project_by_id.return_value = {"id": "p1"}
            mock_db.get_identity_group_id_for_project.return_value = None
            mock_db.get_related_artifact_rows.return_value = []
            response = client.request(
                "DELETE",
                "/v1/identity/test-tenant/link",
                json={"projectId": "p1", "relatedProjectId": "p2"},
            )
        assert response.status_code == 200
        mock_db.unlink_identity_projects.assert_called_once()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_identity_suggestions_never_auto_link():
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.identity_routes.db") as mock_db:
            mock_db.get_project_identity_profile.return_value = {
                "project_id": "p1",
                "name": "Acme API",
                "format_metadata": {"package": "acme.v1"},
            }
            mock_db.get_identity_suggestion_candidates.return_value = [
                {
                    "project_id": "p2",
                    "name": "Acme API",
                    "slug": "acme-api",
                    "publishable": False,
                    "source_format": "protobuf",
                    "protocol": "grpc",
                    "format_metadata": {"package": "acme.v1"},
                    "identity_name": None,
                    "identity_namespace": None,
                }
            ]
            mock_db.get_operation_keys_for_project.side_effect = [
                {"GetUser", "ListUsers"},
                {"GetUser", "ListUsers"},
            ]
            response = client.get("/v1/identity/test-tenant/projects/p1/suggestions")
        assert response.status_code == 200
        suggestions = response.json()
        assert len(suggestions) >= 1
        assert suggestions[0]["projectId"] == "p2"
        mock_db.link_identity_projects.assert_not_called()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# Identity-group writes never fetch (CPDO-4.1, #4804)
# ---------------------------------------------------------------------------
#
# The identity-group writers (INSERT … ON CONFLICT DO NOTHING, UPDATE, DELETE — none
# with a RETURNING clause) used to run through ``execute_query``, whose unconditional
# ``fetchall()`` makes psycopg2 raise "no results to fetch" on any plain write. The
# route suites above mock the data layer, so the first real conversion commit was what
# hit it (the CPDO-4.1 journey e2e). These pin the fix at the SQL boundary with a
# driver-faithful fake: a cursor that, like psycopg2, refuses ``fetchall()`` after a
# statement that produced no result set.


class _WriteOnlyCursor:
    """A psycopg2-shaped cursor for statements that return no rows."""

    rowcount = 1

    def __init__(self, executed):
        self._executed = executed

    def execute(self, query, params=None):
        self._executed.append((" ".join(query.split()), params))

    def fetchall(self):
        raise Exception("no results to fetch")

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class _WriteOnlyConnection:
    def __init__(self):
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return _WriteOnlyCursor(self.executed)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def _db_with_fake_connection():
    import app.database as database

    fake = _WriteOnlyConnection()
    instance = database.Database.__new__(database.Database)
    instance.connect = lambda: fake  # type: ignore[method-assign]
    return instance, fake


def test_add_identity_member_is_a_pure_write():
    instance, fake = _db_with_fake_connection()

    instance._add_identity_member(
        tenant_id="t1",
        group_id="g1",
        project_id="p1",
        created_by="u1",
        link_source="conversion",
    )

    assert len(fake.executed) == 1
    assert fake.executed[0][0].startswith("INSERT INTO apiome.api_identity_members")
    assert fake.commits == 1
    assert fake.rollbacks == 0


def test_merge_identity_groups_is_a_pure_write():
    instance, fake = _db_with_fake_connection()

    instance._merge_identity_groups("t1", "keep", "drop")

    statements = [query for query, _ in fake.executed]
    assert statements[0].startswith("UPDATE apiome.api_identity_members")
    assert statements[1].startswith("DELETE FROM apiome.api_identity_groups")
    assert fake.commits == 2
    assert fake.rollbacks == 0
