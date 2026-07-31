"""Tenant-scoped external ``$ref`` policy for repository scans — REPO-3.9 (#2778).

A specification discovered by the repository scanner may reference schemas that live
outside the repository::

    {"$ref": "https://schemas.acme.com/common.json#/Money"}

Fetching that silently makes every scan an SSRF primitive and a supply-chain hole;
skipping it silently produces a model that is quietly missing definitions. REPO-3.9 makes
the choice the tenant's, and records what the choice cost.

**The three modes** (:class:`ExternalRefMode`):

``block``
    The default. Nothing is fetched. Every external reference is reported unresolved with
    reason :data:`REASON_POLICY_BLOCKED`, and the file row carries a warning listing
    exactly which references are missing (:func:`build_warning`).

``inline``
    References are fetched at scan time and inlined into the scanned document — a
    *snapshot*. The imported model is self-contained and keeps no live dependency on the
    remote host. The allowlist is optional here: empty means "any host the SSRF guard
    permits"; non-empty narrows it, so tightening a tenant never requires a mode change.

``proxy-fetch``
    As ``inline``, but the allowlist is **mandatory**: an empty allowlist fetches nothing.
    This is the mode for a tenant that wants external references followed, but only ever to
    a named set of hosts.

**What this module is.** Pure policy plus the two side effects the policy owes the rest of
the system: the audit row every fetch writes, and the warning a file carries. It owns no
resolution logic of its own — :mod:`app.remote_ref_resolver` does the fetching, under the
SSRF guard and its budgets, and this module supplies the *gate* it consults before every
URL (:func:`build_gate`). That layering matters: the policy can only ever make the resolver
fetch **less**, never more, so nothing here can weaken the SSRF guard.

**Fail-closed everywhere.** An unreadable tenant row, an unparseable allowlist, an unknown
mode, or a deployment kill switch (``APIOME_REMOTE_REF_RESOLUTION_ALLOWED=false``) all
resolve to "fetch nothing". The worst outcome of a fault here is a warning on a file row.

The scan-time wiring — running this over a discovered file and persisting its results — is
:mod:`app.repository_external_ref_scan`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_POLICY",
    "EXTERNAL_REF_FETCHED_ACTION",
    "MAX_WARNING_REFS",
    "REASON_ALLOWLIST_EMPTY",
    "REASON_HOST_NOT_ALLOWLISTED",
    "REASON_INVALID_URL",
    "REASON_POLICY_BLOCKED",
    "REASON_RESOLUTION_DISABLED",
    "REASON_UNSUPPORTED_SCHEME",
    "ExternalRefDecision",
    "ExternalRefMode",
    "ExternalRefPolicy",
    "build_gate",
    "build_warning",
    "decide",
    "host_allowed",
    "hostname_matches",
    "load_tenant_policy",
    "normalize_allowlist",
    "normalize_mode",
    "policy_from_row",
    "record_external_ref_fetched",
]


class ExternalRefMode(str, Enum):
    """What a tenant permits the scanner to do with an external ``$ref``."""

    #: Fetch nothing; report every external reference as a warning (the default).
    BLOCK = "block"
    #: Fetch and inline at scan time (snapshot), allowlist optional.
    INLINE = "inline"
    #: Fetch and inline, restricted to the (mandatory) hostname allowlist.
    PROXY_FETCH = "proxy-fetch"

    @property
    def fetches(self) -> bool:
        """Whether this mode may fetch at all."""
        return self is not ExternalRefMode.BLOCK

    @property
    def requires_allowlist(self) -> bool:
        """Whether an empty allowlist means "nothing is fetchable" in this mode."""
        return self is ExternalRefMode.PROXY_FETCH


# ---------------------------------------------------------------------------
# Refusal reasons (stable strings; they reach the warning, the audit and the UI)
# ---------------------------------------------------------------------------

#: The tenant's policy is ``block``: nothing may be fetched.
REASON_POLICY_BLOCKED = "blocked-by-tenant-policy"
#: The URL's host does not match any allowlist pattern.
REASON_HOST_NOT_ALLOWLISTED = "host-not-allowlisted"
#: The mode requires an allowlist and the tenant has not configured one.
REASON_ALLOWLIST_EMPTY = "allowlist-empty"
#: The reference names a scheme the scanner never fetches (``file:``, ``data:``, ...).
REASON_UNSUPPORTED_SCHEME = "unsupported-scheme"
#: The reference is not a URL with a host at all.
REASON_INVALID_URL = "invalid-url"
#: Remote resolution is switched off for this deployment (operator kill switch).
REASON_RESOLUTION_DISABLED = "resolution-disabled"

#: Workflow-audit action written once per fetched external reference. Distinct from the
#: refresh-cycle action (RAR-5.3) so external-fetch history is queryable on its own.
EXTERNAL_REF_FETCHED_ACTION = "repository.external_ref_fetched"

#: How many individual references a file's warning itemizes. The count stays exact; a
#: document with thousands of references must not turn one row into a megabyte of JSONB.
MAX_WARNING_REFS = 25

#: Schemes a fetch may ever use. Anything else is refused with
#: :data:`REASON_UNSUPPORTED_SCHEME` before the URL reaches the resolver's SSRF guard.
_FETCHABLE_SCHEMES = frozenset({"http", "https"})


# ---------------------------------------------------------------------------
# Policy value object
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExternalRefPolicy:
    """The external-``$ref`` policy in force for one tenant.

    Attributes:
        mode: The tenant's :class:`ExternalRefMode`.
        allowlist: Normalized hostname patterns, deduplicated and ordered.
        is_default: True when this is the built-in default rather than a stored row (an
            unconfigured tenant, or a lookup that failed and degraded to fail-closed).
    """

    mode: ExternalRefMode = ExternalRefMode.BLOCK
    allowlist: Tuple[str, ...] = ()
    is_default: bool = True

    @property
    def fetches(self) -> bool:
        """Whether this policy may fetch anything at all.

        ``proxy-fetch`` with an empty allowlist can never allow a URL, so it reports
        ``False`` here and behaves exactly like ``block`` — with its own refusal reason, so
        an operator can tell a misconfiguration apart from a deliberate block.
        """
        if not self.mode.fetches:
            return False
        return bool(self.allowlist) or not self.mode.requires_allowlist

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for an audit detail or a warning payload."""
        return {"mode": self.mode.value, "allowlist": list(self.allowlist)}


