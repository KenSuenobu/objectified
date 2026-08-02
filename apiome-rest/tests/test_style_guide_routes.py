"""Endpoint tests for the style-guide management API (GOV-2.1, #4433).

The DB layer is mocked (patched on ``app.style_guide_routes.db``) so these tests exercise
the route contract: response shapes (camelCase aliases), admin gating, read-only builtin
handling, and the error codes the Control Panel screen keys off.

The GOV-1.6 (#4432) revision history and audit surface is covered here too: which mutations
capture the pre-edit state, which append a revision and with what change kind, which emit a
``style_guide.*`` audit event, and the two read endpoints over the immutable history.
"""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import psycopg2
import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.lint_rule_registry import LINT_RULE_DOCS_PAGE, builtin_rule_descriptors
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

BUILTIN_ID = "00000000-0000-0000-0000-0000000000a1"
GUIDE_ID = "00000000-0000-0000-0000-0000000000b2"
PROJECT_ID = "00000000-0000-0000-0000-0000000000c3"
NOW = datetime(2026, 7, 11, 12, 0, 0, tzinfo=timezone.utc)


def _override_auth():
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = _override_auth
    yield
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _admin():
    """Mutations require a tenant admin; default every test to an admin caller."""
    with patch("app.style_guide_routes.db.is_user_tenant_admin", return_value=True):
        yield


@pytest.fixture(autouse=True)
def governance():
    """Stub the GOV-1.6 (#4432) history/audit seams every mutation now goes through.

    Revision capture and audit writes talk to the DB singleton directly, so they are patched
    for the whole module (the routes must not reach a database in a contract test) and handed
    back as mocks for the tests that assert on them.
    """
    with patch("app.style_guide_routes.ensure_guide_revision") as ensure, patch(
        "app.style_guide_routes.record_guide_revision"
    ) as record, patch("app.style_guide_routes.audit_style_guide_event") as audit:
        yield SimpleNamespace(ensure=ensure, record=record, audit=audit)


