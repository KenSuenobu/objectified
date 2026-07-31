"""SSRF-guarded remote ``$ref`` resolver — MFI-29.4 (#4391).

Several description formats reference definitions that live in *other documents*: an
AsyncAPI service points at a shared message library, a JSON Schema bundle splits its
``$defs`` across files. When those references are URLs, the adapters cannot follow them —
``@asyncapi/parser`` dereferences **in-document** ``$ref``\\s only, and the JSON Schema
adapter parses a single mapping — so the imported model silently loses everything behind
the reference. Fetching them naively, on the other hand, turns every import into an SSRF
primitive: a tenant-supplied document would make the service fetch
``http://169.254.169.254/…`` on its behalf.

This module is the one shared resolver both problems go through. It is deliberately a
*service*, not an adapter feature: the pipeline runs it over the intake documents before
:meth:`~app.import_source.ImportSource.parse`, so a format opts in with a single class flag
(:attr:`~app.import_source.ImportSource.supports_remote_refs`) and every format gets the
same guard, the same budgets, the same cache, and the same findings.

What it guarantees:

* **Every fetch passes the SSRF guard.** A URL's shape is checked with
  :func:`app.ssrf_guard.validate_url_policy` before any request is made (no ``file:``,
  ``data:``, or ``user:pass@`` reference ever reaches a client), and the fetch itself runs
  on :func:`app.ssrf_guard.build_guarded_client`, whose request hook applies the full
  policy — including the resolved-address check — to **every hop**, so a public URL that
  302s to an internal address is refused mid-chain.
* **Budgets terminate a hostile ref-chain.** A run is bounded by a maximum number of
  resolved references, a maximum nesting depth, a total byte ceiling across all fetches,
  a per-fetch timeout, and an overall wall-clock deadline (:class:`RemoteRefBudget`).
  Hitting any bound stops resolution — it never raises: the remaining references stay in
  place and are reported as unresolved, so a hostile document degrades the import instead
  of failing the service.
* **A re-import does not re-fetch.** Fetched documents live in a bounded,
  content-addressed cache (:class:`RemoteRefCache`): a URL maps to the SHA-256 of its
  bytes, and the parsed document is stored under that digest, so two URLs serving the same
  content share one entry and a second import of the same document is a cache hit.
* **A caller may narrow what is fetchable, never widen it.** An optional per-URL gate
  (:data:`RefGate`) is consulted before the cache and before any client exists, so a caller
  can refuse a URL on its own grounds — REPO-3.9's tenant external-``$ref`` policy plugs in
  there — and a cached document can never slip past it. Everything a gate allows still goes
  through the SSRF guard unchanged. A companion observer (:data:`FetchObserver`) reports
  every document obtained, so a caller can audit what entered the model.
* **Resolution is opt-in and reported either way.** With resolution off (the default) the
  document is untouched and every external reference is reported as a finding
  (:data:`app.intake_lint_rules.RULE_UNRESOLVED_EXTERNAL_REF`) so the user can see exactly
  what the model is missing; with it on, whatever could not be resolved is reported the
  same way, plus :data:`~app.intake_lint_rules.RULE_BLOCKED_EXTERNAL_REF` for anything the
  SSRF guard refused.

Resolution rewrites the document in place of the ``$ref`` node, before the adapter parses
it — and therefore before normalization and fingerprinting, so a fully resolved import
fingerprints as the complete model it actually describes. The *persisted* source is
unaffected: the pipeline keeps the original bytes verbatim (MFI-23.9) and only feeds the
resolved documents to :meth:`~app.import_source.ImportSource.parse`.

**Scope of what counts as remote.** Only absolute ``http``/``https`` references are
resolved from a root document. A relative reference (``./messages.yaml#/Signup``) is a
*fileset* concern (MFI-29.2 bundles those from archive/git members) and is left untouched,
as is an in-document fragment (``#/components/…``), which every adapter dereferences
itself. Inside a **fetched** document both are meaningful again — a relative reference
resolves against the URL it came from, and a fragment addresses that document — so both
are followed there. A reference naming a scheme this service refuses to fetch (``file:``,
``data:``, ``ftp:`` …) is reported as blocked rather than ignored, while a purely
*identifying* scheme (``urn:``, ``tag:``, ``mailto:``) is left alone — nothing is fetchable
there and it is a legitimate JSON Schema identifier.
"""

from __future__ import annotations

import copy
import hashlib
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urljoin, urlsplit

import httpx

from .config import settings
from .intake_lint_rules import (
    RULE_BLOCKED_EXTERNAL_REF,
    RULE_UNRESOLVED_EXTERNAL_REF,
)
from .ssrf_guard import SSRFError, build_guarded_client, validate_url_policy

logger = logging.getLogger(__name__)

__all__ = [
    "REASON_BLOCKED",
    "REASON_BUDGET_DEPTH",
    "REASON_BUDGET_BYTES",
    "REASON_BUDGET_REFS",
    "REASON_BUDGET_TIME",
    "REASON_CIRCULAR",
    "REASON_DISABLED",
    "REASON_FETCH_FAILED",
    "REASON_POINTER_NOT_FOUND",
    "REASON_UNPARSEABLE",
    "ExternalRef",
    "FetchObserver",
    "RefGate",
    "RemoteRefBudget",
    "RemoteRefCache",
    "RemoteRefOutcome",
    "ResolvedRef",
    "UnresolvedRef",
    "default_cache",
    "resolve_remote_refs",
    "scan_external_refs",
]


