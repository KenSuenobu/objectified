"""Custom domain, DNS verification and TLS status REST API — Slate 10.1 (private-suite#119).

The editing half of the domain inventory APX-3.1 could only report. What the Slate Custom Domain
screen consumes:

* ``GET  /v1/slate/environments/{environment_id}/domains``
  — the lane's hosts with, for each, the DNS rows to publish, the verification checklist, and the
  certificate the live host was last observed serving.

* ``POST /v1/slate/environments/{environment_id}/domains``
  — attach a hostname. Answers with the DNS instructions for it, because "added" without them is
  a state the tenant cannot get out of.

* ``POST /v1/slate/domains/{domain_id}/verify``
  — read the tenant's public DNS now and record the outcome. A failure names what was found.

* ``POST /v1/slate/domains/{domain_id}/certificate``
  — complete a TLS handshake with the host and record what it is serving.

* ``POST /v1/slate/domains/{domain_id}/primary`` / ``.../renewal`` / ``DELETE .../{domain_id}``
  — make a host canonical, switch auto-renewal, detach.

* ``GET  /v1/slate/tls/authorize?domain=…``
  — **unauthenticated, and called by the edge, not by a browser.** See below.

**Where certificates come from, and what this service does about it.** ``deploy/Caddyfile``
terminates TLS. Caddy obtains and renews Let's Encrypt certificates itself — that is the
"auto-renewing TLS" of the acceptance criterion, and nothing in this module issues, stores or
renews a certificate. What Caddy cannot know is whether a hostname arriving over SNI is one this
platform is willing to be issued for; without an answer, on-demand TLS would let anyone point a
domain at us and have a certificate ordered in our ACME account. ``/tls/authorize`` is that
answer, and it says yes to exactly one thing: a domain row that exists, has completed DNS
ownership verification, and has renewal enabled.

It is unauthenticated because the caller is a TLS handshake with no session to present. That is
sound here: it takes a hostname the caller already knows and returns nothing beyond whether this
platform will serve it — which is what resolving the name and connecting would reveal anyway. It
is covered by the global rate limiter like every other route.

The certificate fields this surface reports are therefore *observations of the live host*, made by
:class:`app.slate_tls_probe.TlsProbe`, never a private ledger of what we believe a CA did. That is
also what makes a renewal detectable: the serial changes.

Authorization: reads require VERSIONS/VIEW; attaching, verifying, probing and detaching require
VERSIONS/PUBLISH — pointing a hostname at a lane routes production traffic, which is a publish
action on the site being published. As in :mod:`app.slate_cache_routes` there is no separate
``domains`` resource, because a permission dimension the roles matrix does not render would be
ungrantable in the UI.

Scope misses answer 404 (not 403) so cross-tenant probes cannot confirm a lane or domain exists.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .config import settings
from .database import db
from .permissions import Action, Resource, enforce_permission
from .slate_auth import validate_slate_authentication
from .slate_dns import TYPE_CNAME, TYPE_TXT, DnsError, DnsResolver, SystemDnsResolver
from .slate_domains import (
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
    validate_host,
    verification_token,
)
from .slate_domains_store import (
    SlateDomainConflictError,
    SlateDomainStoreError,
    attach_domain,
    detach_domain,
    get_domain,
    get_domain_by_host,
    get_environment_scope,
    list_domains,
    record_certificate,
    record_certificate_error,
    record_verification,
    set_auto_renew,
    set_primary,
)
from .slate_tls_probe import SystemTlsProbe, TlsProbe, TlsProbeError

router = APIRouter(prefix="/v1/slate", tags=["slate"])


class _CamelModel(BaseModel):
    """Wire base: snake_case fields, camelCase JSON, matching the rest of the Slate surface."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ─── Injectable collaborators ────────────────────────────────────────────────
#
# Both reach the network, so both are FastAPI dependencies rather than module globals: a test
# overrides them and the suite never opens a socket, and an operator can point verification at a
# specific resolver without redeploying the service.


