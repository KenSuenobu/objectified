"""GraphQL Federation (supergraph / subgraph) support — IXH-7.6 (#5131).

Composition awareness for the GraphQL adapter chain (MFI-10.x / MFI-EPIC-10). A
federated GraphQL deployment splits one graph across **subgraphs** that a router
serves as a composed **supergraph**; both artifact shapes carry ownership
information this module extracts and the rest of the pipeline preserves:

* **Role detection** — :func:`document_federation_role` recognizes a parsed SDL
  document as a *supergraph* (Apollo ``join``-spec machinery: the
  ``join__Graph`` enum / ``@join__type`` / ``@join__field`` applications) or a
  *subgraph* (federation directives like ``@key`` / ``@external`` /
  ``@shareable``, or a federation ``@link``).
* **Definition prelude** — hand-written subgraph SDL applies ``@key`` et al.
  *without defining them* (the Apollo build injects the definitions); plain
  ``validate_sdl`` therefore rejects real-world subgraph files.
  :func:`federation_prelude_document` returns a document containing exactly the
  missing Federation v2 definitions actually used, which the MFI-10.1 parser
  merges in so subgraph SDL builds cleanly.
* **Ownership extraction** — :func:`supergraph_info` reads per-type /
  per-field subgraph ownership off the ``join`` directives of a built
  supergraph schema; :func:`subgraph_set_info` derives the same mapping for a
  multi-file subgraph set from which file defines which type/field. Both
  produce a :class:`FederationInfo`, stashed on
  ``schema.extensions[FEDERATION_EXTENSIONS_KEY]`` for the MFI-10.2 normalizer
  to fold into canonical ``extras`` (``extras["federation"]`` on the artifact,
  ``extras["subgraphs"]`` per type/field/operation).
* **Composition validation** — :func:`check_composition` runs pure-Python
  composition checks over a subgraph set (invalid ``@key`` selections,
  non-``@shareable`` duplicate fields, unresolvable ``@requires``/``@provides``
  selections), each finding naming the offending subgraph; they surface as the
  ``composition`` lint dimension via :mod:`app.graphql_lint`.
  :func:`compose_subgraphs` / :func:`compose_subgraphs_sync` additionally run
  the bundled ``rover supergraph compose`` (MFI-5.2) when available and map its
  build errors onto the same :class:`CompositionFinding` shape — degrading to
  ``None`` (never raising) when the tool or its composition plugin is
  unavailable in this runtime.
* **Directive preservation** — ``graphql.print_schema`` prints directive
  *definitions* but silently drops *applied* directives, which would strip
  ``@key`` / ``@join__type`` from every stored SDL.
  :func:`print_schema_with_directives` re-prints a built schema with the
  applied directives restored from its AST nodes, and
  :func:`attach_directive_applications` re-attaches applications onto emitted
  SDL from canonical ``extras`` strings (the :mod:`app.graphql_emitter` seam).

Everything here is pure over ``graphql-core`` structures except the ``rover``
wrapper, which follows the bundled-toolchain conventions of
:mod:`app.proto_descriptor` (scratch materialisation, sandboxed runner,
graceful degradation).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import threading
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from graphql import GraphQLSchema, parse, print_ast, print_schema
from graphql.language.ast import (
    DirectiveNode,
    DocumentNode,
    EnumTypeDefinitionNode,
    FieldDefinitionNode,
    NamedTypeNode,
    Node,
    ObjectTypeDefinitionNode,
    OperationType,
    OperationTypeDefinitionNode,
    SchemaDefinitionNode,
    TypeDefinitionNode,
    TypeExtensionNode,
)
from graphql.validation.validate import validate_sdl
from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "FEDERATION_EXTENSIONS_KEY",
    "ROVER_TOOL_KEY",
    "SubgraphRef",
    "CompositionFinding",
    "FederationInfo",
    "document_federation_role",
    "federation_prelude_document",
    "supergraph_info",
    "subgraph_set_info",
    "federation_info_of",
    "subgraph_name_from_label",
    "check_composition",
    "compose_subgraphs",
    "compose_subgraphs_sync",
    "print_schema_with_directives",
    "attach_directive_applications",
]


#: Key under which a built schema's :class:`FederationInfo` rides on
#: ``graphql.GraphQLSchema.extensions`` from the parser to the normalizer.
FEDERATION_EXTENSIONS_KEY = "apiome_federation"

#: Bundled-toolchain key of Apollo's ``rover`` CLI (pinned by MFI-5.2).
ROVER_TOOL_KEY = "rover"

#: Applied-directive names that mark SDL as a *subgraph* (Apollo Federation v1/v2).
_SUBGRAPH_DIRECTIVE_NAMES = frozenset(
    {
        "key",
        "external",
        "requires",
        "provides",
        "shareable",
        "override",
        "inaccessible",
        "interfaceObject",
        "composeDirective",
        "extends",
    }
)

#: Applied-directive / definition names that mark SDL as a *supergraph* (join spec).
_SUPERGRAPH_MARKER_PREFIX = "join__"

#: The join-spec enum whose values enumerate the composed subgraphs.
_JOIN_GRAPH_ENUM = "join__Graph"

#: Federation v2 definitions injected (only when applied-but-undefined) so
#: hand-written subgraph SDL builds under the standard validate/build pipeline.
#: Mirrors the Apollo Federation v2.x subgraph specification's directive set.
_FEDERATION_PRELUDE_SDL = """
directive @link(url: String, as: String, for: link__Purpose, import: [link__Import]) repeatable on SCHEMA
directive @key(fields: federation__FieldSet!, resolvable: Boolean = true) repeatable on OBJECT | INTERFACE
directive @requires(fields: federation__FieldSet!) on FIELD_DEFINITION
directive @provides(fields: federation__FieldSet!) on FIELD_DEFINITION
directive @external on OBJECT | FIELD_DEFINITION
directive @shareable repeatable on OBJECT | FIELD_DEFINITION
directive @override(from: String!, label: String) on FIELD_DEFINITION
directive @inaccessible on FIELD_DEFINITION | OBJECT | INTERFACE | UNION
  | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION
directive @tag(name: String!) repeatable on FIELD_DEFINITION | OBJECT | INTERFACE | UNION
  | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION | SCHEMA
