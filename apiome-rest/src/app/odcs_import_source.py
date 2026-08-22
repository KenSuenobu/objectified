"""ODCS import source — FMT-5.1 (#5439).

The :class:`~app.import_source.ImportSource` adapter that makes an Open Data Contract
Standard (Bitol / Linux Foundation AI & Data, v3.1.0) document importable.

ODCS is the data-side twin of everything Apiome does for APIs: one YAML file states a
dataset's structure, its semantics, its quality expectations, its ownership, its SLAs
and where it is served from — versioned, diffable, lintable, scoreable. Reading it is
what lets a data platform's contracts sit in the same catalog, and under the same
governance, as its APIs.

Parsing, detection and version gating live in :mod:`app.odcs_parser`; the document
algebra and the declared limits in :mod:`app.odcs_contract`; the canonical projection
and the ``odcs_*`` extras namespace in :mod:`app.odcs_normalizer`. This adapter is
read-only — FMT-5.2 (#5440) adds the emitter that writes the same extras back.
"""

from __future__ import annotations

from typing import Any, Optional

from . import odcs_normalizer  # noqa: F401 — self-registers the normalizer
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
from .odcs_contract import LIMIT_DETAILS, OdcsContract, OdcsParseError
from .odcs_parser import ODCS_SUFFIXES, is_odcs, parse_odcs, parse_odcs_fileset
from .payload_analysis import AnalyzerCapabilities, analyzer_capabilities

__all__ = ["ODCS_CAPABILITIES", "OdcsImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is FMT-5.1's "the capability registry declares what is
#: modelled and what is carried-but-not-modelled" in machine-readable form, and it is
#: exactly :data:`app.odcs_contract.LIMIT_DETAILS` — the same vocabulary the per-document
#: coverage ledger names — rather than a second list free to drift from it.
ODCS_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "odcs.contract_envelope",
        "odcs.contract_identity",
        "odcs.contract_versioning",
        "odcs.description",
        "odcs.schema_object",
        "odcs.property",
        "odcs.nested_object_property",
        "odcs.array_property",
        "odcs.required",
        "odcs.logical_type",
        "odcs.logical_type_options",
        "odcs.enum_option",
        "odcs.format_option",
        "odcs.property_order",
        "odcs.json_serialization",
        "odcs.quality_pack_fileset",
    ],
    unsupported=sorted(LIMIT_DETAILS),
)


class OdcsImportSource(ImportSource, register=True):
    """Adapter for Open Data Contract Standard v3.x data contracts."""

    key = "odcs"
    label = "ODCS Data Contract"
    description = (
        "Import an Open Data Contract Standard (ODCS v3.x) data contract — the Linux "
        "Foundation / Bitol YAML that states a dataset's structure, quality rules, "
        "ownership, SLAs and serving infrastructure — as a schemas-only catalog source."
    )
    icon = "database"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("odcs",)
    file_extensions = ODCS_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim an ODCS data contract.

        Claims **any** declared ``apiVersion``, including the v2.2 line: routing a v2
        contract here is what turns it into a version rejection with migration
        guidance instead of "no importer recognized this document".

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``odcs``, or :data:`NO_MATCH`.
        """
        text = payload.text
        if text is None or not is_odcs(text):
            return NO_MATCH
        return DetectionResult(
            confidence=0.95,
            format="odcs",
            reason="`kind: DataContract` with an `apiVersion` — the ODCS envelope",
        )

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> OdcsContract:
        """Parse one ODCS data contract.

        Args:
            raw: The contract text (YAML or its JSON serialization).
            source_label: The document's name, for error messages.

        Returns:
            The parsed :class:`~app.odcs_contract.OdcsContract`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify
                the failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_odcs(raw, source_label=source_label)
        except OdcsParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> OdcsContract:
        """Parse a contract published across several files.

        ODCS has no include directive, so a contract that spans files is composed by
        being imported *together*: a sibling quality pack is merged into the schema
        object it names, and a relative ``authoritativeDefinitions`` URL that names a
        member is recorded as resolved.

        Args:
            fileset: The intake fileset, rooted at the contract document.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed contract.

        Raises:
            ImportSourceError: If the root is missing, if the set holds a second
                contract, or if a quality pack names an object the contract does not
                declare.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "ODCS file set is missing its root contract", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_odcs_fileset(
                fileset.members, root=root, source_label=source_label
            )
        except OdcsParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed contract onto the canonical data-schema model.

        Args:
            native_ast: The parsed contract.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a parsed ODCS contract.
        """
        if not isinstance(native_ast, OdcsContract):
            raise ImportSourceError(
                "ODCS source must be an OdcsContract (see app.odcs_parser.parse_odcs)"
            )
        return self._normalize_via_registry("odcs", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return ODCS_CAPABILITIES
