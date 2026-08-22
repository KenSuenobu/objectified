"""ISO Schematron reader — FMT-4.3 (#5436).

Schematron is not a schema language. ``schema``/``pattern``/``rule``/``assert`` express
*assertions* over XML instances in XPath, which is why it is the validation layer of UBL/Peppol,
national e-invoicing profiles, health-data programmes and government exchanges — and why it
projects onto Apiome's **lint engine** rather than onto the canonical schema model. This module
is the reading half of that: text in, a flat, fully-resolved list of assertions out. The
projection onto lint rules lives in :mod:`app.schematron_projection`, and the style-guide
importer that ties the two together in :mod:`app.schematron_import`.

What "fully resolved" means here — every construct that exists only to *compose* a rule set is
expanded before the caller sees it, so a consumer never re-implements Schematron's composition
rules:

* **``include``** splices a module in at its position (ISO Schematron §6.5). A rule set that only
  exists once assembled (``06-include-set/``) is therefore read from its root member, with the
  fileset supplying the module texts. Nothing is fetched: an ``href`` that names no member of the
  uploaded set fails with ``INPUT_REFERENCE_UNRESOLVED``.
* **Abstract patterns** (``abstract="true"`` + ``is-a``/``param``) are templates. Each
  instantiation substitutes its ``param`` values into the template's ``context``, ``test``,
  ``let`` values and message text, so two instantiations of one template read as two independent
  patterns.
* **Abstract rules** (``rule abstract="true"`` + ``extends``) are inlined into every concrete
  rule that extends them, in ISO order: the extended rule's assertions come first.
* **``let``** variables whose value is an XPath *literal* (a string, a number, or a parenthesised
  sequence of them) are constants, so they are substituted into the assertions that reference
  them — which is what turns ``$profileId``/``$allowedCurrencies`` from an unprojectable variable
  reference into a value the projection can read. Every other ``let`` (``sum(…)``,
  ``current-date()``) is left as ``$name`` and reported by the projection as unevaluable.
* **``phase``/``active``/``defaultPhase``** select which patterns apply. The resolved phase is
  recorded on the document and each assertion carries the phases naming its pattern, so the
  importer can record an out-of-phase assertion as declared rather than active.

Hardening is inherited, not re-invented: parsing goes through :func:`app.secure_xml.parse_xml`,
so a DTD, an entity, an external reference, an XInclude, an oversized document or a
deeply-nested one is refused before this module sees an element. Composition adds its own two
bounds — an include depth cap and a total-document cap — so a set cannot include its way into an
unbounded expansion, and an include cycle is refused rather than unrolled.

Every terminal failure carries an :mod:`app.intake_error_taxonomy` code, so the six negative
corpus classes (malformed, semantic, truncated, wrong-format, encoding, unresolvable reference)
are each grounded in something the reader actually knows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Dict, List, Mapping, Optional, Sequence, Tuple
from xml.etree import ElementTree as ET

from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "LEGACY_SCHEMATRON_NS",
    "MAX_INCLUDE_DEPTH",
    "MAX_TOTAL_DOCUMENTS",
    "SCHEMATRON_NS",
    "SchematronAssertion",
    "SchematronDocument",
    "SchematronParseError",
    "SchematronPattern",
    "SchematronPhase",
    "SchematronRule",
    "detect_schematron_confidence",
    "is_schematron_document",
    "parse_schematron",
    "parse_schematron_bytes",
]

#: The ISO/IEC 19757-3 Schematron namespace — the detection marker.
SCHEMATRON_NS = "http://purl.oclc.org/dsdl/schematron"

#: Schematron 1.5's pre-ISO namespace. Still shipped by long-lived rule packs, and every
#: construct this reader understands is spelled identically in it.
LEGACY_SCHEMATRON_NS = "http://www.ascc.net.tw/xml/schematron"

#: Namespaces a document must use to be read as Schematron at all.
_NAMESPACES = (SCHEMATRON_NS, LEGACY_SCHEMATRON_NS)

#: Maximum nesting of ``include`` directives, and maximum number of documents one set may
#: assemble. Composition is the only place this reader can grow work super-linearly, so both
#: are bounded explicitly rather than left to the XML guards.
MAX_INCLUDE_DEPTH = 16
MAX_TOTAL_DOCUMENTS = 64

#: Maximum ``is-a`` instantiation chain (an abstract pattern may itself be ``is-a`` another).
MAX_ABSTRACT_DEPTH = 8

#: ``role`` values ISO Schematron and the profiles built on it actually use, mapped onto the
#: lint severity vocabulary (``error`` | ``warning`` | ``info``). ``fatal`` is Peppol/UBL's
#: spelling of "blocking", which is what an Apiome ``error`` means.
ROLE_SEVERITIES: Mapping[str, str] = {
    "fatal": "error",
    "error": "error",
    "assert": "error",
    "warn": "warning",
    "warning": "warning",
    "info": "info",
    "information": "info",
    "hint": "info",
}

#: Severity an assertion carries when it declares no ``role``. Schematron gives an unroled
#: assertion no defined weight, and a rule pack that does not grade its own rules should not be
#: allowed to fail a build on import.
DEFAULT_SEVERITY = "warning"

#: ``ET.ParseError`` messages that mean the document simply ran out, as opposed to being
#: mis-structured. Distinguishing them is what grounds ``INPUT_TRUNCATED``.
_TRUNCATION_MARKERS = ("unclosed token", "no element found", "unexpected end of data")

#: An XPath string literal, a number, or a parenthesised sequence of them — the ``let`` values
#: that are constants rather than computations.
_LITERAL_STRING_RE = re.compile(r"^'([^']*)'$|^\"([^\"]*)\"$")
_LITERAL_NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


class SchematronParseError(ValueError):
    """A Schematron document could not be read.

    Attributes:
        message: Human-readable, safe-to-surface explanation.
        code: An :mod:`app.intake_error_taxonomy` code (``INPUT_MALFORMED``,
            ``INPUT_TRUNCATED``, ``INPUT_ENCODING_INVALID``, ``FORMAT_MISMATCH``,
            ``INPUT_SEMANTIC_INVALID``, ``INPUT_REFERENCE_UNRESOLVED``, or a code raised by the
            hardened XML reader).
    """

    def __init__(self, message: str, code: str = "INPUT_MALFORMED") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


@dataclass(frozen=True)
class SchematronAssertion:
    """One ``assert`` or ``report``, with every enclosing coordinate resolved.

    Attributes:
        kind: ``assert`` (the test must hold) or ``report`` (the test holding *is* the finding).
        assertion_id: The ``@id`` as written, or a derived ``<pattern>-<n>`` coordinate when the
            source gave none. Unique within a document.
        declared_id: Whether ``assertion_id`` came from the source (``True``) or was derived.
        test: The ``@test`` XPath, after ``param`` and literal-``let`` substitution.
        context: The enclosing ``rule``'s ``@context`` XPath, after the same substitution.
        message: The assertion's human text, flattened to one line (``<name/>`` becomes
            ``<name>``, ``<value-of select="x"/>`` becomes ``{x}``).
        role: The ``@role`` as written, lowercased, or ``None``.
        severity: ``role`` mapped through :data:`ROLE_SEVERITIES`, or :data:`DEFAULT_SEVERITY`.
        flag: The ``@flag`` as written, or ``None`` (a Schematron flag groups assertions; it has
            no severity meaning of its own).
        pattern_id: The enclosing pattern's id.
        instantiated_from: The abstract pattern this assertion's pattern instantiates, when it
            came from an ``is-a``.
        inherited_from: The abstract rule this assertion was inlined from, when it came from an
            ``extends``.
        diagnostics: Diagnostic text resolved from ``@diagnostics``, joined — the remediation
            copy the rule carries.
        phases: Ids of every ``phase`` whose ``active`` list names this assertion's pattern, in
            document order. Empty when the schema declares no phases.
        active: Whether the pattern is active in the document's resolved phase.
    """

    kind: str
    assertion_id: str
    declared_id: bool
    test: str
    context: str
    message: str
    role: Optional[str]
    severity: str
    flag: Optional[str]
    pattern_id: str
    instantiated_from: Optional[str] = None
    inherited_from: Optional[str] = None
    diagnostics: Optional[str] = None
    phases: Tuple[str, ...] = ()
    active: bool = True


@dataclass(frozen=True)
class SchematronRule:
    """A ``rule``: one context and the assertions that fire in it."""

    context: Optional[str]
    rule_id: Optional[str]
    abstract: bool
    extends: Tuple[str, ...]
    assertions: Tuple[SchematronAssertion, ...]


@dataclass(frozen=True)
class SchematronPattern:
    """A ``pattern``: a named group of rules, possibly abstract or an instantiation."""

    pattern_id: str
    title: Optional[str]
    abstract: bool
    is_a: Optional[str]
    params: Mapping[str, str]
    rules: Tuple[SchematronRule, ...]


@dataclass(frozen=True)
class SchematronPhase:
    """A ``phase``: the patterns that apply in one validation stage."""

    phase_id: str
    active_patterns: Tuple[str, ...]


@dataclass
class SchematronDocument:
    """A fully-resolved Schematron rule set.

    Attributes:
        title: The ``title`` element's text, when present.
        description: Prose from top-level ``p`` elements, joined — the description an imported
            style guide carries.
        query_binding: ``@queryBinding`` as written (``xslt2``, ``xpath2``, …), or ``None``.
        default_phase: ``@defaultPhase`` as written, or ``None``.
        resolved_phase: The phase whose patterns are active: ``default_phase`` when it names a
            declared phase, otherwise ``#ALL``.
        namespaces: ``ns`` prefix -> URI bindings declared by the schema.
        patterns: Every concrete pattern, in document order (abstract templates are expanded
            into their instantiations and do not appear).
        phases: Every declared phase, in document order.
        assertions: Every assertion of every concrete pattern, in document order.
        modules: Relative paths of every module spliced in by ``include``, in resolution order.
    """

    title: Optional[str]
    description: Optional[str]
    query_binding: Optional[str]
    default_phase: Optional[str]
    resolved_phase: str
    namespaces: Mapping[str, str]
    patterns: Tuple[SchematronPattern, ...]
    phases: Tuple[SchematronPhase, ...]
    assertions: Tuple[SchematronAssertion, ...]
    modules: Tuple[str, ...] = ()


# --- Detection ---------------------------------------------------------------------------------


def _local_name(tag: str) -> str:
    """Return the local part of a possibly namespace-qualified ``ElementTree`` tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _namespace(tag: str) -> str:
    """Return the namespace URI of an ``ElementTree`` tag (empty when unqualified)."""
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def is_schematron_document(text: str) -> bool:
    """Return whether ``text`` is a Schematron rule set (never raises).

    The marker is the one the corpus manifest declares: a ``schema`` root — or a bare
    ``pattern`` module, which is what an ``include`` target looks like — in a Schematron
    namespace. A compiled Schematron *stylesheet* (the usual XSLT deliverable) is therefore not
    claimed, which is the neighbour most likely to be mistaken for one.

    Args:
        text: The candidate document text.

    Returns:
        ``True`` when the document is Schematron.
    """
    try:
        root = parse_xml(text)
    except (SecureXmlError, Exception):  # noqa: BLE001 - a sniffer must never raise
        return False
    return _namespace(root.tag) in _NAMESPACES and _local_name(root.tag) in ("schema", "pattern")