directive @extends on OBJECT | INTERFACE
directive @composeDirective(name: String!) repeatable on SCHEMA
directive @interfaceObject on OBJECT
directive @authenticated on FIELD_DEFINITION | OBJECT | INTERFACE | SCALAR | ENUM
directive @requiresScopes(scopes: [[federation__Scope!]!]!) on FIELD_DEFINITION | OBJECT | INTERFACE | SCALAR | ENUM
directive @policy(policies: [[federation__Policy!]!]!) on FIELD_DEFINITION | OBJECT | INTERFACE | SCALAR | ENUM
scalar federation__FieldSet
scalar federation__Scope
scalar federation__Policy
scalar link__Import
enum link__Purpose {
  SECURITY
  EXECUTION
}
"""

#: Supporting type names each prelude directive's arguments reference; injected
#: alongside the directive definition so the merged document stays valid.
_PRELUDE_SUPPORT_TYPES: Dict[str, Tuple[str, ...]] = {
    "key": ("federation__FieldSet",),
    "requires": ("federation__FieldSet",),
    "provides": ("federation__FieldSet",),
    "requiresScopes": ("federation__Scope",),
    "policy": ("federation__Policy",),
    "link": ("link__Purpose", "link__Import"),
}

#: Directives ``print_schema`` already renders from first-class schema fields;
#: copying their AST applications back would print them twice.
_PRINTED_BUILTIN_DIRECTIVES = frozenset({"deprecated", "specifiedBy", "oneOf"})

#: File-name-safe subgraph names for the rover scratch directory.
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


# ===========================================================================
# Models
# ===========================================================================


class SubgraphRef(BaseModel):
    """One subgraph participating in a federated graph."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(description="Subgraph name (join__graph name, or the source file stem).")
    url: Optional[str] = Field(
        default=None, description="Routing URL recorded for the subgraph, when known."
    )


class CompositionFinding(BaseModel):
    """One composition problem attributed to a subgraph.

    Produced by the pure checks (:func:`check_composition`) and by the
    ``rover supergraph compose`` wrapper; both shapes surface as ``composition``
    lint findings via :mod:`app.graphql_lint`.
    """

    model_config = ConfigDict(frozen=True)

    rule: str = Field(
        description="Stable finding discriminator (e.g. ``invalid-key``, ``rover``)."
    )
    subgraph: str = Field(description="Name of the offending subgraph.")
    type_name: Optional[str] = Field(
        default=None, description="The type the finding points at, when known."
    )
    field_name: Optional[str] = Field(
        default=None, description="The field the finding points at, when known."
    )
    message: str = Field(description="Human-readable explanation, naming the subgraph.")

    @property
    def path(self) -> str:
        """A canonical-model-shaped finding path (``types.{Type}[.fields.{Type.field}]``)."""
        if self.type_name and self.field_name:
            return f"types.{self.type_name}.fields.{self.type_name}.{self.field_name}"
        if self.type_name:
            return f"types.{self.type_name}"
        return f"subgraphs.{self.subgraph}"


class FederationInfo(BaseModel):
    """Federation facts extracted at parse time, carried to the normalizer.

    Rides on ``schema.extensions[FEDERATION_EXTENSIONS_KEY]``. Ownership maps
    are keyed by GraphQL schema coordinate (``Product`` / ``Product.price``)
    and list the owning subgraph names, sorted.
    """

    role: str = Field(description='``"supergraph"`` or ``"subgraph"``.')
    subgraphs: List[SubgraphRef] = Field(
        default_factory=list, description="The participating subgraphs, sorted by name."
    )
    type_owners: Dict[str, List[str]] = Field(
        default_factory=dict, description="Type name → owning subgraph names."
    )
    field_owners: Dict[str, List[str]] = Field(
        default_factory=dict, description="``Type.field`` coordinate → owning subgraph names."
    )
    subgraph_sdls: Dict[str, str] = Field(
        default_factory=dict,
        description="Original per-subgraph SDL (subgraph sets only) — the composition-check "
        "input, kept out of the fingerprint via ``CanonicalApi.raw``.",
    )
    composition_findings: List[CompositionFinding] = Field(
        default_factory=list,
        description="Composition errors reported by ``rover supergraph compose`` at import "
        "time (empty when the tool is unavailable or composition succeeded).",
    )

    def extras_payload(self) -> Dict[str, Any]:
        """The compact JSON payload stowed on ``CanonicalApi.extras['federation']``.

        Only identity-bearing facts (role + subgraph roster) — ownership is
        recorded on each owning entity, and SDL/tool output stay in ``raw``.
        """
        return {
            "role": self.role,
            "subgraphs": [ref.model_dump(exclude_none=True) for ref in self.subgraphs],
        }


# ===========================================================================
# Role detection
# ===========================================================================


def _applied_directive_names(document: DocumentNode) -> set[str]:
    """Every directive name *applied* anywhere in ``document`` (definitions excluded)."""
    names: set[str] = set()

    def _walk(node: Any) -> None:
        directives = getattr(node, "directives", None)
        if directives and not isinstance(node, DirectiveNode):
            for directive in directives:
                names.add(directive.name.value)
        for attr in ("fields", "values", "arguments", "operation_types", "interfaces"):
            for child in getattr(node, attr, ()) or ():
                _walk(child)

    for definition in document.definitions:
        if definition.kind == "directive_definition":
            continue
        _walk(definition)
    return names


def _defined_names(documents: Iterable[DocumentNode]) -> Tuple[set[str], set[str]]:
    """Return ``(directive_definition_names, type_definition_names)`` across documents."""
    directive_names: set[str] = set()
    type_names: set[str] = set()
    for document in documents:
        for definition in document.definitions:
            if definition.kind == "directive_definition":
                directive_names.add(definition.name.value)
            elif isinstance(definition, TypeDefinitionNode):
                type_names.add(definition.name.value)
    return directive_names, type_names


