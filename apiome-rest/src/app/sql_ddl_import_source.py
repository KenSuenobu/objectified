"""SQL DDL import source — FMT-5.6 (#5444).

The :class:`~app.import_source.ImportSource` adapter that makes a database's own schema
importable — the import twin of the filed DDL emitter (**#4311**).

For most organizations the database *is* the only formal schema that exists. There is no
OpenAPI document for the warehouse, no Avro schema for the operational tables, and no data
contract for either; there is a ``schema.sql``, a migrations directory, or a
``pg_dump --schema-only``. Reverse-engineering that is the single broadest on-ramp into a
catalog, and it was the one on-ramp Apiome did not have.

The adapter reads one script, or a whole migrations directory, across ANSI SQL plus the
PostgreSQL, MySQL, SQL Server and Oracle dialects. Tables become canonical types, columns
become properties with their type and constraint mapping, and foreign keys become recorded
relationships. The dialect is detected from the script's own markers, recorded in
provenance, and overridable per import.

**Live introspection is out of scope, deliberately.** The ticket draws that line and this
adapter keeps it: there is no connection-string input kind, no driver, and no code path
that opens a socket to a database. An import is a file or a file set. That keeps the
security surface of "read my schema" to the surface of "read my file".

Lexis, dialect detection and the shared type table live in :mod:`app.sql_ddl_dialects`; the
document algebra and the declared limits in :mod:`app.sql_ddl_schema`; the reader in
:mod:`app.sql_ddl_parser`; the canonical projection and the ``sql_*`` extras namespace in
:mod:`app.sql_ddl_normalizer`.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from . import sql_ddl_normalizer  # noqa: F401 — self-registers the normalizer
from .archive_intake import ARCHIVE_SUFFIXES
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
from .sql_ddl_dialects import DIALECT_LABELS, normalize_dialect
from .sql_ddl_parser import (
    SQL_DDL_SUFFIXES,
    detection_confidence,
    parse_sql_ddl,
    parse_sql_ddl_fileset,
)
from .sql_ddl_schema import LIMIT_DETAILS, SqlCatalog, SqlDdlParseError

__all__ = ["SQL_DDL_CAPABILITIES", "SQL_DIALECT_OPTION", "SqlDdlImportSource"]

#: The import option that forces a dialect, instead of letting detection choose. Named here
#: rather than in the pipeline so the adapter owns its own vocabulary; the pipeline only
#: knows that an adapter may want to be configured (see
#: :meth:`app.import_source.ImportSource.configure`).
SQL_DIALECT_OPTION = "sql_dialect"

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is the ticket's "vendor-specific constructs that cannot be
#: modelled are declared parsing limits" in machine-readable form, and it is exactly
#: :data:`app.sql_ddl_schema.LIMIT_DETAILS` — the same vocabulary the per-document coverage
#: ledger names — rather than a second list free to drift from it.
SQL_DDL_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "sql.ansi_dialect",
        "sql.postgres_dialect",
        "sql.mysql_dialect",
        "sql.sqlserver_dialect",
        "sql.oracle_dialect",
        "sql.dialect_detection",
        "sql.dialect_override",
        "sql.create_table",
        "sql.create_view",
        "sql.create_materialized_view",
        "sql.create_type_enum",
        "sql.create_type_composite",
        "sql.create_domain",
        "sql.alter_table",
        "sql.drop",
        "sql.column_definition",
        "sql.nullability",
        "sql.literal_default",
        "sql.primary_key",
        "sql.unique_key",
        "sql.foreign_key_relationship",
        "sql.check_enum_predicate",
        "sql.character_length",
        "sql.comment_on",
        "sql.inline_comment",
        "sql.quoted_identifier",
        "sql.batch_separator",
        "sql.migrations_fileset",
        "sql.final_state_folding",
    ],
    unsupported=sorted(LIMIT_DETAILS),
)


class SqlDdlImportSource(ImportSource, register=True):
    """Adapter for SQL DDL scripts and migrations directories."""

    key = "sql-ddl"
    label = "SQL DDL"
    description = (
        "Import a database schema from its own DDL — a `schema.sql`, a `pg_dump "
        "--schema-only`, or a whole migrations directory — across ANSI SQL plus the "
        "PostgreSQL, MySQL, SQL Server and Oracle dialects. Tables become types, columns "
        "become properties with their constraints, and foreign keys become relationships. "
        "File intake only: no database connection is ever opened."
    )
    icon = "database"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("sql-ddl",)
    file_extensions = SQL_DDL_SUFFIXES + ARCHIVE_SUFFIXES

    def __init__(self, *, dialect: Optional[str] = None) -> None:
        """Build the adapter, optionally pinned to one dialect.

        Args:
            dialect: The dialect every parse is forced to read under, or ``None`` to detect
                it per document. Set by :meth:`configure` from the import's options rather
                than constructed directly.
        """
        self._dialect = dialect

    # -- configuration -----------------------------------------------------

    def configure(self, options: Mapping[str, Any]) -> "SqlDdlImportSource":
        """Return an adapter honouring this import's ``sql_dialect`` option.

        The ticket requires that "an override option forces one". Detection reads a
        script's own markers, which is right for the overwhelming majority of documents and
        wrong for exactly the cases a user can see and the reader cannot: a portable ANSI
        script that happens to use a ``NUMBER(10)`` column, or a MySQL script written
        without a single backtick. The override is how a user says so.

        Args:
            options: The import's options mapping.

        Returns:
            ``self`` when no dialect was requested, and a configured copy when one was — so
            the registry's adapter class stays stateless and two concurrent imports cannot
            read each other's setting.

        Raises:
            ImportSourceError: When the requested dialect names none this reader knows.
                Refusing is deliberate: silently falling back to ANSI would read a MySQL
                script as standard SQL and record a dialect the user did not ask for.
        """
        requested = options.get(SQL_DIALECT_OPTION) if isinstance(options, Mapping) else None
        if requested is None or (isinstance(requested, str) and not requested.strip()):
            return self
        try:
            resolved = normalize_dialect(str(requested))
        except ValueError as exc:
            known = ", ".join(sorted(DIALECT_LABELS))
            raise ImportSourceError(
                f"{SQL_DIALECT_OPTION}={requested!r} is not a SQL dialect this importer reads. "
                f"Use one of: {known}.",
                code="INPUT_SEMANTIC_INVALID",
            ) from exc
        return SqlDdlImportSource(dialect=resolved)

    # -- SPI ---------------------------------------------------------------

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim a SQL DDL script.

        The marker is a *statement*, not a file extension: a ``CREATE TABLE``,
        ``CREATE VIEW``, ``CREATE TYPE``, ``CREATE DOMAIN`` or ``ALTER TABLE`` outside a
        comment. Comments are stripped before the marker is looked for, so a document that
        merely *describes* ``CREATE TABLE`` in prose is not claimed on the strength of its
        own documentation. Which dialect wrote it is a second decision, made at parse time
        and recorded in provenance.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``sql-ddl``, or :data:`NO_MATCH`.
        """
        text = payload.text
        if text is None:
            return NO_MATCH
        confidence = detection_confidence(text)
        if confidence <= 0.0:
            return NO_MATCH
        reason = (
            "a SQL DDL script — a `CREATE TABLE`/`VIEW`/`TYPE`/`DOMAIN` statement"
            if confidence >= 0.9
            else "a SQL migration — an `ALTER TABLE` statement with no definition beside it"
        )
        return DetectionResult(confidence=confidence, format="sql-ddl", reason=reason)

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> SqlCatalog:
        """Read one DDL script into its final state.

        Args:
            raw: The script text.
            source_label: The document's name, for error messages.

        Returns:
            The read :class:`~app.sql_ddl_schema.SqlCatalog`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_sql_ddl(raw, source_label=source_label, dialect=self._dialect)
        except SqlDdlParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> SqlCatalog:
        """Read a migrations directory into the state its last migration leaves behind.

        A migrations directory is how a schema is *published* by most teams — the ``.sql``
        files are the source of truth and the live database is their result — so a file set
        is this format's ordinary shape rather than an include mechanism. Members are
        applied in path order, which is the ordering every migration convention already
        encodes in its filenames, and the catalog they leave behind is the import.

        Args:
            fileset: The intake fileset.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed catalog.

        Raises:
            ImportSourceError: If the root is missing, if no member carries DDL, or if a
                foreign key names a table no member creates.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "SQL DDL file set is missing its root document", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_sql_ddl_fileset(
                fileset.members, root=root, source_label=source_label, dialect=self._dialect
            )
        except SqlDdlParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a read catalog onto the canonical data-schema model.

        Args:
            native_ast: The read catalog.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a read DDL catalog.
        """
        if not isinstance(native_ast, SqlCatalog):
            raise ImportSourceError(
                "SQL DDL source must be a SqlCatalog (see app.sql_ddl_parser.parse_sql_ddl)"
            )
        return self._normalize_via_registry("sql-ddl", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return SQL_DDL_CAPABILITIES
