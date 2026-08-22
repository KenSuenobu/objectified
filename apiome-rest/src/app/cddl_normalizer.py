"""CDDL → canonical model normalizer — FMT-4.4 (#5437).

Projects the rule algebra :mod:`app.cddl_grammar` defines onto a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA` — the same paradigm the ASN.1, Avro,
JSON Schema and XSD readers produce. All of them describe a value space, and a reader of the
catalog should not have to know which language a schema happened to be written in.

**The projection.**

* Every **type rule** becomes one canonical type. Which kind follows from the body: a map is
  a ``RECORD`` (or a ``MAP`` when its whole body is a table), an array is a ``RECORD`` of
  positional members (or an ``ALIAS`` to a list when it holds one repeated element), a
  ``&(…)`` enumeration is an ``ENUM``, a choice is a ``UNION`` (or a ``SCALAR`` carrying
  ``enum`` when every branch is a literal), and everything else is a ``SCALAR``.
* **Group rules produce no type.** A group exists to be spliced, so a member whose value is
  a group reference contributes that group's members to the enclosing type — which is what
  makes ``COSE_Sign = [Headers, payload: bstr]`` project onto a record whose first members
  are the ones ``Headers`` declares.
* **Occurrence indicators become nullability and lists**: ``?`` nullable, ``*`` a nullable
  list, ``+`` a required list, and an explicit ``n*m`` additionally bounds the list with
  ``min_items``/``max_items``.
* **Control operators become constraints where an analogue exists**, which is the ticket's
  second acceptance criterion. ``.size`` becomes lengths (or, on an integer, the value range
  that many bytes admit), ``.regexp`` becomes ``pattern``, ``.lt``/``.le``/``.gt``/``.ge``
  become the numeric bounds, ``.eq`` becomes a single-valued ``enum``, ``.default`` becomes
  the member's default, and ``.and`` merges both operands' constraints. The operators with
  no analogue — ``.cbor``, ``.cborseq``, ``.bits``, ``.within``, ``.ne`` — are recorded on
  the member in ``cddl_control`` and declared as limits, never dropped.
* **Sockets and generics are resolved before this module runs.** :func:`app.cddl_grammar.build_document`
  folds a type socket's plugs into a choice, a group socket's plugs into a group choice, and
  instantiates every generic use, so the normalizer sees ordinary rules. What cannot be
  carried is not the plugs — those are exact — but the socket's *open-endedness*, and that
  is a declared limit.

**What the extras bag carries, and why the emitter reads it back.** Every construct with no
canonical field — a CBOR tag, a major-type shorthand, the exact prelude spelling of a leaf,
an unmapped control operator, whether a record came from a map or an array — is recorded in
``extras`` on the type or the member that carries it. :mod:`app.cddl_emitter` writes each of
them back, which is what makes ``cddl -> cddl`` a round-trip rather than an approximation.
Adding a key here without teaching the emitter to emit it breaks that.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    EnumValue,
    Type,
    TypeKind,
    TypeRef,
)
from .cddl_grammar import (
    PRELUDE_FORMATS,
    PRELUDE_SCALARS,
    CddlDocument,
    CddlGroup,
    CddlLiteral,
    CddlMember,
    CddlMemberKey,
    CddlNode,
    LimitRecorder,
    LiteralKind,
    MemberKeyKind,
    NodeKind,
    Occurrence,
    RuleKind,
    describe_node,
    socket_kind,
)
from .normalizer import Keys, Normalizer, normalize_ordering

__all__ = [
    "CDDL_EXTRAS_KEY",
    "WILDCARD_FIELD_NAME",
    "CddlNormalizer",
]

_FORMAT_KEY = "cddl"

#: The single extras bag the CDDL projection hangs on the canonical API — one key the
#: preview manifest and the capability surfaces read, rather than a scatter of loosely
#: related top-level keys.
CDDL_EXTRAS_KEY = "cddl"

#: The member name given to a map's open table entries, matching the RELAX NG and DTD
#: readers' spelling for the same idea.
WILDCARD_FIELD_NAME = "*"

#: The canonical scalar a construct with no better analogue projects onto.
_ANY = "any"

#: Control operators whose whole meaning is a canonical constraint.
_NUMERIC_CONTROLS = {
    ".lt": "exclusive_maximum",
    ".le": "maximum",
    ".gt": "exclusive_minimum",
    ".ge": "minimum",
}

#: Canonical scalars that hold a length rather than a magnitude, so ``.size`` constrains
#: their length instead of their value.
_LENGTH_SCALARS = frozenset({"string", "bytes"})

#: CBOR major type -> the canonical scalar a bare ``#n`` shorthand projects onto.
_MAJOR_SCALARS = {
    0: "uint64",
    1: "i64",
    2: "bytes",
    3: "string",
    4: "any",
    5: "any",
    6: "any",
    7: _ANY,
}


def _sanitize(name: str) -> str:
    """Return ``name`` reduced to characters a canonical field name may carry.

    CDDL identifiers admit ``$``, ``@``, ``.`` and ``-``. Only the characters that would
    collide with the canonical key grammar's ``.`` separator are folded; ``-`` and the
    socket sigils survive, because a CDDL grammar is written in kebab case and rewriting
    every name would make the imported model unrecognizable beside its source.

    Args:
        name: The source name.

    Returns:
        The folded name, or ``"value"`` when nothing survives.
    """
    folded = "".join(
        character if (character.isalnum() or character in "-_$@") else "_"
        for character in name
    )
    return folded or "value"


def _literal_name(literal: CddlLiteral) -> str:
    """Return the member name a literal map key contributes."""
    if literal.kind is LiteralKind.TEXT:
        return str(literal.value)
    return literal.spelling


class _Members:
    """One type's members, accumulated before they are rendered as canonical fields.

    Collected first and rendered afterwards because a spliced group may contribute a member
    whose name collides with one already present — CDDL permits it, two canonical fields
    cannot share a key, and the collision has to be resolved once every contributor is in.
    """

    def __init__(self) -> None:
        self._entries: List[Tuple[str, TypeRef, Dict[str, Any], Optional[Constraints], Any, Optional[str]]] = []
        self._names: Set[str] = set()

    def add(
        self,
        name: str,
        reference: TypeRef,
        extras: Dict[str, Any],
        constraints: Optional[Constraints],
        default: Any,
        description: Optional[str],
    ) -> None:
        """Add one member, disambiguating a name a previous member already claimed."""
        claimed = name
        suffix = 2
        while claimed in self._names:
            claimed = f"{name}_{suffix}"
            suffix += 1
        self._names.add(claimed)
        self._entries.append((claimed, reference, extras, constraints, default, description))

    def fields(self, owner_key: str) -> List[CanonicalField]:
        """Render the accumulated members as canonical fields, in declaration order."""
        return [
            CanonicalField(
                key=Keys.field(owner_key, name),
                name=name,
                type=reference,
                field_number=number,
                default=default,
                constraints=constraints,
                description=description,
                extras=extras,
            )
            for number, (name, reference, extras, constraints, default, description) in enumerate(
                self._entries, start=1
            )
        ]

    def __len__(self) -> int:
        return len(self._entries)


class _Projection:
    """What one type expression contributes at a use site.

    Attributes:
        reference: The canonical reference a member typed by the expression carries.
        constraints: The constraints the expression states, when any.
        extras: The extras the expression needs recorded to be re-emitted.
        default: The value a ``.default`` control supplied, when any.
    """

    __slots__ = ("reference", "constraints", "extras", "default")

    def __init__(
        self,
        reference: TypeRef,
        *,
        constraints: Optional[Constraints] = None,
        extras: Optional[Dict[str, Any]] = None,
        default: Any = None,
    ) -> None:
        self.reference = reference
        self.constraints = constraints
        self.extras = extras or {}
        self.default = default


class _TypeGraph:
    """Builds the canonical type graph for one parsed CDDL grammar."""

    def __init__(self, document: CddlDocument) -> None:
        self._document = document
        self._limits = LimitRecorder()
        self._limits.extend(document.limits)
        self._types: Dict[str, Type] = {}
        self._rules = {rule.name: rule for rule in document.rules}
        self._group_rules = {
            rule.name: rule for rule in document.rules if rule.kind is RuleKind.GROUP
        }
        self._claimed: Set[str] = set(self._rules)
        #: Group rules currently being spliced, so a group that references itself is
        #: refused rather than expanded forever.
        self._splicing: List[str] = []

    # -- naming -----------------------------------------------------------

    def _claim(self, preferred: str) -> str:
        """Return an unused type name close to ``preferred``."""
        candidate = _sanitize(preferred)
        if candidate not in self._claimed:
            self._claimed.add(candidate)
            return candidate
        suffix = 2
        while f"{candidate}_{suffix}" in self._claimed:
            suffix += 1
        claimed = f"{candidate}_{suffix}"
        self._claimed.add(claimed)
        return claimed

    # -- entry point ------------------------------------------------------

    def build(self) -> Tuple[List[Type], Optional[str], LimitRecorder]:
        """Build the whole type graph.

        Returns:
            ``(types, root_type_key, limits)`` — the types in declaration order, the key of
            the type the grammar's entry rule projects onto, and the accumulated limits.
        """
        for rule in self._document.rules:
            if rule.kind is RuleKind.GROUP or rule.node is None:
                # A group rule has no canonical type: it exists to be spliced, and every
                # splice site carries its members. Recording it as an empty record would
                # invent a type the grammar does not have.
                continue
            self._emit_named_type(rule.name, rule.node, rule.description)

        root = self._document.root
        root_key = root if root in self._types else None
        return list(self._types.values()), root_key, self._limits

    # -- named types ------------------------------------------------------

    def _emit_named_type(
        self, name: str, node: CddlNode, description: Optional[str]
    ) -> str:
        """Create (once) the canonical type a named rule projects onto.

        Args:
            name: The rule's name.
            node: The rule's body.
            description: The comment written above the rule, when there was one.

        Returns:
            The type's canonical key.
        """
        if name in self._types:
            return name
        extras = self._rule_extras(name)
        self._types[name] = self._build_type(name, name, node, description, extras)
        return name

    def _rule_extras(self, name: str) -> Dict[str, Any]:
        """Return the extras a rule's own identity contributes.

        A socket and a generic instantiation are both *derived* rules: nothing in the source
        is spelled the way the canonical type is named, so the derivation is recorded here
        and the emitter uses it to write the rule back in the form the grammar had.
        """
        extras: Dict[str, Any] = {}
        kind = socket_kind(name)
        if kind is not None:
            # Only that the rule *is* a socket, which its name already says and which
            # therefore survives being written back. The plug list is document-level
            # provenance and lives in ``extras['cddl']['sockets']`` — recording it here too
            # would make a socket that also carries an `=` binding disagree with itself once
            # the grammar is re-read, since a re-emitted plug list has no `=` binding left
            # to distinguish.
            extras["cddl_socket"] = kind.value
        # A generic *instantiation* deliberately records nothing here. The instantiated type
        # is an ordinary rule once its arguments are bound, and a marker on it would be lost
        # the moment the grammar is written back — CDDL cannot re-derive `page<T>` from
        # `page_tstr`. The provenance is published document-wide instead, in
        # ``extras['cddl']['instantiations']``.
        return extras

    def _build_type(
        self,
        name: str,
        key: str,
        node: CddlNode,
        description: Optional[str],
        extras: Dict[str, Any],
    ) -> Type:
        """Build the canonical type one type expression declares."""
        node, carried = self._peel(node, location=name)
        merged = {**extras, **carried}

        if node.kind is NodeKind.MAP:
            return self._map_type(name, key, node.group, description, merged)
        if node.kind is NodeKind.ARRAY:
            return self._array_type(name, key, node.group, description, merged)
        if node.kind is NodeKind.ENUM_GROUP:
            return self._enum_type(name, key, node, description, merged)
        if node.kind is NodeKind.GROUP and node.group is not None:
            inner = _parenthesized_type(node.group)
            if inner is not None:
                return self._build_type(name, key, inner, description, merged)
            return self._record_from_group(name, key, node.group, description, merged, shape="group")
        if node.kind is NodeKind.CHOICE:
            return self._choice_type(name, key, node, description, merged)

        projection = self._project(node, owner=name, location=name)
        merged.update(projection.extras)
        reference = projection.reference
        if reference.is_list():
            return Type(
                key=key,
                name=name,
                kind=TypeKind.ALIAS,
                aliased=reference,
                description=description,
                constraints=projection.constraints,
                extras=merged,
            )
        if reference.name in self._types or reference.name in self._rules:
            return Type(
                key=key,
                name=name,
                kind=TypeKind.ALIAS,
                aliased=reference,
                description=description,
                constraints=projection.constraints,
                extras=merged,
            )
        return Type(
            key=key,
            name=name,
            kind=TypeKind.SCALAR,
            description=description,
            constraints=projection.constraints,
            extras={**merged, "cddl_scalar": reference.name or _ANY},
        )

    def _peel(self, node: CddlNode, *, location: str) -> Tuple[CddlNode, Dict[str, Any]]:
        """Strip the wrappers that decorate a type without changing its shape.

        A CBOR tag and an unwrap both sit *around* a type: ``#6.98(COSE_Sign)`` is a
        ``COSE_Sign`` marked with a tag, and ``~wrapper`` is a ``wrapper`` with one layer of
        its brackets removed. Neither is expressible canonically, so both are peeled off,
        recorded and declared — which keeps the type underneath from being buried inside a
        wrapper type the grammar never named.

        Args:
            node: The node to peel.
            location: The rule the node sits under, for the limit's location list.

        Returns:
            ``(inner node, extras the wrappers contributed)``.
        """
        extras: Dict[str, Any] = {}
        while True:
            if node.kind is NodeKind.TAG:
                self._limits.record("cddl.tag", location=location)
                extras["cddl_tag"] = node.tag
                if not node.children:
                    node = CddlNode(kind=NodeKind.ANY)
                    continue
                node = node.children[0]
                continue
            if node.kind is NodeKind.UNWRAP and node.name:
                self._limits.record("cddl.unwrap", location=location)
                extras["cddl_unwrap"] = node.name
                node = CddlNode(kind=NodeKind.REFERENCE, name=node.name)
                continue
            return node, extras

    # -- maps, arrays and groups -----------------------------------------

    def _map_type(
        self,
        name: str,
        key: str,
        group: Optional[CddlGroup],
        description: Optional[str],
        extras: Dict[str, Any],
    ) -> Type:
        """Build the type a ``{ … }`` map projects onto.

        A map whose whole body is one table entry (``{ * tstr => uint }``) is a canonical
        ``MAP`` — exactly what the source says. Any other map is a ``RECORD``: its named
        members become fields, and a table entry beside them becomes one open-content member
        because the further keys it admits are not enumerable.
        """
        group = group or CddlGroup()
        table = _sole_table_entry(group)
        if table is not None:
            key_projection = self._project(
                table.key.node or CddlNode(kind=NodeKind.ANY), owner=name, location=name
            )
            value_projection = self._project(table.value, owner=name, location=name)
            return Type(
                key=key,
                name=name,
                kind=TypeKind.MAP,
                key_type=key_projection.reference,
                value_type=value_projection.reference,
                description=description,
                extras={**extras, "cddl_shape": "map", "cddl_table": True},
            )
        return self._record_from_group(name, key, group, description, extras, shape="map")

    def _array_type(
        self,
        name: str,
        key: str,
        group: Optional[CddlGroup],
        description: Optional[str],
        extras: Dict[str, Any],
    ) -> Type:
        """Build the type a ``[ … ]`` array projects onto.

        An array holding one repeated, unnamed element (``[+ line]``) is a list, and becomes
        an ``ALIAS`` to it. Every other array is an ordered tuple whose entries CDDL lets an
        author name, so it becomes a ``RECORD`` carrying ``cddl_shape: array`` — the fields
        keep their order through ``field_number``, which is what the emitter writes back.
        """
        group = group or CddlGroup()
        element = _sole_repeated_element(group)
        if element is not None:
            projection = self._project(element.value, owner=name, location=name)
            nested = list(projection.extras.pop("cddl_list_occurrence", []))
            return Type(
                key=key,
                name=name,
                kind=TypeKind.ALIAS,
                aliased=_repeat(projection.reference, element.occurrence),
                description=description,
                constraints=_merge_constraints(
                    projection.constraints, _occurrence_constraints(element.occurrence)
                ),
                extras={
                    **extras,
                    **projection.extras,
                    "cddl_shape": "array-of",
                    "cddl_list_occurrence": [element.occurrence.spelling, *nested],
                },
            )
        return self._record_from_group(name, key, group, description, extras, shape="array")

    def _record_from_group(
        self,
        name: str,
        key: str,
        group: CddlGroup,
        description: Optional[str],
        extras: Dict[str, Any],
        *,
        shape: str,
    ) -> Type:
        """Build the ``RECORD`` (or ``UNION`` of records) a group body projects onto.

        A group choice that is the *whole* body states that one of several member sets
        applies, and that is exactly a union — so it is modelled as one synthesized record
        per alternative rather than approximated.
        """
        if group.has_choice:
            members = [
                self._emit_alternative(name, index, alternative, shape=shape)
                for index, alternative in enumerate(group.choices)
            ]
            return Type(
                key=key,
                name=name,
                kind=TypeKind.UNION,
                union_members=members,
                description=description,
                extras={**extras, "cddl_shape": shape, "cddl_group_choice": True},
            )
        collected = _Members()
        self._collect(group.members, collected, owner=name, owner_key=key)
        return Type(
            key=key,
            name=name,
            kind=TypeKind.RECORD,
            fields=collected.fields(key),
            description=description,
            extras={**extras, "cddl_shape": shape},
        )

    def _emit_alternative(
        self,
        owner: str,
        index: int,
        members: Sequence[CddlMember],
        *,
        shape: str,
    ) -> str:
        """Create the record one alternative of a whole-body group choice projects onto."""
        name = self._claim(f"{owner}-choice{index + 1}")
        collected = _Members()
        self._collect(members, collected, owner=name, owner_key=name)
        self._types[name] = Type(
            key=name,
            name=name,
            kind=TypeKind.RECORD,
            fields=collected.fields(name),
            extras={"cddl_shape": shape, "cddl_alternative_of": owner},
        )
        return name

    def _enum_type(
        self,
        name: str,
        key: str,
        node: CddlNode,
        description: Optional[str],
        extras: Dict[str, Any],
    ) -> Type:
        """Build the ``ENUM`` a ``&( … )`` / ``&groupname`` enumeration projects onto."""
        group = node.group
        if group is None and node.name:
            referenced = self._group_rules.get(node.name)
            group = referenced.group if referenced is not None else None
        values: List[EnumValue] = []
        for member in (group.members if group is not None else ()):
            label = member.key.label()
            literal = member.value.literal
            if label is None:
                label = describe_node(member.value)
            values.append(
                EnumValue(
                    key=Keys.enum_value(key, label),
                    name=label,
                    value=literal.value if literal is not None else None,
                    description=member.description,
                    # A member whose value is not a literal (`admin: uint`) has no canonical
                    # value; its spelling is recorded so the emitter writes back what the
                    # grammar said rather than inventing one from the member's name.
                    extras={"cddl_value": describe_node(member.value)},
                )
            )
        enum_extras = {**extras, "cddl_shape": "enum-group"}
        if node.name:
            enum_extras["cddl_enum_group"] = node.name
        return Type(
            key=key,
            name=name,
            kind=TypeKind.ENUM,
            enum_values=values,
            description=description,
            extras=enum_extras,
        )

    def _choice_type(
        self,
        name: str,
        key: str,
        node: CddlNode,
        description: Optional[str],
        extras: Dict[str, Any],
    ) -> Type:
        """Build the type a ``a / b / c`` type choice projects onto.

        A choice whose every branch is a literal is an enumeration of values, not a union of
        types, and becomes a ``SCALAR`` carrying ``constraints.enum`` — which is what a
        consumer of the canonical model can actually act on. Any other choice becomes a
        ``UNION``.
        """
        branches = list(node.children)
        literals = [branch.literal for branch in branches if branch.kind is NodeKind.LITERAL]
        if branches and len(literals) == len(branches):
            scalar = _literal_scalar(literals)
            return Type(
                key=key,
                name=name,
                kind=TypeKind.SCALAR,
                constraints=Constraints(enum=[literal.value for literal in literals]),
                description=description,
                extras={
                    **extras,
                    "cddl_scalar": scalar,
                    "cddl_shape": "literal-choice",
                    "cddl_literals": [literal.spelling for literal in literals],
                },
            )
        members = [
            self._branch_type_key(branch, owner=name, index=index)
            for index, branch in enumerate(branches)
        ]
        return Type(
            key=key,
            name=name,
            kind=TypeKind.UNION,
            union_members=members,
            description=description,
            extras={**extras, "cddl_shape": "choice"},
        )

    def _branch_type_key(self, branch: CddlNode, *, owner: str, index: int) -> str:
        """Return (creating if needed) the type key one union branch resolves to."""
        branch, carried = self._peel(branch, location=owner)
        if branch.kind is NodeKind.REFERENCE and branch.name in self._rules and not carried:
            return branch.name
        if branch.kind is NodeKind.PRELUDE and branch.name in self._rules and not carried:
            return branch.name
        if branch.kind in (NodeKind.PRELUDE, NodeKind.LITERAL, NodeKind.MAJOR, NodeKind.ANY) and not carried:
            projection = self._project(branch, owner=owner, location=owner)
            return projection.reference.name or _ANY
        name = self._claim(f"{owner}-branch{index + 1}")
        self._types[name] = self._build_type(name, name, branch, None, dict(carried))
        return name

    # -- members ----------------------------------------------------------

    def _collect(
        self,
        members: Sequence[CddlMember],
        collected: _Members,
        *,
        owner: str,
        owner_key: str,
    ) -> None:
        """Accumulate the canonical members a group's entries contribute."""
        for position, member in enumerate(members, start=1):
            if member.key.kind is MemberKeyKind.NONE:
                if self._splice(member, collected, owner=owner, owner_key=owner_key):
                    continue
            self._add_member(member, collected, owner=owner, owner_key=owner_key, position=position)

    def _splice(
        self,
        member: CddlMember,
        collected: _Members,
        *,
        owner: str,
        owner_key: str,
    ) -> bool:
        """Splice a positional group reference's members into the enclosing type.

        Args:
            member: The unkeyed entry.
            collected: The accumulator to add to.
            owner: The enclosing type's name.
            owner_key: The enclosing type's key.

        Returns:
            ``True`` when the entry was a group and was spliced, ``False`` when it is an
            ordinary positional member.
        """
        value = member.value
        group: Optional[CddlGroup] = None
        label = owner
        if value.kind is NodeKind.GROUP and value.group is not None:
            group = value.group
        elif value.kind in (NodeKind.REFERENCE, NodeKind.SOCKET) and value.name:
            rule = self._group_rules.get(value.name)
            if rule is not None and rule.group is not None:
                group = rule.group
                label = value.name
        if group is None:
            return False
        if label in self._splicing:
            # A group that splices itself has no finite member list; the reference is kept
            # as an ordinary member rather than expanded.
            return False
        if group.has_choice:
            # Only one set of members can sit in a canonical record. The alternatives that
            # are not carried are declared, counted and located.
            self._limits.record("cddl.group_choice", location=label)
        self._splicing.append(label)
        try:
            self._collect(group.members, collected, owner=owner, owner_key=owner_key)
        finally:
            self._splicing.pop()
        return True

    def _add_member(
        self,
        member: CddlMember,
        collected: _Members,
        *,
        owner: str,
        owner_key: str,
        position: int,
    ) -> None:
        """Render one group entry as a canonical member."""
        name, key_extras = self._member_name(member.key, owner=owner, position=position)
        projection = self._project(member.value, owner=f"{owner}-{name}", location=owner)
        extras: Dict[str, Any] = {**key_extras, **projection.extras}

        occurrence = member.occurrence
        if occurrence.spelling:
            extras["cddl_occurrence"] = occurrence.spelling
        # On a table entry the occurrence counts *entries*, not values: `* label => values`
        # admits many entries each holding one `values`, so wrapping the value in a list
        # would say the wrong thing. Everywhere else a repeating member is a list.
        table = extras.get("cddl_key") == "table"
        base = (
            projection.reference
            if projection.reference.is_list()
            else TypeRef(
                **{
                    **projection.reference.model_dump(),
                    "nullable": occurrence.optional or table,
                }
            )
        )
        reference = base if table else _repeat(base, occurrence)
        constraints = projection.constraints
        if not table:
            constraints = _merge_constraints(
                constraints, _occurrence_constraints(occurrence)
            )
        collected.add(
            name,
            reference,
            extras,
            constraints,
            projection.default,
            member.description,
        )

    def _member_name(
        self, key: CddlMemberKey, *, owner: str, position: int
    ) -> Tuple[str, Dict[str, Any]]:
        """Return the canonical name one member key contributes, and its extras.

        Args:
            key: The member's key.
            owner: The enclosing type's name.
            position: The member's 1-based position, for an entry with no key at all.

        Returns:
            ``(name, extras)``.
        """
        if key.kind is MemberKeyKind.BAREWORD and key.name:
            return _sanitize(key.name), {"cddl_key": "bareword"}
        if key.kind is MemberKeyKind.LITERAL and key.literal is not None:
            return _sanitize(_literal_name(key.literal)), {
                "cddl_key": "literal",
                "cddl_key_literal": key.literal.spelling,
            }
        if key.kind is MemberKeyKind.TYPE and key.node is not None:
            if key.node.kind is NodeKind.LITERAL and key.node.literal is not None:
                extras = {
                    "cddl_key": "arrow-literal",
                    "cddl_key_literal": key.node.literal.spelling,
                }
                if key.cut:
                    extras["cddl_key_cut"] = True
                return _sanitize(_literal_name(key.node.literal)), extras
            # A table entry: the key is a *type*, so the entries it admits are not
            # enumerable and the member stands for all of them.
            self._limits.record("cddl.open_map_entry", location=owner)
            extras = {
                "cddl_key": "table",
                "cddl_key_type": describe_node(key.node),
            }
            if key.cut:
                extras["cddl_key_cut"] = True
            return WILDCARD_FIELD_NAME, extras
        return f"item{position}", {"cddl_key": "positional"}

    # -- type expressions -------------------------------------------------

    def _project(self, node: CddlNode, *, owner: str, location: str) -> _Projection:
        """Return what one type expression contributes at a use site.

        Args:
            node: The expression.
            owner: A name to base a synthesized type's name on.
            location: The rule the expression sits under, for limit locations.

        Returns:
            The projection.
        """
        node, carried = self._peel(node, location=location)

        if node.kind is NodeKind.PRELUDE and node.name:
            # The prelude is a default, not a set of reserved words: a document may declare
            # a rule named `uri` and mean its own. The parser reads one rule at a time and
            # cannot know that, so the shadowing is resolved here, where every rule is in
            # hand.
            if node.name in self._rules and node.name not in self._group_rules:
                return _Projection(TypeRef(name=node.name), extras=dict(carried))
            scalar = PRELUDE_SCALARS.get(node.name, _ANY)
            format_hint = PRELUDE_FORMATS.get(node.name)
            return _Projection(
                TypeRef(name=scalar),
                constraints=Constraints(format=format_hint) if format_hint else None,
                extras={**carried, "cddl_type": node.name},
            )

        if node.kind is NodeKind.LITERAL and node.literal is not None:
            literal = node.literal
            return _Projection(
                TypeRef(name=_literal_scalar([literal])),
                constraints=Constraints(enum=[literal.value]),
                extras={**carried, "cddl_type": literal.spelling, "cddl_literal": True},
            )

        if node.kind is NodeKind.ANY:
            return _Projection(TypeRef(name=_ANY), extras={**carried, "cddl_type": "#"})

        if node.kind is NodeKind.MAJOR and node.major is not None:
            self._limits.record("cddl.major_type", location=location)
            spelling = f"#{node.major}" + (
                f".{node.additional}" if node.additional is not None else ""
            )
            return _Projection(
                TypeRef(name=_MAJOR_SCALARS.get(node.major, _ANY)),
                extras={**carried, "cddl_type": spelling, "cddl_major": True},
            )

        if node.kind in (NodeKind.REFERENCE, NodeKind.SOCKET) and node.name:
            if node.name in self._rules and node.name not in self._group_rules:
                return _Projection(TypeRef(name=node.name), extras=dict(carried))
            if node.name in self._group_rules:
                # A group used where a type is expected: it needs a type of its own, and
                # the type is the record its members describe.
                return _Projection(
                    TypeRef(name=self._group_as_type(node.name)), extras=dict(carried)
                )
            scalar = PRELUDE_SCALARS.get(node.name)
            if scalar is not None:
                return _Projection(
                    TypeRef(name=scalar), extras={**carried, "cddl_type": node.name}
                )
            return _Projection(TypeRef(name=node.name), extras=dict(carried))

        if node.kind is NodeKind.PARAMETER and node.name:
            # A parameter that survived instantiation has no bound argument; the honest
            # projection is the open type, not a guess at what it might have been.
            return _Projection(
                TypeRef(name=_ANY), extras={**carried, "cddl_parameter": node.name}
            )

        if node.kind is NodeKind.RANGE and len(node.children) == 2:
            return self._range(node, carried)

        if node.kind is NodeKind.CONTROL and len(node.children) == 2:
            return self._control(node, carried, owner=owner, location=location)

        if node.kind is NodeKind.GROUP and node.group is not None:
            inner = _parenthesized_type(node.group)
            if inner is not None:
                projection = self._project(inner, owner=owner, location=location)
                projection.extras.update(carried)
                return projection

        if node.kind is NodeKind.ARRAY and node.group is not None:
            element = _sole_repeated_element(node.group)
            if element is not None:
                projection = self._project(element.value, owner=owner, location=location)
                # The occurrence spellings stack outermost-first, so `[3*3 [3*3 number]]`
                # records both bounds and the emitter can rebuild the nesting exactly. The
                # canonical item-count constraints hold only the outermost pair.
                nested = list(projection.extras.pop("cddl_list_occurrence", []))
                return _Projection(
                    _repeat(projection.reference, element.occurrence),
                    constraints=_merge_constraints(
                        projection.constraints, _occurrence_constraints(element.occurrence)
                    ),
                    extras={
                        **carried,
                        **projection.extras,
                        "cddl_list_occurrence": [element.occurrence.spelling, *nested],
                    },
                )

        # Anything left is a structure that needs a type of its own: a nested map, a tuple
        # array, an inline enumeration or a nested choice.
        name = self._claim(owner)
        self._types[name] = self._build_type(name, name, node, None, dict(carried))
        return _Projection(TypeRef(name=name))

    def _group_as_type(self, name: str) -> str:
        """Return (creating if needed) the record type a group rule projects onto.

        A group name written where a *type* is expected (``h: Headers``) is not something
        RFC 8610 admits, but the reader meets it in the wild and failing the whole grammar
        over one member would be worse than reading it. The group's members become a record
        named ``<group>-group`` — a map, because that is what a reader of the canonical model
        can act on, and because writing the grammar back must produce something this reader
        reads the same way. Which groups a document declared is published in
        ``extras['cddl']['group_rules']``.

        Args:
            name: The group rule's name.

        Returns:
            The synthesized record type's key.
        """
        synthesized = f"{name}-group"
        if synthesized in self._types:
            return synthesized
        rule = self._group_rules[name]
        self._claimed.add(synthesized)
        self._types[synthesized] = self._record_from_group(
            synthesized,
            synthesized,
            rule.group or CddlGroup(),
            rule.description,
            {},
            shape="map",
        )
        return synthesized

    def _range(self, node: CddlNode, carried: Dict[str, Any]) -> _Projection:
        """Project a ``a..b`` / ``a...b`` range onto a bounded scalar."""
        lower, upper = node.children
        exclusive = node.operator == "..."
        low = lower.literal.value if lower.literal is not None else None
        high = upper.literal.value if upper.literal is not None else None
        scalar = _literal_scalar(
            [literal for literal in (lower.literal, upper.literal) if literal is not None]
        )
        constraints = Constraints(
            minimum=low if isinstance(low, (int, float)) else None,
            maximum=high if isinstance(high, (int, float)) and not exclusive else None,
            exclusive_maximum=high if isinstance(high, (int, float)) and exclusive else None,
        )
        return _Projection(
            TypeRef(name=scalar),
            constraints=constraints,
            extras={
                **carried,
                "cddl_range": {
                    "operator": node.operator,
                    "from": describe_node(lower),
                    "to": describe_node(upper),
                },
            },
        )

    def _control(
        self,
        node: CddlNode,
        carried: Dict[str, Any],
        *,
        owner: str,
        location: str,
    ) -> _Projection:
        """Project a ``target .op controller`` control operator.

        The operators with a canonical analogue become constraints on the target; the ones
        without are recorded on the member in ``cddl_control`` and declared as limits. The
        distinction is FMT-4.4's second acceptance criterion, and it is made once, here.
        """
        target, controller = node.children
        operator = node.operator or ""
        projection = self._project(target, owner=owner, location=location)
        controller = _unwrap_parentheses(controller)

        if operator == ".default":
            projection.default = (
                controller.literal.value if controller.literal is not None else None
            )
            projection.extras.setdefault("cddl_default", describe_node(controller))
            return projection

        if operator == ".size":
            constraints = self._size_constraints(projection, controller)
            if constraints is not None:
                projection.constraints = _merge_constraints(projection.constraints, constraints)
                projection.extras["cddl_size"] = describe_node(controller)
                return projection
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_unmapped"
            )

        if operator == ".regexp":
            if controller.literal is not None and controller.literal.kind is LiteralKind.TEXT:
                projection.constraints = _merge_constraints(
                    projection.constraints, Constraints(pattern=str(controller.literal.value))
                )
                # Recorded as a control as well as a constraint: the emitter writes a native
                # member's operators back from `cddl_controls` alone, so an operator that
                # left no trace there would be dropped on the way out.
                projection.extras.setdefault("cddl_controls", []).append(
                    {"operator": operator, "operand": controller.literal.spelling}
                )
                return projection
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_unmapped"
            )

        if operator in _NUMERIC_CONTROLS:
            if controller.literal is not None and isinstance(
                controller.literal.value, (int, float)
            ):
                projection.constraints = _merge_constraints(
                    projection.constraints,
                    Constraints(
                        **{_NUMERIC_CONTROLS[operator]: float(controller.literal.value)}
                    ),
                )
                projection.extras.setdefault("cddl_controls", []).append(
                    {"operator": operator, "operand": describe_node(controller)}
                )
                return projection
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_unmapped"
            )

        if operator == ".eq":
            if controller.literal is not None:
                projection.constraints = _merge_constraints(
                    projection.constraints, Constraints(enum=[controller.literal.value])
                )
                projection.extras.setdefault("cddl_controls", []).append(
                    {"operator": operator, "operand": describe_node(controller)}
                )
                return projection
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_unmapped"
            )

        if operator == ".and":
            other = self._project(controller, owner=owner, location=location)
            if other.constraints is not None:
                projection.constraints = _merge_constraints(
                    projection.constraints, other.constraints
                )
                projection.extras.setdefault("cddl_controls", []).append(
                    {"operator": operator, "operand": describe_node(controller)}
                )
                return projection
            return self._unmapped_control(
                projection,
                operator,
                controller,
                location=location,
                limit="cddl.control_intersection",
            )

        if operator == ".within":
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_within"
            )
        if operator in (".cbor", ".cborseq"):
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_cbor"
            )
        if operator == ".bits":
            return self._unmapped_control(
                projection, operator, controller, location=location, limit="cddl.control_bits"
            )
        return self._unmapped_control(
            projection, operator, controller, location=location, limit="cddl.control_unmapped"
        )

    def _unmapped_control(
        self,
        projection: _Projection,
        operator: str,
        controller: CddlNode,
        *,
        location: str,
        limit: str,
    ) -> _Projection:
        """Record a control operator the canonical model cannot express, and keep the target."""
        self._limits.record(limit, location=location)
        projection.extras.setdefault("cddl_controls", []).append(
            {"operator": operator, "operand": describe_node(controller)}
        )
        return projection

    def _size_constraints(
        self, projection: _Projection, controller: CddlNode
    ) -> Optional[Constraints]:
        """Return the constraints ``.size`` states, or ``None`` when it states none.

        ``.size`` means two different things depending on what it constrains, and both have
        a canonical analogue: on a text or byte string it bounds the *length*, and on an
        integer it bounds how many bytes the value occupies — which is a value range.
        """
        lower, upper = _size_bounds(controller)
        if lower is None and upper is None:
            return None
        scalar = projection.reference.name or ""
        if scalar in _LENGTH_SCALARS:
            return Constraints(min_length=lower, max_length=upper)
        if upper is None:
            return None
        return Constraints(minimum=0, maximum=float(256 ** upper - 1))


