"""Arrow Flight ``GetSchema`` discovery — FMT-4.5 (#5438).

The suite behind the ticket's third acceptance criterion: *a Flight ``GetSchema``
discovery path imports from a live endpoint in an integration test.*

The endpoint here is genuinely live. A ``pyarrow.flight.FlightServerBase`` is started on a
loopback port, and the adapter's :meth:`~app.arrow_import_source.ArrowImportSource.discover`
seam connects to it over real gRPC, sends a real ``GetSchema`` with real call headers and
reads a real IPC schema reply. Nothing is stubbed between the adapter and the wire — which
is the only way to find out that the descriptor round-trips, that the credential becomes a
header the server can read, and that the reply lands on the same canonical model an
uploaded file does.

Loopback is *not* an SSRF-legal host, which is the point of the guard: the two tests that
need to connect patch ``ssrf_allow_private`` on, using the documented local-development
override, and one test deliberately leaves it off to assert that a private address is
refused before any client is constructed.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, Iterator, List, Tuple
from unittest.mock import patch

import pytest

from app.arrow_flight import (
    DEFAULT_FLIGHT_TIMEOUT_SECONDS,
    FlightDiscoveryError,
    discover_flight_schema,
    parse_flight_target,
)
from app.arrow_ipc import pyarrow_available
from app.import_source import ImportSourceError, get_import_source, load_builtin_import_sources

load_builtin_import_sources()


def _flight_available() -> bool:
    """Whether this runtime's ``pyarrow`` build ships the Flight component."""
    if not pyarrow_available():
        return False
    try:
        import pyarrow.flight  # noqa: F401
    except Exception:  # noqa: BLE001 - any import failure means "not available"
        return False
    return True


pytestmark = pytest.mark.skipif(
    not _flight_available(), reason="pyarrow.flight is not available in this runtime"
)


@pytest.fixture(scope="module")
def flight_server() -> Iterator[Tuple[int, List[Dict[str, List[str]]]]]:
    """Serve one dataset's schema on a loopback port for the duration of the module.

    Yields:
        The port it is listening on, and the list every request's headers are appended
        to, so a test can assert what actually reached the wire.
    """
    import pyarrow as pa
    import pyarrow.flight as flight

    seen: List[Dict[str, List[str]]] = []

    class _Recorder(flight.ServerMiddlewareFactory):
        """Records each call's headers, so the credential path is observable."""

        def start_call(self, info: Any, headers: Any) -> Any:
            seen.append(dict(headers))
            return None

    class _Server(flight.FlightServerBase):
        """A minimal Flight service that answers ``GetSchema`` for one path."""

        def get_schema(self, context: Any, descriptor: Any) -> Any:
            """Return the shipments schema, or fail for any other descriptor."""
            if [bytes(segment) for segment in descriptor.path or []] != [
                b"warehouse",
                b"public",
                b"shipments",
            ]:
                raise flight.FlightUnavailableError("no such dataset")
            schema = pa.schema(
                [
                    pa.field("shipment_id", pa.string(), nullable=False),
                    pa.field("shipped_at", pa.timestamp("ms", tz="UTC")),
                    pa.field("carrier", pa.dictionary(pa.int8(), pa.string(), ordered=False)),
                ],
                metadata={b"source": b"warehouse.public.shipments"},
            )
            return flight.SchemaResult(schema)

    server = _Server(location="grpc://127.0.0.1:0", middleware={"record": _Recorder()})
    port = server.port
    thread = threading.Thread(target=server.serve, daemon=True)
    thread.start()
    try:
        yield port, seen
    finally:
        server.shutdown()
        thread.join(timeout=5)


# ===========================================================================
# Target parsing and the SSRF guard — before anything connects
# ===========================================================================


@pytest.mark.parametrize(
    ("target", "expected_host", "expected_location", "secure"),
    [
        ("flight.example.com:443", "flight.example.com", "grpc://flight.example.com:443", False),
        ("grpc://flight.example.com:443", "flight.example.com", "grpc://flight.example.com:443", False),
        (
            "grpc+tls://flight.example.com:443",
            "flight.example.com",
            "grpc+tls://flight.example.com:443",
            True,
        ),
        ("[::1]:8815", "::1", "grpc://[::1]:8815", False),
    ],
)
def test_targets_parse_into_a_host_to_vet_and_a_location_to_dial(
    target: str, expected_host: str, expected_location: str, secure: bool
) -> None:
    parsed = parse_flight_target(target)
    assert parsed.host == expected_host
    assert parsed.location == expected_location
    assert parsed.secure is secure


def test_an_embedded_credential_is_stripped_from_the_target() -> None:
    """A credential a caller pasted into the target must not reach a log or an error."""
    parsed = parse_flight_target("grpc://user:secret@flight.example.com:443")
    assert parsed.host == "flight.example.com"
    assert "secret" not in parsed.location


def test_an_empty_target_is_refused() -> None:
    with pytest.raises(FlightDiscoveryError):
        parse_flight_target("   ")


def test_a_private_address_is_refused_before_a_client_is_built() -> None:
    def _explode(location: str) -> Any:  # pragma: no cover - must never be called
        raise AssertionError(f"a client was built for {location}")

    with patch("app.ssrf_guard.settings.ssrf_allow_private", False):
        with pytest.raises(FlightDiscoveryError) as excinfo:
            discover_flight_schema(
                "10.0.0.1:8815", path=["a"], client_factory=_explode
            )
    assert "not allowed" in str(excinfo.value)


