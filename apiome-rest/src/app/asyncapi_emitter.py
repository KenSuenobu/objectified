"""AsyncAPI 3.1 emitter: canonical model → AsyncAPI — MFX-11.1 (#3874).

The inverse of :class:`app.asyncapi_normalizer.AsyncApiNormalizer` and an
implementation of the :class:`app.emitter.Emitter` SPI. It walks a
:class:`~app.canonical_model.CanonicalApi` and produces a schema-valid **AsyncAPI
3.1** document:

* identity/title/version/description → ``info``;
  :class:`~app.canonical_model.Server`\\s → ``servers`` (v3 ``host`` + ``pathname``
  split, ``protocol``, and URL-template ``variables``);
* :class:`~app.canonical_model.Channel`\\s → ``channels`` (the wire ``address``, its
  address-template ``parameters``, and protocol ``bindings``);
* an event source's :class:`~app.canonical_model.Operation`\\s → ``operations``
  (``action: send`` for a :attr:`~app.canonical_model.OperationKind.PUBLISH`,
  ``action: receive`` for a :attr:`~app.canonical_model.OperationKind.SUBSCRIBE`),
  each bound to its channel by ``$ref``;
* :class:`~app.canonical_model.Message`\\s → per-channel ``messages`` (``payload``
  schema, ``headers`` object schema, ``contentType``);
* named :class:`~app.canonical_model.Type`\\s → ``components.schemas`` (via
  :class:`app.emitter.SchemaEmitter` — AsyncAPI schemas *are* JSON Schema).

**Reframing a non-event source.** AsyncAPI is an event vocabulary: it describes
*channels*, *pub/sub operations*, and *messages*, not HTTP routes/verbs/status
codes. A model from a REST or RPC source therefore has no native representation, so
each request/response operation is **reframed** as an AsyncAPI request/reply message
exchange (an ``action: send`` operation whose ``reply`` carries the response
message), the request/response bodies become the sent/replied messages, and the
HTTP method/path/status semantics — which AsyncAPI cannot carry — are recorded as
:class:`~app.emitter.Loss`\\es on the returned :class:`~app.emitter.EmitResult`
rather than silently dropped. The AsyncAPI fidelity pack (:class:`AsyncApiFidelityRulePack`,
MFX-11.2) is the predictive counterpart that turns the same reframing into the
per-construct ``APPROX``/``DROP`` verdicts the fidelity advisory shows *without*
emitting; this emitter's job is to emit the best-effort document and enumerate what
the reframing lost.

Two properties make the output trustworthy:

* **Deterministic.** Every collection is emitted in a stable order (servers by
  declaration, channels/operations/messages by key, component schemas by key), so
  re-converting the same model yields a byte-identical document.

* **Provenance-tracked.** Every emitted value is tagged
  :attr:`~app.emitter.Provenance.SOURCE` (came from the model),
  :attr:`~app.emitter.Provenance.INFERRED` (derived — e.g. a channel synthesized for
  a reframed REST operation), or :attr:`~app.emitter.Provenance.DEFAULT` (a system
  fallback — the ``info.version`` string, the emitter's AsyncAPI version). The
  fidelity analyzer reads this to show what the conversion added.

The emitter is pure (no I/O). It self-registers under the ``asyncapi-3`` format key
so :func:`app.emitter.get_emitter` resolves it. The acceptance-criterion validation
("emits valid AsyncAPI 3 from an event source") is confirmed by feeding the emitted
document back through :func:`app.asyncapi_parser.parse_asyncapi` (the bundled
``@asyncapi/parser`` toolchain), which the round-trip ticket (MFX-11.4) automates.

The ``asyncapi_version`` emit option (FMT-3.2) additionally lets a caller target
**AsyncAPI 2.6** through :mod:`app.asyncapi_downgrade`. The normalizer reads 2.x and
3.x, so without it a customer could bring a 2.6 document in and never get one back —
the asymmetry the OpenAPI emitter avoids by offering 3.1/3.0/2.0. 2.x is a different
object model rather than an older dialect (channels-with-operations instead of a
separate ``operations`` map, messages carried on the operation, one ``url`` instead of
a ``host``/``pathname`` split), and every 3.x-only construct it cannot express is
recorded on the result's :attr:`~app.emitter.EmitResult.losses` with a named reason.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

from pydantic import Field

from .asyncapi_downgrade import ASYNCAPI_26_VERSION, downgrade_to_asyncapi_2
from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Server,
    Service,
    StreamingMode,
)
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitResult,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
    SchemaEmitter,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict

__all__ = ["AsyncApiEmitOptions", "AsyncApiEmitter", "AsyncApiFidelityRulePack"]

# AsyncAPI 3 operation ``action`` values, from the application's own perspective: it
# *sends* to (publishes) or *receives* from (subscribes to) a channel. The inverse of
# :data:`app.asyncapi_normalizer._V3_ACTION_KIND`.
_KIND_ACTION: Dict[OperationKind, str] = {
    OperationKind.PUBLISH: "send",
    OperationKind.SUBSCRIBE: "receive",
}

# The pub/sub operation kinds an event source carries natively; every other kind
# (REST/RPC request-response, GraphQL query/mutation) is reframed as a request/reply
# message exchange.
_EVENT_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})

# Message roles carried as the operation's *sent* message (native event payload or a
# reframed request body) versus its *reply* message (a reframed response/error body).
_SEND_ROLES = frozenset({MessageRole.EVENT, MessageRole.REQUEST})
_REPLY_ROLES = frozenset({MessageRole.RESPONSE, MessageRole.ERROR})

# Operation ``extras`` keys the emitter reconstructs from first-class fields rather
# than copying verbatim, so a merge of the fidelity ``extras`` bag never overwrites
# them (``action`` drives the emitted action; ``reply`` is rebuilt from the messages).
_OPERATION_RESERVED_EXTRAS = frozenset({"action", "reply"})

# Characters not allowed in a document-level name (channel/operation/message map key)
# that is also spliced into a JSON-Pointer ``$ref`` — replaced with ``_`` so the ref
# stays unambiguous. The wire address keeps its original characters (it is a value,
# never a ref segment).
_UNSAFE_NAME_RE = re.compile(r"[^\w.\-]")


class AsyncApiEmitOptions(EmitOptions):
    """Per-target options for :class:`AsyncApiEmitter` (MFX-1.4)."""

    asyncapi_version: Literal["3.1", "2.6"] = Field(
        default="3.1",
        description=(
            "AsyncAPI version to emit. ``3.1`` (default) is the native, lossless "
            "target; ``2.6`` is a downgrade for consumers still on AsyncAPI 2.x, "
            "projected onto the 2.x object model (channels carrying their own "
            "publish/subscribe operations) with every 3.x-only construct recorded as "
            "a fidelity loss (FMT-3.2)."
        ),
    )
    include_channels: bool = Field(
        default=True,
        description="Emit ``channels`` and ``operations``. Disable for a "
        "components-only (schemas) export.",
    )
    include_components: bool = Field(
        default=True,
        description="Emit ``components/schemas`` from the model's named types.",
    )


class AsyncApiFidelityRulePack(CapabilityRulePack):
    """Reference fidelity rule pack for the AsyncAPI 3.1 target — MFX-11.2 (#3875).

    The predictive counterpart to :class:`AsyncApiEmitter` and the AsyncAPI analogue
    of :class:`~app.openapi_emitter.OpenApiFidelityRulePack`: a
    :class:`~app.fidelity_rulepack.FidelityRulePack` shipped *alongside* its emitter
    that refines the profile-derived default wherever AsyncAPI's six-axis
    :class:`~app.emitter.CapabilityProfile` is too coarse to describe how a construct
    actually degrades. It runs against the source :class:`~app.canonical_model.CanonicalApi`
    alone (never the emitted document), so the fidelity advisory can predict a REST→AsyncAPI
    export's losses without emitting, and its verdicts line up construct-for-construct
    with the :class:`~app.emitter.Loss`\\es :class:`AsyncApiEmitter` records at emit time.

    AsyncAPI's profile advertises ``events=True`` (its home vocabulary) and — honestly
    — ``operations=False``: it has no HTTP method/path/status vocabulary. The capability
    default would therefore report every non-event (REST/RPC/GraphQL query·mutation)
    operation a critical ``DROP``. But the emitter does not drop them — it **reframes**
    each as an ``action: send`` (+ ``reply``) message exchange onto a synthesized
    channel. This pack corrects the verdict to the honest reframing outcome:

    * **REST/RPC request-response operations** — reframed and carried, so an ``APPROX``
      (not a ``DROP``); the HTTP method/path/status AsyncAPI cannot carry are enumerated
      as the loss (:meth:`operation_verdict`);
    * **RPC streaming operations** — reframed onto a channel with their streaming
      cardinality lost, an ``APPROX`` (:meth:`operation_verdict`);
    * **native pub/sub operations, event channels, and every named type** — carried
      faithfully (AsyncAPI schemas *are* JSON Schema, so records/scalars/unions/enums
      land in ``components.schemas``), inherited unchanged from the capability default.
    """

    # Pub/sub operation kinds AsyncAPI carries natively (its home vocabulary); every
    # other kind is reframed as a send/receive message exchange, not carried faithfully.
    _EVENT_OPERATION_KINDS = frozenset(
        {OperationKind.PUBLISH, OperationKind.SUBSCRIBE}
    )

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Correct the capability default's ``DROP`` for a reframed non-event operation.

        A native pub/sub operation (``PUBLISH`` / ``SUBSCRIBE``) is AsyncAPI's home
        vocabulary and defers to the inherited ``OK``. Every other kind has no native
        AsyncAPI representation, so :class:`AsyncApiEmitter` reframes it rather than
        dropping it — the capability default's critical ``DROP`` (AsyncAPI advertises
        ``operations=False``) is too harsh. This override reports the honest reframe:

        * an **RPC streaming** method (any non-event operation whose ``streaming`` is
          not ``NONE``) is reframed onto a channel as a send/receive exchange but loses
          its streaming cardinality — an ``APPROX``;
        * every other **request-response** exchange (REST, unary RPC, GraphQL
          query/mutation, GraphQL subscription) is reframed as an ``action: send`` + a
          ``reply`` block, and whichever of the HTTP method/path/response-status the
          source carried — none representable in AsyncAPI — is enumerated as the loss.
          Still carried, so an ``APPROX``.
        """
        if operation.kind in self._EVENT_OPERATION_KINDS:
            return super().operation_verdict(operation)
        if operation.streaming is not StreamingMode.NONE:
            return FidelityVerdict.approx(
                message=f"{self.target_label} cannot model "
                f"{operation.streaming.value} streaming; the operation is reframed "
                "onto a channel as a send/receive message exchange and its streaming "
                "cardinality is dropped",
                target_mapping=f"{operation.streaming.value} streaming → "
                "send/receive message exchange (cardinality dropped)",
            )
        dropped = self._dropped_http_semantics(operation)
        loss_clause = f" and its {dropped} are dropped" if dropped else ""
        mapping_clause = f" ({dropped} dropped)" if dropped else ""
        return FidelityVerdict.approx(
            message=f"{self.target_label} has no HTTP operation vocabulary; the "
            f"{operation.kind.value} exchange is reframed as an action: send + reply"
            f"{loss_clause}",
            target_mapping=f"request/response → send + reply{mapping_clause}",
        )

    @staticmethod
    def _dropped_http_semantics(operation: Operation) -> str:
        """Enumerate the HTTP semantics AsyncAPI drops from a reframed operation.

        Names only the facets the operation actually carries — its HTTP verb, its route
        template, and (from any response/error message) its status code — so the verdict
        message states exactly what the reframe lost, matching the ``http-binding`` and
        ``http-status`` :class:`~app.emitter.Loss`\\es the emitter records for the same
        operation. Returns an empty string for an abstract operation carrying none.

        Args:
            operation: The non-event operation being reframed.

        Returns:
            A comma-joined phrase (e.g. ``"HTTP method, path, response status"``), or
            ``""`` when the operation carries no HTTP semantics at all.
        """
        facets: List[str] = []
        if operation.http_method:
            facets.append("HTTP method")
        if operation.http_path:
            facets.append("path")
        if any(message.status_code for message in operation.messages):
            facets.append("response status")
        return ", ".join(facets)


class AsyncApiEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as an AsyncAPI 3.1 document with provenance.

    Self-registers under ``asyncapi-3``. Primarily targets the event paradigm but
    accepts any canonical model — a non-event operation is reframed as a request/reply
    message exchange so the acceptance-criterion REST coverage holds, with the lost
    HTTP semantics recorded on the result.
    """

    key = "asyncapi"
    format = "asyncapi-3"
    label = "AsyncAPI 3.1"
    description = "Export as an AsyncAPI 3.1 JSON document (channels, operations, messages)."
    icon = "radio-tower"
    paradigm = ApiParadigm.EVENT
    multi_file = False
    options_model = AsyncApiEmitOptions

    #: The AsyncAPI version string this emitter targets natively.
    ASYNCAPI_VERSION = "3.1.0"
    #: Primary output filename within a bundle.
    OUTPUT_PATH = "asyncapi.json"
    #: Primary bundle media type (AsyncAPI has no registered vendor JSON type).
    OUTPUT_MEDIA_TYPE = "application/json"
    #: ``info.version`` used when the model declares none (AsyncAPI requires the field).
    DEFAULT_INFO_VERSION = "0.0.0"
    #: ``server.protocol`` used when neither the model nor the URL yields one (the
    #: AsyncAPI Server Object requires ``protocol``).
    DEFAULT_PROTOCOL = "http"
    #: JSON-Pointer prefix component-type references are emitted with.
    REF_PREFIX = "#/components/schemas/"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """AsyncAPI carries events, JSON-Schema types, unions, and constraints.

        ``operations`` is ``False`` on purpose: AsyncAPI has no HTTP operation
        vocabulary, so a REST/RPC request-response operation is not carried
        *faithfully* — it is reframed and its method/path/status are lost. The
        capability default therefore predicts a REST operation as a ``DROP`` until the
        AsyncAPI fidelity pack (MFX-11.2) refines it to the honest reframing ``APPROX``.
        """
        return CapabilityProfile(
            operations=False,
            events=True,
            unions=True,
            nullability=True,
            constraints=True,
            field_identity=False,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[AsyncApiFidelityRulePack]:
        """Return the reference AsyncAPI fidelity rule pack (MFX-11.2).

        Refines the profile-derived default so a reframed REST/RPC operation is
        predicted as the honest reframing ``APPROX`` rather than the capability
        default's critical ``DROP`` — see :class:`AsyncApiFidelityRulePack`.
        """
        return AsyncApiFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[AsyncApiEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as an AsyncAPI document with per-construct provenance.

        The default target is the native AsyncAPI 3.1. When ``opts.asyncapi_version``
        is ``"2.6"``, the 3.1 document is projected onto the AsyncAPI 2.x object model
        via :mod:`app.asyncapi_downgrade`, and every 3.x-only construct 2.6 cannot
        express is recorded as a :class:`~app.emitter.Loss` on the result — the FMT-3.2
        "3.x-only constructs are reported as losses with named reasons" behaviour.

        Args:
            api: The canonical model to convert.
            opts: Optional emit options. Defaults apply when omitted.

        Returns:
            An :class:`~app.emitter.EmitResult` whose primary file is a schema-valid
            document in the requested AsyncAPI version, whose ``provenance`` records
            where each value came from, and whose ``losses`` enumerate the HTTP
            semantics a reframed non-event source could not carry plus anything the
            requested version could not represent. The output is deterministic for a
            given ``api``.
        """
        options = (
            opts
            if isinstance(opts, AsyncApiEmitOptions)
            else AsyncApiEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        tracker = ProvenanceTracker()
        losses = LossTracker()
        schema = SchemaEmitter(ref_prefix=self.REF_PREFIX)

        # The version string is recorded in ``_apply_version`` so its provenance note
        # names the version actually emitted.
        document: Dict[str, Any] = {"asyncapi": self.ASYNCAPI_VERSION}

        document["info"] = self._info(api, tracker)

        servers = self._servers(api, tracker)
        if servers:
            document["servers"] = servers

        if options.include_channels:
            channels, operations = self._build(api, schema, tracker, losses)
            if channels:
                document["channels"] = channels
            if operations:
                document["operations"] = operations

        if options.include_components:
            components = self._components(api, schema, tracker)
            if components:
                document["components"] = components

        document = self._apply_version(
            document, api, schema, options.asyncapi_version, tracker, losses
        )

        return EmitResult.from_document(
            document,
            path=self.OUTPUT_PATH,
            media_type=self.OUTPUT_MEDIA_TYPE,
            provenance=tracker.records(),
            losses=losses.records(),
        )

    # --- version targeting --------------------------------------------------

    def _apply_version(
        self,
        document: Dict[str, Any],
        api: CanonicalApi,
        schema: SchemaEmitter,
        version: str,
        tracker: ProvenanceTracker,
        losses: LossTracker,
    ) -> Dict[str, Any]:
        """Project the 3.1 ``document`` onto ``version`` and record its provenance.

        The native ``3.1`` target passes the document through unchanged. ``2.6`` runs
        the :func:`app.asyncapi_downgrade.downgrade_to_asyncapi_2` projection, which
        records every 3.x-only construct it cannot carry on ``losses`` — the
        acceptance-criterion "3.x-only constructs are reported as losses with named
        reasons".

        Args:
            document: The emitted AsyncAPI 3.1 document.
            api: The source model, for the channel-parameter schemas a 3.x Parameter
                Object cannot carry (see :meth:`_parameter_schemas`).
            schema: The shared schema emitter those parameter schemas are rendered with.
            version: The requested ``asyncapi_version`` option value.
            tracker: Provenance tracker, for the ``/asyncapi`` version note.
            losses: Loss tracker the downgrade records onto.

        Returns:
            The document in the requested AsyncAPI version.
        """
        if version == "2.6":
            document = downgrade_to_asyncapi_2(
                document,
                losses,
                parameter_schemas=self._parameter_schemas(api, schema),
                named_channel_addresses=frozenset(
                    channel.address for channel in api.channels if channel.name
                ),
            )
            tracker.record(
                "/asyncapi",
                Provenance.DEFAULT,
                f"downgraded from AsyncAPI {self.ASYNCAPI_VERSION} to AsyncAPI "
                f"{ASYNCAPI_26_VERSION}",
            )
            return document
        tracker.record(
            "/asyncapi", Provenance.DEFAULT, "emitter target AsyncAPI version"
        )
        return document

    @classmethod
    def _parameter_schemas(
        cls, api: CanonicalApi, schema: SchemaEmitter
    ) -> Dict[str, Dict[str, Any]]:
        """Render each channel parameter's canonical schema, keyed by channel address.

        An AsyncAPI 2.x Parameter Object describes its value with a full ``schema``;
        the 3.x one is string-valued and carries only ``enum``/``default``. The 3.1
        document therefore cannot be the source for a 2.6 parameter's schema — the
        model is. This renders one JSON Schema per declared channel parameter so the
        2.6 projection can restore it, which is what makes a 2.6 → canonical → 2.6
        round trip preserve a channel parameter's type and constraints.

        Args:
            api: The source canonical model.
            schema: The shared :class:`~app.emitter.SchemaEmitter`.

        Returns:
            ``{channel address: {parameter name: JSON Schema}}``; channels with no
            parameters are omitted.
        """
        result: Dict[str, Dict[str, Any]] = {}
        for channel in api.channels:
            if not channel.parameters:
                continue
            result[channel.address] = {
                param.name: cls._parameter_schema(param, schema)
                for param in channel.parameters
            }
        return result

    @staticmethod
    def _parameter_schema(
        param: CanonicalField, schema: SchemaEmitter
    ) -> Dict[str, Any]:
        """Render one channel parameter's JSON Schema for a 2.x Parameter Object.

        The field's own schema, minus its ``description``: a 2.x Parameter Object
        carries the description in its own field, so repeating it inside the schema
        would say the same thing twice.
        """
        rendered = schema.field_schema(param)
        rendered.pop("description", None)
        return rendered

    # --- info ---------------------------------------------------------------

    def _info(self, api: CanonicalApi, tracker: ProvenanceTracker) -> Dict[str, Any]:
        """Emit the ``info`` object (title + version are required by AsyncAPI)."""
        info: Dict[str, Any] = {}

        if api.title:
            info["title"] = api.title
            tracker.record("/info/title", Provenance.SOURCE)
        else:
            info["title"] = api.identity.name
            tracker.record("/info/title", Provenance.INFERRED, "from identity.name")

        if api.version:
            info["version"] = api.version
            tracker.record("/info/version", Provenance.SOURCE)
        else:
            info["version"] = self.DEFAULT_INFO_VERSION
            tracker.record(
                "/info/version", Provenance.DEFAULT, "model declares no version"
            )

        if api.description:
            info["description"] = api.description
            tracker.record("/info/description", Provenance.SOURCE)

        return info

    # --- servers ------------------------------------------------------------

    def _servers(
        self, api: CanonicalApi, tracker: ProvenanceTracker
    ) -> Dict[str, Any]:
        """Emit the ``servers`` map (inverse of the normalizer's v3 server mapping).

        A canonical :class:`~app.canonical_model.Server` carries a recombined ``url``
        and, for an AsyncAPI source, the original ``host``/``pathname`` split in
        ``extras``. That split is preferred when present (a lossless round-trip);
        otherwise the required ``host``/``pathname`` are derived from the ``url`` — the
        path a REST source's servers take.
        """
        servers: Dict[str, Any] = {}
        for index, server in enumerate(api.servers):
            name = server.name or f"server{index}"
            base = ProvenanceTracker.child("/servers", name)
            servers[name] = self._server(server, base, tracker)
        return servers

    def _server(
        self, server: Server, base: str, tracker: ProvenanceTracker
    ) -> Dict[str, Any]:
        """Emit one AsyncAPI Server Object (``host`` and ``protocol`` are required)."""
        entry: Dict[str, Any] = {}
        # The fidelity `extras` bag holds every key the canonical Server fields do not
        # model (host, pathname, protocolVersion, security, bindings, …); merge it
        # first so first-class fields below win on any overlap.
        for key, value in sorted(server.extras.items()):
            entry[key] = value

        host, pathname, scheme = self._split_url(server.url)
        if "host" not in entry:
            entry["host"] = host if host else server.url
            tracker.record(f"{base}/host", Provenance.INFERRED, "derived from server url")
        else:
            tracker.record(f"{base}/host", Provenance.SOURCE)
        if pathname and "pathname" not in entry:
            entry["pathname"] = pathname

        if server.protocol:
            entry["protocol"] = server.protocol
            tracker.record(f"{base}/protocol", Provenance.SOURCE)
        elif "protocol" not in entry:
            entry["protocol"] = scheme or self.DEFAULT_PROTOCOL
            tracker.record(
                f"{base}/protocol",
                Provenance.INFERRED if scheme else Provenance.DEFAULT,
                "derived from server url scheme" if scheme else "no protocol declared",
            )

        if server.description:
            entry["description"] = server.description
        variables = self._server_variables(server)
        if variables:
            entry["variables"] = variables
        return entry

    @staticmethod
    def _server_variables(server: Server) -> Dict[str, Any]:
        """Emit a server's ``variables`` map (inverse of the normalizer's coercion)."""
        variables: Dict[str, Any] = {}
        for variable in server.variables:
            spec: Dict[str, Any] = {}
            if variable.default is not None:
                spec["default"] = variable.default
            if variable.enum is not None:
                spec["enum"] = list(variable.enum)
            if variable.description is not None:
                spec["description"] = variable.description
            variables[variable.name] = spec
        return variables

    @staticmethod
    def _split_url(url: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """Split a URL into ``(host, pathname, scheme)`` for the AsyncAPI server split.

        ``https://api.example.com/v1`` → ``("api.example.com", "/v1", "https")``. A
        bare host (no scheme, no path) yields ``(host, None, None)``.
        """
        scheme: Optional[str] = None
        rest = url
        if "://" in url:
            scheme, rest = url.split("://", 1)
        if "/" in rest:
            host, path = rest.split("/", 1)
            pathname: Optional[str] = "/" + path
        else:
            host, pathname = rest, None
        return (host or None), pathname, (scheme or None)

    # --- channels & operations ---------------------------------------------

    def _build(
        self,
        api: CanonicalApi,
        schema: SchemaEmitter,
        tracker: ProvenanceTracker,
        losses: LossTracker,
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Emit the ``channels`` and ``operations`` maps together.

        Channels and operations reference each other by ``$ref``, and an operation's
        messages are declared on its bound channel, so both maps are built in one pass
        over a shared channel/message registry. Declared channels (an event source's
        :attr:`~app.canonical_model.CanonicalApi.channels`) are emitted first so their
        native messages and addresses are preserved; a non-event operation with no
        declaring channel synthesizes one. Everything is walked in a deterministic
        (channel key, then service/operation key) order.
        """
        builder = _ChannelBuilder(self, schema, tracker, losses)

        for channel in sorted(api.channels, key=lambda c: c.key):
            builder.declare_channel(channel)

        operations: Dict[str, Any] = {}
        for service, operation in self._sorted_operation_pairs(api):
            op_name, op_obj = builder.operation(operation, service)
            operations[op_name] = op_obj

        channels = builder.finish()
        return (
            dict(sorted(channels.items())),
            dict(sorted(operations.items())),
        )

    @staticmethod
    def _sorted_operation_pairs(api: CanonicalApi) -> List[Tuple[Service, Operation]]:
        """Return every ``(service, operation)`` in deterministic (service, op) order."""
        result: List[Tuple[Service, Operation]] = []
        for service in sorted(api.services, key=lambda s: s.key):
            for operation in sorted(service.operations, key=lambda o: o.key):
                result.append((service, operation))
        return result

    # --- messages -----------------------------------------------------------

    def message_object(
        self,
        message: Message,
        schema: SchemaEmitter,
        tracker: ProvenanceTracker,
        ptr: str,
    ) -> Dict[str, Any]:
        """Emit one canonical :class:`Message` as an AsyncAPI Message Object.

        The inverse of :meth:`app.asyncapi_normalizer.AsyncApiNormalizer._message`:
        the payload schema (a ``$ref`` to a named type or an inline schema), the
        ``headers`` object schema rebuilt from the message's header fields, the
        ``contentType``, and every format-specific attribute the canonical fields do
        not model (``correlationId``, ``bindings``, ``traits``, …) carried back from
        ``extras``.
        """
        obj: Dict[str, Any] = {}
        for key, value in sorted(message.extras.items()):
            obj[key] = value
        if message.name:
            obj["name"] = message.name

        payload = self._payload_schema(message, schema)
        if payload is not None:
            obj["payload"] = payload
            tracker.record(f"{ptr}/payload", Provenance.SOURCE)

        headers = self._headers_schema(message, schema)
        if headers is not None:
            obj["headers"] = headers
            tracker.record(f"{ptr}/headers", Provenance.SOURCE)

        if message.content_types:
            obj["contentType"] = message.content_types[0]
        if message.description:
            obj["description"] = message.description

        tracker.record(ptr, Provenance.SOURCE)
        return obj

    @staticmethod
    def _payload_schema(
        message: Message, schema: SchemaEmitter
    ) -> Optional[Dict[str, Any]]:
        """Resolve a message's payload schema from its ``payload`` ref or inline schema."""
        if message.payload is not None:
            return schema.type_ref(message.payload)
        if message.payload_schema is not None:
            return dict(message.payload_schema)
        return None

    @staticmethod
    def _headers_schema(
        message: Message, schema: SchemaEmitter
    ) -> Optional[Dict[str, Any]]:
        """Rebuild a message's ``headers`` object schema from its header fields.

        AsyncAPI models headers as a single object schema whose ``properties`` are the
        headers; the canonical model splits them into
        :attr:`~app.canonical_model.Message.headers` fields. This recombines them (the
        inverse of the normalizer's ``_headers``), marking a non-nullable header
        ``required``.
        """
        if not message.headers:
            return None
        properties: Dict[str, Any] = {}
        required: List[str] = []
        for header in sorted(message.headers, key=lambda h: h.key):
            properties[header.name] = schema.field_schema(header)
            if header.type.nullable is False:
                required.append(header.name)
        obj: Dict[str, Any] = {"type": "object", "properties": properties}
        if required:
            obj["required"] = required
        return obj

    # --- components ---------------------------------------------------------

    def _components(
        self, api: CanonicalApi, schema: SchemaEmitter, tracker: ProvenanceTracker
    ) -> Dict[str, Any]:
        """Emit ``components.schemas`` from the model's named types."""
        schemas: Dict[str, Any] = {}
        for type_ in sorted(api.types, key=lambda t: t.key):
            schemas[type_.key] = schema.named_schema(type_)
            tracker.record(
                ProvenanceTracker.child("/components/schemas", type_.key),
                Provenance.SOURCE,
            )
        return {"schemas": schemas} if schemas else {}

    # --- name helpers -------------------------------------------------------

    @staticmethod
    def sanitize_name(name: str) -> str:
        """Make ``name`` safe to use as a map key that is also spliced into a ``$ref``.

        Replaces every character a JSON Pointer would have to escape (notably ``/``)
        with ``_`` so ``#/channels/{name}`` stays an unambiguous reference. The value
        is only a document identifier; the wire address is kept verbatim on the
        channel's ``address`` field.
        """
        cleaned = _UNSAFE_NAME_RE.sub("_", name).strip("_")
        return cleaned or "unnamed"

    @staticmethod
    def unique_name(base: str, taken: Dict[str, Any]) -> str:
        """Return ``base``, suffixed with ``_2``, ``_3``, … until it is unused in ``taken``."""
        candidate = base
        counter = 2
        while candidate in taken:
            candidate = f"{base}_{counter}"
            counter += 1
        return candidate


class _ChannelBuilder:
    """Accumulates the ``channels``/``operations`` maps over one emission.

    Channels, their messages, and the operations that reference them are built
    together against a shared registry so an operation can ``$ref`` a message declared
    on its channel and several operations can share a channel's message set without
    duplicating it. The builder is single-use and internal to
    :meth:`AsyncApiEmitter._build`.
    """

    def __init__(
        self,
        emitter: AsyncApiEmitter,
        schema: SchemaEmitter,
        tracker: ProvenanceTracker,
        losses: LossTracker,
    ) -> None:
        self._emitter = emitter
        self._schema = schema
        self._tracker = tracker
        self._losses = losses
        # doc_name -> channel object (its ``messages`` map is attached in `finish`).
        self._channels: Dict[str, Dict[str, Any]] = {}
        # canonical channel key -> channel doc name, for native operation binding.
        self._doc_by_key: Dict[str, str] = {}
        # doc_name -> {message doc name -> message object}.
        self._messages: Dict[str, Dict[str, Any]] = {}
        # doc_name -> {canonical message key -> message doc name}, for dedup.
        self._message_keys: Dict[str, Dict[str, str]] = {}
        # Operation-name namespace, kept distinct from the channel namespace so a
        # channel and an operation may share a readable name without colliding.
        self._operation_names: Dict[str, Any] = {}

    # --- channels -----------------------------------------------------------

    def declare_channel(self, channel: Channel) -> str:
        """Emit a declared (native) channel and register it under its canonical key."""
        base = self._emitter.sanitize_name(channel.name or channel.key)
        doc = self._emitter.unique_name(base, self._channels)
        self._doc_by_key[channel.key] = doc
        self._channels[doc] = self._channel_object(channel, doc)
        self._messages[doc] = {}
        self._message_keys[doc] = {}
        return doc

    def _channel_object(self, channel: Channel, doc: str) -> Dict[str, Any]:
        """Emit one AsyncAPI Channel Object (address, parameters, bindings)."""
        base = ProvenanceTracker.child("/channels", doc)
        obj: Dict[str, Any] = {}
        # Merge fidelity extras (title, tags, externalDocs, servers) first.
        for key, value in sorted(channel.extras.items()):
            obj[key] = value
        obj["address"] = channel.address
        self._tracker.record(f"{base}/address", Provenance.SOURCE)
        if channel.description:
            obj["description"] = channel.description
        parameters = self._channel_parameters(channel)
        if parameters:
            obj["parameters"] = parameters
        if channel.bindings:
            obj["bindings"] = channel.bindings
        return obj

    def _channel_parameters(self, channel: Channel) -> Dict[str, Any]:
        """Emit a channel's address ``parameters`` map (always string-valued in v3)."""
        parameters: Dict[str, Any] = {}
        for param in sorted(channel.parameters, key=lambda p: p.key):
            spec: Dict[str, Any] = {}
            for key, value in sorted(param.extras.items()):  # location, examples
                spec[key] = value
            if param.description:
                spec["description"] = param.description
            if param.default is not None:
                spec["default"] = param.default
            if param.constraints is not None and param.constraints.enum is not None:
                spec["enum"] = list(param.constraints.enum)
            parameters[param.name] = spec
        return parameters

    def _synthesize_channel(self, operation: Operation) -> str:
        """Synthesize a documentation channel for a reframed non-event operation.

        A REST/RPC operation carries no channel; its address is taken from the HTTP
        route (readable) or the operation key, and the synthesis is recorded as an
        inferred loss so the fidelity analyzer sees the channel was invented.
        """
        ref = operation.channel_ref
        if ref and ref in self._doc_by_key:
            return self._doc_by_key[ref]

        address = operation.http_path or ref or f"/{operation.key}"
        base = self._emitter.sanitize_name(
            ref or operation.name or operation.key
        )
        doc = self._emitter.unique_name(base, self._channels)
        if ref:
            self._doc_by_key[ref] = doc
        self._channels[doc] = {"address": address}
        self._messages[doc] = {}
        self._message_keys[doc] = {}
        self._tracker.record(
            ProvenanceTracker.child("/channels", doc, "address"),
            Provenance.INFERRED,
            "synthesized channel for a reframed non-event operation",
        )
        self._losses.record(
            LossKind.INFERRED,
            "synthesized-channel",
            f"operation {operation.key!r} carries no event channel; a documentation "
            f"channel with address {address!r} was synthesized",
            pointer=operation.key,
        )
        return doc

    # --- operations ---------------------------------------------------------

    def operation(
        self, operation: Operation, service: Service
    ) -> Tuple[str, Dict[str, Any]]:
        """Emit one Operation Object and register its messages on its channel.

        Returns the operation's unique document name paired with its object. A native
        pub/sub operation becomes an ``action: send``/``receive`` on its bound channel;
        every other kind is reframed as an ``action: send`` whose response messages
        move to a ``reply`` block, with the lost HTTP semantics recorded as losses.
        """
        action, send_messages, reply_messages, reframed = self._classify(operation)
        doc_channel = self._resolve_channel(operation)

        op_base = self._emitter.sanitize_name(operation.name or operation.key)
        # Operations live in their own flat namespace — disambiguate only against
        # other operations, not the channels.
        op_name = self._emitter.unique_name(op_base, self._operation_names)
        self._operation_names[op_name] = True

        obj: Dict[str, Any] = {
            "action": action,
            "channel": {"$ref": f"#/channels/{doc_channel}"},
        }
        # Carry harmless fidelity extras (bindings, traits, security, …) back.
        for key, value in sorted(operation.extras.items()):
            if key not in _OPERATION_RESERVED_EXTRAS:
                obj.setdefault(key, value)

        send_refs = [
            self._register_message(doc_channel, message)
            for message in send_messages
        ]
        if send_refs:
            obj["messages"] = [
                {"$ref": f"#/channels/{doc_channel}/messages/{name}"}
                for name in send_refs
            ]

        if reply_messages:
            reply_refs = [
                self._register_message(doc_channel, message)
                for message in reply_messages
            ]
            obj["reply"] = {
                "channel": {"$ref": f"#/channels/{doc_channel}"},
                "messages": [
                    {"$ref": f"#/channels/{doc_channel}/messages/{name}"}
                    for name in reply_refs
                ],
            }

        if operation.description:
            obj["description"] = operation.description
        if operation.tags:
            obj["tags"] = [{"name": tag} for tag in operation.tags]

        self._tracker.record(
            ProvenanceTracker.child("/operations", op_name),
            Provenance.INFERRED if reframed else Provenance.SOURCE,
            "reframed from a non-event operation" if reframed else None,
        )
        return op_name, obj

    def _resolve_channel(self, operation: Operation) -> str:
        """Return the channel doc name an operation binds to, synthesizing if needed."""
        if (
            operation.kind in _EVENT_KINDS
            and operation.channel_ref
            and operation.channel_ref in self._doc_by_key
        ):
            return self._doc_by_key[operation.channel_ref]
        return self._synthesize_channel(operation)

    def _classify(
        self, operation: Operation
    ) -> Tuple[str, List[Message], List[Message], bool]:
        """Resolve an operation's ``(action, send, reply, reframed)`` shape.

        A native pub/sub operation keeps all its (event-role) messages as the sent set
        with no reply. Every other kind is reframed: request-role messages are sent,
        response/error-role messages become the reply, and the HTTP method/path/status
        the source carried — none of which AsyncAPI can represent — are recorded as
        losses.
        """
        if operation.kind in _EVENT_KINDS:
            action = _KIND_ACTION[operation.kind]
            return action, list(operation.messages), [], False

        self._record_reframing_losses(operation)
        send = [m for m in operation.messages if m.role in _SEND_ROLES]
        reply = [m for m in operation.messages if m.role in _REPLY_ROLES]
        # A GraphQL subscription is the one non-event kind that reads from a channel;
        # everything else (REST/RPC/query/mutation) is modelled as a send.
        action = "receive" if operation.kind is OperationKind.SUBSCRIPTION else "send"
        return action, send, reply, True

    def _record_reframing_losses(self, operation: Operation) -> None:
        """Record the HTTP semantics a reframed operation could not carry."""
        self._losses.record(
            LossKind.INFERRED,
            "request-reply-reframe",
            f"operation {operation.key!r} is reframed from a "
            f"{operation.kind.value} exchange into an AsyncAPI send + reply",
            pointer=operation.key,
        )
        if operation.http_method or operation.http_path:
            binding = " ".join(
                part
                for part in (operation.http_method, operation.http_path)
                if part
            )
            self._losses.record(
                LossKind.NA,
                "http-binding",
                f"HTTP binding ({binding}) on {operation.key!r} has no AsyncAPI "
                "representation and is dropped",
                pointer=operation.key,
            )
        for message in operation.messages:
            if message.status_code:
                self._losses.record(
                    LossKind.NA,
                    "http-status",
                    f"response status {message.status_code!r} on {operation.key!r} "
                    "has no AsyncAPI representation and is dropped",
                    pointer=message.key,
                )

    def _register_message(self, doc_channel: str, message: Message) -> str:
        """Register ``message`` on ``doc_channel`` (deduped) and return its doc name."""
        seen = self._message_keys[doc_channel]
        if message.key in seen:
            return seen[message.key]
        messages = self._messages[doc_channel]
        base = self._emitter.sanitize_name(
            message.name or f"{message.role.value}Message"
        )
        name = self._emitter.unique_name(base, messages)
        seen[message.key] = name
        ptr = ProvenanceTracker.child("/channels", doc_channel, "messages", name)
        messages[name] = self._emitter.message_object(
            message, self._schema, self._tracker, ptr
        )
        return name

    # --- assembly -----------------------------------------------------------

    def finish(self) -> Dict[str, Any]:
        """Attach each channel's collected messages and return the ``channels`` map."""
        for doc, channel in self._channels.items():
            messages = self._messages.get(doc)
            if messages:
                channel["messages"] = dict(sorted(messages.items()))
        return self._channels