def detect_schematron_confidence(text: str) -> float:
    """Return a 0.0–1.0 detection confidence for ``text``.

    ``0.95`` for a ``schema`` root (a complete rule set), ``0.9`` for a bare ``pattern`` module
    (Schematron, but only meaningful once included), ``0.0`` otherwise.

    Args:
        text: The candidate document text.

    Returns:
        The confidence.
    """
    try:
        root = parse_xml(text)
    except (SecureXmlError, Exception):  # noqa: BLE001 - a sniffer must never raise
        return 0.0
    if _namespace(root.tag) not in _NAMESPACES:
        return 0.0
    return {"schema": 0.95, "pattern": 0.9}.get(_local_name(root.tag), 0.0)


# --- XML reading -------------------------------------------------------------------------------


def _parse_root(text: str, source_label: Optional[str]) -> ET.Element:
    """Parse one Schematron document through the hardened XML reader.

    Args:
        text: The document text.
        source_label: Filename used to make errors specific.

    Returns:
        The root element.

    Raises:
        SchematronParseError: ``INPUT_TRUNCATED`` when the document simply ran out,
            ``INPUT_MALFORMED`` when it is mis-structured, or the hardened reader's own code
            (size, depth, DTD, entity, external reference).
    """
    try:
        return parse_xml(text, source_label=source_label)
    except SecureXmlError as exc:
        code = getattr(exc, "code", None) or "INPUT_MALFORMED"
        if code == "INPUT_MALFORMED" and any(
            marker in str(exc).lower() for marker in _TRUNCATION_MARKERS
        ):
            raise SchematronParseError(
                f"Schematron document ends unexpectedly: {exc}", code="INPUT_TRUNCATED"
            ) from exc
        raise SchematronParseError(str(exc), code=code) from exc


