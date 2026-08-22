"""Arrow Flight ``GetSchema`` discovery — FMT-4.5 (#5438).

The live-endpoint surface of the Arrow adapter. A Flight server is a *discoverable* schema
source: given a descriptor — a dataset path, or an opaque command — it returns that
dataset's Arrow schema, serialized exactly as an IPC schema message. So discovery here is
one RPC plus the bridge that already exists: the reply goes through
:func:`app.arrow_ipc.document_from_pyarrow` and produces the same
:class:`~app.arrow_schema.ArrowDocument` a committed ``.arrow`` file produces.

**Hardening.** The host is vetted against the SSRF policy
(:func:`app.ssrf_guard.validate_host`) *before* a client is constructed, exactly as the
gRPC reflection crawler does — Flight rides gRPC, a Flight location is attacker-supplied,
and a resolved-then-connected host is the shape SSRF exploits. Credentials come from the
shared credential vault and only ever become call headers.

``pyarrow.flight`` is imported lazily. It is part of the declared ``pyarrow`` dependency,
but a runtime without it must still import this module — the adapter's other two surfaces
do not need it — and must say so rather than fail with an import traceback.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Sequence, Tuple

from .arrow_ipc import document_from_pyarrow
from .arrow_schema import ArrowDocument, FlightDescriptor, FlightInfo
from .mcp_auth import AUTH_TYPE_NONE, CredentialPayloadError, build_auth_headers
from .ssrf_guard import SSRFError, validate_host

__all__ = [
    "DEFAULT_FLIGHT_TIMEOUT_SECONDS",
    "FlightDiscoveryError",
    "FlightTarget",
    "discover_flight_schema",
    "parse_flight_target",
]

#: Per-call deadline used when the caller names none. A ``GetSchema`` is one small round
#: trip; a server that cannot answer it in this long is not going to.
DEFAULT_FLIGHT_TIMEOUT_SECONDS = 15.0


class FlightDiscoveryError(Exception):
    """A live Flight endpoint could not be reached, or would not serve a schema."""


@dataclass(frozen=True)
class FlightTarget:
    """A parsed Flight target: where to connect, and how.

    Attributes:
        host: The bare host, as the SSRF policy vets it.
        location: The full ``grpc://`` / ``grpc+tls://`` location a client connects to.
        secure: Whether the location is TLS.
    """

    host: str
    location: str
    secure: bool


def parse_flight_target(target: str, *, secure: bool = False) -> FlightTarget:
    """Parse a Flight endpoint into the host to vet and the location to connect to.

    Accepts what an operator will actually paste: ``host:port``, ``grpc://host:port``,
    ``grpc+tls://host:port``, and a bracketed IPv6 literal. A ``user:pass@`` authority is
    stripped before anything else, so a credential a caller mistakenly embedded in the
    target cannot reach an error message or a log line.

    Args:
        target: The endpoint as given.
        secure: Request TLS. A ``grpc+tls://`` (or ``https://``) scheme in ``target``
            implies it regardless.

    Returns:
        The parsed target.

    Raises:
        FlightDiscoveryError: When no host can be parsed out of ``target``.
    """
    raw = (target or "").strip()
    if not raw:
        raise FlightDiscoveryError("Flight target is empty")

    scheme = ""
    if "://" in raw:
        scheme, raw = raw.split("://", 1)
        scheme = scheme.lower()
    raw = raw.rsplit("@", 1)[-1].strip("/")
    if not raw:
        raise FlightDiscoveryError("could not parse a host from the Flight target")

    if raw.startswith("["):
        end = raw.find("]")
        if end == -1:
            raise FlightDiscoveryError("malformed IPv6 Flight target (missing closing ']')")
        host = raw[1:end]
    elif raw.count(":") > 1:
        host = raw
    else:
        host = raw.split(":", 1)[0]
    host = host.strip()
    if not host:
        raise FlightDiscoveryError("could not parse a host from the Flight target")

    use_tls = secure or scheme in ("grpc+tls", "https", "flight+tls")
    location = f"{'grpc+tls' if use_tls else 'grpc'}://{raw}"
    return FlightTarget(host=host, location=location, secure=use_tls)


def discover_flight_schema(
    target: str,
    *,
    path: Optional[Sequence[str]] = None,
    command: Optional[str] = None,
    auth_type: Optional[str] = None,
    auth_payload: Optional[Mapping[str, Any]] = None,
    headers: Optional[Sequence[Tuple[str, str]]] = None,
    secure: bool = False,
    timeout: Optional[float] = None,
    client_factory: Optional[Any] = None,
) -> ArrowDocument:
    """Fetch one dataset's schema from a live Flight endpoint.

    Args:
        target: The Flight endpoint (``host:port`` or a ``grpc://`` location).
        path: The dataset's descriptor path (``["warehouse", "public", "shipments"]``).
        command: An opaque ``CMD`` descriptor, for a server that addresses datasets by
            command rather than by path. Exactly one of ``path``/``command`` is required.
        auth_type: Credential-vault auth type (``none``/``bearer``/``header``/``basic``…).
        auth_payload: The **decrypted** credential payload for ``auth_type``.
        headers: Extra call headers, merged in after the credential's.
        secure: Open a TLS location when ``True``.
        timeout: Per-call deadline in seconds; :data:`DEFAULT_FLIGHT_TIMEOUT_SECONDS`
            when omitted.
        client_factory: A ``location -> client`` factory injected by tests; production
            omits it so a real Flight client is built.

    Returns:
        The document: the served schema, wrapped in the descriptor that asked for it, so
        the model's identity names the dataset rather than the connection.

    Raises:
        FlightDiscoveryError: For a misconfigured request (no descriptor, an unsafe
            target, a malformed credential), an unreachable endpoint, or a server that
            answers with no schema.
    """
    if bool(path) == bool(command):
        raise FlightDiscoveryError(
            "Flight discovery needs exactly one of a descriptor `path` or a `command`"
        )

    parsed = parse_flight_target(target, secure=secure)
    try:
        validate_host(parsed.host)
    except SSRFError as exc:
        raise FlightDiscoveryError(f"Flight target is not allowed: {exc}") from exc

    call_headers = _auth_headers(auth_type, auth_payload)
    call_headers.extend((name.lower(), value) for name, value in (headers or ()))

    flight = _require_flight()
    descriptor = (
        flight.FlightDescriptor.for_path(*[str(segment) for segment in path])
        if path
        else flight.FlightDescriptor.for_command(str(command))
    )
    options = flight.FlightCallOptions(
        timeout=float(timeout if timeout is not None else DEFAULT_FLIGHT_TIMEOUT_SECONDS),
        headers=[(name.encode("utf-8"), value.encode("utf-8")) for name, value in call_headers],
    )

    factory = client_factory or (lambda location: flight.FlightClient(location))
    client = None
    try:
        client = factory(parsed.location)
        # The reply is read *inside* the connection's lifetime: a `SchemaResult` is
        # deserialized eagerly, but reading it before the channel closes keeps that an
        # implementation detail rather than something this function depends on.
        schema = getattr(client.get_schema(descriptor, options), "schema", None)
    except Exception as exc:  # noqa: BLE001 - Flight raises many unrelated error types
        raise FlightDiscoveryError(
            f"Flight GetSchema against {parsed.location} failed: {exc}"
        ) from exc
    finally:
        _close(client)

    if schema is None:
        raise FlightDiscoveryError(
            f"Flight endpoint {parsed.location} returned no schema for this descriptor"
        )
    return document_from_pyarrow(
        schema,
        flight=FlightInfo(descriptor=_descriptor_of(path, command)),
        source_label=parsed.location,
    )


def _descriptor_of(
    path: Optional[Sequence[str]], command: Optional[str]
) -> FlightDescriptor:
    """Build the descriptor record the model's identity is derived from."""
    if path:
        return FlightDescriptor(type="PATH", path=tuple(str(segment) for segment in path))
    return FlightDescriptor(type="CMD", cmd=str(command))


def _auth_headers(
    auth_type: Optional[str], auth_payload: Optional[Mapping[str, Any]]
) -> List[Tuple[str, str]]:
    """Map a credential-vault entry onto Flight call headers, or ``[]`` for no auth.

    Reuses the shared credential model, so a Flight endpoint takes the same credentials
    every other live source does. Header names are lower-cased: Flight rides gRPC, and
    gRPC metadata names must be lower-case.

    Raises:
        FlightDiscoveryError: If the credential is missing or malformed for its type.
    """
    if not auth_type or auth_type == AUTH_TYPE_NONE:
        return []
    if auth_payload is None:
        raise FlightDiscoveryError(
            f"auth_type={auth_type!r} requires a credential payload (auth_payload)"
        )
    try:
        built = build_auth_headers(auth_type, dict(auth_payload))
    except CredentialPayloadError as exc:
        raise FlightDiscoveryError(str(exc)) from exc
    return [(name.lower(), value) for name, value in built.items()]


def _require_flight() -> Any:
    """Import ``pyarrow.flight``, or raise the stated reason it cannot be used here."""
    try:
        import pyarrow.flight as flight
    except Exception as exc:  # noqa: BLE001 - pyarrow.flight is an optional build component
        raise FlightDiscoveryError(
            "pyarrow.flight is not available in this runtime; Arrow Flight discovery is "
            "unavailable here. An IPC or JSON schema imports without it."
        ) from exc
    return flight


def _close(client: Any) -> None:
    """Close a Flight client, ignoring a close that fails on an already-broken channel."""
    if client is None:
        return
    closer = getattr(client, "close", None)
    if callable(closer):
        try:
            closer()
        except Exception:  # noqa: BLE001 - a failed close must not mask the real error
            pass
