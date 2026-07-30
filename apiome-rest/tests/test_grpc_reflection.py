"""Tests for gRPC live discovery via Server Reflection (MFI-9.3, #3766).

Two layers, mirroring the module:

* **Unit tests** drive the crawl/assembly/fallback/auth logic through an **injected fake
  transport** (no network), and the pure ``build_descriptor_set`` seam over synthetic
  ``FileDescriptorProto``\\s built with :mod:`google.protobuf.descriptor_pb2`. These cover the
  acceptance matrix — *v1 → v1alpha fallback*, *reflection disabled*, *no services*, *unreachable*
  — plus the credential-vault auth wiring, the SSRF guard, target parsing, and dedup/ordering.
* **One real-server integration test** stands up an in-process gRPC server with
  ``grpcio-reflection`` enabled and crawls it through the *real* transport (no injection), proving
  the actual ``stream_stream`` wiring, the genuine ``v1 UNIMPLEMENTED → v1alpha`` fallback, and the
  end-to-end flow into the MFI-9.2 normalizer.
"""

from __future__ import annotations

from concurrent import futures
from typing import List, Optional, Sequence

import pytest
from google.protobuf import descriptor_pb2

from app import grpc_reflection as grpc_reflection_mod
from app.grpc_reflection import (
    REFLECTION_SERVICE_NAMES,
    GrpcReflectionError,
    GrpcReflectionResult,
    ReflectionConnectionError,
    ReflectionVersion,
    ReflectionVersionUnsupportedError,
    _auth_metadata,
    _host_of,
    build_descriptor_set,
    discover_endpoint,
)
from app.mcp_auth import AUTH_TYPE_BEARER, AUTH_TYPE_HEADER, AUTH_TYPE_NONE
from app.proto_descriptor import CompiledDescriptorSet
from app.proto_normalizer import ProtoNormalizer

# ===========================================================================
# Synthetic descriptor helpers
# ===========================================================================

_STRING = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
_OPTIONAL = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL


def _greeter_file() -> descriptor_pb2.FileDescriptorProto:
    """A self-contained proto3 file: a ``Greeter`` service over two messages."""
    fdp = descriptor_pb2.FileDescriptorProto()
    fdp.name = "apiome/greeter.proto"
    fdp.package = "apiome.test"
    fdp.syntax = "proto3"

    req = fdp.message_type.add()
    req.name = "HelloRequest"
    field = req.field.add()
    field.name, field.number, field.type, field.label = "name", 1, _STRING, _OPTIONAL

    reply = fdp.message_type.add()
    reply.name = "HelloReply"
    field = reply.field.add()
    field.name, field.number, field.type, field.label = "message", 1, _STRING, _OPTIONAL

    svc = fdp.service.add()
    svc.name = "Greeter"
    method = svc.method.add()
    method.name = "SayHello"
    method.input_type = ".apiome.test.HelloRequest"
    method.output_type = ".apiome.test.HelloReply"
    return fdp


def _common_file() -> descriptor_pb2.FileDescriptorProto:
    """A dependency file with only a message (a stand-in for a pulled-in import)."""
    fdp = descriptor_pb2.FileDescriptorProto()
    fdp.name = "apiome/common.proto"
    fdp.package = "apiome.devmon"
    fdp.syntax = "proto3"
    msg = fdp.message_type.add()
    msg.name = "Money"
    return fdp


def _blob(fdp: descriptor_pb2.FileDescriptorProto) -> bytes:
    return fdp.SerializeToString()


# ===========================================================================
# Fake transport
# ===========================================================================


