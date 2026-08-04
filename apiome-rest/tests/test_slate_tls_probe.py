"""Observing what a custom domain serves — Slate 10.1 (private-suite#119).

Unit tests over :mod:`app.slate_tls_probe`. No handshake is performed: what is pinned here is
:func:`parse_peer_certificate`, the pure mapping from ``ssl.SSLSocket.getpeercert()`` output onto
the fields the Custom Domain screen prints.

That mapping is worth testing precisely because ``ssl`` returns distinguished names as a nested
tuple-of-tuples rather than a dict, so "issuer" is an easy thing to read out of the wrong level and
end up rendering ``(('commonName', 'R11'),)`` at a tenant.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.slate_tls_probe import (
    StaticTlsProbe,
    TlsObservation,
    TlsProbeError,
    parse_peer_certificate,
)

OBSERVED_AT = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)

LETSENCRYPT_CERT = {
    "subject": ((("commonName", "payments-docs.acme.io"),),),
    "issuer": (
        (("countryName", "US"),),
        (("organizationName", "Let's Encrypt"),),
        (("commonName", "R11"),),
    ),
    "version": 3,
    "serialNumber": "04A1B2C3D4E5F60718293A4B5C6D7E8F",
    "notBefore": "Jul  6 09:14:22 2026 GMT",
    "notAfter": "Oct  4 09:14:21 2026 GMT",
    "subjectAltName": (("DNS", "payments-docs.acme.io"), ("DNS", "www.payments-docs.acme.io")),
}


class TestParsePeerCertificate:
    """The mapping the screen's "Issued by … Expires in …" line is built from."""

    def test_the_issuer_reads_as_a_person_would_say_it(self) -> None:
        observation = parse_peer_certificate(
            LETSENCRYPT_CERT, protocol="TLSv1.3", observed_at=OBSERVED_AT
        )
        assert observation.issuer == "Let's Encrypt (R11)"

    def test_the_validity_window_is_parsed_as_aware_utc(self) -> None:
        observation = parse_peer_certificate(
            LETSENCRYPT_CERT, protocol="TLSv1.3", observed_at=OBSERVED_AT
        )
        assert observation.not_before == datetime(2026, 7, 6, 9, 14, 22, tzinfo=timezone.utc)
        assert observation.not_after == datetime(2026, 10, 4, 9, 14, 21, tzinfo=timezone.utc)

    def test_the_serial_is_carried_through_because_it_is_how_renewal_is_detected(self) -> None:
        observation = parse_peer_certificate(
            LETSENCRYPT_CERT, protocol="TLSv1.3", observed_at=OBSERVED_AT
        )
        assert observation.serial == "04A1B2C3D4E5F60718293A4B5C6D7E8F"

    def test_the_negotiated_protocol_and_observation_time_are_recorded(self) -> None:
        observation = parse_peer_certificate(
            LETSENCRYPT_CERT, protocol="TLSv1.3", observed_at=OBSERVED_AT
        )
        assert observation.protocol == "TLSv1.3"
        assert observation.observed_at == OBSERVED_AT

    def test_subject_alternative_dns_names_are_collected(self) -> None:
        observation = parse_peer_certificate(
            LETSENCRYPT_CERT, protocol="TLSv1.3", observed_at=OBSERVED_AT
        )
        assert observation.san == ("payments-docs.acme.io", "www.payments-docs.acme.io")

    def test_an_issuer_with_only_an_organization_is_not_padded_with_empty_parentheses(self) -> None:
        cert = dict(LETSENCRYPT_CERT, issuer=((("organizationName", "Internal CA"),),))
        observation = parse_peer_certificate(cert, protocol="TLSv1.3", observed_at=OBSERVED_AT)
        assert observation.issuer == "Internal CA"

    def test_an_unreadable_date_is_reported_as_unknown_rather_than_guessed(self) -> None:
        # A guessed expiry would drive a renewal decision, so None is the only safe answer.
        cert = dict(LETSENCRYPT_CERT, notAfter="not a date")
        observation = parse_peer_certificate(cert, protocol="TLSv1.3", observed_at=OBSERVED_AT)
        assert observation.not_after is None

    def test_an_empty_certificate_is_refused(self) -> None:
        with pytest.raises(TlsProbeError) as exc:
            parse_peer_certificate({}, protocol="TLSv1.3", observed_at=OBSERVED_AT)
        assert exc.value.code == "no-certificate"


class TestStaticTlsProbe:
    """The seam the service is tested through."""

    def test_it_returns_the_configured_observation(self) -> None:
        observation = parse_peer_certificate(
            LETSENCRYPT_CERT, protocol="TLSv1.3", observed_at=OBSERVED_AT
        )
        probe = StaticTlsProbe({"payments-docs.acme.io": observation})
        assert probe.observe("Payments-Docs.acme.io") is observation

    def test_a_configured_failure_is_raised(self) -> None:
        probe = StaticTlsProbe({"acme.io": TlsProbeError("certificate", "expired")})
        with pytest.raises(TlsProbeError) as exc:
            probe.observe("acme.io")
        assert exc.value.code == "certificate"

    def test_an_unknown_host_is_unreachable_like_an_unpointed_domain(self) -> None:
        with pytest.raises(TlsProbeError) as exc:
            StaticTlsProbe().observe("acme.io")
        assert exc.value.code == "unreachable"

    def test_an_observation_carries_every_field_the_wire_model_needs(self) -> None:
        observation = TlsObservation(
            protocol="TLSv1.3",
            issuer="Let's Encrypt (R11)",
            subject="acme.io",
            serial="01",
            not_before=OBSERVED_AT,
            not_after=OBSERVED_AT,
            san=("acme.io",),
            observed_at=OBSERVED_AT,
        )
        assert observation.issuer and observation.serial and observation.protocol
