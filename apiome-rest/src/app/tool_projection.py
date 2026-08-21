"""Canonical model → provider-neutral tool definitions — FMT-2.5 (#5423).

The shared middle between every emitter that has to answer "what tools does this API
expose?": :mod:`app.llm_tools_emitter` renders these definitions as an OpenAI /
Anthropic / bare function-calling array, and the MCP tool-definition emitter
(MFX-32.1, #4295) is meant to render exactly the same definitions as MCP
``{name, description, inputSchema}`` entries. Both halves therefore agree on the one
thing they must never disagree about — *what a tool is called and what arguments it
takes* — because the derivation lives here and not in either renderer.

What this module owns
---------------------

* **Name derivation** (:class:`ToolNamer`) — a deterministic, collision-free,
  charset-legal tool name for one canonical operation or type. Names are stable
  across runs (no clocks, no randomness, no dict iteration order) because the
  provider caches on them and an agent's transcript references them.
* **Description assembly** (:func:`assemble_tool_description`) — ``summary`` plus
  ``description``, deduplicated, with a deprecation marker when a deprecated
  operation is deliberately included, and with any credential-shaped literal
  redacted (:func:`scrub_credentials`).
* **Schema flattening** (:class:`ToolSchemaBuilder`) — one self-contained JSON Schema
  object per tool, merging the operation's path, query and header parameters with its
  request body, inlining every named type (a tool schema has no component section to
  ``$ref`` into) and enforcing the provider constraints.
* **The constraint table** — name charset/length, nesting depth, and the strict
  structured-output schema subset — applied identically in every mode so a bundle
  emitted for one provider can be handed to the other unchanged.

What it deliberately does not own
---------------------------------

The *wire shape*. A tool definition here is ``(name, description, input_schema)``;
whether that becomes ``{"type": "function", "function": {…}}``,
``{"name": …, "input_schema": …}`` or an MCP listing entry is the renderer's business.

Nothing credential-shaped becomes a tool argument
-------------------------------------------------

A header or query parameter whose *name* says it carries a credential
(:data:`app.snippet_render.SECRET_HEADER_NAMES` /
:data:`~app.snippet_render.SECRET_QUERY_NAMES` — the same table the snippet renderer
and the request-file emitter use) is **omitted** from the argument schema and reported
as a loss. An agent's runtime supplies its own credentials on the transport; asking a
language model to produce one invites it to invent a plausible-looking secret, and the
tool definition is the wrong place to publish which secret a call needs. Cookie
parameters are omitted for the same reason: a cookie is transport state, not an
argument.
"""

from __future__ import annotations

import copy
import hashlib
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .canonical_model import (
    CanonicalApi,
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
from .emitter import LossKind, LossTracker, Provenance, SchemaEmitter
from .snippet_render import SECRET_HEADER_NAMES, SECRET_QUERY_NAMES

__all__ = [
    "TOOL_NAME_PATTERN",
    "DEFAULT_MAX_NAME_LENGTH",
    "DEFAULT_MAX_NESTING_DEPTH",
    "BODY_ARGUMENT_NAME",
    "STRICT_SUPPORTED_KEYWORDS",
    "EVENT_OPERATION_KINDS",
    "LOSS_BODY_NESTED",
    "LOSS_COOKIE_PARAMETER",
    "LOSS_CREDENTIAL_PARAMETER",
    "LOSS_CREDENTIAL_REDACTED",
    "LOSS_DEPRECATED_IN_DESCRIPTION",
    "LOSS_DEPRECATED_OPERATION",
    "LOSS_EVENT_OPERATION",
    "LOSS_FILTERED_OPERATION",
    "LOSS_NESTING_DEPTH",
    "LOSS_ONEOF_AS_ANYOF",
    "LOSS_REQUIRED_WITHOUT_PROPERTY",
    "LOSS_RESPONSE_SCHEMA",
    "LOSS_SCHEMA_CYCLE",
    "LOSS_SCHEMA_ONLY_TOOL",
    "LOSS_STREAMING_OPERATION",
    "LOSS_STRICT_KEYWORD",
    "LOSS_STRICT_OPTIONAL",
    "LOSS_TOOL_NAME_COLLISION",
    "LOSS_TOOL_NAME_SANITIZED",
    "LOSS_TOOL_NAME_TRUNCATED",
    "LOSS_UNRESOLVED_TYPE",
    "ToolDefinition",
    "ToolNamer",
    "ToolSchemaBuilder",
    "assemble_tool_description",
    "is_credential_parameter",
    "project_tools",
    "sanitize_tool_name",
    "scrub_credentials",
    "selectable_operations",
]


# ===========================================================================
# Provider constraints
# ===========================================================================

#: The tool-name grammar both OpenAI and Anthropic publish for a function/tool name.
#: Applied in every mode — including ``bare`` — so one emitted bundle can be handed to
#: either provider without renaming anything.
TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: Maximum tool-name length the providers accept.
DEFAULT_MAX_NAME_LENGTH = 64

#: Maximum schema nesting the providers accept for a tool's argument object. This is
#: the tightest published limit (OpenAI structured outputs), applied uniformly for the
#: same reason the name grammar is.
DEFAULT_MAX_NESTING_DEPTH = 5

#: Property name a request body is nested under when it cannot be merged flat.
BODY_ARGUMENT_NAME = "body"

#: The JSON-Schema keywords a strict (structured-output) tool schema may carry.
#: Everything else is dropped under ``strict_schema`` and reported as a loss — with
#: one exception: ``oneOf`` is *rewritten* to ``anyOf`` (see :data:`LOSS_ONEOF_AS_ANYOF`)
#: because dropping it would delete the alternatives rather than approximate them.
STRICT_SUPPORTED_KEYWORDS: frozenset = frozenset(
    {
        "$defs",
        "$ref",
        "additionalProperties",
        "anyOf",
        "const",
        "description",
        "enum",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "format",
        "items",
        "maxItems",
        "maxLength",
        "maximum",
        "minItems",
        "minLength",
        "minimum",
        "multipleOf",
        "pattern",
        "properties",
        "required",
        "title",
        "type",
    }
)

#: Operation kinds that describe an event flow rather than a callable request.
EVENT_OPERATION_KINDS = frozenset(
    {OperationKind.PUBLISH, OperationKind.SUBSCRIBE, OperationKind.SUBSCRIPTION}
)

#: Schema positions holding a *map* of nested schemas, each one level deeper than the
#: node that carries it.
_SCHEMA_MAP_POSITIONS: Tuple[str, ...] = (
    "properties",
    "patternProperties",
    "dependentSchemas",
    "$defs",
    "definitions",
)

#: Schema positions holding a single nested schema one level deeper.
_SCHEMA_NESTED_POSITIONS: Tuple[str, ...] = (
    "items",
    "additionalProperties",
    "contains",
    "unevaluatedItems",
    "unevaluatedProperties",
)

#: Schema positions holding a single schema at the *same* depth — a composition or an
#: applicator constrains the node it sits on rather than adding a level of nesting.
_SCHEMA_SAME_DEPTH_POSITIONS: Tuple[str, ...] = (
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
)

#: Composition positions holding a list of alternatives at the same depth as their
#: parent — an ``anyOf`` branch is not an extra level of object nesting.
_SCHEMA_LIST_POSITIONS: Tuple[str, ...] = ("anyOf", "oneOf", "allOf")

#: List positions whose members *are* one level deeper (tuple-typed arrays).
_SCHEMA_DEEPER_LIST_POSITIONS: Tuple[str, ...] = ("prefixItems", "items")

#: Ref prefix the internal :class:`~app.emitter.SchemaEmitter` uses before inlining.
#: It is deliberately not ``#/$defs/`` or ``#/components/schemas/``: a schema that
#: arrived verbatim from an imported tool bundle may carry references of its own, and
#: those must pass through untouched rather than be resolved against ``api.types``.
#: Every ref with *this* prefix is resolved away, so none reaches the output.
_REF_PREFIX = "#/x-apiome-inline/"


# ===========================================================================
# Loss subjects (shared vocabulary so both renderers report the same slugs)
# ===========================================================================

LOSS_TOOL_NAME_SANITIZED = "tool-name-sanitized"
LOSS_TOOL_NAME_TRUNCATED = "tool-name-truncated"
LOSS_TOOL_NAME_COLLISION = "tool-name-collision"
LOSS_CREDENTIAL_PARAMETER = "credential-parameter-omitted"
LOSS_COOKIE_PARAMETER = "cookie-parameter-omitted"
LOSS_BODY_NESTED = "body-nested-on-collision"
LOSS_SCHEMA_CYCLE = "schema-cycle"
LOSS_UNRESOLVED_TYPE = "unresolved-type-reference"
LOSS_NESTING_DEPTH = "nesting-depth-exceeded"
LOSS_REQUIRED_WITHOUT_PROPERTY = "required-without-property"
LOSS_STRICT_KEYWORD = "strict-schema-keyword-dropped"
LOSS_STRICT_OPTIONAL = "strict-schema-optional-required"
LOSS_ONEOF_AS_ANYOF = "oneof-as-anyof"
LOSS_CREDENTIAL_REDACTED = "credential-redacted"
LOSS_DEPRECATED_IN_DESCRIPTION = "deprecated-flag-in-description"
LOSS_RESPONSE_SCHEMA = "response-schema"
LOSS_EVENT_OPERATION = "event-operation"
LOSS_STREAMING_OPERATION = "streaming-operation"
LOSS_DEPRECATED_OPERATION = "deprecated-operation-omitted"
LOSS_FILTERED_OPERATION = "filtered-operation"
LOSS_SCHEMA_ONLY_TOOL = "synthesized-schema-tool"


# ===========================================================================
# Credential hygiene
# ===========================================================================

#: ``https://user:secret@host`` — the one credential spelling that can realistically
#: reach a description through a source document's prose, and the only one redacted by
#: pattern (a heuristic over free text would redact ordinary words).
_URL_USERINFO = re.compile(r"(?<=://)[^/\s@]+:[^/\s@]*@")

#: A literal bearer credential (``Bearer eyJhbGciOi…``). Sixteen characters is long
#: enough that ``Bearer token`` — prose, not a secret — is left alone.
_BEARER_LITERAL = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}")

