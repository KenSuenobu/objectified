"""Guarded upstream proxy capture for the hosted mock runtime (#4747, PMR-2.4).

:mod:`app.mock_capture` decides *what may be recorded*; this module is what actually records it,
and is where the acceptance boundary of PMR-2.4 is enforced. One capture runs six gates, in this
order, and stops at the first that fails:

1. **Opt-in.** Nothing is ever captured by accident. A request is proxied only when it carries
   ``X-Mock-Capture: on``; every other request is served from the spec exactly as before.
2. **Authorization.** The version must hold a live capture grant — enabled, allowlisted, not
   expired — and the caller must present a valid tenant API key, so every recorded exchange is
   attributable. A request that asks to capture without a grant is refused loudly (403) rather
   than quietly mocked: a developer who thinks they are recording must never be told nothing.
3. **Allowlist.** The request path is resolved against the policy's upstream allowlist. Nothing
   else is fetchable, and the resolved URL is re-checked against the entry it was built from, so
   traversal in the request path cannot escape it.
4. **Fetch.** The upstream is fetched through the SSRF-guarded async client
   (:func:`app.ssrf_guard.build_guarded_async_client`): public addresses only, validated on every
   hop, redirects never followed, bounded timeout, bounded response size.
5. **Redact.** The exchange is reduced to a storable record by :func:`app.mock_capture.
   redact_exchange`, and the finished record is re-scanned by
   :func:`app.mock_capture.residual_credential_pointers`. **A record that still looks
   credential-bearing is not stored at all** — the caller still gets the upstream's answer, and
   the response says the exchange was not recorded and why.
6. **Persist.** The redacted record lands in ``mock_capture_exchange`` as ``pending``, with its
   provenance, its redaction decisions, and its schema-validation outcome; an audit row records
   that a capture happened at all. Nothing it contains serves traffic until an owner reviews and
   publishes it.

Capture is hosted-only by construction. It needs the control-plane database for both the grant and
the review queue, and ``proxyCapture`` is not in :data:`app.mock_bundle.BUNDLED_SETTINGS_KEYS`, so
a portable bundle can neither carry a grant nor act on one.

Whatever the outcome, the caller is told what happened on the response itself:
``X-Mock-Capture: recorded | not-recorded`` plus :data:`CAPTURE_REASON_HEADER` when it was not,
:data:`CAPTURE_ID_HEADER` for the review queue entry, and
:data:`CAPTURE_REDACTIONS_HEADER` with how many values were removed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Protocol, Sequence

import httpx
import structlog
from app.mock_capture import (
    MAX_CAPTURE_BODY_BYTES,
    MAX_PENDING_CAPTURES,
    CaptureProvenance,
    build_capture_record,
    canonical_capture_policy,
    capture_authorization_state,
    capture_policy_digest,
    capture_policy_from_storage,
    capture_record_digest,
    redact_exchange,
    residual_credential_pointers,
    resolve_capture_upstream,
)
from app.mock_engine import MockOperation
from app.ssrf_guard import SSRFError, build_guarded_async_client
from fastapi import Request
from fastapi.responses import Response
from psycopg_pool import AsyncConnectionPool

from apiome_mock.api_key import ValidatedApiKey
from apiome_mock.capture_store import count_pending_captures, insert_capture_exchange
from apiome_mock.problems import (
    capture_not_authorized,
    capture_upstream_not_allowed,
    capture_upstream_unreachable,
)
from apiome_mock.response_resolver import select_response_by_status
from apiome_mock.schema_synthesizer import validate_value

__all__ = [
    "CAPTURE_HEADER",
    "CAPTURE_ID_HEADER",
    "CAPTURE_REASON_HEADER",
    "CAPTURE_REDACTIONS_HEADER",
    "CAPTURE_UPSTREAM_HEADER",
    "CaptureProxy",
    "CaptureTransport",
    "HttpxCaptureTransport",
    "RuntimeCapturePolicy",
    "UpstreamRequest",
    "UpstreamResponse",
    "build_capture_proxy",
    "parse_capture_policy",
    "wants_capture",
]

_log = structlog.get_logger(__name__)

#: Two directions, one name. On the request it is the opt-in that turns a mocked call into a
#: recorded one; on the response it says whether the exchange was recorded.
CAPTURE_HEADER = "X-Mock-Capture"

#: Response header carrying the review-queue id of the exchange just recorded.
CAPTURE_ID_HEADER = "X-Mock-Capture-Id"

#: Response header carrying how many values redaction removed before storing.
CAPTURE_REDACTIONS_HEADER = "X-Mock-Capture-Redactions"

#: Response header naming the upstream that answered (query string removed).
CAPTURE_UPSTREAM_HEADER = "X-Mock-Capture-Upstream"

#: Response header explaining why an exchange that was fetched was not recorded.
CAPTURE_REASON_HEADER = "X-Mock-Capture-Reason"

#: Request header values that mean "record this one".
_OPT_IN_VALUES = frozenset({"on", "1", "true", "yes", "record"})

#: Request headers the proxy never forwards upstream: hop-by-hop headers, the ones the upstream's
#: own connection must own, and the mock's own control headers.
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "host",
        "content-length",
        "accept-encoding",
        "x-mock-capture",
        "x-mock-session",
        "x-mock-scenario",
        "x-api-key",
    }
)

#: Response headers the proxy never passes back to the caller: they describe the upstream's
#: connection or content encoding, which no longer holds once the body has been re-framed.
_STRIPPED_RESPONSE_HEADERS = frozenset(
    {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"}
)

#: Media types whose bodies are stored. Anything else is fetched and returned but not recorded.
_TEXTUAL_MEDIA_HINTS = ("json", "text/", "xml", "yaml", "x-www-form-urlencoded")


def wants_capture(request: Request) -> bool:
    """Whether this request asked to be captured (``X-Mock-Capture: on``)."""
    value = request.headers.get(CAPTURE_HEADER)
    return value is not None and value.strip().lower() in _OPT_IN_VALUES


@dataclass(frozen=True)
class RuntimeCapturePolicy:
    """A version's capture grant as the runtime sees it.

    Whether the grant is *live* is deliberately **not** stored on this object. A compiled spec is
    cached for minutes at a time, so a state decided at compile time would keep saying
    ``authorized`` for the rest of the cache's life after the grant lapsed. :meth:`state` is
    evaluated per request instead, which is what makes "capture stops on its own when the
    authorization expires" true rather than approximately true.

    Attributes:
        document: The canonical policy document, the source of the redaction rules.
        digest: The policy's digest, stamped on every capture taken under it.
        validate_responses: Whether captured responses are checked against the contract.
    """

    document: Mapping[str, Any]
    digest: str
    validate_responses: bool = True

    def state(self, *, now: datetime | None = None) -> str:
        """Return why capture is or is not live at ``now`` (defaults to the current UTC time)."""
        return capture_authorization_state(self.document, now=now or datetime.now(timezone.utc))

    def authorized(self, *, now: datetime | None = None) -> bool:
        """Whether capture may run at ``now``."""
        return self.state(now=now) == "authorized"


def parse_capture_policy(mock_settings: Any) -> RuntimeCapturePolicy:
    """Parse the ``proxyCapture`` key of raw mock settings into a runtime policy.

    Follows the runtime's leniency rule (like :mod:`apiome_mock.scenarios` and
    :mod:`apiome_mock.fixture_packs`): a malformed blob never raises, it simply yields a policy
    that authorizes nothing. Leniency here can only ever make capture *less* likely to run.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value (dict, JSON text, or ``None``).

    Returns:
        The parsed policy; call :meth:`RuntimeCapturePolicy.state` per request before using it.
    """
    stored = capture_policy_from_storage(mock_settings)
    canonical = canonical_capture_policy(stored) if stored else {}
    return RuntimeCapturePolicy(
        document=canonical,
        digest=capture_policy_digest(canonical) if canonical else "",
        validate_responses=bool(canonical.get("validateResponses", True)),
    )


@dataclass(frozen=True)
class UpstreamRequest:
    """One outbound fetch, fully authorized and ready to send.

    Attributes:
        method: HTTP method.
        url: Absolute upstream URL, query string included.
        headers: Header pairs to forward (credentials included — they are needed to reach the
            upstream, and they are what redaction removes before anything is stored).
        body: Raw request body, or ``None``.
        timeout_seconds: Ceiling on the fetch.
    """

    method: str
    url: str
    headers: tuple[tuple[str, str], ...]
    body: bytes | None
    timeout_seconds: float


@dataclass(frozen=True)
class UpstreamResponse:
    """What the upstream answered.

    Attributes:
        status: Response status.
        headers: Response header pairs.
        body: Response body bytes (possibly truncated, see :attr:`truncated`).
        truncated: Whether the body exceeded the capture body limit; a truncated body is returned
            to the caller in full but never stored.
    """

    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes
    truncated: bool = False


class CaptureTransport(Protocol):
    """How the proxy puts one request on the wire.

    Extracted as a protocol so tests can drive the whole capture pipeline without a socket, and so
    a deployment can substitute a transport with its own connection policy.
    """

    async def fetch(self, request: UpstreamRequest) -> UpstreamResponse:
        """Fetch one upstream request.

        Raises:
            CaptureTransportError: The fetch never produced a response.
        """


class CaptureTransportError(RuntimeError):
    """One upstream fetch never produced a response (timeout, DNS, refused, SSRF refusal)."""


class HttpxCaptureTransport:
    """The default transport: one SSRF-guarded ``httpx.AsyncClient`` per proxy.

    Redirects are never followed. An upstream that answers 302 is answering; chasing the redirect
    would fetch — and record — a URL no allowlist entry ever authorized.
    """

    def __init__(self, *, allow_private_upstreams: bool = False, max_body_bytes: int) -> None:
        """Create the transport.

        Args:
            allow_private_upstreams: Relax the SSRF hook to shape checks only, for a deployment
                capturing from a local service on purpose.
            max_body_bytes: Response bytes to read before giving up on storing the body.
        """
        self._allow_private = allow_private_upstreams
        self._max_body_bytes = max_body_bytes
        self._client: httpx.AsyncClient | None = None

    async def fetch(self, request: UpstreamRequest) -> UpstreamResponse:
        """Fetch one upstream request through the guarded client."""
        client = self._ensure_client()
        try:
            response = await client.request(
                request.method,
                request.url,
                headers=dict(request.headers),
                content=request.body,
                timeout=request.timeout_seconds,
            )
        except SSRFError as exc:
            raise CaptureTransportError(str(exc)) from exc
        except Exception as exc:  # httpx transport/timeout errors
            raise CaptureTransportError(f"{type(exc).__name__}: {exc}") from exc
        body = response.content or b""
        return UpstreamResponse(
            status=int(response.status_code),
            headers=tuple((name, value) for name, value in response.headers.items()),
            body=body,
            truncated=len(body) > self._max_body_bytes,
        )

    def _ensure_client(self) -> httpx.AsyncClient:
        """Build the guarded client on first use, so a proxy that never fetches costs nothing."""
        if self._client is None:
            self._client = build_guarded_async_client(
                allow_private=self._allow_private,
                follow_redirects=False,
            )
        return self._client

    async def aclose(self) -> None:
        """Close the underlying client, if one was ever built."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None


