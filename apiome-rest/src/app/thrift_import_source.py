"""Apache Thrift import source — MFI-11.6.

The :class:`~app.import_source.ImportSource` adapter that makes Thrift IDL importable into
the catalog (store-raw, MFI-23.7). It wraps the MFI-11.1 parser and MFI-11.2 normalizer:

* **parse** turns ``.thrift`` text into a :class:`~app.thrift_parser.ThriftDocument`;
* **normalize** delegates to :class:`~app.thrift_normalizer.ThriftNormalizer`;
* **fingerprint** / **diff** / **lint** use the canonical-model defaults from
  :mod:`app.import_source`.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import thrift_normalizer  # noqa: F401 — self-registers the normalizer
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
from .thrift_parser import ThriftDocument, ThriftParseError, is_thrift, parse_thrift

__all__ = ["ThriftImportSource"]


class ThriftImportSource(ImportSource, register=True):
    """Adapter for Apache Thrift IDL (``.thrift`` file / url / paste)."""

    key = "thrift"
    label = "Thrift"
    description = "Import an Apache Thrift IDL document (structs, enums, services)."
    icon = "network"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("thrift",)
    file_extensions = (".thrift",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_thrift(text):
            if 'include "' in text:
                reason = '`include "..."` marker'
            elif re.search(r"^\s*namespace\s+\w+\s+", text, re.MULTILINE):
                reason = "`namespace` declaration"
            elif "struct " in text:
                reason = "`struct` definition"
            elif "enum " in text:
                reason = "`enum` definition"
            elif "service " in text:
                reason = "`service` definition"
            else:
                reason = "Thrift IDL marker"
            return DetectionResult(confidence=0.95, format="thrift", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".thrift"):
            return DetectionResult(confidence=0.7, format="thrift", reason="`.thrift` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ThriftDocument:
        try:
            return parse_thrift(raw, source_label=source_label)
        except ThriftParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ThriftDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Thrift fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, ThriftDocument):
            raise ImportSourceError(
                "Thrift source must be a ThriftDocument (see app.thrift_parser.parse_thrift)"
            )
        return self._normalize_via_registry("thrift", native_ast, include_raw=include_raw)
