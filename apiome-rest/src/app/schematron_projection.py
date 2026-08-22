"""Schematron XPath -> canonical-model lint rule projection — FMT-4.3 (#5436).

A Schematron assertion talks about an **instance**: "this invoice's total equals the sum of its
lines". Apiome's lint engine scores a **model**: the types, members and constraints a catalog
item declares. The overlap between the two is real but narrow, and this module is where that
line is drawn — once, explicitly, so both halves of it are inspectable:

* **What projects.** Assertions about *shape* — a child element must (or must not) be there, an
  attribute must be there, a value must come from a fixed set. Those are statements about what
  the schema declares, so they become custom lint rules in the GOV-1.3 DSL
  (:mod:`app.custom_rule_dsl`) evaluated at :data:`~app.custom_rule_dsl.SCOPE_CANONICAL` against
  :func:`canonical_governance_document`.
* **What does not.** Everything that needs a document in hand — arithmetic, cross-references,
  string lengths, dates, computed variables, an instance-selecting context predicate. Those come
  back as an :class:`Unprojectable` carrying a **stable reason code**, and the importer records
  them as declared-but-unevaluable rules rather than dropping them. That is the FMT-4.3
  acceptance criterion, and it is also the honest answer: the rule was in the profile, Apiome
  can say so, and it can say exactly why it cannot score it.

The projection is deliberately conservative. A near-miss translation would quietly change what a
governance profile means — projecting ``inv:Party[@role='seller']`` onto every ``Party`` would
invent violations for buyers — so anything that would need a guess is reported instead.

**The governance document.** :func:`canonical_governance_document` renders a
:class:`~app.canonical_model.CanonicalApi` as the element view a Schematron author already
thinks in: every named type keyed by name, its record members split into ``children`` and
``attributes``, and each member carrying the declared facts a rule can test — ``enum`` (resolved
through a referenced enum type), ``pattern``, lengths, ``required``, ``repeated``. It is a *map*
keyed by name rather than a list precisely so "the schema declares a member called X" is
expressible as a JSONPath ``field`` test, which is what lets the existing DSL evaluate these
rules with no new engine.

Two things make that view line up with the XPath an author actually wrote, and both read
conventions the XML normalizers **already** record rather than inventing anything:

* **Attributes are separated from children.** A member is an attribute when its name carries the
  ``@`` sigil (DTD) or when its ``extras`` carry a ``*_kind`` of ``attribute``
  (``xsd_kind``/``relaxng_kind``/``dtd_kind``). So ``@currencyID`` reaches the attribute bucket
  whichever XML schema language declared it.
* **Elements are aliased onto the types that declare them.** XSD names a complex type
  ``InvoiceType`` and declares an element ``Invoice`` of that type — a Schematron rule says
  ``context="ubl:Invoice"``. Type ``extras`` carrying a ``*_element`` name (``dtd_element``,
  ``relaxng_element``) and artifact ``extras`` carrying a ``*_elements`` list of
  ``{name, type}`` (``xsd_elements``) both alias the element name onto the type's view. A real
  type of that name always wins the key; aliases only fill gaps.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .canonical_model import CanonicalApi, CanonicalField, Type, TypeKind

__all__ = [
    "CANONICAL_ROOT_KEY",
    "PROJECTION_REASONS",
    "ProjectedRule",
    "Projection",
    "REASON_CONTEXT_NOT_PROJECTABLE",
    "REASON_CONTEXT_PREDICATE",
    "REASON_INACTIVE_PHASE",
    "REASON_INSTANCE_VALUE_ASSERTION",
    "REASON_INVALID_PROJECTION",
    "REASON_NO_TEST",
    "REASON_RULE_LIMIT",
    "REASON_UNSUPPORTED_REPORT_INVERSION",
    "REASON_UNSUPPORTED_XPATH_FUNCTION",
    "REASON_UNSUPPORTED_XPATH_OPERATOR",
    "REASON_UNSUPPORTED_XPATH_PATH",
    "REASON_VARIABLE_REFERENCE",
    "Unprojectable",
    "canonical_governance_document",
    "elements_map",
    "project_assertion",
]

#: Top-level key of the governance document: every named type, keyed by name.
CANONICAL_ROOT_KEY = "elements"

# --- Reason codes (stable, machine-readable, additive-only) -------------------------------------

#: The rule's ``@context`` selects instances rather than a declared element (a predicate such as
#: ``inv:Party[@role='seller']``). Projecting it onto every ``Party`` would invent violations.
REASON_CONTEXT_PREDICATE = "context_predicate"

#: The ``@context`` is not a plain element path — a wildcard, an axis, ``//``, a union, the
#: document root — so there is no single canonical type it names.
REASON_CONTEXT_NOT_PROJECTABLE = "context_not_projectable"

#: The ``@test`` references a ``let`` variable that is computed rather than a literal constant.
REASON_VARIABLE_REFERENCE = "variable_reference"

#: The ``@test`` calls an XPath function with no canonical analogue (``string-length``,
#: ``matches``, ``current-date``, a user-defined function, …).
REASON_UNSUPPORTED_XPATH_FUNCTION = "unsupported_xpath_function"

#: The ``@test`` combines sub-expressions with an operator the projection does not model
#: (``and`` / ``or`` / arithmetic / ``castable as``).
REASON_UNSUPPORTED_XPATH_OPERATOR = "unsupported_xpath_operator"

#: The ``@test`` compares instance values (``a = b``, ``a > 0``) rather than asserting shape.
REASON_INSTANCE_VALUE_ASSERTION = "instance_value_assertion"

#: The ``@test`` navigates a multi-step path where the projection can only address one step.
REASON_UNSUPPORTED_XPATH_PATH = "unsupported_xpath_path"

#: A ``report`` (which fires when its test *holds*) whose test has no invertible projection.
REASON_UNSUPPORTED_REPORT_INVERSION = "unsupported_report_inversion"

#: The assertion carries no ``@test`` at all.
REASON_NO_TEST = "no_test"

#: The assertion's pattern is not active in the rule set's resolved phase, so the profile itself
#: says it does not apply here. Assigned by :mod:`app.schematron_import`, not by the projection.
REASON_INACTIVE_PHASE = "inactive_phase"

#: The guide's rule ceiling (:data:`app.custom_rule_dsl.MAX_RULES_PER_GUIDE`) was reached before
#: this assertion. Assigned by :mod:`app.schematron_import`.
REASON_RULE_LIMIT = "rule_limit"

#: The projected rule was rejected by the DSL — an element name too long to address, or a
#: projection bug. The assertion is still recorded, with the validation pointer in its detail.
#: Assigned by :mod:`app.schematron_import`.
REASON_INVALID_PROJECTION = "invalid_projection"

#: Every reason code this feature can attach to a declared-but-unevaluable rule.
PROJECTION_REASONS: Tuple[str, ...] = (
    REASON_CONTEXT_NOT_PROJECTABLE,
    REASON_CONTEXT_PREDICATE,
    REASON_INACTIVE_PHASE,
    REASON_INSTANCE_VALUE_ASSERTION,
    REASON_INVALID_PROJECTION,
    REASON_NO_TEST,
    REASON_RULE_LIMIT,
    REASON_UNSUPPORTED_REPORT_INVERSION,
    REASON_UNSUPPORTED_XPATH_FUNCTION,
    REASON_UNSUPPORTED_XPATH_OPERATOR,
    REASON_UNSUPPORTED_XPATH_PATH,
    REASON_VARIABLE_REFERENCE,
)

# --- XPath shapes -------------------------------------------------------------------------------

#: An element or attribute step: an optional prefix, then an NCName. Prefixes are dropped when
#: the step is projected — the canonical model records a type's namespace on the type, and a
#: Schematron prefix binds to a URI the canonical model does not carry per member.
_STEP_RE = re.compile(r"^(?:(?P<prefix>[A-Za-z_][\w.-]*):)?(?P<local>[A-Za-z_][\w.-]*)$")

#: A relative element/attribute path: ``a``, ``a/b/c``, ``@a``.
_PATH_RE = re.compile(r"^@?[A-Za-z_][\w.:-]*(?:/[A-Za-z_][\w.:-]*)*$")

#: ``count(X) OP N`` — the only aggregate the projection reads.
_COUNT_RE = re.compile(r"^count\(\s*(?P<path>[^()]+?)\s*\)\s*(?P<op>>=|<=|!=|=|>|<)\s*(?P<n>\d+)$")

#: ``exists(X)`` / ``not(X)`` / ``empty(X)`` — the one-argument shape wrappers.
_WRAPPER_RE = re.compile(r"^(?P<fn>exists|not|empty)\(\s*(?P<inner>.+?)\s*\)$")

#: ``X = 'literal'`` or ``X = ('a', 'b')`` — a value drawn from a fixed set.
_EQUALITY_RE = re.compile(r"^(?P<path>[^=<>!]+?)\s*=\s*(?P<value>.+)$")

#: One XPath string literal.
_STRING_LITERAL_RE = re.compile(r"^'([^']*)'$|^\"([^\"]*)\"$")

#: One XPath numeric literal.
_NUMBER_LITERAL_RE = re.compile(r"^-?\d+(?:\.\d+)?$")

#: Operators that betray an instance-level comparison rather than a shape assertion.
_VALUE_OPERATORS = ("!=", ">=", "<=", ">", "<", " div ", " mod ", " idiv ", "+", "*")

#: Keywords that betray a composite or typed expression the projection does not model.
_COMPOSITE_KEYWORDS = (" and ", " or ", " castable as ", " instance of ", " union ", " except ")

#: ``count(X) OP N`` shapes that mean nothing more than "X is declared".
_EXISTENCE_COUNTS = {(">=", 1), (">", 0), ("!=", 0)}

#: One quoted XPath literal. Structural inspection blanks these first: a regex literal such as
#: ``'^[A-Z]{3}-[0-9]{4,}$'`` is full of ``$``, ``(`` and comparison characters that would
#: otherwise be read as XPath syntax and produce a confidently wrong reason code.
_LITERAL_MASK_RE = re.compile(r"'[^']*'|\"[^\"]*\"")


@dataclass(frozen=True)
class ProjectedRule:
    """A Schematron assertion translated into a canonical-scoped custom lint rule.

    Attributes:
        given: JSONPath ``given`` expressions over the governance document.
        then: ``then`` clauses, in the DSL's JSON shape.
        target: The canonical coordinate the rule scores — the element name from the
            assertion's ``@context``. This is "the XPath context recorded as the rule's
            target" the ticket asks for.
        notes: Lossy-but-successful translation notes (what the projection narrowed).
    """

    given: Tuple[str, ...]
    then: Tuple[Mapping[str, Any], ...]
    target: str
    notes: Tuple[str, ...] = ()


@dataclass(frozen=True)
class Unprojectable:
    """Why an assertion has no canonical-model analogue.

    Attributes:
        reason: One of :data:`PROJECTION_REASONS`.
        detail: Human explanation naming the construct that could not be projected.
        target: The element name from ``@context`` when the context itself was readable, so a
            declared rule still records what it was about.
    """

    reason: str
    detail: str
    target: Optional[str] = None


@dataclass(frozen=True)
class Projection:
    """The outcome of projecting one assertion: exactly one of ``rule`` / ``unprojectable``."""

    rule: Optional[ProjectedRule] = None
    unprojectable: Optional[Unprojectable] = None

    @property
    def projected(self) -> bool:
        """Return whether the assertion became an evaluable rule."""
        return self.rule is not None


# --- Governance document -------------------------------------------------------------------------


def canonical_governance_document(api: CanonicalApi) -> Dict[str, Any]:
    """Render a canonical artifact as the element view Schematron-derived rules read.

    The shape (see the module docstring for why it is a map, not a list)::

        {
          "format": "xsd",
          "paradigm": "data_schema",
          "elements": {
            "Invoice": {
              "name": "Invoice", "key": "Invoice", "kind": "RECORD", "namespace": "...",
              "children":   {"ID": {...}, "IssueDate": {...}},
              "attributes": {"currency": {...}}
            }
          }
        }

    Two types with the same ``name`` (different namespaces) collide on one key; the one whose
    ``key`` sorts first wins, which keeps the document deterministic. Attribute members land
    under ``attributes`` (see :func:`_is_attribute`), everything else under ``children``, and
    element names a type or the artifact declares are aliased onto that type's view — both per
    the conventions the module docstring sets out.

    Args:
        api: The canonical artifact. Not mutated.

    Returns:
        A plain JSON-serializable mapping, safe to hand to the custom-rule sandbox.
    """
    elements = elements_map(api.types)
    _apply_artifact_element_aliases(elements, api)
    return {
        "format": api.format,
        "paradigm": getattr(api.paradigm, "value", api.paradigm),
        CANONICAL_ROOT_KEY: elements,
    }


def _apply_artifact_element_aliases(elements: Dict[str, Any], api: CanonicalApi) -> None:
    """Alias artifact-declared element names onto the types they are declared with.

    XSD declares global elements separately from the complex types that give them structure, and
    the normalizer records the mapping as an artifact ``extras`` list of ``{name, type}`` under a
    key ending ``_elements`` (``xsd_elements``). A Schematron rule names the *element*, so the
    element name is aliased onto that type's view — leaving any real type of the same name in
    place, since a declaration always outranks an alias.

    Args:
        elements: The element view to extend, keyed by name. Mutated in place.
        api: The canonical artifact whose ``extras`` are read.
    """
    extras = getattr(api, "extras", None) or {}
    for key, value in extras.items():
        if not key.endswith("_elements") or not isinstance(value, list):
            continue
        for declaration in value:
            if not isinstance(declaration, Mapping):
                continue
            name = str(declaration.get("name") or "").strip()
            target = str(declaration.get("type") or "").strip()
            if name and target and name not in elements and target in elements:
                elements[name] = elements[target]


def elements_map(types: Sequence[Type]) -> Dict[str, Dict[str, Any]]:
    """Return the ``elements`` half of a governance document for ``types``.

    Split out from :func:`canonical_governance_document` because the projection's own tests and
    tooling need the element view without an assembled :class:`~app.canonical_model.CanonicalApi`
    around it, and there must be exactly one definition of what that view is.

    Args:
        types: The named types to render. Not mutated.

    Returns:
        Element name -> element view, deterministic in ``key`` order (first name wins).
    """
    by_name: Dict[str, Dict[str, Any]] = {}
    aliases: Dict[str, str] = {}
    types_by_key = {type_.key: type_ for type_ in types}
    for type_ in sorted(types, key=lambda t: t.key):
        name = (type_.name or type_.key or "").strip()
        if not name or name in by_name:
            continue
        children: Dict[str, Any] = {}
        attributes: Dict[str, Any] = {}
        for member in type_.fields:
            member_name = (member.name or "").strip()
            if not member_name:
                continue
            if _is_attribute(member, member_name):
                attributes[member_name.lstrip("@")] = _member_document(member, types_by_key)
            else:
                children[member_name] = _member_document(member, types_by_key)
        by_name[name] = {
            "name": name,
            "key": type_.key,
            "kind": type_.kind.value if isinstance(type_.kind, TypeKind) else str(type_.kind),
            "namespace": type_.namespace,
            "description": type_.description,
            "children": children,
            "attributes": attributes,
        }
        element = _declared_element_name(type_)
        if element and element != name:
            aliases.setdefault(element, name)

    for element, target in aliases.items():
        if element not in by_name:
            by_name[element] = by_name[target]
    return by_name


def _is_attribute(member: CanonicalField, member_name: str) -> bool:
    """Return whether a record member is an XML attribute rather than a child element.

    Two spellings, both already in the tree: the ``@`` sigil the DTD normalizer puts on the
    member name, and a ``*_kind`` of ``attribute`` in the member's ``extras`` (``xsd_kind``,
    ``relaxng_kind``, ``dtd_kind``). Either is authoritative.
    """
    if member_name.startswith("@"):
        return True
    extras = getattr(member, "extras", None) or {}
    return any(key.endswith("_kind") and value == "attribute" for key, value in extras.items())


def _declared_element_name(type_: Type) -> Optional[str]:
    """Return the element name a type's ``extras`` say it declares, when it says so.

    The DTD and RELAX NG normalizers record ``dtd_element`` / ``relaxng_element`` on a type whose
    structure *is* an element declaration. Reading the ``*_element`` convention keeps the
    projection working for any XML importer that follows it, without this module knowing which
    importers exist.
    """
    extras = getattr(type_, "extras", None) or {}
    for key, value in extras.items():
        if key.endswith("_element") and isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _member_document(member: CanonicalField, types_by_key: Mapping[str, Type]) -> Dict[str, Any]:
    """Render one record member as the declared facts a projected rule can test."""
    ref = member.type
    constraints = member.constraints
    body: Dict[str, Any] = {
        "name": member.name,
        "type": _ref_name(ref),
        "required": not ref.nullable,
        "repeated": ref.is_list(),
        "description": member.description,
    }
    if member.default is not None:
        body["default"] = member.default
    enum_values = _member_enum(member, types_by_key)
    if enum_values is not None:
        body["enum"] = enum_values
    if constraints is not None:
        for key, attribute in (
            ("pattern", "pattern"),
            ("minLength", "min_length"),
            ("maxLength", "max_length"),
            ("minimum", "minimum"),
            ("maximum", "maximum"),
            ("format", "format"),
        ):
            value = getattr(constraints, attribute, None)
            if value is not None:
                body[key] = value
    return body


def _ref_name(ref: Any) -> Optional[str]:
    """Return the leaf type name of a (possibly list-wrapping) :class:`TypeRef`."""
    while ref is not None and ref.name is None and ref.item is not None:
        ref = ref.item
    return None if ref is None else ref.name


def _member_enum(
    member: CanonicalField, types_by_key: Mapping[str, Type]
) -> Optional[List[Any]]:
    """Return the values a member is restricted to, or ``None`` when it is unrestricted.

    Inline ``constraints.enum`` wins; otherwise, when the member's leaf type is a named ENUM,
    that type's values are used — which is how an XSD ``simpleType`` restriction reaches a rule
    written against the element that uses it.
    """
    if member.constraints is not None and member.constraints.enum:
        return list(member.constraints.enum)
    referenced = types_by_key.get(_ref_name(member.type) or "")
    if referenced is not None and referenced.kind == TypeKind.ENUM and referenced.enum_values:
        return [
            value.value if value.value is not None else value.name
            for value in referenced.enum_values
        ]
    return None


# --- Assertion projection ------------------------------------------------------------------------


def project_assertion(assertion: Any) -> Projection:
    """Project one :class:`~app.schematron_parser.SchematronAssertion` onto a lint rule.

    Args:
        assertion: The parsed assertion (typed ``Any`` so the projection stays importable
            without the parser; only ``kind``, ``context`` and ``test`` are read).

    Returns:
        A :class:`Projection` carrying either the translated rule or the reason there is none.
    """
    context = (getattr(assertion, "context", "") or "").strip()
    test = (getattr(assertion, "test", "") or "").strip()
    kind = getattr(assertion, "kind", "assert")

    target, context_problem = _project_context(context)
    if context_problem is not None:
        return Projection(unprojectable=context_problem)
    if not test:
        return Projection(
            unprojectable=Unprojectable(
                reason=REASON_NO_TEST,
                detail="the assertion declares no `test`, so there is nothing to evaluate",
                target=target,
            )
        )
    if "'" in target or "\\" in target:  # pragma: no cover - rejected by _STEP_RE first
        return Projection(
            unprojectable=Unprojectable(
                reason=REASON_CONTEXT_NOT_PROJECTABLE,
                detail=f"context {context!r} cannot be expressed as a JSONPath key",
                target=None,
            )
        )
    return _project_test(test, kind=kind, target=target, context=context)


def _project_context(context: str) -> Tuple[str, Optional[Unprojectable]]:
    """Resolve a rule's ``@context`` to the canonical element name it names.

    Args:
        context: The ``@context`` XPath, after variable substitution.

    Returns:
        ``(element_name, None)`` when the context names one declared element, or
        ``("", Unprojectable)`` when it does not.
    """
    if not context:
        return "", Unprojectable(
            reason=REASON_CONTEXT_NOT_PROJECTABLE,
            detail="the rule declares no `context`, so it names no element",
        )
    if "[" in context:
        return "", Unprojectable(
            reason=REASON_CONTEXT_PREDICATE,
            detail=(
                f"context {context!r} filters instances with a predicate; the canonical model "
                "records one declaration per element, so the filtered subset cannot be scored"
            ),
        )
    if "//" in context or "::" in context or "*" in context or "|" in context or "(" in context:
        return "", Unprojectable(
            reason=REASON_CONTEXT_NOT_PROJECTABLE,
            detail=(
                f"context {context!r} uses a wildcard, an axis or a union, so it does not name "
                "a single declared element"
            ),
        )
    steps = [step for step in context.split("/") if step]
    if not steps:
        return "", Unprojectable(
            reason=REASON_CONTEXT_NOT_PROJECTABLE,
            detail=f"context {context!r} selects the document root, not a declared element",
        )
    match = _STEP_RE.match(steps[-1])
    if match is None:
        return "", Unprojectable(
            reason=REASON_CONTEXT_NOT_PROJECTABLE,
            detail=f"context {context!r} is not a plain element path",
        )
    return match.group("local"), None


def _project_test(test: str, kind: str, target: str, context: str) -> Projection:
    """Project a ``@test`` XPath against a resolved context element."""
    negate = kind == "report"

    wrapper = _WRAPPER_RE.match(test)
    if wrapper is not None and _balanced(wrapper.group("inner")):
        inner = wrapper.group("inner").strip()
        if wrapper.group("fn") in ("not", "empty"):
            negate = not negate
        if _PATH_RE.match(inner):
            return _presence_projection(inner, target, context, negate=negate)
        # ``not(matches(...))`` and friends: report the *inner* problem, which is the useful one.
        return Projection(unprojectable=_classify(inner, target, context))

    count = _COUNT_RE.match(test)
    if count is not None:
        path = count.group("path").strip()
        operator, threshold = count.group("op"), int(count.group("n"))
        if not _PATH_RE.match(path):
            return Projection(unprojectable=_classify(path, target, context))
        if (operator, threshold) in _EXISTENCE_COUNTS:
            return _presence_projection(path, target, context, negate=negate)
        if operator == "=" and threshold == 0:
            return _presence_projection(path, target, context, negate=not negate)
        if operator in (">=", ">", "=") and threshold >= 1 and not negate:
            return _presence_projection(
                path,
                target,
                context,
                negate=negate,
                notes=(
                    f"`{test}` bounds how many times `{path}` occurs in an instance; the "
                    f"canonical model records only that `{path}` is declared, so the rule "
                    "checks presence, not the bound",
                ),
            )
        return Projection(
            unprojectable=Unprojectable(
                reason=REASON_INSTANCE_VALUE_ASSERTION,
                detail=f"`{test}` counts instance nodes, which a schema does not fix",
                target=target,
            )
        )

    equality = _EQUALITY_RE.match(test)
    if equality is not None:
        return _equality_projection(
            equality.group("path").strip(),
            equality.group("value").strip(),
            test=test,
            target=target,
            context=context,
            negate=negate,
        )

    if _PATH_RE.match(test):
        return _presence_projection(test, target, context, negate=negate)

    return Projection(unprojectable=_classify(test, target, context))


def _presence_projection(
    path: str,
    target: str,
    context: str,
    negate: bool,
    notes: Tuple[str, ...] = (),
) -> Projection:
    """Project "this member is (not) declared on the context element".

    Args:
        path: The relative element/attribute path the assertion tests.
        target: The context element name.
        context: The raw ``@context``, for note text.
        negate: ``True`` when the finding fires on *presence* (a ``report``, or a ``not(...)``).
        notes: Notes already accumulated by the caller.

    Returns:
        The projection, or an :class:`Unprojectable` when the path is not addressable.
    """
    steps = [step for step in path.split("/") if step]
    if not steps:  # pragma: no cover - _PATH_RE cannot match an empty path
        return Projection(unprojectable=_classify(path, target, context))
    head = steps[0]
    is_attribute = head.startswith("@")
    match = _STEP_RE.match(head[1:] if is_attribute else head)
    if match is None:  # pragma: no cover - _PATH_RE already constrains the step shape
        return Projection(unprojectable=_classify(path, target, context))
    member = match.group("local")

    all_notes = list(notes)
    if len(steps) > 1:
        all_notes.append(
            f"`{path}` walks {len(steps)} steps; the rule checks that `{member}` is declared on "
            f"`{target}` and does not follow the remaining steps"
        )
    if match.group("prefix"):
        all_notes.append(
            f"namespace prefix `{match.group('prefix')}:` is dropped; the canonical model keys "
            "members by local name"
        )

    bucket = "attributes" if is_attribute else "children"
    return Projection(
        rule=ProjectedRule(
            given=(f"$.{CANONICAL_ROOT_KEY}[{_key(target)}].{bucket}",),
            then=({"field": member, "function": "undefined" if negate else "defined"},),
            target=target,
            notes=tuple(all_notes),
        )
    )


def _equality_projection(
    path: str, value: str, test: str, target: str, context: str, negate: bool
) -> Projection:
    """Project "this member's value comes from a fixed set" onto the declared enum."""
    values = _literal_values(value)
    if values is None:
        return Projection(unprojectable=_classify(test, target, context))
    if negate:
        # A ``report`` fires when the equality *holds*: "this element may not be an E". The DSL's
        # ``enumeration`` is an allow-list with no deny form, so inverting it would change what
        # the rule means.
        return Projection(
            unprojectable=Unprojectable(
                reason=REASON_UNSUPPORTED_REPORT_INVERSION,
                detail=(
                    f"`report` on `{test}` fires when the value *is* one of the listed values; "
                    "the rule vocabulary expresses allowed sets, not forbidden ones"
                ),
                target=target,
            )
        )
    if not _PATH_RE.match(path):
        # The left-hand side is not a path at all (``string-length(x)``, an arithmetic term):
        # the general classifier names what it actually is, which is the more useful reason.
        return Projection(unprojectable=_classify(test, target, context))
    steps = [step for step in path.split("/") if step]
    if len(steps) != 1:
        return Projection(
            unprojectable=Unprojectable(
                reason=REASON_UNSUPPORTED_XPATH_PATH,
                detail=(
                    f"`{path}` walks {len(steps)} steps; a value restriction is only projectable "
                    "onto a member declared directly on the context element"
                ),
                target=target,
            )
        )
    head = steps[0]
    is_attribute = head.startswith("@")
    match = _STEP_RE.match(head[1:] if is_attribute else head)
    if match is None:  # pragma: no cover - guarded by _PATH_RE above
        return Projection(unprojectable=_classify(test, target, context))
    member = match.group("local")
    bucket = "attributes" if is_attribute else "children"
    return Projection(
        rule=ProjectedRule(
            given=(f"$.{CANONICAL_ROOT_KEY}[{_key(target)}].{bucket}[{_key(member)}].enum[*]",),
            then=({"function": "enumeration", "functionOptions": {"values": list(values)}},),
            target=target,
            notes=(
                f"`{test}` restricts an instance value; the rule checks that every value "
                f"`{member}` is declared to allow is one of the listed values, and says nothing "
                "when the schema declares no enumeration",
            ),
        )
    )


def _literal_values(value: str) -> Optional[List[Any]]:
    """Return the literal values of an XPath right-hand side, or ``None`` when it is computed."""
    text = value.strip()
    if text.startswith("(") and text.endswith(")"):
        inner = text[1:-1].strip()
        if not inner:
            return None
        items = [item.strip() for item in inner.split(",")]
    else:
        items = [text]
    values: List[Any] = []
    for item in items:
        literal = _STRING_LITERAL_RE.match(item)
        if literal is not None:
            values.append(literal.group(1) if literal.group(1) is not None else literal.group(2))
            continue
        if _NUMBER_LITERAL_RE.match(item):
            values.append(float(item) if "." in item else int(item))
            continue
        return None
    return values or None


def _classify(expression: str, target: str, context: str) -> Unprojectable:
    """Return the most specific reason ``expression`` has no canonical analogue.

    Ordered most-informative first: a variable reference explains itself, then a named function,
    then a composite operator, then a bare value comparison.
    """
    masked = _mask_literals(expression)
    padded = f" {masked} "
    variables = sorted(set(re.findall(r"\$([A-Za-z_][\w.-]*)", masked)))
    if variables:
        names = ", ".join(f"${name}" for name in variables)
        return Unprojectable(
            reason=REASON_VARIABLE_REFERENCE,
            detail=(
                f"`{expression}` reads {names}, a `let` whose value is computed at validation "
                "time rather than a literal constant"
            ),
            target=target,
        )
    # A composite outranks a function name: in ``not(@id) or matches(@id, …)`` the `or` is what
    # actually defeats the projection, and naming `not()` instead would misdirect the reader.
    if any(keyword in padded for keyword in _COMPOSITE_KEYWORDS):
        return Unprojectable(
            reason=REASON_UNSUPPORTED_XPATH_OPERATOR,
            detail=(
                f"`{expression}` combines sub-expressions with an operator the projection does "
                "not model"
            ),
            target=target,
        )
    functions = sorted(set(re.findall(r"([A-Za-z_][\w.:-]*)\s*\(", masked)))
    if functions:
        return Unprojectable(
            reason=REASON_UNSUPPORTED_XPATH_FUNCTION,
            detail=(
                f"`{expression}` calls {', '.join(f'{name}()' for name in functions)}, which "
                "evaluates against a document instance and has no canonical-model analogue"
            ),
            target=target,
        )
    if any(operator in padded for operator in _VALUE_OPERATORS) or "=" in masked:
        return Unprojectable(
            reason=REASON_INSTANCE_VALUE_ASSERTION,
            detail=(
                f"`{expression}` compares instance values, which a schema constrains only when "
                "the comparison is to a fixed set"
            ),
            target=target,
        )
    return Unprojectable(
        reason=REASON_UNSUPPORTED_XPATH_PATH,
        detail=f"`{expression}` is not a shape assertion the projection can address",
        target=target,
    )


def _key(name: str) -> str:
    """Return ``name`` as a quoted JSONPath key, so any declared name is addressable."""
    return "'" + name.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _mask_literals(expression: str) -> str:
    """Return ``expression`` with every quoted literal blanked, for structural inspection."""
    return _LITERAL_MASK_RE.sub("''", expression)


def _balanced(expression: str) -> bool:
    """Return whether ``expression``'s parentheses balance (literals ignored)."""
    depth = 0
    for character in _mask_literals(expression):
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0
