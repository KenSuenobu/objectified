"""Source-IP allowlist for webhook ingestion (REPO-7.6, #2804).

``POST /v1/repositories/webhook/{provider}`` is the one repository route with no bearer
token, so the HMAC signature over the raw body is its only authentication (REPO-4.3, #2781).
That check is sound and it is not what this module replaces. What it replaces is *who gets to
attempt it*: without a network filter, every unsigned POST from every scanner on the internet
buys a subscription lookup, a constant-time comparison against a real secret, and a ledger
row. Filtering on the source address first turns "we reject every forgery" into "we never
look at one", which is what the ticket means by defense in depth — and it is why the guard
runs **before** :func:`app.repository_webhook_dispatch.ingest_webhook_delivery`, never inside
it.

**The allowlist has two halves, and they are consulted in that order.**

*Provider-published ranges.* GitHub publishes its hook egress addresses at
``https://api.github.com/meta`` (the ``hooks`` array) and Atlassian publishes Bitbucket's at
``https://ip-ranges.atlassian.com/``. Both move — that is exactly why they are published as
endpoints rather than documentation — so they are fetched on a daily cadence and cached in
``apiome.webhook_provider_ip_range`` rather than hard-coded. GitLab.com publishes no
machine-readable equivalent, so its ranges come from deployment configuration
(``APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITLAB``) and are stored with ``source='configured'``;
the same setting exists for the other two providers, for a self-hosted instance whose
addresses no public endpoint knows.

*Per-tenant additional ranges.* A self-hosted GitLab runner, a corporate egress gateway, a
delivery relay: addresses only the tenant can know about. These are consulted **only for the
tenants that actually own the repository the delivery names**, resolved from the payload's
repository name — which is parsing, not verification, and reaches no secret. One tenant
widening its own filter must never widen another's, and a union across all tenants would do
precisely that.

**The failure modes are chosen, not inherited.**

* *Enforcement is opt-in* (``APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST``, default off). A filter
  that switches itself on during an upgrade would silently stop every existing deployment's
  deliveries, and the symptom — providers quietly retrying into a 403 — is one of the hardest
  to notice.
* *An empty range cache does not block by default.* A provider whose ranges have never been
  fetched (fresh deployment, upstream outage) would otherwise reject every delivery for that
  provider. The default allows and logs; ``APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST_STRICT``
  flips it to fail-closed for deployments that prefer the outage to the exposure.
* *An unidentifiable client address blocks* — unless the owning tenant has bypassed
  enforcement, which is precisely the escape hatch for a deployment whose addressing this
  service cannot see. Behind a proxy the peer address is the proxy, so the real client comes
  from ``X-Forwarded-For`` — but only as many hops in as the deployment says it actually
  operates (``APIOME_REPOSITORY_WEBHOOK_TRUSTED_PROXY_HOPS``, default 0 = trust nothing but
  the socket). A header shorter than the configured chain means the request did not traverse
  the proxies we believe sit in front of us, and the addresses in it are attacker-writable,
  so it is refused rather than guessed at.

Everything that decides is a pure function of its arguments; only :func:`refresh_provider_ip_ranges`
and :func:`evaluate_webhook_source_ip` touch the database or the network, and both take their
collaborators as parameters so the tests drive them against literals.
"""

from __future__ import annotations

import ipaddress
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import httpx

from .repository_webhook_ingest import SUPPORTED_PROVIDERS, normalize_provider

_logger = logging.getLogger(__name__)

__all__ = [
    "DECISION_ALLOWED",
    "DECISION_BLOCKED",
    "REASON_ENFORCEMENT_DISABLED",
    "REASON_PROVIDER_RANGE",
    "REASON_TENANT_ALLOWLIST",
    "REASON_TENANT_BYPASS",
    "REASON_RANGES_UNAVAILABLE",
    "REASON_NOT_ALLOWED",
    "REASON_CLIENT_IP_UNKNOWN",
    "IP_BLOCKED_ACTION",
    "IP_ALLOWLIST_UPDATED_ACTION",
    "IP_POLICY_UPDATED_ACTION",
    "PROVIDER_RANGE_SOURCES",
    "AllowlistDecision",
    "ProviderRefreshResult",
    "guard_webhook_delivery",
    "normalize_cidr",
    "parse_ip_address",
    "client_ip_from_request",
    "match_cidr",
    "fetch_provider_ip_ranges",
    "configured_provider_ranges",
    "refresh_provider_ip_ranges",
    "refresh_due_provider_ip_ranges",
    "evaluate_webhook_source_ip",
    "describe_tenant_ip_allowlist",
    "reset_provider_range_cache",
]

#: Outcome of :func:`evaluate_webhook_source_ip`, recorded on the ledger row.
DECISION_ALLOWED = "allowed"
DECISION_BLOCKED = "blocked"

#: Stable reason codes. Codes rather than sentences, so the ledger and the dashboards can be
#: grouped on them and an operator's alert does not break when the wording improves.
REASON_ENFORCEMENT_DISABLED = "enforcement-disabled"
REASON_PROVIDER_RANGE = "provider-range"
REASON_TENANT_ALLOWLIST = "tenant-allowlist"
REASON_TENANT_BYPASS = "tenant-bypass"
REASON_RANGES_UNAVAILABLE = "ranges-unavailable"
REASON_NOT_ALLOWED = "ip-not-allowed"
REASON_CLIENT_IP_UNKNOWN = "client-ip-unknown"

