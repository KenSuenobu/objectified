"""ONC RPC / XDR import source — MFI-21.6.

The :class:`~app.import_source.ImportSource` adapter that makes ONC RPC ``.x`` XDR
definitions importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import oncrpc_normalizer  # noqa: F401 — self-registers the normalizer
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
from .oncrpc_parser import OncRpcDocument, OncRpcParseError, is_oncrpc, parse_oncrpc

__all__ = ["OncRpcImportSource"]


class OncRpcImportSource(ImportSource, register=True):
    """Adapter for ONC/Sun RPC XDR definitions (``.x`` file / url / paste)."""

    key = "oncrpc"
    label = "ONC RPC"
    description = "Import an ONC RPC / XDR rpcgen definition (.x) with program procedures and types."
    icon = "network"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("oncrpc", "sunrpc", "rpcgen", "xdr")
    file_extensions = (".x",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_oncrpc(text):
            return DetectionResult(
                confidence=0.95,
                format="oncrpc",
                reason="`program` / XDR `union ... switch` markers",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".x"):
            if text is not None and is_oncrpc(text):
                return DetectionResult(confidence=0.85, format="oncrpc", reason="`.x` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> OncRpcDocument:
        try:
            return parse_oncrpc(raw, source_label=source_label)
        except OncRpcParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> OncRpcDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("ONC RPC fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, OncRpcDocument):
            raise ImportSourceError(
                "ONC RPC source must be an OncRpcDocument (see app.oncrpc_parser.parse_oncrpc)"
            )
        return self._normalize_via_registry("oncrpc", native_ast, include_raw=include_raw)
