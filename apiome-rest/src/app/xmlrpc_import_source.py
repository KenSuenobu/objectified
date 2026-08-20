"""XML-RPC import source.

The :class:`~app.import_source.ImportSource` adapter that makes XML-RPC messages
importable into the catalog (store-raw).
"""

from __future__ import annotations

from typing import Any, Optional

from . import xmlrpc_normalizer  # noqa: F401 — self-registers the normalizer
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
from .secure_xml import SecureXmlError
from .xmlrpc_parser import (
    XmlRpcDocument,
    XmlRpcParseError,
    is_xmlrpc,
    parse_xmlrpc,
)

__all__ = ["XmlRpcImportSource"]


class XmlRpcImportSource(ImportSource, register=True):
    """Adapter for XML-RPC ``methodCall`` / ``methodResponse`` documents."""

    key = "xmlrpc"
    label = "XML-RPC"
    description = "Import an XML-RPC method call or response message."
    icon = "file-code"
    paradigm = ApiParadigm.RPC
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("xmlrpc", "xml-rpc")
    file_extensions = (".xmlrpc", ".xml")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_xmlrpc(text):
            lower = text.lower()
            reason = (
                "`<methodCall>` root element"
                if "<methodcall" in lower
                else "`<methodResponse>` root element"
            )
            return DetectionResult(confidence=0.98, format="xmlrpc", reason=reason)

        filename = (payload.filename or "").lower()
        if filename.endswith(".xmlrpc") or filename.endswith(".xml"):
            if text is not None and is_xmlrpc(text):
                return DetectionResult(
                    confidence=0.9,
                    format="xmlrpc",
                    reason="XML-RPC XML document",
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> XmlRpcDocument:
        try:
            return parse_xmlrpc(raw, source_label=source_label)
        except (XmlRpcParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD /
            # entity / external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> XmlRpcDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("XML-RPC fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, XmlRpcDocument):
            raise ImportSourceError(
                "XML-RPC source must be an XmlRpcDocument (see app.xmlrpc_parser.parse_xmlrpc)"
            )
        return self._normalize_via_registry("xmlrpc", native_ast, include_raw=include_raw)
