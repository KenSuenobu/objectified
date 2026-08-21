"""Avro IDL (``.avdl``) parser — FMT-3.5 (#5430).

Apache Avro has two surfaces. ``.avsc`` is the *generated* JSON schema; ``.avdl`` — Avro
IDL — is the C-like source humans actually author, and it carries three things the JSON
artifact cannot: doc comments, protocol grouping, and RPC ``message`` declarations.

This module reads the IDL half and produces **the same native AST the ``.avsc`` path
produces** — an :class:`~app.avro_parser.AvroDocument` whose ``types`` are ordinary Avro
schema dicts — plus the protocol/message layer the JSON form has no room for
(:class:`AvroProtocol`). Everything downstream (normalizer, lint, diff, emit) therefore
sees one shape and never learns which surface produced it, except where the protocol
layer is genuinely present.

Two document forms are accepted, matching the specification:

* a **protocol**: an optional doc comment and annotations, then
  ``protocol Name { … }`` holding named types and messages;
* a **schema-only** file: ``namespace a.b;`` followed by bare declarations, which is what
  Avro 1.11.1 added so an IDL file can define types without inventing a protocol.

The distinction is load-bearing rather than cosmetic: a protocol *with messages*
normalizes to ``rpc``-paradigm operations, and a schema-only file stays ``data_schema``.

Imports (``import idl``/``import schema``/``import protocol``) are resolved against the
members of a multi-file set. A named import that the set does not contain is an
``INPUT_REFERENCE_UNRESOLVED`` failure rather than a silently dangling type reference.

Detection (:func:`is_avro_idl`) is a text sniff and never parses: it runs on hostile
input and must not raise.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .avro_parser import AvroDocument, AvroNamedSchema, AvroParseError, parse_avro

__all__ = [
    "AvroIdlParseError",
    "AvroIdlMessage",
    "AvroIdlParameter",
    "AvroProtocol",
    "IDL_SYNTAX",
    "is_avro_idl",
    "parse_avro_idl",
]

#: Value of :attr:`app.avro_parser.AvroDocument.syntax` for a document read from IDL.
IDL_SYNTAX = "avdl"

#: Avro primitive type names, spelled the same in IDL and in ``.avsc``.
_PRIMITIVES = frozenset(
    {"null", "boolean", "int", "long", "float", "double", "bytes", "string"}
)

#: IDL logical-type keywords → the ``(base, logicalType)`` pair they compile to.
#: ``decimal`` is handled separately because it takes ``(precision, scale)``.
_LOGICAL_KEYWORDS: Dict[str, Tuple[str, str]] = {
    "date": ("int", "date"),
    "time_ms": ("int", "time-millis"),
    "timestamp_ms": ("long", "timestamp-millis"),
    "local_timestamp_ms": ("long", "local-timestamp-millis"),
    "uuid": ("string", "uuid"),
}

#: Declaration keywords that introduce a named type.
_TYPE_KEYWORDS = frozenset({"record", "error", "enum", "fixed"})

#: Annotations that configure the *field* rather than its type.
_FIELD_ANNOTATIONS = frozenset({"order", "aliases"})

#: Annotations that configure a named *type declaration* rather than a use site.
_TYPE_DECL_ANNOTATIONS = frozenset({"namespace", "aliases"})

#: The import forms the specification defines.
_IMPORT_KINDS = frozenset({"idl", "schema", "protocol"})

#: How deeply a type expression or a JSON literal may nest. Both are read by recursive
#: descent, so an adversarial document of ``array<array<array<…>>>`` would otherwise
#: exhaust the interpreter stack with a ``RecursionError`` the import pipeline does not
#: catch. No hand-authored schema comes near this.
_MAX_NESTING_DEPTH = 64

_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER_RE = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

#: A ``protocol Name {`` declaration — the strongest IDL marker there is.
_PROTOCOL_MARKER_RE = re.compile(r"(?m)^\s*(?:@[^\n]*\n\s*)*protocol\s+`?[A-Za-z_]\w*`?\s*\{")

#: A schema-only file's ``namespace a.b.c;`` statement: exactly one dotted token, then ``;``.
#: Thrift's ``namespace java com.example`` has two tokens and does not match.
_NAMESPACE_MARKER_RE = re.compile(r"(?m)^\s*namespace\s+[A-Za-z_][A-Za-z0-9_.]*\s*;")

#: A bare named-type declaration, used to corroborate the ``namespace`` marker.
_DECLARATION_MARKER_RE = re.compile(
    r"(?m)^\s*(?:@[^\n]*\n\s*)*(?:record|error|enum|fixed)\s+`?[A-Za-z_]\w*`?\s*[\{(]"
)


class AvroIdlParseError(AvroParseError):
    """Raised when Avro IDL text cannot be parsed.

    Subclasses :class:`~app.avro_parser.AvroParseError` so the Avro adapter's existing
    ``except AvroParseError`` seam keeps working for both surfaces.

    Args:
        message: Human-readable description of the defect.
        code: Optional :mod:`app.intake_error_taxonomy` code the pipeline should report
            instead of the default ``INPUT_MALFORMED`` (see
            ``app.import_source_pipeline._classify_parse_failure``).
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AvroIdlParameter:
    """One positional parameter of an IDL ``message`` declaration.

    Attributes:
        name: The parameter name as written.
        type: The parameter's Avro schema expression (the same shape a ``.avsc``
            field's ``type`` carries: a string, a dict, or a union list).
        default: The declared default value, or ``None`` when there is none.
        has_default: Whether a default was declared at all — distinguishes an absent
            default from an explicit ``= null``.
    """

    name: str
    type: Any
    default: Any = None
    has_default: bool = False


