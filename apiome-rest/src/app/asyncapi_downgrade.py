"""Downgrade an emitted AsyncAPI 3.1 document to AsyncAPI 2.6 — FMT-3.2 (#5427).

The reference emitter (:class:`app.asyncapi_emitter.AsyncApiEmitter`) produces an
**AsyncAPI 3.1** document, while the normalizer
(:class:`app.asyncapi_normalizer.AsyncApiNormalizer`) reads *both* 2.x and 3.x. Left
alone that is an asymmetry a customer feels: a 2.6 document can be brought in and
cannot be taken back out. This module is the missing leg — the AsyncAPI analogue of
:mod:`app.openapi_downgrade`, which gives the OpenAPI target its 3.0/2.0 outputs.

**The 2.x document shape is a different object model, not a dialect of the 3.x one.**
Where the 3.1 emission is a translation of the same structure, the 2.6 projection has
to move constructs between objects:

* **channels-with-operations.** 3.x names its channels and carries a separate top-level
  ``operations`` map, each operation bound to its channel by ``$ref``. 2.x keys each
  channel by its *address* and carries the operation **inside** it as the channel's
  ``publish`` / ``subscribe`` member — so a channel holds at most one of each, and the
  document name a 3.x channel had disappears into its address.
* **messages move with the operation.** 3.x declares messages once on the channel
  (``channels.<name>.messages``) and has each operation ``$ref`` the subset it uses;
  2.x has no channel-level message map, so the referenced messages are inlined onto the
  operation's ``message`` (a single Message Object, or ``oneOf`` for several).
* **server binding relocation.** 3.x splits a server's location into ``host`` +
  ``pathname``; 2.x carries one ``url``. The two are recombined (with the ``protocol``
  restored as the URL scheme, which is how a 2.x document spells it), and the 3.x-only
  ``title`` / ``summary`` / ``externalDocs`` — which the 2.6 Server Object has no slot
  for — are dropped.
* **channel parameters carry a schema again.** A 3.x Parameter Object is string-valued
  with an optional ``enum``/``default``; a 2.x one carries a full ``schema``. The
  parameter's canonical type and constraints are therefore taken from the *model* (via
  ``parameter_schemas``) rather than from the 3.1 document that already dropped them,
  so a 2.6 → canonical → 2.6 round trip keeps the parameter's schema intact.

One 3.x → 2.x difference is deliberately *not* treated as a loss: an operation's
perspective. 3.x names the action from the application's side (``send`` / ``receive``)
and 2.x from the client's (``publish`` / ``subscribe``), but the two describe the same
one-way flow on the same channel — which is why
:class:`app.asyncapi_normalizer.AsyncApiNormalizer` maps both spellings onto the same
:class:`~app.canonical_model.OperationKind`. Re-spelling one as the other carries every
bit of the meaning across, so it is a translation, not a loss.

**Every construct 2.x cannot represent is recorded, never silently dropped.** The
projection walks the document with a :class:`~app.emitter.LossTracker` and records a
:class:`~app.emitter.Loss` naming the reason: an :attr:`~app.emitter.LossKind.NA` loss
when the construct has no 2.x representation at all (an operation ``reply`` block — 2.x
has no request/reply pattern; a second ``send`` operation on one channel — 2.x has a
single ``publish`` slot; the 3.x-only object keys the 2.6 object model forbids) and an
:attr:`~app.emitter.LossKind.INFERRED` loss where the projection had to invent
something (a channel with no ``address``, keyed by its document name instead). Those
losses ride back on the :class:`~app.emitter.EmitResult` so the fidelity engine and the
Export Studio can show what choosing the 2.6 target cost.

The function is **pure and deterministic**: it never mutates the input document,
performs no I/O, and emits collections in the input's (already deterministic) order, so
re-downgrading the same document yields a byte-identical result and loss list.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from .emitter import LossKind, LossTracker

__all__ = [
    "ASYNCAPI_26_VERSION",
    "downgrade_to_asyncapi_2",
]

#: The AsyncAPI 2.x version string emitted by :func:`downgrade_to_asyncapi_2`. 2.6 is
#: the last (and most capable) 2.x minor, so it is the only downgrade target offered:
#: an older 2.x consumer reads it, and nothing is gained by aiming lower.
ASYNCAPI_26_VERSION = "2.6.0"

# AsyncAPI 3 operation ``action`` → the AsyncAPI 2 channel member that holds it. The
# inverse of :data:`app.asyncapi_normalizer._V2_ACTION_KIND` composed with
# :data:`app.asyncapi_emitter._KIND_ACTION`, so an operation imported from 2.x as
# ``publish`` is emitted back as ``publish``.
_V2_MEMBER: Dict[str, str] = {"send": "publish", "receive": "subscribe"}

# Root keys carried across unchanged. ``operations`` is *not* here — it is relocated
# into the channels — and ``channels``/``servers``/``components`` are rebuilt below.
_ROOT_PASSTHROUGH: Tuple[str, ...] = ("id", "info", "defaultContentType", "tags", "externalDocs")

# Server Object keys the 2.6 object model accepts (it is ``additionalProperties: false``,
# so anything else makes the document invalid). ``url`` is rebuilt from ``host`` +
# ``pathname``; the rest are copied when present.
_V2_SERVER_KEYS: Tuple[str, ...] = (
    "protocol",
    "protocolVersion",
    "description",
    "variables",
    "security",
    "bindings",
    "tags",
)

# Server Object keys AsyncAPI 3 added and 2.6 has no slot for.
_SERVER_V3_ONLY: Tuple[str, ...] = ("title", "summary", "externalDocs")

# Channel Item Object keys 2.6 accepts, beyond the ``publish``/``subscribe`` members
# this projection attaches. ``address`` becomes the map key and ``messages`` move onto
# the operations, so neither is copied.
_V2_CHANNEL_KEYS: Tuple[str, ...] = ("description", "servers", "parameters", "bindings", "deprecated")

# Channel Item Object keys AsyncAPI 3 added and 2.6 has no slot for.
_CHANNEL_V3_ONLY: Tuple[str, ...] = ("title", "summary", "tags", "externalDocs")

# Operation Object keys 2.6 accepts, beyond the ``operationId`` and ``message`` this
# projection builds. ``action``/``channel``/``messages``/``reply`` are 3.x-only.
_V2_OPERATION_KEYS: Tuple[str, ...] = (
    "summary",
    "description",
    "security",
    "tags",
    "externalDocs",
    "bindings",
    "traits",
)

# Operation Object keys AsyncAPI 3 added and 2.6 has no slot for (``reply`` is handled
# separately — it carries messages, so its loss names them).
_OPERATION_V3_ONLY: Tuple[str, ...] = ("title",)

# Components Object members the emitter can produce that 2.6 also accepts.
_V2_COMPONENT_KEYS: Tuple[str, ...] = ("schemas", "messages", "securitySchemes", "parameters")

# Parameter Object keys a 3.x parameter carries that a 2.x parameter expresses inside
# its ``schema`` instead.
_PARAMETER_SCHEMA_KEYS: Tuple[str, ...] = ("default", "enum", "examples")


def downgrade_to_asyncapi_2(
    document: Dict[str, Any],
    losses: LossTracker,
    *,
    parameter_schemas: Optional[Dict[str, Dict[str, Any]]] = None,
    named_channel_addresses: FrozenSet[str] = frozenset(),
) -> Dict[str, Any]:
    """Return an AsyncAPI 2.6 projection of a 3.1 ``document``, recording losses.

    Rebuilds the document onto the 2.x object model (see the module docstring): channels
    re-keyed by address and carrying their operations, messages inlined onto those
    operations, servers recombined onto a single ``url``, and every 3.x-only construct
    recorded on ``losses`` with a named reason. The input is not mutated.

    Args:
        document: A schema-valid AsyncAPI 3.1 document (the emitter's output).
        losses: Tracker the projection records each 3.x-only construct's loss on.
        parameter_schemas: Optional ``{channel address: {parameter name: JSON Schema}}``
            supplying each channel parameter's canonical schema — the one thing a 3.x
            Parameter Object cannot carry and so cannot be read back off ``document``.
            A parameter with no entry falls back to a plain ``{"type": "string"}``, the
            3.x Parameter Object's implied type.
        named_channel_addresses: The addresses whose *model* channel declares a document
            name of its own — the 3.x name/address split that 2.x, which keys a channel
            by its address, cannot keep. Only those are reported as a lost channel name;
            a 3.1 emission of a 2.x-sourced model derives every channel name from its
            address, so collapsing it back loses nothing and says nothing.

    Returns:
        A new dict: a schema-valid AsyncAPI 2.6 document.
    """
    schemas_by_address = parameter_schemas or {}
    result: Dict[str, Any] = {"asyncapi": ASYNCAPI_26_VERSION}
    for key in _ROOT_PASSTHROUGH:
        if key in document:
            result[key] = copy.deepcopy(document[key])

    servers = _downgrade_servers(document.get("servers"), losses)
    if servers:
        result["servers"] = servers

    source_channels = document.get("channels")
    source_channels = source_channels if isinstance(source_channels, dict) else {}
    channels, address_by_name = _downgrade_channels(
        source_channels, schemas_by_address, named_channel_addresses, losses
    )
    _attach_operations(
        document.get("operations"), source_channels, address_by_name, channels, losses
    )
    _report_unused_messages(source_channels, address_by_name, channels, losses)
    # ``channels`` is a required root member in 2.x (it is optional in 3.x), so a
    # components-only export still declares an empty map rather than omitting it.
    result["channels"] = channels

    components = _downgrade_components(document.get("components"), losses)
    if components:
        result["components"] = components
    return result


# ===========================================================================
# Servers
# ===========================================================================


def _downgrade_servers(servers: Any, losses: LossTracker) -> Dict[str, Any]:
    """Project the ``servers`` map onto the 2.6 Server Object shape.

    2.6 carries one ``url`` where 3.x splits ``host`` + ``pathname``, and its Server
    Object is closed (``additionalProperties: false``), so the 3.x-only keys are dropped
    with a named loss rather than emitted into an invalid document.

    Args:
        servers: The 3.1 document's ``servers`` map (any type; a non-mapping yields ``{}``).
        losses: Tracker for the 3.x-only server keys that cannot be carried.

    Returns:
        The 2.6 ``servers`` map, in the input's order.
    """
    if not isinstance(servers, dict):
        return {}
    result: Dict[str, Any] = {}
    for name, spec in servers.items():
        if not isinstance(spec, dict):
            continue
        entry: Dict[str, Any] = {"url": _server_url(spec)}
        for key in _V2_SERVER_KEYS:
            if key in spec:
                entry[key] = copy.deepcopy(spec[key])
        for key in _SERVER_V3_ONLY:
            if key in spec:
                losses.record(
                    LossKind.NA,
                    "asyncapi2-server-field",
                    f"server {name!r} declares {key!r}, which the AsyncAPI 2.6 Server "
                    "Object has no field for; it is dropped",
                    pointer=f"/servers/{name}/{key}",
                )
        result[name] = entry
    return result


def _server_url(spec: Dict[str, Any]) -> str:
    """Recombine a 3.x server's ``host``/``pathname``/``protocol`` into one 2.x ``url``.

    ``{"host": "api.example.com", "pathname": "/v1", "protocol": "https"}`` becomes
    ``"https://api.example.com/v1"`` — the spelling a 2.x document uses, and the exact
    string :meth:`app.asyncapi_emitter.AsyncApiEmitter._split_url` took apart, so a URL
    that came in through a 2.x import comes back out unchanged. A host that already
    carries a scheme is left alone.

    Args:
        spec: One 3.1 Server Object.

    Returns:
        The recombined URL (``""`` when the object declares no host at all).
    """
    host = spec.get("host")
    host = host if isinstance(host, str) else ""
    pathname = spec.get("pathname")
    url = host + (pathname if isinstance(pathname, str) else "")
    protocol = spec.get("protocol")
    if url and isinstance(protocol, str) and protocol and "://" not in url:
        url = f"{protocol}://{url}"
    return url


# ===========================================================================
# Channels
# ===========================================================================


def _downgrade_channels(
    channels: Dict[str, Any],
    parameter_schemas: Dict[str, Dict[str, Any]],
    named_channel_addresses: FrozenSet[str],
    losses: LossTracker,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Re-key the ``channels`` map by address and project each onto the 2.6 shape.

    A 3.x channel has both a document *name* (its map key) and a wire *address*; 2.x has
    only the address, so the name is spent. Two 3.x channels sharing one address
    therefore collapse into a single 2.x channel — the first one's object wins and the
    second is recorded as a loss, because 2.x cannot keep them apart.

    Args:
        channels: The 3.1 document's ``channels`` map.
        parameter_schemas: ``{address: {parameter name: JSON Schema}}`` from the model.
        named_channel_addresses: Addresses whose model channel carries its own name.
        losses: Tracker for lost channel names, unaddressed channels and collisions.

    Returns:
        A ``(channels, address_by_name)`` pair: the 2.6 channel map keyed by address,
        and the 3.x channel name → address lookup the operation pass binds through.
    """
    result: Dict[str, Any] = {}
    address_by_name: Dict[str, str] = {}
    for name, spec in channels.items():
        if not isinstance(spec, dict):
            continue
        address = spec.get("address")
        if not isinstance(address, str) or not address:
            address = name
            losses.record(
                LossKind.INFERRED,
                "asyncapi2-channel-address",
                f"channel {name!r} declares no address; AsyncAPI 2.6 keys a channel by "
                f"its address, so the channel name {name!r} is used as the key",
                pointer=f"/channels/{name}",
            )
        address_by_name[name] = address
        if address in named_channel_addresses and name != address:
            losses.record(
                LossKind.NA,
                "asyncapi2-channel-name",
                f"channel {name!r} is declared under a name distinct from its address "
                f"{address!r}; AsyncAPI 2.6 keys a channel by its address alone, so "
                "the name is dropped",
                pointer=f"/channels/{name}",
            )
        if address in result:
            losses.record(
                LossKind.NA,
                "asyncapi2-channel-collision",
                f"channel {name!r} shares the address {address!r} with an earlier "
                "channel; AsyncAPI 2.6 keys channels by address, so only the first "
                "channel's description, parameters and bindings survive",
                pointer=f"/channels/{name}",
            )
            continue
        result[address] = _channel_object(name, spec, parameter_schemas, losses)
    return result, address_by_name


def _channel_object(
    name: str,
    spec: Dict[str, Any],
    parameter_schemas: Dict[str, Dict[str, Any]],
    losses: LossTracker,
) -> Dict[str, Any]:
    """Project one 3.1 Channel Object onto the closed 2.6 Channel Item Object."""
    entry: Dict[str, Any] = {}
    for key in _V2_CHANNEL_KEYS:
        if key not in spec:
            continue
        if key == "parameters":
            entry[key] = _channel_parameters(
                spec[key], parameter_schemas.get(spec.get("address") or name, {})
            )
        elif key == "servers":
            entry[key] = _channel_servers(spec[key])
        else:
            entry[key] = copy.deepcopy(spec[key])
    for key in _CHANNEL_V3_ONLY:
        if key in spec:
            losses.record(
                LossKind.NA,
                "asyncapi2-channel-field",
                f"channel {name!r} declares {key!r}, which the AsyncAPI 2.6 Channel "
                "Item Object has no field for; it is dropped",
                pointer=f"/channels/{name}/{key}",
            )
    return entry


def _channel_servers(servers: Any) -> List[str]:
    """Convert a 3.x channel's ``servers`` ``$ref`` array into 2.x server *names*."""
    if not isinstance(servers, list):
        return []
    names: List[str] = []
    for entry in servers:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("$ref"), str):
            names.append(entry["$ref"].rstrip("/").rsplit("/", 1)[-1])
    return names


