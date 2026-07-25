"""Intake secret-scrubbing tests — IXH-1.4 (#5090), nucleus of MFI-29.6 (#4393).

Pins the two properties the scrubber must have:

* **it redacts** every credential shape intake is likely to receive, and
* **it redacts values only** — the document's structure survives, so a scrubbed
  source still parses and still fingerprints on the same shape.

Every credential below is realistic in *shape* only; none is functional (the AWS
pair is AWS's own published documentation example).
"""

from __future__ import annotations

import json

import pytest
import yaml

from app.intake_secret_scrub import (
    REDACTION_MARKER,
    scrub_document_text,
    scrub_message,
)

# Credential values are assembled from fragments rather than written as literals:
# a realistic-looking token committed verbatim trips secret-scanning push protection
# and leaves a credential-shaped string in the repository forever. None are
# functional; the AWS pair is AWS's own published documentation example.
_AWS_KEY_ID = "AKIA" + "IOSFODNN7" + "EXAMPLE"
_GITHUB_PAT = "ghp" + "_" + "16C7e42F292c6912E7710c838347Ae178B4a"
_SLACK_TOKEN = "xoxb" + "-3096502356789-3097461293841-" + "7Kd0pQmZnRt2VwXyAbCdEfGh"
_GOOGLE_KEY = "AIza" + "SyD-0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P"
_STRIPE_KEY = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dcQ8vB2nM1"
_JWT = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxIn0." + "4Xq8kK1nQmVQ0rZ9pL7wT2sYbN3"
_BASIC_PASSWORD = "S3cr3t-Staging-Pass"
_DB_PASSWORD = "Tr0ub4dor&3"
_PLAIN_PASSWORD = "hunter2-not-real"
_CLIENT_SECRET = "Rb8n2QkTvW7yZpL4mXs9CdEf"

#: (label, text containing a secret, the exact secret span, expected type).
SECRET_CASES = [
    ("aws-access-key", f'{{"accessKeyId": "{_AWS_KEY_ID}"}}', _AWS_KEY_ID, "aws-access-key-id"),
    ("github-pat", f"token: {_GITHUB_PAT}", _GITHUB_PAT, "github-token"),
    ("slack-bot-token", f'"value": "{_SLACK_TOKEN}"', _SLACK_TOKEN, "slack-token"),
    ("google-api-key", f"key={_GOOGLE_KEY}", _GOOGLE_KEY, "google-api-key"),
    ("stripe-live-key", f'"secret": "{_STRIPE_KEY}"', _STRIPE_KEY, "stripe-key"),
    ("jwt", f"Authorization: Bearer {_JWT}", _JWT, "jwt"),
    (
        "basic-auth-url",
        f"url: https://svc:{_BASIC_PASSWORD}@staging.example.com/v1",
        _BASIC_PASSWORD,
        "url-embedded-credential",
    ),
    (
        "postgres-connection-string",
        f"dsn: postgresql://report_user:{_DB_PASSWORD}@db.internal:5432/orders",
        _DB_PASSWORD,
        "url-embedded-credential",
    ),
    ("password-assignment", f'password: "{_PLAIN_PASSWORD}"', _PLAIN_PASSWORD, "secret-assignment"),
    (
        "client-secret-assignment",
        f'"client_secret": "{_CLIENT_SECRET}"',
        _CLIENT_SECRET,
        "secret-assignment",
    ),
]


@pytest.mark.parametrize(
    ("label", "text", "secret", "expected_type"),
    SECRET_CASES,
    ids=[case[0] for case in SECRET_CASES],
)
def test_secret_shape_is_redacted(label, text, secret, expected_type):
    outcome = scrub_document_text(text)
    assert outcome.scrubbed, f"{label}: nothing redacted"
    assert secret not in outcome.text, f"{label}: secret survived scrubbing"
    assert REDACTION_MARKER in outcome.text
    assert expected_type in {finding.secret_type for finding in outcome.findings}, (
        f"{label}: reported {[f.secret_type for f in outcome.findings]}, "
        f"expected {expected_type}"
    )