def parse_schematron_bytes(
    data: bytes,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, bytes]] = None,
) -> SchematronDocument:
    """Decode and parse a Schematron document from bytes.

    Schematron is XML, so UTF-8 is the interchange encoding an uploaded rule set is expected to
    use; anything else (a UTF-16 export, most commonly) is rejected as an encoding fault rather
    than surfacing later as unreadable markup.

    Args:
        data: The document bytes.
        source_label: Filename used to make errors specific.
        members: Fileset members (relative path -> bytes) an ``include`` may name.

    Returns:
        The resolved :class:`SchematronDocument`.

    Raises:
        SchematronParseError: ``INPUT_ENCODING_INVALID`` when the bytes are not UTF-8, plus
            everything :func:`parse_schematron` raises.
    """
    where = f" ({source_label})" if source_label else ""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SchematronParseError(
            f"Schematron document is not UTF-8{where}: {exc}", code="INPUT_ENCODING_INVALID"
        ) from exc

    decoded_members: Optional[Dict[str, str]] = None
    if members:
        decoded_members = {}
        for name, blob in members.items():
            try:
                decoded_members[name] = blob.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise SchematronParseError(
                    f"Schematron module {name!r} is not UTF-8: {exc}",
                    code="INPUT_ENCODING_INVALID",
                ) from exc
    return parse_schematron(text, source_label=source_label, members=decoded_members)


