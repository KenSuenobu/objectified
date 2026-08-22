"""CDDL (RFC 8610) reader — FMT-4.4 (#5437).

A tokenizer and a recursive-descent parser for the Concise Data Definition Language, plus
the sniff (:func:`is_cddl`) that lets the intake pipeline claim a ``.cddl`` document. The
algebra it produces, the prelude it resolves against and the declared limits it records
live in :mod:`app.cddl_grammar`.

**Why a hand-written reader.** CDDL's ABNF is small but its lexis is genuinely ambiguous in
two places, and both need a decision a generated parser cannot make for us:

* An identifier may contain ``.`` (``mime-message``, ``float16-32``, ``a.b``), and a control
  operator is also written ``.name``. The reader resolves this the way every CDDL
  implementation does — a ``.`` continues an identifier only when it is *immediately*
  preceded and followed by identifier characters, so ``tstr .size 8`` is a control and
  ``float16-32`` is one name.
* ``( … )`` is both a parenthesized type and a group. The reader parses it once, as a group,
  and a group holding a single unkeyed member with no occurrence indicator *is* the
  parenthesized type — so the two readings never disagree.

**Bounds are the reader's own.** Nothing else stands between the input and this parser: a
byte ceiling, a nesting ceiling and a rule ceiling are enforced here, because a recursive
descent parser that meets ``[[[[…]]]]`` raises ``RecursionError``, which the import
pipeline does **not** catch and which would therefore surface as a 5xx rather than as a
classified rejection.

**Composition is a fileset property.** CDDL has no ``include``: a grammar split across
files is loaded as a set and the rules are merged into one namespace, which is what
:func:`parse_cddl_fileset` does. A reference that resolves in neither file is an error that
names the missing rule.
"""

from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from .cddl_grammar import (
    MAX_CDDL_BYTES,
    MAX_CDDL_DEPTH,
    PRELUDE_TYPES,
    AssignKind,
    CddlDocument,
    CddlGroup,
    CddlLiteral,
    CddlMember,
    CddlMemberKey,
    CddlNode,
    CddlParseError,
    CddlRule,
    LimitRecorder,
    LiteralKind,
    MemberKeyKind,
    NodeKind,
    Occurrence,
    RuleKind,
    build_document,
    is_socket_name,
)

__all__ = [
    "CDDL_MEDIA_TYPE",
    "CDDL_SUFFIXES",
    "CddlToken",
    "is_cddl",
    "parse_cddl",
    "parse_cddl_fileset",
    "tokenize",
]

#: The file extensions a CDDL grammar is written with. ``.cddl`` is the registered one;
#: ``.cdl`` appears in a few older IETF drafts.
CDDL_SUFFIXES = (".cddl", ".cdl")

#: The media type the emitter writes and the intake surface advertises. CDDL has no
#: registered media type, so the ``text/plain`` family is used with a structured suffix.
CDDL_MEDIA_TYPE = "text/plain"

#: Characters that may begin an identifier (RFC 8610 ``EALPHA``).
_ID_START = re.compile(r"[A-Za-z@_$]")

#: Characters that may continue an identifier, excluding the ``-``/``.`` connectors, which
#: are handled separately because they may only sit *between* two identifier characters.
_ID_BODY = re.compile(r"[A-Za-z0-9@_$]")


class _TokenKind:
    """The token families the scanner produces (a namespace, not an enum: values are
    compared by identity against string constants and never leave this module)."""

    ID = "id"
    NUMBER = "number"
    TEXT = "text"
    BYTES = "bytes"
    PUNCT = "punct"
    CTLOP = "ctlop"
    MAJOR = "major"
    EOF = "eof"


class CddlToken:
    """One lexical token.

    Attributes:
        kind: The token family.
        value: The token's text — an identifier's name, a punctuation spelling, a control
            operator including its leading ``.``.
        line: The 1-based source line the token starts on.
        literal: The parsed value, for ``NUMBER``/``TEXT``/``BYTES`` tokens.
        major: The CBOR major type, for a ``MAJOR`` token.
        additional: The additional-information value, for a ``MAJOR`` token.
        adjacent: Whether the token abuts the previous one with no intervening whitespace.
    """

    __slots__ = ("kind", "value", "line", "literal", "major", "additional", "adjacent")

    def __init__(
        self,
        kind: str,
        value: str,
        line: int,
        *,
        literal: Optional[CddlLiteral] = None,
        major: Optional[int] = None,
        additional: Optional[int] = None,
        adjacent: bool = False,
    ) -> None:
        self.kind = kind
        self.value = value
        self.line = line
        self.literal = literal
        self.major = major
        self.additional = additional
        self.adjacent = adjacent

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return f"CddlToken({self.kind}, {self.value!r}, line={self.line})"


class _Comment:
    """One ``;`` comment, with enough context to attach it to a rule or a member.

    Attributes:
        text: The comment's text, with the ``;`` and surrounding whitespace stripped.
        line: The 1-based source line it sits on.
        leading: Whether it is the first non-whitespace thing on its line (a comment
            *about* what follows) rather than a trailing note on a member.
    """

    __slots__ = ("text", "line", "leading")

    def __init__(self, text: str, line: int, leading: bool) -> None:
        self.text = text
        self.line = line
        self.leading = leading


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------


