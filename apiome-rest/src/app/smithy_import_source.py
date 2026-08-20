"""Smithy import source.

The :class:`~app.import_source.ImportSource` adapter that makes Smithy IDL models
importable into the catalog (store-raw).
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import smithy_normalizer  # noqa: F401 — self-registers the normalizer
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
from .smithy_parser import SmithyDocument, SmithyParseError, is_smithy, parse_smithy

__all__ = ["SmithyImportSource"]


class SmithyImportSource(ImportSource, register=True):
    """Adapter for Smithy 2.x IDL model files."""

    key = "smithy"
    label = "Smithy"
    description = "Import a Smithy IDL model (structures, enums, services, operations)."
    icon = "hammer"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("smithy",)
    file_extensions = (".smithy",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_smithy(text):
            if re.search(r"""^\s*\$version\s*:\s*['"]""", text, re.MULTILINE):
                reason = "`$version` control statement"
            elif re.search(r"^\s*service\s+\w", text, re.MULTILINE):
                reason = "`service` definition"
            elif re.search(r"^\s*structure\s+\w", text, re.MULTILINE):
                reason = "`structure` definition"
            elif re.search(r"^\s*operation\s+\w", text, re.MULTILINE):
                reason = "`operation` definition"
            else:
                reason = "Smithy IDL marker"
            return DetectionResult(confidence=0.95, format="smithy", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".smithy"):
            if text is not None and is_smithy(text):
                return DetectionResult(
                    confidence=0.9,
                    format="smithy",
                    reason="`.smithy` file extension",
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> SmithyDocument:
        try:
            return parse_smithy(raw, source_label=source_label)
        except SmithyParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> SmithyDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Smithy fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, SmithyDocument):
            raise ImportSourceError(
                "Smithy source must be a SmithyDocument (see app.smithy_parser.parse_smithy)"
            )
        return self._normalize_via_registry("smithy", native_ast, include_raw=include_raw)