def get_dns_resolver() -> DnsResolver:
    """Return the resolver ownership checks read public DNS with.

    Returns:
        A resolver configured from the host (or ``APIOME_SLATE_DNS_NAMESERVERS``).
    """
    return SystemDnsResolver()


def get_tls_probe() -> TlsProbe:
    """Return the probe used to observe what a host is serving.

    Returns:
        A probe that verifies hostnames and the system trust store.
    """
    return SystemTlsProbe()


# ─── Request/response models ─────────────────────────────────────────────────


class DnsRecordBody(_CamelModel):
    """One row of the DNS table the tenant copies into their provider."""

    record_type: str = Field(description="CNAME, TXT, or the apex pointer type (ALIAS/ANAME/A).")
    name: str = Field(description="Record name relative to the zone the tenant edits; @ for apex.")
    value: str = Field(description="What the record points at or contains.")
    ttl: int = Field(description="Suggested TTL in seconds.")
    purpose: str = Field(description="verification (proves ownership) or routing (sends traffic).")
    note: Optional[str] = Field(default=None, description="Guidance for this row.")


class ChecklistItemBody(_CamelModel):
    """One line of the verification checklist."""

    id: str = Field(description="Stable identifier the UI keys on.")
    label: str = Field(description="The claim being made.")
    ok: bool = Field(description="Whether the claim currently holds.")
    detail: str = Field(description="Why it does or does not.")


class CertificateBody(_CamelModel):
    """The certificate the live host was last observed serving."""

    known: bool = Field(description="False until a probe has completed a handshake.")
    issuer: Optional[str] = Field(default=None, description="Issuing CA, e.g. Let's Encrypt (R11).")
    serial: Optional[str] = Field(
        default=None, description="Certificate serial; changes on every renewal."
    )
    issued_at: Optional[str] = Field(default=None, description="Observed notBefore, ISO-8601.")
    expires_at: Optional[str] = Field(default=None, description="Observed notAfter, ISO-8601.")
    checked_at: Optional[str] = Field(
        default=None, description="When the handshake completed. Without it, expiry is a claim."
    )
    protocol: Optional[str] = Field(
        default=None, description="Protocol actually negotiated, e.g. TLSv1.3."
    )
    days_remaining: Optional[int] = Field(
        default=None, description="Whole days until expiry; negative once lapsed."
    )
    expired: bool = Field(default=False, description="Whether the observed certificate has lapsed.")
    renewal_due: bool = Field(
        default=False, description="Whether the edge should have renewed by now."
    )
    renews_at: Optional[str] = Field(
        default=None, description="When renewal becomes due, ISO-8601."
    )
    auto_renew: bool = Field(default=True, description="Whether the edge may renew this host.")
    error: Optional[str] = Field(
        default=None, description="Why the last probe failed; null when it succeeded."
    )


class TlsPolicyBody(_CamelModel):
    """What the edge is configured to do for every custom domain.

    A policy, not a measurement — ``CertificateBody.protocol`` is the measurement. Both are
    reported so a host negotiating less than the policy is visible as a discrepancy rather than
    hidden behind the configured value.
    """

    min_version: str = Field(description="Minimum TLS version the edge negotiates.")
    hsts_max_age_seconds: int = Field(description="Strict-Transport-Security max-age sent.")
    renewal_window_days: int = Field(description="Lead time before expiry at which renewal runs.")
    issuer: str = Field(description="The certificate authority the edge orders from.")


class DomainBody(_CamelModel):
    """One custom domain with everything the screen renders for it."""

    id: str
    host: str
    environment_id: str
    site_id: str
    is_primary: bool
    verification_status: str = Field(description="pending, verified or failed.")
    verification_method: str = Field(description="cname or txt.")
    verification_checked_at: Optional[str] = None
    verification_error: Optional[str] = None
    verified_at: Optional[str] = None
    challenge_record: Optional[str] = Field(
        default=None, description="Fully-qualified name of the TXT challenge, when one applies."
    )
    dns_target: str = Field(description="The platform hostname this domain is pointed at.")
    tls_status: str = Field(description="pending, provisioning, active or error.")
    records: List[DnsRecordBody] = Field(
        default_factory=list, description="The DNS rows the tenant must publish."
    )
    checklist: List[ChecklistItemBody] = Field(default_factory=list)
    certificate: CertificateBody
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class DomainListResponse(_CamelModel):
    """A lane's domains and the edge policy that applies to all of them."""

    environment_id: str
    domains: List[DomainBody] = Field(default_factory=list)
    tls_policy: TlsPolicyBody
    dns_target: str = Field(description="The platform hostname custom domains are pointed at.")


