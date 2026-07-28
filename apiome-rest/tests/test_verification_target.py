"""Tests for the verification-target contract (ECA-1.2, #4730).

``app.verification_target`` is the pure, database-free half of the target registry. These tests pin
the invariants the ticket's acceptance criteria turn into rules:

* **URL validation blocks private-network SSRF by default** — scheme, embedded credentials, and
  every non-routable address class, with a stable code per refusal;
* **a target holds a credential reference, never a credential** — the per-kind shape rules make a
  pasted token unstorable;
* **a run record carries a target identity, never credentials** — :func:`target_identity` is
  asserted to contain the identity fields and nothing that points at a secret;
* selection re-checks what a read tolerates: retired, disabled, and moved-inward targets.

The private-address cases use IP **literals** so the real guard runs without any DNS traffic, and
``ssrf_allow_private`` is forced off so a developer's local override cannot make the suite lie.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.ssrf_guard import SSRFError
from app.verification_target import (
    AUTH_KIND_ENV,
    AUTH_KIND_NONE,
    AUTH_KIND_STORED,
    AUTH_SCHEME_BASIC,
    AUTH_SCHEME_BEARER,
    AUTH_SCHEME_HEADER,
    CODE_DISABLED,
    CODE_NOT_FOUND,
    CODE_PRIVATE_NOT_APPROVED,
    CODE_SLUG_INVALID,
    CODE_URL_CREDENTIALS,
    CODE_URL_MALFORMED,
    CODE_URL_PRIVATE_NETWORK,
    CODE_URL_SCHEME,
    CODE_URL_UNRESOLVABLE,
    ENVIRONMENT_PRODUCTION,
    NETWORK_CLASS_PRIVATE,
    NETWORK_CLASS_PUBLIC,
    TargetAuthReference,
    TargetValidationError,
    VerificationPolicy,
    VerificationTargetInput,
    VerificationTargetPatch,
    auth_reference_from_row,
    normalize_base_url,
    policy_violations,
    record_from_row,
    resolve_target_record,
    target_identity,
    validate_base_url,
    validate_slug,
)

_TENANT = "11111111-1111-4111-8111-111111111111"
_TARGET = "22222222-2222-4222-8222-222222222222"
_CREDENTIAL = "33333333-3333-4333-8333-333333333333"


@pytest.fixture(autouse=True)
def _enforce_ssrf_filtering():
    """Force IP filtering on for every test, whatever the developer's environment says."""
    with patch("app.ssrf_guard.settings.ssrf_allow_private", False):
        yield


def _row(**overrides: Any) -> Dict[str, Any]:
    """A stored ``verification_target`` row, as the data layer returns one."""
    row: Dict[str, Any] = {
        "id": _TARGET,
        "tenant_id": _TENANT,
        "slug": "staging",
        "name": "Staging",
        "description": "Pre-production",
        "environment": "staging",
        "base_url": "https://staging.example.com/api",
        "network_class": NETWORK_CLASS_PUBLIC,
        "approved_by": None,
        "approved_at": None,
        "approval_reason": None,
        "auth_kind": AUTH_KIND_ENV,
        "auth_scheme": AUTH_SCHEME_BEARER,
        "auth_ref": "APIOME_STAGING_TOKEN",
        "auth_header_name": None,
        "policy": {"request_timeout_seconds": 15, "max_concurrency": 2},
        "enabled": True,
        "created_by": "44444444-4444-4444-8444-444444444444",
        "updated_by": None,
        "created_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
        "deleted_at": None,
    }
    row.update(overrides)
    return row


# ===========================================================================
# Slug
# ===========================================================================


@pytest.mark.parametrize("slug", ["a", "staging", "eu-prod", "v2-canary", "a" * 128])
def test_a_usable_handle_is_accepted(slug: str) -> None:
    assert validate_slug(slug) == slug


@pytest.mark.parametrize(
    "slug",
    ["", "-staging", "staging-", "Staging", "stag ing", "stag_ing", "a" * 129, "prod/eu"],
)
def test_an_unusable_handle_is_refused_with_a_code(slug: str) -> None:
    with pytest.raises(TargetValidationError) as exc:
        validate_slug(slug)
    assert exc.value.code == CODE_SLUG_INVALID


# ===========================================================================
# URL validation — the SSRF acceptance criterion
# ===========================================================================


def test_a_public_https_url_is_accepted_and_normalized() -> None:
    assert validate_base_url("https://93.184.216.34/api/") == "https://93.184.216.34/api"