class _FakeTransport:
    """An in-memory :class:`~app.grpc_reflection.ReflectionTransport` for the crawl logic.

    Scripts a ``ListServices`` result and a per-symbol descriptor map, and can be told to raise
    the version-unsupported / connection-error signals at construction or per call.
    """

    def __init__(
        self,
        *,
        services: Sequence[str] = (),
        files_by_symbol: Optional[dict] = None,
        unsupported: bool = False,
        connection_error: Optional[str] = None,
        files_unsupported: bool = False,
    ) -> None:
        self._services = list(services)
        self._files_by_symbol = files_by_symbol or {}
        self._unsupported = unsupported
        self._connection_error = connection_error
        self._files_unsupported = files_unsupported
        self.closed = False
        self.requested_symbols: List[str] = []

    def list_services(self) -> List[str]:
        if self._unsupported:
            raise ReflectionVersionUnsupportedError("v? not implemented")
        if self._connection_error:
            raise ReflectionConnectionError(self._connection_error)
        return list(self._services)

    def files_for_symbols(self, symbols: Sequence[str]) -> List[bytes]:
        self.requested_symbols = list(symbols)
        if self._files_unsupported:
            raise ReflectionVersionUnsupportedError("files unsupported")
        blobs: List[bytes] = []
        for symbol in symbols:
            blobs.extend(self._files_by_symbol.get(symbol, []))
        return blobs

    def close(self) -> None:
        self.closed = True


def _factory(transports: dict):
    """Build a transport factory that hands back ``transports[version]`` and records calls."""
    used: List[ReflectionVersion] = []

    def factory(version: ReflectionVersion):
        used.append(version)
        if version not in transports:
            # No transport scripted for this version → behave like an unimplemented service.
            raise ReflectionVersionUnsupportedError(f"{version} unimplemented")
        return transports[version]

    factory.used = used  # type: ignore[attr-defined]
    return factory


@pytest.fixture(autouse=True)
def _allow_any_host(monkeypatch):
    """Neutralise the SSRF DNS check for synthetic hosts (re-enabled explicitly where tested)."""
    monkeypatch.setattr(grpc_reflection_mod, "validate_host", lambda host: None)


# ===========================================================================
# build_descriptor_set — pure assembly
# ===========================================================================


class TestBuildDescriptorSet:
    def test_dedups_and_orders_files(self) -> None:
        greeter, common = _greeter_file(), _common_file()
        # The greeter blob arrives twice (every service drags its deps); common once.
        blobs = [_blob(greeter), _blob(common), _blob(greeter)]
        data, targets = build_descriptor_set(
            blobs, service_symbols=["apiome.test.Greeter"]
        )

        fds = descriptor_pb2.FileDescriptorSet()
        fds.ParseFromString(data)
        names = [f.name for f in fds.file]
        # Deduped (greeter once) and ordered by name (common < greeter).
        assert names == ["apiome/common.proto", "apiome/greeter.proto"]
        # Only the file declaring the discovered service is a target; the message-only file is an import.
        assert targets == ["apiome/greeter.proto"]

    def test_target_detection_handles_unpackaged_service(self) -> None:
        fdp = descriptor_pb2.FileDescriptorProto()
        fdp.name = "root.proto"
        fdp.service.add().name = "RootService"
        data, targets = build_descriptor_set([_blob(fdp)], service_symbols=["RootService"])
        assert targets == ["root.proto"]

    def test_no_symbols_means_all_targets(self) -> None:
        greeter, common = _greeter_file(), _common_file()
        _data, targets = build_descriptor_set([_blob(greeter), _blob(common)])
        assert targets == ["apiome/common.proto", "apiome/greeter.proto"]

    def test_empty_input_raises(self) -> None:
        with pytest.raises(GrpcReflectionError, match="no file descriptors"):
            build_descriptor_set([])

    def test_nameless_only_raises(self) -> None:
        nameless = descriptor_pb2.FileDescriptorProto()  # no .name
        with pytest.raises(GrpcReflectionError, match="nameless"):
            build_descriptor_set([_blob(nameless)])

    def test_unparseable_blob_raises(self) -> None:
        with pytest.raises(GrpcReflectionError, match="unparseable"):
            build_descriptor_set([b"\xff\xff not a descriptor \x00"])

    def test_too_many_files_raises(self, monkeypatch) -> None:
        monkeypatch.setattr(grpc_reflection_mod, "_MAX_DESCRIPTOR_FILES", 1)
        with pytest.raises(GrpcReflectionError, match="too many"):
            build_descriptor_set([_blob(_greeter_file()), _blob(_common_file())])

    def test_too_large_raises(self, monkeypatch) -> None:
        monkeypatch.setattr(grpc_reflection_mod, "_MAX_DESCRIPTOR_BYTES", 5)
        with pytest.raises(GrpcReflectionError, match="assembly limit"):
            build_descriptor_set([_blob(_greeter_file())])