class DomainResponse(_CamelModel):
    """One domain, plus the edge policy, so a single-domain screen needs one call."""

    domain: DomainBody
    tls_policy: TlsPolicyBody


class AttachDomainRequest(_CamelModel):
    """Attach a hostname to a lane."""

    host: str = Field(description="The domain, with or without a scheme — it is normalized here.")
    is_primary: bool = Field(
        default=False, description="Make this the lane's canonical host, demoting the current one."
    )
    verification_method: Optional[str] = Field(
        default=None,
        description=(
            "Override the derived method (cname for a subdomain, txt for an apex). Provided "
            "because apex detection is a heuristic, not the Public Suffix List."
        ),
    )


class RenewalRequest(_CamelModel):
    """Switch automatic certificate renewal for a domain."""

    auto_renew: bool = Field(description="Whether the edge may obtain and renew certificates.")


class VerifyResponse(_CamelModel):
    """The outcome of an ownership check."""

    domain: DomainBody
    verified: bool
    detail: str = Field(description="What was observed — the actionable part of a failure.")
    tls_policy: TlsPolicyBody


class AuthorizeResponse(_CamelModel):
    """The edge's on-demand TLS answer for one hostname."""

    domain: str
    allowed: bool
    reason: str = Field(description="For the edge's log. Not shown to a browser.")


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _iso(value: Any) -> Optional[str]:
    """Render a timestamp as ISO-8601, tolerating a string that already is one."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _now() -> datetime:
    """Current UTC time, isolated so tests can patch one place."""
    return datetime.now(timezone.utc)


def _tls_policy() -> TlsPolicyBody:
    """Describe what the edge is configured to do for every custom domain."""
    return TlsPolicyBody(
        min_version=TLS_MIN_VERSION,
        hsts_max_age_seconds=HSTS_MAX_AGE_SECONDS,
        renewal_window_days=RENEWAL_WINDOW_DAYS,
        issuer="Let's Encrypt",
    )


def _require_environment(tenant_id: str, environment_id: str) -> Dict[str, Any]:
    """Load a lane or answer 404.

    Args:
        tenant_id: Caller's tenant.
        environment_id: The lane.

    Returns:
        The environment row.

    Raises:
        HTTPException: 404 when the lane does not exist in this tenant. Deliberately not 403: a
            cross-tenant probe must not be able to confirm the lane exists.
    """
    environment = get_environment_scope(db, tenant_id=tenant_id, environment_id=environment_id)
    if not environment:
        raise HTTPException(
            status_code=404,
            detail={"code": "environment_not_found", "message": "Environment not found."},
        )
    return environment


def _require_domain(tenant_id: str, domain_id: str) -> Dict[str, Any]:
    """Load a domain or answer 404.

    Args:
        tenant_id: Caller's tenant.
        domain_id: The domain.

    Returns:
        The domain row.

    Raises:
        HTTPException: 404 when it does not exist in this tenant.
    """
    row = get_domain(db, tenant_id=tenant_id, domain_id=domain_id)
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "domain_not_found", "message": "Domain not found."},
        )
    return row


def _domain_body(row: Mapping[str, Any], *, now: Optional[datetime] = None) -> DomainBody:
    """Map a ``slate_domains`` row onto the wire model, deriving everything the screen shows.

    The DNS instructions are regenerated from the row rather than stored alongside it, so a
    deployment that changes its DNS target starts telling every tenant the new one instead of
    serving instructions that were correct when the domain was attached.

    Args:
        row: The domain row.
        now: Reference time for the certificate arithmetic; current time when omitted.

    Returns:
        The wire model.
    """
    reference = now or _now()
    host = str(row["host"])
    method = str(row.get("verification_method") or default_verification_method(host))
    target = str(row.get("dns_target") or settings.slate_domain_dns_target)

    certificate = evaluate_certificate(
        expires_at=row.get("certificate_expires_at"),
        now=reference,
        auto_renew=bool(row.get("auto_renew", True)),
    )
    records = dns_instructions(
        host,
        dns_target=target,
        token=str(row.get("verification_token") or ""),
        method="txt" if method == "txt" else "cname",
    )

    return DomainBody(
        id=str(row["id"]),
        host=host,
        environment_id=str(row["environment_id"]),
        site_id=str(row["site_id"]),
        is_primary=bool(row.get("is_primary")),
        verification_status=str(row.get("verification_status") or "pending"),
        verification_method=method,
        verification_checked_at=_iso(row.get("verification_checked_at")),
        verification_error=row.get("verification_error"),
        verified_at=_iso(row.get("verified_at")),
        challenge_record=challenge_record_name(host) if method == "txt" else None,
        dns_target=target,
        tls_status=str(row.get("tls_status") or "pending"),
        records=[DnsRecordBody(**record.to_dict()) for record in records],
        checklist=[
            ChecklistItemBody(**item.to_dict())
            for item in build_checklist(dict(row), now=reference, certificate=certificate)
        ],
        certificate=CertificateBody(
            known=bool(certificate["known"]),
            issuer=row.get("certificate_issuer"),
            serial=row.get("certificate_serial"),
            issued_at=_iso(row.get("certificate_issued_at")),
            expires_at=_iso(row.get("certificate_expires_at")),
            checked_at=_iso(row.get("certificate_checked_at")),
            protocol=row.get("tls_protocol"),
            days_remaining=certificate["days_remaining"],
            expired=bool(certificate["expired"]),
            renewal_due=bool(certificate["renewal_due"]),
            renews_at=certificate["renews_at"],
            auto_renew=bool(row.get("auto_renew", True)),
            error=row.get("tls_error"),
        ),
        created_at=_iso(row.get("created_at")),
        updated_at=_iso(row.get("updated_at")),
    )


def _refuse(code: str, message: str, *, status_code: int = 400) -> HTTPException:
    """Build the structured refusal shape every Slate surface returns."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ─── Routes ──────────────────────────────────────────────────────────────────


