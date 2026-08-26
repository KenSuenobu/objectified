"""Serverless adapter for the portable mock runtime (#4743, PMR-1.3).

Some teams deploy a test mock as a short-lived function rather than as a long-running service.
This module exposes the *same* portable runtime (:mod:`apiome_mock.portable`) through the narrow
function interfaces of the supported providers, so a mock bundle can be answered by an AWS Lambda,
a Google Cloud Run function, or an Azure Function without a container or an open port.

**One behavior, three doors.** The adapter adds no mock semantics of its own. It builds the very
same ASGI application ``apiome-mock run`` serves and drives it in-process, which means routing,
validation, scenarios, chaos, stateful CRUD, fixture packs, ``/health`` and ``/ready`` are the same
code as the hosted and CLI runtimes — the parity argument PMR-1.2 established, extended one door
further. :func:`serverless_sender` runs the shared conformance corpus *through a provider's real
event shape*, so that claim is tested rather than asserted.

**Deterministic invocation.** A bundle is immutable and carries no wall clock, and the adapter adds
no per-invocation entropy, so the same request against the same bundle produces the same response
whichever function instance answers it. The one thing that legitimately differs between instances
is ``X-Mock-Session`` state, which lives in the instance's memory: sessions survive warm
invocations on one instance and are absent on a cold one. That is a property of function
environments, not a defect, and it is surfaced (see ``docs/guide/serverless-mock-adapter.md``)
rather than papered over.

**Cold start.** The bundle is loaded, verified, and compiled once per execution environment, at
import time via :func:`get_adapter`, and reused by every warm invocation. The cost of that is
measured, logged as ``serverless_cold_start``, reported on ``/ready``-style output
(:meth:`ServerlessAdapter.describe`), returned on every response as ``X-Apiome-Mock-Cold-Start-Ms``,
and checked against each provider's published budget by
:mod:`apiome_mock.serverless_preflight`.

**No provider secret in the bundle.** Bundle verification already rejects credential-shaped content
(:mod:`app.mock_bundle`). This module adds a provider-specific layer on top:
:func:`scan_provider_secrets` refuses a bundle carrying an AWS key id, a Google service-account key,
an Azure connection string, or an embedded private key, *before* it is compiled. Provider
credentials are never read from an event either, and the bundle signing secret stays
environment-only, exactly as it is for the CLI runtime.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import structlog

from apiome_mock import __version__
from apiome_mock.bundle import LoadedBundle, MockBundleError, load_bundle_document
from apiome_mock.conformance import ConformanceRequest, ConformanceResponse, Sender
from apiome_mock.portable import create_portable_app, version_prefix
from apiome_mock.portable_config import PortableSettings
from apiome_mock.problems import PROBLEM_BASE, PROBLEM_CONTENT_TYPE
from apiome_mock.serverless_providers import (
    FunctionRequest,
    FunctionResponse,
    Provider,
    provider_for,
)

__all__ = [
    "PROVIDER_SECRET_PATTERNS",
    "ColdStart",
    "ProviderSecretError",
    "SecretFinding",
    "ServerlessAdapter",
    "ServerlessBundle",
    "asgi_app",
    "aws_lambda_handler",
    "azure_functions_handler",
    "create_adapter",
    "dispatch",
    "gcp_functions_handler",
    "get_adapter",
    "handler_for",
    "load_serverless_bundle",
    "reset_adapter",
    "scan_provider_secrets",
    "serverless_sender",
]

_log = structlog.get_logger(__name__)


# ==================================================================================================
# Provider secrets must never travel inside a bundle
# ==================================================================================================


@dataclass(frozen=True)
class SecretFinding:
    """One provider credential found inside a bundle document.

    Attributes:
        code: Stable machine-readable id of what was matched.
        detail: What the match means, phrased for whoever has to remove it.
        pointer: JSON pointer to the offending location in the bundle document.
    """

    code: str
    detail: str
    pointer: str

    def as_dict(self) -> dict[str, Any]:
        """Render the finding for JSON output."""
        return {"code": self.code, "detail": self.detail, "pointer": self.pointer}


#: Value patterns that identify a *provider* credential, whatever key it hangs off.
#:
#: The bundle format already drops and re-checks credential-shaped **keys** (``token``, ``secret``,
#: ``password``…). These patterns are the complement: values that are unmistakably a cloud
#: credential even under an innocent key such as ``example`` or ``default``, which is exactly how a
#: real key reaches a spec — pasted into a request example, not into a field named ``secret``.
PROVIDER_SECRET_PATTERNS: tuple[tuple[str, str, "re.Pattern[str]"], ...] = (
    (
        "aws-access-key-id",
        "An AWS access key id (AKIA…/ASIA…) is embedded in the bundle.",
        re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])"),
    ),
    (
        "gcp-service-account-key",
        "A Google service-account key document is embedded in the bundle.",
        re.compile(r"\"type\"\s*:\s*\"service_account\"|\"private_key_id\"\s*:"),
    ),
    (
        "gcp-api-key",
        "A Google API key (AIza…) is embedded in the bundle.",
        re.compile(r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"),
    ),
    (
        "azure-shared-key",
        "An Azure storage connection string or shared access key is embedded in the bundle.",
        re.compile(r"AccountKey\s*=|SharedAccessKey\s*=|DefaultEndpointsProtocol\s*=", re.IGNORECASE),
    ),
    (
        "private-key-block",
        "A PEM private key block is embedded in the bundle.",
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ),
)


class ProviderSecretError(MockBundleError):
    """A bundle carries a provider credential and must not be deployed as a function.

    Attributes:
        findings: What was matched and where.
    """

    def __init__(self, message: str, findings: tuple[SecretFinding, ...]) -> None:
        super().__init__(message)
        self.findings = findings

    def as_dict(self) -> dict[str, Any]:
        """Render the failure for structured logging or CLI JSON output."""
        return {"error": str(self), "findings": [finding.as_dict() for finding in self.findings]}


def _escape_pointer(segment: str) -> str:
    """Escape one JSON pointer segment (RFC 6901)."""
    return segment.replace("~", "~0").replace("/", "~1")


def scan_provider_secrets(value: Any, *, pointer: str = "") -> tuple[SecretFinding, ...]:
    """Find provider credentials anywhere in a bundle document.

    Every string in the document — keys included, since a key can itself be a pasted credential —
    is matched against :data:`PROVIDER_SECRET_PATTERNS`.

    Args:
        value: The parsed bundle document, or any sub-document.
        pointer: JSON pointer of ``value`` within the document, used to build findings' pointers.

    Returns:
        One finding per (location, pattern) match, in document order. Empty means clean.
    """
    findings: list[SecretFinding] = []
    _walk_for_secrets(value, pointer, findings)
    return tuple(findings)


def _walk_for_secrets(value: Any, pointer: str, found: list[SecretFinding]) -> None:
    """Recursive worker for :func:`scan_provider_secrets`."""
    if isinstance(value, Mapping):
        # A pasted service-account key survives JSON parsing as structure rather than as text, so
        # the value patterns below would never see it; the shape is what identifies it.
        if str(value.get("type", "")) == "service_account":
            found.append(
                SecretFinding(
                    code="gcp-service-account-key",
                    detail="A Google service-account key document is embedded in the bundle.",
                    pointer=pointer or "/",
                )
            )
        for key, child in value.items():
            child_pointer = f"{pointer}/{_escape_pointer(str(key))}"
            _match_secret(str(key), child_pointer, found)
            _walk_for_secrets(child, child_pointer, found)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            _walk_for_secrets(child, f"{pointer}/{index}", found)
        return
    if isinstance(value, str):
        _match_secret(value, pointer or "/", found)


def _match_secret(text: str, pointer: str, found: list[SecretFinding]) -> None:
    """Record a finding for every pattern that matches ``text``."""
    for code, detail, pattern in PROVIDER_SECRET_PATTERNS:
        if pattern.search(text):
            found.append(SecretFinding(code=code, detail=detail, pointer=pointer))


# ==================================================================================================
# Loading a bundle for a function environment
# ==================================================================================================


@dataclass(frozen=True)
class ServerlessBundle:
    """A verified bundle plus the deployment fact a function environment cares about.

    Attributes:
        bundle: The verified, compiled bundle.
        document_bytes: On-disk size of the bundle document, which counts against the provider's
            deployment package limit.
        path: Where it was read from.
    """

    bundle: LoadedBundle
    document_bytes: int
    path: Path


def load_serverless_bundle(
    path: str | Path,
    *,
    secret: str | None = None,
    require_signature: bool = False,
) -> ServerlessBundle:
    """Read, scan, verify, and compile a bundle for use inside a function.

    The provider-secret scan runs **before** verification and compilation, so a bundle carrying a
    cloud credential is rejected at the earliest possible point rather than being served and only
    noticed later.

    Args:
        path: Filesystem path of the bundle JSON document.
        secret: Shared HMAC secret the bundle signature must verify against, read from the
            environment by the caller — never from the event, and never from the bundle itself.
        require_signature: Reject an unsigned bundle.

    Returns:
        The verified bundle and its on-disk size.

    Raises:
        ProviderSecretError: The bundle carries a provider credential.
        MockBundleIncompatibleError: The bundle targets a different runtime version.
        MockBundleError: The file is missing, is not JSON, or fails verification.
    """
    bundle_path = Path(path)
    try:
        raw = bundle_path.read_bytes()
    except OSError as exc:
        raise MockBundleError(f"Mock bundle could not be read ({bundle_path}): {exc}") from exc
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MockBundleError(f"Mock bundle ({bundle_path}) is not valid JSON: {exc}") from exc

    findings = scan_provider_secrets(document)
    if findings:
        pointers = ", ".join(f"{finding.pointer} [{finding.code}]" for finding in findings)
        raise ProviderSecretError(
            f"Mock bundle ({bundle_path}) carries provider credentials and must not be deployed "
            f"as a function: {pointers}",
            findings,
        )

    bundle = load_bundle_document(document, secret=secret, require_signature=require_signature, source=bundle_path)

    # Fixtures travel base64-encoded, so the document scan above cannot see inside them; they are
    # re-scanned once decoded rather than trusted for having been unreadable.
    fixture_findings = scan_provider_secrets(dict(bundle.fixture_data), pointer="/fixtures")
    if fixture_findings:
        pointers = ", ".join(f"{finding.pointer} [{finding.code}]" for finding in fixture_findings)
        raise ProviderSecretError(
            f"Mock bundle ({bundle_path}) carries provider credentials inside its fixtures and "
            f"must not be deployed as a function: {pointers}",
            fixture_findings,
        )

    return ServerlessBundle(bundle=bundle, document_bytes=len(raw), path=bundle_path)


# ==================================================================================================
# ASGI bridge
# ==================================================================================================


class _AsgiBridge:
    """Drives an ASGI application in-process, one request at a time.

    A function invocation is a synchronous call with no server underneath it, so the adapter owns
    the event loop the application runs on. The loop is created once per execution environment and
    reused, because creating one per invocation would repay part of the cold-start cost on every
    warm request.

    Invocations are serialized behind a lock: an ASGI application is safe to call concurrently, but
    a single event loop driven by ``run_until_complete`` is not, and providers that allow more than
    one concurrent request per instance (Cloud Run functions) would otherwise reenter it.
    """

    def __init__(self, app: Any) -> None:
        """Create the bridge and run the application's lifespan startup.

        Args:
            app: The ASGI application to drive.

        Raises:
            RuntimeError: The application's startup failed, which must fail the cold start rather
                than answer every request with a half-initialized app.
        """
        self._app = app
        self._loop = asyncio.new_event_loop()
        self._lock = threading.Lock()
        self._lifespan_task: "asyncio.Future[Any] | None" = None
        self._to_app: asyncio.Queue[dict[str, Any]] | None = None
        self._from_app: asyncio.Queue[dict[str, Any]] | None = None
        self._loop.run_until_complete(self._startup())

    async def _startup(self) -> None:
        """Run the ASGI lifespan startup phase and leave the lifespan task running."""
        to_app: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        from_app: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._to_app, self._from_app = to_app, from_app

        async def receive() -> dict[str, Any]:
            return await to_app.get()

        async def send(message: dict[str, Any]) -> None:
            await from_app.put(message)

        scope = {"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}, "state": {}}
        self._lifespan_task = asyncio.ensure_future(self._app(scope, receive, send))
        await to_app.put({"type": "lifespan.startup"})
        message = await from_app.get()
        if message.get("type") == "lifespan.startup.failed":
            raise RuntimeError(f"Mock runtime startup failed: {message.get('message', '')}")

    def invoke(self, request: FunctionRequest) -> FunctionResponse:
        """Send one request through the application and collect the response.

        Args:
            request: The normalized request.

        Returns:
            The response the application produced.
        """
        with self._lock:
            return self._loop.run_until_complete(self._call(request))

    async def _call(self, request: FunctionRequest) -> FunctionResponse:
        """Run one HTTP scope through the application."""
        body_pending = True

        async def receive() -> dict[str, Any]:
            nonlocal body_pending
            if body_pending:
                body_pending = False
                return {"type": "http.request", "body": request.body, "more_body": False}
            return {"type": "http.disconnect"}

        messages: list[Mapping[str, Any]] = []

        async def send(message: Mapping[str, Any]) -> None:
            messages.append(message)

        await self._app(_http_scope(request), receive, send)
        return _response_from_messages(messages)

    def close(self) -> None:
        """Run lifespan shutdown and close the loop.

        A function environment is frozen rather than shut down, so this exists for tests and for
        local runs; nothing calls it on the invocation path.
        """
        with self._lock:
            if self._loop.is_closed():
                return
            if self._to_app is not None and self._from_app is not None and self._lifespan_task is not None:
                self._loop.run_until_complete(self._shutdown())
            self._loop.close()

    async def _shutdown(self) -> None:
        """Run the ASGI lifespan shutdown phase and await the lifespan task."""
        assert self._to_app is not None and self._from_app is not None and self._lifespan_task is not None
        await self._to_app.put({"type": "lifespan.shutdown"})
        await self._from_app.get()
        await self._lifespan_task


def _http_scope(request: FunctionRequest) -> dict[str, Any]:
    """Build the ASGI HTTP scope for one normalized request."""
    host = request.header("host") or "localhost"
    hostname, _, port_text = host.partition(":")
    try:
        port = int(port_text) if port_text else (443 if request.scheme == "https" else 80)
    except ValueError:
        port = 443 if request.scheme == "https" else 80
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": request.method.upper(),
        "scheme": request.scheme,
        "path": request.path,
        "raw_path": request.path.encode("utf-8"),
        "root_path": "",
        "query_string": request.query_string.encode("latin-1"),
        "headers": [(key.encode("latin-1"), value.encode("latin-1")) for key, value in request.headers],
        "client": (request.client_ip or "127.0.0.1", 0),
        "server": (hostname or "localhost", port),
        "state": {},
    }


def _response_from_messages(messages: Sequence[Mapping[str, Any]]) -> FunctionResponse:
    """Assemble the ASGI response messages into a :class:`FunctionResponse`.

    Args:
        messages: Everything the application sent, in order.

    Returns:
        The response.

    Raises:
        RuntimeError: The application never started a response, which is an application bug rather
            than a request the caller can fix.
    """
    status: int | None = None
    headers: tuple[tuple[str, str], ...] = ()
    body = bytearray()
    for message in messages:
        if message.get("type") == "http.response.start":
            status = int(message.get("status", 500))
            headers = tuple(
                (bytes(key).decode("latin-1").lower(), bytes(value).decode("latin-1"))
                for key, value in message.get("headers", [])
            )
        elif message.get("type") == "http.response.body":
            body.extend(bytes(message.get("body", b"") or b""))
    if status is None:
        raise RuntimeError("Mock runtime produced no response.")
    return FunctionResponse(status=status, headers=headers, body=bytes(body))


# ==================================================================================================
# The adapter
# ==================================================================================================


@dataclass(frozen=True)
class ColdStart:
    """What one execution environment paid to become ready.

    Attributes:
        bundle_ms: Reading, scanning, verifying, and compiling the bundle.
        app_ms: Building the ASGI application and running its lifespan startup.
        total_ms: Everything, which is what a provider's initialization budget is spent against.
    """

    bundle_ms: float
    app_ms: float
    total_ms: float

    def as_dict(self) -> dict[str, float]:
        """Render the measurement for JSON output and logs."""
        return {
            "bundleMs": round(self.bundle_ms, 3),
            "appMs": round(self.app_ms, 3),
            "totalMs": round(self.total_ms, 3),
        }


class ServerlessAdapter:
    """One execution environment's compiled mock, reused by every invocation it serves.

    Attributes:
        bundle: The verified bundle being served.
        settings: The resolved portable settings the app was built with.
        app: The ASGI application — the same one ``apiome-mock run`` serves over HTTP.
        document_bytes: On-disk size of the bundle document.
        cold_start: What initialization cost.
        mount: The path prefix the bundle is served under.
    """

    def __init__(self, serverless_bundle: ServerlessBundle, settings: PortableSettings, *, bundle_ms: float) -> None:
        """Build the application and run its startup, timing the whole thing.

        Args:
            serverless_bundle: The already-loaded bundle and its size.
            settings: Resolved portable settings.
            bundle_ms: Milliseconds already spent loading the bundle, folded into the cold-start
                total so the reported number is the environment's real initialization cost.
        """
        started = time.perf_counter()
        self.bundle = serverless_bundle.bundle
        self.document_bytes = serverless_bundle.document_bytes
        self.settings = settings
        self.mount = version_prefix(self.bundle) if settings.base_path == "version" else ""
        self.app = create_portable_app(self.bundle, settings)
        self._bridge = _AsgiBridge(self.app)
        app_ms = (time.perf_counter() - started) * 1000.0
        self.cold_start = ColdStart(bundle_ms=bundle_ms, app_ms=app_ms, total_ms=bundle_ms + app_ms)
        self._invocations = 0
        self._counter_lock = threading.Lock()

    @property
    def invocations(self) -> int:
        """How many requests this execution environment has answered."""
        return self._invocations

    def invoke(self, request: FunctionRequest, *, remaining_ms: float | None = None) -> FunctionResponse:
        """Serve one request, adding the headers that make a function invocation traceable.

        Args:
            request: The normalized request.
            remaining_ms: Milliseconds left before the provider times the invocation out, when the
                provider reports it. Logged, never used to change the response — a mock that
                behaved differently near its deadline would not be deterministic.

        Returns:
            The response, carrying ``X-Apiome-Mock-Bundle-Digest`` (which bundle answered),
            ``X-Apiome-Mock-Cold-Start`` (whether this invocation paid for initialization), and
            ``X-Apiome-Mock-Cold-Start-Ms`` (what initialization cost this environment).
        """
        with self._counter_lock:
            self._invocations += 1
            cold = self._invocations == 1

        started = time.perf_counter()
        response = self._bridge.invoke(request)
        duration_ms = (time.perf_counter() - started) * 1000.0

        if self.settings.access_log:
            _log.info(
                "serverless_invocation",
                method=request.method,
                path=request.path,
                status=response.status,
                duration_ms=round(duration_ms, 3),
                cold_start=cold,
                remaining_ms=round(remaining_ms, 3) if remaining_ms is not None else None,
                digest=self.bundle.digest,
            )

        return response.with_headers(
            (
                ("x-apiome-mock-runtime", "serverless"),
                ("x-apiome-mock-bundle-digest", self.bundle.digest),
                ("x-apiome-mock-cold-start", "true" if cold else "false"),
                ("x-apiome-mock-cold-start-ms", f"{self.cold_start.total_ms:.3f}"),
            )
        )

    def describe(self) -> dict[str, Any]:
        """Describe the execution environment, the way ``/ready`` describes a served process.

        Returns:
            A JSON-serializable summary: runtime identity, mount, cold-start measurement, and the
            bundle's identity and size. It carries no settings values and no spec bodies, so it is
            safe to log at INFO.
        """
        return {
            "runtime": {"name": "apiome-mock", "version": __version__, "mode": "serverless"},
            "mount": self.mount or "/",
            "coldStart": self.cold_start.as_dict(),
            "invocations": self.invocations,
            "bundle": {
                "digest": self.bundle.digest,
                "tenant": self.bundle.tenant_slug,
                "project": self.bundle.project_slug,
                "version": self.bundle.version_label,
                "signed": self.bundle.signed,
                "operations": len(self.bundle.operations),
                "bytes": self.document_bytes,
            },
        }

    def close(self) -> None:
        """Release the event loop backing the adapter (tests and local runs)."""
        self._bridge.close()


def create_adapter(settings: PortableSettings | None = None) -> ServerlessAdapter:
    """Load the configured bundle and build an adapter for it.

    Args:
        settings: Resolved settings; ``None`` resolves them from the environment alone, which is
            all a function has (there is no command line to pass flags on).

    Returns:
        The ready adapter.

    Raises:
        ValueError: No bundle is configured.
        ProviderSecretError: The bundle carries a provider credential.
        MockBundleError: The bundle is missing, malformed, or fails verification.
    """
    resolved = settings if settings is not None else PortableSettings()
    if not resolved.bundle.strip():
        raise ValueError("No bundle configured. Set APIOME_MOCK_BUNDLE to the bundle to serve.")

    started = time.perf_counter()
    serverless_bundle = load_serverless_bundle(
        resolved.bundle.strip(),
        secret=resolved.bundle_secret,
        require_signature=resolved.require_signature,
    )
    bundle_ms = (time.perf_counter() - started) * 1000.0
    return ServerlessAdapter(serverless_bundle, resolved, bundle_ms=bundle_ms)


_adapter: ServerlessAdapter | None = None
_adapter_lock = threading.Lock()


def get_adapter() -> ServerlessAdapter:
    """Return this execution environment's adapter, building it on first use.

    The result is cached for the life of the process, which is what makes the bundle a cold-start
    cost rather than a per-request one. Construction is guarded by a lock so a provider that starts
    several threads at once still pays for exactly one initialization.

    Returns:
        The process-wide adapter.

    Raises:
        Exception: Whatever :func:`create_adapter` raises. Initialization failures are deliberately
            not swallowed: a function that answers every request with a 500 is far harder to
            diagnose than one whose cold start fails loudly with the bundle problem in the message.
    """
    global _adapter
    if _adapter is not None:
        return _adapter
    with _adapter_lock:
        if _adapter is None:
            adapter = create_adapter()
            _log.info("serverless_cold_start", runtime_version=__version__, **adapter.describe())
            _adapter = adapter
    return _adapter


def reset_adapter() -> None:
    """Drop the cached adapter (tests, and re-reading a changed bundle in a local run)."""
    global _adapter
    with _adapter_lock:
        if _adapter is not None:
            _adapter.close()
        _adapter = None


def asgi_app() -> Any:
    """Return the ASGI application for the configured bundle.

    Providers with a native ASGI shim (Azure Functions' ``AsgiFunctionApp``, and any WSGI/ASGI
    host) can serve this directly instead of going through an event handler.

    Returns:
        The portable runtime's ASGI application.
    """
    return get_adapter().app


# ==================================================================================================
# Provider entry points
# ==================================================================================================


def _problem(status: int, title: str, detail: str, problem_type: str, **extra: Any) -> FunctionResponse:
    """Build a problem+json :class:`FunctionResponse` for an adapter-level refusal.

    Adapter-level problems are the ones the mock itself never sees — a malformed event, or a
    payload outside the provider's published limits — so they are rendered here in the same
    RFC 7807 vocabulary the runtime uses for everything else.
    """
    body: dict[str, Any] = {
        "type": f"{PROBLEM_BASE}/{problem_type}",
        "title": title,
        "status": status,
        "detail": detail,
    }
    body.update(extra)
    payload = json.dumps(body).encode("utf-8")
    return FunctionResponse(
        status=status,
        headers=(("content-type", PROBLEM_CONTENT_TYPE), ("content-length", str(len(payload)))),
        body=payload,
    )


def _remaining_ms(context: Any) -> float | None:
    """Read the invocation's remaining time from a provider context object, when it offers one."""
    getter = getattr(context, "get_remaining_time_in_millis", None)
    if getter is None:
        return None
    try:
        return float(getter())
    except Exception:  # noqa: BLE001 - a context that misbehaves must not fail the invocation
        return None