def parse_schematron(
    text: str,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, str]] = None,
) -> SchematronDocument:
    """Read a Schematron rule set into a fully-resolved :class:`SchematronDocument`.

    Args:
        text: The rule set's text (the root member of a multi-file set).
        source_label: Relative path of ``text`` within the set, used both to make errors
            specific and to resolve a relative ``include`` ``href`` against.
        members: Fileset members (relative path -> text) an ``include`` may name. ``None`` means
            a single-file rule set, so any ``include`` is unresolvable.

    Returns:
        The resolved document: abstract patterns instantiated, abstract rules inlined, literal
        ``let`` values substituted, phases resolved, assertions flattened in document order.

    Raises:
        SchematronParseError: With an intake taxonomy code — the document is not XML
            (``INPUT_MALFORMED`` / ``INPUT_TRUNCATED``), is not Schematron
            (``FORMAT_MISMATCH``), names a module / abstract pattern / abstract rule that does
            not exist (``INPUT_REFERENCE_UNRESOLVED``), or declares no assertion at all
            (``INPUT_SEMANTIC_INVALID``).
    """
    root = _parse_root(text, source_label)
    if _namespace(root.tag) not in _NAMESPACES:
        raise SchematronParseError(
            f"Document root is {{{_namespace(root.tag)}}}{_local_name(root.tag)}, not a "
            f"Schematron element in {SCHEMATRON_NS}",
            code="FORMAT_MISMATCH",
        )
    if _local_name(root.tag) not in ("schema", "pattern"):
        raise SchematronParseError(
            f"Schematron root must be `schema` or `pattern`, got `{_local_name(root.tag)}`",
            code="FORMAT_MISMATCH",
        )

    reader = _Reader(members or {}, source_label)
    children = reader.expand_includes(root, source_label, depth=0)
    document = reader.build(root, children)
    if not document.assertions:
        raise SchematronParseError(
            "Schematron rule set declares no `assert` or `report`, so it would import as an "
            "empty style guide",
            code="INPUT_SEMANTIC_INVALID",
        )
    return document


# --- Reading -----------------------------------------------------------------------------------


@dataclass
class _AbstractRule:
    """An ``abstract="true"`` rule, held aside until a concrete rule ``extends`` it."""

    rule_id: str
    element: ET.Element


