"""Request-correlated responses on the default path (#5527, MSC-1.1).

A mock that answers ``GET /pets/42`` with the spec example's id instead of ``42`` is not a usable
stand-in for the real API. Everything needed to correlate a response with its request already
existed — the bounded template language in :mod:`app.mock_template` — but both dynamic paths were
gated on a request header (``X-Mock-Scenario``, ``X-Mock-Session``) that a generated SDK or a
browser app cannot be made to send. Correlation is therefore **configuration on the version**,
stored in ``versions.mock_settings`` under the ``"responseCorrelation"`` key::

    {
      "responseCorrelation": {
        "mode": "inferred",
        "operations": {
          "GET /pets/{petId}": {
            "/id": "{{request.path.petId}}",
            "/owner/ref": "{{request.query.owner}}"
          }
        }
      }
    }

Modes
-----

``off`` (the default)
    Nothing runs. Behaviour is byte-identical to a version with no block at all.
``path-params``
    A response property whose name matches a path parameter takes the request's value, at every
    depth of the response body and inside array members. Matching is name-based over a small
    normalization set: ``petId`` matches ``petId``, ``pet_id`` and the bare ``id``.
``inferred``
    Everything ``path-params`` does, plus echoing request-body fields back on ``POST``/``PUT``/
    ``PATCH``. Server-generated fields (:data:`SERVER_OWNED_FIELDS` and anything absent from the
    request) stay synthesized. This is the Counterfact/Prism-shaped behaviour: what you sent comes
    back, enriched.
``explicit``
    Only the per-operation pointer map runs — no inference at all, for the cases where a guess
    would be wrong.

The ``operations`` pointer map is honoured in **every** mode except ``off``, and always last: an
explicit entry wins over an inferred or path-parameter binding for the same pointer. So the passes
compose in the order ``path-params`` → ``inferred`` → ``explicit``, and the ``mode`` chooses which
inference passes run ahead of the map.

This is a *binding* of the existing engine onto the default response path plus an inference pass —
not a second template language and not a second renderer. Explicit expressions are rendered by
:func:`app.mock_template.render_value` and validated at save time by
:func:`app.mock_template.validate_template_value`, so a bad expression is a 422 rather than a
serve-time surprise.

Parsing here is deliberately lenient (malformed entries are skipped, never raised) to mirror
:mod:`apiome_mock.scenarios` and :mod:`apiome_mock.chaos`; author-time validation happens in
apiome-rest (:mod:`app.mock_correlation`) when the settings are saved.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.mock_template import RenderBudget, RenderEnv, render_value, value_references_request_body

from apiome_mock.scenarios import normalize_operation_key

__all__ = [
    "CORRELATION_HEADER",
    "CORRELATION_MODES",
    "EMPTY_CORRELATION",
    "MODE_EXPLICIT",
    "MODE_INFERRED",
    "MODE_OFF",
    "MODE_PATH_PARAMS",
    "SCHEMA_VALID_HEADER",
    "SERVER_OWNED_FIELDS",
    "CorrelationConfig",
    "CorrelationOutcome",
    "correlate_response_body",
    "derive_request_seed",
    "normalize_property_name",
    "parse_response_correlation",
    "path_parameter_aliases",
]

CORRELATION_HEADER = "X-Mock-Correlation"
"""Response header naming the correlation passes that bound something (or ``"none"``)."""

SCHEMA_VALID_HEADER = "X-Mock-Schema-Valid"
"""Response header reporting whether the correlated body still matches the response schema.

Named to match the header the in-REST mock engine already sets (``app.mock_routes``), so one
vocabulary answers "did the served body drift from the contract" on both planes.
"""

MODE_OFF = "off"
"""No correlation; the version behaves exactly as it did before MSC-1.1."""

MODE_PATH_PARAMS = "path-params"
"""Bind response properties named after a path parameter to the request's value."""

MODE_INFERRED = "inferred"
"""``path-params`` plus echoing request-body fields back on writes."""

MODE_EXPLICIT = "explicit"
"""Only the per-operation pointer map; no inference."""

CORRELATION_MODES: tuple[str, ...] = (MODE_OFF, MODE_PATH_PARAMS, MODE_INFERRED, MODE_EXPLICIT)
"""Every accepted ``mode`` value, in increasing order of what they bind."""

