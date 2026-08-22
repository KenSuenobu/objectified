"""DTD → canonical model normalizer — FMT-4.2 (#5435).

Projects the declaration algebra :mod:`app.dtd_grammar` defines onto a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA` — the same paradigm the XSD and
RELAX NG readers produce. All three describe XML documents, and a reader of the catalog
should not have to know which of the three languages a schema happened to be written in.

**The projection.**

* Every ``<!ELEMENT>`` becomes one canonical type, named after the element, so a content
  model that names an element and that element's own declaration line up by key. Which
  *kind* of type follows from the content model: ``(#PCDATA)`` with no attributes is a
  ``SCALAR``, everything else is a ``RECORD``.
* A name particle inside a content model becomes a field typed by that element's type —
  never a spliced-in copy of it, so a DTD that reuses one element in forty content models
  projects onto forty references rather than forty identical types.
* Occurrence indicators become nullability and lists: ``?`` nullable, ``*`` a nullable
  list, ``+`` a required list. An indicator on a *group* distributes onto the group's
  members, which is the ``dtd.repeated_group`` declared limit.
* A ``choice`` becomes a ``UNION`` referenced by one member, rather than being flattened
  into optional siblings that no longer say only one may appear.
* ``<!ATTLIST>`` definitions become members named with the XPath ``@`` sigil — an element
  and one of its own attributes may share a name, and the sigil is how XML itself tells
  them apart. **The attribute default vocabulary becomes canonical constraints**, which is
  the ticket's second acceptance criterion: an enumeration becomes ``constraints.enum``,
  ``#FIXED "v"`` becomes a ``default`` plus a single-valued ``enum`` (the value is not
  merely suggested, it is the only one admitted), a bare literal default becomes
  ``default``, ``#REQUIRED`` a non-nullable member and ``#IMPLIED`` a nullable one.

**Mixed content is modelled *and* declared a limit** — the ticket's third criterion asks
for one or the other, stated explicitly, and both are cheap here. The child elements a
mixed model admits become ordinary repeated members and the character half becomes a
``#text`` member, so nothing is dropped; what genuinely has no canonical analogue — that
the text and the children *interleave*, in any order and any number — is recorded as
``dtd.mixed_content`` in ``extras['dtd']['capability_limits']`` and rendered as a
partially-mapped coverage row.

**Entities are not a canonical construct.** A general entity is expanded by the reader
before normalization, so its uses leave no trace to lose; the declarations themselves are
carried in ``extras['dtd']`` so a reader can still see what the DTD defined, and an
*unparsed* entity — which names external binary content through a notation — is recorded
there as the ``dtd.unparsed_entity`` limit says it is.
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
from .dtd_grammar import (
    IDENTITY_ATTRIBUTE_TYPES,
    TOKENIZED_ATTRIBUTE_TYPES,
    AttributeDefault,
    ContentKind,
    DtdAttribute,
    DtdDocument,
    DtdElement,
    DtdParticle,
)
from .normalizer import Keys, Normalizer, normalize_ordering

__all__ = [
    "ATTRIBUTE_FIELD_SIGIL",
    "DTD_EXTRAS_KEY",
    "TEXT_FIELD_NAME",
    "WILDCARD_FIELD_NAME",
    "DtdNormalizer",
]

_FORMAT_KEY = "dtd"

#: The single extras bag the DTD projection hangs on the canonical API — one key the
#: preview manifest and the capability surfaces read, rather than a scatter of loosely
#: related top-level keys.
DTD_EXTRAS_KEY = "dtd"

#: The sigil an attribute member's name carries, borrowed from XPath. An element may
#: declare an attribute with the same name as one of its children, so the two need to be
#: distinguishable — and a reader who knows XML already reads ``@href`` as an attribute.
ATTRIBUTE_FIELD_SIGIL = "@"

#: The member name given to an element's own character content.
TEXT_FIELD_NAME = "#text"

#: The member name given to the open content of an ``ANY`` element.
WILDCARD_FIELD_NAME = "*"

#: Every DTD attribute value is character data; the declared type constrains its *lexical*
#: shape and its cross-reference role, never its canonical scalar.
_STRING = "string"


def _sanitize(name: str) -> str:
    """Return ``name`` reduced to characters a canonical type key may carry.

    XML names admit ``.``, ``-`` and ``:``, and a colon in particular is how DTDs spell the
    namespace prefixes they have no other support for. Those characters collide with the
    canonical key grammar's separators, so they are folded to ``_``.

    Args:
        name: The source element name.

    Returns:
        The folded name, or ``"element"`` when nothing survives.
    """
    folded = "".join(char if char.isalnum() or char == "_" else "_" for char in name)
    return folded or "element"


def _wrap(reference: TypeRef, *, repeated: bool) -> TypeRef:
    """Return ``reference``, wrapped in a list when the particle repeats.

    The nullability rides on the *list*, not on its items: ``(tag*)`` is an optional list of
    required tags, not a required list of optional ones.
    """
    if not repeated:
        return reference
    item = TypeRef(**{**reference.model_dump(), "nullable": False})
    return TypeRef(name="list", item=item, nullable=reference.nullable)


class _Member:
    """One member a content model contributes, before duplicates are folded together.

    A DTD content model may name the same element twice — ``(party, party)`` means exactly
    two — and two canonical fields cannot share a key. Collecting members first and folding
    afterwards is what turns that into one list member with ``min_items``/``max_items``
    rather than into a key collision or a silently dropped particle.
    """

    __slots__ = (
        "name",
        "type_key",
        "nullable",
        "repeated",
        "particles",
        "countable",
        "default",
        "constraints",
        "extras",
    )

    def __init__(
        self,
        name: str,
        type_key: str,
        *,
        nullable: bool,
        repeated: bool,
        extras: Dict[str, Any],
        default: Optional[Any] = None,
        constraints: Optional[Constraints] = None,
    ) -> None:
        self.name = name
        self.type_key = type_key
        self.nullable = nullable
        self.repeated = repeated
        self.particles = 1
        # Whether the member's cardinality is an exact count. A model that names an element
        # twice bounds it at two; one that names it twice with a `+` on either does not.
        self.countable = not repeated
        self.default = default
        self.constraints = constraints
        self.extras = extras


class _TypeGraph:
    """Builds the canonical type graph for one parsed DTD."""

    def __init__(self, document: DtdDocument) -> None:
        self._document = document
        self._types: Dict[str, Type] = {}
        self._type_names: Dict[str, str] = {}
        self._claimed: Set[str] = set()

    # -- naming ----------------------------------------------------------

    def _claim(self, preferred: str) -> str:
        """Reserve a unique canonical type name derived from ``preferred``."""
        candidate = _sanitize(preferred)
        if candidate not in self._claimed:
            self._claimed.add(candidate)
            return candidate
        index = 2
        while f"{candidate}{index}" in self._claimed:
            index += 1
        candidate = f"{candidate}{index}"
        self._claimed.add(candidate)
        return candidate

    @staticmethod
    def _key(name: str) -> str:
        """Return the canonical type key for a claimed type name."""
        return Keys.type(name, None)

    def _element_key(self, element_name: str) -> str:
        """Return the canonical key of the type an element name resolves to."""
        return self._key(self._type_names[element_name])

    # -- build -----------------------------------------------------------

    def build(self) -> Tuple[List[Type], Optional[str]]:
        """Project the document's declarations onto canonical types.

        Returns:
            The types, ordered as the DTD declared them, and the root type's key.
        """
        for element in self._document.elements:
            self._type_names[element.name] = self._claim(element.name)
        for element in self._document.elements:
            self._build_element(element)
        root = self._document.root
        root_key = self._element_key(root) if root in self._type_names else None
        element_keys = [self._element_key(element.name) for element in self._document.elements]
        declared = set(element_keys)
        ordered = [self._types[key] for key in element_keys]
        synthesized = [
            entity for key, entity in self._types.items() if key not in declared
        ]
        return ordered + synthesized, root_key

    def _build_element(self, element: DtdElement) -> None:
        """Build the canonical type one ``<!ELEMENT>`` declaration projects onto."""
        name = self._type_names[element.name]
        key = self._key(name)
        content = element.content
        extras: Dict[str, Any] = {
            "dtd_element": element.name,
            "dtd_content": content.kind.value,
        }

        if content.kind is ContentKind.PCDATA and not element.attributes:
            self._types[key] = Type(
                key=key,
                name=name,
                kind=TypeKind.SCALAR,
                extras={**extras, "dtd_type": _STRING},
            )
            return

        # Registered before its members are walked so a recursive content model resolves
        # back to this type instead of building a second copy of it.
        self._types[key] = Type(key=key, name=name, kind=TypeKind.RECORD, extras=extras)
        members: List[_Member] = [
            self._attribute_member(attribute, owner_key=key)
            for attribute in element.attributes
        ]
        members.extend(self._content_members(content, owner=name))
        self._types[key] = Type(
            key=key,
            name=name,
            kind=TypeKind.RECORD,
            fields=self._fields(members, owner_key=key),
            extras=extras,
        )

    def _content_members(self, content: DtdParticle, *, owner: str) -> List[_Member]:
        """Return the members an element's content model contributes."""
        if content.kind is ContentKind.EMPTY:
            return []
        if content.kind is ContentKind.ANY:
            return [
                _Member(
                    WILDCARD_FIELD_NAME,
                    _STRING,
                    nullable=True,
                    repeated=True,
                    extras={"dtd_kind": "any", "dtd_open_content": True},
                )
            ]
        if content.kind is ContentKind.PCDATA:
            return [
                _Member(
                    TEXT_FIELD_NAME,
                    _STRING,
                    nullable=False,
                    repeated=False,
                    extras={"dtd_kind": "text"},
                )
            ]
        if content.kind is ContentKind.MIXED:
            members = [
                _Member(
                    child.name or WILDCARD_FIELD_NAME,
                    self._element_key(child.name) if child.name else _STRING,
                    nullable=True,
                    repeated=True,
                    extras={"dtd_kind": "element", "dtd_mixed": True},
                )
                for child in content.children
            ]
            members.append(
                _Member(
                    TEXT_FIELD_NAME,
                    _STRING,
                    nullable=True,
                    repeated=False,
                    extras={"dtd_kind": "text", "dtd_mixed": True},
                )
            )
            return members
        return self._particle_members(
            content,
            owner=owner,
            nullable=content.occurrence.optional,
            repeated=content.occurrence.repeated,
        )

    def _particle_members(
        self,
        particle: DtdParticle,
        *,
        owner: str,
        nullable: bool,
        repeated: bool,
    ) -> List[_Member]:
        """Return the members one content-model particle contributes.

        Args:
            particle: The particle to project.
            owner: The owning type's name, used to name synthesized union types.
            nullable: Whether an enclosing group made this particle optional.
            repeated: Whether an enclosing group made this particle repeat.

        Returns:
            The members, in source order.
        """
        if particle.kind is ContentKind.NAME and particle.name:
            return [
                _Member(
                    particle.name,
                    self._element_key(particle.name),
                    nullable=nullable or particle.occurrence.optional,
                    repeated=repeated or particle.occurrence.repeated,
                    extras={
                        "dtd_kind": "element",
                        "dtd_occurrence": particle.occurrence.value or "1",
                    },
                )
            ]
        if particle.kind is ContentKind.CHOICE:
            return [
                self._choice_member(
                    particle,
                    owner=owner,
                    nullable=nullable or particle.occurrence.optional,
                    repeated=repeated or particle.occurrence.repeated,
                )
            ]
        members: List[_Member] = []
        for child in particle.children:
            members.extend(
                self._particle_members(
                    child,
                    owner=owner,
                    nullable=nullable or particle.occurrence.optional,
                    repeated=repeated or particle.occurrence.repeated,
                )
            )
        return members

    def _choice_member(
        self, particle: DtdParticle, *, owner: str, nullable: bool, repeated: bool
    ) -> _Member:
        """Project a ``choice`` group onto one member typed by a synthesized union."""
        name = self._claim(f"{_sanitize(owner)}Choice")
        key = self._key(name)
        self._types[key] = Type(
            key=key,
            name=name,
            kind=TypeKind.UNION,
            union_members=[
                self._branch_type_key(branch, owner=name, index=index)
                for index, branch in enumerate(particle.children)
            ],
            extras={"dtd_content": "choice", "dtd_owner": owner},
        )
        return _Member(
            name,
            key,
            nullable=nullable,
            repeated=repeated,
            extras={"dtd_kind": "choice"},
        )

    def _branch_type_key(self, branch: DtdParticle, *, owner: str, index: int) -> str:
        """Return (creating if needed) the type key one union branch resolves to."""
        if branch.kind is ContentKind.NAME and branch.name:
            return self._element_key(branch.name)
        if branch.kind is ContentKind.CHOICE:
            return self._choice_member(
                branch, owner=owner, nullable=False, repeated=False
            ).type_key
        name = self._claim(f"{_sanitize(owner)}Branch{index + 1}")
        key = self._key(name)
        self._types[key] = Type(key=key, name=name, kind=TypeKind.RECORD, extras={})
        members = self._particle_members(
            branch,
            owner=name,
            nullable=branch.occurrence.optional,
            repeated=branch.occurrence.repeated,
        )
        self._types[key] = Type(
            key=key,
            name=name,
            kind=TypeKind.RECORD,
            fields=self._fields(members, owner_key=key),
            extras={"dtd_content": branch.kind.value, "dtd_owner": owner},
        )
        return key

    # -- attributes ------------------------------------------------------

    def _attribute_member(self, attribute: DtdAttribute, *, owner_key: str) -> _Member:
        """Project one ``<!ATTLIST>`` definition onto a member.

        Every DTD attribute value is character data, so the member is always a string (or a
        list of strings for the tokenized types) and the declared type survives in extras.
        The *default* vocabulary is what becomes canonical: see the module docstring.
        """
        extras: Dict[str, Any] = {
            "dtd_kind": "attribute",
            "dtd_attribute": attribute.name,
            "dtd_attribute_type": attribute.type.value,
            "dtd_default": attribute.default.value,
        }
        if attribute.type in TOKENIZED_ATTRIBUTE_TYPES:
            extras["dtd_tokenized"] = True
        if attribute.type in IDENTITY_ATTRIBUTE_TYPES:
            extras["dtd_identity"] = True
        if attribute.enumeration:
            extras["dtd_enumeration"] = list(attribute.enumeration)
        return _Member(
            f"{ATTRIBUTE_FIELD_SIGIL}{attribute.name}",
            _STRING,
            # `#IMPLIED` is the one default that leaves the value genuinely absent;
            # `#REQUIRED` demands it and both defaulting forms supply it.
            nullable=attribute.default is AttributeDefault.IMPLIED,
            repeated=attribute.type in TOKENIZED_ATTRIBUTE_TYPES,
            extras=extras,
            default=attribute.default_value,
            constraints=self._attribute_constraints(attribute),
        )

    @staticmethod
    def _attribute_constraints(attribute: DtdAttribute) -> Optional[Constraints]:
        """Return the canonical constraints one attribute definition declares.

        Args:
            attribute: The attribute definition.

        Returns:
            The constraints, or ``None`` when the declaration constrains nothing.
        """
        if attribute.default is AttributeDefault.FIXED and attribute.default_value is not None:
            # `#FIXED "v"` does not suggest a value, it admits exactly one — which is an
            # enumeration of one, and the only canonical way to say so.
            return Constraints(enum=[attribute.default_value])
        if attribute.enumeration:
            return Constraints(enum=list(attribute.enumeration))
        return None

    # -- fields ----------------------------------------------------------

    def _fields(self, members: List[_Member], *, owner_key: str) -> List[CanonicalField]:
        """Fold duplicate members together and render them as canonical fields."""
        folded: List[_Member] = []
        by_name: Dict[str, _Member] = {}
        for member in members:
            existing = by_name.get(member.name)
            if existing is None:
                by_name[member.name] = member
                folded.append(member)
                continue
            # The same element named twice in one model is one repeated member, and how
            # many times it was named is a cardinality fact worth keeping.
            existing.particles += 1
            existing.countable = existing.countable and not member.repeated
            existing.repeated = True
            existing.nullable = existing.nullable and member.nullable

        fields: List[CanonicalField] = []
        for number, member in enumerate(folded, start=1):
            extras = dict(member.extras)
            constraints = member.constraints
            if member.particles > 1:
                extras["dtd_particles"] = member.particles
                if member.countable and constraints is None:
                    constraints = Constraints(
                        min_items=member.particles, max_items=member.particles
                    )
            fields.append(
                CanonicalField(
                    key=Keys.field(owner_key, member.name),
                    name=member.name,
                    type=_wrap(
                        TypeRef(name=member.type_key, nullable=member.nullable),
                        repeated=member.repeated,
                    ),
                    field_number=number,
                    default=member.default,
                    constraints=constraints,
                    extras=extras,
                )
            )
        return fields


