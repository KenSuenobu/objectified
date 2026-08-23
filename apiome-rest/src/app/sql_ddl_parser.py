"""SQL DDL reader — FMT-5.6 (#5444).

Reads ``CREATE``/``ALTER``/``COMMENT`` statements across ANSI SQL plus the PostgreSQL,
MySQL, SQL Server and Oracle dialects into the :class:`~app.sql_ddl_schema.SqlCatalog`
algebra, and hands the result to :mod:`app.sql_ddl_normalizer` for projection.

Why this is a hand-written reader
=================================

The ticket names ``sqlglot`` "or equivalent". A ``sqlglot`` spike against this format's own
corpus failed outright on two of the four dialect fixtures (the MySQL and Oracle
``PARTITION BY RANGE (…)`` lists), silently degraded every ``GO``-separated SQL Server
batch to an opaque ``Command`` node, and rejected ``ALTER COLUMN … SET NOT NULL``. Making
it usable would have meant a ``GO`` splitter, a partition-clause stripper and a paren
scanner in front of it — most of a lexer — with a full-strength SQL *query* parser still
behind it that this reader never needs. Every other IDL in this fleet (DTD, RELAX NG,
CDDL, Avro IDL, WIT) is read by a hand-written scanner for the same reason, and no new
runtime dependency is added to the service to read a schema language.

The shape of the reader
=======================

Four stages, each of which does one thing:

1. :func:`tokenize` — dialect-aware lexing. The *only* things the dialect changes here are
   how an identifier is quoted, which line-comment markers exist, whether ``$$`` quotes a
   string and whether a bare ``GO`` ends a batch (:data:`app.sql_ddl_dialects.LEXIS`).
2. :func:`split_statements` — statements at ``;`` and batches at the separator, both only
   at parenthesis depth zero.
3. :class:`_StatementReader` — one recursive-descent pass per statement, which *applies*
   the statement to the catalog rather than building a tree for somebody else to walk.
4. :func:`_resolve_relationships` — the one whole-document pass, which turns every foreign
   key into a resolved edge and refuses the ones that dangle.

Because stage 3 applies rather than accumulates, "a migrations directory imports as its
final state" needs no special case: the files are ordered, their statements are applied in
sequence, and the catalog left at the end is the answer. A single script with ``ALTER``
statements in it takes exactly the same path.

Nothing is executed. No SQL is planned, no expression is evaluated, and a view's ``SELECT``
is read only far enough to name the columns it projects.

Error codes this reader sets
============================

``INPUT_TRUNCATED`` (a string, a comment or a parenthesis is still open at end of input),
``INPUT_MALFORMED`` (a parenthesis that a later statement proves was never closed, and the
syntax errors this grammar can name), ``INPUT_SEMANTIC_INVALID`` (a script that declares no
shape, or a table with an empty column list), ``INPUT_REFERENCE_UNRESOLVED`` (a foreign key
naming a table the import does not contain), ``INPUT_TOO_LARGE`` / ``INPUT_ENTITY_LIMIT``
(the ceilings in :mod:`app.sql_ddl_schema`), and ``FORMAT_MISMATCH`` for a cleanly decoded
document that carries no DDL statement at all. A document that is *not* cleanly decoded is
refused **without** a code, so the pipeline reports the encoding fault it actually is.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .sql_ddl_dialects import (
    IDENTITY_TYPE_BASES,
    LEXIS,
    VENDOR_TYPE_BASES,
    DialectDetection,
    SqlDialect,
    detect_dialect,
    normalize_dialect,
)
from .sql_ddl_schema import (
    MAX_COLUMNS,
    MAX_PAREN_DEPTH,
    MAX_SQL_BYTES,
    MAX_STATEMENTS,
    MAX_TABLES,
    ConstraintKind,
    SqlCatalog,
    SqlColumn,
    SqlConstraint,
    SqlDdlParseError,
    SqlDomain,
    SqlEnum,
    SqlIndex,
    SqlReference,
    SqlRelation,
    SqlSequence,
    SqlViewColumn,
    qualify,
    snapshot_fileset,
)

__all__ = [
    "SQL_DDL_SUFFIXES",
    "SqlToken",
    "detection_confidence",
    "is_sql_ddl",
    "parse_sql_ddl",
    "parse_sql_ddl_fileset",
    "render",
    "split_statements",
    "tokenize",
]

#: Filename suffixes a DDL script normally carries, most-canonical first. ``.ddl`` is the
#: conventional name for a schema-only script; ``.psql`` and ``.mysql`` are what a
#: dialect-specific dump is often called.
SQL_DDL_SUFFIXES: Tuple[str, ...] = (".sql", ".ddl", ".psql", ".mysql", ".tsql", ".pgsql")


# ===========================================================================
# Detection
# ===========================================================================

#: Comments, stripped before the detection markers are looked for so a script that
#: *mentions* ``CREATE TABLE`` in prose is not claimed on the strength of its own
#: documentation. Both comment forms are removed in one pass.
_COMMENT_STRIPPER = re.compile(r"/\*.*?\*/|--[^\n]*|^[ \t]*#[^\n]*", re.DOTALL | re.MULTILINE)

#: The statements that make a document SQL DDL. A ``CREATE TABLE``/``VIEW``/``TYPE``/
#: ``DOMAIN`` is definitive; an ``ALTER TABLE`` alone is what a migration file looks like
#: and is claimed slightly less confidently, because it declares a change rather than a
#: shape.
_DEFINITION_MARKER = re.compile(
    r"\bcreate\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?"
    r"(?:temp(?:orary)?\s+|unlogged\s+|external\s+|foreign\s+)?"
    r"(?:table|materialized\s+view|view|type|domain)\b",
    re.IGNORECASE,
)
_ALTER_MARKER = re.compile(r"\balter\s+table\b", re.IGNORECASE)


def is_sql_ddl(text: str) -> bool:
    """Whether ``text`` looks like a SQL DDL script.

    Args:
        text: The candidate document.

    Returns:
        ``True`` when a ``CREATE TABLE``/``VIEW``/``TYPE``/``DOMAIN`` or an ``ALTER TABLE``
        statement appears outside a comment.
    """
    return detection_confidence(text) > 0.0


def detection_confidence(text: str) -> float:
    """Return the confidence the adapter's ``detect`` reports for ``text``.

    Args:
        text: The candidate document.

    Returns:
        ``0.94`` for a document that *defines* a relation, ``0.88`` for one that only
        alters one, ``0.0`` for anything else.

        Both live marks clear the corpus contract's 0.85 floor. The definition mark sits
        deliberately above the 0.9 several looser sniffers use: the GraphQL adapter, for
        one, claims any document containing the substring ``"type "`` or ``"enum "``, which
        every ``CREATE TYPE … AS ENUM`` script contains. A statement as specific as
        ``CREATE TABLE`` is far stronger evidence than a bare keyword substring, and
        auto-detection has to be able to tell the two apart. The gap between the two marks
        is what lets a script that defines a table win over a bare migration file.
    """
    if not text:
        return 0.0
    body = _COMMENT_STRIPPER.sub(" ", text)
    if _DEFINITION_MARKER.search(body):
        return 0.94
    if _ALTER_MARKER.search(body):
        return 0.88
    return 0.0


# ===========================================================================
# Tokenizer
# ===========================================================================


@dataclass(frozen=True)
class SqlToken:
    """One lexical unit of a DDL script.

    Attributes:
        kind: ``word`` (an unquoted identifier or keyword), ``ident`` (a quoted
            identifier), ``string`` (a character literal), ``number``, or ``punct``.
        value: The token's meaning — an identifier's name with its quotes removed, a
            literal's decoded text, an operator's characters.
        raw: The token exactly as the document spelled it, so a carried expression renders
            back the way it was written.
        line: 1-based source line, used to decide whether a ``GO`` stands alone and to
            locate a syntax error.
    """

    kind: str
    value: str
    raw: str
    line: int

    @property
    def upper(self) -> str:
        """The value upper-cased — the spelling every keyword comparison uses."""
        return self.value.upper()

    def is_word(self, *words: str) -> bool:
        """Whether this is an *unquoted* word equal to any of ``words`` (case-insensitive).

        Quoted identifiers deliberately never match: a column called ``"CHECK"`` is a
        column, not a constraint.
        """
        return self.kind == "word" and self.upper in words

    def is_punct(self, *values: str) -> bool:
        """Whether this is punctuation equal to any of ``values``."""
        return self.kind == "punct" and self.value in values


_NUMBER_RE = re.compile(r"\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+")
#: An unquoted word. ``@`` and ``#`` lead a Transact-SQL variable/temp name, ``$`` appears
#: inside MySQL and Oracle identifiers, and the astral range keeps a non-ASCII identifier
#: (a schema named in Japanese, say) from being shredded into punctuation.
_WORD_RE = re.compile("[A-Za-z_@#-￿][A-Za-z0-9_$@#-￿]*")
_DOLLAR_TAG_RE = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$")

#: Multi-character operators, longest first so ``::`` is not read as two ``:``.
_OPERATORS: Tuple[str, ...] = ("::", "->>", "<=", ">=", "<>", "!=", "||", "->", ":=")


def tokenize(
    text: str, *, dialect: str = SqlDialect.ANSI, source_label: Optional[str] = None
) -> List[SqlToken]:
    """Lex a DDL script into tokens, discarding comments.

    Args:
        text: The script.
        dialect: The dialect whose lexis applies (see :data:`app.sql_ddl_dialects.LEXIS`).
        source_label: The document's name, for error messages.

    Returns:
        The tokens, in source order.

    Raises:
        SqlDdlParseError: ``INPUT_TRUNCATED`` when a string literal, a quoted identifier or
            a block comment is still open at end of input — the document stops in the
            middle of a token, which is what truncation looks like at this level.
    """
    lexis = LEXIS.get(dialect, LEXIS[SqlDialect.ANSI])
    where = f" ({source_label})" if source_label else ""
    openers = {open_char: close_char for open_char, close_char in lexis.identifier_quotes}
    tokens: List[SqlToken] = []
    index = 0
    line = 1
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\n":
            line += 1
            index += 1
            continue
        if char.isspace():
            index += 1
            continue
        # -- comments -------------------------------------------------------
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise SqlDdlParseError(
                    f"the script ends inside a block comment{where}", code="INPUT_TRUNCATED"
                )
            line += text.count("\n", index, end)
            index = end + 2
            continue
        if any(text.startswith(marker, index) for marker in lexis.line_comments):
            end = text.find("\n", index)
            index = length if end < 0 else end
            continue
        # -- strings --------------------------------------------------------
        if lexis.dollar_quotes and char == "$":
            match = _DOLLAR_TAG_RE.match(text, index)
            if match:
                tag = match.group(0)
                end = text.find(tag, match.end())
                if end < 0:
                    raise SqlDdlParseError(
                        f"the script ends inside a dollar-quoted string{where}",
                        code="INPUT_TRUNCATED",
                    )
                raw = text[index : end + len(tag)]
                tokens.append(SqlToken("string", text[match.end() : end], raw, line))
                line += raw.count("\n")
                index = end + len(tag)
                continue
        if char == "'":
            value, raw, index, line = _scan_string(text, index, line, where)
            tokens.append(SqlToken("string", value, raw, line))
            continue
        # -- quoted identifiers ---------------------------------------------
        if char in openers:
            value, raw, index = _scan_quoted(text, index, char, openers[char], where)
            tokens.append(SqlToken("ident", value, raw, line))
            continue
        # -- words (including a literal's letter prefix) ---------------------
        word_match = _WORD_RE.match(text, index)
        if word_match:
            word = word_match.group(0)
            after = word_match.end()
            if (
                len(word) == 1
                and word.lower() in lexis.string_prefixes
                and after < length
                and text[after] == "'"
            ):
                value, raw, index, line = _scan_string(text, after, line, where)
                tokens.append(SqlToken("string", value, word + raw, line))
                continue
            tokens.append(SqlToken("word", word, word, line))
            index = after
            continue
        number_match = _NUMBER_RE.match(text, index)
        if number_match:
            tokens.append(SqlToken("number", number_match.group(0), number_match.group(0), line))
            index = number_match.end()
            continue
        operator = next((op for op in _OPERATORS if text.startswith(op, index)), None)
        if operator is not None:
            tokens.append(SqlToken("punct", operator, operator, line))
            index += len(operator)
            continue
        tokens.append(SqlToken("punct", char, char, line))
        index += 1
    return tokens


def _scan_string(text: str, index: int, line: int, where: str) -> Tuple[str, str, int, int]:
    """Scan a ``'…'`` literal, honouring the doubled-quote and backslash escapes.

    Args:
        text: The script.
        index: Offset of the opening quote.
        line: Current line number.
        where: The rendered source label, for error messages.

    Returns:
        ``(value, raw, next_index, line)``.

    Raises:
        SqlDdlParseError: ``INPUT_TRUNCATED`` when the literal never closes.
    """
    cursor = index + 1
    pieces: List[str] = []
    length = len(text)
    while cursor < length:
        char = text[cursor]
        if char == "\\" and cursor + 1 < length:
            pieces.append(text[cursor + 1])
            cursor += 2
            continue
        if char == "'":
            if cursor + 1 < length and text[cursor + 1] == "'":
                pieces.append("'")
                cursor += 2
                continue
            raw = text[index : cursor + 1]
            return "".join(pieces), raw, cursor + 1, line + raw.count("\n")
        pieces.append(char)
        cursor += 1
    raise SqlDdlParseError(f"the script ends inside a string literal{where}", code="INPUT_TRUNCATED")


def _scan_quoted(
    text: str, index: int, open_char: str, close_char: str, where: str
) -> Tuple[str, str, int]:
    """Scan a quoted identifier, honouring the doubled-delimiter escape.

    Args:
        text: The script.
        index: Offset of the opening delimiter.
        open_char: The opening delimiter.
        close_char: The closing delimiter.
        where: The rendered source label, for error messages.

    Returns:
        ``(value, raw, next_index)``.

    Raises:
        SqlDdlParseError: ``INPUT_TRUNCATED`` when the identifier never closes.
    """
    cursor = index + 1
    pieces: List[str] = []
    length = len(text)
    while cursor < length:
        char = text[cursor]
        if char == "\n":
            break
        if char == close_char:
            if cursor + 1 < length and text[cursor + 1] == close_char:
                pieces.append(close_char)
                cursor += 2
                continue
            return "".join(pieces), text[index : cursor + 1], cursor + 1
        pieces.append(char)
        cursor += 1
    _ = open_char
    raise SqlDdlParseError(
        f"the script ends inside a quoted identifier{where}", code="INPUT_TRUNCATED"
    )


# ===========================================================================
# Statement splitting
# ===========================================================================


def split_statements(
    tokens: Sequence[SqlToken],
    *,
    dialect: str = SqlDialect.ANSI,
    source_label: Optional[str] = None,
) -> Tuple[List[List[SqlToken]], bool]:
    """Split a token stream into statements.

    A statement ends at a ``;`` at parenthesis depth zero, or — in Transact-SQL — at a bare
    ``GO`` that stands alone on its line, which is a *batch* separator rather than a
    statement terminator. Requiring ``GO`` to be alone on its line is what keeps a table
    called ``go`` readable.

    Args:
        tokens: The lexed script.
        dialect: The dialect whose batch separator applies.
        source_label: The document's name, for error messages.

    Returns:
        ``(statements, unterminated)`` — the statements in order, and whether the input ran
        out with a parenthesis still open. The caller decides what an open parenthesis
        means, because "the file was truncated" and "somebody forgot a bracket" are
        different faults and only the statement reader can tell them apart.

    Raises:
        SqlDdlParseError: ``INPUT_MALFORMED`` when parentheses nest past
            :data:`app.sql_ddl_schema.MAX_PAREN_DEPTH` or close more often than they open,
            and ``INPUT_ENTITY_LIMIT`` past :data:`app.sql_ddl_schema.MAX_STATEMENTS`.
    """
    lexis = LEXIS.get(dialect, LEXIS[SqlDialect.ANSI])
    separator = lexis.batch_separator
    where = f" ({source_label})" if source_label else ""
    statements: List[List[SqlToken]] = []
    current: List[SqlToken] = []
    depth = 0
    for position, token in enumerate(tokens):
        if token.kind == "punct":
            if token.value == "(":
                depth += 1
                if depth > MAX_PAREN_DEPTH:
                    raise SqlDdlParseError(
                        f"parentheses nest more than {MAX_PAREN_DEPTH} deep{where}, which no "
                        "schema declaration does",
                        code="INPUT_MALFORMED",
                    )
            elif token.value == ")":
                depth -= 1
                if depth < 0:
                    raise SqlDdlParseError(
                        f"a closing parenthesis on line {token.line}{where} has no opening one",
                        code="INPUT_MALFORMED",
                    )
            elif token.value == ";" and depth == 0:
                if current:
                    statements.append(current)
                current = []
                continue
        if (
            separator
            and depth == 0
            and token.kind == "word"
            and token.upper == separator
            and _alone_on_line(tokens, position)
        ):
            if current:
                statements.append(current)
            current = []
            continue
        current.append(token)
        if len(statements) > MAX_STATEMENTS:
            raise SqlDdlParseError(
                f"the script declares more than {MAX_STATEMENTS} statements{where}",
                code="INPUT_ENTITY_LIMIT",
            )
    if current:
        statements.append(current)
    return statements, depth > 0


def _alone_on_line(tokens: Sequence[SqlToken], position: int) -> bool:
    """Whether the token at ``position`` is the only one on its source line."""
    line = tokens[position].line
    if position > 0 and tokens[position - 1].line == line:
        return False
    if position + 1 < len(tokens) and tokens[position + 1].line == line:
        return False
    return True


# ===========================================================================
# Token rendering
# ===========================================================================

#: Words after which a ``(`` opens a *group* rather than an argument list, so it is spaced.
_EXPRESSION_KEYWORDS = frozenset(
    {
        "AND", "AS", "BETWEEN", "BY", "CASE", "CHECK", "ELSE", "FROM", "IN", "IS", "KEY",
        "LIKE", "NOT", "ON", "OR", "REFERENCES", "SELECT", "THEN", "UNIQUE", "VALUES",
        "WHEN", "WHERE",
    }
)
_NO_SPACE_BEFORE = frozenset({",", ")", ";", ".", "::"})
_NO_SPACE_AFTER = frozenset({"(", ".", "::"})


def render(tokens: Sequence[SqlToken]) -> str:
    """Render a token run back to readable, deterministic SQL text.

    Used for every construct this reader *carries* rather than models — a ``CHECK``
    predicate, a ``DEFAULT`` expression, a partition clause, a view's ``SELECT``. The
    output is not required to be byte-identical to the source (whitespace and line breaks
    are normalized); it is required to be *stable*, because it lands in a golden file.

    Args:
        tokens: The run to render.

    Returns:
        The rendered text.
    """
    pieces: List[str] = []
    for index, token in enumerate(tokens):
        if pieces:
            previous = tokens[index - 1]
            if token.kind == "punct" and token.value == "(":
                # `(` hugs the name it belongs to and is spaced after a keyword/operator.
                joined = previous.kind == "ident" or (
                    previous.kind == "word" and previous.upper not in _EXPRESSION_KEYWORDS
                )
            else:
                joined = (token.kind == "punct" and token.value in _NO_SPACE_BEFORE) or (
                    previous.kind == "punct" and previous.value in _NO_SPACE_AFTER
                )
            if not joined:
                pieces.append(" ")
        pieces.append(token.raw)
    return "".join(pieces)


# ===========================================================================
# Cursor over one statement
# ===========================================================================

#: Statement-leading keywords. Meeting one where a column definition belongs is what proves
#: an unclosed parenthesis was a *missing bracket* rather than a truncated file.
_STATEMENT_KEYWORDS = frozenset(
    {"CREATE", "ALTER", "DROP", "COMMENT", "INSERT", "UPDATE", "DELETE", "GRANT", "REVOKE", "TRUNCATE", "USE", "SET"}
)

#: Words that end a column's type and begin its constraint list.
_COLUMN_CONSTRAINT_KEYWORDS = frozenset(
    {
        "AFTER", "AS", "AUTO_INCREMENT", "AUTOINCREMENT", "CHECK", "COLLATE", "COMMENT",
        "CONSTRAINT", "DEFAULT", "ENCRYPTED", "FILESTREAM", "GENERATED", "IDENTITY",
        "INVISIBLE", "MASKED", "NOT", "NULL", "ON", "PRIMARY", "REFERENCES", "ROWGUIDCOL",
        "SPARSE", "STORAGE", "UNIQUE", "VIRTUAL", "VISIBLE",
    }
)

#: Words that introduce a *table*-level item rather than a column definition.
_TABLE_CONSTRAINT_KEYWORDS = frozenset(
    {"CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "KEY", "INDEX", "FULLTEXT", "SPATIAL", "PERIOD", "EXCLUDE"}
)

#: Type base names spelled with more than one word. Longest first is not needed — the
#: scanner extends greedily while the joined words remain a prefix of some member.
_MULTIWORD_TYPE_BASES = frozenset(
    {
        "double precision", "character varying", "char varying", "national character",
        "national char", "national character varying", "national char varying",
        "binary varying", "bit varying", "character large object", "long raw",
        "binary large object", "national character large object",
    }
)

#: Words that continue a type declaration *after* its parameters.
_TYPE_SUFFIX_WORDS = frozenset({"UNSIGNED", "SIGNED", "ZEROFILL", "PRECISION", "ARRAY"})

#: Literal words that are values rather than identifiers when they follow ``DEFAULT``.
_LITERAL_WORDS: Dict[str, Any] = {"NULL": None, "TRUE": True, "FALSE": False}

#: Zero-argument functions a ``DEFAULT`` may name without parentheses.
_BARE_FUNCTIONS = frozenset(
    {
        "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_USER", "SESSION_USER",
        "SYSTEM_USER", "SYSDATE", "SYSTIMESTAMP", "LOCALTIME", "LOCALTIMESTAMP", "USER",
    }
)

#: Referential actions a foreign key may declare.
_FK_ACTIONS = frozenset({"CASCADE", "RESTRICT", "SET", "NO"})


class _Cursor:
    """A forward cursor over one statement's tokens.

    Only the handful of moves a DDL grammar needs: look at the current token, accept a
    keyword, require one, and skip a balanced parenthesis group. Keeping them here means
    every statement reader below is a sequence of intent-revealing calls rather than index
    arithmetic.
    """

    def __init__(self, tokens: Sequence[SqlToken], *, where: str) -> None:
        self._tokens = list(tokens)
        self._index = 0
        self._where = where

    # -- inspection --------------------------------------------------------

    @property
    def at_end(self) -> bool:
        """Whether the cursor has consumed every token."""
        return self._index >= len(self._tokens)

    @property
    def index(self) -> int:
        """The cursor's current offset, for a caller that wants to slice."""
        return self._index

    @property
    def tokens(self) -> List[SqlToken]:
        """The statement's tokens."""
        return self._tokens

    def peek(self, offset: int = 0) -> Optional[SqlToken]:
        """Return the token ``offset`` positions ahead, or ``None`` past the end."""
        position = self._index + offset
        if 0 <= position < len(self._tokens):
            return self._tokens[position]
        return None

    def at_word(self, *words: str) -> bool:
        """Whether the current token is an unquoted word equal to any of ``words``."""
        token = self.peek()
        return token is not None and token.is_word(*words)

    def at_punct(self, *values: str) -> bool:
        """Whether the current token is punctuation equal to any of ``values``."""
        token = self.peek()
        return token is not None and token.is_punct(*values)

    def at_name(self) -> bool:
        """Whether the current token can start an object name (a word or a quoted one)."""
        token = self.peek()
        return token is not None and token.kind in {"word", "ident"}

    def at_sequence(self, *words: str) -> bool:
        """Whether the next tokens are exactly ``words``, in order."""
        return all(
            (token := self.peek(offset)) is not None and token.is_word(word)
            for offset, word in enumerate(words)
        )

    # -- movement ----------------------------------------------------------

    def advance(self) -> SqlToken:
        """Consume and return the current token.

        Raises:
            SqlDdlParseError: ``INPUT_TRUNCATED`` past the end of the statement.
        """
        token = self.peek()
        if token is None:
            raise SqlDdlParseError(
                f"the statement ends before it is complete{self._where}", code="INPUT_TRUNCATED"
            )
        self._index += 1
        return token

    def skip(self, count: int) -> None:
        """Consume ``count`` tokens whose identity the caller has already established."""
        for _ in range(count):
            self.advance()

    def accept_word(self, *words: str) -> Optional[SqlToken]:
        """Consume the current token when it is one of ``words``; otherwise do nothing."""
        if self.at_word(*words):
            return self.advance()
        return None

    def accept_sequence(self, *words: str) -> bool:
        """Consume ``words`` when they all appear next, in order; otherwise do nothing."""
        if self.at_sequence(*words):
            for _ in words:
                self.advance()
            return True
        return False

    def accept_punct(self, *values: str) -> Optional[SqlToken]:
        """Consume the current token when it is one of ``values``; otherwise do nothing."""
        if self.at_punct(*values):
            return self.advance()
        return None

    def expect_punct(self, value: str) -> SqlToken:
        """Consume the current token, requiring it to be ``value``.

        Raises:
            SqlDdlParseError: ``INPUT_MALFORMED`` when it is something else,
                ``INPUT_TRUNCATED`` at the end of the statement.
        """
        token = self.peek()
        if token is None:
            raise SqlDdlParseError(
                f"the statement ends where {value!r} was expected{self._where}",
                code="INPUT_TRUNCATED",
            )
        if not token.is_punct(value):
            raise SqlDdlParseError(
                f"expected {value!r} but found {token.raw!r} on line {token.line}{self._where}",
                code="INPUT_MALFORMED",
            )
        return self.advance()

    def take_group(self) -> List[SqlToken]:
        """Consume a balanced ``( … )`` and return the tokens *inside* it.

        Returns:
            The group's contents, without the enclosing parentheses.

        Raises:
            SqlDdlParseError: ``INPUT_MALFORMED`` when the current token is not ``(``.
                An unbalanced group cannot reach here: :func:`split_statements` has already
                proved every ``(`` inside a statement closes, and the one case where it has
                not is reported by :meth:`take_group_or_fail` with a truncation verdict.
        """
        self.expect_punct("(")
        depth = 1
        collected: List[SqlToken] = []
        while not self.at_end:
            token = self.advance()
            if token.is_punct("("):
                depth += 1
            elif token.is_punct(")"):
                depth -= 1
                if depth == 0:
                    return collected
            collected.append(token)
        raise SqlDdlParseError(
            f"the statement ends inside a parenthesized clause{self._where}",
            code="INPUT_TRUNCATED",
        )

    def take_rest(self) -> List[SqlToken]:
        """Consume and return every remaining token."""
        rest = self._tokens[self._index :]
        self._index = len(self._tokens)
        return rest