# ---------------------------------------------------------------------------
# Group helpers
# ---------------------------------------------------------------------------


def _parenthesized_type(group: CddlGroup) -> Optional[CddlNode]:
    """Return the type a ``( … )`` body parenthesizes, when it parenthesizes one.

    ``( a / b )`` wraps a type; ``( a: x, b: y )`` is a group. The distinction is the same
    one :mod:`app.cddl_parser` makes when it decides whether a rule declares a group, and it
    is repeated here because a parenthesized type may also appear at a use site.
    """
    if len(group.choices) != 1 or len(group.choices[0]) != 1:
        return None
    member = group.choices[0][0]
    if member.key.kind is not MemberKeyKind.NONE or member.occurrence.spelling:
        return None
    return member.value


def _unwrap_parentheses(node: CddlNode) -> CddlNode:
    """Return ``node`` with any redundant parentheses removed."""
    while node.kind is NodeKind.GROUP and node.group is not None:
        inner = _parenthesized_type(node.group)
        if inner is None:
            return node
        node = inner
    return node


def _sole_table_entry(group: CddlGroup) -> Optional[CddlMember]:
    """Return the one table entry a map's whole body consists of, when it does."""
    if group.has_choice or len(group.members) != 1:
        return None
    member = group.members[0]
    if member.key.kind is not MemberKeyKind.TYPE or member.key.node is None:
        return None
    if member.key.node.kind is NodeKind.LITERAL:
        return None
    return member