@dataclass(frozen=True)
class AvroIdlMessage:
    """One RPC ``message`` declaration inside an Avro protocol.

    Attributes:
        name: The message (operation) name.
        doc: The doc comment attached to the declaration, already cleaned.
        request: The declared parameters, in source order.
        response: The response schema expression; ``"null"`` for a ``void`` message.
        errors: Fully-resolved names of the error types the message ``throws``.
        oneway: Whether the message is declared ``oneway`` (fire-and-forget).
        properties: Any annotations that are not part of the message grammar,
            preserved verbatim so the emitter can write them back.
    """

    name: str
    doc: Optional[str] = None
    request: Tuple[AvroIdlParameter, ...] = ()
    response: Any = "null"
    errors: Tuple[str, ...] = ()
    oneway: bool = False
    properties: Mapping[str, Any] = dataclass_field(default_factory=dict)


@dataclass(frozen=True)
class AvroProtocol:
    """The protocol layer of an IDL document — what ``.avsc`` has no room for.

    Attributes:
        name: The protocol name.
        namespace: The protocol namespace (from ``@namespace`` or a ``namespace``
            statement), or ``None``.
        doc: The protocol's doc comment.
        messages: Its RPC message declarations, in source order.
        properties: Annotations beyond ``@namespace`` (for example ``@version``),
            preserved verbatim.
    """

    name: str
    namespace: Optional[str] = None
    doc: Optional[str] = None
    messages: Tuple[AvroIdlMessage, ...] = ()
    properties: Mapping[str, Any] = dataclass_field(default_factory=dict)


def is_avro_idl(content: str) -> bool:
    """Return ``True`` when ``content`` looks like Avro IDL source.

    A text-only sniff, deliberately never parsing: detection runs on hostile input and
    must not raise. Two markers are accepted — a ``protocol Name {`` declaration, or a
    schema-only file's ``namespace a.b;`` statement corroborated by at least one
    ``record``/``error``/``enum``/``fixed`` declaration. Requiring the corroboration is
    what keeps the sniff from claiming every language with a ``namespace`` statement.

    Args:
        content: The candidate document text.

    Returns:
        ``True`` when the text carries an Avro IDL marker.
    """
    if not content or not isinstance(content, str) or not content.strip():
        return False
    if _PROTOCOL_MARKER_RE.search(content):
        return True
    return bool(
        _NAMESPACE_MARKER_RE.search(content) and _DECLARATION_MARKER_RE.search(content)
    )


def parse_avro_idl(
    content: str,
    *,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, str]] = None,
) -> AvroDocument:
    """Parse Avro IDL text into an :class:`~app.avro_parser.AvroDocument`.

    Args:
        content: The ``.avdl`` source.
        source_label: Label used in error messages (usually the filename); also the
            base against which relative imports are resolved.
        members: The other documents of a multi-file set, keyed as the fileset keys
            them, so ``import idl``/``import schema``/``import protocol`` resolve.

    Returns:
        The parsed document: ``types`` are ordinary Avro schema dicts, ``protocol``
        carries the RPC layer when the source declared one, and ``syntax`` is
        :data:`IDL_SYNTAX`.

    Raises:
        AvroIdlParseError: When the text is empty, syntactically invalid, truncated,
            semantically invalid, or names an import the set does not contain. The
            error carries the matching taxonomy ``code`` whenever it can name one.
    """
    if not content or not content.strip():
        raise AvroIdlParseError("Invalid or empty Avro IDL document")
    parser = _IdlParser(content, source_label=source_label, members=members or {})
    return parser.parse()


# --- lexer ------------------------------------------------------------------------


@dataclass(frozen=True)
class _Token:
    """One lexical token, with the source offset used for error messages."""

    kind: str  # "ident" | "string" | "number" | "punct" | "doc" | "eof"
    value: Any
    offset: int
    escaped: bool = False