def _split_top_level(tokens: Sequence[SqlToken]) -> List[List[SqlToken]]:
    """Split a token run on commas that sit at parenthesis depth zero.

    Args:
        tokens: The run — a table body, a column list, a select list, an ``ALTER`` action
            list.

    Returns:
        The items, with empty runs dropped.
    """
    items: List[List[SqlToken]] = []
    current: List[SqlToken] = []
    depth = 0
    for token in tokens:
        if token.is_punct("("):
            depth += 1
        elif token.is_punct(")"):
            depth -= 1
        elif token.is_punct(",") and depth == 0:
            if current:
                items.append(current)
            current = []
            continue
        current.append(token)
    if current:
        items.append(current)
    return items


# ===========================================================================
# Names, types and expressions
# ===========================================================================


@dataclass
class _TypeSpec:
    """A parsed type declaration.

    Attributes:
        text: The declaration rendered back, verbatim (``numeric(13,2)``).
        base: The base name, lower-cased and space-collapsed.
        arguments: The parenthesized arguments, each rendered.
        is_array: Whether an array suffix (``[]``/``ARRAY``) was declared.
        enum_values: The members of an inline ``ENUM(…)``/``SET(…)``.
    """

    text: str
    base: str
    arguments: Tuple[str, ...] = ()
    is_array: bool = False
    enum_values: Tuple[str, ...] = ()


