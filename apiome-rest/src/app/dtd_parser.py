"""DTD reader — FMT-4.2 (#5435).

Reads XML Document Type Definitions: an external subset (a ``.dtd`` file), an internal
subset (the ``<!DOCTYPE … [ … ]>`` carried inside an instance document), or a modular set
composed from both through parameter entities.

**A DTD is not XML, so no XML parser is used.** ``<!ELEMENT>``/``<!ATTLIST>`` declarations
are markup declarations, not elements, and :func:`app.secure_xml.parse_xml` refuses a
``DOCTYPE`` outright — correctly, since every sibling adapter reads element trees and has no
business expanding entities. This reader is therefore a hand-written scanner, which also
means the hardening cannot be inherited and has to be built in: the byte ceiling, the
content-model depth ceiling, and above all the :class:`~app.dtd_grammar.ExpansionBudget`
every entity reference is charged against.

**Parameter entities are read the way a DTD processor reads them: as an input stack.** A
``%name;`` reference pushes the entity's replacement text onto the scanner's stack, and
scanning continues inside it — so a parameter entity works wherever the grammar allows one
(as a whole declaration, as an attribute set inside an ``<!ATTLIST>``, as a fragment of a
content model), and a module pulled in by ``<!ENTITY % m SYSTEM "m.dtd"> %m;`` composes
exactly as it does in DocBook, JATS and TEI. The stack is what makes the budget effective:
its depth is the expansion depth, and an entity already on it is a recursion, refused rather
than unrolled.

**Nothing external is ever fetched.** A relative system identifier resolves against the
fileset's members; an absolute one is vetted for shape against the SSRF policy and then
*recorded*, never retrieved. That is the classic XXE and blind-XXE shape, and it fails
closed here.

**One documented limitation.** A multi-character delimiter is matched within a single input,
so a token that straddles an entity boundary — a comment opened in a parameter entity's
replacement text and closed in the document, say — is not recognized across the seam. XML
requires markup to be contained within one entity, so such a document is already invalid;
it fails as a syntax or truncation error rather than being read as intended.
"""

from __future__ import annotations

from typing import Dict, List, Mapping, Optional, Tuple

from .dtd_grammar import (
    MAX_DECLARED_ENTITIES,
    MAX_DTD_BYTES,
    MAX_MODEL_DEPTH,
    AttributeDefault,
    AttributeType,
    ContentKind,
    DtdAttribute,
    DtdDocument,
    DtdElement,
    DtdEntity,
    DtdNotation,
    DtdParseError,
    DtdParticle,
    ExpansionBudget,
    LimitRecorder,
    Occurrence,
    build_document,
    resolve_system_id,
)

__all__ = [
    "DTD_SUFFIXES",
    "is_dtd",
    "is_internal_subset",
    "parse_dtd",
    "parse_dtd_fileset",
]

#: File extensions a DTD is written with. ``.ent`` and ``.mod`` are the conventional
#: suffixes for the entity and module files a large DTD is assembled from.
DTD_SUFFIXES: Tuple[str, ...] = (".dtd", ".ent", ".mod")

#: The markup declarations a standalone DTD may open with.
_DECLARATION_STARTS: Tuple[str, ...] = ("<!ELEMENT", "<!ATTLIST", "<!ENTITY", "<!NOTATION")

_WHITESPACE = " \t\r\n"

#: The tokenized and identity attribute types, re-exported from the algebra for the
#: type-word lookup below.
#: The five entities XML predefines. A document need not declare them, so they are resolved
#: before the declaration tables are consulted — otherwise a legal `"AT&amp;T"` attribute
#: default would fail as an unresolved reference.
_PREDEFINED_ENTITIES: Dict[str, str] = {
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
}

_ATTRIBUTE_TYPE_WORDS: Dict[str, AttributeType] = {
    "CDATA": AttributeType.CDATA,
    "ID": AttributeType.ID,
    "IDREF": AttributeType.IDREF,
    "IDREFS": AttributeType.IDREFS,
    "ENTITY": AttributeType.ENTITY,
    "ENTITIES": AttributeType.ENTITIES,
    "NMTOKEN": AttributeType.NMTOKEN,
    "NMTOKENS": AttributeType.NMTOKENS,
}


def _is_name_start(char: str) -> bool:
    """Return whether ``char`` may start an XML name."""
    return char.isalpha() or char in "_:" or ord(char) > 127


def _is_name_char(char: str) -> bool:
    """Return whether ``char`` may continue an XML name."""
    return char.isalnum() or char in "._-:·" or ord(char) > 127


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def _after_prolog(text: str) -> str:
    """Return ``text`` with any leading whitespace, XML declaration and comments removed.

    Args:
        text: The document text.

    Returns:
        The remainder, starting at the first construct that is neither a comment nor a
        processing instruction.
    """
    index = 0
    length = len(text)
    while index < length:
        while index < length and text[index] in _WHITESPACE:
            index += 1
        if text.startswith("<!--", index):
            end = text.find("-->", index + 4)
            if end < 0:
                return text[index:]
            index = end + 3
            continue
        if text.startswith("<?", index):
            end = text.find("?>", index + 2)
            if end < 0:
                return text[index:]
            index = end + 2
            continue
        break
    return text[index:]


