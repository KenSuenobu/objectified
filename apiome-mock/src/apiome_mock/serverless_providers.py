"""Provider function interfaces for the serverless mock adapter (#4743, PMR-1.3).

A function environment hands a request to user code in its own shape — an API Gateway event dict,
a Flask request object, an ``azure.functions.HttpRequest`` — and expects its own shape back. This
module is the *narrow* translation layer between those shapes and one transport-neutral pair,
:class:`FunctionRequest` / :class:`FunctionResponse`, which :mod:`apiome_mock.serverless` drives
the portable runtime with.

Keeping translation here and behavior there is what makes the adapter narrow: a provider is four
small pure functions and a table of published limits, with **no** mock semantics of its own. Every
request, whichever provider decoded it, reaches the same
:func:`apiome_mock.handler.serve_compiled_request` the hosted and CLI runtimes use.

Each provider implements four methods, in two directions:

Production
    :meth:`Provider.decode_request` (event → :class:`FunctionRequest`) and
    :meth:`Provider.encode_response` (:class:`FunctionResponse` → the provider's return value).
Verification
    :meth:`Provider.encode_request` and :meth:`Provider.decode_response`, the exact inverses. They
    exist so the shared conformance corpus can be run *through a provider's real event shape*
    (``apiome-mock serverless --conformance``) rather than against the ASGI app directly — the only
    way to prove the translation itself is faithful.

:class:`ProviderLimits` is the second half of the module: the published cold-start, payload, size,
and timeout constraints of each environment, as **data** rather than prose, so
:mod:`apiome_mock.serverless_preflight` can check a bundle against them and the guide can render
them without either copy drifting from the other.
"""

from __future__ import annotations

import base64
import json
import urllib.parse
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "PROVIDERS",
    "PROVIDER_NAMES",
    "AwsLambdaProvider",
    "AzureFunctionsProvider",
    "AzureLikeRequest",
    "AzureLikeResponse",
    "FlaskLikeRequest",
    "FunctionRequest",
    "FunctionResponse",
    "GcpFunctionsProvider",
    "Provider",
    "ProviderLimits",
    "UnknownProviderError",
    "provider_for",
]


class UnknownProviderError(LookupError):
    """A provider name that is not one of the supported :data:`PROVIDERS`."""


# ==================================================================================================
# Transport-neutral request/response
# ==================================================================================================


@dataclass(frozen=True)
class FunctionRequest:
    """One HTTP request, normalized out of a provider's event shape.

    Attributes:
        method: Upper-case HTTP method.
        path: Percent-**decoded** absolute path, always starting with ``/``. It includes the mount
            prefix the runtime serves the bundle under, exactly as an HTTP client would send it.
        query_string: Raw, percent-encoded query string with no leading ``?``.
        headers: Header name/value pairs in arrival order. Names are lower-cased; duplicates are
            preserved as separate pairs, because ``Set-Cookie`` and ``Accept`` are not equivalent
            to their comma-joined forms.
        body: Raw request body; empty for bodyless methods.
        scheme: URL scheme the caller used, used only to render absolute URLs.
        client_ip: Caller address when the provider reports one, for logs only.
    """

    method: str
    path: str
    query_string: str = ""
    headers: tuple[tuple[str, str], ...] = ()
    body: bytes = b""
    scheme: str = "https"
    client_ip: str | None = None

    def header(self, name: str) -> str | None:
        """Return the first value of a header, or ``None`` when it is absent.

        Args:
            name: Header name, matched case-insensitively.

        Returns:
            The first matching value, or ``None``.
        """
        wanted = name.lower()
        for key, value in self.headers:
            if key == wanted:
                return value
        return None

    @property
    def size_bytes(self) -> int:
        """Approximate wire size: the body plus the header block.

        Providers meter the whole request, not just the body, so a body-only check would under-read
        the payload limit for a request with large headers.
        """
        header_bytes = sum(len(key) + len(value) + 4 for key, value in self.headers)
        return len(self.body) + header_bytes + len(self.method) + len(self.path) + len(self.query_string)


