"""Tenant intake secret-scrub policy tests — MFI-29.6 (#4393).

Covers the two halves of the policy contract:

* **resolution** — the four-tier order, and specifically that a tenant's global
  ``warn_only`` cannot silently disarm scrubbing for the collection/captured-traffic
  formats that MFI-32.5 gates on;
* **degradation** — an unreadable, malformed, or absent policy resolves to ``enforce``.
  Every failure path here must fail *closed*: the cost of a wrong ``enforce`` is a
  redaction marker, the cost of a wrong ``warn_only`` is a live credential in the database.
"""

from __future__ import annotations

import pytest

from app import intake_scrub_policy
from app.intake_scrub_policy import (
    ALWAYS_ENFORCED_FORMATS,
    DEFAULT_POLICY,
    MODE_ENFORCE,
    MODE_WARN_ONLY,
    TIER_DEFAULT,
    TIER_FORMAT_DEFAULT,
    TIER_FORMAT_OVERRIDE,
    TIER_TENANT,
    ScrubPolicy,
    load_tenant_scrub_policy,
    normalize_mode,
    resolve_scrub_mode,
    scrub_policy_content_fingerprint,
    scrub_policy_from_row,
)


def _saved(**kwargs) -> ScrubPolicy:
    """A policy that came from a stored row (``is_default`` false), with overrides applied."""
    fields = {
        "policy_version_id": "11111111-1111-4111-8111-111111111111",
        "version_number": 3,
        "content_fingerprint": "abc123",
        "is_default": False,
    }
    fields.update(kwargs)
    return ScrubPolicy(**fields)


# --- defaults -------------------------------------------------------------------------


def test_default_policy_enforces_with_entropy_on():
    """The no-row default must equal the behaviour tenants already had before this ticket."""
    assert DEFAULT_POLICY.mode == MODE_ENFORCE
    assert DEFAULT_POLICY.entropy_detection is True
    assert DEFAULT_POLICY.is_default is True
    assert DEFAULT_POLICY.format_overrides == {}


def test_no_tenant_resolves_to_the_default_tier():
    resolution = resolve_scrub_mode(DEFAULT_POLICY, format_key="openapi")
    assert resolution.mode == MODE_ENFORCE
    assert resolution.tier == TIER_DEFAULT
    assert resolution.enforced is True
    assert resolution.policy_version_id is None


# --- resolution order -----------------------------------------------------------------


def test_tenant_tier_applies_to_an_ordinary_format():
    resolution = resolve_scrub_mode(_saved(mode=MODE_WARN_ONLY), format_key="openapi")
    assert resolution.mode == MODE_WARN_ONLY
    assert resolution.tier == TIER_TENANT
    assert resolution.enforced is False


@pytest.mark.parametrize("format_key", sorted(ALWAYS_ENFORCED_FORMATS))
def test_capture_formats_stay_enforced_under_a_warn_only_tenant(format_key):
    """MFI-32.5 gates on this: a global warn-only must not disarm the capture formats."""
    resolution = resolve_scrub_mode(_saved(mode=MODE_WARN_ONLY), format_key=format_key)
    assert resolution.mode == MODE_ENFORCE
    assert resolution.tier == TIER_FORMAT_DEFAULT


def test_explicit_format_override_beats_the_capture_format_default():
    """The escape hatch exists, but only as a deliberate, per-format, audited statement."""
    policy = _saved(mode=MODE_ENFORCE, format_overrides={"postman": {"mode": "warn_only"}})
    resolution = resolve_scrub_mode(policy, format_key="postman")
    assert resolution.mode == MODE_WARN_ONLY
    assert resolution.tier == TIER_FORMAT_OVERRIDE


def test_format_override_can_also_tighten_a_warn_only_tenant():
    policy = _saved(mode=MODE_WARN_ONLY, format_overrides={"openapi": {"mode": "enforce"}})
    resolution = resolve_scrub_mode(policy, format_key="openapi")
    assert resolution.mode == MODE_ENFORCE
    assert resolution.tier == TIER_FORMAT_OVERRIDE


def test_override_for_another_format_does_not_leak():
    policy = _saved(mode=MODE_ENFORCE, format_overrides={"graphql": {"mode": "warn_only"}})
    assert resolve_scrub_mode(policy, format_key="openapi").mode == MODE_ENFORCE


def test_format_key_is_matched_case_insensitively():
    policy = _saved(mode=MODE_ENFORCE, format_overrides={"graphql": {"mode": "warn_only"}})
    assert resolve_scrub_mode(policy, format_key="GraphQL").mode == MODE_WARN_ONLY


def test_unknown_format_key_falls_through_to_the_tenant_tier():
    resolution = resolve_scrub_mode(_saved(mode=MODE_WARN_ONLY), format_key="not-an-adapter")
    assert resolution.mode == MODE_WARN_ONLY
    assert resolution.tier == TIER_TENANT


