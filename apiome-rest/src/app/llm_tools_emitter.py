"""LLM tool-array emitter: canonical model → OpenAI / Anthropic / bare — FMT-2.5 (#5423).

The inverse of :mod:`app.llm_tools_parser`: where that module reads a function-calling
tool bundle and normalizes it into the ``agent`` paradigm, this emitter walks *any*
:class:`~app.canonical_model.CanonicalApi` — a REST service, a gRPC package, a SOAP
contract, a copybook-derived schema — and writes the tool array an agent needs in order
to call it.

Three dialects, one derivation
------------------------------

The ``mode`` option chooses the wire shape:

* ``openai`` — ``{"type": "function", "function": {"name", "description", "parameters"}}``;
* ``anthropic`` — ``{"name", "description", "input_schema"}``;
* ``bare`` — ``{"name", "description", "parameters"}``, the shape most in-house agent
  frameworks read.

Only the envelope differs. *What* a tool is called and *what arguments it takes* comes
from :mod:`app.tool_projection`, the shared middle this emitter and the MCP
tool-definition emitter (MFX-32.1, #4295) both render, so the two cannot drift apart on
the one thing they must agree on. That module owns name derivation, description
assembly, parameter/body flattening and the provider constraint table; this one owns the
envelope, the emit options and the JSON document.

What the output is guaranteed to be
-----------------------------------

Every emitted array is re-checked, in the mode it was written for, against
:func:`app.llm_tool_schema.validate_tool_array` before it leaves this module — the
vendored equivalent of the provider's own acceptance rules. A constraint violation is
therefore impossible to ship: the emitter either rewrites the construct (a name outside
the charset, a ``oneOf`` in a strict schema) and reports the rewrite as a loss, or the
emit fails loudly.

Names are deterministic. The same model always produces the same names in the same
order, because the projection walks services and operations in canonical key order and
disambiguates collisions with a counted suffix rather than anything derived from a clock
or a hash map's iteration order. A provider caches on a tool name, and an agent
transcript refers to a past call by it, so a name that moved between two runs of the same
export would be a silent correctness bug rather than a cosmetic one.

Nothing credential-shaped is published
--------------------------------------

A credential-carrying header or query parameter never becomes a tool argument, a cookie
never becomes one, and any credential literal in a description is redacted before it is
written. A tool definition is read by a language model: an argument called ``api_key``
is an invitation to hallucinate one, and a description carrying a real token has leaked
it into every transcript the tool appears in. The rules live in
:mod:`app.tool_projection` next to the flattening they guard.

Round-tripping
--------------

An operation that was itself imported *from* a tool bundle carries the bundle's own
argument schema in ``extras["input_schema"]``; that schema is emitted verbatim rather
than reconstructed, so a bundle exported from Apiome is the bundle that went in. What a
round trip does **not** preserve is the per-tool *dialect* of a mixed bundle: an emitted
document is written in exactly one mode, so re-importing it reports that mode for every
tool. The mixed-dialect provenance is reported as a loss rather than approximated.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple, Union

from pydantic import Field, field_validator

from .canonical_model import ApiParadigm, CanonicalApi, Channel, Operation, Type
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitOptionsError,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict
from .llm_tool_schema import TOOL_MODES, validate_tool_array
from .tool_projection import (
    DEFAULT_MAX_NAME_LENGTH,
    DEFAULT_MAX_NESTING_DEPTH,
    EVENT_OPERATION_KINDS,
    ToolDefinition,
    project_tools,
)

__all__ = [
    "LLM_TOOLS_FORMAT_KEY",
    "TOOL_MODES",
    "OUTPUT_FILENAME",
    "LlmToolsEmitOptions",
    "LlmToolsEmitter",
    "LlmToolsFidelityRulePack",
    "render_tool_entry",
]

#: Registry key of this emitter. It matches the ``llm-tools`` import adapter, so the
#: round-trip matrix joins emit and re-import without an alias.
LLM_TOOLS_FORMAT_KEY = "llm-tools"

#: Name of the single file this emitter writes.
OUTPUT_FILENAME = "tools.json"

#: Media type of that file.
OUTPUT_MEDIA_TYPE = "application/json"


# ===========================================================================
# Options
# ===========================================================================


class LlmToolsEmitOptions(EmitOptions):
    """Per-target options for :class:`LlmToolsEmitter`.

    The defaults produce the array most callers want: OpenAI-dialect tools for every
    live operation in the model, with ordinary (non-structured-output) JSON Schema
    arguments — the shape that pastes straight into a ``tools=[…]`` argument.
    """

    mode: str = Field(
        default="openai",
        description="Tool dialect to write: `openai` (`{type:'function', function:{…}}`), "
        "`anthropic` (`{name, description, input_schema}`) or `bare` "
        "(`{name, description, parameters}`).",
    )
    tag: Optional[str] = Field(
        default=None,
        description="Emit only operations carrying this tag. Excluded operations are "
        "reported as losses so an absent tool is never silent.",
    )
    path_prefix: Optional[str] = Field(
        default=None,
        description="Emit only operations whose HTTP path starts with this prefix "
        "(for example `/v2/`). Operations with no HTTP binding never match.",
    )
    include_deprecated: bool = Field(
        default=False,
        description="Publish deprecated operations as tools. Off by default: a tool "
        "array steers a model, and steering it at an endpoint the API is retiring is "
        "rarely what the exporter wants. When on, each such tool's description is "
        "marked `Deprecated.`, because no dialect has a `deprecated` keyword.",
    )
    strict_schema: bool = Field(
        default=False,
        description="Emit the strict structured-output schema subset: closed objects "
        "(`additionalProperties: false`), every property listed in `required` with the "
        "optional ones widened to accept null, and only the keyword subset the strict "
        "mode accepts. In `openai` mode the tool also carries `strict: true`.",
    )

    @field_validator("mode")
    @classmethod
    def _known_mode(cls, value: str) -> str:
        """Reject a dialect this emitter does not write."""
        if value not in TOOL_MODES:
            raise ValueError(f"mode must be one of {', '.join(TOOL_MODES)}")
        return value

    @field_validator("tag", "path_prefix")
    @classmethod
    def _non_blank_filter(cls, value: Optional[str]) -> Optional[str]:
        """Treat a blank filter as no filter rather than as "match nothing"."""
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


# ===========================================================================
# Rendering
# ===========================================================================


def render_tool_entry(tool: ToolDefinition, *, mode: str, strict: bool = False) -> Dict[str, Any]:
    """Render one :class:`~app.tool_projection.ToolDefinition` in ``mode``'s wire shape.

    Args:
        tool: The provider-neutral definition to render.
        mode: One of :data:`~app.llm_tool_schema.TOOL_MODES`.
        strict: Whether to declare structured-output strictness. Only the ``openai``
            dialect has a wire field for it; the other two carry strictness purely in
            the shape of the schema.

    Returns:
        The tool object, with ``description`` omitted entirely when the source
        documented none (an empty string would read as "documented as blank").

    Raises:
        ValueError: When ``mode`` is not a known dialect.
    """
    if mode == "openai":
        function: Dict[str, Any] = {"name": tool.name}
        if tool.description:
            function["description"] = tool.description
        function["parameters"] = tool.input_schema
        if strict:
            function["strict"] = True
        return {"type": "function", "function": function}

    if mode == "anthropic":
        entry: Dict[str, Any] = {"name": tool.name}
        if tool.description:
            entry["description"] = tool.description
        entry["input_schema"] = tool.input_schema
        return entry

    if mode == "bare":
        bare: Dict[str, Any] = {"name": tool.name}
        if tool.description:
            bare["description"] = tool.description
        bare["parameters"] = tool.input_schema
        return bare

    raise ValueError(f"Unknown tool mode {mode!r}; expected one of {', '.join(TOOL_MODES)}")


#: Mode → (name pointer token, description pointer token, schema pointer token). A tool
#: array is a JSON array, so a provenance pointer is a real RFC-6901 pointer into the
#: emitted document: ``/0/function/name`` names the first tool's name.
_POINTER_FIELDS: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...], Tuple[str, ...]]] = {
    "openai": (("function", "name"), ("function", "description"), ("function", "parameters")),
    "anthropic": (("name",), ("description",), ("input_schema",)),
    "bare": (("name",), ("description",), ("parameters",)),
}


class _LlmToolsWriter:
    """Build one tool array from a canonical model, with provenance and losses."""

    def __init__(self, api: CanonicalApi, options: LlmToolsEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()

    def render(self) -> str:
        """Render the tool array as pretty-printed JSON text.

        Returns:
            The document text, ending in a newline.

        Raises:
            ValueError: When the model yields no tool at all, or when the finished array
                fails the vendored provider contract.
        """
        tools = project_tools(
            self._api,
            losses=self.losses,
            tag=self._options.tag,
            path_prefix=self._options.path_prefix,
            include_deprecated=self._options.include_deprecated,
            strict_schema=self._options.strict_schema,
            max_name_length=DEFAULT_MAX_NAME_LENGTH,
            max_depth=DEFAULT_MAX_NESTING_DEPTH,
        )
        if not tools:
            raise ValueError(
                "LLM tool-array export requires at least one callable: a tool array "
                "describes what an agent may invoke, and this model declares no "
                "operation (and no record type) that survives the emit filter."
            )

        self._record_document_losses(tools)
        document = [
            render_tool_entry(tool, mode=self._options.mode, strict=self._options.strict_schema)
            for tool in tools
        ]
        for index, tool in enumerate(tools):
            self._record_tool_provenance(index, tool)

        validate_tool_array(
            document,
            mode=self._options.mode,
            max_depth=DEFAULT_MAX_NESTING_DEPTH,
            source_label=self._api.title or self._api.identity.name,
        )
        return json.dumps(document, indent=2, ensure_ascii=False) + "\n"

    # --- provenance ---------------------------------------------------------

    def _record_tool_provenance(self, index: int, tool: ToolDefinition) -> None:
        """Note where each emitted value of one tool came from."""
        name_field, description_field, schema_field = _POINTER_FIELDS[self._options.mode]
        base = ProvenanceTracker.child("", str(index))
        self.tracker.record(
            ProvenanceTracker.child(base, *name_field),
            tool.name_provenance,
            None
            if tool.name_provenance is Provenance.SOURCE
            else f"derived from {tool.source_name!r} to satisfy the tool-name grammar",
        )
        if tool.description:
            self.tracker.record(
                ProvenanceTracker.child(base, *description_field),
                tool.description_provenance,
            )
        self.tracker.record(
            ProvenanceTracker.child(base, *schema_field),
            tool.schema_provenance,
            None
            if tool.schema_provenance is Provenance.SOURCE
            else "assembled from the operation's parameters and request body",
        )

    # --- document-level losses ---------------------------------------------

    def _record_document_losses(self, tools: List[ToolDefinition]) -> None:
        """Report what the *document* as a whole cannot carry.

        Three things live above any single tool: an event channel (a tool array has no
        vocabulary for one), the API's servers and security schemes (a tool definition
        says what to call, never where or with which credential), and the per-tool
        dialect of a mixed source bundle.
        """
        for channel in self._api.channels:
            self.losses.record(
                LossKind.NA,
                "event-channel",
                f"A tool array has no channel vocabulary; channel {channel.key!r} is "
                "not represented.",
                pointer=channel.key,
            )
        if self._api.servers:
            self.losses.record(
                LossKind.NA,
                "server-binding",
                "A tool definition names a callable and its arguments; it has no field "
                f"for a server, so the {len(self._api.servers)} declared server(s) and "
                "the transport binding are not carried.",
                pointer="servers",
            )
        schemes = _declared_security_schemes(self._api)
        if schemes:
            self.losses.record(
                LossKind.NA,
                "security-scheme",
                "A tool array has no security vocabulary; the declared scheme(s) "
                f"{', '.join(repr(name) for name in schemes)} are not carried, and no "
                "credential is published to the model.",
                pointer="security",
            )

        dialects = (self._api.extras or {}).get("dialects")
        if isinstance(dialects, list) and len(dialects) > 1:
            self.losses.record(
                LossKind.INFERRED,
                "mixed-dialect-collapsed",
                f"The source bundle mixes the {', '.join(sorted(str(d) for d in dialects))} "
                f"tool dialects; one document is written in one dialect, so every tool is "
                f"emitted as {self._options.mode!r}.",
                pointer="dialects",
            )


# ===========================================================================
# Fidelity
# ===========================================================================


class LlmToolsFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for tool-array export.

    A tool array is a *call surface with arguments*: it carries a callable's name, its
    documentation and a JSON Schema for its inputs, and nothing else. Events have no
    representation (there is no request/reply exchange to describe), streaming has none
    (a tool call is one request and one reply), and a named type survives only by being
    inlined into every tool that uses it — the standalone type does not come back.
    """

    target_label = "LLM tool array"

    def channel_verdict(self, channel: Channel) -> FidelityVerdict:
        """An event channel has no tool representation; it is dropped."""
        return FidelityVerdict.drop(
            message=(
                f"{self.target_label} has no event/channel vocabulary; "
                f"channel {channel.key!r} is dropped"
            ),
            target_mapping="channel → dropped",
        )

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Only a non-streaming, non-event operation becomes a tool."""
        if operation.kind in EVENT_OPERATION_KINDS:
            return FidelityVerdict.drop(
                message=(
                    f"{self.target_label} describes callables, not event flows; "
                    f"{operation.kind.value} operation {operation.key!r} is dropped"
                ),
                target_mapping="event operation → dropped",
            )
        if operation.streaming.value != "none":
            return FidelityVerdict.drop(
                message=(
                    f"{self.target_label} carries one request and one reply; the "
                    f"{operation.streaming.value}-streaming operation {operation.key!r} "
                    "is dropped"
                ),
                target_mapping="streaming operation → dropped",
            )
        return FidelityVerdict.ok(message=f"operation carried to {self.target_label}")

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """A named type is inlined into each tool that uses it, never declared."""
        return FidelityVerdict.approx(
            message=(
                f"{self.target_label} has no component section; type {type_.key!r} is "
                "inlined into every tool schema that references it and is not "
                "recoverable as a standalone type"
            ),
            target_mapping="named type → inlined schema",
        )


# ===========================================================================
# Emitter
# ===========================================================================


class LlmToolsEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as an OpenAI / Anthropic / bare tool array."""

    key = LLM_TOOLS_FORMAT_KEY
    format = LLM_TOOLS_FORMAT_KEY
    label = "LLM Tool Definitions"
    description = (
        "Export as a function-calling tool array (OpenAI, Anthropic or bare): one tool "
        "per operation, with a collision-free name, a description assembled from the "
        "summary and description, and a JSON Schema merging path, query, header and "
        "body arguments."
    )
    icon = "bot"
    paradigm = ApiParadigm.AGENT
    multi_file = False
    options_model = LlmToolsEmitOptions

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what a tool array carries faithfully.

        Its argument schemas *are* JSON Schema, so unions, optionality and validation
        facets all survive. What it has no vocabulary for is events — a channel or a
        pub/sub action has no callable to describe — and field identity, which no
        JSON-Schema-shaped target carries.
        """
        return CapabilityProfile(
            operations=True,
            events=False,
            unions=True,
            nullability=True,
            constraints=True,
            field_identity=False,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        """Return the tool-array degradation rules."""
        return LlmToolsFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[LlmToolsEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one JSON tool array.

        Args:
            api: The canonical model to export.
            opts: Per-target options; the defaults emit OpenAI-dialect tools for every
                live operation with ordinary JSON-Schema arguments.

        Returns:
            A single-file :class:`~app.emitter.EmitResult` whose content is the tool
            array's JSON text, with the provenance of every emitted value and a loss for
            every construct a tool array cannot carry.

        Raises:
            EmitOptionsError: When ``opts`` names an unknown option value.
            ValueError: When the model yields no tool, or when the finished array fails
                the vendored provider contract.
        """
        options = _coerce_options(opts)
        writer = _LlmToolsWriter(api, options)
        content = writer.render()
        return EmitResult(
            files=[
                EmittedFile(
                    path=OUTPUT_FILENAME,
                    content=content,
                    media_type=OUTPUT_MEDIA_TYPE,
                )
            ],
            media_type=OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _declared_security_schemes(api: CanonicalApi) -> List[str]:
    """Return the security-scheme names the model declares, from wherever they live.

    The canonical model has no first-class security field: an import records schemes on
    ``api.extras['inferred_auth_schemes']`` (an inferred surface) or per operation on
    ``extras['security']`` (a gateway or OpenAPI import). Both are read here so the loss
    report names what a tool array is dropping rather than merely that it drops
    something.

    Args:
        api: The model being emitted.

    Returns:
        The distinct scheme names, sorted for determinism.
    """
    names: set = set()
    inferred = (api.extras or {}).get("inferred_auth_schemes")
    if isinstance(inferred, list):
        names.update(str(item) for item in inferred if item)
    elif isinstance(inferred, dict):
        names.update(str(key) for key in inferred)
    for service in api.services:
        for operation in service.operations:
            declared = (operation.extras or {}).get("security")
            if isinstance(declared, list):
                names.update(str(item) for item in declared if isinstance(item, str))
            elif isinstance(declared, str):
                names.add(declared)
    return sorted(names)


def _coerce_options(
    opts: Optional[Union[LlmToolsEmitOptions, EmitOptions]],
) -> LlmToolsEmitOptions:
    """Validate caller-supplied options into a :class:`LlmToolsEmitOptions`."""
    if isinstance(opts, LlmToolsEmitOptions):
        return opts
    try:
        return LlmToolsEmitOptions.model_validate(opts.model_dump() if opts else {})
    except ValueError as exc:
        raise EmitOptionsError(f"Invalid LLM tool-array emit options: {exc}") from exc