class _Reader:
    """Reads one rule set: include splicing, then a single pass over the assembled elements.

    Held as a class purely so the fileset, the module ledger and the document-count budget are
    shared by the recursive include walk and the single build pass, rather than threaded through
    every helper.
    """

    def __init__(self, members: Mapping[str, str], root_label: Optional[str]) -> None:
        self._members = members
        self._root_label = root_label
        self._modules: List[str] = []
        self._documents = 1

    # --- include splicing ---------------------------------------------------------------

    def expand_includes(
        self, element: ET.Element, base: Optional[str], depth: int, seen: Sequence[str] = ()
    ) -> List[ET.Element]:
        """Return ``element``'s children with every ``include`` replaced by its module's root.

        ISO Schematron's ``include`` is positional splicing, not a reference: the module's root
        element takes the directive's place. Resolution is against the uploaded set only —
        nothing is fetched — and both the nesting depth and the number of assembled documents
        are capped.

        Args:
            element: The element whose children to expand.
            base: Relative path of the document ``element`` came from, which a relative ``href``
                resolves against.
            depth: Current include nesting depth.
            seen: Module paths already on this include chain, for cycle detection.

        Returns:
            The expanded child list, in document order.

        Raises:
            SchematronParseError: On a missing ``href``, an unresolvable module, an include
                cycle, or a breach of either composition bound.
        """
        expanded: List[ET.Element] = []
        for child in element:
            if _namespace(child.tag) not in _NAMESPACES or _local_name(child.tag) != "include":
                expanded.append(child)
                continue

            href = (child.get("href") or "").strip()
            if not href:
                raise SchematronParseError(
                    "`include` has no `href` attribute", code="INPUT_SEMANTIC_INVALID"
                )
            if depth >= MAX_INCLUDE_DEPTH:
                raise SchematronParseError(
                    f"`include` nests deeper than {MAX_INCLUDE_DEPTH} levels", code="INPUT_DEPTH_LIMIT"
                )
            resolved = self._resolve_href(href, base)
            if resolved in seen:
                raise SchematronParseError(
                    f"`include` of {href!r} forms a cycle", code="INPUT_UNSAFE_CONSTRUCT"
                )
            self._documents += 1
            if self._documents > MAX_TOTAL_DOCUMENTS:
                raise SchematronParseError(
                    f"Schematron set assembles more than {MAX_TOTAL_DOCUMENTS} documents",
                    code="INPUT_TOO_LARGE",
                )

            module_root = _parse_root(self._members[resolved], resolved)
            if _namespace(module_root.tag) not in _NAMESPACES:
                raise SchematronParseError(
                    f"Included module {href!r} is not a Schematron document",
                    code="FORMAT_MISMATCH",
                )
            self._modules.append(resolved)
            # The module's own children may include further modules; splice them first so the
            # spliced-in root is already whole.
            module_children = self.expand_includes(
                module_root, resolved, depth + 1, tuple(seen) + (resolved,)
            )
            spliced = ET.Element(module_root.tag, dict(module_root.attrib))
            spliced.extend(module_children)
            expanded.append(spliced)
        return expanded

    def _resolve_href(self, href: str, base: Optional[str]) -> str:
        """Resolve an ``include`` ``href`` to a fileset member path.

        Args:
            href: The directive's ``href``, relative to ``base``.
            base: Relative path of the including document.

        Returns:
            The member key.

        Raises:
            SchematronParseError: ``INPUT_REFERENCE_UNRESOLVED`` when the set has no such
                member (which is also what a single-file upload with an ``include`` hits).
        """
        candidates: List[str] = []
        if base:
            parent = PurePosixPath(base).parent
            candidates.append(str((parent / href)) if str(parent) != "." else href)
        candidates.append(href)
        candidates.append(PurePosixPath(href).name)
        for candidate in candidates:
            normalized = str(PurePosixPath(candidate))
            if normalized in self._members:
                return normalized
        raise SchematronParseError(
            f"`include` names {href!r}, which is not part of the uploaded rule set",
            code="INPUT_REFERENCE_UNRESOLVED",
        )

    # --- build --------------------------------------------------------------------------

    def build(self, root: ET.Element, children: Sequence[ET.Element]) -> SchematronDocument:
        """Assemble the resolved document from the root element and its spliced children.

        Args:
            root: The ``schema`` (or bare ``pattern``) root element.
            children: ``root``'s children with includes already spliced in.

        Returns:
            The resolved :class:`SchematronDocument`.

        Raises:
            SchematronParseError: On any unresolvable ``is-a`` / ``extends`` reference.
        """
        if _local_name(root.tag) == "pattern":
            # A bare module: treat it as a one-pattern schema so a member of an include set can
            # still be read on its own.
            children = [root]

        title: Optional[str] = None
        prose: List[str] = []
        namespaces: Dict[str, str] = {}
        schema_lets: Dict[str, str] = {}
        phases: List[SchematronPhase] = []
        diagnostics: Dict[str, str] = {}
        pattern_elements: List[ET.Element] = []
        abstract_patterns: Dict[str, ET.Element] = {}

        for child in children:
            if _namespace(child.tag) not in _NAMESPACES:
                continue
            local = _local_name(child.tag)
            if local == "title" and title is None:
                title = _flatten_text(child) or None
            elif local == "p":
                text = _flatten_text(child)
                if text:
                    prose.append(text)
            elif local == "ns":
                prefix, uri = child.get("prefix"), child.get("uri")
                if prefix and uri:
                    namespaces[prefix] = uri
            elif local == "let":
                name, value = child.get("name"), child.get("value")
                if name and value is not None:
                    schema_lets[name] = value
            elif local == "phase":
                phases.append(
                    SchematronPhase(
                        phase_id=child.get("id") or "",
                        active_patterns=tuple(
                            active.get("pattern") or ""
                            for active in child
                            if _local_name(active.tag) == "active" and active.get("pattern")
                        ),
                    )
                )
            elif local == "diagnostics":
                for diagnostic in child:
                    if _local_name(diagnostic.tag) != "diagnostic":
                        continue
                    diagnostic_id = diagnostic.get("id")
                    if diagnostic_id:
                        diagnostics[diagnostic_id] = _flatten_text(diagnostic)
            elif local == "pattern":
                if _is_true(child.get("abstract")):
                    pattern_id = child.get("id")
                    if pattern_id:
                        abstract_patterns[pattern_id] = child
                else:
                    pattern_elements.append(child)

        default_phase = root.get("defaultPhase")
        declared_phase_ids = {phase.phase_id for phase in phases}
        resolved_phase = default_phase if default_phase in declared_phase_ids else "#ALL"
        active_patterns = (
            {
                pattern
                for phase in phases
                if phase.phase_id == resolved_phase
                for pattern in phase.active_patterns
            }
            if resolved_phase != "#ALL"
            else None
        )
        phases_by_pattern: Dict[str, List[str]] = {}
        for phase in phases:
            for pattern_id in phase.active_patterns:
                phases_by_pattern.setdefault(pattern_id, []).append(phase.phase_id)

        patterns: List[SchematronPattern] = []
        assertions: List[SchematronAssertion] = []
        used_ids: Dict[str, int] = {}
        for index, element in enumerate(pattern_elements):
            pattern = self._read_pattern(
                element,
                abstract_patterns,
                schema_lets,
                diagnostics,
                fallback_id=f"pattern-{index + 1}",
                used_ids=used_ids,
                phases=tuple(phases_by_pattern.get(element.get("id") or "", ())),
                active=active_patterns is None or (element.get("id") or "") in active_patterns,
            )
            patterns.append(pattern)
            for rule in pattern.rules:
                assertions.extend(rule.assertions)

        return SchematronDocument(
            title=title,
            description=" ".join(prose) or None,
            query_binding=root.get("queryBinding"),
            default_phase=default_phase,
            resolved_phase=resolved_phase,
            namespaces=namespaces,
            patterns=tuple(patterns),
            phases=tuple(phases),
            assertions=tuple(assertions),
            modules=tuple(self._modules),
        )

    def _read_pattern(
        self,
        element: ET.Element,
        abstract_patterns: Mapping[str, ET.Element],
        schema_lets: Mapping[str, str],
        diagnostics: Mapping[str, str],
        fallback_id: str,
        used_ids: Dict[str, int],
        phases: Tuple[str, ...],
        active: bool,
    ) -> SchematronPattern:
        """Read one concrete pattern, instantiating it from its template when it is an ``is-a``.

        Args:
            element: The ``pattern`` element.
            abstract_patterns: Every abstract pattern by id, for ``is-a`` resolution.
            schema_lets: Schema-level ``let`` values in scope.
            diagnostics: Diagnostic text by id.
            fallback_id: Id to use when the pattern declares none.
            used_ids: Assertion ids already taken in this document (mutated).
            phases: Ids of the phases that activate this pattern.
            active: Whether this pattern is active in the resolved phase.

        Returns:
            The resolved pattern.

        Raises:
            SchematronParseError: On an unresolvable ``is-a`` or an over-deep chain.
        """
        pattern_id = element.get("id") or fallback_id
        is_a = element.get("is-a")

        # Walk the ``is-a`` chain to the template that actually carries the rules. An abstract
        # pattern may itself instantiate another, and the *outermost* ``param`` wins, so params
        # collected earlier in the walk are never overwritten by the template's own.
        params: Dict[str, str] = {}
        template = element
        current = element
        depth = 0
        while current.get("is-a"):
            if depth >= MAX_ABSTRACT_DEPTH:
                raise SchematronParseError(
                    f"`is-a` chain for pattern {pattern_id!r} nests deeper than "
                    f"{MAX_ABSTRACT_DEPTH} levels",
                    code="INPUT_DEPTH_LIMIT",
                )
            for param in current:
                if _local_name(param.tag) != "param":
                    continue
                name, value = param.get("name"), param.get("value")
                if name and value is not None:
                    params.setdefault(name, value)
            target = current.get("is-a") or ""
            template = abstract_patterns.get(target)
            if template is None:
                raise SchematronParseError(
                    f"Pattern {pattern_id!r} instantiates abstract pattern {target!r}, which the "
                    "rule set does not declare",
                    code="INPUT_REFERENCE_UNRESOLVED",
                )
            current = template
            depth += 1

        pattern_lets = dict(schema_lets)
        for child in template:
            if _local_name(child.tag) == "let":
                name, value = child.get("name"), child.get("value")
                if name and value is not None:
                    pattern_lets[name] = value

        abstract_rules: Dict[str, ET.Element] = {}
        rule_elements: List[ET.Element] = []
        for child in template:
            if _namespace(child.tag) not in _NAMESPACES or _local_name(child.tag) != "rule":
                continue
            if _is_true(child.get("abstract")):
                rule_id = child.get("id")
                if rule_id:
                    abstract_rules[rule_id] = child
            else:
                rule_elements.append(child)

        rules = tuple(
            self._read_rule(
                rule_element,
                abstract_rules,
                pattern_lets,
                diagnostics,
                params,
                pattern_id=pattern_id,
                instantiated_from=is_a,
                used_ids=used_ids,
                phases=phases,
                active=active,
            )
            for rule_element in rule_elements
        )
        return SchematronPattern(
            pattern_id=pattern_id,
            title=next(
                (
                    _flatten_text(child)
                    for child in template
                    if _local_name(child.tag) == "title"
                ),
                None,
            ),
            abstract=False,
            is_a=is_a,
            params=params,
            rules=rules,
        )

    def _read_rule(
        self,
        element: ET.Element,
        abstract_rules: Mapping[str, ET.Element],
        pattern_lets: Mapping[str, str],
        diagnostics: Mapping[str, str],
        params: Mapping[str, str],
        pattern_id: str,
        instantiated_from: Optional[str],
        used_ids: Dict[str, int],
        phases: Tuple[str, ...],
        active: bool,
    ) -> SchematronRule:
        """Read one concrete rule, inlining every abstract rule it extends.

        Raises:
            SchematronParseError: When an ``extends`` names a rule the pattern does not declare.
        """
        rule_lets = dict(pattern_lets)
        for child in element:
            if _local_name(child.tag) == "let":
                name, value = child.get("name"), child.get("value")
                if name and value is not None:
                    rule_lets[name] = value

        substitutions = _substitutions(params, rule_lets)
        context = _normalize_xpath(_substitute(element.get("context") or "", substitutions))

        extends: List[str] = []
        assertion_elements: List[Tuple[ET.Element, Optional[str]]] = []
        for child in element:
            if _namespace(child.tag) not in _NAMESPACES:
                continue
            local = _local_name(child.tag)
            if local == "extends":
                extended_id = child.get("rule")
                if not extended_id or extended_id not in abstract_rules:
                    raise SchematronParseError(
                        f"`extends` names rule {extended_id!r}, which the pattern "
                        f"{pattern_id!r} does not declare as abstract",
                        code="INPUT_REFERENCE_UNRESOLVED",
                    )
                extends.append(extended_id)
                # ISO order: an extended rule's assertions are evaluated before the extending
                # rule's own.
                assertion_elements.extend(
                    (grandchild, extended_id)
                    for grandchild in abstract_rules[extended_id]
                    if _local_name(grandchild.tag) in ("assert", "report")
                )
            elif local in ("assert", "report"):
                assertion_elements.append((child, None))

        assertions = tuple(
            self._read_assertion(
                assertion_element,
                substitutions,
                diagnostics,
                context=context,
                pattern_id=pattern_id,
                instantiated_from=instantiated_from,
                inherited_from=inherited_from,
                used_ids=used_ids,
                phases=phases,
                active=active,
            )
            for assertion_element, inherited_from in assertion_elements
        )
        return SchematronRule(
            context=context or None,
            rule_id=element.get("id"),
            abstract=False,
            extends=tuple(extends),
            assertions=assertions,
        )

    def _read_assertion(
        self,
        element: ET.Element,
        substitutions: Mapping[str, str],
        diagnostics: Mapping[str, str],
        context: str,
        pattern_id: str,
        instantiated_from: Optional[str],
        inherited_from: Optional[str],
        used_ids: Dict[str, int],
        phases: Tuple[str, ...],
        active: bool,
    ) -> SchematronAssertion:
        """Read one ``assert`` / ``report`` into a :class:`SchematronAssertion`."""
        declared = element.get("id")
        assertion_id = _unique_id(declared or f"{pattern_id}-{len(used_ids) + 1}", used_ids)
        role = (element.get("role") or "").strip().lower() or None
        diagnostic_ids = (element.get("diagnostics") or "").split()
        remediation = " ".join(
            diagnostics[diagnostic_id]
            for diagnostic_id in diagnostic_ids
            if diagnostic_id in diagnostics and diagnostics[diagnostic_id]
        )
        return SchematronAssertion(
            kind=_local_name(element.tag),
            assertion_id=assertion_id,
            declared_id=bool(declared),
            test=_normalize_xpath(_substitute(element.get("test") or "", substitutions)),
            context=context,
            message=_substitute(_flatten_text(element), substitutions),
            role=role,
            severity=ROLE_SEVERITIES.get(role or "", DEFAULT_SEVERITY),
            flag=element.get("flag"),
            pattern_id=pattern_id,
            instantiated_from=instantiated_from,
            inherited_from=inherited_from,
            diagnostics=remediation or None,
            phases=phases,
            active=active,
        )


