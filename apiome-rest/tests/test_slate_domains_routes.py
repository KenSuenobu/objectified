"""Custom domain REST surface — Slate 10.1 (private-suite#119).

Route-level tests over :mod:`app.slate_domains_routes`, following the ``test_slate_cache_routes.py``
precedent: a module-level ``TestClient``, a mock auth dict, store functions patched *where used*,
and the DNS resolver and TLS probe supplied through their dependency overrides so no test opens a
socket.

The ticket's acceptance criterion — *a verified domain serves the site over auto-renewing TLS* —
is proven by :class:`TestAcceptance`, which walks the whole path with a fake resolver and a fake
probe: attach, publish the wrong record, fail with the reason, publish the right one, verify, and
watch ``/tls/authorize`` flip from 403 to 200. That last flip is the load-bearing one, because it
is literally what the edge asks before ordering a Let's Encrypt certificate, and everything after
it — issuance and renewal — is Caddy's, exercised by the config in ``deploy/Caddyfile``.

The claims nothing below is allowed to weaken:

* **``/tls/authorize`` is a single conjunction.** Unknown, unverified, or renewal-off ⇒ 403. It is
  unauthenticated, so a permissive branch here is an open certificate mint.
* **A failed check is a 200 that says what was found.** "The record isn't there yet" is the normal
  state of a domain attached ninety seconds ago, not an error banner.
* **An apex is never handed a CNAME.**
* **A cross-tenant probe gets 404, not 403.**
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.slate_auth import validate_slate_authentication
from app.slate_dns import TYPE_CNAME, TYPE_TXT, DnsAnswer, DnsError, StaticDnsResolver
from app.slate_domains_routes import get_dns_resolver, get_tls_probe
from app.slate_domains_store import SlateDomainConflictError, SlateDomainStoreError
from app.slate_tls_probe import StaticTlsProbe, TlsObservation, TlsProbeError

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
SITE = "22222222-2222-2222-2222-222222222222"
ENV = "33333333-3333-3333-3333-333333333333"
DOMAIN = "44444444-4444-4444-4444-444444444444"

HOST = "payments-docs.acme.io"
TARGET = "sites.apiome.app"
NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)

#: Certificate arithmetic in the routes runs against the real clock, so validity windows are
#: anchored to a single snapshot of it rather than to the fixed NOW used for the audit timestamps.
#: Taken once at import so the whole module still sees one deterministic reference. The hour of
#: slack absorbs the time the suite itself takes: days-remaining truncates toward zero (23 hours
#: left is 0 days left, deliberately), so an expiry of exactly ``+87 days`` would read as 86.
REAL_NOW = datetime.now(timezone.utc) + timedelta(hours=1)

_MOCK_JWT: Dict[str, Any] = {
    "tenant_id": TENANT,
    "tenant_slug": "acme",
    "user_id": "user-1",
    "email": "ken@example.com",
    "auth_type": "jwt",
}

ENVIRONMENT = {"id": ENV, "site_id": SITE, "tenant_id": TENANT, "kind": "production", "name": "prod"}


def domain_row(**overrides) -> Dict[str, Any]:
    """A pending, unverified domain row, before per-test overrides."""
    row = {
        "id": DOMAIN,
        "tenant_id": TENANT,
        "site_id": SITE,
        "environment_id": ENV,
        "host": HOST,
        "is_primary": True,
        "tls_status": "pending",
        "verification_status": "pending",
        "verification_token": "apiome-domain-verification=abc123",
        "verification_method": "cname",
        "verification_checked_at": None,
        "verification_error": None,
        "verified_at": None,
        "dns_target": TARGET,
        "certificate_issuer": None,
        "certificate_expires_at": None,
        "certificate_issued_at": None,
        "certificate_serial": None,
        "certificate_checked_at": None,
        "tls_protocol": None,
        "tls_error": None,
        "auto_renew": True,
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(overrides)
    return row


def verified_row(**overrides) -> Dict[str, Any]:
    """A verified domain serving a live Let's Encrypt certificate."""
    fields: Dict[str, Any] = {
        "verification_status": "verified",
        "verified_at": NOW,
        "verification_checked_at": NOW,
        "tls_status": "active",
        "certificate_issuer": "Let's Encrypt (R11)",
        "certificate_serial": "04A1",
        "certificate_issued_at": REAL_NOW - timedelta(days=3),
        "certificate_expires_at": REAL_NOW + timedelta(days=87),
        "certificate_checked_at": NOW,
        "tls_protocol": "TLSv1.3",
    }
    fields.update(overrides)
    return domain_row(**fields)


