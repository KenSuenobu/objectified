"""ISO 8583 import source — MFI-22.6.

The :class:`~app.import_source.ImportSource` adapter that makes ISO 8583 field-map
JSON documents importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

import json
from typing import Any, Optional

from . import iso8583_normalizer  # noqa: F401 — self-registers the normalizer
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
from .iso8583_parser import Iso8583Document, Iso8583ParseError, is_iso8583, parse_iso8583

__all__ = ["Iso8583ImportSource"]


class Iso8583ImportSource(ImportSource, register=True):
    """Adapter for ISO 8583 card transaction field-map JSON documents."""

    key = "iso8583"
    label = "ISO 8583"
    description = "Import an ISO 8583 MTI + data-element field map and infer its message schema."
    icon = "credit-card"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("iso8583",)
    file_extensions = (".iso8583.json", ".8583.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_iso8583(text):
            return DetectionResult(
                confidence=0.98,
                format="iso8583",
                reason="`mti` + `dataElements` ISO 8583 field map",
            )

        document = payload.document
        if isinstance(document, dict) and is_iso8583(
            json.dumps(document, separators=(",", ":"))
        ):
            return DetectionResult(
                confidence=0.96,
                format="iso8583",
                reason="`mti` + `dataElements` ISO 8583 field map",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith((".iso8583.json", ".8583.json")) and text is not None and is_iso8583(text):
            return DetectionResult(
                confidence=0.85,
                format="iso8583",
                reason="`.iso8583.json` file extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Iso8583Document:
        try:
            return parse_iso8583(raw, source_label=source_label)
        except Iso8583ParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> Iso8583Document:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("ISO 8583 fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, Iso8583Document):
            raise ImportSourceError(
                "ISO 8583 source must be an Iso8583Document (see app.iso8583_parser.parse_iso8583)"
            )
        return self._normalize_via_registry("iso8583", native_ast, include_raw=include_raw)