#: Replacement written in place of anything redacted.
_REDACTED = "[redacted]"


def scrub_credentials(text: str) -> Tuple[str, int]:
    """Redact credential literals from human-facing text.

    A tool description is published to a language model and, from there, into
    transcripts and provider logs. Two spellings can carry a real secret out of a
    source document: a URL with ``user:password@`` userinfo, and a literal
    ``Bearer <token>``. Both are replaced with ``[redacted]``.

    Args:
        text: The description text to clean.

    Returns:
        ``(cleaned_text, redaction_count)``. The count is zero for the overwhelmingly
        common case, which lets the caller record a loss only when something was
        actually removed.
    """
    if not text:
        return text, 0
    cleaned, userinfo = _URL_USERINFO.subn(_REDACTED + "@", text)
    cleaned, bearer = _BEARER_LITERAL.subn("Bearer " + _REDACTED, cleaned)
    return cleaned, userinfo + bearer


def is_credential_parameter(parameter: Parameter) -> bool:
    """Whether a parameter's *name* says it carries a credential.

    Reuses the tables :mod:`app.snippet_render` already applies to headers and query
    parameters (themselves a port of the browse Try-It secret rules), so "what counts
    as a credential" is decided in one place across snippets, request files and tool
    definitions.

    Args:
        parameter: The canonical parameter to classify.

    Returns:
        ``True`` when the parameter carries a credential and must not become a tool
        argument.
    """
    if parameter.location is ParameterLocation.HEADER:
        return bool(SECRET_HEADER_NAMES.fullmatch(parameter.name))
    if parameter.location is ParameterLocation.QUERY:
        return bool(SECRET_QUERY_NAMES.fullmatch(parameter.name))
    return False


# ===========================================================================
# Names
# ===========================================================================

_ILLEGAL_NAME_CHARS = re.compile(r"[^A-Za-z0-9_-]+")


def sanitize_tool_name(raw: str) -> str:
    """Fold arbitrary identity text into the provider tool-name charset.

    Every run of characters outside ``[A-Za-z0-9_-]`` becomes a single ``_`` and the
    result is stripped of leading/trailing separators, so ``GET /pets/{id}`` becomes
    ``GET_pets_id`` and ``Query.user`` becomes ``Query_user``. Case is **preserved**:
    folding it would merge ``getPet`` and ``GetPet`` into one name, and a bundle
    imported from an existing tool array must come back out under the names it
    arrived with.

    Args:
        raw: Any identity text (an ``operationId``, an operation name, a canonical key).

    Returns:
        A charset-legal fragment, or ``""`` when ``raw`` contains no legal character.
    """
    return _ILLEGAL_NAME_CHARS.sub("_", raw or "").strip("_-")


def _truncate_name(name: str, max_length: int) -> str:
    """Shorten ``name`` to ``max_length``, keeping it unique and deterministic.

    The tail is replaced with eight hex characters of the full name's SHA-256, so two
    long names sharing a prefix do not collapse onto each other and the same input
    always produces the same output.
    """
    if len(name) <= max_length:
        return name
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]
    keep = max(1, max_length - len(digest) - 1)
    return f"{name[:keep]}_{digest}"