# ===========================================================================
# _host_of — target parsing
# ===========================================================================


class TestHostOf:
    @pytest.mark.parametrize(
        "target,expected",
        [
            ("api.example.com:50051", "api.example.com"),
            ("api.example.com", "api.example.com"),
            ("grpc://api.example.com:443", "api.example.com"),
            ("dns:///api.example.com:50051", "api.example.com"),
            ("user:pass@api.example.com:50051", "api.example.com"),
            ("[2001:db8::1]:50051", "2001:db8::1"),
            ("2001:db8::1", "2001:db8::1"),
            ("203.0.113.5:50051", "203.0.113.5"),
        ],
    )
    def test_extracts_host(self, target, expected) -> None:
        assert _host_of(target) == expected

    def test_empty_raises(self) -> None:
        with pytest.raises(GrpcReflectionError, match="empty"):
            _host_of("   ")


# ===========================================================================
# _auth_metadata — credential vault → gRPC metadata
# ===========================================================================


class TestAuthMetadata:
    def test_none_yields_empty(self) -> None:
        assert _auth_metadata(None, None) == []
        assert _auth_metadata(AUTH_TYPE_NONE, None) == []

    def test_bearer_lowercases_authorization(self) -> None:
        md = _auth_metadata(AUTH_TYPE_BEARER, {"token": "s3cret"})
        assert md == [("authorization", "Bearer s3cret")]

    def test_header_lowercases_custom_name(self) -> None:
        md = _auth_metadata(AUTH_TYPE_HEADER, {"name": "X-Api-Key", "value": "abc"})
        assert md == [("x-api-key", "abc")]

    def test_missing_payload_raises(self) -> None:
        with pytest.raises(GrpcReflectionError, match="requires a credential payload"):
            _auth_metadata(AUTH_TYPE_BEARER, None)

    def test_malformed_credential_raises(self) -> None:
        with pytest.raises(GrpcReflectionError):
            _auth_metadata(AUTH_TYPE_BEARER, {"token": ""})

    def test_header_injection_rejected(self) -> None:
        with pytest.raises(GrpcReflectionError, match="control characters"):
            _auth_metadata(AUTH_TYPE_HEADER, {"name": "X-Evil", "value": "a\r\nInjected: 1"})


# ===========================================================================
# discover_endpoint — orchestration via the fake transport
# ===========================================================================


