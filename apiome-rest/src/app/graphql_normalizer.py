"""GraphQL → canonical model normalizer — MFI-10.2 (#3771).

Maps a built ``graphql-core`` :class:`~graphql.GraphQLSchema` (the live object the
MFI-10.1 parser produces via
:func:`app.graphql_parser.build_schema_from_sources` / :func:`~app.graphql_parser.build_graphql_schema`)
into a :class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.GRAPH`. Unlike the AsyncAPI/OpenAPI
normalizers (which consume a parsed ``dict``), this one consumes the *typed schema
object* so it never re-parses SDL and reads nullability/list wrappers, arguments and
applied directives straight off the type system.

Everything is keyed by **GraphQL Schema Coordinate** (``User``, ``User.email``,
``Query.user``, ``Query.user#arg.id``) so a diff lines two versions up by identity:

* **named types → :class:`~app.canonical_model.Type`** keyed by type name —
  object/interface/input-object → :attr:`~app.canonical_model.TypeKind.RECORD`,
  union → :attr:`~app.canonical_model.TypeKind.UNION` (member type keys), enum →
  :attr:`~app.canonical_model.TypeKind.ENUM` (values, preserving deprecation), and
  custom scalar → :attr:`~app.canonical_model.TypeKind.SCALAR`. The GraphQL type
  family (``object``/``interface``/``input``/``scalar``), implemented interfaces,
  and a scalar's ``@specifiedBy`` URL are kept in ``extras`` so the RECORD/UNION/…
  collapse stays lossless. Built-in scalars (``Int``/``Float``/``String``/
  ``Boolean``/``ID``) and introspection types (``__*``) are excluded, exactly as
  the parser excludes them from its ``type_names``.
* **fields → :class:`~app.canonical_model.CanonicalField`** keyed ``Type.field``;
  the field type becomes a :class:`~app.canonical_model.TypeRef` that preserves
  every ``!`` (non-null → ``nullable=False``) and ``[...]`` (list → ``item``)
  wrapper level-by-level, which is the acceptance criterion. A field's own
  arguments (GraphQL allows them on any field, not just roots) are kept in the
  field's ``extras``.
* **root-type fields → :class:`~app.canonical_model.Operation`** under a
  :class:`~app.canonical_model.Service` per root type (``Query``/``Mutation``/
  ``Subscription``, honouring ``schema { query: … }`` renames): kind
  ``QUERY``/``MUTATION``/``SUBSCRIPTION`` (subscriptions are server-streaming), the
  field arguments become :class:`~app.canonical_model.Parameter`\\s
  (``Query.user#arg.id``), and the field return type becomes the operation's lone
  response :class:`~app.canonical_model.Message` (``Query.user#response``). A root
  operation type is therefore surfaced *as a service*, not duplicated into
  ``types``.
* **directives** — custom directive *definitions* (built-ins ``@skip``/``@include``/
  ``@deprecated``/``@specifiedBy``/``@oneOf`` excluded) are captured on the
  artifact's ``extras``; *applied* directives on a type/field/value are captured in
  that entity's ``extras`` (``@deprecated`` is consumed into the canonical
  ``deprecated`` flag + reason instead, so it is not double-counted).

Because ``extras`` is carried verbatim into the fingerprint payload (see
:mod:`app.fingerprint`) while ``raw``/descriptions are stripped, arguments and
directives stowed in ``extras`` — and every wrapper on a ``TypeRef`` — all
contribute to the stable semantic fingerprint, so a nullability/list/argument/
directive change flips it while a doc-only edit does not.

The normalizer is **pure** (no I/O) and finishes with
:func:`app.normalizer.normalize_ordering`, so output is byte-stable regardless of
the schema's declaration order. It self-registers under the ``graphql`` format key
(the one :mod:`app.format_detection` emits).
"""

from __future__ import annotations

from typing import Any, List, Optional

