"""Connect-RPC import source — MFI-12.6.

The :class:`~app.import_source.ImportSource` adapter for Connect-RPC catalog imports. Connect
reuses Protocol Buffers ``.proto`` contracts (the same compiled descriptor set gRPC uses), so
**parse** / **discover** / **parse_fileset** delegate to :class:`app.grpc_import_source.GrpcImportSource`
while **normalize** runs through :class:`app.connectrpc_normalizer.ConnectRpcNormalizer` so the
stored catalog item is labeled ``connectrpc`` rather than ``protobuf``.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence, Tuple

from . import connectrpc_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .grpc_import_source import GrpcImportSource
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
    LintReport,
)
from .proto_descriptor import CompiledDescriptorSet

__all__ = ["ConnectRpcImportSource"]

# Connect-RPC prose in comments, docs, or paths — strong enough to prefer this adapter over gRPC.
_CONNECT_MARKER_RE = re.compile(
    r"(?i)connect[\s\-]*rpc|connectrpc|buf\.build/connect",
)

# Cheap protobuf markers shared with the gRPC adapter (detection must never shell out to ``buf``).
_PROTO_MARKERS: Tuple[str, ...] = (
    'syntax = "proto3"',
    'syntax = "proto2"',
    "edition = ",
    "message ",
    "service ",
    "enum ",
    "package ",
)


def _looks_like_proto(text: str) -> bool:
    if 'syntax = "proto3"' in text or 'syntax = "proto2"' in text:
        return True
    if "edition = " in text and ("message " in text or "service " in text):
        return True
    return any(marker in text for marker in _PROTO_MARKERS)


def _connect_path_hint(filename: str) -> bool:
    lowered = filename.replace("\\", "/").lower()
    return (
        "connectrpc" in lowered
        or "/connect/" in lowered
        or lowered.startswith("connect/")
        or "/connect-" in lowered
    )


class ConnectRpcImportSource(ImportSource, register=True):
    """Adapter for Connect-RPC (Protobuf ``.proto`` upload or live gRPC reflection)."""

    key = "connectrpc"
    label = "Connect RPC"
    description = (
        "Import a Connect-RPC service from a .proto file or a live gRPC-compatible reflection endpoint."
    )
    icon = "network"
    paradigm = ApiParadigm.RPC
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.DISCOVERY,
        InputKind.FILESET,
    )
    supports_live_discovery = True
    formats = ("connectrpc",)
    file_extensions = (".proto",)
    required_tools = ("buf",)

    def __init__(self) -> None:
        self._grpc = GrpcImportSource()

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        filename = (payload.filename or "").replace("\\", "/")

        if text is not None and _looks_like_proto(text):
            if _CONNECT_MARKER_RE.search(text):
                return DetectionResult(
                    confidence=0.98,
                    format="connectrpc",
                    reason="Connect-RPC protobuf contract",
                )
            if filename and _connect_path_hint(filename):
                return DetectionResult(
                    confidence=0.93,
                    format="connectrpc",
                    reason="`.proto` under a Connect path",
                )

        if filename:
            lowered = filename.lower()
            if lowered.endswith(".proto") and _connect_path_hint(filename):
                return DetectionResult(
                    confidence=0.75,
                    format="connectrpc",
                    reason="Connect-oriented `.proto` filename/path",
                )

        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CompiledDescriptorSet:
        return self._grpc.parse(raw, source_label=source_label)

    def accepts_bytes(self, raw: bytes, *, filename: Optional[str] = None) -> bool:
        """Delegate binary descriptor-set routing to the gRPC adapter (IXH-7.5)."""
        return self._grpc.accepts_bytes(raw, filename=filename)

    def parse_bytes(
        self, raw: bytes, *, source_label: Optional[str] = None
    ) -> CompiledDescriptorSet:
        """Decode a binary ``FileDescriptorSet`` / buf image via the gRPC adapter (IXH-7.5)."""
        return self._grpc.parse_bytes(raw, source_label=source_label)

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CompiledDescriptorSet:
        return self._grpc.parse_fileset(fileset, source_label=source_label)

    def discover(
        self,
        target: str,
        *,
        auth_type: Optional[str] = None,
        auth_payload: Optional[Mapping[str, Any]] = None,
        metadata: Optional[Sequence[Tuple[str, str]]] = None,
        secure: bool = False,
        timeout: Optional[float] = None,
        transport_factory: Optional[Any] = None,
    ) -> CompiledDescriptorSet:
        return self._grpc.discover(
            target,
            auth_type=auth_type,
            auth_payload=auth_payload,
            metadata=metadata,
            secure=secure,
            timeout=timeout,
            transport_factory=transport_factory,
        )

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        try:
            return self._normalize_via_registry("connectrpc", native_ast, include_raw=include_raw)
        except ValueError as exc:
            raise ImportSourceError(str(exc)) from exc

    def lint(self, model: CanonicalApi) -> LintReport:
        from .proto_lint import lint_protobuf_result

        return LintReport.from_lint_result(lint_protobuf_result(model))