def _channel_parameters(
    parameters: Any, schemas: Dict[str, Any]
) -> Dict[str, Any]:
    """Project a channel's ``parameters`` map onto the 2.6 Parameter Object shape.

    A 2.6 parameter describes its value with a ``schema``; a 3.x one is string-valued
    and spells its constraints as sibling ``enum``/``default``/``examples`` keys. Those
    keys move into the schema, and the schema itself is preferentially the canonical
    one from ``schemas`` — the source's own parameter schema, which the 3.x Parameter
    Object could not carry.

    Args:
        parameters: The 3.1 channel's ``parameters`` map.
        schemas: ``{parameter name: JSON Schema}`` for this channel, from the model.

    Returns:
        The 2.6 ``parameters`` map, in the input's order.
    """
    if not isinstance(parameters, dict):
        return {}
    result: Dict[str, Any] = {}
    for name, spec in parameters.items():
        if not isinstance(spec, dict):
            continue
        entry: Dict[str, Any] = {}
        if isinstance(spec.get("description"), str):
            entry["description"] = spec["description"]
        if isinstance(spec.get("location"), str):
            entry["location"] = spec["location"]
        schema = copy.deepcopy(schemas.get(name)) or {"type": "string"}
        for key in _PARAMETER_SCHEMA_KEYS:
            if key in spec and key not in schema:
                schema[key] = copy.deepcopy(spec[key])
        entry["schema"] = schema
        result[name] = entry
    return result


