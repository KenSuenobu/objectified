"""Contract tests for the intake error taxonomy — IXH-1.3 (#5089), nucleus of IXH-6.4.

The taxonomy is additive-only: codes are never renamed, removed, or repurposed.
These tests pin the shipped codes and the metadata contract every code must carry,
so an accidental rename/removal fails CI even before the negative corpus notices.
"""

from __future__ import annotations

from app.intake_error_taxonomy import (
    INTAKE_ERROR_TAXONOMY,
    LEGACY_EVENT_CODE_MAP,
    IntakeErrorCategory,
    JobErrorCategory,
    descriptor_for,
    resolve_intake_error_code,
)

#: Codes shipped with IXH-1.3. Additive-only: this set may grow, never shrink.
SHIPPED_CODES = {
    "INPUT_EMPTY",
    "INPUT_ENCODING_INVALID",
    "INPUT_MALFORMED",
    "INPUT_TRUNCATED",
    "INPUT_SEMANTIC_INVALID",
    "INPUT_REFERENCE_UNRESOLVED",
    "INPUT_ARCHIVE_INVALID",
    "FORMAT_MISMATCH",
    "FORMAT_VERSION_UNSUPPORTED",
    # Added by IXH-2.1 (#5096): auto-detection found no importer for the document.
    "FORMAT_UNRECOGNIZED",
    "ADAPTER_UNAVAILABLE",
    "INTERNAL_ADAPTER_FAULT",
    "INTERNAL_WORKER_FAULT",
    "INTERNAL_PERSIST_FAULT",
}


def test_all_shipped_codes_remain_registered():
    missing = SHIPPED_CODES - set(INTAKE_ERROR_TAXONOMY)
    assert not missing, (
        f"taxonomy codes removed or renamed (the taxonomy is additive-only): {sorted(missing)}"
    )


def test_every_descriptor_is_complete_and_consistent():
    for code, descriptor in INTAKE_ERROR_TAXONOMY.items():
        assert descriptor.code == code, f"{code}: registry key and descriptor code differ"
        assert isinstance(descriptor.category, IntakeErrorCategory)
        assert isinstance(descriptor.retriable, bool)
        assert descriptor.remediation.strip(), f"{code}: remediation must be non-empty"


def test_legacy_event_codes_map_onto_registered_codes():
    unmapped = {
        legacy: target
        for legacy, target in LEGACY_EVENT_CODE_MAP.items()
        if target not in INTAKE_ERROR_TAXONOMY
    }
    assert not unmapped, f"legacy codes mapped to unregistered taxonomy codes: {unmapped}"


def test_resolver_accepts_taxonomy_legacy_and_unknown_codes():
    assert resolve_intake_error_code("INPUT_MALFORMED") == "INPUT_MALFORMED"
    assert resolve_intake_error_code("PARSE_ERROR") == "INPUT_MALFORMED"
    assert resolve_intake_error_code("WORKER_FAILED") == "INTERNAL_WORKER_FAULT"
    assert resolve_intake_error_code("NO_SUCH_CODE") is None
    assert resolve_intake_error_code(None) is None
    assert resolve_intake_error_code("") is None


def test_descriptor_lookup():
    descriptor = descriptor_for("FORMAT_MISMATCH")
    assert descriptor is not None
    assert descriptor.category is IntakeErrorCategory.FORMAT
    assert descriptor_for("NO_SUCH_CODE") is None
    assert descriptor_for(None) is None


def test_job_error_category_is_intake_alias():
    """IXH-6.4: JobErrorCategory is the shared name; IntakeErrorCategory stays as alias."""
    assert IntakeErrorCategory is JobErrorCategory
    assert set(JobErrorCategory) == {
        JobErrorCategory.INPUT,
        JobErrorCategory.FORMAT,
        JobErrorCategory.CAPABILITY,
        JobErrorCategory.POLICY,
        JobErrorCategory.RESOURCE,
        JobErrorCategory.TRANSPORT,
        JobErrorCategory.INTERNAL,
    }