@dataclass(frozen=True)
class FunctionResponse:
    """One HTTP response, on its way back into a provider's return shape.

    Attributes:
        status: HTTP status code.
        headers: Header name/value pairs, names lower-cased, duplicates preserved.
        body: Raw response body.
    """

    status: int
    headers: tuple[tuple[str, str], ...] = ()
    body: bytes = b""

    def header(self, name: str) -> str | None:
        """Return the first value of a header, or ``None`` when it is absent."""
        wanted = name.lower()
        for key, value in self.headers:
            if key == wanted:
                return value
        return None

    def with_headers(self, extra: Iterable[tuple[str, str]]) -> "FunctionResponse":
        """Return a copy carrying additional headers.

        Args:
            extra: Name/value pairs to append; names are lower-cased.

        Returns:
            A new response — the type is frozen so observability headers never mutate a response
            another caller already holds.
        """
        appended = tuple((key.lower(), value) for key, value in extra)
        return FunctionResponse(status=self.status, headers=self.headers + appended, body=self.body)

    @property
    def size_bytes(self) -> int:
        """Approximate wire size of the response, headers included."""
        return len(self.body) + sum(len(key) + len(value) + 4 for key, value in self.headers)

    def json(self) -> Any:
        """Decode the body as JSON.

        Returns:
            The decoded value, or ``None`` when the body is empty or is not valid JSON.
        """
        if not self.body:
            return None
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None


#: Media types whose bodies travel as text rather than as base64 in event-shaped providers.
_TEXT_MEDIA_PREFIXES: tuple[str, ...] = (
    "text/",
    "application/json",
    "application/problem+json",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "application/yaml",
)


def _is_text_media_type(content_type: str | None) -> bool:
    """Is a body with this content type safe to carry as a JSON string?"""
    if not content_type:
        return False
    base = content_type.split(";")[0].strip().lower()
    return base.endswith("+json") or base.endswith("+xml") or base.startswith(_TEXT_MEDIA_PREFIXES)


def _encode_body(response: FunctionResponse) -> tuple[str, bool]:
    """Render a response body for a JSON event envelope.

    Args:
        response: The response whose body is being rendered.

    Returns:
        ``(body, is_base64)``. Textual bodies that decode as UTF-8 travel as-is, which keeps event
        payloads readable in provider logs; anything else is base64, which is the only lossless
        option inside a JSON envelope.
    """
    if not response.body:
        return "", False
    if _is_text_media_type(response.header("content-type")):
        try:
            return response.body.decode("utf-8"), False
        except UnicodeDecodeError:  # pragma: no cover - a mislabeled text body is provider-agnostic
            pass
    return base64.b64encode(response.body).decode("ascii"), True


def _decode_body(body: Any, *, is_base64: bool) -> bytes:
    """Decode an event envelope's body field into raw bytes."""
    if body is None or body == "":
        return b""
    if isinstance(body, (bytes, bytearray)):
        return bytes(body)
    text = str(body)
    return base64.b64decode(text) if is_base64 else text.encode("utf-8")


def _single_headers(headers: Sequence[tuple[str, str]]) -> dict[str, str]:
    """Collapse header pairs into the single-valued map event envelopes carry.

    Duplicates are comma-joined, which is the representation every provider uses for its
    single-valued header map.
    """
    collapsed: dict[str, str] = {}
    for key, value in headers:
        collapsed[key] = f"{collapsed[key]}, {value}" if key in collapsed else value
    return collapsed


def _multi_headers(headers: Sequence[tuple[str, str]]) -> dict[str, list[str]]:
    """Group header pairs into the multi-valued map API Gateway v1 and ALB accept."""
    grouped: dict[str, list[str]] = {}
    for key, value in headers:
        grouped.setdefault(key, []).append(value)
    return grouped


def _pairs_from_mapping(headers: Any) -> tuple[tuple[str, str], ...]:
    """Normalize any mapping-ish or pair-iterable header collection into lower-cased pairs."""
    if headers is None:
        return ()
    items: Iterable[Any]
    if isinstance(headers, Mapping):
        items = headers.items()
    else:
        items = headers
    pairs: list[tuple[str, str]] = []
    for item in items:
        key, value = item
        if isinstance(value, (list, tuple)):
            pairs.extend((str(key).lower(), str(entry)) for entry in value)
        else:
            pairs.append((str(key).lower(), str(value)))
    return tuple(pairs)


