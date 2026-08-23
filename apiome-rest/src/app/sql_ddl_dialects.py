"""SQL dialect vocabulary and the shared DDL type-mapping table — FMT-5.6 (#5444).

Everything about SQL DDL that differs *by vendor* lives here, so the reader in
:mod:`app.sql_ddl_parser` and the projection in :mod:`app.sql_ddl_normalizer` can be one
implementation of one grammar rather than four near-copies of it.

Three things are vendor-specific and nothing else is:

* **Lexis** — how an identifier is quoted (``"ansi"``, ``` `mysql` ```, ``[tsql]``), which
  line-comment markers exist (``--`` everywhere, ``#`` in MySQL), whether the dialect has
  dollar-quoted strings, and whether it separates *batches* with a bare ``GO`` line.
  :data:`LEXIS` states it; the tokenizer reads nothing else about the dialect.
* **Markers** — the constructs that identify which vendor wrote a script.
  :func:`detect_dialect` scores them and returns both the verdict and the evidence, because
  FMT-5.6 requires the dialect to be *recorded*, not merely used.
* **Types** — :data:`SQL_TYPE_SCALARS` maps a type's **base name** onto a canonical scalar.
  This is the table the ticket asks be shared with the filed DDL *emitter* (**#4311**): it
  is deliberately import-free and side-effect free so the writer can import it without
  pulling a reader in with it.

The dialect is a *lexical and vocabulary* selector, not a different parser. A ``CREATE
TABLE`` is a ``CREATE TABLE`` in all five, which is why one reader covers ANSI plus four
vendors instead of five readers covering one each.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

__all__ = [
    "ANSI_ORDER",
    "BINARY_TYPE_BASES",
    "CHARACTER_TYPE_BASES",
    "DIALECT_LABELS",
    "DIALECTS",
    "IDENTITY_TYPE_BASES",
    "VENDOR_TYPE_BASES",
    "LEXIS",
    "SQL_TYPE_SCALARS",
    "DialectDetection",
    "DialectLexis",
    "SqlDialect",
    "detect_dialect",
    "normalize_dialect",
]


class SqlDialect:
    """The SQL dialects this reader distinguishes.

    Plain string constants rather than an ``Enum`` so the value lands in the extras bag —
    and therefore in a golden file, a provenance record and an API payload — as the word
    itself, with no serialization step to get wrong. This mirrors
    :class:`app.dbt_resources.DbtSurface`.
    """

    #: No vendor marker found: the script is read as standard SQL.
    ANSI = "ansi"
    #: PostgreSQL (and the engines that clone its DDL surface).
    POSTGRES = "postgres"
    #: MySQL / MariaDB.
    MYSQL = "mysql"
    #: Microsoft SQL Server (Transact-SQL).
    SQLSERVER = "sqlserver"
    #: Oracle Database.
    ORACLE = "oracle"


#: Every dialect key, in the order a tie between equally-scored candidates is broken.
#: ANSI is last because it is the *fallback*, never a positive verdict.
DIALECTS: Tuple[str, ...] = (
    SqlDialect.POSTGRES,
    SqlDialect.MYSQL,
    SqlDialect.SQLSERVER,
    SqlDialect.ORACLE,
    SqlDialect.ANSI,
)

#: Human labels, for provenance and error messages.
DIALECT_LABELS: Dict[str, str] = {
    SqlDialect.ANSI: "ANSI SQL",
    SqlDialect.POSTGRES: "PostgreSQL",
    SqlDialect.MYSQL: "MySQL",
    SqlDialect.SQLSERVER: "SQL Server",
    SqlDialect.ORACLE: "Oracle",
}

#: The dialect a construct is read under when nothing identifies the vendor.
ANSI_ORDER = SqlDialect.ANSI


@dataclass(frozen=True)
class DialectLexis:
    """How one dialect spells the things a tokenizer must recognize.

    Attributes:
        identifier_quotes: ``(open, close)`` pairs that delimit a quoted identifier. Every
            dialect is given the ANSI ``"`` pair as well as its own, because a script
            written for one vendor routinely quotes ANSI-style, and reading ``"order"`` as
            a *string* would silently turn a column name into a literal. Every dialect also
            accepts MySQL's backtick, because no standard SQL construct uses one: a forced
            dialect (see :func:`normalize_dialect`) can then still read a script written for
            another vendor, instead of shredding its identifiers into punctuation.
            Transact-SQL's ``[…]`` is *not* shared, because ``[`` subscripts an array in
            PostgreSQL.
        line_comments: Markers that start a comment running to end of line.
        dollar_quotes: Whether ``$tag$ … $tag$`` delimits a string (PostgreSQL).
        batch_separator: A bare word that ends a *batch* the way ``;`` ends a statement,
            or ``None``. Only Transact-SQL has one (``GO``), and only when it stands alone
            on its line — which is what keeps a column named ``go`` readable.
        string_prefixes: Letters that may immediately precede a quoted string and are part
            of the literal's spelling, not of the preceding token (``N'x'``, ``B'1'``).
    """

    identifier_quotes: Tuple[Tuple[str, str], ...]
    line_comments: Tuple[str, ...]
    dollar_quotes: bool = False
    batch_separator: Optional[str] = None
    string_prefixes: Tuple[str, ...] = ("n", "e", "b", "x", "u")


#: Per-dialect lexis. The ANSI row is the shared baseline every vendor row extends.
LEXIS: Dict[str, DialectLexis] = {
    SqlDialect.ANSI: DialectLexis(
        identifier_quotes=(('"', '"'), ("`", "`")),
        line_comments=("--",),
    ),
    SqlDialect.POSTGRES: DialectLexis(
        identifier_quotes=(('"', '"'), ("`", "`")),
        line_comments=("--",),
        dollar_quotes=True,
    ),
    SqlDialect.MYSQL: DialectLexis(
        identifier_quotes=(("`", "`"), ('"', '"')),
        line_comments=("--", "#"),
    ),
    SqlDialect.SQLSERVER: DialectLexis(
        identifier_quotes=(("[", "]"), ('"', '"'), ("`", "`")),
        line_comments=("--",),
        batch_separator="GO",
    ),
    SqlDialect.ORACLE: DialectLexis(
        identifier_quotes=(('"', '"'), ("`", "`")),
        line_comments=("--",),
    ),
}


# ---------------------------------------------------------------------------
# Dialect detection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DialectDetection:
    """Which vendor wrote a script, and what said so.

    Attributes:
        dialect: The resolved dialect key.
        source: ``detected`` when a marker decided it, ``override`` when the caller forced
            it, ``default`` when nothing identified a vendor and ANSI was assumed.
        evidence: The marker names that scored, strongest first — the *recorded* half of
            "dialect is detected and recorded". Empty for ``default`` and ``override``.
        scores: Every dialect's score, for a caller that wants to explain a near-miss.
    """

    dialect: str
    source: str
    evidence: Tuple[str, ...] = ()
    scores: Tuple[Tuple[str, int], ...] = ()


#: ``(dialect, marker-name, pattern, weight)``. A marker is worth 2 when only one vendor
#: can produce it and 1 when it is merely characteristic — ``GENERATED BY DEFAULT AS
#: IDENTITY``, for instance, is standard SQL that both PostgreSQL and Oracle implement, so
#: it identifies neither on its own.
#:
#: Patterns run over the *raw script text*. That is deliberate: detection happens before
#: tokenizing, because the tokenizer needs the dialect to know how an identifier is quoted.
#: The cost of that ordering is that a marker inside a comment or a string literal still
#: scores; the benefit is that a MySQL script full of backticks is read with backticks.
_MARKERS: Tuple[Tuple[str, str, str, int], ...] = (
    # PostgreSQL
    (SqlDialect.POSTGRES, "serial-type", r"\b(?:big|small)?serial\b", 2),
    (SqlDialect.POSTGRES, "timestamptz", r"\btimestamptz\b|\btimetz\b", 2),
    (SqlDialect.POSTGRES, "enum-type", r"\bcreate\s+type\b[^;]{0,200}?\bas\s+enum\b", 2),
    (SqlDialect.POSTGRES, "create-domain", r"\bcreate\s+domain\b", 2),
    (SqlDialect.POSTGRES, "table-inheritance", r"\binherits\s*\(", 2),
    (SqlDialect.POSTGRES, "declarative-partition", r"\bpartition\s+of\b", 2),
    (SqlDialect.POSTGRES, "bytea", r"\bbytea\b", 2),
    (SqlDialect.POSTGRES, "jsonb", r"\bjsonb\b", 2),
    (SqlDialect.POSTGRES, "cast-operator", r"::[A-Za-z_]", 1),
    (SqlDialect.POSTGRES, "materialized-view", r"\bcreate\s+materialized\s+view\b", 1),
    (SqlDialect.POSTGRES, "now-default", r"\bdefault\s+now\s*\(\s*\)", 1),
    # MySQL
    (SqlDialect.MYSQL, "backtick-identifier", r"`[^`\n]+`", 2),
    (SqlDialect.MYSQL, "auto-increment", r"\bauto_increment\b", 2),
    (SqlDialect.MYSQL, "engine-clause", r"\bengine\s*=", 2),
    (SqlDialect.MYSQL, "charset-clause", r"\bdefault\s+charset\s*=|\bcharacter\s+set\s+utf8", 2),
    (SqlDialect.MYSQL, "unsigned-type", r"\b(?:tiny|small|medium|big)?int(?:\(\d+\))?\s+unsigned\b", 2),
    (SqlDialect.MYSQL, "set-type", r"\bset\s*\(\s*'", 2),
    (SqlDialect.MYSQL, "inline-enum", r"\benum\s*\(\s*'", 2),
    (SqlDialect.MYSQL, "on-update-timestamp", r"\bon\s+update\s+current_timestamp\b", 2),
    (SqlDialect.MYSQL, "fulltext-key", r"\bfulltext\s+(?:key|index)\b", 2),
    (SqlDialect.MYSQL, "mediumint", r"\bmediumint\b|\btinytext\b|\blongtext\b", 2),
    (SqlDialect.MYSQL, "use-database", r"^\s*use\s+[`\w]", 1),
    # SQL Server
    (SqlDialect.SQLSERVER, "go-batch", r"^\s*go\s*$", 2),
    (SqlDialect.SQLSERVER, "identity-clause", r"\bidentity\s*\(\s*\d+\s*,", 2),
    (SqlDialect.SQLSERVER, "bracket-identifier", r"\[[A-Za-z_][\w ]*\]", 2),
    (SqlDialect.SQLSERVER, "nvarchar-max", r"\bn?varchar\s*\(\s*max\s*\)|\bvarbinary\s*\(\s*max\s*\)", 2),
    (SqlDialect.SQLSERVER, "rowversion", r"\browversion\b|\btimestamp\s+not\s+null\s*,?\s*constraint\s+pk_", 2),
    (SqlDialect.SQLSERVER, "clustered-index", r"\b(?:non)?clustered\b", 2),
    (SqlDialect.SQLSERVER, "persisted-computed", r"\bpersisted\b", 2),
    (SqlDialect.SQLSERVER, "datetime2", r"\bdatetime2\b|\bsysutcdatetime\b|\bgetdate\s*\(\s*\)", 2),
    (SqlDialect.SQLSERVER, "unicode-literal", r"\bn'[^']*'", 1),
    (SqlDialect.SQLSERVER, "nvarchar", r"\bn(?:var)?char\b", 1),
    # Oracle
    (SqlDialect.ORACLE, "varchar2", r"\bn?varchar2\b", 2),
    (SqlDialect.ORACLE, "number-type", r"\bnumber\s*\(\s*\d+", 2),
    (SqlDialect.ORACLE, "sysdate", r"\bsysdate\b|\bsystimestamp\b", 2),
    (SqlDialect.ORACLE, "sequence-cache", r"\bno(?:cache|order|cycle)\b", 2),
    (SqlDialect.ORACLE, "lob-type", r"\b[bcn]clob\b", 2),
    (SqlDialect.ORACLE, "dual", r"\bfrom\s+dual\b", 2),
    (SqlDialect.ORACLE, "date-literal", r"\bdate\s+'\d{4}-\d{2}-\d{2}'", 1),
    (SqlDialect.ORACLE, "identity-standard", r"\bgenerated\s+(?:always|by\s+default)\s+as\s+identity\b", 1),
)

#: The compiled marker table, built once at import.
_COMPILED_MARKERS: Tuple[Tuple[str, str, "re.Pattern[str]", int], ...] = tuple(
    (dialect, name, re.compile(pattern, re.IGNORECASE | re.MULTILINE), weight)
    for dialect, name, pattern, weight in _MARKERS
)

#: How much of a script the detector reads. A dialect announces itself in its first few
#: statements; scanning a 20 MiB dump to reach the same verdict is wasted work, and the
#: reader's own byte ceiling has already bounded the input by the time this runs.
MAX_DETECTION_BYTES = 512_000


def normalize_dialect(value: Optional[str]) -> Optional[str]:
    """Resolve a caller-supplied dialect name onto a :class:`SqlDialect` key.

    Accepts the registry keys themselves plus the spellings a human types — ``postgresql``,
    ``psql``, ``mariadb``, ``tsql``, ``mssql``, ``oracledb``, ``standard``.

    Args:
        value: The requested dialect, or ``None``/blank for "not requested".

    Returns:
        The resolved key, or ``None`` when nothing was requested.

    Raises:
        ValueError: When ``value`` names no known dialect. The caller turns this into the
            adapter's own error; refusing an unknown override is deliberate, because
            silently falling back to ANSI would read a MySQL script as standard SQL and
            report a dialect the user did not ask for.
    """
    if value is None:
        return None
    candidate = str(value).strip().lower().replace("_", "-")
    if not candidate:
        return None
    aliases = {
        "ansi": SqlDialect.ANSI,
        "standard": SqlDialect.ANSI,
        "sql": SqlDialect.ANSI,
        "postgres": SqlDialect.POSTGRES,
        "postgresql": SqlDialect.POSTGRES,
        "psql": SqlDialect.POSTGRES,
        "pgsql": SqlDialect.POSTGRES,
        "mysql": SqlDialect.MYSQL,
        "mariadb": SqlDialect.MYSQL,
        "sqlserver": SqlDialect.SQLSERVER,
        "sql-server": SqlDialect.SQLSERVER,
        "mssql": SqlDialect.SQLSERVER,
        "tsql": SqlDialect.SQLSERVER,
        "transact-sql": SqlDialect.SQLSERVER,
        "oracle": SqlDialect.ORACLE,
        "oracledb": SqlDialect.ORACLE,
        "plsql": SqlDialect.ORACLE,
    }
    resolved = aliases.get(candidate)
    if resolved is None:
        known = ", ".join(sorted(set(aliases)))
        raise ValueError(f"unknown SQL dialect {value!r}; expected one of: {known}")
    return resolved


def detect_dialect(text: str, *, override: Optional[str] = None) -> DialectDetection:
    """Decide which vendor wrote ``text``, or honour an explicit override.

    Scoring is additive over :data:`_MARKERS`: each pattern that matches contributes its
    weight once, however many times it occurs, so a script with one backtick and one
    ``AUTO_INCREMENT`` does not out-score a script with fifty ``timestamptz`` columns by
    sheer repetition. A tie is broken by :data:`DIALECTS` order, and a script that scores
    nothing at all is ANSI — the honest "no vendor said anything", not a guess.

    Args:
        text: The raw script.
        override: A caller-forced dialect (already an accepted spelling; see
            :func:`normalize_dialect`).

    Returns:
        The :class:`DialectDetection`.
    """
    if override:
        return DialectDetection(dialect=override, source="override")
    window = text[:MAX_DETECTION_BYTES]
    scores: Dict[str, int] = {dialect: 0 for dialect in DIALECTS if dialect != SqlDialect.ANSI}
    hits: Dict[str, List[Tuple[int, str]]] = {dialect: [] for dialect in scores}
    for dialect, name, pattern, weight in _COMPILED_MARKERS:
        if pattern.search(window):
            scores[dialect] += weight
            hits[dialect].append((weight, name))
    ranked = sorted(scores.items(), key=lambda row: (-row[1], DIALECTS.index(row[0])))
    best, best_score = ranked[0]
    ordered_scores = tuple(sorted(scores.items(), key=lambda row: row[0]))
    if best_score <= 0:
        return DialectDetection(dialect=SqlDialect.ANSI, source="default", scores=ordered_scores)
    evidence = tuple(name for _, name in sorted(hits[best], key=lambda row: (-row[0], row[1])))
    return DialectDetection(
        dialect=best, source="detected", evidence=evidence, scores=ordered_scores
    )


# ---------------------------------------------------------------------------
# The shared type-mapping table (coordinated with the #4311 emitter)
# ---------------------------------------------------------------------------

#: SQL type **base name** → canonical scalar.
#:
#: Keyed by the base name only — the identifier before any ``(...)`` parameters, any ``[]``
#: array suffix and any ``WITH/WITHOUT TIME ZONE`` modifier — because that is the half that
#: means the same thing in every dialect. The parameters are read separately (see
#: :func:`app.sql_ddl_parser.parse_type`) and only the ones with an exact canonical facet
#: are projected; the declared spelling is always carried verbatim.
#:
#: The canonical spellings are the precise widths the rest of the fleet uses
#: (:data:`app.canonical_json_schema.CANONICAL_SCALAR_SCHEMAS`), so a DDL table, an Avro
#: record and a dbt model describing the same relation produce comparable canonical fields.
#: The table is dialect-agnostic on purpose: ``VARCHAR2`` only exists in Oracle and
#: ``NVARCHAR`` only in SQL Server and MySQL, so a single map has no collisions to resolve.
SQL_TYPE_SCALARS: Dict[str, str] = {
    # --- character ---------------------------------------------------------
    "char": "string",
    "character": "string",
    "nchar": "string",
    "national char": "string",
    "national character": "string",
    "bpchar": "string",
    "varchar": "string",
    "varchar2": "string",
    "nvarchar": "string",
    "nvarchar2": "string",
    "character varying": "string",
    "char varying": "string",
    "national character varying": "string",
    "national char varying": "string",
    "text": "string",
    "tinytext": "string",
    "mediumtext": "string",
    "longtext": "string",
    "ntext": "string",
    "string": "string",
    "clob": "string",
    "nclob": "string",
    "long": "string",
    "citext": "string",
    "xml": "string",
    "xmltype": "string",
    "enum": "string",
    "set": "string",
    "uuid": "uuid",
    "uniqueidentifier": "uuid",
    "rowid": "string",
    "urowid": "string",
    # --- integers ----------------------------------------------------------
    "tinyint": "int8",
    "int1": "int8",
    "smallint": "int16",
    "int2": "int16",
    "mediumint": "int32",
    "int": "int32",
    "integer": "int32",
    "int4": "int32",
    "bigint": "int64",
    "int8": "int64",
    "smallserial": "int16",
    "serial2": "int16",
    "serial": "int32",
    "serial4": "int32",
    "bigserial": "int64",
    "serial8": "int64",
    # --- reals and exact numerics ------------------------------------------
    "real": "float",
    "float4": "float",
    "binary_float": "float",
    "float": "double",
    "float8": "double",
    "double": "double",
    "double precision": "double",
    "binary_double": "double",
    "numeric": "decimal",
    "decimal": "decimal",
    "dec": "decimal",
    "number": "decimal",
    "money": "decimal",
    "smallmoney": "decimal",
    "binary_integer": "int32",
    # --- temporal ----------------------------------------------------------
    "date": "date",
    "time": "time",
    "timetz": "time",
    "datetime": "timestamp",
    "datetime2": "timestamp",
    "smalldatetime": "timestamp",
    "datetimeoffset": "timestamp",
    "timestamp": "timestamp",
    "timestamptz": "timestamp",
    "year": "int16",
    "interval": "duration",
    # --- boolean, binary and the open types --------------------------------
    "boolean": "boolean",
    "bool": "boolean",
    "bit": "boolean",
    "binary": "bytes",
    "varbinary": "bytes",
    "binary varying": "bytes",
    "bytea": "bytes",
    "blob": "bytes",
    "tinyblob": "bytes",
    "mediumblob": "bytes",
    "longblob": "bytes",
    "image": "bytes",
    "raw": "bytes",
    "long raw": "bytes",
    "bfile": "bytes",
    "rowversion": "bytes",
    "json": "json",
    "jsonb": "json",
    "variant": "json",
    "super": "json",
    "hstore": "json",
}

#: Base names whose ``(n)`` parameter is a **character** count, so it projects onto the
#: canonical ``max_length`` facet. Binary widths are excluded deliberately: ``VARBINARY(16)``
#: is sixteen *bytes*, and ``max_length`` on a canonical ``bytes`` field would be read as a
#: character count by every consumer of the JSON-Schema projection.
CHARACTER_TYPE_BASES = frozenset(
    {
        "char",
        "character",
        "nchar",
        "national char",
        "national character",
        "bpchar",
        "varchar",
        "varchar2",
        "nvarchar",
        "nvarchar2",
        "character varying",
        "char varying",
        "national character varying",
        "national char varying",
        "text",
        "ntext",
        "string",
    }
)

#: Base names whose ``(n)`` parameter counts bytes rather than characters.
BINARY_TYPE_BASES = frozenset(
    {"binary", "varbinary", "binary varying", "raw", "long raw", "blob", "bytea"}
)

#: Base names that *are* an auto-assigned key by virtue of the type name alone. Writing
#: ``SERIAL`` is writing ``INTEGER`` plus a sequence plus a default, so the column carries
#: the same identity declaration an explicit ``GENERATED … AS IDENTITY`` would.
IDENTITY_TYPE_BASES = frozenset(
    {"serial", "serial2", "serial4", "serial8", "smallserial", "bigserial"}
)

#: Base names with no portable meaning: they are projected onto the nearest canonical
#: scalar so the column still has a shape, and the semantics the vendor attaches to them —
#: auto-maintained, storage-locating, externally-referencing — are a declared limit.
VENDOR_TYPE_BASES = frozenset(
    {"rowversion", "rowid", "urowid", "bfile", "year", "image", "hstore", "variant",
     "super", "xmltype", "citext", "money", "smallmoney"}
)
