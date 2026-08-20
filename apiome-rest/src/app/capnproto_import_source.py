"""Cap'n Proto import source — MFI-14.6.

The :class:`~app.import_source.ImportSource` adapter that makes Cap'n Proto ``.capnp`` schemas
importable into the catalog (store-raw, MFI-23.7). It wraps the MFI-14.1 parser and MFI-14.2
normalizer.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import capnproto_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .capnproto_parser import CapnpDocument, CapnpParseError, is_capnproto, parse_capnproto
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["CapnpImportSource"]


class CapnpImportSource(ImportSource, register=True):
    """Adapter for Cap'n Proto schemas (``.capnp`` file / url / paste)."""

    key = "capnproto"
    label = "Cap'n Proto"
    description = "Import a Cap'n Proto schema (.capnp) with structs, enums, and RPC interfaces."
    icon = "zap"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("capnproto", "capnp")
    file_extensions = (".capnp",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_capnproto(text):
            if re.search(r"@0x[0-9a-fA-F]+\s*;", text):
                reason = "Cap'n Proto file id (`@0x…`)"
            elif re.search(r"\binterface\s+\w+\s*\{", text):
                reason = "`interface` definition"
            elif re.search(r"\bstruct\s+\w+\s*\{", text):
                reason = "`struct` definition"
            else:
                reason = "Cap'n Proto schema marker"
            return DetectionResult(confidence=0.96, format="capnproto", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".capnp"):
            return DetectionResult(confidence=0.75, format="capnproto", reason="`.capnp` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CapnpDocument:
        try:
            return parse_capnproto(raw, source_label=source_label)
        except CapnpParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CapnpDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Cap'n Proto fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, CapnpDocument):
            raise ImportSourceError(
                "Cap'n Proto source must be a CapnpDocument "
                "(see app.capnproto_parser.parse_capnproto)"
            )
        return self._normalize_via_registry("capnproto", native_ast, include_raw=include_raw)
