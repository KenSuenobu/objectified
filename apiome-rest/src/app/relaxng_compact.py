"""RELAX NG compact syntax (``.rnc``) reader — FMT-4.1 (#5434).

The compact syntax is not a second language: the RELAX NG specification defines it by a
purely syntactic translation into the XML syntax, so ``.rng`` and ``.rnc`` state the same
grammars. This module is the second front-end onto the shared pattern algebra in
:mod:`app.relaxng_grammar` — a tokenizer plus a recursive-descent parser that produces
exactly the AST :mod:`app.relaxng_parser` produces for the XML spelling, which is what
makes the ticket's *"both import to the same canonical model"* criterion hold by
construction rather than by two parsers being kept in step.

What it reads: the ``namespace`` / ``default namespace`` / ``datatypes`` declarations, the
``start`` and named-pattern assignments (``=``, ``|=``, ``&=``), ``div`` grouping, the
``element`` / ``attribute`` / ``list`` / ``mixed`` / ``grammar`` / ``parent`` / ``external``
patterns, the ``,`` / ``&`` / ``|`` combinators, the ``?`` / ``*`` / ``+`` repeats, datatype
names with ``{ param = "…" }`` facets and ``- except`` clauses, literal values, and the
``*`` / ``prefix:*`` name-class wildcards.

There is no network and no filesystem here: ``include`` and ``external`` record their href
and are resolved by the caller against the intake fileset, exactly as in the XML front-end.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .relaxng_grammar import (
    LimitRecorder,
    NameClassKind,
    PatternKind,
    RelaxNgComponents,
    RelaxNgInclude,
    RelaxNgNameClass,
    RelaxNgParseError,
    RelaxNgPattern,
    merged_start,
)
from .secure_xml import DEFAULT_MAX_XML_BYTES, DEFAULT_MAX_XML_DEPTH

__all__ = [
    "MAX_COMPACT_BYTES",
    "MAX_COMPACT_DEPTH",
    "read_compact_components",
    "tokenize_compact",
]

#: The compact syntax's reserved words. A name that collides with one is written ``\name``.
KEYWORDS = frozenset(
    {
        "attribute",
        "datatypes",
        "default",
        "div",
        "element",
        "empty",
        "external",
        "grammar",
        "include",
        "inherit",
        "list",
        "mixed",
        "namespace",
        "notAllowed",
        "parent",
        "start",
        "string",
        "text",
        "token",
    }
)

#: The two datatype names the compact syntax spells without a library prefix. Both come
#: from RELAX NG's built-in library, which is *not* the W3C XML Schema datatypes library.
BUILTIN_DATATYPES = frozenset({"string", "token"})

#: Multi-character operators, longest first so ``|=`` is never read as ``|`` then ``=``.
_OPERATORS = ("|=", "&=", "=", "{", "}", "(", ")", "[", "]", ",", "&", "|", "?", "*", "+", "-", "~")

_NCNAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]*")

#: How deeply a compact-syntax pattern may nest. The syntax is read by recursive descent, so
#: an adversarial ``((((((…))))))`` would otherwise exhaust the interpreter stack with a
#: ``RecursionError`` the import pipeline does not catch (IXH-1.3: adversarial input must
#: never 5xx). Matched to the hardened XML reader's element-depth cap so a grammar is bounded
#: the same way in either syntax; no hand-authored grammar comes near it.
MAX_COMPACT_DEPTH = DEFAULT_MAX_XML_DEPTH

#: UTF-8 byte ceiling for one compact-syntax document. The XML syntax gets this from
#: :func:`app.secure_xml.parse_xml`; the compact syntax has no XML parser to inherit it from,
#: so it is applied here rather than left as the one intake path with no size bound.
MAX_COMPACT_BYTES = DEFAULT_MAX_XML_BYTES


@dataclass(frozen=True)
class _Token:
    """One lexical token.

    Attributes:
        kind: ``"name"`` (an NCName or keyword), ``"cname"`` (``prefix:local``),
            ``"nsname"`` (``prefix:*``), ``"literal"`` (a quoted string), ``"doc"`` (a
            ``##`` documentation comment), or ``"op"``.
        value: The token's text, with quotes and escapes already resolved.
        line: 1-based source line, used in error messages.
    """

    kind: str
    value: str
    line: int


def tokenize_compact(text: str) -> List[_Token]:
    """Split compact-syntax source into tokens.

    Comments run from ``#`` to end of line. A ``##`` comment is a *documentation*
    annotation and is kept as a ``doc`` token; a plain ``#`` comment is discarded.

    Args:
        text: The ``.rnc`` source.

    Returns:
        The token list, in source order.

    Raises:
        RelaxNgParseError: On an unterminated string literal or a character the syntax has
            no production for.
    """
    tokens: List[_Token] = []
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
        if char == "#":
            end = text.find("\n", index)
            end = length if end == -1 else end
            if text.startswith("##", index):
                comment = text[index + 2 : end].strip()
                if comment:
                    tokens.append(_Token("doc", comment, line))
            index = end
            continue
        if char in "\"'":
            value, index = _read_literal(text, index, line)
            tokens.append(_Token("literal", value, line))
            continue
        if char == "\\":
            # A backslash escapes a name that would otherwise read as a keyword.
            match = _NCNAME.match(text, index + 1)
            if match is None:
                raise RelaxNgParseError(
                    f"line {line}: `\\` must be followed by a name", code="INPUT_MALFORMED"
                )
            tokens.append(_Token("name", match.group(0), line))
            index = match.end()
            continue
        match = _NCNAME.match(text, index)
        if match is not None:
            name = match.group(0)
            index = match.end()
            if index < length and text[index] == ":":
                if text.startswith(":*", index):
                    tokens.append(_Token("nsname", name, line))
                    index += 2
                    continue
                local = _NCNAME.match(text, index + 1)
                if local is not None:
                    tokens.append(_Token("cname", f"{name}:{local.group(0)}", line))
                    index = local.end()
                    continue
            tokens.append(_Token("name", name, line))
            continue
        for operator in _OPERATORS:
            if text.startswith(operator, index):
                tokens.append(_Token("op", operator, line))
                index += len(operator)
                break
        else:
            raise RelaxNgParseError(
                f"line {line}: unexpected character {char!r} in RELAX NG compact syntax",
                code="INPUT_MALFORMED",
            )
    return tokens


def _read_literal(text: str, index: int, line: int) -> Tuple[str, int]:
    """Read a quoted literal starting at ``index``.

    Handles both the single-quoted/double-quoted form and the triple-quoted form the
    compact syntax provides for values containing quotes.

    Args:
        text: The whole source.
        index: Offset of the opening quote.
        line: The current line, for error messages.

    Returns:
        ``(value, next_index)``.

    Raises:
        RelaxNgParseError: If the literal is never closed.
    """
    quote = text[index]
    triple = quote * 3
    if text.startswith(triple, index):
        end = text.find(triple, index + 3)
        if end == -1:
            raise RelaxNgParseError(
                f"line {line}: unterminated triple-quoted literal", code="INPUT_MALFORMED"
            )
        return text[index + 3 : end], end + 3
    end = index + 1
    while end < len(text) and text[end] != quote:
        if text[end] == "\n":
            raise RelaxNgParseError(
                f"line {line}: unterminated literal", code="INPUT_MALFORMED"
            )
        end += 1
    if end >= len(text):
        raise RelaxNgParseError(f"line {line}: unterminated literal", code="INPUT_MALFORMED")
    return text[index + 1 : end], end + 1


class _Parser:
    """Recursive-descent parser over the token stream.

    Holds the declaration environment a compact document builds up as it is read — the
    namespace prefix bindings, the default element namespace, and the datatype-library
    prefix bindings — because unlike the XML syntax (where ``ns`` and ``datatypeLibrary``
    are inherited *down the tree*) the compact syntax resolves prefixes against a single
    document-level environment.
    """

    def __init__(
        self,
        tokens: Sequence[_Token],
        *,
        source_label: Optional[str],
        limits: LimitRecorder,
    ) -> None:
        self._tokens = list(tokens)
        self._position = 0
        self._source_label = source_label
        self.namespaces: Dict[str, str] = {}
        self.default_namespace: Optional[str] = None
        self.datatype_libraries: Dict[str, str] = {}
        self.default_datatype_library: Optional[str] = None
        self.limits = limits
        self.documentation: Optional[str] = None
        #: Current recursive-descent nesting depth, bounded by :data:`MAX_COMPACT_DEPTH`.
        self._depth = 0
        #: Declarations lifted out of nested ``grammar`` patterns.
        self.nested: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
        self._location = "start"

    # -- token helpers ----------------------------------------------------

    def _peek(self, offset: int = 0) -> Optional[_Token]:
        """Return the token ``offset`` ahead of the cursor, or ``None`` past the end."""
        position = self._position + offset
        return self._tokens[position] if position < len(self._tokens) else None

    def _next(self) -> _Token:
        """Consume and return the token at the cursor.

        Raises:
            RelaxNgParseError: At end of input, which is always a truncated grammar.
        """
        token = self._peek()
        if token is None:
            raise self._error("unexpected end of grammar")
        self._position += 1
        return token

    def _at_op(self, *values: str) -> bool:
        """Whether the cursor is on one of the given punctuation tokens."""
        token = self._peek()
        return token is not None and token.kind == "op" and token.value in values

    def _at_name(self, *values: str) -> bool:
        """Whether the cursor is on one of the given name/keyword tokens."""
        token = self._peek()
        return token is not None and token.kind == "name" and token.value in values

    def _expect_op(self, value: str) -> _Token:
        """Consume the given punctuation token, or fail with what was found instead."""
        token = self._next()
        if token.kind != "op" or token.value != value:
            raise self._error(f"expected {value!r}, found {token.value!r}", token)
        return token

    def _enter(self) -> None:
        """Descend one nesting level, failing rather than recursing without bound.

        Raises:
            RelaxNgParseError: ``INPUT_DEPTH_LIMIT`` past :data:`MAX_COMPACT_DEPTH`.
        """
        self._depth += 1
        if self._depth > MAX_COMPACT_DEPTH:
            raise RelaxNgParseError(
                f"RELAX NG compact grammar nests deeper than {MAX_COMPACT_DEPTH} levels",
                code="INPUT_DEPTH_LIMIT",
            )

    def _error(self, message: str, token: Optional[_Token] = None) -> RelaxNgParseError:
        """Build a parse error naming the source line and file, ready to raise."""
        # The token just consumed, when the caller named none — never `_peek(-1)`, which
        # would index from the *end* of the stream at the very first token.
        if token is None and self._position:
            token = self._tokens[self._position - 1]
        where = f"line {token.line}: " if token else ""
        label = f" ({self._source_label})" if self._source_label else ""
        return RelaxNgParseError(f"{where}{message}{label}", code="INPUT_MALFORMED")

    def _take_doc(self) -> Optional[str]:
        """Consume and join any run of ``##`` documentation tokens at the cursor."""
        parts: List[str] = []
        while self._peek() is not None and self._peek().kind == "doc":  # type: ignore[union-attr]
            parts.append(self._next().value)
        return " ".join(parts) if parts else None

    # -- declarations -----------------------------------------------------

    def parse_declarations(self) -> None:
        """Read the leading ``namespace`` / ``default namespace`` / ``datatypes`` block."""
        while True:
            documentation = self._take_doc()
            if documentation and self.documentation is None:
                self.documentation = documentation
            if self._at_name("namespace"):
                self._next()
                prefix = self._next().value
                self._expect_op("=")
                self.namespaces[prefix] = self._literal_or_inherit()
                continue
            if self._at_name("default") and self._peek(1) and self._peek(1).value == "namespace":
                self._next()
                self._next()
                prefix: Optional[str] = None
                if not self._at_op("="):
                    prefix = self._next().value
                self._expect_op("=")
                uri = self._literal_or_inherit()
                self.default_namespace = uri or None
                if prefix:
                    self.namespaces[prefix] = uri
                continue
            if self._at_name("datatypes"):
                self._next()
                prefix = self._next().value
                self._expect_op("=")
                library = self._next().value
                self.datatype_libraries[prefix] = library
                continue
            break

    def _literal_or_inherit(self) -> str:
        """Read a namespace URI literal, or the ``inherit`` keyword's empty stand-in."""
        token = self._next()
        if token.kind == "name" and token.value == "inherit":
            return ""
        return token.value

    # -- grammar bodies ---------------------------------------------------

    def looks_like_grammar(self) -> bool:
        """Whether the body is a grammar (``start = …``) rather than a bare pattern."""
        token = self._peek()
        if token is None:
            return False
        if token.kind == "name" and token.value in ("start", "div", "include"):
            return True
        following = self._peek(1)
        return (
            token.kind == "name"
            and token.value not in KEYWORDS
            and following is not None
            and following.kind == "op"
            and following.value in ("=", "|=", "&=")
        )

    def parse_grammar_body(
        self, *, stop_at_brace: bool = False
    ) -> Tuple[
        RelaxNgPattern,
        List[Tuple[str, RelaxNgPattern, Optional[str]]],
        List[RelaxNgInclude],
    ]:
        """Read ``start`` / named-pattern / ``div`` / ``include`` components.

        Args:
            stop_at_brace: Stop at a closing ``}`` (used for ``div`` and nested
                ``grammar`` bodies) instead of at end of input.

        Returns:
            ``(start_pattern, declarations, include_directives)``. The start pattern is
            ``notAllowed`` when no ``start`` was declared.
        """
        starts: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
        declarations: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
        includes: List[RelaxNgInclude] = []
        while self._peek() is not None:
            if stop_at_brace and self._at_op("}"):
                break
            self._take_doc()
            if self._peek() is None or (stop_at_brace and self._at_op("}")):
                break
            token = self._peek()
            if token.kind == "name" and token.value == "div":
                self._next()
                self._expect_op("{")
                nested_start, nested_declarations, nested_includes = self.parse_grammar_body(
                    stop_at_brace=True
                )
                self._expect_op("}")
                if nested_start.kind is not PatternKind.NOT_ALLOWED:
                    starts.append(("start", nested_start, None))
                declarations.extend(nested_declarations)
                includes.extend(nested_includes)
                continue
            if token.kind == "name" and token.value == "include":
                self._next()
                href = self._next().value
                if self._at_name("inherit"):
                    self._next()
                    self._expect_op("=")
                    self._next()
                override_start = None
                overrides: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
                if self._at_op("{"):
                    self._next()
                    override_start, overrides, nested_includes = self.parse_grammar_body(
                        stop_at_brace=True
                    )
                    self._expect_op("}")
                    includes.extend(nested_includes)
                    if override_start.kind is PatternKind.NOT_ALLOWED:
                        override_start = None
                includes.append(
                    RelaxNgInclude(
                        href=href,
                        override_start=override_start,
                        override_declarations=tuple(overrides),
                    )
                )
                continue
            if token.kind == "name" and token.value == "start":
                self._next()
                combine = self._assign_method()
                self._location = "start"
                starts.append(("start", self.parse_pattern(), combine))
                continue
            if token.kind in ("name", "cname"):
                name = self._next().value
                combine = self._assign_method()
                self._location = name
                declarations.append((name, self.parse_pattern(), combine))
                continue
            raise self._error(f"unexpected {token.value!r} at grammar level", token)
        return merged_start(starts), declarations, includes

    def _assign_method(self) -> Optional[str]:
        """Read ``=`` / ``|=`` / ``&=`` and return the combine method it implies."""
        token = self._next()
        if token.kind != "op" or token.value not in ("=", "|=", "&="):
            raise self._error(f"expected an assignment, found {token.value!r}", token)
        if token.value == "|=":
            return "choice"
        if token.value == "&=":
            return "interleave"
        return None

    # -- patterns ---------------------------------------------------------

    def parse_pattern(self) -> RelaxNgPattern:
        """Read one pattern, including the ``|`` / ``&`` / ``,`` combinators.

        The three combinators may not be mixed without parentheses in valid RELAX NG, so
        their relative precedence never decides a well-formed grammar's meaning; they are
        given the conventional ``|`` < ``&`` < ``,`` ordering so that a document which does
        mix them still reads as something rather than failing.
        """
        return self._parse_combination(0)

    #: Combinator levels, loosest first, paired with the pattern they build.
    _COMBINATORS: Tuple[Tuple[str, PatternKind], ...] = (
        ("|", PatternKind.CHOICE),
        ("&", PatternKind.INTERLEAVE),
        (",", PatternKind.GROUP),
    )

    def _parse_combination(self, level: int) -> RelaxNgPattern:
        """Parse one precedence level of :data:`_COMBINATORS`, recursing into the next."""
        if level >= len(self._COMBINATORS):
            return self._parse_repeat()
        self._enter()
        operator, kind = self._COMBINATORS[level]
        first = self._parse_combination(level + 1)
        if not self._at_op(operator):
            self._depth -= 1
            return first
        branches = [first]
        while self._at_op(operator):
            self._next()
            branches.append(self._parse_combination(level + 1))
        if kind is PatternKind.INTERLEAVE:
            self.limits.record("relaxng.interleave", location=self._location)
        self._depth -= 1
        return RelaxNgPattern(kind=kind, children=tuple(branches))

    def _parse_repeat(self) -> RelaxNgPattern:
        """Read a primary pattern plus any trailing ``?`` / ``*`` / ``+``."""
        pattern = self._parse_primary()
        while self._at_op("?", "*", "+"):
            operator = self._next().value
            kind = {
                "?": PatternKind.OPTIONAL,
                "*": PatternKind.ZERO_OR_MORE,
                "+": PatternKind.ONE_OR_MORE,
            }[operator]
            pattern = RelaxNgPattern(kind=kind, children=(pattern,))
        return pattern

    def _parse_primary(self) -> RelaxNgPattern:
        """Read one primary pattern production."""
        documentation = self._take_doc()
        if self._at_op("["):
            # A foreign annotation block; read and discarded, like `a:*` in the XML syntax.
            self._skip_balanced("[", "]")
            documentation = documentation or self._take_doc()
        token = self._next()

        if token.kind == "op" and token.value == "(":
            pattern = self.parse_pattern()
            self._expect_op(")")
            return pattern

        if token.kind == "literal":
            return RelaxNgPattern(
                kind=PatternKind.VALUE, literal=token.value, documentation=documentation
            )

        if token.kind == "cname":
            return self._parse_datatype(token.value, documentation=documentation)

        if token.kind != "name":
            raise self._error(f"unexpected {token.value!r} where a pattern was expected", token)

        keyword = token.value
        if keyword in ("element", "attribute"):
            kind = PatternKind.ELEMENT if keyword == "element" else PatternKind.ATTRIBUTE
            name_class = self._parse_name_class(attribute=kind is PatternKind.ATTRIBUTE)
            self._expect_op("{")
            body = self.parse_pattern()
            self._expect_op("}")
            return RelaxNgPattern(
                kind=kind,
                name_class=name_class,
                children=(body,),
                documentation=documentation,
            )
        if keyword in ("list", "mixed"):
            kind = PatternKind.LIST if keyword == "list" else PatternKind.MIXED
            self.limits.record(
                "relaxng.list" if kind is PatternKind.LIST else "relaxng.mixed",
                location=self._location,
            )
            self._expect_op("{")
            body = self.parse_pattern()
            self._expect_op("}")
            return RelaxNgPattern(kind=kind, children=(body,), documentation=documentation)
        if keyword == "empty":
            return RelaxNgPattern(kind=PatternKind.EMPTY, documentation=documentation)
        if keyword == "text":
            return RelaxNgPattern(kind=PatternKind.TEXT, documentation=documentation)
        if keyword == "notAllowed":
            return RelaxNgPattern(kind=PatternKind.NOT_ALLOWED, documentation=documentation)
        if keyword == "parent":
            return RelaxNgPattern(
                kind=PatternKind.PARENT_REF,
                ref_name=self._next().value,
                documentation=documentation,
            )
        if keyword == "external":
            href = self._next().value
            if self._at_name("inherit"):
                self._next()
                self._expect_op("=")
                self._next()
            return RelaxNgPattern(
                kind=PatternKind.EXTERNAL_REF, ref_name=href, documentation=documentation
            )
        if keyword == "grammar":
            self._expect_op("{")
            nested_start, nested_declarations, _ = self.parse_grammar_body(stop_at_brace=True)
            self._expect_op("}")
            self.nested.extend(nested_declarations)
            return nested_start
        if keyword in BUILTIN_DATATYPES:
            return self._parse_datatype(keyword, documentation=documentation)
        # Anything else at this position is a reference to a named pattern.
        return RelaxNgPattern(
            kind=PatternKind.REF, ref_name=keyword, documentation=documentation
        )

    def _parse_datatype(self, name: str, *, documentation: Optional[str]) -> RelaxNgPattern:
        """Read a datatype name, its optional ``{ param = "…" }`` facets and ``- except``.

        A datatype name immediately followed by a literal is the ``datatypeValue`` form
        (``xsd:token "reserved"``), which is a ``value`` pattern rather than a ``data`` one.

        Args:
            name: The datatype name as written (``string``, ``xsd:decimal``).
            documentation: Any ``##`` comment attached to the pattern.

        Returns:
            The ``data`` or ``value`` pattern.
        """
        prefix, _, local = name.rpartition(":")
        library = self._library_for(prefix) if prefix else None
        if prefix and library is None:
            raise self._error(f"datatype prefix {prefix!r} is not bound by a `datatypes` declaration")
        if library and library not in ("", "http://www.w3.org/2001/XMLSchema-datatypes"):
            self.limits.record("relaxng.external_datatype_library", location=self._location)

        token = self._peek()
        if token is not None and token.kind == "literal":
            self._next()
            return RelaxNgPattern(
                kind=PatternKind.VALUE,
                literal=token.value,
                datatype=local,
                datatype_library=library,
                documentation=documentation,
            )

        params: List[Tuple[str, str]] = []
        if self._at_op("{"):
            self._next()
            while not self._at_op("}"):
                self._take_doc()
                if self._at_op("}"):
                    break
                param_name = self._next().value
                self._expect_op("=")
                params.append((param_name, self._next().value))
            self._expect_op("}")

        excepted: List[RelaxNgPattern] = []
        if self._at_op("-"):
            self._next()
            self.limits.record("relaxng.datatype_except", location=self._location)
            excepted.append(self._parse_repeat())

        return RelaxNgPattern(
            kind=PatternKind.DATA,
            datatype=local,
            datatype_library=library,
            params=tuple(params),
            excepted=tuple(excepted),
            documentation=documentation,
        )

    def _library_for(self, prefix: str) -> Optional[str]:
        """Return the datatype library URI bound to ``prefix``, if any."""
        return self.datatype_libraries.get(prefix)

    # -- name classes -----------------------------------------------------

    def _parse_name_class(self, *, attribute: bool) -> RelaxNgNameClass:
        """Read an element/attribute name class, including ``|`` alternatives.

        Args:
            attribute: Whether the owning pattern is an ``attribute`` — an unprefixed
                attribute name is in no namespace, while an unprefixed element name takes
                the document's default namespace.

        Returns:
            The name class.
        """
        first = self._parse_name_class_item(attribute=attribute)
        if not self._at_op("|"):
            return first
        alternatives = [first]
        while self._at_op("|"):
            self._next()
            alternatives.append(self._parse_name_class_item(attribute=attribute))
        return RelaxNgNameClass(kind=NameClassKind.CHOICE, alternatives=tuple(alternatives))

    def _parse_name_class_item(self, *, attribute: bool) -> RelaxNgNameClass:
        """Read one name-class production."""
        if self._at_op("("):
            self._next()
            inner = self._parse_name_class(attribute=attribute)
            self._expect_op(")")
            return inner
        token = self._next()
        if token.kind == "op" and token.value == "*":
            self.limits.record("relaxng.name_class_wildcard", location=self._location)
            return RelaxNgNameClass(
                kind=NameClassKind.ANY_NAME, excepted=self._parse_name_class_except(attribute)
            )
        if token.kind == "nsname":
            self.limits.record("relaxng.name_class_wildcard", location=self._location)
            return RelaxNgNameClass(
                kind=NameClassKind.NS_NAME,
                ns=self.namespaces.get(token.value),
                excepted=self._parse_name_class_except(attribute),
            )
        if token.kind == "cname":
            prefix, _, local = token.value.rpartition(":")
            return RelaxNgNameClass(
                kind=NameClassKind.NAME, name=local, ns=self.namespaces.get(prefix)
            )
        if token.kind == "name":
            return RelaxNgNameClass(
                kind=NameClassKind.NAME,
                name=token.value,
                ns=None if attribute else self.default_namespace,
            )
        raise self._error(f"unexpected {token.value!r} where a name was expected", token)

    def _parse_name_class_except(self, attribute: bool) -> Tuple[RelaxNgNameClass, ...]:
        """Read the ``- nameClass`` exclusion of a wildcard, when present."""
        if not self._at_op("-"):
            return ()
        self._next()
        return (self._parse_name_class_item(attribute=attribute),)

    def _skip_balanced(self, opening: str, closing: str) -> None:
        """Consume a balanced ``opening``…``closing`` run, discarding it."""
        self._expect_op(opening)
        depth = 1
        while depth:
            token = self._next()
            if token.kind == "op" and token.value == opening:
                depth += 1
            elif token.kind == "op" and token.value == closing:
                depth -= 1


def read_compact_components(
    content: str,
    *,
    source_label: Optional[str] = None,
    limits: Optional[LimitRecorder] = None,
) -> RelaxNgComponents:
    """Read compact-syntax source into its uncomposed components.

    The compact front-end's whole public surface. It reads one *file* — patterns,
    definitions and the ``include`` directives it declares — and stops there: resolving
    those directives against the fileset, substituting ``external`` references and checking
    that every ``ref`` lands somewhere are the composer's job in
    :mod:`app.relaxng_parser`, shared with the XML front-end so a mixed-syntax set composes
    by the same rules as a single-syntax one.

    Args:
        content: The ``.rnc`` source.
        source_label: The file's name, used in error messages.
        limits: The recorder declared limits are accumulated into. A fresh one is used when
            omitted, which is what a standalone parse of one file wants.

    Returns:
        The file's components.

    Raises:
        RelaxNgParseError: If the source is not well-formed compact syntax.
    """
    if not content or not content.strip():
        raise RelaxNgParseError("Invalid or empty RELAX NG document")
    size = len(content.encode("utf-8", errors="replace"))
    if size > MAX_COMPACT_BYTES:
        raise RelaxNgParseError(
            f"RELAX NG document is too large: {size} bytes exceeds the "
            f"{MAX_COMPACT_BYTES}-byte limit",
            code="INPUT_TOO_LARGE",
        )

    parser = _Parser(
        tokenize_compact(content),
        source_label=source_label,
        limits=limits or LimitRecorder(),
    )
    parser.parse_declarations()
    if parser.looks_like_grammar():
        start, declarations, includes = parser.parse_grammar_body()
    else:
        start, declarations, includes = parser.parse_pattern(), [], []

    return RelaxNgComponents(
        start=start,
        declarations=tuple(declarations) + tuple(parser.nested),
        includes=tuple(includes),
        namespace=parser.default_namespace,
        datatype_library=parser.default_datatype_library,
        documentation=parser.documentation,
    )