# ===========================================================================
# Operations
# ===========================================================================


def _attach_operations(
    operations: Any,
    source_channels: Dict[str, Any],
    address_by_name: Dict[str, str],
    channels: Dict[str, Any],
    losses: LossTracker,
) -> None:
    """Move the top-level ``operations`` map into its channels' publish/subscribe slots.

    Mutates ``channels`` in place (it is this module's own freshly built map). An
    operation whose channel cannot be resolved, or whose channel already carries an
    operation of the same action, has nowhere to go in the 2.x object model and is
    recorded as a loss.

    Args:
        operations: The 3.1 document's ``operations`` map.
        source_channels: The 3.1 ``channels`` map, for resolving message ``$ref``\\s.
        address_by_name: 3.x channel name → 2.x channel key (its address).
        channels: The 2.6 channel map being assembled.
        losses: Tracker for operations and reply blocks 2.x cannot carry.
    """
    if not isinstance(operations, dict):
        return
    for name, spec in operations.items():
        if not isinstance(spec, dict):
            continue
        member = _V2_MEMBER.get(spec.get("action"))
        if member is None:
            losses.record(
                LossKind.NA,
                "asyncapi2-operation-action",
                f"operation {name!r} declares no send/receive action, so it maps to "
                "neither an AsyncAPI 2.6 publish nor a subscribe; it is dropped",
                pointer=f"/operations/{name}",
            )
            continue
        channel_name = _channel_name_of(spec.get("channel"))
        address = address_by_name.get(channel_name) if channel_name else None
        if address is None or address not in channels:
            losses.record(
                LossKind.NA,
                "asyncapi2-operation-channel",
                f"operation {name!r} binds to a channel that is not declared in the "
                "document; AsyncAPI 2.6 carries an operation inside its channel, so "
                "the operation is dropped",
                pointer=f"/operations/{name}",
            )
            continue
        channel = channels[address]
        if member in channel:
            losses.record(
                LossKind.NA,
                "asyncapi2-duplicate-action",
                f"channel {address!r} already carries a {member!r} operation; an "
                f"AsyncAPI 2.6 channel has one {member} slot, so operation {name!r} "
                "is dropped",
                pointer=f"/operations/{name}",
            )
            continue
        channel[member] = _operation_object(
            name, spec, source_channels.get(channel_name or ""), losses
        )