def observation(**overrides) -> TlsObservation:
    """A successful TLS handshake with a Let's Encrypt certificate."""
    fields = {
        "protocol": "TLSv1.3",
        "issuer": "Let's Encrypt (R11)",
        "subject": HOST,
        "serial": "04A1",
        "not_before": REAL_NOW - timedelta(days=3),
        "not_after": REAL_NOW + timedelta(days=87),
        "san": (HOST,),
        "observed_at": NOW,
    }
    fields.update(overrides)
    return TlsObservation(**fields)


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_slate_authentication] = lambda: dict(_MOCK_JWT)
    yield
    app.dependency_overrides.pop(validate_slate_authentication, None)


@pytest.fixture(autouse=True)
def _permissions():
    """Allow by default; individual tests re-patch to assert the required permission."""
    with patch("app.slate_domains_routes.enforce_permission") as enforce:
        yield enforce


@pytest.fixture(autouse=True)
def _lane():
    """Resolve the lane for every route that needs one."""
    with patch(
        "app.slate_domains_routes.get_environment_scope", return_value=dict(ENVIRONMENT)
    ) as scope:
        yield scope


@pytest.fixture
def resolver():
    """Install a table-driven resolver and hand it back so tests can populate it."""
    answers: Dict[Any, DnsAnswer] = {}
    app.dependency_overrides[get_dns_resolver] = lambda: StaticDnsResolver(answers)
    yield answers
    app.dependency_overrides.pop(get_dns_resolver, None)


@pytest.fixture
def probe():
    """Install a table-driven TLS probe and hand it back so tests can populate it."""
    observations: Dict[str, Any] = {}
    app.dependency_overrides[get_tls_probe] = lambda: StaticTlsProbe(observations)
    yield observations
    app.dependency_overrides.pop(get_tls_probe, None)


class TestListDomains:
    """What the lane's inventory reports."""

    def test_a_lane_with_no_domains_returns_the_edge_policy_anyway(self) -> None:
        with patch("app.slate_domains_routes.list_domains", return_value=[]):
            response = client.get(f"/v1/slate/environments/{ENV}/domains")
        assert response.status_code == 200
        body = response.json()
        assert body["domains"] == []
        assert body["tlsPolicy"]["minVersion"] == "TLS 1.3"
        assert body["tlsPolicy"]["hstsMaxAgeSeconds"] == 31_536_000
        assert body["tlsPolicy"]["issuer"] == "Let's Encrypt"
        assert body["dnsTarget"]

    def test_each_domain_carries_its_records_checklist_and_certificate(self) -> None:
        with patch("app.slate_domains_routes.list_domains", return_value=[verified_row()]):
            body = client.get(f"/v1/slate/environments/{ENV}/domains").json()
        domain = body["domains"][0]
        assert domain["host"] == HOST
        assert [record["recordType"] for record in domain["records"]] == ["CNAME"]
        assert [item["id"] for item in domain["checklist"]] == [
            "dns-record",
            "tls-policy",
            "auto-renewal",
        ]
        assert domain["certificate"]["known"] is True
        assert domain["certificate"]["daysRemaining"] == 87
        assert domain["certificate"]["issuer"] == "Let's Encrypt (R11)"

    def test_the_dns_rows_are_regenerated_from_the_current_target_not_frozen_at_attach(
        self,
    ) -> None:
        stale = verified_row(dns_target="old-sites.apiome.app")
        with patch("app.slate_domains_routes.list_domains", return_value=[stale]):
            body = client.get(f"/v1/slate/environments/{ENV}/domains").json()
        # The row's own target is what the tenant was told; changing the deployment's target
        # changes the instruction for everyone, which is why the records are derived, not stored.
        assert body["domains"][0]["records"][0]["value"] == "old-sites.apiome.app"

    def test_a_lane_in_another_tenant_answers_404_not_403(self, _lane) -> None:
        _lane.return_value = None
        response = client.get(f"/v1/slate/environments/{ENV}/domains")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "environment_not_found"

    def test_reading_requires_the_view_permission(self, _permissions) -> None:
        with patch("app.slate_domains_routes.list_domains", return_value=[]):
            client.get(f"/v1/slate/environments/{ENV}/domains")
        _, args, _ = _permissions.mock_calls[0]
        assert (args[2], args[3]) == ("versions", "view")


