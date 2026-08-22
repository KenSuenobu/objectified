"""DTD import source — FMT-4.2 (#5435).

The :class:`~app.import_source.ImportSource` adapter that makes XML Document Type
Definitions importable. DTDs are the only schema most legacy XML has: older EDI-XML
profiles, publishing pipelines (DocBook, JATS, TEI), and a long tail of configuration
formats describe themselves this way and always will, because the documents are shipped and
the schemas are frozen. Apiome already read XSD and RELAX NG; DTD is the third XML schema
language, and the one a general XML tool is expected to read.

Parsing lives in :mod:`app.dtd_parser` (a hand-written scanner — a DTD is not XML, and
:mod:`app.secure_xml` refuses a ``DOCTYPE`` outright), the algebra, limits and expansion
budget in :mod:`app.dtd_grammar`, and normalization in :mod:`app.dtd_normalizer`. DTD
**output** is not part of this ticket: this adapter reads only.
"""

from __future__ import annotations

from typing import Any, Optional

from . import dtd_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .dtd_grammar import DtdDocument, DtdParseError
from .dtd_parser import (
    DTD_SUFFIXES,
    is_dtd,
    is_internal_subset,
    parse_dtd,
    parse_dtd_fileset,
)
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .payload_analysis import AnalyzerCapabilities, analyzer_capabilities

__all__ = ["DTD_CAPABILITIES", "DtdImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is FMT-4.2's "mixed content is modelled or declared a limit,
#: **explicitly**" in machine-readable form: ``dtd.mixed_content`` is declared here, and
#: therefore published by ``GET /v1/import/format-capabilities``, rather than being a fact a
#: reader would have to infer from a smaller-than-expected type. Every key is also a
#: :data:`app.dtd_grammar.LIMIT_DETAILS` entry, so the registry's list and the per-document
#: coverage ledger name the same constructs in the same words.
DTD_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "dtd.element",
        "dtd.content_sequence",
        "dtd.content_choice",
        "dtd.occurrence_indicator",
        "dtd.empty_content",
        "dtd.pcdata_content",
        "dtd.attlist",
        "dtd.attribute_type",
        "dtd.attribute_enumeration",
        "dtd.attribute_required",
        "dtd.attribute_implied",
        "dtd.attribute_fixed",
        "dtd.attribute_default",
        "dtd.general_entity",
        "dtd.parameter_entity",
        "dtd.external_parameter_entity",
        "dtd.character_reference",
        "dtd.notation",
        "dtd.conditional_section",
        "dtd.internal_subset",
        "dtd.external_subset",
    ],
    unsupported=[
        "dtd.any_content",
        "dtd.id_uniqueness",
        "dtd.mixed_content",
        "dtd.orphan_attlist",
        "dtd.remote_system_id",
        "dtd.repeated_group",
        "dtd.tokenized_attribute",
        "dtd.unparsed_entity",
    ],
)


class DtdImportSource(ImportSource, register=True):
    """Adapter for XML Document Type Definitions."""

    key = "dtd"
    label = "DTD"
    description = (
        "Import an XML DTD — a `.dtd` external subset, a modular set, or the internal "
        "subset carried inside an instance document — as a schemas-only catalog source."
    )
    icon = "file-code"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("dtd",)
    file_extensions = DTD_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim a DTD, in either of the two places one is written.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``dtd``, or :data:`NO_MATCH`.
        """
        text = payload.text
        if text is None or not is_dtd(text):
            return NO_MATCH
        if is_internal_subset(text):
            return DetectionResult(
                confidence=0.9,
                format="dtd",
                reason="`<!DOCTYPE …[ … ]>` internal subset declaring elements",
            )
        return DetectionResult(
            confidence=0.95,
            format="dtd",
            reason="`<!ELEMENT`/`<!ATTLIST`/`<!ENTITY` markup declarations",
        )

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> DtdDocument:
        """Parse one DTD document.

        Args:
            raw: The DTD text, or an instance document carrying an internal subset.
            source_label: The document's name, for error messages.

        Returns:
            The parsed :class:`~app.dtd_grammar.DtdDocument`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_dtd(raw, source_label=source_label)
        except DtdParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> DtdDocument:
        """Parse a modular DTD, resolving its modules across the set.

        Args:
            fileset: The intake fileset, rooted at the DTD the others compose into.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed document.

        Raises:
            ImportSourceError: If the root is missing, a module cannot be read, or a
                reference resolves to nothing.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "DTD fileset is missing its root document", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_dtd_fileset(
                fileset.members, root=root, source_label=source_label
            )
        except DtdParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed DTD onto the canonical data-schema model.

        Args:
            native_ast: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a parsed DTD.
        """
        if not isinstance(native_ast, DtdDocument):
            raise ImportSourceError(
                "DTD source must be a DtdDocument (see app.dtd_parser.parse_dtd)"
            )
        return self._normalize_via_registry("dtd", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return DTD_CAPABILITIES
