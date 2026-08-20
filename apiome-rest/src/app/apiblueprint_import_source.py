"""API Blueprint import source.

The :class:`~app.import_source.ImportSource` adapter that makes API Blueprint
documents importable into the catalog (store-raw).
"""

from __future__ import annotations

from typing import Any, Optional

from . import apiblueprint_normalizer  # noqa: F401 — self-registers the normalizer
from .apiblueprint_parser import (
    ApiblueprintDocument,
    ApiblueprintParseError,
    is_apiblueprint,
    parse_apiblueprint,
)
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

__all__ = ["ApiblueprintImportSource"]


class ApiblueprintImportSource(ImportSource, register=True):
    """Adapter for API Blueprint 1A markdown documents."""

    key = "apiblueprint"
    label = "API Blueprint"
    description = "Import an API Blueprint 1A REST API description with MSON data structures."
    icon = "file-text"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("apiblueprint", "api-blueprint", "apib", "blueprint")
    # `.md` is listed because API Blueprint is a Markdown dialect and is routinely saved as
    # plain `.md`; the `FORMAT: 1A` content marker is what actually claims the document.
    file_extensions = (".apib", ".md")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_apiblueprint(text):
            return DetectionResult(
                confidence=0.98,
                format="api-blueprint",
                reason="API Blueprint `FORMAT: 1A` marker",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".apib"):
            if text is not None and is_apiblueprint(text):
                return DetectionResult(
                    confidence=0.9,
                    format="api-blueprint",
                    reason="`.apib` file extension",
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ApiblueprintDocument:
        try:
            return parse_apiblueprint(raw, source_label=source_label)
        except ApiblueprintParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ApiblueprintDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("API Blueprint fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, ApiblueprintDocument):
            raise ImportSourceError(
                "API Blueprint source must be an ApiblueprintDocument "
                "(see app.apiblueprint_parser.parse_apiblueprint)"
            )
        return self._normalize_via_registry("apiblueprint", native_ast, include_raw=include_raw)