def _sole_repeated_element(group: CddlGroup) -> Optional[CddlMember]:
    """Return the one repeated element an array's whole body consists of, when it does."""
    if group.has_choice or len(group.members) != 1:
        return None
    member = group.members[0]
    if member.key.kind is not MemberKeyKind.NONE:
        return None
    if not member.occurrence.repeated:
        return None
    return member


def _size_bounds(controller: CddlNode) -> Tuple[Optional[int], Optional[int]]:
    """Return the ``(lower, upper)`` bounds a ``.size`` controller states."""
    if controller.kind is NodeKind.LITERAL and controller.literal is not None:
        value = controller.literal.value
        if isinstance(value, int):
            return value, value
        return None, None
    if controller.kind is NodeKind.RANGE and len(controller.children) == 2:
        lower, upper = controller.children
        low = lower.literal.value if lower.literal is not None else None
        high = upper.literal.value if upper.literal is not None else None
        return (
            low if isinstance(low, int) else None,
            high if isinstance(high, int) else None,
        )
    return None, None


def _literal_scalar(literals: Sequence[CddlLiteral]) -> str:
    """Return the canonical scalar a set of literal values shares."""
    kinds = {literal.kind for literal in literals}
    if not kinds:
        return _ANY
    if kinds == {LiteralKind.TEXT}:
        return "string"
    if kinds == {LiteralKind.BYTES}:
        return "bytes"
    if kinds <= {LiteralKind.INT}:
        return "i64"
    if kinds <= {LiteralKind.INT, LiteralKind.FLOAT}:
        return "double"
    return _ANY


