"""GraphQL SDL parse + build-schema service — MFI-10.1 (#3770).

Unlike the AsyncAPI seam (MFI-8.1), which shells out to a Node parser, GraphQL has a
first-class Python library: **``graphql-core``** (the reference implementation, a port of
``graphql-js``). This module is the thin, pure-Python service over it that the GraphQL import
adapter is built on. It does three things in one call:

* **parse** — each SDL source is lexed/parsed into an AST. A syntax error is captured as a
  :class:`GraphQlDiagnostic` (with the offending source label and line/column) rather than
  raising.
* **merge** — multiple SDL files are merged with ``graphql-tools``-style semantics: a type
  declared across several files has its fields/values/members **unioned** into one definition,
  and ``extend type`` blocks are applied by the builder. So a schema split across files (the
  common "``Query`` in one file, ``User`` in another, ``extend type Query`` in a third"
  layout) builds into a single schema.
* **build + validate** — the merged AST is built into a ``GraphQLSchema`` and validated
  (``validate_sdl`` for document-level problems — unknown types, conflicting definitions — and
  ``validate_schema`` for schema-level ones — a missing ``Query`` root, an invalid interface
  implementation). The **root operation types** (``query`` / ``mutation`` / ``subscription``)
  are captured, and the schema is re-printed to **canonical SDL**.

A document that fails to build is **not** an exception: :func:`parse_graphql` (and the
multi-source :func:`parse_graphql_sources`) return a result with
:attr:`GraphQlParseResult.ok` ``False`` and the error diagnostics attached, so a caller can
surface them. Callers that prefer the raising style use
:meth:`GraphQlParseResult.raise_if_invalid`. The :class:`GraphQlParseError` exception is
reserved for callers (e.g. :func:`build_graphql_schema`) that ask for the built schema and
must get one or fail.

The downstream canonical-model mapping (MFI-10.2) consumes the live ``GraphQLSchema`` via
:func:`build_schema_from_sources` / :func:`build_graphql_schema` (no re-parse), while the
serializable :attr:`GraphQlParseResult.sdl` is the canonical artifact stored/round-tripped
like the AsyncAPI canonical document.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple, Union

from graphql import (
    GraphQLError,
    GraphQLSchema,
    build_ast_schema,
    is_introspection_type,
    is_specified_scalar_type,
    parse,
    print_ast,
    validate_schema,
)
from graphql.language.ast import DocumentNode, Node
from graphql.validation.validate import validate_sdl
from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "GraphQlSource",
    "GraphQlSourceLocation",
    "GraphQlDiagnostic",
    "GraphQlRootOperations",
    "GraphQlParseResult",
    "GraphQlParseError",
    "parse_graphql",
    "parse_graphql_sources",
    "build_graphql_schema",
    "build_schema_from_sources",
]


#: The AST node kinds whose same-named definitions we merge field-by-field (``graphql-tools``
#: ``mergeTypeDefs`` semantics). Each maps to the node attributes that hold mergeable child
#: nodes, keyed by name (or, for the schema definition, by operation). Extension nodes
#: (``*_extension``) are intentionally absent: the builder applies them to their base type.
_MERGEABLE_DEFINITION_FIELDS: Dict[str, Tuple[str, ...]] = {
    "object_type_definition": ("fields", "interfaces", "directives"),
    "interface_type_definition": ("fields", "interfaces", "directives"),
    "input_object_type_definition": ("fields", "directives"),
    "enum_type_definition": ("values", "directives"),
    "union_type_definition": ("types", "directives"),
    "scalar_type_definition": ("directives",),
}


# ===========================================================================
# Inputs
# ===========================================================================


class GraphQlSource(BaseModel):
    """One SDL source file fed to the parser.

    A ``label`` (filename/URL/logical name) is carried only so a diagnostic can point at the
    *file* a problem came from when several are merged; it has no semantic effect.
    """

    model_config = ConfigDict(frozen=True)

    label: str = Field(description="A human label for this source (filename/URL); used in diagnostics.")
    text: str = Field(description="The raw GraphQL SDL text of this source.")


#: What a caller may hand to :func:`parse_graphql_sources` for a single source: a bare SDL
#: string, a ``(label, text)`` pair, or a fully-formed :class:`GraphQlSource`.
SourceLike = Union[str, Tuple[str, str], GraphQlSource]


def _coerce_source(item: SourceLike, index: int) -> GraphQlSource:
    """Normalise a caller-supplied source into a :class:`GraphQlSource`.

    A bare string is labelled positionally (``source[0]``); a ``(label, text)`` pair keeps its
    label; an existing :class:`GraphQlSource` passes through.
    """
    if isinstance(item, GraphQlSource):
        return item
    if isinstance(item, tuple):
        label, text = item
        return GraphQlSource(label=str(label), text=str(text))
    return GraphQlSource(label=f"source[{index}]", text=str(item))


# ===========================================================================
# Result models
# ===========================================================================


class GraphQlSourceLocation(BaseModel):
    """A 1-based line/column position inside an SDL source, as ``graphql-core`` reports it."""

    model_config = ConfigDict(frozen=True)

    line: int = Field(description="1-based line number.")
    column: int = Field(description="1-based column number.")


class GraphQlDiagnostic(BaseModel):
    """One problem found while parsing/building the schema.

    ``graphql-core`` reports only errors (there is no warning tier), so :attr:`severity` is
    always ``error`` today; it is kept as a field for parity with the other format adapters and
    to leave room for advisory findings. Any error makes :attr:`GraphQlParseResult.ok` ``False``.
    """

    model_config = ConfigDict(frozen=True)

    severity: str = Field(default="error", description="Always ``error`` (graphql-core has no warning tier).")
    message: str = Field(description="Human-readable explanation of the problem.")
    source: Optional[str] = Field(
        default=None, description="Label of the source file the problem came from (when known)."
    )
    locations: List[GraphQlSourceLocation] = Field(
        default_factory=list, description="Line/column positions the error points at (may be empty)."
    )

    @property
    def is_error(self) -> bool:
        """Whether this finding is an error (renders the document invalid)."""
        return self.severity == "error"


class GraphQlRootOperations(BaseModel):
    """The root operation type names of a built schema.

    GraphQL lets a schema rename its roots (``schema { query: MyQueryRoot }``); these are the
    *type names* actually wired as roots, each ``None`` when the schema declares no such root.
    """

    model_config = ConfigDict(frozen=True)

    query: Optional[str] = Field(default=None, description="The ``query`` root type name, if any.")
    mutation: Optional[str] = Field(default=None, description="The ``mutation`` root type name, if any.")
    subscription: Optional[str] = Field(
        default=None, description="The ``subscription`` root type name, if any."
    )


class GraphQlParseResult(BaseModel):
    """The outcome of parsing + merging + building one or more GraphQL SDL sources.

    A *valid* schema has :attr:`ok` ``True``, a populated :attr:`sdl` (the canonical re-printed
    SDL), :attr:`root_operations`, and the user-defined :attr:`type_names`. An *invalid* one has
    :attr:`ok` ``False``, ``sdl`` ``None``, empty roots/type-names, and at least one error in
    :attr:`diagnostics`.
    """

    model_config = ConfigDict(frozen=True)

    ok: bool = Field(description="True when the SDL parsed, merged, built and validated with no errors.")
    sdl: Optional[str] = Field(
        default=None,
        description="Canonical re-printed SDL of the built schema; ``None`` when the schema is invalid.",
    )
    root_operations: GraphQlRootOperations = Field(
        default_factory=GraphQlRootOperations,
        description="The query/mutation/subscription root type names.",
    )
    type_names: List[str] = Field(
        default_factory=list,
        description="User-defined named types (built-in scalars and introspection types excluded), "
        "in schema order.",
    )
    diagnostics: List[GraphQlDiagnostic] = Field(
        default_factory=list, description="All findings, in discovery order."
    )

    @property
    def errors(self) -> List[GraphQlDiagnostic]:
        """The error-severity diagnostics (empty when the schema is valid)."""
        return [d for d in self.diagnostics if d.is_error]

    def raise_if_invalid(self) -> "GraphQlParseResult":
        """Return ``self`` when valid; raise :class:`GraphQlParseError` when not.

        Raises:
            GraphQlParseError: When :attr:`ok` is ``False``. The error carries the error
                diagnostics and its message is the first one.
        """
        if self.ok:
            return self
        errors = self.errors
        if errors:
            first = errors[0]
            detail = first.message
            # Append the source location so a caller (and the user surfacing the error) can find
            # the offending token; graphql-core reports it, but the bare message drops it — which
            # makes a syntax error like an unexpected description string hard to locate in a large
            # SDL document.
            if first.locations:
                loc = first.locations[0]
                detail = f"{detail} (at line {loc.line}, column {loc.column})"
        else:
            detail = "GraphQL schema failed to build"
        raise GraphQlParseError(detail, diagnostics=self.diagnostics)


class GraphQlParseError(Exception):
    """A GraphQL schema could not be built from the supplied SDL.

    Raised by the build-oriented helpers (:func:`build_graphql_schema`,
    :func:`build_schema_from_sources`) and via :meth:`GraphQlParseResult.raise_if_invalid`.
    Carries a human-readable message a route can surface, plus the diagnostics that explain it.
    """

    def __init__(self, message: str, *, diagnostics: Optional[List[GraphQlDiagnostic]] = None) -> None:
        super().__init__(message)
        self.diagnostics: List[GraphQlDiagnostic] = list(diagnostics or [])


# ===========================================================================
# Diagnostics helpers
# ===========================================================================


def _diagnostic_from_error(error: GraphQLError, *, source: Optional[str] = None) -> GraphQlDiagnostic:
    """Adapt a ``graphql-core`` :class:`GraphQLError` into a typed :class:`GraphQlDiagnostic`."""
    locations = [
        GraphQlSourceLocation(line=loc.line, column=loc.column) for loc in (error.locations or [])
    ]
    return GraphQlDiagnostic(message=error.message, source=source, locations=locations)


# ===========================================================================
# Multi-file merge (graphql-tools semantics)
# ===========================================================================


def _node_name(node: Node) -> Optional[str]:
    """The ``name.value`` of a named AST node (field, type, enum value), or ``None``."""
    name = getattr(node, "name", None)
    return getattr(name, "value", None)


def _merge_child_lists(
    primary: Node,
    addition: Node,
    attributes: Tuple[str, ...],
    *,
    type_name: str,
) -> List[GraphQlDiagnostic]:
    """Union ``addition``'s child nodes into ``primary`` for each named ``attribute``.

    Children are de-duplicated by name (or, for a schema definition's ``operation_types``, by
    operation). The first occurrence wins; a later field/input-field that redeclares a name with
    a *different* type is a real conflict and yields an error diagnostic (matching
    ``graphql-tools``, which refuses to silently pick one). ``primary``'s collection attributes
    are rewritten in place.
    """
    diagnostics: List[GraphQlDiagnostic] = []
    for attr in attributes:
        existing = list(getattr(primary, attr, ()) or ())
        seen: Dict[str, Node] = {}
        for child in existing:
            key = _child_key(child)
            if key is not None:
                seen[key] = child
        for child in getattr(addition, attr, ()) or ():
            key = _child_key(child)
            if key is None:
                existing.append(child)
                continue
            if key not in seen:
                seen[key] = child
                existing.append(child)
                continue
            conflict = _field_type_conflict(seen[key], child)
            if conflict is not None:
                prior, incoming = conflict
                diagnostics.append(
                    GraphQlDiagnostic(
                        message=(
                            f'Field "{type_name}.{key}" has conflicting types across sources '
                            f'("{prior}" vs "{incoming}"); keeping the first.'
                        )
                    )
                )
        setattr(primary, attr, tuple(existing))
    return diagnostics


def _child_key(child: Node) -> Optional[str]:
    """A de-duplication key for a merged child node.

    Named children (fields, enum values, member/interface type references, applied directives)
    key on their name; a schema definition's operation types key on the operation keyword.
    """
    operation = getattr(child, "operation", None)
    if operation is not None and child.kind == "operation_type_definition":
        return str(getattr(operation, "value", operation))
    return _node_name(child)


def _field_type_conflict(prior: Node, incoming: Node) -> Optional[Tuple[str, str]]:
    """Return ``(prior_type, incoming_type)`` when two same-named fields disagree on type, else ``None``.

    Only field/input-field nodes carry a ``type``; for everything else (enum values, directives,
    member types) a name match is treated as fully equivalent, so there is never a conflict.
    """
    prior_type = getattr(prior, "type", None)
    incoming_type = getattr(incoming, "type", None)
    if prior_type is None or incoming_type is None:
        return None
    prior_printed = print_ast(prior_type)
    incoming_printed = print_ast(incoming_type)
    if prior_printed == incoming_printed:
        return None
    return prior_printed, incoming_printed


def _merge_documents(
    parsed: Sequence[Tuple[str, DocumentNode]],
) -> Tuple[DocumentNode, List[GraphQlDiagnostic]]:
    """Merge several parsed SDL documents into one, ``graphql-tools`` style.

    Same-named **type definitions** (and any ``schema`` definitions) are folded into their first
    occurrence with their fields/values/members unioned; everything else — extensions, directive
    definitions — is concatenated in source order so the builder can apply it. Two same-named
    definitions of *different* kinds are left both in place, so the downstream ``validate_sdl``
    reports the conflict precisely rather than this merge guessing.

    Returns:
        The merged document and any conflict diagnostics raised while unioning fields.
    """
    diagnostics: List[GraphQlDiagnostic] = []
    # Primary node chosen per merge key, preserving first-seen order via ``order``.
    primary_by_key: Dict[str, Node] = {}
    order: List[str] = []
    passthrough: List[Tuple[int, Node]] = []  # (position, node) for non-merged definitions

    position = 0
    for _label, document in parsed:
        for definition in document.definitions:
            kind = definition.kind
            mergeable_attrs = _MERGEABLE_DEFINITION_FIELDS.get(kind)
            merge_key = _merge_key(definition)
            if mergeable_attrs is None or merge_key is None:
                passthrough.append((position, definition))
                position += 1
                continue
            primary = primary_by_key.get(merge_key)
            if primary is None:
                primary_by_key[merge_key] = definition
                order.append(merge_key)
                passthrough.append((position, definition))
                position += 1
                continue
            if primary.kind != kind:
                # Same name, different kind — not mergeable; keep both for validate_sdl to flag.
                passthrough.append((position, definition))
                position += 1
                continue
            diagnostics.extend(
                _merge_child_lists(
                    primary, definition, mergeable_attrs, type_name=merge_key.split(":", 1)[-1]
                )
            )

    definitions = tuple(node for _pos, node in sorted(passthrough, key=lambda pair: pair[0]))
    return DocumentNode(definitions=definitions), diagnostics


def _merge_key(definition: Node) -> Optional[str]:
    """The key a definition merges on: ``schema`` for the schema definition, else its type name.

    The schema definition has no name but there can be only one, so it merges under a fixed key.
    Type definitions merge under their name. Anything unnamed and non-schema returns ``None`` and
    is passed through untouched.
    """
    if definition.kind == "schema_definition":
        return "schema"
    name = _node_name(definition)
    return f"type:{name}" if name is not None else None


# ===========================================================================
# Build pipeline
# ===========================================================================


def _user_defined_type_names(schema: GraphQLSchema) -> List[str]:
    """Names of the schema's user-defined types, in declaration order.

    Built-in scalars (``Int``/``Float``/``String``/``Boolean``/``ID``) and introspection types
    (``__Schema`` etc.) are excluded — only the author's own types remain.
    """
    names: List[str] = []
    for name, type_ in schema.type_map.items():
        if name.startswith("__") or is_introspection_type(type_) or is_specified_scalar_type(type_):
            continue
        names.append(name)
    return names


def _root_operations(schema: GraphQLSchema) -> GraphQlRootOperations:
    """Capture the schema's root operation type names."""
    return GraphQlRootOperations(
        query=schema.query_type.name if schema.query_type else None,
        mutation=schema.mutation_type.name if schema.mutation_type else None,
        subscription=schema.subscription_type.name if schema.subscription_type else None,
    )


