"""OData CSDL / EDMX import source — MFI-22.1, v2/v3 added by FMT-3.4 (#5429).

The :class:`~app.import_source.ImportSource` adapter that makes OData ``.edmx`` / CSDL
documents importable into the catalog (store-raw, MFI-23.7).

Three CSDL generations are read — v2, v3 and v4 — and :meth:`ODataImportSource.detect`
reports **which**, so the version a document is written in is a fact the import records
rather than something a reader infers. The same version keys are declared in
:attr:`ODataImportSource.formats`, which is what the format matrix serves as this format's
version coverage (``GET /v1/formats/matrix`` → ``version_coverage``) and what the generated
supported-formats page renders.
"""

from __future__ import annotations

from typing import Any, Optional

from . import odata_normalizer  # noqa: F401 — self-registers the normalizer
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
from .odata_csdl_versions import detect_odata_version, format_key_for_version
from .odata_parser import ODataDocument, ODataParseError, is_odata, parse_odata
from .secure_xml import SecureXmlError

__all__ = ["ODataImportSource"]


class ODataImportSource(ImportSource, register=True):
    """Adapter for OData v2 / v3 / v4 CSDL / EDMX documents (``.edmx`` file / url / paste)."""

    key = "odata"
    label = "OData"
    description = "Import an OData v2, v3 or v4 CSDL / EDMX service metadata document."
    icon = "database"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    #: Declared version coverage. ``odata`` stays first because it is the registry key every
    #: existing caller sends and the key a v4 document still detects as; the version-scoped
    #: keys name the CSDL generations FMT-3.4 added, and ``edmx`` is the long-standing
    #: filename-shaped alias.
    formats = ("odata", "odata-v2", "odata-v3", "edmx")
    file_extensions = (".edmx", ".xml")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim OData EDMX text and report which CSDL generation it is written in.

        The version is sniffed from the document's namespaces without parsing it
        (:func:`~app.odata_csdl_versions.detect_odata_version`), because detection runs
        on hostile input and must never raise. A v4 document keeps reporting the plain
        ``odata`` key it always has; a v2 or v3 document reports ``odata-v2`` / ``odata-v3``,
        both of which resolve back to this adapter.

        Args:
            payload: The detection input.

        Returns:
            The verdict; :data:`~app.import_source.NO_MATCH` when the text is not EDMX.
        """
        text = payload.text
        if text is not None and is_odata(text):
            version = detect_odata_version(text)
            root = "`<edmx:Edmx>` root" if "<edmx:Edmx" in text else "OData `<Edmx>` root"
            reason = root if version is None else f"{root}, CSDL {version}"
            return DetectionResult(
                confidence=0.98, format=format_key_for_version(version), reason=reason
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".edmx"):
            if text is not None and is_odata(text):
                return DetectionResult(confidence=0.85, format="odata", reason="`.edmx` file extension")
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ODataDocument:
        try:
            return parse_odata(raw, source_label=source_label)
        except (ODataParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD /
            # entity / external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ODataDocument:
        """Parse a multi-document set as one API.

        The set's other members are handed to the parser so ``<edmx:Reference Uri=…>``
        declarations resolve against them and the schemas they name are merged into the
        root document — how a v3 service that keeps its shared complex types in a sibling
        file imports as a single API instead of a root with dangling type references.

        Args:
            fileset: The set, with its root member named.
            source_label: Fallback label for error messages.

        Returns:
            The parsed document, references merged.

        Raises:
            ImportSourceError: If the set has no root document, or the root fails to parse.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("OData fileset is missing its root document")
        try:
            return parse_odata(
                fileset.members[root],
                source_label=root or source_label,
                members=fileset.members,
            )
        except (ODataParseError, SecureXmlError) as exc:
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, ODataDocument):
            raise ImportSourceError(
                "OData source must be an ODataDocument (see app.odata_parser.parse_odata)"
            )
        return self._normalize_via_registry("odata", native_ast, include_raw=include_raw)