@dataclass
class _NameOutcome:
    """One derived name plus how far it drifted from the source identity."""

    name: str
    sanitized: bool = False
    truncated: bool = False
    deduplicated: bool = False

    @property
    def provenance(self) -> Provenance:
        """``SOURCE`` when the identity survived verbatim, else ``INFERRED``."""
        if self.sanitized or self.truncated or self.deduplicated:
            return Provenance.INFERRED
        return Provenance.SOURCE


class ToolNamer:
    """Derive deterministic, collision-free, charset-legal tool names.

    One namer instance serves one emitted document: it remembers the names it has
    already handed out so the second tool that wants ``create_ticket`` becomes
    ``create_ticket_2`` rather than shadowing the first. Because it is fed operations
    in canonical (key-sorted) order, the same model always produces the same names —
    which matters more than it looks, since a provider caches on the tool name and an
    agent transcript refers to a call by it.

    Args:
        max_length: Longest name the target accepts.
        fallback: Name stem used when an identity sanitizes to nothing at all.
    """

    def __init__(self, *, max_length: int = DEFAULT_MAX_NAME_LENGTH, fallback: str = "tool") -> None:
        if max_length < 12:
            raise ValueError("max_length must leave room for a disambiguating suffix (>= 12)")
        self._max_length = max_length
        self._fallback = fallback
        self._taken: Dict[str, str] = {}

    @property
    def taken(self) -> Dict[str, str]:
        """Mapping of every emitted name to the source key that claimed it."""
        return dict(self._taken)

    def name_for(self, identity: str, *, source_key: str) -> _NameOutcome:
        """Return the tool name for one source identity, claiming it for ``source_key``.

        Args:
            identity: The name the source gave this callable (an ``operationId``, an
                operation name, a type name).
            source_key: Canonical key of the construct being named, used for the
                loss/provenance coordinate and recorded as the claim on the name.

        Returns:
            A :class:`_NameOutcome` carrying the final name and the adjustments made.
        """
        stem = sanitize_tool_name(identity)
        outcome = _NameOutcome(name=stem or self._fallback)
        outcome.sanitized = stem != (identity or "")
        if not stem:
            outcome.sanitized = True

        truncated = _truncate_name(outcome.name, self._max_length)
        outcome.truncated = truncated != outcome.name
        outcome.name = truncated

        if outcome.name in self._taken:
            base = outcome.name
            suffix = 2
            while True:
                tail = f"_{suffix}"
                candidate = _truncate_name(base, self._max_length - len(tail)) + tail
                if candidate not in self._taken:
                    break
                suffix += 1
            outcome.name = candidate
            outcome.deduplicated = True

        self._taken[outcome.name] = source_key
        return outcome


# ===========================================================================
# Descriptions
# ===========================================================================

#: Prefix stamped on a deprecated operation's description. A tool object has no
#: ``deprecated`` keyword in any provider dialect, so the only way to tell a model that
#: a tool is on the way out is to say so in the text it reads.
DEPRECATION_PREFIX = "Deprecated."


def assemble_tool_description(
    *,
    summary: Optional[str],
    description: Optional[str],
    deprecated: bool = False,
) -> Tuple[Optional[str], int]:
    """Compose the description a model reads when deciding whether to call a tool.

    The summary leads (it is the one-line "what this does" a catalog already curated)
    and the longer description follows, unless it merely repeats the summary — which is
    the common case for an OpenAPI operation that declares only one of the two, because
    the normalizer copies ``summary`` into ``description`` when ``description`` is
    absent.

    Args:
        summary: The source's short summary, when it has one.
        description: The source's long description, when it has one.
        deprecated: Whether to stamp the :data:`DEPRECATION_PREFIX` on the front.

    Returns:
        ``(description_text_or_None, redaction_count)`` — the text a renderer should
        emit, and how many credential literals :func:`scrub_credentials` removed from it.
    """
    head = (summary or "").strip()
    tail = (description or "").strip()
    if head and tail:
        # Whichever text already contains the other is the one to keep: an OpenAPI
        # operation that declares only a summary comes through the normalizer with both
        # fields set to the same string, and a description that opens with its summary
        # is one sentence, not two paragraphs.
        if tail.startswith(head):
            text = tail
        elif head.startswith(tail):
            text = head
        else:
            text = f"{head}\n\n{tail}"
    else:
        text = head or tail

    if not text:
        return (DEPRECATION_PREFIX if deprecated else None), 0

    if deprecated:
        text = f"{DEPRECATION_PREFIX} {text}"
    return scrub_credentials(text)


# ===========================================================================
# Tool definitions
# ===========================================================================


@dataclass(frozen=True)
class ToolDefinition:
    """One provider-neutral tool: what it is called, what it does, what it takes.

    Attributes:
        name: The emitted tool name — charset-legal, unique within the document, and
            stable across runs.
        description: Text the model reads when choosing the tool, or ``None`` when the
            source documented nothing (a renderer emits no description key rather than
            an empty string, which reads as "documented as blank").
        input_schema: A self-contained JSON Schema object describing the arguments. It
            never contains a ``$ref`` into a component section the tool array does not
            have.
        source_key: Canonical key of the operation (or type) the tool came from — the
            coordinate a loss or provenance note points at.
        source_name: The identity the name was derived from, before sanitization.
        name_provenance: ``SOURCE`` when the source's identity survived verbatim,
            ``INFERRED`` when it had to be sanitized, truncated or disambiguated.
        description_provenance: ``SOURCE`` when the text came from the model,
            ``DEFAULT`` when there was nothing to say.
        schema_provenance: ``SOURCE`` when the argument schema came through verbatim
            from an imported tool bundle, ``INFERRED`` when it was assembled from the
            operation's parameters and body.
    """

    name: str
    description: Optional[str]
    input_schema: Dict[str, Any]
    source_key: str
    source_name: str
    name_provenance: Provenance = Provenance.SOURCE
    description_provenance: Provenance = Provenance.SOURCE
    schema_provenance: Provenance = Provenance.INFERRED


# ===========================================================================
# Schema flattening
# ===========================================================================

#: Parameter locations that become tool arguments, in the order they are merged.
_MERGED_LOCATIONS: Tuple[ParameterLocation, ...] = (
    ParameterLocation.PATH,
    ParameterLocation.QUERY,
    ParameterLocation.HEADER,
)


