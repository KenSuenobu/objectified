"""Bounded response template language for mock scenarios (#4744, PMR-2.1).

Scenario responses (bodies and header values) may embed ``{{ expression }}`` placeholders that are
expanded per request. The language is deliberately tiny and *closed*: an expression can only read
request fields, draw seeded random values, or read fixture data. There is no attribute access, no
function definition, no imports, and no host object of any kind reachable from a template, so
network, filesystem, and process access are structurally impossible — not sandboxed away, simply
not expressible.

Like :mod:`app.mock_match`, this module lives in the ``app`` package (the :mod:`app.mock_bundle`
precedent) so the save-time validator in apiome-rest and the renderer in apiome-mock share one
implementation and can never drift.

Expressions::

    {{request.method}}              upper-case HTTP method
    {{request.path.petId}}          a path template parameter
    {{request.query.limit}}         a query parameter (first supplied value)
    {{request.header.x-tier}}       a header (case-insensitive)
    {{request.body}}                the parsed JSON request body
    {{request.body#/items/0/sku}}   a body fragment by RFC 6901 JSON Pointer
    {{fixture.pets}}                a fixture value by name
    {{fixture.pets#/0/name}}        a fixture fragment by JSON Pointer
    {{random.int(1, 100)}}          seeded integer in [min, max]
    {{random.float(0, 1)}}          seeded float in [min, max), 6 decimals
    {{random.uuid()}}               seeded UUIDv4-shaped identifier
    {{random.hex(8)}}               seeded lowercase hex string of n chars (1-64)
    {{random.bool()}}               seeded boolean
    {{random.choice("a", "b", 3)}}  seeded pick from 1-20 scalar arguments

A string that is *exactly* one expression renders to the expression's native JSON value (numbers
stay numbers, objects stay objects); an expression embedded in surrounding text renders to its
string form. ``{{{{`` escapes a literal ``{{``. Unresolvable references (missing query parameter,
absent fixture) render to ``null`` when whole-string and ``""`` when embedded — never an error at
serve time.

Determinism: all ``random.*`` values come from one :class:`random.Random` seeded from the caller's
``(seed, scope)`` (see :func:`make_rng`), and rendering walks the response in stored order, so the
same stored response, request seed, and scope always produce byte-identical output.

Limits (CPU and output): every renderer step draws from a shared :class:`RenderBudget` — a
deterministic operation budget, an output byte cap, and a wall-clock deadline. Exceeding any of
them raises :class:`TemplateLimitError`, which the runtime converts into a problem response.

Save-time validation: :func:`validate_template_value` / :func:`validate_template_text` parse every
string and report syntax errors, unknown roots or functions, bad arguments, and over-limit
templates, so a saved scenario can only contain well-formed templates.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, List, Mapping, Optional, Tuple, Union

from .mock_match import MatchContext, resolve_json_pointer

MAX_TEMPLATE_TEXT_CHARS = 65_536
"""Maximum length of one template string."""

MAX_EXPRESSION_CHARS = 512
"""Maximum length of one ``{{ ... }}`` expression."""

MAX_EXPRESSIONS_PER_VALUE = 200
"""Maximum expressions across one templated value (save-time cap)."""

DEFAULT_MAX_RENDER_OPS = 10_000
"""Default deterministic operation budget for one render."""

DEFAULT_MAX_OUTPUT_BYTES = 262_144
"""Default output cap for one render (256 KiB, matching the settings-blob cap)."""

DEFAULT_RENDER_DEADLINE_SECONDS = 0.25
"""Default wall-clock budget for one render."""

_OPEN = "{{"
_CLOSE = "}}"
_ESCAPED_OPEN = "{{{{"

_RANDOM_FUNCTIONS = ("int", "float", "uuid", "hex", "bool", "choice")
_MAX_CHOICE_ARGS = 20
_MAX_HEX_CHARS = 64
_MAX_RANDOM_MAGNITUDE = 1e15

_NAME_PATTERN = re.compile(r"[^\s#(){}\"',]+\Z")
_FIXTURE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_NUMBER_PATTERN = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")

_MISSING = object()


class TemplateError(ValueError):
    """A template failed to parse or validate (save-time error)."""


class TemplateLimitError(RuntimeError):
    """A render exceeded its CPU, output, or wall-clock budget."""


@dataclass
class RenderBudget:
    """Shared limits for one render pass.

    Attributes:
        max_ops: Deterministic operation budget (every step consumes at least one).
        max_output_bytes: Cumulative cap on rendered output size.
        deadline: Absolute ``time.monotonic()`` cutoff for the render.
    """

    max_ops: int = DEFAULT_MAX_RENDER_OPS
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES
    deadline: float = field(default_factory=lambda: time.monotonic() + DEFAULT_RENDER_DEADLINE_SECONDS)
    ops_used: int = 0
    bytes_used: int = 0

    def spend(self, *, ops: int = 1, output_bytes: int = 0) -> None:
        """Consume budget; raises :class:`TemplateLimitError` when any limit is crossed."""
        self.ops_used += ops
        self.bytes_used += output_bytes
        if self.ops_used > self.max_ops:
            raise TemplateLimitError(f"template render exceeded the operation budget ({self.max_ops}).")
        if self.bytes_used > self.max_output_bytes:
            raise TemplateLimitError(f"template output exceeded {self.max_output_bytes} bytes.")
        if time.monotonic() > self.deadline:
            raise TemplateLimitError("template render exceeded its time budget.")


@dataclass(frozen=True)
class RenderEnv:
    """Everything a render may read: the request, the seeded RNG, and fixture data."""

    ctx: MatchContext
    rng: random.Random
    fixtures: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class _RequestRef:
    """``request.*`` reference: a field plus an optional name / body pointer."""

    request_field: str
    name: str = ""
    pointer: Optional[str] = None


@dataclass(frozen=True)
class _FixtureRef:
    """``fixture.<name>`` reference with an optional JSON Pointer fragment."""

    name: str
    pointer: Optional[str] = None


@dataclass(frozen=True)
class _RandomCall:
    """``random.<fn>(args...)`` call with already-validated scalar arguments."""

    fn: str
    args: Tuple[Any, ...] = ()


_Expr = Union[_RequestRef, _FixtureRef, _RandomCall]
_Segment = Union[str, _RequestRef, _FixtureRef, _RandomCall]


def make_rng(seed: int, *scope: str) -> random.Random:
    """Build the deterministic RNG for one render.

    Mirrors ``apiome_mock.schema_synthesizer._seeded_rng``: the scope strings (scenario name,
    operation key, rule/response indexes) are hashed into the seed so distinct responses draw
    distinct-but-reproducible streams.
    """
    digest = hashlib.sha256(("\x00".join(scope)).encode("utf-8")).hexdigest()
    return random.Random(seed ^ int(digest[:16], 16))


def _split_pointer(text: str, *, context: str) -> Tuple[str, Optional[str]]:
    """Split ``name#/pointer`` into ``(name, pointer)``; pointer syntax is checked."""
    if "#" not in text:
        return text, None
    name, _, pointer = text.partition("#")
    if pointer != "" and not pointer.startswith("/"):
        raise TemplateError(f'{context}: JSON Pointer must be "" or start with "/" (got "#{pointer}").')
    return name, pointer


