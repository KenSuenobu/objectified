"""Custom-domain naming, DNS guidance and TLS lifecycle rules — Slate 10.1 (private-suite#119).

Unit tests over :mod:`app.slate_domains`. Everything here is pure, so no database, no resolver and
no clock: the reference time is passed in.

Weighted toward the claims the screen makes on this module's behalf:

* an apex is never handed a CNAME, because RFC 1034 forbids one beside the SOA and NS records
  every zone apex carries — an instruction that breaks the tenant's mail is worse than no
  instruction;
* a failed check says what was *found*, not merely that it failed;
* ``authorize_issuance`` is a single conjunction with no fallback, since it is the only thing
  standing between on-demand TLS and anyone pointing a hostname at this platform;
* a checklist item can be false. One that cannot is decoration.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.slate_domains import (
    HSTS_MAX_AGE_SECONDS,
    RENEWAL_WINDOW_DAYS,
    TLS_MIN_VERSION,
    SlateDomainError,
    authorize_issuance,
    build_checklist,
    challenge_record_name,
    default_verification_method,
    dns_instructions,
    evaluate_certificate,
    evaluate_verification,
    is_apex,
    normalize_host,
    registrable_domain,
    relative_record_name,
    validate_host,
    verification_token,
)

TARGET = "sites.apiome.app"
NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
SECRET = "test-verification-secret"


def _row(**overrides) -> dict:
    """A verified domain row with an active certificate, before per-test overrides."""
    row = {
        "host": "payments-docs.acme.io",
        "verification_method": "cname",
        "verification_status": "verified",
        "verification_checked_at": NOW,
        "verification_error": None,
        "tls_protocol": "TLSv1.3",
        "certificate_expires_at": NOW + timedelta(days=87),
        "auto_renew": True,
    }
    row.update(overrides)
    return row


class TestNormalizeHost:
    """What people paste, reduced to what everything else keys on."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("payments-docs.acme.io", "payments-docs.acme.io"),
            ("  PAYMENTS-Docs.Acme.IO  ", "payments-docs.acme.io"),
            ("https://payments-docs.acme.io/docs/v2?x=1", "payments-docs.acme.io"),
            ("http://payments-docs.acme.io:8443", "payments-docs.acme.io"),
            ("payments-docs.acme.io.", "payments-docs.acme.io"),
            ("https://user@payments-docs.acme.io", "payments-docs.acme.io"),
            ("", ""),
            ("   ", ""),
        ],
    )
    def test_it_strips_everything_that_is_not_the_host(self, raw: str, expected: str) -> None:
        assert normalize_host(raw) == expected

    def test_a_unicode_domain_becomes_its_a_label_so_dns_comparison_is_byte_for_byte(self) -> None:
        assert normalize_host("münchen.de") == "xn--mnchen-3ya.de"


class TestValidateHost:
    """The names that cannot serve a site, refused with a sentence rather than a stack trace."""

    def test_a_normal_subdomain_passes(self) -> None:
        assert validate_host("https://payments-docs.acme.io/") == "payments-docs.acme.io"

    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "localhost",
            "*.acme.io",
            "203.0.113.10",
            "-bad.acme.io",
            "bad-.acme.io",
            "acme.123",
        ],
    )
    def test_it_refuses_names_that_cannot_be_issued_for(self, raw: str) -> None:
        with pytest.raises(SlateDomainError) as exc:
            validate_host(raw)
        assert exc.value.code == "invalid-host"
        assert str(exc.value)  # a sentence, not an empty message

    def test_a_host_inside_the_platform_zone_is_refused_as_reserved(self) -> None:
        with pytest.raises(SlateDomainError) as exc:
            validate_host("tenant.sites.apiome.app", platform_zone=TARGET)
        assert exc.value.code == "reserved-host"
        assert TARGET in str(exc.value)

    def test_the_platform_zone_itself_is_refused(self) -> None:
        with pytest.raises(SlateDomainError) as exc:
            validate_host(TARGET, platform_zone=TARGET)
        assert exc.value.code == "reserved-host"

    def test_a_host_that_merely_ends_in_similar_text_is_not_reserved(self) -> None:
        # "notapiome.app" ends with "apiome.app" as a *string* but not as a DNS suffix.
        assert validate_host("docs.notsites.apiome.app.example", platform_zone=TARGET)


