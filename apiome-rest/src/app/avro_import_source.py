"""Avro import source — MFI-19.6.

The :class:`~app.import_source.ImportSource` adapter that makes Apache Avro schemas
importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import avro_normalizer  # noqa: F401 — self-registers the normalizer
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
from .avro_parser import AvroDocument, AvroParseError, is_avro, is_avro_document, parse_avro

__all__ = ["AvroImportSource"]


class AvroImportSource(ImportSource, register=True):
    """Adapter for Apache Avro record schemas (``.avsc`` / ``.json`` file / url / paste)."""

    key = "avro"
    label = "Avro"
    description = "Import an Apache Avro schema (.avsc) as a schemas-only catalog source."
    icon = "binary"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("avro", "avsc")
    file_extensions = (".avsc", ".avro")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_avro(text):
            return DetectionResult(
                confidence=0.95,
                format="avro",
                reason="Avro `type: record` with `fields`",
            )

        document = payload.document
        if document is not None and is_avro_document(document):
            name = document.get("name")
            if isinstance(name, str) and name:
                reason = f"Avro record `{name}`"
            else:
                reason = "Avro `type: record` with `fields`"
            return DetectionResult(confidence=0.95, format="avro", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".avsc"):
            return DetectionResult(confidence=0.8, format="avro", reason="`.avsc` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> AvroDocument:
        try:
            return parse_avro(raw, source_label=source_label)
        except AvroParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> AvroDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Avro fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, AvroDocument):
            raise ImportSourceError(
                "Avro source must be an AvroDocument (see app.avro_parser.parse_avro)"
            )
        return self._normalize_via_registry("avro", native_ast, include_raw=include_raw)