def _parse_argument(raw: str, *, context: str) -> Any:
    """Parse one ``random.*`` call argument: a quoted string or a number."""
    text = raw.strip()
    if len(text) >= 2 and text[0] in "'\"" and text[-1] == text[0]:
        inner = text[1:-1]
        if text[0] in inner or "\\" in inner:
            raise TemplateError(f"{context}: string arguments cannot contain quotes or backslashes.")
        return inner
    if _NUMBER_PATTERN.match(text):
        return float(text) if "." in text else int(text)
    raise TemplateError(f"{context}: arguments must be quoted strings or numbers (got '{text}').")


def _split_arguments(raw: str) -> List[str]:
    """Split a call argument list on commas outside quotes."""
    parts: List[str] = []
    current: List[str] = []
    quote: Optional[str] = None
    for char in raw:
        if quote is not None:
            current.append(char)
            if char == quote:
                quote = None
        elif char in "'\"":
            current.append(char)
            quote = char
        elif char == ",":
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def _validate_random_args(fn: str, args: Tuple[Any, ...], *, context: str) -> None:
    """Check argument count/types/ranges for one ``random.*`` function."""
    if fn in ("int", "float"):
        if len(args) != 2 or any(isinstance(arg, str) for arg in args):
            raise TemplateError(f"{context}: random.{fn} takes exactly two numeric arguments (min, max).")
        low, high = args
        if fn == "int" and any(isinstance(arg, float) for arg in args):
            raise TemplateError(f"{context}: random.int arguments must be integers.")
        if abs(float(low)) > _MAX_RANDOM_MAGNITUDE or abs(float(high)) > _MAX_RANDOM_MAGNITUDE:
            raise TemplateError(f"{context}: random.{fn} bounds must stay within ±{_MAX_RANDOM_MAGNITUDE:.0e}.")
        if float(low) > float(high):
            raise TemplateError(f"{context}: random.{fn} requires min <= max.")
    elif fn == "hex":
        if len(args) != 1 or not isinstance(args[0], int):
            raise TemplateError(f"{context}: random.hex takes one integer argument.")
        if not 1 <= args[0] <= _MAX_HEX_CHARS:
            raise TemplateError(f"{context}: random.hex length must be between 1 and {_MAX_HEX_CHARS}.")
    elif fn in ("uuid", "bool"):
        if args:
            raise TemplateError(f"{context}: random.{fn} takes no arguments.")
    elif fn == "choice":
        if not 1 <= len(args) <= _MAX_CHOICE_ARGS:
            raise TemplateError(f"{context}: random.choice takes between 1 and {_MAX_CHOICE_ARGS} arguments.")