def test_a_trailing_slash_never_survives_normalization() -> None:
    assert normalize_base_url("https://api.example.com/v1///") == "https://api.example.com/v1"
    assert normalize_base_url("  https://api.example.com  ") == "https://api.example.com"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8080",
        "http://10.0.0.5/api",
        "http://192.168.1.10",
        "http://169.254.169.254/latest/meta-data",  # the cloud metadata endpoint
        "http://[::1]/api",
        "http://[::ffff:10.0.0.1]/api",  # an internal IPv4 smuggled through IPv6
    ],
)
def test_a_private_address_is_blocked_by_default(url: str) -> None:
    with pytest.raises(TargetValidationError) as exc:
        validate_base_url(url)
    assert exc.value.code == CODE_URL_PRIVATE_NETWORK


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com", "data:text/plain,x"])
def test_a_disallowed_scheme_is_refused(url: str) -> None:
    with pytest.raises(TargetValidationError) as exc:
        validate_base_url(url)
    assert exc.value.code == CODE_URL_SCHEME


def test_a_url_with_embedded_credentials_is_refused() -> None:
    with pytest.raises(TargetValidationError) as exc:
        validate_base_url("https://user:secret@api.example.com")
    assert exc.value.code == CODE_URL_CREDENTIALS


def test_an_empty_url_is_refused() -> None:
    with pytest.raises(TargetValidationError) as exc:
        validate_base_url("   ")
    assert exc.value.code == CODE_URL_MALFORMED


def test_an_unresolvable_host_is_refused_rather_than_allowed() -> None:
    with patch(
        "app.verification_target.validate_host",
        side_effect=SSRFError("could not resolve host 'nope.invalid'"),
    ):
        with pytest.raises(TargetValidationError) as exc:
            validate_base_url("https://nope.invalid")
    assert exc.value.code == CODE_URL_UNRESOLVABLE


def test_a_declared_private_target_may_reach_a_private_address() -> None:
    # The escape hatch: declaring the network class is what makes an internal target legal, and
    # V211 refuses to store one without an approver and a reason.
    assert (
        validate_base_url("http://10.0.0.5/api", NETWORK_CLASS_PRIVATE) == "http://10.0.0.5/api"
    )


def test_a_private_declaration_does_not_relax_the_scheme_or_credential_rules() -> None:
    for url, code in (
        ("file:///etc/passwd", CODE_URL_SCHEME),
        ("http://user:pw@10.0.0.5", CODE_URL_CREDENTIALS),
    ):
        with pytest.raises(TargetValidationError) as exc:
            validate_base_url(url, NETWORK_CLASS_PRIVATE)
        assert exc.value.code == code


def test_skipping_resolution_still_runs_the_shape_checks() -> None:
    assert validate_base_url("https://api.example.com", resolve=False) == "https://api.example.com"
    with pytest.raises(TargetValidationError):
        validate_base_url("file:///etc/passwd", resolve=False)


# ===========================================================================
# Credential reference — a pointer, never a secret
# ===========================================================================


def test_a_none_reference_carries_nothing() -> None:
    reference = TargetAuthReference()
    assert reference.kind == AUTH_KIND_NONE
    assert reference.scheme is None and reference.ref is None


def test_a_none_reference_refuses_stray_fields() -> None:
    with pytest.raises(ValidationError):
        TargetAuthReference(kind=AUTH_KIND_NONE, ref="APIOME_TOKEN")


def test_an_env_reference_accepts_a_variable_name() -> None:
    reference = TargetAuthReference(
        kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref="APIOME_STAGING_TOKEN"
    )
    assert reference.ref == "APIOME_STAGING_TOKEN"


@pytest.mark.parametrize(
    "value",
    [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",  # a JWT
        "sk_live_51H8xYzAbCdEf",  # an API key
        "dG9rZW4tdmFsdWU=",  # base64
        "lowercase_name",
        "WITH SPACE",
        "9LEADING_DIGIT",
    ],
)
def test_an_env_reference_cannot_hold_a_secret(value: str) -> None:
    # The central invariant: this column holds a NAME. Every realistic secret shape fails the
    # environment-variable grammar, so a paste cannot become a stored credential.
    with pytest.raises(ValidationError):
        TargetAuthReference(kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref=value)


def test_a_stored_reference_must_be_a_vault_uuid() -> None:
    assert (
        TargetAuthReference(
            kind=AUTH_KIND_STORED, scheme=AUTH_SCHEME_BEARER, ref=_CREDENTIAL
        ).ref
        == _CREDENTIAL
    )
    with pytest.raises(ValidationError):
        TargetAuthReference(kind=AUTH_KIND_STORED, scheme=AUTH_SCHEME_BEARER, ref="a-token")