#: Applied to a tenant with no stored configuration, and to every failure path.
DEFAULT_POLICY = ExternalRefPolicy()


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def normalize_mode(raw: Any, *, fallback: ExternalRefMode = ExternalRefMode.BLOCK) -> ExternalRefMode:
    """Coerce a stored/submitted mode into an :class:`ExternalRefMode`.

    Accepts the canonical values plus the underscored spelling (``proxy_fetch``), which is
    what a Python identifier or an env var naturally produces. Anything unrecognized —
    including ``None`` — yields ``fallback``, so a typo fails closed rather than silently
    enabling fetching.

    Args:
        raw: The stored or submitted value.
        fallback: Mode applied when ``raw`` is missing or unrecognized.

    Returns:
        The resolved mode.
    """
    text = str(raw or "").strip().lower().replace("_", "-")
    if not text:
        return fallback
    try:
        return ExternalRefMode(text)
    except ValueError:
        logger.warning("unknown external $ref policy mode %r; falling back to %s", raw, fallback.value)
        return fallback


def _normalize_pattern(raw: Any) -> Optional[str]:
    """Normalize one allowlist entry to a bare hostname pattern, or ``None`` to drop it.

    Tolerates the shapes an operator actually pastes — ``https://schemas.acme.com/v1``,
    ``schemas.acme.com:8443``, ``ACME.com.`` — by reducing each to its host part. A pattern
    that survives is lowercase, has no scheme, port, path, or trailing dot, and is either
    ``*``, ``*.<host>``, or a literal host.
    """
    text = str(raw or "").strip().lower()
    if not text:
        return None
    if "://" in text:
        text = urlsplit(text).netloc or ""
    # Drop credentials, a path/query tail, and a port, in that order.
    text = text.split("@")[-1].split("/")[0].split("?")[0].split("#")[0]
    if text.count(":") == 1:
        text = text.split(":")[0]
    text = text.strip().strip(".")
    if not text:
        return None
    if text == "*":
        return "*"
    body = text[2:] if text.startswith("*.") else text
    # A pattern with no label, an interior wildcard, or any character a hostname cannot
    # contain would silently never match, so drop it loudly instead of storing a dud that
    # reads to an operator like a working rule. Non-ASCII letters are allowed through so an
    # internationalized domain stays expressible.
    if not body or not all(ch.isalnum() or ch in "-._" for ch in body):
        logger.warning("dropping unusable external $ref allowlist pattern %r", raw)
        return None
    return f"*.{body}" if text.startswith("*.") else body