def _build(
    sources: Sequence[SourceLike],
) -> Tuple[Optional[GraphQLSchema], GraphQlParseResult]:
    """Core pipeline: parse → merge → validate-sdl → build → validate-schema.

    Returns the built :class:`GraphQLSchema` (``None`` when invalid) alongside the serializable
    :class:`GraphQlParseResult`. Every failure mode (no input, syntax error, unknown type,
    conflicting definition, missing root) is captured as a diagnostic — nothing here raises.
    """
    coerced = [_coerce_source(item, i) for i, item in enumerate(sources)]
    if not coerced or all(not src.text.strip() for src in coerced):
        return None, GraphQlParseResult(
            ok=False,
            diagnostics=[GraphQlDiagnostic(message="No GraphQL SDL was provided.")],
        )

    # 1) Parse each source; a syntax error is a per-source diagnostic, not a raise.
    parsed: List[Tuple[str, DocumentNode]] = []
    syntax_diagnostics: List[GraphQlDiagnostic] = []
    for src in coerced:
        try:
            parsed.append((src.label, parse(src.text)))
        except GraphQLError as exc:
            syntax_diagnostics.append(_diagnostic_from_error(exc, source=src.label))
    if syntax_diagnostics:
        # A document that does not even parse cannot be merged or built.
        return None, GraphQlParseResult(ok=False, diagnostics=syntax_diagnostics)

    # 1b) Federation subgraph SDL applies @key/@shareable/@link without defining
    #     them (Apollo's build injects the definitions); fold in exactly the
    #     missing Federation v2 definitions so validate_sdl accepts real-world
    #     subgraph files (IXH-7.6). Plain SDL and supergraph SDL are untouched.
    from .graphql_federation import (
        document_federation_role,
        federation_prelude_document,
        subgraph_set_info,
    )

    prelude = federation_prelude_document([document for _label, document in parsed])
    merge_input = list(parsed)
    if prelude is not None:
        merge_input.append(("federation-prelude", prelude))

    # Subgraph-set ownership must be read *before* the merge: _merge_documents
    # unions same-named types into the first-seen definition node in place,
    # which would smear every merged field onto the first file's subgraph.
    subgraph_info = None
    if any(document_federation_role(document) == "subgraph" for _label, document in parsed):
        texts = {src.label: src.text for src in coerced}
        subgraph_info = subgraph_set_info(
            [(label, document, texts.get(label, "")) for label, document in parsed]
        )

    # 2) Merge (graphql-tools semantics) and 3) validate the merged SDL document.
    merged, merge_diagnostics = _merge_documents(merge_input)
    sdl_diagnostics = [_diagnostic_from_error(err) for err in validate_sdl(merged)]
    if merge_diagnostics or sdl_diagnostics:
        return None, GraphQlParseResult(ok=False, diagnostics=merge_diagnostics + sdl_diagnostics)

    # 4) Build the schema. validate_sdl has already cleared the common failures, but guard the
    #    builder defensively: a residual structural problem must surface as a diagnostic, never
    #    as an unhandled exception escaping the service.
    try:
        schema = build_ast_schema(merged)
    except (GraphQLError, TypeError) as exc:
        message = exc.message if isinstance(exc, GraphQLError) else str(exc)
        return None, GraphQlParseResult(ok=False, diagnostics=[GraphQlDiagnostic(message=message)])

    # 5) Validate the built schema (root-type presence, interface implementations, …).
    schema_diagnostics = [_diagnostic_from_error(err) for err in validate_schema(schema)]
    if schema_diagnostics:
        return None, GraphQlParseResult(ok=False, diagnostics=schema_diagnostics)

    # 6) Federation awareness (IXH-7.6): record subgraph ownership on the built
    #    schema — from the join-spec directives of a supergraph, or from the
    #    pre-merge file boundaries for a subgraph set — for the normalizer to
    #    fold into extras.
    from .graphql_federation import FEDERATION_EXTENSIONS_KEY, supergraph_info

    info = supergraph_info(schema) or subgraph_info
    if info is not None:
        schema.extensions[FEDERATION_EXTENSIONS_KEY] = info

    # The canonical SDL keeps applied directives (@key / @join__type / @link …)
    # rather than the bare print_schema form, which silently drops them.
    from .graphql_federation import print_schema_with_directives

    return schema, GraphQlParseResult(
        ok=True,
        sdl=print_schema_with_directives(schema),
        root_operations=_root_operations(schema),
        type_names=_user_defined_type_names(schema),
    )