# ==================================================================================================
# Published provider limits
# ==================================================================================================


@dataclass(frozen=True)
class ProviderLimits:
    """The published constraints of one function environment.

    Every field is a *provider-published* number rather than a measurement of this runtime, so the
    table can be checked against the provider's documentation without re-running anything. It is
    data on purpose: :mod:`apiome_mock.serverless_preflight` checks a bundle against it and
    ``docs/guide/serverless-mock-adapter.md`` renders the same values, so the two cannot drift.

    Attributes:
        max_package_bytes: Largest deployable code package, uncompressed. The mock bundle is only
            part of it — the runtime and its dependencies share the same budget.
        max_request_bytes: Largest request payload the front door will forward.
        max_response_bytes: Largest response payload the function may return.
        max_function_timeout_seconds: Longest a single invocation may run.
        max_gateway_timeout_seconds: Longest the front door will wait for the function; the
            *effective* deadline for an HTTP mock, and usually far shorter than the function's own.
        max_init_seconds: Budget for the cold-start initialization phase, when the provider meters
            one separately; ``None`` when initialization is simply charged to the first invocation.
        docs_url: The provider's own limits page.
        verified_on: ISO date these values were last read from that page.
        notes: Environment-specific caveats worth surfacing next to the numbers.
    """

    max_package_bytes: int
    max_request_bytes: int
    max_response_bytes: int
    max_function_timeout_seconds: int
    max_gateway_timeout_seconds: int
    max_init_seconds: float | None
    docs_url: str
    verified_on: str
    notes: tuple[str, ...] = ()

    @property
    def cold_start_budget_seconds(self) -> float:
        """The deadline a cold start actually has to beat.

        Returns:
            The metered initialization budget when the provider has one, otherwise the front door's
            timeout — because where initialization is not metered separately it is charged to the
            first request, which the gateway is already timing.
        """
        if self.max_init_seconds is not None:
            return float(self.max_init_seconds)
        return float(self.max_gateway_timeout_seconds)

    def as_dict(self) -> dict[str, Any]:
        """Render the limits for JSON output."""
        return {
            "maxPackageBytes": self.max_package_bytes,
            "maxRequestBytes": self.max_request_bytes,
            "maxResponseBytes": self.max_response_bytes,
            "maxFunctionTimeoutSeconds": self.max_function_timeout_seconds,
            "maxGatewayTimeoutSeconds": self.max_gateway_timeout_seconds,
            "maxInitSeconds": self.max_init_seconds,
            "coldStartBudgetSeconds": self.cold_start_budget_seconds,
            "docsUrl": self.docs_url,
            "verifiedOn": self.verified_on,
            "notes": list(self.notes),
        }


# ==================================================================================================
# Provider interface
# ==================================================================================================


@dataclass(frozen=True)
class Provider(ABC):
    """One supported function environment.

    Attributes:
        name: Stable id used on the command line and in reports.
        title: Human name for docs and CLI output.
        entrypoint: Dotted path of the handler to configure in the provider's console or manifest.
        payload_formats: Event shapes the provider is wired up with.
        limits: The environment's published constraints.
    """

    name: str
    title: str
    entrypoint: str
    payload_formats: tuple[str, ...]
    limits: ProviderLimits

    @abstractmethod
    def decode_request(self, event: Any) -> FunctionRequest:
        """Normalize a provider event into a :class:`FunctionRequest`.

        Args:
            event: Whatever the provider hands the function.

        Returns:
            The normalized request.

        Raises:
            ValueError: The event is not a shape this provider understands.
        """

    @abstractmethod
    def encode_response(self, response: FunctionResponse, *, event: Any = None) -> Any:
        """Render a :class:`FunctionResponse` in the provider's return shape.

        Args:
            response: The response the runtime produced.
            event: The event being answered, when the return shape depends on the request shape
                (API Gateway's payload format versions differ on both sides).

        Returns:
            The value the function should return.
        """

    @abstractmethod
    def encode_request(self, request: FunctionRequest) -> Any:
        """Build a provider event from a :class:`FunctionRequest` (verification direction).

        This is the inverse of :meth:`decode_request`, used to drive the shared conformance corpus
        through a provider's real event shape.

        Args:
            request: The request to encode.

        Returns:
            An event of the shape :meth:`decode_request` accepts.
        """

    @abstractmethod
    def decode_response(self, payload: Any) -> FunctionResponse:
        """Normalize a provider return value back into a :class:`FunctionResponse`.

        This is the inverse of :meth:`encode_response`, used by the same verification path.

        Args:
            payload: A value produced by :meth:`encode_response`.

        Returns:
            The normalized response.
        """

    def as_dict(self) -> dict[str, Any]:
        """Render the provider's identity and limits for JSON output."""
        return {
            "name": self.name,
            "title": self.title,
            "entrypoint": self.entrypoint,
            "payloadFormats": list(self.payload_formats),
            "limits": self.limits.as_dict(),
        }