def _builtin_row(**over):
    row = {
        "id": BUILTIN_ID,
        "name": "Apiome Recommended",
        "description": "The built-in Apiome style guide.",
        "source": "builtin",
        "is_default": True,
        "rule_count": 37,
        "enabled_rule_count": 37,
        "tenant_assigned": False,
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(over)
    return row


def _custom_row(**over):
    row = {
        "id": GUIDE_ID,
        "name": "Payments Guide",
        "description": None,
        "source": "custom",
        "is_default": False,
        "rule_count": 12,
        "enabled_rule_count": 9,
        "tenant_assigned": False,
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(over)
    return row


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


def test_list_returns_guides_with_rollups_and_camel_case():
    assignments = [
        {"guide_id": GUIDE_ID, "project_id": PROJECT_ID, "project_name": "Payments"}
    ]
    with patch("app.style_guide_routes.db.ensure_builtin_style_guide") as ensure, patch(
        "app.style_guide_routes.db.list_style_guides",
        return_value=[_builtin_row(), _custom_row()],
    ), patch(
        "app.style_guide_routes.db.list_style_guide_project_assignments",
        return_value=assignments,
    ):
        r = client.get("/v1/style-guides/acme")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    ensure.assert_called_once_with("t1")

    builtin, custom = body["guides"]
    assert builtin["name"] == "Apiome Recommended"
    assert builtin["source"] == "builtin"
    assert builtin["isDefault"] is True
    assert builtin["enabledRuleCount"] == 37
    assert builtin["ruleCount"] == 37
    assert builtin["projectAssignments"] == []
    assert custom["projectAssignments"] == [
        {"projectId": PROJECT_ID, "projectName": "Payments"}
    ]
    assert custom["tenantAssigned"] is False
    assert "createdAt" in custom and "updatedAt" in custom


def test_list_is_readable_by_non_admin_members():
    with patch(
        "app.style_guide_routes.db.is_user_tenant_admin", return_value=False
    ), patch("app.style_guide_routes.db.ensure_builtin_style_guide"), patch(
        "app.style_guide_routes.db.list_style_guides", return_value=[]
    ), patch(
        "app.style_guide_routes.db.list_style_guide_project_assignments", return_value=[]
    ):
        r = client.get("/v1/style-guides/acme")
    assert r.status_code == 200
    assert r.json() == {"guides": [], "count": 0}


# ---------------------------------------------------------------------------
# Create / duplicate
# ---------------------------------------------------------------------------


def test_create_empty_guide():
    created = _custom_row(rule_count=0, enabled_rule_count=0)
    with patch(
        "app.style_guide_routes.db.create_style_guide", return_value=created
    ) as create:
        r = client.post(
            "/v1/style-guides/acme",
            json={"name": "Payments Guide", "description": "House rules"},
        )
    assert r.status_code == 201
    assert r.json()["name"] == "Payments Guide"
    assert r.json()["ruleCount"] == 0
    create.assert_called_once_with(
        "t1", "Payments Guide", "House rules", None, external_lint_profile=None
    )


def test_create_duplicates_source_guide_rules():
    rules = [{"rule_id": f"r{i}", "enabled": True, "severity": "warning", "custom_def": None} for i in range(5)]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_builtin_row()
    ), patch(
        "app.style_guide_routes.db.get_style_guide_rules", return_value=rules
    ), patch(
        "app.style_guide_routes.db.create_style_guide", return_value=_custom_row()
    ) as create:
        r = client.post(
            "/v1/style-guides/acme",
            json={"name": "My Copy", "sourceGuideId": BUILTIN_ID},
        )
    assert r.status_code == 201
    assert r.json()["ruleCount"] == 5
    assert r.json()["enabledRuleCount"] == 5
    create.assert_called_once_with(
        "t1", "My Copy", None, BUILTIN_ID, external_lint_profile=None
    )


def test_create_with_unknown_source_guide_404s():
    with patch("app.style_guide_routes.db.get_style_guide_by_id", return_value=None):
        r = client.post(
            "/v1/style-guides/acme",
            json={"name": "My Copy", "sourceGuideId": GUIDE_ID},
        )
    assert r.status_code == 404


def test_create_name_conflict_409s_with_code():
    with patch(
        "app.style_guide_routes.db.create_style_guide",
        side_effect=psycopg2.IntegrityError(),
    ):
        r = client.post("/v1/style-guides/acme", json={"name": "Payments Guide"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "STYLE_GUIDE_NAME_CONFLICT"


def test_create_blank_name_400s():
    r = client.post("/v1/style-guides/acme", json={"name": "   "})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Update / delete — read-only builtin
# ---------------------------------------------------------------------------


def test_update_builtin_guide_is_read_only():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_builtin_row()
    ):
        r = client.patch(
            f"/v1/style-guides/acme/{BUILTIN_ID}", json={"name": "Renamed"}
        )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "STYLE_GUIDE_READ_ONLY"


def test_update_renames_custom_guide():
    renamed = _custom_row(name="Renamed")
    rules = [{"rule_id": "a", "enabled": True, "severity": "info", "custom_def": None}]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.update_style_guide", return_value=renamed
    ) as update, patch(
        "app.style_guide_routes.db.get_style_guide_rules", return_value=rules
    ):
        r = client.patch(f"/v1/style-guides/acme/{GUIDE_ID}", json={"name": "Renamed"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"
    # Description untouched when the body omits it.
    update.assert_called_once_with(
        GUIDE_ID, "t1", "Renamed", None, external_lint_profile=None
    )


def test_delete_builtin_guide_is_read_only():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_builtin_row()
    ):
        r = client.delete(f"/v1/style-guides/acme/{BUILTIN_ID}")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "STYLE_GUIDE_READ_ONLY"


def test_delete_custom_guide():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch("app.style_guide_routes.db.delete_style_guide", return_value=True):
        r = client.delete(f"/v1/style-guides/acme/{GUIDE_ID}")
    assert r.status_code == 200
    assert r.json() == {"status": "deleted", "id": GUIDE_ID}


def test_delete_missing_guide_404s():
    with patch("app.style_guide_routes.db.get_style_guide_by_id", return_value=None):
        r = client.delete(f"/v1/style-guides/acme/{GUIDE_ID}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Rule catalog tab — GET / PUT rules (GOV-2.2, #4434)
# ---------------------------------------------------------------------------

# The registry is real (imported by the app), so tests derive expectations from it rather
# than hard-coding rule ids.
DESCRIPTORS = builtin_rule_descriptors()


def test_get_rules_merges_registry_with_guide_rows():
    first, second = DESCRIPTORS[0], DESCRIPTORS[1]
    overridden_severity = "info" if first.default_severity != "info" else "error"
    rows = [
        # An enabled row with a severity override.
        {"rule_id": first.rule_id, "enabled": True, "severity": overridden_severity, "custom_def": None},
        # A disabled row keeps its stored severity but reports enabled=False.
        {"rule_id": second.rule_id, "enabled": False, "severity": second.default_severity, "custom_def": None},
        # A custom rule row (GOV-1.3) must not leak into the built-in catalog view.
        {"rule_id": "custom.team-rule", "enabled": True, "severity": "error", "custom_def": {"description": "x"}},
        # A stale row for an unregistered id is ignored.
        {"rule_id": "gone.rule", "enabled": True, "severity": "error", "custom_def": None},
    ]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=rows):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/rules")
    assert r.status_code == 200
    body = r.json()
    assert body["guideId"] == GUIDE_ID
    assert body["guideName"] == "Payments Guide"
    assert body["source"] == "custom"
    assert body["count"] == len(DESCRIPTORS)
    assert body["enabledCount"] == 1
    assert body["docsPage"] == LINT_RULE_DOCS_PAGE

    by_id = {rule["ruleId"]: rule for rule in body["rules"]}
    assert "custom.team-rule" not in by_id
    assert "gone.rule" not in by_id
    assert by_id[first.rule_id]["enabled"] is True
    assert by_id[first.rule_id]["severity"] == overridden_severity
    assert by_id[first.rule_id]["defaultSeverity"] == first.default_severity
    assert by_id[first.rule_id]["category"] == first.category
    assert by_id[first.rule_id]["rationale"] == first.rationale
    assert by_id[first.rule_id]["docsAnchor"] == first.docs_anchor
    assert by_id[second.rule_id]["enabled"] is False
    # Registry rules without a row render disabled at their default severity.
    unlisted = next(d for d in DESCRIPTORS if d.rule_id not in (first.rule_id, second.rule_id))
    assert by_id[unlisted.rule_id]["enabled"] is False
    assert by_id[unlisted.rule_id]["severity"] == unlisted.default_severity


def test_get_rules_is_readable_by_non_admin_members():
    with patch(
        "app.style_guide_routes.db.is_user_tenant_admin", return_value=False
    ), patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_builtin_row()
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=[]):
        r = client.get(f"/v1/style-guides/acme/{BUILTIN_ID}/rules")
    assert r.status_code == 200
    assert r.json()["enabledCount"] == 0


def test_get_rules_missing_guide_404s():
    with patch("app.style_guide_routes.db.get_style_guide_by_id", return_value=None):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/rules")
    assert r.status_code == 404


def test_put_rules_replaces_rows_and_returns_updated_view():
    first = DESCRIPTORS[0]
    payload = {"rules": [{"ruleId": first.rule_id, "enabled": True, "severity": "error"}]}
    stored = [{"rule_id": first.rule_id, "enabled": True, "severity": "error", "custom_def": None}]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.replace_style_guide_builtin_rules", return_value=True
    ) as replace, patch(
        "app.style_guide_routes.db.get_style_guide_rules", return_value=stored
    ):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/rules", json=payload)
    assert r.status_code == 200
    replace.assert_called_once_with(
        GUIDE_ID, "t1", [{"rule_id": first.rule_id, "enabled": True, "severity": "error"}]
    )
    body = r.json()
    assert body["enabledCount"] == 1
    by_id = {rule["ruleId"]: rule for rule in body["rules"]}
    assert by_id[first.rule_id]["severity"] == "error"