class TestAttachDomain:
    """Adding a hostname, and answering with what makes it work."""

    def test_attaching_answers_201_with_the_dns_records_to_publish(self) -> None:
        with patch(
            "app.slate_domains_routes.attach_domain", return_value=domain_row()
        ) as attach:
            response = client.post(
                f"/v1/slate/environments/{ENV}/domains", json={"host": f"https://{HOST}/docs"}
            )
        assert response.status_code == 201
        domain = response.json()["domain"]
        assert domain["host"] == HOST  # normalized out of the pasted URL
        assert domain["records"][0]["recordType"] == "CNAME"
        assert domain["records"][0]["name"] == "payments-docs"
        assert attach.call_args.kwargs["verification_method"] == "cname"

    def test_a_new_domain_is_neither_verified_nor_provisioning(self) -> None:
        with patch("app.slate_domains_routes.attach_domain", return_value=domain_row()):
            domain = client.post(
                f"/v1/slate/environments/{ENV}/domains", json={"host": HOST}
            ).json()["domain"]
        assert domain["verificationStatus"] == "pending"
        assert domain["tlsStatus"] == "pending"
        assert domain["certificate"]["known"] is False

    def test_an_apex_is_given_a_txt_challenge_and_never_a_cname(self) -> None:
        row = domain_row(host="acme.io", verification_method="txt")
        with patch("app.slate_domains_routes.attach_domain", return_value=row) as attach:
            domain = client.post(
                f"/v1/slate/environments/{ENV}/domains", json={"host": "acme.io"}
            ).json()["domain"]
        assert attach.call_args.kwargs["verification_method"] == "txt"
        assert [record["recordType"] for record in domain["records"]] == ["TXT", "ALIAS"]
        assert domain["challengeRecord"] == "_apiome-challenge.acme.io"

    def test_the_verification_method_can_be_overridden_for_an_unusual_suffix(self) -> None:
        row = domain_row(host="docs.acme.io", verification_method="txt")
        with patch("app.slate_domains_routes.attach_domain", return_value=row) as attach:
            client.post(
                f"/v1/slate/environments/{ENV}/domains",
                json={"host": "docs.acme.io", "verificationMethod": "txt"},
            )
        assert attach.call_args.kwargs["verification_method"] == "txt"

    def test_an_unknown_verification_method_is_refused_with_a_sentence(self) -> None:
        response = client.post(
            f"/v1/slate/environments/{ENV}/domains",
            json={"host": HOST, "verificationMethod": "http"},
        )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid-verification-method"

    def test_an_unusable_hostname_is_refused_with_a_sentence(self) -> None:
        response = client.post(f"/v1/slate/environments/{ENV}/domains", json={"host": "localhost"})
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["code"] == "invalid-host"
        assert "full domain" in detail["message"]

    def test_a_host_inside_the_platform_zone_is_refused_as_reserved(self) -> None:
        response = client.post(
            f"/v1/slate/environments/{ENV}/domains", json={"host": "tenant.sites.apiome.app"}
        )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "reserved-host"

    def test_a_hostname_already_attached_elsewhere_answers_409(self) -> None:
        with patch(
            "app.slate_domains_routes.attach_domain", side_effect=SlateDomainConflictError(HOST)
        ):
            response = client.post(f"/v1/slate/environments/{ENV}/domains", json={"host": HOST})
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "domain_conflict"
        # Says the host is taken; says nothing about who holds it.
        assert HOST in detail["message"]
        assert "tenant" not in detail["message"].lower()

    def test_attaching_requires_the_publish_permission(self, _permissions) -> None:
        with patch("app.slate_domains_routes.attach_domain", return_value=domain_row()):
            client.post(f"/v1/slate/environments/{ENV}/domains", json={"host": HOST})
        _, args, _ = _permissions.mock_calls[0]
        assert (args[2], args[3]) == ("versions", "publish")