# ==================================================================================================
# AWS Lambda
# ==================================================================================================

AWS_LIMITS = ProviderLimits(
    max_package_bytes=250 * 1024 * 1024,
    max_request_bytes=10 * 1024 * 1024,
    max_response_bytes=6 * 1024 * 1024,
    max_function_timeout_seconds=900,
    max_gateway_timeout_seconds=29,
    max_init_seconds=10.0,
    docs_url="https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html",
    verified_on="2026-08-26",
    notes=(
        "The 10s initialization budget is separate from the invocation timeout; exceeding it makes "
        "Lambda re-run initialization inside the first invocation, which then pays for it twice.",
        "API Gateway's 29s integration timeout, not the function's 900s, is the deadline an HTTP mock actually has.",
        "Deploy the bundle inside the package or a layer, never from S3 at init time: a network "
        "read at cold start is what turns a fast mock into a flaky one.",
    ),
)


@dataclass(frozen=True)
class AwsLambdaProvider(Provider):
    """API Gateway / Lambda Function URL / ALB events, payload format 1.0 and 2.0.

    Both payload formats are decoded, distinguished the way AWS itself distinguishes them: format
    2.0 declares ``version: "2.0"`` and carries the method under ``requestContext.http``, while
    1.0 (REST API and ALB) carries ``httpMethod`` at the top level. The response is rendered in
    whichever format the event used, so one handler serves either wiring.

    Attributes:
        payload_format: Format :meth:`encode_request` builds; decoding always accepts both.
    """

    payload_format: str = "2.0"

    def decode_request(self, event: Any) -> FunctionRequest:
        """Normalize an API Gateway, Function URL, or ALB event."""
        if not isinstance(event, Mapping):
            raise ValueError("AWS Lambda events must be JSON objects.")
        if str(event.get("version", "")) == "2.0":
            return self._decode_v2(event)
        if "httpMethod" in event:
            return self._decode_v1(event)
        raise ValueError(
            "Unrecognized AWS event: expected payload format 2.0 (version: '2.0') or 1.0 (top-level httpMethod)."
        )

    def _decode_v2(self, event: Mapping[str, Any]) -> FunctionRequest:
        """Decode payload format 2.0 (HTTP API and Lambda Function URLs)."""
        context = _sub_mapping(event, "requestContext")
        http = _sub_mapping(context, "http")
        headers = _pairs_from_mapping(event.get("headers"))
        cookies = [str(cookie) for cookie in list(event.get("cookies") or [])]
        if cookies:
            # Format 2.0 lifts cookies out of the header map; the app expects them back in it.
            headers = headers + (("cookie", "; ".join(cookies)),)
        raw_path = str(event.get("rawPath") or http.get("path") or "/")
        return FunctionRequest(
            method=str(http.get("method") or "GET").upper(),
            path=_normalize_path(urllib.parse.unquote(raw_path)),
            query_string=str(event.get("rawQueryString") or ""),
            headers=headers,
            body=_decode_body(event.get("body"), is_base64=bool(event.get("isBase64Encoded"))),
            client_ip=str(http.get("sourceIp")) if http.get("sourceIp") else None,
        )

    def _decode_v1(self, event: Mapping[str, Any]) -> FunctionRequest:
        """Decode payload format 1.0 (REST API and Application Load Balancer)."""
        multi_headers = event.get("multiValueHeaders")
        headers = _pairs_from_mapping(multi_headers if isinstance(multi_headers, Mapping) else event.get("headers"))
        multi_query = event.get("multiValueQueryStringParameters")
        query = multi_query if isinstance(multi_query, Mapping) else event.get("queryStringParameters")
        identity = _sub_mapping(_sub_mapping(event, "requestContext"), "identity")
        return FunctionRequest(
            method=str(event.get("httpMethod") or "GET").upper(),
            path=_normalize_path(str(event.get("path") or "/")),
            query_string=_query_string(query),
            headers=headers,
            body=_decode_body(event.get("body"), is_base64=bool(event.get("isBase64Encoded"))),
            client_ip=str(identity.get("sourceIp")) if identity.get("sourceIp") else None,
        )

    def encode_response(self, response: FunctionResponse, *, event: Any = None) -> dict[str, Any]:
        """Render the response in the payload format the event arrived in."""
        body, is_base64 = _encode_body(response)
        version = str(event.get("version", "")) if isinstance(event, Mapping) else self.payload_format
        if version == "2.0" or (event is None and self.payload_format == "2.0"):
            cookies = [value for key, value in response.headers if key == "set-cookie"]
            visible = [(key, value) for key, value in response.headers if key != "set-cookie"]
            payload: dict[str, Any] = {
                "statusCode": response.status,
                "headers": _single_headers(visible),
                "body": body,
                "isBase64Encoded": is_base64,
            }
            if cookies:
                payload["cookies"] = cookies
            return payload
        return {
            "statusCode": response.status,
            "headers": _single_headers(response.headers),
            "multiValueHeaders": _multi_headers(response.headers),
            "body": body,
            "isBase64Encoded": is_base64,
        }

    def encode_request(self, request: FunctionRequest) -> dict[str, Any]:
        """Build an event in :attr:`payload_format` (verification direction)."""
        if self.payload_format == "2.0":
            cookies = [value for key, value in request.headers if key == "cookie"]
            headers = _single_headers([(key, value) for key, value in request.headers if key != "cookie"])
            return {
                "version": "2.0",
                "routeKey": "$default",
                "rawPath": urllib.parse.quote(request.path),
                "rawQueryString": request.query_string,
                "cookies": cookies,
                "headers": headers,
                "requestContext": {
                    "http": {
                        "method": request.method,
                        "path": request.path,
                        "sourceIp": request.client_ip or "127.0.0.1",
                    }
                },
                **_body_fields(request.body, request.header("content-type")),
            }
        return {
            "version": "1.0",
            "httpMethod": request.method,
            "path": request.path,
            "headers": _single_headers(request.headers),
            "multiValueHeaders": _multi_headers(request.headers),
            "queryStringParameters": _query_parameters(request.query_string),
            "requestContext": {"identity": {"sourceIp": request.client_ip or "127.0.0.1"}},
            **_body_fields(request.body, request.header("content-type")),
        }

    def decode_response(self, payload: Any) -> FunctionResponse:
        """Normalize an API Gateway response envelope back into a response."""
        if not isinstance(payload, Mapping):
            raise ValueError("AWS Lambda responses must be JSON objects.")
        multi = payload.get("multiValueHeaders")
        headers = _pairs_from_mapping(multi if isinstance(multi, Mapping) else payload.get("headers"))
        headers = headers + tuple(("set-cookie", str(cookie)) for cookie in list(payload.get("cookies") or []))
        return FunctionResponse(
            status=int(payload.get("statusCode", 200)),
            headers=headers,
            body=_decode_body(payload.get("body"), is_base64=bool(payload.get("isBase64Encoded"))),
        )


