"""EDI X12 import source — MFI-20.5.

The :class:`~app.import_source.ImportSource` adapter that makes ANSI X12 EDI
interchanges importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from . import edix12_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .edix12_analysis import (
    EDIX12_ANALYZER_KEY,
    EDIX12_ANALYZER_VERSION,
    analyze_edix12,
    edix12_capabilities,
    edix12_tool_versions,
)
from .edix12_parser import EdiX12Document, EdiX12ParseError, is_edix12, parse_edix12
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .payload_analysis import AnalyzerCapabilities, PayloadAnalysisDocument

__all__ = ["EdiX12ImportSource"]


class EdiX12ImportSource(ImportSource, register=True):
    """Adapter for ANSI ASC X12 EDI interchanges (``.edi`` / ``.x12`` file / url / paste)."""

    key = "edix12"
    label = "EDI X12"
    description = "Import an ANSI X12 EDI interchange and infer its transaction-set schema."
    icon = "file-text"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("edix12", "x12", "edi")
    analyzer_key = EDIX12_ANALYZER_KEY
    analyzer_version = EDIX12_ANALYZER_VERSION

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_edix12(text):
            return DetectionResult(
                confidence=0.95,
                format="edix12",
                reason="`ISA`/`GS`/`ST` X12 interchange markers",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith((".edi", ".x12")):
            if text is not None and is_edix12(text):
                return DetectionResult(confidence=0.85, format="edix12", reason="`.edi` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> EdiX12Document:
        try:
            return parse_edix12(raw, source_label=source_label)
        except EdiX12ParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> EdiX12Document:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("EDI X12 fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, EdiX12Document):
            raise ImportSourceError(
                "EDI X12 source must be an EdiX12Document (see app.edix12_parser.parse_edix12)"
            )
        return self._normalize_via_registry("edix12", native_ast, include_raw=include_raw)

    def analyzer_tool_versions(self) -> Dict[str, str]:
        """Return the ``pyx12`` release that read the interchange."""
        return edix12_tool_versions()

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the X12 extractor's capability declaration (CPDO-1.2).

        This is the **format-wide** answer — what the analyzer models given an interchange it can
        read — and it is what CPDO-2.4's registry publishes ahead of any import. It therefore
        declares the source-position constructs (CPDO-2.2) supported: the analyzer produces them
        for any interchange whose delimiter scan matches its parse, which is the ordinary case.

        The narrower, per-record answer lives on the record itself: :func:`analyze_edix12` stamps
        each analysis with what *that* analysis managed, so an interchange whose scan could not be
        aligned carries a declaration saying those constructs are absent from it.

        Returns:
            The analyzer's capability declaration.
        """
        return edix12_capabilities(source_positions=True)

    def analyze(
        self, native_ast: Any, *, source: Optional[str] = None
    ) -> PayloadAnalysisDocument:
        """Describe the interchange natively — every group and transaction set (CPDO-1.2).

        The canonical model normalizes only the *first* functional group's *first* transaction set,
        so a two-group interchange loses its second group at normalize time. The analysis is what
        keeps it: :func:`app.edix12_analysis.analyze_edix12` walks the whole envelope.

        Args:
            native_ast: The parsed :class:`~app.edix12_parser.EdiX12Document`.
            source: The exact interchange text analysed; defaults to the document's retained raw.

        Returns:
            The analysis document.

        Raises:
            ImportSourceError: If ``native_ast`` is not an X12 document.
        """
        if not isinstance(native_ast, EdiX12Document):
            raise ImportSourceError(
                "EDI X12 analysis needs an EdiX12Document (see app.edix12_parser.parse_edix12)"
            )
        return analyze_edix12(native_ast, source=source, source_format=self.key)
