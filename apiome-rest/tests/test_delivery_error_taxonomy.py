"""Contract tests for the delivery error taxonomy — IXH-6.4 (#5123).

The taxonomy is additive-only: codes are never renamed, removed, or repurposed.
These tests pin the shipped codes and the metadata contract every code must carry.
"""

from __future__ import annotations

from app.delivery_error_taxonomy import (
    DELIVERY_ERROR_TAXONOMY,
    delivery_error_fields,
    descriptor_for,
    resolve_delivery_error_code,
    sanitize_delivery_message,
)
from app.intake_error_taxonomy import JobErrorCategory

#: Codes shipped with IXH-6.4. Additive-only: this set may grow, never shrink.
SHIPPED_CODES = {
    "SOURCE_LOAD_FAILED",
    "UNSUPPORTED_TARGET",
    "STALE_PREVIEW",
    "TRANSCODE_CONFIRMATION_REQUIRED",
    "EMIT_FAILED",
    "EMPTY_EMIT",
    "EMITTED_ARTIFACT_INVALID",
    "EXPORT_ARTIFACT_TOO_LARGE",
    "EXPORT_ARTIFACT_STORE_UNAVAILABLE",
    "EXPORT_ARTIFACT_PERSIST_FAILED",
    "EXPORT_EXCEPTION",
    "PACKAGING_FAILED",
    "DELIVERY_FAILED",
}


def test_all_shipped_codes_remain_registered():
    missing = SHIPPED_CODES - set(DELIVERY_ERROR_TAXONOMY)
    assert not missing, (
        f"taxonomy codes removed or renamed (the taxonomy is additive-only): {sorted(missing)}"
    )


def test_every_descriptor_is_complete_and_consistent():
    for code, descriptor in DELIVERY_ERROR_TAXONOMY.items():
        assert descriptor.code == code, f"{code}: registry key and descriptor code differ"
        assert isinstance(descriptor.category, JobErrorCategory)
        assert isinstance(descriptor.retriable, bool)
        assert descriptor.remediation.strip(), f"{code}: remediation must be non-empty"


def test_resolver_accepts_registered_and_unknown_codes():
    assert resolve_delivery_error_code("EMIT_FAILED") == "EMIT_FAILED"
    assert resolve_delivery_error_code("NO_SUCH_CODE") is None
    assert resolve_delivery_error_code(None) is None
    assert resolve_delivery_error_code("") is None


def test_descriptor_lookup():
    descriptor = descriptor_for("STALE_PREVIEW")
    assert descriptor is not None
    assert descriptor.category is JobErrorCategory.INPUT
    assert descriptor_for("NO_SUCH_CODE") is None
    assert descriptor_for(None) is None


def test_sanitize_internal_message_uses_correlation_id():
    raw = "Traceback (most recent call last): ValueError: boom"
    safe = sanitize_delivery_message(
        "EXPORT_EXCEPTION", raw, correlation_id="job-abc"
    )
    assert "boom" not in safe
    assert "ValueError" not in safe
    assert "job-abc" in safe
    assert "internal error" in safe.lower()


def test_sanitize_non_internal_keeps_caller_message():
    msg = "Target 'openapi' is not registered."
    assert sanitize_delivery_message("UNSUPPORTED_TARGET", msg) == msg


def test_delivery_error_fields_fill_taxonomy_metadata():
    fields = delivery_error_fields(
        "STALE_PREVIEW",
        "snapshot mismatch",
        context={"acknowledged_snapshot": "aaa", "current_snapshot": "bbb"},
        correlation_id="job-1",
    )
    assert fields["code"] == "STALE_PREVIEW"
    assert fields["category"] == "input"
    assert fields["retriable"] is False
    assert fields["remediation"].strip()
    assert fields["message"] == "snapshot mismatch"
    assert fields["context"]["acknowledged_snapshot"] == "aaa"


def test_delivery_error_fields_unknown_code_falls_back_to_export_exception():
    fields = delivery_error_fields(
        "NO_SUCH_CODE",
        "KaboomException: secrets",
        correlation_id="job-xyz",
    )
    assert fields["code"] == "EXPORT_EXCEPTION"
    assert fields["category"] == "internal"
    assert fields["retriable"] is True
    assert "KaboomException" not in fields["message"]
    assert "job-xyz" in fields["message"]