def _forwarded_request_headers(request: Request) -> tuple[tuple[str, str], ...]:
    """Return the request headers to forward upstream, hop-by-hop and control headers removed."""
    return tuple((name, value) for name, value in request.headers.items() if name.lower() not in _HOP_BY_HOP)


def _is_textual(media_type: str | None) -> bool:
    """Whether a media type names a payload worth storing (JSON, text, XML, YAML, form)."""
    if not media_type:
        return False
    lowered = media_type.lower()
    return any(hint in lowered for hint in _TEXTUAL_MEDIA_HINTS)


def _decode_body(body: bytes | None, media_type: str | None) -> Any:
    """Decode a body for storage: JSON when it parses, otherwise text; ``None`` when unusable."""
    if not body:
        return None
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return None
    lowered = (media_type or "").lower()
    if "json" in lowered:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


def _media_type(headers: Mapping[str, str] | Sequence[tuple[str, str]], fallback: str | None = None) -> str | None:
    """Extract the bare media type from a ``Content-Type`` header."""
    items = headers.items() if isinstance(headers, Mapping) else headers
    for name, value in items:
        if name.lower() == "content-type":
            return value.split(";", 1)[0].strip() or fallback
    return fallback


def _response_schema(operation: MockOperation | None, status: int, media_type: str | None) -> Any:
    """Return the declared schema for a status/media type pair, or ``None`` when none is declared."""
    if operation is None:
        return None
    _, response_obj = select_response_by_status(operation.operation, status)
    if not isinstance(response_obj, dict):
        return None
    content = response_obj.get("content")
    if not isinstance(content, dict) or not content:
        return None
    if media_type and media_type in content:
        entry = content[media_type]
    else:
        entry = next(iter(content.values()))
    return entry.get("schema") if isinstance(entry, dict) else None


