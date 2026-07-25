"""WADL import source — MFI-17.6.

The :class:`~app.import_source.ImportSource` adapter that makes WADL REST service
descriptions importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import wadl_normalizer  # noqa: F401 — self-registers the normalizer
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
from .wadl_parser import WadlDocument, WadlParseError, is_wadl, parse_wadl
from .secure_xml import SecureXmlError

__all__ = ["WadlImportSource"]


class WadlImportSource(ImportSource, register=True):
    """Adapter for WADL REST service descriptions (``.wadl`` file / url / paste)."""

    key = "wadl"
    label = "WADL"
    description = "Import a WADL REST service description with embedded XSD grammars."
    icon = "file-code"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("wadl", "restdescription")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_wadl(text):
            return DetectionResult(
                confidence=0.97,
                format="wadl",
                reason="`<application>` root with WADL namespace",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".wadl"):
            return DetectionResult(confidence=0.75, format="wadl", reason="`.wadl` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> WadlDocument:
        try:
            return parse_wadl(raw, source_label=source_label)
        except (WadlParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD /
            # entity / external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> WadlDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("WADL fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, WadlDocument):
            raise ImportSourceError(
                "WADL source must be a WadlDocument (see app.wadl_parser.parse_wadl)"
            )
        return self._normalize_via_registry("wadl", native_ast, include_raw=include_raw)
