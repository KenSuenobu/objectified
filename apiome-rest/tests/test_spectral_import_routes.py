"""Endpoint tests for the Spectral ruleset importer — POST /v1/lint/custom-rules/import (GOV-1.5, #4431)."""

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_session_credentials
from app.main import app
from app.spectral_import import SpectralImportError

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

IMPORT = "/v1/lint/custom-rules/import"
FIXTURE = Path(__file__).parent / "fixtures" / "spectral" / "zalando-style.spectral.yaml"

RULESET = """
extends: spectral:oas
rules:
  info-description: error
  operation-tags: warn
  servers-use-https:
    description: Every server URL uses https.
    severity: error
    given: $.servers[*].url
    then: {function: pattern, functionOptions: {match: '^https://'}}
  needs-js:
    description: Unsafe operations accept an Idempotency-Key header.
    given: $.paths[*][*]
    then: {function: checkIdempotencyKey}
"""


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_session_credentials] = lambda: _MOCK_AUTH
    yield
    app.dependency_overrides.clear()


def test_import_reports_every_outcome():
    r = client.post(IMPORT, json={"content": RULESET, "sourceLabel": "org.spectral.yaml"})

    assert r.status_code == 200
    body = r.json()
    assert body["sourceLabel"] == "org.spectral.yaml"
    assert body["ruleCount"] == 4
    assert body["mappedCount"] == 2
    assert body["unsupportedCount"] == 2
    assert body["coverage"] == 0.5
    assert body["customRuleCount"] == 1
    assert "servers-use-https" in body["yaml"]

    outcomes = {entry["sourceRuleId"]: entry for entry in body["entries"]}
    assert outcomes["info-description"]["outcome"] == "builtin"
    assert "documentation.info-missing-description" in outcomes["info-description"]["builtinRuleIds"]
    assert outcomes["servers-use-https"]["outcome"] == "custom"
    assert outcomes["servers-use-https"]["ruleId"] == "servers-use-https"
    assert outcomes["operation-tags"]["reason"] == "unmapped_builtin"
    assert outcomes["needs-js"]["reason"] == "js_function"
    assert outcomes["needs-js"]["pointer"] == "rules.needs-js.then.function"


def test_import_returns_storable_builtin_rows():
    r = client.post(IMPORT, json={"content": RULESET})

    rows = r.json()["builtinRules"]
    assert rows
    for row in rows:
        assert set(row) == {"ruleId", "enabled", "severity", "sourceRuleId"}
        assert row["severity"] in {"error", "warning", "info"}
    assert [row["ruleId"] for row in rows] == sorted(row["ruleId"] for row in rows)


def test_import_reports_extends_targets():
    r = client.post(
        IMPORT, json={"content": "extends: [spectral:oas, ./local.yaml]\nrules: {}\n"}
    )

    extends = r.json()["extends"]
    assert [x["target"] for x in extends] == ["spectral:oas", "./local.yaml"]
    assert extends[0]["supported"] is True and extends[0]["mappedRuleCount"] > 0
    assert extends[1]["supported"] is False
    assert extends[1]["reason"] == "unsupported_extends"


def test_zalando_style_fixture_imports_over_seventy_percent():
    r = client.post(IMPORT, json={"content": FIXTURE.read_text()})

    body = r.json()
    assert r.status_code == 200
    assert body["coverage"] >= 0.70
    assert body["notes"], "the fixture's ignored 'overrides' block is reported"


def test_imported_yaml_is_accepted_by_the_validation_endpoint():
    """The import output must be storable as-is by the GOV-1.3 custom-rules contract."""
    imported = client.post(IMPORT, json={"content": FIXTURE.read_text()}).json()

    r = client.post("/v1/lint/custom-rules/validate", json={"yaml": imported["yaml"]})
    assert r.status_code == 200
    assert r.json()["count"] == imported["customRuleCount"]


def test_url_source_is_fetched_and_labelled():
    with patch(
        "app.lint_routes.fetch_spectral_ruleset",
        return_value=(RULESET, "https://example.com/.spectral.yaml"),
    ) as fetch:
        r = client.post(IMPORT, json={"url": "https://example.com/.spectral.yaml"})

    assert r.status_code == 200
    fetch.assert_called_once_with("https://example.com/.spectral.yaml")
    assert r.json()["sourceLabel"] == "https://example.com/.spectral.yaml"


def test_unfetchable_url_returns_400():
    with patch(
        "app.lint_routes.fetch_spectral_ruleset",
        side_effect=SpectralImportError("URL returned HTTP 404; it may be private or invalid"),
    ):
        r = client.post(IMPORT, json={"url": "https://example.com/missing.yaml"})

    assert r.status_code == 400
    assert "404" in r.json()["detail"]


@pytest.mark.parametrize(
    "content,fragment",
    [
        ("rules: [\n", "invalid YAML"),
        ("- a\n- b\n", "must be a YAML mapping"),
        ("rules: [a]\n", "'rules' must be a mapping"),
    ],
)
def test_unreadable_document_returns_400(content, fragment):
    r = client.post(IMPORT, json={"content": content})

    assert r.status_code == 400
    assert fragment in r.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"content": "rules: {}\n", "url": "https://example.com/.spectral.yaml"},
        {"content": "   "},
    ],
)
def test_exactly_one_source_is_required(payload):
    r = client.post(IMPORT, json=payload)

    assert r.status_code == 422


def test_import_requires_authentication():
    app.dependency_overrides.clear()
    r = client.post(IMPORT, json={"content": RULESET})

    assert r.status_code in (401, 403)