class ToolSchemaBuilder:
    """Build one self-contained argument schema per operation or type.

    A tool array has no component section, so every named type reference is **inlined**
    and a reference that revisits a type already on the inlining stack is a cycle the
    format cannot express — reported as a loss and replaced with a free-form object,
    never emitted as a dangling ``$ref``. The provider constraints (nesting depth, and
    under ``strict`` the structured-output keyword subset) are applied to the finished
    schema so they hold however the schema was assembled.

    Args:
        api: The model being emitted; supplies the named types to inline against.
        losses: Sink for every construct a constraint drops.
        strict: Whether to emit the strict structured-output subset — closed objects,
            every property required, and only :data:`STRICT_SUPPORTED_KEYWORDS`.
        max_depth: Deepest schema nesting the target accepts.
    """

    def __init__(
        self,
        api: CanonicalApi,
        *,
        losses: LossTracker,
        strict: bool = False,
        max_depth: int = DEFAULT_MAX_NESTING_DEPTH,
    ) -> None:
        self._types: Dict[str, Type] = {type_.key: type_ for type_ in api.types}
        self._losses = losses
        self._strict = strict
        self._max_depth = max_depth
        self._schema = SchemaEmitter(ref_prefix=_REF_PREFIX)

    # --- entry points -------------------------------------------------------

    def for_operation(self, operation: Operation) -> Tuple[Dict[str, Any], Provenance]:
        """Build the argument schema for one operation.

        An operation imported *from* a tool bundle already carries the exact schema the
        bundle declared (``extras["input_schema"]``); that schema is used verbatim so a
        bundle re-emitted from Apiome is the bundle that went in, not a reconstruction
        of it. Everything else is assembled from the operation's parameters and request
        body.

        Args:
            operation: The operation to describe.

        Returns:
            ``(schema, provenance)`` — the argument object and whether it came from the
            source verbatim (``SOURCE``) or was assembled (``INFERRED``).
        """
        verbatim = self._verbatim_schema(operation)
        if verbatim is not None:
            return self._finish(verbatim, subject=operation.key), Provenance.SOURCE
        return (
            self._finish(self._assemble(operation), subject=operation.key),
            Provenance.INFERRED,
        )

    def for_type(self, type_: Type) -> Dict[str, Any]:
        """Build the argument schema for a named type (the schema-only projection).

        Args:
            type_: The record type whose members become the tool's arguments.

        Returns:
            A self-contained argument object.
        """
        schema = self._inline(
            self._schema.named_schema(type_),
            subject=type_.key,
            stack=(type_.key,),
        )
        return self._finish(schema, subject=type_.key)

    # --- assembly -----------------------------------------------------------

    @staticmethod
    def _verbatim_schema(operation: Operation) -> Optional[Dict[str, Any]]:
        """Return the imported tool bundle's own argument schema, when there is one."""
        extras = operation.extras or {}
        schema = extras.get("input_schema")
        if isinstance(schema, dict):
            return copy.deepcopy(schema)
        for message in operation.messages:
            candidate = (message.extras or {}).get("llm_tools_parameters")
            if isinstance(candidate, dict):
                return copy.deepcopy(candidate)
        return None

    def _assemble(self, operation: Operation) -> Dict[str, Any]:
        """Merge an operation's parameters and request body into one argument object."""
        properties: Dict[str, Any] = {}
        required: List[str] = []

        for location in _MERGED_LOCATIONS:
            for parameter in operation.parameters:
                if parameter.location is not location:
                    continue
                if is_credential_parameter(parameter):
                    self._losses.record(
                        LossKind.NA,
                        LOSS_CREDENTIAL_PARAMETER,
                        f"{parameter.location.value} parameter {parameter.name!r} on "
                        f"{operation.key!r} carries a credential; a tool definition "
                        "publishes arguments a model may fill in, and a credential is "
                        "supplied by the agent runtime instead.",
                        pointer=parameter.key,
                    )
                    continue
                properties[parameter.name] = self._parameter_schema(parameter)
                if parameter.required or parameter.location is ParameterLocation.PATH:
                    required.append(parameter.name)

        for parameter in operation.parameters:
            if parameter.location is ParameterLocation.COOKIE:
                self._losses.record(
                    LossKind.NA,
                    LOSS_COOKIE_PARAMETER,
                    f"Cookie parameter {parameter.name!r} on {operation.key!r} is "
                    "transport state, not a tool argument, so it is omitted.",
                    pointer=parameter.key,
                )

        message = _request_message(operation)
        body = self._body_schema(message)
        if body is not None:
            self._merge_body(
                body,
                properties,
                required,
                operation=operation,
                required_body=bool(message.required) if message is not None else False,
            )

        schema: Dict[str, Any] = {"type": "object", "properties": properties}
        if required:
            schema["required"] = required
        return schema

    def _parameter_schema(self, parameter: Parameter) -> Dict[str, Any]:
        """Emit one non-body parameter as a property schema."""
        fragment = self._inline(self._schema.type_ref(parameter.type), subject=parameter.key)
        if "$ref" not in fragment:
            fragment.update(_constraint_keywords(parameter.constraints))
            if parameter.default is not None:
                fragment["default"] = parameter.default
            description, redacted = scrub_credentials(parameter.description or "")
            if description:
                fragment["description"] = description
            self._note_redactions(redacted, parameter.key)
        return fragment

    def _body_schema(self, message: Optional[Message]) -> Optional[Dict[str, Any]]:
        """Resolve a request message into an inlined schema, if it carries one."""
        if message is None:
            return None
        if isinstance(message.payload_schema, dict):
            return self._inline(copy.deepcopy(message.payload_schema), subject=message.key)
        if message.payload is not None:
            return self._inline(self._schema.type_ref(message.payload), subject=message.key)
        return None

    def _merge_body(
        self,
        body: Dict[str, Any],
        properties: Dict[str, Any],
        required: List[str],
        *,
        operation: Operation,
        required_body: bool,
    ) -> None:
        """Fold the request body into the argument object.

        An object body is merged **flat** — an agent calls ``create_pet(name=…)``, not
        ``create_pet(body={name: …})``. Two things force the nested spelling instead: a
        body that is not an object (an array or a scalar has no properties to merge),
        and a body property whose name is already taken by a path/query/header
        parameter. Splitting the body across both spellings would be worse than either,
        so a single collision nests the whole body and says so.

        Args:
            body: The inlined request-body schema.
            properties: The argument object's properties, mutated in place.
            required: The argument object's required names, mutated in place.
            operation: The operation being described, for the loss coordinate.
            required_body: Whether the source marked the request body required.
        """
        body_properties = body.get("properties")
        if body.get("type") == "object" and isinstance(body_properties, dict):
            collisions = sorted(set(body_properties) & set(properties))
            if not collisions:
                body_required = body.get("required")
                required_names = set(body_required) if isinstance(body_required, list) else set()
                for name, schema in body_properties.items():
                    properties[name] = schema
                    if name in required_names:
                        required.append(name)
                return
            self._losses.record(
                LossKind.INFERRED,
                LOSS_BODY_NESTED,
                f"Request body properties {', '.join(repr(c) for c in collisions)} on "
                f"{operation.key!r} collide with a parameter of the same name, so the "
                f"whole body is nested under {BODY_ARGUMENT_NAME!r} instead of merged.",
                pointer=operation.key,
            )

        properties[BODY_ARGUMENT_NAME] = body
        if required_body:
            required.append(BODY_ARGUMENT_NAME)

    def _note_redactions(self, count: int, pointer: str) -> None:
        """Record that :func:`scrub_credentials` removed something at ``pointer``."""
        if count:
            self._losses.record(
                LossKind.INFERRED,
                LOSS_CREDENTIAL_REDACTED,
                f"{count} credential literal(s) were redacted from the text at "
                f"{pointer!r} before it was published to a tool definition.",
                pointer=pointer,
            )

    # --- inlining + constraint enforcement ----------------------------------

    def _inline(
        self,
        node: Any,
        *,
        subject: str,
        stack: Tuple[str, ...] = (),
    ) -> Dict[str, Any]:
        """Resolve every internal ``$ref`` in ``node`` against the model's named types.

        Walks the *schema* positions explicitly (a ``properties`` map holds property
        names, not keywords), so a property that happens to be called ``items`` or
        ``type`` is never mistaken for the keyword of the same name. Depth is **not**
        this pass's business: a body may end up merged flat or nested one level down, so
        the level a node finally sits at is only known once the argument object is
        assembled, and :meth:`_limit_depth` enforces the limit there.

        Args:
            node: A JSON-Schema fragment, possibly carrying internal ``$ref``s.
            subject: Canonical coordinate reported with any loss this walk records.
            stack: Type keys currently being inlined, for cycle detection.

        Returns:
            A fragment with no internal ``$ref``.
        """
        if not isinstance(node, dict):
            return {}

        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith(_REF_PREFIX):
            return self._inline_ref(node, ref, subject=subject, stack=stack)

        def descend(value: Any) -> Any:
            return self._inline(value, subject=subject, stack=stack)

        out: Dict[str, Any] = {}
        for key, value in node.items():
            if key in _SCHEMA_MAP_POSITIONS and isinstance(value, dict):
                out[key] = {child: descend(schema) for child, schema in value.items()}
            elif (
                key in _SCHEMA_DEEPER_LIST_POSITIONS or key in _SCHEMA_LIST_POSITIONS
            ) and isinstance(value, list):
                out[key] = [descend(item) for item in value]
            elif (
                key in _SCHEMA_NESTED_POSITIONS
                or key in _SCHEMA_DEEPER_LIST_POSITIONS
                or key in _SCHEMA_SAME_DEPTH_POSITIONS
            ) and isinstance(value, dict):
                out[key] = descend(value)
            else:
                out[key] = copy.deepcopy(value)
        return out

    def _inline_ref(
        self,
        node: Mapping[str, Any],
        ref: str,
        *,
        subject: str,
        stack: Tuple[str, ...],
    ) -> Dict[str, Any]:
        """Replace one internal ``$ref`` with the referenced type's schema."""
        key = ref[len(_REF_PREFIX) :]
        if key in stack:
            self._losses.record(
                LossKind.NA,
                LOSS_SCHEMA_CYCLE,
                f"Type {key!r} reached under {subject!r} refers back to itself; a tool "
                "schema is self-contained and cannot express the cycle, so the "
                "recursion point becomes a free-form node.",
                pointer=subject,
            )
            return self._free_form()
        target = self._types.get(key)
        if target is None:
            self._losses.record(
                LossKind.NA,
                LOSS_UNRESOLVED_TYPE,
                f"Type {key!r} referenced under {subject!r} is not defined by the model, "
                "so its structure is unknown and becomes a free-form node.",
                pointer=subject,
            )
            return self._free_form()
        resolved = self._schema.named_schema(target)
        siblings = {k: copy.deepcopy(v) for k, v in node.items() if k != "$ref"}
        return self._inline(
            {**resolved, **siblings},
            subject=subject,
            stack=stack + (key,),
        )

    def _limit_depth(self, node: Any, *, subject: str, depth: int = 1) -> None:
        """Prune anything nested past the provider's limit, in place.

        Run once over the *finished* argument object, which is the only point at which
        every node's final level is known — a request body is one level deeper when a
        name collision forced it under :data:`BODY_ARGUMENT_NAME` than when it merged
        flat. A node at the limit keeps its own keywords and loses its nested positions,
        which leaves it free-form rather than invalid, and any ``required`` name the
        pruning orphaned is dropped with it.

        Args:
            node: The schema node to limit.
            subject: Canonical coordinate reported with any loss this pass records.
            depth: Nesting level of ``node`` itself (the root argument object is 1).
        """
        if not isinstance(node, dict):
            return

        can_nest = depth + 1 <= self._max_depth
        pruned: List[str] = []
        for key in list(node):
            value = node[key]
            nests = (
                key in _SCHEMA_MAP_POSITIONS
                or key in _SCHEMA_DEEPER_LIST_POSITIONS
                or key in _SCHEMA_NESTED_POSITIONS
            )
            if nests and isinstance(value, (dict, list)):
                if not can_nest:
                    pruned.append(key)
                    del node[key]
                    continue
                step = 1
            elif (
                key in _SCHEMA_LIST_POSITIONS or key in _SCHEMA_SAME_DEPTH_POSITIONS
            ) and isinstance(value, (dict, list)):
                step = 0
            else:
                continue

            if isinstance(value, dict) and key in _SCHEMA_MAP_POSITIONS:
                for child in value.values():
                    self._limit_depth(child, subject=subject, depth=depth + step)
            elif isinstance(value, list):
                for item in value:
                    self._limit_depth(item, subject=subject, depth=depth + step)
            else:
                self._limit_depth(value, subject=subject, depth=depth + step)

        if pruned:
            self._losses.record(
                LossKind.NA,
                LOSS_NESTING_DEPTH,
                f"A schema under {subject!r} nests deeper than the {self._max_depth}-level "
                f"limit a tool schema may carry; {', '.join(repr(key) for key in sorted(pruned))} "
                f"at level {depth} and everything below it is dropped.",
                pointer=subject,
            )
        self._reconcile_required(node, subject=subject)

    def _reconcile_required(self, node: Dict[str, Any], *, subject: str) -> None:
        """Drop ``required`` entries that name no declared property.

        Both providers read ``required`` against ``properties``, so a name with no
        property behind it is rejected rather than ignored. Two things produce one: a
        source schema that declares ``required`` without the matching property, and the
        depth limit pruning a ``properties`` map away. Either way the stale name is
        removed and reported, because a required argument silently disappearing is the
        kind of change a caller needs to see.
        """
        required = node.get("required")
        if not isinstance(required, list):
            return
        properties = node.get("properties")
        declared = set(properties) if isinstance(properties, dict) else set()
        kept = [name for name in required if name in declared]
        if len(kept) == len(required):
            return
        stale = [name for name in required if name not in declared]
        if kept:
            node["required"] = kept
        else:
            del node["required"]
        self._losses.record(
            LossKind.NA,
            LOSS_REQUIRED_WITHOUT_PROPERTY,
            f"Required argument(s) {', '.join(repr(name) for name in stale)} under "
            f"{subject!r} have no declared property behind them, so the requirement is "
            "dropped rather than emitted against a property the provider cannot find.",
            pointer=subject,
        )

    def _free_form(self) -> Dict[str, Any]:
        """The stand-in for a structure this target cannot carry.

        Ordinary JSON Schema spells "any value" as ``{}``, which is exactly the claim to
        make about a cycle or an unmodelled type: the emitter does not know the shape,
        so it constrains nothing. A strict schema has no such spelling — every node
        needs a type — so strict mode falls back to an object, which the closing pass
        finishes as an empty closed object. Either way the substitution is recorded as a
        loss by the caller.
        """
        return {"type": "object"} if self._strict else {}

    def _finish(self, schema: Dict[str, Any], *, subject: str) -> Dict[str, Any]:
        """Apply the whole-schema constraints and return the argument object.

        The root is coerced to an object — both providers require the argument schema to
        *be* one — the nesting limit is enforced over the assembled result, and then,
        under ``strict``, the structured-output subset is applied:
        unsupported keywords are dropped, ``oneOf`` is rewritten to ``anyOf``, every
        object is closed, and every property is listed as required with the optional
        ones widened to accept ``null``.

        Args:
            schema: The assembled (or verbatim) argument schema.
            subject: Canonical coordinate reported with any loss this step records.

        Returns:
            The finished argument object.
        """
        schema = _as_object_root(schema)
        self._limit_depth(schema, subject=subject)
        if not self._strict:
            return schema
        schema = self._strict_keywords(schema, subject=subject)
        schema = _as_object_root(schema)
        self._close_objects(schema, subject=subject)
        return schema

    def _strict_keywords(self, node: Any, *, subject: str) -> Any:
        """Drop keywords outside :data:`STRICT_SUPPORTED_KEYWORDS`, recursively.

        Only *keyword* positions are filtered. Property names are data, not keywords, so
        a ``properties`` map is recursed into by value and never pruned by key.
        """
        if not isinstance(node, dict):
            return node

        dropped: List[str] = []
        out: Dict[str, Any] = {}
        for key, value in node.items():
            target = key
            if key == "oneOf":
                target = "anyOf"
                self._losses.record(
                    LossKind.INFERRED,
                    LOSS_ONEOF_AS_ANYOF,
                    f"A `oneOf` under {subject!r} was rewritten as `anyOf`: a strict tool "
                    "schema has no `oneOf`, and widening the alternatives keeps them all "
                    "where dropping the keyword would delete them.",
                    pointer=subject,
                )
            elif key not in STRICT_SUPPORTED_KEYWORDS:
                dropped.append(key)
                continue

            if target in _SCHEMA_MAP_POSITIONS and isinstance(value, dict):
                out[target] = {
                    child: self._strict_keywords(schema, subject=subject)
                    for child, schema in value.items()
                }
            elif target in _SCHEMA_LIST_POSITIONS and isinstance(value, list):
                out[target] = [self._strict_keywords(item, subject=subject) for item in value]
            elif target in _SCHEMA_DEEPER_LIST_POSITIONS and isinstance(value, list):
                out[target] = [self._strict_keywords(item, subject=subject) for item in value]
            elif (
                target in _SCHEMA_NESTED_POSITIONS or target in _SCHEMA_SAME_DEPTH_POSITIONS
            ) and isinstance(value, dict):
                out[target] = self._strict_keywords(value, subject=subject)
            else:
                out[target] = value

        if dropped:
            self._losses.record(
                LossKind.NA,
                LOSS_STRICT_KEYWORD,
                "Strict tool schemas accept a fixed keyword subset; "
                f"{', '.join(repr(name) for name in sorted(dropped))} under {subject!r} "
                "is outside it and was dropped.",
                pointer=subject,
            )
        return out

    def _close_objects(self, node: Any, *, subject: str) -> None:
        """Close every object and require every property (the strict-mode contract).

        Mutates ``node`` in place, **children first**: a parent widens an optional
        property's ``type`` to accept ``null``, and a node whose type has already become
        a list would no longer be recognised as the object it is. An object with no
        ``properties`` at all — the free-form stand-in a cycle or a depth cut leaves
        behind — is closed as an empty object, which states honestly that the structure
        could not be carried rather than implying it accepts anything.
        """
        if not isinstance(node, dict):
            return

        for key, value in node.items():
            if key in _SCHEMA_MAP_POSITIONS and isinstance(value, dict):
                for child in value.values():
                    self._close_objects(child, subject=subject)
            elif (
                key in _SCHEMA_LIST_POSITIONS or key in _SCHEMA_DEEPER_LIST_POSITIONS
            ) and isinstance(value, list):
                for item in value:
                    self._close_objects(item, subject=subject)
            elif (
                key in _SCHEMA_NESTED_POSITIONS or key in _SCHEMA_SAME_DEPTH_POSITIONS
            ) and isinstance(value, dict):
                self._close_objects(value, subject=subject)

        if node.get("type") != "object" and not isinstance(node.get("properties"), dict):
            return

        properties = node.get("properties")
        if not isinstance(properties, dict):
            properties = {}
            node["properties"] = properties
        node["additionalProperties"] = False
        declared = node.get("required")
        already = set(declared) if isinstance(declared, list) else set()
        optional = [name for name in properties if name not in already]
        for name in optional:
            _widen_to_nullable(properties[name])
        if properties:
            node["required"] = list(properties)
        elif "required" in node:
            del node["required"]
        if optional:
            self._losses.record(
                LossKind.INFERRED,
                LOSS_STRICT_OPTIONAL,
                "A strict tool schema requires every property, so optional "
                f"{', '.join(repr(name) for name in optional)} under {subject!r} "
                "is listed as required and widened to accept null instead.",
                pointer=subject,
            )