def test_private_key_block_is_redacted():
    text = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n"
        "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n"
        "-----END RSA PRIVATE KEY-----\n"
    )
    outcome = scrub_document_text(text)
    assert outcome.scrubbed
    assert "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX" not in outcome.text
    assert "private-key-block" in {finding.secret_type for finding in outcome.findings}
    # The fence survives, so a reader can see *what* was removed.
    assert "BEGIN RSA PRIVATE KEY" in outcome.text


def test_clean_document_is_returned_unchanged():
    text = json.dumps({"openapi": "3.1.0", "info": {"title": "Clean", "version": "1.0.0"}})
    outcome = scrub_document_text(text)
    assert outcome.text == text
    assert not outcome.scrubbed
    assert outcome.findings == []
    assert outcome.redaction_count == 0


def test_findings_never_contain_the_secret_value():
    text = f'api_key: "{_GOOGLE_KEY}"\npassword: "{_DB_PASSWORD}"\n'
    outcome = scrub_document_text(text)
    serialized = json.dumps(outcome.report())
    assert _GOOGLE_KEY not in serialized
    assert _DB_PASSWORD not in serialized
    # It does say what and where.
    assert outcome.report()["redactions"] >= 2
    assert all(finding.line >= 1 for finding in outcome.findings)


def test_report_lists_types_and_lines():
    text = "\n".join(
        [
            "info:",
            f"  token: {_GITHUB_PAT}",
            "  nested:",
            f"    accessKeyId: {_AWS_KEY_ID}",
        ]
    )
    report = scrub_document_text(text).report()
    assert report["scrubbed"] is True
    # The specific provider patterns run first and consume the value, so the generic
    # `secret-assignment` pattern does not double-report the same credential.
    assert set(report["secret_types"]) == {"github-token", "aws-access-key-id"}
    assert {finding["line"] for finding in report["findings"]} == {2, 4}


def test_json_structure_survives_scrubbing():
    document = {
        "openapi": "3.1.0",
        "servers": [{"url": "https://u:P4ssw0rd-Fake@example.com"}],
        "x-keys": {"api_key": _GOOGLE_KEY},
        "components": {"schemas": {"A": {"type": "object"}}},
    }
    text = json.dumps(document, indent=2)
    scrubbed = json.loads(scrub_document_text(text).text)
    assert set(scrubbed) == set(document)
    assert scrubbed["components"] == document["components"]
    assert scrubbed["openapi"] == "3.1.0"
    # The URL keeps its scheme, user, host and path; only the password is gone.
    url = scrubbed["servers"][0]["url"]
    assert url.startswith("https://u:") and url.endswith("@example.com")
    assert "P4ssw0rd-Fake" not in url


def test_yaml_structure_survives_scrubbing():
    text = (
        "openapi: 3.1.0\n"
        "info:\n"
        "  title: T\n"
        "  version: 1.0.0\n"
        "x-auth:\n"
        "  password: S3cr3t-Value-Here\n"
        "paths: {}\n"
    )
    outcome = scrub_document_text(text)
    parsed = yaml.safe_load(outcome.text)
    assert parsed["openapi"] == "3.1.0"
    assert parsed["info"] == {"title": "T", "version": "1.0.0"}
    assert parsed["paths"] == {}
    assert parsed["x-auth"]["password"] == REDACTION_MARKER
    assert "S3cr3t-Value-Here" not in outcome.text


def test_marker_is_not_re_redacted():
    """Scrubbing an already-scrubbed document is a no-op, not a cascade."""
    once = scrub_document_text('password: "Tr0ub4dor-3-fake"')
    twice = scrub_document_text(once.text)
    assert twice.text == once.text
    assert not twice.scrubbed


def test_scrub_message_redacts_quoted_source_spans():
    """A parser error quoting a secret-bearing line is scrubbed before it is kept."""
    message = (
        "Source document is not valid JSON or YAML (creds.yaml): mapping values are not "
        'allowed here\n  in "<unicode string>", line 3, column 12:\n'
        f'        api_key: "{_GOOGLE_KEY}"\n'
    )
    scrubbed = scrub_message(message)
    assert _GOOGLE_KEY not in scrubbed
    # The diagnostic itself survives, so the error stays actionable.
    assert "line 3, column 12" in scrubbed
    assert "mapping values are not allowed here" in scrubbed


def test_scrub_message_passes_through_none_and_clean_text():
    assert scrub_message(None) is None
    assert scrub_message("Parsed 3 operations") == "Parsed 3 operations"