# ---------------------------------------------------------------------------
# Reasons a reference was not inlined (stable strings; they reach the summary)
# ---------------------------------------------------------------------------

#: Remote resolution was not enabled for this import (the default).
REASON_DISABLED = "resolution-disabled"
#: The SSRF guard refused the URL (non-public address or disallowed scheme).
REASON_BLOCKED = "blocked-by-ssrf-guard"
#: The request failed (connection error, timeout, non-2xx status).
REASON_FETCH_FAILED = "fetch-failed"
#: The fetched document is not parseable JSON/YAML, or breached an intake limit.
REASON_UNPARSEABLE = "unparseable-document"
#: The fetched document does not contain the referenced JSON pointer.
REASON_POINTER_NOT_FOUND = "pointer-not-found"
#: The reference chain revisits a reference already being resolved.
REASON_CIRCULAR = "circular-reference"
#: The per-import maximum number of resolved references was reached.
REASON_BUDGET_REFS = "budget-exhausted-refs"
#: The maximum nesting depth of chained remote references was reached.
REASON_BUDGET_DEPTH = "budget-exhausted-depth"
#: The total fetched-bytes ceiling for the import was reached.
REASON_BUDGET_BYTES = "budget-exhausted-bytes"
#: The wall-clock deadline for the whole resolution was reached.
REASON_BUDGET_TIME = "budget-exhausted-time"

#: The reasons that mean "a budget stopped us", so a caller can tell a hostile or oversized
#: ref-chain apart from a document that merely points somewhere unreachable.
_BUDGET_REASONS = frozenset(
    {REASON_BUDGET_REFS, REASON_BUDGET_DEPTH, REASON_BUDGET_BYTES, REASON_BUDGET_TIME}
)

#: Cap on how many individual references are itemized in the job summary and how many lint
#: findings are emitted. A document with thousands of external references would otherwise
#: bury the report; the counts stay exact and a single roll-up finding covers the remainder.
_MAX_REPORTED_REFS = 25

#: Schemes that name something fetchable (or locally readable) which this service refuses to
#: fetch. A reference using one is reported as blocked rather than ignored, because it is an
#: attempt to make the server read something it must not — ``file:///etc/passwd`` most of all.
#: Schemes that merely *identify* (``urn:``, ``tag:``, ``mailto:``) are not listed: they are
#: legitimate JSON Schema identifiers and nothing is ever fetched for them.
_REFUSED_SCHEMES = frozenset(
    {
        "file",
        "ftp",
        "ftps",
        "sftp",
        "tftp",
        "data",
        "gopher",
        "ldap",
        "ldaps",
        "dict",
        "jar",
        "netdoc",
        "ws",
        "wss",
    }
)

_USER_AGENT = "Apiome-RemoteRefResolver/1.0"
_ACCEPT = "application/json, application/schema+json, application/yaml, text/yaml;q=0.9, */*;q=0.5"


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RemoteRefBudget:
    """Per-import ceilings that bound one resolution run.

    Attributes:
        max_refs: Maximum number of references inlined in one import. Reaching it stops
            resolution; the rest are reported unresolved.
        max_depth: Maximum nesting depth of chained remote references (a reference inside a
            fetched document is depth 2). Bounds a ref-chain that never terminates.
        max_bytes: Total ceiling, in bytes, across every document fetched for one import.
        fetch_timeout_seconds: Per-request timeout (connect + read).
        total_timeout_seconds: Wall-clock deadline for the whole resolution run, so many
            individually fast fetches still cannot stall an import.
    """

    max_refs: int = 50
    max_depth: int = 5
    max_bytes: int = 4 * 1024 * 1024
    fetch_timeout_seconds: float = 5.0
    total_timeout_seconds: float = 15.0

    @classmethod
    def from_settings(cls) -> "RemoteRefBudget":
        """Build the budget from deployment settings (``APIOME_REMOTE_REF_*``)."""
        return cls(
            max_refs=max(0, int(settings.remote_ref_max_refs)),
            max_depth=max(1, int(settings.remote_ref_max_depth)),
            max_bytes=max(0, int(settings.remote_ref_max_bytes)),
            fetch_timeout_seconds=max(0.1, float(settings.remote_ref_fetch_timeout_seconds)),
            total_timeout_seconds=max(0.1, float(settings.remote_ref_total_timeout_seconds)),
        )


# ---------------------------------------------------------------------------
# Reference records
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExternalRef:
    """One external ``$ref`` occurrence found in an intake document.

    Attributes:
        location: Where the reference sits, as ``[<document>]#<json-pointer>`` — the
            document label is omitted for a single-document intake.
        ref: The raw ``$ref`` string as written in the document.
        url: The absolute URL the reference resolves to (fragment stripped).
    """

    location: str
    ref: str
    url: str