def test_put_rules_on_builtin_guide_is_read_only():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_builtin_row()
    ):
        r = client.put(f"/v1/style-guides/acme/{BUILTIN_ID}/rules", json={"rules": []})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "STYLE_GUIDE_READ_ONLY"


def test_put_rules_rejects_unknown_rule_id():
    payload = {"rules": [{"ruleId": "not.a-registered-rule", "enabled": True, "severity": "error"}]}
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/rules", json=payload)
    assert r.status_code == 400
    assert "not.a-registered-rule" in r.json()["detail"]


def test_put_rules_rejects_duplicate_rule_ids():
    first = DESCRIPTORS[0]
    payload = {
        "rules": [
            {"ruleId": first.rule_id, "enabled": True, "severity": "error"},
            {"ruleId": first.rule_id, "enabled": False, "severity": "info"},
        ]
    }
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/rules", json=payload)
    assert r.status_code == 400
    assert "Duplicate" in r.json()["detail"]


def test_put_rules_rejects_invalid_severity():
    first = DESCRIPTORS[0]
    payload = {"rules": [{"ruleId": first.rule_id, "enabled": True, "severity": "fatal"}]}
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/rules", json=payload)
    assert r.status_code == 422


def test_put_rules_missing_guide_404s():
    with patch("app.style_guide_routes.db.get_style_guide_by_id", return_value=None):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/rules", json={"rules": []})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------