class TestDiscoverEndpoint:
    def test_v1_happy_path(self) -> None:
        greeter = _greeter_file()
        transport = _FakeTransport(
            services=["apiome.test.Greeter", "grpc.reflection.v1.ServerReflection"],
            files_by_symbol={"apiome.test.Greeter": [_blob(greeter)]},
        )
        factory = _factory({ReflectionVersion.V1: transport})

        result = discover_endpoint("api.example.com:50051", transport_factory=factory)

        assert result.ok is True
        assert result.reflection_version == ReflectionVersion.V1
        # Reflection service excluded from the discovered surface.
        assert result.services == ["apiome.test.Greeter"]
        assert result.target_files == ["apiome/greeter.proto"]
        assert result.summary is not None and result.summary.service_count == 1
        # The crawl only queried the user service, not the reflection service.
        assert transport.requested_symbols == ["apiome.test.Greeter"]
        assert transport.closed is True

    def test_compiled_round_trips_into_normalizer(self) -> None:
        greeter, common = _greeter_file(), _common_file()
        transport = _FakeTransport(
            services=["apiome.test.Greeter"],
            # FileContainingSymbol returns the file + its (here, synthetic) dependency.
            files_by_symbol={
                "apiome.test.Greeter": [_blob(greeter), _blob(common)]
            },
        )
        result = discover_endpoint(
            "api.example.com:50051",
            transport_factory=_factory({ReflectionVersion.V1: transport}),
        )

        compiled = result.compiled()
        assert isinstance(compiled, CompiledDescriptorSet)
        by_name = {f.name: f for f in compiled.files}
        # The service file is a target; the message-only dependency is an import.
        assert by_name["apiome/greeter.proto"].is_import is False
        assert by_name["apiome/common.proto"].is_import is True

        # And it normalizes through MFI-9.2 unchanged.
        api = ProtoNormalizer().normalize(compiled)
        assert any(s.key == "apiome.test.Greeter" for s in api.services)

    def test_falls_back_to_v1alpha_when_v1_unimplemented(self) -> None:
        greeter = _greeter_file()
        # v1 transport reports the service is unimplemented; v1alpha answers.
        v1 = _FakeTransport(unsupported=True)
        v1alpha = _FakeTransport(
            services=["apiome.test.Greeter"],
            files_by_symbol={"apiome.test.Greeter": [_blob(greeter)]},
        )
        factory = _factory({ReflectionVersion.V1: v1, ReflectionVersion.V1ALPHA: v1alpha})

        result = discover_endpoint("api.example.com:50051", transport_factory=factory)

        assert result.ok is True
        assert result.reflection_version == ReflectionVersion.V1ALPHA
        assert factory.used == [ReflectionVersion.V1, ReflectionVersion.V1ALPHA]
        assert v1.closed and v1alpha.closed

    def test_reflection_disabled_on_both_versions(self) -> None:
        # Neither version implements reflection → not ok, both versions attempted.
        factory = _factory({})  # every version → ReflectionVersionUnsupportedError
        result = discover_endpoint("api.example.com:50051", transport_factory=factory)
        assert result.ok is False
        assert result.reflection_version is None
        assert factory.used == [ReflectionVersion.V1, ReflectionVersion.V1ALPHA]
        assert "unimplemented" in (result.reason or "")

    def test_no_services_is_terminal(self) -> None:
        # Server answers reflection but advertises only the reflection service itself.
        transport = _FakeTransport(services=list(REFLECTION_SERVICE_NAMES))
        factory = _factory({ReflectionVersion.V1: transport})
        result = discover_endpoint("api.example.com:50051", transport_factory=factory)
        assert result.ok is False
        assert "no services" in (result.reason or "")
        # No version fallback — an empty surface is not a version problem.
        assert factory.used == [ReflectionVersion.V1]

    def test_unreachable_is_terminal_no_fallback(self) -> None:
        v1 = _FakeTransport(connection_error="unavailable")
        factory = _factory({ReflectionVersion.V1: v1, ReflectionVersion.V1ALPHA: _FakeTransport()})
        result = discover_endpoint("api.example.com:50051", transport_factory=factory)
        assert result.ok is False
        assert "unavailable" in (result.reason or "")
        # A connection error stops the crawl — v1alpha is not tried.
        assert factory.used == [ReflectionVersion.V1]

    def test_services_but_no_descriptors(self) -> None:
        transport = _FakeTransport(services=["apiome.test.Greeter"], files_by_symbol={})
        factory = _factory({ReflectionVersion.V1: transport})
        result = discover_endpoint("api.example.com:50051", transport_factory=factory)
        assert result.ok is False
        assert "no file descriptors" in (result.reason or "")

    def test_files_unsupported_triggers_fallback(self) -> None:
        greeter = _greeter_file()
        v1 = _FakeTransport(services=["apiome.test.Greeter"], files_unsupported=True)
        v1alpha = _FakeTransport(
            services=["apiome.test.Greeter"],
            files_by_symbol={"apiome.test.Greeter": [_blob(greeter)]},
        )
        factory = _factory({ReflectionVersion.V1: v1, ReflectionVersion.V1ALPHA: v1alpha})
        result = discover_endpoint("api.example.com:50051", transport_factory=factory)
        assert result.ok is True
        assert result.reflection_version == ReflectionVersion.V1ALPHA

    def test_auth_and_extra_metadata_reach_the_production_factory(self, monkeypatch) -> None:
        # With no injected factory, discover_endpoint builds metadata and hands it to the real
        # _build_grpc_transport — spy on it to assert auth + extra metadata are merged and lowercased.
        captured = {}

        def spy_build(target, version, *, metadata, timeout, secure, channel_credentials):
            captured["metadata"] = list(metadata)
            captured["timeout"] = timeout
            return _FakeTransport(
                services=["apiome.test.Greeter"],
                files_by_symbol={"apiome.test.Greeter": [_blob(_greeter_file())]},
            )

        monkeypatch.setattr(grpc_reflection_mod, "_build_grpc_transport", spy_build)

        result = discover_endpoint(
            "api.example.com:50051",
            auth_type=AUTH_TYPE_BEARER,
            auth_payload={"token": "s3cret"},
            metadata=[("X-Tenant", "acme")],
            timeout=12.5,
        )
        assert result.ok is True
        # Auth header first (lowercased), then the extra routing header (lowercased).
        assert captured["metadata"] == [
            ("authorization", "Bearer s3cret"),
            ("x-tenant", "acme"),
        ]
        assert captured["timeout"] == 12.5