@dataclass(frozen=True)
class ResolvedRef:
    """One reference that was fetched and inlined.

    Attributes:
        location: Where the reference sat (see :attr:`ExternalRef.location`).
        url: The absolute URL that was fetched (fragment stripped).
        digest: SHA-256 of the fetched bytes — the cache's content address.
        bytes_fetched: Size of the fetched document, ``0`` for a cache hit.
        from_cache: Whether the document came from the cache instead of the network.
    """

    location: str
    url: str
    digest: str
    bytes_fetched: int
    from_cache: bool

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for the job summary."""
        return {
            "location": self.location,
            "url": self.url,
            "digest": self.digest,
            "bytes": self.bytes_fetched,
            "cached": self.from_cache,
        }


@dataclass(frozen=True)
class UnresolvedRef:
    """One reference that was left in place, and why.

    Attributes:
        location: Where the reference sits (see :attr:`ExternalRef.location`).
        ref: The raw ``$ref`` string.
        url: The absolute URL it points at.
        reason: One of the ``REASON_*`` constants, or — for a gate refusal — the reason the
            caller's gate supplied (see :data:`RefGate`).
        detail: Human-readable detail (an error message, a bound that was hit).
        gate_refused: Whether the caller's policy gate refused the URL, rather than the
            reference failing for a completeness reason. Set by the resolver, never by a
            caller.
    """

    location: str
    ref: str
    url: str
    reason: str
    detail: str = ""
    gate_refused: bool = False

    @property
    def blocked(self) -> bool:
        """Whether a security policy refused this reference.

        Covers both refusals: the SSRF guard's, and the caller's gate (REPO-3.9's
        tenant external-``$ref`` policy). Both mean "nothing was fetched from this URL
        on purpose", which is a different signal from "we tried and could not".
        """
        return self.reason == REASON_BLOCKED or self.gate_refused

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for the job summary."""
        return {
            "location": self.location,
            "ref": self.ref,
            "url": self.url,
            "reason": self.reason,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class RemoteRefOutcome:
    """The result of one resolution run over an import's documents.

    Attributes:
        enabled: Whether resolution was requested (``False`` = scan-and-report only).
        documents: Label → document, rewritten where references were inlined. A document
            with nothing to inline is the same object that was passed in.
        resolved: Every reference that was inlined, sorted for determinism.
        unresolved: Every reference left in place, sorted for determinism.
        fetched_bytes: Total bytes fetched from the network (cache hits excluded).
        cache_hits: How many fetches were served from the cache.
        changed_documents: Labels of the documents that were rewritten.
    """

    enabled: bool
    documents: Dict[str, Any]
    resolved: Tuple[ResolvedRef, ...] = ()
    unresolved: Tuple[UnresolvedRef, ...] = ()
    fetched_bytes: int = 0
    cache_hits: int = 0
    changed_documents: Tuple[str, ...] = ()

    @property
    def budget_exhausted(self) -> bool:
        """Whether a budget stopped the walk (a hostile or oversized ref-chain)."""
        return any(ref.reason in _BUDGET_REASONS for ref in self.unresolved)

    @property
    def blocked(self) -> Tuple[UnresolvedRef, ...]:
        """Every reference the SSRF guard refused."""
        return tuple(ref for ref in self.unresolved if ref.blocked)

    def report(self) -> Dict[str, Any]:
        """Build the deterministic ``remote_refs`` block for the job summary.

        Counts are exact; the itemized lists are capped at :data:`_MAX_REPORTED_REFS`
        entries (with ``refs_truncated`` / ``resolved_truncated`` marking the cut) so a
        document with thousands of references cannot bloat a status payload.
        """
        return {
            "enabled": self.enabled,
            "resolved": len(self.resolved),
            "unresolved": len(self.unresolved),
            "blocked": len(self.blocked),
            "budget_exhausted": self.budget_exhausted,
            "fetched_bytes": self.fetched_bytes,
            "cache_hits": self.cache_hits,
            "refs": [ref.as_dict() for ref in self.unresolved[:_MAX_REPORTED_REFS]],
            "refs_truncated": len(self.unresolved) > _MAX_REPORTED_REFS,
            "resolved_refs": [ref.as_dict() for ref in self.resolved[:_MAX_REPORTED_REFS]],
            "resolved_truncated": len(self.resolved) > _MAX_REPORTED_REFS,
        }

    def findings(self) -> List[Any]:
        """Build the intake lint findings for every unresolved reference.

        Returns SPI :class:`app.import_source.LintFinding` objects (imported lazily so this
        module stays off the SPI's import path): one finding per unresolved reference up to
        :data:`_MAX_REPORTED_REFS`, then a single roll-up finding covering the remainder, so
        a pathological document cannot flood the lint report.
        """
        from .import_source import LintFinding

        findings: List[Any] = []
        for ref in self.unresolved[:_MAX_REPORTED_REFS]:
            rule = RULE_BLOCKED_EXTERNAL_REF if ref.blocked else RULE_UNRESOLVED_EXTERNAL_REF
            detail = f" ({ref.detail})" if ref.detail else ""
            findings.append(
                LintFinding(
                    path=ref.location,
                    rule=rule,
                    severity="warning",
                    category="structure",
                    message=(
                        f"External $ref {ref.ref!r} was not resolved: {ref.reason}{detail}. "
                        "The definitions it names are missing from the imported model."
                    ),
                )
            )
        remainder = len(self.unresolved) - _MAX_REPORTED_REFS
        if remainder > 0:
            findings.append(
                LintFinding(
                    path="#",
                    rule=RULE_UNRESOLVED_EXTERNAL_REF,
                    severity="warning",
                    category="structure",
                    message=(
                        f"{remainder} further external $ref(s) were not resolved; see the "
                        "import summary for the full tally."
                    ),
                )
            )
        return findings


# ---------------------------------------------------------------------------
# Content-addressed cache
# ---------------------------------------------------------------------------


@dataclass
class _CacheEntry:
    """One cached document: its content digest, parsed value, and insertion time."""

    digest: str
    document: Any
    size: int
    stored_at: float


class RemoteRefCache:
    """Bounded, content-addressed cache of fetched reference documents.

    A URL maps to the SHA-256 digest of the bytes it served, and the *parsed* document is
    stored under that digest — so two URLs serving identical content share one parsed
    document, and re-importing the same source is a cache hit rather than a re-fetch.

    Bounded three ways so a long-lived process cannot grow without limit: a maximum number
    of URLs (evicted least-recently-used), a total byte ceiling, and a per-entry TTL after
    which a document is re-fetched (a remote schema library is not immutable).

    One instance is shared process-wide, and a caller may drive the pipeline from a worker
    thread, so every mutation is taken under a lock — cheap next to a network fetch, and it
    keeps a concurrent eviction from corrupting the LRU index.
    """

    def __init__(
        self,
        *,
        max_entries: int = 64,
        max_bytes: int = 16 * 1024 * 1024,
        ttl_seconds: float = 900.0,
    ) -> None:
        self._max_entries = max(1, max_entries)
        self._max_bytes = max(1, max_bytes)
        self._ttl_seconds = max(0.0, ttl_seconds)
        # URL → digest, in least-recently-used order; digest → entry.
        self._urls: "OrderedDict[str, str]" = OrderedDict()
        self._entries: Dict[str, _CacheEntry] = {}
        self._bytes = 0
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls) -> "RemoteRefCache":
        """Build a cache sized from deployment settings."""
        return cls(
            max_entries=int(settings.remote_ref_cache_max_entries),
            max_bytes=int(settings.remote_ref_cache_max_bytes),
            ttl_seconds=float(settings.remote_ref_cache_ttl_seconds),
        )

    def get(self, url: str) -> Optional[Tuple[str, Any]]:
        """Return ``(digest, document)`` for ``url``, or ``None`` on a miss/expiry."""
        with self._lock:
            return self._get_locked(url)

    def _get_locked(self, url: str) -> Optional[Tuple[str, Any]]:
        """The body of :meth:`get`, with the lock already held."""
        digest = self._urls.get(url)
        if digest is None:
            return None
        entry = self._entries.get(digest)
        if entry is None:  # pragma: no cover - index and store are updated together
            self._urls.pop(url, None)
            return None
        if self._ttl_seconds and (time.monotonic() - entry.stored_at) > self._ttl_seconds:
            self._forget(url)
            return None
        self._urls.move_to_end(url)
        return entry.digest, entry.document

    def put(self, url: str, content: bytes, document: Any) -> str:
        """Store ``document`` under the digest of ``content`` and index ``url`` to it.

        Returns:
            The SHA-256 hex digest the document is addressed by.
        """
        digest = hashlib.sha256(content).hexdigest()
        with self._lock:
            return self._put_locked(url, digest, content, document)

    def _put_locked(self, url: str, digest: str, content: bytes, document: Any) -> str:
        """The body of :meth:`put`, with the lock already held."""
        existing = self._entries.get(digest)
        if existing is None:
            self._entries[digest] = _CacheEntry(
                digest=digest,
                document=document,
                size=len(content),
                stored_at=time.monotonic(),
            )
            self._bytes += len(content)
        # Re-indexing a URL onto a new digest must release the old entry's bytes.
        previous = self._urls.get(url)
        if previous is not None and previous != digest:
            self._release(previous, keep_urls=(url,))
        self._urls[url] = digest
        self._urls.move_to_end(url)
        self._evict()
        return digest

    def clear(self) -> None:
        """Drop every entry (used by tests and by an operator-triggered reset)."""
        with self._lock:
            self._urls.clear()
            self._entries.clear()
            self._bytes = 0

    def __len__(self) -> int:
        """Number of cached URLs (not distinct documents)."""
        with self._lock:
            return len(self._urls)

    def _forget(self, url: str) -> None:
        """Drop one URL and, when it was the last reference, its document."""
        digest = self._urls.pop(url, None)
        if digest is not None:
            self._release(digest)

    def _release(self, digest: str, *, keep_urls: Sequence[str] = ()) -> None:
        """Drop the document at ``digest`` when no remaining URL points at it."""
        if any(d == digest and u not in keep_urls for u, d in self._urls.items()):
            return
        entry = self._entries.pop(digest, None)
        if entry is not None:
            self._bytes -= entry.size

    def _evict(self) -> None:
        """Evict least-recently-used URLs until both bounds are satisfied."""
        while self._urls and (len(self._urls) > self._max_entries or self._bytes > self._max_bytes):
            oldest = next(iter(self._urls))
            self._forget(oldest)