def dispatch(
    provider: Provider,
    event: Any,
    *,
    context: Any = None,
    adapter: ServerlessAdapter | None = None,
) -> Any:
    """Answer one function invocation for a provider.

    The provider's published payload limits are enforced here rather than left to the provider,
    for two reasons: the refusal is then a documented problem+json rather than a provider-shaped
    error page, and the limit becomes something a test can assert.

    Args:
        provider: The provider whose event shape this is.
        event: The provider's event.
        context: The provider's context object, when it passes one.
        adapter: Adapter to serve from; ``None`` uses the process-wide one.

    Returns:
        The value the function should return, in the provider's own shape.
    """
    active = adapter if adapter is not None else get_adapter()
    limits = provider.limits

    try:
        request = provider.decode_request(event)
    except ValueError as exc:
        return provider.encode_response(
            _problem(400, "Bad Request", str(exc), "serverless-event-unsupported"),
            event=event,
        )

    if request.size_bytes > limits.max_request_bytes:
        return provider.encode_response(
            _problem(
                413,
                "Payload Too Large",
                f"The request is {request.size_bytes} bytes; {provider.title} forwards at most "
                f"{limits.max_request_bytes} bytes to a function.",
                "serverless-request-too-large",
                maxRequestBytes=limits.max_request_bytes,
            ),
            event=event,
        )

    response = active.invoke(request, remaining_ms=_remaining_ms(context))

    if response.size_bytes > limits.max_response_bytes:
        _log.warning(
            "serverless_response_too_large",
            provider=provider.name,
            bytes=response.size_bytes,
            limit=limits.max_response_bytes,
            path=request.path,
        )
        return provider.encode_response(
            _problem(
                502,
                "Bad Gateway",
                f"The mock response is {response.size_bytes} bytes; {provider.title} returns at "
                f"most {limits.max_response_bytes} bytes from a function.",
                "serverless-response-too-large",
                maxResponseBytes=limits.max_response_bytes,
            ),
            event=event,
        )

    return provider.encode_response(response, event=event)