def _channel_name_of(channel_field: Any) -> Optional[str]:
    """Return the channel document name a 3.x operation's ``channel`` ``$ref`` points at."""
    if not isinstance(channel_field, dict):
        return None
    ref = channel_field.get("$ref")
    if not isinstance(ref, str):
        return None
    return ref.rstrip("/").rsplit("/", 1)[-1] or None


def _operation_object(
    name: str,
    spec: Dict[str, Any],
    channel_spec: Any,
    losses: LossTracker,
) -> Dict[str, Any]:
    """Project one 3.1 Operation Object onto the closed 2.6 Operation Object.

    The 3.x operation name (its map key) becomes the 2.x ``operationId`` — the identity
    a 2.x operation carries — and the messages it ``$ref``\\s on its channel are inlined
    onto ``message``. A ``reply`` block has no 2.x counterpart at all: AsyncAPI 2.x
    describes one-way channel operations, with no request/reply pattern, so it is
    recorded as a loss naming the reply messages it drops.
    """
    entry: Dict[str, Any] = {"operationId": name}
    for key in _V2_OPERATION_KEYS:
        if key in spec:
            entry[key] = copy.deepcopy(spec[key])
    for key in _OPERATION_V3_ONLY:
        if key in spec:
            losses.record(
                LossKind.NA,
                "asyncapi2-operation-field",
                f"operation {name!r} declares {key!r}, which the AsyncAPI 2.6 Operation "
                "Object has no field for; it is dropped",
                pointer=f"/operations/{name}/{key}",
            )

    messages = _resolve_messages(spec.get("messages"), channel_spec)
    if len(messages) == 1:
        entry["message"] = messages[0]
    elif messages:
        entry["message"] = {"oneOf": messages}

    reply = spec.get("reply")
    if isinstance(reply, dict):
        replies = _resolve_messages(reply.get("messages"), channel_spec)
        losses.record(
            LossKind.NA,
            "asyncapi2-operation-reply",
            f"operation {name!r} declares a reply, a request/reply pattern AsyncAPI "
            f"2.6 cannot express; its {len(replies)} reply message(s) are dropped",
            pointer=f"/operations/{name}/reply",
        )
    return entry