class TestVerifyDomain:
    """Reading the tenant's DNS and recording what was found."""

    def test_a_matching_cname_verifies_and_moves_tls_to_provisioning(self, resolver) -> None:
        resolver[(HOST, TYPE_CNAME)] = DnsAnswer(cname=TARGET)
        updated = domain_row(
            verification_status="verified",
            verified_at=NOW,
            verification_checked_at=NOW,
            tls_status="provisioning",
        )
        with (
            patch("app.slate_domains_routes.get_domain", return_value=domain_row()),
            patch("app.slate_domains_routes.record_verification", return_value=updated) as record,
        ):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/verify")
        assert response.status_code == 200
        body = response.json()
        assert body["verified"] is True
        assert body["domain"]["tlsStatus"] == "provisioning"
        assert record.call_args.kwargs["verified"] is True

    def test_a_missing_record_is_a_200_that_says_what_is_missing(self, resolver) -> None:
        failed = domain_row(
            verification_status="failed",
            verification_checked_at=NOW,
            verification_error="No CNAME record was found for payments-docs.acme.io.",
        )
        with (
            patch("app.slate_domains_routes.get_domain", return_value=domain_row()),
            patch("app.slate_domains_routes.record_verification", return_value=failed),
        ):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/verify")
        assert response.status_code == 200
        assert response.json()["verified"] is False
        assert "No CNAME record" in response.json()["detail"]

    def test_a_record_pointing_somewhere_else_names_where(self, resolver) -> None:
        resolver[(HOST, TYPE_CNAME)] = DnsAnswer(cname="ghs.googlehosted.com")
        with (
            patch("app.slate_domains_routes.get_domain", return_value=domain_row()),
            patch("app.slate_domains_routes.record_verification", return_value=domain_row()),
        ):
            body = client.post(f"/v1/slate/domains/{DOMAIN}/verify").json()
        assert body["verified"] is False
        assert "ghs.googlehosted.com" in body["detail"]

    def test_an_apex_is_checked_against_its_txt_challenge(self, resolver) -> None:
        row = domain_row(
            host="acme.io",
            verification_method="txt",
            verification_token="apiome-domain-verification=abc123",
        )
        resolver[("_apiome-challenge.acme.io", TYPE_TXT)] = DnsAnswer(
            txt=("apiome-domain-verification=abc123",)
        )
        with (
            patch("app.slate_domains_routes.get_domain", return_value=row),
            patch("app.slate_domains_routes.record_verification", return_value=row),
        ):
            body = client.post(f"/v1/slate/domains/{DOMAIN}/verify").json()
        assert body["verified"] is True

    def test_a_resolver_failure_is_a_502_because_it_is_our_problem_not_the_tenants(self) -> None:
        class Broken:
            def query(self, name: str, record_type: int) -> DnsAnswer:
                raise DnsError("timeout", "The nameserver 1.1.1.1 did not answer within 3s.")

        app.dependency_overrides[get_dns_resolver] = Broken
        try:
            with patch("app.slate_domains_routes.get_domain", return_value=domain_row()):
                response = client.post(f"/v1/slate/domains/{DOMAIN}/verify")
        finally:
            app.dependency_overrides.pop(get_dns_resolver, None)
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "dns_unavailable"

    def test_a_domain_in_another_tenant_answers_404(self, resolver) -> None:
        with patch("app.slate_domains_routes.get_domain", return_value=None):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/verify")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "domain_not_found"