def test_exactly_one_of_path_or_command_is_required() -> None:
    for kwargs in ({}, {"path": ["a"], "command": "b"}):
        with pytest.raises(FlightDiscoveryError) as excinfo:
            discover_flight_schema("flight.example.com:443", **kwargs)
        assert "exactly one" in str(excinfo.value)


def test_a_credential_type_without_a_payload_is_refused() -> None:
    def _explode(location: str) -> Any:  # pragma: no cover - must never be called
        raise AssertionError(f"a client was built for {location}")

    # A public IP literal, so the SSRF check (which runs first, and fails closed) passes
    # without needing DNS — the credential is what has to be refused here.
    with pytest.raises(FlightDiscoveryError) as excinfo:
        discover_flight_schema(
            "8.8.8.8:443", path=["a"], auth_type="bearer", client_factory=_explode
        )
    assert "auth_payload" in str(excinfo.value)


def test_the_default_timeout_is_stated() -> None:
    assert DEFAULT_FLIGHT_TIMEOUT_SECONDS > 0


# ===========================================================================
# Against a live endpoint
# ===========================================================================


def test_discovery_imports_a_schema_from_a_live_flight_endpoint(
    flight_server: Tuple[int, List[Dict[str, List[str]]]]
) -> None:
    port, seen = flight_server
    seen.clear()
    adapter = get_import_source("arrow")

    with patch("app.ssrf_guard.settings.ssrf_allow_private", True):
        document = adapter.discover(
            f"127.0.0.1:{port}",
            path=["warehouse", "public", "shipments"],
            auth_type="bearer",
            auth_payload={"token": "flight-token"},
            timeout=10.0,
        )

    assert [field.name for field in document.schema.fields] == [
        "shipment_id",
        "shipped_at",
        "carrier",
    ]
    assert document.schema.fields[0].nullable is False
    assert document.schema.fields[2].dictionary is not None

    model = adapter.normalize(document)
    # The descriptor the client asked with becomes the model's identity, so a live
    # endpoint catalogs a *named dataset* rather than a connection.
    assert model.identity.name == "shipments"
    assert model.identity.namespace == "warehouse.public"
    assert model.format == "arrow"
    root = next(item for item in model.types if item.name == "shipments")
    assert {field.name for field in root.fields} == {"shipment_id", "shipped_at", "carrier"}

    # The vault credential became a real gRPC header, lower-cased as gRPC requires.
    assert seen and seen[-1]["authorization"] == ["Bearer flight-token"]


def test_a_live_reply_normalizes_exactly_as_an_uploaded_schema_would(
    flight_server: Tuple[int, List[Dict[str, List[str]]]]
) -> None:
    """Discovery is intake by another route, not a second pipeline."""
    port, _ = flight_server
    adapter = get_import_source("arrow")

    with patch("app.ssrf_guard.settings.ssrf_allow_private", True):
        document = adapter.discover(
            f"127.0.0.1:{port}", path=["warehouse", "public", "shipments"], timeout=10.0
        )

    # The document carries a readable JSON integration form, so re-reading it as an
    # uploaded file must produce the same schema.
    assert document.raw is not None
    reparsed = adapter.parse(document.raw, source_label="captured.json")
    assert reparsed.schema == document.schema
    assert adapter.normalize(reparsed, include_raw=False).types == adapter.normalize(
        document, include_raw=False
    ).types


def test_an_unknown_dataset_fails_with_a_stated_reason(
    flight_server: Tuple[int, List[Dict[str, List[str]]]]
) -> None:
    port, _ = flight_server
    adapter = get_import_source("arrow")
    with patch("app.ssrf_guard.settings.ssrf_allow_private", True):
        with pytest.raises(ImportSourceError) as excinfo:
            adapter.discover(f"127.0.0.1:{port}", path=["nope"], timeout=10.0)
    assert "GetSchema" in str(excinfo.value)


def test_an_unreachable_endpoint_fails_rather_than_hangs() -> None:
    adapter = get_import_source("arrow")
    with patch("app.ssrf_guard.settings.ssrf_allow_private", True):
        with pytest.raises(ImportSourceError):
            # Port 1 is reserved and never listening.
            adapter.discover("127.0.0.1:1", path=["a"], timeout=2.0)


def test_a_server_that_answers_with_no_schema_is_refused() -> None:
    class _Empty:
        """A client whose reply carries no schema at all."""

        def get_schema(self, descriptor: Any, options: Any) -> Any:
            return object()

        def close(self) -> None:
            return None

    with patch("app.ssrf_guard.settings.ssrf_allow_private", True):
        with pytest.raises(FlightDiscoveryError) as excinfo:
            discover_flight_schema(
                "127.0.0.1:8815", path=["a"], client_factory=lambda _location: _Empty()
            )
    assert "no schema" in str(excinfo.value)


def test_a_client_that_fails_to_close_does_not_mask_the_real_error() -> None:
    class _Broken:
        def get_schema(self, descriptor: Any, options: Any) -> Any:
            raise RuntimeError("upstream refused")

        def close(self) -> None:
            raise RuntimeError("and the channel is wedged")

    with patch("app.ssrf_guard.settings.ssrf_allow_private", True):
        with pytest.raises(FlightDiscoveryError) as excinfo:
            discover_flight_schema(
                "127.0.0.1:8815", path=["a"], client_factory=lambda _location: _Broken()
            )
    assert "upstream refused" in str(excinfo.value)
