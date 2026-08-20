"""FIX import source — MFI-22.8.

The :class:`~app.import_source.ImportSource` adapter that makes FIX messages
importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import fix_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .fix_parser import FixDocument, FixParseError, is_fix, parse_fix
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["FixImportSource"]


class FixImportSource(ImportSource, register=True):
    """Adapter for FIX tag=value trading messages (``.fix`` file / url / paste)."""

    key = "fix"
    label = "FIX"
    description = "Import a FIX tag=value message and infer its field schema."
    icon = "trending-up"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("fix", "fixprotocol")
    file_extensions = (".fix",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_fix(text):
            return DetectionResult(
                confidence=0.98,
                format="fix",
                reason="`8=FIX.` BeginString with tag=value fields",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".fix") and text is not None and is_fix(text):
            return DetectionResult(
                confidence=0.85,
                format="fix",
                reason="`.fix` file extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> FixDocument:
        try:
            return parse_fix(raw, source_label=source_label)
        except FixParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> FixDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("FIX fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, FixDocument):
            raise ImportSourceError(
                "FIX source must be a FixDocument (see app.fix_parser.parse_fix)"
            )
        return self._normalize_via_registry("fix", native_ast, include_raw=include_raw)
