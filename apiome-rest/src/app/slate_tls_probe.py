"""Observing what a custom domain is actually serving — Slate 10.1 (private-suite#119).

Certificates for custom domains are obtained and renewed by the edge (``deploy/Caddyfile`` — Caddy
with on-demand TLS against Let's Encrypt, renewing automatically). Nothing in this service issues
one, and nothing here should pretend to know what the CA did.

So the certificate state this surface reports is measured, not remembered: :class:`SystemTlsProbe`
completes a TLS handshake with the host on port 443 and reads the peer certificate. The issuer, the
serial, the validity window and the negotiated protocol are then facts about the live host at a
named instant, which is the only version of "certificate active" worth putting on a screen. A
renewal is *detected* — the serial changes — rather than assumed from a timer.

:class:`TlsProbe` is the seam: the service depends on the protocol, so tests supply observations
directly and no test opens a socket.

**Deliberate limits.** One handshake to port 443 with hostname verification on, a short timeout,
no HTTP request and no content check — this answers "what certificate is this host serving", not
"is the site healthy". A failed handshake is reported with its reason and never downgrades to a
lenient retry: a probe that disabled verification in order to get an answer would report a
certificate that browsers reject as if it were fine.
"""

from __future__ import annotations

import socket
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Protocol, Sequence, Tuple

__all__ = [
    "TlsObservation",
    "TlsProbe",
    "TlsProbeError",
    "StaticTlsProbe",
    "SystemTlsProbe",
    "parse_peer_certificate",
]