def normalize_allowlist(raw: Any) -> Tuple[str, ...]:
    """Normalize a stored allowlist into deduplicated hostname patterns.

    Accepts the JSONB array the tenant row stores, a comma/whitespace-separated string (what
    an env var or a form field yields), or ``None``. Unusable entries are dropped with a
    warning rather than failing the read — a single bad pattern must not take the whole
    policy down to "no allowlist", which in ``inline`` mode would *widen* it.

    Args:
        raw: The stored value (list, string, or ``None``).

    Returns:
        The normalized patterns, in first-seen order with duplicates removed.
    """
    items: Sequence[Any]
    if raw is None:
        items = ()
    elif isinstance(raw, str):
        items = [piece for piece in raw.replace(",", " ").split() if piece]
    elif isinstance(raw, Mapping):
        # A JSON object where an array belongs: unusable, and treating its keys as patterns
        # would be a guess. Fail closed to "no patterns".
        logger.warning("external $ref allowlist is an object, not an array; ignoring it")
        items = ()
    elif isinstance(raw, Sequence):
        items = list(raw)
    else:
        logger.warning("external $ref allowlist has unusable type %s; ignoring it", type(raw).__name__)
        items = ()

    out: List[str] = []
    for item in items:
        pattern = _normalize_pattern(item)
        if pattern and pattern not in out:
            out.append(pattern)
    return tuple(out)


def policy_from_row(row: Optional[Mapping[str, Any]]) -> ExternalRefPolicy:
    """Build a policy from a ``tenants`` row (or ``None`` for the default).

    Args:
        row: A mapping carrying ``repository_external_ref_policy`` and
            ``repository_external_ref_allowlist``; ``None``/empty yields
            :data:`DEFAULT_POLICY`.

    Returns:
        The tenant's policy.
    """
    if not row:
        return DEFAULT_POLICY
    return ExternalRefPolicy(
        mode=normalize_mode(row.get("repository_external_ref_policy")),
        allowlist=normalize_allowlist(row.get("repository_external_ref_allowlist")),
        is_default=False,
    )


def load_tenant_policy(
    tenant_id: Optional[str], *, db: Optional[Any] = None
) -> ExternalRefPolicy:
    """Load the external-``$ref`` policy in force for a tenant.

    Never raises. A missing tenant, an unreadable row, or any store fault degrades to
    :data:`DEFAULT_POLICY` (``block``) — the strict end of the range, so a database problem
    can only ever make the scanner fetch *less*.

    Args:
        tenant_id: The tenant owning the repository being scanned; ``None``/blank yields
            the default.
        db: Database handle to read through; omit to use the process singleton. Callers that
            already hold a handle should pass it, so one scan reads one store.

    Returns:
        The tenant's policy, or :data:`DEFAULT_POLICY`.
    """
    if not tenant_id:
        return DEFAULT_POLICY
    try:
        handle = db
        if handle is None:
            # Lazy import so this module stays importable (and unit-testable) without a
            # database, exactly like ``style_guide_engine`` does.
            from .database import db as default_db

            handle = default_db
        row = handle.get_tenant_external_ref_policy(str(tenant_id))
    except Exception:  # noqa: BLE001 - an unreadable policy must never enable fetching
        logger.warning(
            "could not load the external $ref policy for tenant %s; falling back to block",
            tenant_id,
            exc_info=True,
        )
        return DEFAULT_POLICY
    return policy_from_row(row)


# ---------------------------------------------------------------------------
# Matching + decision
# ---------------------------------------------------------------------------


def hostname_matches(host: str, pattern: str) -> bool:
    """Whether ``host`` satisfies one allowlist ``pattern``.

    Three pattern shapes, all matched case-insensitively and ignoring a trailing dot:

    * ``*`` — any host.
    * ``*.acme.com`` — any subdomain of ``acme.com`` at **any** depth (``a.acme.com``,
      ``a.b.acme.com``), but *not* the apex ``acme.com``. Listing the apex as well is a
      separate entry, so "subdomains only" stays expressible.
    * ``acme.com`` — that host exactly.

    Args:
        host: The URL's hostname.
        pattern: One normalized pattern from :func:`normalize_allowlist`.

    Returns:
        True when the host is covered by the pattern.
    """
    h = str(host or "").strip().lower().strip(".")
    p = str(pattern or "").strip().lower().strip(".")
    if not h or not p:
        return False
    if p == "*":
        return True
    if p.startswith("*."):
        return h.endswith("." + p[2:])
    return h == p


def host_allowed(host: str, allowlist: Sequence[str]) -> bool:
    """Whether ``host`` matches any pattern in ``allowlist`` (empty allowlist: no)."""
    return any(hostname_matches(host, pattern) for pattern in allowlist)