def test_a_referenced_credential_requires_a_presentation_scheme() -> None:
    with pytest.raises(ValidationError):
        TargetAuthReference(kind=AUTH_KIND_ENV, ref="APIOME_TOKEN")


def test_the_header_scheme_requires_a_token_grammar_name() -> None:
    reference = TargetAuthReference(
        kind=AUTH_KIND_ENV,
        scheme=AUTH_SCHEME_HEADER,
        ref="APIOME_TOKEN",
        header_name="X-Api-Key",
    )
    assert reference.header_name == "X-Api-Key"

    for bad in ["X-Api Key", "X:Key", "X-Key\r\nInjected", ""]:
        with pytest.raises(ValidationError):
            TargetAuthReference(
                kind=AUTH_KIND_ENV,
                scheme=AUTH_SCHEME_HEADER,
                ref="APIOME_TOKEN",
                header_name=bad,
            )


def test_a_header_name_is_meaningless_outside_the_header_scheme() -> None:
    with pytest.raises(ValidationError):
        TargetAuthReference(
            kind=AUTH_KIND_ENV,
            scheme=AUTH_SCHEME_BASIC,
            ref="APIOME_TOKEN",
            header_name="X-Api-Key",
        )


def test_an_unknown_reference_kind_or_scheme_is_refused() -> None:
    with pytest.raises(ValidationError):
        TargetAuthReference(kind="vault", scheme=AUTH_SCHEME_BEARER, ref="APIOME_TOKEN")
    with pytest.raises(ValidationError):
        TargetAuthReference(kind=AUTH_KIND_ENV, scheme="digest", ref="APIOME_TOKEN")


def test_a_reference_rebuilds_from_a_stored_row() -> None:
    reference = auth_reference_from_row(_row())
    assert (reference.kind, reference.scheme, reference.ref) == (
        AUTH_KIND_ENV,
        AUTH_SCHEME_BEARER,
        "APIOME_STAGING_TOKEN",
    )


def test_a_legacy_row_with_no_auth_columns_reads_as_anonymous() -> None:
    assert auth_reference_from_row({}).kind == AUTH_KIND_NONE


# ===========================================================================
# Policy
# ===========================================================================


def test_policy_defaults_are_the_safe_reading_of_verify_this_contract() -> None:
    policy = VerificationPolicy()
    assert policy.request_timeout_seconds == 30
    assert policy.max_concurrency == 4
    assert policy.retry_attempts == 0
    assert policy.allow_mutating_methods is False
    assert policy.follow_redirects is False
    assert policy.verify_tls is True
    assert policy.failure_action == "block"
    assert policy.max_allowed_failures == 0


@pytest.mark.parametrize(
    "field,value",
    [
        ("request_timeout_seconds", 0),
        ("request_timeout_seconds", 301),
        ("max_concurrency", 0),
        ("max_concurrency", 33),
        ("retry_attempts", 6),
        ("retry_backoff_ms", -1),
        ("max_allowed_failures", -1),
        ("failure_action", "ignore"),
    ],
)
def test_policy_bounds_are_enforced(field: str, value: Any) -> None:
    with pytest.raises(ValidationError):
        VerificationPolicy(**{field: value})


def test_tls_verification_may_only_be_disabled_on_a_private_target() -> None:
    policy = VerificationPolicy(verify_tls=False)
    assert policy_violations(network_class=NETWORK_CLASS_PUBLIC, policy=policy)
    assert not policy_violations(network_class=NETWORK_CLASS_PRIVATE, policy=policy)


def test_an_unknown_policy_field_is_refused_rather_than_ignored() -> None:
    with pytest.raises(ValidationError):
        VerificationPolicy(max_requests_per_second=10)


def test_a_stored_policy_from_another_contract_version_still_loads() -> None:
    # Configuration must keep loading across a field rename; an unknown key is dropped and a
    # missing one takes its default, so a tenant's target never becomes unreadable.
    record = record_from_row(_row(policy={"max_concurrency": 7, "legacy_field": "x"}))
    assert record.policy.max_concurrency == 7
    assert record.policy.request_timeout_seconds == 30


def test_a_stored_policy_outside_current_bounds_degrades_to_defaults() -> None:
    record = record_from_row(_row(policy={"max_concurrency": 9999}))
    assert record.policy.max_concurrency == 4


def test_a_missing_policy_column_reads_as_defaults() -> None:
    assert record_from_row(_row(policy=None)).policy.max_concurrency == 4


# ===========================================================================
# Definition models
# ===========================================================================


