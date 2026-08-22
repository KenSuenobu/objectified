"""CDDL algebra, prelude and declared limits — FMT-4.4 (#5437).

The shared middle of the CDDL reader and writer: the rule algebra
:mod:`app.cddl_parser` produces, :mod:`app.cddl_normalizer` consumes and
:mod:`app.cddl_emitter` writes back, the prelude every CDDL document inherits without
declaring it, and the vocabulary of constructs the canonical model cannot fully hold.

**Why one module holds all three.** CDDL (RFC 8610) is the schema language of CBOR — COSE,
WebAuthn/FIDO, the EU Digital Identity Wallet and most IETF IoT work are written in it — and
Apiome both reads and writes it. A reader and a writer that disagree about what ``uint``
means, or about which control operators have a canonical analogue, produce a round-trip that
silently changes a grammar. Holding the prelude table, the scalar mapping and the limit
vocabulary in one place is what makes the two directions provably agree: the emitter's
canonical → CDDL table is derived from the reader's CDDL → canonical one.

**Sockets, plugs and generics are resolved here, not approximated.** A type socket
(``$name``) collects its ``/=`` plugs into a choice; a group socket (``$$name``) collects its
``//=`` plugs into a group choice; a generic rule (``page<T>``) is instantiated once per
distinct argument list. All three are *composition* mechanisms — they exist to be resolved
before anything downstream sees a type — and resolving them here is what keeps the normalizer
free of CDDL's extension rules. Each resolution is charged against a budget, because a
generic that instantiates itself would otherwise not terminate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

__all__ = [
    "MAX_CDDL_BYTES",
    "MAX_CDDL_DEPTH",
    "MAX_GENERIC_DEPTH",
    "MAX_GENERIC_INSTANTIATIONS",
    "MAX_RULES",
    "AssignKind",
    "CddlDocument",
    "CddlGroup",
    "CddlLimit",
    "CddlLiteral",
    "CddlMember",
    "CddlMemberKey",
    "CddlNode",
    "CddlParseError",
    "CddlRule",
    "LIMIT_DETAILS",
    "LiteralKind",
    "LimitRecorder",
    "MemberKeyKind",
    "NodeKind",
    "ONCE",
    "Occurrence",
    "PRELUDE_FORMATS",
    "PRELUDE_SCALARS",
    "PRELUDE_TYPES",
    "RuleKind",
    "SocketKind",
    "build_document",
    "canonical_scalar_to_cddl",
    "describe_group",
    "describe_node",
    "is_socket_name",
    "socket_kind",
]

# ---------------------------------------------------------------------------
# Ceilings
# ---------------------------------------------------------------------------

#: UTF-8 byte ceiling for one CDDL document, matching the other text-schema readers so
#: every intake surface agrees on how large a single file may be.
MAX_CDDL_BYTES = 10 * 1024 * 1024

#: How deeply types and groups may nest. The parser is recursive descent with no other
#: parser behind it, so this is what keeps ``[[[[…]]]]`` from raising an uncaught
#: ``RecursionError`` — which the import pipeline does **not** catch, and which would
#: therefore surface as a 5xx rather than as a classified rejection.
MAX_CDDL_DEPTH = 128

#: How many rules one document (or fileset) may declare.
MAX_RULES = 10_000

#: How many generic instantiations one document may produce in total.
MAX_GENERIC_INSTANTIATIONS = 2_000

#: How deeply generic instantiation may nest — a generic instantiated from inside another
#: generic's body, and so on.
#:
#: Two ceilings, because they bound two different failures. A generic rule whose body
#: instantiates itself with a *fresh* argument (``tree<T> = {child: tree<[T]>}``) has no
#: fixed point: each level's argument is structurally larger than the last, so re-entry is
#: never identical and the total count alone would let the substituted argument grow deep
#: enough to raise ``RecursionError`` — which the import pipeline does not catch. Bounding
#: the chain stops that shape while it is still small; the total bounds a document that
#: merely instantiates a great many distinct types.
MAX_GENERIC_DEPTH = 32


class CddlParseError(ValueError):
    """A CDDL document could not be read.

    Attributes:
        code: The intake-taxonomy code when the reader can classify the failure
            (``INPUT_TRUNCATED``, ``INPUT_SEMANTIC_INVALID``, ``INPUT_REFERENCE_UNRESOLVED``,
            ``INPUT_DEPTH_LIMIT``, ``INPUT_TOO_LARGE``, ``INPUT_EXPANSION_LIMIT``), and
            ``None`` for a plain syntax error — which the pipeline then classifies itself, so
            a UTF-16 file reads as an encoding fault and a JSON document as a format
            mismatch, rather than both reading as malformed CDDL.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Algebra
# ---------------------------------------------------------------------------


class RuleKind(str, Enum):
    """Whether a rule names a type or a group.

    RFC 8610 keeps the two namespaces separate: ``a = (b: c)`` declares a *group* that other
    groups splice in, while ``a = {b: c}`` declares a *type* other types reference.
    """

    TYPE = "type"
    GROUP = "group"


class AssignKind(str, Enum):
    """How a rule binds its name."""

    DEFINE = "="  # the one binding a name may have
    TYPE_EXTEND = "/="  # a plug into a type socket
    GROUP_EXTEND = "//="  # a plug into a group socket


class SocketKind(str, Enum):
    """Which kind of socket a ``$``-prefixed name is."""

    TYPE = "type"  # `$name`
    GROUP = "group"  # `$$name`


class NodeKind(str, Enum):
    """The shape of one node of a CDDL type expression."""

    LITERAL = "literal"  # "text" / 5 / h'0f'
    PRELUDE = "prelude"  # uint, tstr, bool … (RFC 8610 Appendix D)
    REFERENCE = "reference"  # another rule's name, with optional generic arguments
    SOCKET = "socket"  # $name / $$name
    PARAMETER = "parameter"  # a generic parameter inside a parameterised rule's body
    MAP = "map"  # { group }
    ARRAY = "array"  # [ group ]
    GROUP = "group"  # ( group ) used where a type is expected
    ENUM_GROUP = "enum_group"  # &( group ) / &groupname
    UNWRAP = "unwrap"  # ~name
    TAG = "tag"  # #6.n(type)
    MAJOR = "major"  # #n / #n.m
    ANY = "any"  # bare #
    CHOICE = "choice"  # a / b / c
    RANGE = "range"  # a..b / a...b
    CONTROL = "control"  # target .op controller


