"""Serving an ephemeral hosted sandbox through the one mock engine (#5532, MSC-2.2).

apiome-rest provisions *sandboxes*: short-lived mocks frozen from a published version or from an
emitted export artifact, addressed by id at ``/v1/mock/{id}/…`` rather than by API coordinates.
Until MSC-2.2 they were served by a second, weaker resolver living inside apiome-rest — no
templates, no predicates, no stateful CRUD, no fixtures, no chaos — and every feature built here
was invisible there.

This module is the surviving half of that fold. A sandbox request now arrives over one internal
hop as a bundle plus a described request, and is answered by
:func:`apiome_mock.handler.serve_compiled_request` — the same function the hosted data plane and
the portable runtime call. There is no second resolution path left to drift.

It is deliberately *not* the preview path (#5528, MSC-1.2), which shares the same transport shape:

* **Chaos applies.** A preview reports the latency and error injection it suppressed, because a
  preview that slept would answer a different question. A sandbox is real traffic, so it sleeps.
* **Session state persists** for the life of the sandbox, in a store of its own, so stateful CRUD
  behaves across requests the way it does on the hosted plane.
* **Callbacks are not dispatched.** A sandbox is served for an unauthenticated caller from a
  frozen artifact; firing outbound HTTP at a third party on their behalf is an SSRF-shaped risk
  with no owner. The retired engine never delivered callbacks either, so nothing is lost.

Sandbox session state is held in memory, per sandbox, and evicted by
:class:`SandboxSessionStores`. That matches what a sandbox *is* — an instance with a TTL measured
in minutes or hours — and keeps the serving path free of a database it does not otherwise need.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Mapping

from apiome_mock.handler import ServeTrace, serve_compiled_request
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.session_store import SessionCaps, SessionStore
from apiome_mock.spec_loader import CompiledSpec
from apiome_mock.synthetic import (
    SyntheticRequest,
    build_synthetic_request,
    decode_response_body,
)

__all__ = [
    "MAX_TRACKED_SANDBOXES",
    "SANDBOX_SESSION_CAPS",
    "SandboxResult",
    "SandboxSessionStores",
    "serve_sandbox_request",
]

SANDBOX_SESSION_CAPS = SessionCaps(
    ttl_seconds=3600.0,
    max_resources=500,
    max_bytes=4_194_304,
    max_sessions=32,
)
"""Per-sandbox session limits. Generous enough for a real test drive, bounded so an anonymous
data plane cannot turn stateful CRUD into a memory exhaustion primitive."""

MAX_TRACKED_SANDBOXES = 256
"""How many sandboxes keep session state at once; the least recently served is evicted first."""


@dataclass(frozen=True)
class SandboxResult:
    """What the mock served for one sandbox request.

    Attributes:
        status: The HTTP status to return to the original caller.
        headers: The response headers, including the ``X-Mock-*`` family.
        media_type: The negotiated response media type.
        body: The response body — parsed JSON, decoded text, or base64, per ``body_encoding``.
        body_encoding: One of ``json``, ``text``, ``base64``, ``empty``.
        operation: The canonical ``"METHOD /template"`` key matched, or ``None`` when nothing did.
        scenario: The scenario that was in effect, or ``None`` when none was.
        schema_valid: Whether the served body validated against the response schema; ``None`` when
            nothing was checked (no operation matched, or the body was canned). Reported so the
            calling service can keep its own request log honest without re-deriving it.
    """

    status: int
    headers: Mapping[str, str]
    media_type: str
    body: Any
    body_encoding: str
    operation: str | None
    scenario: str | None
    schema_valid: bool | None = None

    def as_dict(self) -> dict[str, Any]:
        """Render the result as the JSON shape the calling service consumes."""
        return {
            "status": self.status,
            "headers": dict(self.headers),
            "mediaType": self.media_type,
            "body": self.body,
            "bodyEncoding": self.body_encoding,
            "operation": self.operation,
            "scenario": self.scenario,
            "schemaValid": self.schema_valid,
        }


class SandboxSessionStores:
    """Bounded registry of per-sandbox session stores.

    Each sandbox gets its own :class:`~apiome_mock.memory_session_store.InMemorySessionStore`, so
    two sandboxes frozen from the *same* version can never read each other's stateful CRUD state —
    which sharing one store keyed by API coordinates would allow, because that is all a session
    key carries.

    The registry is an LRU: the least recently served sandbox is dropped once
    :data:`MAX_TRACKED_SANDBOXES` are tracked. Losing a store loses only session state, which is
    already TTL-bounded and which callers must treat as expirable.
    """

    def __init__(self, *, caps: SessionCaps = SANDBOX_SESSION_CAPS, limit: int = MAX_TRACKED_SANDBOXES) -> None:
        """Create an empty registry.

        Args:
            caps: Limits applied to every store this registry hands out.
            limit: How many sandboxes may hold state at once.
        """
        self._caps = caps
        self._limit = max(1, limit)
        self._stores: OrderedDict[str, InMemorySessionStore] = OrderedDict()

    def for_sandbox(self, sandbox_id: str) -> SessionStore:
        """Return the store for one sandbox, creating it on first use.

        Args:
            sandbox_id: The sandbox's opaque identifier.

        Returns:
            That sandbox's session store, now the most recently used.
        """
        store = self._stores.pop(sandbox_id, None)
        if store is None:
            store = InMemorySessionStore(self._caps)
        self._stores[sandbox_id] = store
        while len(self._stores) > self._limit:
            self._stores.popitem(last=False)
        return store

    def forget(self, sandbox_id: str) -> None:
        """Drop one sandbox's session state, e.g. when the instance is destroyed.

        Args:
            sandbox_id: The sandbox's opaque identifier. Unknown ids are ignored.
        """
        self._stores.pop(sandbox_id, None)

    def __len__(self) -> int:
        """How many sandboxes currently hold session state."""
        return len(self._stores)


async def serve_sandbox_request(
    compiled: CompiledSpec,
    spec: SyntheticRequest,
    *,
    session_store: SessionStore | None = None,
) -> SandboxResult:
    """Serve one sandbox request against a compiled spec, exactly as the data plane would.

    Nothing here decides *what* the mock returns — :func:`serve_compiled_request` does, with chaos
    intact and session state kept, which is the whole point of routing sandboxes through it.

    Args:
        compiled: The spec compiled from the sandbox's bundle.
        spec: The described request, relative to the sandbox root.
        session_store: Store backing ``X-Mock-Session`` state; ``None`` disables stateful CRUD.

    Returns:
        The served response, rendered for the JSON hop back to the calling service.
    """
    request = build_synthetic_request(
        spec,
        tenant=compiled.tenant_slug,
        project=compiled.project_slug,
        version=compiled.version_label,
        host="sandbox.invalid",
    )

    trace = ServeTrace()
    response = await serve_compiled_request(
        request,
        compiled=compiled,
        tenant=compiled.tenant_slug,
        project=compiled.project_slug,
        version=compiled.version_label,
        path=spec.relative_path,
        session_store=session_store,
        # No dispatcher: a sandbox never fires an outbound callback at anybody.
        callback_dispatcher=None,
        trace=trace,
    )

    media_type = response.headers.get("content-type", "application/json")
    body, encoding = decode_response_body(bytes(response.body or b""), media_type)
    return SandboxResult(
        status=response.status_code,
        headers={name: value for name, value in response.headers.items()},
        media_type=media_type.split(";", 1)[0].strip() or "application/json",
        body=body,
        body_encoding=encoding,
        operation=trace.operation.key if trace.operation is not None else None,
        scenario=trace.scenario,
        schema_valid=trace.schema_valid,
    )