@dataclass(frozen=True)
class ExternalRefDecision:
    """The verdict for one candidate URL under a policy.

    Attributes:
        allowed: Whether the fetch may proceed.
        reason: Stable machine reason — a ``REASON_*`` constant for a refusal, or the
            policy mode's value for an allow.
        detail: Human-readable explanation, safe to surface in a warning or an event.
        host: The URL's hostname, when it had one.
    """

    allowed: bool
    reason: str
    detail: str = ""
    host: str = ""


def decide(url: str, policy: ExternalRefPolicy) -> ExternalRefDecision:
    """Decide whether one external reference URL may be fetched under ``policy``.

    Order of checks — shape first, then policy — so a ``file:`` reference is reported as an
    unsupported scheme regardless of the tenant's mode, rather than being masked by a
    ``block`` verdict that would read as "the tenant turned this off".

    Args:
        url: The absolute URL the reference resolves to (fragment already stripped by the
            resolver, though a fragment here is harmless).
        policy: The tenant's policy.

    Returns:
        The :class:`ExternalRefDecision`. Never raises: an unparseable URL is a refusal.
    """
    try:
        parts = urlsplit(str(url or ""))
    except ValueError:
        return ExternalRefDecision(False, REASON_INVALID_URL, "the reference is not a parseable URL")

    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if scheme and scheme not in _FETCHABLE_SCHEMES:
        return ExternalRefDecision(
            False,
            REASON_UNSUPPORTED_SCHEME,
            f"the scanner never fetches {scheme}: references",
            host,
        )
    if not scheme or not host:
        return ExternalRefDecision(
            False, REASON_INVALID_URL, "the reference has no fetchable http(s) host", host
        )

    if not policy.mode.fetches:
        return ExternalRefDecision(
            False,
            REASON_POLICY_BLOCKED,
            "this tenant's external $ref policy is 'block'; nothing is fetched",
            host,
        )
    if policy.mode.requires_allowlist and not policy.allowlist:
        return ExternalRefDecision(
            False,
            REASON_ALLOWLIST_EMPTY,
            (
                f"policy '{policy.mode.value}' fetches only from allowlisted hosts and this "
                "tenant's allowlist is empty"
            ),
            host,
        )
    if policy.allowlist and not host_allowed(host, policy.allowlist):
        return ExternalRefDecision(
            False,
            REASON_HOST_NOT_ALLOWLISTED,
            f"host {host!r} is not on this tenant's external $ref allowlist",
            host,
        )
    return ExternalRefDecision(
        True, policy.mode.value, f"host {host!r} is permitted by policy '{policy.mode.value}'", host
    )


def build_gate(
    policy: ExternalRefPolicy,
    *,
    resolution_allowed: bool = True,
    on_decision: Optional[Callable[[str, ExternalRefDecision], None]] = None,
) -> Callable[[str], Optional[Tuple[str, str]]]:
    """Build the per-URL gate :func:`app.remote_ref_resolver.resolve_remote_refs` consults.

    The resolver calls the gate before it looks in its cache and before any client exists,
    so a refusal costs nothing and — crucially — a *cached* document cannot bypass the
    policy that a previous, differently-configured tenant paid for.

    Args:
        policy: The tenant's policy.
        resolution_allowed: The deployment kill switch
            (``settings.remote_ref_resolution_allowed``). ``False`` refuses every URL with
            :data:`REASON_RESOLUTION_DISABLED`, whatever the tenant configured.
        on_decision: Optional observer invoked with ``(url, decision)`` for every URL the
            gate judges. Used by the scan wiring to count refusals; an observer that raises
            is logged and ignored so it can never fail a scan.

    Returns:
        A callable ``(url) -> None | (reason, detail)`` — ``None`` allows the fetch, a
        tuple refuses it and becomes the reference's unresolved reason.
    """

    def gate(url: str) -> Optional[Tuple[str, str]]:
        if not resolution_allowed:
            decision = ExternalRefDecision(
                False,
                REASON_RESOLUTION_DISABLED,
                "remote $ref resolution is disabled for this deployment",
                (urlsplit(str(url or "")).hostname or "").lower(),
            )
        else:
            decision = decide(url, policy)
        if on_decision is not None:
            try:
                on_decision(url, decision)
            except Exception:  # noqa: BLE001 - an observer must never fail a scan
                logger.warning("external $ref policy observer failed", exc_info=True)
        return None if decision.allowed else (decision.reason, decision.detail)

    return gate


# ---------------------------------------------------------------------------
# Side effects: the audit row and the file warning
# ---------------------------------------------------------------------------