def document_federation_role(document: DocumentNode) -> Optional[str]:
    """Classify a parsed SDL document as ``"supergraph"``, ``"subgraph"``, or ``None``.

    A document is a *supergraph* when it carries Apollo ``join``-spec machinery
    (the ``join__Graph`` enum or any ``join__``-prefixed directive definition or
    application); it is a *subgraph* when it applies a federation directive
    (``@key`` / ``@external`` / …) or ``@link``\\s the federation spec. Plain
    SDL returns ``None``.

    Args:
        document: A parsed (not necessarily built) SDL document.

    Returns:
        ``"supergraph"``, ``"subgraph"``, or ``None``.
    """
    for definition in document.definitions:
        name = getattr(getattr(definition, "name", None), "value", "")
        if isinstance(definition, (EnumTypeDefinitionNode,)) and name == _JOIN_GRAPH_ENUM:
            return "supergraph"
        if definition.kind == "directive_definition" and name.startswith(
            _SUPERGRAPH_MARKER_PREFIX
        ):
            return "supergraph"

    applied = _applied_directive_names(document)
    if any(name.startswith(_SUPERGRAPH_MARKER_PREFIX) for name in applied):
        return "supergraph"
    if applied & _SUBGRAPH_DIRECTIVE_NAMES:
        return "subgraph"
    if "link" in applied and _links_federation_spec(document):
        return "subgraph"
    return None


def _links_federation_spec(document: DocumentNode) -> bool:
    """Whether any ``@link`` application in ``document`` targets the federation spec."""
    for definition in document.definitions:
        for directive in getattr(definition, "directives", ()) or ():
            if directive.name.value != "link":
                continue
            for argument in directive.arguments or ():
                value = getattr(argument.value, "value", None)
                if (
                    argument.name.value == "url"
                    and isinstance(value, str)
                    and "/federation/" in value
                ):
                    return True
    return False


# ===========================================================================
# Definition prelude (subgraph SDL without directive definitions)
# ===========================================================================


_PRELUDE_DEFINITIONS: Optional[Dict[str, Node]] = None


def _prelude_definitions() -> Dict[str, Node]:
    """Parse the Federation v2 prelude once and index its definitions by name."""
    global _PRELUDE_DEFINITIONS
    if _PRELUDE_DEFINITIONS is None:
        _PRELUDE_DEFINITIONS = {
            definition.name.value: definition
            for definition in parse(_FEDERATION_PRELUDE_SDL).definitions
        }
    return _PRELUDE_DEFINITIONS


def federation_prelude_document(
    documents: Sequence[DocumentNode],
) -> Optional[DocumentNode]:
    """Return the Federation definitions ``documents`` apply but never define.

    Hand-written subgraph SDL uses ``@key`` / ``@shareable`` / ``@link`` without
    defining them (Apollo's build injects the definitions), so the standard
    ``validate_sdl`` step would reject it with *Unknown directive*. This
    computes exactly the missing definitions — each federation directive that
    is applied somewhere but defined nowhere, plus the support types its
    arguments reference — as a single document for the MFI-10.1 merge to fold
    in. Definitions the author *did* write are never overridden.

    Args:
        documents: The parsed user documents (prelude candidates excluded).

    Returns:
        A :class:`DocumentNode` with the missing definitions, or ``None`` when
        nothing federation-flavored is missing (plain SDL, supergraph SDL, or a
        subgraph that carries its own definitions).
    """
    applied: set[str] = set()
    for document in documents:
        applied |= _applied_directive_names(document)

    candidates = applied & (
        _SUBGRAPH_DIRECTIVE_NAMES
        | set(_PRELUDE_SUPPORT_TYPES)
        | {"link", "tag", "authenticated", "requiresScopes", "policy"}
    )
    if not candidates:
        return None

    defined_directives, defined_types = _defined_names(documents)
    prelude = _prelude_definitions()

    picked: List[Node] = []
    picked_names: set[str] = set()

    def _pick(name: str) -> None:
        if name in picked_names or name not in prelude:
            return
        picked_names.add(name)
        picked.append(prelude[name])

    for name in sorted(candidates):
        if name in defined_directives or name not in prelude:
            continue
        _pick(name)
        for support in _PRELUDE_SUPPORT_TYPES.get(name, ()):  # e.g. federation__FieldSet
            if support not in defined_types:
                _pick(support)

    if not picked:
        return None
    return DocumentNode(definitions=tuple(picked))


# ===========================================================================
# Ownership extraction
# ===========================================================================


def _directive_string_argument(directive: DirectiveNode, name: str) -> Optional[str]:
    """The string value of ``directive``'s ``name`` argument, if present."""
    for argument in directive.arguments or ():
        if argument.name.value == name:
            value = getattr(argument.value, "value", None)
            return value if isinstance(value, str) else None
    return None


def _directive_enum_argument(directive: DirectiveNode, name: str) -> Optional[str]:
    """The enum-value name of ``directive``'s ``name`` argument, if present."""
    for argument in directive.arguments or ():
        if argument.name.value == name:
            return getattr(argument.value, "value", None)
    return None


def _ast_nodes(entity: Any) -> List[Node]:
    """A schema element's definition node plus any extension nodes, in order."""
    nodes: List[Node] = []
    ast_node = getattr(entity, "ast_node", None)
    if ast_node is not None:
        nodes.append(ast_node)
    nodes.extend(getattr(entity, "extension_ast_nodes", ()) or ())
    return nodes


def _node_directives(entity: Any) -> List[DirectiveNode]:
    """All applied directives across an element's definition + extension nodes."""
    directives: List[DirectiveNode] = []
    for node in _ast_nodes(entity):
        directives.extend(getattr(node, "directives", ()) or ())
    return directives