def _parse_expression(text: str, *, context: str) -> _Expr:
    """Parse the inside of one ``{{ ... }}`` placeholder."""
    expr = text.strip()
    if not expr:
        raise TemplateError(f"{context}: empty expression.")
    if len(expr) > MAX_EXPRESSION_CHARS:
        raise TemplateError(f"{context}: expression exceeds {MAX_EXPRESSION_CHARS} characters.")

    if expr.startswith("request."):
        rest = expr[len("request.") :]
        if rest == "method":
            return _RequestRef(request_field="method")
        if rest == "body" or rest.startswith("body#"):
            _, pointer = _split_pointer(rest, context=context)
            return _RequestRef(request_field="body", pointer=pointer if pointer is not None else "")
        for prefix in ("path.", "query.", "header."):
            if rest.startswith(prefix):
                name = rest[len(prefix) :]
                if not _NAME_PATTERN.match(name):
                    raise TemplateError(f"{context}: invalid {prefix[:-1]} name '{name}'.")
                return _RequestRef(request_field=prefix[:-1], name=name)
        raise TemplateError(
            f"{context}: unknown request field '{rest}' "
            "(allowed: method, path.<name>, query.<name>, header.<name>, body, body#/<pointer>)."
        )

    if expr.startswith("fixture."):
        rest = expr[len("fixture.") :]
        name, pointer = _split_pointer(rest, context=context)
        if not _FIXTURE_NAME_PATTERN.match(name):
            raise TemplateError(f"{context}: invalid fixture name '{name}'.")
        return _FixtureRef(name=name, pointer=pointer)

    if expr.startswith("random."):
        call = expr[len("random.") :]
        match = re.fullmatch(r"([a-z]+)\((.*)\)", call, flags=re.DOTALL)
        if match is None:
            raise TemplateError(f"{context}: random expressions are calls, e.g. random.int(1, 10).")
        fn, raw_args = match.group(1), match.group(2)
        if fn not in _RANDOM_FUNCTIONS:
            allowed = ", ".join(_RANDOM_FUNCTIONS)
            raise TemplateError(f"{context}: unknown function random.{fn} (allowed: {allowed}).")
        args: Tuple[Any, ...] = ()
        if raw_args.strip():
            args = tuple(_parse_argument(part, context=context) for part in _split_arguments(raw_args))
        _validate_random_args(fn, args, context=context)
        return _RandomCall(fn=fn, args=args)

    raise TemplateError(f"{context}: unknown expression root (allowed: request, random, fixture).")