# ==================================================================================================
# Google Cloud (Cloud Run functions / Functions Framework)
# ==================================================================================================

GCP_LIMITS = ProviderLimits(
    max_package_bytes=500 * 1024 * 1024,
    max_request_bytes=32 * 1024 * 1024,
    max_response_bytes=32 * 1024 * 1024,
    max_function_timeout_seconds=3600,
    max_gateway_timeout_seconds=3600,
    max_init_seconds=None,
    docs_url="https://cloud.google.com/functions/quotas",
    verified_on="2026-08-26",
    notes=(
        "Initialization is not metered separately: a cold start is charged to the request that "
        "triggers it, so the bundle must compile well inside the request timeout.",
        "Concurrency above 1 sends parallel requests into one instance; the adapter serializes "
        "them, so raise instances rather than concurrency for a mock under load.",
    ),
)


@dataclass(frozen=True)
class FlaskLikeRequest:
    """The subset of a Flask/Werkzeug request the Functions Framework hands an HTTP function.

    Instances are built by :meth:`GcpFunctionsProvider.encode_request` so the conformance corpus
    can run without Flask installed. Production traffic arrives as a real Flask request, which
    exposes the same four members and is therefore decoded by the same code.

    Attributes:
        method: HTTP method.
        path: Percent-decoded path.
        query_string: Raw query string as bytes, matching Werkzeug.
        headers: Header pairs.
        data: Raw request body.
    """

    method: str
    path: str
    query_string: bytes = b""
    headers: tuple[tuple[str, str], ...] = ()
    data: bytes = b""

    def get_data(self) -> bytes:
        """Return the raw request body, as Werkzeug's ``get_data()`` does."""
        return self.data