class TestProbeCertificate:
    """Measuring the live host rather than remembering what we think a CA did."""

    def test_a_successful_probe_records_the_observed_certificate(self, probe) -> None:
        probe[HOST] = observation()
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch(
                "app.slate_domains_routes.record_certificate", return_value=verified_row()
            ) as record,
        ):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/certificate")
        assert response.status_code == 200
        assert record.call_args.kwargs["issuer"] == "Let's Encrypt (R11)"
        assert record.call_args.kwargs["serial"] == "04A1"
        assert record.call_args.kwargs["protocol"] == "TLSv1.3"
        certificate = response.json()["domain"]["certificate"]
        assert certificate["daysRemaining"] == 87
        assert certificate["checkedAt"] is not None

    def test_a_renewal_is_detected_by_the_serial_changing(self, probe) -> None:
        probe[HOST] = observation(serial="09FF", not_after=REAL_NOW + timedelta(days=90))
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch(
                "app.slate_domains_routes.record_certificate", return_value=verified_row()
            ) as record,
        ):
            client.post(f"/v1/slate/domains/{DOMAIN}/certificate")
        assert record.call_args.kwargs["serial"] == "09FF"

    def test_an_unreachable_host_is_recorded_as_an_error_state_not_raised(self, probe) -> None:
        errored = verified_row(tls_status="error", tls_error="acme.io could not be reached.")
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch(
                "app.slate_domains_routes.record_certificate_error", return_value=errored
            ) as record,
        ):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/certificate")
        assert response.status_code == 200
        assert response.json()["domain"]["tlsStatus"] == "error"
        assert response.json()["domain"]["certificate"]["error"]
        assert "could not be reached" in record.call_args.kwargs["error"]

    def test_a_certificate_that_does_not_verify_is_reported_rather_than_swallowed(
        self, probe
    ) -> None:
        probe[HOST] = TlsProbeError("certificate", f"{HOST} served a certificate that does not verify.")
        errored = verified_row(tls_status="error", tls_error="does not verify")
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch("app.slate_domains_routes.record_certificate_error", return_value=errored),
        ):
            body = client.post(f"/v1/slate/domains/{DOMAIN}/certificate").json()
        assert body["domain"]["tlsStatus"] == "error"


class TestPrimaryAndRenewal:
    """Canonical host and the renewal switch."""

    def test_a_verified_domain_can_become_the_canonical_host(self) -> None:
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch("app.slate_domains_routes.set_primary", return_value=verified_row()) as promote,
        ):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/primary")
        assert response.status_code == 200
        assert response.json()["domain"]["isPrimary"] is True
        assert promote.call_args.kwargs["domain_id"] == DOMAIN

    def test_an_unverified_domain_cannot_become_canonical(self) -> None:
        with patch("app.slate_domains_routes.get_domain", return_value=domain_row()):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/primary")
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "domain_not_verified"
        assert "redirect" in detail["message"]

    def test_renewal_can_be_switched_off(self) -> None:
        parked = verified_row(auto_renew=False)
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch("app.slate_domains_routes.set_auto_renew", return_value=parked) as toggle,
        ):
            response = client.post(
                f"/v1/slate/domains/{DOMAIN}/renewal", json={"autoRenew": False}
            )
        assert response.status_code == 200
        assert toggle.call_args.kwargs["enabled"] is False
        assert response.json()["domain"]["certificate"]["autoRenew"] is False

    def test_a_parked_domain_says_its_certificate_will_lapse(self) -> None:
        parked = verified_row(auto_renew=False)
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch("app.slate_domains_routes.set_auto_renew", return_value=parked),
        ):
            body = client.post(
                f"/v1/slate/domains/{DOMAIN}/renewal", json={"autoRenew": False}
            ).json()
        renewal = next(
            item for item in body["domain"]["checklist"] if item["id"] == "auto-renewal"
        )
        assert renewal["ok"] is False
        assert "lapse" in renewal["detail"]