def _as_object_root(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce an argument schema so its root *is* a JSON-Schema object.

    A schema that already says ``type: object`` is returned as-is (with a
    ``properties`` map, which both providers expect even when it is empty). A schema
    with no declared type is *labelled* an object rather than wrapped, because an
    untyped ``{}`` from a source tool bundle means "an argument object with nothing
    documented", not "one argument that happens to be untyped". Only an explicitly
    non-object root (an array, a scalar) is wrapped under
    :data:`BODY_ARGUMENT_NAME`, since it genuinely has no properties to merge.
    """
    declared = schema.get("type")
    if declared == "object" or declared is None:
        result = dict(schema)
        result["type"] = "object"
        result.setdefault("properties", {})
        return result
    return {"type": "object", "properties": {BODY_ARGUMENT_NAME: schema}}


def _widen_to_nullable(schema: Any) -> None:
    """Let ``schema`` accept ``null`` in place of being absent (strict-mode optionality)."""
    if not isinstance(schema, dict):
        return
    declared = schema.get("type")
    if isinstance(declared, str):
        if declared != "null":
            schema["type"] = [declared, "null"]
    elif isinstance(declared, list):
        if "null" not in declared:
            schema["type"] = [*declared, "null"]
    elif isinstance(schema.get("anyOf"), list):
        if not any(
            isinstance(branch, dict) and branch.get("type") == "null"
            for branch in schema["anyOf"]
        ):
            schema["anyOf"] = [*schema["anyOf"], {"type": "null"}]


def _constraint_keywords(constraints: Any) -> Dict[str, Any]:
    """Emit a :class:`~app.canonical_model.Constraints` as JSON-Schema keywords.

    Delegates to the shared :class:`~app.emitter.SchemaEmitter` by round-tripping a
    throwaway scalar type, so the constraint spellings stay identical to every other
    JSON-Schema-shaped target rather than being written a second time here.
    """
    if constraints is None:
        return {}
    scratch = Type(key="_c", name="_c", kind=TypeKind.SCALAR, constraints=constraints)
    return SchemaEmitter().named_schema(scratch)


def _request_message(operation: Operation) -> Optional[Message]:
    """Return the operation's request message, when it declares one."""
    for message in operation.messages:
        if message.role is MessageRole.REQUEST:
            return message
    return None


# ===========================================================================
# Operation selection
# ===========================================================================


def selectable_operations(
    api: CanonicalApi,
    *,
    tag: Optional[str] = None,
    path_prefix: Optional[str] = None,
    include_deprecated: bool = False,
    losses: Optional[LossTracker] = None,
) -> List[Tuple[Service, Operation]]:
    """Return the operations that become tools, in a deterministic order.

    Four things remove an operation from the tool array, and each one is reported so an
    absent tool is always explained:

    * an **event** operation (publish/subscribe/subscription) — an agent calls a tool
      and reads a result; there is no such exchange for an event flow;
    * a **streaming** operation — the tool-call protocols carry one request and one
      response, so a client/server/bidi stream has no representation;
    * a **deprecated** operation, unless ``include_deprecated`` says otherwise —
      publishing one to a model steers it at an endpoint the API is retiring;
    * an operation the caller's **tag / path-prefix filter** excludes.

    Args:
        api: The model to select from.
        tag: When set, keep only operations carrying this tag.
        path_prefix: When set, keep only operations whose HTTP path starts with it.
        include_deprecated: Whether deprecated operations become tools.
        losses: Optional sink for the exclusions.

    Returns:
        ``(service, operation)`` pairs, services sorted by key and operations sorted by
        key within each service.
    """
    selected: List[Tuple[Service, Operation]] = []
    filtered = 0
    for service in sorted(api.services, key=lambda item: item.key):
        for operation in sorted(service.operations, key=lambda item: item.key):
            if operation.kind in EVENT_OPERATION_KINDS:
                _record(
                    losses,
                    LossKind.NA,
                    LOSS_EVENT_OPERATION,
                    f"{operation.kind.value} operation {operation.key!r} describes an "
                    "event flow; a tool call is a request with a reply, so it has no "
                    "tool representation.",
                    operation.key,
                )
                continue
            if operation.streaming is not StreamingMode.NONE:
                _record(
                    losses,
                    LossKind.NA,
                    LOSS_STREAMING_OPERATION,
                    f"Operation {operation.key!r} streams "
                    f"({operation.streaming.value}); a tool call carries one request "
                    "and one response, so the streaming semantics cannot be expressed.",
                    operation.key,
                )
                continue
            if operation.deprecated and not include_deprecated:
                _record(
                    losses,
                    LossKind.NA,
                    LOSS_DEPRECATED_OPERATION,
                    f"Operation {operation.key!r} is deprecated and "
                    "`include_deprecated` is off, so it is not published to the model.",
                    operation.key,
                )
                continue
            if not _matches_filter(operation, tag=tag, path_prefix=path_prefix):
                filtered += 1
                continue
            selected.append((service, operation))

    if filtered:
        criteria = ", ".join(
            part
            for part in (
                f"tag={tag!r}" if tag else "",
                f"path_prefix={path_prefix!r}" if path_prefix else "",
            )
            if part
        )
        _record(
            losses,
            LossKind.NA,
            LOSS_FILTERED_OPERATION,
            f"{filtered} operation(s) were excluded by the emit filter ({criteria}).",
            None,
        )
    return selected


def _matches_filter(
    operation: Operation,
    *,
    tag: Optional[str],
    path_prefix: Optional[str],
) -> bool:
    """Whether an operation survives the caller's tag / path-prefix filter."""
    if tag is not None and tag not in operation.tags:
        return False
    if path_prefix is not None:
        path = operation.http_path or ""
        if not path.startswith(path_prefix):
            return False
    return True


def _record(
    losses: Optional[LossTracker],
    kind: LossKind,
    subject: str,
    detail: str,
    pointer: Optional[str],
) -> None:
    """Record a loss when a sink was supplied."""
    if losses is not None:
        losses.record(kind, subject, detail, pointer)


# ===========================================================================
# The projection
# ===========================================================================


def project_tools(
    api: CanonicalApi,
    *,
    losses: LossTracker,
    tag: Optional[str] = None,
    path_prefix: Optional[str] = None,
    include_deprecated: bool = False,
    strict_schema: bool = False,
    max_name_length: int = DEFAULT_MAX_NAME_LENGTH,
    max_depth: int = DEFAULT_MAX_NESTING_DEPTH,
) -> List[ToolDefinition]:
    """Project a canonical model into the tool definitions it exposes.

    Operations come first: every selected operation becomes exactly one tool. A model
    that declares **no operations at all** — a copybook, an Avro schema, a JSON Schema
    document — is projected from its record types instead, one tool per root record, so
    "hand me the tool definitions for this catalog entry" answers something for a
    schema-only entry rather than failing. That fallback is reported as a loss, because
    a synthesized "submit this record" tool is an inference, not something the source
    stated.

    Args:
        api: The canonical model to project.
        losses: Sink for every construct the projection could not carry.
        tag: Keep only operations carrying this tag.
        path_prefix: Keep only operations whose HTTP path starts with this prefix.
        include_deprecated: Whether deprecated operations become tools.
        strict_schema: Emit the strict structured-output schema subset.
        max_name_length: Longest tool name the target accepts.
        max_depth: Deepest schema nesting the target accepts.

    Returns:
        The tool definitions, in the order they should be emitted (deterministic).
    """
    namer = ToolNamer(max_length=max_name_length)
    builder = ToolSchemaBuilder(api, losses=losses, strict=strict_schema, max_depth=max_depth)
    selected = selectable_operations(
        api,
        tag=tag,
        path_prefix=path_prefix,
        include_deprecated=include_deprecated,
        losses=losses,
    )

    tools: List[ToolDefinition] = []
    for _service, operation in selected:
        tools.append(_tool_for_operation(operation, namer=namer, builder=builder, losses=losses))

    if not tools:
        tools.extend(_tools_for_types(api, namer=namer, builder=builder, losses=losses))
    return tools


def _tool_for_operation(
    operation: Operation,
    *,
    namer: ToolNamer,
    builder: ToolSchemaBuilder,
    losses: LossTracker,
) -> ToolDefinition:
    """Project one operation into a :class:`ToolDefinition`."""
    identity = _operation_identity(operation)
    outcome = namer.name_for(identity, source_key=operation.key)
    _record_name_losses(outcome, identity=identity, source_key=operation.key, losses=losses)

    extras = operation.extras or {}
    summary = extras.get("summary")
    description, redacted = assemble_tool_description(
        summary=summary if isinstance(summary, str) else None,
        description=operation.description,
        deprecated=operation.deprecated,
    )
    if redacted:
        losses.record(
            LossKind.INFERRED,
            LOSS_CREDENTIAL_REDACTED,
            f"{redacted} credential literal(s) were redacted from the description of "
            f"{operation.key!r} before it was published to a tool definition.",
            pointer=operation.key,
        )
    if operation.deprecated:
        losses.record(
            LossKind.INFERRED,
            LOSS_DEPRECATED_IN_DESCRIPTION,
            f"No tool dialect has a `deprecated` keyword, so the deprecation of "
            f"{operation.key!r} is carried as a marker in its description.",
            pointer=operation.key,
        )
    if any(message.role is MessageRole.RESPONSE for message in operation.messages):
        losses.record(
            LossKind.NA,
            LOSS_RESPONSE_SCHEMA,
            f"A tool definition declares inputs only, so the declared response of "
            f"{operation.key!r} is not carried.",
            pointer=operation.key,
        )

    schema, schema_provenance = builder.for_operation(operation)
    return ToolDefinition(
        name=outcome.name,
        description=description,
        input_schema=schema,
        source_key=operation.key,
        source_name=identity,
        name_provenance=outcome.provenance,
        description_provenance=(
            Provenance.SOURCE if description else Provenance.DEFAULT
        ),
        schema_provenance=schema_provenance,
    )


def _tools_for_types(
    api: CanonicalApi,
    *,
    namer: ToolNamer,
    builder: ToolSchemaBuilder,
    losses: LossTracker,
) -> List[ToolDefinition]:
    """Project a schema-only model's root record types into tools."""
    referenced = _referenced_type_keys(api.types)
    roots = [
        type_
        for type_ in sorted(api.types, key=lambda item: item.key)
        if type_.kind is TypeKind.RECORD and type_.key not in referenced
    ]
    if not roots:
        roots = [
            type_
            for type_ in sorted(api.types, key=lambda item: item.key)
            if type_.kind is TypeKind.RECORD
        ]

    tools: List[ToolDefinition] = []
    for type_ in roots:
        outcome = namer.name_for(type_.name or type_.key, source_key=type_.key)
        _record_name_losses(
            outcome, identity=type_.name or type_.key, source_key=type_.key, losses=losses
        )
        losses.record(
            LossKind.INFERRED,
            LOSS_SCHEMA_ONLY_TOOL,
            f"The model declares no operations, so type {type_.key!r} was projected as a "
            "tool that submits one instance of the record. The source states no such "
            "callable.",
            pointer=type_.key,
        )
        description, _ = assemble_tool_description(
            summary=None,
            description=type_.description or f"Submit a {type_.name} record.",
        )
        tools.append(
            ToolDefinition(
                name=outcome.name,
                description=description,
                input_schema=builder.for_type(type_),
                source_key=type_.key,
                source_name=type_.name or type_.key,
                name_provenance=outcome.provenance,
                description_provenance=(
                    Provenance.SOURCE if type_.description else Provenance.INFERRED
                ),
                schema_provenance=Provenance.INFERRED,
            )
        )
    return tools


def _referenced_type_keys(types: Sequence[Type]) -> set:
    """Keys of every type reached from another type (so the rest are roots)."""
    referenced: set = set()

    def visit(ref: Optional[TypeRef]) -> None:
        while ref is not None:
            if ref.name:
                referenced.add(ref.name)
            ref = ref.item

    for type_ in types:
        for member in type_.fields:
            visit(member.type)
        visit(type_.aliased)
        visit(type_.key_type)
        visit(type_.value_type)
        referenced.update(type_.union_members)
    return referenced


def _operation_identity(operation: Operation) -> str:
    """The name the source gave this callable, preferred over its canonical key."""
    extras = operation.extras or {}
    source = extras.get("operationId")
    if isinstance(source, str) and source.strip():
        return source.strip()
    return (operation.name or operation.key).strip()


def _record_name_losses(
    outcome: _NameOutcome,
    *,
    identity: str,
    source_key: str,
    losses: LossTracker,
) -> None:
    """Report every way a derived name drifted from the source identity."""
    if outcome.sanitized:
        losses.record(
            LossKind.INFERRED,
            LOSS_TOOL_NAME_SANITIZED,
            f"Identity {identity!r} contains characters a tool name may not "
            f"({TOOL_NAME_PATTERN.pattern}); it is published as {outcome.name!r}.",
            pointer=source_key,
        )
    if outcome.truncated:
        losses.record(
            LossKind.INFERRED,
            LOSS_TOOL_NAME_TRUNCATED,
            f"Identity {identity!r} is longer than a tool name may be; it is published "
            f"as {outcome.name!r}, shortened with a hash of the full name so it stays "
            "unique and stable.",
            pointer=source_key,
        )
    if outcome.deduplicated:
        losses.record(
            LossKind.INFERRED,
            LOSS_TOOL_NAME_COLLISION,
            f"Identity {identity!r} resolves to a tool name already used in this "
            f"document; it is published as {outcome.name!r}.",
            pointer=source_key,
        )