#: Workflow-audit actions. All carry the ``repository.`` prefix, so each one appears in the
#: REPO-7.5 compliance export without any further wiring.
IP_BLOCKED_ACTION = "repository.webhook.ip_blocked"
IP_ALLOWLIST_UPDATED_ACTION = "repository.webhook.ip_allowlist_updated"
IP_POLICY_UPDATED_ACTION = "repository.webhook.ip_policy_updated"

#: How the ledger records a blocked delivery. Reuses the REPO-4.3 webhook event table's
#: existing ``rejected`` outcome: from the provider's point of view a blocked delivery and a
#: badly-signed one are the same event — one we refused — and a new outcome value would mean
#: every existing ledger reader had to learn about it to keep counting rejections correctly.
BLOCKED_OUTCOME = "rejected"

#: Ranges stored with this source came from the provider's own published endpoint.
SOURCE_PROVIDER = "provider"
#: Ranges stored with this source came from deployment configuration.
SOURCE_CONFIGURED = "configured"

#: Refresh outcomes recorded in ``apiome.webhook_provider_ip_refresh.last_outcome``.
REFRESH_SUCCESS = "success"
REFRESH_FAILURE = "failure"
REFRESH_SKIPPED = "skipped"

#: Timeout for one provider range fetch. Generous — the refresh runs daily in the background
#: and a slow answer is better than a day-old cache — but bounded, because the sweep tick that
#: calls it also refreshes the other providers.
_FETCH_TIMEOUT = httpx.Timeout(15.0)

#: User agent for provider range fetches, so an upstream rate-limit conversation has something
#: to name.
_USER_AGENT = "Apiome-WebhookIpAllowlist/1.0"

#: Ceiling on the ranges accepted from one provider fetch. GitHub publishes a few thousand
#: entries across all its services and only the ``hooks`` slice is read; a response an order of
#: magnitude past that is a malformed or hostile answer, not a bigger provider.
MAX_PROVIDER_RANGES = 4096


@dataclass(frozen=True)
class ProviderRangeSource:
    """Where one provider's published hook ranges come from.

    Attributes:
        url: The published endpoint, or ``""`` when the provider publishes nothing
            machine-readable (GitLab.com) — those providers are configuration-only.
        extract: Turns the decoded JSON body into raw CIDR strings.
        note: One line for the admin panel explaining what an operator is looking at.
    """

    url: str
    extract: Callable[[Any], List[str]]
    note: str


def _extract_github_hooks(payload: Any) -> List[str]:
    """Pull the ``hooks`` array out of a GitHub ``meta`` response.

    Only ``hooks`` is read. ``actions``, ``web`` and the rest are much larger and describe
    addresses that never deliver a webhook, so including them would widen the filter to
    GitHub's entire estate for no gain.
    """
    if not isinstance(payload, Mapping):
        return []
    hooks = payload.get("hooks")
    if not isinstance(hooks, (list, tuple)):
        return []
    return [str(entry) for entry in hooks if isinstance(entry, str)]


def _extract_atlassian_bitbucket(payload: Any) -> List[str]:
    """Pull Bitbucket's ranges out of an ``ip-ranges.atlassian.com`` response.

    The document covers every Atlassian product, so entries are filtered on ``product``
    containing ``bitbucket``. An entry with no product list is skipped rather than assumed
    relevant: a filter that quietly widens itself when the upstream format shifts is worse
    than one that narrows.
    """
    if not isinstance(payload, Mapping):
        return []
    items = payload.get("items")
    if not isinstance(items, (list, tuple)):
        return []
    ranges: List[str] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        products = item.get("product")
        if not isinstance(products, (list, tuple)):
            continue
        if not any(str(p).strip().lower() == "bitbucket" for p in products):
            continue
        cidr = item.get("cidr")
        if isinstance(cidr, str):
            ranges.append(cidr)
    return ranges


#: Per-provider published range sources. GitLab.com documents its webhook egress addresses in
#: a wiki page rather than an endpoint, so there is nothing to fetch and its ranges come from
#: ``APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITLAB``.
PROVIDER_RANGE_SOURCES: Dict[str, ProviderRangeSource] = {
    "github": ProviderRangeSource(
        url="https://api.github.com/meta",
        extract=_extract_github_hooks,
        note="GitHub publishes its webhook egress ranges in the `hooks` array of api.github.com/meta.",
    ),
    "bitbucket": ProviderRangeSource(
        url="https://ip-ranges.atlassian.com/",
        extract=_extract_atlassian_bitbucket,
        note=(
            "Atlassian publishes Bitbucket's ranges at ip-ranges.atlassian.com; entries "
            "are filtered on product = bitbucket."
        ),
    ),
    "gitlab": ProviderRangeSource(
        url="",
        extract=lambda _payload: [],
        note=(
            "GitLab.com publishes no machine-readable range list. Set "
            "APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITLAB to the ranges your instance delivers from."
        ),
    ),
}


# ---------------------------------------------------------------------------------------
# Pure address handling
# ---------------------------------------------------------------------------------------