def _limits_payload(document: DtdDocument) -> List[Dict[str, Any]]:
    """Render the reader's declared limits as the extras bag's ``capability_limits``."""
    return [
        {
            "construct": limit.construct,
            "detail": limit.detail,
            "count": limit.count,
            "locations": list(limit.locations),
        }
        for limit in document.limits
    ]


def _entities_payload(document: DtdDocument) -> Dict[str, Any]:
    """Render the entity, notation and orphan-attribute declarations for the extras bag."""
    payload: Dict[str, Any] = {}
    if document.entities:
        payload["entities"] = [
            {
                key: value
                for key, value in (
                    ("name", entity.name),
                    ("value", entity.value),
                    ("system_id", entity.system_id),
                    ("public_id", entity.public_id),
                    ("notation", entity.notation),
                )
                if value is not None
            }
            for entity in document.entities
        ]
    if document.parameter_entities:
        payload["parameter_entities"] = [
            {
                key: value
                for key, value in (
                    ("name", entity.name),
                    ("value", entity.value),
                    ("system_id", entity.system_id),
                    ("public_id", entity.public_id),
                )
                if value is not None
            }
            for entity in document.parameter_entities
        ]
    if document.notations:
        payload["notations"] = [
            {
                key: value
                for key, value in (
                    ("name", notation.name),
                    ("system_id", notation.system_id),
                    ("public_id", notation.public_id),
                )
                if value is not None
            }
            for notation in document.notations
        ]
    if document.orphan_attlists:
        payload["orphan_attlists"] = {
            element: [
                {
                    "name": attribute.name,
                    "type": attribute.type.value,
                    "default": attribute.default.value,
                }
                for attribute in attributes
            ]
            for element, attributes in sorted(document.orphan_attlists.items())
        }
    return payload