def test_a_definition_defaults_to_a_public_anonymous_staging_target() -> None:
    definition = VerificationTargetInput(
        slug="staging", name="Staging", base_url="https://staging.example.com"
    )
    assert definition.environment == "staging"
    assert definition.network_class == NETWORK_CLASS_PUBLIC
    assert definition.auth.kind == AUTH_KIND_NONE
    assert definition.enabled is True


def test_an_unknown_environment_or_network_class_is_refused() -> None:
    with pytest.raises(ValidationError):
        VerificationTargetInput(
            slug="s", name="S", base_url="https://x.example.com", environment="prod"
        )
    with pytest.raises(ValidationError):
        VerificationTargetInput(
            slug="s", name="S", base_url="https://x.example.com", network_class="internal"
        )


def test_a_definition_refuses_an_unknown_field() -> None:
    with pytest.raises(ValidationError):
        VerificationTargetInput(
            slug="s", name="S", base_url="https://x.example.com", secret="hunter2"
        )


def test_an_empty_patch_reports_no_changes() -> None:
    assert VerificationTargetPatch().has_changes() is False
    assert VerificationTargetPatch(enabled=False).has_changes() is True


def test_a_patch_that_clears_a_description_counts_as_a_change() -> None:
    # `exclude_unset` is what distinguishes "leave it alone" from "clear it".
    assert VerificationTargetPatch(description=None).has_changes() is True


# ===========================================================================
# Record adaptation and resolution
# ===========================================================================


def test_a_row_adapts_into_a_record() -> None:
    record = record_from_row(_row())
    assert record.id == _TARGET
    assert record.slug == "staging"
    assert record.base_url == "https://staging.example.com/api"
    assert record.auth.ref == "APIOME_STAGING_TOKEN"
    assert record.policy.request_timeout_seconds == 15


def test_resolution_returns_the_identity_endpoint_policy_and_reference() -> None:
    resolved = resolve_target_record(record_from_row(_row()), revalidate_url=False)
    assert resolved.target_id == _TARGET
    assert resolved.slug == "staging"
    assert resolved.base_url == "https://staging.example.com/api"
    assert resolved.policy.max_concurrency == 2
    assert resolved.auth.ref == "APIOME_STAGING_TOKEN"
    assert resolved.resolved_at.tzinfo is not None


def test_a_disabled_target_cannot_be_resolved() -> None:
    with pytest.raises(TargetValidationError) as exc:
        resolve_target_record(record_from_row(_row(enabled=False)), revalidate_url=False)
    assert exc.value.code == CODE_DISABLED


def test_a_retired_target_cannot_be_resolved() -> None:
    row = _row(deleted_at=datetime(2026, 7, 27, tzinfo=timezone.utc))
    with pytest.raises(TargetValidationError) as exc:
        resolve_target_record(record_from_row(row), revalidate_url=False)
    assert exc.value.code == CODE_NOT_FOUND


def test_resolution_rechecks_the_address_because_dns_moves() -> None:
    # A definition can look unchanged while its hostname starts answering with an internal
    # address; resolution is the moment that matters, so the check runs again there.
    row = _row(base_url="http://10.0.0.5/api")
    with pytest.raises(TargetValidationError) as exc:
        resolve_target_record(record_from_row(row))
    assert exc.value.code == CODE_URL_PRIVATE_NETWORK


def test_a_private_target_without_a_stated_reason_cannot_be_resolved() -> None:
    row = _row(base_url="http://10.0.0.5/api", network_class=NETWORK_CLASS_PRIVATE)
    with pytest.raises(TargetValidationError) as exc:
        resolve_target_record(record_from_row(row))
    assert exc.value.code == CODE_PRIVATE_NOT_APPROVED


def test_an_approved_private_target_resolves() -> None:
    row = _row(
        base_url="http://10.0.0.5/api",
        network_class=NETWORK_CLASS_PRIVATE,
        approval_reason="staging runs on the internal VPC",
        approved_by="44444444-4444-4444-8444-444444444444",
    )
    resolved = resolve_target_record(record_from_row(row))
    assert resolved.base_url == "http://10.0.0.5/api"


# ===========================================================================
# Run identity — never credentials
# ===========================================================================


def test_a_run_identity_names_the_target_and_nothing_that_points_at_a_secret() -> None:
    identity = target_identity(record_from_row(_row(environment=ENVIRONMENT_PRODUCTION)))
    assert identity == {
        "target_id": _TARGET,
        "slug": "staging",
        "environment": ENVIRONMENT_PRODUCTION,
        "network_class": NETWORK_CLASS_PUBLIC,
        "base_url": "https://staging.example.com/api",
    }
    serialized = str(identity)
    assert "APIOME_STAGING_TOKEN" not in serialized
    assert "auth" not in identity
