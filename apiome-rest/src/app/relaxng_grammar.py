"""RELAX NG pattern algebra — the AST both syntaxes parse into (FMT-4.1, #5434).

RELAX NG is written two interchangeable ways: the XML syntax (``.rng``) and the
compact syntax (``.rnc``). The specifications define them as the *same* language —
the compact syntax has a normative, purely syntactic translation into the XML one —
so an importer that parsed them separately would have two chances to disagree about
one grammar.

This module is the shared middle that makes disagreement impossible: it defines the
pattern algebra, and :mod:`app.relaxng_parser` (XML) and :mod:`app.relaxng_compact`
(compact) are two front-ends onto it. :mod:`app.relaxng_normalizer` reads only what
is here, so the FMT-4.1 acceptance criterion — *"``.rng`` and ``.rnc`` both import to
the same canonical model for the same grammar"* — is a structural property of the
module layout rather than a pair of parsers kept in step by hand.

The algebra is RELAX NG's own, kept deliberately close to the specification's
vocabulary: a :class:`RelaxNgPattern` is one of the spec's pattern productions, a
:class:`RelaxNgNameClass` is one of its name-class productions, and a
:class:`RelaxNgDefine` is a named pattern with its ``combine`` method. Nothing is
simplified away here — a construct the canonical model cannot hold is *recorded* as a
:class:`RelaxNgLimit` on the document, which is what the ticket means by "declared
parsing limits in the capability registry, not silent omissions".
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

__all__ = [
    "RELAXNG_NS",
    "RELAXNG_ANNOTATIONS_NS",
    "XSD_DATATYPES_LIBRARY",
    "LIMIT_DETAILS",
    "NameClassKind",
    "PatternKind",
    "RelaxNgComponents",
    "RelaxNgDefine",
    "RelaxNgDocument",
    "RelaxNgInclude",
    "RelaxNgLimit",
    "RelaxNgNameClass",
    "RelaxNgPattern",
    "LimitRecorder",
    "RelaxNgParseError",
    "build_document",
    "combine_defines",
    "effective_datatype_library",
    "is_absolute_href",
    "merged_start",
    "resolve_href",
    "referenced_names",
]

#: The RELAX NG structure namespace every ``.rng`` document lives in.
RELAXNG_NS = "http://relaxng.org/ns/structure/1.0"

#: The RELAX NG compatibility annotations namespace (``a:documentation``).
RELAXNG_ANNOTATIONS_NS = "http://relaxng.org/ns/compatibility/annotations/1.0"

#: The one datatype library whose type names are mapped onto canonical scalars. Any other
#: ``datatypeLibrary`` is a declared limit: its type names are kept verbatim and carried as
#: opaque strings rather than guessed at.
XSD_DATATYPES_LIBRARY = "http://www.w3.org/2001/XMLSchema-datatypes"


class PatternKind(str, Enum):
    """One of RELAX NG's pattern productions.

    The values are the XML syntax's element names, so a pattern's kind is also the tag a
    reader would find in a ``.rng`` document — which keeps extras, ledger rows and error
    messages phrased in the source language rather than in an invented one.
    """

    ELEMENT = "element"
    ATTRIBUTE = "attribute"
    GROUP = "group"
    INTERLEAVE = "interleave"
    CHOICE = "choice"
    OPTIONAL = "optional"
    ZERO_OR_MORE = "zeroOrMore"
    ONE_OR_MORE = "oneOrMore"
    LIST = "list"
    MIXED = "mixed"
    REF = "ref"
    PARENT_REF = "parentRef"
    EXTERNAL_REF = "externalRef"
    EMPTY = "empty"
    TEXT = "text"
    DATA = "data"
    VALUE = "value"
    NOT_ALLOWED = "notAllowed"


class NameClassKind(str, Enum):
    """One of RELAX NG's name-class productions."""

    NAME = "name"
    ANY_NAME = "anyName"
    NS_NAME = "nsName"
    CHOICE = "choice"


