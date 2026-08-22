"""DTD algebra, limits and expansion budget — FMT-4.2 (#5435).

The shared middle of the DTD reader: the declaration algebra
:mod:`app.dtd_parser` produces and :mod:`app.dtd_normalizer` consumes, the vocabulary of
constructs the canonical model cannot hold, and — the part that matters most — the
**expansion budget** every entity reference is charged against.

**Why the budget lives here.** A DTD is the one schema language whose own grammar contains
a general-purpose macro facility, and entity expansion is therefore not an optional
hardening pass but part of parsing. Both the parameter-entity input stack (which composes
the document) and general-entity value expansion (which materializes replacement text)
charge the same :class:`ExpansionBudget`, so a document cannot spend its way past one guard
by moving work into the other. The budget bounds three dimensions at once — how many
references are expanded, how many bytes they produce, and how deep the expansion nests —
and a breach is a terminal, classified failure rather than a slow parse.

**Recursion is refused, never unrolled.** :class:`ExpansionBudget` tracks the chain of
entities currently being expanded; an entity that re-enters its own chain is rejected as an
unsafe construct. That covers both the direct case (``<!ENTITY % a "%a;">``) and the mutual
one, and it is what makes "bounded *and* never recursive" two separate guarantees rather
than one budget that happens to stop a loop eventually.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

__all__ = [
    "MAX_DTD_BYTES",
    "MAX_ENTITY_EXPANSIONS",
    "MAX_EXPANDED_BYTES",
    "MAX_ENTITY_DEPTH",
    "MAX_DECLARED_ENTITIES",
    "MAX_MODEL_DEPTH",
    "AttributeDefault",
    "AttributeType",
    "ContentKind",
    "DtdAttribute",
    "DtdDocument",
    "DtdElement",
    "DtdEntity",
    "DtdLimit",
    "DtdNotation",
    "DtdParseError",
    "DtdParticle",
    "ExpansionBudget",
    "LIMIT_DETAILS",
    "LimitRecorder",
    "Occurrence",
    "build_document",
    "is_absolute_system_id",
    "resolve_system_id",
]

# ---------------------------------------------------------------------------
# Budget ceilings
# ---------------------------------------------------------------------------

#: UTF-8 byte ceiling for one DTD document, matching :data:`app.secure_xml.DEFAULT_MAX_XML_BYTES`
#: so every XML-family intake surface agrees on how large a single file may be.
MAX_DTD_BYTES = 10 * 1024 * 1024

#: How many entity references one document may expand in total.
#:
#: A classic billion-laughs chain reaches this within the first few levels of its fan-out;
#: the largest honest DTDs (DocBook is ~1,500 declarations built from a few hundred
#: parameter entities) expand two orders of magnitude fewer.
MAX_ENTITY_EXPANSIONS = 10_000

#: How many bytes of replacement text one document's expansions may produce in total.
#:
#: Charged incrementally as text is appended, so an exponential expansion is stopped while
#: it is being built rather than after it has been materialized.
MAX_EXPANDED_BYTES = 4 * 1024 * 1024

#: How deeply entity expansion may nest — an entity referenced from an entity's replacement
#: text, and so on. Recursion is caught by the active-chain check regardless; this bounds
#: the legitimate-but-absurd case.
MAX_ENTITY_DEPTH = 40

#: How many entities one document may declare.
MAX_DECLARED_ENTITIES = 10_000

#: How deeply a content model's parentheses may nest. The model parser recurses per level,
#: so this is what keeps ``((((…))))`` from raising an uncaught ``RecursionError``.
MAX_MODEL_DEPTH = 64


class DtdParseError(ValueError):
    """A DTD document could not be read.

    Attributes:
        code: The intake-taxonomy code when the reader can classify the failure
            (``INPUT_TRUNCATED``, ``INPUT_SEMANTIC_INVALID``, ``INPUT_REFERENCE_UNRESOLVED``,
            ``INPUT_UNSAFE_CONSTRUCT``, ``INPUT_EXPANSION_LIMIT``, ``INPUT_ENTITY_LIMIT``,
            ``INPUT_DEPTH_LIMIT``, ``INPUT_TOO_LARGE``), and ``None`` for a plain syntax
            error — which the pipeline then classifies itself, so a UTF-16 file reads as an
            encoding fault rather than as malformed markup.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