class TestZoneShape:
    """Whether a host is an apex decides which record it can be given."""

    @pytest.mark.parametrize(
        "host,apex",
        [
            ("acme.io", True),
            ("payments-docs.acme.io", False),
            ("acme.co.uk", True),
            ("docs.acme.co.uk", False),
        ],
    )
    def test_apex_detection_understands_multi_label_suffixes(self, host: str, apex: bool) -> None:
        assert is_apex(host) is apex

    def test_the_registrable_domain_is_what_the_provider_form_edits(self) -> None:
        assert registrable_domain("docs.acme.co.uk") == "acme.co.uk"
        assert registrable_domain("acme.io") == "acme.io"

    def test_a_record_name_is_phrased_relative_to_that_zone(self) -> None:
        assert relative_record_name("payments-docs.acme.io") == "payments-docs"
        assert relative_record_name("a.b.acme.io") == "a.b"
        assert relative_record_name("acme.io") == "@"

    def test_an_apex_defaults_to_txt_and_a_subdomain_to_cname(self) -> None:
        assert default_verification_method("acme.io") == "txt"
        assert default_verification_method("payments-docs.acme.io") == "cname"


class TestVerificationToken:
    """The token is published in public DNS, so it must be unguessable and stable."""

    def test_it_is_stable_for_a_host_so_a_returning_tenant_keeps_their_record(self) -> None:
        assert verification_token("acme.io", SECRET) == verification_token("acme.io", SECRET)

    def test_it_differs_per_host_so_one_tenant_cannot_reuse_anothers(self) -> None:
        assert verification_token("acme.io", SECRET) != verification_token("other.io", SECRET)

    def test_it_differs_per_secret_so_a_leaked_deployment_secret_does_not_travel(self) -> None:
        assert verification_token("acme.io", SECRET) != verification_token("acme.io", "other")

    def test_without_a_secret_it_refuses_rather_than_issuing_a_guessable_token(self) -> None:
        with pytest.raises(SlateDomainError) as exc:
            verification_token("acme.io", "")
        assert exc.value.code == "verification-secret-missing"


class TestDnsInstructions:
    """The rows the tenant copies into their provider."""

    def test_a_subdomain_gets_one_cname_that_both_proves_and_routes(self) -> None:
        records = dns_instructions("payments-docs.acme.io", dns_target=TARGET, token="t")
        assert len(records) == 1
        record = records[0]
        assert record.record_type == "CNAME"
        assert record.name == "payments-docs"
        assert record.value == TARGET
        assert record.ttl == 300
        assert record.purpose == "routing"

    def test_an_apex_is_never_given_a_cname(self) -> None:
        records = dns_instructions("acme.io", dns_target=TARGET, token="tok")
        assert [record.record_type for record in records] == ["TXT", "ALIAS"]
        assert all(record.record_type != "CNAME" for record in records)

    def test_an_apex_gets_both_a_proof_record_and_a_routing_record(self) -> None:
        records = dns_instructions("acme.io", dns_target=TARGET, token="tok")
        purposes = {record.purpose for record in records}
        assert purposes == {"verification", "routing"}
        txt = next(record for record in records if record.record_type == "TXT")
        assert txt.name == "_apiome-challenge"
        assert txt.value == "tok"

    def test_an_apex_note_explains_why_a_cname_is_impossible(self) -> None:
        records = dns_instructions("acme.io", dns_target=TARGET, token="tok")
        assert "SOA" in (records[0].note or "")

    def test_a_deep_apex_challenge_is_named_below_the_zone(self) -> None:
        records = dns_instructions(
            "docs.acme.io", dns_target=TARGET, token="tok", method="txt"
        )
        assert records[0].name == "_apiome-challenge.docs"

    def test_the_challenge_name_is_fully_qualified_under_the_host(self) -> None:
        assert challenge_record_name("acme.io") == "_apiome-challenge.acme.io"


