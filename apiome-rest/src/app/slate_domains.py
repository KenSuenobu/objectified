"""Custom-domain naming, DNS guidance and TLS lifecycle rules — Slate 10.1 (private-suite#119).

The pure half of the custom-domain surface. Nothing here touches the database, the network or the
clock beyond a ``now`` a caller passes in, so every rule the screen renders is decided in one
place and pinned by tests that need neither Postgres nor DNS.

What it decides:

* **What a hostname is.** :func:`normalize_host` accepts what people actually paste — a URL, a
  trailing dot, mixed case, a Unicode domain — and reduces it to the one form everything else
  keys on (lowercase, IDNA/A-label, no scheme, no port, no trailing dot).
  :func:`validate_host` then refuses what cannot work: bare labels, wildcards, IP literals,
  over-long labels, and hosts under the platform's own zone (a tenant "verifying"
  ``anything.sites.apiome.app`` would be verifying our DNS, not theirs).

* **What the tenant must publish.** :func:`dns_instructions` returns the exact rows of the
  mockup's DNS table. A subdomain is delegated with a single CNAME. An apex cannot be: RFC 1034
  forbids a CNAME coexisting with the SOA and NS records every zone apex carries, so an apex is
  proven with a TXT record and pointed with the provider's ALIAS/ANAME (or a flattened A). Handing
  an apex a CNAME row would be an instruction that either fails or breaks the tenant's mail.

* **Whether ownership is proven.** :func:`evaluate_verification` compares what the resolver
  actually observed against what was asked for, and when it does not match it says what was found.
  "Failed" with the observed record is a state a tenant can act on; a red dot is one they can only
  re-click.

* **What the certificate state means.** :func:`evaluate_certificate` turns an expiry into days
  remaining, whether renewal is due, and whether the thing has already lapsed —
  and :func:`build_checklist` renders the three claims the mockup makes (record verified, TLS 1.3
  + HSTS, auto-renewal) as items that can each be false.

**Where certificates actually come from.** Not from here. ``deploy/Caddyfile`` terminates TLS and
Caddy obtains and renews Let's Encrypt certificates itself (on-demand TLS + ACME, automatic
renewal). This module supplies the two things the edge cannot know on its own: whether a host is
authorized to be issued for (:func:`authorize_issuance`, which the edge's ``ask`` endpoint calls
before every issuance for an unrecognized name), and how to describe to a human what the live host
is serving. Consequently every certificate field this surface reports is an *observation* of the
deployed host, never a private ledger of what we believe the CA did.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

__all__ = [
    "APEX_ALIAS_RECORD_TYPES",
    "CHALLENGE_LABEL",
    "DEFAULT_RECORD_TTL_SECONDS",
    "HSTS_MAX_AGE_SECONDS",
    "RENEWAL_WINDOW_DAYS",
    "TLS_MIN_VERSION",
    "ChecklistItem",
    "DnsRecordInstruction",
    "SlateDomainError",
    "VerificationMethod",
    "VerificationOutcome",
    "authorize_issuance",
    "build_checklist",
    "challenge_record_name",
    "default_verification_method",
    "dns_instructions",
    "evaluate_certificate",
    "evaluate_verification",
    "is_apex",
    "normalize_host",
    "relative_record_name",
    "validate_host",
    "verification_token",
]

# ─── Constants the surface reports rather than re-deriving ───────────────────

#: The TTL suggested on every generated record. Five minutes keeps a mistyped record cheap to
#: correct; the mockup's DNS table shows the same value.
DEFAULT_RECORD_TTL_SECONDS = 300

#: Label the ownership TXT record is published under, for apexes and for any host whose provider
#: cannot delegate with a CNAME. Underscore-prefixed so it can never collide with a real host.
CHALLENGE_LABEL = "_apiome-challenge"

#: Renewal lead time. Let's Encrypt issues 90-day certificates and recommends renewing at 30 days
#: remaining, which leaves a month of retries before anything is user-visible.
RENEWAL_WINDOW_DAYS = 30

#: Minimum TLS version the edge negotiates (``deploy/Caddyfile``). Reported, not enforced here.
TLS_MIN_VERSION = "TLS 1.3"

#: ``Strict-Transport-Security`` max-age the edge sends, in seconds (one year, preload-eligible).
HSTS_MAX_AGE_SECONDS = 31_536_000

#: Record types a provider may offer for pointing a zone apex, in the order worth trying.
APEX_ALIAS_RECORD_TYPES = ("ALIAS", "ANAME", "A")

#: How ownership may be proven.
VerificationMethod = Literal["cname", "txt"]

#: One DNS label: 1–63 characters, letters/digits/hyphen, not starting or ending with a hyphen.
_LABEL_PATTERN = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")

#: An IPv4 literal, which is a plausible paste but never a valid custom domain.
_IPV4_PATTERN = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")

#: Multi-label public suffixes common enough that treating them as a registrable domain would
#: give the wrong record guidance. Deliberately short: it exists to stop ``acme.co.uk`` being
#: mistaken for a subdomain of ``co.uk``, not to reimplement the Public Suffix List. Anything it
#: misses is recoverable — the caller may state the verification method explicitly.
_MULTI_LABEL_SUFFIXES = frozenset(
    {
        "co.uk",
        "org.uk",
        "gov.uk",
        "ac.uk",
        "me.uk",
        "co.jp",
        "or.jp",
        "ne.jp",
        "com.au",
        "net.au",
        "org.au",
        "com.br",
        "com.cn",
        "com.mx",
        "co.nz",
        "co.za",
        "co.in",
        "com.sg",
        "com.tr",
    }
)


class SlateDomainError(Exception):
    """A hostname or lifecycle rule was violated.

    Carries a machine-readable ``code`` alongside an operator-facing sentence so the REST layer
    maps it to a status without string-matching the message.

    Attributes:
        code: Stable reason, e.g. ``invalid-host`` / ``reserved-host``.
        message: A sentence naming what is wrong and what to do about it.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class DnsRecordInstruction:
    """One row of the DNS table the tenant copies into their provider.

    Attributes:
        record_type: ``CNAME``, ``TXT``, or the apex pointer type (``ALIAS``/``ANAME``/``A``).
        name: The record name *relative to the zone the tenant edits* — ``payments-docs``, not
            the full hostname, because that is what a provider's form asks for. ``@`` for an apex.
        value: What the record points at or contains.
        ttl: Suggested TTL in seconds.
        purpose: ``verification`` when the record proves ownership, ``routing`` when it sends
            traffic. An apex needs both; a subdomain's single CNAME does both at once.
        note: Optional guidance for the row (e.g. why an apex cannot use a CNAME).
    """

    record_type: str
    name: str
    value: str
    ttl: int
    purpose: Literal["verification", "routing"]
    note: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Return the JSON-safe form the API responds with."""
        return {
            "record_type": self.record_type,
            "name": self.name,
            "value": self.value,
            "ttl": self.ttl,
            "purpose": self.purpose,
            "note": self.note,
        }


@dataclass(frozen=True)
class VerificationOutcome:
    """The result of comparing observed DNS against what was asked for.

    Attributes:
        verified: True when the published records prove ownership.
        detail: A sentence stating what was observed — the value of a failure, since it is what
            tells the tenant which record to fix.
        observed: The records the resolver actually returned, for the audit trail.
    """

    verified: bool
    detail: str
    observed: Tuple[str, ...] = ()


@dataclass(frozen=True)
class ChecklistItem:
    """One line of the mockup's verification checklist.

    Attributes:
        id: Stable identifier the UI keys on.
        label: The claim, phrased so that ``ok=False`` reads as its negation.
        ok: Whether the claim currently holds.
        detail: Why it does or does not.
    """

    id: str
    label: str
    ok: bool
    detail: str

    def to_dict(self) -> Dict[str, Any]:
        """Return the JSON-safe form the API responds with."""
        return {"id": self.id, "label": self.label, "ok": self.ok, "detail": self.detail}


# ─── Hostnames ───────────────────────────────────────────────────────────────


def normalize_host(raw: str) -> str:
    """Reduce whatever was pasted to the canonical hostname everything else keys on.

    Accepts a URL, a host with a port, a trailing dot, surrounding whitespace, mixed case and a
    Unicode (U-label) domain, and returns the lowercase A-label form with none of those. It does
    not judge whether the result is *usable* — that is :func:`validate_host` — so a caller that
    only needs a comparison key can use this alone.

    Args:
        raw: The user's input.

    Returns:
        The canonical hostname, possibly empty when the input contained no host.
    """
    text = (raw or "").strip()
    if not text:
        return ""

    # Drop a scheme and anything after the authority. The mockup tells the tenant not to include
    # "https://", but refusing a paste that contains one helps nobody.
    text = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", text)
    text = text.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    text = text.split("@")[-1]  # userinfo, if a whole URL was pasted

    # A bracketed IPv6 literal is not a custom domain, but strip the brackets so validation can
    # name it rather than choke on the punctuation.
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    elif text.count(":") == 1:
        text = text.split(":", 1)[0]

    text = text.rstrip(".").strip().lower()
    if not text:
        return ""

    # IDNA: store the A-label so DNS comparison is byte-for-byte. A domain that cannot be encoded
    # is left as-is for validation to refuse with a sentence rather than a UnicodeError.
    if any(ord(char) > 127 for char in text):
        try:
            text = text.encode("idna").decode("ascii").lower()
        except UnicodeError:
            return text
    return text


def validate_host(raw: str, *, platform_zone: str = "") -> str:
    """Normalize a hostname and refuse the ones that cannot serve a site.

    Args:
        raw: The user's input.
        platform_zone: The platform's own DNS zone (e.g. ``sites.apiome.app``). A host inside it
            is refused: pointing it here would "verify" our DNS rather than the tenant's, and the
            tenant cannot publish records in a zone they do not control.

    Returns:
        The canonical hostname.

    Raises:
        SlateDomainError: ``invalid-host`` when the name cannot be a public hostname;
            ``reserved-host`` when it falls inside the platform's own zone.
    """
    host = normalize_host(raw)
    if not host:
        raise SlateDomainError("invalid-host", "Enter a domain, for example payments-docs.acme.io.")

    if "*" in host:
        raise SlateDomainError(
            "invalid-host",
            "Wildcard domains are not supported. Add each hostname you want to serve.",
        )
    if _IPV4_PATTERN.match(host) or ":" in host:
        raise SlateDomainError(
            "invalid-host",
            "That is an IP address. A certificate is issued to a hostname, so enter a domain name.",
        )
    if len(host) > 253:
        raise SlateDomainError(
            "invalid-host", "That domain is longer than the 253 characters DNS permits."
        )

    labels = host.split(".")
    if len(labels) < 2:
        raise SlateDomainError(
            "invalid-host",
            f"'{host}' is a single label. Enter a full domain, for example payments-docs.acme.io.",
        )
    for label in labels:
        if not _LABEL_PATTERN.match(label):
            raise SlateDomainError(
                "invalid-host",
                f"'{label}' is not a valid DNS label — use letters, digits and hyphens, "
                "and do not start or end a label with a hyphen.",
            )
    if labels[-1].isdigit():
        raise SlateDomainError(
            "invalid-host", "A domain cannot end in a numeric label. Check the spelling."
        )

    zone = normalize_host(platform_zone)
    if zone and (host == zone or host.endswith(f".{zone}")):
        raise SlateDomainError(
            "reserved-host",
            f"'{host}' is inside {zone}, which this platform controls. Use a domain you can "
            "publish DNS records for.",
        )
    return host


def registrable_domain(host: str) -> str:
    """Return the zone the tenant most likely edits records in.

    Uses the label count plus a short list of well-known multi-label suffixes. It is a heuristic,
    not the Public Suffix List, and is used only to phrase record *names* relative to a zone —
    getting it wrong makes an instruction awkward, never wrong-by-construction, because the
    generated record's fully-qualified form is what verification actually checks.

    Args:
        host: A canonical hostname.

    Returns:
        The registrable domain (``acme.io`` for ``docs.acme.io``, ``acme.co.uk`` for
        ``docs.acme.co.uk``).
    """
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if ".".join(labels[-2:]) in _MULTI_LABEL_SUFFIXES and len(labels) >= 3:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def is_apex(host: str) -> bool:
    """Whether ``host`` is a zone apex (and therefore cannot carry a CNAME).

    Args:
        host: A canonical hostname.

    Returns:
        True when the host is its own registrable domain.
    """
    return host == registrable_domain(host)


def relative_record_name(host: str) -> str:
    """Phrase a record name the way a DNS provider's form asks for it.

    Args:
        host: A canonical hostname.

    Returns:
        The labels below the registrable domain (``payments-docs``), or ``@`` for an apex.
    """
    zone = registrable_domain(host)
    if host == zone:
        return "@"
    return host[: -(len(zone) + 1)]


def default_verification_method(host: str) -> VerificationMethod:
    """The method that works for this host without further input.

    Args:
        host: A canonical hostname.

    Returns:
        ``txt`` for an apex — RFC 1034 forbids a CNAME beside the apex's mandatory SOA and NS
        records — and ``cname`` for anything below it, where one record both proves ownership and
        routes traffic.
    """
    return "txt" if is_apex(host) else "cname"


def challenge_record_name(host: str) -> str:
    """Fully-qualified name of the ownership TXT record for ``host``.

    Args:
        host: A canonical hostname.

    Returns:
        ``_apiome-challenge.<host>``.
    """
    return f"{CHALLENGE_LABEL}.{host}"


def verification_token(host: str, secret: str) -> str:
    """Derive the ownership token a tenant publishes for ``host``.

    Derived rather than random so it is stable across re-reads and reproducible from the row: a
    tenant who half-applied the instructions and came back tomorrow gets the same token instead of
    a new one that silently invalidates the record they already published.

    Args:
        host: A canonical hostname.
        secret: Server-side secret; without it the token would be guessable from the hostname and
            would prove nothing.

    Returns:
        A URL-safe token.

    Raises:
        SlateDomainError: ``verification-secret-missing`` when no secret is configured, rather
            than deriving a token from an empty string that any caller could reproduce.
    """
    if not secret:
        raise SlateDomainError(
            "verification-secret-missing",
            "Domain verification is not configured on this deployment: no verification secret is "
            "set, so an ownership token cannot be issued.",
        )
    digest = hmac.new(secret.encode("utf-8"), host.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"apiome-domain-verification={digest[:48]}"


# ─── DNS guidance ────────────────────────────────────────────────────────────


def dns_instructions(
    host: str,
    *,
    dns_target: str,
    token: str,
    method: Optional[VerificationMethod] = None,
) -> List[DnsRecordInstruction]:
    """Build the DNS rows the tenant must publish for ``host``.

    Args:
        host: A canonical hostname.
        dns_target: The platform hostname traffic is pointed at (e.g. ``sites.apiome.app``).
        token: The ownership token from :func:`verification_token`.
        method: Override the derived method; omit to use :func:`default_verification_method`.

    Returns:
        One instruction for a delegated subdomain; two for an apex (the TXT that proves ownership
        and the ALIAS/A that routes traffic), in the order they should be applied.
    """
    resolved = method or default_verification_method(host)
    name = relative_record_name(host)

    if resolved == "cname":
        return [
            DnsRecordInstruction(
                record_type="CNAME",
                name=name,
                value=dns_target,
                ttl=DEFAULT_RECORD_TTL_SECONDS,
                purpose="routing",
                note="One record both proves ownership and routes traffic — no separate "
                "verification record is needed.",
            )
        ]

    challenge_name = CHALLENGE_LABEL if name == "@" else f"{CHALLENGE_LABEL}.{name}"
    return [
        DnsRecordInstruction(
            record_type="TXT",
            name=challenge_name,
            value=token,
            ttl=DEFAULT_RECORD_TTL_SECONDS,
            purpose="verification",
            note="A zone apex cannot carry a CNAME beside its mandatory SOA and NS records, so "
            "ownership is proven with a TXT record instead.",
        ),
        DnsRecordInstruction(
            record_type=APEX_ALIAS_RECORD_TYPES[0],
            name=name,
            value=dns_target,
            ttl=DEFAULT_RECORD_TTL_SECONDS,
            purpose="routing",
            note="Use whichever of ALIAS, ANAME or flattened-CNAME your provider offers. If it "
            "offers none, an A record to the addresses "
            f"'{dns_target}' resolves to will work, but must be updated if they change.",
        ),
    ]


def evaluate_verification(
    host: str,
    *,
    method: VerificationMethod,
    dns_target: str,
    token: str,
    observed_cname: Optional[str] = None,
    observed_txt: Sequence[str] = (),
) -> VerificationOutcome:
    """Decide whether what DNS returned proves ownership of ``host``.

    Args:
        host: A canonical hostname (used only in the sentences).
        method: The method the domain was issued instructions for.
        dns_target: The platform hostname the CNAME must point at.
        token: The expected TXT value.
        observed_cname: The CNAME the resolver returned for ``host``, if any.
        observed_txt: The TXT strings returned for the challenge name, if any.

    Returns:
        The outcome, whose ``detail`` names what was observed when verification did not pass.
    """
    target = normalize_host(dns_target)

    if method == "cname":
        found = normalize_host(observed_cname or "")
        if not found:
            return VerificationOutcome(
                verified=False,
                detail=f"No CNAME record was found for {host}. Add the record below; DNS changes "
                "usually propagate within a few minutes.",
            )
        if found != target:
            return VerificationOutcome(
                verified=False,
                detail=f"{host} is a CNAME to {found}, not to {target}. Point it at {target} and "
                "check again.",
                observed=(found,),
            )
        return VerificationOutcome(
            verified=True,
            detail=f"{host} resolves to {target} by CNAME.",
            observed=(found,),
        )

    values = tuple(value.strip() for value in observed_txt if value and value.strip())
    if not values:
        return VerificationOutcome(
            verified=False,
            detail=f"No TXT record was found at {challenge_record_name(host)}. Add the record "
            "below; DNS changes usually propagate within a few minutes.",
        )
    if token not in values:
        return VerificationOutcome(
            verified=False,
            detail=f"The TXT record at {challenge_record_name(host)} does not contain this "
            "domain's verification token. Replace it with the value below.",
            observed=values,
        )
    return VerificationOutcome(
        verified=True,
        detail=f"The verification token is published at {challenge_record_name(host)}.",
        observed=values,
    )


# ─── Certificate lifecycle ───────────────────────────────────────────────────


def evaluate_certificate(
    *,
    expires_at: Optional[datetime],
    now: datetime,
    auto_renew: bool = True,
    renewal_window_days: int = RENEWAL_WINDOW_DAYS,
) -> Dict[str, Any]:
    """Describe a certificate's remaining life and whether renewal is due.

    Args:
        expires_at: The observed ``notAfter``; None when nothing has been observed.
        now: The reference time (passed in so the result is deterministic under test).
        auto_renew: Whether the edge is permitted to renew this host.
        renewal_window_days: Lead time before expiry at which renewal becomes due.

    Returns:
        A dict with ``known``, ``days_remaining`` (negative once lapsed), ``expired``,
        ``renewal_due``, ``renews_at`` (ISO-8601, when renewal becomes due) and ``auto_renew``.
    """
    if expires_at is None:
        return {
            "known": False,
            "days_remaining": None,
            "expired": False,
            "renewal_due": False,
            "renews_at": None,
            "auto_renew": auto_renew,
        }

    reference = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    expiry = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    remaining = expiry - reference
    # Truncate toward zero rather than rounding: a certificate with 23 hours left has 0 days left,
    # not 1. Rounding up is how "expires in 1 day" is shown on the morning it expires.
    days_remaining = int(remaining.total_seconds() // 86_400)
    renews_at = expiry - timedelta(days=renewal_window_days)
    return {
        "known": True,
        "days_remaining": days_remaining,
        "expired": remaining.total_seconds() <= 0,
        "renewal_due": reference >= renews_at,
        "renews_at": renews_at.isoformat(),
        "auto_renew": auto_renew,
    }


def _protocol_version(protocol: str) -> str:
    """Extract the numeric version from a TLS protocol name.

    Args:
        protocol: A protocol name in any spelling — ``TLSv1.3``, ``TLS 1.3``, ``TLSv1.2``.

    Returns:
        The version alone (``1.3``), or an empty string when none is present.
    """
    match = re.search(r"(\d+\.\d+)", protocol or "")
    return match.group(1) if match else ""


def authorize_issuance(row: Optional[Dict[str, Any]]) -> Tuple[bool, str]:
    """Decide whether the edge may obtain a certificate for a host.

    This is the whole of the on-demand TLS policy. The edge calls it — through the ``ask``
    endpoint — before every ACME order for a name it has not seen, so a permissive answer here is
    an open invitation to have certificates issued in our account for hosts nobody owns. It
    therefore answers True for exactly one case: a domain row that exists, has proven ownership,
    and has not had renewal switched off.

    Args:
        row: The ``slate_domains`` row for the requested host, or None when there is none.

    Returns:
        ``(allowed, reason)``. ``reason`` is for the edge's log, not for a browser.
    """
    if row is None:
        return False, "No custom domain is configured for that host."
    if row.get("verification_status") != "verified":
        return False, "That host has not completed DNS ownership verification."
    if not row.get("auto_renew", True):
        return False, "Certificate renewal is switched off for that host."
    return True, "Host is verified and may be issued for."


def build_checklist(
    row: Dict[str, Any],
    *,
    now: datetime,
    certificate: Optional[Dict[str, Any]] = None,
) -> List[ChecklistItem]:
    """Render the mockup's verification checklist for one domain row.

    Every item can be false — a checklist whose items are constants is decoration. The TLS and
    HSTS item is the one that most deserves scrutiny: it reports the protocol the host was
    *observed* negotiating, and reads as unproven until a probe has actually completed a
    handshake, rather than restating the edge's configured preference as a fact about the host.

    Args:
        row: A ``slate_domains`` row.
        now: Reference time.
        certificate: A precomputed :func:`evaluate_certificate` result; computed when omitted.

    Returns:
        Three items, in the mockup's order.
    """
    method = row.get("verification_method") or "cname"
    record_kind = "CNAME" if method == "cname" else "TXT"
    verified = row.get("verification_status") == "verified"
    checked_at = row.get("verification_checked_at")

    if verified:
        record_detail = f"{record_kind} record verified."
    elif row.get("verification_error"):
        record_detail = str(row["verification_error"])
    elif checked_at is None:
        record_detail = f"The {record_kind} record has not been checked yet. Select Verify."
    else:
        record_detail = f"The {record_kind} record did not match on the last check."

    observed_protocol = row.get("tls_protocol")
    # ``ssl`` reports "TLSv1.3"; an operator writes "TLS 1.3". Compare on the version alone so the
    # spelling of the separator cannot decide whether the checklist item is green.
    protocol_ok = bool(observed_protocol) and _protocol_version(observed_protocol) == "1.3"
    if not observed_protocol:
        protocol_detail = (
            f"The edge negotiates {TLS_MIN_VERSION} and sends "
            f"Strict-Transport-Security: max-age={HSTS_MAX_AGE_SECONDS}. Not yet confirmed "
            "against the live host."
        )
    elif protocol_ok:
        protocol_detail = (
            f"{observed_protocol} negotiated with the live host · HSTS "
            f"max-age={HSTS_MAX_AGE_SECONDS}."
        )
    else:
        protocol_detail = (
            f"The live host negotiated {observed_protocol}, below the {TLS_MIN_VERSION} the edge "
            "is configured for. Traffic may not be reaching this platform."
        )

    state = certificate or evaluate_certificate(
        expires_at=row.get("certificate_expires_at"),
        now=now,
        auto_renew=bool(row.get("auto_renew", True)),
    )
    if not row.get("auto_renew", True):
        renewal_detail = (
            "Auto-renewal is switched off, so this certificate will lapse when it expires."
        )
    elif not state["known"]:
        renewal_detail = (
            "Auto-renewal is enabled. The edge renews with Let's Encrypt "
            f"{RENEWAL_WINDOW_DAYS} days before expiry; no certificate has been observed yet."
        )
    elif state["expired"]:
        renewal_detail = "The observed certificate has expired and has not been replaced."
    else:
        renewal_detail = (
            f"Auto-renewal enabled · renews {RENEWAL_WINDOW_DAYS} days before expiry "
            f"({state['days_remaining']} days remaining)."
        )

    return [
        ChecklistItem(
            id="dns-record",
            label=f"{record_kind} record verified",
            ok=verified,
            detail=record_detail,
        ),
        ChecklistItem(
            id="tls-policy",
            label=f"{TLS_MIN_VERSION} enforced · HSTS max-age={HSTS_MAX_AGE_SECONDS}",
            ok=protocol_ok,
            detail=protocol_detail,
        ),
        ChecklistItem(
            id="auto-renewal",
            label="Auto-renewal enabled",
            ok=bool(row.get("auto_renew", True)) and not state["expired"],
            detail=renewal_detail,
        ),
    ]