def supergraph_info(schema: GraphQLSchema) -> Optional[FederationInfo]:
    """Extract subgraph ownership from a built supergraph schema's ``join`` directives.

    The Apollo ``join`` spec records composition results in the supergraph SDL:
    the ``join__Graph`` enum enumerates the subgraphs (``@join__graph(name:,
    url:)`` per value), ``@join__type(graph:)`` marks which subgraphs define a
    type, and ``@join__field(graph:)`` marks field ownership; a field with no
    ``@join__field`` belongs to every subgraph that owns its type.

    Args:
        schema: A built schema (AST nodes attached, as SDL-built schemas are).

    Returns:
        The extracted :class:`FederationInfo` (role ``supergraph``), or ``None``
        when ``schema`` carries no ``join__Graph`` enum (not a supergraph).
    """
    graph_enum = schema.type_map.get(_JOIN_GRAPH_ENUM)
    values = getattr(graph_enum, "values", None)
    if not values:
        return None

    # join__Graph enum value (e.g. ``PRODUCTS``) → subgraph name (e.g. ``products``).
    graph_names: Dict[str, str] = {}
    subgraphs: List[SubgraphRef] = []
    for value_name, value in values.items():
        name: Optional[str] = None
        url: Optional[str] = None
        for directive in _node_directives(value):
            if directive.name.value == "join__graph":
                name = _directive_string_argument(directive, "name") or value_name.lower()
                url = _directive_string_argument(directive, "url")
        if name is None:
            name = value_name.lower()
        graph_names[value_name] = name
        subgraphs.append(SubgraphRef(name=name, url=url))
    subgraphs.sort(key=lambda ref: ref.name)

    type_owners: Dict[str, List[str]] = {}
    field_owners: Dict[str, List[str]] = {}

    for type_name, type_ in schema.type_map.items():
        if type_name.startswith("__"):
            continue
        owners: List[str] = []
        for directive in _node_directives(type_):
            if directive.name.value != "join__type":
                continue
            graph_key = _directive_enum_argument(directive, "graph")
            resolved = graph_names.get(graph_key or "")
            if resolved and resolved not in owners:
                owners.append(resolved)
        if not owners:
            continue
        type_owners[type_name] = sorted(owners)

        fields = getattr(type_, "fields", None)
        if not isinstance(fields, dict):
            continue
        for field_name, field in fields.items():
            declared: List[str] = []
            for directive in _node_directives(field):
                if directive.name.value != "join__field":
                    continue
                # ``@join__field(graph: X, external: true)`` records a stub
                # reference, not a resolver — X does not own the field.
                if any(
                    argument.name.value == "external"
                    and getattr(argument.value, "value", None) is True
                    for argument in directive.arguments or ()
                ):
                    continue
                graph_key = _directive_enum_argument(directive, "graph")
                resolved = graph_names.get(graph_key or "")
                if resolved and resolved not in declared:
                    declared.append(resolved)
            field_owners[f"{type_name}.{field_name}"] = (
                sorted(declared) if declared else sorted(owners)
            )

    return FederationInfo(
        role="supergraph",
        subgraphs=subgraphs,
        type_owners=type_owners,
        field_owners=field_owners,
    )


def subgraph_name_from_label(label: Optional[str], index: int = 0) -> str:
    """Derive a subgraph name from a source label (file path / URL / logical name).

    ``12-federation-set/products.graphql`` → ``products``. Falls back to a
    positional ``subgraph``/``subgraph-N`` name when the label is missing or
    yields nothing usable.
    """
    stem = ""
    if label and not label.strip().startswith("source["):  # positional parser label
        stem = os.path.basename(label.strip().rstrip("/"))
        stem = stem.rsplit(".", 1)[0] if "." in stem else stem
        stem = _SAFE_NAME_RE.sub("-", stem).strip("-")
    if not stem:
        return "subgraph" if index == 0 else f"subgraph-{index}"
    return stem


def subgraph_set_info(
    sources: Sequence[Tuple[str, DocumentNode, str]],
) -> Optional[FederationInfo]:
    """Derive ownership for a set of subgraph SDL sources from their file boundaries.

    Each source is one subgraph (named for its file stem); a type is owned by
    every subgraph that defines or extends it, and a field by the subgraph(s)
    whose file declares it.

    Args:
        sources: ``(label, parsed document, original text)`` per subgraph file,
            in intake order.

    Returns:
        A :class:`FederationInfo` (role ``subgraph``), or ``None`` when no
        source shows subgraph markers.
    """
    if not any(document_federation_role(document) == "subgraph" for _, document, _ in sources):
        return None

    subgraphs: List[SubgraphRef] = []
    type_owners: Dict[str, List[str]] = {}
    field_owners: Dict[str, List[str]] = {}
    subgraph_sdls: Dict[str, str] = {}
    used_names: set[str] = set()

    for index, (label, document, text) in enumerate(sources):
        name = subgraph_name_from_label(label, index)
        while name in used_names:  # two files with the same stem in different dirs
            name = f"{name}-{index}"
        used_names.add(name)
        subgraphs.append(SubgraphRef(name=name))
        subgraph_sdls[name] = text

        for definition in document.definitions:
            if not isinstance(definition, (TypeDefinitionNode, TypeExtensionNode)):
                continue
            type_name = definition.name.value
            owners = type_owners.setdefault(type_name, [])
            if name not in owners:
                owners.append(name)
            for field in getattr(definition, "fields", ()) or ():
                # An @external field is a stub *referencing* another subgraph's
                # field (for @key/@requires selections), not a resolver — it
                # does not make this subgraph an owner of the field.
                if any(
                    d.name.value == "external" for d in (field.directives or ())
                ):
                    continue
                coordinate = f"{type_name}.{field.name.value}"
                owning = field_owners.setdefault(coordinate, [])
                if name not in owning:
                    owning.append(name)

    subgraphs.sort(key=lambda ref: ref.name)
    return FederationInfo(
        role="subgraph",
        subgraphs=subgraphs,
        type_owners={key: sorted(value) for key, value in type_owners.items()},
        field_owners={key: sorted(value) for key, value in field_owners.items()},
        subgraph_sdls=subgraph_sdls,
    )


def federation_info_of(schema: GraphQLSchema) -> Optional[FederationInfo]:
    """The schema's :class:`FederationInfo` — stashed by the parser, or derived.

    Prefers the parse-time info riding on ``schema.extensions`` (which knows
    file boundaries for subgraph sets); a schema built outside the MFI-10.1
    pipeline still gets supergraph ownership derived directly from its ``join``
    directives.
    """
    stashed = (schema.extensions or {}).get(FEDERATION_EXTENSIONS_KEY)
    if isinstance(stashed, FederationInfo):
        return stashed
    if isinstance(stashed, Mapping):
        try:
            return FederationInfo.model_validate(stashed)
        except Exception:  # noqa: BLE001 - a foreign extensions payload is not ours to raise on
            return None
    return supergraph_info(schema)


# ===========================================================================
# Pure composition checks
# ===========================================================================


