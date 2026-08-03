"""Kubernetes Gateway API ``HTTPRoute`` import source — IXH-7.8 (#5133).

The :class:`~app.import_source.ImportSource` adapter that makes Gateway API
``HTTPRoute`` manifests (including multi-document YAML streams and manifest
directories) importable. HTTPRoutes describe a real surface — hostnames, path
matches, methods, filters — with no request/response schemas, so the import
routes to the catalog as non-publishable and the missing schemas are stated on
the coverage ledger as a capability limit of the format, never as a drop.

Detection keys on the ``apiVersion: gateway.networking.k8s.io/*`` +
``kind: HTTPRoute`` marker pair, which cannot collide with the Kubernetes CRD
adapter's ``apiextensions.k8s.io`` + ``CustomResourceDefinition`` markers.
"""

from __future__ import annotations

from typing import Any, Optional

from . import gateway_config_normalizer  # noqa: F401 — self-registers the normalizers
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .gateway_api_parser import (
    is_gateway_api_httproute,
    is_gateway_api_httproute_document,
    parse_gateway_api,
    parse_gateway_api_fileset,
)
from .gateway_config_model import GatewayConfigDocument, GatewayConfigParseError
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["GatewayApiImportSource"]


class GatewayApiImportSource(ImportSource, register=True):
    """Adapter for Gateway API HTTPRoute manifests (file / url / paste / fileset)."""

    key = "gateway-api"
    label = "Gateway API HTTPRoute"
    description = (
        "Import Kubernetes Gateway API HTTPRoute manifests (single document or "
        "multi-document stream) and normalize each rule's matches to canonical "
        "operations — hostnames, path patterns, methods, header/query matches. "
        "HTTPRoutes carry no request/response schemas, so the import lands in "
        "the catalog as non-publishable; supply schemas and convert to promote."
    )
    icon = "route"
    paradigm = ApiParadigm.REST
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.FILESET,
    )
    supports_live_discovery = False
    formats = ("gateway-api", "httproute")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_gateway_api_httproute(text):
            return DetectionResult(
                confidence=0.97,
                format="gateway-api",
                reason="`apiVersion: gateway.networking.k8s.io/*` + `kind: HTTPRoute`",
            )
        document = payload.document
        if document is not None and is_gateway_api_httproute_document(document):
            return DetectionResult(
                confidence=0.97,
                format="gateway-api",
                reason="`apiVersion: gateway.networking.k8s.io/*` + `kind: HTTPRoute`",
            )
        filename = (payload.filename or "").lower()
        if "httproute" in filename and filename.endswith((".yaml", ".yml")):
            return DetectionResult(
                confidence=0.65,
                format="gateway-api",
                reason="filename contains `httproute` with YAML extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> GatewayConfigDocument:
        try:
            return parse_gateway_api(raw, source_label=source_label)
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
                "Gateway API fileset has no members", code="INPUT_MALFORMED"
            )
        try:
            return parse_gateway_api_fileset(
                fileset.members,
                root=fileset.root,
                source_label=source_label or fileset.root,
            )
        except GatewayConfigParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, GatewayConfigDocument):
            raise ImportSourceError(
                "Gateway API source must be a GatewayConfigDocument "
                "(see app.gateway_api_parser.parse_gateway_api)"
            )
        return self._normalize_via_registry(
            "gateway-api", native_ast, include_raw=include_raw
        )