@dataclass(frozen=True)
class GcpFunctionsProvider(Provider):
    """Google Cloud Run functions (Functions Framework for Python), HTTP trigger.

    The Functions Framework passes a Flask request and accepts a ``(body, status, headers)`` tuple
    back, so this provider duck-types both sides: nothing here imports Flask, which keeps the
    runtime's dependency set identical whether or not it is deployed to Google.
    """

    def decode_request(self, event: Any) -> FunctionRequest:
        """Normalize a Flask-shaped request object."""
        for attribute in ("method", "path", "headers"):
            if not hasattr(event, attribute):
                raise ValueError(f"Google Cloud function requests must expose '{attribute}'.")
        raw_query = getattr(event, "query_string", b"") or b""
        query_string = raw_query.decode("latin-1") if isinstance(raw_query, (bytes, bytearray)) else str(raw_query)
        body = event.get_data() if hasattr(event, "get_data") else b""
        return FunctionRequest(
            method=str(event.method).upper(),
            path=_normalize_path(str(event.path)),
            query_string=query_string.lstrip("?"),
            headers=_pairs_from_mapping(_header_items(event.headers)),
            body=bytes(body or b""),
            client_ip=getattr(event, "remote_addr", None),
        )

    def encode_response(
        self, response: FunctionResponse, *, event: Any = None
    ) -> tuple[bytes, int, list[tuple[str, str]]]:
        """Render the ``(body, status, headers)`` tuple the Functions Framework returns."""
        return (response.body, response.status, [(key, value) for key, value in response.headers])

    def encode_request(self, request: FunctionRequest) -> FlaskLikeRequest:
        """Build a Flask-shaped stand-in request (verification direction)."""
        return FlaskLikeRequest(
            method=request.method,
            path=request.path,
            query_string=request.query_string.encode("latin-1"),
            headers=request.headers,
            data=request.body,
        )

    def decode_response(self, payload: Any) -> FunctionResponse:
        """Normalize the ``(body, status, headers)`` tuple back into a response."""
        if not isinstance(payload, tuple) or len(payload) != 3:
            raise ValueError("Google Cloud function responses must be (body, status, headers) tuples.")
        body, status, headers = payload
        raw = body if isinstance(body, (bytes, bytearray)) else str(body).encode("utf-8")
        return FunctionResponse(status=int(status), headers=_pairs_from_mapping(headers), body=bytes(raw))


# ==================================================================================================
# Azure Functions
# ==================================================================================================

AZURE_LIMITS = ProviderLimits(
    max_package_bytes=1024 * 1024 * 1024,
    max_request_bytes=100 * 1024 * 1024,
    max_response_bytes=100 * 1024 * 1024,
    max_function_timeout_seconds=600,
    max_gateway_timeout_seconds=230,
    max_init_seconds=None,
    docs_url="https://learn.microsoft.com/azure/azure-functions/functions-scale#service-limits",
    verified_on="2026-08-26",
    notes=(
        "The 230s front-door idle timeout is fixed and cannot be raised, whatever functionTimeout is set to.",
        "The Consumption plan's 600s function timeout is its maximum, not its default (5 minutes).",
        "Run the package from a mounted archive so the bundle is present at initialization instead "
        "of being fetched during it.",
    ),
)