@dataclass(frozen=True)
class RelaxNgNameClass:
    """The name (or set of names) an ``element``/``attribute`` pattern matches.

    Attributes:
        kind: Which production this is.
        name: The local name, for :attr:`NameClassKind.NAME`.
        ns: The namespace URI in force, for :attr:`NameClassKind.NAME` and
            :attr:`NameClassKind.NS_NAME`.
        alternatives: The branches of a :attr:`NameClassKind.CHOICE`.
        excepted: Name classes subtracted from a wildcard (``<anyName><except>…``).
    """

    kind: NameClassKind
    name: Optional[str] = None
    ns: Optional[str] = None
    alternatives: Tuple["RelaxNgNameClass", ...] = ()
    excepted: Tuple["RelaxNgNameClass", ...] = ()

    @property
    def is_wildcard(self) -> bool:
        """Whether this name class matches more than one specific name."""
        return self.kind in (NameClassKind.ANY_NAME, NameClassKind.NS_NAME) or any(
            alternative.is_wildcard for alternative in self.alternatives
        )

    def describe(self) -> str:
        """Return a short human-readable spelling, for extras and error messages."""
        if self.kind is NameClassKind.NAME:
            return self.name or "*"
        if self.kind is NameClassKind.NS_NAME:
            return f"{{{self.ns or ''}}}*"
        if self.kind is NameClassKind.CHOICE:
            return " | ".join(alternative.describe() for alternative in self.alternatives)
        return "*"


@dataclass(frozen=True)
class RelaxNgPattern:
    """One node of the pattern algebra.

    Only the fields a given :attr:`kind` uses are populated; the rest keep their defaults.
    Frozen and tuple-valued throughout so a parsed grammar is safe to share — the normalizer
    walks the same tree several times (once for the type graph, once for the coverage
    ledger) and must not be able to mutate it between walks.

    Attributes:
        kind: The production this node is.
        name_class: For ``element``/``attribute``, the names it matches.
        ref_name: For ``ref``/``parentRef``, the named pattern referenced; for
            ``externalRef``, the ``href`` it names.
        datatype: For ``data``/``value``, the datatype's local name (``string``, ``ID``).
        datatype_library: The ``datatypeLibrary`` in force at this node, if any.
        params: For ``data``, the ``<param name="…">value</param>`` facets in order.
        literal: For ``value``, the literal text the pattern matches.
        children: Sub-patterns, in document order.
        excepted: The ``<except>`` sub-patterns of a ``data`` pattern.
        documentation: An ``a:documentation`` annotation attached to this node.
    """

    kind: PatternKind
    name_class: Optional[RelaxNgNameClass] = None
    ref_name: Optional[str] = None
    datatype: Optional[str] = None
    datatype_library: Optional[str] = None
    params: Tuple[Tuple[str, str], ...] = ()
    literal: Optional[str] = None
    children: Tuple["RelaxNgPattern", ...] = ()
    excepted: Tuple["RelaxNgPattern", ...] = ()
    documentation: Optional[str] = None

    @property
    def element_name(self) -> Optional[str]:
        """The single element/attribute name this pattern matches, when it has one."""
        if self.name_class is None or self.name_class.kind is not NameClassKind.NAME:
            return None
        return self.name_class.name


@dataclass(frozen=True)
class RelaxNgDefine:
    """A named pattern (``<define name="…">`` / ``name = …``).

    Attributes:
        name: The pattern name ``ref`` cites.
        pattern: The pattern body. Several declarations combined with ``combine`` are
            merged into a single body by the parser, so a consumer never has to.
        combine: The declared combine method (``choice``/``interleave``), or ``None`` when
            the name was declared exactly once.
    """

    name: str
    pattern: RelaxNgPattern
    combine: Optional[str] = None


@dataclass(frozen=True)
class RelaxNgLimit:
    """A construct the reader parsed but the canonical model cannot hold.

    The FMT-4.1 acceptance criterion in structural form: ``interleave`` and the
    datatype-library constructs are *declared* rather than silently dropped, so an entry
    here is a capability statement, never a defect in the source.

    Attributes:
        construct: The stable key the capability registry publishes
            (``relaxng.interleave``).
        detail: One line on what is kept and what is not.
        count: How many times the construct appeared in this document.
        locations: The named patterns (or ``start``) the occurrences sit under, sorted.
    """

    construct: str
    detail: str
    count: int = 1
    locations: Tuple[str, ...] = ()