class _SubgraphIndex:
    """Per-subgraph view of parsed SDL used by the composition checks."""

    def __init__(self, name: str, document: DocumentNode) -> None:
        self.name = name
        # type name → {field name → field node}, across definitions + extensions.
        self.fields: Dict[str, Dict[str, FieldDefinitionNode]] = {}
        # type name → its type-level applied-directive names.
        self.type_directives: Dict[str, set[str]] = {}
        # type name → its definition/extension nodes (for type-level directive args).
        self.nodes: Dict[str, List[Node]] = {}
        for definition in document.definitions:
            if not isinstance(definition, (TypeDefinitionNode, TypeExtensionNode)):
                continue
            type_name = definition.name.value
            per_type = self.fields.setdefault(type_name, {})
            names = self.type_directives.setdefault(type_name, set())
            names.update(d.name.value for d in (definition.directives or ()))
            self.nodes.setdefault(type_name, []).append(definition)
            for field in getattr(definition, "fields", ()) or ():
                per_type[field.name.value] = field

    def field_directive_names(self, type_name: str, field_name: str) -> set[str]:
        field = self.fields.get(type_name, {}).get(field_name)
        if field is None:
            return set()
        return {d.name.value for d in (field.directives or ())}


def _top_level_selection_names(fields_value: str) -> List[str]:
    """Top-level field names of a federation ``fields:`` selection string.

    ``"id name address { street }"`` → ``["id", "name", "address"]``. Nested
    selections are intentionally not resolved (that is the composer's job); a
    selection that does not even parse returns ``[]`` so the caller can flag it.
    """
    try:
        document = parse("{" + fields_value + "}")
    except Exception:  # noqa: BLE001 - malformed selection handled by the caller
        return []
    definitions = document.definitions
    if not definitions:
        return []
    selection_set = getattr(definitions[0], "selection_set", None)
    if selection_set is None:
        return []
    names: List[str] = []
    for selection in selection_set.selections:
        name = getattr(getattr(selection, "name", None), "value", None)
        if name:
            names.append(name)
    return names


_ROOT_TYPE_NAMES = frozenset({"Query", "Mutation", "Subscription"})


def check_composition(subgraph_sdls: Mapping[str, str]) -> List[CompositionFinding]:
    """Run the pure-Python composition checks over a subgraph set.

    A deterministic, dependency-free subset of Apollo composition validation —
    the checks that catch the common authoring mistakes and can name the
    offending subgraph without running the composer:

    * ``invalid-key`` — a ``@key(fields:)`` selection names a field the type
      does not declare in that subgraph (or does not parse).
    * ``non-shareable-field`` — the same object-type field is resolved by more
      than one subgraph without every occurrence being ``@shareable`` (key
      fields and ``@external`` stubs excluded, root types excluded — root
      fields merge by design).
    * ``unresolvable-selection`` — a ``@requires(fields:)`` /
      ``@provides(fields:)`` selection names fields its target type declares in
      no subgraph.

    Args:
        subgraph_sdls: Subgraph name → original SDL text.

    Returns:
        Findings sorted by ``(rule, subgraph, path)``; empty when the set is
        composition-clean (or when a source is unparsable — intake already
        reports parse errors; composition checks do not duplicate them).
    """
    indexes: List[_SubgraphIndex] = []
    for name in sorted(subgraph_sdls):
        try:
            document = parse(subgraph_sdls[name])
        except Exception:  # noqa: BLE001 - parse errors are intake's finding, not ours
            continue
        indexes.append(_SubgraphIndex(name, document))

    findings: List[CompositionFinding] = []
    findings.extend(_check_key_selections(indexes))
    findings.extend(_check_shareable_duplicates(indexes))
    findings.extend(_check_requires_provides(indexes))
    findings.sort(key=lambda f: (f.rule, f.subgraph, f.path))
    return findings


def _key_fields_of(index: _SubgraphIndex, type_name: str) -> set[str]:
    """Top-level field names named by any ``@key`` on ``type_name`` in ``index``."""
    names: set[str] = set()
    for node in index.nodes.get(type_name, ()):
        for directive in getattr(node, "directives", ()) or ():
            if directive.name.value != "key":
                continue
            fields_value = _directive_string_argument(directive, "fields")
            if fields_value:
                names.update(_top_level_selection_names(fields_value))
    return names


def _check_key_selections(indexes: Sequence[_SubgraphIndex]) -> List[CompositionFinding]:
    """``@key`` selections must name fields the type declares in that subgraph."""
    findings: List[CompositionFinding] = []
    for index in indexes:
        for type_name, nodes in index.nodes.items():
            declared = set(index.fields.get(type_name, {}))
            for node in nodes:
                for directive in getattr(node, "directives", ()) or ():
                    if directive.name.value != "key":
                        continue
                    fields_value = _directive_string_argument(directive, "fields")
                    selection = _top_level_selection_names(fields_value or "")
                    if fields_value and not selection:
                        findings.append(
                            CompositionFinding(
                                rule="invalid-key",
                                subgraph=index.name,
                                type_name=type_name,
                                message=(
                                    f"@key(fields: \"{fields_value}\") on type "
                                    f"'{type_name}' in subgraph '{index.name}' is not a "
                                    "valid selection set."
                                ),
                            )
                        )
                        continue
                    for field_name in selection:
                        if field_name not in declared:
                            findings.append(
                                CompositionFinding(
                                    rule="invalid-key",
                                    subgraph=index.name,
                                    type_name=type_name,
                                    message=(
                                        f"@key on type '{type_name}' in subgraph "
                                        f"'{index.name}' selects field '{field_name}', "
                                        "which the type does not declare there."
                                    ),
                                )
                            )
    return findings


def _check_shareable_duplicates(
    indexes: Sequence[_SubgraphIndex],
) -> List[CompositionFinding]:
    """A field resolved by several subgraphs must be ``@shareable`` everywhere."""
    findings: List[CompositionFinding] = []
    all_types: set[str] = set()
    for index in indexes:
        all_types.update(index.fields)

    for type_name in sorted(all_types - _ROOT_TYPE_NAMES):
        field_names: set[str] = set()
        for index in indexes:
            field_names.update(index.fields.get(type_name, {}))
        for field_name in sorted(field_names):
            resolvers: List[_SubgraphIndex] = []
            for index in indexes:
                if field_name not in index.fields.get(type_name, {}):
                    continue
                directives = index.field_directive_names(type_name, field_name)
                if "external" in directives:
                    continue  # a stub reference, not a resolver
                if field_name in _key_fields_of(index, type_name):
                    continue  # key fields are shareable by definition
                resolvers.append(index)
            if len(resolvers) < 2:
                continue
            unshared = [
                index.name
                for index in resolvers
                if "shareable" not in index.field_directive_names(type_name, field_name)
                and "shareable" not in index.type_directives.get(type_name, set())
            ]
            if not unshared:
                continue
            for subgraph_name in unshared:
                findings.append(
                    CompositionFinding(
                        rule="non-shareable-field",
                        subgraph=subgraph_name,
                        type_name=type_name,
                        field_name=field_name,
                        message=(
                            f"Field '{type_name}.{field_name}' is resolved by "
                            f"{len(resolvers)} subgraphs but is not @shareable in "
                            f"subgraph '{subgraph_name}'."
                        ),
                    )
                )
    return findings