def normalize_cidr(raw: Any) -> Tuple[str, int]:
    """Canonicalise one CIDR (or bare address) for storage and comparison.

    A bare address is accepted and stored as its single-host network (``/32`` or ``/128``),
    because "allow this one machine" is the most common thing an operator types. Host bits
    are **not** silently discarded: ``10.0.0.1/24`` is rejected rather than quietly stored as
    ``10.0.0.0/24``, since an operator who meant one host and got 256 of them would never find
    out from the UI.

    Args:
        raw: The CIDR or address text.

    Returns:
        ``(canonical_text, family)`` where family is 4 or 6.

    Raises:
        ValueError: When the value is blank, not an address or network, or carries host bits.
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("CIDR is required")
    if len(text) > 64:
        raise ValueError("CIDR is too long")
    try:
        network = ipaddress.ip_network(text, strict=True)
    except ValueError as exc:
        # `strict=True` reports host bits and malformed input through the same exception, so
        # the message is re-raised as-is: it already says which of the two happened.
        raise ValueError(f"Invalid CIDR {text!r}: {exc}") from exc
    return str(network), int(network.version)


def parse_ip_address(raw: Any) -> Optional[ipaddress._BaseAddress]:
    """Parse a client address, tolerating the shapes a proxy actually emits.

    Handles the bracketed-with-port form ``[2001:db8::1]:443`` and the IPv4 ``1.2.3.4:443``
    form, and unwraps IPv4-mapped IPv6 (``::ffff:1.2.3.4``) so a dual-stack listener matches
    the same IPv4 ranges a v4 listener would.

    Args:
        raw: The address text.

    Returns:
        The parsed address, or ``None`` when it is not one. ``None`` is a decision input, not
        an error: an unparseable address is treated as an unidentifiable client.
    """
    text = str(raw or "").strip()
    if not text:
        return None
    if text.startswith("["):
        closing = text.find("]")
        if closing > 0:
            text = text[1:closing]
    elif text.count(":") == 1 and "." in text:
        text = text.split(":", 1)[0]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def client_ip_from_request(
    headers: Mapping[str, Any],
    peer_ip: Optional[str],
    trusted_proxy_hops: int,
) -> Optional[str]:
    """Determine the address the delivery genuinely came from.

    With ``trusted_proxy_hops = 0`` the socket peer is the answer and ``X-Forwarded-For`` is
    ignored entirely — the header is caller-supplied, so honouring it without a proxy in front
    would let anyone name their own source address and defeat the whole filter.

    With ``N > 0`` the deployment is asserting that exactly N proxies it controls sit in front
    of this service, each appending the address it received from. The client is therefore the
    Nth entry from the right of the header. A header with fewer than N entries means the
    request did not traverse the chain the deployment described — so the remaining entries are
    attacker-written, and the address is reported as unknown rather than guessed from them.

    Args:
        headers: Request headers (case-insensitive lookup is performed).
        peer_ip: The socket peer address, when the server exposes one.
        trusted_proxy_hops: How many reverse proxies the deployment operates in front of this
            endpoint. Negative values are treated as 0.

    Returns:
        The client address as text, or ``None`` when it cannot be established.
    """
    hops = max(0, int(trusted_proxy_hops or 0))
    if hops == 0:
        parsed = parse_ip_address(peer_ip)
        return str(parsed) if parsed else None

    forwarded = ""
    for key, value in headers.items():
        if str(key).lower() == "x-forwarded-for":
            forwarded = str(value or "")
            break

    parts = [segment.strip() for segment in forwarded.split(",") if segment.strip()]
    if len(parts) < hops:
        return None
    parsed = parse_ip_address(parts[-hops])
    return str(parsed) if parsed else None


def match_cidr(
    address: Optional[ipaddress._BaseAddress], cidrs: Iterable[str]
) -> Optional[str]:
    """Return the first CIDR containing ``address``, or ``None``.

    A stored value that no longer parses is skipped rather than raising: one corrupt row must
    not be able to reject every delivery the rest of the list would have allowed.

    Args:
        address: The parsed client address, or ``None``.
        cidrs: Candidate CIDR strings.

    Returns:
        The matching CIDR text, or ``None`` when none contains the address.
    """
    if address is None:
        return None
    for cidr in cidrs:
        try:
            network = ipaddress.ip_network(str(cidr), strict=False)
        except ValueError:
            _logger.warning("webhook ip allowlist: skipping unparseable stored CIDR %r", cidr)
            continue
        if network.version != address.version:
            continue
        if address in network:
            return str(cidr)
    return None


# ---------------------------------------------------------------------------------------
# Provider range refresh
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderRefreshResult:
    """What one provider's range refresh did.

    Attributes:
        provider: The provider refreshed.
        outcome: ``success`` | ``failure`` | ``skipped``.
        stored: Ranges written to the cache (fetched plus configured, deduplicated).
        fetched: Ranges the provider's endpoint yielded, before configured ones were added.
        removed: Cached ranges deleted because they are no longer published.
        error: Failure detail, or ``None``.
    """

    provider: str
    outcome: str
    stored: int = 0
    fetched: int = 0
    removed: int = 0
    error: Optional[str] = None


def configured_provider_ranges(provider: str) -> List[str]:
    """Read the deployment-configured ranges for one provider.

    The escape hatch for a provider that publishes nothing (GitLab.com) and for self-hosted
    instances whose addresses no public endpoint knows. An entry that does not parse is
    dropped with a warning rather than failing the refresh: one typo in a comma-separated
    setting must not cost the deployment the other ranges in it.

    Args:
        provider: Normalized provider id.

    Returns:
        Canonical CIDR strings, in configuration order, deduplicated.
    """
    from .config import settings

    raw = str(
        getattr(settings, f"repository_webhook_ip_ranges_{provider}", "") or ""
    )
    seen: Dict[str, None] = {}
    for token in raw.replace(";", ",").split(","):
        candidate = token.strip()
        if not candidate:
            continue
        try:
            canonical, _family = normalize_cidr(candidate)
        except ValueError as exc:
            _logger.warning(
                "webhook ip allowlist: ignoring configured range %r for %s (%s)",
                candidate,
                provider,
                exc,
            )
            continue
        seen.setdefault(canonical, None)
    return list(seen)


def fetch_provider_ip_ranges(
    provider: str,
    *,
    client_factory: Optional[Callable[[], httpx.Client]] = None,
) -> List[str]:
    """Fetch one provider's published hook ranges.

    Args:
        provider: Normalized provider id.
        client_factory: Builds the HTTP client; injected by the tests. Defaults to a plain
            :class:`httpx.Client` — the URLs are module constants, not caller input, so the
            SSRF guard that wraps user-supplied URL fetches does not apply here.

    Returns:
        Raw CIDR strings as published, capped at :data:`MAX_PROVIDER_RANGES`. Empty for a
        provider that publishes nothing.

    Raises:
        RuntimeError: When the endpoint answered with a non-2xx status or an unusable body.
        httpx.HTTPError: When the request itself failed.
    """
    source = PROVIDER_RANGE_SOURCES.get(provider)
    if source is None or not source.url:
        return []

    factory = client_factory or (
        lambda: httpx.Client(
            timeout=_FETCH_TIMEOUT, headers={"User-Agent": _USER_AGENT}
        )
    )
    with factory() as client:
        response = client.get(source.url)
        if response.status_code >= 400:
            raise RuntimeError(
                f"{source.url} answered {response.status_code}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError(f"{source.url} did not answer with JSON: {exc}") from exc

    ranges = source.extract(payload)
    if len(ranges) > MAX_PROVIDER_RANGES:
        raise RuntimeError(
            f"{source.url} published {len(ranges)} ranges, more than the "
            f"{MAX_PROVIDER_RANGES} this deployment will cache"
        )
    return ranges


def refresh_provider_ip_ranges(
    db: Any,
    provider: str,
    *,
    client_factory: Optional[Callable[[], httpx.Client]] = None,
) -> ProviderRefreshResult:
    """Refresh one provider's cached ranges, and record the attempt either way.

    The cache is replaced, not merged: a range the provider has stopped publishing must stop
    being allowed, and an append-only cache would keep yesterday's addresses alive forever.
    The replacement is one transaction in the DAO, so the guard never observes a moment with
    no ranges for a provider that has them.

    A fetch that yields nothing is treated as a **failure**, not as "the provider has no
    ranges any more". An empty answer is far more likely to be an upstream incident than a
    genuine withdrawal of every address, and acting on it would either open the filter (in the
    default posture) or take the deployment's deliveries down (in strict mode) on the strength
    of one bad response. The previous cache is left in place and the refresh is retried on the
    next tick.

    Args:
        db: Database handle.
        provider: Provider id; normalized here.
        client_factory: Injected HTTP client factory (tests).

    Returns:
        The :class:`ProviderRefreshResult`. Never raises: a refresh failure is recorded and
        reported, because the caller is a background sweep whose next tick is the retry.
    """
    key = normalize_provider(provider)
    if not key:
        return ProviderRefreshResult(
            provider=str(provider),
            outcome=REFRESH_FAILURE,
            error=f"unsupported provider {provider!r}",
        )

    configured = configured_provider_ranges(key)
    fetched: List[str] = []
    error: Optional[str] = None
    try:
        fetched = fetch_provider_ip_ranges(key, client_factory=client_factory)
    except Exception as exc:  # noqa: BLE001 - every fetch failure is recorded, not raised
        error = f"{type(exc).__name__}: {exc}"
        _logger.warning(
            "webhook ip allowlist: provider range fetch failed provider=%s (%s)", key, error
        )

    rows: List[Dict[str, Any]] = []
    seen: Dict[str, None] = {}
    for cidr in list(fetched) + list(configured):
        try:
            canonical, family = normalize_cidr(cidr)
        except ValueError as exc:
            _logger.warning(
                "webhook ip allowlist: provider %s published unusable range %r (%s)",
                key,
                cidr,
                exc,
            )
            continue
        if canonical in seen:
            continue
        seen[canonical] = None
        rows.append(
            {
                "cidr": canonical,
                "family": family,
                # A range present in both the fetch and the configuration is attributed to the
                # provider: that is the stronger claim, and it is what the operator wants to
                # see when deciding whether the configured entry is still needed.
                "source": SOURCE_PROVIDER if cidr in fetched else SOURCE_CONFIGURED,
            }
        )

    if not rows:
        # `skipped` is reserved for the one case that is not a fault: a provider that
        # publishes no endpoint (GitLab.com) and has no configured ranges either — there is
        # genuinely nothing to fetch, and reporting that as a failure would leave the panel
        # permanently red about a state the operator has already chosen. Everything else —
        # including a published endpoint answering with an empty list — is a failure, because
        # acting on it would empty a cache the filter depends on.
        has_source = bool(PROVIDER_RANGE_SOURCES[key].url)
        nothing_to_do = error is None and not has_source and not configured
        outcome = REFRESH_SKIPPED if nothing_to_do else REFRESH_FAILURE
        detail = error or (
            f"{key} publishes no range list and none are configured"
            if nothing_to_do
            else f"{key} published no usable ranges"
        )
        _record_refresh_state(db, key, outcome=outcome, error=detail, range_count=None)
        return ProviderRefreshResult(
            provider=key, outcome=outcome, fetched=len(fetched), error=detail
        )

    try:
        removed = int(db.replace_webhook_provider_ip_ranges(key, rows) or 0)
    except Exception as exc:  # noqa: BLE001 - a store failure is a recorded failure
        detail = f"{type(exc).__name__}: {exc}"
        _logger.exception("webhook ip allowlist: range store failed provider=%s", key)
        _record_refresh_state(db, key, outcome=REFRESH_FAILURE, error=detail, range_count=None)
        return ProviderRefreshResult(
            provider=key, outcome=REFRESH_FAILURE, fetched=len(fetched), error=detail
        )

    reset_provider_range_cache(key)
    _record_refresh_state(
        db,
        key,
        outcome=REFRESH_SUCCESS,
        # A partial success is still a success — the cache holds ranges — but the fetch error
        # is kept so the panel can say "these are configured ranges; GitHub has been
        # unreachable since Tuesday".
        error=error,
        range_count=len(rows),
    )
    return ProviderRefreshResult(
        provider=key,
        outcome=REFRESH_SUCCESS,
        stored=len(rows),
        fetched=len(fetched),
        removed=removed,
        error=error,
    )


def _record_refresh_state(
    db: Any,
    provider: str,
    *,
    outcome: str,
    error: Optional[str],
    range_count: Optional[int],
) -> None:
    """Write the per-provider refresh state; best-effort, never raises.

    Bookkeeping about a refresh must not be able to fail the refresh: the ranges are already
    stored by the time this runs, and losing the timestamp costs one extra fetch tomorrow.
    """
    try:
        db.record_webhook_provider_ip_refresh(
            provider,
            outcome=outcome,
            error=(error[:2000] if error else None),
            range_count=range_count,
        )
    except Exception:
        _logger.exception(
            "webhook ip allowlist: refresh state not recorded provider=%s", provider
        )


def refresh_due_provider_ip_ranges(
    db: Any,
    *,
    interval_seconds: Optional[int] = None,
    now: Optional[datetime] = None,
    client_factory: Optional[Callable[[], httpx.Client]] = None,
) -> List[ProviderRefreshResult]:
    """Refresh every provider whose cache is older than the configured cadence (REPO-7.6).

    The sweep entry point. Due-ness is measured from ``last_success_at``, not from the last
    *attempt*: a provider whose endpoint has been failing must be retried on the next tick
    rather than once a day, which is the whole difference between a two-hour gap and a
    two-day one when an upstream incident ends.

    Args:
        db: Database handle.
        interval_seconds: Refresh cadence; defaults to the configured daily value.
        now: Clock override for the tests.
        client_factory: Injected HTTP client factory (tests).

    Returns:
        One result per provider actually refreshed. A tick with nothing due returns ``[]``.
    """
    from .config import settings

    cadence = int(
        interval_seconds
        if interval_seconds is not None
        else settings.repository_webhook_ip_refresh_interval_seconds
    )
    cadence = max(60, cadence)
    moment = now or datetime.now(timezone.utc)

    try:
        state = {
            str(row.get("provider")): row
            for row in (db.list_webhook_provider_ip_refresh() or [])
        }
    except Exception:
        _logger.exception("webhook ip allowlist: refresh state read failed")
        state = {}

    results: List[ProviderRefreshResult] = []
    for provider in SUPPORTED_PROVIDERS:
        last_success = state.get(provider, {}).get("last_success_at")
        if isinstance(last_success, datetime):
            reference = (
                last_success
                if last_success.tzinfo
                else last_success.replace(tzinfo=timezone.utc)
            )
            if (moment - reference).total_seconds() < cadence:
                continue
        results.append(
            refresh_provider_ip_ranges(db, provider, client_factory=client_factory)
        )
    return results


# ---------------------------------------------------------------------------------------
# Cached provider-range reads
# ---------------------------------------------------------------------------------------


@dataclass
class _RangeCacheEntry:
    """One provider's ranges as of ``loaded_at`` (monotonic seconds)."""

    loaded_at: float
    cidrs: Tuple[str, ...]


