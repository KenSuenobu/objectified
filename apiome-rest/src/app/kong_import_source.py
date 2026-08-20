"""Kong declarative-config import source — IXH-7.8 (#5133).

The :class:`~app.import_source.ImportSource` adapter that makes Kong declarative
YAML/JSON (`deck` files) importable. Gateway configs describe a real surface —
hosts, path patterns, methods, auth plugins — with no request/response schemas,
so the import routes to the catalog as non-publishable and the missing schemas
are stated on the coverage ledger as a capability limit of the format, never as
a drop. Consumer credentials are redacted at parse time and the shared intake
secret scrub is always enforced for this format
(:data:`app.intake_scrub_policy.ALWAYS_ENFORCED_FORMATS`).
"""

from __future__ import annotations

from typing import Any, Optional

from . import gateway_config_normalizer  # noqa: F401 — self-registers the normalizers
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .gateway_config_model import GatewayConfigDocument, GatewayConfigParseError
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .kong_parser import (
    is_kong_declarative,
    is_kong_declarative_document,
    parse_kong_declarative,
    parse_kong_fileset,
)

__all__ = ["KongImportSource"]


class KongImportSource(ImportSource, register=True):
    """Adapter for Kong declarative config (YAML/JSON, single file or fileset)."""

    key = "kong"
    label = "Kong Declarative Config"
    description = (
        "Import a Kong declarative (deck) YAML/JSON config and normalize its "
        "routes to canonical operations — hosts, path patterns, methods, and "
        "auth plugins mapped to canonical security. Gateway configs carry no "
        "request/response schemas, so the import lands in the catalog as "
        "non-publishable; supply schemas and convert to promote."
    )
    icon = "waypoints"
    paradigm = ApiParadigm.REST
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.FILESET,
    )
    supports_live_discovery = False
    formats = ("kong", "kong-declarative")
    file_extensions = (".yaml", ".yml", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_kong_declarative(text):
            return DetectionResult(
                confidence=0.95,
                format="kong",
                reason="`_format_version` + services/routes declarative sections",
            )
        document = payload.document
        if document is not None and is_kong_declarative_document(document):
            return DetectionResult(
                confidence=0.95,
                format="kong",
                reason="`_format_version` + services/routes declarative sections",
            )
        filename = (payload.filename or "").lower()
        if filename in ("kong.yml", "kong.yaml", "kong.json") or filename.endswith(
            ("/kong.yml", "/kong.yaml", "/kong.json")
        ):
            return DetectionResult(
                confidence=0.7,
                format="kong",
                reason="`kong.yml` / `kong.yaml` filename",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> GatewayConfigDocument:
        try:
            return parse_kong_declarative(raw, source_label=source_label)
        except GatewayConfigParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> GatewayConfigDocument:
        if not fileset.members:
            raise ImportSourceError(
                "Kong declarative fileset has no members", code="INPUT_MALFORMED"
            )
        try:
            return parse_kong_fileset(
                fileset.members,
                root=fileset.root,
                source_label=source_label or fileset.root,
            )
        except GatewayConfigParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, GatewayConfigDocument):
            raise ImportSourceError(
                "Kong source must be a GatewayConfigDocument "
                "(see app.kong_parser.parse_kong_declarative)"
            )
        return self._normalize_via_registry("kong", native_ast, include_raw=include_raw)