def _check_requires_provides(
    indexes: Sequence[_SubgraphIndex],
) -> List[CompositionFinding]:
    """``@requires``/``@provides`` selections must resolve against known fields."""
    findings: List[CompositionFinding] = []
    # Union of declared fields per type across the whole set.
    union_fields: Dict[str, set[str]] = {}
    for index in indexes:
        for type_name, fields in index.fields.items():
            union_fields.setdefault(type_name, set()).update(fields)

    for index in indexes:
        for type_name, fields in index.fields.items():
            for field_name, field in fields.items():
                for directive in field.directives or ():
                    directive_name = directive.name.value
                    if directive_name not in ("requires", "provides"):
                        continue
                    fields_value = _directive_string_argument(directive, "fields")
                    selection = _top_level_selection_names(fields_value or "")
                    if directive_name == "requires":
                        # @requires selects sibling fields of the same type.
                        target_type = type_name
                    else:
                        # @provides selects fields of the field's return type.
                        target_type = _named_return_type(field)
                    known = union_fields.get(target_type or "", set())
                    for selected in selection:
                        if selected not in known:
                            findings.append(
                                CompositionFinding(
                                    rule="unresolvable-selection",
                                    subgraph=index.name,
                                    type_name=type_name,
                                    field_name=field_name,
                                    message=(
                                        f"@{directive_name} on '{type_name}.{field_name}' "
                                        f"in subgraph '{index.name}' selects "
                                        f"'{selected}', which no subgraph declares on "
                                        f"type '{target_type or '?'}'."
                                    ),
                                )
                            )
    return findings


def _named_return_type(field: FieldDefinitionNode) -> Optional[str]:
    """The innermost named type of a field's return type node."""
    node: Any = field.type
    while node is not None and not isinstance(node, NamedTypeNode):
        node = getattr(node, "type", None)
    return node.name.value if isinstance(node, NamedTypeNode) else None


# ===========================================================================
# rover supergraph compose (bundled tool, degrades gracefully)
# ===========================================================================


async def compose_subgraphs(
    subgraphs: Sequence[SubgraphRef],
    subgraph_sdls: Mapping[str, str],
    *,
    runner: Optional[Any] = None,
    timeout: Optional[float] = None,
) -> Optional[List[CompositionFinding]]:
    """Run ``rover supergraph compose`` over a subgraph set, mapping build errors.

    Materialises each subgraph SDL plus a ``supergraph.yaml`` into a scratch
    directory and runs the bundled ``rover`` (MFI-5.2) with ``--format json``.
    Composition *errors* map to :class:`CompositionFinding`\\s (rule
    ``rover``, subgraph attributed from the error nodes when present); a clean
    composition returns ``[]``.

    Degrades, never raises: when ``rover`` is missing, times out, cannot fetch
    its composition plugin (the sandbox has no network), or emits unparseable
    output, the result is ``None`` — "no verdict", distinct from "composed
    clean". The pure checks (:func:`check_composition`) remain the always-on
    baseline.

    Args:
        subgraphs: The subgraph roster (names + optional routing URLs).
        subgraph_sdls: Subgraph name → SDL text (must cover every roster name).
        runner: Toolchain runner override (tests); defaults to the shared one.
        timeout: Optional per-call timeout in seconds.

    Returns:
        Composition findings (possibly empty), or ``None`` when no verdict
        could be obtained.
    """
    from .toolchain_packaging import bundled_tool
    from .toolchain_runner import (
        ToolchainError,
        ToolSpec,
        default_runner,
    )

    if not subgraph_sdls:
        return None

    tool = bundled_tool(ROVER_TOOL_KEY)
    spec = ToolSpec(
        key=ROVER_TOOL_KEY,
        executable=tool.executable if tool is not None else "rover",
        description="rover supergraph compose → composition verdict (IXH-7.6).",
        base_args=("supergraph", "compose"),
        default_timeout_seconds=(
            tool.default_timeout_seconds if tool is not None else 60.0
        ),
        env_override_keys=(tool.env_override_key,) if tool is not None else (),
        parses_json=False,
    )
    active_runner = runner if runner is not None else default_runner

    urls = {ref.name: ref.url for ref in subgraphs}
    with tempfile.TemporaryDirectory(prefix="apiome-rover-") as scratch:
        config_lines = ["federation_version: =2.9.3", "subgraphs:"]
        for name in sorted(subgraph_sdls):
            safe = _SAFE_NAME_RE.sub("-", name) or "subgraph"
            file_name = f"{safe}.graphql"
            with open(os.path.join(scratch, file_name), "w", encoding="utf-8") as handle:
                handle.write(subgraph_sdls[name])
            routing_url = urls.get(name) or f"http://{safe}.invalid/graphql"
            config_lines.append(f"  {safe}:")
            config_lines.append(f"    routing_url: {routing_url}")
            config_lines.append("    schema:")
            config_lines.append(f"      file: ./{file_name}")
        config_path = os.path.join(scratch, "supergraph.yaml")
        with open(config_path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(config_lines) + "\n")

        try:
            result = await active_runner.run_spec(
                spec,
                ["--config", config_path, "--format", "json", "--elv2-license", "accept"],
                timeout=timeout,
                cwd=scratch,
            )
            stdout = result.stdout
        except ToolchainError as exc:
            # Non-zero exit still writes the JSON verdict to stdout; anything
            # without parseable output is an environment problem → no verdict.
            stdout = getattr(exc, "stdout", "") or ""
            if not stdout.strip():
                return None
        except Exception:  # noqa: BLE001 - a compose failure must never fail import/lint
            return None

    return _rover_findings_from_output(stdout)