class TestDetachDomain:
    """Removing a hostname."""

    def test_detaching_answers_204(self) -> None:
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch("app.slate_domains_routes.detach_domain", return_value=verified_row()) as detach,
        ):
            response = client.delete(f"/v1/slate/domains/{DOMAIN}")
        assert response.status_code == 204
        assert detach.call_args.kwargs["domain_id"] == DOMAIN

    def test_detaching_a_domain_in_another_tenant_answers_404(self) -> None:
        with patch("app.slate_domains_routes.get_domain", return_value=None):
            assert client.delete(f"/v1/slate/domains/{DOMAIN}").status_code == 404

    def test_detaching_requires_the_publish_permission(self, _permissions) -> None:
        with (
            patch("app.slate_domains_routes.get_domain", return_value=verified_row()),
            patch("app.slate_domains_routes.detach_domain", return_value=verified_row()),
        ):
            client.delete(f"/v1/slate/domains/{DOMAIN}")
        _, args, _ = _permissions.mock_calls[0]
        assert (args[2], args[3]) == ("versions", "publish")


class TestAuthorizeEndpoint:
    """The edge's on-demand TLS gate. Unauthenticated, so every branch matters."""

    def test_a_verified_auto_renewing_host_is_authorized(self) -> None:
        with patch("app.slate_domains_routes.get_domain_by_host", return_value=verified_row()):
            response = client.get("/v1/slate/tls/authorize", params={"domain": HOST})
        assert response.status_code == 200
        assert response.json()["allowed"] is True
        assert response.json()["domain"] == HOST

    def test_an_unknown_host_is_refused_403_so_caddy_orders_nothing(self) -> None:
        with patch("app.slate_domains_routes.get_domain_by_host", return_value=None):
            response = client.get("/v1/slate/tls/authorize", params={"domain": "evil.example"})
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "domain_not_authorized"

    def test_an_unverified_host_is_refused(self) -> None:
        with patch("app.slate_domains_routes.get_domain_by_host", return_value=domain_row()):
            response = client.get("/v1/slate/tls/authorize", params={"domain": HOST})
        assert response.status_code == 403

    def test_a_host_with_renewal_switched_off_is_refused(self) -> None:
        with patch(
            "app.slate_domains_routes.get_domain_by_host",
            return_value=verified_row(auto_renew=False),
        ):
            response = client.get("/v1/slate/tls/authorize", params={"domain": HOST})
        assert response.status_code == 403

    def test_an_ip_literal_over_sni_is_refused_without_a_database_read(self) -> None:
        with patch("app.slate_domains_routes.get_domain_by_host") as lookup:
            response = client.get("/v1/slate/tls/authorize", params={"domain": "203.0.113.10"})
        assert response.status_code == 403
        lookup.assert_not_called()

    def test_the_host_is_normalized_before_it_is_looked_up(self) -> None:
        with patch(
            "app.slate_domains_routes.get_domain_by_host", return_value=verified_row()
        ) as lookup:
            client.get("/v1/slate/tls/authorize", params={"domain": "Payments-Docs.ACME.io."})
        assert lookup.call_args.kwargs["host"] == HOST

    def test_it_needs_no_session_because_the_caller_is_a_handshake(self) -> None:
        # Every other route on this surface is gated; this one cannot be, so the absence of a
        # session must be proven rather than assumed from the fixture happening to install one.
        app.dependency_overrides.pop(validate_slate_authentication, None)
        with patch("app.slate_domains_routes.get_domain_by_host", return_value=verified_row()):
            response = client.get("/v1/slate/tls/authorize", params={"domain": HOST})
        assert response.status_code == 200


