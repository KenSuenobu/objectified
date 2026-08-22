"""RELAX NG import source — FMT-4.1 (#5434).

The :class:`~app.import_source.ImportSource` adapter that makes RELAX NG grammars
importable, in both of the language's syntaxes: the XML syntax (``.rng``) and the compact
syntax (``.rnc``). Apiome already read XSD and called that "XML schema support"; RELAX NG is
the schema language of DocBook, TEI, OpenDocument and a large body of publishing and
government document standards, so reading only half of XML schema was an overclaim this
adapter removes.

Parsing lives in :mod:`app.relaxng_parser` (XML syntax, fileset composition) and
:mod:`app.relaxng_compact` (compact syntax), both onto the shared algebra in
:mod:`app.relaxng_grammar`; normalization lives in :mod:`app.relaxng_normalizer`. RELAX NG
**output** is a separate ticket (#4134), so this adapter reads only.
"""

from __future__ import annotations

from typing import Any, Optional

from . import relaxng_normalizer  # noqa: F401 — self-registers the normalizer
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
from .payload_analysis import AnalyzerCapabilities, analyzer_capabilities
from .relaxng_grammar import RelaxNgDocument, RelaxNgParseError
from .relaxng_parser import (
    RELAXNG_COMPACT_SUFFIXES,
    RELAXNG_XML_SUFFIXES,
    is_relaxng,
    is_relaxng_compact,
    parse_relaxng,
    parse_relaxng_fileset,
)
from .secure_xml import SecureXmlError

__all__ = ["RELAXNG_CAPABILITIES", "RelaxNgImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is the FMT-4.1 acceptance criterion in machine-readable form:
#: ``interleave``, the name-class wildcards and the datatype-library constructs that cannot
#: be modelled are **declared** here — and therefore published by
#: ``GET /v1/import/format-capabilities`` — rather than quietly dropped during
#: normalization. Every key is also a :data:`app.relaxng_grammar.LIMIT_DETAILS` entry, so
#: the registry's list and the per-document coverage ledger name the same constructs.
RELAXNG_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "relaxng.grammar",
        "relaxng.start",
        "relaxng.define",
        "relaxng.ref",
        "relaxng.combine",
        "relaxng.element",
        "relaxng.attribute",
        "relaxng.group",
        "relaxng.choice",
        "relaxng.optional",
        "relaxng.zeroOrMore",
        "relaxng.oneOrMore",
        "relaxng.empty",
        "relaxng.text",
        "relaxng.value",
        "relaxng.data",
        "relaxng.data_param",
        "relaxng.datatype_library",
        "relaxng.include",
        "relaxng.include_override",
        "relaxng.externalRef",
        "relaxng.div",
        "relaxng.ns",
        "relaxng.annotation",
        "relaxng.compact_syntax",
    ],
    unsupported=[
        "relaxng.interleave",
        "relaxng.name_class_wildcard",
        "relaxng.datatype_except",
        "relaxng.external_datatype_library",
        "relaxng.list",
        "relaxng.mixed",
        "relaxng.remote_href",
    ],
)


class RelaxNgImportSource(ImportSource, register=True):
    """Adapter for RELAX NG grammars in XML (``.rng``) and compact (``.rnc``) syntax."""

    key = "relaxng"
    label = "RELAX NG"
    description = (
        "Import a RELAX NG grammar — XML (.rng) or compact (.rnc) syntax — as a "
        "schemas-only catalog source."
    )
    icon = "file-code"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    # Two keys, one adapter: the syntaxes are two spellings of one language and produce the
    # same canonical model, but a caller (and the version-coverage table) still needs to be
    # able to say which spelling a document was written in.
    formats = ("relaxng", "relaxng-compact")
    file_extensions = RELAXNG_XML_SUFFIXES + RELAXNG_COMPACT_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim RELAX NG text in either syntax.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``relaxng`` for the XML syntax and
            ``relaxng-compact`` for the compact one, or :data:`NO_MATCH`.
        """
        text = payload.text
        filename = (payload.filename or "").lower()

        if text is not None and is_relaxng(text):
            if is_relaxng_compact(text) and not filename.endswith(RELAXNG_XML_SUFFIXES):
                return DetectionResult(
                    confidence=0.95,
                    format="relaxng-compact",
                    reason="RELAX NG compact-syntax grammar (`start = …` / `element … { … }`)",
                )
            return DetectionResult(
                confidence=0.98,
                format="relaxng",
                reason="`grammar`/`element` root in the RELAX NG structure namespace",
            )

        if filename.endswith(RELAXNG_COMPACT_SUFFIXES) and text is not None:
            if is_relaxng_compact(text):
                return DetectionResult(
                    confidence=0.9, format="relaxng-compact", reason="`.rnc` file extension"
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> RelaxNgDocument:
        """Parse one RELAX NG document.

        Args:
            raw: The grammar text, in either syntax.
            source_label: The document's name, for error messages.

        Returns:
            The parsed :class:`~app.relaxng_grammar.RelaxNgDocument`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_relaxng(raw, source_label=source_label)
        except (RelaxNgParseError, SecureXmlError) as exc:
            # SecureXmlError carries the taxonomy code for a rejected DTD / entity /
            # external reference or an exceeded size or depth limit.
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> RelaxNgDocument:
        """Parse a modular grammar, resolving ``include`` and ``externalRef`` across the set.

        Args:
            fileset: The intake fileset, rooted at the grammar the others compose into.
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
                "RELAX NG fileset is missing its root document", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_relaxng_fileset(
                fileset.members, root=root, source_label=source_label
            )
        except (RelaxNgParseError, SecureXmlError) as exc:
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed grammar onto the canonical data-schema model.

        Args:
            native_ast: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a parsed RELAX NG document.
        """
        if not isinstance(native_ast, RelaxNgDocument):
            raise ImportSourceError(
                "RELAX NG source must be a RelaxNgDocument "
                "(see app.relaxng_parser.parse_relaxng)"
            )
        return self._normalize_via_registry("relaxng", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return RELAXNG_CAPABILITIES