SERVER_OWNED_FIELDS: frozenset[str] = frozenset({"id", "createdat", "updatedat", "deletedat"})
"""Normalized property names ``inferred`` never echoes from the request body.

These are the fields a real server *assigns*: echoing a client-supplied ``id`` back would make the
mock agree with a request the real API would have overruled. They are compared after
:func:`normalize_property_name`, so ``created_at`` and ``createdAt`` are the same field. An author
who genuinely wants one of them bound says so with an ``explicit`` pointer entry.
"""

MAX_CORRELATION_OPERATIONS = 200
"""Maximum operation entries read from one stored block; extras are skipped."""

MAX_POINTERS_PER_OPERATION = 50
"""Maximum pointer bindings read from one operation entry; extras are skipped."""

_ECHOED_METHODS = frozenset({"POST", "PUT", "PATCH"})
"""Methods whose request body ``inferred`` echoes back."""

_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")


def normalize_property_name(name: str) -> str:
    """Fold a property or path-parameter name to its comparison form.

    Lower-cases and drops every non-alphanumeric character, so ``petId``, ``pet_id`` and ``Pet-Id``
    all become ``petid``.

    Args:
        name: The raw property or parameter name.

    Returns:
        The normalized form used for name-based matching.
    """
    return _NON_ALPHANUMERIC.sub("", name.lower())


@dataclass(frozen=True)
class CorrelationConfig:
    """The version's response-correlation settings, already parsed and normalized.

    Attributes:
        mode: One of :data:`CORRELATION_MODES`; ``"off"`` disables everything.
        operations: Explicit pointer bindings keyed by canonical ``"METHOD /template"`` operation
            key. Each value is an ordered tuple of ``(json_pointer, template_expression)`` pairs,
            applied in stored order so the outcome is deterministic.
    """

    mode: str = MODE_OFF
    operations: Mapping[str, tuple[tuple[str, str], ...]] = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        """Whether any correlation pass runs at all."""
        return self.mode != MODE_OFF

    @property
    def binds_path_params(self) -> bool:
        """Whether the name-based path-parameter pass runs."""
        return self.mode in (MODE_PATH_PARAMS, MODE_INFERRED)

    @property
    def echoes_request_body(self) -> bool:
        """Whether the request-body echo pass runs."""
        return self.mode == MODE_INFERRED

    def pointers_for(self, operation_key: str) -> tuple[tuple[str, str], ...]:
        """Return the explicit bindings for one operation (empty when it has none)."""
        if not self.enabled:
            return ()
        return self.operations.get(operation_key, ())

    def applies_to(self, operation_key: str) -> bool:
        """Whether serving ``operation_key`` would run any correlation pass."""
        if not self.enabled:
            return False
        return self.binds_path_params or self.echoes_request_body or bool(self.pointers_for(operation_key))

    def needs_request_body(self, operation_key: str) -> bool:
        """Whether correlating ``operation_key`` has to read the parsed request body.

        Reads are never echoed, so a ``GET`` only needs the body when an explicit expression asks
        for it — which keeps correlation from pulling a body the request will not use.
        """
        if not self.enabled:
            return False
        if self.echoes_request_body and operation_key.split(" ", 1)[0].upper() in _ECHOED_METHODS:
            return True
        return any(value_references_request_body(expression) for _, expression in self.pointers_for(operation_key))


EMPTY_CORRELATION = CorrelationConfig()
"""The default: correlation switched off."""


@dataclass(frozen=True)
class CorrelationOutcome:
    """What one correlation pass-set did to a response body.

    Attributes:
        body: The correlated body (the input value unchanged when nothing bound).
        applied: The names of the passes that changed something, in application order.
        pointers: The JSON Pointers the explicit pass actually wrote to, in application order.
            Empty unless the ``explicit`` pass bound something. Recorded so the dry-run preview
            (#5528, MSC-1.2) can tell an author *which* binding produced a value, not merely that
            correlation ran.
    """

    body: Any
    applied: tuple[str, ...] = ()
    pointers: tuple[str, ...] = ()

    @property
    def changed(self) -> bool:
        """Whether any pass bound something."""
        return bool(self.applied)

    def header_value(self) -> str:
        """Render :data:`CORRELATION_HEADER` for this outcome."""
        return ", ".join(self.applied) if self.applied else "none"