@router.get(
    "/environments/{environment_id}/domains",
    response_model=DomainListResponse,
    response_model_by_alias=True,
)
async def list_environment_domains(
    environment_id: str,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
) -> DomainListResponse:
    """List a lane's custom domains with their DNS instructions and certificate state."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    tenant_id = auth_data["tenant_id"]
    _require_environment(tenant_id, environment_id)

    now = _now()
    rows = list_domains(db, tenant_id=tenant_id, environment_id=environment_id)
    return DomainListResponse(
        environment_id=environment_id,
        domains=[_domain_body(row, now=now) for row in rows],
        tls_policy=_tls_policy(),
        dns_target=settings.slate_domain_dns_target,
    )


@router.post(
    "/environments/{environment_id}/domains",
    response_model=DomainResponse,
    response_model_by_alias=True,
    status_code=201,
)
async def attach_environment_domain(
    environment_id: str,
    request: AttachDomainRequest,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
) -> DomainResponse:
    """Attach a hostname to a lane and answer with the DNS records that make it work.

    The domain starts unverified and with no certificate: nothing has been proven, and because
    ``/tls/authorize`` refuses an unverified host, nothing is being provisioned either.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    tenant_id = auth_data["tenant_id"]
    environment = _require_environment(tenant_id, environment_id)

    try:
        host = validate_host(request.host, platform_zone=settings.effective_slate_domain_zone)
        method = request.verification_method or default_verification_method(host)
        if method not in ("cname", "txt"):
            raise SlateDomainError(
                "invalid-verification-method",
                f"'{method}' is not a verification method. Use cname or txt.",
            )
        token = verification_token(host, settings.effective_slate_domain_verification_secret)
    except SlateDomainError as exc:
        raise _refuse(exc.code, str(exc), status_code=422) from exc

    try:
        row = attach_domain(
            db,
            tenant_id=tenant_id,
            site_id=str(environment["site_id"]),
            environment_id=environment_id,
            host=host,
            dns_target=settings.slate_domain_dns_target,
            verification_method=method,
            verification_token=token,
            is_primary=request.is_primary,
        )
    except SlateDomainConflictError as exc:
        raise _refuse("domain_conflict", str(exc), status_code=409) from exc

    return DomainResponse(domain=_domain_body(row), tls_policy=_tls_policy())