class TestEvaluateVerification:
    """A failure is only useful if it says what was found."""

    def test_a_matching_cname_verifies(self) -> None:
        outcome = evaluate_verification(
            "payments-docs.acme.io",
            method="cname",
            dns_target=TARGET,
            token="t",
            observed_cname="sites.apiome.app.",
        )
        assert outcome.verified is True
        assert TARGET in outcome.detail

    def test_a_missing_cname_says_so_and_does_not_verify(self) -> None:
        outcome = evaluate_verification(
            "payments-docs.acme.io", method="cname", dns_target=TARGET, token="t"
        )
        assert outcome.verified is False
        assert "No CNAME record" in outcome.detail

    def test_a_wrong_cname_names_what_it_points_at_instead(self) -> None:
        outcome = evaluate_verification(
            "payments-docs.acme.io",
            method="cname",
            dns_target=TARGET,
            token="t",
            observed_cname="ghs.googlehosted.com",
        )
        assert outcome.verified is False
        assert "ghs.googlehosted.com" in outcome.detail
        assert outcome.observed == ("ghs.googlehosted.com",)

    def test_a_matching_txt_among_several_verifies(self) -> None:
        outcome = evaluate_verification(
            "acme.io",
            method="txt",
            dns_target=TARGET,
            token="apiome-domain-verification=abc",
            observed_txt=("v=spf1 -all", "apiome-domain-verification=abc"),
        )
        assert outcome.verified is True

    def test_a_txt_with_the_wrong_token_reports_the_records_it_saw(self) -> None:
        outcome = evaluate_verification(
            "acme.io",
            method="txt",
            dns_target=TARGET,
            token="apiome-domain-verification=abc",
            observed_txt=("apiome-domain-verification=zzz",),
        )
        assert outcome.verified is False
        assert outcome.observed == ("apiome-domain-verification=zzz",)

    def test_no_txt_at_all_names_the_record_that_is_missing(self) -> None:
        outcome = evaluate_verification(
            "acme.io", method="txt", dns_target=TARGET, token="tok"
        )
        assert outcome.verified is False
        assert "_apiome-challenge.acme.io" in outcome.detail


class TestEvaluateCertificate:
    """Remaining life, and whether the edge should already have renewed."""

    def test_nothing_observed_reports_unknown_rather_than_zero_days(self) -> None:
        state = evaluate_certificate(expires_at=None, now=NOW)
        assert state["known"] is False
        assert state["days_remaining"] is None
        assert state["expired"] is False
        assert state["renewal_due"] is False

    def test_days_remaining_truncates_rather_than_rounds_up(self) -> None:
        state = evaluate_certificate(expires_at=NOW + timedelta(hours=23), now=NOW)
        assert state["days_remaining"] == 0
        assert state["expired"] is False

    def test_a_fresh_certificate_is_not_due_for_renewal(self) -> None:
        state = evaluate_certificate(expires_at=NOW + timedelta(days=87), now=NOW)
        assert state["days_remaining"] == 87
        assert state["renewal_due"] is False
        assert state["renews_at"] == (NOW + timedelta(days=87 - RENEWAL_WINDOW_DAYS)).isoformat()

    def test_renewal_is_due_inside_the_window(self) -> None:
        state = evaluate_certificate(expires_at=NOW + timedelta(days=29), now=NOW)
        assert state["renewal_due"] is True
        assert state["expired"] is False

    def test_a_lapsed_certificate_is_expired_with_negative_days(self) -> None:
        state = evaluate_certificate(expires_at=NOW - timedelta(days=2), now=NOW)
        assert state["expired"] is True
        assert state["days_remaining"] < 0

    def test_a_naive_expiry_is_read_as_utc_rather_than_raising(self) -> None:
        state = evaluate_certificate(expires_at=datetime(2026, 11, 1), now=NOW)
        assert state["known"] is True
        assert state["days_remaining"] > 0