def _repeat(reference: TypeRef, occurrence: Occurrence) -> TypeRef:
    """Return ``reference``, wrapped in a list when the occurrence indicator repeats.

    Nullability rides on the *list*, not on its items: ``[* tstr]`` is an optional list of
    required strings, not a required list of optional ones.
    """
    if not occurrence.repeated:
        return reference
    item = TypeRef(**{**reference.model_dump(), "nullable": False})
    return TypeRef(name="list", item=item, nullable=occurrence.optional)


def _occurrence_constraints(occurrence: Occurrence) -> Optional[Constraints]:
    """Return the item-count constraints an explicit ``n*m`` indicator states."""
    if not occurrence.repeated:
        return None
    if occurrence.minimum == 0 and occurrence.maximum is None:
        return None
    if occurrence.minimum == 1 and occurrence.maximum is None:
        return Constraints(min_items=1)
    return Constraints(
        min_items=occurrence.minimum or None,
        max_items=occurrence.maximum,
    )


def _merge_constraints(
    first: Optional[Constraints], second: Optional[Constraints]
) -> Optional[Constraints]:
    """Merge two constraint sets, with ``second`` filling only what ``first`` leaves unset."""
    if first is None:
        return second
    if second is None:
        return first
    merged = first.model_dump()
    for key, value in second.model_dump().items():
        if value in (None, {}, []):
            continue
        if merged.get(key) in (None, {}, []):
            merged[key] = value
    return Constraints(**merged)