def tokenize(text: str, *, source_label: Optional[str] = None) -> Tuple[List[CddlToken], List[_Comment]]:
    """Scan ``text`` into tokens and comments.

    Args:
        text: The CDDL source.
        source_label: The document's name, for error messages.

    Returns:
        ``(tokens, comments)`` — the token stream (ending with an ``EOF`` token) and every
        comment in source order.

    Raises:
        CddlParseError: On an unterminated string, or a character CDDL does not admit.
    """
    where = f" ({source_label})" if source_label else ""
    tokens: List[CddlToken] = []
    comments: List[_Comment] = []
    index = 0
    line = 1
    length = len(text)
    line_start = True
    gap = True

    while index < length:
        character = text[index]

        if character in " \t\r":
            index += 1
            gap = True
            continue
        if character == "\n":
            index += 1
            line += 1
            line_start = True
            gap = True
            continue
        if character == ";":
            end = text.find("\n", index)
            end = length if end == -1 else end
            comments.append(_Comment(text[index + 1 : end].strip(), line, line_start))
            index = end
            gap = True
            continue

        start_line = line
        adjacent = not gap
        gap = False
        line_start = False

        if character == '"':
            value, index, line = _scan_text(text, index, line, where)
            tokens.append(
                CddlToken(
                    _TokenKind.TEXT,
                    value.spelling,
                    start_line,
                    literal=value,
                    adjacent=adjacent,
                )
            )
            continue

        if character == "'":
            value, index, line = _scan_bytes(text, index, line, "", where)
            tokens.append(
                CddlToken(
                    _TokenKind.BYTES,
                    value.spelling,
                    start_line,
                    literal=value,
                    adjacent=adjacent,
                )
            )
            continue

        if character == "#":
            token, index = _scan_major(text, index, start_line, adjacent)
            tokens.append(token)
            continue

        if _ID_START.match(character):
            word, index = _scan_identifier(text, index)
            # `h'0f'` and `b64'…'` are byte-string literals whose qualifier lexes as an
            # identifier; only these two qualifiers exist, and only when the quote abuts.
            if word in ("h", "b64") and index < length and text[index] == "'":
                value, index, line = _scan_bytes(text, index, line, word, where)
                tokens.append(
                    CddlToken(
                        _TokenKind.BYTES,
                        value.spelling,
                        start_line,
                        literal=value,
                        adjacent=adjacent,
                    )
                )
                continue
            tokens.append(CddlToken(_TokenKind.ID, word, start_line, adjacent=adjacent))
            continue

        if character.isdigit() or (
            character == "-" and index + 1 < length and text[index + 1].isdigit()
        ):
            literal, index = _scan_number(text, index, where)
            tokens.append(
                CddlToken(
                    _TokenKind.NUMBER,
                    literal.spelling,
                    start_line,
                    literal=literal,
                    adjacent=adjacent,
                )
            )
            continue

        if character == ".":
            # `...` and `..` are range operators; `.name` is a control operator. A `.`
            # inside an identifier never reaches here — `_scan_identifier` absorbs it.
            if text.startswith("...", index):
                tokens.append(CddlToken(_TokenKind.PUNCT, "...", start_line, adjacent=adjacent))
                index += 3
                continue
            if text.startswith("..", index):
                tokens.append(CddlToken(_TokenKind.PUNCT, "..", start_line, adjacent=adjacent))
                index += 2
                continue
            if index + 1 < length and _ID_START.match(text[index + 1]):
                word, index = _scan_identifier(text, index + 1)
                tokens.append(
                    CddlToken(_TokenKind.CTLOP, f".{word}", start_line, adjacent=adjacent)
                )
                continue
            raise CddlParseError(f"stray `.` at line {start_line}{where}")

        for spelling in ("//=", "/=", "//", "=>", "="):
            if text.startswith(spelling, index):
                tokens.append(
                    CddlToken(_TokenKind.PUNCT, spelling, start_line, adjacent=adjacent)
                )
                index += len(spelling)
                break
        else:
            if character in "{}[]()<>,:*+?~&^/":
                tokens.append(
                    CddlToken(_TokenKind.PUNCT, character, start_line, adjacent=adjacent)
                )
                index += 1
                continue
            raise CddlParseError(
                f"character {character!r} at line {start_line}{where} is not part of the "
                f"CDDL grammar"
            )

    tokens.append(CddlToken(_TokenKind.EOF, "", line))
    return tokens, comments


def _scan_identifier(text: str, index: int) -> Tuple[str, int]:
    """Scan one identifier starting at ``index``.

    RFC 8610's ``id`` admits ``-`` and ``.`` as *connectors*: they may appear only between
    two identifier characters. Enforcing that here is what separates ``float16-32`` (one
    name) from ``tstr .size`` (a name and a control operator), and it is the one lexical
    decision the RFC's ABNF leaves to the implementation.

    Args:
        text: The source.
        index: Where the identifier starts.

    Returns:
        ``(identifier, next_index)``.
    """
    start = index
    length = len(text)
    index += 1
    while index < length:
        character = text[index]
        if _ID_BODY.match(character):
            index += 1
            continue
        if character in "-.":
            # A connector only continues the identifier when a body character follows.
            probe = index + 1
            while probe < length and text[probe] in "-.":
                probe += 1
            if probe < length and _ID_BODY.match(text[probe]):
                index = probe + 1
                continue
        break
    return text[start:index], index


