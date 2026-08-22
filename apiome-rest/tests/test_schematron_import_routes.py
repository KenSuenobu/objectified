"""Endpoint tests for the Schematron importer — POST /v1/lint/schematron/import (FMT-4.3, #5436).

Covers the wire contract the Control Panel drives: the camelCase payload, the multi-file
``members`` form an ``include`` set needs, and the one place a Schematron document is rejected
outright — where the response must carry the intake taxonomy ``code``, not just prose.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_session_credentials
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

IMPORT = "/v1/lint/schematron/import"
CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "schematron"

RULESET = """<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <title>Billing profile</title>
  <p>Rules a billing document must satisfy.</p>
  <ns prefix="cbc" uri="urn:example:components"/>
  <pattern id="core">
    <rule context="ubl:Invoice">
      <assert test="cbc:ID" id="BR-02" role="fatal">An invoice shall have an invoice number.</assert>
      <assert test="cbc:Total = $lineSum" id="BR-CO-10" role="fatal">Totals shall agree.</assert>
    </rule>
  </pattern>
</schema>
"""


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_session_credentials] = lambda: _MOCK_AUTH
    yield
    app.dependency_overrides.clear()


def test_import_reports_both_outcomes_and_the_storable_yaml():
    response = client.post(IMPORT, json={"content": RULESET, "sourceLabel": "billing.sch"})

    assert response.status_code == 200
    body = response.json()
    assert body["sourceLabel"] == "billing.sch"
    assert body["guideName"] == "Billing profile"
    assert body["description"] == "Rules a billing document must satisfy."
    assert body["assertionCount"] == 2
    assert body["projectedCount"] == 1
    assert body["declaredCount"] == 1
    assert body["coverage"] == 0.5
    assert body["resolvedPhase"] == "#ALL"
    assert body["namespaces"] == {"cbc": "urn:example:components"}

    entries = {entry["assertionId"]: entry for entry in body["entries"]}
    assert entries["BR-02"]["outcome"] == "projected"
    assert entries["BR-02"]["severity"] == "error"  # role="fatal" is a blocking rule
    assert entries["BR-02"]["ruleId"] == "schematron.br-02"
    assert entries["BR-02"]["target"] == "Invoice"
    assert entries["BR-02"]["reason"] is None

    assert entries["BR-CO-10"]["outcome"] == "declared"
    assert entries["BR-CO-10"]["reason"] == "variable_reference"
    assert entries["BR-CO-10"]["detail"]
    assert entries["BR-CO-10"]["context"] == "ubl:Invoice"

    # Every assertion is in the guide, including the one that cannot be evaluated.
    assert "schematron.br-02" in body["yaml"]
    assert "schematron.br-co-10" in body["yaml"]
    assert "scope: declared" in body["yaml"]


def test_import_assembles_a_multi_file_rule_set_through_members():
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in (CORPUS / "06-include-set").iterdir()
    }
    response = client.post(
        IMPORT,
        json={
            "content": members["main.sch"],
            "sourceLabel": "main.sch",
            "members": members,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["modules"] == ["structure-rules.sch"]
    assert [entry["assertionId"] for entry in body["entries"]] == [
        "SHR-001",
        "SHR-002",
        "SHR-010",
        "LOC-001",
    ]


def test_phases_are_reported_and_out_of_phase_rules_are_declared():
    response = client.post(
        IMPORT,
        json={
            "content": (CORPUS / "04-stress-phases-and-diagnostics.sch").read_text(
                encoding="utf-8"
            ),
            "sourceLabel": "04-stress-phases-and-diagnostics.sch",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["resolvedPhase"] == "submission"
    assert body["phases"] == ["submission", "publication"]

    entries = {entry["assertionId"]: entry for entry in body["entries"]}
    assert entries["XRF-002"]["active"] is False
    assert entries["XRF-002"]["reason"] == "inactive_phase"
    assert entries["STR-001"]["phases"] == ["submission", "publication"]


@pytest.mark.parametrize(
    ("fixture", "code"),
    [
        ("negative/01-syntactic-unclosed-rule.sch", "INPUT_MALFORMED"),
        ("negative/02-semantic-pattern-without-rules.sch", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-assert.sch", "INPUT_TRUNCATED"),
        ("negative/04-wrong-format-xslt.xsl", "FORMAT_MISMATCH"),
        ("negative/06-unresolvable-is-a-reference.sch", "INPUT_REFERENCE_UNRESOLVED"),
    ],
)
def test_an_unreadable_rule_set_is_a_400_carrying_its_taxonomy_code(fixture: str, code: str):
    response = client.post(
        IMPORT,
        json={"content": (CORPUS / fixture).read_text(encoding="utf-8"), "sourceLabel": fixture},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == code
    assert response.json()["detail"]["message"]


def test_an_empty_document_is_rejected_by_the_request_model():
    assert client.post(IMPORT, json={"content": ""}).status_code == 422


def test_an_oversized_member_set_is_rejected_by_the_request_model():
    response = client.post(
        IMPORT,
        json={
            "content": RULESET,
            "members": {f"m{index}.sch": "x" for index in range(65)},
        },
    )
    assert response.status_code == 422