def test_set_tenant_default():
    promoted = _custom_row(is_default=True)
    with patch(
        "app.style_guide_routes.db.set_style_guide_tenant_default", return_value=promoted
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=[]):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/default")
    assert r.status_code == 200
    assert r.json()["isDefault"] is True
    assert r.json()["tenantAssigned"] is True


def test_set_tenant_default_missing_guide_404s():
    with patch(
        "app.style_guide_routes.db.set_style_guide_tenant_default", return_value=None
    ):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/default")
    assert r.status_code == 404


def test_assign_project():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.assign_style_guide_to_project", return_value=True
    ) as assign:
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/assignments/projects/{PROJECT_ID}"
        )
    assert r.status_code == 200
    assert r.json() == {
        "status": "assigned",
        "guideId": GUIDE_ID,
        "projectId": PROJECT_ID,
    }
    assign.assert_called_once_with(GUIDE_ID, "t1", PROJECT_ID)


def test_assign_project_unknown_project_404s():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.assign_style_guide_to_project", return_value=False
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/assignments/projects/{PROJECT_ID}"
        )
    assert r.status_code == 404


def test_unassign_project():
    with patch(
        "app.style_guide_routes.db.unassign_style_guide_from_project", return_value=True
    ):
        r = client.delete(f"/v1/style-guides/acme/assignments/projects/{PROJECT_ID}")
    assert r.status_code == 200
    assert r.json() == {"status": "unassigned", "projectId": PROJECT_ID}


def test_unassign_project_without_assignment_404s():
    with patch(
        "app.style_guide_routes.db.unassign_style_guide_from_project", return_value=False
    ):
        r = client.delete(f"/v1/style-guides/acme/assignments/projects/{PROJECT_ID}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Custom rules tab (GOV-2.3, #4435)
# ---------------------------------------------------------------------------

VALID_CUSTOM_YAML = """rules:
  servers-use-https:
    description: Every server URL uses https.
    severity: error
    given: "$.servers[*].url"
    then:
      function: pattern
      functionOptions:
        match: '^https://'
"""


def test_get_custom_rules_returns_yaml_document():
    rows = [
        {
            "rule_id": "servers-use-https",
            "enabled": True,
            "severity": "error",
            "custom_def": {
                "description": "Every server URL uses https.",
                "severity": "error",
                "given": ["$.servers[*].url"],
                "then": [
                    {
                        "function": "pattern",
                        "functionOptions": {"match": "^https://"},
                    }
                ],
            },
        }
    ]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=rows):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/custom-rules")
    assert r.status_code == 200
    body = r.json()
    assert body["guideId"] == GUIDE_ID
    assert body["ruleCount"] == 1
    assert "servers-use-https" in body["yaml"]


def test_put_custom_rules_validates_and_persists():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.replace_style_guide_custom_rules", return_value=True
    ) as replace, patch(
        "app.style_guide_routes.db.get_style_guide_rules", return_value=[]
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/custom-rules",
            json={"yaml": VALID_CUSTOM_YAML},
        )
    assert r.status_code == 200
    replace.assert_called_once()
    stored = replace.call_args[0][2]
    assert stored[0]["rule_id"] == "servers-use-https"
    assert stored[0]["custom_def"]["description"].startswith("Every server")