@router.get("/domains/{domain_id}", response_model=DomainResponse, response_model_by_alias=True)
async def get_domain_detail(
    domain_id: str,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
) -> DomainResponse:
    """Return one domain with its DNS instructions, checklist and certificate state."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    row = _require_domain(auth_data["tenant_id"], domain_id)
    return DomainResponse(domain=_domain_body(row), tls_policy=_tls_policy())


@router.post(
    "/domains/{domain_id}/verify", response_model=VerifyResponse, response_model_by_alias=True
)
async def verify_domain(
    domain_id: str,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
    resolver: DnsResolver = Depends(get_dns_resolver),
) -> VerifyResponse:
    """Read the tenant's public DNS now and record whether ownership is proven.

    A failed check is a 200 with ``verified: false``, not an error: "the record is not there yet"
    is the normal state of a domain someone attached ninety seconds ago, and answering 4xx would
    make the screen show an error banner for the expected path. Only an inability to *ask* — a
    resolver that timed out, a truncated answer — is a 502, because that is a statement about this
    platform rather than about the tenant's DNS.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    tenant_id = auth_data["tenant_id"]
    row = _require_domain(tenant_id, domain_id)

    host = str(row["host"])
    method = str(row.get("verification_method") or default_verification_method(host))
    target = str(row.get("dns_target") or settings.slate_domain_dns_target)
    token = str(row.get("verification_token") or "")

    try:
        if method == "txt":
            answer = resolver.query(challenge_record_name(host), TYPE_TXT)
            outcome = evaluate_verification(
                host,
                method="txt",
                dns_target=target,
                token=token,
                observed_txt=answer.txt,
            )
        else:
            answer = resolver.query(host, TYPE_CNAME)
            outcome = evaluate_verification(
                host,
                method="cname",
                dns_target=target,
                token=token,
                observed_cname=answer.cname,
            )
    except DnsError as exc:
        raise _refuse("dns_unavailable", str(exc), status_code=502) from exc

    try:
        updated = record_verification(
            db,
            tenant_id=tenant_id,
            domain_id=domain_id,
            verified=outcome.verified,
            detail=outcome.detail,
        )
    except SlateDomainStoreError as exc:
        raise _refuse(exc.code, str(exc), status_code=404) from exc

    return VerifyResponse(
        domain=_domain_body(updated),
        verified=outcome.verified,
        detail=outcome.detail,
        tls_policy=_tls_policy(),
    )