def _read_name(cursor: _Cursor) -> str:
    """Read a possibly dotted, possibly quoted object name.

    Args:
        cursor: The statement cursor, positioned at the name's first token.

    Returns:
        The name, with each part in the spelling the document used and quotes removed —
        ``commerce.order``, ``product``, ``claims.Policy``.

    Raises:
        SqlDdlParseError: ``INPUT_MALFORMED`` when the current token cannot start a name.
    """
    token = cursor.peek()
    if token is None:
        raise SqlDdlParseError("expected a name but the statement ended", code="INPUT_TRUNCATED")
    if token.kind not in {"word", "ident"}:
        raise SqlDdlParseError(
            f"expected a name but found {token.raw!r} on line {token.line}", code="INPUT_MALFORMED"
        )
    parts = [cursor.advance().value]
    while cursor.at_punct("."):
        cursor.advance()
        part = cursor.peek()
        if part is None or part.kind not in {"word", "ident"}:
            break
        parts.append(cursor.advance().value)
    return ".".join(parts)


def _read_type(cursor: _Cursor) -> Optional[_TypeSpec]:
    """Read a column's declared type, if it has one.

    Handles the multi-word bases (``DOUBLE PRECISION``, ``CHARACTER VARYING``, ``NATIONAL
    CHARACTER VARYING``), parameters (``numeric(13,2)``, ``VARCHAR(MAX)``, ``ENUM('a')``),
    the modifiers that follow them (``UNSIGNED``, ``WITH TIME ZONE``) and PostgreSQL's
    array suffix. A qualified user-defined type (``commerce.order_status``) is read as a
    name, which is exactly what it is.

    Args:
        cursor: The statement cursor, positioned after the column name.

    Returns:
        The parsed type, or ``None`` when the declaration states none — a Transact-SQL
        computed column (``IsActive AS (…)``) is the case that matters.
    """
    token = cursor.peek()
    if token is None or token.kind not in {"word", "ident"}:
        return None
    if token.kind == "word" and token.upper in {"AS", "GENERATED", "CONSTRAINT"}:
        return None
    start = cursor.index
    words: List[str] = [cursor.advance().value]
    if cursor.at_punct("."):
        cursor.advance()
        part = cursor.peek()
        if part is not None and part.kind in {"word", "ident"}:
            words[0] = f"{words[0]}.{cursor.advance().value}"
    else:
        while True:
            following = cursor.peek()
            if following is None or following.kind != "word":
                break
            candidate = " ".join(words + [following.value]).lower()
            if not any(base.startswith(candidate) for base in _MULTIWORD_TYPE_BASES):
                break
            words.append(cursor.advance().value)
    base = " ".join(words).lower()
    arguments: Tuple[str, ...] = ()
    enum_values: Tuple[str, ...] = ()
    if cursor.at_punct("("):
        group = cursor.take_group()
        items = _split_top_level(group)
        arguments = tuple(render(item) for item in items)
        if base in {"enum", "set"}:
            enum_values = tuple(
                item[0].value for item in items if len(item) == 1 and item[0].kind == "string"
            )
    # Trailing modifiers: `UNSIGNED`, `PRECISION`, `WITH/WITHOUT TIME ZONE`, `CHARACTER SET`.
    while True:
        if cursor.at_word(*_TYPE_SUFFIX_WORDS):
            cursor.advance()
            continue
        if cursor.at_sequence("WITH", "TIME", "ZONE") or cursor.at_sequence("WITHOUT", "TIME", "ZONE"):
            cursor.skip(3)
            continue
        if cursor.at_sequence("WITH", "LOCAL", "TIME", "ZONE"):
            cursor.skip(4)
            continue
        if cursor.at_sequence("CHARACTER", "SET") or cursor.at_sequence("CHAR", "SET"):
            cursor.skip(2)
            if cursor.at_name():
                cursor.advance()
            continue
        break
    is_array = False
    while cursor.at_punct("["):
        cursor.advance()
        while not cursor.at_punct("]") and not cursor.at_end:
            cursor.advance()
        cursor.accept_punct("]")
        is_array = True
    text = render(cursor.tokens[start : cursor.index])
    return _TypeSpec(
        text=text, base=base, arguments=arguments, is_array=is_array, enum_values=enum_values
    )


def _read_atom(cursor: _Cursor) -> List[SqlToken]:
    """Read one expression atom — the shape a ``DEFAULT`` value takes.

    An atom is a parenthesized group, a literal, a bare zero-argument function
    (``CURRENT_TIMESTAMP``, ``SYSDATE``), or a name optionally followed by an argument list
    (``now()``, ``nextval('seq')``), each optionally cast with PostgreSQL's ``::``. Reading
    exactly one atom is what lets ``DEFAULT SYSDATE NOT NULL`` and ``DEFAULT
    CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`` both parse without a stop-word list.

    Args:
        cursor: The statement cursor.

    Returns:
        The atom's tokens, empty when the cursor is not at one.
    """
    start = cursor.index
    if cursor.at_punct("-", "+", "~"):
        cursor.advance()
    if cursor.at_punct("("):
        cursor.expect_punct("(")
        depth = 1
        while not cursor.at_end and depth:
            token = cursor.advance()
            if token.is_punct("("):
                depth += 1
            elif token.is_punct(")"):
                depth -= 1
    else:
        token = cursor.peek()
        if token is None:
            return []
        if token.kind in {"string", "number"}:
            cursor.advance()
        elif token.kind in {"word", "ident"}:
            _read_name(cursor)
            if cursor.at_punct("("):
                cursor.take_group()
        else:
            return []
    while cursor.at_punct("::"):
        cursor.advance()
        _read_type(cursor)
    return cursor.tokens[start : cursor.index]


def _literal_value(tokens: Sequence[SqlToken]) -> Tuple[bool, Any]:
    """Decide whether an atom is a literal, and what value it holds.

    Args:
        tokens: The atom's tokens.

    Returns:
        ``(is_literal, value)``. A parenthesized literal counts — Transact-SQL writes
        ``DEFAULT (0)`` for the number zero — and so does a signed number. Anything that
        calls a function or names a column does not, because its value is computed by the
        database and the document does not state it.
    """
    body = list(tokens)
    while len(body) >= 2 and body[0].is_punct("(") and body[-1].is_punct(")"):
        body = body[1:-1]
    if not body:
        return False, None
    sign = 1
    if body[0].is_punct("-", "+"):
        sign = -1 if body[0].value == "-" else 1
        body = body[1:]
    if len(body) != 1:
        return False, None
    token = body[0]
    if token.kind == "number":
        text = token.value.replace("_", "")
        try:
            number: Any = int(text)
        except ValueError:
            try:
                number = float(text)
            except ValueError:
                return False, None
        return True, number * sign if sign == -1 else number
    if token.kind == "string":
        return True, token.value
    if token.kind == "word" and token.upper in _LITERAL_WORDS:
        return True, _LITERAL_WORDS[token.upper]
    return False, None