# --- Text, ids and substitution ----------------------------------------------------------------


def _is_true(value: Optional[str]) -> bool:
    """Return whether an XML boolean attribute reads true."""
    return (value or "").strip().lower() in ("true", "yes", "1")


def _normalize_xpath(expression: str) -> str:
    """Collapse whitespace runs in an XPath, leaving quoted literals byte-identical.

    XML attribute values keep the source's line wrapping, so a long ``@test`` arrives with runs
    of newlines and indentation inside it. Those are insignificant to XPath but noisy in a
    recorded target and in the reason text quoting the expression — while whitespace *inside* a
    string literal is significant, so the collapse steps around quoted spans.

    Args:
        expression: The XPath as written.

    Returns:
        The single-line form.
    """
    if not expression:
        return expression
    parts: List[str] = []
    quote: Optional[str] = None
    buffer: List[str] = []
    for character in expression:
        if quote is None and character in ("'", '"'):
            parts.append(re.sub(r"\s+", " ", "".join(buffer)))
            buffer = [character]
            quote = character
        elif quote is not None and character == quote:
            buffer.append(character)
            parts.append("".join(buffer))
            buffer = []
            quote = None
        else:
            buffer.append(character)
    parts.append("".join(buffer) if quote is not None else re.sub(r"\s+", " ", "".join(buffer)))
    return "".join(parts).strip()