def _scan_number(text: str, index: int, where: str) -> Tuple[CddlLiteral, int]:
    """Scan one numeric literal starting at ``index``.

    Args:
        text: The source.
        index: Where the number starts.
        where: The source label suffix for error messages.

    Returns:
        ``(literal, next_index)``.

    Raises:
        CddlParseError: When the digits do not form a number CDDL admits.
    """
    start = index
    length = len(text)
    if text[index] == "-":
        index += 1
    if text.startswith(("0x", "0X"), index):
        index += 2
        while index < length and text[index] in "0123456789abcdefABCDEF":
            index += 1
        spelling = text[start:index]
        return CddlLiteral(LiteralKind.INT, int(spelling, 16), spelling), index
    if text.startswith(("0b", "0B"), index):
        index += 2
        while index < length and text[index] in "01":
            index += 1
        spelling = text[start:index]
        return CddlLiteral(LiteralKind.INT, int(spelling, 2), spelling), index

    while index < length and text[index].isdigit():
        index += 1
    is_float = False
    # A `.` begins a fraction only when a digit follows — `0..100` is a range, not `0.`
    if index + 1 < length and text[index] == "." and text[index + 1].isdigit():
        is_float = True
        index += 1
        while index < length and text[index].isdigit():
            index += 1
    if index < length and text[index] in "eE":
        probe = index + 1
        if probe < length and text[probe] in "+-":
            probe += 1
        if probe < length and text[probe].isdigit():
            is_float = True
            index = probe
            while index < length and text[index].isdigit():
                index += 1
    spelling = text[start:index]
    try:
        value = float(spelling) if is_float else int(spelling)
    except ValueError as exc:  # pragma: no cover — the scan above cannot produce this
        raise CddlParseError(f"{spelling!r} is not a CDDL number{where}") from exc
    return CddlLiteral(LiteralKind.FLOAT if is_float else LiteralKind.INT, value, spelling), index


def _scan_text(text: str, index: int, line: int, where: str) -> Tuple[CddlLiteral, int, int]:
    """Scan one ``"…"`` text literal.

    Args:
        text: The source.
        index: The opening quote's index.
        line: The current line number.
        where: The source label suffix for error messages.

    Returns:
        ``(literal, next_index, line)``.

    Raises:
        CddlParseError: ``INPUT_TRUNCATED`` when the string is never closed.
    """
    start = index
    index += 1
    parts: List[str] = []
    length = len(text)
    while index < length:
        character = text[index]
        if character == "\\" and index + 1 < length:
            parts.append(_unescape(text[index + 1]))
            index += 2
            continue
        if character == '"':
            index += 1
            return CddlLiteral(LiteralKind.TEXT, "".join(parts), text[start:index]), index, line
        if character == "\n":
            line += 1
        parts.append(character)
        index += 1
    raise CddlParseError(
        f"a text literal opened at line {line}{where} is never closed",
        code="INPUT_TRUNCATED",
    )


def _unescape(character: str) -> str:
    """Return the character one backslash escape stands for."""
    return {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}.get(character, character)


def _scan_bytes(
    text: str, index: int, line: int, qualifier: str, where: str
) -> Tuple[CddlLiteral, int, int]:
    """Scan one ``'…'`` byte-string literal, with its optional ``h``/``b64`` qualifier.

    Args:
        text: The source.
        index: The opening quote's index.
        line: The current line number.
        qualifier: ``"h"``, ``"b64"`` or ``""``.
        where: The source label suffix for error messages.

    Returns:
        ``(literal, next_index, line)``.

    Raises:
        CddlParseError: ``INPUT_TRUNCATED`` when the literal is never closed.
    """
    start = index - len(qualifier)
    index += 1
    parts: List[str] = []
    length = len(text)
    while index < length:
        character = text[index]
        if character == "\\" and index + 1 < length:
            parts.append(_unescape(text[index + 1]))
            index += 2
            continue
        if character == "'":
            index += 1
            body = "".join(parts)
            value = _decode_bytes(body, qualifier)
            return CddlLiteral(LiteralKind.BYTES, value, text[start:index]), index, line
        if character == "\n":
            line += 1
        parts.append(character)
        index += 1
    raise CddlParseError(
        f"a byte-string literal opened at line {line}{where} is never closed",
        code="INPUT_TRUNCATED",
    )


def _decode_bytes(body: str, qualifier: str) -> bytes:
    """Return the bytes a byte-string literal's body denotes.

    A body that does not decode is kept as its UTF-8 text rather than failing the import:
    the value is documentation for a schema reader, and a malformed hex run is not a reason
    to reject a grammar whose structure is sound.

    Args:
        body: The literal's contents, unescaped.
        qualifier: ``"h"``, ``"b64"`` or ``""``.

    Returns:
        The decoded bytes.
    """
    compact = "".join(body.split())
    try:
        if qualifier == "h":
            return bytes.fromhex(compact)
        if qualifier == "b64":
            import base64

            padded = compact + "=" * (-len(compact) % 4)
            return base64.urlsafe_b64decode(padded)
    except (ValueError, TypeError):
        return body.encode("utf-8", "replace")
    return body.encode("utf-8", "replace")


def _scan_major(text: str, index: int, line: int, adjacent: bool) -> Tuple[CddlToken, int]:
    """Scan one ``#``, ``#n`` or ``#n.m`` major-type token.

    ``#6.1(…)`` is scanned as one token rather than as ``#`` plus the float ``6.1``, which
    is the whole reason the tokenizer handles ``#`` itself.

    Args:
        text: The source.
        index: The ``#``'s index.
        line: The current line number.
        adjacent: Whether the ``#`` abuts the previous token.

    Returns:
        ``(token, next_index)``.
    """
    start = index
    index += 1
    length = len(text)
    major: Optional[int] = None
    additional: Optional[int] = None
    if index < length and text[index].isdigit():
        digits = index
        while index < length and text[index].isdigit():
            index += 1
        major = int(text[digits:index])
        if index + 1 < length and text[index] == "." and text[index + 1].isdigit():
            index += 1
            digits = index
            while index < length and text[index].isdigit():
                index += 1
            additional = int(text[digits:index])
    return (
        CddlToken(
            _TokenKind.MAJOR,
            text[start:index],
            line,
            major=major,
            additional=additional,
            adjacent=adjacent,
        ),
        index,
    )


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