class TestAuthorizeIssuance:
    """The only thing between on-demand TLS and an open certificate mint."""

    def test_a_verified_auto_renewing_domain_is_allowed(self) -> None:
        allowed, reason = authorize_issuance(_row())
        assert allowed is True
        assert reason

    def test_an_unknown_host_is_refused(self) -> None:
        allowed, reason = authorize_issuance(None)
        assert allowed is False
        assert "No custom domain" in reason

    @pytest.mark.parametrize("status", ["pending", "failed"])
    def test_an_unverified_host_is_refused(self, status: str) -> None:
        allowed, _ = authorize_issuance(_row(verification_status=status))
        assert allowed is False

    def test_a_domain_with_renewal_switched_off_is_refused(self) -> None:
        allowed, reason = authorize_issuance(_row(auto_renew=False))
        assert allowed is False
        assert "switched off" in reason


class TestChecklist:
    """Three claims the screen makes, each of which can be false."""

    def test_a_healthy_domain_passes_every_item(self) -> None:
        items = build_checklist(_row(), now=NOW)
        assert [item.id for item in items] == ["dns-record", "tls-policy", "auto-renewal"]
        assert all(item.ok for item in items)

    def test_the_policy_item_states_the_version_and_the_hsts_max_age(self) -> None:
        item = build_checklist(_row(), now=NOW)[1]
        assert TLS_MIN_VERSION in item.label
        assert str(HSTS_MAX_AGE_SECONDS) in item.label

    def test_an_unverified_domain_that_was_never_checked_says_so(self) -> None:
        items = build_checklist(
            _row(verification_status="pending", verification_checked_at=None), now=NOW
        )
        assert items[0].ok is False
        assert "not been checked yet" in items[0].detail

    def test_a_failed_check_shows_the_observed_reason(self) -> None:
        items = build_checklist(
            _row(
                verification_status="failed",
                verification_error="acme.io is a CNAME to ghs.googlehosted.com, not to "
                "sites.apiome.app.",
            ),
            now=NOW,
        )
        assert items[0].ok is False
        assert "ghs.googlehosted.com" in items[0].detail

    def test_an_unprobed_host_does_not_claim_its_protocol_as_confirmed(self) -> None:
        item = build_checklist(_row(tls_protocol=None), now=NOW)[1]
        assert item.ok is False
        assert "Not yet confirmed" in item.detail

    def test_a_host_negotiating_below_the_policy_is_reported_as_a_discrepancy(self) -> None:
        item = build_checklist(_row(tls_protocol="TLSv1.2"), now=NOW)[1]
        assert item.ok is False
        assert "TLSv1.2" in item.detail

    def test_the_protocol_item_accepts_either_spelling_of_tls_1_3(self) -> None:
        assert build_checklist(_row(tls_protocol="TLS 1.3"), now=NOW)[1].ok is True

    def test_renewal_switched_off_fails_the_renewal_item_and_says_it_will_lapse(self) -> None:
        item = build_checklist(_row(auto_renew=False), now=NOW)[2]
        assert item.ok is False
        assert "lapse" in item.detail

    def test_an_expired_certificate_fails_the_renewal_item(self) -> None:
        item = build_checklist(
            _row(certificate_expires_at=NOW - timedelta(days=1)), now=NOW
        )[2]
        assert item.ok is False
        assert "expired" in item.detail

    def test_a_txt_verified_domain_names_the_txt_record_rather_than_a_cname(self) -> None:
        items = build_checklist(_row(host="acme.io", verification_method="txt"), now=NOW)
        assert "TXT" in items[0].label