class CaptureProxy:
    """The runtime's guarded proxy: forwards an authorized request and records the exchange.

    One proxy exists per deployment (``None`` when capture is switched off at the process level),
    holding the transport. All per-version authorization comes from the version's own policy, so
    enabling the feature on a deployment grants nothing by itself.
    """

    def __init__(
        self,
        *,
        transport: CaptureTransport,
        timeout_seconds: float = 10.0,
        max_body_bytes: int = MAX_CAPTURE_BODY_BYTES,
        retention_hours: int = 168,
    ) -> None:
        """Create the proxy.

        Args:
            transport: How requests reach the upstream.
            timeout_seconds: Ceiling on one upstream fetch.
            max_body_bytes: Largest request/response body a capture stores.
            retention_hours: How long a recorded exchange survives before the retention sweep
                removes it.
        """
        self._transport = transport
        self._timeout = timeout_seconds
        self._max_body_bytes = max_body_bytes
        self._retention_hours = retention_hours

    async def aclose(self) -> None:
        """Release the transport's connections at shutdown."""
        closer = getattr(self._transport, "aclose", None)
        if closer is not None:
            await closer()

    async def capture(
        self,
        request: Request,
        *,
        spec: Mapping[str, Any],
        policy: RuntimeCapturePolicy,
        operation: MockOperation | None,
        tenant: str,
        project: str,
        version: str,
        relative_path: str,
        instance: str,
        api_key: ValidatedApiKey | None,
        pool: AsyncConnectionPool,
    ) -> Response:
        """Proxy one opt-in request upstream and record the redacted exchange.

        Args:
            request: The incoming request (already known to have opted in).
            spec: The generated OpenAPI document ``$ref``s in response schemas resolve against.
            policy: The version's capture grant.
            operation: The spec operation the request matched, when it matched one.
            tenant: Tenant slug.
            project: Project slug.
            version: Version label.
            relative_path: The request path relative to the version prefix.
            instance: Problem ``instance`` path for error bodies.
            api_key: The validated tenant API key that attributes the capture.
            pool: Database pool for the review queue and the audit ledger.

        Returns:
            The upstream's response, annotated with the capture headers — or a problem response
            when capture was refused or the upstream could not be reached.
        """
        # Evaluated now, not when the spec was compiled and cached: an expired grant must stop
        # recording the moment it lapses, not when the cache next turns over.
        state = policy.state()
        if state != "authorized":
            return capture_not_authorized(
                _unauthorized_detail(state, tenant, project, version),
                instance=instance,
                state=state,
            )
        if api_key is None:
            return capture_not_authorized(
                "Capture requires a tenant API key so every recorded exchange is attributable; send one in X-Api-Key.",
                instance=instance,
                state="no-api-key",
            )

        target = resolve_capture_upstream(
            policy.document,
            relative_path=relative_path,
            query_string=request.url.query or "",
        )
        if target is None:
            return capture_upstream_not_allowed(
                f"No allowlisted upstream authorizes capturing {relative_path}.",
                instance=instance,
                allowed=list(policy.document.get("upstreams") or []),
            )

        request_body = await request.body()
        try:
            upstream = await self._transport.fetch(
                UpstreamRequest(
                    method=request.method.upper(),
                    url=target.url,
                    headers=_forwarded_request_headers(request),
                    body=request_body or None,
                    timeout_seconds=self._timeout,
                )
            )
        except CaptureTransportError as exc:
            _log.warning(
                "mock_capture_upstream_failed",
                tenant=tenant,
                project=project,
                version=version,
                upstream=target.logged_url,
                error=str(exc),
            )
            return capture_upstream_unreachable(
                f"The allowlisted upstream {target.logged_url} could not be reached: {exc}",
                instance=instance,
                upstream=target.logged_url,
            )

        response = self._client_response(upstream)
        response.headers[CAPTURE_UPSTREAM_HEADER] = target.logged_url

        recorded, reason, capture_id, redaction_count = await self._record(
            request,
            upstream=upstream,
            target=target,
            policy=policy,
            spec=spec,
            operation=operation,
            tenant=tenant,
            project=project,
            version=version,
            relative_path=relative_path,
            request_body=request_body,
            api_key=api_key,
            pool=pool,
        )
        response.headers[CAPTURE_HEADER] = "recorded" if recorded else "not-recorded"
        response.headers[CAPTURE_REDACTIONS_HEADER] = str(redaction_count)
        if capture_id:
            response.headers[CAPTURE_ID_HEADER] = capture_id
        if reason:
            response.headers[CAPTURE_REASON_HEADER] = reason
        return response

    def _client_response(self, upstream: UpstreamResponse) -> Response:
        """Return the upstream's answer to the caller, connection headers removed.

        The proxy is transparent about *content*: the caller gets the real status and body, which
        is the entire point of capturing against a live service. It is not transparent about
        framing — hop-by-hop and encoding headers describe a connection that no longer exists.
        """
        headers = {
            name.lower(): value for name, value in upstream.headers if name.lower() not in _STRIPPED_RESPONSE_HEADERS
        }
        media_type = _media_type(upstream.headers)
        # Starlette writes ``content-type`` from ``media_type``; leaving the upstream's own copy in
        # the header map would emit it twice.
        headers.pop("content-type", None)
        return Response(
            content=upstream.body,
            status_code=upstream.status,
            headers=headers,
            media_type=media_type,
        )

    async def _record(
        self,
        request: Request,
        *,
        upstream: UpstreamResponse,
        target: Any,
        policy: RuntimeCapturePolicy,
        spec: Mapping[str, Any],
        operation: MockOperation | None,
        tenant: str,
        project: str,
        version: str,
        relative_path: str,
        request_body: bytes,
        api_key: ValidatedApiKey,
        pool: AsyncConnectionPool,
    ) -> tuple[bool, str | None, str | None, int]:
        """Redact, validate, re-scan, and persist one exchange.

        Returns:
            ``(recorded, reason, capture_id, redaction_count)`` — ``reason`` is set only when the
            exchange was fetched but deliberately not stored, and is safe to put in a header.
        """
        request_type = _media_type(request.headers)
        response_type = _media_type(upstream.headers)
        request_oversize = len(request_body) > self._max_body_bytes

        # Decode first, then decide whether the body is storable at all: a payload that is not
        # JSON/text, or that is not valid UTF-8, is reported as non-textual so the redaction engine
        # records *why* it is missing rather than silently omitting it.
        decoded_request = None if request_oversize else _decode_body(request_body, request_type)
        decoded_response = None if upstream.truncated else _decode_body(upstream.body, response_type)

        exchange = redact_exchange(
            policy=policy.document,
            method=request.method,
            path=relative_path,
            query_params=list(request.query_params.multi_items()),
            request_headers=dict(request.headers),
            request_body=decoded_request,
            request_media_type=request_type,
            request_body_textual=not request_body or (_is_textual(request_type) and decoded_request is not None),
            request_body_oversize=request_oversize,
            status=upstream.status,
            response_headers=dict(upstream.headers),
            response_body=decoded_response,
            response_media_type=response_type,
            response_body_textual=not upstream.body or (_is_textual(response_type) and decoded_response is not None),
            response_body_oversize=upstream.truncated,
        )
        redaction_count = len(exchange.decisions)

        validation_errors: list[str] = []
        validated = False
        if policy.validate_responses and exchange.response.get("body") is not None:
            schema = _response_schema(operation, upstream.status, response_type)
            if schema is not None:
                validated = True
                error = validate_value(exchange.response["body"], schema, dict(spec))
                if error:
                    validation_errors.append(error)

        provenance = CaptureProvenance(
            tenant=tenant,
            project=project,
            version=version,
            upstream=target.logged_url,
            allowlist_entry=target.allowlist_entry,
            policy_digest=policy.digest,
            captured_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            captured_by=str(api_key.id),
            operation_key=operation.key if operation is not None else None,
            path_template=operation.path_template if operation is not None else None,
        )
        record = build_capture_record(
            exchange=exchange,
            provenance=provenance,
            validation_errors=validation_errors,
            validated=validated,
        )

        # Last gate: a record the redaction rules missed something in is never stored. The caller
        # already has the upstream's answer; what fails closed here is *retention*.
        residual = residual_credential_pointers(record)
        if residual:
            _log.warning(
                "mock_capture_refused_residual_credentials",
                tenant=tenant,
                project=project,
                version=version,
                pointers=residual,
            )
            return False, "credential-scan-failed", None, redaction_count

        try:
            pending = await count_pending_captures(
                pool, tenant_id=api_key.tenant_id, tenant=tenant, project=project, version=version
            )
            if pending >= MAX_PENDING_CAPTURES:
                return False, "review-queue-full", None, redaction_count
            capture_id = await insert_capture_exchange(
                pool,
                tenant_id=api_key.tenant_id,
                tenant=tenant,
                project=project,
                version=version,
                upstream=target.logged_url,
                allowlist_entry=target.allowlist_entry,
                policy_digest=policy.digest,
                api_key_id=api_key.id,
                operation_key=provenance.operation_key,
                method=request.method.upper(),
                path=relative_path,
                status_code=upstream.status,
                record=record,
                digest=capture_record_digest(record),
                redactions=exchange.decisions_as_json(),
                schema_valid=(not validation_errors) if validated else None,
                validation_errors=validation_errors,
                expires_at=datetime.now(timezone.utc) + timedelta(hours=self._retention_hours),
            )
        except Exception:
            _log.warning(
                "mock_capture_store_failed",
                tenant=tenant,
                project=project,
                version=version,
                exc_info=True,
            )
            return False, "store-unavailable", None, redaction_count

        if capture_id is None:
            return False, "store-unavailable", None, redaction_count

        _log.info(
            "mock_capture_recorded",
            tenant=tenant,
            project=project,
            version=version,
            capture_id=capture_id,
            upstream=target.logged_url,
            status=upstream.status,
            redactions=redaction_count,
            schema_valid=(not validation_errors) if validated else None,
        )
        return True, None, capture_id, redaction_count


