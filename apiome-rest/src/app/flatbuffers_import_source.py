"""FlatBuffers import source — MFI-13.6.

The :class:`~app.import_source.ImportSource` adapter that makes FlatBuffers ``.fbs`` schemas
importable into the catalog (store-raw, MFI-23.7). It wraps the MFI-13.1 parser and MFI-13.2
normalizer.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import flatbuffers_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .flatbuffers_parser import (
    FlatBuffersDocument,
    FlatBuffersParseError,
    is_flatbuffers,
    parse_flatbuffers,
)
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["FlatBuffersImportSource"]


class FlatBuffersImportSource(ImportSource, register=True):
    """Adapter for FlatBuffers serialization schemas (``.fbs`` file / url / paste)."""

    key = "flatbuffers"
    label = "FlatBuffers"
    description = "Import a FlatBuffers schema (.fbs) with tables, structs, enums, and root types."
    icon = "boxes"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("flatbuffers", "fbs")
    file_extensions = (".fbs",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_flatbuffers(text):
            if re.search(r"\broot_type\s+\w+", text):
                reason = "`root_type` declaration"
            elif re.search(r"\btable\s+\w+", text):
                reason = "`table` definition"
            elif re.search(r"\bstruct\s+\w+", text):
                reason = "`struct` definition"
            elif re.search(r"\bunion\s+\w+", text):
                reason = "`union` definition"
            else:
                reason = "FlatBuffers schema marker"
            return DetectionResult(confidence=0.96, format="flatbuffers", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".fbs"):
            return DetectionResult(confidence=0.75, format="flatbuffers", reason="`.fbs` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> FlatBuffersDocument:
        try:
            return parse_flatbuffers(raw, source_label=source_label)
        except FlatBuffersParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> FlatBuffersDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("FlatBuffers fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, FlatBuffersDocument):
            raise ImportSourceError(
                "FlatBuffers source must be a FlatBuffersDocument "
                "(see app.flatbuffers_parser.parse_flatbuffers)"
            )
        return self._normalize_via_registry("flatbuffers", native_ast, include_raw=include_raw)