class DtdNormalizer(Normalizer, register=True):
    """Normalize a parsed DTD into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Project a :class:`~app.dtd_grammar.DtdDocument` onto the canonical model.

        Args:
            source: The parsed document.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ValueError: If ``source`` is not a parsed DTD.
        """
        if not isinstance(source, DtdDocument):
            raise ValueError(
                "DTD source must be a DtdDocument (see app.dtd_parser.parse_dtd)"
            )

        graph = _TypeGraph(source)
        types, root_key = graph.build()
        title = source.root or source.name or "dtd"

        dtd: Dict[str, Any] = {
            "root_type": root_key,
            "root_element": source.root,
            "capability_limits": _limits_payload(source),
            "entity_expansions": source.expansions,
        }
        if source.name:
            # Present only when the DTD travelled inside an instance document: a standalone
            # external subset declares no root, and this is how a reader tells the two apart.
            dtd["doctype"] = source.name
        if source.external_subsets:
            dtd["external_subsets"] = list(source.external_subsets)
        if source.unresolved_system_ids:
            dtd["unresolved_system_ids"] = list(source.unresolved_system_ids)
        dtd.update(_entities_payload(source))

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=title),
            title=title,
            types=types,
            raw={"dtd": source.raw} if include_raw else None,
            extras={DTD_EXTRAS_KEY: dtd},
        )
        return normalize_ordering(api)
