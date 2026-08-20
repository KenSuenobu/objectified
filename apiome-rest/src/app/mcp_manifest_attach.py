"""Where a manifest import lands — FMT-1.7 (#5418).

The acceptance criterion this module exists for: *importing a manifest does not create a
duplicate endpoint when one already exists from probing; it attaches as a source of the
same endpoint.*

That is a decision, and decisions about identity are exactly the thing worth keeping out
of a route handler. Everything here is **pure** — it takes the parsed manifest and the
tenant's existing endpoint rows and returns a plan. No database, no network, no clock — so
the rule that decides whether two records are the same server is unit-testable against
plain dict fixtures rather than only reachable through a live catalog.

Two ways one server is recognised, in this order
------------------------------------------------
1. **Same address.** The manifest's ``transport`` block names where the server is reached;
   an existing endpoint is the same server when its ``endpoint_url`` normalizes to the same
   string under :func:`~app.mcp_duplicate_detection.normalize_mcp_endpoint_url_for_dedup`
   — the same canonicalization the duplicate report already uses, so "the same server" means
   one thing across the catalog. This is checked first because an address match holds even
   when the manifest and the probe describe *different* surfaces, which is the interesting
   case: a stale manifest for a server that has since changed still belongs to that server.

2. **Same surface.** Failing that, an endpoint whose current snapshot's
   ``surface_fingerprint`` equals the declared one is the same server. Two servers offering
   a byte-identical surface — same name, version, protocol, tools, schemas, prompts — are
   not plausibly distinct records, and this is the only path available when the manifest
   declares no transport at all.

Nothing else matches. Notably a shared *host* does not: the duplicate report treats that as
an advisory hint precisely because two servers can live on one host, and silently attaching
a manifest to the wrong endpoint would be worse than creating a second one an operator can
merge.

A conflict is not a match failure
---------------------------------
When an address match is found but the surfaces differ, the plan still attaches — to that
endpoint — and records ``surface_conflict``. The disagreement is a fact about the endpoint
that :mod:`app.mcp_surface_provenance` reports; it is not evidence of a different server.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence

from .mcp_duplicate_detection import normalize_mcp_endpoint_url_for_dedup
from .mcp_manifest_parser import McpManifestDocument

__all__ = [
    "MATCH_ADDRESS",
    "MATCH_NONE",
    "MATCH_SURFACE",
    "ManifestAttachPlan",
    "ManifestTarget",
    "ManifestTargetError",
    "plan_manifest_attach",
    "resolve_manifest_target",
    "slugify_endpoint_name",
]

#: The existing endpoint was recognised by its normalized address.
MATCH_ADDRESS = "address"

#: The existing endpoint was recognised because its current surface fingerprint equals the
#: declared one.
MATCH_SURFACE = "surface"

#: No existing endpoint matched; the import creates one.
MATCH_NONE = "none"

#: How an endpoint created by a manifest import records its origin (the V148
#: ``mcp_endpoints.added_via`` domain).
ADDED_VIA_IMPORT = "import"


class ManifestTargetError(ValueError):
    """The manifest does not say — and the caller did not supply — where the server lives."""


@dataclass(frozen=True)
class ManifestTarget:
    """The address a manifest import is about.

    Attributes:
        endpoint_url: The catalog ``endpoint_url`` (a URL, or a stdio command line).
        transport: The catalog transport (``streamable_http`` / ``sse`` / ``stdio``).
        name: Proposed display name for a newly created endpoint.
        slug: Proposed slug for a newly created endpoint (uniquified by the DB layer).
        declared_fingerprint: The declared surface's fingerprint.
    """

    endpoint_url: str
    transport: str
    name: str
    slug: str
    declared_fingerprint: str

    @property
    def normalized_url(self) -> str:
        """The endpoint URL as duplicate detection canonicalizes it."""
        return normalize_mcp_endpoint_url_for_dedup(
            self.endpoint_url, transport=self.transport
        )


@dataclass(frozen=True)
class ManifestAttachPlan:
    """What a manifest import should do.

    Attributes:
        endpoint_id: The existing endpoint to attach to, or ``None`` when one must be
            created.
        match: Why that endpoint was chosen — :data:`MATCH_ADDRESS`,
            :data:`MATCH_SURFACE`, or :data:`MATCH_NONE`.
        created: ``True`` when the plan requires creating an endpoint.
        surface_conflict: ``True`` when an existing endpoint was matched but its observed
            surface fingerprint differs from the declared one.
        observed_fingerprint: The matched endpoint's current surface fingerprint, when it
            has one.
        reason: One sentence a reader can act on, surfaced by the REST response.
    """

    endpoint_id: Optional[str]
    match: str
    created: bool
    surface_conflict: bool = False
    observed_fingerprint: Optional[str] = None
    reason: str = ""


def slugify_endpoint_name(name: str) -> str:
    """Derive a URL-safe catalog slug from a server name.

    Mirrors the manual registration route's rule (lowercase, runs of non-alphanumerics
    collapse to one hyphen, trimmed) so a manifest-created endpoint and a hand-registered
    one slug identically.

    Args:
        name: The proposed display name.

    Returns:
        The slug, or ``"endpoint"`` when the name has no slug-able characters.
    """
    slug: list[str] = []
    for char in name.strip().lower():
        if char.isalnum() and char.isascii():
            slug.append(char)
        elif slug and slug[-1] != "-":
            slug.append("-")
    return "".join(slug).strip("-") or "endpoint"


def resolve_manifest_target(
    document: McpManifestDocument,
    declared_fingerprint: str,
    *,
    endpoint_url: Optional[str] = None,
    transport: Optional[str] = None,
) -> ManifestTarget:
    """Work out which address a manifest import is about.

    An explicit caller-supplied address always wins: a manifest may carry no ``transport``
    block at all, or may name the address the server has in *its* network rather than the
    one this catalog reaches it by.

    Args:
        document: The parsed manifest.
        declared_fingerprint: The declared surface's fingerprint.
        endpoint_url: Caller-supplied endpoint URL, overriding the manifest's.
        transport: Caller-supplied transport, overriding the manifest's.

    Returns:
        The resolved :class:`ManifestTarget`.

    Raises:
        ManifestTargetError: When neither the caller nor the manifest names an address.
            Deliberately an error rather than a synthesized placeholder: an endpoint whose
            URL Apiome invented is one nobody can ever discover against.
    """
    supplied_url = (endpoint_url or "").strip()
    resolved_url = supplied_url or document.transport.endpoint_target()
    if not resolved_url:
        raise ManifestTargetError(
            "The manifest declares no `transport` block, so it does not say where this "
            "server is reached. Supply an endpoint_url with the import."
        )

    resolved_transport = (transport or "").strip()
    if not resolved_transport and not supplied_url:
        # Only trust the manifest's transport for the manifest's own address. A caller who
        # redirected the import to a different address may well have changed how the server is
        # reached — pairing their URL with the manifest's `stdio` would catalog an endpoint
        # nothing could ever discover against.
        resolved_transport = document.transport.kind or ""
    if not resolved_transport:
        # An address with a scheme is reached over HTTP; `streamable_http` is the transport
        # every catalogued URL endpoint uses. Anything else is a command line.
        resolved_transport = "streamable_http" if "://" in resolved_url else "stdio"

    name = document.server_info.title or document.server_info.name or document.title
    return ManifestTarget(
        endpoint_url=resolved_url,
        transport=resolved_transport,
        name=name,
        slug=slugify_endpoint_name(name),
        declared_fingerprint=declared_fingerprint,
    )


def plan_manifest_attach(
    target: ManifestTarget,
    endpoints: Sequence[Mapping[str, Any]],
    *,
    observed_fingerprints: Optional[Mapping[str, Optional[str]]] = None,
) -> ManifestAttachPlan:
    """Decide whether a manifest attaches to an existing endpoint or creates one.

    Args:
        target: The resolved address the manifest is about.
        endpoints: The tenant's live ``mcp_endpoints`` rows (needs ``id``,
            ``endpoint_url``, ``transport``).
        observed_fingerprints: Endpoint id → that endpoint's current
            ``surface_fingerprint``, for the surface-match rule and for conflict
            reporting. A missing or ``None`` entry means the endpoint has never been
            discovered, which is not a conflict — it is an absence.

    Returns:
        The :class:`ManifestAttachPlan`.
    """
    fingerprints: Dict[str, Optional[str]] = dict(observed_fingerprints or {})
    normalized_target = target.normalized_url

    for row in endpoints:
        endpoint_id = str(row.get("id") or "")
        if not endpoint_id:
            continue
        candidate = normalize_mcp_endpoint_url_for_dedup(
            str(row.get("endpoint_url") or ""),
            transport=str(row.get("transport") or "") or None,
        )
        if candidate and candidate == normalized_target:
            return _attach_plan(endpoint_id, target, fingerprints.get(endpoint_id), MATCH_ADDRESS)

    for row in endpoints:
        endpoint_id = str(row.get("id") or "")
        if not endpoint_id:
            continue
        observed = fingerprints.get(endpoint_id)
        if observed and observed == target.declared_fingerprint:
            return _attach_plan(endpoint_id, target, observed, MATCH_SURFACE)

    return ManifestAttachPlan(
        endpoint_id=None,
        match=MATCH_NONE,
        created=True,
        reason=(
            f"No catalogued endpoint matched {target.endpoint_url!r} by address or by "
            "declared surface, so the manifest registered a new one."
        ),
    )


def _attach_plan(
    endpoint_id: str,
    target: ManifestTarget,
    observed_fingerprint: Optional[str],
    match: str,
) -> ManifestAttachPlan:
    """Build the plan for attaching to an already-catalogued endpoint.

    Args:
        endpoint_id: The matched endpoint.
        target: The resolved address.
        observed_fingerprint: That endpoint's current surface fingerprint, if any.
        match: :data:`MATCH_ADDRESS` or :data:`MATCH_SURFACE`.

    Returns:
        The :class:`ManifestAttachPlan`, flagging a surface conflict when the endpoint has
        been discovered and its observed surface differs from the declared one.
    """
    conflict = bool(observed_fingerprint) and observed_fingerprint != target.declared_fingerprint
    if match == MATCH_SURFACE:
        reason = (
            "An existing endpoint already declares this exact surface fingerprint, so the "
            "manifest attached to it rather than creating a second record."
        )
    elif conflict:
        reason = (
            f"An endpoint at {target.endpoint_url!r} is already catalogued; the manifest "
            "attached to it. Its declared surface differs from the last observed one — the "
            "detail view attributes each fact to its source."
        )
    else:
        reason = (
            f"An endpoint at {target.endpoint_url!r} is already catalogued, so the manifest "
            "attached to it as a declared source."
        )
    return ManifestAttachPlan(
        endpoint_id=endpoint_id,
        match=match,
        created=False,
        surface_conflict=conflict,
        observed_fingerprint=observed_fingerprint,
        reason=reason,
    )