#: The reviewed sentence for each declared limit, keyed by construct. Held here rather than
#: at each raise site so the parser, the capability registry and the coverage ledger all
#: quote one wording.
LIMIT_DETAILS: Dict[str, str] = {
    "relaxng.interleave": (
        "`interleave` admits its branches in any order. Neither the canonical model nor "
        "JSON Schema has an unordered-any-order construct, so the branches are kept as "
        "ordinary members and their order-independence is not expressible."
    ),
    "relaxng.name_class_wildcard": (
        "An `anyName`/`nsName` wildcard matches a set of names rather than one name. The "
        "canonical model names every field, so the wildcard is carried as a single "
        "open-content member and the set it stands for is not enumerable."
    ),
    "relaxng.datatype_except": (
        "A `data` pattern's `except` clause subtracts values from a datatype. The "
        "canonical constraint vocabulary has no subtraction facet, so the base datatype "
        "survives and the exclusion is recorded but not enforced."
    ),
    "relaxng.external_datatype_library": (
        "A `datatypeLibrary` other than the W3C XML Schema datatypes is not interpreted: "
        "its type names are carried verbatim as opaque scalars rather than guessed at."
    ),
    "relaxng.list": (
        "A `list` pattern matches whitespace-separated tokens inside one text node. The "
        "canonical model has no tokenized-text collection, so the member is carried as a "
        "list of its item type and the single-text-node encoding is not expressible."
    ),
    "relaxng.mixed": (
        "`mixed` interleaves text with element content. The canonical model has no "
        "mixed-content record, so the text half is carried as an open-content member "
        "alongside the element members."
    ),
    "relaxng.remote_href": (
        "An `include`/`externalRef` naming an absolute URL is never fetched during import: "
        "the reference is recorded and the definitions behind it are absent."
    ),
}


class LimitRecorder:
    """Accumulates :class:`RelaxNgLimit` records while a grammar is walked.

    Both syntax front-ends and the composer meet these constructs, and all three must
    record them with the same wording and the same de-duplication, so the bookkeeping lives
    here rather than being written out at each site.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, set] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The named pattern the occurrence sits under, when known.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown RELAX NG limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def limits(self) -> Tuple[RelaxNgLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            RelaxNgLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )


@dataclass(frozen=True)
class RelaxNgDocument:
    """A parsed RELAX NG grammar, whichever syntax it was written in.

    Attributes:
        syntax: ``"xml"`` for ``.rng``, ``"compact"`` for ``.rnc``. The one field whose
            value legitimately differs between the two spellings of one grammar.
        namespace: The default element namespace (the ``ns`` attribute / ``default
            namespace`` declaration), or ``None``.
        datatype_library: The datatype library the grammar's ``data`` patterns actually
            type against — see :func:`effective_datatype_library`, which is what lets the
            two syntaxes agree on one answer despite declaring it differently.
        start: The grammar's start pattern.
        defines: Every named pattern, sorted by name, with ``combine`` groups merged.
        declared_limits: Constructs parsed but not expressible canonically.
        includes: ``include`` hrefs, in document order.
        external_refs: ``externalRef`` hrefs, in document order.
        unresolved_refs: Hrefs that named neither a fileset member nor a fetchable
            document, in document order.
        documentation: The document-level ``a:documentation`` text, if any.
        raw: The source text exactly as supplied.
    """

    syntax: str
    namespace: Optional[str]
    datatype_library: Optional[str]
    start: RelaxNgPattern
    defines: Tuple[RelaxNgDefine, ...]
    declared_limits: Tuple[RelaxNgLimit, ...] = ()
    includes: Tuple[str, ...] = ()
    external_refs: Tuple[str, ...] = ()
    unresolved_refs: Tuple[str, ...] = ()
    documentation: Optional[str] = None
    raw: str = ""

    def define_map(self) -> Dict[str, RelaxNgDefine]:
        """Return the named patterns keyed by name."""
        return {define.name: define for define in self.defines}


def combine_defines(
    declarations: Iterable[Tuple[str, RelaxNgPattern, Optional[str]]],
) -> Tuple[RelaxNgDefine, ...]:
    """Merge repeated ``define`` declarations of one name into a single named pattern.

    RELAX NG lets a pattern be assembled from several declarations, each stating how it
    joins the others (``combine="choice"`` / ``combine="interleave"``); the compact syntax
    spells the same thing ``name |= …`` / ``name &= …``. Both front-ends produce the raw
    declarations and hand them here, so the merge — and therefore the resulting AST — is
    identical whichever syntax was read.

    A name declared once keeps its body verbatim (``combine`` stays ``None``), which is
    what makes the common case indistinguishable between the two spellings.

    Args:
        declarations: ``(name, pattern, combine)`` triples in document order.

    Returns:
        The merged named patterns, sorted by name so a grammar's AST does not depend on
        declaration order.

    Raises:
        ValueError: If one name is declared more than once with conflicting (or missing)
            combine methods — the spec's error, not a shape this reader may invent an
            answer for.
    """
    order: List[str] = []
    bodies: Dict[str, List[RelaxNgPattern]] = {}
    methods: Dict[str, List[Optional[str]]] = {}
    for name, body, combine in declarations:
        if name not in bodies:
            order.append(name)
            bodies[name] = []
            methods[name] = []
        bodies[name].append(body)
        methods[name].append(combine)

    merged: List[RelaxNgDefine] = []
    for name in order:
        parts = bodies[name]
        if len(parts) == 1:
            merged.append(RelaxNgDefine(name=name, pattern=parts[0], combine=methods[name][0]))
            continue
        declared = {method for method in methods[name] if method}
        if len(declared) != 1:
            raise ValueError(
                f"named pattern {name!r} is declared {len(parts)} times with "
                f"{'conflicting' if declared else 'no'} combine methods"
            )
        method = declared.pop()
        kind = PatternKind.INTERLEAVE if method == "interleave" else PatternKind.CHOICE
        merged.append(
            RelaxNgDefine(
                name=name,
                pattern=RelaxNgPattern(kind=kind, children=tuple(parts)),
                combine=method,
            )
        )
    return tuple(sorted(merged, key=lambda define: define.name))


class RelaxNgParseError(ValueError):
    """Raised when RELAX NG text cannot be read, in either syntax.

    Lives with the algebra rather than with one of the two front-ends because the
    well-formedness rules it reports — a grammar must declare a ``start``, every ``ref``
    must name a definition — are properties of the algebra, and both front-ends must
    report them identically.

    Args:
        message: What was wrong with the grammar.
        code: The intake-taxonomy code this maps onto, when the reader can classify the
            failure precisely (``INPUT_SEMANTIC_INVALID`` for a grammar with no ``start``,
            ``INPUT_REFERENCE_UNRESOLVED`` for a ``ref``/``href`` naming nothing,
            ``INPUT_UNSAFE_CONSTRUCT`` for an href the SSRF policy forbids). ``None``
            leaves the classification to the pipeline's own phase default.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


