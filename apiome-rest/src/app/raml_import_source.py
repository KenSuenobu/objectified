"""RAML import source — MFI-16.6.

The :class:`~app.import_source.ImportSource` adapter that makes RAML REST API
definitions importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import raml_normalizer  # noqa: F401 — self-registers the normalizer
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
from .raml_parser import RamlDocument, RamlParseError, is_raml, parse_raml

__all__ = ["RamlImportSource"]

_RAMl_HEADER_RE = re.compile(r"^\s*#%RAML\s+(\d+\.\d+)", re.IGNORECASE)


class RamlImportSource(ImportSource, register=True):
    """Adapter for RAML REST API definitions (``.raml`` file / url / paste)."""

    key = "raml"
    label = "RAML"
    description = "Import a RAML 1.0 REST API definition with types and resources."
    icon = "book-marked"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("raml",)
    file_extensions = (".raml",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_raml(text):
            match = _RAMl_HEADER_RE.match(text.strip())
            if match:
                reason = f"`#%RAML {match.group(1)}` header"
            else:
                reason = "RAML root keys (`title` + `baseUri`/`types`)"
            return DetectionResult(confidence=0.99 if match else 0.85, format="raml", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".raml"):
            return DetectionResult(confidence=0.75, format="raml", reason="`.raml` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> RamlDocument:
        try:
            return parse_raml(raw, source_label=source_label)
        except RamlParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> RamlDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("RAML fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, RamlDocument):
            raise ImportSourceError(
                "RAML source must be a RamlDocument (see app.raml_parser.parse_raml)"
            )
        return self._normalize_via_registry("raml", native_ast, include_raw=include_raw)