# ===========================================================================
# SSRF guard integration
# ===========================================================================


class TestSsrfGuard:
    def test_unsafe_target_raises(self, monkeypatch) -> None:
        # Restore the real guard (the autouse fixture neutralised it) and force a rejection.
        from app import ssrf_guard

        def reject(host):
            raise ssrf_guard.SSRFError(f"host '{host}' resolves to non-public address")

        monkeypatch.setattr(grpc_reflection_mod, "validate_host", reject)
        with pytest.raises(GrpcReflectionError, match="non-public"):
            discover_endpoint("169.254.169.254:50051", transport_factory=_factory({}))

    def test_host_validated_before_connect(self, monkeypatch) -> None:
        # The SSRF check runs before any transport is built.
        called = {"factory": False}

        def factory(version):
            called["factory"] = True
            return _FakeTransport()

        monkeypatch.setattr(
            grpc_reflection_mod,
            "validate_host",
            lambda host: (_ for _ in ()).throw(
                grpc_reflection_mod.SSRFError("blocked")
            ),
        )
        with pytest.raises(GrpcReflectionError):
            discover_endpoint("10.0.0.5:50051", transport_factory=factory)
        assert called["factory"] is False


# ===========================================================================
# Real in-process gRPC server — end-to-end (no injected transport)
# ===========================================================================


@pytest.fixture(scope="module")
def _sample_grpc_server():
    """Start an in-process gRPC server advertising a real ``Greeter`` service via reflection.

    The service descriptor is registered into the default descriptor pool so the bundled
    ``grpcio-reflection`` server can answer ``ListServices`` / ``FileContainingSymbol`` for it —
    the method itself is never invoked, the crawl only reads the schema. ``grpcio-reflection``
    ships the **v1alpha** service only, so a real ``discover_endpoint`` run exercises the genuine
    ``v1 UNIMPLEMENTED → v1alpha`` fallback.
    """
    grpc = pytest.importorskip("grpc")
    from google.protobuf import descriptor_pool
    from grpc_reflection.v1alpha import reflection

    # Register the sample file in the default pool (idempotent across the module's tests).
    pool = descriptor_pool.Default()
    file_name = "apiome/greeter.proto"
    try:
        pool.FindFileByName(file_name)
    except KeyError:
        pool.Add(_greeter_file())

    service_name = "apiome.test.Greeter"
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    reflection.enable_server_reflection([service_name, reflection.SERVICE_NAME], server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield port
    finally:
        server.stop(0)


class TestRealServer:
    def test_discovers_full_surface_and_falls_back(self, _sample_grpc_server, monkeypatch) -> None:
        # Allow the loopback target through the SSRF guard for this local server.
        monkeypatch.setattr(grpc_reflection_mod, "validate_host", lambda host: None)

        result = discover_endpoint(f"127.0.0.1:{_sample_grpc_server}", timeout=10.0)

        assert isinstance(result, GrpcReflectionResult)
        assert result.ok is True, result.reason
        # grpcio-reflection serves v1alpha only → the v1 attempt fell back.
        assert result.reflection_version == ReflectionVersion.V1ALPHA
        assert "apiome.test.Greeter" in result.services
        assert "grpc.reflection.v1alpha.ServerReflection" not in result.services

        # The assembled descriptor set normalizes through MFI-9.2 with the full surface intact.
        api = ProtoNormalizer().normalize(result.compiled())
        greeter = next(s for s in api.services if s.key == "apiome.test.Greeter")
        assert any(op.key.endswith("SayHello") for op in greeter.operations)
        type_keys = {t.key for t in api.types}
        assert "apiome.test.HelloRequest" in type_keys
        assert "apiome.test.HelloReply" in type_keys