def referenced_names(node: RelaxNgPattern) -> List[str]:
    """Return every ``ref`` name reachable from ``node``, in document order.

    Args:
        node: The pattern to walk.

    Returns:
        The referenced named-pattern names, with duplicates kept (a caller that wants the
        set can build one; a caller reporting *where* a name is used wants them all).
    """
    names: List[str] = []
    stack = [node]
    while stack:
        current = stack.pop()
        if current.kind is PatternKind.REF and current.ref_name:
            names.append(current.ref_name)
        stack.extend(reversed(current.children))
        stack.extend(reversed(current.excepted))
    return names


def effective_datatype_library(
    declared: Optional[str], start: RelaxNgPattern, defines: Sequence[RelaxNgDefine]
) -> Optional[str]:
    """Return the datatype library a grammar actually types its values against.

    The two syntaxes state this differently and neither statement is the whole answer: the
    XML syntax carries an inheritable ``datatypeLibrary`` attribute, while the compact
    syntax binds *prefixes* to libraries and has no document-level default at all. Deriving
    the effective library from the ``data`` patterns themselves — and falling back to the
    declaration only when nothing is typed — is what lets one grammar written both ways
    report one library, which the FMT-4.1 "same canonical model" criterion requires.

    Args:
        declared: The document-level ``datatypeLibrary``, when the syntax has one.
        start: The start pattern.
        defines: The named patterns.

    Returns:
        The single library every typed ``data`` pattern uses, else the declared value.
    """
    used: set = set()
    stack: List[RelaxNgPattern] = [start, *(define.pattern for define in defines)]
    while stack:
        current = stack.pop()
        if current.kind is PatternKind.DATA and current.datatype and current.datatype_library:
            used.add(current.datatype_library)
        stack.extend(current.children)
        stack.extend(current.excepted)
    if len(used) == 1:
        return used.pop()
    return declared