class LiteralKind(str, Enum):
    """The lexical family of a CDDL literal value."""

    TEXT = "text"  # "…"
    BYTES = "bytes"  # '…' / h'…' / b64'…'
    INT = "int"
    FLOAT = "float"


class MemberKeyKind(str, Enum):
    """How a group member names its key."""

    BAREWORD = "bareword"  # name:
    LITERAL = "literal"  # "name": / 1:
    TYPE = "type"  # type1 =>
    NONE = "none"  # positional entry, or a spliced group reference


@dataclass(frozen=True)
class Occurrence:
    """A member's occurrence indicator.

    Attributes:
        minimum: The least number of times the member may appear.
        maximum: The greatest number, or ``None`` for unbounded.
        spelling: The source spelling (``?``, ``+``, ``*``, ``3*3``), kept so the emitter
            writes back what the grammar said rather than a normalized equivalent.
    """

    minimum: int = 1
    maximum: Optional[int] = 1
    spelling: str = ""

    @property
    def optional(self) -> bool:
        """Whether the member may be absent."""
        return self.minimum == 0

    @property
    def repeated(self) -> bool:
        """Whether the member may appear more than once."""
        return self.maximum is None or self.maximum > 1

    @property
    def bounded(self) -> bool:
        """Whether the indicator states an exact upper bound above one."""
        return self.maximum is not None and self.maximum > 1


#: The implicit "exactly once" indicator every member carries unless it says otherwise.
ONCE = Occurrence()


@dataclass(frozen=True)
class CddlLiteral:
    """One literal value.

    Attributes:
        kind: The literal's lexical family.
        value: The parsed Python value — ``str`` for text, ``bytes`` for byte strings,
            ``int``/``float`` for numbers.
        spelling: The exact source text, kept so a byte string written ``h'0f'`` is not
            re-emitted as ``'\\x0f'``.
    """

    kind: LiteralKind
    value: Any
    spelling: str


@dataclass(frozen=True)
class CddlNode:
    """One node of a CDDL type expression.

    A single node type with optional slots, rather than a class per production: the
    normalizer and the emitter both dispatch on :attr:`kind`, and one shape keeps the
    substitution walk (generics) and the equality used to de-duplicate instantiations
    trivially correct.

    Attributes:
        kind: What the node is.
        name: The referenced name, for ``REFERENCE``/``SOCKET``/``PARAMETER``/``UNWRAP``/
            ``ENUM_GROUP``/``PRELUDE``.
        literal: The value, for ``LITERAL``.
        group: The group body, for ``MAP``/``ARRAY``/``GROUP``/``ENUM_GROUP``.
        children: Sub-expressions — the branches of a ``CHOICE``, the two endpoints of a
            ``RANGE``, ``(target, controller)`` of a ``CONTROL``, the tagged type of a ``TAG``.
        operator: The control operator (``.size``) or range operator (``..``/``...``).
        tag: The tag number, for ``TAG``.
        major: The CBOR major type, for ``MAJOR``.
        additional: The additional-information value, for ``MAJOR`` (``#7.25``).
        arguments: Generic arguments supplied at a ``REFERENCE``.
    """

    kind: NodeKind
    name: Optional[str] = None
    literal: Optional[CddlLiteral] = None
    group: Optional["CddlGroup"] = None
    children: Tuple["CddlNode", ...] = ()
    operator: Optional[str] = None
    tag: Optional[int] = None
    major: Optional[int] = None
    additional: Optional[int] = None
    arguments: Tuple["CddlNode", ...] = ()


@dataclass(frozen=True)
class CddlMemberKey:
    """The key half of a group member.

    Attributes:
        kind: How the key is written.
        name: The bareword, for :attr:`MemberKeyKind.BAREWORD`.
        literal: The literal, for :attr:`MemberKeyKind.LITERAL`.
        node: The key type, for :attr:`MemberKeyKind.TYPE`.
        cut: Whether the key cuts (``^ =>``; a bareword or literal ``:`` key cuts
            implicitly, which is why the flag is only set for the explicit spelling).
    """

    kind: MemberKeyKind = MemberKeyKind.NONE
    name: Optional[str] = None
    literal: Optional[CddlLiteral] = None
    node: Optional[CddlNode] = None
    cut: bool = False

    def label(self) -> Optional[str]:
        """Return the member's name when the key states a fixed one, else ``None``."""
        if self.kind is MemberKeyKind.BAREWORD:
            return self.name
        if self.kind is MemberKeyKind.LITERAL and self.literal is not None:
            if self.literal.kind is LiteralKind.TEXT:
                return str(self.literal.value)
            return self.literal.spelling
        return None


@dataclass(frozen=True)
class CddlMember:
    """One entry of a group.

    Attributes:
        key: The member's key.
        value: The member's type.
        occurrence: The member's occurrence indicator.
        description: The trailing ``;`` comment written on the member's own line, when
            there was one — CDDL's only documentation construct.
        line: The 1-based source line the member ended on.
    """

    key: CddlMemberKey
    value: CddlNode
    occurrence: Occurrence = ONCE
    description: Optional[str] = None
    line: int = 0


@dataclass(frozen=True)
class CddlGroup:
    """A group: one or more alternatives, each an ordered sequence of members.

    ``choices`` holds the ``//`` alternatives. A group with no ``//`` has exactly one
    alternative, which is the common case; the plural shape is what lets a group socket's
    plugs and an inline group choice be represented identically.
    """

    choices: Tuple[Tuple[CddlMember, ...], ...] = ()

    @property
    def members(self) -> Tuple[CddlMember, ...]:
        """The first alternative's members — the whole group when there is no ``//``."""
        return self.choices[0] if self.choices else ()

    @property
    def has_choice(self) -> bool:
        """Whether the group states more than one alternative."""
        return len(self.choices) > 1


