"""WIT (WebAssembly Component Model) import source — IXH-7.9.

The :class:`~app.import_source.ImportSource` adapter that makes WIT (``.wit``)
interface packages importable into the catalog (store-raw, MFI-23.7). It wraps
the IXH-7.9 parser (:mod:`app.wit_parser`) and normalizer
(:mod:`app.wit_normalizer`): worlds/interfaces normalize to services, functions
to operations, and the WIT type system to canonical types, with
canonical-inexpressible constructs recorded as capability limits.

Fileset intake (archive/git) merges every ``.wit`` member into one package, so
``use`` statements resolve across the files of the supplied package.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import wit_normalizer  # noqa: F401 — self-registers the normalizer
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
from .wit_parser import WitDocument, WitParseError, is_wit, parse_wit, parse_wit_package

__all__ = ["WitImportSource"]


class WitImportSource(ImportSource, register=True):
    """Adapter for WIT packages (``.wit`` file / url / paste / fileset)."""

    key = "wit"
    label = "WIT (WebAssembly)"
    description = (
        "Import a WebAssembly Component Model WIT package with worlds, interfaces, "
        "functions, and the WIT type system."
    )
    icon = "component"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("wit",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_wit(text):
            if re.search(r"^\s*package\s+[a-z][\w-]*:[a-z]", text, re.MULTILINE):
                reason = "WIT `package ns:name` declaration"
                confidence = 0.97
            elif re.search(r"\bworld\s+[a-z][a-z0-9-]*\s*\{", text):
                reason = "WIT `world` definition"
                confidence = 0.92
            else:
                reason = "WIT `interface` definition with WIT type/function syntax"
                confidence = 0.92
            return DetectionResult(confidence=confidence, format="wit", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".wit"):
            return DetectionResult(
                confidence=0.75, format="wit", reason="`.wit` file extension"
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> WitDocument:
        try:
            return parse_wit(raw, source_label=source_label)
        except WitParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> WitDocument:
        try:
            return parse_wit_package(
                dict(fileset.members), source_label=fileset.root or source_label
            )
        except WitParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, WitDocument):
            raise ImportSourceError(
                "WIT source must be a WitDocument (see app.wit_parser.parse_wit)"
            )
        return self._normalize_via_registry("wit", native_ast, include_raw=include_raw)
