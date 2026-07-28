"""Project a canonical named type into a draft 2020-12 JSON Schema — IXH-5.1 (#5113).

The instance-validation service (:mod:`app.schema_instance_service`) answers "does this
payload satisfy this schema?" for schemas addressed by **project version** or **catalog
revision**. Those coordinates do not name a JSON Schema document — they name a
:class:`~app.canonical_model.CanonicalApi` rebuilt from the revision's captured source. This
module is the bridge: one canonical :class:`~app.canonical_model.Type` becomes one
self-contained JSON Schema document whose ``$defs`` hold exactly the other types it reaches.

Why not reuse :class:`app.jsonschema_emitter.JsonSchemaEmitter`? The emitter's job is
*round-trip fidelity* — it re-emits the imported raw document when one was captured, and its
canonical rebuild writes the canonical scalar name straight into ``type`` (``{"type": "i32"}``),
which is a **valid emitted artifact but not a valid validator input**: draft 2020-12 only knows
the seven JSON types, so ``"i32"`` makes the whole schema unusable. Validation needs the
opposite trade: never emit a keyword a validator cannot honor, and say out loud (via
:attr:`CanonicalSchemaProjection.unmapped_scalars`) where a source scalar had no JSON analogue
and therefore constrains nothing.

Guarantees this module makes, because the API contract depends on them:

* **Deterministic.** Pure function of the model — no clock, no I/O, no randomness. ``$defs``
  keys are sorted, ``required`` follows field declaration order, and repeated calls on an equal
  model produce an equal document.
* **Cycle-safe and bounded.** Type reachability is walked with an explicit stack and a seen-set,
  so a self-referential type (``Node.children: [Node]``) terminates, and no more than
  :data:`MAX_PROJECTED_DEFS` types are pulled into one document.
* **Honest.** A canonical scalar with no JSON Schema analogue projects to ``{}`` (constrains
  nothing) and is named in ``unmapped_scalars``, rather than to a keyword that would make every
  instance fail.

**How nullability is projected.** :attr:`~app.canonical_model.TypeRef.nullable` documents itself
as "whether this level may be null **or absent**", defaults to ``True``, and is only ever set
to ``False`` deliberately (GraphQL's ``!``, an OpenAPI ``required`` entry, a protobuf ``required``
label). The model therefore conflates optionality with null-acceptance, and only one reading is
safe to project: ``nullable=False`` puts the member in ``required``, and ``nullable=True`` leaves
it out. The alternative — reading the permissive *default* as "``null`` is an accepted value" —
would widen every scalar to ``["string", "null"]`` across the whole adapter fleet, which erases
the type constraint that makes validation worth running. A source that genuinely accepts ``null``
says so through its own constraints, and those are projected verbatim.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from .canonical_model import (
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
from .schema_validation import DRAFT_2020_12, DRAFT_2020_12_META_URI

__all__ = [
    "CANONICAL_SCALAR_SCHEMAS",
    "MAX_PROJECTED_DEFS",
    "CanonicalSchemaProjection",
    "CanonicalTypeNotFoundError",
    "build_ref_json_schema",
    "build_type_json_schema",
    "list_projectable_types",
]

#: Ceiling on how many named types one projection pulls into ``$defs``. A canonical model can
#: hold thousands of types; a validation document that reached all of them would be megabytes
#: for a two-field root. Reachability from the requested type keeps real documents far below
#: this, so the cap is a runaway backstop rather than a routine truncation.
MAX_PROJECTED_DEFS = 500

#: Canonical scalar name (lower-cased) → the JSON Schema fragment that constrains it.
#:
#: Keys are the scalar spellings the normalizers actually emit across the adapter fleet
#: (``string``/``String``, ``i32``/``int32``, ``bool``/``boolean``, …). ``format`` values are
#: draft 2020-12 *annotations*: they document intent for a reader and are not asserted by the
#: validator unless a format checker is installed, so adding one can never turn a valid instance
#: invalid. A name absent from this map projects to ``{}`` — see the module docstring.
CANONICAL_SCALAR_SCHEMAS: Dict[str, Dict[str, Any]] = {
    # text
    "string": {"type": "string"},
    "str": {"type": "string"},
    "text": {"type": "string"},
    "char": {"type": "string"},
    "id": {"type": "string"},
    # text with a semantic shape
    "uuid": {"type": "string", "format": "uuid"},
    "guid": {"type": "string", "format": "uuid"},
    "uri": {"type": "string", "format": "uri"},
    "url": {"type": "string", "format": "uri"},
    "email": {"type": "string", "format": "email"},
    "hostname": {"type": "string", "format": "hostname"},
    "ipv4": {"type": "string", "format": "ipv4"},
    "ipv6": {"type": "string", "format": "ipv6"},
    "date": {"type": "string", "format": "date"},
    "time": {"type": "string", "format": "time"},
    "datetime": {"type": "string", "format": "date-time"},
    "date-time": {"type": "string", "format": "date-time"},
    "timestamp": {"type": "string", "format": "date-time"},
    "instant": {"type": "string", "format": "date-time"},
    "duration": {"type": "string", "format": "duration"},
    # opaque binary — carried as base64 text on every JSON wire we emit
    "bytes": {"type": "string", "contentEncoding": "base64"},
    "binary": {"type": "string", "contentEncoding": "base64"},
    "blob": {"type": "string", "contentEncoding": "base64"},
    # integers
    "integer": {"type": "integer"},
    "int": {"type": "integer"},
    "byte": {"type": "integer"},
    "sbyte": {"type": "integer"},
    "i8": {"type": "integer"},
    "int8": {"type": "integer"},
    "uint8": {"type": "integer"},
    "short": {"type": "integer"},
    "i16": {"type": "integer"},
    "int16": {"type": "integer"},
    "uint16": {"type": "integer"},
    "i32": {"type": "integer", "format": "int32"},
    "int32": {"type": "integer", "format": "int32"},
    "uint32": {"type": "integer", "format": "int32"},
    "fixed32": {"type": "integer", "format": "int32"},
    "sfixed32": {"type": "integer", "format": "int32"},
    "sint32": {"type": "integer", "format": "int32"},
    "i64": {"type": "integer", "format": "int64"},
    "int64": {"type": "integer", "format": "int64"},
    "uint64": {"type": "integer", "format": "int64"},
    "fixed64": {"type": "integer", "format": "int64"},
    "sfixed64": {"type": "integer", "format": "int64"},
    "sint64": {"type": "integer", "format": "int64"},
    "long": {"type": "integer", "format": "int64"},
    "bigint": {"type": "integer"},
    # reals
    "number": {"type": "number"},
    "float": {"type": "number", "format": "float"},
    "f32": {"type": "number", "format": "float"},
    "double": {"type": "number", "format": "double"},
    "f64": {"type": "number", "format": "double"},
    "decimal": {"type": "number"},
    # booleans and the empty type
    "boolean": {"type": "boolean"},
    "bool": {"type": "boolean"},
    "null": {"type": "null"},
    "void": {"type": "null"},
    "none": {"type": "null"},
}

#: Characters permitted in a ``$defs`` key. Everything else collapses to ``_`` so a canonical
#: key like ``acme.pets.v1/Pet`` cannot inject a JSON Pointer separator into a ``$ref``.
_DEFS_KEY_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")

#: Canonical scalar names that mean "any JSON value" rather than a missing mapping — projecting
#: them to ``{}`` is exactly right, so they must not be reported as unmapped.
_ANY_SCALARS = frozenset({"any", "object", "json", "map", "value", "unknown", "variant"})


class CanonicalTypeNotFoundError(LookupError):
    """The requested type name does not resolve to exactly one type in the model.

    Attributes:
        type_name: The name the caller asked for.
        candidates: Every projectable type name in the model, sorted — so the caller can
            surface "did you mean" guidance instead of a bare miss.
        ambiguous: ``True`` when the name matched more than one type (a name collision across
            namespaces); ``False`` when it matched none.
    """

    def __init__(
        self, type_name: str, candidates: List[str], *, ambiguous: bool = False
    ) -> None:
        detail = (
            f"Type {type_name!r} is ambiguous in this model — address it by its fully "
            "qualified key."
            if ambiguous
            else f"Type {type_name!r} was not found in this model."
        )
        super().__init__(detail)
        self.type_name = type_name
        self.candidates = candidates
        self.ambiguous = ambiguous


@dataclass(frozen=True)
class CanonicalSchemaProjection:
    """One canonical type projected into a self-contained JSON Schema document.

    Attributes:
        document: The draft 2020-12 schema. Its root constrains the requested type; ``$defs``
            holds every other type reachable from it.
        type_key: The stable canonical key of the projected type (``acme.Pet``).
        type_name: The source name of the projected type (``Pet``).
        dialect: The JSON Schema dialect token the document is written in (always
            :data:`app.schema_validation.DRAFT_2020_12`).
        unmapped_scalars: Sorted canonical scalar names the projection could not constrain,
            each of which contributed a ``{}`` (accept-anything) subschema.
        truncated: ``True`` when reachability hit :data:`MAX_PROJECTED_DEFS` and some reachable
            types were left out — their ``$ref`` targets are absent and will be reported as
            unresolvable by the validator rather than silently ignored.
    """

    document: Dict[str, Any]
    type_key: str
    type_name: str
    dialect: str = DRAFT_2020_12
    unmapped_scalars: Tuple[str, ...] = ()
    truncated: bool = False


@dataclass
class _Walk:
    """Mutable bookkeeping shared by one projection walk."""

    types_by_key: Dict[str, Type]
    #: Canonical key → the sanitized, collision-free ``$defs`` key it is emitted under.
    defs_keys: Dict[str, str] = field(default_factory=dict)
    #: ``$defs`` keys already handed out, so two canonical keys cannot collide after sanitizing.
    used_defs_keys: Set[str] = field(default_factory=set)
    unmapped: Set[str] = field(default_factory=set)
    truncated: bool = False


def list_projectable_types(api: CanonicalApi) -> List[str]:
    """Return every addressable type name in a model, sorted and de-duplicated.

    Both the source name (``Pet``) and the stable key (``acme.Pet``) are addressable, so both
    appear. Used to build "not found" guidance and to advertise a revision's schemas.

    Args:
        api: The canonical model to inspect.

    Returns:
        The sorted, de-duplicated list of addressable names; empty when the model has no types.
    """
    names: Set[str] = set()
    for type_ in api.types:
        if type_.key:
            names.add(type_.key)
        if type_.name:
            names.add(type_.name)
    return sorted(names)


def build_type_json_schema(
    api: CanonicalApi, type_name: str, *, max_defs: int = MAX_PROJECTED_DEFS
) -> CanonicalSchemaProjection:
    """Project one named canonical type into a self-contained draft 2020-12 schema.

    Args:
        api: The canonical model the type lives in.
        type_name: The type to project, addressed by its stable key (``acme.Pet``) or its
            source name (``Pet``). A key match wins over a name match; a name that matches
            several types is rejected rather than resolved arbitrarily.
        max_defs: Ceiling on how many additional types are pulled into ``$defs``.

    Returns:
        The :class:`CanonicalSchemaProjection` — document plus the honesty metadata
        (``unmapped_scalars``, ``truncated``) the API surfaces as diagnostics.

    Raises:
        CanonicalTypeNotFoundError: When ``type_name`` matches no type, or matches more than one.
    """
    root = _lookup_type(api, type_name)
    walk = _Walk(types_by_key={t.key: t for t in api.types if t.key})

    root_schema = _type_to_schema(root, walk)

    return _finish_document(
        root_schema,
        walk,
        max_defs=max_defs,
        title=root.name or root.key,
        type_key=root.key,
        type_name=root.name or root.key,
    )


def build_ref_json_schema(
    api: CanonicalApi,
    ref: TypeRef,
    *,
    constraints: Optional[Constraints] = None,
    title: Optional[str] = None,
    max_defs: int = MAX_PROJECTED_DEFS,
) -> CanonicalSchemaProjection:
    """Project a *use-site* type reference into a self-contained draft 2020-12 schema.

    :func:`build_type_json_schema` projects a type the model **names**. A use site — an
    operation parameter, or a body declared as ``[Pet]`` rather than as ``Pet`` — is a
    :class:`~app.canonical_model.TypeRef` instead, and its list wrappers and its own constraints
    are part of the contract. The contract-suite compiler (ECA-1.1) needs exactly that: the
    schema a *value at this site* must satisfy, ``$defs`` and all.

    Args:
        api: The canonical model the reference resolves against.
        ref: The reference to project. A list wrapper becomes an ``array`` schema; a name that
            resolves to a model type becomes a ``$ref`` into ``$defs``; anything else is read
            as a scalar (and reported in ``unmapped_scalars`` when it has no JSON analogue).
        constraints: Use-site validation facets (a parameter's ``enum``/``pattern``/bounds),
            applied on top of the projected reference.
        title: Optional ``title`` for the document; omitted when ``None``.
        max_defs: Ceiling on how many types are pulled into ``$defs``.

    Returns:
        The :class:`CanonicalSchemaProjection`. Unlike the named-type projection this never
        raises: a reference to a type the model does not define projects to the scalar
        vocabulary (or to ``{}``) and says so through ``unmapped_scalars``.
    """
    walk = _Walk(types_by_key={t.key: t for t in api.types if t.key})
    root_schema = _ref_to_schema(ref, walk)
    _apply_constraints(root_schema, constraints)

    leaf = ref
    while leaf.item is not None:
        leaf = leaf.item
    return _finish_document(
        root_schema,
        walk,
        max_defs=max_defs,
        title=title,
        type_key=leaf.name or "",
        type_name=leaf.name or "",
    )


def _finish_document(
    root_schema: Dict[str, Any],
    walk: _Walk,
    *,
    max_defs: int,
    title: Optional[str],
    type_key: str,
    type_name: str,
) -> CanonicalSchemaProjection:
    """Drain the reachable ``$defs`` set and wrap a root subschema into a standalone document.

    Args:
        root_schema: The projected root subschema; its ``$ref``s have already registered their
            targets on ``walk``.
        walk: The bookkeeping the projection walked with.
        max_defs: Ceiling on how many types are pulled into ``$defs``.
        title: ``title`` for the document, or ``None`` to omit it.
        type_key: Value for :attr:`CanonicalSchemaProjection.type_key`.
        type_name: Value for :attr:`CanonicalSchemaProjection.type_name`.

    Returns:
        The finished :class:`CanonicalSchemaProjection`.
    """
    # Breadth-first over the reachable set: every ``$ref`` emitted while projecting registers
    # its target in ``defs_keys``, so draining that mapping until it stops growing collects
    # exactly the transitive closure. The seen-set makes a type cycle terminate on its second
    # visit rather than recursing forever.
    defs: Dict[str, Dict[str, Any]] = {}
    expanded: Set[str] = set()
    while True:
        pending = [key for key in walk.defs_keys if key not in expanded]
        if not pending:
            break
        # Sorted so the *order* types are pulled in — and therefore which ones survive a
        # ``max_defs`` truncation — is a property of the model, not of dict insertion order.
        for key in sorted(pending):
            expanded.add(key)
            if len(defs) >= max_defs:
                walk.truncated = True
                continue
            target = walk.types_by_key.get(key)
            if target is None:
                # A ref to a type the model does not define. Left out deliberately: the
                # validator reports the dangling ``$ref`` rather than us inventing a schema.
                continue
            defs[walk.defs_keys[key]] = _type_to_schema(target, walk)

    document: Dict[str, Any] = {"$schema": DRAFT_2020_12_META_URI}
    if title:
        document["title"] = title
    document.update(root_schema)
    if defs:
        document["$defs"] = {key: defs[key] for key in sorted(defs)}

    return CanonicalSchemaProjection(
        document=document,
        type_key=type_key,
        type_name=type_name,
        unmapped_scalars=tuple(sorted(walk.unmapped)),
        truncated=walk.truncated,
    )


# ===========================================================================
# Lookup
# ===========================================================================


def _lookup_type(api: CanonicalApi, type_name: str) -> Type:
    """Resolve ``type_name`` to exactly one canonical type (key match beats name match)."""
    wanted = (type_name or "").strip()
    if not wanted:
        raise CanonicalTypeNotFoundError("", list_projectable_types(api))

    for type_ in api.types:
        if type_.key == wanted:
            return type_

    matches = [type_ for type_ in api.types if type_.name == wanted]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise CanonicalTypeNotFoundError(
            wanted, list_projectable_types(api), ambiguous=True
        )
    raise CanonicalTypeNotFoundError(wanted, list_projectable_types(api))


# ===========================================================================
# Type / field / ref projection
# ===========================================================================


def _type_to_schema(type_: Type, walk: _Walk) -> Dict[str, Any]:
    """Project one canonical type into a JSON Schema subschema (no ``$defs`` of its own)."""
    if type_.kind is TypeKind.RECORD:
        schema = _record_to_schema(type_, walk)
    elif type_.kind is TypeKind.ENUM:
        schema = _enum_to_schema(type_)
    elif type_.kind is TypeKind.UNION:
        members = [
            _ref_to_schema(TypeRef(name=member), walk) for member in type_.union_members
        ]
        schema = {"oneOf": members} if members else {}
    elif type_.kind is TypeKind.MAP:
        schema = {"type": "object"}
        if type_.value_type is not None:
            schema["additionalProperties"] = _ref_to_schema(type_.value_type, walk)
    elif type_.kind is TypeKind.ALIAS and type_.aliased is not None:
        schema = _ref_to_schema(type_.aliased, walk)
    else:
        # SCALAR (and an ALIAS with no target): the type's own name is the scalar vocabulary.
        schema = _scalar_to_schema(type_.name or type_.key, walk)

    _apply_constraints(schema, type_.constraints)
    if type_.description:
        schema.setdefault("description", type_.description)
    if type_.deprecated:
        schema["deprecated"] = True
    return schema


def _record_to_schema(type_: Type, walk: _Walk) -> Dict[str, Any]:
    """Project a RECORD type: properties in declaration order, ``required`` from nullability."""
    properties: Dict[str, Any] = {}
    required: List[str] = []
    for member in type_.fields:
        if not member.name:
            continue
        properties[member.name] = _field_to_schema(member, walk)
        # ``nullable=False`` is the canonical spelling of GraphQL's ``!`` / protobuf's
        # ``required`` / an OpenAPI ``required`` entry, and it is the *only* required signal
        # the canonical model carries.
        if member.type.nullable is False:
            required.append(member.name)
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _enum_to_schema(type_: Type) -> Dict[str, Any]:
    """Project an ENUM type into an ``enum`` over its wire values.

    A member's wire value (``EnumValue.value``) wins over its name when the source declares one
    — a protobuf enum on the wire is its number, not its identifier. Members are kept in
    declaration order so the schema reads like the source.
    """
    values: List[Any] = []
    for member in type_.enum_values:
        value = member.value if member.value is not None else member.name
        if value not in values:
            values.append(value)
    if not values:
        return {}
    # A homogeneous string enum also gets ``type``, which turns a wrong-typed instance into a
    # ``type`` finding rather than a bare ``enum`` miss — a more actionable message.
    schema: Dict[str, Any] = {"enum": values}
    if all(isinstance(value, str) for value in values):
        schema["type"] = "string"
    elif all(isinstance(value, bool) for value in values):
        schema["type"] = "boolean"
    elif all(isinstance(value, int) and not isinstance(value, bool) for value in values):
        schema["type"] = "integer"
    return schema


def _field_to_schema(member: CanonicalField, walk: _Walk) -> Dict[str, Any]:
    """Project one record member: its type reference plus its own constraints/annotations."""
    schema = _ref_to_schema(member.type, walk)
    _apply_constraints(schema, member.constraints)
    if member.default is not None:
        schema.setdefault("default", member.default)
    if member.description:
        schema.setdefault("description", member.description)
    if member.deprecated:
        schema["deprecated"] = True
    return schema


def _ref_to_schema(ref: TypeRef, walk: _Walk) -> Dict[str, Any]:
    """Project a type reference — list wrappers, named-type ``$ref``s, and scalars."""
    if ref.is_list():
        item = ref.item or TypeRef(name="string")
        return {"type": "array", "items": _ref_to_schema(item, walk)}

    name = ref.name or ""
    if name in walk.types_by_key:
        return {"$ref": f"#/$defs/{_defs_key_for(name, walk)}"}

    # A reference may name a type by its *source* name rather than its key. Resolve that only
    # when it is unambiguous; otherwise fall through to the scalar vocabulary.
    by_name = [key for key, type_ in walk.types_by_key.items() if type_.name == name]
    if len(by_name) == 1:
        return {"$ref": f"#/$defs/{_defs_key_for(by_name[0], walk)}"}

    # ``ref.nullable`` is deliberately *not* projected here — see the module docstring: it is
    # consumed by _record_to_schema as the ``required`` signal and nowhere else.
    return _scalar_to_schema(name, walk)


def _scalar_to_schema(name: str, walk: _Walk) -> Dict[str, Any]:
    """Map a canonical scalar name onto its JSON Schema fragment, recording misses."""
    key = (name or "").strip().lower()
    if not key:
        return {}
    mapped = CANONICAL_SCALAR_SCHEMAS.get(key)
    if mapped is not None:
        return dict(mapped)
    if key not in _ANY_SCALARS:
        walk.unmapped.add(name)
    return {}


def _defs_key_for(canonical_key: str, walk: _Walk) -> str:
    """Return (allocating on first use) the collision-free ``$defs`` key for a canonical key."""
    existing = walk.defs_keys.get(canonical_key)
    if existing is not None:
        return existing
    base = _DEFS_KEY_UNSAFE.sub("_", canonical_key).strip("_") or "Type"
    candidate = base
    suffix = 2
    while candidate in walk.used_defs_keys:
        candidate = f"{base}_{suffix}"
        suffix += 1
    walk.used_defs_keys.add(candidate)
    walk.defs_keys[canonical_key] = candidate
    return candidate


def _apply_constraints(schema: Dict[str, Any], constraints: Optional[Constraints]) -> None:
    """Copy canonical validation facets onto a subschema, in place.

    The canonical :class:`~app.canonical_model.Constraints` vocabulary is deliberately the
    JSON-Schema one, so this is a rename-only mapping. Existing keywords are never overwritten:
    a projection that already asserted ``enum`` from an ENUM type keeps it.
    """
    if constraints is None:
        return
    numeric: List[Tuple[str, Any]] = [
        ("minimum", constraints.minimum),
        ("maximum", constraints.maximum),
        ("exclusiveMinimum", constraints.exclusive_minimum),
        ("exclusiveMaximum", constraints.exclusive_maximum),
        ("multipleOf", constraints.multiple_of),
        ("minLength", constraints.min_length),
        ("maxLength", constraints.max_length),
        ("pattern", constraints.pattern),
        ("minItems", constraints.min_items),
        ("maxItems", constraints.max_items),
        ("uniqueItems", constraints.unique_items),
    ]
    for keyword, value in numeric:
        if value is not None:
            schema.setdefault(keyword, value)
    if constraints.enum:
        schema.setdefault("enum", list(constraints.enum))
    if constraints.format:
        schema.setdefault("format", constraints.format)