# ===========================================================================
# Public entry points
# ===========================================================================


def parse_graphql_sources(sources: Sequence[SourceLike]) -> GraphQlParseResult:
    """Parse, merge and build a GraphQL schema from one or more SDL sources.

    This is the multi-file entry point. Each item may be a bare SDL string, a ``(label, text)``
    pair, or a :class:`GraphQlSource`. The sources are parsed, merged with ``graphql-tools``
    semantics (same-named types unioned, ``extend`` blocks applied), built into a single schema
    and validated. The result describes the outcome either way: validity is a *return value*,
    not an exception.

    Args:
        sources: The SDL sources to merge and build.

    Returns:
        A :class:`GraphQlParseResult` — ``ok`` with canonical SDL/roots/types, or not-``ok`` with
        error diagnostics.
    """
    _schema, result = _build(sources)
    return result


def parse_graphql(raw: str, *, source_label: Optional[str] = None) -> GraphQlParseResult:
    """Parse, build and validate a single GraphQL SDL document.

    A convenience wrapper over :func:`parse_graphql_sources` for the common single-file case.

    Args:
        raw: The raw SDL text.
        source_label: Optional label (filename/URL) used to attribute diagnostics; defaults to a
            positional label.

    Returns:
        A :class:`GraphQlParseResult`.
    """
    source: SourceLike = GraphQlSource(label=source_label, text=raw) if source_label else raw
    return parse_graphql_sources([source])


