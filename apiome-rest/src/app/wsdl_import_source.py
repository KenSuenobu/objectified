"""WSDL import source — MFI-15.6, WSDL 2.0 added by FMT-3.3 (#5428).

The :class:`~app.import_source.ImportSource` adapter that makes SOAP WSDL documents
importable into the catalog (store-raw, MFI-23.7). It wraps the MFI-15.1 parser and
MFI-15.2 normalizer.

Both WSDL grammars are read — 1.1 and 2.0 — and :meth:`WsdlImportSource.detect` reports
**which**, so the grammar a document is written in is a fact the import records rather than
something a reader infers. The same version keys are declared in
:attr:`WsdlImportSource.formats`, which is what the format matrix serves as this format's
version coverage (``GET /v1/formats/matrix`` -> ``version_coverage``) and what the
generated supported-formats page renders. WSDL 2.0 **output** is a separate ticket
(#4182); this adapter is import-only for 2.0.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from . import wsdl_normalizer  # noqa: F401 — self-registers the normalizer
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
from .wsdl_parser import WsdlDocument, WsdlParseError, is_wsdl, parse_wsdl
from .wsdl_versions import VERSION_2_0, detect_wsdl_version, format_key_for_version

__all__ = ["WsdlImportSource"]


class WsdlImportSource(ImportSource, register=True):
    """Adapter for SOAP WSDL documents (``.wsdl`` file / url / paste)."""

    key = "wsdl"
    label = "WSDL"
    description = (
        "Import a SOAP web service description (WSDL 1.1 or 2.0) with embedded XSD types."
    )
    icon = "file-code"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    #: Declared version coverage. ``wsdl`` stays first because it is the registry key every
    #: existing caller sends and the key a 1.1 document still detects as; ``wsdl-2.0`` names
    #: the grammar FMT-3.3 added, and ``soap`` is the long-standing protocol-shaped alias.
    formats = ("wsdl", "wsdl-2.0", "soap")
    file_extensions = (".wsdl", ".xml")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim WSDL text and report which grammar it is written in.

        The version is sniffed from the document's namespaces without parsing it
        (:func:`~app.wsdl_versions.detect_wsdl_version`), because detection runs on hostile
        input and must never raise. A 1.1 document keeps reporting the plain ``wsdl`` key
        it always has; a 2.0 document reports ``wsdl-2.0``, which resolves back to this
        adapter. A ``.wsdl`` filename with no readable text stays the family key, since a
        filename is not evidence of a grammar.

        Args:
            payload: The detection input.

        Returns:
            The verdict; :data:`~app.import_source.NO_MATCH` when the text is not WSDL.
        """
        text = payload.text
        if text is not None and is_wsdl(text):
            version = detect_wsdl_version(text)
            if version == VERSION_2_0:
                reason = "`<description>` root in the WSDL 2.0 namespace"
            elif "<wsdl:definitions" in text:
                reason = "`<wsdl:definitions>` root"
            else:
                reason = "WSDL `definitions` root"
            return DetectionResult(
                confidence=0.97, format=format_key_for_version(version), reason=reason
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".wsdl"):
            return DetectionResult(confidence=0.75, format="wsdl", reason="`.wsdl` file extension")
        return NO_MATCH

    def parse(
        self,
        raw: str,
        *,
        source_label: Optional[str] = None,
        members: Optional[Mapping[str, str]] = None,
    ) -> WsdlDocument:
        """Parse one WSDL document into the native AST.

        Args:
            raw: The document text.
            source_label: Label used in error messages (usually the filename).
            members: Sibling documents of a multi-file set, when parsing one.

        Returns:
            The parsed document.

        Raises:
            ImportSourceError: When the text cannot be parsed, carrying the parser's own
                taxonomy code when it has one.
        """
        try:
            return parse_wsdl(raw, source_label=source_label, members=members)
        except (WsdlParseError, SecureXmlError) as exc:
            # WsdlParseError carries the taxonomy code for a semantic defect the parser can
            # name (a 2.0 document with no interface, a dangling interface reference);
            # SecureXmlError carries it for a rejected DTD / entity / external reference or
            # an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> WsdlDocument:
        """Parse a multi-file set, resolving schema imports against its members.

        The set's other members are handed to the parser so that an ``xs:import`` /
        ``xs:include`` naming a sibling ``.xsd`` resolves, and a service that keeps its
        types in a separate schema imports as one API instead of one with no types.

        Args:
            fileset: The set, rooted at its primary document.
            source_label: Fallback label when the set records no root path.

        Returns:
            The parsed document.

        Raises:
            ImportSourceError: When the root is missing or the document cannot be parsed.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("WSDL fileset is missing its root document")
        return self.parse(
            fileset.members[root],
            source_label=root or source_label,
            members=fileset.members,
        )

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, WsdlDocument):
            raise ImportSourceError(
                "WSDL source must be a WsdlDocument (see app.wsdl_parser.parse_wsdl)"
            )
        return self._normalize_via_registry("wsdl", native_ast, include_raw=include_raw)