class _Parser:
    """Recursive-descent parser over one CDDL document's token stream."""

    def __init__(
        self,
        tokens: Sequence[CddlToken],
        *,
        source_label: Optional[str] = None,
        member: Optional[str] = None,
    ) -> None:
        self._tokens = list(tokens)
        self._index = 0
        self._label = source_label
        self._member = member
        self._depth = 0
        self._parameters: Tuple[str, ...] = ()
        #: Set while a member's value is being read, so an EOF there reads as a truncation
        #: rather than as an unclosed bracket. See :meth:`_unexpected_eof`.
        self._inside_member = False

    # -- token helpers ----------------------------------------------------

    @property
    def _current(self) -> CddlToken:
        return self._tokens[self._index]

    def _peek(self, offset: int = 1) -> CddlToken:
        position = min(self._index + offset, len(self._tokens) - 1)
        return self._tokens[position]

    def _advance(self) -> CddlToken:
        token = self._tokens[self._index]
        if token.kind is not _TokenKind.EOF:
            self._index += 1
        return token

    def _at(self, kind: str, value: Optional[str] = None) -> bool:
        token = self._current
        return token.kind == kind and (value is None or token.value == value)

    def _accept(self, kind: str, value: Optional[str] = None) -> Optional[CddlToken]:
        if self._at(kind, value):
            return self._advance()
        return None

    def _expect(self, kind: str, value: Optional[str] = None) -> CddlToken:
        if self._at(kind, value):
            return self._advance()
        self._fail(f"expected {value or kind}")

    def _where(self) -> str:
        parts = [part for part in (self._member, self._label) if part]
        return f" ({parts[0]})" if parts else ""

    def _fail(self, message: str) -> None:
        """Raise a plain syntax error at the current token.

        No taxonomy code is attached: the import pipeline classifies an uncoded parse
        failure itself, which is what makes a UTF-16 file read as an encoding fault and a
        JSON document as a format mismatch rather than both reading as malformed CDDL.
        """
        token = self._current
        if token.kind is _TokenKind.EOF:
            self._unexpected_eof(message)
        found = token.value or token.kind
        raise CddlParseError(
            f"{message} at line {token.line}{self._where()}, found {found!r}"
        )

    def _unexpected_eof(self, message: str) -> None:
        """Raise the right error for an input that ends before the grammar does.

        The distinction is a real parser state, not a heuristic. Ending at a **member
        boundary** — after a ``,``, or with nothing open but a bracket — means the document
        is well-formed as far as it goes and merely never closed: a malformed grammar. Ending
        **inside** a member, after its key or its type but before the separator that would
        finish it, means the input stops mid-construct: a truncated file. The two negative
        corpus entries differ in exactly this way, and a reader that could not tell them
        apart would report both the same.
        """
        if self._inside_member:
            raise CddlParseError(
                f"the document ends inside a rule{self._where()} ({message}); the input "
                f"stops mid-construct rather than at a complete declaration",
                code="INPUT_TRUNCATED",
            )
        raise CddlParseError(
            f"the document ends before the grammar does{self._where()} ({message})"
        )

    # -- depth ------------------------------------------------------------

    def _enter(self) -> None:
        self._depth += 1
        if self._depth > MAX_CDDL_DEPTH:
            raise CddlParseError(
                f"types and groups nest deeper than the {MAX_CDDL_DEPTH}-level limit"
                f"{self._where()}",
                code="INPUT_DEPTH_LIMIT",
            )

    def _leave(self) -> None:
        self._depth -= 1

    # -- rules ------------------------------------------------------------

    def parse_rules(self) -> List[CddlRule]:
        """Read every rule in the document.

        Returns:
            The rules, in declaration order.
        """
        rules: List[CddlRule] = []
        while not self._at(_TokenKind.EOF):
            rules.append(self._parse_rule())
        return rules

    def _parse_rule(self) -> CddlRule:
        """Read one ``name [<params>] (= | /= | //=) body`` rule."""
        name_token = self._current
        if name_token.kind is not _TokenKind.ID:
            self._fail("expected a rule name")
        name = self._advance().value

        parameters: Tuple[str, ...] = ()
        if self._at(_TokenKind.PUNCT, "<"):
            parameters = self._parse_generic_parameters()

        assign_token = self._current
        if assign_token.kind is not _TokenKind.PUNCT or assign_token.value not in (
            "=",
            "/=",
            "//=",
        ):
            self._fail(f"expected `=`, `/=` or `//=` after rule name {name!r}")
        assign = AssignKind(self._advance().value)

        previous = self._parameters
        self._parameters = parameters
        try:
            node = self._parse_type()
        finally:
            self._parameters = previous

        # A rule whose whole body is a parenthesized group declares a *group*, which other
        # groups splice in. A parenthesized single type is the same syntax; the group form
        # is chosen only when the parentheses hold something a type cannot be — a keyed
        # member, an occurrence indicator, several entries, or a group choice.
        if node.kind is NodeKind.GROUP and node.group is not None and _is_group_body(node.group):
            return CddlRule(
                name=name,
                kind=RuleKind.GROUP,
                assign=assign,
                parameters=parameters,
                group=node.group,
                line=name_token.line,
                source=self._member,
            )
        if assign is AssignKind.GROUP_EXTEND:
            # `//=` always plugs a group socket, so its body is a group even when it holds
            # a single unkeyed entry.
            group = (
                node.group
                if node.kind is NodeKind.GROUP and node.group is not None
                else CddlGroup(choices=((CddlMember(key=CddlMemberKey(), value=node),),))
            )
            return CddlRule(
                name=name,
                kind=RuleKind.GROUP,
                assign=assign,
                parameters=parameters,
                group=group,
                line=name_token.line,
                source=self._member,
            )
        return CddlRule(
            name=name,
            kind=RuleKind.TYPE,
            assign=assign,
            parameters=parameters,
            node=node,
            line=name_token.line,
            source=self._member,
        )

    def _parse_generic_parameters(self) -> Tuple[str, ...]:
        """Read a ``<T, U>`` generic parameter list."""
        self._expect(_TokenKind.PUNCT, "<")
        names: List[str] = []
        while True:
            names.append(self._expect(_TokenKind.ID).value)
            if self._accept(_TokenKind.PUNCT, ","):
                continue
            break
        self._expect(_TokenKind.PUNCT, ">")
        return tuple(names)

    # -- types ------------------------------------------------------------

    def _parse_type(self) -> CddlNode:
        """Read a ``type1 *( "/" type1 )`` type choice."""
        branches = [self._parse_type1()]
        while self._at(_TokenKind.PUNCT, "/"):
            self._advance()
            branches.append(self._parse_type1())
        if len(branches) == 1:
            return branches[0]
        return CddlNode(kind=NodeKind.CHOICE, children=tuple(branches))

    def _parse_type1(self) -> CddlNode:
        """Read a ``type2 [ (rangeop | ctlop) type2 ]`` expression.

        Control operators chain left-associatively — ``uint .ge 1 .le 10`` is two controls
        on one target — which RFC 8610's ABNF does not spell out but every grammar assumes.
        """
        node = self._parse_type2()
        while True:
            if self._at(_TokenKind.PUNCT, "..") or self._at(_TokenKind.PUNCT, "..."):
                operator = self._advance().value
                upper = self._parse_type2()
                node = CddlNode(
                    kind=NodeKind.RANGE, children=(node, upper), operator=operator
                )
                continue
            if self._at(_TokenKind.CTLOP):
                operator = self._advance().value
                controller = self._parse_type2()
                node = CddlNode(
                    kind=NodeKind.CONTROL, children=(node, controller), operator=operator
                )
                continue
            return node

    def _parse_type2(self) -> CddlNode:
        """Read one primary type expression."""
        token = self._current

        if token.kind is _TokenKind.TEXT or token.kind is _TokenKind.BYTES:
            self._advance()
            return CddlNode(kind=NodeKind.LITERAL, literal=token.literal)

        if token.kind is _TokenKind.NUMBER:
            self._advance()
            return CddlNode(kind=NodeKind.LITERAL, literal=token.literal)

        if token.kind is _TokenKind.MAJOR:
            return self._parse_major()

        if token.kind is _TokenKind.PUNCT:
            if token.value == "{":
                return self._parse_bracketed(NodeKind.MAP, "{", "}")
            if token.value == "[":
                return self._parse_bracketed(NodeKind.ARRAY, "[", "]")
            if token.value == "(":
                return self._parse_bracketed(NodeKind.GROUP, "(", ")")
            if token.value == "~":
                self._advance()
                name = self._expect(_TokenKind.ID).value
                arguments = self._parse_generic_arguments()
                return CddlNode(kind=NodeKind.UNWRAP, name=name, arguments=arguments)
            if token.value == "&":
                self._advance()
                if self._at(_TokenKind.PUNCT, "("):
                    inner = self._parse_bracketed(NodeKind.GROUP, "(", ")")
                    return CddlNode(kind=NodeKind.ENUM_GROUP, group=inner.group)
                name = self._expect(_TokenKind.ID).value
                arguments = self._parse_generic_arguments()
                return CddlNode(kind=NodeKind.ENUM_GROUP, name=name, arguments=arguments)

        if token.kind is _TokenKind.ID:
            self._advance()
            arguments = self._parse_generic_arguments()
            return self._name_node(token.value, arguments)

        self._fail("expected a type")
        raise AssertionError("unreachable")  # pragma: no cover

    def _name_node(self, name: str, arguments: Tuple[CddlNode, ...]) -> CddlNode:
        """Return the node one identifier used as a type denotes.

        A generic parameter shadows everything, then a socket, then the prelude, and a name
        that is none of those is a reference to another rule — resolved (or reported
        missing) once the whole document is in hand.
        """
        if name in self._parameters:
            return CddlNode(kind=NodeKind.PARAMETER, name=name)
        if is_socket_name(name):
            return CddlNode(kind=NodeKind.SOCKET, name=name, arguments=arguments)
        if name in PRELUDE_TYPES:
            return CddlNode(kind=NodeKind.PRELUDE, name=name)
        return CddlNode(kind=NodeKind.REFERENCE, name=name, arguments=arguments)

    def _parse_generic_arguments(self) -> Tuple[CddlNode, ...]:
        """Read a ``<tstr, uint>`` generic argument list, when one follows.

        ``<`` is unambiguous here: CDDL has no comparison operators, so a ``<`` after a
        type name can only open an argument list.
        """
        if not self._at(_TokenKind.PUNCT, "<"):
            return ()
        self._advance()
        arguments: List[CddlNode] = []
        while True:
            arguments.append(self._parse_type1())
            if self._accept(_TokenKind.PUNCT, ","):
                continue
            break
        self._expect(_TokenKind.PUNCT, ">")
        return tuple(arguments)

    def _parse_major(self) -> CddlNode:
        """Read a ``#``, ``#n``, ``#n.m`` or ``#6.n(type)`` major-type expression."""
        token = self._advance()
        if token.major is None:
            return CddlNode(kind=NodeKind.ANY)
        if token.major == 6:
            if self._at(_TokenKind.PUNCT, "("):
                self._advance()
                inner = self._parse_type()
                self._expect(_TokenKind.PUNCT, ")")
                return CddlNode(kind=NodeKind.TAG, tag=token.additional, children=(inner,))
            return CddlNode(kind=NodeKind.TAG, tag=token.additional, children=())
        return CddlNode(
            kind=NodeKind.MAJOR, major=token.major, additional=token.additional
        )

    def _parse_bracketed(self, kind: NodeKind, opening: str, closing: str) -> CddlNode:
        """Read ``{ group }``, ``[ group ]`` or ``( group )``."""
        self._expect(_TokenKind.PUNCT, opening)
        self._enter()
        try:
            group = self._parse_group(closing)
        finally:
            self._leave()
        self._expect(_TokenKind.PUNCT, closing)
        return CddlNode(kind=kind, group=group)

    # -- groups -----------------------------------------------------------

    def _parse_group(self, closing: str) -> CddlGroup:
        """Read a ``grpchoice *( "//" grpchoice )`` group body up to ``closing``."""
        choices: List[Tuple[CddlMember, ...]] = [self._parse_group_choice(closing)]
        while self._at(_TokenKind.PUNCT, "//"):
            self._advance()
            choices.append(self._parse_group_choice(closing))
        return CddlGroup(choices=tuple(choices))

    def _parse_group_choice(self, closing: str) -> Tuple[CddlMember, ...]:
        """Read one ``//``-separated alternative of a group."""
        members: List[CddlMember] = []
        while True:
            if self._at(_TokenKind.PUNCT, closing) or self._at(_TokenKind.PUNCT, "//"):
                break
            if self._at(_TokenKind.EOF):
                self._unexpected_eof(f"expected `{closing}`")
            members.append(self._parse_member())
            if self._accept(_TokenKind.PUNCT, ","):
                continue
            if self._at(_TokenKind.EOF):
                # The member was read whole but nothing terminates it — no `,`, no closing
                # bracket, no `//`. The input stops mid-construct, which is a truncation
                # and not the same failure as a bracket that is simply never closed.
                raise CddlParseError(
                    f"the document ends immediately after a group member{self._where()}, "
                    f"with no `,` or `{closing}` to terminate it; the input stops "
                    f"mid-construct",
                    code="INPUT_TRUNCATED",
                )
            break
        return tuple(members)

    def _parse_member(self) -> CddlMember:
        """Read one ``[occur] [memberkey] type`` group entry."""
        previous = self._inside_member
        self._inside_member = True
        try:
            occurrence = self._parse_occurrence()
            key = self._parse_member_key()
            value = self._parse_type()
            line = self._tokens[max(self._index - 1, 0)].line
            return CddlMember(key=key, value=value, occurrence=occurrence, line=line)
        finally:
            self._inside_member = previous

    def _parse_occurrence(self) -> Occurrence:
        """Read an occurrence indicator, or return the implicit "exactly once"."""
        if self._at(_TokenKind.PUNCT, "?"):
            self._advance()
            return Occurrence(minimum=0, maximum=1, spelling="?")
        if self._at(_TokenKind.PUNCT, "+"):
            self._advance()
            return Occurrence(minimum=1, maximum=None, spelling="+")
        if self._at(_TokenKind.PUNCT, "*"):
            self._advance()
            maximum = self._parse_occurrence_bound()
            return Occurrence(
                minimum=0, maximum=maximum, spelling="*" + ("" if maximum is None else str(maximum))
            )
        if self._at(_TokenKind.NUMBER) and self._peek().kind is _TokenKind.PUNCT:
            if self._peek().value == "*":
                lower_token = self._advance()
                self._advance()
                lower = int(lower_token.literal.value) if lower_token.literal else 0
                maximum = self._parse_occurrence_bound()
                spelling = f"{lower}*" + ("" if maximum is None else str(maximum))
                return Occurrence(minimum=lower, maximum=maximum, spelling=spelling)
        return Occurrence()

    def _parse_occurrence_bound(self) -> Optional[int]:
        """Read the optional upper bound that may follow a ``*``."""
        if self._at(_TokenKind.NUMBER) and self._current.adjacent:
            token = self._advance()
            return int(token.literal.value) if token.literal else None
        return None

    def _parse_member_key(self) -> CddlMemberKey:
        """Read a member key, or return the positional key when the entry has none.

        Three spellings exist, and the choice between them is one token of lookahead:
        ``bareword :``, ``value :`` and ``type1 [^] =>``. Anything else is a positional
        entry — an array element, or a group reference spliced into the group.
        """
        token = self._current
        if token.kind is _TokenKind.ID and self._peek().kind is _TokenKind.PUNCT:
            if self._peek().value == ":":
                self._advance()
                self._advance()
                return CddlMemberKey(kind=MemberKeyKind.BAREWORD, name=token.value)
        if (
            token.kind in (_TokenKind.TEXT, _TokenKind.NUMBER, _TokenKind.BYTES)
            and self._peek().kind is _TokenKind.PUNCT
            and self._peek().value == ":"
        ):
            self._advance()
            self._advance()
            return CddlMemberKey(kind=MemberKeyKind.LITERAL, literal=token.literal)
        if self._has_arrow_key():
            node = self._parse_type1()
            cut = self._accept(_TokenKind.PUNCT, "^") is not None
            self._expect(_TokenKind.PUNCT, "=>")
            return CddlMemberKey(kind=MemberKeyKind.TYPE, node=node, cut=cut)
        return CddlMemberKey()

    def _has_arrow_key(self) -> bool:
        """Return whether a ``=>`` closes the key that starts at the current token.

        Scanned rather than back-tracked: the key is a whole ``type1``, so the only cheap
        test is to look ahead for a ``=>`` before the entry's own terminator, tracking
        bracket depth so a nested ``{ a => b }`` inside the *value* is not mistaken for
        this entry's arrow.
        """
        depth = 0
        index = self._index
        limit = len(self._tokens)
        while index < limit:
            token = self._tokens[index]
            if token.kind is _TokenKind.EOF:
                return False
            if token.kind is _TokenKind.PUNCT:
                if token.value in "{[(":
                    depth += 1
                elif token.value in "}])":
                    if depth == 0:
                        return False
                    depth -= 1
                elif depth == 0:
                    if token.value == "=>":
                        return True
                    if token.value in (",", "//"):
                        return False
            index += 1
        return False


