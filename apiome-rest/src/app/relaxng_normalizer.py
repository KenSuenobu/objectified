"""RELAX NG → canonical model normalizer — FMT-4.1 (#5434).

Projects the pattern algebra :mod:`app.relaxng_grammar` defines onto a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA`, the same paradigm the XSD reader
produces — RELAX NG and XSD describe the same documents, so a reader of the catalog should
not have to know which language a schema happened to be written in.

**The projection.**

* A named pattern (``define``) becomes one canonical type, named after the pattern so a
  ``ref`` and its target line up by key. Which *kind* of type follows from the pattern's
  shape: a pattern whose content is only text and datatypes is a ``SCALAR``, a choice
  between two or more branches is a ``UNION`` (the ticket's "``choice`` maps to unions"),
  and anything with attributes or child elements is a ``RECORD``.
* An ``element``/``attribute`` inside a content model becomes a field. ``optional`` makes
  it nullable, ``zeroOrMore``/``oneOrMore`` make it a list, and a ``choice`` of literal
  ``value`` patterns becomes the field's ``enum`` constraint rather than a type of its own.
* A ``ref`` used as a content particle becomes one member typed by the named pattern it
  cites — never a spliced-in copy of it, so a grammar that reuses one content model in ten
  places projects onto ten references rather than ten structurally identical types.
* ``data`` parameters become canonical constraints (``pattern``, ``minLength``,
  ``maxInclusive``, …) and the W3C XML Schema datatype becomes a canonical scalar.

**What the canonical model cannot hold is declared, not dropped.** ``interleave``'s
order-independence, ``anyName``/``nsName`` wildcards, a ``data`` ``except`` clause, ``list``
tokenization, ``mixed`` content and an uninterpreted datatype library are all recorded by
the reader as :class:`~app.relaxng_grammar.RelaxNgLimit` entries; this module carries them
onto ``extras['relaxng']['capability_limits']``, which the import preview renders as
partially-mapped coverage rows and the capability registry publishes as the format's
parsing limits. The affected fields are additionally tagged in their own extras, so a
reader can see *which* members the limit is about rather than only that one exists.

**The syntax is deliberately not part of the model.** ``.rng`` and ``.rnc`` are two
spellings of one language, and FMT-4.1 requires both to import to the same canonical model,
so nothing here may depend on which one was read. The syntax survives on the retained raw
source, which is where a question about the original file belongs.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
from .normalizer import Keys, Normalizer, normalize_ordering
from .relaxng_grammar import (
    NameClassKind,
    PatternKind,
    RelaxNgDefine,
    RelaxNgDocument,
    RelaxNgPattern,
)

__all__ = [
    "RELAXNG_EXTRAS_KEY",
    "XSD_DATATYPE_TO_CANONICAL",
    "XSD_DATATYPE_FORMATS",
    "RelaxNgNormalizer",
]

_FORMAT_KEY = "relaxng"

#: The single extras bag the RELAX NG projection hangs on the canonical API, mirroring the
#: WIT adapter's ``extras['wit']``: one key the preview manifest and the capability surfaces
#: read, rather than a scatter of loosely-related top-level keys.
RELAXNG_EXTRAS_KEY = "relaxng"

#: W3C XML Schema datatype (lower-cased local name) -> canonical scalar name.
#:
#: RELAX NG's own built-in library has only ``string`` and ``token``; everything else comes
#: from the XML Schema datatypes library, which is the one library the reader interprets.
#: The table is deliberately its own rather than shared with :mod:`app.xsd_normalizer`,
#: whose narrower legacy map is load-bearing for committed XSD goldens — widening it there
#: would move those snapshots for no gain to this ticket.
XSD_DATATYPE_TO_CANONICAL: Dict[str, str] = {
    "string": "string",
    "normalizedstring": "string",
    "token": "string",
    "language": "string",
    "name": "string",
    "ncname": "string",
    "nmtoken": "string",
    "id": "string",
    "idref": "string",
    "idrefs": "string",
    "entity": "string",
    "anyuri": "string",
    "qname": "string",
    "notation": "string",
    "base64binary": "string",
    "hexbinary": "string",
    "duration": "string",
    "date": "string",
    "datetime": "string",
    "time": "string",
    "gyear": "string",
    "gyearmonth": "string",
    "gmonth": "string",
    "gmonthday": "string",
    "gday": "string",
    "boolean": "bool",
    "float": "float",
    "double": "double",
    "decimal": "double",
    "integer": "i64",
    "int": "i32",
    "long": "i64",
    "short": "i16",
    "byte": "int8",
    "positiveinteger": "i64",
    "nonnegativeinteger": "i64",
    "negativeinteger": "i64",
    "nonpositiveinteger": "i64",
    "unsignedint": "uint32",
    "unsignedlong": "uint64",
    "unsignedshort": "uint16",
    "unsignedbyte": "uint8",
}

#: Datatypes that carry a canonical ``format`` hint alongside their scalar.
XSD_DATATYPE_FORMATS: Dict[str, str] = {
    "date": "date",
    "datetime": "date-time",
    "time": "time",
    "anyuri": "uri",
    "duration": "duration",
    "base64binary": "byte",
    "hexbinary": "binary",
}

#: ``data`` parameter name -> the canonical :class:`~app.canonical_model.Constraints` field
#: it sets. Parameters with no canonical analogue are kept in the field's extras instead.
_PARAM_TO_CONSTRAINT: Dict[str, str] = {
    "minLength": "min_length",
    "maxLength": "max_length",
    "pattern": "pattern",
    "minInclusive": "minimum",
    "maxInclusive": "maximum",
    "minExclusive": "exclusive_minimum",
    "maxExclusive": "exclusive_maximum",
}

#: Pattern kinds that carry no content of their own.
_EMPTY_KINDS = frozenset({PatternKind.EMPTY, PatternKind.NOT_ALLOWED})

#: Pattern kinds that wrap exactly one child and only change its cardinality.
_CARDINALITY_KINDS = frozenset(
    {PatternKind.OPTIONAL, PatternKind.ZERO_OR_MORE, PatternKind.ONE_OR_MORE}
)

#: The field name given to an element or attribute whose name class is a wildcard. RELAX
#: NG's own spelling for "any name", so a reader sees the source's word rather than ours.
WILDCARD_FIELD_NAME = "*"

#: The field name given to an element's own character content.
TEXT_FIELD_NAME = "text"

#: The field name given to an element's own datatyped content.
VALUE_FIELD_NAME = "value"


def _camel(prefix: str, suffix: str) -> str:
    """Join a parent type name and a child element name into a nested type name.

    Args:
        prefix: The owning type's name.
        suffix: The nested element's name.

    Returns:
        ``prefix`` + capitalized ``suffix`` (``order`` + ``line`` -> ``orderLine``), the
        same anonymous-type spelling the WSDL/XSD reader uses.
    """
    cleaned = _sanitize(suffix)
    if not cleaned:
        return _sanitize(prefix)
    return f"{_sanitize(prefix)}{cleaned[0].upper()}{cleaned[1:]}"


def _sanitize(name: str) -> str:
    """Return ``name`` reduced to characters a canonical type key may carry.

    Composition can produce scoped names (``parcel.rng#1.address``) whose punctuation would
    collide with the canonical key grammar's separators, so it is folded to ``_``.

    Args:
        name: The source name.

    Returns:
        The sanitized name; ``pattern`` when nothing usable survives.
    """
    cleaned = "".join(char if char.isalnum() or char == "_" else "_" for char in name).strip("_")
    return cleaned or "pattern"


class _TypeGraph:
    """Builds the canonical type graph for one parsed grammar.

    Held as a class because building it is one traversal with two pieces of shared state:
    the name table, so two anonymous types can never claim one key, and the emitted types,
    which double as the memo that lets a recursive grammar terminate.
    """

    def __init__(self, document: RelaxNgDocument) -> None:
        self._document = document
        self._namespace = document.namespace
        self._defines: Dict[str, RelaxNgDefine] = document.define_map()
        self._type_names: Dict[str, str] = {}
        self._types: Dict[str, Type] = {}
        self._taken: Set[str] = set()
        for name in self._defines:
            self._type_names[name] = self._claim(_sanitize(name))

    # -- naming -----------------------------------------------------------

    def _claim(self, name: str) -> str:
        """Reserve ``name``, appending a counter until it is unique."""
        candidate = name
        counter = 2
        while candidate in self._taken:
            candidate = f"{name}{counter}"
            counter += 1
        self._taken.add(candidate)
        return candidate

    def _key(self, name: str) -> str:
        """Return the canonical type key for a type name."""
        return Keys.type(name, self._namespace)

    # -- pattern shape ----------------------------------------------------

    def _resolve(self, node: RelaxNgPattern) -> Optional[RelaxNgPattern]:
        """Return the pattern a ``ref`` names, or the node itself when it is not a ref."""
        if node.kind is not PatternKind.REF:
            return node
        define = self._defines.get(node.ref_name or "")
        return define.pattern if define else None

    def _element_of(self, node: RelaxNgPattern) -> Optional[RelaxNgPattern]:
        """Return the single ``element`` pattern ``node`` reduces to, if any.

        Cardinality wrappers and one-child groups are transparent here: ``zeroOrMore {
        element x { … } }`` still *defines* the element ``x``.

        Args:
            node: The pattern to reduce.

        Returns:
            The ``element`` pattern, or ``None`` when the pattern is not element-shaped.
        """
        current: Optional[RelaxNgPattern] = node
        # A grammar may define `a = b` and `b = a`; following refs without a guard would
        # then spin here forever on a document the parser itself accepted.
        seen: Set[str] = set()
        while current is not None:
            if current.kind is PatternKind.ELEMENT:
                return current
            if current.kind in _CARDINALITY_KINDS and len(current.children) == 1:
                current = current.children[0]
                continue
            if current.kind is PatternKind.GROUP and len(current.children) == 1:
                current = current.children[0]
                continue
            if current.kind is PatternKind.REF:
                name = current.ref_name or ""
                if name in seen:
                    return None
                seen.add(name)
                define = self._defines.get(name)
                current = define.pattern if define else None
                continue
            return None
        return None

    def _content_of(self, element: RelaxNgPattern) -> RelaxNgPattern:
        """Return an ``element``/``attribute`` pattern's single content pattern.

        A ``choice`` with one real branch and an ``empty`` one is RELAX NG's spelling of
        "optional content"; it is unwrapped here so the content reads as what it is rather
        than as an alternation of one.

        Args:
            element: The ``element`` or ``attribute`` pattern.

        Returns:
            The content pattern; ``empty`` when the pattern declares none.
        """
        content = (
            element.children[0] if element.children else RelaxNgPattern(kind=PatternKind.EMPTY)
        )
        while content.kind is PatternKind.CHOICE:
            branches = [child for child in content.children if child.kind not in _EMPTY_KINDS]
            if len(branches) != 1:
                break
            content = branches[0]
        return content

    def _shared_type_key(self, content: RelaxNgPattern) -> Optional[str]:
        """Return the named pattern's type key when ``content`` is just a reference to it.

        The rule that keeps the type graph the size of the grammar: an element whose whole
        content is ``<ref name="inline"/>`` *is* an ``inline``, so it takes that type rather
        than growing a private copy of it at every use site. Without this, a grammar that
        reuses one content model in a dozen places — which is what a publishing grammar
        does — projects onto a dozen structurally identical anonymous types.

        Args:
            content: The element's content pattern.

        Returns:
            The referenced named pattern's key, or ``None`` when the content is not a bare
            reference to a non-element, non-scalar pattern.
        """
        if content.kind is not PatternKind.REF:
            return None
        name = content.ref_name or ""
        define = self._defines.get(name)
        if define is None or name not in self._type_names:
            return None
        if self._element_of(define.pattern) is not None or self._is_simple(define.pattern):
            # An element-shaped target is a *child* element, not this element's own type,
            # and a scalar target is handled by the scalar projection.
            return None
        return self._key(self._type_names[name])

    def _is_simple(self, node: RelaxNgPattern, *, seen: Optional[Set[str]] = None) -> bool:
        """Whether ``node``'s content is only text and datatypes.

        A simple pattern projects onto a canonical scalar; anything else — an attribute, a
        child element, mixed content — needs a record.

        Args:
            node: The pattern to classify.
            seen: Named patterns already on the resolution path, for the cycle guard.

        Returns:
            ``True`` when the pattern admits only character content.
        """
        seen = seen or set()
        if node.kind in (PatternKind.TEXT, PatternKind.DATA, PatternKind.VALUE):
            return True
        if node.kind in _EMPTY_KINDS:
            return True
        if node.kind in (PatternKind.ELEMENT, PatternKind.ATTRIBUTE, PatternKind.MIXED):
            return False
        if node.kind is PatternKind.EXTERNAL_REF:
            return False
        if node.kind is PatternKind.PARENT_REF:
            return False
        if node.kind is PatternKind.REF:
            name = node.ref_name or ""
            if name in seen:
                return False
            define = self._defines.get(name)
            return bool(define) and self._is_simple(define.pattern, seen=seen | {name})
        return all(self._is_simple(child, seen=seen) for child in node.children)

    # -- scalars ----------------------------------------------------------

    def _scalar(self, node: RelaxNgPattern) -> Tuple[TypeRef, Optional[Constraints], Dict[str, Any]]:
        """Project a simple pattern onto a scalar reference, constraints and extras.

        Args:
            node: A pattern :meth:`_is_simple` accepts.

        Returns:
            ``(type_ref, constraints, extras)``.
        """
        if node.kind is PatternKind.REF:
            name = node.ref_name or ""
            return (
                TypeRef(name=self._key(self._type_names.get(name, _sanitize(name))), nullable=False),
                None,
                {},
            )
        if node.kind is PatternKind.DATA:
            return self._data_scalar(node)
        if node.kind is PatternKind.VALUE:
            return (
                TypeRef(name="string", nullable=False),
                Constraints(enum=[node.literal]),
                {"relaxng_datatype": node.datatype} if node.datatype else {},
            )
        if node.kind is PatternKind.TEXT:
            return TypeRef(name="string", nullable=False), None, {}
        if node.kind in _EMPTY_KINDS:
            return TypeRef(name="string", nullable=False), None, {"relaxng_content": "empty"}
        if node.kind is PatternKind.LIST:
            inner, constraints, extras = self._scalar(
                node.children[0] if node.children else RelaxNgPattern(kind=PatternKind.TEXT)
            )
            return (
                TypeRef(item=inner, nullable=False),
                constraints,
                {**extras, "relaxng_kind": "list"},
            )
        if node.kind is PatternKind.CHOICE:
            return self._choice_scalar(node)
        if node.kind in _CARDINALITY_KINDS and node.children:
            return self._scalar(node.children[0])
        if node.kind is PatternKind.GROUP and node.children:
            # A group of simple particles is a single text node's content; the first
            # particle carries the datatype, the rest only refine it.
            return self._scalar(node.children[0])
        return TypeRef(name="string", nullable=False), None, {}

    def _data_scalar(
        self, node: RelaxNgPattern
    ) -> Tuple[TypeRef, Optional[Constraints], Dict[str, Any]]:
        """Project a ``data`` pattern onto a scalar, its constraints and its extras."""
        datatype = (node.datatype or "string").strip()
        mapped = XSD_DATATYPE_TO_CANONICAL.get(datatype.lower(), "string")
        fields: Dict[str, Any] = {}
        extras: Dict[str, Any] = {"relaxng_datatype": datatype}
        fmt = XSD_DATATYPE_FORMATS.get(datatype.lower())
        if fmt:
            fields["format"] = fmt
        unmapped: Dict[str, str] = {}
        for name, value in node.params:
            if name == "length":
                fields["min_length"] = _as_int(value, fields.get("min_length"))
                fields["max_length"] = _as_int(value, fields.get("max_length"))
                continue
            target = _PARAM_TO_CONSTRAINT.get(name)
            if target is None:
                unmapped[name] = value
                continue
            if target in ("min_length", "max_length"):
                fields[target] = _as_int(value, None)
            elif target == "pattern":
                fields[target] = value
            else:
                fields[target] = _as_float(value, None)
        fields = {name: value for name, value in fields.items() if value is not None}
        if unmapped:
            extras["relaxng_params"] = unmapped
        if node.excepted:
            extras["relaxng_except"] = [
                child.literal or child.datatype or child.kind.value for child in node.excepted
            ]
        if node.datatype_library:
            extras["relaxng_datatype_library"] = node.datatype_library
        return (
            TypeRef(name=mapped, nullable=False),
            Constraints(**fields) if fields else None,
            extras,
        )

    def _choice_scalar(
        self, node: RelaxNgPattern
    ) -> Tuple[TypeRef, Optional[Constraints], Dict[str, Any]]:
        """Project a choice of simple branches onto one scalar.

        A choice whose branches are all literal ``value`` patterns is an enumeration, which
        the canonical model states as a constraint on the field rather than as a type — the
        values have no names of their own to become enum members.
        """
        branches = [child for child in node.children if child.kind not in _EMPTY_KINDS]
        if branches and all(child.kind is PatternKind.VALUE for child in branches):
            return (
                TypeRef(name="string", nullable=False),
                Constraints(enum=[child.literal for child in branches]),
                {},
            )
        if not branches:
            return TypeRef(name="string", nullable=False), None, {"relaxng_content": "empty"}
        reference, constraints, extras = self._scalar(branches[0])
        if len(branches) > 1:
            extras = {
                **extras,
                "relaxng_alternatives": [
                    child.datatype or child.literal or child.kind.value for child in branches
                ],
            }
        return reference, constraints, extras

    # -- members ----------------------------------------------------------

    def _members(
        self,
        node: RelaxNgPattern,
        *,
        owner: str,
        owner_key: str,
        nullable: bool = False,
        repeated: bool = False,
        interleaved: bool = False,
        counter: Optional[List[int]] = None,
    ) -> List[CanonicalField]:
        """Walk a content model, returning the canonical fields it contributes.

        Args:
            node: The content pattern.
            owner: The owning type's name, used to name anonymous nested types.
            owner_key: The owning type's key, used to build field keys.
            nullable: Whether an enclosing ``optional``/``choice`` makes these members
                optional.
            repeated: Whether an enclosing ``zeroOrMore``/``oneOrMore`` makes them lists.
            interleaved: Whether they came from an ``interleave`` branch, which is the
                declared limit made visible per member.
            counter: Shared field-number counter for the owning type.

        Returns:
            The fields, in document order.
        """
        counter = counter if counter is not None else [0]
        kind = node.kind

        if kind in _EMPTY_KINDS:
            return []

        if kind is PatternKind.OPTIONAL:
            return self._flatten(
                node, owner=owner, owner_key=owner_key, nullable=True,
                repeated=repeated, interleaved=interleaved, counter=counter,
            )
        if kind in (PatternKind.ZERO_OR_MORE, PatternKind.ONE_OR_MORE):
            return self._flatten(
                node, owner=owner, owner_key=owner_key,
                nullable=nullable or kind is PatternKind.ZERO_OR_MORE,
                repeated=True, interleaved=interleaved, counter=counter,
            )
        if kind is PatternKind.GROUP:
            return self._flatten(
                node, owner=owner, owner_key=owner_key, nullable=nullable,
                repeated=repeated, interleaved=interleaved, counter=counter,
            )
        if kind is PatternKind.INTERLEAVE:
            # Every branch stays a member; only their order-independence is inexpressible,
            # which is what the declared limit says and what this tag points at.
            return self._flatten(
                node, owner=owner, owner_key=owner_key, nullable=nullable,
                repeated=repeated, interleaved=True, counter=counter,
            )
        if kind is PatternKind.MIXED:
            members = self._flatten(
                node, owner=owner, owner_key=owner_key, nullable=nullable,
                repeated=repeated, interleaved=interleaved, counter=counter,
            )
            return members + [
                self._leaf_field(
                    RelaxNgPattern(kind=PatternKind.TEXT),
                    name=TEXT_FIELD_NAME,
                    owner_key=owner_key,
                    nullable=True,
                    repeated=False,
                    interleaved=interleaved,
                    counter=counter,
                    extras={"relaxng_kind": "text", "relaxng_mixed": True},
                )
            ]

        if kind is PatternKind.CHOICE:
            return self._choice_members(
                node, owner=owner, owner_key=owner_key, nullable=nullable,
                repeated=repeated, interleaved=interleaved, counter=counter,
            )

        if kind is PatternKind.ELEMENT:
            return [
                self._element_field(
                    node, owner=owner, owner_key=owner_key, nullable=nullable,
                    repeated=repeated, interleaved=interleaved, counter=counter,
                )
            ]

        if kind is PatternKind.ATTRIBUTE:
            return [
                self._attribute_field(
                    node, owner_key=owner_key, nullable=nullable,
                    interleaved=interleaved, counter=counter,
                )
            ]

        if kind is PatternKind.REF:
            return self._ref_members(
                node, owner=owner, owner_key=owner_key, nullable=nullable,
                repeated=repeated, interleaved=interleaved, counter=counter,
            )

        if kind in (PatternKind.TEXT, PatternKind.DATA, PatternKind.VALUE, PatternKind.LIST):
            name = TEXT_FIELD_NAME if kind is PatternKind.TEXT else VALUE_FIELD_NAME
            return [
                self._leaf_field(
                    node, name=name, owner_key=owner_key, nullable=nullable,
                    repeated=repeated, interleaved=interleaved, counter=counter,
                    extras={"relaxng_kind": kind.value},
                )
            ]

        if kind in (PatternKind.PARENT_REF, PatternKind.EXTERNAL_REF):
            # A reference this reader could not resolve never reaches normalization: the
            # parser fails the import first. Reaching here would be a reader bug, so the
            # member is emitted as an opaque string rather than silently skipped.
            return [
                self._leaf_field(
                    RelaxNgPattern(kind=PatternKind.TEXT),
                    name=_sanitize(node.ref_name or "reference"),
                    owner_key=owner_key, nullable=True, repeated=repeated,
                    interleaved=interleaved, counter=counter,
                    extras={"relaxng_kind": kind.value, "relaxng_href": node.ref_name},
                )
            ]
        return []

    def _flatten(self, node: RelaxNgPattern, **kwargs: Any) -> List[CanonicalField]:
        """Return the members of every child of ``node``, concatenated in order."""
        members: List[CanonicalField] = []
        for child in node.children:
            members.extend(self._members(child, **kwargs))
        return members

    def _choice_members(
        self,
        node: RelaxNgPattern,
        *,
        owner: str,
        owner_key: str,
        nullable: bool,
        repeated: bool,
        interleaved: bool,
        counter: List[int],
    ) -> List[CanonicalField]:
        """Project a ``choice`` used as a content particle.

        Three shapes, three answers:

        * every branch simple — the choice is the *value* of one member, so it becomes that
          member's scalar (an enumeration when the branches are literals);
        * one non-empty branch — ``choice { p, empty }`` is how RELAX NG spells "optional",
          so the branch's members are emitted as nullable;
        * otherwise — a genuine alternation, which becomes a ``UNION`` type referenced by
          one member. This is the ticket's "``choice`` maps to unions": the alternation
          exists in the type graph rather than being flattened into optional siblings that
          no longer say only one may appear.
        """
        branches = [child for child in node.children if child.kind not in _EMPTY_KINDS]
        optional = nullable or len(branches) != len(node.children)
        if not branches:
            return []
        if all(self._is_simple(child) for child in node.children):
            return [
                self._leaf_field(
                    node, name=VALUE_FIELD_NAME, owner_key=owner_key, nullable=optional,
                    repeated=repeated, interleaved=interleaved, counter=counter,
                    extras={"relaxng_kind": "choice"},
                )
            ]
        if len(branches) == 1:
            return self._members(
                branches[0], owner=owner, owner_key=owner_key, nullable=optional,
                repeated=repeated, interleaved=interleaved, counter=counter,
            )

        union_name = self._claim(f"{_sanitize(owner)}Choice")
        union_key = self._key(union_name)
        member_keys: List[str] = []
        for index, branch in enumerate(branches):
            member_keys.append(self._branch_type_key(branch, owner=union_name, index=index))
        self._types[union_key] = Type(
            key=union_key,
            name=union_name,
            kind=TypeKind.UNION,
            namespace=self._namespace,
            union_members=member_keys,
            extras={"relaxng_pattern": "choice", "relaxng_owner": owner},
        )
        counter[0] += 1
        return [
            CanonicalField(
                key=Keys.field(owner_key, union_name),
                name=union_name,
                type=_wrap(TypeRef(name=union_key, nullable=optional), repeated=repeated),
                field_number=counter[0],
                extras=_field_extras({"relaxng_kind": "choice"}, interleaved=interleaved),
            )
        ]

    def _branch_type_key(self, branch: RelaxNgPattern, *, owner: str, index: int) -> str:
        """Return (creating if needed) the type key one union branch resolves to."""
        if branch.kind is PatternKind.REF and branch.ref_name in self._type_names:
            return self._key(self._type_names[branch.ref_name])
        element = self._element_of(branch)
        if element is not None and element.element_name:
            return self._nested_type(element, owner=owner)
        if self._is_simple(branch):
            reference, _, _ = self._scalar(branch)
            return reference.name or "string"
        name = self._claim(f"{_sanitize(owner)}Branch{index + 1}")
        return self._record_from(name, branch, pattern_kind="choice-branch")

    # -- fields -----------------------------------------------------------

    def _element_field(
        self,
        node: RelaxNgPattern,
        *,
        owner: str,
        owner_key: str,
        nullable: bool,
        repeated: bool,
        interleaved: bool,
        counter: List[int],
    ) -> CanonicalField:
        """Build the field an ``element`` particle contributes."""
        name = node.element_name or WILDCARD_FIELD_NAME
        content = self._content_of(node)
        extras: Dict[str, Any] = {"relaxng_kind": "element"}
        if node.name_class is not None and node.name_class.kind is not NameClassKind.NAME:
            extras["relaxng_name_class"] = node.name_class.describe()
            extras["relaxng_wildcard"] = True
        if node.name_class is not None and node.name_class.ns:
            extras["relaxng_ns"] = node.name_class.ns

        shared = self._shared_type_key(content)
        if self._is_simple(content):
            reference, constraints, leaf_extras = self._scalar(content)
            extras.update(leaf_extras)
        elif shared is not None:
            reference = TypeRef(name=shared, nullable=False)
            constraints = None
            extras["relaxng_ref"] = content.ref_name
        else:
            reference = TypeRef(name=self._nested_type(node, owner=owner), nullable=False)
            constraints = None

        counter[0] += 1
        return CanonicalField(
            key=Keys.field(owner_key, name),
            name=name,
            type=_wrap(TypeRef(**{**reference.model_dump(), "nullable": nullable}), repeated=repeated),
            field_number=counter[0],
            constraints=constraints,
            description=node.documentation,
            extras=_field_extras(extras, interleaved=interleaved),
        )

    def _attribute_field(
        self,
        node: RelaxNgPattern,
        *,
        owner_key: str,
        nullable: bool,
        interleaved: bool,
        counter: List[int],
    ) -> CanonicalField:
        """Build the field an ``attribute`` particle contributes.

        An attribute's content is always character data in RELAX NG, so it is always a
        scalar member — never a nested record.
        """
        name = node.element_name or WILDCARD_FIELD_NAME
        content = self._content_of(node) if node.children else RelaxNgPattern(kind=PatternKind.TEXT)
        reference, constraints, extras = self._scalar(content)
        extras = {**extras, "relaxng_kind": "attribute"}
        if node.name_class is not None and node.name_class.kind is not NameClassKind.NAME:
            extras["relaxng_name_class"] = node.name_class.describe()
            extras["relaxng_wildcard"] = True
        counter[0] += 1
        return CanonicalField(
            key=Keys.field(owner_key, name),
            name=name,
            type=TypeRef(**{**reference.model_dump(), "nullable": nullable}),
            field_number=counter[0],
            constraints=constraints,
            description=node.documentation,
            extras=_field_extras(extras, interleaved=interleaved),
        )

    def _leaf_field(
        self,
        node: RelaxNgPattern,
        *,
        name: str,
        owner_key: str,
        nullable: bool,
        repeated: bool,
        interleaved: bool,
        counter: List[int],
        extras: Dict[str, Any],
    ) -> CanonicalField:
        """Build the field an element's own character/datatyped content contributes."""
        reference, constraints, leaf_extras = self._scalar(node)
        counter[0] += 1
        return CanonicalField(
            key=Keys.field(owner_key, name),
            name=name,
            type=_wrap(TypeRef(**{**reference.model_dump(), "nullable": nullable}), repeated=repeated),
            field_number=counter[0],
            constraints=constraints,
            extras=_field_extras({**leaf_extras, **extras}, interleaved=interleaved),
        )

    def _ref_members(
        self,
        node: RelaxNgPattern,
        *,
        owner: str,
        owner_key: str,
        nullable: bool,
        repeated: bool,
        interleaved: bool,
        counter: List[int],
    ) -> List[CanonicalField]:
        """Project a ``ref`` used as a content particle.

        Every shape becomes exactly one member, typed by the named pattern's own canonical
        type. Which member it is depends on what the target defines: a target that defines
        an element contributes *that element* (so the member takes the element's name), a
        text-only target contributes the owning element's datatyped content, and any other
        target — an attribute set, a content group, mixed prose — contributes a member named
        after the pattern itself.

        Args:
            node: The ``ref`` pattern.
            owner: The owning type's name.
            owner_key: The owning type's key.
            nullable: Whether an enclosing ``optional``/``choice`` makes it optional.
            repeated: Whether an enclosing ``zeroOrMore``/``oneOrMore`` makes it a list.
            interleaved: Whether it came from an ``interleave`` branch.
            counter: Shared field-number counter for the owning type.

        Returns:
            The single field, or nothing when the reference names no known pattern (which
            the parser has already refused, so it cannot happen for a parsed document).
        """
        name = node.ref_name or ""
        define = self._defines.get(name)
        if define is None:
            return []
        element = self._element_of(define.pattern)
        if element is not None:
            field_name = element.element_name or WILDCARD_FIELD_NAME
            counter[0] += 1
            return [
                CanonicalField(
                    key=Keys.field(owner_key, field_name),
                    name=field_name,
                    type=_wrap(
                        TypeRef(name=self._key(self._type_names[name]), nullable=nullable),
                        repeated=repeated,
                    ),
                    field_number=counter[0],
                    extras=_field_extras(
                        {"relaxng_kind": "element", "relaxng_ref": name},
                        interleaved=interleaved,
                    ),
                )
            ]
        if self._is_simple(define.pattern):
            return [
                self._leaf_field(
                    node, name=VALUE_FIELD_NAME, owner_key=owner_key, nullable=nullable,
                    repeated=repeated, interleaved=interleaved, counter=counter,
                    extras={"relaxng_kind": "data", "relaxng_ref": name},
                )
            ]
        # Any other named pattern — an attribute set, a content group, mixed prose — keeps
        # its identity: the member is typed by the named pattern rather than having its
        # members spliced in, which is what "named patterns become canonical types" means
        # and what keeps a grammar that reuses one group in ten places to ten references
        # rather than ten copies.
        field_name = _sanitize(name)
        counter[0] += 1
        return [
            CanonicalField(
                key=Keys.field(owner_key, field_name),
                name=field_name,
                type=_wrap(
                    TypeRef(name=self._key(self._type_names[name]), nullable=nullable),
                    repeated=repeated,
                ),
                field_number=counter[0],
                extras=_field_extras(
                    {"relaxng_kind": "group", "relaxng_ref": name}, interleaved=interleaved
                ),
            )
        ]

    # -- types ------------------------------------------------------------

    def _nested_type(
        self, element: RelaxNgPattern, *, owner: str, name: Optional[str] = None
    ) -> str:
        """Return (creating if needed) the type key for an inline ``element`` pattern.

        Args:
            element: The ``element`` pattern.
            owner: The owning type's name, which the nested type is named after.
            name: An explicit type name, used for the document element (which is named
                after itself rather than after a parent it has none of).

        Returns:
            The nested type's canonical key.
        """
        claimed = self._claim(name or _camel(owner, element.element_name or "any"))
        return self._record_from(
            claimed,
            self._content_of(element),
            pattern_kind="inline",
            element_name=element.element_name,
        )

    def _record_from(
        self,
        name: str,
        content: RelaxNgPattern,
        *,
        pattern_kind: str,
        element_name: Optional[str] = None,
    ) -> str:
        """Create a ``RECORD`` type from a content pattern and return its key."""
        key = self._key(name)
        extras: Dict[str, Any] = {"relaxng_pattern": pattern_kind}
        if element_name:
            extras["relaxng_element"] = element_name
        # Registered before its members are walked so a recursive content model resolves
        # back to this type instead of building a second copy of it.
        self._types[key] = Type(
            key=key, name=name, kind=TypeKind.RECORD, namespace=self._namespace, extras=extras
        )
        fields = self._members(content, owner=name, owner_key=key)
        self._types[key] = Type(
            key=key,
            name=name,
            kind=TypeKind.RECORD,
            namespace=self._namespace,
            fields=fields,
            extras=extras,
        )
        return key

    def _emit_named_type(
        self, name: str, body: RelaxNgPattern, *, pattern_kind: str, combine: Optional[str] = None
    ) -> str:
        """Emit the canonical type a whole named (or start) pattern projects onto.

        Shared by the ``define`` table and by a ``start`` that declares its document element
        inline, so the same body shape produces the same kind of type wherever it is
        written: an element with text-only content is a ``SCALAR``, an element whose whole
        content is one ``ref`` is an ``ALIAS``, a choice of branches is a ``UNION``, and
        anything else is a ``RECORD``.

        Args:
            name: The already-claimed type name.
            body: The pattern the type is built from.
            pattern_kind: What the body was written as (``define`` / ``start``), recorded in
                extras.
            combine: The declared ``combine`` method, when the name was assembled from
                several declarations.

        Returns:
            The type's canonical key.
        """
        key = self._key(name)
        extras: Dict[str, Any] = {"relaxng_pattern": pattern_kind}
        if combine:
            extras["relaxng_combine"] = combine

        element = self._element_of(body)
        if element is not None:
            extras["relaxng_element"] = element.element_name or WILDCARD_FIELD_NAME
            if element.name_class is not None and element.name_class.kind is not NameClassKind.NAME:
                extras["relaxng_name_class"] = element.name_class.describe()
            content = self._content_of(element)
            if self._is_simple(content):
                self._types[key] = self._scalar_type(name, key, content, extras)
                return key
            shared = self._shared_type_key(content)
            if shared is not None:
                self._types[key] = Type(
                    key=key,
                    name=name,
                    kind=TypeKind.ALIAS,
                    namespace=self._namespace,
                    aliased=TypeRef(name=shared, nullable=False),
                    description=element.documentation or body.documentation,
                    extras={**extras, "relaxng_ref": content.ref_name},
                )
                return key
            self._types[key] = Type(
                key=key, name=name, kind=TypeKind.RECORD, namespace=self._namespace, extras=extras
            )
            self._types[key] = Type(
                key=key,
                name=name,
                kind=TypeKind.RECORD,
                namespace=self._namespace,
                fields=self._members(content, owner=name, owner_key=key),
                description=element.documentation or body.documentation,
                extras=extras,
            )
            return key

        if self._is_simple(body):
            self._types[key] = self._scalar_type(name, key, body, extras)
            return key

        if body.kind is PatternKind.CHOICE:
            branches = [child for child in body.children if child.kind not in _EMPTY_KINDS]
            if len(branches) > 1:
                self._types[key] = Type(
                    key=key,
                    name=name,
                    kind=TypeKind.UNION,
                    namespace=self._namespace,
                    union_members=[
                        self._branch_type_key(branch, owner=name, index=index)
                        for index, branch in enumerate(branches)
                    ],
                    description=body.documentation,
                    extras={**extras, "relaxng_pattern": "choice"},
                )
                return key

        self._types[key] = Type(
            key=key, name=name, kind=TypeKind.RECORD, namespace=self._namespace, extras=extras
        )
        self._types[key] = Type(
            key=key,
            name=name,
            kind=TypeKind.RECORD,
            namespace=self._namespace,
            fields=self._members(body, owner=name, owner_key=key),
            description=body.documentation,
            extras=extras,
        )
        return key

    def _scalar_type(
        self, name: str, key: str, content: RelaxNgPattern, extras: Dict[str, Any]
    ) -> Type:
        """Build the ``SCALAR``/``ENUM`` type a text-only named pattern projects onto."""
        reference, constraints, leaf_extras = self._scalar(content)
        merged = {**extras, **leaf_extras, "relaxng_type": reference.name or "list"}
        return Type(
            key=key,
            name=name,
            kind=TypeKind.SCALAR,
            namespace=self._namespace,
            constraints=constraints,
            description=content.documentation,
            extras=merged,
        )

    # -- entry point ------------------------------------------------------

    def build(self) -> Tuple[List[Type], str]:
        """Build the whole type graph.

        Returns:
            ``(types, root_type_key)`` — the types in a deterministic order, and the key of
            the type the grammar's ``start`` pattern resolves to.
        """
        for define in self._document.defines:
            self._emit_named_type(
                self._type_names[define.name],
                define.pattern,
                pattern_kind="define",
                combine=define.combine,
            )

        start = self._document.start
        if start.kind is PatternKind.REF and start.ref_name in self._type_names:
            root_key = self._key(self._type_names[start.ref_name])
        else:
            element = self._element_of(start)
            if element is not None and element.element_name:
                # A start that declares its document element inline goes through the same
                # projection a `define` would, so a text-only document element is a scalar
                # here exactly as it would be if the grammar had named it.
                root_key = self._emit_named_type(
                    self._claim(_sanitize(element.element_name)),
                    start,
                    pattern_kind="start",
                )
            elif start.kind is PatternKind.CHOICE:
                branches = [child for child in start.children if child.kind not in _EMPTY_KINDS]
                root_name = self._claim("start")
                root_key = self._key(root_name)
                self._types[root_key] = Type(
                    key=root_key,
                    name=root_name,
                    kind=TypeKind.UNION,
                    namespace=self._namespace,
                    union_members=[
                        self._branch_type_key(branch, owner=root_name, index=index)
                        for index, branch in enumerate(branches)
                    ],
                    extras={"relaxng_pattern": "start"},
                )
            else:
                root_name = self._claim("start")
                root_key = self._record_from(root_name, start, pattern_kind="start")
        return list(self._types.values()), root_key


def _as_int(value: str, fallback: Optional[int]) -> Optional[int]:
    """Parse a ``data`` parameter as an integer, keeping ``fallback`` when it is not one."""
    try:
        return int(value.strip())
    except (TypeError, ValueError):
        return fallback


def _as_float(value: str, fallback: Optional[float]) -> Optional[float]:
    """Parse a ``data`` parameter as a number, keeping ``fallback`` when it is not one."""
    try:
        return float(value.strip())
    except (TypeError, ValueError):
        return fallback


def _wrap(reference: TypeRef, *, repeated: bool) -> TypeRef:
    """Wrap ``reference`` in a list reference when the particle repeats.

    Optionality moves outward with the wrapper: ``zeroOrMore`` means *the list* may be
    absent, not that each item may be null, so the item reference is made non-nullable and
    the list carries the nullability instead. ``oneOrMore`` produces a required list of
    required items, which is the same rule with nothing to move.

    Args:
        reference: The item reference, already carrying the particle's nullability.
        repeated: Whether an enclosing ``zeroOrMore``/``oneOrMore`` makes it a list.

    Returns:
        The reference, wrapped when repeated.
    """
    if not repeated:
        return reference
    return TypeRef(
        item=reference.model_copy(update={"nullable": False}), nullable=reference.nullable
    )


def _field_extras(extras: Dict[str, Any], *, interleaved: bool) -> Dict[str, Any]:
    """Return a field's extras, tagging the ones an ``interleave`` contributed.

    The tag is what makes the ``relaxng.interleave`` declared limit actionable: a reader
    can see exactly which members are the ones whose order-independence was not carried,
    instead of being told only that the grammar contained an interleave somewhere.
    """
    cleaned = {name: value for name, value in extras.items() if value is not None}
    if interleaved:
        cleaned["relaxng_interleaved"] = True
    return cleaned


def _limits_payload(document: RelaxNgDocument) -> List[Dict[str, Any]]:
    """Render the reader's declared limits as the extras bag's ``capability_limits``."""
    return [
        {
            "construct": limit.construct,
            "detail": limit.detail,
            "count": limit.count,
            "locations": list(limit.locations),
        }
        for limit in document.declared_limits
    ]


class RelaxNgNormalizer(Normalizer, register=True):
    """Normalize a parsed RELAX NG grammar into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Project a :class:`~app.relaxng_grammar.RelaxNgDocument` onto the canonical model.

        Args:
            source: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ValueError: If ``source`` is not a parsed RELAX NG document.
        """
        if not isinstance(source, RelaxNgDocument):
            raise ValueError(
                "RELAX NG source must be a RelaxNgDocument (see app.relaxng_parser.parse_relaxng)"
            )

        graph = _TypeGraph(source)
        types, root_key = graph.build()
        root = next((entity for entity in types if entity.key == root_key), None)
        title = (root.extras.get("relaxng_element") if root else None) or (
            root.name if root else "grammar"
        )

        relaxng: Dict[str, Any] = {
            "root_type": root_key,
            "capability_limits": _limits_payload(source),
        }
        if source.namespace:
            relaxng["namespace"] = source.namespace
        if source.datatype_library:
            relaxng["datatype_library"] = source.datatype_library
        if source.includes:
            relaxng["includes"] = list(source.includes)
        if source.external_refs:
            relaxng["external_refs"] = list(source.external_refs)

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=title, namespace=source.namespace),
            title=title,
            description=source.documentation,
            types=types,
            raw={"relaxng": source.raw} if include_raw else None,
            extras={RELAXNG_EXTRAS_KEY: relaxng},
        )
        return normalize_ordering(api)