from graphql import (
    GraphQLArgument,
    GraphQLEnumType,
    GraphQLField,
    GraphQLInputField,
    GraphQLInputObjectType,
    GraphQLInterfaceType,
    GraphQLList,
    GraphQLNamedType,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLSchema,
    GraphQLUnionType,
    Undefined,
    is_introspection_type,
    is_specified_directive,
    is_specified_scalar_type,
    print_ast,
)

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    EnumValue,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from .graphql_federation import (
    FederationInfo,
    federation_info_of,
    print_schema_with_directives,
)
from .normalizer import Keys, Normalizer, normalize_ordering

__all__ = ["GraphQlNormalizer"]


# The GraphQL format key this normalizer registers under and stamps onto the
# canonical model — the same key :mod:`app.format_detection` emits for SDL.
_FORMAT_KEY = "graphql"

# GraphQL's three root operation slots → the canonical operation kind a field of
# that root resolves to, plus whether it streams. Queries/mutations are a single
# request/response; a subscription pushes a stream of results (server-streaming).
_ROOT_OPERATION_KINDS: dict[str, OperationKind] = {
    "query": OperationKind.QUERY,
    "mutation": OperationKind.MUTATION,
    "subscription": OperationKind.SUBSCRIPTION,
}

# Built-in directives whose effect is captured by a first-class canonical signal
# rather than as an opaque applied-directive string: ``@deprecated`` becomes the
# ``deprecated`` flag (+ reason in ``extras``) and ``@specifiedBy`` becomes a
# scalar's ``specified_by_url``. Echoing them into an entity's applied-directive
# list would double-count them in the fingerprint, so they are filtered out there.
# (``@skip``/``@include`` are executable-only and never appear on a type-system
# location; ``@oneOf`` carries input-union semantics with no other home, so it is
# *kept* in the applied-directive list.)
_REDUNDANT_APPLIED_DIRECTIVES = frozenset({"deprecated", "specifiedBy"})