def _internal_subset(text: str) -> Optional[str]:
    """Return the internal subset of a ``<!DOCTYPE … [ … ]>``, if the text carries one.

    The closing ``]`` is found with awareness of comments and quoted literals, so a ``]``
    inside either does not end the subset early.

    Args:
        text: The document text.

    Returns:
        The subset's text, or ``None`` when there is no ``DOCTYPE`` or it has no subset.
    """
    body = _after_prolog(text)
    if not body.startswith("<!DOCTYPE"):
        return None
    start = body.find("[")
    end_of_declaration = body.find(">")
    if start < 0 or (0 <= end_of_declaration < start):
        return None
    index = start + 1
    length = len(body)
    while index < length:
        char = body[index]
        if char == "]":
            return body[start + 1 : index]
        if body.startswith("<!--", index):
            closing = body.find("-->", index + 4)
            index = length if closing < 0 else closing + 3
            continue
        if char in "\"'":
            closing = body.find(char, index + 1)
            index = length if closing < 0 else closing + 1
            continue
        index += 1
    return None


def is_dtd(text: str) -> bool:
    """Return whether ``text`` looks like a DTD this reader should claim.

    Two shapes qualify, and both are deliberately narrow so the sniffer does not claim
    every XML document that happens to carry a ``DOCTYPE``:

    * the document *is* a DTD — its first construct is a markup declaration; or
    * the document carries an internal subset that declares at least one element.

    Requiring ``<!ELEMENT`` in the second case is what keeps this adapter away from the
    entity-only ``DOCTYPE`` a hostile XSD, WSDL or ISO 20022 message uses to smuggle an
    expansion bomb: those documents belong to their own adapters, whose hardened XML
    readers reject them, and a DTD reader claiming them would move the rejection to the
    wrong place.

    Args:
        text: The candidate document text.

    Returns:
        ``True`` when the text should be read as a DTD.
    """
    if not text or not text.strip():
        return False
    body = _after_prolog(text)
    if body.startswith(_DECLARATION_STARTS):
        return True
    if body.startswith("<!["):
        keyword = body[3:].lstrip()
        if keyword.startswith(("INCLUDE", "IGNORE", "%")):
            return True
    subset = _internal_subset(text)
    return subset is not None and "<!ELEMENT" in subset


def is_internal_subset(text: str) -> bool:
    """Return whether the DTD travels *inside* an instance document.

    The two placements a DTD is written in are the two detection reasons the adapter
    reports, so the distinction is drawn here — off the same prolog skip :func:`is_dtd`
    uses — rather than by a second, differently-worded string test at the call site.

    Args:
        text: The candidate document text.

    Returns:
        ``True`` for a ``<!DOCTYPE …>`` document, ``False`` for a standalone subset.
    """
    return _after_prolog(text).startswith("<!DOCTYPE")


# ---------------------------------------------------------------------------
# Scanner input stack
# ---------------------------------------------------------------------------


class _Input:
    """One text being scanned: the document itself, or an entity's replacement text."""

    __slots__ = ("text", "pos", "entity")

    def __init__(self, text: str, entity: Optional[str] = None) -> None:
        self.text = text
        self.pos = 0
        self.entity = entity

    @property
    def exhausted(self) -> bool:
        """Whether the whole text has been consumed."""
        return self.pos >= len(self.text)