def parse_template(text: str, *, context: str = "template") -> Tuple[_Segment, ...]:
    """Tokenize one template string into literal and expression segments.

    Raises:
        TemplateError: On unterminated placeholders, over-long text, or invalid expressions.
    """
    if len(text) > MAX_TEMPLATE_TEXT_CHARS:
        raise TemplateError(f"{context}: template string exceeds {MAX_TEMPLATE_TEXT_CHARS} characters.")
    segments: List[_Segment] = []
    position = 0
    while position < len(text):
        start = text.find(_OPEN, position)
        if start == -1:
            segments.append(text[position:])
            break
        if start > position:
            segments.append(text[position:start])
        if text.startswith(_ESCAPED_OPEN, start):
            segments.append(_OPEN)
            position = start + len(_ESCAPED_OPEN)
            continue
        end = text.find(_CLOSE, start + len(_OPEN))
        if end == -1:
            raise TemplateError(f"{context}: unterminated '{{{{' placeholder.")
        segments.append(_parse_expression(text[start + len(_OPEN) : end], context=context))
        position = end + len(_CLOSE)
    return tuple(segments)


def _evaluate_random(call: _RandomCall, rng: random.Random) -> Any:
    """Draw one value from the seeded RNG for a ``random.*`` call."""
    if call.fn == "int":
        return rng.randint(int(call.args[0]), int(call.args[1]))
    if call.fn == "float":
        return round(rng.uniform(float(call.args[0]), float(call.args[1])), 6)
    if call.fn == "uuid":
        return str(uuid.UUID(int=rng.getrandbits(128), version=4))
    if call.fn == "hex":
        length = int(call.args[0])
        return format(rng.getrandbits(4 * length), f"0{length}x")
    if call.fn == "bool":
        return rng.random() < 0.5
    return rng.choice(call.args)


def _evaluate(expr: _Expr, env: RenderEnv, budget: RenderBudget) -> Any:
    """Evaluate one expression; returns :data:`_MISSING` for unresolvable references."""
    budget.spend()
    if isinstance(expr, _RandomCall):
        return _evaluate_random(expr, env.rng)
    if isinstance(expr, _FixtureRef):
        if expr.name not in env.fixtures:
            return _MISSING
        value, found = resolve_json_pointer(env.fixtures[expr.name], expr.pointer or "")
        return value if found else _MISSING
    ctx = env.ctx
    if expr.request_field == "method":
        return ctx.method
    if expr.request_field == "path":
        return ctx.path_params.get(expr.name, _MISSING)
    if expr.request_field == "query":
        values = ctx.query.get(expr.name, ())
        return values[0] if values else _MISSING
    if expr.request_field == "header":
        return ctx.headers.get(expr.name.lower(), _MISSING)
    if not ctx.body_present:
        return _MISSING
    value, found = resolve_json_pointer(ctx.body, expr.pointer or "")
    return value if found else _MISSING


def _stringify(value: Any) -> str:
    """Render a resolved value for embedding inside surrounding text."""
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"), default=str)


def render_text(text: str, env: RenderEnv, budget: RenderBudget) -> str:
    """Render one template string to text (used for header values and embedded strings).

    Unparseable templates are returned verbatim: stored settings were validated on save, so a
    malformed string reaching the runtime is served as literal text rather than failing the mock.

    Raises:
        TemplateLimitError: When the render budget is exhausted.
    """
    rendered = render_value(text, env, budget)
    return rendered if isinstance(rendered, str) else _stringify(rendered)