def aws_lambda_handler(event: Any, context: Any = None) -> Any:
    """AWS Lambda entry point (API Gateway HTTP API, REST API, ALB, and Function URLs).

    Configure this dotted path as the function handler:
    ``apiome_mock.serverless.aws_lambda_handler``.

    Args:
        event: The API Gateway / ALB event, in payload format 1.0 or 2.0.
        context: The Lambda context object.

    Returns:
        The response envelope, in the payload format the event arrived in.
    """
    return dispatch(provider_for("aws-lambda"), event, context=context)


def gcp_functions_handler(request: Any) -> Any:
    """Google Cloud Run functions entry point (Functions Framework, HTTP trigger).

    Args:
        request: The Flask request the Functions Framework passes.

    Returns:
        The ``(body, status, headers)`` tuple the Functions Framework returns.
    """
    return dispatch(provider_for("gcp-functions"), request)


def azure_functions_handler(req: Any) -> Any:
    """Azure Functions entry point (HTTP trigger with a wildcard route).

    Args:
        req: The ``azure.functions.HttpRequest``.

    Returns:
        An ``azure.functions.HttpResponse``.
    """
    return dispatch(provider_for("azure-functions"), req)


def handler_for(name: str) -> Any:
    """Return the entry point of a supported provider by name.

    Args:
        name: One of :data:`apiome_mock.serverless_providers.PROVIDER_NAMES`.

    Returns:
        The handler callable.

    Raises:
        UnknownProviderError: The provider is not supported.
    """
    handlers = {
        "aws-lambda": aws_lambda_handler,
        "gcp-functions": gcp_functions_handler,
        "azure-functions": azure_functions_handler,
    }
    return handlers[provider_for(name).name]