def test_put_custom_rules_malformed_yaml_returns_422_with_pointer():
    bad_yaml = """rules:
  broken:
    description: x
    given: $.info
    then:
      function: pattern
      functionOptions:
        match: '('
"""
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/custom-rules",
            json={"yaml": bad_yaml},
        )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "pointer" in detail
    assert detail["pointer"].startswith("rules.broken")


def test_put_custom_rules_rejects_builtin_guide():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_builtin_row()
    ):
        r = client.put(
            f"/v1/style-guides/acme/{BUILTIN_ID}/custom-rules",
            json={"yaml": "rules: {}\n"},
        )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "STYLE_GUIDE_READ_ONLY"


def test_preview_custom_rules_returns_violations():
    version = {
        "id": "00000000-0000-0000-0000-0000000000d4",
        "project_id": PROJECT_ID,
        "version_id": "v1",
    }
    spec = {
        "openapi": "3.1.0",
        "info": {"title": "t", "version": "1.0.0"},
        "servers": [{"url": "http://insecure.example.com"}],
        "paths": {},
    }
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.get_project_by_id",
        return_value={"id": PROJECT_ID, "name": "Payments"},
    ), patch(
        "app.style_guide_routes.db.get_version_by_id", return_value=version
    ), patch(
        "app.style_guide_routes.openapi_for_revision", return_value=spec
    ):
        r = client.post(
            f"/v1/style-guides/acme/{GUIDE_ID}/custom-rules/preview",
            json={
                "yaml": VALID_CUSTOM_YAML,
                "projectId": PROJECT_ID,
                "versionRecordId": version["id"],
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 1
    assert body["findings"][0]["rule"] == "servers-use-https"
    assert body["versionId"] == "v1"


# ---------------------------------------------------------------------------
# Admin gating
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "/v1/style-guides/acme", {"name": "X"}),
        ("patch", f"/v1/style-guides/acme/{GUIDE_ID}", {"name": "X"}),
        ("put", f"/v1/style-guides/acme/{GUIDE_ID}/rules", {"rules": []}),
        ("put", f"/v1/style-guides/acme/{GUIDE_ID}/custom-rules", {"yaml": "rules: {}\n"}),
        ("delete", f"/v1/style-guides/acme/{GUIDE_ID}", None),
        ("put", f"/v1/style-guides/acme/{GUIDE_ID}/default", None),
        (
            "put",
            f"/v1/style-guides/acme/{GUIDE_ID}/assignments/projects/{PROJECT_ID}",
            None,
        ),
        ("delete", f"/v1/style-guides/acme/assignments/projects/{PROJECT_ID}", None),
    ],
)
def test_mutations_require_tenant_admin(method, path, body):
    with patch("app.style_guide_routes.db.is_user_tenant_admin", return_value=False):
        kwargs = {"json": body} if body is not None else {}
        r = getattr(client, method)(path, **kwargs)
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Revisions & audit (GOV-1.6, #4432)
# ---------------------------------------------------------------------------

REVISION_ID = "00000000-0000-0000-0000-0000000000f4"


def _revision_row(**over):
    """A ``style_guide_revisions`` row as the DB accessors return it."""
    row = {
        "id": REVISION_ID,
        "guide_id": GUIDE_ID,
        "tenant_id": "t1",
        "revision_number": 2,
        "change_kind": "rules_changed",
        "name": "Payments Guide",
        "description": "House rules",
        "external_lint_profile": "baseline",
        "rules": [
            {"rule_id": "naming.schema-pascal-case", "enabled": True, "severity": "error"},
            {"rule_id": "naming.property-name", "enabled": False, "severity": "warning"},
            {
                "rule_id": "payments-currency",
                "enabled": True,
                "severity": "warning",
                "custom_def": {"given": "$..currency", "then": {"function": "truthy"}},
            },
        ],
        "policy": {
            "axisGates": {},
            "requiredCoverage": ["quality"],
            "ciOutcomes": {"failOnUnwaivedErrors": True},
        },
        "content_fingerprint": "c" * 64,
        "snapshot_fingerprint": "s" * 64,
        "actor_user_id": None,
        "actor_label": "admin@example.com",
        "created_at": NOW,
    }
    row.update(over)
    return row


def test_create_records_the_first_revision_and_audits(governance):
    with patch(
        "app.style_guide_routes.db.create_style_guide", return_value=_custom_row()
    ):
        r = client.post("/v1/style-guides/acme", json={"name": "Payments Guide"})

    assert r.status_code == 201
    assert governance.record.call_args.args[:2] == (GUIDE_ID, "t1")
    assert governance.record.call_args.kwargs["change_kind"] == "created"
    assert governance.audit.call_args.kwargs["action"] == "style_guide.created"
    assert governance.audit.call_args.kwargs["target"] == GUIDE_ID


def test_update_captures_the_pre_edit_state_before_recording_the_new_one(governance):
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.update_style_guide",
        return_value=_custom_row(name="Renamed"),
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=[]):
        r = client.patch(f"/v1/style-guides/acme/{GUIDE_ID}", json={"name": "Renamed"})

    assert r.status_code == 200
    # The state an edit replaces must be in the history even for guides predating GOV-1.6.
    governance.ensure.assert_called_once_with(GUIDE_ID, "t1")
    assert governance.record.call_args.kwargs["change_kind"] == "edited"
    detail = governance.audit.call_args.kwargs["detail"]
    assert governance.audit.call_args.kwargs["action"] == "style_guide.updated"
    assert detail["previousName"] == "Payments Guide"
    assert detail["name"] == "Renamed"