@dataclass(frozen=True)
class CddlRule:
    """One rule declaration.

    Attributes:
        name: The rule's name, including any ``$``/``$$`` socket sigil.
        kind: Whether the rule declares a type or a group.
        assign: How the rule binds its name.
        parameters: The generic parameter names, for a parameterised rule.
        node: The rule's body, for a type rule.
        group: The rule's body, for a group rule.
        description: The comment block written immediately above the rule, when there was
            one — CDDL's only documentation construct.
        line: The 1-based source line the rule's name sits on.
        source: The fileset member the rule was read from.
    """

    name: str
    kind: RuleKind
    assign: AssignKind = AssignKind.DEFINE
    parameters: Tuple[str, ...] = ()
    node: Optional[CddlNode] = None
    group: Optional[CddlGroup] = None
    description: Optional[str] = None
    line: int = 0
    source: Optional[str] = None


@dataclass(frozen=True)
class CddlLimit:
    """A construct the reader parsed but the canonical model cannot fully hold.

    An entry here is a **capability statement**, never a defect in the source: FMT-4.4's
    "control operators map to canonical constraints where an analogue exists and are
    declared losses where none does" is satisfied by ``cddl.control_cbor`` appearing here
    rather than by ``.cbor`` being dropped.

    Attributes:
        construct: The stable key the capability registry publishes.
        detail: One line on what is kept and what is not.
        count: How many times the construct appeared in this document.
        locations: The rules the occurrences sit under, sorted.
    """

    construct: str
    detail: str
    count: int = 1
    locations: Tuple[str, ...] = ()


#: The reviewed sentence for each declared limit, keyed by construct.
#:
#: Held here rather than at each recording site so the parser, the normalizer, the capability
#: registry and the per-document coverage ledger all quote one wording. The key set is
#: asserted equal to ``CDDL_CAPABILITIES.unsupported`` and to the registry seed's
#: ``dropped_constructs``.
LIMIT_DETAILS: Dict[str, str] = {
    "cddl.control_bits": (
        "`.bits` reads an integer as a bit set whose positions are named by a group. The "
        "canonical constraint vocabulary has no bit-set facet, so the member keeps its "
        "integer type and the named group is recorded in `cddl_control`; which bits are "
        "legal is not enforced."
    ),
    "cddl.control_cbor": (
        "`.cbor` and `.cborseq` say a byte string carries a *nested* CBOR encoding of "
        "another type. The canonical model has no embedded-encoding facet, so the member "
        "stays a byte string and the embedded type is recorded in `cddl_control` — the "
        "nesting is described, not modelled."
    ),
    "cddl.control_intersection": (
        "`.and` admits only values matching both operands. The canonical model has no "
        "intersection type, so the constraints of both sides are merged when both are "
        "expressible and the left operand is kept alone when they are not."
    ),
    "cddl.control_unmapped": (
        "A control operator with no canonical analogue — `.ne`, and any operator outside "
        "RFC 8610 and RFC 9165 — is recorded on the member in `cddl_control` and is not "
        "enforced. The member keeps the type its left operand states."
    ),
    "cddl.control_within": (
        "`.within` asserts that one type is a subset of another. The canonical model has "
        "no subtype assertion, so the narrower (left) type is carried and the wider one is "
        "recorded in `cddl_control`; the relationship between them is not checked."
    ),
    "cddl.generic_rule": (
        "A generic rule (`page<T>`) has no canonical type of its own — its parameters are "
        "unbound. Every instantiation the document actually uses becomes its own type with "
        "the arguments substituted, and the parameterised definition is recorded in "
        "`extras['cddl']['generics']`. A generic never instantiated in the document "
        "produces no type."
    ),
    "cddl.group_choice": (
        "A group choice (`//`) spliced into a larger group states that one *set* of "
        "members applies. A canonical record holds one set of members, so the first "
        "alternative is carried and the others are recorded; a group choice that is the "
        "whole body of a map or an array is modelled exactly, as a union of one record per "
        "alternative."
    ),
    "cddl.group_socket": (
        "A group socket (`$$name`) is spliced from the `//=` plugs the document supplies. "
        "The plugs present are resolved, and the socket's open-endedness — that a later "
        "file may add another plug — is not expressible."
    ),
    "cddl.major_type": (
        "A bare major-type shorthand (`#2`, `#7.25`) names a CBOR encoding slot rather "
        "than a value space. The nearest canonical scalar is used and the shorthand is "
        "recorded, so `#2` reads as bytes without claiming to be a declared byte string."
    ),
    "cddl.open_map_entry": (
        "A table entry (`* label => values`) alongside named members admits any number of "
        "further entries whose keys are not enumerable. The named members are carried and "
        "the table becomes one open-content member named `*`; a map whose *whole* body is "
        "a table is modelled exactly, as a canonical `MAP`."
    ),
    "cddl.tag": (
        "A CBOR tag (`#6.1(number)`) marks a value's semantics in the encoding. The "
        "canonical model has no tag facet, so the tagged type is carried and the tag "
        "number is recorded in `cddl_tag` — preserved and re-emitted, but not modelled."
    ),
    "cddl.type_socket": (
        "A type socket (`$name`) is resolved to a choice over the `/=` plugs the document "
        "supplies. The plugs present are modelled as union members, and the socket's "
        "open-endedness — that a later file may add another plug — is not expressible."
    ),
    "cddl.unwrap": (
        "`~name` strips one layer of the referenced type's map or array so its members "
        "appear inline. The canonical model names the referenced type rather than copying "
        "it, so the member is typed by that type and the unwrapping is recorded."
    ),
}


