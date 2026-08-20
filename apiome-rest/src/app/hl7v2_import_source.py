"""HL7 v2.x import source — MFI-22.4.

The :class:`~app.import_source.ImportSource` adapter that makes HL7 v2 messages
importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import hl7v2_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .hl7v2_parser import Hl7V2Document, Hl7V2ParseError, is_hl7v2, parse_hl7v2
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["Hl7V2ImportSource"]


class Hl7V2ImportSource(ImportSource, register=True):
    """Adapter for HL7 v2.x healthcare messages (``.hl7`` file / url / paste)."""

    key = "hl7v2"
    label = "HL7 v2"
    description = "Import an HL7 v2.x healthcare message and infer its segment schema."
    icon = "heart-pulse"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("hl7v2", "hl7", "hl7v2x")
    file_extensions = (".hl7",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_hl7v2(text):
            return DetectionResult(
                confidence=0.98,
                format="hl7v2",
                reason="`MSH|^~\\&|` HL7 v2 message header",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".hl7") and text is not None and is_hl7v2(text):
            return DetectionResult(
                confidence=0.85,
                format="hl7v2",
                reason="`.hl7` file extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Hl7V2Document:
        try:
            return parse_hl7v2(raw, source_label=source_label)
        except Hl7V2ParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> Hl7V2Document:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("HL7 v2 fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, Hl7V2Document):
            raise ImportSourceError(
                "HL7 v2 source must be an Hl7V2Document (see app.hl7v2_parser.parse_hl7v2)"
            )
        return self._normalize_via_registry("hl7v2", native_ast, include_raw=include_raw)
