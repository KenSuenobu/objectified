"""Apache Arrow / Flight import source — FMT-4.5 (#5438).

The :class:`~app.import_source.ImportSource` adapter that makes an Apache Arrow schema
importable. Arrow is the interchange layer under most modern analytical systems — Parquet
readers, DuckDB, Spark, Polars and every Flight service speak it — and until now Apiome
could emit toward that family (#4317) without being able to read anything in it.

Four intake shapes, one model:

* a **JSON integration-form** schema, pasted or uploaded (:mod:`app.arrow_parser`);
* a **binary IPC** stream, file or schema message, through the binary intake SPI
  (:meth:`ArrowImportSource.accepts_bytes` / :meth:`~ArrowImportSource.parse_bytes`) that
  IXH-7.5 built for protobuf descriptor sets (:mod:`app.arrow_ipc`);
* a **fileset**, when a captured Flight ``GetFlightInfo`` response defers its schema to a
  sibling document;
* a **live Flight endpoint**, through the ``discovery`` input kind
  (:meth:`~ArrowImportSource.discover`, :mod:`app.arrow_flight`).

All four land on the same :class:`~app.arrow_schema.ArrowDocument` and therefore on the
same canonical model — which is FMT-4.5's first acceptance criterion, held as a property
of the code rather than as an agreement between readers.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence, Tuple

from . import arrow_normalizer  # noqa: F401 — self-registers the normalizer
from .arrow_ipc import ArrowIpcError, read_ipc_schema, sniff_arrow_ipc
from .arrow_parser import (
    ARROW_IPC_SUFFIXES,
    ARROW_SUFFIXES,
    is_arrow,
    is_arrow_document,
    parse_arrow,
    parse_arrow_fileset,
)
from .arrow_schema import ArrowDocument, ArrowParseError
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

__all__ = ["ARROW_CAPABILITIES", "ArrowImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is FMT-4.5's "nested, dictionary-encoded and decimal types are
#: modelled **or declared limits**" criterion in machine-readable form: every key is also a
#: :data:`app.arrow_schema.LIMIT_DETAILS` entry, so the registry's list, the adapter's
#: declaration and the per-document coverage ledger name the same constructs in the same
#: words. Nested types are absent from it because they are modelled exactly.
ARROW_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "arrow.schema",
        "arrow.schema_metadata",
        "arrow.field",
        "arrow.field_metadata",
        "arrow.nullability",
        "arrow.null_type",
        "arrow.boolean",
        "arrow.integer",
        "arrow.floating_point",
        "arrow.utf8",
        "arrow.binary",
        "arrow.fixed_size_binary",
        "arrow.decimal",
        "arrow.date",
        "arrow.time",
        "arrow.timestamp",
        "arrow.duration",
        "arrow.struct",
        "arrow.list",
        "arrow.fixed_size_list",
        "arrow.map",
        "arrow.union",
        "arrow.dictionary",
        "arrow.json_form",
        "arrow.ipc_file",
        "arrow.ipc_stream",
        "arrow.flight_descriptor",
        "arrow.flight_get_schema",
        "arrow.fileset",
    ],
    unsupported=[
        "arrow.decimal_width",
        "arrow.dictionary_encoding",
        "arrow.extension_type",
        "arrow.flight_endpoint",
        "arrow.half_precision",
        "arrow.interval",
        "arrow.physical_layout",
        "arrow.temporal_unit",
        "arrow.union_layout",
    ],
)


class ArrowImportSource(ImportSource, register=True):
    """Adapter for Apache Arrow schemas (JSON form, IPC bytes, or a live Flight endpoint)."""

    key = "arrow"
    label = "Apache Arrow"
    description = (
        "Import an Apache Arrow schema — the JSON integration form, a binary IPC stream "
        "or file, or a live Arrow Flight `GetSchema` endpoint — as a schemas-only catalog "
        "source."
    )
    icon = "binary"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.DISCOVERY,
        InputKind.FILESET,
    )
    supports_live_discovery = True
    formats = ("arrow",)
    file_extensions = ARROW_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim an Arrow schema, from bytes, from text, or from a filename.

        The undecoded bytes are consulted first when the caller supplies them (IXH-7.5):
        an IPC payload's magic *is* the evidence, and it is not decodable as text, so no
        text sniff could reach it. The JSON integration form and a Flight response envelope
        are then recognized by content. A filename is the weakest signal and only claims
        the binary suffixes, because ``.json`` says nothing.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``arrow``, or :data:`NO_MATCH`.
        """
        if payload.data is not None and sniff_arrow_ipc(payload.data):
            return DetectionResult(
                confidence=0.95, format="arrow", reason="Arrow IPC stream or file magic"
            )

        text = payload.text
        if text is not None and is_arrow(text):
            return DetectionResult(
                confidence=0.95,
                format="arrow",
                reason="Arrow `schema.fields[].type.name` in the JSON integration form",
            )

        document = payload.document
        if document is not None and is_arrow_document(document):
            return DetectionResult(
                confidence=0.95, format="arrow", reason="Arrow schema object"
            )

        if (payload.filename or "").strip().lower().endswith(ARROW_IPC_SUFFIXES):
            return DetectionResult(
                confidence=0.6, format="arrow", reason="Arrow IPC file extension"
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ArrowDocument:
        """Parse one Arrow schema written as the JSON integration form.

        Args:
            raw: The document text.
            source_label: The document's name, for error messages.

        Returns:
            The parsed :class:`~app.arrow_schema.ArrowDocument`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_arrow(raw, source_label=source_label)
        except ArrowParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def accepts_bytes(self, raw: bytes, *, filename: Optional[str] = None) -> bool:
        """Whether ``raw`` should be routed to :meth:`parse_bytes` rather than decoded.

        Claims on the IPC magic, and — following the IXH-7.5 suffix rule — on a
        conventional IPC filename *even when the bytes are broken*. That is deliberate: a
        truncated ``.arrow`` upload routed through the text path would be reported as a
        decoding fault, when what actually happened is that an Arrow file was cut short,
        and only the binary reader can say so.

        Args:
            raw: The undecoded upload bytes.
            filename: Optional filename hint.

        Returns:
            ``True`` when the payload is this adapter's binary form.
        """
        if (filename or "").strip().lower().endswith(ARROW_IPC_SUFFIXES):
            return True
        return sniff_arrow_ipc(raw)

    def parse_bytes(self, raw: bytes, *, source_label: Optional[str] = None) -> ArrowDocument:
        """Parse a binary Arrow IPC stream, file, or bare schema message.

        Args:
            raw: The undecoded payload.
            source_label: The payload's name, for error messages.

        Returns:
            The parsed document — the same shape :meth:`parse` returns, which is what
            makes an IPC schema and its JSON twin one model rather than two.

        Raises:
            ImportSourceError: When the payload is not a readable Arrow IPC serialization,
                or ``pyarrow`` is unavailable in this runtime.
        """
        try:
            return read_ipc_schema(raw, source_label=source_label)
        except ArrowIpcError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc
        except ArrowParseError as exc:  # pragma: no cover - ArrowIpcError covers this path
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ArrowDocument:
        """Parse a captured Flight response whose schema lives in a sibling document.

        Args:
            fileset: The intake fileset, rooted at the Flight response.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed document.

        Raises:
            ImportSourceError: If the root is missing, or its schema reference resolves to
                nothing in the set.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "Arrow fileset is missing its root document", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_arrow_fileset(
                fileset.members, root=root, source_label=source_label
            )
        except ArrowParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def discover(
        self,
        target: str,
        *,
        path: Optional[Sequence[str]] = None,
        command: Optional[str] = None,
        auth_type: Optional[str] = None,
        auth_payload: Optional[Mapping[str, Any]] = None,
        headers: Optional[Sequence[Tuple[str, str]]] = None,
        secure: bool = False,
        timeout: Optional[float] = None,
        client_factory: Optional[Any] = None,
    ) -> ArrowDocument:
        """Fetch a dataset's schema from a live Arrow Flight endpoint (the discovery seam).

        The live-endpoint counterpart to :meth:`parse`, and the Arrow analogue of the gRPC
        adapter's Server Reflection crawl: one ``GetSchema`` call against an
        SSRF-vetted host, whose reply is the same IPC schema serialization
        :meth:`parse_bytes` reads. A live Flight service therefore catalogs a version
        through exactly the canonical path an uploaded file does.

        Args:
            target: The Flight endpoint (``host:port`` or a ``grpc://`` location).
            path: The dataset's descriptor path.
            command: An opaque ``CMD`` descriptor, for a command-addressed server. Exactly
                one of ``path``/``command`` is required.
            auth_type: Credential-vault auth type.
            auth_payload: The **decrypted** credential payload for ``auth_type``.
            headers: Extra call headers, merged in after the credential's.
            secure: Open a TLS location when ``True``.
            timeout: Per-call deadline in seconds.
            client_factory: A Flight client factory injected by tests; production omits it.

        Returns:
            The document, carrying the descriptor that asked for it so the model's
            identity names the dataset.

        Raises:
            ImportSourceError: For a misconfigured request, an unsafe target, an
                unreachable endpoint, or a server that serves no schema.
        """
        from .arrow_flight import FlightDiscoveryError, discover_flight_schema

        try:
            return discover_flight_schema(
                target,
                path=path,
                command=command,
                auth_type=auth_type,
                auth_payload=auth_payload,
                headers=headers,
                secure=secure,
                timeout=timeout,
                client_factory=client_factory,
            )
        except FlightDiscoveryError as exc:
            raise ImportSourceError(str(exc)) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed Arrow schema onto the canonical data-schema model.

        Args:
            native_ast: The parsed document.
            include_raw: Whether to retain the JSON integration form in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a parsed Arrow document.
        """
        if not isinstance(native_ast, ArrowDocument):
            raise ImportSourceError(
                "Arrow source must be an ArrowDocument (see app.arrow_parser.parse_arrow)"
            )
        return self._normalize_via_registry("arrow", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return ARROW_CAPABILITIES