def _rover_findings_from_output(stdout: str) -> Optional[List[CompositionFinding]]:
    """Map ``rover --format json`` output to findings (``None`` when unparseable)."""
    try:
        payload = json.loads(stdout)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, Mapping):
        return None

    error = payload.get("error")
    if not error:
        return [] if payload.get("data") is not None else None
    if not isinstance(error, Mapping):
        return None

    build_errors = (
        error.get("details", {}).get("build_errors")
        if isinstance(error.get("details"), Mapping)
        else None
    )
    if not isinstance(build_errors, list):
        # An error without build_errors is environmental (plugin fetch, config…).
        return None

    findings: List[CompositionFinding] = []
    for entry in build_errors:
        if not isinstance(entry, Mapping):
            continue
        message = str(entry.get("message", "") or "").strip()
        code = str(entry.get("code", "") or "").strip()
        subgraph = "unknown"
        nodes = entry.get("nodes")
        if isinstance(nodes, list):
            for node in nodes:
                if isinstance(node, Mapping) and node.get("subgraph"):
                    subgraph = str(node["subgraph"])
                    break
        if code and code not in message:
            message = f"[{code}] {message}"
        if not message:
            continue
        findings.append(
            CompositionFinding(rule="rover", subgraph=subgraph, message=message)
        )
    return findings