def _is_group_body(group: CddlGroup) -> bool:
    """Return whether a parenthesized body is a *group* rather than a parenthesized type.

    ``( a / b )`` parenthesizes a type; ``( a: x, b: y )``, ``( * a )`` and ``( a // b )``
    are groups. The test is structural — a group holding exactly one unkeyed member that
    occurs exactly once is indistinguishable from a parenthesized type, and is read as one.

    Args:
        group: The parsed body.

    Returns:
        ``True`` when the body must be read as a group.
    """
    if len(group.choices) != 1:
        return True
    members = group.choices[0]
    if len(members) != 1:
        return True
    member = members[0]
    return member.key.kind is not MemberKeyKind.NONE or member.occurrence.spelling != ""


# ---------------------------------------------------------------------------
# Comment attachment
# ---------------------------------------------------------------------------


def _attach_comments(
    rules: Sequence[CddlRule], comments: Sequence[_Comment]
) -> Tuple[List[CddlRule], Optional[str]]:
    """Attach comments to the rules and members they document.

    CDDL has exactly one documentation construct — the ``;`` comment — and no way to bind
    one to a declaration, so the binding is positional and deliberately conservative:

    * A run of full-line comments immediately above a rule, with no blank line between,
      documents that rule.
    * The same run separated from the rule by a blank line documents the *file*, which is
      how every fixture in the corpus (and most published grammars) opens.
    * A comment sharing a line with the end of a member documents that member.

    Anything else is left unattached rather than guessed at.

    Args:
        rules: The parsed rules, in declaration order.
        comments: Every comment, in source order.

    Returns:
        ``(rules, file_description)``.
    """
    leading: Dict[int, str] = {}
    trailing: Dict[int, str] = {}
    blocks: List[Tuple[int, int, str]] = []  # (first line, last line, text)

    block_start: Optional[int] = None
    block_lines: List[str] = []
    previous_line = -10
    for comment in comments:
        if not comment.leading:
            trailing[comment.line] = comment.text
            continue
        if block_start is not None and comment.line == previous_line + 1:
            block_lines.append(comment.text)
        else:
            if block_start is not None:
                blocks.append((block_start, previous_line, " ".join(block_lines).strip()))
            block_start = comment.line
            block_lines = [comment.text]
        previous_line = comment.line
    if block_start is not None:
        blocks.append((block_start, previous_line, " ".join(block_lines).strip()))

    rule_lines = sorted(rule.line for rule in rules)
    first_rule_line = rule_lines[0] if rule_lines else 0
    file_description: Optional[str] = None
    for first, last, text in blocks:
        if not text:
            continue
        following = next((line for line in rule_lines if line > last), None)
        if following is not None and following == last + 1:
            leading[following] = text
        elif first < first_rule_line and file_description is None:
            file_description = text

    attached = [
        CddlRule(
            name=rule.name,
            kind=rule.kind,
            assign=rule.assign,
            parameters=rule.parameters,
            node=_annotate_node(rule.node, trailing) if rule.node is not None else None,
            group=_annotate_group(rule.group, trailing) if rule.group is not None else None,
            description=leading.get(rule.line) or rule.description,
            line=rule.line,
            source=rule.source,
        )
        for rule in rules
    ]
    return attached, file_description