class TlsProbeError(Exception):
    """The host could not be probed, or served a certificate that does not verify.

    Attributes:
        code: Stable reason — ``unreachable``, ``timeout``, ``handshake``, ``certificate`` or
            ``no-certificate``.
        message: An operator-facing sentence naming what happened.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class TlsObservation:
    """What one handshake with a host revealed.

    Attributes:
        protocol: The negotiated protocol as ``ssl`` names it, e.g. ``TLSv1.3``.
        issuer: The issuing CA's common name (``R11``) qualified by its organization
            (``Let's Encrypt``), which is what the mockup's "Issued by" line shows.
        subject: The certificate's common name, when it has one.
        serial: The certificate serial. Changes on renewal, so comparing it is how a renewal is
            observed rather than inferred.
        not_before: Start of the validity window, UTC.
        not_after: End of the validity window, UTC — what renewal counts down to.
        san: Every subject-alternative DNS name, so a certificate that verifies for the host but
            was issued for a different set can still be inspected.
        observed_at: When the handshake completed.
    """

    protocol: str
    issuer: str
    subject: Optional[str]
    serial: Optional[str]
    not_before: Optional[datetime]
    not_after: Optional[datetime]
    san: Tuple[str, ...]
    observed_at: datetime


class TlsProbe(Protocol):
    """The TLS surface the domain service depends on."""

    def observe(self, host: str, *, port: int = 443) -> TlsObservation:
        """Complete a handshake with ``host`` and describe the certificate it served.

        Args:
            host: The hostname to connect to and verify against.
            port: The port; 443 outside tests.

        Returns:
            The observation.

        Raises:
            TlsProbeError: When the host could not be reached or its certificate does not verify.
        """
        ...


def _rdn_value(rdn: Sequence[Any], key: str) -> Optional[str]:
    """Pull one attribute out of ``ssl``'s nested RDN representation.

    ``getpeercert()`` returns a distinguished name as a tuple of relative distinguished names,
    each itself a tuple of ``(key, value)`` pairs. This flattens the search.

    Args:
        rdn: The nested structure from ``getpeercert()``.
        key: The attribute to find, e.g. ``commonName``.

    Returns:
        The first matching value, or None.
    """
    for part in rdn or ():
        for entry in part or ():
            if len(entry) == 2 and entry[0] == key:
                return str(entry[1])
    return None


def _parse_cert_time(value: Optional[str]) -> Optional[datetime]:
    """Convert an ``ssl`` certificate timestamp to an aware UTC datetime.

    Args:
        value: A string such as ``Jun  1 12:00:00 2026 GMT``.

    Returns:
        The parsed time, or None when absent or unparseable — an unreadable date is reported as
        unknown rather than guessed, because a guessed expiry drives a renewal decision.
    """
    if not value:
        return None
    try:
        return datetime.fromtimestamp(ssl.cert_time_to_seconds(value), tz=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def parse_peer_certificate(
    cert: Dict[str, Any], *, protocol: str, observed_at: datetime
) -> TlsObservation:
    """Turn ``ssl.SSLSocket.getpeercert()`` output into a :class:`TlsObservation`.

    Pure, so the mapping — including the issuer phrasing the UI prints — is pinned by tests
    without a network.

    Args:
        cert: The decoded peer certificate.
        protocol: The negotiated protocol name.
        observed_at: When the handshake completed.

    Returns:
        The observation.

    Raises:
        TlsProbeError: ``no-certificate`` when the peer supplied nothing to read.
    """
    if not cert:
        raise TlsProbeError(
            "no-certificate",
            "The host completed a handshake but presented no certificate that could be read.",
        )

    issuer_cn = _rdn_value(cert.get("issuer", ()), "commonName")
    issuer_org = _rdn_value(cert.get("issuer", ()), "organizationName")
    if issuer_cn and issuer_org and issuer_cn != issuer_org:
        issuer = f"{issuer_org} ({issuer_cn})"
    else:
        issuer = issuer_org or issuer_cn or "unknown issuer"

    san = tuple(
        value for kind, value in cert.get("subjectAltName", ()) if kind.lower() == "dns" and value
    )

    return TlsObservation(
        protocol=protocol,
        issuer=issuer,
        subject=_rdn_value(cert.get("subject", ()), "commonName"),
        serial=cert.get("serialNumber"),
        not_before=_parse_cert_time(cert.get("notBefore")),
        not_after=_parse_cert_time(cert.get("notAfter")),
        san=san,
        observed_at=observed_at,
    )


class SystemTlsProbe:
    """Opens a verified TLS connection to the host and reads its certificate.

    Args:
        timeout: Connect and handshake timeout in seconds. Short because an operator is waiting.
        context: An ``ssl`` context to use. The default verifies hostnames and the system trust
            store, which is the point — an unverified observation would describe a certificate
            no browser would accept.
    """

    def __init__(self, *, timeout: float = 5.0, context: Optional[ssl.SSLContext] = None) -> None:
        self._timeout = timeout
        self._context = context or ssl.create_default_context()

    def observe(self, host: str, *, port: int = 443) -> TlsObservation:
        """Complete a handshake with ``host`` and describe what it served.

        Args:
            host: The hostname to connect to; also the name verified against.
            port: The port to connect to.

        Returns:
            The observation.

        Raises:
            TlsProbeError: ``timeout`` when the host did not answer, ``unreachable`` when the
                connection failed, ``certificate`` when verification failed (which names the
                reason — an expired or mis-issued certificate is the answer, not an error to
                swallow), and ``handshake`` for any other TLS failure.
        """
        try:
            with socket.create_connection((host, port), timeout=self._timeout) as raw:
                with self._context.wrap_socket(raw, server_hostname=host) as tls:
                    cert = tls.getpeercert()
                    protocol = tls.version() or "unknown"
                    observed_at = datetime.now(timezone.utc)
        except ssl.SSLCertVerificationError as exc:
            raise TlsProbeError(
                "certificate",
                f"{host} served a certificate that does not verify: {exc.verify_message or exc}.",
            ) from exc
        except ssl.SSLError as exc:
            raise TlsProbeError("handshake", f"The TLS handshake with {host} failed: {exc}.") from exc
        except socket.timeout as exc:
            raise TlsProbeError(
                "timeout", f"{host} did not complete a TLS handshake within {self._timeout:g}s."
            ) from exc
        except OSError as exc:
            raise TlsProbeError("unreachable", f"{host} could not be reached on port {port}: {exc}.") from exc

        return parse_peer_certificate(cert, protocol=protocol, observed_at=observed_at)


class StaticTlsProbe:
    """A probe that answers from a supplied table.

    Args:
        observations: ``{host: TlsObservation | TlsProbeError}``. A host that is absent raises
            ``unreachable``, which is what an unpointed domain looks like.
    """

    def __init__(self, observations: Optional[Dict[str, Any]] = None) -> None:
        self._observations = {key.lower(): value for key, value in (observations or {}).items()}

    def observe(self, host: str, *, port: int = 443) -> TlsObservation:
        """Return the configured observation for ``host``.

        Args:
            host: The hostname.
            port: Ignored; present to satisfy :class:`TlsProbe`.

        Returns:
            The configured observation.

        Raises:
            TlsProbeError: When the table holds an error for the host, or holds nothing.
        """
        result = self._observations.get(host.lower())
        if isinstance(result, TlsProbeError):
            raise result
        if result is None:
            raise TlsProbeError("unreachable", f"{host} could not be reached on port {port}.")
        return result