def _resolve_messages(refs: Any, channel_spec: Any) -> List[Dict[str, Any]]:
    """Inline the message objects a 3.x operation ``$ref``\\s on its channel.

    Args:
        refs: The operation's (or reply's) ``messages`` array of ``$ref`` objects.
        channel_spec: The 3.1 Channel Object declaring those messages.

    Returns:
        The referenced Message Objects, deep-copied, in reference order. An inline
        message object (no ``$ref``) is carried through as-is; an unresolvable
        reference is skipped.
    """
    if not isinstance(refs, list):
        return []
    declared = channel_spec.get("messages") if isinstance(channel_spec, dict) else None
    declared = declared if isinstance(declared, dict) else {}
    result: List[Dict[str, Any]] = []
    for entry in refs:
        if not isinstance(entry, dict):
            continue
        ref = entry.get("$ref")
        if not isinstance(ref, str):
            result.append(copy.deepcopy(entry))
            continue
        message = declared.get(ref.rstrip("/").rsplit("/", 1)[-1])
        if isinstance(message, dict):
            result.append(copy.deepcopy(message))
    return result


def _report_unused_messages(
    source_channels: Dict[str, Any],
    address_by_name: Dict[str, str],
    channels: Dict[str, Any],
    losses: LossTracker,
) -> None:
    """Record any channel message no surviving 2.x operation carries.

    A 3.x channel declares its messages independently of the operations that use them,
    so a message can outlive every operation that referenced it (an operation dropped
    for a duplicate action, or a channel that declares messages and no operation at
    all). 2.x has nowhere to put such a message — its messages live on an operation —
    so each one is named rather than quietly disappearing.
    """
    for name, spec in source_channels.items():
        if not isinstance(spec, dict):
            continue
        declared = spec.get("messages")
        if not isinstance(declared, dict) or not declared:
            continue
        address = address_by_name.get(name)
        channel = channels.get(address) if address is not None else None
        carried = _carried_message_names(channel)
        for message_name, message in declared.items():
            if not isinstance(message, dict):
                continue
            if _message_identity(message) in carried:
                continue
            losses.record(
                LossKind.NA,
                "asyncapi2-orphan-message",
                f"message {message_name!r} on channel {name!r} is carried by no "
                "AsyncAPI 2.6 operation; a 2.6 message lives on its channel's publish "
                "or subscribe operation, so it is dropped",
                pointer=f"/channels/{name}/messages/{message_name}",
            )