# ---------------------------------------------------------------------------
# Extras payloads
# ---------------------------------------------------------------------------


def _limits_payload(limits: Sequence[Any]) -> List[Dict[str, Any]]:
    """Render the reader's declared limits as the extras bag's ``capability_limits``."""
    return [
        {
            "construct": limit.construct,
            "detail": limit.detail,
            "count": limit.count,
            "locations": list(limit.locations),
        }
        for limit in limits
    ]


def _composition_payload(document: CddlDocument) -> Dict[str, Any]:
    """Render the composition facts — sockets, generics and group rules — for the bag."""
    payload: Dict[str, Any] = {}
    if document.sockets:
        payload["sockets"] = {
            name: list(plugs) for name, plugs in sorted(document.sockets.items())
        }
    if document.generics:
        payload["generics"] = {
            name: list(parameters) for name, parameters in sorted(document.generics.items())
        }
    if document.instantiations:
        payload["instantiations"] = {
            name: {"rule": rule, "arguments": list(arguments)}
            for name, (rule, arguments) in sorted(document.instantiations.items())
        }
    groups = [rule.name for rule in document.rules if rule.kind is RuleKind.GROUP]
    if groups:
        payload["group_rules"] = groups
    if document.members:
        payload["members"] = list(document.members)
    return payload


class CddlNormalizer(Normalizer, register=True):
    """Normalize a parsed CDDL grammar into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Project a :class:`~app.cddl_grammar.CddlDocument` onto the canonical model.

        Args:
            source: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ValueError: If ``source`` is not a parsed CDDL grammar.
        """
        if not isinstance(source, CddlDocument):
            raise ValueError(
                "CDDL source must be a CddlDocument (see app.cddl_parser.parse_cddl)"
            )

        graph = _TypeGraph(source)
        types, root_key, limits = graph.build()
        title = source.root or "cddl"

        cddl: Dict[str, Any] = {
            "root_rule": source.root,
            "root_type": root_key,
            "capability_limits": _limits_payload(limits.limits()),
        }
        cddl.update(_composition_payload(source))

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=title),
            title=title,
            description=source.description,
            types=types,
            raw={"cddl": source.raw} if include_raw else None,
            extras={CDDL_EXTRAS_KEY: cddl},
        )
        return normalize_ordering(api)