def render_value(value: Any, env: RenderEnv, budget: RenderBudget) -> Any:
    """Render every template inside a JSON value, preserving structure and key order.

    Strings that are exactly one expression become the expression's native value (``null`` when
    unresolvable); mixed strings render each expression to text (``""`` when unresolvable).
    Mapping keys are never rendered. Unparseable strings pass through verbatim.

    Raises:
        TemplateLimitError: When the render budget is exhausted.
    """
    budget.spend()
    if isinstance(value, str):
        if _OPEN not in value:
            budget.spend(ops=0, output_bytes=len(value))
            return value
        try:
            segments = parse_template(value)
        except TemplateError:
            budget.spend(ops=0, output_bytes=len(value))
            return value
        expressions = [segment for segment in segments if not isinstance(segment, str)]
        literals_empty = all(segment == "" for segment in segments if isinstance(segment, str))
        if len(expressions) == 1 and literals_empty:
            resolved = _evaluate(expressions[0], env, budget)
            if resolved is _MISSING:
                resolved = None
            budget.spend(ops=0, output_bytes=len(_stringify(resolved)))
            return resolved
        parts: List[str] = []
        for segment in segments:
            if isinstance(segment, str):
                parts.append(segment)
            else:
                resolved = _evaluate(segment, env, budget)
                parts.append("" if resolved is _MISSING else _stringify(resolved))
            budget.spend(ops=0, output_bytes=len(parts[-1]))
        return "".join(parts)
    if isinstance(value, Mapping):
        return {key: render_value(entry, env, budget) for key, entry in value.items()}
    if isinstance(value, (list, tuple)):
        return [render_value(entry, env, budget) for entry in value]
    return value


def _walk_strings(value: Any, path: str) -> List[Tuple[str, str]]:
    """Collect every string in a JSON value as ``(path, text)`` pairs."""
    if isinstance(value, str):
        return [(path, value)]
    found: List[Tuple[str, str]] = []
    if isinstance(value, Mapping):
        for key, entry in value.items():
            found.extend(_walk_strings(entry, f"{path}/{key}"))
    elif isinstance(value, (list, tuple)):
        for index, entry in enumerate(value):
            found.extend(_walk_strings(entry, f"{path}/{index}"))
    return found


def validate_template_text(text: str, *, context: str = "template") -> List[str]:
    """Validate one template string; returns error messages (empty when valid)."""
    try:
        parse_template(text, context=context)
    except TemplateError as exc:
        return [str(exc)]
    return []


def validate_template_value(value: Any, *, context: str = "body") -> List[str]:
    """Validate every template inside a JSON value for the save path.

    Checks each string's syntax and caps the total expression count at
    :data:`MAX_EXPRESSIONS_PER_VALUE`.
    """
    errors: List[str] = []
    expression_count = 0
    for path, text in _walk_strings(value, context):
        if _OPEN not in text:
            continue
        try:
            segments = parse_template(text, context=path)
        except TemplateError as exc:
            errors.append(str(exc))
            continue
        expression_count += sum(1 for segment in segments if not isinstance(segment, str))
    if expression_count > MAX_EXPRESSIONS_PER_VALUE:
        errors.append(f"{context}: at most {MAX_EXPRESSIONS_PER_VALUE} template expressions are allowed.")
    return errors


def value_contains_template(value: Any) -> bool:
    """Whether any string in ``value`` parses to at least one template expression."""
    for _, text in _walk_strings(value, ""):
        if _OPEN not in text:
            continue
        try:
            segments = parse_template(text)
        except TemplateError:
            continue
        if any(not isinstance(segment, str) for segment in segments):
            return True
    return False


def value_references_request_body(value: Any) -> bool:
    """Whether any template expression in ``value`` reads ``request.body``."""
    for _, text in _walk_strings(value, ""):
        if _OPEN not in text:
            continue
        try:
            segments = parse_template(text)
        except TemplateError:
            continue
        for segment in segments:
            if isinstance(segment, _RequestRef) and segment.request_field == "body":
                return True
    return False