class ExpansionBudget:
    """The single expansion budget a document is parsed under.

    One instance is threaded through the whole parse — the parameter-entity input stack and
    general-entity value expansion both charge it — so the total work a document can compel
    is bounded no matter which mechanism it uses.

    Attributes:
        expansions: How many references have been expanded so far.
        expanded_bytes: How many bytes of replacement text have been produced so far.
    """

    def __init__(
        self,
        *,
        max_expansions: int = MAX_ENTITY_EXPANSIONS,
        max_bytes: int = MAX_EXPANDED_BYTES,
        max_depth: int = MAX_ENTITY_DEPTH,
    ) -> None:
        self._max_expansions = max_expansions
        self._max_bytes = max_bytes
        self._max_depth = max_depth
        self.expansions = 0
        self.expanded_bytes = 0
        self._chain: List[str] = []

    @property
    def chain(self) -> Tuple[str, ...]:
        """The entities currently being expanded, outermost first."""
        return tuple(self._chain)

    def enter(self, name: str) -> None:
        """Begin expanding ``name``, charging one expansion against the budget.

        Args:
            name: The entity's name, ``%``-prefixed for a parameter entity.

        Raises:
            DtdParseError: If ``name`` is already being expanded (recursion), if the
                expansion count is exhausted, or if the chain is too deep.
        """
        if name in self._chain:
            cycle = " -> ".join((*self._chain, name))
            raise DtdParseError(
                f"entity {name!r} is recursive, which XML forbids and this reader refuses "
                f"to unroll ({cycle})",
                code="INPUT_UNSAFE_CONSTRUCT",
            )
        if len(self._chain) >= self._max_depth:
            raise DtdParseError(
                f"entity expansion nests deeper than the {self._max_depth}-level limit "
                f"(expanding {name!r})",
                code="INPUT_EXPANSION_LIMIT",
            )
        self.expansions += 1
        if self.expansions > self._max_expansions:
            raise DtdParseError(
                f"the document expands more than {self._max_expansions} entity references, "
                f"which is the import limit (expanding {name!r})",
                code="INPUT_EXPANSION_LIMIT",
            )
        self._chain.append(name)

    def leave(self) -> None:
        """Finish expanding the innermost entity."""
        if self._chain:
            self._chain.pop()

    def charge_bytes(self, count: int) -> None:
        """Charge ``count`` bytes of produced replacement text.

        Args:
            count: How many bytes were produced.

        Raises:
            DtdParseError: If the total exceeds the budget.
        """
        self.expanded_bytes += count
        if self.expanded_bytes > self._max_bytes:
            raise DtdParseError(
                f"expanding the document's entities produces more than "
                f"{self._max_bytes} bytes, which is the import limit",
                code="INPUT_EXPANSION_LIMIT",
            )


# ---------------------------------------------------------------------------
# Algebra
# ---------------------------------------------------------------------------


class ContentKind(str, Enum):
    """The shape of a content model or of one particle inside it."""

    EMPTY = "empty"  # <!ELEMENT x EMPTY>
    ANY = "any"  # <!ELEMENT x ANY>
    PCDATA = "pcdata"  # (#PCDATA)
    MIXED = "mixed"  # (#PCDATA | a | b)*
    SEQUENCE = "sequence"  # (a, b)
    CHOICE = "choice"  # (a | b)
    NAME = "name"  # a single element-name particle


class Occurrence(str, Enum):
    """A particle's occurrence indicator."""

    ONE = ""
    OPTIONAL = "?"
    ZERO_OR_MORE = "*"
    ONE_OR_MORE = "+"

    @property
    def repeated(self) -> bool:
        """Whether the particle may appear more than once."""
        return self in (Occurrence.ZERO_OR_MORE, Occurrence.ONE_OR_MORE)

    @property
    def optional(self) -> bool:
        """Whether the particle may be absent."""
        return self in (Occurrence.OPTIONAL, Occurrence.ZERO_OR_MORE)


