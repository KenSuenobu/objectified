"""z/OS Connect import source — MFI-22.9.

The :class:`~app.import_source.ImportSource` adapter that makes z/OS Connect
descriptors importable into the catalog (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import zosconnect_normalizer  # noqa: F401 — self-registers the normalizer
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
from .zosconnect_parser import (
    ZosConnectDocument,
    ZosConnectParseError,
    is_zosconnect,
    parse_zosconnect,
)

__all__ = ["ZosConnectImportSource"]


class ZosConnectImportSource(ImportSource, register=True):
    """Adapter for z/OS Connect API requester/provider JSON descriptors."""

    key = "zosconnect"
    label = "z/OS Connect"
    description = "Import a z/OS Connect API requester or provider descriptor (.json)."
    icon = "server"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("zosconnect", "zos", "zos-connect")
    file_extensions = (".zosconnect.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_zosconnect(text):
            if '"apiProvider"' in text or "'apiProvider'" in text:
                reason = "`apiProvider` block with mapped `operations`"
            else:
                reason = "`apiRequester` block with mapped `operations`"
            return DetectionResult(confidence=0.98, format="zosconnect", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".json") and text is not None and is_zosconnect(text):
            return DetectionResult(
                confidence=0.85,
                format="zosconnect",
                reason="z/OS Connect JSON descriptor",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ZosConnectDocument:
        try:
            return parse_zosconnect(raw, source_label=source_label)
        except ZosConnectParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ZosConnectDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("z/OS Connect fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, ZosConnectDocument):
            raise ImportSourceError(
                "z/OS Connect source must be a ZosConnectDocument "
                "(see app.zosconnect_parser.parse_zosconnect)"
            )
        return self._normalize_via_registry("zosconnect", native_ast, include_raw=include_raw)
