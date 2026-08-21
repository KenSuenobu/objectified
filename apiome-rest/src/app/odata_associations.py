"""OData v2/v3 ``Association`` model and its projection onto v4 navigation — FMT-3.4 (#5429).

CSDL below v4 does not put a type on a navigation property. It declares a standalone
``<Association>`` naming two ``<End>`` roles, and every navigation property points at that
association plus the role it travels *to*::

    <Association Name="CustomerOrders">
      <End Role="Customer" Type="NS.Customer" Multiplicity="1"/>
      <End Role="Order"    Type="NS.Order"    Multiplicity="*"/>
    </Association>

    <NavigationProperty Name="Orders" Relationship="NS.CustomerOrders"
                        FromRole="Customer" ToRole="Order"/>

v4 writes the same fact directly on the property (``Type="Collection(NS.Order)"``,
``Partner="Customer"``). This module owns the half of that rewrite that is pure association
arithmetic — indexing the declarations, resolving the end a traversal lands on, and spelling
that end as a v4 type expression. The parser applies it, because rewriting a navigation
property means constructing one.

The declarations themselves are *not* discarded: the parser keeps them so the canonical
model's ``extras`` can carry the association, its referential constraints and its
association sets, none of which v4 has a place for.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Sequence, Tuple

__all__ = [
    "ODataAssociation",
    "ODataAssociationEnd",
    "ODataAssociationSet",
    "ODataAssociationSetEnd",
    "ODataReferentialConstraint",
    "ODataUnresolvedRelationshipError",
    "association_index",
    "navigation_type_expr",
    "resolve_target_end",
]

#: The ``Multiplicity`` value that makes an association end a collection.
_MANY = "*"


class ODataUnresolvedRelationshipError(LookupError):
    """A navigation property names an association or role that is not declared.

    Raised by :func:`resolve_target_end`. The parser turns it into an
    ``INPUT_REFERENCE_UNRESOLVED`` intake error: a relationship that resolves to nothing
    cannot be projected onto a canonical type reference, and inventing one would put a
    dangling type in the catalog.
    """


@dataclass(frozen=True)
class ODataAssociationEnd:
    """One end of an ``<Association>``: a role name, the entity type, its multiplicity."""

    role: str
    type_expr: str
    multiplicity: Optional[str] = None

    @property
    def is_collection(self) -> bool:
        """Whether travelling *to* this end yields many entities."""
        return (self.multiplicity or "").strip() == _MANY


@dataclass(frozen=True)
class ODataReferentialConstraint:
    """An association's ``<ReferentialConstraint>``: which properties tie the ends together.

    Attributes:
        principal_role: Role name of the ``<Principal>`` end.
        principal_properties: The principal's key properties, in declaration order.
        dependent_role: Role name of the ``<Dependent>`` end.
        dependent_properties: The dependent's foreign-key properties, in declaration order.
    """

    principal_role: str
    principal_properties: Tuple[str, ...]
    dependent_role: str
    dependent_properties: Tuple[str, ...]


@dataclass(frozen=True)
class ODataAssociation:
    """A declared relationship between two entity types."""

    name: str
    namespace: str
    ends: Tuple[ODataAssociationEnd, ...]
    referential_constraints: Tuple[ODataReferentialConstraint, ...] = ()
    annotations: Tuple[Tuple[str, str], ...] = ()

    @property
    def qualified_name(self) -> str:
        """``Namespace.Name`` — how a navigation property refers to this association."""
        return f"{self.namespace}.{self.name}"

    def end_for_role(self, role: Optional[str]) -> Optional[ODataAssociationEnd]:
        """The end named ``role``, or ``None`` when no end carries that role name."""
        if not role:
            return None
        return next((end for end in self.ends if end.role == role), None)


@dataclass(frozen=True)
class ODataAssociationSetEnd:
    """One end of an ``<AssociationSet>``: a role name bound to a container entity set."""

    role: str
    entity_set: str


@dataclass(frozen=True)
class ODataAssociationSet:
    """A container-level binding of an association onto two entity sets."""

    name: str
    association: str
    ends: Tuple[ODataAssociationSetEnd, ...]
    annotations: Tuple[Tuple[str, str], ...] = ()


def association_index(
    associations: Sequence[ODataAssociation],
) -> Dict[str, ODataAssociation]:
    """Index associations by every name a navigation property may use to reach one.

    A ``Relationship`` attribute is normally namespace-qualified, but SAP and older
    Dynamics services also emit the bare name when the association sits in the referring
    schema. Both spellings are indexed; a bare name is only registered when it is
    unambiguous across the document, so two same-named associations in different namespaces
    cannot silently resolve to whichever was parsed last.

    Args:
        associations: Every association declared anywhere in the document.

    Returns:
        Lookup name → association.
    """
    index: Dict[str, ODataAssociation] = {}
    bare_counts: Dict[str, int] = {}
    for association in associations:
        index[association.qualified_name] = association
        bare_counts[association.name] = bare_counts.get(association.name, 0) + 1
    for association in associations:
        if bare_counts[association.name] == 1:
            index.setdefault(association.name, association)
    return index


def resolve_target_end(
    association: ODataAssociation,
    *,
    from_role: Optional[str],
    to_role: Optional[str],
) -> ODataAssociationEnd:
    """The association end a navigation property travels *to*.

    Args:
        association: The resolved association.
        from_role: The property's ``FromRole``.
        to_role: The property's ``ToRole``.

    Returns:
        The target end.

    Raises:
        ODataUnresolvedRelationshipError: When ``to_role`` names no end and the target
            cannot be inferred. Inference applies only to a two-end association, where the
            target is unambiguously the end the traversal did not start from; SAP emits
            documents with a blank ``ToRole`` often enough to be worth recovering, but
            guessing on a wider association would invent a relationship.
    """
    end = association.end_for_role(to_role)
    if end is not None:
        return end
    if len(association.ends) == 2 and from_role:
        inferred = next((item for item in association.ends if item.role != from_role), None)
        if inferred is not None:
            return inferred
    raise ODataUnresolvedRelationshipError(
        f"association '{association.qualified_name}' declares no end for role {to_role!r}"
    )


def navigation_type_expr(end: ODataAssociationEnd) -> str:
    """Spell an association end the way a v4 ``NavigationProperty`` would spell its ``Type``.

    Args:
        end: The target end.

    Returns:
        The entity type, wrapped in ``Collection(...)`` when the end is a collection.
    """
    return f"Collection({end.type_expr})" if end.is_collection else end.type_expr