#: Process-local cache of the provider ranges, keyed by provider. The guard runs on an
#: unauthenticated endpoint, so a flood of blocked deliveries would otherwise be a flood of
#: queries — the one thing an attacker can still make this endpoint do. The ranges change
#: daily, so a short TTL costs nothing in freshness; the refresh invalidates the entry it
#: rewrote immediately, so an operator-triggered refresh is visible at once on that replica.
_RANGE_CACHE: Dict[str, _RangeCacheEntry] = {}


def reset_provider_range_cache(provider: Optional[str] = None) -> None:
    """Drop the process-local provider range cache.

    Args:
        provider: Drop just this provider's entry; ``None`` drops everything. Called by the
            refresh (for the provider it rewrote) and by the tests between cases.
    """
    if provider is None:
        _RANGE_CACHE.clear()
    else:
        _RANGE_CACHE.pop(provider, None)


def _provider_ranges(db: Any, provider: str) -> Tuple[str, ...]:
    """Read one provider's cached ranges, through the process-local TTL cache.

    A read failure yields an empty tuple and is **not** cached, so a database blip does not
    pin the guard into its ranges-unavailable posture for the whole TTL.
    """
    from .config import settings

    ttl = max(0, int(settings.repository_webhook_ip_cache_seconds or 0))
    entry = _RANGE_CACHE.get(provider)
    if entry is not None and ttl > 0 and (time.monotonic() - entry.loaded_at) < ttl:
        return entry.cidrs

    try:
        rows = db.list_webhook_provider_ip_ranges(provider) or []
    except Exception:
        _logger.exception(
            "webhook ip allowlist: provider range read failed provider=%s", provider
        )
        return ()

    cidrs = tuple(str(row.get("cidr")) for row in rows if row.get("cidr"))
    if ttl > 0:
        _RANGE_CACHE[provider] = _RangeCacheEntry(loaded_at=time.monotonic(), cidrs=cidrs)
    return cidrs