def test_put_rules_captures_records_and_audits(governance):
    first = builtin_rule_descriptors()[0]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.replace_style_guide_builtin_rules", return_value=True
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=[]), patch(
        "app.style_guide_routes.snapshot_style_guide_policy"
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/rules",
            json={
                "rules": [
                    {"ruleId": first.rule_id, "enabled": True, "severity": "error"}
                ]
            },
        )

    assert r.status_code == 200
    governance.ensure.assert_called_once_with(GUIDE_ID, "t1")
    assert governance.record.call_args.kwargs["change_kind"] == "rules_changed"
    assert governance.audit.call_args.kwargs["action"] == "style_guide.rules_updated"
    assert governance.audit.call_args.kwargs["detail"]["ruleCount"] == 1


def test_put_custom_rules_records_and_audits(governance):
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.replace_style_guide_custom_rules", return_value=True
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=[]), patch(
        "app.style_guide_routes.snapshot_style_guide_policy"
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/custom-rules",
            json={"yaml": VALID_CUSTOM_YAML},
        )

    assert r.status_code == 200
    governance.ensure.assert_called_once_with(GUIDE_ID, "t1")
    assert governance.record.call_args.kwargs["change_kind"] == "custom_rules_changed"
    assert (
        governance.audit.call_args.kwargs["action"] == "style_guide.custom_rules_updated"
    )
    assert governance.audit.call_args.kwargs["detail"]["customRuleCount"] == 1


def test_delete_audits_the_name_and_records_no_revision(governance):
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch("app.style_guide_routes.db.delete_style_guide", return_value=True):
        r = client.delete(f"/v1/style-guides/acme/{GUIDE_ID}")

    assert r.status_code == 200
    # Revisions cascade away with the guide, so the ledger is the surviving evidence.
    governance.record.assert_not_called()
    detail = governance.audit.call_args.kwargs["detail"]
    assert governance.audit.call_args.kwargs["action"] == "style_guide.deleted"
    assert detail["name"] == "Payments Guide"


def test_set_tenant_default_audits_a_tenant_scoped_assignment(governance):
    with patch(
        "app.style_guide_routes.db.set_style_guide_tenant_default",
        return_value=_custom_row(is_default=True),
    ), patch("app.style_guide_routes.db.get_style_guide_rules", return_value=[]):
        r = client.put(f"/v1/style-guides/acme/{GUIDE_ID}/default")

    assert r.status_code == 200
    kwargs = governance.audit.call_args.kwargs
    assert kwargs["action"] == "style_guide.assigned"
    assert kwargs["detail"]["scope"] == "tenant"
    # An assignment changes no guide content, so it is not a revision.
    governance.record.assert_not_called()