@router.post(
    "/domains/{domain_id}/certificate", response_model=DomainResponse, response_model_by_alias=True
)
async def probe_domain_certificate(
    domain_id: str,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
    probe: TlsProbe = Depends(get_tls_probe),
) -> DomainResponse:
    """Complete a TLS handshake with the host and record what it is serving.

    This is the whole of "Renew now" as an honest action. Renewal is the edge's job and it does it
    on a schedule; what an operator actually wants from that button is confirmation, so this
    measures the live host and reports the certificate it found — including, when the serial has
    changed, that a renewal has already happened.

    A probe that fails is recorded and returned as a 200 with ``tlsStatus: "error"`` and the
    reason, for the same reason a failed DNS check is: an unreachable host is a state to display,
    not an exception to raise.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    tenant_id = auth_data["tenant_id"]
    row = _require_domain(tenant_id, domain_id)
    host = str(row["host"])

    try:
        observation = probe.observe(host)
    except TlsProbeError as exc:
        updated = record_certificate_error(
            db, tenant_id=tenant_id, domain_id=domain_id, error=str(exc)
        )
        return DomainResponse(domain=_domain_body(updated), tls_policy=_tls_policy())

    updated = record_certificate(
        db,
        tenant_id=tenant_id,
        domain_id=domain_id,
        issuer=observation.issuer,
        serial=observation.serial,
        issued_at=observation.not_before,
        expires_at=observation.not_after,
        protocol=observation.protocol,
        checked_at=observation.observed_at,
    )
    return DomainResponse(domain=_domain_body(updated), tls_policy=_tls_policy())


@router.post(
    "/domains/{domain_id}/primary", response_model=DomainResponse, response_model_by_alias=True
)
async def make_domain_primary(
    domain_id: str,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
) -> DomainResponse:
    """Make a domain the lane's canonical host; the others become redirects to it.

    Refused for an unverified host: a canonical host that does not resolve here would redirect
    every alias to a name that fails, taking the working aliases down with it.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    tenant_id = auth_data["tenant_id"]
    row = _require_domain(tenant_id, domain_id)

    if row.get("verification_status") != "verified":
        raise _refuse(
            "domain_not_verified",
            f"'{row['host']}' has not completed DNS verification, so it cannot become the "
            "canonical host — every other domain on this lane would redirect to a name that does "
            "not resolve here.",
            status_code=409,
        )

    updated = set_primary(db, tenant_id=tenant_id, domain_id=domain_id)
    return DomainResponse(domain=_domain_body(updated), tls_policy=_tls_policy())


@router.post(
    "/domains/{domain_id}/renewal", response_model=DomainResponse, response_model_by_alias=True
)
async def set_domain_renewal(
    domain_id: str,
    request: RenewalRequest,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
) -> DomainResponse:
    """Switch automatic certificate renewal on or off.

    Switching it off withdraws the edge's authorization to obtain a certificate for the host at
    all, so it parks a domain immediately rather than in ninety days' time.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    tenant_id = auth_data["tenant_id"]
    _require_domain(tenant_id, domain_id)
    updated = set_auto_renew(
        db, tenant_id=tenant_id, domain_id=domain_id, enabled=request.auto_renew
    )
    return DomainResponse(domain=_domain_body(updated), tls_policy=_tls_policy())


@router.delete("/domains/{domain_id}", status_code=204)
async def remove_domain(
    domain_id: str,
    auth_data: Dict[str, Any] = Depends(validate_slate_authentication),
) -> Response:
    """Detach a domain from its lane.

    The row is deleted rather than tombstoned: it is what makes the global hostname claim and the
    issuance authorization true, and a retained row would keep a hostname claimed against whoever
    registers it next.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    tenant_id = auth_data["tenant_id"]
    _require_domain(tenant_id, domain_id)
    detach_domain(db, tenant_id=tenant_id, domain_id=domain_id)
    return Response(status_code=204)


@router.get("/tls/authorize", response_model=AuthorizeResponse, response_model_by_alias=True)
async def authorize_tls(
    domain: str = Query(description="The hostname the edge received over SNI."),
) -> AuthorizeResponse:
    """Answer the edge's on-demand TLS question: may this hostname be issued for?

    **Unauthenticated by necessity and by design.** The caller is a TLS handshake, which has no
    session to present. It supplies a hostname it already has and learns only whether this
    platform will serve it — the same thing it would learn by connecting. Every other route on
    this surface requires VERSIONS/PUBLISH.

    Answers 200 only for a domain that exists, is verified, and has renewal enabled; everything
    else is 403, which is what Caddy reads as "do not order a certificate". A permissive answer
    here would let anyone point a hostname at us and have certificates issued in our ACME account
    until the rate limit stopped them, so the check is a single conjunction with no fallbacks.
    """
    try:
        host = validate_host(domain, platform_zone="")
    except SlateDomainError as exc:
        raise _refuse("domain_not_authorized", str(exc), status_code=403) from exc

    row = get_domain_by_host(db, host=host)
    allowed, reason = authorize_issuance(dict(row) if row else None)
    if not allowed:
        raise _refuse("domain_not_authorized", reason, status_code=403)
    return AuthorizeResponse(domain=host, allowed=True, reason=reason)