# ---------------------------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AllowlistDecision:
    """Whether one delivery's source address may proceed to verification.

    Attributes:
        allowed: True when the delivery may continue to HMAC verification.
        decision: :data:`DECISION_ALLOWED` or :data:`DECISION_BLOCKED`.
        reason: Stable ``REASON_*`` code for the ledger and the response.
        client_ip: The address the decision was made about, when one could be established.
        matched_cidr: The range that allowed it, when the allowance came from a range.
        tenant_ids: Tenants that own the repository the delivery names, when it named one that
            is registered here. Used to attribute the audit row for a block.
    """

    allowed: bool
    decision: str
    reason: str
    client_ip: Optional[str] = None
    matched_cidr: Optional[str] = None
    tenant_ids: Tuple[str, ...] = field(default_factory=tuple)


def _allow(reason: str, *, client_ip: Optional[str] = None, cidr: Optional[str] = None,
           tenant_ids: Sequence[str] = ()) -> AllowlistDecision:
    """Build an allowing decision."""
    return AllowlistDecision(
        allowed=True,
        decision=DECISION_ALLOWED,
        reason=reason,
        client_ip=client_ip,
        matched_cidr=cidr,
        tenant_ids=tuple(tenant_ids),
    )


def _block(reason: str, *, client_ip: Optional[str] = None,
           tenant_ids: Sequence[str] = ()) -> AllowlistDecision:
    """Build a blocking decision."""
    return AllowlistDecision(
        allowed=False,
        decision=DECISION_BLOCKED,
        reason=reason,
        client_ip=client_ip,
        tenant_ids=tuple(tenant_ids),
    )