class AttributeType(str, Enum):
    """The declared type of an attribute (XML 1.0 §3.3.1)."""

    CDATA = "CDATA"
    ID = "ID"
    IDREF = "IDREF"
    IDREFS = "IDREFS"
    ENTITY = "ENTITY"
    ENTITIES = "ENTITIES"
    NMTOKEN = "NMTOKEN"
    NMTOKENS = "NMTOKENS"
    NOTATION = "NOTATION"
    ENUMERATION = "ENUMERATION"


#: Attribute types whose value is a whitespace-separated list of tokens rather than one.
TOKENIZED_ATTRIBUTE_TYPES = frozenset(
    {AttributeType.IDREFS, AttributeType.ENTITIES, AttributeType.NMTOKENS}
)

#: Attribute types that carry XML's cross-reference identity semantics.
IDENTITY_ATTRIBUTE_TYPES = frozenset(
    {AttributeType.ID, AttributeType.IDREF, AttributeType.IDREFS}
)


class AttributeDefault(str, Enum):
    """An attribute's default declaration (XML 1.0 §3.3.2)."""

    REQUIRED = "#REQUIRED"
    IMPLIED = "#IMPLIED"
    FIXED = "#FIXED"
    DEFAULT = "default"  # a bare literal, e.g. `align (left|right) "left"`


@dataclass(frozen=True)
class DtdParticle:
    """One node of a content model.

    Attributes:
        kind: What the node is.
        name: The element name, for :attr:`ContentKind.NAME` particles.
        children: Sub-particles, for sequences, choices and mixed content.
        occurrence: The node's occurrence indicator.
    """

    kind: ContentKind
    name: Optional[str] = None
    children: Tuple["DtdParticle", ...] = ()
    occurrence: Occurrence = Occurrence.ONE

    def element_names(self) -> Tuple[str, ...]:
        """Return every element name this particle's subtree references, in order."""
        if self.kind is ContentKind.NAME and self.name:
            return (self.name,)
        names: List[str] = []
        for child in self.children:
            names.extend(child.element_names())
        return tuple(names)


@dataclass(frozen=True)
class DtdAttribute:
    """One attribute definition from an ``<!ATTLIST>``.

    Attributes:
        name: The attribute's name as declared.
        type: The declared attribute type.
        enumeration: The permitted values, for ``ENUMERATION`` and ``NOTATION`` types.
        default: How the attribute defaults.
        default_value: The literal default (``#FIXED`` and bare-literal defaults).
        element: The element the ``<!ATTLIST>`` named.
    """

    name: str
    type: AttributeType
    enumeration: Tuple[str, ...] = ()
    default: AttributeDefault = AttributeDefault.IMPLIED
    default_value: Optional[str] = None
    element: str = ""


@dataclass(frozen=True)
class DtdElement:
    """One ``<!ELEMENT>`` declaration and the attributes declared for it.

    Attributes:
        name: The element's name.
        content: Its content model.
        attributes: The merged attribute definitions, in declaration order.
    """

    name: str
    content: DtdParticle
    attributes: Tuple[DtdAttribute, ...] = ()


@dataclass(frozen=True)
class DtdEntity:
    """One ``<!ENTITY>`` declaration.

    Attributes:
        name: The entity's name, without the ``%``/``&`` sigil.
        parameter: Whether it is a parameter entity (``<!ENTITY % x …>``).
        value: The **expanded** replacement text, for an internal entity.
        system_id: The system identifier, for an external entity.
        public_id: The public identifier, when one was declared.
        notation: The ``NDATA`` notation name, for an unparsed entity.
    """

    name: str
    parameter: bool = False
    value: Optional[str] = None
    system_id: Optional[str] = None
    public_id: Optional[str] = None
    notation: Optional[str] = None

    @property
    def unparsed(self) -> bool:
        """Whether this is an unparsed entity (``NDATA``)."""
        return self.notation is not None


@dataclass(frozen=True)
class DtdNotation:
    """One ``<!NOTATION>`` declaration.

    Attributes:
        name: The notation's name.
        system_id: Its system identifier, when declared.
        public_id: Its public identifier, when declared.
    """

    name: str
    system_id: Optional[str] = None
    public_id: Optional[str] = None