@dataclass(frozen=True)
class AzureLikeResponse:
    """The response shape used when ``azure.functions`` is not importable.

    The real ``azure.functions.HttpResponse`` is constructed when the SDK is present (a deployed
    function always has it). This stand-in keeps the conformance corpus runnable in an environment
    that has no reason to install the SDK — a developer laptop, or CI for this repository.

    Attributes:
        body: Raw response body.
        status_code: HTTP status code.
        headers: Response headers.
    """

    body: bytes
    status_code: int
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class AzureLikeRequest:
    """The subset of ``azure.functions.HttpRequest`` an HTTP-triggered function reads.

    Built by :meth:`AzureFunctionsProvider.encode_request` for the verification path; production
    traffic arrives as the SDK's own ``HttpRequest``, which exposes the same members.

    Attributes:
        method: HTTP method.
        url: Absolute request URL, as the SDK reports it.
        headers: Header pairs.
        body: Raw request body.
    """

    method: str
    url: str
    headers: tuple[tuple[str, str], ...] = ()
    body: bytes = b""

    def get_body(self) -> bytes:
        """Return the raw request body, as the SDK's ``get_body()`` does."""
        return self.body


@dataclass(frozen=True)
class AzureFunctionsProvider(Provider):
    """Azure Functions, HTTP trigger with a wildcard route.

    ``azure.functions`` is imported lazily and only to build the response object, so the runtime
    carries no Azure dependency and can still be exercised end to end without one.
    """

    def decode_request(self, event: Any) -> FunctionRequest:
        """Normalize an ``azure.functions.HttpRequest``."""
        for attribute in ("method", "url", "headers"):
            if not hasattr(event, attribute):
                raise ValueError(f"Azure function requests must expose '{attribute}'.")
        parts = urllib.parse.urlsplit(str(event.url))
        body = event.get_body() if hasattr(event, "get_body") else b""
        return FunctionRequest(
            method=str(event.method).upper(),
            path=_normalize_path(urllib.parse.unquote(parts.path)),
            query_string=parts.query,
            headers=_pairs_from_mapping(_header_items(event.headers)),
            body=bytes(body or b""),
            scheme=parts.scheme or "https",
        )

    def encode_response(self, response: FunctionResponse, *, event: Any = None) -> Any:
        """Build an ``azure.functions.HttpResponse``, or the stand-in when the SDK is absent."""
        response_class = _azure_response_class()
        return response_class(
            body=response.body,
            status_code=response.status,
            headers=_single_headers(response.headers),
        )

    def encode_request(self, request: FunctionRequest) -> AzureLikeRequest:
        """Build an SDK-shaped stand-in request (verification direction)."""
        host = request.header("host") or "localhost"
        query = f"?{request.query_string}" if request.query_string else ""
        return AzureLikeRequest(
            method=request.method,
            url=f"{request.scheme}://{host}{urllib.parse.quote(request.path)}{query}",
            headers=request.headers,
            body=request.body,
        )

    def decode_response(self, payload: Any) -> FunctionResponse:
        """Normalize an ``HttpResponse``-shaped object back into a response."""
        for attribute in ("status_code", "headers"):
            if not hasattr(payload, attribute):
                raise ValueError(f"Azure function responses must expose '{attribute}'.")
        raw = getattr(payload, "body", b"") or b""
        body = raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode("utf-8")
        return FunctionResponse(
            status=int(payload.status_code),
            headers=_pairs_from_mapping(_header_items(payload.headers)),
            body=bytes(body),
        )


def _azure_response_class() -> Any:
    """Return ``azure.functions.HttpResponse``, or :class:`AzureLikeResponse` when it is absent.

    Returns:
        The response class to construct. A deployed Azure function always resolves the SDK class;
        the stand-in exists so the same code path runs where the SDK has no reason to be installed.
    """
    try:  # pragma: no cover - exercised only where the Azure SDK is installed
        import azure.functions as azure_functions

        return azure_functions.HttpResponse
    except ImportError:
        return AzureLikeResponse