def _candidate_tenant_ids(db: Any, provider: str, repo_full_name: str) -> List[str]:
    """Tenants that have registered the repository a delivery names.

    Resolving this is parsing, not authentication: the repository name is read straight out of
    the payload and reaches no secret. It exists so a tenant's own additional ranges are
    consulted only for that tenant's repositories — a union across every tenant would let one
    workspace widen the filter protecting all the others.
    """
    try:
        return [
            str(tenant_id)
            for tenant_id in (
                db.list_repository_webhook_tenant_ids(provider, repo_full_name) or []
            )
            if tenant_id
        ]
    except Exception:
        _logger.exception(
            "webhook ip allowlist: tenant resolution failed repo=%s", repo_full_name
        )
        return []


def evaluate_webhook_source_ip(
    db: Any,
    *,
    provider: str,
    client_ip: Optional[str],
    repo_full_name: Optional[str] = None,
) -> AllowlistDecision:
    """Decide whether a delivery's source address may proceed to verification (REPO-7.6).

    The order is deliberate and cheapest-first: the deployment switch, then the provider's
    published ranges (one cached read, no tenant context needed), and only for an address
    those do not cover, the per-tenant halves — which are what require resolving the
    repository the payload names.

    One ordering subtlety: a tenant that has **bypassed** enforcement is honoured even when
    the client address could not be established at all. The bypass means "do not filter this
    tenant's deliveries", and a deployment whose proxy configuration yields no usable address
    is exactly the situation an operator reaches for the bypass to escape. Blocking there
    would leave a hole in the one escape hatch the feature provides. Every *other* verdict on
    an unidentifiable address is a block.

    Args:
        db: Database handle.
        provider: Normalized provider id from the URL path.
        client_ip: The client address established by :func:`client_ip_from_request`, or
            ``None`` when it could not be.
        repo_full_name: Lowercased ``owner/name`` from the payload, when the body could be
            parsed. ``None`` simply means the per-tenant halves cannot be consulted — it is
            never on its own a reason to allow.

    Returns:
        The :class:`AllowlistDecision`.
    """
    from .config import settings

    if not settings.repository_webhook_ip_allowlist_enabled:
        return _allow(REASON_ENFORCEMENT_DISABLED, client_ip=client_ip)

    address = parse_ip_address(client_ip)
    text = str(address) if address is not None else None

    provider_ranges: Tuple[str, ...] = ()
    if address is not None:
        provider_ranges = _provider_ranges(db, provider)
        matched = match_cidr(address, provider_ranges)
        if matched:
            return _allow(REASON_PROVIDER_RANGE, client_ip=text, cidr=matched)

    tenant_ids = (
        _candidate_tenant_ids(db, provider, repo_full_name) if repo_full_name else []
    )

    for tenant_id in tenant_ids:
        try:
            policy = db.get_tenant_webhook_ip_policy(tenant_id) or {}
        except Exception:
            _logger.exception(
                "webhook ip allowlist: policy read failed tenant_id=%s", tenant_id
            )
            policy = {}
        if policy and policy.get("enforcement_enabled") is False:
            # The tenant-admin bypass: this workspace has accepted the exposure for its own
            # repositories, and only for its own.
            return _allow(REASON_TENANT_BYPASS, client_ip=text, tenant_ids=[tenant_id])

        if address is None:
            continue

        try:
            entries = db.list_tenant_webhook_ip_allowlist(tenant_id, enabled_only=True) or []
        except Exception:
            _logger.exception(
                "webhook ip allowlist: tenant entry read failed tenant_id=%s", tenant_id
            )
            entries = []
        tenant_match = match_cidr(
            address, [str(entry.get("cidr")) for entry in entries if entry.get("cidr")]
        )
        if tenant_match:
            return _allow(
                REASON_TENANT_ALLOWLIST,
                client_ip=text,
                cidr=tenant_match,
                tenant_ids=[tenant_id],
            )

    if address is None:
        # Behind a proxy chain shorter than the deployment described, or a peer address the
        # server did not supply. Every candidate source in hand is attacker-writable, so
        # there is nothing here to check an allowlist against.
        return _block(REASON_CLIENT_IP_UNKNOWN, tenant_ids=tenant_ids)

    if not provider_ranges:
        # Nothing has ever been cached for this provider — a fresh deployment, or an upstream
        # endpoint that has never answered. Blocking here would reject every delivery for the
        # provider on the strength of a cache we failed to populate, so the default allows and
        # says so loudly; a deployment that prefers the outage sets the strict flag.
        if settings.repository_webhook_ip_allowlist_strict:
            return _block(REASON_RANGES_UNAVAILABLE, client_ip=text, tenant_ids=tenant_ids)
        _logger.warning(
            "webhook ip allowlist: no cached ranges for provider=%s — allowing delivery from "
            "%s unfiltered. Check the daily refresh, or set "
            "APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST_STRICT to fail closed instead.",
            provider,
            text,
        )
        return _allow(REASON_RANGES_UNAVAILABLE, client_ip=text, tenant_ids=tenant_ids)

    return _block(REASON_NOT_ALLOWED, client_ip=text, tenant_ids=tenant_ids)


