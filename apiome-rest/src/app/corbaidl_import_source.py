"""CORBA / OMG IDL import source — MFI-21.7.

The :class:`~app.import_source.ImportSource` adapter that makes CORBA IDL ``.idl``
definitions importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import corbaidl_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .corbaidl_parser import CorbaIdlDocument, CorbaIdlParseError, is_corbaidl, parse_corbaidl
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["CorbaIdlImportSource"]


class CorbaIdlImportSource(ImportSource, register=True):
    """Adapter for CORBA / OMG IDL (``.idl`` file / url / paste)."""

    key = "corbaidl"
    label = "CORBA IDL"
    description = "Import a CORBA / OMG IDL definition (.idl) with modules, interfaces, and types."
    icon = "network"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("corbaidl", "corba", "idl")
    file_extensions = (".idl",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_corbaidl(text):
            if "module " in text and "interface " in text:
                reason = "`module` + `interface` markers"
                confidence = 0.97
            elif "raises (" in text:
                reason = "`raises (...)` fault declaration"
                confidence = 0.96
            else:
                reason = "CORBA IDL marker"
                confidence = 0.95
            return DetectionResult(confidence=confidence, format="corbaidl", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".idl"):
            if text is not None and is_corbaidl(text):
                return DetectionResult(confidence=0.85, format="corbaidl", reason="`.idl` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CorbaIdlDocument:
        try:
            return parse_corbaidl(raw, source_label=source_label)
        except CorbaIdlParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CorbaIdlDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("CORBA IDL fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, CorbaIdlDocument):
            raise ImportSourceError(
                "CORBA IDL source must be a CorbaIdlDocument (see app.corbaidl_parser.parse_corbaidl)"
            )
        return self._normalize_via_registry("corbaidl", native_ast, include_raw=include_raw)