#: Process-wide cache, so a re-import (or a second document referencing the same library)
#: does not re-fetch. Bounded and TTL'd; :meth:`RemoteRefCache.clear` resets it.
_DEFAULT_CACHE: Optional[RemoteRefCache] = None


def default_cache() -> RemoteRefCache:
    """Return the process-wide reference cache, building it on first use."""
    global _DEFAULT_CACHE
    if _DEFAULT_CACHE is None:
        _DEFAULT_CACHE = RemoteRefCache.from_settings()
    return _DEFAULT_CACHE


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

#: A fetcher takes an already-guard-validated URL plus the remaining byte allowance and
#: returns the raw bytes. Tests substitute a callable; production uses :func:`_http_fetch`.
RefFetcher = Callable[..., bytes]

#: A gate decides, per URL, whether this run may fetch it *at all* — the hook the REPO-3.9
#: tenant external-``$ref`` policy plugs into. It returns ``None`` to allow the fetch, or
#: ``(reason, detail)`` to refuse it, which becomes the reference's unresolved record. The
#: resolver consults it before the cache and before any HTTP client exists, so a refusal
#: costs nothing and a cached document cannot slip past a policy. A gate can only ever
#: *narrow* what is fetched: the SSRF guard still runs on everything it allows.
RefGate = Callable[[str], Optional[Tuple[str, str]]]