class TestAcceptance:
    """*A verified domain serves the site over auto-renewing TLS.*

    The whole path, with a fake resolver and a fake probe standing in for the tenant's DNS and the
    live host. The step that carries the criterion is the last one: ``/tls/authorize`` flipping to
    200 is exactly what Caddy asks before ordering a Let's Encrypt certificate, and issuance plus
    automatic renewal from that point on are properties of ``deploy/Caddyfile``, not of this
    service.
    """

    def test_attach_fail_fix_verify_then_authorize_and_observe_the_certificate(
        self, resolver, probe
    ) -> None:
        # 1. Attach. Nothing is verified and nothing is being provisioned.
        with patch("app.slate_domains_routes.attach_domain", return_value=domain_row()):
            attached = client.post(
                f"/v1/slate/environments/{ENV}/domains", json={"host": HOST}
            ).json()["domain"]
        assert attached["verificationStatus"] == "pending"
        assert attached["tlsStatus"] == "pending"
        record = attached["records"][0]
        assert (record["recordType"], record["name"], record["value"]) == (
            "CNAME",
            "payments-docs",
            TARGET,
        )

        # 2. The edge will not order a certificate for it yet.
        with patch("app.slate_domains_routes.get_domain_by_host", return_value=domain_row()):
            assert client.get("/v1/slate/tls/authorize", params={"domain": HOST}).status_code == 403

        # 3. The tenant points it at the wrong place. The check says where.
        resolver[(HOST, TYPE_CNAME)] = DnsAnswer(cname="ghs.googlehosted.com")
        failed_row = domain_row(
            verification_status="failed",
            verification_checked_at=NOW,
            verification_error=f"{HOST} is a CNAME to ghs.googlehosted.com, not to {TARGET}.",
        )
        with (
            patch("app.slate_domains_routes.get_domain", return_value=domain_row()),
            patch("app.slate_domains_routes.record_verification", return_value=failed_row),
        ):
            failed = client.post(f"/v1/slate/domains/{DOMAIN}/verify").json()
        assert failed["verified"] is False
        assert "ghs.googlehosted.com" in failed["detail"]
        assert failed["domain"]["checklist"][0]["ok"] is False

        # 4. They fix the record. Verification passes and issuance becomes legitimate.
        resolver[(HOST, TYPE_CNAME)] = DnsAnswer(cname=f"{TARGET}.")
        provisioning = domain_row(
            verification_status="verified",
            verified_at=NOW,
            verification_checked_at=NOW,
            tls_status="provisioning",
        )
        with (
            patch("app.slate_domains_routes.get_domain", return_value=failed_row),
            patch("app.slate_domains_routes.record_verification", return_value=provisioning),
        ):
            verified = client.post(f"/v1/slate/domains/{DOMAIN}/verify").json()
        assert verified["verified"] is True
        assert verified["domain"]["tlsStatus"] == "provisioning"

        # 5. The edge asks, and is now told yes. This is the certificate order being authorized.
        with patch("app.slate_domains_routes.get_domain_by_host", return_value=provisioning):
            allowed = client.get("/v1/slate/tls/authorize", params={"domain": HOST})
        assert allowed.status_code == 200
        assert allowed.json()["allowed"] is True

        # 6. Caddy issues. Probing the live host confirms what it is actually serving, and the
        #    checklist's three claims are now all true.
        probe[HOST] = observation()
        with (
            patch("app.slate_domains_routes.get_domain", return_value=provisioning),
            patch("app.slate_domains_routes.record_certificate", return_value=verified_row()),
        ):
            active = client.post(f"/v1/slate/domains/{DOMAIN}/certificate").json()["domain"]
        assert active["tlsStatus"] == "active"
        assert active["certificate"]["issuer"] == "Let's Encrypt (R11)"
        assert active["certificate"]["autoRenew"] is True
        assert active["certificate"]["expired"] is False
        assert all(item["ok"] for item in active["checklist"])

    def test_renewal_becomes_due_before_the_certificate_lapses(self) -> None:
        # Renewal is the edge's job; what this surface owes is a countdown that goes true while
        # there is still a month to fix it, not on the morning it expires.
        soon = verified_row(certificate_expires_at=REAL_NOW + timedelta(days=20))
        with patch("app.slate_domains_routes.list_domains", return_value=[soon]):
            body = client.get(f"/v1/slate/environments/{ENV}/domains").json()
        certificate = body["domains"][0]["certificate"]
        assert certificate["renewalDue"] is True
        assert certificate["expired"] is False


class TestStoreErrorMapping:
    """A row that vanished between the read and the write is a 404, not a 500."""

    def test_a_domain_deleted_mid_request_answers_404(self, resolver) -> None:
        resolver[(HOST, TYPE_CNAME)] = DnsAnswer(cname=TARGET)
        with (
            patch("app.slate_domains_routes.get_domain", return_value=domain_row()),
            patch(
                "app.slate_domains_routes.record_verification",
                side_effect=SlateDomainStoreError("domain_not_found", "Domain was not found."),
            ),
        ):
            response = client.post(f"/v1/slate/domains/{DOMAIN}/verify")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "domain_not_found"