#: ``col IN ('a', 'b')`` — the one predicate shape with an exact canonical analogue.
def _check_enum_values(tokens: Sequence[SqlToken]) -> Tuple[Optional[str], Tuple[Any, ...]]:
    """Decode ``<column> IN (<literal>, …)`` out of a ``CHECK`` predicate.

    Args:
        tokens: The predicate's tokens, without the enclosing parentheses.

    Returns:
        ``(column_name, values)`` when the predicate has exactly that shape, and
        ``(None, ())`` otherwise. Nothing else is decoded: a general predicate is a program,
        and guessing at one would put facts in the model the document did not state.
    """
    body = list(tokens)
    while len(body) >= 2 and body[0].is_punct("(") and body[-1].is_punct(")"):
        body = body[1:-1]
    if len(body) < 4 or body[0].kind not in {"word", "ident"}:
        return None, ()
    column = body[0].value
    rest = body[1:]
    if rest and rest[0].is_punct("."):
        if len(rest) < 2 or rest[1].kind not in {"word", "ident"}:
            return None, ()
        column = rest[1].value
        rest = rest[2:]
    if not rest or not rest[0].is_word("IN"):
        return None, ()
    rest = rest[1:]
    if not rest or not rest[0].is_punct("(") or not rest[-1].is_punct(")"):
        return None, ()
    values: List[Any] = []
    for item in _split_top_level(rest[1:-1]):
        literal, value = _literal_value(item)
        if not literal:
            return None, ()
        values.append(value)
    if not values:
        return None, ()
    return column, tuple(values)


def _read_column_list(tokens: Sequence[SqlToken]) -> Tuple[str, ...]:
    """Read the column names out of a constrained-column list.

    Each item is reduced to its leading identifier, which drops the ``ASC``/``DESC`` and
    length qualifiers a key may carry. An item that is an *expression* (an expression
    index's ``lower(email)``) is rendered whole instead, so the declaration is still
    reported honestly rather than reduced to the function's name.

    Args:
        tokens: The list's tokens, without the enclosing parentheses.

    Returns:
        The column names or expressions, in declaration order.
    """
    names: List[str] = []
    for item in _split_top_level(tokens):
        if not item:
            continue
        if item[0].kind in {"word", "ident"} and (len(item) == 1 or not item[1].is_punct("(")):
            offset = 1
            name = item[0].value
            while offset + 1 < len(item) and item[offset].is_punct("."):
                name = item[offset + 1].value
                offset += 2
            names.append(name)
        else:
            names.append(render(item))
    return tuple(names)


# ===========================================================================
# Statement readers
# ===========================================================================

#: The statement keywords whose presence *inside* an unclosed parenthesis proves the
#: bracket was never closed, rather than that the file stops early. A column list cannot
#: contain a ``CREATE TABLE``; a truncated one simply stops.
_RESUMPTION_KEYWORDS = frozenset({"CREATE", "ALTER", "DROP", "GRANT", "INSERT", "TRUNCATE"})

#: Referential actions spelled with two words.
_TWO_WORD_ACTIONS = {("NO", "ACTION"): "NO ACTION", ("SET", "NULL"): "SET NULL", ("SET", "DEFAULT"): "SET DEFAULT"}