def _flatten_text(element: ET.Element) -> str:
    """Flatten an assertion's mixed content to one line of human text.

    Schematron message text interleaves prose with ``<name/>`` (the matched element's name) and
    ``<value-of select="…"/>`` (a computed value). Neither has a value outside a validation run,
    so they become readable placeholders — ``<name>`` and ``{select}`` — rather than being
    dropped, which would silently change what the message says.

    Args:
        element: The element whose content to flatten.

    Returns:
        The single-line text (collapsed whitespace, may be empty).
    """
    parts: List[str] = [element.text or ""]
    for child in element:
        local = _local_name(child.tag)
        if local == "name":
            parts.append("<name>")
        elif local == "value-of":
            parts.append("{" + (child.get("select") or "") + "}")
        elif local in ("emph", "span", "dir", "b", "i"):
            parts.append(_flatten_text(child))
        parts.append(child.tail or "")
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _unique_id(candidate: str, used_ids: Dict[str, int]) -> str:
    """Return ``candidate``, suffixed when the document already used it.

    An abstract pattern instantiated twice, or an abstract rule extended by two concrete rules,
    legitimately produces the same assertion ``@id`` more than once — the assertions are
    distinct, so they get distinct ids (``ID-R001``, ``ID-R001-2``) rather than colliding into
    one imported rule.

    Args:
        candidate: The assertion id as written (or derived).
        used_ids: Ids already taken, mapped to how many times (mutated).

    Returns:
        A document-unique id.
    """
    count = used_ids.get(candidate, 0) + 1
    used_ids[candidate] = count
    return candidate if count == 1 else f"{candidate}-{count}"


