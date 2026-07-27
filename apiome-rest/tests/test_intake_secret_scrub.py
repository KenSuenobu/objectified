"""Intake secret-scrubbing tests — IXH-1.4 (#5090), completed by MFI-29.6 (#4393).

Pins the three properties the scrubber must have:

* **it redacts** every credential shape intake is likely to receive — by named
  pattern, and (MFI-29.6) by entropy when no pattern can name it;
* **it redacts values only** — the document's structure survives, so a scrubbed
  source still parses and still fingerprints on the same shape;
* **it does not redact what is not a secret** — the entropy heuristic is the half
  that can be wrong, so its false-positive behaviour is pinned as tightly as its
  true-positive behaviour.

Every credential below is realistic in *shape* only; none is functional (the AWS
pair is AWS's own published documentation example).
"""

from __future__ import annotations

import json

import pytest
import yaml

from app.intake_secret_scrub import (
    ENTROPY_MAX_LENGTH,
    ENTROPY_SECRET_TYPE,
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


# --- MFI-29.6: entropy detection ------------------------------------------------------

#: Opaque tokens no named pattern recognizes — a bespoke gateway key under a neutral key
#: name is exactly the case entropy detection exists for. Assembled from fragments for the
#: same reason as the values above.
_OPAQUE_TOKENS = [
    ("mixed-alphanumeric", "f4Kd9Lm2Qp7" + "Rt3Vw8Yz1Ab" + "5Cd6Ef0Gh"),
    ("base64url", "ZmFrZS10b2tlbi1" + "mb3ItdGVzdGluZzEy" + "MzQ1Ng=="),
    ("vendor-opaque", "Rb8n2QkTvW7y" + "ZpL4mXs9CdEf" + "GhJkLmNo"),
]

#: Long, mixed, and *not* secrets. Every one of these appears in real API descriptions, and
#: redacting any of them would corrupt a legitimate document.
_NON_SECRETS = [
    ("operation-id", "getUserSubscriptionByAccountId2"),
    ("schema-name", "ListPaymentMethodsRequest_v2Beta1"),
    ("header-name", "X-Amz-Content-Sha256-Unsigned-Payload2"),
    ("urn", "urn.example.schema.OrderLine.v2.2024"),
    ("uuid", "550e8400-e29b-41d4-a716-446655440000"),
    ("sha256-digest", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    ("iso-timestamp", "2026-07-26T20:22:21.000000+00:00"),
    ("lowercase-slug", "the-quick-brown-fox-jumps-over-the-lazy-dog"),
    ("repeated-character", "A" * 40 + "1a"),
]


@pytest.mark.parametrize(
    ("label", "token"), _OPAQUE_TOKENS, ids=[case[0] for case in _OPAQUE_TOKENS]
)
def test_high_entropy_value_is_redacted(label, token):
    """A credential no pattern can name is caught by its randomness."""
    outcome = scrub_document_text(f'{{"value": "{token}"}}')
    assert outcome.scrubbed, f"{label}: nothing redacted"
    assert token not in outcome.text
    assert ENTROPY_SECRET_TYPE in {finding.secret_type for finding in outcome.findings}


@pytest.mark.parametrize(
    ("label", "value"), _NON_SECRETS, ids=[case[0] for case in _NON_SECRETS]
)
def test_identifier_shaped_value_is_not_redacted(label, value):
    """The heuristic must leave the long non-secrets a real document is full of alone."""
    outcome = scrub_document_text(f'{{"name": "{value}"}}')
    assert not outcome.scrubbed, f"{label}: falsely redacted as a secret"
    assert value in outcome.text


def test_entropy_detection_can_be_disabled():
    """The heuristic is switchable; the named patterns are not."""
    token = "f4Kd9Lm2Qp7" + "Rt3Vw8Yz1Ab" + "5Cd6Ef0Gh"
    text = f'{{"value": "{token}", "password": "{_PLAIN_PASSWORD}"}}'

    off = scrub_document_text(text, entropy_detection=False)
    assert token in off.text, "entropy_detection=False still redacted an unnamed token"
    assert _PLAIN_PASSWORD not in off.text, "a named pattern was skipped"
    assert {finding.secret_type for finding in off.findings} == {"secret-assignment"}

    on = scrub_document_text(text, entropy_detection=True)
    assert token not in on.text


def test_embedded_payload_is_too_long_for_the_entropy_heuristic():
    """A base64 blob is an example, not a credential — redacting it destroys the example."""
    blob = ("QUJDRGVmZ2hpams" + "xMjM0NTY3ODkw") * 8
    assert len(blob) > ENTROPY_MAX_LENGTH
    outcome = scrub_document_text(f'{{"thumbnail": "{blob}"}}')
    assert not outcome.scrubbed
    assert blob in outcome.text


def test_named_pattern_wins_over_entropy_for_the_same_value():
    """A provider-shaped key is reported as that provider, not as an anonymous blob."""
    outcome = scrub_document_text(f'{{"key": "{_GOOGLE_KEY}"}}')
    types = {finding.secret_type for finding in outcome.findings}
    assert types == {"google-api-key"}, f"expected the named type only, got {types}"
    assert outcome.redaction_count == 1


def test_line_numbers_survive_a_multi_line_redaction():
    """A PEM block collapses to one marker; findings after it must still report true lines.

    Detection runs against the original text precisely so this holds — a report that
    mislocates a finding is worse than no location at all.
    """
    text = "\n".join(
        [
            "-----BEGIN RSA PRIVATE KEY-----",  # 1
            "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",  # 2
            "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==",  # 3
            "-----END RSA PRIVATE KEY-----",  # 4
            "info:",  # 5
            f'  api_key: "{_GOOGLE_KEY}"',  # 6
        ]
    )
    findings = {finding.secret_type: finding.line for finding in scrub_document_text(text).findings}
    assert findings["private-key-block"] == 1
    assert findings["google-api-key"] == 6, (
        "the line number shifted with the collapsed PEM body"
    )


def test_a_token_dense_document_scrubs_in_reasonable_time():
    """A capture full of credentials must not make detection quadratic.

    HAR and Postman exports — the formats MFI-29.6 exists to protect — routinely carry
    thousands of cookies and tokens. Overlap resolution is neighbour-checked rather than
    scanned, so this stays near-linear; the assertion is a generous ceiling that a
    quadratic implementation blows through rather than a performance benchmark.
    """
    import time

    entries = "\n".join(
        f'  {{"name": "sid{index}", "value": "Bearer sessioncookie{index}abcdefghijklmnop"}},'
        for index in range(4000)
    )
    text = "[\n" + entries + "\n]"

    started = time.monotonic()
    outcome = scrub_document_text(text)
    elapsed = time.monotonic() - started

    assert outcome.redaction_count >= 4000, "the dense fixture did not actually redact"
    assert elapsed < 10.0, f"scrubbing 4000 credentials took {elapsed:.1f}s"


def test_overlapping_patterns_claim_a_span_once():
    """Two patterns matching the same value must not double-report or nest markers."""
    outcome = scrub_document_text(f'Authorization: Bearer {_JWT}')
    assert outcome.redaction_count == 1
    assert outcome.text.count(REDACTION_MARKER) == 1
    assert _JWT not in outcome.text


def test_entropy_redaction_keeps_the_document_parseable():
    """Values only, still — the MFI-29.6 structural contract covers the heuristic too."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "T", "version": "1.0.0"},
        "x-gateway": {"credential": "f4Kd9Lm2Qp7" + "Rt3Vw8Yz1Ab" + "5Cd6Ef0Gh"},
        "paths": {},
    }
    text = json.dumps(document, indent=2)
    outcome = scrub_document_text(text)
    scrubbed = json.loads(outcome.text)
    assert scrubbed["openapi"] == "3.1.0"
    assert scrubbed["info"] == document["info"]
    assert scrubbed["paths"] == {}
    assert scrubbed["x-gateway"]["credential"] == REDACTION_MARKER
