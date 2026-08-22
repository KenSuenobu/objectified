"""CDDL import source — FMT-4.4 (#5437).

The :class:`~app.import_source.ImportSource` adapter that makes CDDL (RFC 8610) grammars
importable. CDDL is the schema language of CBOR: COSE, WebAuthn/FIDO, the EU Digital
Identity Wallet and most IETF IoT work publish their structures as `.cddl`, and it is the
binary-schema gap beside ASN.1 — a regulator-adjacent format Apiome could not read.

Parsing lives in :mod:`app.cddl_parser` (a hand-written tokenizer and recursive-descent
parser — there is no CDDL parser in the dependency set, and the language's two lexical
ambiguities need decisions a generated parser cannot make), the algebra, prelude and
declared limits in :mod:`app.cddl_grammar`, and normalization in
:mod:`app.cddl_normalizer`. Unlike its FMT-EPIC-4 siblings this format is **read and
written**: :mod:`app.cddl_emitter` writes a grammar back.
"""

from __future__ import annotations

from typing import Any, Optional

from . import cddl_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .cddl_grammar import CddlDocument, CddlParseError
from .cddl_parser import CDDL_SUFFIXES, is_cddl, parse_cddl, parse_cddl_fileset
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

__all__ = ["CDDL_CAPABILITIES", "CddlImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is FMT-4.4's "control operators map to canonical constraints
#: where an analogue exists and are declared losses where none does" in machine-readable
#: form: ``cddl.control_cbor`` is declared here, and therefore published by
#: ``GET /v1/import/format-capabilities``, rather than being a fact a reader would have to
#: infer from a constraint that never appeared. Every key is also a
#: :data:`app.cddl_grammar.LIMIT_DETAILS` entry, so the registry's list and the per-document
#: coverage ledger name the same constructs in the same words.
CDDL_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "cddl.type_rule",
        "cddl.group_rule",
        "cddl.map",
        "cddl.array",
        "cddl.table",
        "cddl.member_key_bareword",
        "cddl.member_key_literal",
        "cddl.member_key_type",
        "cddl.occurrence_indicator",
        "cddl.type_choice",
        "cddl.group_splice",
        "cddl.enumeration_group",
        "cddl.range",
        "cddl.prelude_type",
        "cddl.literal_value",
        "cddl.generic_instantiation",
        "cddl.socket_plug",
        "cddl.control_size",
        "cddl.control_regexp",
        "cddl.control_default",
        "cddl.control_comparison",
        "cddl.comment",
        "cddl.fileset",
    ],
    unsupported=[
        "cddl.control_bits",
        "cddl.control_cbor",
        "cddl.control_intersection",
        "cddl.control_unmapped",
        "cddl.control_within",
        "cddl.generic_rule",
        "cddl.group_choice",
        "cddl.group_socket",
        "cddl.major_type",
        "cddl.open_map_entry",
        "cddl.tag",
        "cddl.type_socket",
        "cddl.unwrap",
    ],
)


class CddlImportSource(ImportSource, register=True):
    """Adapter for CDDL (RFC 8610) grammars."""

    key = "cddl"
    label = "CDDL"
    description = (
        "Import a CDDL grammar (.cddl, RFC 8610) — the schema language of CBOR, COSE and "
        "WebAuthn — as a schemas-only catalog source, alone or as a set of files."
    )
    icon = "binary"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("cddl",)
    file_extensions = CDDL_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim a CDDL grammar.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``cddl``, or :data:`NO_MATCH`.
        """
        text = payload.text
        if text is None or not is_cddl(text):
            return NO_MATCH
        return DetectionResult(
            confidence=0.9,
            format="cddl",
            reason="`name = { … }` rule assignments with CDDL prelude types or operators",
        )

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CddlDocument:
        """Parse one CDDL grammar.

        Args:
            raw: The grammar text.
            source_label: The document's name, for error messages.

        Returns:
            The parsed :class:`~app.cddl_grammar.CddlDocument`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_cddl(raw, source_label=source_label)
        except CddlParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CddlDocument:
        """Parse a CDDL grammar split across several files.

        CDDL has no ``include`` directive, so a grammar that spans files is composed by
        being *loaded together* — the set is the unit of import, and a reference that
        resolves in no member is an error rather than a deferred lookup.

        Args:
            fileset: The intake fileset, rooted at the file holding the entry point.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed document.

        Raises:
            ImportSourceError: If the root is missing, or a reference resolves to nothing.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "CDDL fileset is missing its root document", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_cddl_fileset(
                fileset.members, root=root, source_label=source_label
            )
        except CddlParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed CDDL grammar onto the canonical data-schema model.

        Args:
            native_ast: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a parsed CDDL grammar.
        """
        if not isinstance(native_ast, CddlDocument):
            raise ImportSourceError(
                "CDDL source must be a CddlDocument (see app.cddl_parser.parse_cddl)"
            )
        return self._normalize_via_registry("cddl", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return CDDL_CAPABILITIES