def _unauthorized_detail(state: str, tenant: str, project: str, version: str) -> str:
    """Explain, in one sentence, exactly which capture gate refused this request."""
    coordinates = f"{tenant}/{project}/{version}"
    reasons = {
        "unconfigured": f"No capture policy is configured for {coordinates}.",
        "disabled": f"Capture is switched off for {coordinates}.",
        "no-upstreams": f"The capture policy for {coordinates} allowlists no upstreams.",
        "unauthorized": f"The capture policy for {coordinates} carries no authorization.",
        "expired": f"The capture authorization for {coordinates} has expired; renew it to record again.",
    }
    return reasons.get(state, f"Capture is not authorized for {coordinates}.")


def build_capture_proxy(
    *,
    enabled: bool,
    allow_private_upstreams: bool,
    timeout_seconds: float,
    max_body_bytes: int = MAX_CAPTURE_BODY_BYTES,
    retention_hours: int = 168,
) -> CaptureProxy | None:
    """Build the runtime's capture proxy from resolved deployment settings.

    A deployment with capture switched off has no proxy at all, so no policy, request header, or
    stored grant can make it record. Enabling it grants nothing on its own either: every capture
    still needs a live per-version authorization.

    Args:
        enabled: Whether this deployment may proxy and record upstream traffic.
        allow_private_upstreams: Whether non-public upstream addresses are permitted.
        timeout_seconds: Ceiling on one upstream fetch.
        max_body_bytes: Largest request/response body a capture stores.
        retention_hours: How long a recorded exchange survives before retention removes it.

    Returns:
        The proxy, or ``None`` when capture is disabled for this deployment.
    """
    if not enabled:
        return None
    return CaptureProxy(
        transport=HttpxCaptureTransport(
            allow_private_upstreams=allow_private_upstreams,
            max_body_bytes=max_body_bytes,
        ),
        timeout_seconds=timeout_seconds,
        max_body_bytes=max_body_bytes,
        retention_hours=retention_hours,
    )
