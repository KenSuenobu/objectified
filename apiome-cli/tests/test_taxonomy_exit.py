"""Unit tests for taxonomy-driven CLI exit codes (IXH-6.4)."""

from __future__ import annotations

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_POLICY_BLOCKED, EXIT_USAGE
from apiome_cli.taxonomy_exit import (
    exit_code_for_category,
    format_taxonomy_error,
    taxonomy_failure_from_payload,
)


def test_exit_code_for_category_mapping() -> None:
    assert exit_code_for_category("policy") == EXIT_POLICY_BLOCKED
    assert exit_code_for_category("input") == EXIT_USAGE
    assert exit_code_for_category("format") == EXIT_USAGE
    assert exit_code_for_category("capability") == EXIT_USAGE
    assert exit_code_for_category("resource") == EXIT_USAGE
    assert exit_code_for_category("transport") == EXIT_ERROR
    assert exit_code_for_category("internal") == EXIT_ERROR
    assert exit_code_for_category(None) == EXIT_ERROR
    assert exit_code_for_category("unknown") == EXIT_ERROR


def test_format_taxonomy_error() -> None:
    assert (
        format_taxonomy_error(
            {
                "code": "INPUT_MALFORMED",
                "message": "bad SDL",
                "remediation": "Fix the syntax and retry.",
            }
        )
        == "[INPUT_MALFORMED] bad SDL — Fix the syntax and retry."
    )
    assert format_taxonomy_error({}) is None


def test_taxonomy_failure_from_payload_drives_exit() -> None:
    detail, code = taxonomy_failure_from_payload(
        {
            "error": {
                "code": "TRANSCODE_CONFIRMATION_REQUIRED",
                "category": "policy",
                "message": "needs confirm",
                "remediation": "Resubmit with confirm.",
                "retriable": False,
            }
        }
    )
    assert detail is not None
    assert "TRANSCODE_CONFIRMATION_REQUIRED" in detail
    assert code == EXIT_POLICY_BLOCKED

    detail2, code2 = taxonomy_failure_from_payload({"state": "failed"})
    assert detail2 is None
    assert code2 == EXIT_ERROR
