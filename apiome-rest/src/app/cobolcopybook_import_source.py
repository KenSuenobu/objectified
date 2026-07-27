"""COBOL copybook import source — MFI-22.7.

The :class:`~app.import_source.ImportSource` adapter that makes COBOL copybooks
importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from . import cobolcopybook_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .cobolcopybook_analysis import (
    COBOL_ANALYZER_KEY,
    COBOL_ANALYZER_VERSION,
    analyze_cobolcopybook,
    cobolcopybook_capabilities,
    cobolcopybook_tool_versions,
)
from .cobolcopybook_parser import (
    CobolCopybookDocument,
    CobolCopybookParseError,
    is_cobolcopybook,
    parse_cobolcopybook,
)
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

__all__ = ["CobolCopybookImportSource"]


class CobolCopybookImportSource(ImportSource, register=True):
    """Adapter for COBOL copybook record layouts (``.cpy`` / ``.copybook``)."""

    key = "cobolcopybook"
    label = "COBOL Copybook"
    description = "Import a COBOL copybook record layout and infer its data schema."
    icon = "file-code"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("cobolcopybook", "copybook", "cobol", "cobol-copybook")
    analyzer_key = COBOL_ANALYZER_KEY
    analyzer_version = COBOL_ANALYZER_VERSION

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_cobolcopybook(text):
            if " OCCURS " in text.upper():
                reason = "level-01 group with `PIC` / `OCCURS` clauses"
            else:
                reason = "level-01 group with `PIC` clauses"
            return DetectionResult(confidence=0.98, format="cobolcopybook", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith((".cpy", ".copybook", ".cbl")) and text is not None and is_cobolcopybook(text):
            return DetectionResult(
                confidence=0.85,
                format="cobolcopybook",
                reason="COBOL copybook filename extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CobolCopybookDocument:
        try:
            return parse_cobolcopybook(raw, source_label=source_label)
        except CobolCopybookParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CobolCopybookDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("COBOL copybook fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, CobolCopybookDocument):
            raise ImportSourceError(
                "COBOL copybook source must be a CobolCopybookDocument "
                "(see app.cobolcopybook_parser.parse_cobolcopybook)"
            )
        return self._normalize_via_registry("cobolcopybook", native_ast, include_raw=include_raw)

    def analyzer_tool_versions(self) -> Dict[str, str]:
        """Return the copybook parser version behind the analysis."""
        return cobolcopybook_tool_versions()

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the copybook extractor's capability declaration (CPDO-1.2)."""
        return cobolcopybook_capabilities()

    def analyze(
        self, native_ast: Any, *, source: Optional[str] = None
    ) -> PayloadAnalysisDocument:
        """Describe the copybook natively — levels, PIC, USAGE, OCCURS, 88s (CPDO-1.2).

        The canonical model keeps a field's name and type; everything that makes a copybook a
        *layout* is derived at import and otherwise lost. This keeps it, and reports the clauses the
        parser does not read rather than letting them vanish silently.

        Args:
            native_ast: The parsed :class:`~app.cobolcopybook_parser.CobolCopybookDocument`.
            source: The exact copybook text analysed; defaults to the document's retained raw.

        Returns:
            The analysis document.

        Raises:
            ImportSourceError: If ``native_ast`` is not a copybook document.
        """
        if not isinstance(native_ast, CobolCopybookDocument):
            raise ImportSourceError(
                "COBOL copybook analysis needs a CobolCopybookDocument "
                "(see app.cobolcopybook_parser.parse_cobolcopybook)"
            )
        return analyze_cobolcopybook(native_ast, source=source, source_format=self.key)
