"""WSDL import source — MFI-15.6.

The :class:`~app.import_source.ImportSource` adapter that makes SOAP WSDL documents
importable into the catalog (store-raw, MFI-23.7). It wraps the MFI-15.1 parser and
MFI-15.2 normalizer.
"""

from __future__ import annotations

from typing import Any, Optional

from . import wsdl_normalizer  # noqa: F401 — self-registers the normalizer
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
from .wsdl_parser import WsdlDocument, WsdlParseError, is_wsdl, parse_wsdl
from .secure_xml import SecureXmlError

__all__ = ["WsdlImportSource"]


class WsdlImportSource(ImportSource, register=True):
    """Adapter for SOAP WSDL documents (``.wsdl`` file / url / paste)."""

    key = "wsdl"
    label = "WSDL"
    description = "Import a SOAP web service description (WSDL 1.1) with embedded XSD types."
    icon = "file-code"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("wsdl", "soap")
    file_extensions = (".wsdl", ".xml")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_wsdl(text):
            if "<wsdl:definitions" in text:
                reason = "`<wsdl:definitions>` root"
            else:
                reason = "WSDL `definitions` root"
            return DetectionResult(confidence=0.97, format="wsdl", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".wsdl"):
            return DetectionResult(confidence=0.75, format="wsdl", reason="`.wsdl` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> WsdlDocument:
        try:
            return parse_wsdl(raw, source_label=source_label)
        except (WsdlParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD /
            # entity / external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> WsdlDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("WSDL fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, WsdlDocument):
            raise ImportSourceError(
                "WSDL source must be a WsdlDocument (see app.wsdl_parser.parse_wsdl)"
            )
        return self._normalize_via_registry("wsdl", native_ast, include_raw=include_raw)