def test_missing_format_key_skips_both_format_tiers():
    resolution = resolve_scrub_mode(_saved(mode=MODE_WARN_ONLY), format_key=None)
    assert resolution.tier == TIER_TENANT
    assert resolution.format_key is None


def test_resolution_carries_policy_provenance_onto_the_report():
    policy = _saved(mode=MODE_WARN_ONLY, entropy_detection=False)
    fields = resolve_scrub_mode(policy, format_key="openapi").as_report_fields()
    assert fields == {
        "mode": MODE_WARN_ONLY,
        "applied": False,
        "policy_tier": TIER_TENANT,
        "entropy_detection": False,
        "format_key": "openapi",
        "policy_version_id": policy.policy_version_id,
        "policy_content_fingerprint": policy.content_fingerprint,
    }


# --- malformed input fails closed -----------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "  ", "off", "disabled", "ENFORCE_ALL", 7])
def test_unknown_mode_normalizes_to_enforce(value):
    assert normalize_mode(value) == MODE_ENFORCE


@pytest.mark.parametrize(
    ("value", "expected"),
    [("enforce", MODE_ENFORCE), ("ENFORCE", MODE_ENFORCE), ("warn_only", MODE_WARN_ONLY),
     ("Warn-Only", MODE_WARN_ONLY), (" warn_only ", MODE_WARN_ONLY)],
)
def test_known_modes_normalize(value, expected):
    assert normalize_mode(value) == expected


def test_unreadable_mode_in_a_stored_row_becomes_enforce():
    policy = scrub_policy_from_row(
        {"id": "x", "version_number": 2, "content_fingerprint": "f", "mode": "nonsense"}
    )
    assert policy.mode == MODE_ENFORCE
    assert policy.is_default is False


def test_unreadable_mode_in_an_override_falls_back_to_the_tenant_tier():
    """A typo must not read as a deliberate change in either direction."""
    policy = _saved(mode=MODE_WARN_ONLY, format_overrides={"openapi": {"mode": "warnonly!"}})
    resolution = resolve_scrub_mode(policy, format_key="openapi")
    assert resolution.mode == MODE_WARN_ONLY
    assert resolution.tier == TIER_FORMAT_OVERRIDE


def test_non_mapping_override_is_ignored():
    policy = _saved(mode=MODE_ENFORCE, format_overrides={"openapi": "warn_only"})
    assert resolve_scrub_mode(policy, format_key="openapi").tier == TIER_TENANT


def test_row_without_overrides_yields_an_empty_map():
    policy = scrub_policy_from_row({"id": "x", "mode": "enforce", "format_overrides": None})
    assert policy.format_overrides == {}


def test_null_row_is_the_default_policy():
    assert scrub_policy_from_row(None) is DEFAULT_POLICY


# --- loading ---------------------------------------------------------------------------


def test_blank_tenant_loads_the_default_without_touching_the_store(monkeypatch):
    def _explode(*_args, **_kwargs):  # pragma: no cover - must never run
        raise AssertionError("the store was queried for a blank tenant")

    monkeypatch.setattr(intake_scrub_policy.db, "get_latest_intake_secret_scrub_policy", _explode)
    assert load_tenant_scrub_policy(None) is DEFAULT_POLICY
    assert load_tenant_scrub_policy("") is DEFAULT_POLICY


def test_store_failure_degrades_to_enforce(monkeypatch):
    """A database fault must never be a reason to stop redacting credentials."""

    def _fail(*_args, **_kwargs):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(intake_scrub_policy.db, "get_latest_intake_secret_scrub_policy", _fail)
    policy = load_tenant_scrub_policy("22222222-2222-4222-8222-222222222222")
    assert policy is DEFAULT_POLICY
    assert resolve_scrub_mode(policy, format_key="openapi").enforced is True


def test_stored_row_is_loaded(monkeypatch):
    monkeypatch.setattr(
        intake_scrub_policy.db,
        "get_latest_intake_secret_scrub_policy",
        lambda _tenant: {
            "id": "33333333-3333-4333-8333-333333333333",
            "version_number": 4,
            "content_fingerprint": "deadbeef",
            "mode": "warn_only",
            "entropy_detection": False,
            "format_overrides": {"har": {"mode": "enforce"}},
        },
    )
    policy = load_tenant_scrub_policy("22222222-2222-4222-8222-222222222222")
    assert policy.mode == MODE_WARN_ONLY
    assert policy.entropy_detection is False
    assert policy.version_number == 4
    assert policy.is_default is False


# --- fingerprinting ---------------------------------------------------------------------


def test_fingerprint_is_stable_and_content_addressed():
    args = {"mode": MODE_WARN_ONLY, "entropy_detection": True, "format_overrides": {"har": {"mode": "enforce"}}}
    assert scrub_policy_content_fingerprint(**args) == scrub_policy_content_fingerprint(**args)
    changed = dict(args, mode=MODE_ENFORCE)
    assert scrub_policy_content_fingerprint(**changed) != scrub_policy_content_fingerprint(**args)
    assert len(scrub_policy_content_fingerprint(**args)) == 64
