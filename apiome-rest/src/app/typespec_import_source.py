"""Microsoft TypeSpec import source — MFI-22.3.

The :class:`~app.import_source.ImportSource` adapter that makes TypeSpec ``.tsp``
documents importable into the catalog.
"""

from __future__ import annotations

from typing import Any, Optional

from . import typespec_normalizer  # noqa: F401 — self-registers the normalizer
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
from .typespec_parser import TypeSpecDocument, TypeSpecParseError, is_typespec, parse_typespec

__all__ = ["TypeSpecImportSource"]


class TypeSpecImportSource(ImportSource, register=True):
    """Adapter for Microsoft TypeSpec ``.tsp`` API definitions."""

    key = "typespec"
    label = "TypeSpec"
    description = "Import a Microsoft TypeSpec API definition (.tsp)."
    icon = "file-code"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("typespec", "tsp", "cadl")
    file_extensions = (".tsp", ".cadl")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_typespec(text):
            if 'import "@typespec/' in text or "import '@typespec/" in text:
                return DetectionResult(
                    confidence=0.98,
                    format="typespec",
                    reason='`import "@typespec/..."` marker',
                )
            if "model " in text or "interface " in text:
                return DetectionResult(
                    confidence=0.96,
                    format="typespec",
                    reason="TypeSpec `model` / `interface` declarations",
                )
            return DetectionResult(
                confidence=0.94,
                format="typespec",
                reason="TypeSpec namespace marker",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".tsp") and text is not None and is_typespec(text):
            return DetectionResult(
                confidence=0.85,
                format="typespec",
                reason="TypeSpec `.tsp` filename extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> TypeSpecDocument:
        try:
            return parse_typespec(raw, source_label=source_label)
        except TypeSpecParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> TypeSpecDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("TypeSpec fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, TypeSpecDocument):
            raise ImportSourceError(
                "TypeSpec source must be a TypeSpecDocument (see app.typespec_parser.parse_typespec)"
            )
        return self._normalize_via_registry("typespec", native_ast, include_raw=include_raw)