def _repo_full_name_from_raw_body(provider: str, raw_body: bytes) -> Optional[str]:
    """Best-effort read of the repository name a delivery claims, for tenant scoping.

    Deliberately total: every malformed body — not JSON, not an object, no repository key —
    comes back as ``None`` rather than raising. A body the guard cannot read is not a reason
    to fail the request *here*; it simply means the per-tenant halves of the allowlist have no
    tenant to be evaluated against, and the request falls through to the provider-range
    verdict. The 400 for an unusable body still comes from the ingestion path afterwards, for
    the deliveries that get that far.

    This is parsing, never authentication: no secret is read, and no comparison is made.
    """
    import json

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    from .repository_webhook_ingest import repo_full_name_from_payload

    try:
        return repo_full_name_from_payload(provider, payload) or None
    except Exception:  # noqa: BLE001 - hostile payloads must not crash the guard
        _logger.exception("webhook ip allowlist: repository name extraction failed")
        return None


def guard_webhook_delivery(
    db: Any,
    *,
    provider: str,
    raw_body: bytes,
    headers: Mapping[str, Any],
    peer_ip: Optional[str],
) -> AllowlistDecision:
    """Decide, record and report whether a delivery may reach verification (REPO-7.6).

    The single call the ingestion route makes. It runs before
    :func:`app.repository_webhook_dispatch.ingest_webhook_delivery`, so a blocked delivery is
    never given the chance to have its signature checked — which is the ticket's defense-in-
    depth requirement, and the reason this is not a branch inside the dispatcher.

    A block is written to the same webhook ledger every other delivery lands in, with the
    existing ``rejected`` outcome and the ``ip-not-allowed`` reason, plus a ``workflow_audit``
    row for each tenant that owns the named repository. Both writes are best-effort: an
    evidence problem must not become an availability problem, and the block itself has
    already been decided by the time either runs.

    Args:
        db: Database handle.
        provider: Normalized provider id from the URL path.
        raw_body: The exact received bytes. Read only for the repository name.
        headers: The request headers.
        peer_ip: The socket peer address, when the server exposes one.

    Returns:
        The :class:`AllowlistDecision`. The caller raises 403 when it is not ``allowed``.
    """
    from .config import settings

    client_ip = client_ip_from_request(
        headers, peer_ip, settings.repository_webhook_trusted_proxy_hops
    )
    repo_full_name = _repo_full_name_from_raw_body(provider, raw_body)
    decision = evaluate_webhook_source_ip(
        db, provider=provider, client_ip=client_ip, repo_full_name=repo_full_name
    )
    if decision.allowed:
        return decision

    _logger.warning(
        "webhook ip allowlist: blocked delivery provider=%s source=%s reason=%s repo=%s",
        provider,
        decision.client_ip or "unknown",
        decision.reason,
        repo_full_name or "unknown",
    )

    from .repository_webhook_dispatch import read_delivery_headers

    delivery = read_delivery_headers(headers)
    try:
        db.record_repository_webhook_event(
            provider=provider,
            outcome=BLOCKED_OUTCOME,
            delivery_id=delivery.delivery_id,
            event_type=delivery.event_type,
            repo_full_name=repo_full_name,
            reason=decision.reason,
        )
    except Exception:
        _logger.exception(
            "webhook ip allowlist: ledger write failed for blocked delivery provider=%s",
            provider,
        )

    for tenant_id in decision.tenant_ids:
        # Audited per owning tenant, exactly as the REPO-4.3 signature rejection is: a tenant
        # whose provider changed egress ranges has to be able to see *why* its deliveries
        # stopped, and a row nobody can read would not tell them.
        try:
            db.insert_workflow_audit(
                tenant_id,
                None,
                None,
                IP_BLOCKED_ACTION,
                "failure",
                None,
                {
                    "provider": provider,
                    "repositoryFullName": repo_full_name,
                    "sourceIp": decision.client_ip,
                    "reason": decision.reason,
                    "eventType": delivery.event_type,
                    "deliveryId": delivery.delivery_id,
                },
            )
        except Exception:
            _logger.exception(
                "webhook ip allowlist: audit write failed tenant_id=%s", tenant_id
            )

    return decision