# ==================================================================================================
# Conformance through a provider's real event shape
# ==================================================================================================


def serverless_sender(adapter: ServerlessAdapter, *, provider: Provider, mount: str | None = None) -> Sender:
    """Build a conformance :data:`~apiome_mock.conformance.Sender` that goes through a provider.

    Each corpus case is encoded into the provider's own event shape, dispatched exactly as a real
    invocation would be, and decoded back from the provider's own return shape. Running the shared
    corpus this way proves what an in-process ASGI call cannot: that the *translation* is faithful,
    and therefore that a function invocation answers a bundle the way every other runtime does.

    Args:
        adapter: The adapter to serve from.
        provider: The provider whose event shape to round-trip through.
        mount: Path prefix the bundle is mounted under; ``None`` uses the adapter's own.

    Returns:
        A sender suitable for :func:`apiome_mock.conformance.run_corpus`.
    """
    prefix = adapter.mount if mount is None else mount

    def send(request: ConformanceRequest) -> ConformanceResponse:
        response: ConformanceResponse | None = None
        for _ in range(request.repeat):
            payload = dispatch(provider, provider.encode_request(_function_request(request, prefix)), adapter=adapter)
            decoded = provider.decode_response(payload)
            response = ConformanceResponse(
                status=decoded.status,
                headers={key: value for key, value in decoded.headers},
                body=decoded.body,
            )
        assert response is not None  # corpus loading validates repeat >= 1
        return response

    return send


def _function_request(request: ConformanceRequest, mount: str) -> FunctionRequest:
    """Translate one corpus request into a :class:`FunctionRequest`."""
    path = request.path if request.absolute else f"{mount.rstrip('/')}{request.path}"
    headers = [(key.lower(), value) for key, value in request.headers.items()]
    body = b""
    if request.json_body is not None:
        body = json.dumps(request.json_body).encode("utf-8")
        if not any(key == "content-type" for key, _ in headers):
            headers.append(("content-type", "application/json"))
    return FunctionRequest(
        method=request.method.upper(),
        path=path or "/",
        query_string=urllib.parse.urlencode(dict(request.query)),
        headers=tuple(headers),
        body=body,
    )