def build_document(
    *,
    syntax: str,
    namespace: Optional[str],
    datatype_library: Optional[str],
    start: RelaxNgPattern,
    declarations: Sequence[Tuple[str, RelaxNgPattern, Optional[str]]],
    limits: "LimitRecorder",
    includes: Sequence[str] = (),
    external_refs: Sequence[str] = (),
    unresolved_refs: Sequence[str] = (),
    documentation: Optional[str] = None,
    raw: str = "",
    source_label: Optional[str] = None,
) -> RelaxNgDocument:
    """Merge declarations, check every reference, and build the document.

    The one place a grammar becomes a :class:`RelaxNgDocument`, shared by both syntaxes so
    the semantic checks are literally the same code rather than two copies free to disagree.

    Args:
        syntax: ``"xml"`` or ``"compact"``.
        namespace: The document's default element namespace.
        datatype_library: The document's declared ``datatypeLibrary``, if it has one.
        start: The start pattern; ``notAllowed`` means the grammar declared none.
        declarations: ``(name, pattern, combine)`` triples, pre-merge.
        limits: The recorder holding the declared limits met while reading.
        includes: ``include`` hrefs met.
        external_refs: ``externalRef`` hrefs met.
        unresolved_refs: Hrefs that named nothing available.
        documentation: Document-level annotation text.
        raw: The source text exactly as supplied.
        source_label: The document's name, for error messages.

    Returns:
        The finished document.

    Raises:
        RelaxNgParseError: If the grammar declares no ``start``
            (``INPUT_SEMANTIC_INVALID``), combines one name inconsistently
            (``INPUT_SEMANTIC_INVALID``), or references a pattern nothing defines
            (``INPUT_REFERENCE_UNRESOLVED``).
    """
    label = f" ({source_label})" if source_label else ""
    if start.kind is PatternKind.NOT_ALLOWED:
        raise RelaxNgParseError(
            f"RELAX NG grammar declares no `start` pattern{label}, so it defines no "
            "document element",
            code="INPUT_SEMANTIC_INVALID",
        )

    try:
        defines = combine_defines(declarations)
    except ValueError as exc:
        raise RelaxNgParseError(f"{exc}{label}", code="INPUT_SEMANTIC_INVALID") from exc

    defined = {define.name for define in defines}
    referenced: List[str] = list(referenced_names(start))
    for define in defines:
        referenced.extend(referenced_names(define.pattern))
    dangling = sorted({name for name in referenced if name not in defined})
    if dangling:
        raise RelaxNgParseError(
            "RELAX NG grammar references undefined named pattern(s) "
            f"{', '.join(repr(name) for name in dangling)}{label}",
            code="INPUT_REFERENCE_UNRESOLVED",
        )
    if unresolved_refs:
        raise RelaxNgParseError(
            "RELAX NG grammar could not resolve "
            f"{', '.join(repr(href) for href in unresolved_refs)}{label} — the referenced "
            "module was not supplied with the document",
            code="INPUT_REFERENCE_UNRESOLVED",
        )

    return RelaxNgDocument(
        syntax=syntax,
        namespace=namespace,
        datatype_library=effective_datatype_library(datatype_library, start, defines),
        start=start,
        defines=defines,
        declared_limits=limits.limits(),
        includes=tuple(includes),
        external_refs=tuple(external_refs),
        unresolved_refs=tuple(unresolved_refs),
        documentation=documentation,
        raw=raw,
    )


@dataclass(frozen=True)
class RelaxNgInclude:
    """One ``include`` directive, with the components declared inside it.

    Attributes:
        href: The location the directive names.
        override_start: A ``start`` declared inside the directive, replacing the included
            module's own, or ``None``.
        override_declarations: ``(name, pattern, combine)`` triples declared inside the
            directive, each replacing the included module's definition of that name.
    """

    href: str
    override_start: Optional[RelaxNgPattern] = None
    override_declarations: Tuple[Tuple[str, RelaxNgPattern, Optional[str]], ...] = ()


