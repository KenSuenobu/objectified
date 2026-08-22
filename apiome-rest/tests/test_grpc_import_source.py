"""End-to-end tests for the gRPC / Protobuf import source (MFI-9.6, #3769).

Exercises the adapter through the full SPI: detect → parse → normalize → fingerprint/lint, plus the
live Server Reflection discovery seam. The parse step drives ``buf build`` via a worker-thread loop;
tests that need a real compile are gated on the bundled ``buf`` being resolvable (mirroring
``test_proto_lint.py``), while the detect / normalize / lint / discover paths are covered without it
using synthetic ``FileDescriptorSet``\\s (built with :mod:`google.protobuf.descriptor_pb2`) and a
monkeypatched compiler / reflection crawler for the bridge + error mapping.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from google.protobuf import descriptor_pb2

from app import grpc_import_source as grpc_src
from app.canonical_model import ApiParadigm, CanonicalApi
from app.grpc_import_source import (
    EDITIONS_FORMAT_KEY,
    GrpcImportSource,
    _compile_error,
)
from app.grpc_reflection import GrpcReflectionError, GrpcReflectionResult
from app.import_source import (
    DetectionInput,
    ImportSource,
    ImportSourceError,
    InputKind,
    LintReport,
    get_import_source,
)
from app.proto_descriptor import (
    CompiledDescriptorSet,
    ProtoCompileError,
    ProtoDescriptorError,
    ProtoFile,
    read_file_descriptor_set,
)
from app.toolchain_packaging import probe_tool

_FIXTURES = Path(__file__).parent / "fixtures" / "proto"
_FD = descriptor_pb2.FieldDescriptorProto

_ECHO_PROTO = (_FIXTURES / "grpc" / "echo.proto").read_text(encoding="utf-8")


# ===========================================================================
# Synthetic descriptor set (no buf) — an echo.v1 service + messages
# ===========================================================================


def _scalar(message: descriptor_pb2.DescriptorProto, name: str, number: int) -> None:
    field = message.field.add()
    field.name = name
    field.number = number
    field.type = _FD.TYPE_STRING
    field.label = _FD.LABEL_OPTIONAL


def _echo_descriptor_set() -> descriptor_pb2.FileDescriptorSet:
    """A single-target proto3 descriptor set: an ``echo.v1`` service + request/response messages."""
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "echo.proto"
    f.package = "echo.v1"
    f.syntax = "proto3"

    req = f.message_type.add()
    req.name = "EchoRequest"
    _scalar(req, "message", 1)

    resp = f.message_type.add()
    resp.name = "EchoResponse"
    _scalar(resp, "message", 1)

    svc = f.service.add()
    svc.name = "EchoService"
    echo = svc.method.add()
    echo.name = "Echo"
    echo.input_type = ".echo.v1.EchoRequest"
    echo.output_type = ".echo.v1.EchoResponse"
    return fds


def _compiled_echo() -> CompiledDescriptorSet:
    fds = _echo_descriptor_set()
    return read_file_descriptor_set(fds.SerializeToString(), target_files=["echo.proto"])


# ===========================================================================
# Descriptor / registration
# ===========================================================================


def test_descriptor_shape() -> None:
    desc = GrpcImportSource.descriptor()
    assert desc.key == "grpc"
    assert desc.paradigm is ApiParadigm.RPC
    assert desc.supports_live_discovery is True
    # FMT-3.7 added the version-scoped Editions detection key; ``protobuf`` stays first
    # because it is the canonical model format the adapter normalizes to.
    assert desc.formats == ["protobuf", "protobuf-editions"]
    assert set(desc.input_kinds) == {
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.DISCOVERY,
        InputKind.FILESET,
    }


def test_descriptor_reports_availability_from_buf_toolchain(monkeypatch) -> None:
    # MFI-5.2: gRPC hard-requires `buf`; the descriptor reflects whether it can run in this runtime.
    monkeypatch.setattr("app.toolchain_runner.is_tool_available", lambda key: key != "buf")
    desc = GrpcImportSource.descriptor()
    assert desc.available is False
    assert desc.unavailable_reason and "buf" in desc.unavailable_reason

    monkeypatch.setattr("app.toolchain_runner.is_tool_available", lambda key: True)
    desc_ok = GrpcImportSource.descriptor()
    assert desc_ok.available is True
    assert desc_ok.unavailable_reason is None


def test_registered_in_registry() -> None:
    resolved = get_import_source("grpc")
    assert isinstance(resolved, GrpcImportSource)


def test_protobuf_alias_resolves_to_grpc_adapter() -> None:
    resolved = get_import_source("protobuf")
    assert isinstance(resolved, GrpcImportSource)


def test_registered_source_is_an_import_source() -> None:
    assert issubclass(GrpcImportSource, ImportSource)


# ===========================================================================
# detect
# ===========================================================================


def test_detect_proto3_syntax_marker_high_confidence() -> None:
    result = GrpcImportSource().detect(DetectionInput(text=_ECHO_PROTO))
    assert result.matched
    assert result.format == "protobuf"
    assert result.confidence >= 0.9


def test_detect_editions_marker() -> None:
    # FMT-3.7: an ``edition = `` document is claimed under the version-scoped key so the
    # wizard can name the dialect; it still normalizes through the one protobuf normalizer.
    text = 'edition = "2023";\npackage acme.v1;\nservice Foo { }\n'
    result = GrpcImportSource().detect(DetectionInput(text=text))
    assert result.matched
    assert result.format == EDITIONS_FORMAT_KEY
    assert result.confidence >= 0.9


def test_detect_keyword_only_is_weaker() -> None:
    text = "package acme.v1;\nmessage Foo { string id = 1; }\n"
    result = GrpcImportSource().detect(DetectionInput(text=text))
    assert result.matched
    assert result.confidence < 0.9


def test_detect_filename_only() -> None:
    result = GrpcImportSource().detect(DetectionInput(filename="service.proto"))
    assert result.matched
    assert result.format == "protobuf"


def test_detect_no_match_on_unrelated_text() -> None:
    result = GrpcImportSource().detect(DetectionInput(text="openapi: 3.1.0\ninfo: {}"))
    assert not result.matched


# ===========================================================================
# normalize (buf-free, over a synthetic descriptor set)
# ===========================================================================


def test_normalize_compiled_descriptor_set() -> None:
    api = GrpcImportSource().normalize(_compiled_echo())
    assert isinstance(api, CanonicalApi)
    assert api.paradigm is ApiParadigm.RPC
    assert api.format == "protobuf"
    assert api.protocol == "grpc"
    service_keys = {s.key for s in api.services}
    assert "echo.v1.EchoService" in service_keys


def test_normalize_accepts_bare_file_descriptor_set() -> None:
    api = GrpcImportSource().normalize(_echo_descriptor_set())
    assert any(s.key == "echo.v1.EchoService" for s in api.services)


def test_normalize_accepts_serialized_bytes() -> None:
    api = GrpcImportSource().normalize(_echo_descriptor_set().SerializeToString())
    assert any(s.key == "echo.v1.EchoService" for s in api.services)


def test_normalize_rejects_unknown_source() -> None:
    with pytest.raises(ImportSourceError):
        GrpcImportSource().normalize({"not": "a descriptor set"})


# ===========================================================================
# lint (buf-free; native + common packs still score deterministically)
# ===========================================================================


def test_lint_scores_the_model() -> None:
    api = GrpcImportSource().normalize(_compiled_echo())
    report = GrpcImportSource().lint(api)
    assert isinstance(report, LintReport)
    assert report.score is not None
    assert report.grade is not None
    assert report.report_fingerprint is not None


def test_lint_is_deterministic() -> None:
    api = GrpcImportSource().normalize(_compiled_echo())
    first = GrpcImportSource().lint(api)
    second = GrpcImportSource().lint(api)
    assert first.report_fingerprint == second.report_fingerprint


def test_fingerprint_is_stable_across_two_reads() -> None:
    adapter = GrpcImportSource()
    a = adapter.normalize(_compiled_echo())
    b = adapter.normalize(_compiled_echo())
    assert adapter.fingerprint(a) == adapter.fingerprint(b)


# ===========================================================================
# parse — compiler bridge + error mapping (monkeypatched compiler)
# ===========================================================================


def test_parse_returns_compiled_set(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def _fake_compile(files):
        captured["files"] = files
        return _compiled_echo()

    monkeypatch.setattr(grpc_src, "_compile_on_worker_loop", _fake_compile)
    compiled = GrpcImportSource().parse(_ECHO_PROTO, source_label="echo.proto")
    assert isinstance(compiled, CompiledDescriptorSet)
    files = captured["files"]
    assert isinstance(files, tuple) and len(files) == 1
    assert isinstance(files[0], ProtoFile)
    assert files[0].path == "echo.proto"
    assert files[0].content == _ECHO_PROTO


def test_parse_default_path_for_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def _fake_compile(files):
        captured["files"] = files
        return _compiled_echo()

    monkeypatch.setattr(grpc_src, "_compile_on_worker_loop", _fake_compile)
    GrpcImportSource().parse(_ECHO_PROTO, source_label=None)
    assert captured["files"][0].path == "import.proto"


def test_parse_strips_directory_and_adds_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def _fake_compile(files):
        captured["files"] = files
        return _compiled_echo()

    monkeypatch.setattr(grpc_src, "_compile_on_worker_loop", _fake_compile)
    GrpcImportSource().parse(_ECHO_PROTO, source_label="a/b/schema")
    assert captured["files"][0].path == "schema.proto"


def test_parse_maps_compile_error_with_diagnostics(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(files):
        raise ProtoCompileError("buf build failed", diagnostics="echo.proto:3:1: bad")

    monkeypatch.setattr(grpc_src, "_compile_on_worker_loop", _boom)
    with pytest.raises(ImportSourceError) as excinfo:
        GrpcImportSource().parse("syntax = \"proto3\";", source_label="echo.proto")
    assert "buf build failed" in str(excinfo.value)
    assert "echo.proto:3:1: bad" in str(excinfo.value)


def test_parse_maps_descriptor_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(files):
        raise ProtoDescriptorError("not a descriptor set")

    monkeypatch.setattr(grpc_src, "_compile_on_worker_loop", _boom)
    with pytest.raises(ImportSourceError):
        GrpcImportSource().parse("syntax = \"proto3\";", source_label="echo.proto")


# ===========================================================================
# discover — live reflection seam + error mapping (no network)
# ===========================================================================


def _ok_reflection_result() -> GrpcReflectionResult:
    """A successful reflection crawl carrying the synthetic echo descriptor bytes."""
    fds = _echo_descriptor_set()
    return GrpcReflectionResult(
        ok=True,
        services=["echo.v1.EchoService"],
        descriptor_set_bytes=fds.SerializeToString(),
        target_files=["echo.proto"],
    )


def test_discover_returns_compiled_set(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def _fake_discover(target, **kwargs):
        captured["target"] = target
        captured["kwargs"] = kwargs
        return _ok_reflection_result()

    monkeypatch.setattr("app.grpc_reflection.discover_endpoint", _fake_discover)
    compiled = GrpcImportSource().discover(
        "api.example.com:50051", auth_type="bearer", auth_payload={"token": "t"}
    )
    assert isinstance(compiled, CompiledDescriptorSet)
    # The compiled set feeds normalize unchanged → the live service catalogs a version.
    api = GrpcImportSource().normalize(compiled)
    assert any(s.key == "echo.v1.EchoService" for s in api.services)
    assert captured["target"] == "api.example.com:50051"
    assert captured["kwargs"]["auth_type"] == "bearer"


def test_discover_reflection_disabled_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_discover(target, **kwargs):
        return GrpcReflectionResult(ok=False, reason="server reflection is not enabled")

    monkeypatch.setattr("app.grpc_reflection.discover_endpoint", _fake_discover)
    with pytest.raises(ImportSourceError) as excinfo:
        GrpcImportSource().discover("api.example.com:50051")
    assert "reflection is not enabled" in str(excinfo.value)


def test_discover_maps_reflection_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_discover(target, **kwargs):
        raise GrpcReflectionError("target host is not permitted")

    monkeypatch.setattr("app.grpc_reflection.discover_endpoint", _fake_discover)
    with pytest.raises(ImportSourceError) as excinfo:
        GrpcImportSource().discover("10.0.0.1:50051")
    assert "not permitted" in str(excinfo.value)


# ===========================================================================
# End-to-end: the real bundled buf compiles the fixture (gated)
# ===========================================================================


_BUF_AVAILABLE = bool(getattr(probe_tool("buf"), "available", False))


@pytest.mark.skipif(not _BUF_AVAILABLE, reason="bundled buf not resolvable in this environment")
def test_end_to_end_compile_normalize_lint_over_fixture() -> None:
    adapter = GrpcImportSource()
    compiled = adapter.parse(_ECHO_PROTO, source_label="echo.proto")
    api = adapter.normalize(compiled)
    assert api.paradigm is ApiParadigm.RPC
    assert any(s.key == "echo.v1.EchoService" for s in api.services)
    report = adapter.lint(api)
    assert report.score is not None


# ---------------------------------------------------------------------------
# Compile-failure classification — FMT-3.7 (#5432)
# ---------------------------------------------------------------------------


def test_edition_version_diagnostic_is_classified_as_an_unsupported_version() -> None:
    """A rejected `edition` value is a version problem, not a malformed document.

    The two wordings buf uses for it are the ones asserted here. Getting this wrong tells the
    user to fix a file that is fine and hides that the *server* needs a newer compiler.
    """
    for diagnostics in (
        'api.proto:1:11:unrecognized `edition` declaration value',
        'api.proto:1:11:edition value "2024" not recognized; should be one of ["2023"]',
    ):
        error = _compile_error(ProtoCompileError("buf build failed", diagnostics=diagnostics))
        assert error.code == "FORMAT_VERSION_UNSUPPORTED", diagnostics
        # The compiler's own text is still surfaced verbatim.
        assert diagnostics in str(error)


def test_an_ordinary_compile_failure_keeps_the_default_classification() -> None:
    """Only the edition wording is classified; everything else stays generic."""
    error = _compile_error(
        ProtoCompileError(
            "buf build failed",
            diagnostics="api.proto:6:3:field User.id: unknown type .integer",
        )
    )
    assert error.code is None


def test_a_later_edition_mention_does_not_reclassify_a_syntax_error() -> None:
    """A rejected edition cascades into junk diagnostics; the *first* one decides.

    A file whose real fault is a missing brace can still mention an edition further down, and
    reporting that as an unsupported version would send the user to the wrong fix.
    """
    error = _compile_error(
        ProtoCompileError(
            "buf build failed",
            diagnostics=(
                "api.proto:7:15:encountered unmatched `{` delimiter\n"
                "api.proto:9:1:the edition of this file could not be determined"
            ),
        )
    )
    assert error.code is None


def test_no_diagnostics_is_never_classified() -> None:
    assert _compile_error(ProtoCompileError("buf is not installed")).code is None