def _annotate_node(node: CddlNode, trailing: Mapping[int, str]) -> CddlNode:
    """Return ``node`` with trailing comments attached to the members beneath it."""
    if node.group is None and not node.children:
        return node
    return CddlNode(
        kind=node.kind,
        name=node.name,
        literal=node.literal,
        group=_annotate_group(node.group, trailing) if node.group is not None else None,
        children=tuple(_annotate_node(child, trailing) for child in node.children),
        operator=node.operator,
        tag=node.tag,
        major=node.major,
        additional=node.additional,
        arguments=node.arguments,
    )


def _annotate_group(group: CddlGroup, trailing: Mapping[int, str]) -> CddlGroup:
    """Return ``group`` with each member carrying the comment written on its own line."""
    return CddlGroup(
        choices=tuple(
            tuple(
                CddlMember(
                    key=member.key,
                    value=_annotate_node(member.value, trailing),
                    occurrence=member.occurrence,
                    description=member.description or trailing.get(member.line),
                    line=member.line,
                )
                for member in choice
            )
            for choice in group.choices
        )
    )


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

#: A rule assignment — the one construct every CDDL document has and no sibling format
#: spells the same way.
_RULE_ASSIGNMENT = re.compile(
    r"^[ \t]*[A-Za-z@_$][A-Za-z0-9@_$.-]*[ \t]*(<[^>\n]*>[ \t]*)?(=|/=|//=)[ \t]*\S",
    re.MULTILINE,
)