@dataclass(frozen=True)
class DtdLimit:
    """A construct the reader parsed but the canonical model cannot fully hold.

    An entry here is a **capability statement**, never a defect in the source: FMT-4.2's
    "mixed content is modelled or declared a limit, explicitly" is satisfied by
    ``dtd.mixed_content`` appearing here rather than by mixed content being dropped.

    Attributes:
        construct: The stable key the capability registry publishes (``dtd.mixed_content``).
        detail: One line on what is kept and what is not.
        count: How many times the construct appeared in this document.
        locations: The element declarations the occurrences sit under, sorted.
    """

    construct: str
    detail: str
    count: int = 1
    locations: Tuple[str, ...] = ()


#: The reviewed sentence for each declared limit, keyed by construct.
#:
#: Held here rather than at each recording site so the parser, the capability registry and
#: the per-document coverage ledger all quote one wording. The key set is asserted equal to
#: ``DTD_CAPABILITIES.unsupported`` and to the registry seed's ``dropped_constructs``.
LIMIT_DETAILS: Dict[str, str] = {
    "dtd.any_content": (
        "`ANY` admits character data and any declared element, in any order and any "
        "number. The canonical model names every member, so the element is carried as a "
        "record with its attributes and one open-content member, and the set of children "
        "it actually admits is not enumerable."
    ),
    "dtd.mixed_content": (
        "Mixed content interleaves character data with child elements. The canonical model "
        "has no mixed-content record, so the child elements are carried as ordinary "
        "repeated members alongside a `#text` member, and the interleaving — text before, "
        "between and after the children — is not expressible."
    ),
    "dtd.repeated_group": (
        "An occurrence indicator on a *group* — `(a, b)+` — repeats the group as a unit. "
        "The canonical model repeats members, not groups, so the indicator is distributed "
        "onto the group's members and the fact that they repeat together is lost."
    ),
    "dtd.unparsed_entity": (
        "An unparsed entity (`<!ENTITY logo SYSTEM … NDATA png>`) names external binary "
        "content through a notation. Neither is a canonical construct, so both are "
        "recorded in `extras['dtd']` and the referenced resource is never fetched."
    ),
    "dtd.tokenized_attribute": (
        "`IDREFS`, `ENTITIES` and `NMTOKENS` hold several whitespace-separated tokens in "
        "one attribute value. The member is carried as a list of strings; the fact that "
        "the list is encoded as a single text value is not expressible."
    ),
    "dtd.id_uniqueness": (
        "`ID`, `IDREF` and `IDREFS` declare document-wide uniqueness and referential "
        "integrity. The canonical constraint vocabulary has no identity facet, so the "
        "declared type is recorded on the member and the constraint is not enforced."
    ),
    "dtd.orphan_attlist": (
        "An `<!ATTLIST>` naming an element that is never declared has no type to attach "
        "to. XML permits it, so the import is not failed: the definitions are recorded in "
        "`extras['dtd']['orphan_attlists']` and no canonical member is produced."
    ),
    "dtd.remote_system_id": (
        "An external subset or external entity whose system identifier is an absolute URL "
        "is never fetched during import: the reference is recorded and the declarations "
        "behind it are absent."
    ),
}


