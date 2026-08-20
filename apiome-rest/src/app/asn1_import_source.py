"""ASN.1 import source — MFI-21.5.

The :class:`~app.import_source.ImportSource` adapter that makes ASN.1 modules
importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import asn1_normalizer  # noqa: F401 — self-registers the normalizer
from .asn1_parser import Asn1Document, Asn1ParseError, is_asn1, parse_asn1
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

__all__ = ["Asn1ImportSource"]


class Asn1ImportSource(ImportSource, register=True):
    """Adapter for ASN.1 module definitions (``.asn1`` file / url / paste)."""

    key = "asn1"
    label = "ASN.1"
    description = "Import an ASN.1 module (SEQUENCE / CHOICE / ENUMERATED) as a schemas-only catalog source."
    icon = "binary"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("asn1", "asn")
    file_extensions = (".asn1", ".asn")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_asn1(text):
            return DetectionResult(
                confidence=0.95,
                format="asn1",
                reason="`DEFINITIONS ::= BEGIN` module marker",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".asn1") or filename.endswith(".asn"):
            if text is not None and is_asn1(text):
                return DetectionResult(confidence=0.85, format="asn1", reason="`.asn1` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Asn1Document:
        try:
            return parse_asn1(raw, source_label=source_label)
        except Asn1ParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> Asn1Document:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("ASN.1 fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, Asn1Document):
            raise ImportSourceError(
                "ASN.1 source must be an Asn1Document (see app.asn1_parser.parse_asn1)"
            )
        return self._normalize_via_registry("asn1", native_ast, include_raw=include_raw)
