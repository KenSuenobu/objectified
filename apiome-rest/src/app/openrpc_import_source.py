"""OpenRPC import source — MFI-18.6.

The :class:`~app.import_source.ImportSource` adapter that makes OpenRPC JSON-RPC
service descriptions importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import openrpc_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .openrpc_parser import (
    OpenRpcDocument,
    OpenRpcParseError,
    is_openrpc,
    is_openrpc_document,
    parse_openrpc,
)

__all__ = ["OpenRpcImportSource"]


class OpenRpcImportSource(ImportSource, register=True):
    """Adapter for OpenRPC JSON-RPC service descriptions (``.json`` file / url / paste)."""

    key = "openrpc"
    label = "OpenRPC"
    description = "Import an OpenRPC JSON-RPC 2.0 service description with methods and schemas."
    icon = "workflow"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("openrpc", "jsonrpc")
    file_extensions = (".openrpc.json", ".openrpc", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_openrpc(text):
            return DetectionResult(
                confidence=0.98,
                format="openrpc",
                reason="`openrpc` version marker",
            )

        document = payload.document
        if document is not None and is_openrpc_document(document):
            return DetectionResult(
                confidence=0.98,
                format="openrpc",
                reason="`openrpc` version marker",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".openrpc.json") or filename.endswith(".openrpc"):
            return DetectionResult(confidence=0.75, format="openrpc", reason="`.openrpc` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> OpenRpcDocument:
        try:
            return parse_openrpc(raw, source_label=source_label)
        except OpenRpcParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> OpenRpcDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("OpenRPC fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, OpenRpcDocument):
            raise ImportSourceError(
                "OpenRPC source must be an OpenRpcDocument (see app.openrpc_parser.parse_openrpc)"
            )
        return self._normalize_via_registry("openrpc", native_ast, include_raw=include_raw)