#: Observer invoked once per reference document a run obtains — freshly fetched or served
#: from the cache — as ``(url, digest, bytes_fetched, from_cache)``. Used to write the
#: REPO-3.9 ``repository.external_ref_fetched`` audit rows. Exceptions it raises are logged
#: and swallowed: observation must never fail a resolution.
FetchObserver = Callable[[str, str, int, bool], None]


class _FetchError(Exception):
    """Internal: a reference could not be resolved, with its reason and detail."""

    def __init__(self, reason: str, detail: str) -> None:
        self.reason = reason
        self.detail = detail
        super().__init__(detail)


class _GateRefusalError(_FetchError):
    """Internal: the caller's :data:`RefGate` refused this URL.

    A subclass rather than a flag so the recorded :class:`UnresolvedRef` can be marked
    ``gate_refused`` — a deliberate policy refusal, not a failure to reach something — while
    still travelling the one ``_FetchError`` path every other reason uses.
    """


def _http_fetch(url: str, *, max_bytes: int, timeout: float) -> bytes:
    """Fetch ``url`` over the SSRF-guarded client, streaming under a byte ceiling.

    The response is streamed rather than buffered so a hostile endpoint advertising (or
    simply serving) a huge body is cut off at ``max_bytes`` instead of being read into
    memory. Every hop — including redirects — is re-validated by the guard's request hook.

    Args:
        url: The absolute http/https URL to fetch.
        max_bytes: Remaining byte allowance for this import; exceeding it fails the fetch.
        timeout: Per-request timeout in seconds.

    Returns:
        The response body bytes.

    Raises:
        SSRFError: If the guard refuses the URL or any redirect hop.
        _FetchError: On a non-2xx status, a transport error, or an oversized body.
    """
    client = build_guarded_client(
        timeout=httpx.Timeout(timeout, connect=min(timeout, 5.0)),
        follow_redirects=True,
        headers={"user-agent": _USER_AGENT, "accept": _ACCEPT},
    )
    try:
        with client.stream("GET", url) as response:
            if response.status_code >= 400:
                raise _FetchError(
                    REASON_FETCH_FAILED, f"HTTP {response.status_code} from {url}"
                )
            chunks: List[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise _FetchError(
                        REASON_BUDGET_BYTES,
                        f"response from {url} exceeds the remaining {max_bytes}-byte budget",
                    )
                chunks.append(chunk)
        return b"".join(chunks)
    except SSRFError:
        raise
    except _FetchError:
        raise
    except httpx.HTTPError as exc:
        raise _FetchError(REASON_FETCH_FAILED, f"{type(exc).__name__}: {exc}") from exc
    finally:
        client.close()


# ---------------------------------------------------------------------------
# Reference discovery
# ---------------------------------------------------------------------------


def _escape_token(token: str) -> str:
    """Escape one JSON Pointer token (RFC 6901)."""
    return str(token).replace("~", "~0").replace("/", "~1")


def _location(label: str, pointer: str) -> str:
    """Format a finding location as ``[<document>]#<json-pointer>``."""
    prefix = f"{label}" if label else ""
    return f"{prefix}#{pointer}" if prefix else f"#{pointer or ''}"


def _split_ref(ref: str) -> Tuple[str, str]:
    """Split a ``$ref`` into ``(document-part, fragment)`` (the fragment keeps no ``#``)."""
    if "#" in ref:
        head, fragment = ref.split("#", 1)
        return head, fragment
    return ref, ""


def _absolute_url(ref_head: str, base_url: Optional[str]) -> Optional[str]:
    """Return the absolute URL ``ref_head`` names, or ``None`` when it is local.

    A reference is remote when it is already an absolute http/https URL, or when it is
    relative *and* we are inside a fetched document (``base_url`` set), in which case it is
    resolved against that document's URL. A fragment-only reference inside a fetched
    document addresses that document itself. Everything else — relative references and
    fragments in a root intake document — is local and left to the adapter/fileset bundler.

    A reference naming a scheme this service refuses to fetch (:data:`_REFUSED_SCHEMES`)
    is also returned, so the guard's refusal is *reported* rather than silently ignored. A
    non-locating scheme (``urn:``, ``tag:``, ``mailto:``) is neither fetchable nor a threat —
    it is a legitimate identifier in JSON Schema — so it is treated as local and left alone.
    """
    if not ref_head:
        return base_url if base_url else None
    scheme = urlsplit(ref_head).scheme.lower()
    if scheme in ("http", "https") or scheme in _REFUSED_SCHEMES:
        return ref_head
    if scheme:
        return None
    if base_url:
        return urljoin(base_url, ref_head)
    return None


def _iter_refs(
    value: Any,
    *,
    label: str,
    pointer: str,
    base_url: Optional[str],
) -> Iterator[Tuple[str, str, str]]:
    """Yield ``(location, ref, url)`` for every remote ``$ref`` under ``value``."""
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str) and ref:
            head, _fragment = _split_ref(ref)
            url = _absolute_url(head, base_url)
            if url:
                yield _location(label, pointer), ref, url
        for key, item in value.items():
            yield from _iter_refs(
                item,
                label=label,
                pointer=f"{pointer}/{_escape_token(key)}",
                base_url=base_url,
            )
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _iter_refs(
                item, label=label, pointer=f"{pointer}/{index}", base_url=base_url
            )