@dataclass(frozen=True)
class RelaxNgComponents:
    """One RELAX NG *source file*, read but not yet composed.

    The unit both front-ends produce and the composer consumes. Splitting "read this file"
    from "resolve what it includes" is what lets one composer serve both syntaxes: a
    ``.rnc`` that includes a ``.rng`` (or the reverse) is composed by the same code that
    composes a set written entirely one way.

    Attributes:
        start: The file's start pattern, or ``notAllowed`` when it declares none.
        declarations: Its own ``(name, pattern, combine)`` triples, in document order.
        includes: Its ``include`` directives, in document order.
        namespace: The default element namespace it declares, if any.
        datatype_library: The datatype library it declares at document level, if any.
        documentation: Its document-level annotation text, if any.
    """

    start: RelaxNgPattern
    declarations: Tuple[Tuple[str, RelaxNgPattern, Optional[str]], ...] = ()
    includes: Tuple[RelaxNgInclude, ...] = ()
    namespace: Optional[str] = None
    datatype_library: Optional[str] = None
    documentation: Optional[str] = None


def is_absolute_href(href: str) -> bool:
    """Return whether ``href`` names an absolute URL rather than a relative path.

    Args:
        href: The href as written.

    Returns:
        ``True`` when the href carries a scheme (``http:``, ``file:``, ``urn:``).
    """
    scheme, separator, _ = href.partition(":")
    return bool(separator) and scheme.isalpha() and len(scheme) > 1


def resolve_href(
    href: str,
    *,
    members: Mapping[str, str],
    base: Optional[str],
    limits: "LimitRecorder",
) -> Optional[Tuple[str, str]]:
    """Resolve an ``include``/``externalRef`` href against a fileset's members.

    Relative hrefs are resolved against the referring document's directory first (the
    RELAX NG rule), then against the bare filename — the same two-step the XSD reader uses
    for ``schemaLocation``, so a set assembled from an archive resolves whether or not the
    archive preserved directory prefixes.

    Absolute URLs are **never fetched**. They are vetted for shape only — via
    :func:`app.ssrf_guard.validate_url_policy`, which needs no DNS and is therefore safe to
    call inside a parser: an href the policy forbids (``file:``, ``data:``, embedded
    credentials, no host) is an unsafe construct and fails the import, while a policy-legal
    ``http(s)`` href is recorded as a declared limit and left unresolved. Import never
    reaches the network, so a grammar cannot make this service fetch a URL of its author's
    choosing.

    Args:
        href: The declared href.
        members: Fileset member name -> text.
        base: The member key of the referring document, for relative resolution.
        limits: Recorder for the remote-href declared limit.

    Returns:
        ``(member_key, text)`` when the href resolves inside the set, else ``None``.

    Raises:
        RelaxNgParseError: If the href's shape is forbidden by the SSRF policy.
    """
    from .ssrf_guard import SSRFError, validate_url_policy

    if is_absolute_href(href):
        try:
            validate_url_policy(href)
        except SSRFError as exc:
            raise RelaxNgParseError(
                f"RELAX NG href {href!r} is not a fetchable location: {exc}",
                code="INPUT_UNSAFE_CONSTRUCT",
            ) from exc
        limits.record("relaxng.remote_href", location=href)
        return None

    candidates: List[str] = []
    if base and "/" in base:
        candidates.append(f"{base.rsplit('/', 1)[0]}/{href}")
    candidates.append(href)
    tail = href.rsplit("/", 1)[-1]
    candidates.append(tail)
    for candidate in candidates:
        if candidate in members:
            return candidate, members[candidate]
    for key, text in members.items():
        if key.rsplit("/", 1)[-1] == tail:
            return key, text
    return None


def merged_start(
    declarations: Sequence[Tuple[str, RelaxNgPattern, Optional[str]]],
) -> RelaxNgPattern:
    """Reduce a grammar's ``start`` declarations to the single pattern they describe.

    A grammar may declare ``start`` more than once when each declaration states how it
    combines with the others (``combine="choice"`` / ``"interleave"``, spelled ``start |=``
    / ``start &=`` in the compact syntax). The merge is the same one named patterns get, so
    it is :func:`combine_defines` rather than a second implementation of it.

    Args:
        declarations: ``("start", pattern, combine)`` triples in document order.

    Returns:
        The start pattern, or ``notAllowed`` when the grammar declared none — which
        :func:`build_document` is what turns into a reported error, since an *included*
        module legitimately has no start of its own.

    Raises:
        RelaxNgParseError: If the declarations combine inconsistently.
    """
    if not declarations:
        return RelaxNgPattern(kind=PatternKind.NOT_ALLOWED)
    try:
        return combine_defines(declarations)[0].pattern
    except ValueError as exc:
        raise RelaxNgParseError(str(exc), code="INPUT_SEMANTIC_INVALID") from exc