def _literal_let(value: str) -> Optional[str]:
    """Return ``value`` when it is an XPath literal constant, else ``None``.

    A ``let`` is only substitutable when it *is* a value: a quoted string, a number, or a
    parenthesised sequence of them (``('EUR', 'GBP', 'USD')``). Anything computed
    (``sum(inv:Line/inv:LineAmount)``, ``current-date()``) stays a variable reference, which the
    projection then reports as unevaluable instead of guessing.

    Args:
        value: The ``@value`` XPath as written.

    Returns:
        The literal, normalized, or ``None`` when the value is a computation.
    """
    text = value.strip()
    if _LITERAL_STRING_RE.match(text) or _LITERAL_NUMBER_RE.match(text):
        return text
    if text.startswith("(") and text.endswith(")"):
        inner = text[1:-1].strip()
        if not inner:
            return None
        items = [item.strip() for item in inner.split(",")]
        if all(_LITERAL_STRING_RE.match(item) or _LITERAL_NUMBER_RE.match(item) for item in items):
            return "(" + ", ".join(items) + ")"
    return None


def _substitutions(params: Mapping[str, str], lets: Mapping[str, str]) -> Dict[str, str]:
    """Return the ``$name`` -> replacement map in scope for one rule.

    Abstract-pattern ``param`` values always substitute (that is what a template *is*); ``let``
    values substitute only when they are literals (:func:`_literal_let`). Parameters win over
    variables of the same name, matching ISO Schematron's instantiation semantics.
    """
    substitutions = {name: _literal_let(value) or "" for name, value in lets.items()}
    substitutions = {name: value for name, value in substitutions.items() if value}
    substitutions.update(params)
    return substitutions


def _substitute(expression: str, substitutions: Mapping[str, str]) -> str:
    """Replace every ``$name`` in ``expression`` with its in-scope value.

    Longest name first, so ``$parentId`` is not clipped by a substitution for ``$parent``.

    Args:
        expression: An XPath or message text.
        substitutions: ``name`` -> replacement (no ``$``).

    Returns:
        The substituted expression (unchanged when nothing is in scope).
    """
    if not expression or not substitutions:
        return expression
    for name in sorted(substitutions, key=len, reverse=True):
        expression = re.sub(rf"\${re.escape(name)}\b", substitutions[name], expression)
    return expression