def scan_external_refs(documents: Mapping[str, Any]) -> List[ExternalRef]:
    """List every external ``$ref`` in ``documents`` without fetching anything.

    This is what the **disabled** path reports: the exact set of definitions the imported
    model is missing. Pure and side-effect free.

    Args:
        documents: Label → parsed document (use ``""`` as the label for a single-document
            intake; a fileset passes its member paths).

    Returns:
        The external references, sorted by location for a deterministic report.
    """
    refs: List[ExternalRef] = []
    for label in sorted(documents):
        for location, ref, url in _iter_refs(
            documents[label], label=label, pointer="", base_url=None
        ):
            refs.append(ExternalRef(location=location, ref=ref, url=url))
    return sorted(refs, key=lambda r: (r.location, r.ref))


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def _json_pointer_get(document: Any, fragment: str) -> Any:
    """Follow an RFC 6901 JSON Pointer fragment into ``document``.

    Args:
        document: The parsed document to walk.
        fragment: The fragment with no leading ``#`` (``""`` addresses the whole document).

    Raises:
        _FetchError: If the pointer does not address a node in ``document``.
    """
    pointer = fragment[1:] if fragment.startswith("/") else fragment
    if not fragment or fragment == "/":
        return document
    if not fragment.startswith("/"):
        raise _FetchError(
            REASON_POINTER_NOT_FOUND, f"unsupported non-pointer fragment '#{fragment}'"
        )
    current = document
    for raw_token in pointer.split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                raise _FetchError(
                    REASON_POINTER_NOT_FOUND, f"'#{fragment}' has no key {token!r}"
                )
            current = current[token]
        elif isinstance(current, list):
            try:
                current = current[int(token)]
            except (ValueError, IndexError) as exc:
                raise _FetchError(
                    REASON_POINTER_NOT_FOUND, f"'#{fragment}' has no index {token!r}"
                ) from exc
        else:
            raise _FetchError(REASON_POINTER_NOT_FOUND, f"'#{fragment}' is not addressable")
    return current


