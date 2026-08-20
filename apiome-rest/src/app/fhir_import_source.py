"""HL7 FHIR R4 import source — MFI-22.2.

The :class:`~app.import_source.ImportSource` adapter that makes FHIR JSON documents
importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import fhir_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fhir_parser import FhirDocument, FhirParseError, is_fhir, parse_fhir
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["FhirImportSource"]


class FhirImportSource(ImportSource, register=True):
    """Adapter for HL7 FHIR R4 JSON (StructureDefinition profiles and resource instances)."""

    key = "fhir"
    label = "FHIR"
    description = "Import an HL7 FHIR R4 StructureDefinition profile or resource instance."
    icon = "heart-pulse"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("fhir", "fhirr4", "structuredefinition")
    file_extensions = (".fhir.json", ".structuredefinition.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_fhir(text):
            if '"resourceType": "StructureDefinition"' in text or '"resourceType":"StructureDefinition"' in text:
                reason = "`resourceType: StructureDefinition`"
                confidence = 0.98
            elif "hl7.org/fhir" in text.lower():
                reason = "HL7 FHIR profile URL marker"
                confidence = 0.97
            else:
                reason = "FHIR `resourceType` marker"
                confidence = 0.95
            return DetectionResult(confidence=confidence, format="fhir", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".fhir.json") or filename.endswith(".structuredefinition.json"):
            if text is not None and is_fhir(text):
                return DetectionResult(confidence=0.85, format="fhir", reason="FHIR filename extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> FhirDocument:
        try:
            return parse_fhir(raw, source_label=source_label)
        except FhirParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> FhirDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("FHIR fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, FhirDocument):
            raise ImportSourceError(
                "FHIR source must be a FhirDocument (see app.fhir_parser.parse_fhir)"
            )
        return self._normalize_via_registry("fhir", native_ast, include_raw=include_raw)