class _Reader:
    """Reads one DTD — its declarations, its entities, and what it composes in.

    The reader owns the scanner's input stack, the expansion budget every reference is
    charged against, and the accumulating declaration tables. One instance reads one
    document (an internal subset and the external subset it names are read by the same
    instance, so their declarations merge under XML's first-declaration-wins rule).
    """

    def __init__(
        self,
        *,
        members: Mapping[str, str],
        base: Optional[str],
        source_label: Optional[str],
    ) -> None:
        self._members = members
        self._base = base
        self._source_label = source_label
        self._where = f" ({source_label})" if source_label else ""

        self.budget = ExpansionBudget()
        self.limits = LimitRecorder()

        self._stack: List[_Input] = []
        self._expand_parameters = True
        self._conditional_depth = 0

        self._models: List[Tuple[str, DtdParticle]] = []
        self._attlists: Dict[str, List[DtdAttribute]] = {}
        self._general: Dict[str, DtdEntity] = {}
        self._general_order: List[str] = []
        self._parameters: Dict[str, DtdEntity] = {}
        self._parameter_order: List[str] = []
        self._notations: Dict[str, DtdNotation] = {}
        self._notation_order: List[str] = []

        self.external_subsets: List[str] = []
        self.unresolved_system_ids: List[str] = []

    # -- errors ----------------------------------------------------------

    def _syntax(self, message: str) -> DtdParseError:
        """Return an unclassified syntax error.

        Leaving the code unset is deliberate: the pipeline classifies a code-less parse
        failure itself, which is what lets a UTF-16 file surface as an encoding fault and a
        misrouted document as a format mismatch rather than as malformed DTD markup.
        """
        return DtdParseError(f"{message}{self._where}")

    def _truncated(self, what: str) -> DtdParseError:
        """Return a truncation error: the input ended inside ``what``."""
        return DtdParseError(
            f"the DTD ends inside {what}{self._where}", code="INPUT_TRUNCATED"
        )

    # -- scanner ---------------------------------------------------------

    def _settle(self) -> None:
        """Pop exhausted inputs and expand any parameter-entity reference now current."""
        while True:
            while len(self._stack) > 1 and self._stack[-1].exhausted:
                self._pop()
            top = self._stack[-1]
            if top.exhausted or not self._expand_parameters:
                return
            if top.text[top.pos] != "%":
                return
            name = self._parameter_reference_at(top)
            if name is None:
                return
            top.pos += len(name) + 2
            self._push_parameter(name)

    @staticmethod
    def _parameter_reference_at(top: _Input) -> Optional[str]:
        """Return the entity name if ``top`` is positioned on a ``%Name;`` reference.

        Requiring the closing ``;`` is what distinguishes a reference from the ``%`` that
        introduces a parameter-entity *declaration* (``<!ENTITY % name …>``).
        """
        text = top.text
        index = top.pos + 1
        length = len(text)
        if index >= length or not _is_name_start(text[index]):
            return None
        end = index
        while end < length and _is_name_char(text[end]):
            end += 1
        if end >= length or text[end] != ";":
            return None
        return text[index:end]

    def _push_parameter(self, name: str) -> None:
        """Resolve ``%name;`` and push its replacement text onto the input stack.

        Args:
            name: The parameter entity's name.

        Raises:
            DtdParseError: ``INPUT_REFERENCE_UNRESOLVED`` if the entity was never declared
                or names a file the fileset does not contain, ``INPUT_UNSAFE_CONSTRUCT`` if
                its system identifier is one the SSRF policy forbids, or
                ``INPUT_EXPANSION_LIMIT`` if the budget is exhausted.
        """
        entity = self._parameters.get(name)
        if entity is None:
            raise DtdParseError(
                f"parameter entity '%{name};' is referenced but never declared{self._where}",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        if entity.system_id is not None:
            text = self._external_text(entity.system_id, kind=f"parameter entity '%{name};'")
        else:
            text = entity.value or ""
        self.budget.enter(f"%{name}")
        self.budget.charge_bytes(len(text))
        # XML pads a parameter entity's replacement text with spaces so it cannot fuse with
        # the tokens around it (`%a;%b;` must not read as one name).
        self._stack.append(_Input(f" {text} ", entity=f"%{name}"))

    def _pop(self) -> None:
        """Pop the innermost input, releasing its place in the expansion chain."""
        finished = self._stack.pop()
        if finished.entity is not None:
            self.budget.leave()

    def _external_text(self, system_id: str, *, kind: str) -> str:
        """Return the text an external system identifier resolves to.

        Args:
            system_id: The declared system identifier.
            kind: What is being resolved, for the error message.

        Returns:
            The member's text, or ``""`` for an absolute URL that was recorded rather than
            fetched.

        Raises:
            DtdParseError: ``INPUT_REFERENCE_UNRESOLVED`` when the identifier names nothing
                in the fileset.
        """
        resolved = resolve_system_id(
            system_id,
            members=self._members,
            base=self._base,
            limits=self.limits,
            recorded=self.unresolved_system_ids,
        )
        if resolved is None:
            if system_id in self.unresolved_system_ids:
                # A policy-legal absolute URL: recorded as a declared limit, never fetched.
                return ""
            raise DtdParseError(
                f"{kind} names {system_id!r}, which is not part of the uploaded set"
                f"{self._where}; upload the DTD together with the modules it includes "
                f"(for example as one .zip)",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        member, text = resolved
        if member not in self.external_subsets:
            self.external_subsets.append(member)
        return text

    def _eof(self) -> bool:
        """Whether every input has been consumed."""
        self._settle()
        return len(self._stack) == 1 and self._stack[0].exhausted

    def _peek(self, count: int = 1) -> str:
        """Return up to ``count`` characters at the scan position, without consuming."""
        self._settle()
        top = self._stack[-1]
        return top.text[top.pos : top.pos + count]

    def _advance(self, count: int = 1) -> str:
        """Consume and return up to ``count`` characters at the scan position."""
        self._settle()
        top = self._stack[-1]
        taken = top.text[top.pos : top.pos + count]
        top.pos += len(taken)
        return taken

    def _expect(self, char: str, *, inside: str) -> None:
        """Consume ``char``, or fail describing what was being read.

        Args:
            char: The character required here.
            inside: What is being read, for the error message.

        Raises:
            DtdParseError: Truncation at end of input, otherwise a syntax error.
        """
        found = self._peek()
        if found == char:
            self._advance()
            return
        if not found:
            raise self._truncated(inside)
        raise self._syntax(f"expected {char!r} in {inside}, found {found!r}")

    def _skip_space(self) -> None:
        """Skip whitespace, expanding parameter entities met along the way."""
        while True:
            char = self._peek()
            if char and char in _WHITESPACE:
                self._advance()
                continue
            return

    def _skip_misc(self) -> None:
        """Skip whitespace, comments and processing instructions between declarations."""
        while True:
            self._skip_space()
            if self._peek(4) == "<!--":
                self._advance(4)
                self._skip_verbatim("-->", inside="a comment")
                continue
            if self._peek(2) == "<?":
                self._advance(2)
                self._skip_verbatim("?>", inside="a processing instruction")
                continue
            return

    def _skip_verbatim(self, terminator: str, *, inside: str) -> None:
        """Consume characters up to and including ``terminator``, expanding nothing.

        Comments, processing instructions and ``IGNORE`` sections are *text*, not markup:
        a ``%name;`` inside one is not a reference, and expanding it would both corrupt the
        parse and let a comment spend the expansion budget. Every fixture that documents
        its own parameter entities in a leading comment depends on this.

        Args:
            terminator: The closing delimiter.
            inside: What is being skipped, for the truncation message.

        Raises:
            DtdParseError: ``INPUT_TRUNCATED`` if the input ends first.
        """
        self._expand_parameters = False
        try:
            while True:
                if self._peek(len(terminator)) == terminator:
                    self._advance(len(terminator))
                    return
                if not self._advance():
                    raise self._truncated(inside)
        finally:
            self._expand_parameters = True

    def _read_name(self, *, inside: str) -> str:
        """Read an XML name.

        Args:
            inside: What is being read, for the error message.

        Returns:
            The name.

        Raises:
            DtdParseError: If no name is present.
        """
        char = self._peek()
        if not char:
            raise self._truncated(inside)
        if not _is_name_start(char):
            raise self._syntax(f"expected a name in {inside}, found {char!r}")
        chars = [self._advance()]
        while True:
            char = self._peek()
            if not char or not _is_name_char(char):
                break
            chars.append(self._advance())
        return "".join(chars)

    def _read_nmtoken(self, *, inside: str) -> str:
        """Read a name token — like a name, but may start with a digit."""
        char = self._peek()
        if not char:
            raise self._truncated(inside)
        if not _is_name_char(char):
            raise self._syntax(f"expected a name token in {inside}, found {char!r}")
        chars: List[str] = []
        while True:
            char = self._peek()
            if not char or not _is_name_char(char):
                break
            chars.append(self._advance())
        return "".join(chars)

    def _read_literal(self, *, inside: str) -> str:
        """Read a quoted literal verbatim, without expanding anything inside it.

        Entity references inside a literal are expanded when the literal is *used*, not
        when it is read — which is what lets a parameter entity's replacement text carry
        references to entities declared after it, and what keeps expansion accounted for in
        one place.

        Args:
            inside: What is being read, for the error message.

        Returns:
            The literal's contents, without the quotes.

        Raises:
            DtdParseError: If the literal is unquoted or unterminated.
        """
        quote = self._peek()
        if not quote:
            raise self._truncated(inside)
        if quote not in "\"'":
            raise self._syntax(f"expected a quoted value in {inside}, found {quote!r}")
        self._advance()
        self._expand_parameters = False
        try:
            chars: List[str] = []
            while True:
                char = self._advance()
                if not char:
                    raise self._truncated(inside)
                if char == quote:
                    return "".join(chars)
                chars.append(char)
        finally:
            self._expand_parameters = True

    def _read_keyword(self, *, inside: str) -> str:
        """Read an upper-case declaration keyword (``ELEMENT``, ``SYSTEM``, ``NDATA``…)."""
        chars: List[str] = []
        while True:
            char = self._peek()
            if not char or not char.isalpha():
                break
            chars.append(self._advance())
        if not chars:
            raise self._syntax(f"expected a keyword in {inside}")
        return "".join(chars)

    # -- declarations ----------------------------------------------------

    def begin(self, text: str) -> None:
        """Point the scanner at ``text``, discarding any previous input stack.

        Args:
            text: The text to scan.
        """
        self._stack = [_Input(text)]

    def read(self, text: str) -> None:
        """Read every declaration in ``text`` into this reader's tables.

        Args:
            text: An external or internal subset.

        Raises:
            DtdParseError: On any syntax, semantic, reference or budget failure.
        """
        self.begin(text)
        while True:
            self._skip_misc()
            if self._eof():
                break
            if self._peek(3) == "]]>":
                if self._conditional_depth == 0:
                    raise self._syntax("']]>' outside a conditional section")
                self._advance(3)
                self._conditional_depth -= 1
                continue
            if self._peek(3) == "<![":
                self._read_conditional_section()
                continue
            if self._peek(2) != "<!":
                found = self._peek(20)
                raise self._syntax(
                    f"expected a markup declaration, found {found!r}"
                )
            self._advance(2)
            keyword = self._read_keyword(inside="a markup declaration")
            if keyword == "ELEMENT":
                self._read_element_declaration()
            elif keyword == "ATTLIST":
                self._read_attlist_declaration()
            elif keyword == "ENTITY":
                self._read_entity_declaration()
            elif keyword == "NOTATION":
                self._read_notation_declaration()
            else:
                raise self._syntax(f"unknown markup declaration '<!{keyword}'")
        if self._conditional_depth:
            raise self._truncated("a conditional section")

    def _read_conditional_section(self) -> None:
        """Read a ``<![INCLUDE[ … ]]>`` / ``<![IGNORE[ … ]]>`` section.

        The keyword is very often written as a parameter entity (``<![%draft;[ … ]]>``),
        which is how a DTD ships two profiles in one file; the input stack expands it before
        the keyword is read, so both spellings work.
        """
        self._advance(3)
        self._skip_space()
        keyword = self._read_keyword(inside="a conditional section")
        self._skip_space()
        self._expect("[", inside="a conditional section")
        if keyword == "INCLUDE":
            self._conditional_depth += 1
            return
        if keyword != "IGNORE":
            raise self._syntax(
                f"a conditional section must be INCLUDE or IGNORE, found {keyword!r}"
            )
        depth = 1
        self._expand_parameters = False
        try:
            while depth:
                if self._peek(3) == "<![":
                    self._advance(3)
                    depth += 1
                    continue
                if self._peek(3) == "]]>":
                    self._advance(3)
                    depth -= 1
                    continue
                if not self._advance():
                    raise self._truncated("an IGNORE section")
        finally:
            self._expand_parameters = True

    def _read_element_declaration(self) -> None:
        """Read ``<!ELEMENT Name contentspec >``."""
        self._skip_space()
        name = self._read_name(inside="an <!ELEMENT> declaration")
        self._skip_space()
        model = self._read_content_spec(owner=name)
        self._skip_space()
        self._expect(">", inside=f"the <!ELEMENT {name}> declaration")
        self._models.append((name, model))

    def _read_content_spec(self, *, owner: str) -> DtdParticle:
        """Read an element's content specification.

        Args:
            owner: The element being declared, for limit locations and errors.

        Returns:
            The content model.
        """
        char = self._peek()
        if not char:
            raise self._truncated(f"the <!ELEMENT {owner}> declaration")
        if char == "(":
            return self._read_group(owner=owner, depth=0)
        keyword = self._read_keyword(inside=f"the <!ELEMENT {owner}> content model")
        if keyword == "EMPTY":
            return DtdParticle(kind=ContentKind.EMPTY)
        if keyword == "ANY":
            self.limits.record("dtd.any_content", location=owner)
            return DtdParticle(kind=ContentKind.ANY)
        raise self._syntax(
            f"the <!ELEMENT {owner}> content model must be EMPTY, ANY or a group, "
            f"found {keyword!r}"
        )

    def _read_group(self, *, owner: str, depth: int) -> DtdParticle:
        """Read a parenthesized content-model group.

        The XML grammar keeps mixed content in a separate production that requires
        ``#PCDATA`` first. Real DTDs — including ones assembled from parameter-entity
        fragments, where the author cannot control the order — write it elsewhere in the
        choice, so this reader parses one general group and decides afterwards: a group
        containing ``#PCDATA`` anywhere *is* mixed content.

        Args:
            owner: The element being declared.
            depth: Current parenthesis nesting, bounded by
                :data:`~app.dtd_grammar.MAX_MODEL_DEPTH`.

        Returns:
            The group's particle.
        """
        if depth >= MAX_MODEL_DEPTH:
            raise DtdParseError(
                f"the content model of {owner!r} nests deeper than the "
                f"{MAX_MODEL_DEPTH}-level limit{self._where}",
                code="INPUT_DEPTH_LIMIT",
            )
        inside = f"the <!ELEMENT {owner}> content model"
        self._expect("(", inside=inside)
        children: List[DtdParticle] = []
        separator: Optional[str] = None
        has_pcdata = False
        while True:
            self._skip_space()
            char = self._peek()
            if not char:
                raise self._truncated(inside)
            if char == "#":
                self._advance()
                keyword = self._read_keyword(inside=inside)
                if keyword != "PCDATA":
                    raise self._syntax(f"expected '#PCDATA' in {inside}, found '#{keyword}'")
                has_pcdata = True
            elif char == "(":
                children.append(self._read_group(owner=owner, depth=depth + 1))
            else:
                child_name = self._read_name(inside=inside)
                children.append(
                    DtdParticle(
                        kind=ContentKind.NAME,
                        name=child_name,
                        occurrence=self._read_occurrence(),
                    )
                )
            self._skip_space()
            char = self._peek()
            if char in (",", "|"):
                self._advance()
                if separator is None:
                    separator = char
                elif separator != char:
                    raise self._syntax(
                        f"{inside} mixes ',' and '|' in one group, which XML does not allow"
                    )
                continue
            if char == ")":
                self._advance()
                break
            if not char:
                raise self._truncated(inside)
            raise self._syntax(f"expected ',', '|' or ')' in {inside}, found {char!r}")

        occurrence = self._read_occurrence()
        if has_pcdata:
            names = tuple(
                dict.fromkeys(
                    name for child in children for name in child.element_names()
                )
            )
            if not names:
                # `(#PCDATA)` is text-only content, which the canonical model holds exactly
                # — it is not mixed content and must not be declared a limit.
                return DtdParticle(kind=ContentKind.PCDATA, occurrence=occurrence)
            self.limits.record("dtd.mixed_content", location=owner)
            return DtdParticle(
                kind=ContentKind.MIXED,
                children=tuple(
                    DtdParticle(kind=ContentKind.NAME, name=name) for name in names
                ),
                occurrence=occurrence,
            )
        if not children:
            raise self._syntax(f"{inside} is an empty group")
        kind = ContentKind.CHOICE if separator == "|" else ContentKind.SEQUENCE
        if len(children) > 1 and occurrence.repeated:
            self.limits.record("dtd.repeated_group", location=owner)
        return DtdParticle(kind=kind, children=tuple(children), occurrence=occurrence)

    def _read_occurrence(self) -> Occurrence:
        """Read an optional occurrence indicator (``?``, ``*``, ``+``)."""
        char = self._peek()
        if char == "?":
            self._advance()
            return Occurrence.OPTIONAL
        if char == "*":
            self._advance()
            return Occurrence.ZERO_OR_MORE
        if char == "+":
            self._advance()
            return Occurrence.ONE_OR_MORE
        return Occurrence.ONE

    def _read_attlist_declaration(self) -> None:
        """Read ``<!ATTLIST Name AttDef* >``.

        Several ``<!ATTLIST>`` declarations for one element are legal and common — a
        modular DTD adds attributes to an element declared in another module — so the
        definitions merge, and XML's rule that the *first* declaration of an attribute wins
        is what resolves a collision.
        """
        self._skip_space()
        element = self._read_name(inside="an <!ATTLIST> declaration")
        inside = f"the <!ATTLIST {element}> declaration"
        definitions = self._attlists.setdefault(element, [])
        declared = {definition.name for definition in definitions}
        while True:
            self._skip_space()
            char = self._peek()
            if char == ">":
                self._advance()
                return
            if not char:
                raise self._truncated(inside)
            name = self._read_name(inside=inside)
            self._skip_space()
            attribute_type, enumeration = self._read_attribute_type(
                element=element, attribute=name, inside=inside
            )
            self._skip_space()
            default, default_value = self._read_attribute_default(inside=inside)
            if name in declared:
                continue
            declared.add(name)
            definitions.append(
                DtdAttribute(
                    name=name,
                    type=attribute_type,
                    enumeration=enumeration,
                    default=default,
                    default_value=default_value,
                    element=element,
                )
            )

    def _read_attribute_type(
        self, *, element: str, attribute: str, inside: str
    ) -> Tuple[AttributeType, Tuple[str, ...]]:
        """Read an attribute's declared type.

        Returns:
            The type and, for enumerations and ``NOTATION`` types, its permitted values.
        """
        if self._peek() == "(":
            return AttributeType.ENUMERATION, self._read_enumeration(inside=inside)
        keyword = self._read_keyword(inside=inside)
        if keyword == "NOTATION":
            self._skip_space()
            return AttributeType.NOTATION, self._read_enumeration(inside=inside)
        resolved = _ATTRIBUTE_TYPE_WORDS.get(keyword)
        if resolved is None:
            raise self._syntax(
                f"{keyword!r} is not an attribute type for {attribute!r} in {inside}"
            )
        if resolved in (AttributeType.ID, AttributeType.IDREF, AttributeType.IDREFS):
            self.limits.record("dtd.id_uniqueness", location=element)
        if resolved in (
            AttributeType.IDREFS,
            AttributeType.ENTITIES,
            AttributeType.NMTOKENS,
        ):
            self.limits.record("dtd.tokenized_attribute", location=element)
        return resolved, ()

    def _read_enumeration(self, *, inside: str) -> Tuple[str, ...]:
        """Read a ``( a | b | c )`` enumeration."""
        self._expect("(", inside=inside)
        values: List[str] = []
        while True:
            self._skip_space()
            values.append(self._read_nmtoken(inside=inside))
            self._skip_space()
            char = self._peek()
            if char == "|":
                self._advance()
                continue
            if char == ")":
                self._advance()
                return tuple(values)
            if not char:
                raise self._truncated(inside)
            raise self._syntax(f"expected '|' or ')' in an enumeration in {inside}")

    def _read_attribute_default(
        self, *, inside: str
    ) -> Tuple[AttributeDefault, Optional[str]]:
        """Read an attribute's default declaration."""
        char = self._peek()
        if not char:
            raise self._truncated(inside)
        if char == "#":
            self._advance()
            keyword = self._read_keyword(inside=inside)
            if keyword == "REQUIRED":
                return AttributeDefault.REQUIRED, None
            if keyword == "IMPLIED":
                return AttributeDefault.IMPLIED, None
            if keyword == "FIXED":
                self._skip_space()
                return AttributeDefault.FIXED, self._attribute_value(inside=inside)
            raise self._syntax(f"'#{keyword}' is not an attribute default in {inside}")
        return AttributeDefault.DEFAULT, self._attribute_value(inside=inside)

    def _attribute_value(self, *, inside: str) -> str:
        """Read a default attribute value, expanding the entity references inside it."""
        return self._expand(self._read_literal(inside=inside), general_only=True)

    def _read_entity_declaration(self) -> None:
        """Read ``<!ENTITY [%] Name (EntityValue | ExternalID NDataDecl?) >``."""
        self._skip_space()
        parameter = self._peek() == "%"
        if parameter:
            self._advance()
            self._skip_space()
        inside = "an <!ENTITY> declaration"
        name = self._read_name(inside=inside)
        inside = f"the <!ENTITY {'% ' if parameter else ''}{name}> declaration"
        self._skip_space()
        char = self._peek()
        if not char:
            raise self._truncated(inside)

        if char in "\"'":
            entity = DtdEntity(
                name=name, parameter=parameter, value=self._read_literal(inside=inside)
            )
        else:
            public_id, system_id = self._read_external_id(inside=inside)
            notation: Optional[str] = None
            self._skip_space()
            if self._peek().isalpha():
                keyword = self._read_keyword(inside=inside)
                if keyword != "NDATA":
                    raise self._syntax(f"expected 'NDATA' in {inside}, found {keyword!r}")
                self._skip_space()
                notation = self._read_name(inside=inside)
                self.limits.record("dtd.unparsed_entity", location=name)
            entity = DtdEntity(
                name=name,
                parameter=parameter,
                system_id=system_id,
                public_id=public_id,
                notation=notation,
            )
        self._skip_space()
        self._expect(">", inside=inside)

        table = self._parameters if parameter else self._general
        order = self._parameter_order if parameter else self._general_order
        if len(self._parameters) + len(self._general) >= MAX_DECLARED_ENTITIES:
            raise DtdParseError(
                f"the DTD declares more than {MAX_DECLARED_ENTITIES} entities"
                f"{self._where}",
                code="INPUT_ENTITY_LIMIT",
            )
        # XML: the first declaration of an entity is binding; a later one is not an error.
        if name not in table:
            table[name] = entity
            order.append(name)

    def _read_external_id(self, *, inside: str) -> Tuple[Optional[str], str]:
        """Read a ``SYSTEM``/``PUBLIC`` external identifier.

        Returns:
            The public identifier (or ``None``) and the system identifier.
        """
        keyword = self._read_keyword(inside=inside)
        if keyword == "SYSTEM":
            self._skip_space()
            return None, self._read_literal(inside=inside)
        if keyword == "PUBLIC":
            self._skip_space()
            public_id = self._read_literal(inside=inside)
            self._skip_space()
            return public_id, self._read_literal(inside=inside)
        raise self._syntax(
            f"expected 'SYSTEM' or 'PUBLIC' in {inside}, found {keyword!r}"
        )

    def _read_notation_declaration(self) -> None:
        """Read ``<!NOTATION Name (ExternalID | PublicID) >``."""
        self._skip_space()
        name = self._read_name(inside="a <!NOTATION> declaration")
        inside = f"the <!NOTATION {name}> declaration"
        self._skip_space()
        public_id, system_id = self._read_external_id(inside=inside)
        self._skip_space()
        self._expect(">", inside=inside)
        if name not in self._notations:
            self._notations[name] = DtdNotation(
                name=name, system_id=system_id, public_id=public_id
            )
            self._notation_order.append(name)

    # -- entity value expansion ------------------------------------------

    def _expand(self, text: str, *, general_only: bool = False) -> str:
        """Expand the entity references inside a replacement text.

        Every reference is charged against the same budget the input stack uses, and the
        budget's active chain is what refuses recursion — so a value that expands to itself
        fails here exactly as a recursive parameter entity fails in the scanner.

        Args:
            text: The raw replacement text.
            general_only: Expand only ``&name;`` references, leaving ``%name;`` alone. Used
                for attribute default values, where a parameter entity has no meaning.

        Returns:
            The expanded text.

        Raises:
            DtdParseError: On recursion, an unresolved reference, or a budget breach.
        """
        out: List[str] = []
        index = 0
        length = len(text)
        while index < length:
            char = text[index]
            if char == "&" and index + 1 < length and text[index + 1] == "#":
                decoded, index = self._character_reference(text, index)
                out.append(decoded)
                continue
            if char in ("&", "%") and not (general_only and char == "%"):
                name, end = _reference_name(text, index)
                if name is None:
                    out.append(char)
                    index += 1
                    continue
                out.append(self._expand_named(char, name))
                index = end
                continue
            out.append(char)
            index += 1
        return "".join(out)

    def _expand_named(self, sigil: str, name: str) -> str:
        """Expand one ``&name;`` / ``%name;`` reference met inside a replacement text."""
        key = f"{sigil}{name}"
        if sigil == "&" and name in _PREDEFINED_ENTITIES:
            return _PREDEFINED_ENTITIES[name]
        table = self._general if sigil == "&" else self._parameters
        entity = table.get(name)
        if entity is None:
            raise DtdParseError(
                f"entity '{key};' is referenced but never declared{self._where}",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        if entity.unparsed:
            raise DtdParseError(
                f"unparsed entity '{key};' cannot be referenced as text{self._where}",
                code="INPUT_SEMANTIC_INVALID",
            )
        if entity.system_id is not None:
            text = self._external_text(entity.system_id, kind=f"entity '{key};'")
        else:
            text = entity.value or ""
        self.budget.enter(key)
        try:
            expanded = self._expand(text)
        finally:
            self.budget.leave()
        self.budget.charge_bytes(len(expanded))
        return expanded

    def _character_reference(self, text: str, index: int) -> Tuple[str, int]:
        """Decode a ``&#123;`` / ``&#x1F;`` character reference starting at ``index``."""
        end = text.find(";", index)
        if end < 0:
            return text[index], index + 1
        body = text[index + 2 : end]
        try:
            code_point = int(body[1:], 16) if body[:1].lower() == "x" else int(body)
            return chr(code_point), end + 1
        except (ValueError, OverflowError):
            return text[index], index + 1

    # -- assembly --------------------------------------------------------

    def document(self, *, name: Optional[str], raw: str) -> DtdDocument:
        """Expand what is left to expand and assemble the parsed document.

        General entities are expanded here rather than when they are declared, so a forward
        reference resolves — and so an expansion bomb is charged against the same budget as
        everything else, and fails the import instead of being carried into the model.

        Args:
            name: The ``<!DOCTYPE>`` name, when there was one.
            raw: The source text, for the fidelity bag.

        Returns:
            The assembled document.
        """
        general: List[DtdEntity] = []
        for entity_name in self._general_order:
            entity = self._general[entity_name]
            if entity.value is not None:
                expanded = self._expand(entity.value)
                self.budget.charge_bytes(len(expanded))
                entity = DtdEntity(
                    name=entity.name,
                    parameter=False,
                    value=expanded,
                    system_id=entity.system_id,
                    public_id=entity.public_id,
                    notation=entity.notation,
                )
            general.append(entity)

        declared_names = {element_name for element_name, _ in self._models}
        elements = [
            DtdElement(
                name=element_name,
                content=model,
                attributes=tuple(self._attlists.get(element_name, ())),
            )
            for element_name, model in self._models
        ]
        orphans: Dict[str, Tuple[DtdAttribute, ...]] = {}
        for element_name, definitions in self._attlists.items():
            if element_name not in declared_names:
                orphans[element_name] = tuple(definitions)
                self.limits.record("dtd.orphan_attlist", location=element_name)

        return build_document(
            name=name,
            elements=elements,
            entities=general,
            parameter_entities=[self._parameters[key] for key in self._parameter_order],
            notations=[self._notations[key] for key in self._notation_order],
            orphan_attlists=orphans,
            external_subsets=self.external_subsets,
            unresolved_system_ids=self.unresolved_system_ids,
            limits=self.limits,
            expansions=self.budget.expansions,
            raw=raw,
            source_label=self._source_label,
        )


def _reference_name(text: str, index: int) -> Tuple[Optional[str], int]:
    """Return the entity name a reference at ``index`` names, and the index after it.

    Args:
        text: The text being scanned.
        index: Position of the ``&`` or ``%`` sigil.

    Returns:
        ``(name, end)``, or ``(None, index)`` when the sigil does not open a reference.
    """
    cursor = index + 1
    length = len(text)
    if cursor >= length or not _is_name_start(text[cursor]):
        return None, index
    end = cursor
    while end < length and _is_name_char(text[end]):
        end += 1
    if end >= length or text[end] != ";":
        return None, index
    return text[cursor:end], end + 1


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def _split_doctype(text: str, *, source_label: Optional[str]) -> Tuple[Optional[str], str, Optional[str]]:
    """Split a document into its ``DOCTYPE`` name, internal subset and external identifier.

    Args:
        text: The document text.
        source_label: The document's name, for error messages.

    Returns:
        ``(doctype_name, internal_subset, external_system_id)``. A standalone DTD returns
        ``(None, text, None)`` — the whole file *is* the external subset.

    Raises:
        DtdParseError: If a ``DOCTYPE`` is present but malformed.
    """
    body = _after_prolog(text)
    if not body.startswith("<!DOCTYPE"):
        return None, text, None

    where = f" ({source_label})" if source_label else ""
    header_reader = _Reader(members={}, base=None, source_label=source_label)
    header_reader.begin(body[len("<!DOCTYPE") :])
    header_reader._skip_space()
    name = header_reader._read_name(inside="the <!DOCTYPE> declaration")
    header_reader._skip_space()
    system_id: Optional[str] = None
    if header_reader._peek().isalpha():
        _, system_id = header_reader._read_external_id(inside="the <!DOCTYPE> declaration")
        header_reader._skip_space()
    subset = _internal_subset(text)
    if subset is None:
        if header_reader._peek() == "[":
            raise DtdParseError(
                f"the <!DOCTYPE {name}> internal subset is not closed{where}",
                code="INPUT_TRUNCATED",
            )
        subset = ""
    return name, subset, system_id


def _read_document(
    text: str,
    *,
    members: Mapping[str, str],
    base: Optional[str],
    source_label: Optional[str],
) -> DtdDocument:
    """Read one DTD document — the shared body of both public entry points."""
    size = len(text.encode("utf-8", errors="replace"))
    if size > MAX_DTD_BYTES:
        where = f" ({source_label})" if source_label else ""
        raise DtdParseError(
            f"the DTD is too large{where}: {size} bytes exceeds the "
            f"{MAX_DTD_BYTES}-byte limit",
            code="INPUT_TOO_LARGE",
        )
    if not text.strip():
        raise DtdParseError(
            f"the DTD is empty{f' ({source_label})' if source_label else ''}",
            code="INPUT_EMPTY",
        )

    name, subset, system_id = _split_doctype(text, source_label=source_label)
    reader = _Reader(members=members, base=base, source_label=source_label)
    if subset.strip():
        reader.read(subset)
    if system_id is not None:
        # XML reads the internal subset first, so its declarations already bind; the
        # external subset then contributes everything the instance did not override.
        external = reader._external_text(system_id, kind="the <!DOCTYPE> external subset")
        if external.strip():
            reader.read(external)
    return reader.document(name=name, raw=text)


def parse_dtd(raw: str, *, source_label: Optional[str] = None) -> DtdDocument:
    """Parse one DTD document.

    Args:
        raw: The DTD text — an external subset, or an instance document whose
            ``<!DOCTYPE>`` carries an internal subset.
        source_label: The document's name, for error messages.

    Returns:
        The parsed :class:`~app.dtd_grammar.DtdDocument`.

    Raises:
        DtdParseError: With an intake-taxonomy code when the reader can classify the
            failure, and without one when the pipeline should classify it.
    """
    return _read_document(raw, members={}, base=source_label, source_label=source_label)


def parse_dtd_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> DtdDocument:
    """Parse a modular DTD, resolving its modules across a fileset.

    Args:
        members: Fileset member name -> text.
        root: The member the set is rooted at.
        source_label: Fallback label for error messages.

    Returns:
        The composed document.

    Raises:
        DtdParseError: If the root is missing, a module cannot be resolved, or any
            per-document guard fires.
    """
    if root not in members:
        raise DtdParseError(
            f"DTD fileset is missing its root document {root!r}",
            code="INPUT_SEMANTIC_INVALID",
        )
    total = sum(len(text.encode("utf-8", errors="replace")) for text in members.values())
    if total > MAX_DTD_BYTES:
        raise DtdParseError(
            f"the DTD set is too large: {total} bytes exceeds the "
            f"{MAX_DTD_BYTES}-byte limit",
            code="INPUT_TOO_LARGE",
        )
    return _read_document(
        members[root], members=members, base=root, source_label=source_label or root
    )
