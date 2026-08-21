"""WIT identifier and type-expression mapping — FMT-2.6 (#5424).

The half of the WIT emitter that answers two narrow questions, so
:mod:`app.wit_emitter` can concentrate on assembling the package document:

* **what is this construct called in WIT?** — WIT identifiers are
  ``lower-kebab-case`` words (optionally ``%``-escaped when they collide with a
  keyword), a grammar most canonical names do not already satisfy. :func:`wit_identifier`
  rewrites one name; :class:`WitNameAllocator` keeps a scope's names distinct.

* **how is this type spelled in WIT?** — :class:`WitTypeRenderer` maps a
  :class:`~app.canonical_model.TypeRef` onto a WIT type expression, resolving named
  types through an injected resolver and wrapping the levels WIT spells with a
  generic (``list<…>``, ``option<…>``, ``borrow<…>``, ``stream<…>``).

Both record what they could not carry through the *same three ledger classes the WIT
importer records* (IXH-7.9), so the two directions describe the same ledger rather
than two private vocabularies — see :class:`WitLossClass`.

The module is pure: no I/O, no global state, and every collection it walks is walked
in the order it was given, so an emit of the same model is byte-identical.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple

from .canonical_model import TypeRef
from .emitter import Loss, LossKind, LossTracker
from .projection_taxonomy import ProjectionReason, ProjectionStatus

__all__ = [
    "WIT_KEYWORDS",
    "WIT_IDENTIFIER_RE",
    "CANONICAL_TO_WIT_PRIMITIVE",
    "CANONICAL_TO_WIT_APPROXIMATION",
    "WIT_UNTYPED_FALLBACK",
    "WitLossClass",
    "LEDGER_OUTCOME",
    "LOSS_KIND_FOR_CLASS",
    "LOSS_LEDGER_CLASS",
    "record_wit_loss",
    "wit_identifier",
    "is_wit_identifier",
    "WitNameAllocator",
    "WitTypeRenderer",
    "referenced_identifiers",
]


# ===========================================================================
# Identifiers
# ===========================================================================

#: Words the WIT grammar reserves. A canonical name that lands on one of these is
#: emitted in the explicit-identifier form (``%record``), which the grammar accepts
#: anywhere a plain identifier is accepted — so a type honestly called ``record``
#: keeps its name instead of being silently renamed.
WIT_KEYWORDS: frozenset = frozenset(
    {
        "as",
        "async",
        "bool",
        "borrow",
        "char",
        "constructor",
        "enum",
        "export",
        "f32",
        "f64",
        "flags",
        "float32",
        "float64",
        "from",
        "func",
        "future",
        "import",
        "include",
        "interface",
        "list",
        "option",
        "own",
        "package",
        "record",
        "resource",
        "result",
        "s8",
        "s16",
        "s32",
        "s64",
        "static",
        "stream",
        "string",
        "tuple",
        "type",
        "u8",
        "u16",
        "u32",
        "u64",
        "use",
        "variant",
        "with",
        "world",
    }
)

#: The grammar one WIT identifier must satisfy (mirrors ``app.wit_parser._ID``).
WIT_IDENTIFIER_RE = re.compile(r"%?[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z")

#: Where a camel/Pascal-cased word breaks into kebab segments.
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")

#: Everything that is not a word character is a segment separator.
_SEPARATOR = re.compile(r"[^0-9A-Za-z]+")


def _segments(raw: str) -> List[str]:
    """Split ``raw`` into lower-case WIT name segments.

    ``GetPet`` → ``['get', 'pet']``; ``GET /pets/{id}`` → ``['get', 'pets', 'id']``;
    ``HTTPServer`` → ``['http', 'server']``.

    Args:
        raw: Any source spelling.

    Returns:
        The segments, in order; empty when ``raw`` holds no word characters.
    """
    spaced = _CAMEL_BOUNDARY.sub(" ", raw)
    return [part.lower() for part in _SEPARATOR.split(spaced) if part]


def wit_identifier(raw: Optional[str], *, fallback: str = "item") -> str:
    """Rewrite one source name as a WIT identifier.

    Args:
        raw: The source spelling (a type, service, operation or field name, or a
            canonical key). ``None`` and names with no word characters fall back.
        fallback: The name to use when ``raw`` yields no segments at all.

    Returns:
        A ``lower-kebab-case`` identifier the WIT grammar accepts, ``%``-escaped
        when it collides with a reserved word and ``x-``-prefixed when the source
        started with a digit (a WIT identifier must start with a letter).
    """
    parts = _segments(raw or "") or _segments(fallback) or ["item"]
    identifier = "-".join(parts)
    if not identifier[0].isalpha():
        identifier = f"x-{identifier}"
    if identifier in WIT_KEYWORDS:
        identifier = f"%{identifier}"
    return identifier


def is_wit_identifier(candidate: str) -> bool:
    """Return whether ``candidate`` is already a legal WIT identifier."""
    return bool(WIT_IDENTIFIER_RE.match(candidate))


#: Every identifier-shaped token inside a WIT type expression.
_REFERENCE_RE = re.compile(r"%?[a-z][a-z0-9]*(?:-[a-z0-9]+)*")


def referenced_identifiers(expression: str) -> List[str]:
    """Return the type names a verbatim WIT type expression refers to.

    Generic heads and primitives (``list``, ``option``, ``result``, ``u32``, …) are
    reserved words, so filtering :data:`WIT_KEYWORDS` out of the identifier-shaped
    tokens leaves exactly the *named* types the expression depends on.

    Args:
        expression: A WIT type expression, e.g. ``result<option<row>, lookup-error>``.

    Returns:
        The distinct named-type references, sorted for determinism.
    """
    return sorted(
        {
            token
            for token in _REFERENCE_RE.findall(expression)
            if token not in WIT_KEYWORDS
        }
    )


class WitNameAllocator:
    """Hands out identifiers that are unique within one WIT scope.

    A WIT scope — the package's interfaces and worlds, one interface's types, one
    interface's functions, one record's fields — may not declare the same name
    twice, but two canonical names can normalize onto one identifier (``getPet``
    and ``get-pet``). The allocator appends a counted suffix in that case, which is
    deterministic because it depends only on the order names are offered in.
    """

    def __init__(self, reserved: Iterable[str] = ()) -> None:
        """Create an allocator.

        Args:
            reserved: Identifiers that are already taken in this scope.
        """
        self._used: Set[str] = set(reserved)

    def allocate(self, raw: Optional[str], *, fallback: str = "item") -> str:
        """Return a free identifier derived from ``raw`` and mark it taken.

        Args:
            raw: The source spelling to derive from.
            fallback: The name to derive from when ``raw`` yields no segments.

        Returns:
            The allocated identifier.
        """
        base = wit_identifier(raw, fallback=fallback)
        candidate = base
        counter = 2
        while candidate in self._used:
            candidate = f"{base}-{counter}"
            counter += 1
        self._used.add(candidate)
        return candidate

    def reserve(self, identifier: str) -> None:
        """Mark ``identifier`` taken without deriving it from a source name."""
        self._used.add(identifier)

    def taken(self) -> Set[str]:
        """Return a copy of the identifiers allocated so far."""
        return set(self._used)


# ===========================================================================
# Scalars
# ===========================================================================

#: Canonical scalar name → the WIT type expression that carries it **exactly**.
#: The inverse of :data:`app.wit_normalizer._WIT_PRIMITIVE_TO_CANONICAL`, widened
#: with the spellings other normalizers produce for the same wire types so a
#: protobuf ``int32`` and an OpenAPI ``integer`` both land on a real WIT integer.
CANONICAL_TO_WIT_PRIMITIVE: Dict[str, str] = {
    "bool": "bool",
    "boolean": "bool",
    "byte": "s8",
    "bytes": "list<u8>",
    "binary": "list<u8>",
    "blob": "list<u8>",
    "char": "char",
    "character": "char",
    "double": "f64",
    "float": "f32",
    "float32": "f32",
    "float64": "f64",
    "i16": "s16",
    "i32": "s32",
    "i64": "s64",
    "int": "s32",
    "int8": "s8",
    "int16": "s16",
    "int32": "s32",
    "int64": "s64",
    "integer": "s64",
    "long": "s64",
    "s8": "s8",
    "s16": "s16",
    "s32": "s32",
    "s64": "s64",
    "short": "s16",
    "str": "string",
    "string": "string",
    "text": "string",
    "u8": "u8",
    "u16": "u16",
    "u32": "u32",
    "u64": "u64",
    "uint8": "u8",
    "uint16": "u16",
    "uint32": "u32",
    "uint64": "u64",
}

#: Canonical scalar name → (WIT expression, why the mapping is lossy). These are
#: carried by a WIT type that is *related* but not equivalent: a semantic format
#: WIT has no vocabulary for, or a number whose range/precision WIT cannot state.
CANONICAL_TO_WIT_APPROXIMATION: Dict[str, Tuple[str, str]] = {
    "any": ("string", "an unconstrained value is emitted as its `string` rendering"),
    "date": ("string", "WIT has no date type; the value is emitted as a `string`"),
    "datetime": ("string", "WIT has no timestamp type; the value is emitted as a `string`"),
    "date-time": ("string", "WIT has no timestamp type; the value is emitted as a `string`"),
    "decimal": ("f64", "WIT has no arbitrary-precision decimal; `f64` loses precision"),
    "id": ("string", "WIT has no opaque identifier type; the value is emitted as a `string`"),
    "duration": ("string", "WIT has no duration type; the value is emitted as a `string`"),
    "json": ("string", "WIT has no anonymous JSON value; the value is emitted as its text"),
    "negativeinteger": ("s64", "WIT has no bounded integer; `s64` does not enforce the bound"),
    "nonnegativeinteger": ("u64", "WIT has no bounded integer; `u64` does not enforce the bound"),
    "nonpositiveinteger": ("s64", "WIT has no bounded integer; `s64` does not enforce the bound"),
    "null": ("string", "WIT has no null literal type; the value is emitted as a `string`"),
    "positiveinteger": ("u64", "WIT has no bounded integer; `u64` does not enforce the bound"),
    "number": ("f64", "an unbounded `number` is emitted as `f64`, which bounds it"),
    "object": ("string", "WIT has no anonymous object type; the value is emitted as its text"),
    "time": ("string", "WIT has no time type; the value is emitted as a `string`"),
    "timestamp": ("string", "WIT has no timestamp type; the value is emitted as a `string`"),
    "uri": ("string", "WIT has no URI type; the value is emitted as a `string`"),
    "url": ("string", "WIT has no URL type; the value is emitted as a `string`"),
    "uuid": ("string", "WIT has no UUID type; the value is emitted as a `string`"),
    "void": ("string", "WIT has no unit type outside a function result"),
}

#: What a reference with neither a name nor an element type is emitted as. A
#: canonical field can be genuinely typeless (a normalizer that could not read the
#: source's type); WIT has no ``any``, so the value is carried as its text.
WIT_UNTYPED_FALLBACK = "string"


# ===========================================================================
# The ledger (symmetric with the importer's three capability-limit classes)
# ===========================================================================


class WitLossClass(str, Enum):
    """The three classes of loss a WIT projection can incur.

    They are the emit-direction mirror of the three capability-limit classes the
    **importer** records (IXH-7.9, ``app.import_preview_manifest._wit_capability_rows``
    plus ``KNOWN_PARSER_LIMITS['wit']``), expressed in the same shared taxonomy
    (:class:`~app.projection_taxonomy.ProjectionStatus` /
    :class:`~app.projection_taxonomy.ProjectionReason`) rather than in a private
    vocabulary:

    ================================  ================================================
    importer class                    this emitter's mirror
    ================================  ================================================
    ``partially-mapped`` — the WIT     :attr:`PARTIALLY_MAPPED` — the canonical
    construct is normalized and its    construct is emitted, and the part WIT cannot
    inexpressible part is preserved    hold is stated rather than dropped
    in ``extras``
    ``inferred`` — a reference is      :attr:`INFERRED` — a reference is emitted by
    kept by name, the definition       name, or a construct is invented, because the
    behind it was not supplied         model did not supply what WIT requires
    ``not-parsed-by-adapter`` — a      :attr:`UNSUPPORTED` — a construct has no WIT
    declared limit of our parser       spelling at all, so nothing is written
    ================================  ================================================

    Only the third class inverts its *reason*: where the importer blames our parser
    (``source_parse_limit``) for a WIT construct it declines to read, the emit
    direction blames the destination grammar (``destination_unsupported``) — there is
    no WIT spelling to write, rather than a WIT spelling this emitter refuses to.
    """

    PARTIALLY_MAPPED = "partially-mapped"
    INFERRED = "inferred"
    UNSUPPORTED = "unsupported"


#: Loss class → the shared-taxonomy ``(status, reason)`` pair it stands for. This is
#: the bijection that makes the symmetry checkable rather than merely asserted.
LEDGER_OUTCOME: Dict[WitLossClass, Tuple[ProjectionStatus, ProjectionReason]] = {
    WitLossClass.PARTIALLY_MAPPED: (
        ProjectionStatus.APPROXIMATED,
        ProjectionReason.DESTINATION_UNSUPPORTED,
    ),
    WitLossClass.INFERRED: (
        ProjectionStatus.SYNTHESIZED,
        ProjectionReason.SOURCE_INCOMPLETE,
    ),
    WitLossClass.UNSUPPORTED: (
        ProjectionStatus.DROPPED,
        ProjectionReason.DESTINATION_UNSUPPORTED,
    ),
}

#: Loss class → the :class:`~app.emitter.LossKind` the emitter envelope carries it as.
#: ``LossKind`` is a two-valued channel (something was emitted through a derived
#: representation, or nothing was emitted at all), so the first two classes share a
#: kind and are told apart by :data:`LOSS_LEDGER_CLASS`.
LOSS_KIND_FOR_CLASS: Dict[WitLossClass, LossKind] = {
    WitLossClass.PARTIALLY_MAPPED: LossKind.INFERRED,
    WitLossClass.INFERRED: LossKind.INFERRED,
    WitLossClass.UNSUPPORTED: LossKind.NA,
}

#: Every loss subject this projection can record → its ledger class. A subject that
#: is not in this table cannot be recorded (:func:`record_wit_loss` refuses it), so
#: the ledger cannot grow a class the importer has no counterpart for.
LOSS_LEDGER_CLASS: Dict[str, WitLossClass] = {
    # --- partially mapped: emitted, but WIT cannot hold all of it ---
    "additional-response": WitLossClass.PARTIALLY_MAPPED,
    "default-value": WitLossClass.PARTIALLY_MAPPED,
    "deprecated-marker": WitLossClass.PARTIALLY_MAPPED,
    "documentation-comment": WitLossClass.PARTIALLY_MAPPED,
    "field-identity": WitLossClass.PARTIALLY_MAPPED,
    "http-binding": WitLossClass.PARTIALLY_MAPPED,
    "inline-payload-schema": WitLossClass.PARTIALLY_MAPPED,
    "open-ended-map": WitLossClass.PARTIALLY_MAPPED,
    "renamed-identifier": WitLossClass.PARTIALLY_MAPPED,
    "resource-methods": WitLossClass.PARTIALLY_MAPPED,
    "scalar-approximation": WitLossClass.PARTIALLY_MAPPED,
    "undiscriminated-union": WitLossClass.PARTIALLY_MAPPED,
    "untyped-value": WitLossClass.PARTIALLY_MAPPED,
    "validation-constraints": WitLossClass.PARTIALLY_MAPPED,
    # --- inferred: invented, or kept by name only, because the model was silent ---
    "synthesized-interface": WitLossClass.INFERRED,
    "synthesized-package-name": WitLossClass.INFERRED,
    "synthesized-world": WitLossClass.INFERRED,
    "unresolved-type-reference": WitLossClass.INFERRED,
    "unsupported-version-literal": WitLossClass.INFERRED,
    # --- unsupported: WIT has no spelling, so nothing is written ---
    "event-channel": WitLossClass.UNSUPPORTED,
    "event-operation": WitLossClass.UNSUPPORTED,
    "security-scheme": WitLossClass.UNSUPPORTED,
    "server-binding": WitLossClass.UNSUPPORTED,
    "streaming-operation": WitLossClass.UNSUPPORTED,
}


def record_wit_loss(
    losses: LossTracker,
    subject: str,
    detail: str,
    pointer: Optional[str] = None,
) -> Loss:
    """Record one projection loss under its declared ledger class.

    Args:
        losses: The tracker collecting this emit's losses.
        subject: A slug from :data:`LOSS_LEDGER_CLASS`.
        detail: Human-readable explanation of what was not carried.
        pointer: The canonical key (or emitted coordinate) the loss concerns.

    Returns:
        The :class:`~app.emitter.Loss` that was recorded, for callers that want to
        assert on it without re-reading the tracker.

    Raises:
        KeyError: When ``subject`` is not a declared subject — a new kind of loss
            must be classified in :data:`LOSS_LEDGER_CLASS` first, which is what
            keeps this ledger symmetric with the importer's.
    """
    kind = LOSS_KIND_FOR_CLASS[LOSS_LEDGER_CLASS[subject]]
    losses.record(kind, subject, detail, pointer)
    return Loss(kind=kind, subject=subject, detail=detail, pointer=pointer)


# ===========================================================================
# Type expressions
# ===========================================================================

#: ``extras`` key holding the verbatim WIT spelling of a construct the canonical
#: model could only approximate (``tuple<…>``, a nested ``result<…>``, ``char``).
_EXTRA_TYPE = "wit_type"
#: ``extras`` key holding a resource handle kind (``borrow`` / ``own``).
_EXTRA_HANDLE = "wit_handle"
#: ``extras`` key holding an async wrapper kind (``stream`` / ``future``).
_EXTRA_ASYNC = "wit_async"


class WitTypeRenderer:
    """Renders a :class:`~app.canonical_model.TypeRef` as a WIT type expression.

    Named types are resolved through the injected ``resolve`` callable, which the
    emitter supplies: it maps a canonical type key onto the identifier that type is
    declared under *in the interface currently being written* (registering a ``use``
    statement as a side effect when the type lives in a sibling interface). Anything
    the resolver cannot place is emitted by name and reported as an unresolved
    reference, never silently replaced.

    Wrapper levels are rendered outermost-last: a nullable list of borrowed handles
    is ``option<list<borrow<t>>>``, matching the order
    :meth:`app.wit_normalizer.WitNormalizer._type_ref` unwrapped them in.
    """

    def __init__(
        self,
        *,
        resolve: Callable[[str], Optional[str]],
        losses: LossTracker,
        link: Optional[Callable[[str, Optional[str]], None]] = None,
    ) -> None:
        """Create a renderer.

        Args:
            resolve: Canonical type key → the identifier to spell it with in the
                current scope, or ``None`` when the model defines no such type.
            losses: Tracker for constructs WIT could not carry faithfully.
            link: Called with every verbatim WIT expression written back from
                ``extras``, so the caller can register the ``use`` statements the
                names inside it need. A verbatim expression bypasses ``resolve``
                (it is already WIT text), which is exactly why it needs this hook.
        """
        self._resolve = resolve
        self._losses = losses
        self._link = link
        # One report per distinct name: a model with a hundred `date-time` fields
        # should say so once, not bury the ledger under a hundred identical rows.
        self._reported: Set[Tuple[str, str]] = set()

    def link(self, expression: str, pointer: Optional[str] = None) -> str:
        """Normalize a verbatim WIT expression and register what it depends on.

        Verbatim text written back from ``extras`` never passes through
        :meth:`render_name`, so the ``use`` statements its named types need would
        otherwise go unwritten. Every caller that emits preserved WIT text routes it
        through here.

        Args:
            expression: The WIT type expression as the importer preserved it.
            pointer: Canonical key of the construct being rendered, for loss reports.

        Returns:
            The expression with its whitespace collapsed.
        """
        normalized = " ".join(expression.split())
        if self._link is not None:
            self._link(normalized, pointer)
        return normalized

    def render(self, ref: Optional[TypeRef], *, pointer: Optional[str] = None) -> str:
        """Render ``ref`` as a WIT type expression.

        Args:
            ref: The reference to render; ``None`` renders the untyped fallback.
            pointer: Canonical key of the construct being rendered, for loss reports.

        Returns:
            A WIT type expression (``list<u8>``, ``option<pet>``, ``borrow<table>``).
        """
        if ref is None:
            return WIT_UNTYPED_FALLBACK
        expression = self._render_base(ref, pointer)
        handle = ref.extras.get(_EXTRA_HANDLE)
        if handle in ("borrow", "own"):
            expression = f"{handle}<{expression}>"
        wrapper = ref.extras.get(_EXTRA_ASYNC)
        if wrapper in ("stream", "future"):
            expression = f"{wrapper}<{expression}>"
        if ref.nullable:
            expression = f"option<{expression}>"
        return expression

    def _render_base(self, ref: TypeRef, pointer: Optional[str]) -> str:
        """Render the non-wrapper core of ``ref``."""
        verbatim = ref.extras.get(_EXTRA_TYPE)
        if isinstance(verbatim, str) and verbatim.strip():
            # The importer preserved the source's own WIT spelling for a construct
            # the canonical model could not hold; writing it back is exact.
            return self.link(verbatim, pointer)
        if ref.item is not None:
            return f"list<{self.render(ref.item, pointer=pointer)}>"
        if not ref.name:
            record_wit_loss(
                self._losses,
                "untyped-value",
                "The reference names no type and is not a list; WIT has no "
                f"unconstrained value type, so it is emitted as `{WIT_UNTYPED_FALLBACK}`.",
                pointer,
            )
            return WIT_UNTYPED_FALLBACK
        return self.render_name(ref.name, pointer)

    def render_name(self, name: str, pointer: Optional[str] = None) -> str:
        """Render a leaf type name — a named type, a scalar, or an unknown.

        Args:
            name: The canonical type key or scalar name at the use site.
            pointer: Canonical key of the referring construct, for loss reports.

        Returns:
            The WIT spelling of ``name``.
        """
        resolved = self._resolve(name)
        if resolved is not None:
            return resolved
        lowered = name.strip().lower()
        primitive = CANONICAL_TO_WIT_PRIMITIVE.get(lowered)
        if primitive is not None:
            return primitive
        approximation = CANONICAL_TO_WIT_APPROXIMATION.get(lowered)
        if approximation is not None:
            expression, reason = approximation
            if self._first_report("scalar-approximation", lowered):
                record_wit_loss(
                    self._losses,
                    "scalar-approximation",
                    f"Scalar {name!r} has no exact WIT type: {reason}.",
                    pointer,
                )
            return expression
        if self._first_report("unresolved-type-reference", name):
            record_wit_loss(
                self._losses,
                "unresolved-type-reference",
                f"Type reference {name!r} names no type this model defines and no known "
                "scalar; it is emitted by name, so the package resolves only where that "
                "name is supplied by another package.",
                pointer,
            )
        return wit_identifier(name, fallback="unknown-type")

    def _first_report(self, subject: str, name: str) -> bool:
        """Return whether ``(subject, name)`` has not been reported yet this emit."""
        if (subject, name) in self._reported:
            return False
        self._reported.add((subject, name))
        return True
