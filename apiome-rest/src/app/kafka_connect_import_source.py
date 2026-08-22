"""Kafka Connect import source — FMT-5.3 (#5441).

The :class:`~app.import_source.ImportSource` adapter that makes a Kafka Connect schema
importable into the catalog.

Connect's schema form — ``{type, optional, name, version, fields, parameters}`` — is what
a Connect pipeline actually carries between systems. It is neither Avro nor JSON Schema:
a struct's members are keyed ``field``, optionality is a flag rather than a union with
null, and the semantic layer lives in *logical types* named on a primitive. Apiome had
the two formats on either side of it and could not read the thing in the middle.

Parsing and detection live in :mod:`app.kafka_connect_parser`; the schema algebra, the
logical-type table and the declared limits in :mod:`app.kafka_connect_schema`; the
canonical projection and the ``connect_*`` extras namespace in
:mod:`app.kafka_connect_normalizer`. The emitter that writes the same extras back is
:mod:`app.kafka_connect_emitter`.
"""

from __future__ import annotations

from typing import Any, Optional

from . import kafka_connect_normalizer  # noqa: F401 — self-registers the normalizer
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
from .kafka_connect_parser import (
    CONNECT_SUFFIXES,
    is_connect_connector_config,
    is_kafka_connect_document,
    load_connect_document,
    parse_kafka_connect,
    parse_kafka_connect_fileset,
)
from .kafka_connect_schema import LIMIT_DETAILS, ConnectDocument, ConnectParseError
from .payload_analysis import AnalyzerCapabilities, analyzer_capabilities

__all__ = ["KAFKA_CONNECT_CAPABILITIES", "KafkaConnectImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is exactly :data:`app.kafka_connect_schema.LIMIT_DETAILS` —
#: the same vocabulary the per-document coverage ledger names — rather than a second
#: list free to drift from it.
KAFKA_CONNECT_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "kafka-connect.struct",
        "kafka-connect.field",
        "kafka-connect.primitive_type",
        "kafka-connect.array",
        "kafka-connect.map",
        "kafka-connect.nested_struct",
        "kafka-connect.optional",
        "kafka-connect.default",
        "kafka-connect.doc",
        "kafka-connect.schema_name",
        "kafka-connect.logical_type",
        "kafka-connect.decimal_parameters",
        "kafka-connect.enum_parameters",
        "kafka-connect.schema_payload_envelope",
        "kafka-connect.pipeline_fileset",
    ],
    unsupported=sorted(LIMIT_DETAILS),
)


class KafkaConnectImportSource(ImportSource, register=True):
    """Adapter for Kafka Connect schemas (file / url / paste / pipeline file set)."""

    key = "kafka-connect"
    label = "Kafka Connect Schema"
    description = (
        "Import a Kafka Connect schema — the `{type, optional, name, version, fields, "
        "parameters}` form a Connect pipeline carries between systems, including its "
        "logical types — as a schemas-only catalog source."
    )
    icon = "database"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("kafka-connect",)
    file_extensions = CONNECT_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim a Kafka Connect document.

        Three surfaces are claimed, and the marker for each is narrow on purpose: a bare
        ``type: struct`` would also describe a Kubernetes structural schema, and a
        ``fields[]`` array whose members are keyed ``name`` is Avro. Requiring the
        ``field`` spelling is what keeps the two apart — which is the whole point of an
        adapter that promises an Avro ↔ Connect transcode.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``kafka-connect``, or :data:`NO_MATCH`.
        """
        document: Any = payload.document
        if document is None and payload.text:
            try:
                document = load_connect_document(payload.text)
            except (ConnectParseError, RecursionError):
                # A sniff never raises: a document this reader cannot even load is
                # simply not claimed, and the pipeline asks the other adapters.
                document = None
        if not is_kafka_connect_document(document):
            return NO_MATCH
        if is_connect_connector_config(document):
            return DetectionResult(
                confidence=0.9,
                format="kafka-connect",
                reason="Kafka Connect connector configuration (`config` with a "
                "`connector.class`/converter)",
            )
        if "schema" in document and "payload" in document:
            return DetectionResult(
                confidence=0.95,
                format="kafka-connect",
                reason="Kafka Connect `{schema, payload}` converter envelope",
            )
        return DetectionResult(
            confidence=0.95,
            format="kafka-connect",
            reason="Kafka Connect `type: struct` with `fields[].field`",
        )

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> ConnectDocument:
        """Parse one Kafka Connect document.

        Args:
            raw: The document text — a schema or a ``{schema, payload}`` envelope.
            source_label: The document's name, for error messages.

        Returns:
            The parsed :class:`~app.kafka_connect_schema.ConnectDocument`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_kafka_connect(raw, source_label=source_label)
        except ConnectParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> ConnectDocument:
        """Parse a pipeline published across several files.

        Connect has no include directive, so a pipeline that spans files is composed by
        being imported *together*: the connector configuration contributes the pipeline's
        identity and its operational settings, and every schema member contributes a root
        record.

        Args:
            fileset: The intake fileset, rooted at whichever member the caller named.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed document.

        Raises:
            ImportSourceError: If the root is missing, the set carries no schema, or a
                member fails to parse.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "Kafka Connect file set is missing its root document",
                code="INPUT_SEMANTIC_INVALID",
            )
        try:
            return parse_kafka_connect_fileset(
                fileset.members, root=root, source_label=source_label
            )
        except ConnectParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed document onto the canonical data-schema model.

        Args:
            native_ast: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a parsed Connect document.
        """
        if not isinstance(native_ast, ConnectDocument):
            raise ImportSourceError(
                "Kafka Connect source must be a ConnectDocument "
                "(see app.kafka_connect_parser.parse_kafka_connect)"
            )
        return self._normalize_via_registry("kafka-connect", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return KAFKA_CONNECT_CAPABILITIES