def _carried_message_names(channel: Any) -> List[str]:
    """Return the identity of every message the 2.6 ``channel`` ended up carrying."""
    carried: List[str] = []
    if not isinstance(channel, dict):
        return carried
    for member in _V2_MEMBER.values():
        operation = channel.get(member)
        if not isinstance(operation, dict):
            continue
        message = operation.get("message")
        if not isinstance(message, dict):
            continue
        alternatives = message.get("oneOf")
        for entry in alternatives if isinstance(alternatives, list) else [message]:
            if isinstance(entry, dict):
                carried.append(_message_identity(entry))
    return carried


def _message_identity(message: Dict[str, Any]) -> str:
    """Return a stable identity for a message object, for the carried/orphan comparison."""
    name = message.get("name")
    if isinstance(name, str) and name:
        return name
    return repr(sorted(message.items(), key=lambda item: item[0]))


# ===========================================================================
# Components
# ===========================================================================


def _downgrade_components(components: Any, losses: LossTracker) -> Dict[str, Any]:
    """Carry the Components Object members 2.6 shares with 3.x.

    The emitter produces ``components.schemas`` only, and AsyncAPI 2.6 keeps its named
    schemas under the same ``#/components/schemas`` path, so nothing has to be rewritten
    (unlike Swagger 2.0's ``#/definitions``). Any other member is 3.x-only and named.
    """
    if not isinstance(components, dict):
        return {}
    result: Dict[str, Any] = {}
    for key, value in components.items():
        if key in _V2_COMPONENT_KEYS:
            result[key] = copy.deepcopy(value)
        else:
            losses.record(
                LossKind.NA,
                "asyncapi2-components-member",
                f"components.{key} has no AsyncAPI 2.6 Components Object member and "
                "is dropped",
                pointer=f"/components/{key}",
            )
    return result
