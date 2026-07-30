"""Unit tests for the MCP Streamable HTTP transport (V2-MCP-16.1, #3657).

These exercise the JSON-RPC-over-Streamable-HTTP client end to end with a mocked
httpx transport (``httpx.MockTransport``) — no sockets — so every spec branch
(JSON vs SSE responses, 202 accepts, session round-trip, protocol pinning, and
the 400/404/405 status handling) is covered deterministically. A companion
integration test that drives the client against a real loopback stub server lives
in ``test_mcp_transport_http_integration.py``.
"""

import json
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from app.mcp_client.transport_http import (
    DEFAULT_PROTOCOL_VERSION,
    PROTOCOL_VERSION_HEADER,
    SESSION_ID_HEADER,
    JsonRpcResponse,
    McpAuthRequiredError,
    McpHttpStatusError,
    McpProtocolError,
    McpRateLimitedError,
    McpSessionExpiredError,
    McpSsrfError,
    McpTransportError,
    StreamableHttpTransport,
)

ENDPOINT = "https://mcp.example.com/mcp"


# ===========================================================================
# Test helpers
# ===========================================================================


def sse_body(*messages: Dict[str, Any]) -> bytes:
    """Render JSON-RPC messages as an SSE ``message`` event stream."""
    chunks = [f"event: message\ndata: {json.dumps(m)}\n\n" for m in messages]
    return "".join(chunks).encode("utf-8")


def json_response(message: Dict[str, Any], **headers: str) -> httpx.Response:
    return httpx.Response(200, json=message, headers=headers)


def sse_response(*messages: Dict[str, Any], **headers: str) -> httpx.Response:
    hdrs = {"Content-Type": "text/event-stream", **headers}
    return httpx.Response(200, content=sse_body(*messages), headers=hdrs)


