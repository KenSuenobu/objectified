"""RELAX NG reader — XML syntax, with fileset composition (FMT-4.1, #5434).

Apiome reads XSD and calls that "XML schema support". RELAX NG is the other half: the
schema language of DocBook, TEI, OpenDocument and a large body of publishing and
government document standards. This module reads its **XML syntax** (``.rng``) and
delegates the **compact syntax** (``.rnc``) to :mod:`app.relaxng_compact`, so
:func:`parse_relaxng` is the one entry point either spelling arrives at.

Both front-ends produce the pattern algebra in :mod:`app.relaxng_grammar`, which is what
makes the ticket's first acceptance criterion structural rather than aspirational: the
same grammar written either way lands on the same AST and therefore on the same canonical
model.

**Composition lives here for both syntaxes.** Each front-end reads one *file* into a
:class:`~app.relaxng_grammar.RelaxNgComponents`; this module then resolves what that file
composes — ``include`` merges another grammar's named patterns (minus any the including
grammar overrides inside the directive) and ``externalRef`` substitutes another grammar's
pattern in place, under its own definition scope. Both resolve against the intake
fileset's members through :func:`app.relaxng_grammar.resolve_href`, the same plumbing
shape the XSD reader uses for ``xs:import``/``xs:include``. Because the composer is
syntax-agnostic, a ``.rnc`` grammar including a ``.rng`` module (or the reverse) composes
by the same rules as a single-syntax set.

**Remote references are never fetched** — see :func:`app.relaxng_grammar.resolve_href`: an
absolute URL is vetted for shape against the SSRF policy and then *recorded*, never
retrieved. Import does not reach the network, so a grammar cannot make this service fetch
a URL of its author's choosing.

**Security.** Parsing goes through :mod:`app.secure_xml` — no DTD, no entity expansion, no
external references, bounded size and depth — like every other XML adapter here. (The
ticket's stack line names ``lxml``; the hardened stdlib seam is used instead, because an
lxml parse would need its own DTD/entity/external-reference hardening rather than
inheriting the one every sibling adapter already shares.)
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import List, Mapping, Optional, Sequence, Tuple

from .relaxng_grammar import (
    RELAXNG_ANNOTATIONS_NS,
    RELAXNG_NS,
    XSD_DATATYPES_LIBRARY,
    LimitRecorder,
    NameClassKind,
    PatternKind,
    RelaxNgComponents,
    RelaxNgDocument,
    RelaxNgInclude,
    RelaxNgNameClass,
    RelaxNgParseError,
    RelaxNgPattern,
    build_document,
    merged_start,
    resolve_href,
)
from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "RELAXNG_COMPACT_SUFFIXES",
    "RELAXNG_XML_SUFFIXES",
    "RelaxNgParseError",
    "is_relaxng",
    "is_relaxng_compact",
    "parse_relaxng",
    "parse_relaxng_fileset",
]

#: File suffixes that carry the XML syntax.
RELAXNG_XML_SUFFIXES = (".rng",)

#: File suffixes that carry the compact syntax.
RELAXNG_COMPACT_SUFFIXES = (".rnc",)

#: Patterns that take an ordered list of sub-patterns and nothing else.
_COMPOSITE_KINDS = {
    "group": PatternKind.GROUP,
    "interleave": PatternKind.INTERLEAVE,
    "choice": PatternKind.CHOICE,
    "optional": PatternKind.OPTIONAL,
    "zeroOrMore": PatternKind.ZERO_OR_MORE,
    "oneOrMore": PatternKind.ONE_OR_MORE,
    "list": PatternKind.LIST,
    "mixed": PatternKind.MIXED,
}

#: Patterns with no children at all.
_ATOMIC_KINDS = {
    "empty": PatternKind.EMPTY,
    "text": PatternKind.TEXT,
    "notAllowed": PatternKind.NOT_ALLOWED,
}

#: The maximum depth of ``include``/``externalRef`` composition followed before the reader
#: declares a cycle. RELAX NG grammars nest a handful of modules deep; a set that reaches
#: this is referencing itself, directly or through a ring.
MAX_COMPOSITION_DEPTH = 16


@dataclass
class _ReadContext:
    """Mutable state a single grammar read accumulates.

    Threaded through the pattern walk instead of being returned from it, because two of the
    three things a walk produces — the declared limits it met, and the definitions a nested
    ``grammar`` pattern contributes — belong to the *document* rather than to the pattern
    the walker happens to be returning.

    Attributes:
        limits: Recorder for constructs parsed but not canonically expressible.
        nested: ``(name, pattern, combine)`` declarations contributed by nested ``grammar``
            patterns, already scope-prefixed so they cannot collide with the host grammar's
            own names.
        scopes: How many nested scopes have been opened, which is what makes each prefix
            unique.
    """

    limits: LimitRecorder
    nested: List[Tuple[str, RelaxNgPattern, Optional[str]]] = field(default_factory=list)
    scopes: int = 0

    def next_scope(self, label: str) -> str:
        """Return a fresh, stable prefix for a nested or externally referenced grammar.

        Args:
            label: A short human-readable origin (``grammar``, or the ``href``).

        Returns:
            The prefix to prepend to every name that grammar defines.
        """
        self.scopes += 1
        return f"{label}#{self.scopes}."


# ===========================================================================
# Sniffing
# ===========================================================================


#: A compact-syntax ``start`` assignment (``start = …`` / ``start |= …`` / ``start &= …``).
_COMPACT_START_RE = re.compile(r"(?m)^\s*start\s*[|&]?=")

#: A compact-syntax ``element NAME {`` / ``attribute NAME {`` production at the head of a
#: line, optionally preceded by the named-pattern assignment that introduces it. Anchored on
#: purpose: ``element`` and ``attribute`` are ordinary English words, and an unanchored
#: search for them would let this adapter claim prose.
_COMPACT_PATTERN_RE = re.compile(
    r"(?m)^\s*(?:\w[\w.-]*\s*[|&]?=\s*)?(?:element|attribute)\s+[\\\w*][\w.:*-]*\s*\{"
)

#: A compact-syntax declaration or keyword no other assignment-shaped schema language
#: writes. ``start = …`` on its own is *not* one: CDDL (RFC 8610) spells its entry rule the
#: same way, so a document whose only compact signal is that assignment needs corroboration
#: before this adapter claims it. See :func:`is_relaxng_compact`.
_COMPACT_CORROBORATION_RE = re.compile(
    r"(?m)^\s*(?:default\s+namespace|namespace|datatypes|include|div|grammar\s*\{)\b"
    r"|\b(?:element|attribute|notAllowed|externalRef|parentRef)\b"
)


def is_relaxng_compact(content: str) -> bool:
    """Return whether ``content`` looks like RELAX NG **compact** syntax.

    The compact syntax has no namespace and no root element to key on, so the sniff looks
    for an ``element NAME {`` / ``attribute NAME {`` production at the head of a line — the
    compact syntax lets a whole schema be a single pattern with no ``start``, so requiring a
    ``start`` assignment would leave that shape unreadable — or for a ``start`` assignment
    **together with** a construct only RELAX NG has. That corroboration is what keeps this
    adapter off a CDDL grammar (FMT-4.4, #5437), which spells its entry rule ``start = name``
    exactly the same way. Both are looked for outside comments, and any XML markup
    disqualifies the text outright.

    Args:
        content: The candidate text.

    Returns:
        ``True`` when the text is plausibly a ``.rnc`` grammar.
    """
    if not content or not isinstance(content, str):
        return False
    if "\x00" in content:
        # A UTF-16 payload decoded as UTF-8: not text this reader can sniff.
        return False
    body = "\n".join(line.split("#", 1)[0] for line in content.splitlines())
    if "<" in body and ">" in body:
        # An XML document (a `.rng`, an XSD, anything else) is not the compact syntax.
        return False
    if not body.strip():
        return False
    if _COMPACT_PATTERN_RE.search(body):
        return True
    if _COMPACT_START_RE.search(body):
        # `start = name` alone is ambiguous — CDDL spells its entry rule identically — so
        # the assignment claims a document only alongside a construct only RELAX NG has.
        return bool(_COMPACT_CORROBORATION_RE.search(body))
    return False


def is_relaxng(content: str) -> bool:
    """Return whether ``content`` looks like a RELAX NG grammar in either syntax.

    Sniffers must never raise (a hostile document reaching detection would otherwise fail
    every caller), so an unsafe or malformed document is simply "not RELAX NG" here and the
    parse phase reports the real reason.

    Args:
        content: The candidate text.

    Returns:
        ``True`` for a ``.rng`` document rooted at ``grammar``/``element`` in the RELAX NG
        namespace, or for compact-syntax text.
    """
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if RELAXNG_NS in trimmed:
        # The namespace URI appears in a `.rng` document's own xmlns declaration. Parse to
        # confirm it is the *root* that lives there rather than a document quoting it.
        try:
            root = parse_xml(trimmed)
        except SecureXmlError:
            # A truncated or unsafe `.rng` still declares the namespace; claiming it lets
            # the parse phase report a malformed RELAX NG document rather than the intake
            # reporting a wrong-format upload.
            return True
        return _namespace(root.tag) == RELAXNG_NS and _local(root.tag) in ("grammar", "element")
    return is_relaxng_compact(trimmed)


# ===========================================================================
# XML helpers
# ===========================================================================


def _local(tag: str) -> str:
    """Return an ElementTree tag's local name."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _namespace(tag: str) -> str:
    """Return an ElementTree tag's namespace URI (empty when unqualified)."""
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def _relaxng_children(element: ET.Element) -> List[ET.Element]:
    """Return the element's children that live in the RELAX NG namespace."""
    return [
        child
        for child in element
        if isinstance(child.tag, str) and _namespace(child.tag) == RELAXNG_NS
    ]


def _documentation(element: ET.Element) -> Optional[str]:
    """Return the ``a:documentation`` text attached to ``element``, if any."""
    for child in element:
        if not isinstance(child.tag, str):
            continue
        if _namespace(child.tag) == RELAXNG_ANNOTATIONS_NS and _local(child.tag) == "documentation":
            text = (child.text or "").strip()
            if text:
                return " ".join(text.split())
    return None


def _inherited(element: ET.Element, attribute: str, inherited: Optional[str]) -> Optional[str]:
    """Return ``element``'s own value for an inheritable attribute, else the inherited one.

    ``ns`` and ``datatypeLibrary`` are inherited down the element tree in RELAX NG, so every
    walk carries the value in force rather than re-reading the root.
    """
    own = element.get(attribute)
    return own if own is not None else inherited


# ===========================================================================
# Name classes
# ===========================================================================


def _name_class(
    element: ET.Element,
    *,
    ns: Optional[str],
    ctx: "_ReadContext",
    location: str,
) -> RelaxNgNameClass:
    """Read the name class of an ``element``/``attribute`` pattern.

    A ``name`` attribute is the common shorthand; otherwise the first RELAX NG child is the
    name-class production (``name``, ``anyName``, ``nsName``, ``choice``).

    Args:
        element: The ``element``/``attribute`` pattern element.
        ns: The namespace URI in force.
        ctx: The read context (limit recorder, nested-grammar accumulator).
        location: The named pattern this sits under, for the limit's ``locations``.

    Returns:
        The name class.

    Raises:
        RelaxNgParseError: If the pattern declares no name and carries no name class.
    """
    literal = element.get("name")
    if literal is not None:
        return RelaxNgNameClass(kind=NameClassKind.NAME, name=literal.strip(), ns=ns)
    for child in _relaxng_children(element):
        local = _local(child.tag)
        if local in ("name", "anyName", "nsName", "choice"):
            return _read_name_class(child, ns=ns, ctx=ctx, location=location)
    raise RelaxNgParseError(
        f"`{_local(element.tag)}` pattern declares neither a name nor a name class",
        code="INPUT_SEMANTIC_INVALID",
    )


def _read_name_class(
    element: ET.Element,
    *,
    ns: Optional[str],
    ctx: "_ReadContext",
    location: str,
) -> RelaxNgNameClass:
    """Read one name-class production, recursing through ``choice`` and ``except``."""
    local = _local(element.tag)
    element_ns = _inherited(element, "ns", ns)
    if local == "name":
        return RelaxNgNameClass(
            kind=NameClassKind.NAME, name=(element.text or "").strip(), ns=element_ns
        )
    if local == "choice":
        return RelaxNgNameClass(
            kind=NameClassKind.CHOICE,
            alternatives=tuple(
                _read_name_class(child, ns=element_ns, ctx=ctx, location=location)
                for child in _relaxng_children(element)
                if _local(child.tag) != "except"
            ),
        )
    kind = NameClassKind.ANY_NAME if local == "anyName" else NameClassKind.NS_NAME
    ctx.limits.record("relaxng.name_class_wildcard", location=location)
    excepted: List[RelaxNgNameClass] = []
    for child in _relaxng_children(element):
        if _local(child.tag) != "except":
            continue
        excepted.extend(
            _read_name_class(grandchild, ns=element_ns, ctx=ctx, location=location)
            for grandchild in _relaxng_children(child)
        )
    return RelaxNgNameClass(
        kind=kind, ns=element_ns if kind is NameClassKind.NS_NAME else None,
        excepted=tuple(excepted),
    )


# ===========================================================================
# Patterns
# ===========================================================================


def _read_patterns(
    elements: Sequence[ET.Element],
    *,
    ns: Optional[str],
    datatype_library: Optional[str],
    ctx: "_ReadContext",
    location: str,
) -> List[RelaxNgPattern]:
    """Read a sequence of sibling pattern elements, skipping annotations."""
    read: List[RelaxNgPattern] = []
    for element in elements:
        local = _local(element.tag)
        if local in ("name", "anyName", "nsName", "except", "param"):
            continue
        read.append(
            _read_pattern(
                element,
                ns=ns,
                datatype_library=datatype_library,
                ctx=ctx,
                location=location,
            )
        )
    return read


def _sequenced(patterns: List[RelaxNgPattern]) -> RelaxNgPattern:
    """Collapse a sibling list into the one pattern the algebra says it is.

    RELAX NG treats several siblings inside ``element``/``attribute``/``define``/``start``
    as an implicit group, which the compact syntax writes explicitly as ``a, b``. Making it
    explicit here too is what keeps the two spellings of one grammar structurally
    identical; every consumer then sees exactly one body pattern.

    Args:
        patterns: The sibling patterns, in document order.

    Returns:
        The single pattern, a ``group`` of several, or ``empty`` for none.
    """
    if len(patterns) == 1:
        return patterns[0]
    if not patterns:
        # A content model with no pattern at all matches nothing but itself, which is what
        # `empty` means; the alternative would be an ill-formed zero-branch group.
        return RelaxNgPattern(kind=PatternKind.EMPTY)
    return RelaxNgPattern(kind=PatternKind.GROUP, children=tuple(patterns))


def _read_pattern(
    element: ET.Element,
    *,
    ns: Optional[str],
    datatype_library: Optional[str],
    ctx: "_ReadContext",
    location: str,
) -> RelaxNgPattern:
    """Read one pattern element and everything under it.

    Args:
        element: The pattern element.
        ns: The element namespace in force.
        datatype_library: The ``datatypeLibrary`` in force.
        ctx: The read context (limit recorder, nested-grammar accumulator).
        location: The named pattern this subtree sits under.

    Returns:
        The parsed pattern.

    Raises:
        RelaxNgParseError: On an unknown production or a pattern missing a required
            attribute.
    """
    local = _local(element.tag)
    element_ns = _inherited(element, "ns", ns)
    library = _inherited(element, "datatypeLibrary", datatype_library)
    documentation = _documentation(element)

    if local in _ATOMIC_KINDS:
        return RelaxNgPattern(kind=_ATOMIC_KINDS[local], documentation=documentation)

    if local in ("element", "attribute"):
        kind = PatternKind.ELEMENT if local == "element" else PatternKind.ATTRIBUTE
        # An attribute's name is unqualified unless it says otherwise, which is why the
        # inherited `ns` is not carried into an attribute's name class.
        name_ns = element_ns if kind is PatternKind.ELEMENT else element.get("ns")
        name_class = _name_class(element, ns=name_ns, ctx=ctx, location=location)
        children = _read_patterns(
            _relaxng_children(element),
            ns=element_ns,
            datatype_library=library,
            ctx=ctx,
            location=location,
        )
        return RelaxNgPattern(
            kind=kind,
            name_class=name_class,
            children=(_sequenced(children),),
            documentation=documentation,
        )

    if local in _COMPOSITE_KINDS:
        kind = _COMPOSITE_KINDS[local]
        if kind is PatternKind.INTERLEAVE:
            ctx.limits.record("relaxng.interleave", location=location)
        elif kind is PatternKind.LIST:
            ctx.limits.record("relaxng.list", location=location)
        elif kind is PatternKind.MIXED:
            ctx.limits.record("relaxng.mixed", location=location)
        children = _read_patterns(
            _relaxng_children(element),
            ns=element_ns,
            datatype_library=library,
            ctx=ctx,
            location=location,
        )
        return RelaxNgPattern(kind=kind, children=tuple(children), documentation=documentation)

    if local in ("ref", "parentRef"):
        name = (element.get("name") or "").strip()
        if not name:
            raise RelaxNgParseError(
                f"`{local}` pattern has no `name` attribute", code="INPUT_SEMANTIC_INVALID"
            )
        kind = PatternKind.REF if local == "ref" else PatternKind.PARENT_REF
        return RelaxNgPattern(kind=kind, ref_name=name, documentation=documentation)

    if local == "externalRef":
        href = (element.get("href") or "").strip()
        if not href:
            raise RelaxNgParseError(
                "`externalRef` has no `href` attribute", code="INPUT_SEMANTIC_INVALID"
            )
        return RelaxNgPattern(
            kind=PatternKind.EXTERNAL_REF, ref_name=href, documentation=documentation
        )

    if local == "value":
        # `datatypeLibrary` is meaningful on a `value` only when it names a `type`: an
        # untyped `<value>` is compared as the built-in `token` datatype whatever library
        # happens to be in force. Carrying the inherited library anyway would make the XML
        # spelling of a literal differ from the compact one, which has no library to inherit.
        value_type = element.get("type")
        return RelaxNgPattern(
            kind=PatternKind.VALUE,
            literal=(element.text or "").strip(),
            datatype=value_type,
            datatype_library=library if value_type else None,
            documentation=documentation,
        )

    if local == "data":
        if library and library != XSD_DATATYPES_LIBRARY:
            ctx.limits.record("relaxng.external_datatype_library", location=location)
        params = tuple(
            (child.get("name") or "", (child.text or "").strip())
            for child in _relaxng_children(element)
            if _local(child.tag) == "param" and child.get("name")
        )
        excepted: List[RelaxNgPattern] = []
        for child in _relaxng_children(element):
            if _local(child.tag) != "except":
                continue
            ctx.limits.record("relaxng.datatype_except", location=location)
            excepted.extend(
                _read_patterns(
                    _relaxng_children(child),
                    ns=element_ns,
                    datatype_library=library,
                    ctx=ctx,
                    location=location,
                )
            )
        return RelaxNgPattern(
            kind=PatternKind.DATA,
            datatype=element.get("type"),
            datatype_library=library,
            params=params,
            excepted=tuple(excepted),
            documentation=documentation,
        )

    if local == "grammar":
        # A nested `grammar` opens its own definition scope: a `ref` inside it names one of
        # *its* definitions, not the host grammar's. Rather than drop those definitions (a
        # silent omission that would then read as an unresolved reference), they are lifted
        # into the host's table under a unique prefix and every reference inside the
        # subtree is rewritten to match, so the scope survives flattening.
        prefix = ctx.next_scope("grammar")
        nested_start, nested_declarations = _read_grammar_body(
            element, ns=element_ns, datatype_library=library, ctx=ctx
        )
        ctx.nested.extend(
            (f"{prefix}{name}", _rescope(body, prefix=prefix), combine)
            for name, body, combine in nested_declarations
        )
        return _rescope(nested_start, prefix=prefix)

    raise RelaxNgParseError(
        f"unknown RELAX NG pattern `{local}`", code="INPUT_SEMANTIC_INVALID"
    )


# ===========================================================================
# Grammar bodies
# ===========================================================================


def _read_grammar_body(
    grammar: ET.Element,
    *,
    ns: Optional[str],
    datatype_library: Optional[str],
    ctx: "_ReadContext",
) -> Tuple[RelaxNgPattern, List[Tuple[str, RelaxNgPattern, Optional[str]]]]:
    """Read a ``grammar`` element's ``start`` and ``define`` declarations.

    ``include`` elements are **not** expanded here; :func:`_compose` does that, because
    expansion needs the fileset the grammar was supplied with.

    Args:
        grammar: The ``grammar`` element.
        ns: The element namespace in force.
        datatype_library: The ``datatypeLibrary`` in force.
        ctx: The read context (limit recorder, nested-grammar accumulator).

    Returns:
        ``(start_pattern, define_declarations)``. ``start_pattern`` is ``notAllowed`` when
        the grammar declares no ``start`` — the caller decides whether that is an error
        (a root grammar) or expected (an included module whose start is overridden).
    """
    starts: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
    declarations: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
    for child in _relaxng_children(grammar):
        local = _local(child.tag)
        child_ns = _inherited(child, "ns", ns)
        child_library = _inherited(child, "datatypeLibrary", datatype_library)
        if local == "start":
            patterns = _read_patterns(
                _relaxng_children(child),
                ns=child_ns,
                datatype_library=child_library,
                ctx=ctx,
                location="start",
            )
            if not patterns:
                raise RelaxNgParseError(
                    "`start` declares no pattern", code="INPUT_SEMANTIC_INVALID"
                )
            starts.append(("start", _sequenced(patterns), child.get("combine")))
        elif local == "define":
            name = (child.get("name") or "").strip()
            if not name:
                raise RelaxNgParseError(
                    "`define` has no `name` attribute", code="INPUT_SEMANTIC_INVALID"
                )
            patterns = _read_patterns(
                _relaxng_children(child),
                ns=child_ns,
                datatype_library=child_library,
                ctx=ctx,
                location=name,
            )
            if not patterns:
                raise RelaxNgParseError(
                    f"`define` {name!r} declares no pattern", code="INPUT_SEMANTIC_INVALID"
                )
            declarations.append((name, _sequenced(patterns), child.get("combine")))
    return merged_start(starts), declarations


# ===========================================================================
# Scoping
# ===========================================================================


def _rescope(node: RelaxNgPattern, *, prefix: str) -> RelaxNgPattern:
    """Rewrite every ``ref`` inside ``node`` to live under ``prefix``.

    Used when a grammar with its own definition scope — an ``externalRef`` target or a
    nested ``grammar`` pattern — is flattened into the host grammar's single table. A
    ``parentRef`` deliberately keeps its name: it names the *enclosing* scope, which is the
    table being flattened into.

    Args:
        node: The pattern to rewrite.
        prefix: The scope prefix to prepend to every ``ref`` name.

    Returns:
        A rewritten copy; the input is untouched.
    """
    children = tuple(_rescope(child, prefix=prefix) for child in node.children)
    excepted = tuple(_rescope(child, prefix=prefix) for child in node.excepted)
    ref_name = node.ref_name
    if node.kind is PatternKind.REF and ref_name:
        ref_name = f"{prefix}{ref_name}"
    return RelaxNgPattern(
        kind=node.kind,
        name_class=node.name_class,
        ref_name=ref_name,
        datatype=node.datatype,
        datatype_library=node.datatype_library,
        params=node.params,
        literal=node.literal,
        children=children,
        excepted=excepted,
        documentation=node.documentation,
    )


# ===========================================================================
# Reading one source file into components
# ===========================================================================


def _parse_member(text: str, *, source_label: str) -> ET.Element:
    """Parse a fileset member as XML through the hardened parser.

    Args:
        text: The member's text.
        source_label: The member key, used in error messages.

    Returns:
        The parsed root element.

    Raises:
        RelaxNgParseError: If the member is not well-formed or is rejected by the guards.
    """
    try:
        return parse_xml(text, source_label=source_label)
    except SecureXmlError as exc:
        raise RelaxNgParseError(
            f"RELAX NG module {source_label!r} could not be read: {exc}",
            code=exc.code if exc.code != "INPUT_MALFORMED" else None,
        ) from exc


def _read_xml_components(
    root: ET.Element,
    *,
    ns: Optional[str],
    datatype_library: Optional[str],
    ctx: "_ReadContext",
) -> RelaxNgComponents:
    """Read one ``.rng`` document into its uncomposed components.

    A document is either a ``grammar`` (``start`` plus named patterns plus ``include``
    directives) or a bare pattern — RELAX NG lets a whole schema be a single ``element``
    pattern with no grammar wrapper, which is what the minimal fixture is.

    Args:
        root: The document's root element.
        ns: The element namespace in force from the including context.
        datatype_library: The ``datatypeLibrary`` in force from the including context.
        ctx: The read context.

    Returns:
        The file's components, with ``include`` directives unresolved.
    """
    root_ns = _inherited(root, "ns", ns)
    root_library = _inherited(root, "datatypeLibrary", datatype_library)
    documentation = _documentation(root)

    if _local(root.tag) != "grammar":
        return RelaxNgComponents(
            start=_read_pattern(
                root, ns=root_ns, datatype_library=root_library, ctx=ctx, location="start"
            ),
            namespace=root.get("ns"),
            datatype_library=root.get("datatypeLibrary"),
            documentation=documentation,
        )

    start, declarations = _read_grammar_body(
        root, ns=root_ns, datatype_library=root_library, ctx=ctx
    )
    includes: List[RelaxNgInclude] = []
    for include in _relaxng_children(root):
        if _local(include.tag) != "include":
            continue
        href = (include.get("href") or "").strip()
        if not href:
            raise RelaxNgParseError(
                "`include` has no `href` attribute", code="INPUT_SEMANTIC_INVALID"
            )
        override_start, overrides = _read_grammar_body(
            include,
            ns=_inherited(include, "ns", root_ns),
            datatype_library=_inherited(include, "datatypeLibrary", root_library),
            ctx=ctx,
        )
        includes.append(
            RelaxNgInclude(
                href=href,
                override_start=(
                    None if override_start.kind is PatternKind.NOT_ALLOWED else override_start
                ),
                override_declarations=tuple(overrides),
            )
        )

    return RelaxNgComponents(
        start=start,
        declarations=tuple(declarations),
        includes=tuple(includes),
        namespace=root.get("ns"),
        datatype_library=root.get("datatypeLibrary"),
        documentation=documentation,
    )


def _read_components(
    text: str,
    *,
    source_label: Optional[str],
    ns: Optional[str],
    datatype_library: Optional[str],
    ctx: "_ReadContext",
) -> RelaxNgComponents:
    """Read one RELAX NG source file, in whichever syntax it is written in.

    The syntax is chosen from the text itself, not from the filename: a ``.rnc`` extension
    is a hint the intake may not have (pasted text carries none), and the two syntaxes are
    unambiguous to look at. This is also the seam that makes a mixed-syntax fileset work —
    a ``.rnc`` grammar including a ``.rng`` module is composed by the same code as a set
    written entirely one way.

    Args:
        text: The file's source.
        source_label: The file's name, for error messages.
        ns: The element namespace in force from the including context.
        datatype_library: The ``datatypeLibrary`` in force from the including context.
        ctx: The read context.

    Returns:
        The file's uncomposed components.
    """
    if is_relaxng_compact(text) and RELAXNG_NS not in text:
        from .relaxng_compact import read_compact_components

        return read_compact_components(text, source_label=source_label, limits=ctx.limits)
    return _read_xml_components(
        _parse_member(text, source_label=source_label or "<document>"),
        ns=ns,
        datatype_library=datatype_library,
        ctx=ctx,
    )


# ===========================================================================
# Composition
# ===========================================================================


@dataclass
class _Composition:
    """What a whole composed grammar accumulates beyond its patterns.

    Attributes:
        includes: ``include`` hrefs met, in document order.
        external_refs: ``externalRef`` hrefs met, in document order.
        unresolved: Hrefs that named nothing in the set, in document order.
    """

    includes: List[str] = field(default_factory=list)
    external_refs: List[str] = field(default_factory=list)
    unresolved: List[str] = field(default_factory=list)


def _compose(
    text: str,
    *,
    source_label: Optional[str],
    members: Mapping[str, str],
    depth: int,
    ns: Optional[str],
    datatype_library: Optional[str],
    ctx: "_ReadContext",
    composition: _Composition,
) -> RelaxNgComponents:
    """Read one file and expand every ``include`` it declares, recursively.

    ``externalRef`` is *not* expanded here — it appears deep inside patterns rather than at
    grammar level, so it is substituted afterwards by :func:`_substitute_external_refs`
    over the finished tree.

    Args:
        text: The file's source.
        source_label: The member key of this file.
        members: Fileset member name -> text.
        depth: Current composition depth, for the cycle guard.
        ns: The element namespace in force.
        datatype_library: The ``datatypeLibrary`` in force.
        ctx: The read context.
        composition: Accumulator for the hrefs met.

    Returns:
        The composed components: one start pattern and one flat declaration list.

    Raises:
        RelaxNgParseError: On a composition cycle, an unreadable module, or an unsafe href.
    """
    if depth > MAX_COMPOSITION_DEPTH:
        raise RelaxNgParseError(
            f"RELAX NG composition exceeded {MAX_COMPOSITION_DEPTH} levels — the set "
            "includes itself, directly or through a ring",
            code="INPUT_DEPTH_LIMIT",
        )

    components = _read_components(
        text,
        source_label=source_label,
        ns=ns,
        datatype_library=datatype_library,
        ctx=ctx,
    )

    start = components.start
    included: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []
    for directive in components.includes:
        composition.includes.append(directive.href)
        resolved = resolve_href(
            directive.href, members=members, base=source_label, limits=ctx.limits
        )
        if resolved is None:
            composition.unresolved.append(directive.href)
            continue
        member_key, member_text = resolved
        module = _compose(
            member_text,
            source_label=member_key,
            members=members,
            depth=depth + 1,
            ns=components.namespace or ns,
            datatype_library=components.datatype_library or datatype_library,
            ctx=ctx,
            composition=composition,
        )
        overridden = {name for name, _, _ in directive.override_declarations}
        included.extend(
            declaration
            for declaration in module.declarations
            if declaration[0] not in overridden
        )
        included.extend(directive.override_declarations)
        if start.kind is PatternKind.NOT_ALLOWED:
            # The including grammar states no `start` of its own, so the directive's
            # override stands, and failing that the module's own start does.
            start = directive.override_start or module.start

    # The including grammar's own declarations are appended last so that, where a name is
    # declared on both sides without a `combine`, the including grammar is the one that
    # wins — the practical reading of a module set, and the only one under which a
    # published module can be reused by a grammar that refines it.
    return RelaxNgComponents(
        start=start,
        declarations=tuple(included) + tuple(components.declarations),
        namespace=components.namespace,
        datatype_library=components.datatype_library,
        documentation=components.documentation,
    )


def _substitute_external_refs(
    node: RelaxNgPattern,
    *,
    members: Mapping[str, str],
    base: Optional[str],
    depth: int,
    ctx: "_ReadContext",
    composition: _Composition,
    extra_declarations: List[Tuple[str, RelaxNgPattern, Optional[str]]],
) -> RelaxNgPattern:
    """Replace every ``externalRef`` in ``node`` with the grammar it names.

    Unlike ``include``, ``externalRef`` does not merge definition tables: the referenced
    grammar is a *pattern* substituted in place, keeping its own scope. Its definitions are
    therefore lifted under a unique prefix and its references rewritten, exactly as a
    nested ``grammar`` pattern's are.

    An href that resolves to nothing leaves the ``externalRef`` node in the tree and is
    recorded; :func:`app.relaxng_grammar.build_document` is what turns that into a reported
    unresolved reference.

    Args:
        node: The pattern to rewrite.
        members: Fileset member name -> text.
        base: The member key of the referring document.
        depth: Current composition depth, for the cycle guard.
        ctx: The read context.
        composition: Accumulator for the hrefs met.
        extra_declarations: Collector for the substituted grammars' definitions.

    Returns:
        The rewritten pattern.
    """
    if node.kind is PatternKind.EXTERNAL_REF and node.ref_name:
        href = node.ref_name
        composition.external_refs.append(href)
        resolved = resolve_href(href, members=members, base=base, limits=ctx.limits)
        if resolved is None:
            composition.unresolved.append(href)
            return node
        member_key, member_text = resolved
        module = _compose(
            member_text,
            source_label=member_key,
            members=members,
            depth=depth + 1,
            ns=None,
            datatype_library=None,
            ctx=ctx,
            composition=composition,
        )
        prefix = ctx.next_scope(href)
        extra_declarations.extend(
            (f"{prefix}{name}", _rescope(body, prefix=prefix), combine)
            for name, body, combine in module.declarations
        )
        return _substitute_external_refs(
            _rescope(module.start, prefix=prefix),
            members=members,
            base=member_key,
            depth=depth + 1,
            ctx=ctx,
            composition=composition,
            extra_declarations=extra_declarations,
        )

    children = tuple(
        _substitute_external_refs(
            child,
            members=members,
            base=base,
            depth=depth,
            ctx=ctx,
            composition=composition,
            extra_declarations=extra_declarations,
        )
        for child in node.children
    )
    if children == node.children:
        return node
    return RelaxNgPattern(
        kind=node.kind,
        name_class=node.name_class,
        ref_name=node.ref_name,
        datatype=node.datatype,
        datatype_library=node.datatype_library,
        params=node.params,
        literal=node.literal,
        children=children,
        excepted=node.excepted,
        documentation=node.documentation,
    )


# ===========================================================================
# Public entry points
# ===========================================================================


def parse_relaxng(
    content: str,
    *,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, str]] = None,
) -> RelaxNgDocument:
    """Parse RELAX NG text — either syntax — into a :class:`RelaxNgDocument`.

    Args:
        content: The grammar text.
        source_label: The document's name, used in error messages and as the base for
            relative ``href`` resolution.
        members: Fileset member name -> text, when the grammar was supplied as a set.

    Returns:
        The parsed document.

    Raises:
        RelaxNgParseError: If the text is not RELAX NG, is malformed, declares no ``start``,
            or references a named pattern nothing defines.
        SecureXmlError: If the XML guards (DTD, entities, size, depth) reject the document.
    """
    if not content or not content.strip():
        raise RelaxNgParseError("Invalid or empty RELAX NG document")

    label = f" ({source_label})" if source_label else ""
    compact = is_relaxng_compact(content) and RELAXNG_NS not in content
    if not compact and not is_relaxng(content):
        raise RelaxNgParseError(f"Content does not appear to be a RELAX NG grammar{label}")

    fileset: Mapping[str, str] = members or {}
    ctx = _ReadContext(limits=LimitRecorder())
    composition = _Composition()
    try:
        components = _compose(
            content,
            source_label=source_label,
            members=fileset,
            depth=0,
            ns=None,
            datatype_library=None,
            ctx=ctx,
            composition=composition,
        )
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            raise RelaxNgParseError(f"Malformed RELAX NG document{label}: {exc}") from exc
        raise

    extra: List[Tuple[str, RelaxNgPattern, Optional[str]]] = []

    def substitute(node: RelaxNgPattern) -> RelaxNgPattern:
        """Substitute every ``externalRef`` in one pattern against this document's set."""
        return _substitute_external_refs(
            node,
            members=fileset,
            base=source_label,
            depth=0,
            ctx=ctx,
            composition=composition,
            extra_declarations=extra,
        )

    start = substitute(components.start)
    declarations = [
        (name, substitute(body), combine) for name, body, combine in components.declarations
    ]

    return build_document(
        syntax="compact" if compact else "xml",
        namespace=components.namespace,
        datatype_library=components.datatype_library,
        start=start,
        declarations=declarations + extra + ctx.nested,
        limits=ctx.limits,
        includes=composition.includes,
        external_refs=composition.external_refs,
        unresolved_refs=composition.unresolved,
        documentation=components.documentation,
        raw=content,
        source_label=source_label,
    )


def parse_relaxng_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> RelaxNgDocument:
    """Parse a multi-file RELAX NG set through its root document.

    Args:
        members: Member name -> text for every file in the set.
        root: The member name of the root grammar.
        source_label: Optional label used when ``root`` is absent from ``members``.

    Returns:
        The composed document.

    Raises:
        RelaxNgParseError: If the root member is missing, or composition fails.
    """
    if root not in members:
        raise RelaxNgParseError(
            f"RELAX NG fileset is missing its root document {root!r}",
            code="INPUT_SEMANTIC_INVALID",
        )
    return parse_relaxng(members[root], source_label=root or source_label, members=members)