# ---------------------------------------------------------------------------------------
# Admin projection
# ---------------------------------------------------------------------------------------


def _iso(value: Any) -> Optional[str]:
    """Render a timestamp as ISO 8601 UTC, or ``None``."""
    if not isinstance(value, datetime):
        return None
    moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat()


def _is_stale(row: Mapping[str, Any], cadence: int, now: datetime) -> bool:
    """True when a provider's cache is older than **two** refresh cadences.

    One cadence would be the wrong threshold: a refresh that lands a minute late — which the
    sweep's own tick interval guarantees it sometimes will — would flip the panel to "stale"
    every day for no reason an operator could act on. Two means a refresh has actually been
    missed. A provider that has never refreshed successfully is stale by definition.
    """
    last_success = row.get("last_success_at")
    if not isinstance(last_success, datetime):
        return True
    reference = last_success if last_success.tzinfo else last_success.replace(tzinfo=timezone.utc)
    return (now - reference).total_seconds() > (cadence * 2)


def describe_tenant_ip_allowlist(
    db: Any, tenant_id: str, *, now: Optional[datetime] = None
) -> Dict[str, Any]:
    """Project the allowlist a tenant administrator sees (REPO-7.6).

    One read answers the three questions the panel exists for: is the filter on for us, what
    does the provider currently vouch for (and how stale is that), and what have we added
    ourselves.

    Args:
        db: Database handle.
        tenant_id: The tenant whose view is being built.
        now: Clock override for the tests.

    Returns:
        A camelCase-keyed dict matching ``RepositoryWebhookIpAllowlistResponse``.
    """
    from .config import settings

    moment = now or datetime.now(timezone.utc)
    cadence = max(60, int(settings.repository_webhook_ip_refresh_interval_seconds))

    try:
        policy = db.get_tenant_webhook_ip_policy(tenant_id) or {}
    except Exception:
        _logger.exception("webhook ip allowlist: policy read failed tenant_id=%s", tenant_id)
        policy = {}

    try:
        refresh_rows = {
            str(row.get("provider")): row
            for row in (db.list_webhook_provider_ip_refresh() or [])
        }
    except Exception:
        _logger.exception("webhook ip allowlist: refresh state read failed")
        refresh_rows = {}

    providers: List[Dict[str, Any]] = []
    for provider in SUPPORTED_PROVIDERS:
        source = PROVIDER_RANGE_SOURCES[provider]
        try:
            rows = db.list_webhook_provider_ip_ranges(provider) or []
        except Exception:
            _logger.exception(
                "webhook ip allowlist: provider range read failed provider=%s", provider
            )
            rows = []
        state = refresh_rows.get(provider, {})
        providers.append(
            {
                "provider": provider,
                "sourceUrl": source.url or None,
                "note": source.note,
                "rangeCount": len(rows),
                "ranges": [
                    {
                        "cidr": str(row.get("cidr")),
                        "family": int(row.get("family") or 4),
                        "source": str(row.get("source") or SOURCE_PROVIDER),
                        "refreshedAt": _iso(row.get("refreshed_at")),
                    }
                    for row in rows
                ],
                "lastAttemptAt": _iso(state.get("last_attempt_at")),
                "lastSuccessAt": _iso(state.get("last_success_at")),
                "lastOutcome": str(state.get("last_outcome") or "pending"),
                "lastError": (str(state["last_error"]) if state.get("last_error") else None),
                "stale": _is_stale(state, cadence, moment),
            }
        )

    try:
        entry_rows = db.list_tenant_webhook_ip_allowlist(tenant_id) or []
    except Exception:
        _logger.exception(
            "webhook ip allowlist: tenant entry read failed tenant_id=%s", tenant_id
        )
        entry_rows = []

    return {
        "enforcementEnabled": bool(settings.repository_webhook_ip_allowlist_enabled),
        "strict": bool(settings.repository_webhook_ip_allowlist_strict),
        "refreshIntervalSeconds": cadence,
        "trustedProxyHops": max(0, int(settings.repository_webhook_trusted_proxy_hops or 0)),
        "tenantEnforcementEnabled": (
            True if policy.get("enforcement_enabled") is None
            else bool(policy.get("enforcement_enabled"))
        ),
        "bypassReason": (
            str(policy["bypass_reason"]) if policy.get("bypass_reason") else None
        ),
        "policyUpdatedAt": _iso(policy.get("updated_at")),
        "providers": providers,
        "entries": [
            {
                "id": str(row.get("id")),
                "cidr": str(row.get("cidr")),
                "family": int(row.get("family") or 4),
                "description": (
                    str(row["description"]) if row.get("description") else None
                ),
                "enabled": bool(row.get("enabled", True)),
                "createdAt": _iso(row.get("created_at")),
                "updatedAt": _iso(row.get("updated_at")),
            }
            for row in entry_rows
        ],
    }