class GraphQlNormalizer(Normalizer, register=True):
    """Normalize a built ``graphql-core`` schema into a :class:`CanonicalApi`.

    Self-registers under the ``graphql`` format key. Consumes the live
    :class:`~graphql.GraphQLSchema` (not re-parsed SDL) so list/non-null wrappers,
    field arguments, and applied directives are read straight off the type system
    and mapped to GraphQL Schema Coordinates.
    """

    format = _FORMAT_KEY
    paradigm = ApiParadigm.GRAPH

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a built GraphQL schema into the canonical GRAPH model.

        Args:
            source: A built :class:`graphql.GraphQLSchema` — what
                :func:`app.graphql_parser.build_schema_from_sources` returns. SDL
                parsing/merging/validation happen *before* this call; the
                normalizer only walks the typed schema.
            include_raw: When ``True`` (default) the schema's canonical SDL is
                preserved on :attr:`CanonicalApi.raw` (under ``sdl``) for
                full-fidelity round-tripping; pass ``False`` to omit it.

        Returns:
            The order-normalized :class:`CanonicalApi` with ``format`` ``graphql``
            and ``paradigm`` :attr:`~app.canonical_model.ApiParadigm.GRAPH`.

        Raises:
            ValueError: If ``source`` is not a :class:`graphql.GraphQLSchema`.
        """
        if not isinstance(source, GraphQLSchema):
            raise ValueError(
                "GraphQL source must be a built graphql.GraphQLSchema "
                "(see app.graphql_parser.build_schema_from_sources)"
            )

        # The root operation type names become services; their fields become the
        # service's operations and are *not* re-emitted as plain ``types``.
        root_type_names = self._root_type_names(source)

        types = self._types(source, root_type_names)
        services = self._services(source)

        directive_definitions = self._directive_definitions(source)
        extras: dict[str, Any] = (
            {"directive_definitions": directive_definitions}
            if directive_definitions
            else {}
        )

        # Schema-level applied directives (``schema @link(...) { … }``) — the
        # supergraph/subgraph @link machinery lives here (IXH-7.6).
        schema_directives = _schema_applied_directives(source)
        if schema_directives:
            extras["directives"] = schema_directives

        # Federation ownership (IXH-7.6): the parser stashes a FederationInfo on
        # the built schema (supergraph join-spec ownership, or per-file ownership
        # for a subgraph set); record the roster on the artifact and the owning
        # subgraph names on every owned type/field/service/operation.
        federation = federation_info_of(source)
        if federation is not None:
            extras["federation"] = federation.extras_payload()
            _stamp_subgraph_ownership(types, services, federation)

        raw: Optional[dict[str, Any]] = None
        if include_raw:
            # The stored SDL keeps applied directives (@key / @join__type / …)
            # rather than the bare print_schema form, which drops them.
            raw = {"sdl": print_schema_with_directives(source)}
            if federation is not None and federation.subgraph_sdls:
                raw["subgraphs"] = dict(federation.subgraph_sdls)
            if federation is not None and federation.composition_findings:
                raw["composition"] = [
                    finding.model_dump(exclude_none=True)
                    for finding in federation.composition_findings
                ]

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=_FORMAT_KEY,
            protocol="graphql",
            identity=ApiIdentity(name="GraphQL Schema"),
            description=source.description,
            services=services,
            types=types,
            raw=raw,
            extras=extras,
        )
        return normalize_ordering(api)

    # --- root operation types ----------------------------------------------

    @staticmethod
    def _root_type_names(schema: GraphQLSchema) -> dict[str, str]:
        """Map each present root operation slot to its (possibly renamed) type name.

        Honours ``schema { query: MyQueryRoot }`` renames; a slot the schema does
        not declare is simply absent from the returned mapping.
        """
        roots: dict[str, str] = {}
        if schema.query_type is not None:
            roots["query"] = schema.query_type.name
        if schema.mutation_type is not None:
            roots["mutation"] = schema.mutation_type.name
        if schema.subscription_type is not None:
            roots["subscription"] = schema.subscription_type.name
        return roots

    # --- named types --------------------------------------------------------

    def _types(
        self, schema: GraphQLSchema, root_type_names: dict[str, str]
    ) -> List[Type]:
        """Coerce every user-defined named type into a canonical :class:`Type`.

        Built-in scalars, introspection types (``__*``) and the root operation
        types (surfaced as services) are excluded.
        """
        root_names = set(root_type_names.values())
        types: List[Type] = []
        for name, type_ in schema.type_map.items():
            if name.startswith("__"):
                continue
            if is_introspection_type(type_) or is_specified_scalar_type(type_):
                continue
            if name in root_names:
                continue
            mapped = self._named_type(type_)
            if mapped is not None:
                types.append(mapped)
        return types

    def _named_type(self, type_: GraphQLNamedType) -> Optional[Type]:
        """Dispatch one named GraphQL type to its canonical :class:`Type`.

        Returns ``None`` for a type family this normalizer does not model (none in
        practice — every SDL-expressible named type is handled).
        """
        if isinstance(type_, GraphQLObjectType):
            return self._record_type(type_, graphql_kind="object")
        if isinstance(type_, GraphQLInterfaceType):
            return self._record_type(type_, graphql_kind="interface")
        if isinstance(type_, GraphQLInputObjectType):
            return self._input_type(type_)
        if isinstance(type_, GraphQLEnumType):
            return self._enum_type(type_)
        if isinstance(type_, GraphQLUnionType):
            return self._union_type(type_)
        if isinstance(type_, GraphQLScalarType):
            return self._scalar_type(type_)
        return None

    def _record_type(
        self, type_: GraphQLObjectType | GraphQLInterfaceType, *, graphql_kind: str
    ) -> Type:
        """Coerce an object/interface type into a RECORD with its output fields.

        The GraphQL family (``object``/``interface``) and the interfaces it
        implements are kept in ``extras`` so the RECORD collapse round-trips.
        """
        key = Keys.type(type_.name)
        extras: dict[str, Any] = {"graphql_type": graphql_kind}
        interfaces = [iface.name for iface in type_.interfaces]
        if interfaces:
            extras["interfaces"] = interfaces
        extras.update(_applied_directives(type_))
        return Type(
            key=key,
            name=type_.name,
            kind=TypeKind.RECORD,
            description=type_.description,
            fields=[
                self._output_field(key, field_name, field)
                for field_name, field in type_.fields.items()
            ],
            extras=extras,
        )

    def _input_type(self, type_: GraphQLInputObjectType) -> Type:
        """Coerce an input-object type into a RECORD of its input fields."""
        key = Keys.type(type_.name)
        extras: dict[str, Any] = {"graphql_type": "input"}
        extras.update(_applied_directives(type_))
        return Type(
            key=key,
            name=type_.name,
            kind=TypeKind.RECORD,
            description=type_.description,
            fields=[
                self._input_field(key, field_name, field)
                for field_name, field in type_.fields.items()
            ],
            extras=extras,
        )

    def _enum_type(self, type_: GraphQLEnumType) -> Type:
        """Coerce an enum type into an ENUM, preserving value deprecation."""
        key = Keys.type(type_.name)
        extras: dict[str, Any] = {"graphql_type": "enum"}
        extras.update(_applied_directives(type_))
        values: List[EnumValue] = []
        for value_name, value in type_.values.items():
            value_extras = _applied_directives(value)
            if value.deprecation_reason is not None:
                value_extras["deprecation_reason"] = value.deprecation_reason
            values.append(
                EnumValue(
                    key=Keys.enum_value(key, value_name),
                    name=value_name,
                    description=value.description,
                    deprecated=value.deprecation_reason is not None,
                    extras=value_extras,
                )
            )
        return Type(
            key=key,
            name=type_.name,
            kind=TypeKind.ENUM,
            description=type_.description,
            enum_values=values,
            extras=extras,
        )

    def _union_type(self, type_: GraphQLUnionType) -> Type:
        """Coerce a union type into a UNION of its member type keys."""
        key = Keys.type(type_.name)
        extras: dict[str, Any] = {"graphql_type": "union"}
        extras.update(_applied_directives(type_))
        return Type(
            key=key,
            name=type_.name,
            kind=TypeKind.UNION,
            description=type_.description,
            union_members=[member.name for member in type_.types],
            extras=extras,
        )

    def _scalar_type(self, type_: GraphQLScalarType) -> Type:
        """Coerce a custom scalar into a SCALAR, keeping its ``@specifiedBy`` URL."""
        key = Keys.type(type_.name)
        extras: dict[str, Any] = {"graphql_type": "scalar"}
        specified_by = type_.specified_by_url
        if specified_by is not None:
            extras["specified_by_url"] = specified_by
        extras.update(_applied_directives(type_))
        return Type(
            key=key,
            name=type_.name,
            kind=TypeKind.SCALAR,
            description=type_.description,
            extras=extras,
        )

    # --- fields -------------------------------------------------------------

    def _output_field(
        self, type_key: str, name: str, field: GraphQLField
    ) -> CanonicalField:
        """Coerce one object/interface output field into a :class:`CanonicalField`.

        A field's own arguments (GraphQL permits them on any field) are kept in
        ``extras``; a non-root field is not an operation, so its args have nowhere
        else to live on the canonical field.
        """
        extras: dict[str, Any] = {}
        if field.args:
            extras["arguments"] = [
                _argument_descriptor(arg_name, arg)
                for arg_name, arg in field.args.items()
            ]
        if field.deprecation_reason is not None:
            extras["deprecation_reason"] = field.deprecation_reason
        extras.update(_applied_directives(field))
        return CanonicalField(
            key=Keys.field(type_key, name),
            name=name,
            type=_type_ref(field.type),
            description=field.description,
            deprecated=field.deprecation_reason is not None,
            extras=extras,
        )

    def _input_field(
        self, type_key: str, name: str, field: GraphQLInputField
    ) -> CanonicalField:
        """Coerce one input-object field into a :class:`CanonicalField`.

        An input field carries a default value (when declared) but never
        arguments; its nullability/list wrappers live on the ``TypeRef``.
        """
        extras: dict[str, Any] = {}
        if field.deprecation_reason is not None:
            extras["deprecation_reason"] = field.deprecation_reason
        extras.update(_applied_directives(field))
        return CanonicalField(
            key=Keys.field(type_key, name),
            name=name,
            type=_type_ref(field.type),
            default=_default_value(field.default_value),
            description=field.description,
            deprecated=field.deprecation_reason is not None,
            extras=extras,
        )

    # --- services / operations ---------------------------------------------

    def _services(self, schema: GraphQLSchema) -> List[Service]:
        """Build one :class:`Service` per present root operation type.

        Each root type's fields become the service's operations; a schema with no
        mutations/subscriptions simply yields fewer services.
        """
        services: List[Service] = []
        for slot, root_type in (
            ("query", schema.query_type),
            ("mutation", schema.mutation_type),
            ("subscription", schema.subscription_type),
        ):
            if root_type is None:
                continue
            services.append(
                Service(
                    key=root_type.name,
                    name=root_type.name,
                    description=root_type.description,
                    operations=[
                        self._operation(slot, root_type.name, field_name, field)
                        for field_name, field in root_type.fields.items()
                    ],
                    # A root operation type can carry applied directives too
                    # (e.g. a supergraph's @join__type); the type is surfaced as
                    # a service, so they live on the service's extras.
                    extras=_applied_directives(root_type),
                )
            )
        return services

    def _operation(
        self, slot: str, root_name: str, field_name: str, field: GraphQLField
    ) -> Operation:
        """Coerce one root-type field into a canonical :class:`Operation`.

        The operation kind/streaming follow the root slot; arguments become
        :class:`Parameter`\\s and the return type becomes the lone response
        :class:`Message`, all keyed off the ``Root.field`` coordinate.
        """
        op_key = Keys.operation_graphql(root_name, field_name)
        kind = _ROOT_OPERATION_KINDS[slot]
        streaming = (
            StreamingMode.SERVER
            if kind is OperationKind.SUBSCRIPTION
            else StreamingMode.NONE
        )

        extras: dict[str, Any] = {}
        if field.deprecation_reason is not None:
            extras["deprecation_reason"] = field.deprecation_reason
        extras.update(_applied_directives(field))

        return Operation(
            key=op_key,
            name=field_name,
            kind=kind,
            streaming=streaming,
            description=field.description,
            deprecated=field.deprecation_reason is not None,
            parameters=[
                self._parameter(op_key, arg_name, arg)
                for arg_name, arg in field.args.items()
            ],
            messages=[
                Message(
                    key=Keys.graphql_response(op_key),
                    role=MessageRole.RESPONSE,
                    payload=_type_ref(field.type),
                )
            ],
            extras=extras,
        )

    def _parameter(
        self, op_key: str, name: str, arg: GraphQLArgument
    ) -> Parameter:
        """Coerce one root-field argument into a canonical :class:`Parameter`.

        GraphQL arguments have no HTTP location; the closest canonical fit is
        :attr:`~app.canonical_model.ParameterLocation.QUERY` (an argument
        parameterises the query), with the GraphQL nature recorded by the
        ``#arg.`` key segment. An argument is *required* when its type is non-null
        **and** it declares no default.
        """
        extras: dict[str, Any] = _applied_directives(arg)
        if arg.deprecation_reason is not None:
            extras["deprecation_reason"] = arg.deprecation_reason
        type_ref = _type_ref(arg.type)
        has_default = arg.default_value is not Undefined
        return Parameter(
            key=Keys.graphql_argument(op_key, name),
            name=name,
            location=ParameterLocation.QUERY,
            type=type_ref,
            required=not type_ref.nullable and not has_default,
            default=_default_value(arg.default_value),
            description=arg.description,
            deprecated=arg.deprecation_reason is not None,
            extras=extras,
        )

    # --- directives ---------------------------------------------------------

    @staticmethod
    def _directive_definitions(schema: GraphQLSchema) -> List[dict[str, Any]]:
        """Capture the schema's *custom* directive definitions, in name order.

        The five built-in directives (``@skip``/``@include``/``@deprecated``/
        ``@specifiedBy``/``@oneOf``) are excluded — they are part of every schema
        and carry no per-artifact identity. Each custom directive is captured as
        its printed SDL plus its locations/repeatability for a structured diff.
        """
        definitions: List[dict[str, Any]] = []
        for directive in schema.directives:
            if is_specified_directive(directive):
                continue
            definitions.append(
                {
                    "name": directive.name,
                    "locations": sorted(loc.name for loc in directive.locations),
                    "repeatable": directive.is_repeatable,
                    "arguments": [
                        _argument_descriptor(arg_name, arg)
                        for arg_name, arg in directive.args.items()
                    ],
                }
            )
        definitions.sort(key=lambda d: d["name"])
        return definitions


# ===========================================================================
# Module-level helpers (pure)
# ===========================================================================


def _type_ref(gql_type: Any) -> TypeRef:
    """Convert a ``graphql-core`` type into a canonical :class:`TypeRef`.

    Walks the ``GraphQLNonNull`` / ``GraphQLList`` wrappers outermost-first,
    recording nullability and list nesting *per level* so the GraphQL wrapper is
    reproduced exactly (this is the MFI-10.2 acceptance criterion):

    * ``String``    → ``TypeRef(name="String")``
    * ``String!``   → ``TypeRef(name="String", nullable=False)``
    * ``[String!]`` → ``TypeRef(item=TypeRef(name="String", nullable=False))``
    * ``[String!]!``→ ``TypeRef(item=TypeRef(name="String", nullable=False),
      nullable=False)``

    A bare named type (object/scalar/enum/…) is nullable; wrapping it in
    ``GraphQLNonNull`` makes *that* level ``nullable=False``.

    Args:
        gql_type: A ``graphql-core`` output/input type (possibly wrapped).

    Returns:
        The canonical :class:`TypeRef` mirroring the wrappers level-by-level.
    """
    nullable = True
    inner = gql_type
    if isinstance(inner, GraphQLNonNull):
        nullable = False
        inner = inner.of_type
    if isinstance(inner, GraphQLList):
        return TypeRef(item=_type_ref(inner.of_type), nullable=nullable)
    return TypeRef(name=inner.name, nullable=nullable)


def _argument_descriptor(name: str, arg: GraphQLArgument) -> dict[str, Any]:
    """Describe one argument as a fidelity record for an ``extras`` bag.

    Used for arguments that have no first-class canonical home — a non-root
    field's arguments and a directive definition's arguments. Captures the name,
    the wrapper-preserving canonical type, and the declared default (omitted when
    none) so the descriptor still flips the fingerprint on a type/default change.

    Args:
        name: The argument's source name.
        arg: The ``graphql-core`` argument.

    Returns:
        A JSON-serializable descriptor ``{"name", "type", ["default"]}`` where
        ``type`` is the dumped :class:`TypeRef`.
    """
    descriptor: dict[str, Any] = {
        "name": name,
        "type": _type_ref(arg.type).model_dump(),
    }
    if arg.default_value is not Undefined:
        descriptor["default"] = _default_value(arg.default_value)
    return descriptor


def _applied_directives(node: Any) -> dict[str, Any]:
    """Return ``{"directives": [...]}`` for a node's *applied* directives, or ``{}``.

    Reads the directives applied at a use site off the node's ``ast_node`` and
    renders each to its SDL form (``@auth(role: "admin")``), preserving source
    order. Directives captured by a first-class canonical signal
    (:data:`_REDUNDANT_APPLIED_DIRECTIVES` — ``@deprecated``/``@specifiedBy``) are
    omitted so they are not double-counted in the fingerprint. A node with no
    ``ast_node`` or no applied directives yields an empty mapping, keeping
    ``extras`` clean.

    Args:
        node: A ``graphql-core`` type/field/value/argument with an ``ast_node``.

    Returns:
        ``{"directives": ["@auth(role: \\"admin\\")", …]}`` or ``{}``.
    """
    ast_node = getattr(node, "ast_node", None)
    if ast_node is None:
        # graphql-core always sets ast_node on SDL-parsed nodes; this guard
        # covers schema-construction paths (e.g. programmatic schema builders)
        # that do not retain the AST subtree.
        return {}
    applied = [
        print_ast(directive)
        for directive in getattr(ast_node, "directives", ()) or ()
        if directive.name.value not in _REDUNDANT_APPLIED_DIRECTIVES
    ]
    return {"directives": applied} if applied else {}


def _schema_applied_directives(schema: GraphQLSchema) -> List[str]:
    """Printed schema-level applied directives (``@link(url: "…")``), in source order.

    Read off the schema definition node and every ``extend schema`` node, so a
    subgraph's ``extend schema @link(...)`` and a supergraph's ``schema @link(...)``
    both land in the artifact's ``extras["directives"]``. Directives consumed
    into first-class canonical signals are filtered exactly as
    :func:`_applied_directives` does.
    """
    rendered: List[str] = []
    nodes = [schema.ast_node, *(schema.extension_ast_nodes or ())]
    for node in nodes:
        if node is None:
            continue
        for directive in getattr(node, "directives", ()) or ():
            if directive.name.value in _REDUNDANT_APPLIED_DIRECTIVES:
                continue
            rendered.append(print_ast(directive))
    return rendered


def _stamp_subgraph_ownership(
    types: List[Type], services: List[Service], federation: FederationInfo
) -> None:
    """Record owning-subgraph names on every owned entity's ``extras`` (in place).

    Keys line up with the federation ownership maps by construction: a GraphQL
    canonical type key is the bare type name, a field key is ``Type.field``,
    a service key is the root type name, and an operation key is the
    ``Root.field`` schema coordinate. Entities the federation info does not
    cover (e.g. join/link machinery types) are left untouched — no empty keys.
    """
    for type_ in types:
        owners = federation.type_owners.get(type_.key)
        if owners:
            type_.extras["subgraphs"] = list(owners)
        for field in type_.fields:
            field_owners = federation.field_owners.get(field.key)
            if field_owners:
                field.extras["subgraphs"] = list(field_owners)
    for service in services:
        owners = federation.type_owners.get(service.key)
        if owners:
            service.extras["subgraphs"] = list(owners)
        for operation in service.operations:
            field_owners = federation.field_owners.get(operation.key)
            if field_owners:
                operation.extras["subgraphs"] = list(field_owners)


def _default_value(value: Any) -> Any:
    """Normalize a ``graphql-core`` default into a JSON-serializable literal.

    ``graphql-core`` uses the ``Undefined`` sentinel for "no default declared";
    this maps that to ``None`` so the canonical ``default`` field stays clean
    (an *explicit* ``null`` default also arrives as ``None``, which is the right
    canonical representation either way).

    Args:
        value: An argument/input-field default value, or ``Undefined``.

    Returns:
        The value, or ``None`` when undefined.
    """
    return None if value is Undefined else value