def _clean_doc(raw: str) -> Optional[str]:
    """Normalize a ``/** … */`` doc comment body the way the IDL compiler does.

    Strips the comment delimiters, the leading ``*`` of continuation lines, and the
    common indentation, then trims blank edges.

    Args:
        raw: The full comment text including its delimiters.

    Returns:
        The cleaned doc string, or ``None`` when nothing but whitespace remains.
    """
    body = raw[3:-2] if raw.endswith("*/") else raw[3:]
    lines: List[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("*"):
            stripped = stripped[1:].strip()
        lines.append(stripped)
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    text = "\n".join(lines).strip()
    return text or None


def _tokenize(content: str) -> List[_Token]:
    """Split IDL source into tokens, keeping doc comments and dropping other comments.

    Args:
        content: The ``.avdl`` source.

    Returns:
        The token list, terminated by an ``eof`` token.

    Raises:
        AvroIdlParseError: On an unterminated string or block comment — both of which
            mean the document was cut short, so they carry ``INPUT_TRUNCATED``.
    """
    tokens: List[_Token] = []
    index = 0
    length = len(content)
    while index < length:
        char = content[index]
        if char in " \t\r\n\f\v":
            index += 1
            continue
        if content.startswith("//", index):
            end = content.find("\n", index)
            index = length if end == -1 else end + 1
            continue
        if content.startswith("/*", index):
            end = content.find("*/", index + 2)
            if end == -1:
                raise AvroIdlParseError(
                    "Unterminated block comment: the document ends inside a comment",
                    code="INPUT_TRUNCATED",
                )
            if content.startswith("/**", index):
                tokens.append(_Token("doc", _clean_doc(content[index : end + 2]), index))
            index = end + 2
            continue
        if char == '"':
            literal, next_index = _read_string(content, index)
            tokens.append(_Token("string", literal, index))
            index = next_index
            continue
        if char == "`":
            end = content.find("`", index + 1)
            if end == -1:
                raise AvroIdlParseError(
                    "Unterminated escaped identifier: the document ends inside a backtick",
                    code="INPUT_TRUNCATED",
                )
            tokens.append(_Token("ident", content[index + 1 : end], index, escaped=True))
            index = end + 1
            continue
        match = _IDENT_RE.match(content, index)
        if match:
            tokens.append(_Token("ident", match.group(0), index))
            index = match.end()
            continue
        number = _NUMBER_RE.match(content, index)
        if number and (char.isdigit() or (char == "-" and number.end() > index + 1)):
            raw = number.group(0)
            numeric: Any = float(raw) if any(c in raw for c in ".eE") else int(raw)
            tokens.append(_Token("number", numeric, index))
            index = number.end()
            continue
        tokens.append(_Token("punct", char, index))
        index += 1
    tokens.append(_Token("eof", None, length))
    return tokens


def _read_string(content: str, start: int) -> Tuple[str, int]:
    """Read a double-quoted string literal starting at ``start``.

    Args:
        content: The source text.
        start: Offset of the opening quote.

    Returns:
        A ``(value, next_index)`` pair.

    Raises:
        AvroIdlParseError: When the literal is never closed (``INPUT_TRUNCATED``).
    """
    index = start + 1
    out: List[str] = []
    escapes = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", '"': '"', "\\": "\\", "/": "/"}
    while index < len(content):
        char = content[index]
        if char == "\\":
            if index + 1 >= len(content):
                break
            nxt = content[index + 1]
            if nxt == "u" and index + 6 <= len(content):
                try:
                    out.append(chr(int(content[index + 2 : index + 6], 16)))
                except ValueError:
                    out.append(nxt)
                index += 6
                continue
            out.append(escapes.get(nxt, nxt))
            index += 2
            continue
        if char == '"':
            return "".join(out), index + 1
        out.append(char)
        index += 1
    raise AvroIdlParseError(
        "Unterminated string literal: the document ends inside a string",
        code="INPUT_TRUNCATED",
    )


# --- parser -----------------------------------------------------------------------


class _IdlParser:
    """Recursive-descent parser over the token stream of one IDL document.

    One instance parses one document; imported documents get their own instance, whose
    named types are merged into this one's (an import contributes types, not messages).
    """

    def __init__(
        self,
        content: str,
        *,
        source_label: Optional[str],
        members: Mapping[str, str],
        importing: Optional[Sequence[str]] = None,
    ) -> None:
        self._content = content
        self._label = source_label
        self._members = members
        # The document's own name seeds the import chain, so a file that (directly or
        # transitively) imports itself stops instead of recursing.
        self._importing = tuple(importing or ()) or (
            (source_label.rsplit("/", 1)[-1],) if source_label else ()
        )
        self._tokens = _tokenize(content)
        self._pos = 0
        self._namespace: Optional[str] = None
        #: Qualified name → schema dict, in declaration order. Holds both this
        #: document's own declarations and the ones its imports contribute.
        self._types: Dict[str, Dict[str, Any]] = {}
        #: Qualified names *this* document declares. Duplicate-declaration detection
        #: reads this rather than ``_types``, because re-importing a type through two
        #: paths is legal — declaring it twice in one file is not.
        self._declared: set[str] = set()
        self._first_declared: Optional[str] = None
        self._doc: Optional[str] = None
        self._depth = 0

    # --- token helpers ---

    def _peek(self, ahead: int = 0) -> _Token:
        return self._tokens[min(self._pos + ahead, len(self._tokens) - 1)]

    def _next(self) -> _Token:
        token = self._peek()
        if token.kind != "eof":
            self._pos += 1
        return token

    def _at_keyword(self, word: str, ahead: int = 0) -> bool:
        token = self._peek(ahead)
        return token.kind == "ident" and not token.escaped and token.value == word

    def _at_punct(self, char: str, ahead: int = 0) -> bool:
        token = self._peek(ahead)
        return token.kind == "punct" and token.value == char

    def _accept_punct(self, char: str) -> bool:
        if self._at_punct(char):
            self._pos += 1
            return True
        return False

    def _expect_punct(self, char: str) -> None:
        if not self._accept_punct(char):
            self._fail(f"expected {char!r}")

    def _expect_ident(self, what: str) -> str:
        token = self._peek()
        if token.kind != "ident":
            self._fail(f"expected {what}")
        self._pos += 1
        return str(token.value)

    def _fail(self, expectation: str) -> None:
        """Raise a positioned syntax error, tagged truncated when it is at EOF."""
        token = self._peek()
        where = self._position(token.offset)
        label = f" in {self._label}" if self._label else ""
        if token.kind == "eof":
            raise AvroIdlParseError(
                f"Unexpected end of Avro IDL document{label}: {expectation}",
                code="INPUT_TRUNCATED",
            )
        found = token.value if token.kind != "eof" else "end of file"
        raise AvroIdlParseError(
            f"Invalid Avro IDL{label} at {where}: {expectation}, found {found!r}"
        )

    def _position(self, offset: int) -> str:
        line = self._content.count("\n", 0, offset) + 1
        column = offset - (self._content.rfind("\n", 0, offset) + 1) + 1
        return f"line {line}, column {column}"

    # --- document ---

    def parse(self) -> AvroDocument:
        """Parse the whole document and return its :class:`AvroDocument`."""
        doc, annotations = self._leading()
        if self._at_keyword("protocol"):
            protocol = self._parse_protocol(doc, annotations)
        else:
            protocol = None
            self._doc = doc
            self._apply_file_annotations(annotations)
            stray = self._parse_declarations(terminator=None)
            if stray:
                # A schema-only file has no protocol to hang an RPC message on. Dropping
                # one silently would lose an operation the author wrote down.
                raise AvroIdlParseError(
                    f"Avro IDL message {stray[0].name!r} is declared outside a protocol",
                    code="INPUT_SEMANTIC_INVALID",
                )
        return self._build(protocol)

    def _build(self, protocol: Optional[AvroProtocol]) -> AvroDocument:
        """Assemble the parsed declarations into the shared native AST."""
        if not self._types:
            label = f" ({self._label})" if self._label else ""
            raise AvroIdlParseError(
                f"No Avro named types found{label}",
                code="INPUT_SEMANTIC_INVALID",
            )
        named = tuple(
            AvroNamedSchema(
                name=qualified.rsplit(".", 1)[-1],
                namespace=qualified.rsplit(".", 1)[0] if "." in qualified else None,
                schema=schema,
            )
            for qualified, schema in sorted(self._types.items())
        )
        root_qualified = self._first_declared or sorted(self._types)[0]
        root = next(
            (
                entry
                for entry in named
                if _qualified(entry.name, entry.namespace) == root_qualified
            ),
            named[0],
        )
        return AvroDocument(
            root=root,
            types=named,
            raw=self._content,
            protocol=protocol,
            doc=self._doc,
            syntax=IDL_SYNTAX,
        )

    def _leading(self) -> Tuple[Optional[str], Dict[str, Any]]:
        """Consume the doc comment and annotations preceding a declaration."""
        doc: Optional[str] = None
        while self._peek().kind == "doc":
            doc = self._next().value
        annotations = self._parse_annotations()
        while self._peek().kind == "doc":
            doc = self._next().value
        return doc, annotations

    def _parse_annotations(self) -> Dict[str, Any]:
        """Parse a run of ``@name(json)`` annotations into a property mapping."""
        annotations: Dict[str, Any] = {}
        while self._at_punct("@"):
            self._pos += 1
            name = self._expect_ident("an annotation name")
            value: Any = True
            if self._accept_punct("("):
                value = self._parse_json_value()
                self._expect_punct(")")
            annotations[name] = value
        return annotations

    def _apply_file_annotations(self, annotations: Mapping[str, Any]) -> None:
        """Apply a schema-only file's leading annotations (only ``@namespace`` acts)."""
        namespace = annotations.get("namespace")
        if isinstance(namespace, str) and namespace.strip():
            self._namespace = namespace.strip()

    # --- protocol ---

    def _parse_protocol(
        self, doc: Optional[str], annotations: Mapping[str, Any]
    ) -> AvroProtocol:
        """Parse ``protocol Name { … }`` and everything it declares."""
        self._pos += 1  # 'protocol'
        name = self._expect_ident("a protocol name")
        namespace = annotations.get("namespace")
        if isinstance(namespace, str) and namespace.strip():
            self._namespace = namespace.strip()
        self._expect_punct("{")
        messages = self._parse_declarations(terminator="}")
        self._expect_punct("}")
        properties = {
            key: value for key, value in annotations.items() if key != "namespace"
        }
        return AvroProtocol(
            name=name,
            namespace=self._namespace,
            doc=doc,
            messages=tuple(messages),
            properties=properties,
        )

    def _parse_declarations(self, *, terminator: Optional[str]) -> List[AvroIdlMessage]:
        """Parse declarations until ``terminator`` (or EOF), returning any messages.

        Args:
            terminator: The punctuation that closes the enclosing block, or ``None``
                to read to end of file (the schema-only form).

        Returns:
            The message declarations encountered, in source order.
        """
        messages: List[AvroIdlMessage] = []
        while True:
            if terminator is None:
                if self._peek().kind == "eof":
                    return messages
            elif self._at_punct(terminator):
                return messages
            doc, annotations = self._leading()
            if terminator is None and self._peek().kind == "eof":
                return messages
            if self._at_keyword("namespace"):
                self._parse_namespace_statement()
                if self._doc is None:
                    self._doc = doc
                continue
            if self._at_keyword("import"):
                self._parse_import()
                continue
            keyword = self._peek()
            if keyword.kind == "ident" and not keyword.escaped and keyword.value in _TYPE_KEYWORDS:
                self._parse_named_type(str(keyword.value), doc, annotations)
                continue
            messages.append(self._parse_message(doc, annotations))

    def _parse_namespace_statement(self) -> None:
        """Parse ``namespace a.b.c;``, which sets the enclosing namespace."""
        self._pos += 1  # 'namespace'
        parts = [self._expect_ident("a namespace segment")]
        while self._accept_punct("."):
            parts.append(self._expect_ident("a namespace segment"))
        self._expect_punct(";")
        self._namespace = ".".join(parts)

    # --- imports ---

    def _parse_import(self) -> None:
        """Parse ``import idl|schema|protocol "path";`` and merge what it declares."""
        self._pos += 1  # 'import'
        kind_token = self._peek()
        if kind_token.kind != "ident" or kind_token.value not in _IMPORT_KINDS:
            self._fail("expected `idl`, `schema`, or `protocol` after `import`")
        kind = str(self._next().value)
        path_token = self._next()
        if path_token.kind != "string":
            self._fail("expected a quoted import path")
        self._expect_punct(";")
        self._merge_import(kind, str(path_token.value))

    def _resolve_member(self, path: str) -> str:
        """Return the text of a set member named by an import, or fail.

        Members are keyed by the fileset; a relative path is matched on its own
        basename as well, so ``import idl "common.avdl"`` resolves whether the set
        keys members flat or by directory.

        Args:
            path: The quoted import path as written.

        Raises:
            AvroIdlParseError: When no member matches (``INPUT_REFERENCE_UNRESOLVED``).
        """
        candidates = [path, path.lstrip("./"), path.rsplit("/", 1)[-1]]
        for candidate in candidates:
            if candidate in self._members:
                return self._members[candidate]
        for key, text in self._members.items():
            if key.rsplit("/", 1)[-1] == path.rsplit("/", 1)[-1]:
                return text
        raise AvroIdlParseError(
            f"Unresolved Avro IDL import {path!r}: the file is not part of this import set",
            code="INPUT_REFERENCE_UNRESOLVED",
        )

    def _merge_import(self, kind: str, path: str) -> None:
        """Resolve one import and merge the named types it contributes."""
        if path in self._importing:
            return  # already being read further up the chain; stop the cycle
        text = self._resolve_member(path)
        if kind == "idl":
            nested = _IdlParser(
                text,
                source_label=path,
                members=self._members,
                importing=self._importing + (path,),
            )
            nested_doc = nested.parse()
            for named in nested_doc.types:
                self._types.setdefault(_qualified(named.name, named.namespace), named.schema)
            return
        if kind == "schema":
            try:
                imported = parse_avro(text, source_label=path)
            except AvroParseError as exc:
                raise AvroIdlParseError(
                    f"Avro IDL import {path!r} is not a readable Avro schema: {exc}"
                ) from exc
            for named in imported.types:
                self._types.setdefault(_qualified(named.name, named.namespace), named.schema)
            return
        self._merge_protocol_import(path, text)

    def _merge_protocol_import(self, path: str, text: str) -> None:
        """Merge the ``types`` of an imported ``.avpr`` protocol JSON document."""
        try:
            document = json.loads(text)
        except ValueError as exc:
            raise AvroIdlParseError(
                f"Avro IDL import {path!r} is not readable Avro protocol JSON: {exc}"
            ) from exc
        if not isinstance(document, dict):
            raise AvroIdlParseError(
                f"Avro IDL import {path!r} is not an Avro protocol object"
            )
        namespace = document.get("namespace")
        for schema in document.get("types") or []:
            if not isinstance(schema, dict):
                continue
            name = schema.get("name")
            if not isinstance(name, str) or not name:
                continue
            schema_namespace = schema.get("namespace") or namespace
            self._types.setdefault(_qualified(name, schema_namespace), schema)

    # --- named types ---

    def _parse_named_type(
        self, keyword: str, doc: Optional[str], annotations: Mapping[str, Any]
    ) -> None:
        """Parse one ``record``/``error``/``enum``/``fixed`` declaration."""
        self._pos += 1  # the keyword
        name = self._expect_ident(f"a {keyword} name")
        namespace = annotations.get("namespace")
        namespace = namespace.strip() if isinstance(namespace, str) and namespace.strip() else self._namespace
        schema: Dict[str, Any] = {"type": keyword, "name": name}
        if namespace:
            schema["namespace"] = namespace
        if doc:
            schema["doc"] = doc
        aliases = annotations.get("aliases")
        if isinstance(aliases, list) and aliases:
            schema["aliases"] = aliases
        for key, value in annotations.items():
            if key not in _TYPE_DECL_ANNOTATIONS:
                schema[key] = value

        if keyword == "fixed":
            self._expect_punct("(")
            size = self._next()
            if size.kind != "number" or not isinstance(size.value, int):
                self._fail("expected a fixed size")
            schema["size"] = size.value
            self._expect_punct(")")
            self._accept_punct(";")
        elif keyword == "enum":
            schema["symbols"] = self._parse_enum_symbols()
            if self._accept_punct("="):
                schema["default"] = self._expect_ident("an enum default symbol")
            self._accept_punct(";")
        else:
            schema["fields"] = self._parse_record_fields()
            self._accept_punct(";")

        qualified = _qualified(name, namespace)
        if qualified in self._declared:
            raise AvroIdlParseError(
                f"Duplicate Avro type declaration {qualified!r}",
                code="INPUT_SEMANTIC_INVALID",
            )
        self._declared.add(qualified)
        self._types[qualified] = schema
        if self._first_declared is None:
            self._first_declared = qualified

    def _parse_enum_symbols(self) -> List[str]:
        """Parse ``{ A, B, C }`` into its symbol list."""
        self._expect_punct("{")
        symbols: List[str] = []
        if not self._at_punct("}"):
            symbols.append(self._expect_ident("an enum symbol"))
            while self._accept_punct(","):
                if self._at_punct("}"):
                    break
                symbols.append(self._expect_ident("an enum symbol"))
        self._expect_punct("}")
        if not symbols:
            raise AvroIdlParseError(
                "Avro enum declares no symbols", code="INPUT_SEMANTIC_INVALID"
            )
        return symbols

    def _parse_record_fields(self) -> List[Dict[str, Any]]:
        """Parse ``{ Type name [= default]; … }`` into ``.avsc`` field dicts."""
        self._expect_punct("{")
        fields: List[Dict[str, Any]] = []
        seen: set[str] = set()
        while not self._at_punct("}"):
            if self._peek().kind == "eof":
                self._fail("expected a field declaration or `}`")
            doc, annotations = self._leading()
            type_annotations = {
                key: value
                for key, value in annotations.items()
                if key not in _FIELD_ANNOTATIONS
            }
            field_type = self._parse_type(type_annotations)
            name = self._expect_ident("a field name")
            entry: Dict[str, Any] = {"name": name, "type": field_type}
            if self._accept_punct("="):
                entry["default"] = self._parse_json_value()
            if doc:
                entry["doc"] = doc
            order = annotations.get("order")
            if isinstance(order, str):
                entry["order"] = order
            aliases = annotations.get("aliases")
            if isinstance(aliases, list) and aliases:
                entry["aliases"] = aliases
            self._expect_punct(";")
            if name in seen:
                raise AvroIdlParseError(
                    f"Duplicate field {name!r} in Avro record",
                    code="INPUT_SEMANTIC_INVALID",
                )
            seen.add(name)
            fields.append(entry)
        self._expect_punct("}")
        return fields

    # --- messages ---

    def _parse_message(
        self, doc: Optional[str], annotations: Mapping[str, Any]
    ) -> AvroIdlMessage:
        """Parse ``ResultType name(params) [oneway] [throws E, …];``."""
        if self._at_keyword("void"):
            self._pos += 1
            response: Any = "null"
        else:
            response = self._parse_type({})
        name = self._expect_ident("a message name")
        self._expect_punct("(")
        parameters: List[AvroIdlParameter] = []
        while not self._at_punct(")"):
            if self._peek().kind == "eof":
                self._fail("expected a parameter or `)`")
            _, param_annotations = self._leading()
            param_type = self._parse_type(
                {k: v for k, v in param_annotations.items() if k not in _FIELD_ANNOTATIONS}
            )
            param_name = self._expect_ident("a parameter name")
            has_default = self._accept_punct("=")
            default = self._parse_json_value() if has_default else None
            parameters.append(
                AvroIdlParameter(
                    name=param_name,
                    type=param_type,
                    default=default,
                    has_default=has_default,
                )
            )
            if not self._accept_punct(","):
                break
        self._expect_punct(")")
        oneway = False
        errors: List[str] = []
        while True:
            if self._at_keyword("oneway"):
                self._pos += 1
                oneway = True
                continue
            if self._at_keyword("throws"):
                self._pos += 1
                errors.append(self._parse_qualified_name())
                while self._accept_punct(","):
                    errors.append(self._parse_qualified_name())
                continue
            break
        self._expect_punct(";")
        return AvroIdlMessage(
            name=name,
            doc=doc,
            request=tuple(parameters),
            response=response,
            errors=tuple(errors),
            oneway=oneway,
            properties=dict(annotations),
        )

    # --- type expressions ---

    def _parse_qualified_name(self) -> str:
        """Parse a possibly dotted type name (``a.b.Name``)."""
        parts = [self._expect_ident("a type name")]
        while self._at_punct(".") and self._peek(1).kind == "ident":
            self._pos += 1
            parts.append(self._expect_ident("a type name segment"))
        return ".".join(parts)

    def _enter(self) -> None:
        """Record one level of recursive descent, refusing pathological nesting."""
        self._depth += 1
        if self._depth > _MAX_NESTING_DEPTH:
            raise AvroIdlParseError(
                f"Avro IDL nests more than {_MAX_NESTING_DEPTH} levels deep",
                code="INPUT_DEPTH_LIMIT",
            )

    def _parse_type(self, annotations: Mapping[str, Any]) -> Any:
        """Parse one type expression, applying any annotations that precede it.

        Args:
            annotations: Annotations written before the type (``@logicalType`` and any
                non-grammar properties); ``order``/``aliases`` are filtered out by the
                caller because they configure the field, not the type.

        Returns:
            An Avro schema expression: a primitive name, a schema dict, or a union list.
        """
        self._enter()
        try:
            base = self._parse_base_type()
            while self._accept_punct("?"):
                base = _nullable(base)
        finally:
            self._depth -= 1
        if not annotations:
            return base
        return _apply_type_annotations(base, annotations)

    def _parse_base_type(self) -> Any:
        """Parse a type expression without trailing ``?`` or leading annotations."""
        if self._at_punct("@"):
            annotations = self._parse_annotations()
            return _apply_type_annotations(self._parse_base_type(), annotations)
        token = self._peek()
        if token.kind != "ident":
            self._fail("expected a type")
        word = str(token.value)
        if not token.escaped:
            if word == "array":
                self._pos += 1
                self._expect_punct("<")
                items = self._parse_type({})
                self._expect_punct(">")
                return {"type": "array", "items": items}
            if word == "map":
                self._pos += 1
                self._expect_punct("<")
                values = self._parse_type({})
                self._expect_punct(">")
                return {"type": "map", "values": values}
            if word == "union":
                self._pos += 1
                return self._parse_union()
            if word == "decimal":
                self._pos += 1
                return self._parse_decimal()
            if word in _LOGICAL_KEYWORDS:
                self._pos += 1
                base, logical = _LOGICAL_KEYWORDS[word]
                return {"type": base, "logicalType": logical}
            if word in _PRIMITIVES:
                self._pos += 1
                return word
        return self._parse_qualified_name()

    def _parse_union(self) -> List[Any]:
        """Parse ``union { A, B, … }`` into an Avro union list."""
        self._expect_punct("{")
        branches: List[Any] = []
        while not self._at_punct("}"):
            if self._peek().kind == "eof":
                self._fail("expected a union branch or `}`")
            branches.append(self._parse_type({}))
            if not self._accept_punct(","):
                break
        self._expect_punct("}")
        if not branches:
            raise AvroIdlParseError(
                "Avro union declares no branches", code="INPUT_SEMANTIC_INVALID"
            )
        _reject_duplicate_union_branches(branches)
        return branches

    def _parse_decimal(self) -> Dict[str, Any]:
        """Parse ``decimal(precision, scale)`` into its logical-type schema."""
        self._expect_punct("(")
        precision = self._next()
        if precision.kind != "number" or not isinstance(precision.value, int):
            self._fail("expected a decimal precision")
        self._expect_punct(",")
        scale = self._next()
        if scale.kind != "number" or not isinstance(scale.value, int):
            self._fail("expected a decimal scale")
        self._expect_punct(")")
        return {
            "type": "bytes",
            "logicalType": "decimal",
            "precision": precision.value,
            "scale": scale.value,
        }

    # --- JSON values (defaults and annotation arguments) ---

    def _parse_json_value(self) -> Any:
        """Parse a JSON literal (default value or annotation argument)."""
        self._enter()
        try:
            return self._parse_json_value_inner()
        finally:
            self._depth -= 1

    def _parse_json_value_inner(self) -> Any:
        """Parse one JSON literal, one nesting level already accounted for."""
        token = self._peek()
        if token.kind == "string":
            self._pos += 1
            return token.value
        if token.kind == "number":
            self._pos += 1
            return token.value
        if token.kind == "ident":
            if token.value == "true":
                self._pos += 1
                return True
            if token.value == "false":
                self._pos += 1
                return False
            if token.value == "null":
                self._pos += 1
                return None
            self._pos += 1
            return str(token.value)  # an unquoted enum symbol
        if self._accept_punct("["):
            items: List[Any] = []
            while not self._at_punct("]"):
                if self._peek().kind == "eof":
                    self._fail("expected a JSON array element or `]`")
                items.append(self._parse_json_value())
                if not self._accept_punct(","):
                    break
            self._expect_punct("]")
            return items
        if self._accept_punct("{"):
            obj: Dict[str, Any] = {}
            while not self._at_punct("}"):
                if self._peek().kind == "eof":
                    self._fail("expected a JSON object member or `}`")
                key = self._next()
                if key.kind not in ("string", "ident"):
                    self._fail("expected a JSON object key")
                self._expect_punct(":")
                obj[str(key.value)] = self._parse_json_value()
                if not self._accept_punct(","):
                    break
            self._expect_punct("}")
            return obj
        self._fail("expected a JSON value")
        return None  # pragma: no cover - _fail always raises


def _apply_type_annotations(base: Any, annotations: Mapping[str, Any]) -> Any:
    """Attach annotations to a type expression, promoting a bare name to a dict.

    Args:
        base: The parsed type expression.
        annotations: The annotations written before it.

    Returns:
        The type expression carrying the annotations as schema properties. A union
        list is returned unchanged — Avro unions carry no properties of their own.
    """
    if not annotations or isinstance(base, list):
        return base
    schema: Dict[str, Any] = {"type": base} if isinstance(base, str) else dict(base)
    for key, value in annotations.items():
        schema[key] = value
    return schema


def _reject_duplicate_union_branches(branches: Sequence[Any]) -> None:
    """Reject a union that repeats an *unnamed* branch type.

    Avro forbids two branches of the same unnamed type in one union — ``union { null,
    string, string }`` has no wire representation, because the branch index could not
    be decoded back to a distinct type. Named types (records, enums, fixed) are
    compared by name, so two different records are fine.

    Args:
        branches: The parsed branch expressions.

    Raises:
        AvroIdlParseError: On a repeated branch (``INPUT_SEMANTIC_INVALID``).
    """
    seen: set[str] = set()
    for branch in branches:
        if isinstance(branch, str):
            marker = branch
        elif isinstance(branch, dict):
            inner = branch.get("type")
            logical = branch.get("logicalType")
            marker = f"{inner}:{logical}" if logical else str(inner)
        else:
            continue
        if marker in seen:
            raise AvroIdlParseError(
                f"Avro union repeats the branch type {marker!r}; a union may not "
                "declare the same unnamed type twice",
                code="INPUT_SEMANTIC_INVALID",
            )
        seen.add(marker)


def _nullable(base: Any) -> Any:
    """Return the ``T?`` shorthand's expansion: a union with a ``null`` branch.

    Args:
        base: The type expression the ``?`` was written after.

    Returns:
        ``base`` unchanged when it is already nullable, otherwise a union list with
        ``null`` first (Avro's convention, and what a ``null`` default requires).
    """
    if base == "null":
        return base
    if isinstance(base, list):
        return base if "null" in base else ["null", *base]
    return ["null", base]


def _qualified(name: str, namespace: Optional[str]) -> str:
    """Return ``namespace.name`` when a namespace is set, else ``name``."""
    return f"{namespace}.{name}" if namespace else name