# ==================================================================================================
# Shared helpers and the registry
# ==================================================================================================


def _sub_mapping(source: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    """Return a nested object from an event, or an empty mapping when it is absent or not one.

    Args:
        source: The event (or a sub-object of it).
        key: The nested key to read.

    Returns:
        The nested mapping, or ``{}`` — a partial event should decode to a request with defaults
        rather than raise, because the provider, not the caller, chose the event's shape.
    """
    value = source.get(key)
    return value if isinstance(value, Mapping) else {}


def _normalize_path(path: str) -> str:
    """Force a path to a single leading slash, as an ASGI scope requires."""
    text = str(path or "/")
    return text if text.startswith("/") else f"/{text}"


def _header_items(headers: Any) -> Any:
    """Return something iterable as name/value pairs from any header collection shape."""
    if hasattr(headers, "items"):
        return headers.items()
    return headers


def _query_string(parameters: Any) -> str:
    """Render event query parameters as a percent-encoded query string."""
    if not isinstance(parameters, Mapping):
        return ""
    pairs: list[tuple[str, str]] = []
    for key, value in parameters.items():
        if isinstance(value, (list, tuple)):
            pairs.extend((str(key), str(entry)) for entry in value)
        else:
            pairs.append((str(key), str(value)))
    return urllib.parse.urlencode(pairs)


def _query_parameters(query_string: str) -> dict[str, str]:
    """Parse a query string into the single-valued map payload format 1.0 carries."""
    parsed = urllib.parse.parse_qsl(query_string, keep_blank_values=True)
    return {key: value for key, value in parsed}


def _body_fields(body: bytes, content_type: str | None) -> dict[str, Any]:
    """Render a request body into an event's ``body``/``isBase64Encoded`` pair."""
    if not body:
        return {"body": None, "isBase64Encoded": False}
    if _is_text_media_type(content_type):
        try:
            return {"body": body.decode("utf-8"), "isBase64Encoded": False}
        except UnicodeDecodeError:  # pragma: no cover - mislabeled bodies fall back to base64
            pass
    return {"body": base64.b64encode(body).decode("ascii"), "isBase64Encoded": True}


#: Every supported provider, keyed by the name used on the command line and in reports.
PROVIDERS: Mapping[str, Provider] = {
    provider.name: provider
    for provider in (
        AwsLambdaProvider(
            name="aws-lambda",
            title="AWS Lambda",
            entrypoint="apiome_mock.serverless.aws_lambda_handler",
            payload_formats=("apigateway-http-2.0", "apigateway-rest-1.0", "alb-1.0", "function-url-2.0"),
            limits=AWS_LIMITS,
        ),
        GcpFunctionsProvider(
            name="gcp-functions",
            title="Google Cloud Run functions",
            entrypoint="apiome_mock.serverless.gcp_functions_handler",
            payload_formats=("functions-framework-http",),
            limits=GCP_LIMITS,
        ),
        AzureFunctionsProvider(
            name="azure-functions",
            title="Azure Functions",
            entrypoint="apiome_mock.serverless.azure_functions_handler",
            payload_formats=("http-trigger",),
            limits=AZURE_LIMITS,
        ),
    )
}

#: Supported provider names, in registry order — the choices every ``--provider`` flag offers.
PROVIDER_NAMES: tuple[str, ...] = tuple(PROVIDERS)


def provider_for(name: str) -> Provider:
    """Look up a supported provider by name.

    Args:
        name: One of :data:`PROVIDER_NAMES`.

    Returns:
        The provider.

    Raises:
        UnknownProviderError: The name is not supported. The message lists what is, because an
            unsupported target is a deployment decision the caller has to make, not a typo to fix
            silently.
    """
    try:
        return PROVIDERS[name]
    except KeyError as exc:
        supported = ", ".join(PROVIDER_NAMES)
        raise UnknownProviderError(f"Unsupported serverless provider '{name}'. Supported: {supported}.") from exc
