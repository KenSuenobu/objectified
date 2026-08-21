"""Avro import source — MFI-19.6, Avro IDL added by FMT-3.5 (#5430).

The :class:`~app.import_source.ImportSource` adapter that makes Apache Avro importable
into the catalog (store-raw, MFI-23.7).

Avro ships two surfaces and this adapter reads both. ``.avsc`` is the generated JSON
schema; ``.avdl`` is the Avro IDL source teams actually author, and it carries the doc
comments, protocol grouping, and RPC message declarations the JSON artifact loses.
:meth:`AvroImportSource.detect` reports **which** surface a document is written in, so
that is a fact the import records rather than something a reader infers, and the same
keys are declared in :attr:`AvroImportSource.formats` — what the format matrix serves as
this format's coverage (``GET /v1/formats/matrix`` → ``version_coverage``) and what the
generated supported-formats page renders.

Routing happens twice, from different evidence: by filename suffix when the caller gives
one, and by content sniff otherwise, because a paste has no filename and a filename is
not evidence of content.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from . import avro_normalizer  # noqa: F401 — self-registers the normalizer
from .avro_idl_parser import AvroIdlParseError, is_avro_idl, parse_avro_idl
from .avro_parser import AvroDocument, AvroParseError, is_avro, is_avro_document, parse_avro
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

__all__ = ["AvroImportSource"]

#: Filename suffixes that mean "this is Avro IDL, not the generated JSON schema".
_IDL_SUFFIXES = (".avdl",)

#: The detection format key an IDL document reports. A ``.avsc`` document keeps the
#: plain ``avro`` key every existing caller sends.
_IDL_FORMAT_KEY = "avro-idl"


def _is_idl_filename(filename: Optional[str]) -> bool:
    """Return ``True`` when a filename names an Avro IDL document."""
    return (filename or "").strip().lower().endswith(_IDL_SUFFIXES)


class AvroImportSource(ImportSource, register=True):
    """Adapter for Apache Avro schemas and IDL (``.avsc`` / ``.avdl`` file / url / paste)."""

    key = "avro"
    label = "Avro"
    description = (
        "Import an Apache Avro schema (.avsc) or Avro IDL protocol (.avdl) as a catalog source."
    )
    icon = "binary"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    #: Declared surface coverage. ``avro``/``avsc`` stay first because they are the keys
    #: every existing caller sends; ``avro-idl`` names the source surface FMT-3.5 added.
    formats = ("avro", "avsc", "avro-idl")
    file_extensions = (".avsc", ".avro", ".avdl")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim Avro content and report which of Avro's two surfaces it is.

        The JSON surface is tested first because it is decidable — either the text
        parses as an Avro schema object or it does not. Only then is the IDL text sniff
        consulted, so a ``.avsc`` document can never be mistaken for IDL.

        Args:
            payload: The detection input.

        Returns:
            The verdict; :data:`~app.import_source.NO_MATCH` when the payload is not Avro.
        """
        text = payload.text
        if text is not None and is_avro(text):
            return DetectionResult(
                confidence=0.95,
                format="avro",
                reason="Avro `type: record` with `fields`",
            )

        document = payload.document
        if document is not None and is_avro_document(document):
            name = document.get("name")
            if isinstance(name, str) and name:
                reason = f"Avro record `{name}`"
            else:
                reason = "Avro `type: record` with `fields`"
            return DetectionResult(confidence=0.95, format="avro", reason=reason)

        if text is not None and is_avro_idl(text):
            return DetectionResult(
                confidence=0.95,
                format=_IDL_FORMAT_KEY,
                reason="Avro IDL `protocol`/`namespace` with type declarations",
            )

        filename = (payload.filename or "").lower()
        if _is_idl_filename(filename):
            return DetectionResult(
                confidence=0.8, format=_IDL_FORMAT_KEY, reason="`.avdl` file extension"
            )
        if filename.endswith(".avsc"):
            return DetectionResult(confidence=0.8, format="avro", reason="`.avsc` file extension")
        return NO_MATCH

    def parse(
        self,
        raw: str,
        *,
        source_label: Optional[str] = None,
        members: Optional[Mapping[str, str]] = None,
    ) -> AvroDocument:
        """Parse one Avro document into the native AST, routing by surface.

        Args:
            raw: The document text.
            source_label: Label used in error messages, and the filename the suffix
                route reads.
            members: Sibling documents of a multi-file set, so an IDL ``import`` resolves.

        Returns:
            The parsed document — the same :class:`~app.avro_parser.AvroDocument` shape
            from either surface.

        Raises:
            ImportSourceError: When the text cannot be parsed, carrying the parser's own
                taxonomy code when it has one.
        """
        try:
            if _is_idl_filename(source_label) or is_avro_idl(raw):
                return parse_avro_idl(raw, source_label=source_label, members=members)
            return parse_avro(raw, source_label=source_label)
        except AvroIdlParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc
        except AvroParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> AvroDocument:
        """Parse a multi-file set, resolving IDL imports against its members.

        The set's other members are handed to the parser so ``import idl`` /
        ``import schema`` / ``import protocol`` resolve, and a protocol that keeps its
        shared value types in sibling files imports as one API rather than one with
        dangling references.

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
            raise ImportSourceError("Avro fileset is missing its root document")
        return self.parse(
            fileset.members[root],
            source_label=root or source_label,
            members=fileset.members,
        )

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, AvroDocument):
            raise ImportSourceError(
                "Avro source must be an AvroDocument (see app.avro_parser.parse_avro)"
            )
        return self._normalize_via_registry("avro", native_ast, include_raw=include_raw)