def compose_subgraphs_sync(
    subgraphs: Sequence[SubgraphRef],
    subgraph_sdls: Mapping[str, str],
) -> Optional[List[CompositionFinding]]:
    """Synchronous bridge for :func:`compose_subgraphs` (the import-pipeline seam).

    The import SPI is synchronous but runs on the service's event loop, where
    ``asyncio.run`` is illegal — so, exactly like the gRPC adapter's ``buf``
    bridge, the compose runs on a dedicated worker thread with its own loop and
    a fresh sibling runner. Skips fast (returns ``None``) when the bundled
    ``rover`` is not available in this runtime; swallows every failure.
    """
    from .toolchain_runner import ToolchainRunner, default_runner, is_tool_available

    try:
        if not is_tool_available(ROVER_TOOL_KEY):
            return None
    except Exception:  # noqa: BLE001 - availability probe must never break import
        return None

    box: Dict[str, Any] = {}

    def _worker() -> None:
        async def _drive() -> Optional[List[CompositionFinding]]:
            runner = ToolchainRunner(
                max_concurrency=default_runner.max_concurrency,
                default_timeout_seconds=default_runner.default_timeout_seconds,
                default_policy=default_runner.default_policy,
            )
            return await compose_subgraphs(subgraphs, subgraph_sdls, runner=runner)

        try:
            box["value"] = asyncio.run(_drive())
        except BaseException as exc:  # noqa: BLE001 - reported as "no verdict" below
            box["error"] = exc

    thread = threading.Thread(target=_worker, name="rover-compose", daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        return None
    return box.get("value")


# ===========================================================================
# Directive-preserving SDL printing
# ===========================================================================


def _mergeable_directives(entity: Any) -> List[DirectiveNode]:
    """An element's applied directives worth re-printing (spec-printed ones excluded)."""
    return [
        directive
        for directive in _node_directives(entity)
        if directive.name.value not in _PRINTED_BUILTIN_DIRECTIVES
    ]


def _reattach_on_children(
    printed_children: Sequence[Node],
    live_children: Mapping[str, Any],
) -> None:
    """Copy applied directives from live child elements onto printed child nodes."""
    for child in printed_children:
        name = getattr(getattr(child, "name", None), "value", None)
        if name is None or name not in live_children:
            continue
        live = live_children[name]
        directives = _mergeable_directives(live)
        if directives:
            child.directives = tuple(directives)
        # Field arguments can carry directives too.
        printed_args = getattr(child, "arguments", ()) or ()
        live_args = getattr(live, "args", None)
        if printed_args and isinstance(live_args, dict):
            _reattach_on_children(printed_args, live_args)


def print_schema_with_directives(schema: GraphQLSchema) -> str:
    """Print a built schema as SDL *with its applied directives restored*.

    ``graphql.print_schema`` prints custom directive definitions but drops
    every application (only ``@deprecated``/``@specifiedBy`` survive, via their
    first-class fields) — which would strip ``@key`` / ``@join__type`` /
    ``@link`` from stored SDL. This re-prints the schema and copies the applied
    directives back from the schema elements' AST nodes (definitions and
    extensions combined). A schema built without AST nodes (programmatic
    construction) prints exactly as ``print_schema`` would.

    Args:
        schema: The built schema.

    Returns:
        Canonical SDL with applied directives present.
    """
    printed = print_schema(schema)
    try:
        document = parse(printed)
    except Exception:  # noqa: BLE001 - never make printing worse than print_schema
        return printed

    schema_directives: List[DirectiveNode] = []
    for node in _ast_nodes(schema):
        schema_directives.extend(
            d
            for d in (getattr(node, "directives", ()) or ())
            if d.name.value not in _PRINTED_BUILTIN_DIRECTIVES
        )

    definitions = list(document.definitions)
    saw_schema_definition = False
    for definition in definitions:
        if isinstance(definition, SchemaDefinitionNode):
            saw_schema_definition = True
            if schema_directives:
                definition.directives = tuple(schema_directives)
            continue
        if not isinstance(definition, TypeDefinitionNode):
            continue
        live_type = schema.type_map.get(definition.name.value)
        if live_type is None:
            continue
        directives = _mergeable_directives(live_type)
        if directives:
            definition.directives = tuple(directives)
        children = getattr(definition, "fields", None) or getattr(definition, "values", None)
        live_children = getattr(live_type, "fields", None) or getattr(live_type, "values", None)
        if children and isinstance(live_children, dict):
            _reattach_on_children(children, live_children)

    if schema_directives and not saw_schema_definition:
        operation_types = []
        for operation, root in (
            (OperationType.QUERY, schema.query_type),
            (OperationType.MUTATION, schema.mutation_type),
            (OperationType.SUBSCRIPTION, schema.subscription_type),
        ):
            if root is not None:
                operation_types.append(
                    OperationTypeDefinitionNode(
                        operation=operation,
                        type=NamedTypeNode(name=root.ast_node.name)
                        if root.ast_node is not None
                        else None,
                    )
                )
        operation_types = [node for node in operation_types if node.type is not None]
        if operation_types:
            definitions.insert(
                0,
                SchemaDefinitionNode(
                    directives=tuple(schema_directives),
                    operation_types=tuple(operation_types),
                ),
            )

    return print_ast(DocumentNode(definitions=tuple(definitions)))


# ===========================================================================
# Directive application re-attachment for emitted SDL (extras → SDL)
# ===========================================================================


def _parse_directive_strings(rendered: Sequence[str]) -> List[DirectiveNode]:
    """Parse printed applied-directive strings (``@auth(role: "admin")``) to AST nodes.

    Invalid entries are skipped — the caller records the skip as a loss.
    """
    nodes: List[DirectiveNode] = []
    for text in rendered:
        if not isinstance(text, str) or not text.strip().startswith("@"):
            continue
        try:
            probe = parse(f"scalar __ApiomeDirectiveProbe {text}")
        except Exception:  # noqa: BLE001 - unparseable extras entry: skip
            continue
        definition = probe.definitions[0]
        nodes.extend(getattr(definition, "directives", ()) or ())
    return nodes


def _synthesized_schema_definition(
    document: DocumentNode,
) -> Optional[SchemaDefinitionNode]:
    """A ``schema { query: Query … }`` node for a document printed without one.

    ``print_schema`` omits the schema block when every root uses its default
    name; schema-level directive attachment needs the node back. Returns
    ``None`` when the document has no default-named root types at all.
    """
    default_roots = {
        "Query": OperationType.QUERY,
        "Mutation": OperationType.MUTATION,
        "Subscription": OperationType.SUBSCRIPTION,
    }
    operation_types: List[OperationTypeDefinitionNode] = []
    for definition in document.definitions:
        if not isinstance(definition, ObjectTypeDefinitionNode):
            continue
        operation = default_roots.get(definition.name.value)
        if operation is None:
            continue
        operation_types.append(
            OperationTypeDefinitionNode(
                operation=operation, type=NamedTypeNode(name=definition.name)
            )
        )
    if not operation_types:
        return None
    return SchemaDefinitionNode(
        directives=(), operation_types=tuple(operation_types)
    )


def attach_directive_applications(
    sdl: str,
    applications: Mapping[str, Sequence[str]],
) -> Tuple[str, List[str]]:
    """Re-attach applied directives (as printed SDL strings) onto SDL coordinates.

    The :mod:`app.graphql_emitter` counterpart of
    :func:`print_schema_with_directives`: the emitter builds its schema
    programmatically (so applications cannot survive ``print_schema``) and the
    canonical model carries them as printed strings in ``extras`` — this
    parses the emitted SDL, attaches each application at its coordinate, and
    re-prints. Directives whose *definition* is absent from the document (and
    which are not spec built-ins) are skipped so the output stays buildable;
    the final document is re-validated and, on any error, the original SDL is
    returned untouched with everything reported as skipped.

    Args:
        sdl: The emitted SDL document.
        applications: Coordinate → printed directive strings. Coordinates:
            ``""`` (schema level), ``TypeName``, or ``TypeName.childName``
            (field / input field / enum value).

    Returns:
        ``(new_sdl, skipped)`` where ``skipped`` lists human-readable reasons
        for applications that could not be attached.
    """
    if not applications:
        return sdl, []
    try:
        document = parse(sdl)
    except Exception:  # noqa: BLE001 - emitted SDL should always parse; degrade if not
        dropped = sum(len(rendered) for rendered in applications.values())
        return sdl, [
            f"emitted SDL did not parse; {dropped} directive application(s) dropped"
        ]

    defined_directives = {
        definition.name.value
        for definition in document.definitions
        if definition.kind == "directive_definition"
    } | {"deprecated", "specifiedBy", "skip", "include", "oneOf"}

    skipped: List[str] = []

    def _attachable(coordinate: str, rendered: Sequence[str]) -> Tuple[DirectiveNode, ...]:
        nodes = _parse_directive_strings(rendered)
        if len(nodes) < len([r for r in rendered if isinstance(r, str) and r.strip()]):
            skipped.append(f"{coordinate or '(schema)'}: unparseable directive application")
        kept: List[DirectiveNode] = []
        for node in nodes:
            if node.name.value not in defined_directives:
                skipped.append(
                    f"{coordinate or '(schema)'}: @{node.name.value} has no directive "
                    "definition in the emitted document"
                )
                continue
            kept.append(node)
        return tuple(kept)

    type_nodes: Dict[str, Node] = {}
    for definition in document.definitions:
        if isinstance(definition, TypeDefinitionNode):
            type_nodes[definition.name.value] = definition

    attached_any = False
    for coordinate, rendered in applications.items():
        nodes = _attachable(coordinate, rendered)
        if not nodes:
            continue
        if coordinate == "":
            target: Optional[Node] = next(
                (d for d in document.definitions if isinstance(d, SchemaDefinitionNode)),
                None,
            )
            if target is None:
                # print_schema omits the schema block when the roots use their
                # default names; synthesize one so schema-level directives
                # (e.g. a federation @link) still have a home.
                target = _synthesized_schema_definition(document)
                if target is None:
                    skipped.append("(schema): no schema definition block to attach to")
                    continue
                document = DocumentNode(definitions=(target, *document.definitions))
        elif "." in coordinate:
            type_name, child_name = coordinate.split(".", 1)
            parent = type_nodes.get(type_name)
            target = None
            if parent is not None:
                children = list(getattr(parent, "fields", ()) or ()) + list(
                    getattr(parent, "values", ()) or ()
                )
                target = next(
                    (c for c in children if c.name.value == child_name), None
                )
            if target is None:
                skipped.append(f"{coordinate}: coordinate not present in emitted SDL")
                continue
        else:
            target = type_nodes.get(coordinate)
            if target is None:
                skipped.append(f"{coordinate}: coordinate not present in emitted SDL")
                continue
        existing = tuple(getattr(target, "directives", ()) or ())
        existing_rendered = {print_ast(node) for node in existing}
        additions = tuple(
            node for node in nodes if print_ast(node) not in existing_rendered
        )
        if not additions:
            continue
        target.directives = existing + additions  # type: ignore[attr-defined]
        attached_any = True

    if not attached_any:
        return sdl, skipped

    errors = validate_sdl(document)
    if errors:
        return sdl, [
            f"attached directives failed SDL validation ({errors[0].message}); "
            "emitted without applied directives"
        ]
    return print_ast(document), skipped