#: Index qualifiers a ``CREATE INDEX`` or a table-body key may carry.
_INDEX_KINDS = frozenset({"FULLTEXT", "SPATIAL", "CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "HASH", "BITMAP"})

#: Words that state *when* a constraint is enforced rather than what it constrains. They
#: change no shape, so they are consumed and not recorded.
_CONSTRAINT_STATE_WORDS: Tuple[str, ...] = (
    "NOT", "ENFORCED", "ENABLE", "DISABLE", "VALIDATE", "NOVALIDATE", "DEFERRABLE",
    "INITIALLY", "IMMEDIATE", "DEFERRED", "RELY", "NORELY",
)

#: Words that may not be read as a table alias in a view's ``FROM``/``JOIN`` clause.
_NOT_AN_ALIAS = frozenset(
    {
        "ON", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "JOIN", "INNER",
        "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "WITH", "USING", "SELECT", "AND", "OR",
        "WINDOW", "FETCH", "OFFSET", "FOR",
    }
)


def _is_star_projection(item: Sequence[SqlToken]) -> bool:
    """Whether a select-list item is ``*`` or ``alias.*``.

    A ``*`` anywhere else in the item is multiplication — ``l.unit_price * l.quantity`` —
    and reading it as a star would silently drop a column the view really projects.

    Args:
        item: The select-list item's tokens.

    Returns:
        ``True`` for a star projection, whose columns this reader cannot name because it
        does not expand ``*`` against the sources.
    """
    if len(item) == 1:
        return item[0].is_punct("*")
    return len(item) == 3 and item[1].is_punct(".") and item[2].is_punct("*")


class _StatementReader:
    """Applies one statement at a time to a :class:`~app.sql_ddl_schema.SqlCatalog`.

    Every method here *changes the catalog* rather than returning a node. That is the whole
    reason a migrations directory needs no special handling: applying ``V2``'s ``ALTER`` to
    the catalog ``V1`` built leaves the final state behind, and applying a single script's
    ``ALTER`` statements does exactly the same thing.
    """

    def __init__(self, catalog: SqlCatalog, *, source_label: Optional[str] = None) -> None:
        self._catalog = catalog
        self._label = source_label
        self._where = f" ({source_label})" if source_label else ""

    # -- entry point -------------------------------------------------------

    def apply(self, tokens: Sequence[SqlToken]) -> None:
        """Read one statement and apply it.

        Args:
            tokens: The statement's tokens, without its terminator.

        Raises:
            SqlDdlParseError: When the statement is one this reader models and cannot read.
                A statement it does *not* model is recorded as a declared limit instead, so
                a schema dump carrying `INSERT`s or `GRANT`s still imports its structure.
        """
        if not tokens:
            return
        cursor = _Cursor(tokens, where=self._where)
        head = tokens[0]
        if head.is_word("CREATE"):
            cursor.advance()
            self._create(cursor, tokens)
            return
        if head.is_word("ALTER"):
            cursor.advance()
            if cursor.accept_word("TABLE"):
                self._alter_table(cursor, tokens)
                return
            self._unsupported(tokens)
            return
        if head.is_word("COMMENT") and len(tokens) > 1 and tokens[1].is_word("ON"):
            cursor.skip(2)
            self._comment_on(cursor, tokens)
            return
        if head.is_word("DROP"):
            cursor.advance()
            self._drop(cursor, tokens)
            return
        if head.is_word("USE"):
            cursor.advance()
            self._use(cursor)
            return
        self._unsupported(tokens)

    # -- helpers -----------------------------------------------------------

    def _fail(self, message: str, *, code: str = "INPUT_MALFORMED") -> "SqlDdlParseError":
        """Build a parse error carrying the source label."""
        return SqlDdlParseError(f"{message}{self._where}", code=code)

    def _unsupported(self, tokens: Sequence[SqlToken], *, location: Optional[str] = None) -> None:
        """Record a statement this reader does not model, naming what it was."""
        self._catalog.limits.record("sql.unsupported_statement", location=location)
        head = " ".join(token.value.upper() for token in tokens[:2] if token.kind == "word")
        self._catalog.count_statement(head or "unknown")

    def _split_name(self, raw: str) -> Tuple[Optional[str], str]:
        """Split a possibly qualified object name into ``(schema, name)``.

        A three-part name (``database.schema.table``) keeps its last two parts, because the
        catalog models one database. An unqualified name takes the namespace a ``USE``
        established, when one did — which is what puts a MySQL dump's tables under the
        database it selected.

        Args:
            raw: The name as the document spelled it.

        Returns:
            ``(schema, name)``.
        """
        parts = raw.split(".")
        if len(parts) >= 2:
            return parts[-2], parts[-1]
        return self._catalog.current_schema, parts[0]

    def _relation_for(self, raw: str) -> Optional[SqlRelation]:
        """Resolve an existing relation by the name a statement spelled."""
        return self._catalog.find_relation(raw)

    def _next_position(self) -> int:
        """Return the next declaration-order slot.

        The counter lives on the catalog rather than on this reader, because declaration
        order is a property of the *import*: a migrations set reads several files into one
        catalog, and a per-reader counter would restart at every file and interleave the
        second migration's tables with the first's.
        """
        self._catalog.declaration_count += 1
        return self._catalog.declaration_count

    # -- CREATE ------------------------------------------------------------

    def _create(self, cursor: _Cursor, tokens: Sequence[SqlToken]) -> None:
        """Dispatch a ``CREATE`` statement to the reader for its object kind."""
        cursor.accept_sequence("OR", "REPLACE")
        while cursor.accept_word("GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED", "EXTERNAL", "FOREIGN"):
            continue
        unique = bool(cursor.accept_word("UNIQUE"))
        kind = None
        while cursor.at_word(*_INDEX_KINDS):
            kind = cursor.advance().value.lower()
        if cursor.accept_word("TABLE"):
            self._create_table(cursor)
            return
        if cursor.accept_word("VIEW"):
            self._create_view(cursor, materialized=False)
            return
        if cursor.accept_sequence("MATERIALIZED", "VIEW"):
            self._create_view(cursor, materialized=True)
            return
        if cursor.accept_word("TYPE"):
            self._create_type(cursor, tokens)
            return
        if cursor.accept_word("DOMAIN"):
            self._create_domain(cursor)
            return
        if cursor.accept_word("INDEX"):
            self._create_index(cursor, unique=unique, kind=kind)
            return
        if cursor.accept_word("SEQUENCE"):
            self._create_sequence(cursor)
            return
        if cursor.accept_word("SCHEMA", "DATABASE"):
            self._create_schema(cursor)
            return
        self._unsupported(tokens)

    def _create_table(self, cursor: _Cursor) -> None:
        """Read ``CREATE TABLE`` — the statement the whole format is about."""
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        raw_name = _read_name(cursor)
        schema, name = self._split_name(raw_name)
        key = qualify(schema, name)
        relation = SqlRelation(name=name, schema=schema, position=self._next_position())
        if cursor.at_punct("("):
            body = self._take_body(cursor, key)
            self._read_table_body(body, relation)
        self._read_table_options(cursor, relation)
        existing = self._catalog.relations.get(key)
        if existing is not None and not relation.columns and relation.partition_of is None:
            # `CREATE TABLE IF NOT EXISTS` over a table the script already declared.
            return
        self._catalog.relations[key] = relation
        self._catalog.count_statement("CREATE TABLE")
        if len(self._catalog.relations) > MAX_TABLES:
            raise self._fail(
                f"the script declares more than {MAX_TABLES} relations", code="INPUT_ENTITY_LIMIT"
            )

    def _take_body(self, cursor: _Cursor, key: str) -> List[SqlToken]:
        """Consume a table's parenthesized body, telling truncation from a lost bracket.

        Args:
            cursor: The statement cursor, positioned at ``(``.
            key: The relation's key, for the error message.

        Returns:
            The body's tokens.

        Raises:
            SqlDdlParseError: ``INPUT_MALFORMED`` when a later statement's keyword turns up
                inside the unclosed group — a column list cannot contain a ``CREATE
                TABLE``, so the bracket was never closed. ``INPUT_TRUNCATED`` when the
                group simply runs out, which is what a cut-off file looks like.
        """
        opened = cursor.index
        try:
            return cursor.take_group()
        except SqlDdlParseError as exc:
            if getattr(exc, "code", None) != "INPUT_TRUNCATED":
                raise
            scanned = cursor.tokens[opened:]
            if any(token.kind == "word" and token.upper in _RESUMPTION_KEYWORDS for token in scanned):
                raise self._fail(
                    f"the column list of {key!r} is never closed — a later statement begins "
                    "inside it, so its opening parenthesis has no match",
                    code="INPUT_MALFORMED",
                ) from exc
            raise

    def _read_table_body(self, body: Sequence[SqlToken], relation: SqlRelation) -> None:
        """Read a table body's items into columns, constraints and indexes."""
        for item in _split_top_level(body):
            if not item:
                continue
            if item[0].kind == "word" and item[0].upper in _TABLE_CONSTRAINT_KEYWORDS:
                self._read_table_constraint(item, relation)
                continue
            self._read_column(item, relation)

    def _read_column(self, item: Sequence[SqlToken], relation: SqlRelation) -> SqlColumn:
        """Read one column definition and attach it to ``relation``.

        Args:
            item: The definition's tokens.
            relation: The relation the column belongs to.

        Returns:
            The column, so an ``ALTER`` action can inspect what it just added.

        Raises:
            SqlDdlParseError: ``INPUT_MALFORMED`` when the item does not start with a name.
        """
        cursor = _Cursor(item, where=self._where)
        head = cursor.peek()
        if head is None or head.kind not in {"word", "ident"}:
            raise self._fail(
                f"expected a column name in {relation.key!r} but found "
                f"{head.raw if head else 'the end of the statement'!r}"
            )
        column = SqlColumn(name=cursor.advance().value, position=len(relation.columns))
        spec = _read_type(cursor)
        if spec is not None:
            column.data_type = spec.text
            column.type_base = spec.base
            column.type_arguments = spec.arguments
            column.is_array = spec.is_array
            column.enum_values = spec.enum_values
            if spec.base in IDENTITY_TYPE_BASES:
                column.identity = {"kind": "serial"}
                self._catalog.limits.record("sql.identity", location=relation.key)
            if spec.base in VENDOR_TYPE_BASES:
                self._catalog.limits.record("sql.vendor_type", location=relation.key)
            if spec.base == "set":
                self._catalog.limits.record("sql.set_type", location=relation.key)
        self._read_column_constraints(cursor, column, relation)
        existing = relation.column(column.name)
        if existing is not None:
            index = relation.columns.index(existing)
            relation.columns[index] = column
            column.position = index
        else:
            relation.columns.append(column)
        if len(relation.columns) > MAX_COLUMNS:
            raise self._fail(
                f"{relation.key!r} declares more than {MAX_COLUMNS} columns",
                code="INPUT_ENTITY_LIMIT",
            )
        return column

    def _read_column_constraints(
        self, cursor: _Cursor, column: SqlColumn, relation: SqlRelation
    ) -> None:
        """Read the clauses that follow a column's type.

        Inline constraints are lifted to *table*-level :class:`SqlConstraint` records with a
        single-column list, so the projection reads one representation of a primary key
        rather than two.
        """
        pending_name: Optional[str] = None
        undecoded = False
        while not cursor.at_end:
            if cursor.accept_word("CONSTRAINT"):
                pending_name = _read_name(cursor)
                continue
            if cursor.accept_sequence("NOT", "NULL"):
                column.not_null = True
                pending_name = None
                continue
            if cursor.accept_word("NULL"):
                column.not_null = False
                pending_name = None
                continue
            if cursor.accept_sequence("PRIMARY", "KEY"):
                cursor.accept_word("CLUSTERED", "NONCLUSTERED")
                relation.constraints.append(
                    SqlConstraint(kind=ConstraintKind.PRIMARY_KEY, name=pending_name, columns=(column.name,))
                )
                column.not_null = True
                pending_name = None
                continue
            if cursor.accept_word("UNIQUE"):
                cursor.accept_word("KEY", "INDEX")
                cursor.accept_word("CLUSTERED", "NONCLUSTERED")
                relation.constraints.append(
                    SqlConstraint(kind=ConstraintKind.UNIQUE, name=pending_name, columns=(column.name,))
                )
                pending_name = None
                continue
            if cursor.accept_word("CHECK"):
                self._read_check(cursor, relation, name=pending_name, column=column)
                pending_name = None
                continue
            if cursor.accept_word("REFERENCES"):
                reference = self._read_reference(cursor)
                relation.constraints.append(
                    SqlConstraint(
                        kind=ConstraintKind.FOREIGN_KEY,
                        name=pending_name,
                        columns=(column.name,),
                        reference=reference,
                    )
                )
                pending_name = None
                continue
            if cursor.accept_word("DEFAULT"):
                self._read_default(cursor, column, relation)
                pending_name = None
                continue
            if cursor.accept_word("AUTO_INCREMENT", "AUTOINCREMENT"):
                column.identity = {"kind": "auto_increment"}
                self._catalog.limits.record("sql.identity", location=relation.key)
                continue
            if cursor.accept_word("IDENTITY"):
                identity: Dict[str, Any] = {"kind": "identity"}
                if cursor.at_punct("("):
                    arguments = [render(part) for part in _split_top_level(cursor.take_group())]
                    if arguments:
                        identity["arguments"] = arguments
                column.identity = identity
                self._catalog.limits.record("sql.identity", location=relation.key)
                continue
            if cursor.at_word("GENERATED"):
                self._read_generated(cursor, column, relation)
                continue
            if cursor.at_word("AS") and (peeked := cursor.peek(1)) is not None and peeked.is_punct("("):
                cursor.advance()
                self._read_computed(cursor, column, relation)
                continue
            if cursor.accept_word("COLLATE"):
                column.collation = _read_name(cursor)
                self._catalog.limits.record("sql.collation", location=relation.key)
                continue
            if cursor.accept_word("COMMENT"):
                cursor.accept_punct("=")
                token = cursor.peek()
                if token is not None and token.kind == "string":
                    column.comment = cursor.advance().value
                continue
            if cursor.accept_sequence("ON", "UPDATE"):
                column.extras["on_update"] = render(_read_atom(cursor))
                undecoded = True
                continue
            if cursor.accept_word("AFTER", "FIRST"):
                if cursor.at_name():
                    cursor.advance()
                undecoded = True
                continue
            cursor.advance()
            undecoded = True
        if undecoded:
            self._catalog.limits.record("sql.column_clause", location=relation.key)

    def _read_default(self, cursor: _Cursor, column: SqlColumn, relation: SqlRelation) -> None:
        """Read a ``DEFAULT`` clause, separating a stated literal from a computed value."""
        atom = _read_atom(cursor)
        column.has_default = True
        literal, value = _literal_value(atom)
        if literal:
            column.default_literal = value
        else:
            column.default_expression = render(atom)
            self._catalog.limits.record("sql.default_expression", location=relation.key)

    def _read_generated(self, cursor: _Cursor, column: SqlColumn, relation: SqlRelation) -> None:
        """Read ``GENERATED … AS IDENTITY`` and ``GENERATED ALWAYS AS (<expr>)``."""
        cursor.advance()
        mode = "always"
        if cursor.accept_sequence("BY", "DEFAULT"):
            mode = "by default"
        else:
            cursor.accept_word("ALWAYS")
        cursor.accept_sequence("ON", "NULL")
        cursor.accept_word("AS")
        if cursor.accept_word("IDENTITY"):
            identity: Dict[str, Any] = {"kind": "identity", "mode": mode}
            if cursor.at_punct("("):
                arguments = [render(part) for part in _split_top_level(cursor.take_group())]
                if arguments:
                    identity["arguments"] = arguments
            column.identity = identity
            self._catalog.limits.record("sql.identity", location=relation.key)
            return
        self._read_computed(cursor, column, relation, mode=mode)

    def _read_computed(
        self, cursor: _Cursor, column: SqlColumn, relation: SqlRelation, *, mode: str = "always"
    ) -> None:
        """Read a computed column's expression and its storage qualifier."""
        expression = render(cursor.take_group()) if cursor.at_punct("(") else render(_read_atom(cursor))
        generated: Dict[str, Any] = {"expression": expression, "mode": mode}
        storage = cursor.accept_word("STORED", "VIRTUAL", "PERSISTED")
        if storage is not None:
            generated["storage"] = storage.value.lower()
        column.generated = generated
        self._catalog.limits.record("sql.computed_column", location=relation.key)

    def _read_check(
        self,
        cursor: _Cursor,
        relation: SqlRelation,
        *,
        name: Optional[str],
        column: Optional[SqlColumn] = None,
    ) -> None:
        """Read a ``CHECK`` predicate, decoding the one shape that has a canonical analogue."""
        group = cursor.take_group()
        expression = render(group)
        target, values = _check_enum_values(group)
        if column is not None:
            column.checks = column.checks + (expression,)
        constraint = SqlConstraint(
            kind=ConstraintKind.CHECK,
            name=name,
            columns=(column.name,) if column is not None else ((target,) if target else ()),
            expression=expression,
            enum_values=values,
        )
        relation.constraints.append(constraint)
        self._catalog.limits.record("sql.check_constraint", location=relation.key)
        while cursor.accept_word(*_CONSTRAINT_STATE_WORDS):
            continue

    def _read_reference(self, cursor: _Cursor) -> SqlReference:
        """Read the target half of a foreign key, with its referential actions."""
        table = _read_name(cursor)
        columns: Tuple[str, ...] = ()
        if cursor.at_punct("("):
            columns = _read_column_list(cursor.take_group())
        reference = SqlReference(table=table, columns=columns)
        while not cursor.at_end:
            if cursor.accept_sequence("ON", "DELETE"):
                reference.on_delete = self._read_action(cursor)
                continue
            if cursor.accept_sequence("ON", "UPDATE"):
                reference.on_update = self._read_action(cursor)
                continue
            if cursor.accept_word("MATCH"):
                cursor.accept_word("FULL", "PARTIAL", "SIMPLE")
                continue
            if cursor.accept_word(*_CONSTRAINT_STATE_WORDS):
                continue
            if cursor.accept_sequence("NOT", "DEFERRABLE"):
                continue
            break
        return reference

    @staticmethod
    def _read_action(cursor: _Cursor) -> Optional[str]:
        """Read a referential action (``CASCADE``, ``SET NULL``, ``NO ACTION``, …)."""
        first = cursor.peek()
        second = cursor.peek(1)
        if first is None:
            return None
        if second is not None:
            pair = (first.upper, second.upper)
            if pair in _TWO_WORD_ACTIONS:
                cursor.skip(2)
                return _TWO_WORD_ACTIONS[pair]
        if first.kind == "word":
            cursor.advance()
            return first.upper
        return None

    def _read_table_constraint(self, item: Sequence[SqlToken], relation: SqlRelation) -> None:
        """Read one table-level constraint, key or index declaration."""
        cursor = _Cursor(item, where=self._where)
        name: Optional[str] = None
        if cursor.accept_word("CONSTRAINT"):
            name = _read_name(cursor)
        if cursor.accept_sequence("PRIMARY", "KEY"):
            cursor.accept_word("CLUSTERED", "NONCLUSTERED")
            columns = _read_column_list(cursor.take_group()) if cursor.at_punct("(") else ()
            relation.constraints.append(
                SqlConstraint(kind=ConstraintKind.PRIMARY_KEY, name=name, columns=columns)
            )
            return
        if cursor.accept_word("UNIQUE"):
            cursor.accept_word("KEY", "INDEX")
            cursor.accept_word("CLUSTERED", "NONCLUSTERED")
            if not cursor.at_punct("(") and cursor.at_name():
                name = name or _read_name(cursor)
            columns = _read_column_list(cursor.take_group()) if cursor.at_punct("(") else ()
            relation.constraints.append(
                SqlConstraint(kind=ConstraintKind.UNIQUE, name=name, columns=columns)
            )
            return
        if cursor.accept_sequence("FOREIGN", "KEY"):
            if not cursor.at_punct("(") and cursor.at_name():
                name = name or _read_name(cursor)
            columns = _read_column_list(cursor.take_group()) if cursor.at_punct("(") else ()
            if not cursor.accept_word("REFERENCES"):
                raise self._fail(f"the foreign key on {relation.key!r} names no target table")
            relation.constraints.append(
                SqlConstraint(
                    kind=ConstraintKind.FOREIGN_KEY,
                    name=name,
                    columns=columns,
                    reference=self._read_reference(cursor),
                )
            )
            return
        if cursor.accept_word("CHECK"):
            self._read_check(cursor, relation, name=name)
            return
        if cursor.at_word("KEY", "INDEX") or cursor.at_word(*_INDEX_KINDS):
            self._read_body_index(cursor, relation, name=name)
            return
        self._catalog.limits.record("sql.column_clause", location=relation.key)

    def _read_body_index(self, cursor: _Cursor, relation: SqlRelation, *, name: Optional[str]) -> None:
        """Read a ``KEY``/``INDEX``/``FULLTEXT KEY`` declared inside a table body."""
        kind: Optional[str] = None
        while cursor.at_word(*_INDEX_KINDS):
            kind = cursor.advance().value.lower()
        cursor.accept_word("KEY", "INDEX")
        if not cursor.at_punct("(") and cursor.at_name():
            name = name or _read_name(cursor)
        columns = _read_column_list(cursor.take_group()) if cursor.at_punct("(") else ()
        relation.indexes.append(SqlIndex(name=name, table=relation.key, columns=columns, kind=kind))
        self._catalog.limits.record("sql.index", location=relation.key)

    def _read_table_options(self, cursor: _Cursor, relation: SqlRelation) -> None:
        """Read everything that follows a table's body — storage, partitioning, inheritance."""
        while not cursor.at_end:
            if cursor.at_sequence("PARTITION", "BY"):
                relation.partitioning = render(cursor.take_rest())
                self._catalog.limits.record("sql.partitioning", location=relation.key)
                continue
            if cursor.at_sequence("PARTITION", "OF"):
                cursor.skip(2)
                relation.partition_of = _read_name(cursor)
                if not cursor.at_end:
                    relation.partitioning = render(cursor.take_rest())
                self._catalog.limits.record("sql.partitioning", location=relation.key)
                continue
            if cursor.accept_word("INHERITS"):
                relation.inherits = tuple(render(part) for part in _split_top_level(cursor.take_group()))
                self._catalog.limits.record("sql.table_inheritance", location=relation.key)
                continue
            if cursor.accept_word("COMMENT"):
                cursor.accept_punct("=")
                token = cursor.peek()
                if token is not None and token.kind == "string":
                    relation.comment = cursor.advance().value
                continue
            token = cursor.peek()
            if token is None:
                break
            if token.kind != "word":
                cursor.advance()
                continue
            key = cursor.advance().value.upper()
            if key == "DEFAULT" and cursor.at_word("CHARSET", "CHARACTER", "COLLATE"):
                key = f"DEFAULT {cursor.advance().value.upper()}"
                if key.endswith("CHARACTER"):
                    cursor.accept_word("SET")
                    key = "DEFAULT CHARACTER SET"
            cursor.accept_punct("=")
            value = render(_read_atom(cursor))
            relation.options[key] = value or True
            self._catalog.limits.record("sql.storage_clause", location=relation.key)

    def _create_view(self, cursor: _Cursor, *, materialized: bool) -> None:
        """Read ``CREATE VIEW`` / ``CREATE MATERIALIZED VIEW``."""
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        raw_name = _read_name(cursor)
        schema, name = self._split_name(raw_name)
        declared: Tuple[str, ...] = ()
        if cursor.at_punct("("):
            declared = _read_column_list(cursor.take_group())
        while not cursor.at_end and not cursor.at_word("AS"):
            cursor.advance()
        cursor.accept_word("AS")
        definition_tokens = cursor.take_rest()
        relation = SqlRelation(
            name=name,
            schema=schema,
            kind="materialized_view" if materialized else "view",
            position=self._next_position(),
            view_definition=render(definition_tokens),
        )
        relation.view_columns = self._read_view_columns(definition_tokens, declared, relation)
        self._catalog.relations[relation.key] = relation
        self._catalog.limits.record("sql.view_definition", location=relation.key)
        self._catalog.count_statement("CREATE VIEW")

    def _read_view_columns(
        self, tokens: Sequence[SqlToken], declared: Sequence[str], relation: SqlRelation
    ) -> List[SqlViewColumn]:
        """Name the columns a view projects, resolving the ones that are column references.

        The ``SELECT`` is *read*, never planned: the select list is split on top-level
        commas, an explicit ``AS`` alias names the output column, and a bare column
        reference names and types it by looking the source column up. Anything else — an
        aggregate, an arithmetic term, a ``CASE`` — is a derived column whose type the
        document does not state, and is declared as such.

        Args:
            tokens: The view's definition tokens.
            declared: Column names from an explicit ``CREATE VIEW v (a, b)`` list, which
                override the projected names positionally.
            relation: The view, for limit locations.

        Returns:
            The projected columns, in select-list order.
        """
        select_at = next(
            (index for index, token in enumerate(tokens) if token.is_word("SELECT")), None
        )
        if select_at is None:
            self._catalog.limits.record("sql.view_derived_column", location=relation.key)
            return []
        body = list(tokens[select_at + 1 :])
        cursor = _Cursor(body, where=self._where)
        cursor.accept_word("ALL", "DISTINCT")
        if cursor.at_word("ON") and (peeked := cursor.peek(1)) is not None and peeked.is_punct("("):
            cursor.advance()
            cursor.take_group()
        body = body[cursor.index :]
        depth = 0
        end = len(body)
        for index, token in enumerate(body):
            if token.is_punct("("):
                depth += 1
            elif token.is_punct(")"):
                depth -= 1
            elif depth == 0 and token.is_word("FROM"):
                end = index
                break
        sources = self._read_view_sources(body[end:])
        columns: List[SqlViewColumn] = []
        for position, item in enumerate(_split_top_level(body[:end])):
            column = self._read_view_column(item, position, sources, relation)
            if column is None:
                continue
            if position < len(declared):
                column.name = declared[position]
            columns.append(column)
        return columns

    def _read_view_sources(self, tokens: Sequence[SqlToken]) -> Dict[str, SqlRelation]:
        """Map every alias and table name in a view's ``FROM``/``JOIN`` clauses to a relation."""
        sources: Dict[str, SqlRelation] = {}
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token.kind == "word" and token.upper in {"FROM", "JOIN"}:
                cursor = _Cursor(tokens[index + 1 :], where=self._where)
                following = cursor.peek()
                if following is None or following.kind not in {"word", "ident"}:
                    index += 1
                    continue
                raw = _read_name(cursor)
                relation = self._relation_for(raw)
                if relation is not None:
                    sources[raw.rsplit(".", 1)[-1].casefold()] = relation
                    cursor.accept_word("AS")
                    alias = cursor.peek()
                    if alias is not None and alias.kind in {"word", "ident"} and not alias.is_word(*_NOT_AN_ALIAS):
                        sources[alias.value.casefold()] = relation
                index += 1 + cursor.index
                continue
            index += 1
        return sources

    def _read_view_column(
        self,
        item: Sequence[SqlToken],
        position: int,
        sources: Mapping[str, SqlRelation],
        relation: SqlRelation,
    ) -> Optional[SqlViewColumn]:
        """Read one select-list item into a projected column."""
        expression = render(item)
        if _is_star_projection(item):
            self._catalog.limits.record("sql.view_derived_column", location=relation.key)
            return None
        if len(item) >= 2 and item[-2].is_word("AS") and item[-1].kind in {"word", "ident"}:
            name = item[-1].value
            reference = item[:-2]
        else:
            name = ""
            reference = item
        source_table: Optional[str] = None
        source_column: Optional[str] = None
        qualifier: Optional[str] = None
        if len(reference) == 1 and reference[0].kind in {"word", "ident"}:
            source_column = reference[0].value
        elif (
            len(reference) == 3
            and reference[0].kind in {"word", "ident"}
            and reference[1].is_punct(".")
            and reference[2].kind in {"word", "ident"}
        ):
            qualifier = reference[0].value
            source_column = reference[2].value
        if source_column is not None:
            owner = self._resolve_view_source(qualifier, source_column, sources)
            if owner is not None:
                source_table = owner.key
            name = name or source_column
        if not name:
            name = f"column_{position + 1}"
            self._catalog.limits.record("sql.view_derived_column", location=relation.key)
        elif source_table is None:
            self._catalog.limits.record("sql.view_derived_column", location=relation.key)
        return SqlViewColumn(
            name=name,
            expression=expression,
            source_table=source_table,
            source_column=source_column if source_table else None,
        )

    @staticmethod
    def _resolve_view_source(
        qualifier: Optional[str], column: str, sources: Mapping[str, SqlRelation]
    ) -> Optional[SqlRelation]:
        """Find the relation a view's column reference belongs to, when exactly one does."""
        if qualifier is not None:
            return sources.get(qualifier.casefold())
        owners = {
            relation.key: relation
            for relation in sources.values()
            if relation.column(column) is not None
        }
        return next(iter(owners.values())) if len(owners) == 1 else None

    def _create_type(self, cursor: _Cursor, tokens: Sequence[SqlToken]) -> None:
        """Read ``CREATE TYPE`` — an enumeration, or a composite (row) type."""
        raw_name = _read_name(cursor)
        schema, name = self._split_name(raw_name)
        cursor.accept_word("AS")
        if cursor.accept_word("ENUM"):
            group = cursor.take_group() if cursor.at_punct("(") else []
            values = tuple(
                item[0].value for item in _split_top_level(group) if item and item[0].kind == "string"
            )
            enum = SqlEnum(name=name, schema=schema, values=values, position=self._next_position())
            self._catalog.enums[enum.key] = enum
            self._catalog.count_statement("CREATE TYPE")
            return
        cursor.accept_word("OBJECT")
        if cursor.at_punct("("):
            composite = SqlRelation(
                name=name, schema=schema, kind="composite", position=self._next_position()
            )
            self._read_table_body(cursor.take_group(), composite)
            self._catalog.composites[composite.key] = composite
            self._catalog.count_statement("CREATE TYPE")
            return
        self._unsupported(tokens, location=qualify(schema, name))

    def _create_domain(self, cursor: _Cursor) -> None:
        """Read ``CREATE DOMAIN`` — a named scalar with constraints."""
        raw_name = _read_name(cursor)
        schema, name = self._split_name(raw_name)
        cursor.accept_word("AS")
        spec = _read_type(cursor)
        domain = SqlDomain(
            name=name,
            schema=schema,
            data_type=spec.text if spec else None,
            type_base=spec.base if spec else None,
            type_arguments=spec.arguments if spec else (),
            position=self._next_position(),
        )
        while not cursor.at_end:
            if cursor.accept_word("CONSTRAINT"):
                _read_name(cursor)
                continue
            if cursor.accept_sequence("NOT", "NULL"):
                domain.not_null = True
                continue
            if cursor.accept_word("NULL"):
                continue
            if cursor.accept_word("COLLATE"):
                _read_name(cursor)
                self._catalog.limits.record("sql.collation", location=domain.key)
                continue
            if cursor.accept_word("DEFAULT"):
                atom = _read_atom(cursor)
                literal, value = _literal_value(atom)
                if literal:
                    domain.default_literal = value
                else:
                    domain.default_expression = render(atom)
                    self._catalog.limits.record("sql.default_expression", location=domain.key)
                continue
            if cursor.accept_word("CHECK"):
                group = cursor.take_group()
                domain.checks = domain.checks + (render(group),)
                target, values = _check_enum_values(group)
                if values and (target is None or target.upper() == "VALUE"):
                    domain.enum_values = values
                self._catalog.limits.record("sql.check_constraint", location=domain.key)
                continue
            cursor.advance()
        self._catalog.domains[domain.key] = domain
        self._catalog.count_statement("CREATE DOMAIN")

    def _create_index(self, cursor: _Cursor, *, unique: bool, kind: Optional[str]) -> None:
        """Read a standalone ``CREATE INDEX`` and attach it to the relation it indexes."""
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        name: Optional[str] = None
        if not cursor.at_word("ON"):
            name = _read_name(cursor)
        cursor.accept_word("ON")
        table = _read_name(cursor)
        if cursor.accept_word("USING"):
            cursor.advance()
        columns = _read_column_list(cursor.take_group()) if cursor.at_punct("(") else ()
        include: Tuple[str, ...] = ()
        predicate: Optional[str] = None
        while not cursor.at_end:
            if cursor.accept_word("INCLUDE"):
                include = _read_column_list(cursor.take_group()) if cursor.at_punct("(") else ()
                continue
            if cursor.accept_word("WHERE"):
                predicate = render(cursor.take_rest())
                continue
            cursor.advance()
        index = SqlIndex(
            name=name,
            table=table,
            columns=columns,
            unique=unique,
            kind=kind,
            predicate=predicate,
            include=include,
        )
        relation = self._relation_for(table)
        if relation is not None:
            index.table = relation.key
            relation.indexes.append(index)
            self._catalog.limits.record("sql.index", location=relation.key)
        else:
            self._catalog.limits.record("sql.index")
        self._catalog.count_statement("CREATE INDEX")

    def _create_sequence(self, cursor: _Cursor) -> None:
        """Read ``CREATE SEQUENCE`` — carried, because it declares a generator, not a shape."""
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        raw_name = _read_name(cursor)
        schema, name = self._split_name(raw_name)
        options: Dict[str, Any] = {}
        while not cursor.at_end:
            token = cursor.peek()
            if token is None or token.kind != "word":
                cursor.advance()
                continue
            key = cursor.advance().value.upper()
            for extra in ("WITH", "BY", "VALUE"):
                if cursor.at_word(extra):
                    key = f"{key} {cursor.advance().value.upper()}"
            cursor.accept_punct("=")
            following = cursor.peek()
            if following is not None and following.kind in {"number", "string"}:
                options[key] = cursor.advance().value
            else:
                options[key] = True
        sequence = SqlSequence(name=name, schema=schema, options=options)
        self._catalog.sequences[sequence.key] = sequence
        self._catalog.limits.record("sql.sequence")
        self._catalog.count_statement("CREATE SEQUENCE")

    def _create_schema(self, cursor: _Cursor) -> None:
        """Read ``CREATE SCHEMA`` / ``CREATE DATABASE`` — the namespace, plus its options."""
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        name = _read_name(cursor) if not cursor.at_end else ""
        record: Dict[str, Any] = {"name": name}
        rest = render(cursor.take_rest())
        if rest:
            record["options"] = rest
        if name and not any(entry.get("name") == name for entry in self._catalog.schemas):
            self._catalog.schemas.append(record)
        self._catalog.limits.record("sql.schema_definition")
        self._catalog.count_statement("CREATE SCHEMA")

    def _use(self, cursor: _Cursor) -> None:
        """Read ``USE <database>`` — the namespace later unqualified names resolve into."""
        if cursor.at_end:
            return
        name = _read_name(cursor)
        self._catalog.current_schema = name
        if not any(entry.get("name") == name for entry in self._catalog.schemas):
            self._catalog.schemas.append({"name": name})
        self._catalog.limits.record("sql.schema_definition")
        self._catalog.count_statement("USE")

    # -- ALTER -------------------------------------------------------------

    def _alter_table(self, cursor: _Cursor, tokens: Sequence[SqlToken]) -> None:
        """Apply an ``ALTER TABLE``'s actions to the relation they change."""
        cursor.accept_sequence("IF", "EXISTS")
        cursor.accept_word("ONLY")
        raw_name = _read_name(cursor)
        relation = self._relation_for(raw_name)
        if relation is None:
            self._unsupported(tokens, location=raw_name)
            return
        for action in _split_top_level(cursor.take_rest()):
            self._alter_action(_Cursor(action, where=self._where), relation, action)
        self._catalog.count_statement("ALTER TABLE")

    def _alter_action(self, cursor: _Cursor, relation: SqlRelation, tokens: Sequence[SqlToken]) -> None:
        """Apply one comma-separated ``ALTER TABLE`` action."""
        if cursor.accept_word("ADD"):
            self._alter_add(cursor, relation, tokens)
            return
        if cursor.accept_word("DROP"):
            self._alter_drop(cursor, relation)
            return
        if cursor.accept_word("RENAME"):
            self._alter_rename(cursor, relation)
            return
        if cursor.accept_word("ALTER", "MODIFY", "CHANGE"):
            self._alter_column(cursor, relation, tokens)
            return
        self._catalog.limits.record("sql.unsupported_statement", location=relation.key)

    def _alter_add(self, cursor: _Cursor, relation: SqlRelation, tokens: Sequence[SqlToken]) -> None:
        """Apply ``ADD COLUMN`` / ``ADD CONSTRAINT`` / ``ADD KEY``."""
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        if cursor.at_word(*_TABLE_CONSTRAINT_KEYWORDS) or cursor.at_word(*_INDEX_KINDS):
            self._read_table_constraint(cursor.take_rest(), relation)
            return
        _ = tokens
        cursor.accept_word("COLUMN")
        cursor.accept_sequence("IF", "NOT", "EXISTS")
        self._read_column(cursor.take_rest(), relation)

    def _alter_drop(self, cursor: _Cursor, relation: SqlRelation) -> None:
        """Apply ``DROP COLUMN`` / ``DROP CONSTRAINT``."""
        if cursor.accept_word("CONSTRAINT"):
            cursor.accept_sequence("IF", "EXISTS")
            name = _read_name(cursor)
            relation.constraints = [c for c in relation.constraints if c.name != name]
            relation.indexes = [index for index in relation.indexes if index.name != name]
            return
        if cursor.accept_word("INDEX", "KEY"):
            name = _read_name(cursor)
            relation.indexes = [index for index in relation.indexes if index.name != name]
            return
        cursor.accept_word("COLUMN")
        cursor.accept_sequence("IF", "EXISTS")
        if cursor.at_end:
            return
        name = _read_name(cursor)
        folded = name.casefold()
        relation.columns = [column for column in relation.columns if column.name.casefold() != folded]
        for position, column in enumerate(relation.columns):
            column.position = position
        relation.constraints = [
            constraint
            for constraint in relation.constraints
            if folded not in {value.casefold() for value in constraint.columns}
        ]

    def _alter_rename(self, cursor: _Cursor, relation: SqlRelation) -> None:
        """Apply ``RENAME COLUMN a TO b`` and ``RENAME TO <table>``."""
        if cursor.accept_word("COLUMN"):
            old = _read_name(cursor)
            cursor.accept_word("TO", "AS")
            new = _read_name(cursor)
            column = relation.column(old)
            if column is not None:
                folded = old.casefold()
                column.name = new
                for constraint in relation.constraints:
                    constraint.columns = tuple(
                        new if value.casefold() == folded else value for value in constraint.columns
                    )
                for index in relation.indexes:
                    index.columns = tuple(
                        new if value.casefold() == folded else value for value in index.columns
                    )
            return
        cursor.accept_word("TO", "AS")
        if cursor.at_end:
            return
        new_raw = _read_name(cursor)
        schema, name = self._split_name(new_raw)
        self._catalog.relations.pop(relation.key, None)
        relation.schema = schema
        relation.name = name
        self._catalog.relations[relation.key] = relation

    def _alter_column(self, cursor: _Cursor, relation: SqlRelation, tokens: Sequence[SqlToken]) -> None:
        """Apply the ``ALTER``/``MODIFY``/``CHANGE`` column actions of all four dialects."""
        cursor.accept_word("COLUMN")
        if cursor.at_end:
            return
        name = _read_name(cursor)
        column = relation.column(name)
        if column is None:
            # MySQL's `CHANGE old new <type>` renames while redefining.
            self._catalog.limits.record("sql.unsupported_statement", location=relation.key)
            return
        if cursor.at_end:
            return
        if cursor.accept_sequence("SET", "NOT", "NULL"):
            column.not_null = True
            return
        if cursor.accept_sequence("DROP", "NOT", "NULL"):
            column.not_null = False
            return
        if cursor.accept_sequence("SET", "DEFAULT"):
            self._read_default(cursor, column, relation)
            return
        if cursor.accept_sequence("DROP", "DEFAULT"):
            column.has_default = False
            column.default_literal = None
            column.default_expression = None
            return
        cursor.accept_sequence("SET", "DATA")
        cursor.accept_word("TYPE")
        spec = _read_type(cursor)
        if spec is None:
            self._catalog.limits.record("sql.unsupported_statement", location=relation.key)
            return
        column.data_type = spec.text
        column.type_base = spec.base
        column.type_arguments = spec.arguments
        column.is_array = spec.is_array
        column.enum_values = spec.enum_values
        # A `MODIFY`/`CHANGE` restates the whole definition, so the clauses after the type
        # are the column's new ones.
        self._read_column_constraints(cursor, column, relation)
        _ = tokens

    # -- COMMENT / DROP ----------------------------------------------------

    def _comment_on(self, cursor: _Cursor, tokens: Sequence[SqlToken]) -> None:
        """Apply ``COMMENT ON TABLE|VIEW|COLUMN … IS '…'``."""
        target = cursor.peek()
        if target is None:
            return
        kind = cursor.advance().upper
        if kind == "MATERIALIZED":
            cursor.accept_word("VIEW")
            kind = "VIEW"
        raw_name = _read_name(cursor)
        cursor.accept_word("IS")
        literal = cursor.peek()
        text = literal.value if literal is not None and literal.kind == "string" else None
        if kind in {"TABLE", "VIEW"}:
            relation = self._relation_for(raw_name)
            if relation is not None:
                relation.comment = text
            self._catalog.count_statement("COMMENT ON")
            return
        if kind == "COLUMN":
            table_part, _, column_name = raw_name.rpartition(".")
            relation = self._relation_for(table_part) if table_part else None
            if relation is not None:
                column = relation.column(column_name)
                if column is not None:
                    column.comment = text
                else:
                    projected = next(
                        (
                            view_column
                            for view_column in relation.view_columns
                            if view_column.name.casefold() == column_name.casefold()
                        ),
                        None,
                    )
                    if projected is None:
                        self._catalog.limits.record("sql.unsupported_statement", location=relation.key)
            self._catalog.count_statement("COMMENT ON")
            return
        self._unsupported(tokens)

    def _drop(self, cursor: _Cursor, tokens: Sequence[SqlToken]) -> None:
        """Apply ``DROP TABLE``/``VIEW``/``TYPE``/``DOMAIN``/``INDEX`` to the final state."""
        kind = cursor.peek()
        if kind is None:
            return
        cursor.accept_word("MATERIALIZED")
        object_kind = cursor.advance().upper
        cursor.accept_sequence("IF", "EXISTS")
        if object_kind not in {"TABLE", "VIEW", "TYPE", "DOMAIN", "INDEX", "SEQUENCE"}:
            self._unsupported(tokens)
            return
        names: List[str] = []
        while not cursor.at_end:
            token = cursor.peek()
            if token is None or token.kind not in {"word", "ident"}:
                break
            names.append(_read_name(cursor))
            if not cursor.accept_punct(","):
                break
        for raw_name in names:
            if object_kind in {"TABLE", "VIEW"}:
                relation = self._relation_for(raw_name)
                if relation is not None:
                    self._catalog.relations.pop(relation.key, None)
            elif object_kind in {"TYPE", "DOMAIN"}:
                key = self._catalog.find_named_type(raw_name)
                if key is not None:
                    self._catalog.enums.pop(key, None)
                    self._catalog.domains.pop(key, None)
                    self._catalog.composites.pop(key, None)
            elif object_kind == "SEQUENCE":
                schema, name = self._split_name(raw_name)
                self._catalog.sequences.pop(qualify(schema, name), None)
            else:
                for relation in self._catalog.relations.values():
                    relation.indexes = [
                        index for index in relation.indexes if index.name != raw_name
                    ]
        self._catalog.count_statement(f"DROP {object_kind}")


# ===========================================================================
# Whole-document passes
# ===========================================================================

#: How many times inheritance is resolved before the reader gives up chasing a chain. A
#: PostgreSQL inheritance tree is one or two levels deep in practice; the bound stops a
#: cycle (``a INHERITS (b)``, ``b INHERITS (a)``) from spinning.
_MAX_INHERITANCE_PASSES = 8


def _copy_column(column: SqlColumn) -> SqlColumn:
    """Return an independent copy of ``column``, mutable members included.

    An inherited column belongs to the child as much as to the parent, so a later ``ALTER``
    on either must not reach the other. Tuples are already immutable; the dictionaries are
    not.

    Args:
        column: The column to copy.

    Returns:
        The copy.
    """
    fields = dict(vars(column))
    fields["extras"] = dict(column.extras)
    fields["identity"] = dict(column.identity) if column.identity else None
    fields["generated"] = dict(column.generated) if column.generated else None
    return SqlColumn(**fields)


def _merge_inherited_columns(catalog: SqlCatalog) -> None:
    """Give every inheriting and partitioned relation the columns it actually has.

    PostgreSQL's ``INHERITS (parent)`` *copies* the parent's columns into the child, and a
    ``PARTITION OF parent`` child has exactly the parent's columns. Both are real structure
    — a row in the child carries those columns — so both are modelled, in the physical order
    the database gives them: inherited columns first, then the child's own. The inheritance
    *link* has no canonical analogue and stays a declared limit.

    Args:
        catalog: The catalog to complete, in place.
    """
    for _ in range(_MAX_INHERITANCE_PASSES):
        changed = False
        for relation in catalog.relations.values():
            parents = list(relation.inherits)
            if relation.partition_of:
                parents.append(relation.partition_of)
            for parent_name in parents:
                parent = catalog.find_relation(parent_name)
                if parent is None or parent is relation:
                    continue
                inherited = [
                    column
                    for column in parent.columns
                    if relation.column(column.name) is None
                ]
                if not inherited:
                    continue
                copies = [_copy_column(column) for column in inherited]
                relation.columns = copies + relation.columns
                for position, column in enumerate(relation.columns):
                    column.position = position
                changed = True
            if relation.partition_of and not relation.constraints:
                parent = catalog.find_relation(relation.partition_of)
                if parent is not None and parent is not relation and parent.constraints:
                    relation.constraints = list(parent.constraints)
                    changed = True
        if not changed:
            return


def _resolve_relationships(catalog: SqlCatalog, *, source_label: Optional[str] = None) -> None:
    """Resolve every foreign key, and refuse the ones that dangle.

    A foreign key is an edge this reader *writes down* — it becomes a relationship on the
    canonical field — so one that names a table the import does not contain cannot be
    carried honestly. It is refused as ``INPUT_REFERENCE_UNRESOLVED``, exactly as FMT-5.4
    refuses a dangling ``relationships`` test, rather than silently dropped.

    Args:
        catalog: The catalog to resolve, in place.
        source_label: The document's name, for the error message.

    Raises:
        SqlDdlParseError: ``INPUT_REFERENCE_UNRESOLVED`` when a foreign key names an
            unknown table.
    """
    where = f" ({source_label})" if source_label else ""
    for relation in catalog.relations.values():
        for constraint in relation.constraints:
            if constraint.kind != ConstraintKind.FOREIGN_KEY or constraint.reference is None:
                continue
            target = catalog.find_relation(constraint.reference.table)
            if target is None:
                named = constraint.name or "unnamed"
                raise SqlDdlParseError(
                    f"the foreign key {named!r} on {relation.key!r} references table "
                    f"{constraint.reference.table!r}{where}, which no statement in this import "
                    "creates. Import the migrations directory or the whole schema dump so the "
                    "referenced table is present, or remove the constraint.",
                    code="INPUT_REFERENCE_UNRESOLVED",
                )
            constraint.reference.resolved_table = target.key
            catalog.limits.record("sql.foreign_key", location=relation.key)
        for constraint in relation.constraints:
            if constraint.kind in {ConstraintKind.PRIMARY_KEY, ConstraintKind.UNIQUE}:
                catalog.limits.record("sql.uniqueness", location=relation.key)
            if constraint.kind == ConstraintKind.PRIMARY_KEY:
                for name in constraint.columns:
                    column = relation.column(name)
                    if column is not None:
                        column.not_null = True


# ===========================================================================
# Public API
# ===========================================================================


def _refusal_code(text: str) -> Optional[str]:
    """Pick the code for a document that carries no DDL statement at all.

    A cleanly decoded document that declares nothing this reader recognizes is the *wrong
    format*, and saying so is more useful than "malformed" — the pipeline's own mismatch
    rule cannot reach that verdict here, because it depends on some *other* adapter
    claiming the document, and formats like DBML have no adapter to claim them. A document
    that did not decode cleanly is an **encoding** fault first, so it is refused without a
    code and the pipeline classifies it.

    Args:
        text: The decoded document.

    Returns:
        ``"FORMAT_MISMATCH"``, or ``None`` to defer to the pipeline.
    """
    if "\x00" in text or "�" in text or text.startswith("﻿"):
        return None
    return "FORMAT_MISMATCH"


def _read_script(
    catalog: SqlCatalog, text: str, *, source_label: Optional[str] = None
) -> None:
    """Tokenize one script and apply every statement in it to ``catalog``.

    Args:
        catalog: The catalog being built.
        text: The script.
        source_label: The script's name, for error messages.

    Raises:
        SqlDdlParseError: With this reader's taxonomy code for any statement it models and
            cannot read.
    """
    tokens = tokenize(text, dialect=catalog.dialect, source_label=source_label)
    statements, _unterminated = split_statements(
        tokens, dialect=catalog.dialect, source_label=source_label
    )
    reader = _StatementReader(catalog, source_label=source_label)
    for statement in statements:
        reader.apply(statement)


def _finish(catalog: SqlCatalog, *, source_label: Optional[str] = None) -> SqlCatalog:
    """Run the whole-document passes and the semantic checks, then freeze the catalog.

    Args:
        catalog: The built catalog.
        source_label: The document's name, for error messages.

    Returns:
        The same catalog.

    Raises:
        SqlDdlParseError: ``INPUT_SEMANTIC_INVALID`` when the import declares no shape,
            ``INPUT_REFERENCE_UNRESOLVED`` for a dangling foreign key,
            ``INPUT_ENTITY_LIMIT`` past the column ceiling.
    """
    where = f" ({source_label})" if source_label else ""
    _merge_inherited_columns(catalog)
    _resolve_relationships(catalog, source_label=source_label)
    empty = [
        relation.key
        for relation in catalog.relations.values()
        if relation.kind == "table" and not relation.columns
    ]
    if empty and not catalog.describes_data():
        listed = ", ".join(sorted(empty)[:5])
        raise SqlDdlParseError(
            f"the script declares table(s) {listed} with no columns{where}, so it describes no "
            "structure to import. A `CREATE TABLE` needs at least one column definition.",
            code="INPUT_SEMANTIC_INVALID",
        )
    if not catalog.describes_data():
        raise SqlDdlParseError(
            f"the script declares no table, view or type{where}, so there is nothing to import.",
            code="INPUT_SEMANTIC_INVALID",
        )
    total_columns = sum(len(relation.columns) for relation in catalog.relations.values())
    if total_columns > MAX_COLUMNS:
        raise SqlDdlParseError(
            f"the script declares more than {MAX_COLUMNS} columns{where}",
            code="INPUT_ENTITY_LIMIT",
        )
    # A column-less table beside real ones is kept, not dropped: PostgreSQL allows
    # `CREATE TABLE t ()`, the script did declare the relation, and an empty record is a
    # truer reading of it than a silent removal. It is only when *nothing* in the import has
    # a shape that there is nothing to import — which is the refusal above.
    catalog.name = _catalog_name(catalog, source_label=source_label)
    return catalog


def _catalog_name(catalog: SqlCatalog, *, source_label: Optional[str] = None) -> str:
    """Name the import after the schema it describes.

    A script that puts everything in one schema is named for that schema, which is what a
    reader expects a catalog entry called ``commerce`` to contain. A script that spans
    several (or names none) falls back to the document's own name.

    Args:
        catalog: The built catalog.
        source_label: The document or file-set label.

    Returns:
        The import's name.
    """
    namespaces = {
        relation.schema for relation in catalog.relations.values() if relation.schema
    }
    if len(namespaces) == 1 and len(namespaces) == len(
        {relation.schema for relation in catalog.relations.values()}
    ):
        return next(iter(namespaces))
    if source_label:
        stem = source_label.rsplit("/", 1)[-1]
        for suffix in SQL_DDL_SUFFIXES:
            if stem.lower().endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        if stem:
            return stem
    return "schema"


def parse_sql_ddl(
    raw: str, *, source_label: Optional[str] = None, dialect: Optional[str] = None
) -> SqlCatalog:
    """Read one DDL script into its final state.

    Args:
        raw: The script text.
        source_label: The document's name, for error messages.
        dialect: A forced dialect (any spelling :func:`normalize_dialect` accepts). When
            omitted the dialect is detected from the script's own markers.

    Returns:
        The :class:`~app.sql_ddl_schema.SqlCatalog` the script leaves behind.

    Raises:
        SqlDdlParseError: With this reader's taxonomy code; see the module docstring.
    """
    if len(raw.encode("utf-8", errors="ignore")) > MAX_SQL_BYTES:
        raise SqlDdlParseError(
            f"the script is larger than the {MAX_SQL_BYTES}-byte DDL ceiling", code="INPUT_TOO_LARGE"
        )
    try:
        override = normalize_dialect(dialect)
    except ValueError as exc:
        raise SqlDdlParseError(str(exc), code="INPUT_SEMANTIC_INVALID") from exc
    if not is_sql_ddl(raw):
        raise SqlDdlParseError(
            "the document declares no `CREATE TABLE`, `CREATE VIEW`, `CREATE TYPE` or "
            "`ALTER TABLE` statement, so it is not a SQL DDL script",
            code=_refusal_code(raw),
        )
    detection = detect_dialect(raw, override=override)
    catalog = _new_catalog(detection, source_label=source_label, raw=raw)
    _read_script(catalog, raw, source_label=source_label)
    return _finish(catalog, source_label=source_label)


def parse_sql_ddl_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
    dialect: Optional[str] = None,
) -> SqlCatalog:
    """Read a directory of DDL scripts — a migrations series — into its final state.

    Members are applied in **path order**, which is the ordering every migration convention
    already encodes in its filenames (``V1__``/``V2__``, ``001_``/``002_``,
    ``20240115_``). The root names the set and is applied in its place in that order rather
    than first, because a migration series is a sequence and pulling one file out of it
    would change the state the others build on.

    Args:
        members: Every member of the set, keyed by relative path.
        root: The member the set is rooted at.
        source_label: Fallback label when the set names no root.
        dialect: A forced dialect; detection otherwise reads the whole set at once, so one
            member with no vendor marker is still read as the dialect its siblings declare.

    Returns:
        The composed catalog.

    Raises:
        SqlDdlParseError: With this reader's taxonomy code; see the module docstring.
    """
    ordered = [path for path in sorted(members) if _is_ddl_member(path, members[path])]
    if not ordered:
        raise SqlDdlParseError(
            "no member of the file set declares a `CREATE TABLE`, `CREATE VIEW`, "
            "`CREATE TYPE` or `ALTER TABLE` statement, so the set is not SQL DDL",
            code=_refusal_code("\n".join(members.values())),
        )
    combined = "\n".join(members[path] for path in ordered)
    total = sum(len(text.encode("utf-8", errors="ignore")) for text in members.values())
    if total > MAX_SQL_BYTES:
        raise SqlDdlParseError(
            f"the file set is larger than the {MAX_SQL_BYTES}-byte DDL ceiling",
            code="INPUT_TOO_LARGE",
        )
    try:
        override = normalize_dialect(dialect)
    except ValueError as exc:
        raise SqlDdlParseError(str(exc), code="INPUT_SEMANTIC_INVALID") from exc
    detection = detect_dialect(combined, override=override)
    label = source_label or root
    catalog = _new_catalog(detection, source_label=label, raw=combined)
    for path in ordered:
        _read_script(catalog, members[path], source_label=path)
    catalog.fileset = snapshot_fileset(members, root=root, applied=ordered)
    return _finish(catalog, source_label=label)


def _is_ddl_member(path: str, text: str) -> bool:
    """Whether one file-set member carries statements this reader should apply.

    Args:
        path: The member's relative path.
        text: Its content.

    Returns:
        ``True`` for a member with a DDL statement in it. A README, a seed-data ``INSERT``
        script or a rollback note beside the migrations contributes nothing and is recorded
        as skipped rather than parsed.
    """
    _ = path
    return is_sql_ddl(text)


def _new_catalog(
    detection: "DialectDetection", *, source_label: Optional[str], raw: str
) -> SqlCatalog:
    """Build an empty catalog carrying the resolved dialect and its evidence."""
    return SqlCatalog(
        dialect=detection.dialect,
        dialect_source=detection.source,
        dialect_evidence=detection.evidence,
        source_label=source_label,
        raw=raw,
    )
