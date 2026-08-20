"""XSD import source.

The :class:`~app.import_source.ImportSource` adapter that makes XML Schema (XSD)
documents importable into the catalog (store-raw).
"""

from __future__ import annotations

from typing import Any, Optional

from . import xsd_normalizer  # noqa: F401 — self-registers the normalizer
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
from .xsd_parser import XsdDocument, XsdParseError, is_xsd, parse_xsd
from .secure_xml import SecureXmlError

__all__ = ["XsdImportSource"]


class XsdImportSource(ImportSource, register=True):
    """Adapter for W3C XML Schema (``.xsd``) documents."""

    key = "xsd"
    label = "XSD"
    description = "Import an XML Schema Definition (XSD) as a schemas-only catalog source."
    icon = "file-code"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("xsd", "xmlschema")
    file_extensions = (".xsd",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_xsd(text):
            return DetectionResult(
                confidence=0.98,
                format="xsd",
                reason="`xs:schema` / W3C XML Schema root",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".xsd"):
            if text is not None and is_xsd(text):
                return DetectionResult(confidence=0.9, format="xsd", reason="`.xsd` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> XsdDocument:
        try:
            return parse_xsd(raw, source_label=source_label)
        except (XsdParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD /
            # entity / external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> XsdDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("XSD fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, XsdDocument):
            raise ImportSourceError(
                "XSD source must be an XsdDocument (see app.xsd_parser.parse_xsd)"
            )
        return self._normalize_via_registry("xsd", native_ast, include_raw=include_raw)