#: Prelude names a CDDL document almost always uses, and which read as CDDL rather than as
#: any other assignment-shaped language.
_PRELUDE_MARKERS = re.compile(
    r"(?<![A-Za-z0-9@_$.-])(tstr|bstr|uint|nint|tdate|bignint|biguint|any|bool|nil)"
    r"(?![A-Za-z0-9@_$.-])"
)

#: Constructs no other assignment-shaped language writes.
_STRUCTURE_MARKERS = re.compile(r"(=>|//=|/=|#6\.|\.size|\.regexp|\.cbor|\.bits|\.within)")


def is_cddl(text: str) -> bool:
    """Return whether ``text`` reads as a CDDL grammar.

    Detection is deliberately narrow: a rule assignment alone is shared with a dozen
    configuration languages, so a document must also use something only CDDL has — a
    prelude type, or one of its own operators. That is what keeps this adapter off a
    ``.properties`` file and off the JSON Schema document the negative corpus supplies.

    Args:
        text: The decoded document text.

    Returns:
        ``True`` when the document should be read as CDDL.
    """
    if not text or "\x00" in text[:512]:
        return False
    stripped = text.lstrip()
    if stripped[:1] in ("{", "["):
        # A JSON document. CDDL never begins with a bracket: it begins with a rule name.
        return False
    if not _RULE_ASSIGNMENT.search(text):
        return False
    return bool(_PRELUDE_MARKERS.search(text)) or bool(_STRUCTURE_MARKERS.search(text))


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def _guard_size(text: str, *, source_label: Optional[str]) -> None:
    """Refuse a document larger than the reader's byte ceiling."""
    size = len(text.encode("utf-8", "ignore"))
    if size > MAX_CDDL_BYTES:
        where = f" ({source_label})" if source_label else ""
        raise CddlParseError(
            f"the CDDL document is {size} bytes{where}, above the {MAX_CDDL_BYTES}-byte "
            f"import limit",
            code="INPUT_TOO_LARGE",
        )