def test_assign_project_audits_a_project_scoped_assignment(governance):
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.assign_style_guide_to_project", return_value=True
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/assignments/projects/{PROJECT_ID}"
        )

    assert r.status_code == 200
    kwargs = governance.audit.call_args.kwargs
    assert kwargs["action"] == "style_guide.assigned"
    assert kwargs["target"] == f"{GUIDE_ID}:{PROJECT_ID}"
    assert kwargs["detail"]["projectId"] == PROJECT_ID


def test_unassign_project_audits(governance):
    with patch(
        "app.style_guide_routes.db.unassign_style_guide_from_project", return_value=True
    ):
        r = client.delete(f"/v1/style-guides/acme/assignments/projects/{PROJECT_ID}")

    assert r.status_code == 200
    assert governance.audit.call_args.kwargs["action"] == "style_guide.unassigned"


def test_failed_mutations_do_not_audit(governance):
    """A 404 is not a governance event — only changes that happened are recorded."""
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.assign_style_guide_to_project", return_value=False
    ):
        r = client.put(
            f"/v1/style-guides/acme/{GUIDE_ID}/assignments/projects/{PROJECT_ID}"
        )

    assert r.status_code == 404
    governance.audit.assert_not_called()


def test_list_revisions_returns_history_with_rollups(governance):
    rows = [_revision_row(), _revision_row(revision_number=1, change_kind="created")]
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.list_style_guide_revisions", return_value=rows
    ) as listed:
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions")

    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert body["guideId"] == GUIDE_ID
    newest = body["revisions"][0]
    assert newest["revisionNumber"] == 2
    assert newest["changeKind"] == "rules_changed"
    assert newest["ruleCount"] == 3
    assert newest["enabledRuleCount"] == 2
    assert newest["customRuleCount"] == 1
    assert newest["contentFingerprint"] == "c" * 64
    assert newest["actorLabel"] == "admin@example.com"
    # The list projection stays light: no frozen rules until the detail endpoint.
    assert "rules" not in newest
    # Reading self-heals a guide that has no history yet.
    governance.ensure.assert_called_once_with(GUIDE_ID, "t1")
    listed.assert_called_once_with(GUIDE_ID, "t1", limit=100)


def test_list_revisions_is_readable_by_non_admin_members():
    with patch(
        "app.style_guide_routes.db.is_user_tenant_admin", return_value=False
    ), patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch("app.style_guide_routes.db.list_style_guide_revisions", return_value=[]):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions")
    assert r.status_code == 200


def test_list_revisions_clamps_the_limit():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.list_style_guide_revisions", return_value=[]
    ) as listed:
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions?limit=99999")
    assert r.status_code == 200
    assert listed.call_args.kwargs["limit"] == 500


def test_list_revisions_missing_guide_404s():
    with patch("app.style_guide_routes.db.get_style_guide_by_id", return_value=None):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions")
    assert r.status_code == 404


def test_get_revision_returns_the_frozen_rules_and_policy():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.get_style_guide_revision", return_value=_revision_row()
    ):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions/{REVISION_ID}")

    assert r.status_code == 200
    body = r.json()
    assert body["id"] == REVISION_ID
    assert [rule["rule_id"] for rule in body["rules"]] == [
        "naming.schema-pascal-case",
        "naming.property-name",
        "payments-currency",
    ]
    assert body["policy"]["requiredCoverage"] == ["quality"]
    assert body["snapshotFingerprint"] == "s" * 64


def test_get_revision_of_another_guide_404s():
    """A revision id is only readable through the guide it belongs to."""
    other_guide = "00000000-0000-0000-0000-0000000000f9"
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch(
        "app.style_guide_routes.db.get_style_guide_revision",
        return_value=_revision_row(guide_id=other_guide),
    ):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions/{REVISION_ID}")
    assert r.status_code == 404


def test_get_revision_missing_404s():
    with patch(
        "app.style_guide_routes.db.get_style_guide_by_id", return_value=_custom_row()
    ), patch("app.style_guide_routes.db.get_style_guide_revision", return_value=None):
        r = client.get(f"/v1/style-guides/acme/{GUIDE_ID}/revisions/{REVISION_ID}")
    assert r.status_code == 404