def record_external_ref_fetched(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    branch: str,
    path: str,
    url: str,
    policy: ExternalRefPolicy,
    digest: Optional[str] = None,
    bytes_fetched: int = 0,
    from_cache: bool = False,
    file_id: Optional[str] = None,
    project_id: Optional[str] = None,
    actor_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Write one :data:`EXTERNAL_REF_FETCHED_ACTION` row to ``apiome.workflow_audit``.

    Written for **every** external reference a fetching mode resolves, including one served
    from the resolver's content cache (``from_cache=True``, ``bytes=0``): the audit answers
    "what external material entered this tenant's model, and from where", and a cached
    document entered it just as surely as a freshly downloaded one.

    Best-effort, like every other writer of this ledger: :meth:`Database.insert_workflow_audit`
    logs and swallows store errors, and this function additionally guards against a missing
    or faulty handle, so an audit problem can never fail the scan it describes.

    Args:
        db: Database handle exposing ``insert_workflow_audit``.
        tenant_id: Owning tenant (audit scope).
        repository_id: The repository whose file carried the reference.
        branch: The branch the file was scanned on.
        path: The repository-relative file path.
        url: The absolute URL that was fetched.
        policy: The policy that permitted the fetch (recorded so a later change of mode does
            not rewrite history).
        digest: SHA-256 content address of the fetched document, when known.
        bytes_fetched: Bytes transferred; ``0`` for a cache hit.
        from_cache: Whether the document came from the resolver's cache.
        file_id: The ``tenant_repository_files`` row id, when known.
        project_id: Catalog project the scan feeds, when known.
        actor_id: The user who triggered the scan, or ``None`` for a background sweep.

    Returns:
        The ``detail`` dict that was recorded (useful for tests and for the caller to log).
    """
    host = (urlsplit(str(url or "")).hostname or "").lower()
    detail: Dict[str, Any] = {
        "repositoryId": str(repository_id or ""),
        "branch": str(branch or ""),
        "path": str(path or ""),
        "url": str(url or ""),
        "host": host,
        "policy": policy.mode.value,
        "allowlist": list(policy.allowlist),
        "cached": bool(from_cache),
        "bytes": int(bytes_fetched or 0),
    }
    if file_id:
        detail["fileId"] = str(file_id)
    if digest:
        detail["digest"] = str(digest)

    try:
        db.insert_workflow_audit(
            str(tenant_id or ""),
            str(project_id) if project_id else None,
            None,
            EXTERNAL_REF_FETCHED_ACTION,
            "success",
            str(actor_id) if actor_id else None,
            detail,
        )
    except Exception:  # noqa: BLE001 - an audit failure must never fail a scan
        logger.warning(
            "could not record %s for %s", EXTERNAL_REF_FETCHED_ACTION, url, exc_info=True
        )
    return detail


def build_warning(
    policy: ExternalRefPolicy,
    unresolved: Sequence[Any],
    *,
    recorded_at: Optional[datetime] = None,
    max_refs: int = MAX_WARNING_REFS,
) -> Optional[Dict[str, Any]]:
    """Build the ``external_ref_warning`` payload for a scanned file.

    ``None`` when nothing is unresolved — which is what clears an existing warning, so a
    file that stops referencing an external schema (or whose tenant switches to ``inline``)
    does not keep a stale warning forever.

    The itemized list is capped at ``max_refs`` entries with ``truncated`` marking the cut;
    ``unresolved_count`` stays exact, so a document with thousands of references reports the
    true number without turning one row into a megabyte of JSONB.

    Args:
        policy: The policy that applied during the scan.
        unresolved: The resolver's :class:`~app.remote_ref_resolver.UnresolvedRef` records
            (any objects exposing ``location``/``ref``/``url``/``reason``/``detail``).
        recorded_at: Timestamp to stamp; defaults to now (UTC).
        max_refs: How many references to itemize.

    Returns:
        The warning payload, or ``None`` when there is nothing to warn about.
    """
    refs = list(unresolved or ())
    if not refs:
        return None
    cap = max(0, int(max_refs))
    stamp = recorded_at or datetime.now(timezone.utc)
    return {
        "policy": policy.mode.value,
        "allowlist": list(policy.allowlist),
        "recorded_at": stamp.astimezone(timezone.utc).isoformat(),
        "unresolved_count": len(refs),
        "truncated": len(refs) > cap,
        "unresolved": [
            {
                "location": str(getattr(ref, "location", "") or ""),
                "ref": str(getattr(ref, "ref", "") or ""),
                "url": str(getattr(ref, "url", "") or ""),
                "reason": str(getattr(ref, "reason", "") or ""),
                "detail": str(getattr(ref, "detail", "") or ""),
            }
            for ref in refs[:cap]
        ],
    }