def _parse_pointer_map(raw: Any) -> tuple[tuple[str, str], ...]:
    """Parse one operation's ``{pointer: expression}`` map, skipping malformed entries."""
    if not isinstance(raw, dict):
        return ()
    entries: list[tuple[str, str]] = []
    for pointer, expression in raw.items():
        if len(entries) >= MAX_POINTERS_PER_OPERATION:
            break
        if not isinstance(pointer, str) or not isinstance(expression, str):
            continue
        if pointer != "" and not pointer.startswith("/"):
            continue
        entries.append((pointer, expression))
    return tuple(entries)


def parse_response_correlation(mock_settings: Any) -> CorrelationConfig:
    """Parse ``versions.mock_settings`` into a :class:`CorrelationConfig`.

    Accepts the raw JSONB value (dict, JSON text, or ``None``) and never raises: an unknown mode,
    a non-mapping block, a malformed operation key, and a non-string pointer or expression are all
    skipped, so a malformed stored blob degrades to "no correlation" rather than breaking serving.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value.

    Returns:
        The parsed configuration; :data:`EMPTY_CORRELATION` when nothing usable is stored.
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return EMPTY_CORRELATION
    if not isinstance(settings, dict):
        return EMPTY_CORRELATION
    block = settings.get("responseCorrelation")
    if not isinstance(block, dict):
        return EMPTY_CORRELATION

    mode = block.get("mode")
    if not isinstance(mode, str) or mode not in CORRELATION_MODES:
        return EMPTY_CORRELATION
    if mode == MODE_OFF:
        return EMPTY_CORRELATION

    operations: dict[str, tuple[tuple[str, str], ...]] = {}
    raw_operations = block.get("operations")
    if isinstance(raw_operations, dict):
        for raw_key, raw_map in raw_operations.items():
            if len(operations) >= MAX_CORRELATION_OPERATIONS:
                break
            operation_key = normalize_operation_key(raw_key)
            if operation_key is None:
                continue
            pointers = _parse_pointer_map(raw_map)
            if pointers:
                operations[operation_key] = pointers
    return CorrelationConfig(mode=mode, operations=operations)


def derive_request_seed(method: str, path_template: str, path_params: Mapping[str, str]) -> int:
    """Derive the default synthesis seed from the request itself.

    Without this, an unseeded request synthesizes from a constant ``0``, so ``GET /pets/42`` and
    ``GET /pets/43`` return the *same* invented body. Hashing ``(method, path template, path
    parameter values)`` makes the two differ while each stays byte-stable across repeated calls and
    across deployments — the property a portable bundle in CI has to reproduce.

    Query and header values are deliberately excluded: a body that changed with every incidental
    query parameter would make a mock unusable as a fixture.

    Args:
        method: The request method.
        path_template: The matched operation's path template (``/pets/{petId}``).
        path_params: The path parameters routing extracted.

    Returns:
        A non-negative integer seed for :func:`apiome_mock.schema_synthesizer.generate_example`.
    """
    parts = [method.upper(), path_template]
    parts.extend(f"{name}={value}" for name, value in sorted(path_params.items()))
    digest = hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()
    return int(digest[:16], 16)


def path_parameter_aliases(path_params: Mapping[str, str]) -> dict[str, str]:
    """Build the ``normalized property name -> request value`` map the name pass matches on.

    Every parameter registers its own normalized name, and a parameter whose name *ends* in ``id``
    (``petId``, ``pet_id``) additionally registers the bare ``id`` — the spelling most response
    schemas actually use. When several parameters would claim the bare ``id``
    (``/users/{userId}/pets/{petId}``) the **last** one wins: it addresses the resource the
    response is about.

    Args:
        path_params: Path parameters as extracted by routing, in template order.

    Returns:
        Normalized property name to raw request value.
    """
    aliases: dict[str, str] = {}
    for name, value in path_params.items():
        normalized = normalize_property_name(name)
        if not normalized:
            continue
        aliases[normalized] = value
        if normalized.endswith("id") and len(normalized) > 2:
            aliases["id"] = value
    return aliases


def _coerce_like(text: str, current: Any) -> Any:
    """Coerce a raw path value to the JSON type of the value it replaces.

    A path parameter always arrives as text, but the response schema usually declares ``id`` an
    integer — writing ``"42"`` where ``42`` belongs would produce a schema-invalid body from a
    correct binding. The replaced value's own type is the most reliable signal available at this
    point (it came from a spec example or from schema synthesis), so it decides.

    Args:
        text: The raw request value.
        current: The value being replaced.

    Returns:
        ``text`` converted to ``current``'s JSON type, or ``text`` when it will not convert.
    """
    if isinstance(current, bool):
        lowered = text.strip().lower()
        if lowered in ("true", "false"):
            return lowered == "true"
        return text
    if isinstance(current, int):
        try:
            return int(text)
        except ValueError:
            return text
    if isinstance(current, float):
        try:
            return float(text)
        except ValueError:
            return text
    return text


def _bind_path_params(node: Any, aliases: Mapping[str, str]) -> tuple[Any, bool]:
    """Replace every scalar property whose name matches a path parameter, at any depth."""
    if isinstance(node, Mapping):
        out: dict[Any, Any] = {}
        changed = False
        for key, value in node.items():
            raw = aliases.get(normalize_property_name(key)) if isinstance(key, str) else None
            if raw is not None and not isinstance(value, (Mapping, list)):
                coerced = _coerce_like(raw, value)
                out[key] = coerced
                changed = changed or coerced != value
                continue
            child, child_changed = _bind_path_params(value, aliases)
            out[key] = child
            changed = changed or child_changed
        return out, changed
    if isinstance(node, list):
        results = [_bind_path_params(item, aliases) for item in node]
        return [body for body, _ in results], any(flag for _, flag in results)
    return node, False


def _lookup_request_field(source: Mapping[str, Any], key: str) -> tuple[Any, bool]:
    """Find ``key`` in a request-body object, exactly or by normalized name."""
    if key in source:
        return source[key], True
    target = normalize_property_name(key)
    for candidate, value in source.items():
        if isinstance(candidate, str) and normalize_property_name(candidate) == target:
            return value, True
    return None, False


def _echo_request_body(node: Any, source: Mapping[str, Any]) -> tuple[Any, bool]:
    """Echo request-body fields into a response body, leaving server-owned fields alone.

    Aligned by name at each level. A response object that matches *nothing* in ``source`` is
    treated as an envelope (``{"data": {...}}``) and the same source is offered to its children;
    once a level has matched at least one field, unmatched siblings are left synthesized rather
    than searched again, so a nested ``owner`` object cannot silently inherit the top-level
    ``name`` the request supplied.
    """
    if isinstance(node, Mapping):
        matches: dict[Any, Any] = {}
        for key in node:
            if not isinstance(key, str) or normalize_property_name(key) in SERVER_OWNED_FIELDS:
                continue
            value, found = _lookup_request_field(source, key)
            if found:
                matches[key] = value
        out: dict[Any, Any] = {}
        changed = False
        for key, value in node.items():
            if key in matches:
                replacement = matches[key]
                if isinstance(value, Mapping) and isinstance(replacement, Mapping):
                    child, child_changed = _echo_request_body(value, replacement)
                    out[key] = child
                    changed = changed or child_changed
                elif isinstance(value, (Mapping, list)) != isinstance(replacement, (Mapping, list)):
                    # Shape disagreement (object where a scalar was sent, or the reverse): keep the
                    # synthesized value rather than serve something the schema will reject.
                    out[key] = value
                else:
                    out[key] = replacement
                    changed = changed or replacement != value
                continue
            if not matches:
                child, child_changed = _echo_request_body(value, source)
                out[key] = child
                changed = changed or child_changed
            else:
                out[key] = value
        return out, changed
    if isinstance(node, list):
        results = [_echo_request_body(item, source) for item in node]
        return [body for body, _ in results], any(flag for _, flag in results)
    return node, False


_POINTER_UNESCAPE = (("~1", "/"), ("~0", "~"))
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")


def _set_at_pointer(node: Any, tokens: tuple[str, ...], value: Any) -> tuple[Any, bool]:
    """Set ``value`` at ``tokens`` inside ``node``, copying containers along the way.

    A missing key on the *final* segment of an object is created (the author named the pointer, so
    binding it is the instruction). Anything else missing — an absent intermediate container, an
    out-of-range array index, a scalar where a container is needed — leaves the document untouched
    and reports ``False``, because inventing structure the schema does not describe would turn one
    mistyped pointer into an invalid body.
    """
    if not tokens:
        return value, True
    token, rest = tokens[0], tokens[1:]
    if isinstance(node, Mapping):
        if rest:
            if token not in node:
                return node, False
            child, ok = _set_at_pointer(node[token], rest, value)
            if not ok:
                return node, False
            out = dict(node)
            out[token] = child
            return out, True
        out = dict(node)
        out[token] = value
        return out, True
    if isinstance(node, list):
        if not _ARRAY_INDEX.fullmatch(token):
            return node, False
        index = int(token)
        if index >= len(node):
            return node, False
        if rest:
            child, ok = _set_at_pointer(node[index], rest, value)
            if not ok:
                return node, False
        else:
            child = value
        out_list = list(node)
        out_list[index] = child
        return out_list, True
    return node, False


def _pointer_tokens(pointer: str) -> tuple[str, ...]:
    """Split an RFC 6901 pointer into unescaped tokens (``""`` yields no tokens)."""
    if pointer == "":
        return ()
    tokens: list[str] = []
    for raw in pointer.split("/")[1:]:
        token = raw
        for escaped, plain in _POINTER_UNESCAPE:
            token = token.replace(escaped, plain)
        tokens.append(token)
    return tuple(tokens)


def _bind_explicit(
    node: Any,
    pointers: tuple[tuple[str, str], ...],
    env: RenderEnv,
    budget: RenderBudget,
) -> tuple[Any, tuple[str, ...]]:
    """Render and apply each explicit pointer binding, in stored order.

    Args:
        node: The response body to bind into.
        pointers: ``(json_pointer, expression)`` pairs in stored order.
        env: Request facts, seeded RNG, and fixture data for the expressions.
        budget: The shared render budget.

    Returns:
        ``(body, bound_pointers)`` — the rewritten body and the pointers that actually wrote a
        value (a pointer whose parent is missing writes nothing and is not reported).

    Raises:
        TemplateLimitError: When a rendered expression exhausts the shared render budget.
    """
    body = node
    bound: list[str] = []
    for pointer, expression in pointers:
        rendered = render_value(expression, env, budget)
        body, applied = _set_at_pointer(body, _pointer_tokens(pointer), rendered)
        if applied:
            bound.append(pointer)
    return body, tuple(bound)


def correlate_response_body(
    body: Any,
    *,
    config: CorrelationConfig,
    operation_key: str,
    env: RenderEnv,
    budget: RenderBudget,
) -> CorrelationOutcome:
    """Correlate a resolved response body with the request that asked for it.

    Runs the configured passes in order — path parameters, request-body echo, explicit pointer
    map — with each pass reading the same :class:`~app.mock_template.RenderEnv` the scenario
    renderer uses. The body is rebuilt rather than mutated, so the caller's value (a spec example,
    shared through the compiled-spec cache) is never modified in place.

    Args:
        body: The default-path response body, already resolved.
        config: The version's parsed correlation settings.
        operation_key: The canonical ``"METHOD /template"`` key of the matched operation.
        env: Request facts, seeded RNG, and fixture data for explicit expressions.
        budget: The shared render budget for explicit expressions.

    Returns:
        The correlated body, the names of the passes that bound something, and the explicit
        pointers those passes wrote to.

    Raises:
        TemplateLimitError: When an explicit expression exhausts the render budget.
    """
    if not config.enabled or body is None:
        return CorrelationOutcome(body=body)

    applied: list[str] = []
    bound_pointers: tuple[str, ...] = ()
    result = body

    if config.binds_path_params:
        aliases = path_parameter_aliases(env.ctx.path_params)
        if aliases:
            result, changed = _bind_path_params(result, aliases)
            if changed:
                applied.append(MODE_PATH_PARAMS)

    if config.echoes_request_body and env.ctx.method in _ECHOED_METHODS and isinstance(env.ctx.body, Mapping):
        result, changed = _echo_request_body(result, env.ctx.body)
        if changed:
            applied.append(MODE_INFERRED)

    pointers = config.pointers_for(operation_key)
    if pointers:
        result, bound_pointers = _bind_explicit(result, pointers, env, budget)
        if bound_pointers:
            applied.append(MODE_EXPLICIT)

    return CorrelationOutcome(body=result, applied=tuple(applied), pointers=bound_pointers)