def make_transport(
    handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any
) -> StreamableHttpTransport:
    """Build a transport wired to an httpx.MockTransport running ``handler``."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return StreamableHttpTransport(ENDPOINT, client=client, **kwargs)


class RecordingHandler:
    """A MockTransport handler that records every request and replies per method.

    ``replies`` maps a JSON-RPC method (or ``"DELETE"``/``"__notification__"``) to
    a factory ``(request, body) -> httpx.Response``. Falls back to a JSON result.
    """

    def __init__(self, replies: Optional[Dict[str, Callable[..., httpx.Response]]] = None) -> None:
        self.replies = replies or {}
        self.requests: List[httpx.Request] = []
        self.bodies: List[Dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "DELETE":
            factory = self.replies.get("DELETE")
            return factory(request) if factory else httpx.Response(200)
        body = json.loads(request.content)
        self.bodies.append(body)
        key = body.get("method") if "id" in body else "__notification__"
        factory = self.replies.get(key)
        if factory is not None:
            return factory(request, body)
        # Default: echo a trivial successful result for the request id.
        return json_response({"jsonrpc": "2.0", "id": body.get("id"), "result": {"ok": True}})


# ===========================================================================
# Request / response shapes
# ===========================================================================


async def test_request_returns_json_result():
    handler = RecordingHandler(
        {"ping": lambda req, body: json_response({"jsonrpc": "2.0", "id": body["id"], "result": {"pong": 1}})}
    )
    transport = make_transport(handler)

    resp = await transport.request("ping", {"x": 1})

    assert isinstance(resp, JsonRpcResponse)
    assert not resp.is_error
    assert resp.result == {"pong": 1}
    # Envelope sent to the server is a well-formed JSON-RPC request.
    sent = handler.bodies[0]
    assert sent["jsonrpc"] == "2.0"
    assert sent["method"] == "ping"
    assert sent["params"] == {"x": 1}
    assert "id" in sent


async def test_request_captures_transport_observation(monkeypatch):
    """The first request records host/timing on ``observed_transport`` (V2-MCP-34.1)."""
    handler = RecordingHandler(
        {"initialize": lambda req, body: json_response(
            {"jsonrpc": "2.0", "id": body["id"], "result": {"ok": True}}, Server="nginx"
        )}
    )
    transport = make_transport(handler)

    assert transport.observed_transport is None
    await transport.request("initialize", {})

    obs = transport.observed_transport
    assert obs is not None
    assert obs.host == "mcp.example.com"
    assert obs.scheme == "https"
    # A mocked transport exposes no TLS session, so the cert is absent but capture still succeeds.
    assert obs.certificate is None
    assert obs.response_headers.get("server") == "nginx"
    assert obs.connect_ms is not None


async def test_transport_observation_captured_once(monkeypatch):
    """Only the first response is observed; later requests do not overwrite it."""
    handler = RecordingHandler()
    transport = make_transport(handler)

    await transport.request("initialize", {})
    first = transport.observed_transport
    await transport.request("tools/list", {})

    assert transport.observed_transport is first


async def test_request_omits_params_when_none():
    handler = RecordingHandler()
    transport = make_transport(handler)

    await transport.request("tools/list")

    assert "params" not in handler.bodies[0]


async def test_request_parses_sse_streamed_response():
    handler = RecordingHandler(
        {"slow": lambda req, body: sse_response({"jsonrpc": "2.0", "id": body["id"], "result": {"streamed": True}})}
    )
    transport = make_transport(handler)

    resp = await transport.request("slow", request_id=42)

    assert resp.id == 42
    assert resp.result == {"streamed": True}


async def test_request_sends_accept_and_origin_headers():
    handler = RecordingHandler()
    transport = make_transport(handler)

    await transport.request("ping")

    sent = handler.requests[0]
    assert sent.headers["Accept"] == "application/json, text/event-stream"
    # Origin defaults to the endpoint's scheme://host with no path.
    assert sent.headers["Origin"] == "https://mcp.example.com"


# ===========================================================================
# Session + protocol-version handshake
# ===========================================================================


async def test_initialize_captures_session_id():
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": DEFAULT_PROTOCOL_VERSION}},
                **{SESSION_ID_HEADER: "sess-123"},
            )
        }
    )
    transport = make_transport(handler)

    await transport.request("initialize", {"capabilities": {}})

    assert transport.session_id == "sess-123"
    assert transport.initialized is True
    # The initialize request itself must NOT carry the protocol-version header.
    assert PROTOCOL_VERSION_HEADER not in handler.requests[0].headers


async def test_session_id_and_protocol_version_echoed_after_init():
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}},
                **{SESSION_ID_HEADER: "sess-xyz"},
            )
        }
    )
    transport = make_transport(handler)

    await transport.request("initialize", {})
    await transport.request("tools/list", {})

    follow_up = handler.requests[1]
    assert follow_up.headers[SESSION_ID_HEADER] == "sess-xyz"
    assert follow_up.headers[PROTOCOL_VERSION_HEADER] == DEFAULT_PROTOCOL_VERSION


async def test_custom_protocol_version_is_sent():
    handler = RecordingHandler(
        {"initialize": lambda req, body: json_response({"jsonrpc": "2.0", "id": body["id"], "result": {}})}
    )
    transport = make_transport(handler, protocol_version="2099-01-01")

    await transport.request("initialize", {})
    await transport.request("tools/list", {})

    assert handler.requests[1].headers[PROTOCOL_VERSION_HEADER] == "2099-01-01"


async def test_notification_succeeds_on_202():
    handler = RecordingHandler({"__notification__": lambda req, body: httpx.Response(202)})
    transport = make_transport(handler)

    result = await transport.notify("notifications/initialized", {"ack": True})

    assert result is None
    sent = handler.bodies[0]
    assert "id" not in sent  # notifications carry no id
    assert sent["method"] == "notifications/initialized"


async def test_notification_succeeds_on_200():
    handler = RecordingHandler({"__notification__": lambda req, body: httpx.Response(200)})
    transport = make_transport(handler)

    assert await transport.notify("notifications/progress") is None


# ===========================================================================
# Status-code handling (400 / 404 / 405 / 202)
# ===========================================================================


async def test_400_raises_http_status_error():
    handler = RecordingHandler({"bad": lambda req, body: httpx.Response(400, text="bad request")})
    transport = make_transport(handler)

    with pytest.raises(McpHttpStatusError) as exc:
        await transport.request("bad")
    assert exc.value.status_code == 400
    assert "bad request" in exc.value.body


async def test_405_raises_http_status_error():
    handler = RecordingHandler({"nope": lambda req, body: httpx.Response(405)})
    transport = make_transport(handler)

    with pytest.raises(McpHttpStatusError) as exc:
        await transport.request("nope")
    assert exc.value.status_code == 405


async def test_404_with_active_session_raises_session_expired_and_clears_it():
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}}, **{SESSION_ID_HEADER: "sess-1"}
            ),
            "tools/list": lambda req, body: httpx.Response(404, text="gone"),
        }
    )
    transport = make_transport(handler)
    await transport.request("initialize", {})
    assert transport.session_id == "sess-1"

    with pytest.raises(McpSessionExpiredError) as exc:
        await transport.request("tools/list", {})

    assert exc.value.session_id == "sess-1"
    assert exc.value.status_code == 404
    # Session is cleared so a fresh initialize can start cleanly.
    assert transport.session_id is None
    assert transport.initialized is False


async def test_404_without_session_raises_plain_http_status_error():
    handler = RecordingHandler({"x": lambda req, body: httpx.Response(404)})
    transport = make_transport(handler)

    with pytest.raises(McpHttpStatusError) as exc:
        await transport.request("x")
    assert not isinstance(exc.value, McpSessionExpiredError)
    assert exc.value.status_code == 404


async def test_401_raises_auth_required_with_www_authenticate():
    handler = RecordingHandler(
        {
            "tools/list": lambda req, body: httpx.Response(
                401, text="auth", headers={"WWW-Authenticate": 'Bearer resource_metadata="https://as/.well-known"'}
            )
        }
    )
    transport = make_transport(handler)

    with pytest.raises(McpAuthRequiredError) as exc:
        await transport.request("tools/list")
    # The dedicated 401 error preserves the challenge and is still an HTTP status error.
    assert isinstance(exc.value, McpHttpStatusError)
    assert exc.value.status_code == 401
    assert exc.value.www_authenticate == 'Bearer resource_metadata="https://as/.well-known"'
    assert "auth" in exc.value.body


async def test_401_without_www_authenticate_header():
    handler = RecordingHandler({"x": lambda req, body: httpx.Response(401)})
    transport = make_transport(handler)

    with pytest.raises(McpAuthRequiredError) as exc:
        await transport.request("x")
    assert exc.value.www_authenticate is None


async def test_429_raises_rate_limited_with_retry_after():
    handler = RecordingHandler(
        {"tools/list": lambda req, body: httpx.Response(429, text="slow down", headers={"Retry-After": "120"})}
    )
    transport = make_transport(handler)

    with pytest.raises(McpRateLimitedError) as exc:
        await transport.request("tools/list")
    # The dedicated 429 error is still an HTTP status error and parses the Retry-After delay.
    assert isinstance(exc.value, McpHttpStatusError)
    assert exc.value.status_code == 429
    assert exc.value.retry_after == 120
    assert "slow down" in exc.value.body


async def test_429_without_retry_after_header():
    handler = RecordingHandler({"x": lambda req, body: httpx.Response(429)})
    transport = make_transport(handler)

    with pytest.raises(McpRateLimitedError) as exc:
        await transport.request("x")
    assert exc.value.retry_after is None


async def test_202_to_a_request_is_a_protocol_error():
    # 202 is only valid when the body had no request needing an answer.
    handler = RecordingHandler({"x": lambda req, body: httpx.Response(202)})
    transport = make_transport(handler)

    with pytest.raises(McpProtocolError, match="202"):
        await transport.request("x")


# ===========================================================================
# Malformed responses
# ===========================================================================


async def test_unexpected_content_type_raises_protocol_error():
    handler = RecordingHandler(
        {"x": lambda req, body: httpx.Response(200, content=b"<html/>", headers={"Content-Type": "text/html"})}
    )
    transport = make_transport(handler)

    with pytest.raises(McpProtocolError, match="Content-Type"):
        await transport.request("x")


async def test_invalid_json_body_raises_protocol_error():
    handler = RecordingHandler(
        {"x": lambda req, body: httpx.Response(200, content=b"not json", headers={"Content-Type": "application/json"})}
    )
    transport = make_transport(handler)

    with pytest.raises(McpProtocolError, match="not valid JSON"):
        await transport.request("x")


async def test_missing_jsonrpc_version_raises_protocol_error():
    handler = RecordingHandler({"x": lambda req, body: json_response({"id": body["id"], "result": {}})})
    transport = make_transport(handler)

    with pytest.raises(McpProtocolError, match="jsonrpc"):
        await transport.request("x")


async def test_response_without_result_or_error_raises_protocol_error():
    handler = RecordingHandler({"x": lambda req, body: json_response({"jsonrpc": "2.0", "id": body["id"]})})
    transport = make_transport(handler)

    with pytest.raises(McpProtocolError, match="neither"):
        await transport.request("x")


async def test_jsonrpc_error_response_is_surfaced():
    handler = RecordingHandler(
        {
            "x": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": "Method not found"}}
            )
        }
    )
    transport = make_transport(handler)

    resp = await transport.request("x")
    assert resp.is_error
    assert resp.error is not None
    assert resp.error.code == -32601
    assert resp.error.message == "Method not found"
    with pytest.raises(McpProtocolError, match="-32601"):
        resp.raise_for_error()


# ===========================================================================
# SSE specifics
# ===========================================================================


async def test_sse_dispatches_server_message_before_our_response():
    server_note = {"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info"}}
    handler = RecordingHandler(
        {"x": lambda req, body: sse_response(server_note, {"jsonrpc": "2.0", "id": body["id"], "result": {"done": 1}})}
    )
    transport = make_transport(handler)

    received: List[Dict[str, Any]] = []
    resp = await transport.request("x", request_id=7, on_server_message=received.append)

    assert resp.result == {"done": 1}
    assert received == [server_note]


async def test_sse_supports_async_server_message_handler():
    server_note = {"jsonrpc": "2.0", "method": "notifications/message"}
    handler = RecordingHandler(
        {"x": lambda req, body: sse_response(server_note, {"jsonrpc": "2.0", "id": body["id"], "result": {}})}
    )
    transport = make_transport(handler)
    received: List[Dict[str, Any]] = []

    async def collect(msg: Dict[str, Any]) -> None:
        received.append(msg)

    await transport.request("x", on_server_message=collect)
    assert received == [server_note]


async def test_sse_stream_without_matching_response_raises():
    # A stream that closes carrying only an unrelated notification has no answer.
    handler = RecordingHandler(
        {"x": lambda req, body: sse_response({"jsonrpc": "2.0", "method": "notifications/message"})}
    )
    transport = make_transport(handler)

    with pytest.raises(McpProtocolError, match="closed before a response"):
        await transport.request("x", request_id=99)


async def test_sse_joins_multiple_data_lines():
    # A single SSE event whose JSON payload is split across two ``data:`` lines.
    body = b'event: message\ndata: {"jsonrpc": "2.0",\ndata: "id": 5, "result": {"v": 9}}\n\n'
    handler = RecordingHandler(
        {"x": lambda req, b: httpx.Response(200, content=body, headers={"Content-Type": "text/event-stream"})}
    )
    transport = make_transport(handler)

    resp = await transport.request("x", request_id=5)
    assert resp.result == {"v": 9}


# ===========================================================================
# Session termination (DELETE)
# ===========================================================================


async def test_end_session_sends_delete_with_session_header():
    deletes: List[httpx.Request] = []
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}}, **{SESSION_ID_HEADER: "sess-del"}
            ),
            "DELETE": lambda req: deletes.append(req) or httpx.Response(200),
        }
    )
    transport = make_transport(handler)
    await transport.request("initialize", {})

    await transport.end_session()

    assert len(deletes) == 1
    assert deletes[0].headers[SESSION_ID_HEADER] == "sess-del"
    assert transport.session_id is None
    assert transport.initialized is False


async def test_end_session_is_noop_without_session():
    handler = RecordingHandler({"DELETE": lambda req: (_ for _ in ()).throw(AssertionError("should not DELETE"))})
    transport = make_transport(handler)

    await transport.end_session()  # no session -> no DELETE attempted


async def test_end_session_tolerates_405():
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}}, **{SESSION_ID_HEADER: "s"}
            ),
            "DELETE": lambda req: httpx.Response(405),
        }
    )
    transport = make_transport(handler)
    await transport.request("initialize", {})

    await transport.end_session()  # 405 is tolerated per spec
    assert transport.session_id is None


async def test_end_session_raises_on_500():
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}}, **{SESSION_ID_HEADER: "s"}
            ),
            "DELETE": lambda req: httpx.Response(500),
        }
    )
    transport = make_transport(handler)
    await transport.request("initialize", {})

    with pytest.raises(McpHttpStatusError):
        await transport.end_session()


async def test_context_manager_closes_session_on_exit():
    deletes: List[httpx.Request] = []
    handler = RecordingHandler(
        {
            "initialize": lambda req, body: json_response(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}}, **{SESSION_ID_HEADER: "ctx"}
            ),
            "DELETE": lambda req: deletes.append(req) or httpx.Response(200),
        }
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async with StreamableHttpTransport(ENDPOINT, client=client) as transport:
        await transport.request("initialize", {})

    assert len(deletes) == 1  # leaving the context tore the session down


# ===========================================================================
# Transport security (Origin / HTTPS)
# ===========================================================================


def test_plain_http_to_loopback_is_allowed():
    # Local reference servers run http:// on loopback — must be permitted.
    for host in ("http://127.0.0.1:9000/mcp", "http://localhost:9000/mcp", "http://[::1]:9000/mcp"):
        t = StreamableHttpTransport(host)
        assert t.url == host


def test_plain_http_to_public_host_is_rejected():
    with pytest.raises(McpTransportError, match="non-loopback"):
        StreamableHttpTransport("http://mcp.example.com/mcp")


def test_plain_http_public_host_allowed_with_opt_in():
    t = StreamableHttpTransport("http://internal.host/mcp", allow_insecure_http=True)
    assert t.url == "http://internal.host/mcp"


def test_unsupported_scheme_is_rejected():
    with pytest.raises(McpTransportError, match="scheme"):
        StreamableHttpTransport("ftp://mcp.example.com/mcp")


# ===========================================================================
# SSRF guard (private-address ranges)
# ===========================================================================


@pytest.mark.parametrize(
    "url, reason",
    [
        ("https://10.0.0.5/mcp", "private"),
        ("https://192.168.1.10:8443/mcp", "private"),
        ("https://172.16.4.4/mcp", "private"),
        ("https://169.254.169.254/mcp", "link-local"),  # cloud metadata endpoint
        ("https://[fd00::1]/mcp", "private"),  # IPv6 unique-local
        ("https://[::ffff:10.0.0.1]/mcp", "private"),  # IPv4-mapped IPv6 smuggling
    ],
)
def test_private_ip_endpoint_is_blocked(url, reason):
    with pytest.raises(McpSsrfError) as exc:
        StreamableHttpTransport(url)
    assert exc.value.reason == reason
    # SSRF is a transport error so broad except clauses still catch it.
    assert isinstance(exc.value, McpTransportError)


def test_private_ip_endpoint_allowed_with_opt_in():
    t = StreamableHttpTransport("https://10.0.0.5/mcp", allow_private_network=True)
    assert t.url == "https://10.0.0.5/mcp"


def test_loopback_ip_is_exempt_from_ssrf_guard():
    # Loopback is the local reference-server case; never an SSRF block.
    for url in ("http://127.0.0.1:9000/mcp", "http://[::1]:9000/mcp"):
        t = StreamableHttpTransport(url)
        assert t.url == url


def test_public_ip_and_hostname_endpoints_pass_ssrf_guard():
    # A public IP literal and an ordinary hostname (no DNS resolution here) are fine.
    assert StreamableHttpTransport("https://8.8.8.8/mcp").url == "https://8.8.8.8/mcp"
    assert StreamableHttpTransport("https://mcp.example.com/mcp").url == "https://mcp.example.com/mcp"


def test_origin_includes_non_default_port():
    t = StreamableHttpTransport("https://mcp.example.com:8443/mcp")
    assert t.origin == "https://mcp.example.com:8443"


def test_explicit_origin_overrides_default():
    handler = RecordingHandler()
    t = StreamableHttpTransport(
        ENDPOINT,
        origin="https://ade.apiome.dev",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    assert t.origin == "https://ade.apiome.dev"


def test_extra_headers_are_merged():
    handler = RecordingHandler()
    t = StreamableHttpTransport(
        ENDPOINT,
        headers={"X-Trace": "abc"},
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    built = t._build_headers(is_request=True)
    assert built["X-Trace"] == "abc"