def build_schema_from_sources(sources: Sequence[SourceLike]) -> GraphQLSchema:
    """Build and return the live :class:`GraphQLSchema` from one or more SDL sources.

    For in-process consumers (e.g. the MFI-10.2 canonical-model mapping) that need the built
    schema object, not its serialized form — avoids a re-parse of the canonical SDL.

    Args:
        sources: The SDL sources to merge and build.

    Returns:
        The built, validated :class:`GraphQLSchema`.

    Raises:
        GraphQlParseError: When the SDL does not build into a valid schema.
    """
    schema, result = _build(sources)
    if schema is None:
        result.raise_if_invalid()  # always raises here (schema is None ⇒ not ok)
    assert schema is not None  # for type-checkers; unreachable when invalid
    return schema


def build_graphql_schema(sdl: str, *, source_label: Optional[str] = None) -> GraphQLSchema:
    """Build and return the live :class:`GraphQLSchema` from a single SDL document.

    Args:
        sdl: The raw SDL text.
        source_label: Optional label used to attribute diagnostics.

    Returns:
        The built, validated :class:`GraphQLSchema`.

    Raises:
        GraphQlParseError: When the SDL does not build into a valid schema.
    """
    source: SourceLike = GraphQlSource(label=source_label, text=sdl) if source_label else sdl
    return build_schema_from_sources([source])