@dataclass
class _Run:
    """Mutable state for one resolution run (shared across an intake's documents)."""

    budget: RemoteRefBudget
    cache: RemoteRefCache
    fetcher: RefFetcher
    deadline: float
    gate: Optional[RefGate] = None
    on_fetch: Optional[FetchObserver] = None
    resolved: List[ResolvedRef] = field(default_factory=list)
    unresolved: List[UnresolvedRef] = field(default_factory=list)
    fetched_bytes: int = 0
    cache_hits: int = 0
    gate_refusals: int = 0

    def observe(self, url: str, digest: str, fetched: int, from_cache: bool) -> None:
        """Notify the run's fetch observer, never letting it break the resolution."""
        if self.on_fetch is None:
            return
        try:
            self.on_fetch(url, digest, fetched, from_cache)
        except Exception:  # noqa: BLE001 - observation must never fail a resolution
            logger.warning("remote $ref fetch observer failed for %s", url, exc_info=True)

    def remaining_bytes(self) -> int:
        """Bytes still allowed to be fetched for this import."""
        return self.budget.max_bytes - self.fetched_bytes

    def check_budgets(self) -> None:
        """Raise when a whole-run budget has been spent.

        Raises:
            _FetchError: With the ``REASON_BUDGET_*`` reason that was hit.
        """
        if len(self.resolved) >= self.budget.max_refs:
            raise _FetchError(
                REASON_BUDGET_REFS,
                f"the {self.budget.max_refs}-reference budget for this import is spent",
            )
        if self.remaining_bytes() <= 0:
            raise _FetchError(
                REASON_BUDGET_BYTES,
                f"the {self.budget.max_bytes}-byte fetch budget for this import is spent",
            )
        if time.monotonic() >= self.deadline:
            raise _FetchError(
                REASON_BUDGET_TIME,
                f"the {self.budget.total_timeout_seconds}s resolution deadline elapsed",
            )

    def document_for(self, url: str) -> Tuple[str, Any, int, bool]:
        """Fetch (or read from cache) the document at ``url``.

        Returns:
            ``(digest, parsed document, bytes fetched, from_cache)`` — ``bytes fetched`` is
            ``0`` for a cache hit.

        Raises:
            _FetchError: If the URL cannot be fetched or parsed, or the run's gate refused
                it (with the gate's own reason).
            SSRFError: If the guard refuses the URL (or a redirect hop).
        """
        # The policy gate runs first — before the cache, before any client exists. Consulting
        # it after a cache lookup would let one tenant's fetch serve another tenant whose
        # policy forbids that host, which is exactly the leak REPO-3.9 exists to close.
        if self.gate is not None:
            refusal = self.gate(url)
            if refusal is not None:
                self.gate_refusals += 1
                raise _GateRefusalError(refusal[0], refusal[1])

        cached = self.cache.get(url)
        if cached is not None:
            self.cache_hits += 1
            self.observe(url, cached[0], 0, True)
            return cached[0], cached[1], 0, True

        # Reject a structurally-disallowed URL (file:, data:, user:pass@) before any client
        # exists, with a precise reason. The address policy — every resolved IP must be
        # public, re-checked on every redirect hop — is enforced by the guarded client's
        # request hook inside the fetcher, which is where a redirect chain can be seen.
        validate_url_policy(url)
        try:
            content = self.fetcher(
                url,
                max_bytes=self.remaining_bytes(),
                timeout=self.budget.fetch_timeout_seconds,
            )
        except _FetchError as failure:
            if failure.reason == REASON_BUDGET_BYTES:
                # The response ran past the ceiling: the bytes were transferred even though
                # nothing was kept, so spend the run's budget. Otherwise a server serving one
                # oversized body per reference would be re-downloaded up to `max_refs` times.
                self.fetched_bytes = self.budget.max_bytes
            raise
        self.fetched_bytes += len(content)

        # Lazy import: the ingestion module pulls in the YAML/limit machinery, which this
        # module has no other reason to load.
        from .import_ingestion import IngestionError, parse_document
        from .intake_resource_guard import IntakeLimitError

        try:
            document = parse_document(content.decode("utf-8", errors="replace"), source_label=url)
        except (IngestionError, IntakeLimitError) as exc:
            raise _FetchError(REASON_UNPARSEABLE, str(exc)) from exc
        digest = self.cache.put(url, content, document)
        self.observe(url, digest, len(content), False)
        return digest, document, len(content), False