class LimitRecorder:
    """Accumulates :class:`DtdLimit` records while a document is read.

    The parser and the normalizer both meet these constructs, and both must record them
    with the same wording and the same de-duplication, so the bookkeeping lives here.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, Set[str]] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The element declaration the occurrence sits under, when known.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown DTD limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def extend(self, limits: Sequence[DtdLimit]) -> None:
        """Fold already-recorded limits (from a parse) back into this recorder.

        Args:
            limits: The limits to absorb, preserving counts and locations.
        """
        for limit in limits:
            self._counts[limit.construct] = self._counts.get(limit.construct, 0) + limit.count
            if limit.locations:
                self._locations.setdefault(limit.construct, set()).update(limit.locations)

    def limits(self) -> Tuple[DtdLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            DtdLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )


@dataclass(frozen=True)
class DtdDocument:
    """A parsed DTD — an external subset, an internal subset, or both composed.

    Attributes:
        name: The ``<!DOCTYPE>`` name, when the DTD travelled inside an instance document.
            ``None`` for a standalone external subset, which declares no root.
        root: The element the document describes, derived when no ``<!DOCTYPE>`` named one.
        elements: Every ``<!ELEMENT>`` declaration with its merged attributes, in
            declaration order.
        entities: Every general ``<!ENTITY>`` declaration, in declaration order.
        parameter_entities: Every ``<!ENTITY %>`` declaration, in declaration order.
        notations: Every ``<!NOTATION>`` declaration, in declaration order.
        orphan_attlists: Attribute definitions whose ``<!ATTLIST>`` named an element that
            was never declared, keyed by that element name.
        external_subsets: System identifiers this document composed in, in the order they
            were pulled.
        unresolved_system_ids: Absolute-URL system identifiers that were recorded and never
            fetched.
        limits: The declared limits this document exercises.
        expansions: How many entity references were expanded reading it.
        raw: The source text, retained for the fidelity bag.
    """

    name: Optional[str] = None
    root: Optional[str] = None
    elements: Tuple[DtdElement, ...] = ()
    entities: Tuple[DtdEntity, ...] = ()
    parameter_entities: Tuple[DtdEntity, ...] = ()
    notations: Tuple[DtdNotation, ...] = ()
    orphan_attlists: Mapping[str, Tuple[DtdAttribute, ...]] = field(default_factory=dict)
    external_subsets: Tuple[str, ...] = ()
    unresolved_system_ids: Tuple[str, ...] = ()
    limits: Tuple[DtdLimit, ...] = ()
    expansions: int = 0
    raw: str = ""


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------


def build_document(
    *,
    name: Optional[str],
    elements: Sequence[DtdElement],
    entities: Sequence[DtdEntity],
    parameter_entities: Sequence[DtdEntity],
    notations: Sequence[DtdNotation],
    orphan_attlists: Mapping[str, Tuple[DtdAttribute, ...]],
    external_subsets: Sequence[str],
    unresolved_system_ids: Sequence[str],
    limits: LimitRecorder,
    expansions: int,
    raw: str,
    source_label: Optional[str] = None,
) -> DtdDocument:
    """Check a read DTD's semantics and assemble it into a :class:`DtdDocument`.

    Two rules are enforced here rather than in the scanner, because both need the whole
    document: a content model may only name elements the document declares, and an element
    may only be declared once.

    Args:
        name: The ``<!DOCTYPE>`` name, when there was one.
        elements: The element declarations, in declaration order.
        entities: The general entity declarations.
        parameter_entities: The parameter entity declarations.
        notations: The notation declarations.
        orphan_attlists: Attribute definitions for elements that were never declared.
        external_subsets: System identifiers composed in.
        unresolved_system_ids: Absolute-URL system identifiers recorded and not fetched.
        limits: The recorder holding the declared limits seen so far.
        expansions: How many entity references were expanded.
        raw: The source text.
        source_label: The document's name, for error messages.

    Returns:
        The assembled document.

    Raises:
        DtdParseError: ``INPUT_SEMANTIC_INVALID`` if an element is declared twice, if a
            content model names an element that is never declared, or if the document
            declares no elements at all.
    """
    where = f" ({source_label})" if source_label else ""

    declared: Dict[str, DtdElement] = {}
    for element in elements:
        if element.name in declared:
            raise DtdParseError(
                f"element {element.name!r} is declared more than once{where}; XML requires "
                f"a unique element-type declaration, and picking one silently would change "
                f"the grammar",
                code="INPUT_SEMANTIC_INVALID",
            )
        declared[element.name] = element

    if not declared:
        raise DtdParseError(
            f"the DTD declares no elements{where}, so it describes no document",
            code="INPUT_SEMANTIC_INVALID",
        )

    missing: List[str] = []
    for element in elements:
        for referenced in element.content.element_names():
            if referenced not in declared and referenced not in missing:
                missing.append(f"{referenced} (in the content model of {element.name})")
    if missing:
        raise DtdParseError(
            f"content models name elements that are never declared{where}: "
            + ", ".join(missing),
            code="INPUT_SEMANTIC_INVALID",
        )

    if name and name in declared:
        root = name
    else:
        root = _derive_root(elements)

    return DtdDocument(
        name=name,
        root=root,
        elements=tuple(elements),
        entities=tuple(entities),
        parameter_entities=tuple(parameter_entities),
        notations=tuple(notations),
        orphan_attlists=dict(orphan_attlists),
        external_subsets=tuple(external_subsets),
        unresolved_system_ids=tuple(unresolved_system_ids),
        limits=limits.limits(),
        expansions=expansions,
        raw=raw,
    )


def _derive_root(elements: Sequence[DtdElement]) -> Optional[str]:
    """Return the element a DTD describes when no ``<!DOCTYPE>`` named one.

    A standalone external subset declares no root, so it is derived structurally: the
    first-declared element that no other element's content model references. A DTD whose
    every element is referenced (a mutually recursive grammar) has no such element, and the
    first declaration is used — that is a guess, and it is recorded as the derived root
    rather than presented as a declared one.

    Args:
        elements: The element declarations, in declaration order.

    Returns:
        The root element's name, or ``None`` when there are no elements.
    """
    if not elements:
        return None
    referenced: Set[str] = set()
    for element in elements:
        referenced.update(element.content.element_names())
    for element in elements:
        if element.name not in referenced:
            return element.name
    return elements[0].name


# ---------------------------------------------------------------------------
# External identifiers
# ---------------------------------------------------------------------------


def is_absolute_system_id(system_id: str) -> bool:
    """Return whether ``system_id`` names an absolute URL rather than a relative path.

    Args:
        system_id: The system identifier as declared.

    Returns:
        ``True`` when it carries a scheme (``http:``, ``file:``, ``urn:``).
    """
    scheme, separator, _ = system_id.partition(":")
    return bool(separator) and scheme.isalpha() and len(scheme) > 1


def resolve_system_id(
    system_id: str,
    *,
    members: Mapping[str, str],
    base: Optional[str],
    limits: LimitRecorder,
    recorded: List[str],
) -> Optional[Tuple[str, str]]:
    """Resolve an external subset or external entity against a fileset's members.

    Relative identifiers resolve against the referring document's directory first (the XML
    rule), then against the bare filename — the same two-step the XSD and RELAX NG readers
    use, so a set assembled from an archive resolves whether or not the archive preserved
    directory prefixes.

    Absolute URLs are **never fetched**. They are vetted for shape only, through
    :func:`app.ssrf_guard.validate_url_policy` — which needs no DNS and is therefore safe to
    call inside a parser: an identifier the policy forbids (``file:``, ``data:``, embedded
    credentials, no host) is an unsafe construct and fails the import, while a policy-legal
    ``http(s)`` identifier is recorded as a declared limit and left unresolved. Import never
    reaches the network, so a DTD cannot make this service fetch a URL of its author's
    choosing — which is precisely the classic XXE and blind-XXE shape.

    Args:
        system_id: The declared system identifier.
        members: Fileset member name -> text.
        base: The member key of the referring document, for relative resolution.
        limits: Recorder for the remote-system-id declared limit.
        recorded: Out-parameter collecting absolute identifiers that were not fetched.

    Returns:
        ``(member_key, text)`` when the identifier resolves inside the set, else ``None``.

    Raises:
        DtdParseError: ``INPUT_UNSAFE_CONSTRUCT`` if the identifier's shape is forbidden by
            the SSRF policy.
    """
    if is_absolute_system_id(system_id):
        from .ssrf_guard import SSRFError, validate_url_policy

        try:
            validate_url_policy(system_id)
        except SSRFError as exc:
            raise DtdParseError(
                f"DTD system identifier {system_id!r} is not a fetchable location: {exc}",
                code="INPUT_UNSAFE_CONSTRUCT",
            ) from exc
        limits.record("dtd.remote_system_id", location=system_id)
        if system_id not in recorded:
            recorded.append(system_id)
        return None

    candidates: List[str] = []
    if base and "/" in base:
        candidates.append(f"{base.rsplit('/', 1)[0]}/{system_id}")
    candidates.append(system_id)
    tail = system_id.rsplit("/", 1)[-1]
    candidates.append(tail)
    for candidate in candidates:
        if candidate in members:
            return candidate, members[candidate]
    for key, text in members.items():
        if key.rsplit("/", 1)[-1] == tail:
            return key, text
    return None
