"""CDDL emitter: canonical model → CDDL grammar — FMT-4.4 (#5437).

The inverse of :class:`app.cddl_normalizer.CddlNormalizer` and an implementation of the
:class:`app.emitter.Emitter` SPI. Writes a `.cddl` grammar — one rule per canonical type —
that RFC 8610 admits and that this repository's own reader parses back.

**Two callers, one writer, and why the difference matters.** A model imported *from* CDDL
carries the source's own spellings in ``extras`` — which prelude type a leaf was written
with, a CBOR tag, an unmapped control operator, whether a record came from a map or an
array. A model imported from anywhere else carries none of them, and its constraints are the
only thing there is to write. The writer therefore has two modes, decided per type and per
member by :func:`_is_native`:

* **native** — every CDDL construct is re-emitted from the extras that recorded it, and the
  canonical constraints are *not* re-derived, because deriving them would write the same
  facet twice (``tstr .size 32`` would come back as ``tstr .size 32 .size 32``).
* **projected** — the canonical constraints become control operators, occurrence indicators
  become the CDDL spellings, and everything CDDL cannot carry is recorded as a loss.

That split is what makes ``cddl -> cddl`` a round-trip rather than a re-derivation, and it is
the same technique the WIT emitter uses for the same reason.

**What CDDL cannot carry, declared rather than dropped.** CDDL describes a value space and
nothing else: it has no operations, no services and no channels, so an API model exports its
types and every operation becomes a stated loss. Within the types, a map's open content, a
canonical scalar with no prelude analogue, a union member that resolves to nothing, and a
constraint vocabulary CDDL has no operator for (``multiple_of``, ``unique_items``) are each
recorded through :class:`~app.emitter.LossTracker` rather than silently omitted.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from pydantic import Field

from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
from .cddl_grammar import canonical_scalar_to_cddl
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict

__all__ = [
    "CddlEmitOptions",
    "CddlEmitter",
    "CddlFidelityRulePack",
    "validate_cddl_document",
]

#: Written when a canonical scalar has no prelude analogue at all.
_FALLBACK_TYPE = "any"

#: The message every types-only drop quotes, so one sentence explains the whole family.
_TYPES_ONLY_DROP = "only data schemas are exported"

#: Characters an identifier may hold, per RFC 8610's ``id`` production.
_IDENTIFIER = re.compile(r"^[A-Za-z@_$][A-Za-z0-9@_$]*([.-]+[A-Za-z0-9@_$]+)*$")

#: Canonical constraint fields CDDL has no control operator for.
_UNSUPPORTED_CONSTRAINTS = ("multiple_of", "unique_items")


class CddlFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for CDDL export."""

    target_label = "CDDL"

    def operation_verdict(self, operation) -> FidelityVerdict:
        return FidelityVerdict.drop(
            message=f"{self.target_label} is types-only — {_TYPES_ONLY_DROP}; "
            f"the {operation.kind.value} operation is dropped",
            target_mapping="operation → dropped (types-only export)",
        )

    def channel_verdict(self, channel) -> FidelityVerdict:
        return FidelityVerdict.drop(
            message=f"{self.target_label} is types-only — {_TYPES_ONLY_DROP}; "
            "the event channel is dropped",
            target_mapping="channel → dropped (types-only export)",
        )


class CddlEmitOptions(EmitOptions):
    """Per-target options for :class:`CddlEmitter`."""

    include_comments: bool = Field(
        default=True,
        description=(
            "Carry type and member descriptions into `;` comments. CDDL has no other "
            "documentation construct, and no generated-file banner is written — a banner "
            "would read back as the grammar's own leading comment on the next import."
        ),
    )
    sockets_as_plugs: bool = Field(
        default=True,
        description=(
            "Write a type socket back as its `/=` plugs rather than as one flattened "
            "choice. Turning this off produces a closed rule a reader cannot extend."
        ),
    )


class CddlEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as a CDDL grammar."""

    key = "cddl"
    format = "cddl"
    label = "CDDL"
    description = (
        "Export as a CDDL grammar (.cddl, RFC 8610) — the schema language of CBOR, COSE "
        "and WebAuthn — with maps, arrays, choices, control operators and tags."
    )
    icon = "binary"
    paradigm = ApiParadigm.DATA_SCHEMA
    multi_file = False
    options_model = CddlEmitOptions

    OUTPUT_MEDIA_TYPE = "text/plain"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        return CapabilityProfile(
            operations=False,
            events=False,
            unions=True,
            nullability=True,
            field_identity=True,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        return CddlFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[CddlEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Render ``api`` as one CDDL document.

        Args:
            api: The canonical model to export.
            opts: Per-target options.

        Returns:
            The emitted bundle, with provenance and loss records.
        """
        options = (
            opts
            if isinstance(opts, CddlEmitOptions)
            else CddlEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        writer = _CddlWriter(api, options)
        content = writer.render()
        return EmitResult(
            files=[
                EmittedFile(
                    path=writer.output_path,
                    content=content,
                    media_type=self.OUTPUT_MEDIA_TYPE,
                )
            ],
            media_type=self.OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _is_native(extras: Dict[str, Any]) -> bool:
    """Return whether ``extras`` came from this repository's own CDDL reader.

    One flag decides the whole writing mode for a type or a member, and it is deliberately a
    single test rather than a per-facet one: a facet that is half re-emitted and half
    re-derived writes itself twice.

    Args:
        extras: The entity's extras bag.

    Returns:
        ``True`` when the entity carries CDDL provenance.
    """
    return any(key.startswith("cddl_") for key in extras)


def _quote(value: str) -> str:
    """Return ``value`` as a CDDL text literal."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def _literal(value: Any) -> str:
    """Return the CDDL spelling of a Python value used as a literal."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value) if isinstance(value, float) else str(value)
    if value is None:
        return "nil"
    if isinstance(value, bytes):
        return f"h'{value.hex()}'"
    return _quote(str(value))


def _identifier(name: str) -> str:
    """Return ``name`` as an identifier CDDL admits.

    Args:
        name: The canonical type or member name.

    Returns:
        The name unchanged when it already parses, else a folded form.
    """
    if _IDENTIFIER.match(name):
        return name
    folded = re.sub(r"[^A-Za-z0-9@_$.-]+", "-", name).strip("-.")
    folded = re.sub(r"^[^A-Za-z@_$]+", "", folded)
    return folded or "value"


def _operand(spelling: str) -> str:
    """Return a control operand, parenthesized when it would otherwise re-associate.

    ``tstr .size 1..40`` parses as ``(tstr .size 1) .. 40`` — the range operator binds to the
    whole controlled type — so a compound operand must be written ``tstr .size (1..40)``.
    """
    if any(token in spelling for token in ("..", "/", " ")):
        return f"({spelling})"
    return spelling


def _comment_lines(text: str, indent: str) -> List[str]:
    """Return ``text`` as one or more ``;`` comment lines at ``indent``."""
    return [f"{indent}; {line}" for line in text.splitlines() or [""]]


class _CddlWriter:
    """Renders one canonical model as a CDDL document."""

    def __init__(self, api: CanonicalApi, options: CddlEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self._types = {type_.key: type_ for type_ in api.types}
        #: Types written inline as another type's group choice, and therefore not written
        #: again as rules of their own.
        self._inlined: Set[str] = set()
        self.output_path = _output_path(api)

    # -- document --------------------------------------------------------

    def render(self) -> str:
        """Return the whole CDDL document."""
        lines: List[str] = []
        if self._options.include_comments and self._api.description:
            lines.extend(_comment_lines(self._api.description, ""))
            lines.append("")

        for type_ in self._ordered_types():
            if type_.key in self._inlined:
                continue
            rendered = self._render_type(type_)
            if rendered:
                lines.extend(rendered)
                lines.append("")

        if self._api.services or self._api.channels:
            self.losses.record(
                LossKind.NA,
                "services-dropped",
                "CDDL describes a value space and has no operation or channel construct; "
                "services and channels are omitted",
            )

        return "\n".join(lines).rstrip() + "\n"

    def _ordered_types(self) -> List[Type]:
        """Return the types in the order they are written.

        RFC 8610 §3.1 makes the **first** rule the grammar's entry point, so the type the
        model names as its root is written first and everything else follows by key. Writing
        them in any other order would change which rule a reader treats as the entry point.
        """
        types = sorted(self._api.types, key=lambda item: item.key)
        root = self._root_key()
        if root is None:
            return types
        head = [type_ for type_ in types if type_.key == root]
        return head + [type_ for type_ in types if type_.key != root]

    def _root_key(self) -> Optional[str]:
        """Return the key of the type the model treats as its entry point."""
        extras = self._api.extras.get("cddl") if isinstance(self._api.extras, dict) else None
        if isinstance(extras, dict):
            candidate = extras.get("root_type") or extras.get("root_rule")
            if isinstance(candidate, str) and candidate in self._types:
                return candidate
        title = self._api.identity.name if self._api.identity else None
        if isinstance(title, str) and title in self._types:
            return title
        return None

    # -- rules -----------------------------------------------------------

    def _render_type(self, type_: Type) -> List[str]:
        """Return the rule (with its comment) one canonical type is written as."""
        body = self._rule_body(type_)
        if body is None:
            self.losses.record(
                LossKind.NA,
                "type-skipped",
                f"Type {type_.key!r} has no CDDL representation and is skipped",
                pointer=type_.key,
            )
            return []
        self.tracker.record(type_.key, Provenance.SOURCE)
        lines: List[str] = []
        if self._options.include_comments and type_.description:
            lines.extend(_comment_lines(type_.description, ""))
        if isinstance(body, list):
            lines.extend(body)
        else:
            lines.append(body)
        return lines

    def _rule_body(self, type_: Type) -> Optional[Union[str, List[str]]]:
        """Return the rule text for one type, or ``None`` when it cannot be written."""
        name = _identifier(type_.name or type_.key)
        extras = type_.extras or {}
        # A type socket binds with `/=`, not `=`: writing `$m = tstr` would turn an
        # extension point into a closed rule. A socket whose plugs collapsed into a union
        # is written as one `/=` per plug by `_union_rule`; one that did not is written
        # here, with the same binding.
        assign = (
            "/="
            if extras.get("cddl_socket") == "type" and self._options.sockets_as_plugs
            else "="
        )

        if type_.kind is TypeKind.UNION:
            return self._union_rule(name, type_, extras, assign=assign)
        if type_.kind is TypeKind.ENUM:
            return f"{name} {assign} &(\n" + self._enum_members(type_) + "\n)"
        if type_.kind is TypeKind.RECORD:
            opening, closing = _brackets(extras.get("cddl_shape"))
            members = self._members(type_)
            if not members:
                return f"{name} {assign} {opening}{closing}"
            return [f"{name} {assign} {opening}", *members, closing]
        if type_.kind is TypeKind.MAP:
            key_expr = self._reference(type_.key_type) if type_.key_type else "any"
            value_expr = self._reference(type_.value_type) if type_.value_type else "any"
            return f"{name} {assign} {{ * {key_expr} => {value_expr} }}"
        if type_.kind is TypeKind.ALIAS and type_.aliased is not None:
            expression = self._type_expression(
                type_.aliased, extras, type_.constraints, native=_is_native(extras)
            )
            return f"{name} {assign} {expression}"
        if type_.kind is TypeKind.SCALAR:
            return f"{name} {assign} {self._scalar_expression(type_, extras)}"
        return None

    def _union_rule(
        self, name: str, type_: Type, extras: Dict[str, Any], *, assign: str = "="
    ) -> Optional[Union[str, List[str]]]:
        """Return the rule a union is written as.

        Three shapes, all of which the reader produces and reads back: a type socket
        becomes its ``/=`` plugs, a whole-body group choice becomes the alternatives inside
        one map or array, and an ordinary union becomes a ``/`` type choice.
        """
        members = [member for member in type_.union_members]
        if not members:
            self.losses.record(
                LossKind.NA,
                "empty-union",
                f"Union {type_.key!r} names no members and is written as `any`",
                pointer=type_.key,
            )
            return f"{name} {assign} any"

        if extras.get("cddl_socket") == "type" and self._options.sockets_as_plugs:
            return [f"{name} /= {self._member_expression(member)}" for member in members]

        if extras.get("cddl_group_choice"):
            opening, closing = _brackets(extras.get("cddl_shape"))
            alternatives: List[str] = []
            for member in members:
                alternative = self._types.get(member)
                if alternative is None:
                    alternatives.append(f"({self._member_expression(member)})")
                    continue
                self._inlined.add(member)
                self.tracker.record(alternative.key, Provenance.SOURCE)
                inline = ", ".join(
                    line.strip().rstrip(",") for line in self._members(alternative)
                )
                alternatives.append(f"({inline})")
            return f"{name} {assign} {opening} " + " // ".join(alternatives) + f" {closing}"

        return f"{name} {assign} " + " / ".join(
            self._member_expression(member) for member in members
        )

    def _member_expression(self, member_key: str) -> str:
        """Return the type expression one union member key is written as."""
        referenced = self._types.get(member_key)
        if referenced is not None:
            return _identifier(referenced.name or referenced.key)
        mapped = canonical_scalar_to_cddl(member_key)
        if mapped is not None:
            return mapped
        self.losses.record(
            LossKind.INFERRED,
            "union-member-unresolved",
            f"Union member {member_key!r} names neither a type in this model nor a "
            f"canonical scalar; written as `{_FALLBACK_TYPE}`",
            pointer=member_key,
        )
        return _FALLBACK_TYPE

    def _enum_members(self, type_: Type) -> str:
        """Return the ``&( … )`` body an enum is written as."""
        lines: List[str] = []
        for value in type_.enum_values:
            name = _identifier(value.name)
            spelling = (value.extras or {}).get("cddl_value")
            literal = (
                str(spelling)
                if isinstance(spelling, str) and spelling
                else _literal(value.value if value.value is not None else value.name)
            )
            comment = (
                f"  ; {value.description}"
                if self._options.include_comments and value.description
                else ""
            )
            lines.append(f"  {name}: {literal},{comment}")
        return "\n".join(lines)

    # -- members ---------------------------------------------------------

    def _members(self, type_: Type) -> List[str]:
        """Return the indented member lines one record's fields are written as."""
        ordered = sorted(
            type_.fields, key=lambda item: (item.field_number or 0, item.key)
        )
        lines: List[str] = []
        for field in ordered:
            self.tracker.record(field.key, Provenance.SOURCE)
            lines.append(self._member(field))
        return lines

    def _member(self, field: CanonicalField) -> str:
        """Return the one line a record member is written as."""
        extras = dict(field.extras or {})
        native = _is_native(extras)
        occurrence = self._occurrence(field, extras, native=native)
        key = self._member_key(field, extras)
        value = self._type_expression(
            field.type, extras, field.constraints, native=native, default=field.default
        )
        comment = (
            f"  ; {field.description}"
            if self._options.include_comments and field.description
            else ""
        )
        prefix = f"{occurrence} " if occurrence else ""
        return f"  {prefix}{key}{value},{comment}"

    def _occurrence(
        self, field: CanonicalField, extras: Dict[str, Any], *, native: bool
    ) -> str:
        """Return the member's occurrence indicator.

        A native member carries the source's own spelling — ``3*3`` and ``0*5`` say more
        than ``*`` does — and a projected one derives the indicator from nullability and the
        item-count constraints.
        """
        if native:
            return str(extras.get("cddl_occurrence") or "")
        if field.type.is_list():
            minimum = field.constraints.min_items if field.constraints else None
            return "+" if minimum else "*"
        return "?" if field.type.nullable else ""

    def _member_key(self, field: CanonicalField, extras: Dict[str, Any]) -> str:
        """Return the key half of a member line, including its separator."""
        kind = extras.get("cddl_key")
        if kind == "positional":
            return ""
        cut = "^ " if extras.get("cddl_key_cut") else ""
        if kind == "table":
            key_type = str(extras.get("cddl_key_type") or "any")
            return f"{_operand(key_type)} {cut}=> "
        if kind == "arrow-literal":
            return f"{extras.get('cddl_key_literal')} {cut}=> "
        if kind == "literal":
            return f"{extras.get('cddl_key_literal')}: "
        return f"{_identifier(field.name)}: "

    # -- type expressions ------------------------------------------------

    def _scalar_expression(self, type_: Type, extras: Dict[str, Any]) -> str:
        """Return the expression a ``SCALAR`` type's rule is written as."""
        literals = extras.get("cddl_literals")
        if isinstance(literals, list) and literals:
            return " / ".join(str(literal) for literal in literals)
        reference = TypeRef(name=str(extras.get("cddl_scalar") or _FALLBACK_TYPE))
        return self._type_expression(
            reference, extras, type_.constraints, native=_is_native(extras)
        )

    def _type_expression(
        self,
        reference: TypeRef,
        extras: Dict[str, Any],
        constraints: Optional[Constraints],
        *,
        native: bool,
        default: Any = None,
    ) -> str:
        """Return the CDDL type expression one canonical reference is written as.

        Args:
            reference: The reference to write.
            extras: The owning entity's extras, holding the source's own spellings.
            constraints: The owning entity's constraints.
            native: Whether the entity carries CDDL provenance.
            default: The member's declared default, when it has one.

        Returns:
            The type expression.
        """
        base = self._base_expression(reference, extras, native=native)
        parts = [base]
        parts.extend(self._controls(extras, constraints, native=native, default=default))
        expression = " ".join(parts)
        if "cddl_tag" in extras:
            # `#6(t)` — a tagged value whose tag number the grammar left open — is a tag
            # too, so the key's *presence* decides, not its value.
            tag = extras["cddl_tag"]
            expression = (
                f"#6({expression})" if tag is None else f"#6.{tag}({expression})"
            )
        return expression

    def _base_expression(
        self, reference: TypeRef, extras: Dict[str, Any], *, native: bool
    ) -> str:
        """Return the un-controlled core of a type expression."""
        unwrap = extras.get("cddl_unwrap")
        if native and isinstance(unwrap, str):
            return f"~{_identifier(unwrap)}"

        range_ = extras.get("cddl_range")
        if native and isinstance(range_, dict):
            return f"{range_.get('from')}{range_.get('operator')}{range_.get('to')}"

        occurrences = extras.get("cddl_list_occurrence")
        if native and isinstance(occurrences, list) and occurrences:
            inner = self._leaf(_innermost(reference), extras, native=native)
            for spelling in reversed([str(item) for item in occurrences]):
                inner = f"[{spelling} {inner}]"
            return inner

        if reference.is_list():
            if native and extras.get("cddl_occurrence"):
                # `* tags: tstr` is a member that may repeat, not a member holding a list.
                # The reader wraps it in a list because that is the canonical shape; the
                # member line writes the indicator, so the type expression is the element's.
                return self._base_expression(
                    reference.item or TypeRef(), extras, native=native
                )
            inner = self._base_expression(reference.item or TypeRef(), extras, native=native)
            return f"[* {inner}]"

        return self._leaf(reference, extras, native=native)

    def _leaf(self, reference: TypeRef, extras: Dict[str, Any], *, native: bool) -> str:
        """Return the expression a leaf reference is written as."""
        spelling = extras.get("cddl_type")
        if native and isinstance(spelling, str) and spelling:
            return spelling
        name = reference.name
        if not name:
            return _FALLBACK_TYPE
        referenced = self._types.get(name)
        if referenced is not None:
            return _identifier(referenced.name or referenced.key)
        mapped = canonical_scalar_to_cddl(name)
        if mapped is not None:
            return mapped
        self.losses.record(
            LossKind.INFERRED,
            "scalar-approximated",
            f"Canonical type {name!r} has no CDDL prelude analogue; written as "
            f"`{_FALLBACK_TYPE}`",
            pointer=name,
        )
        return _FALLBACK_TYPE

    def _controls(
        self,
        extras: Dict[str, Any],
        constraints: Optional[Constraints],
        *,
        native: bool,
        default: Any = None,
    ) -> List[str]:
        """Return the control operators that follow a type expression.

        A native entity re-emits the operators the reader recorded; a projected one derives
        them from the canonical constraints. The two are never mixed — see :func:`_is_native`.
        """
        if native:
            return self._native_controls(extras)
        return self._projected_controls(constraints, default)

    def _native_controls(self, extras: Dict[str, Any]) -> List[str]:
        """Return the control operators recorded by the reader, in source order."""
        parts: List[str] = []
        size = extras.get("cddl_size")
        if size is not None:
            parts.append(f".size {_operand(str(size))}")
        for control in extras.get("cddl_controls") or []:
            if not isinstance(control, dict):
                continue
            operator = str(control.get("operator") or "")
            operand = str(control.get("operand") or "")
            if operator:
                parts.append(f"{operator} {_operand(operand)}" if operand else operator)
        declared_default = extras.get("cddl_default")
        if declared_default is not None:
            parts.append(f".default {_operand(str(declared_default))}")
        return parts

    def _projected_controls(
        self, constraints: Optional[Constraints], default: Any
    ) -> List[str]:
        """Return the control operators a foreign model's constraints project onto."""
        parts: List[str] = []
        if constraints is not None:
            low = constraints.min_length
            high = constraints.max_length
            if low is not None and high is not None:
                parts.append(
                    f".size {high}" if low == high else f".size ({low}..{high})"
                )
            elif high is not None:
                parts.append(f".size (0..{high})")
            elif low is not None:
                # CDDL's `.size` has no open upper bound; a floor alone is not expressible.
                self.losses.record(
                    LossKind.NA,
                    "constraint-min-length",
                    "CDDL's `.size` bounds a length exactly or within a range; a minimum "
                    "length with no maximum is omitted",
                )
            if constraints.pattern:
                parts.append(f".regexp {_quote(constraints.pattern)}")
            if constraints.minimum is not None:
                parts.append(f".ge {_number(constraints.minimum)}")
            if constraints.maximum is not None:
                parts.append(f".le {_number(constraints.maximum)}")
            if constraints.exclusive_minimum is not None:
                parts.append(f".gt {_number(constraints.exclusive_minimum)}")
            if constraints.exclusive_maximum is not None:
                parts.append(f".lt {_number(constraints.exclusive_maximum)}")
            for name in _UNSUPPORTED_CONSTRAINTS:
                if getattr(constraints, name, None) is not None:
                    self.losses.record(
                        LossKind.NA,
                        f"constraint-{name.replace('_', '-')}",
                        f"CDDL has no control operator for `{name}`; the constraint is "
                        f"omitted",
                    )
        if default is not None:
            parts.append(f".default {_literal(default)}")
        return parts

    def _reference(self, reference: TypeRef) -> str:
        """Return the expression a bare reference (a map's key or value type) is written as."""
        return self._base_expression(reference, {}, native=False)


def _innermost(reference: TypeRef) -> TypeRef:
    """Return the leaf a (possibly nested) list reference wraps."""
    while reference.item is not None:
        reference = reference.item
    return reference


def _brackets(shape: Any) -> Tuple[str, str]:
    """Return the bracket pair a record's ``cddl_shape`` is written with."""
    if shape == "array":
        return "[", "]"
    return "{", "}"


def _number(value: float) -> str:
    """Return a numeric constraint bound as CDDL writes it."""
    if float(value).is_integer():
        return str(int(value))
    return repr(value)


def _output_path(api: CanonicalApi) -> str:
    """Return the file name the emitted grammar is written to."""
    base = api.identity.name if api.identity and api.identity.name else "schema"
    folded = re.sub(r"[^A-Za-z0-9_.-]+", "-", base).strip("-.") or "schema"
    return f"{folded}.cddl"


def validate_cddl_document(content: str) -> None:
    """Validate emitted CDDL text by parsing it back through this repository's reader.

    Args:
        content: The emitted grammar.

    Raises:
        CddlParseError: When the document is not a CDDL grammar this reader accepts.
    """
    from .cddl_parser import parse_cddl

    parse_cddl(content, source_label="emitted.cddl")