class LimitRecorder:
    """Accumulates :class:`CddlLimit` records while a document is read and normalized.

    The parser (composition) and the normalizer (projection) both meet these constructs,
    and both must record them with the same wording and the same de-duplication, so the
    bookkeeping lives here.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, Set[str]] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The rule the occurrence sits under, when known.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown CDDL limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def extend(self, limits: Sequence[CddlLimit]) -> None:
        """Fold already-recorded limits (from a parse) back into this recorder.

        Args:
            limits: The limits to absorb, preserving counts and locations.
        """
        for limit in limits:
            self._counts[limit.construct] = (
                self._counts.get(limit.construct, 0) + limit.count
            )
            if limit.locations:
                self._locations.setdefault(limit.construct, set()).update(limit.locations)

    def limits(self) -> Tuple[CddlLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            CddlLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )


@dataclass(frozen=True)
class CddlDocument:
    """A parsed CDDL grammar — one file, or a fileset composed into one namespace.

    Attributes:
        rules: Every rule, in declaration order, with sockets resolved and generics
            instantiated. Plug rules (``/=``/``//=``) are folded into their socket and do
            not appear again here.
        root: The name of the rule the grammar starts at — the first rule declared, which
            is RFC 8610's own rule, unless the document declares ``start``.
        generics: The parameterised rules, keyed by name, with their parameter lists —
            recorded because they have no canonical type of their own.
        instantiations: ``instantiated name -> (generic name, argument spellings)`` for
            every generic instantiation the document used.
        sockets: ``socket name -> the plug rule names that filled it``, in declaration
            order.
        members: The fileset member names the document was composed from, in load order.
        limits: The declared limits this document exercises.
        description: The file-level comment block — a comment separated from the first
            rule by a blank line — when there was one.
        raw: The source text, retained for the fidelity bag.
    """

    rules: Tuple[CddlRule, ...] = ()
    root: Optional[str] = None
    generics: Mapping[str, Tuple[str, ...]] = field(default_factory=dict)
    instantiations: Mapping[str, Tuple[str, Tuple[str, ...]]] = field(default_factory=dict)
    sockets: Mapping[str, Tuple[str, ...]] = field(default_factory=dict)
    members: Tuple[str, ...] = ()
    limits: Tuple[CddlLimit, ...] = ()
    description: Optional[str] = None
    raw: str = ""

    def rule(self, name: str) -> Optional[CddlRule]:
        """Return the rule named ``name``, or ``None`` when the document declares none."""
        for candidate in self.rules:
            if candidate.name == name:
                return candidate
        return None


# ---------------------------------------------------------------------------
# The prelude (RFC 8610 Appendix D)
# ---------------------------------------------------------------------------

#: Every prelude name, mapped to the canonical scalar it projects onto.
#:
#: The prelude is the set of names a CDDL document may use without declaring them. It is
#: *not* a set of reserved words — a document may shadow any of them with its own rule, and
#: the reader honours that, so this table is consulted only for names the document leaves
#: undeclared.
PRELUDE_SCALARS: Dict[str, str] = {
    "any": "any",
    "uint": "uint64",
    "nint": "i64",
    "int": "i64",
    "bstr": "bytes",
    "bytes": "bytes",
    "tstr": "string",
    "text": "string",
    "tdate": "string",
    "time": "double",
    "number": "number",
    "biguint": "integer",
    "bignint": "integer",
    "bigint": "integer",
    "integer": "integer",
    "unsigned": "integer",
    "decfrac": "double",
    "bigfloat": "double",
    "eb64url": "any",
    "eb64legacy": "any",
    "eb16": "any",
    "encoded-cbor": "bytes",
    "uri": "string",
    "b64url": "string",
    "b64legacy": "string",
    "regexp": "string",
    "mime-message": "string",
    "cbor-any": "any",
    "float16": "float",
    "float32": "float",
    "float64": "double",
    "float16-32": "float",
    "float32-64": "double",
    "float": "double",
    "false": "bool",
    "true": "bool",
    "bool": "bool",
    "nil": "null",
    "null": "null",
    "undefined": "null",
}

#: Prelude names that carry a canonical ``format`` hint alongside their scalar.
PRELUDE_FORMATS: Dict[str, str] = {
    "tdate": "date-time",
    "time": "date-time",
    "uri": "uri",
    "b64url": "byte",
    "b64legacy": "byte",
    "regexp": "regex",
    "biguint": "bignum",
    "bignint": "bignum",
    "bigint": "bignum",
}

#: The prelude names a reader recognizes, as a set.
PRELUDE_TYPES = frozenset(PRELUDE_SCALARS)

#: Canonical scalar -> the CDDL prelude type the emitter writes for it.
#:
#: Derived from :data:`PRELUDE_SCALARS` by choosing, for each canonical scalar, the prelude
#: name a reader would map straight back — so ``bytes -> bstr -> bytes`` is a fixed point.
#: Names the reader maps *into* a scalar but that are not that scalar's preferred spelling
#: (``text``, ``bytes``, ``null``) are deliberately absent.
_CANONICAL_TO_CDDL: Dict[str, str] = {
    "any": "any",
    "bool": "bool",
    "boolean": "bool",
    "string": "tstr",
    "str": "tstr",
    "text": "tstr",
    "uuid": "tstr",
    "date": "tstr",
    "date-time": "tdate",
    "timestamp": "tdate",
    "instant": "tdate",
    "duration": "tstr",
    "bytes": "bstr",
    "binary": "bstr",
    "blob": "bstr",
    "integer": "int",
    "int": "int",
    "i8": "int",
    "int8": "int",
    "i16": "int",
    "int16": "int",
    "i32": "int",
    "int32": "int",
    "i64": "int",
    "int64": "int",
    "long": "int",
    "short": "int",
    "byte": "int",
    "sbyte": "int",
    "sint32": "int",
    "sint64": "int",
    "sfixed32": "int",
    "sfixed64": "int",
    "bigint": "bigint",
    "uint8": "uint",
    "uint16": "uint",
    "uint32": "uint",
    "uint64": "uint",
    "fixed32": "uint",
    "fixed64": "uint",
    "unsigned": "uint",
    "number": "number",
    "decimal": "number",
    "float": "float32",
    "f32": "float32",
    "double": "float64",
    "f64": "float64",
    "null": "nil",
    "void": "nil",
    "none": "nil",
}


def canonical_scalar_to_cddl(scalar: Optional[str]) -> Optional[str]:
    """Return the CDDL prelude type a canonical scalar name projects onto.

    Args:
        scalar: The canonical scalar name, or ``None``.

    Returns:
        The prelude type name, or ``None`` when the scalar has no prelude analogue and the
        caller must record a loss.
    """
    if not scalar:
        return None
    return _CANONICAL_TO_CDDL.get(scalar.strip().lower())


# ---------------------------------------------------------------------------
# Sockets
# ---------------------------------------------------------------------------


def is_socket_name(name: str) -> bool:
    """Return whether ``name`` is a socket (``$name`` or ``$$name``)."""
    return name.startswith("$")


def socket_kind(name: str) -> Optional[SocketKind]:
    """Return which kind of socket ``name`` is, or ``None`` when it is not one.

    Args:
        name: The rule name as written.

    Returns:
        :attr:`SocketKind.GROUP` for ``$$name``, :attr:`SocketKind.TYPE` for ``$name``,
        ``None`` otherwise.
    """
    if name.startswith("$$"):
        return SocketKind.GROUP
    if name.startswith("$"):
        return SocketKind.TYPE
    return None


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------


def build_document(
    *,
    rules: Sequence[CddlRule],
    limits: LimitRecorder,
    members: Sequence[str],
    description: Optional[str],
    raw: str,
    source_label: Optional[str] = None,
) -> CddlDocument:
    """Check a read grammar's semantics and assemble it into a :class:`CddlDocument`.

    Three rules are enforced here rather than in the scanner, because all three need the
    whole document: a name may be bound by ``=`` only once, every referenced name must
    resolve, and a grammar must declare at least one rule. Socket plugs are folded into
    their socket and generics are instantiated per use, both of which are *composition* and
    therefore finished before anything downstream sees a rule.

    Args:
        rules: The rules, in declaration order, across every fileset member.
        limits: The recorder holding the declared limits seen so far.
        members: The fileset member names the rules were read from, in load order.
        description: The file-level comment, when the root member carried one.
        raw: The source text.
        source_label: The document's name, for error messages.

    Returns:
        The assembled document.

    Raises:
        CddlParseError: ``INPUT_SEMANTIC_INVALID`` when a name is bound twice or the
            grammar declares no rules, and ``INPUT_REFERENCE_UNRESOLVED`` when a rule
            references a name that is neither declared nor part of the prelude.
    """
    where = f" ({source_label})" if source_label else ""

    if not rules:
        raise CddlParseError(
            f"the CDDL document declares no rules{where}, so it describes no data",
            code="INPUT_SEMANTIC_INVALID",
        )
    if len(rules) > MAX_RULES:
        raise CddlParseError(
            f"the CDDL document declares more than {MAX_RULES} rules{where}, which is the "
            f"import limit",
            code="INPUT_EXPANSION_LIMIT",
        )

    declared: Dict[str, CddlRule] = {}
    sockets: Dict[str, List[str]] = {}
    plugs: Dict[str, List[CddlRule]] = {}
    order: List[str] = []

    for rule in rules:
        if rule.assign is AssignKind.DEFINE:
            if rule.name in declared:
                raise CddlParseError(
                    f"rule {rule.name!r} is assigned with `=` more than once{where}; CDDL "
                    f"binds a name once and extends it only through `/=` or `//=`, and "
                    f"picking one binding silently would change the grammar",
                    code="INPUT_SEMANTIC_INVALID",
                )
            declared[rule.name] = rule
            order.append(rule.name)
            continue
        # A plug. Its socket need not be declared with `=` — a socket that only ever
        # receives plugs is the ordinary spelling — so the socket is created on first use.
        plugs.setdefault(rule.name, []).append(rule)
        sockets.setdefault(rule.name, []).append(_plug_label(rule))
        if rule.name not in order:
            order.append(rule.name)

    for name, filled in plugs.items():
        resolved = _resolve_socket(name, filled, existing=declared.get(name), limits=limits)
        declared[name] = resolved

    ordered = [declared[name] for name in order if name in declared]
    generics = {rule.name: rule.parameters for rule in ordered if rule.parameters}
    for name in generics:
        limits.record("cddl.generic_rule", location=name)

    instantiator = _GenericInstantiator(declared, limits)
    ordered = instantiator.expand(ordered)
    declared = {rule.name: rule for rule in ordered}

    _check_references(ordered, declared, where=where)

    root = _derive_root(ordered, declared)

    return CddlDocument(
        rules=tuple(ordered),
        root=root,
        generics=dict(generics),
        instantiations=dict(instantiator.instantiations),
        sockets={name: tuple(filled) for name, filled in sorted(sockets.items())},
        members=tuple(members),
        limits=limits.limits(),
        description=description,
        raw=raw,
    )


def _plug_label(rule: CddlRule) -> str:
    """Return a stable label for one plug, for the socket's recorded plug list.

    Derived from the plug's *body*, never from its position, so re-reading a grammar this
    repository wrote records the same plug list it read.
    """
    if rule.node is not None:
        return describe_node(rule.node)
    return rule.name


def _resolve_socket(
    name: str,
    filled: Sequence[CddlRule],
    *,
    existing: Optional[CddlRule],
    limits: LimitRecorder,
) -> CddlRule:
    """Fold a socket's plugs into the one rule that stands for the socket.

    A type socket's plugs become the branches of a choice; a group socket's plugs become
    the alternatives of a group choice. Both are recorded as declared limits, because what
    cannot be carried is not the plugs — those are resolved exactly — but the socket's
    *open-endedness*: a later file may supply another plug, and a closed model cannot say so.

    Args:
        name: The socket's name, including its sigil.
        filled: The plug rules, in declaration order.
        existing: The socket's own ``=`` binding, when the document declared one.
        limits: Recorder for the socket limits.

    Returns:
        One rule standing for the resolved socket.
    """
    kind = socket_kind(name)
    if kind is SocketKind.GROUP:
        limits.record("cddl.group_socket", location=name)
        choices: List[Tuple[CddlMember, ...]] = []
        if existing is not None and existing.group is not None:
            choices.extend(existing.group.choices)
        for plug in filled:
            if plug.group is not None:
                choices.extend(plug.group.choices)
            elif plug.node is not None:
                choices.append(
                    (CddlMember(key=CddlMemberKey(), value=plug.node, line=plug.line),)
                )
        return CddlRule(
            name=name,
            kind=RuleKind.GROUP,
            group=CddlGroup(choices=tuple(choices)),
            description=existing.description if existing else None,
            line=filled[0].line if filled else 0,
            source=filled[0].source if filled else None,
        )

    limits.record("cddl.type_socket", location=name)
    branches: List[CddlNode] = []
    if existing is not None and existing.node is not None:
        branches.extend(_choice_branches(existing.node))
    for plug in filled:
        if plug.node is not None:
            branches.extend(_choice_branches(plug.node))
        elif plug.group is not None:
            branches.append(CddlNode(kind=NodeKind.GROUP, group=plug.group))
    node = (
        branches[0]
        if len(branches) == 1
        else CddlNode(kind=NodeKind.CHOICE, children=tuple(branches))
    )
    return CddlRule(
        name=name,
        kind=RuleKind.TYPE,
        node=node,
        description=existing.description if existing else None,
        line=filled[0].line if filled else 0,
        source=filled[0].source if filled else None,
    )


def _choice_branches(node: CddlNode) -> Tuple[CddlNode, ...]:
    """Return ``node``'s branches when it is a choice, else ``node`` alone."""
    if node.kind is NodeKind.CHOICE:
        return node.children
    return (node,)


class _GenericInstantiator:
    """Instantiates every generic use a document makes, once per distinct argument list.

    A generic rule has no canonical type — its parameters are unbound — so the only honest
    projection is to produce one concrete rule per instantiation the document actually
    performs. Instantiations are keyed by ``(rule, argument spellings)`` so ``page<tstr>``
    used in ten places yields one type, and re-entering an identical instantiation is
    refused rather than unrolled.
    """

    def __init__(self, declared: Mapping[str, CddlRule], limits: LimitRecorder) -> None:
        self._declared = dict(declared)
        self._limits = limits
        self._emitted: Dict[str, CddlRule] = {}
        self._depth = 0
        self._count = 0
        #: ``(generic name, argument spellings) -> instantiated name``. Keyed by the
        #: *signature* rather than by the folded name so two structurally different argument
        #: lists that fold to the same identifier (``page<tstr>`` and ``page<[tstr]>``) get
        #: two rules rather than silently sharing one.
        self._by_signature: Dict[Tuple[str, Tuple[str, ...]], str] = {}
        self._claimed: Set[str] = set(declared)
        #: instantiated name -> (generic rule name, argument spellings)
        self.instantiations: Dict[str, Tuple[str, Tuple[str, ...]]] = {}

    def _claim(self, preferred: str) -> str:
        """Return an unused rule name close to ``preferred``."""
        if preferred not in self._claimed:
            self._claimed.add(preferred)
            return preferred
        suffix = 2
        while f"{preferred}_{suffix}" in self._claimed:
            suffix += 1
        claimed = f"{preferred}_{suffix}"
        self._claimed.add(claimed)
        return claimed

    def expand(self, rules: Sequence[CddlRule]) -> List[CddlRule]:
        """Return ``rules`` with every generic use replaced by a concrete instantiation.

        Args:
            rules: The declared rules, in declaration order.

        Returns:
            The rules a normalizer sees: the non-generic rules with their bodies rewritten,
            followed by one rule per instantiation, in the order the instantiations were
            first needed.
        """
        rewritten: List[CddlRule] = []
        for rule in rules:
            if rule.parameters:
                # The parameterised definition itself has no concrete body to project.
                continue
            rewritten.append(self._rewrite_rule(rule))
        return rewritten + list(self._emitted.values())

    def _rewrite_rule(self, rule: CddlRule) -> CddlRule:
        """Return ``rule`` with generic references in its body instantiated."""
        node = self._rewrite_node(rule.node) if rule.node is not None else None
        group = self._rewrite_group(rule.group) if rule.group is not None else None
        if node is rule.node and group is rule.group:
            return rule
        return CddlRule(
            name=rule.name,
            kind=rule.kind,
            assign=rule.assign,
            parameters=rule.parameters,
            node=node,
            group=group,
            description=rule.description,
            line=rule.line,
            source=rule.source,
        )

    def _rewrite_group(self, group: CddlGroup) -> CddlGroup:
        """Return ``group`` with generic references in its members instantiated."""
        return CddlGroup(
            choices=tuple(
                tuple(
                    CddlMember(
                        key=self._rewrite_key(member.key),
                        value=self._rewrite_node(member.value),
                        occurrence=member.occurrence,
                        description=member.description,
                        line=member.line,
                    )
                    for member in choice
                )
                for choice in group.choices
            )
        )

    def _rewrite_key(self, key: CddlMemberKey) -> CddlMemberKey:
        """Return ``key`` with a generic reference in a ``type1 =>`` key instantiated."""
        if key.node is None:
            return key
        return CddlMemberKey(
            kind=key.kind,
            name=key.name,
            literal=key.literal,
            node=self._rewrite_node(key.node),
            cut=key.cut,
        )

    def _rewrite_node(self, node: CddlNode) -> CddlNode:
        """Return ``node`` with every generic reference beneath it instantiated."""
        if node.kind is NodeKind.REFERENCE and node.arguments:
            return CddlNode(kind=NodeKind.REFERENCE, name=self._instantiate(node))
        group = self._rewrite_group(node.group) if node.group is not None else None
        children = tuple(self._rewrite_node(child) for child in node.children)
        if group is node.group and children == node.children:
            return node
        return CddlNode(
            kind=node.kind,
            name=node.name,
            literal=node.literal,
            group=group,
            children=children,
            operator=node.operator,
            tag=node.tag,
            major=node.major,
            additional=node.additional,
            arguments=node.arguments,
        )

    def _instantiate(self, reference: CddlNode) -> str:
        """Instantiate one generic use and return the concrete rule name it resolves to.

        Args:
            reference: The ``REFERENCE`` node carrying generic arguments.

        Returns:
            The instantiated rule's name.

        Raises:
            CddlParseError: ``INPUT_REFERENCE_UNRESOLVED`` when the generic is not declared
                or is given the wrong number of arguments, and ``INPUT_EXPANSION_LIMIT``
                when instantiation does not terminate.
        """
        name = reference.name or ""
        generic = self._declared.get(name)
        if generic is None or not generic.parameters:
            raise CddlParseError(
                f"rule {name!r} is used with generic arguments but is not a generic rule",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        arguments = tuple(self._rewrite_node(argument) for argument in reference.arguments)
        if len(arguments) != len(generic.parameters):
            raise CddlParseError(
                f"generic rule {name!r} takes {len(generic.parameters)} argument(s) but is "
                f"used with {len(arguments)}",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        spellings = tuple(describe_node(argument) for argument in arguments)
        signature = (name, spellings)
        existing = self._by_signature.get(signature)
        if existing is not None:
            # Either this instantiation was already produced, or we are re-entering an
            # identical one — in both cases the same rule is meant, so it is named, not
            # expanded again.
            return existing

        self._count += 1
        if self._count > MAX_GENERIC_INSTANTIATIONS:
            raise CddlParseError(
                f"the document performs more than {MAX_GENERIC_INSTANTIATIONS} generic "
                f"instantiations, which is the import limit (instantiating {name!r})",
                code="INPUT_EXPANSION_LIMIT",
            )
        if self._depth >= MAX_GENERIC_DEPTH:
            raise CddlParseError(
                f"generic instantiation nests deeper than the {MAX_GENERIC_DEPTH}-level "
                f"limit (instantiating {name!r}); a generic whose body instantiates itself "
                f"with a larger argument has no fixed point",
                code="INPUT_EXPANSION_LIMIT",
            )

        instantiated = self._claim(_instantiated_name(name, spellings))
        self._by_signature[signature] = instantiated
        self.instantiations[instantiated] = signature

        bindings = dict(zip(generic.parameters, arguments))
        self._depth += 1
        try:
            node = (
                self._rewrite_node(_substitute(generic.node, bindings))
                if generic.node is not None
                else None
            )
            group = (
                self._rewrite_group(_substitute_group(generic.group, bindings))
                if generic.group is not None
                else None
            )
        finally:
            self._depth -= 1

        self._emitted[instantiated] = CddlRule(
            name=instantiated,
            kind=generic.kind,
            node=node,
            group=group,
            description=generic.description,
            line=generic.line,
            source=generic.source,
        )
        return instantiated


def _instantiated_name(name: str, spellings: Sequence[str]) -> str:
    """Return the concrete rule name one generic instantiation takes.

    ``page<$message>`` becomes ``page_message``: readable, deterministic, and free of the
    ``<``/``>``/``$`` characters a canonical type key may not carry.

    Args:
        name: The generic rule's name.
        spellings: The argument spellings, in order.

    Returns:
        The instantiated name.
    """
    parts = [_identifier_fragment(name)]
    parts.extend(_identifier_fragment(spelling) for spelling in spellings)
    return "_".join(part for part in parts if part)


def _identifier_fragment(value: str) -> str:
    """Return ``value`` reduced to the characters an instantiated rule name may carry."""
    folded = "".join(
        character if (character.isalnum() or character in "-_") else "_"
        for character in value
    )
    return folded.strip("_") or "arg"


def _substitute(node: Optional[CddlNode], bindings: Mapping[str, CddlNode]) -> Optional[CddlNode]:
    """Return ``node`` with every generic parameter replaced by its bound argument.

    Args:
        node: The node to rewrite, or ``None``.
        bindings: Parameter name -> argument node.

    Returns:
        The rewritten node, or ``None`` when ``node`` was.
    """
    if node is None:
        return None
    if node.kind is NodeKind.PARAMETER and node.name in bindings:
        return bindings[node.name]
    if node.kind is NodeKind.REFERENCE and node.name in bindings and not node.arguments:
        return bindings[node.name]
    return CddlNode(
        kind=node.kind,
        name=node.name,
        literal=node.literal,
        group=_substitute_group(node.group, bindings) if node.group is not None else None,
        children=tuple(
            child
            for child in (_substitute(child, bindings) for child in node.children)
            if child is not None
        ),
        operator=node.operator,
        tag=node.tag,
        major=node.major,
        additional=node.additional,
        arguments=tuple(
            argument
            for argument in (_substitute(argument, bindings) for argument in node.arguments)
            if argument is not None
        ),
    )


def _substitute_group(group: CddlGroup, bindings: Mapping[str, CddlNode]) -> CddlGroup:
    """Return ``group`` with every generic parameter replaced by its bound argument."""
    return CddlGroup(
        choices=tuple(
            tuple(
                CddlMember(
                    key=CddlMemberKey(
                        kind=member.key.kind,
                        name=member.key.name,
                        literal=member.key.literal,
                        node=_substitute(member.key.node, bindings),
                        cut=member.key.cut,
                    ),
                    value=_substitute(member.value, bindings) or member.value,
                    occurrence=member.occurrence,
                    description=member.description,
                    line=member.line,
                )
                for member in choice
            )
            for choice in group.choices
        )
    )


def describe_node(node: CddlNode) -> str:
    """Return a short, stable description of a type expression.

    Used to name generic instantiations and to quote a construct in a limit's location, so
    it must be deterministic and free of newlines — not a full re-rendering, which is
    :mod:`app.cddl_emitter`'s job.

    Args:
        node: The node to describe.

    Returns:
        A one-line description.
    """
    if node.kind in (NodeKind.REFERENCE, NodeKind.SOCKET, NodeKind.PARAMETER, NodeKind.PRELUDE):
        return node.name or node.kind.value
    if node.kind is NodeKind.LITERAL and node.literal is not None:
        return node.literal.spelling
    if node.kind is NodeKind.UNWRAP:
        return f"~{node.name}"
    if node.kind is NodeKind.ENUM_GROUP:
        return f"&{node.name}" if node.name else "&group"
    if node.kind is NodeKind.TAG:
        inner = describe_node(node.children[0]) if node.children else "any"
        return f"#6.{node.tag}({inner})" if node.tag is not None else f"#6({inner})"
    if node.kind is NodeKind.MAJOR:
        return f"#{node.major}" + (f".{node.additional}" if node.additional is not None else "")
    if node.kind is NodeKind.CHOICE:
        return "/".join(describe_node(child) for child in node.children)
    if node.kind is NodeKind.RANGE and len(node.children) == 2:
        return (
            f"{describe_node(node.children[0])}{node.operator}"
            f"{describe_node(node.children[1])}"
        )
    if node.kind is NodeKind.CONTROL and len(node.children) == 2:
        return (
            f"{describe_node(node.children[0])} {node.operator} "
            f"{describe_node(node.children[1])}"
        )
    if node.kind is NodeKind.MAP and node.group is not None:
        return "{" + describe_group(node.group) + "}"
    if node.kind is NodeKind.ARRAY and node.group is not None:
        return "[" + describe_group(node.group) + "]"
    if node.kind is NodeKind.GROUP and node.group is not None:
        return "(" + describe_group(node.group) + ")"
    return node.kind.value


def describe_group(group: CddlGroup) -> str:
    """Return a short, stable description of a group body.

    Recursive rather than a bare ``"group"`` label because a generic instantiation is named
    after its arguments: collapsing every array to one word would make ``page<[tstr]>`` and
    ``page<[uint]>`` claim the same instantiated rule.

    Args:
        group: The group to describe.

    Returns:
        A one-line description.
    """
    return " // ".join(
        ", ".join(_describe_member(member) for member in choice)
        for choice in group.choices
    )


def _describe_member(member: CddlMember) -> str:
    """Return a short, stable description of one group member."""
    prefix = f"{member.occurrence.spelling} " if member.occurrence.spelling else ""
    label = member.key.label()
    if label is not None:
        return f"{prefix}{label}: {describe_node(member.value)}"
    if member.key.kind is MemberKeyKind.TYPE and member.key.node is not None:
        return f"{prefix}{describe_node(member.key.node)} => {describe_node(member.value)}"
    return f"{prefix}{describe_node(member.value)}"


def _check_references(
    rules: Sequence[CddlRule],
    declared: Mapping[str, CddlRule],
    *,
    where: str,
) -> None:
    """Fail the import when a rule references a name nothing declares.

    A CDDL grammar has no ``include``: a reference that does not resolve inside the
    supplied file (or fileset) is missing, not deferred. Treating it as ``any`` would
    silently produce a smaller grammar than the author wrote, so it is a hard failure that
    names the missing rule.

    Args:
        rules: The rules to check.
        declared: Every declared name.
        where: The source label suffix for error messages.

    Raises:
        CddlParseError: ``INPUT_REFERENCE_UNRESOLVED`` naming every unresolved reference.
    """
    missing: List[str] = []
    seen: Set[str] = set()
    for rule in rules:
        for referenced in _referenced_names(rule):
            if referenced in declared or referenced in PRELUDE_TYPES:
                continue
            token = f"{referenced} (in rule {rule.name})"
            if token not in seen:
                seen.add(token)
                missing.append(token)
    if missing:
        raise CddlParseError(
            f"the grammar references rules that are never defined{where}: "
            + ", ".join(missing)
            + ". CDDL has no include directive, so a companion file must be supplied "
            "alongside the root rather than resolved on its behalf.",
            code="INPUT_REFERENCE_UNRESOLVED",
        )


def _referenced_names(rule: CddlRule) -> Tuple[str, ...]:
    """Return every rule name ``rule``'s body references, in encounter order."""
    names: List[str] = []
    if rule.node is not None:
        _collect_names(rule.node, names)
    if rule.group is not None:
        _collect_group_names(rule.group, names)
    return tuple(names)


def _collect_names(node: CddlNode, names: List[str]) -> None:
    """Accumulate the rule names ``node``'s subtree references."""
    if node.kind in (NodeKind.REFERENCE, NodeKind.SOCKET, NodeKind.UNWRAP) and node.name:
        names.append(node.name)
    if node.kind is NodeKind.ENUM_GROUP and node.name:
        names.append(node.name)
    for child in node.children:
        _collect_names(child, names)
    for argument in node.arguments:
        _collect_names(argument, names)
    if node.group is not None:
        _collect_group_names(node.group, names)


def _collect_group_names(group: CddlGroup, names: List[str]) -> None:
    """Accumulate the rule names ``group``'s members reference."""
    for choice in group.choices:
        for member in choice:
            if member.key.node is not None:
                _collect_names(member.key.node, names)
            _collect_names(member.value, names)


def _derive_root(rules: Sequence[CddlRule], declared: Mapping[str, CddlRule]) -> Optional[str]:
    """Return the rule a grammar starts at.

    RFC 8610 §3.1 makes the **first** rule the entry point. A grammar that declares a rule
    literally named ``start`` says so explicitly, and that wins — several IETF grammars use
    the convention, and honouring it costs one lookup.

    Args:
        rules: The rules, in declaration order.
        declared: Every declared name.

    Returns:
        The root rule's name, or ``None`` for an empty grammar.
    """
    if "start" in declared:
        return "start"
    for rule in rules:
        if not is_socket_name(rule.name):
            return rule.name
    return rules[0].name if rules else None