def _resolve_node(
    value: Any,
    *,
    run: _Run,
    label: str,
    pointer: str,
    base_url: Optional[str],
    depth: int,
    stack: Tuple[Tuple[str, str], ...],
) -> Any:
    """Recursively inline remote ``$ref``\\s under ``value``, returning the rewritten node.

    Never raises for a reference that cannot be resolved: the original node is returned and
    an :class:`UnresolvedRef` is recorded, so one bad reference degrades that subtree only.
    """
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str) and ref:
            head, fragment = _split_ref(ref)
            url = _absolute_url(head, base_url)
            if url:
                return _inline_ref(
                    value,
                    ref=ref,
                    url=url,
                    fragment=fragment,
                    run=run,
                    label=label,
                    pointer=pointer,
                    base_url=base_url,
                    depth=depth,
                    stack=stack,
                )
        return {
            key: _resolve_node(
                item,
                run=run,
                label=label,
                pointer=f"{pointer}/{_escape_token(key)}",
                base_url=base_url,
                depth=depth,
                stack=stack,
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _resolve_node(
                item,
                run=run,
                label=label,
                pointer=f"{pointer}/{index}",
                base_url=base_url,
                depth=depth,
                stack=stack,
            )
            for index, item in enumerate(value)
        ]
    return value


def _unresolved_node(
    node: Dict[str, Any], *, ref: str, url: str, fragment: str, base_url: Optional[str]
) -> Dict[str, Any]:
    """Return the node to leave in place for a reference that was not inlined.

    A reference written *inside a fetched document* (``base_url`` set) is relative to that
    document — ``./common.json#/Id``, or a bare ``#/Id``. Copying it verbatim into the root
    document would silently re-target it at the root, turning a missing definition into a
    **wrong** one. So an unresolved reference from a fetched document is rewritten to its
    absolute URL form: it still names the document it always meant, and a later resolution
    (or a human reading the source) sees the truth. A reference in a root intake document is
    already absolute and is returned untouched.
    """
    if base_url is None:
        return node
    absolute = f"{url}#{fragment}" if fragment else url
    if absolute == ref:
        return node
    return {**node, "$ref": absolute}


def _inline_ref(
    node: Dict[str, Any],
    *,
    ref: str,
    url: str,
    fragment: str,
    run: _Run,
    label: str,
    pointer: str,
    base_url: Optional[str],
    depth: int,
    stack: Tuple[Tuple[str, str], ...],
) -> Any:
    """Fetch, address, and inline one remote reference — or record why it stayed put."""
    location = _location(label, pointer)
    key = (url, fragment)
    unresolved_node = _unresolved_node(
        node, ref=ref, url=url, fragment=fragment, base_url=base_url
    )
    try:
        if key in stack:
            raise _FetchError(
                REASON_CIRCULAR, f"'{ref}' is already being resolved in this chain"
            )
        if depth >= run.budget.max_depth:
            raise _FetchError(
                REASON_BUDGET_DEPTH,
                f"the {run.budget.max_depth}-level reference-chain depth limit was reached",
            )
        run.check_budgets()
        digest, document, fetched, from_cache = run.document_for(url)
        target = _json_pointer_get(document, fragment)
    except _FetchError as failure:
        run.unresolved.append(
            UnresolvedRef(
                location=location,
                ref=ref,
                url=url,
                reason=failure.reason,
                detail=failure.detail,
                gate_refused=isinstance(failure, _GateRefusalError),
            )
        )
        return unresolved_node
    except SSRFError as exc:
        run.unresolved.append(
            UnresolvedRef(
                location=location, ref=ref, url=url, reason=REASON_BLOCKED, detail=str(exc)
            )
        )
        return unresolved_node
    except Exception as exc:  # noqa: BLE001 - a resolver fault must never fail an import
        logger.warning("remote $ref resolution failed for %s", url, exc_info=True)
        run.unresolved.append(
            UnresolvedRef(
                location=location,
                ref=ref,
                url=url,
                reason=REASON_FETCH_FAILED,
                detail=f"{type(exc).__name__}: {exc}",
            )
        )
        return unresolved_node

    run.resolved.append(
        ResolvedRef(
            location=location,
            url=url,
            digest=digest,
            bytes_fetched=fetched,
            from_cache=from_cache,
        )
    )
    # References *inside* the fetched fragment resolve against the document they came from,
    # one level deeper, with this reference on the cycle stack.
    return _resolve_node(
        copy.deepcopy(target),
        run=run,
        label=label,
        pointer=pointer,
        base_url=url,
        depth=depth + 1,
        stack=stack + (key,),
    )


def resolve_remote_refs(
    documents: Mapping[str, Any],
    *,
    enabled: bool = True,
    budget: Optional[RemoteRefBudget] = None,
    cache: Optional[RemoteRefCache] = None,
    fetcher: Optional[RefFetcher] = None,
    gate: Optional[RefGate] = None,
    on_fetch: Optional[FetchObserver] = None,
) -> RemoteRefOutcome:
    """Resolve (or, when disabled, merely report) the external ``$ref``\\s in ``documents``.

    With ``enabled=False`` nothing is fetched and nothing is rewritten: every external
    reference is returned as unresolved with reason :data:`REASON_DISABLED`, which is what
    the default import reports as findings. With ``enabled=True`` each reference is fetched
    through the SSRF-guarded client under the run's :class:`RemoteRefBudget` and inlined in
    place; anything that cannot be resolved is reported and left untouched.

    Args:
        documents: Label → parsed document (``""`` for a single-document intake, member
            paths for a fileset). Documents are never mutated — a rewritten document is a
            new object.
        enabled: Whether to actually fetch (the per-import opt-in).
        budget: Ceilings for this run; defaults to :meth:`RemoteRefBudget.from_settings`.
        cache: Document cache; defaults to the process-wide :func:`default_cache`.
        fetcher: Fetch callable ``(url, *, max_bytes, timeout) -> bytes``; defaults to the
            SSRF-guarded HTTP fetcher. Tests substitute their own.
        gate: Optional per-URL policy gate (:data:`RefGate`), consulted before the cache and
            before any client exists. A refused URL is recorded unresolved with the gate's
            reason and marked ``gate_refused``. This is how REPO-3.9's tenant policy is
            enforced; a gate can only narrow what is fetched, never widen it.
        on_fetch: Optional observer (:data:`FetchObserver`) called once per reference
            document obtained, cache hits included, so a caller can audit what external
            material entered the model.

    Returns:
        The :class:`RemoteRefOutcome` for the run.
    """
    if not enabled:
        refs = scan_external_refs(documents)
        return RemoteRefOutcome(
            enabled=False,
            documents=dict(documents),
            unresolved=tuple(
                UnresolvedRef(
                    location=ref.location,
                    ref=ref.ref,
                    url=ref.url,
                    reason=REASON_DISABLED,
                    detail="remote $ref resolution is off for this import",
                )
                for ref in refs
            ),
        )

    effective_budget = budget or RemoteRefBudget.from_settings()
    run = _Run(
        budget=effective_budget,
        cache=cache if cache is not None else default_cache(),
        fetcher=fetcher or _http_fetch,
        deadline=time.monotonic() + effective_budget.total_timeout_seconds,
        gate=gate,
        on_fetch=on_fetch,
    )

    out_documents: Dict[str, Any] = {}
    changed: List[str] = []
    for label in sorted(documents):
        original = documents[label]
        before = len(run.resolved)
        rewritten = _resolve_node(
            original,
            run=run,
            label=label,
            pointer="",
            base_url=None,
            depth=0,
            stack=(),
        )
        if len(run.resolved) > before:
            out_documents[label] = rewritten
            changed.append(label)
        else:
            # Nothing was inlined — keep the caller's object so an untouched document is
            # provably untouched (and its persisted source text stays byte-identical).
            out_documents[label] = original

    return RemoteRefOutcome(
        enabled=True,
        documents=out_documents,
        resolved=tuple(sorted(run.resolved, key=lambda r: (r.location, r.url))),
        unresolved=tuple(sorted(run.unresolved, key=lambda r: (r.location, r.ref))),
        fetched_bytes=run.fetched_bytes,
        cache_hits=run.cache_hits,
        changed_documents=tuple(changed),
    )
