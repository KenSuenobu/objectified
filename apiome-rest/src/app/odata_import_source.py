"""OData CSDL / EDMX import source — MFI-22.1.

The :class:`~app.import_source.ImportSource` adapter that makes OData ``.edmx`` / CSDL
documents importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import odata_normalizer  # noqa: F401 — self-registers the normalizer
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
from .odata_parser import ODataDocument, ODataParseError, is_odata, parse_odata
from .secure_xml import SecureXmlError

__all__ = ["ODataImportSource"]


class ODataImportSource(ImportSource, register=True):
    """Adapter for OData v4 CSDL / EDMX documents (``.edmx`` file / url / paste)."""

    key = "odata"
    label = "OData"
    description = "Import an OData v4 CSDL / EDMX service metadata document."
    icon = "database"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("odata", "edmx")
    file_extensions = (".edmx", ".xml")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_odata(text):
            if "<edmx:Edmx" in text:
                reason = "`<edmx:Edmx>` root"
            else:
                reason = "OData `<Edmx>` root"
            return DetectionResult(confidence=0.98, format="odata", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".edmx"):
            if text is not None and is_odata(text):
                return DetectionResult(confidence=0.85, format="odata", reason="`.edmx` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ODataDocument:
        try:
            return parse_odata(raw, source_label=source_label)
        except (ODataParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD /
            # entity / external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ODataDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("OData fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, ODataDocument):
            raise ImportSourceError(
                "OData source must be an ODataDocument (see app.odata_parser.parse_odata)"
            )
        return self._normalize_via_registry("odata", native_ast, include_raw=include_raw)