def parse_cddl(raw: str, *, source_label: Optional[str] = None) -> CddlDocument:
    """Parse one CDDL grammar.

    Args:
        raw: The document text.
        source_label: The document's name, for error messages.

    Returns:
        The parsed :class:`~app.cddl_grammar.CddlDocument`, with sockets resolved and
        generics instantiated.

    Raises:
        CddlParseError: With a taxonomy code when the reader can classify the failure, and
            without one when the pipeline should.
    """
    _guard_size(raw, source_label=source_label)
    tokens, comments = tokenize(raw, source_label=source_label)
    parser = _Parser(tokens, source_label=source_label)
    rules = parser.parse_rules()
    rules, description = _attach_comments(rules, comments)
    return build_document(
        rules=rules,
        limits=LimitRecorder(),
        members=(source_label,) if source_label else (),
        description=description,
        raw=raw,
        source_label=source_label,
    )


def parse_cddl_fileset(
    members: Mapping[str, str],
    *,
    root: Optional[str] = None,
    source_label: Optional[str] = None,
) -> CddlDocument:
    """Parse a CDDL grammar split across several files.

    CDDL has no ``include`` directive, so composition is a property of the *set*: the
    files are loaded together and their rules share one namespace. The root is read first
    so the grammar's entry point is the root file's first rule, and the remaining members
    follow in sorted order so the same set always composes identically.

    Args:
        members: Fileset member name -> text.
        root: The member that holds the grammar's entry point.
        source_label: Fallback label when the set names no root.

    Returns:
        The composed document.

    Raises:
        CddlParseError: If a member fails to parse, a rule is bound twice across the set,
            or a reference resolves in none of the members.
    """
    ordered: List[str] = []
    if root and root in members:
        ordered.append(root)
    ordered.extend(name for name in sorted(members) if name not in ordered)

    rules: List[CddlRule] = []
    description: Optional[str] = None
    raw_parts: List[str] = []
    for name in ordered:
        text = members[name]
        _guard_size(text, source_label=name)
        tokens, comments = tokenize(text, source_label=name)
        parsed = _Parser(tokens, source_label=source_label, member=name).parse_rules()
        parsed, member_description = _attach_comments(parsed, comments)
        if description is None:
            description = member_description
        rules.extend(parsed)
        raw_parts.append(f"; --- {name} ---\n{text}")

    return build_document(
        rules=rules,
        limits=LimitRecorder(),
        members=tuple(ordered),
        description=description,
        raw="\n".join(raw_parts),
        source_label=source_label or root,
    )
