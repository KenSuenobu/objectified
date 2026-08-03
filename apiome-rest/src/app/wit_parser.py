"""WIT (WebAssembly Component Model) parser — IXH-7.9.

Parses WIT (``.wit``) interface definitions into a typed :class:`WitDocument` AST
using lightweight scanning and brace matching (no external ``wasm-tools``
dependency), following the repo's Cap'n Proto / Thrift parser convention. Syntax
errors surface as :class:`WitParseError` carrying an intake-taxonomy ``code``
where the failure is classifiable (truncation, encoding, format mismatch).

Covered grammar (the WIT 0.2 surface):

* ``package ns:name@version;`` declarations (the nested single-block form
  ``package ns:name { … }`` is unwrapped; *secondary* nested package blocks are a
  declared parser limit — see ``KNOWN_PARSER_LIMITS['wit']``);
* ``interface`` blocks with ``use``, ``type`` aliases, ``record``, ``variant``,
  ``enum``, ``flags``, ``resource`` (constructor / methods / static methods) and
  freestanding ``func`` definitions;
* ``world`` blocks with interface imports/exports (by name, by package path, or
  inline), function imports/exports, ``use`` and (unexpanded) ``include``;
* ``@since`` / ``@unstable`` / ``@deprecated`` gate annotations (stripped —
  feature gating is not part of the imported shape).

Type expressions (``list<u8>``, ``option<t>``, ``result<a, b>``, ``tuple<…>``,
``borrow<r>``…) are kept verbatim on the AST; the normalizer interprets them.
Multi-file packages are merged by :func:`parse_wit_package`, so ``use``
statements across files resolve within the supplied package.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

__all__ = [
    "WitParseError",
    "WitUse",
    "WitField",
    "WitFunction",
    "WitRecord",
    "WitVariantCase",
    "WitVariant",
    "WitEnum",
    "WitFlags",
    "WitTypeAlias",
    "WitResource",
    "WitInterface",
    "WitWorldFunction",
    "WitWorldInterfaceRef",
    "WitWorld",
    "WitDocument",
    "is_wit",
    "parse_wit",
    "parse_wit_package",
]


class WitParseError(ValueError):
    """Raised when WIT text cannot be parsed.

    Args:
        message: Human-readable description of the syntax problem.
        code: Optional stable intake-taxonomy code (``INPUT_TRUNCATED``,
            ``INPUT_MALFORMED``, ``FORMAT_MISMATCH``, …) when the failure is
            classifiable at the parser level.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


# A WIT identifier: lower-kebab-case words, optionally %-prefixed (explicit-id form).
_ID = r"%?[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
# An interface path: `iface`, `ns:pkg/iface`, or `ns:pkg/iface@1.2.3`.
_PATH = rf"(?:{_ID}:)?{_ID}(?:/{_ID})?(?:@[0-9][0-9a-zA-Z.+-]*)?"


# ===========================================================================
# AST
# ===========================================================================


@dataclass(frozen=True)
class WitUse:
    """One ``use path.{a, b as c};`` statement."""

    path: str
    names: Tuple[Tuple[str, Optional[str]], ...]  # (source name, local alias or None)


@dataclass(frozen=True)
class WitField:
    """A named, typed member — record field, function parameter, named result."""

    name: str
    type_expr: str


@dataclass(frozen=True)
class WitFunction:
    """A ``func`` signature (freestanding, method, static method, or constructor).

    ``result`` holds the single anonymous result type expression (WIT 0.2 allows
    at most one); ``named_results`` preserves the legacy ``-> (a: t, b: u)`` form.
    """

    name: str
    params: Tuple[WitField, ...]
    result: Optional[str] = None
    named_results: Tuple[WitField, ...] = ()
    kind: str = "freestanding"  # freestanding | method | static | constructor
    is_async: bool = False


@dataclass(frozen=True)
class WitRecord:
    name: str
    fields: Tuple[WitField, ...]


@dataclass(frozen=True)
class WitVariantCase:
    """One variant case, with an optional payload type expression."""

    name: str
    payload: Optional[str] = None


@dataclass(frozen=True)
class WitVariant:
    name: str
    cases: Tuple[WitVariantCase, ...]


@dataclass(frozen=True)
class WitEnum:
    name: str
    cases: Tuple[str, ...]


@dataclass(frozen=True)
class WitFlags:
    name: str
    flags: Tuple[str, ...]


@dataclass(frozen=True)
class WitTypeAlias:
    name: str
    target: str


@dataclass(frozen=True)
class WitResource:
    """A ``resource`` with its constructor and (static) methods."""

    name: str
    constructor: Optional[WitFunction] = None
    methods: Tuple[WitFunction, ...] = ()


@dataclass(frozen=True)
class WitInterface:
    """One ``interface`` block's contents."""

    name: str
    uses: Tuple[WitUse, ...] = ()
    records: Tuple[WitRecord, ...] = ()
    variants: Tuple[WitVariant, ...] = ()
    enums: Tuple[WitEnum, ...] = ()
    flags: Tuple[WitFlags, ...] = ()
    aliases: Tuple[WitTypeAlias, ...] = ()
    resources: Tuple[WitResource, ...] = ()
    functions: Tuple[WitFunction, ...] = ()

    def type_names(self) -> Tuple[str, ...]:
        """Every type name this interface defines, in declaration-family order."""
        return tuple(
            item.name
            for group in (
                self.records,
                self.variants,
                self.enums,
                self.flags,
                self.aliases,
                self.resources,
            )
            for item in group
        )


@dataclass(frozen=True)
class WitWorldFunction:
    """A function imported or exported directly by a world."""

    direction: str  # import | export
    function: WitFunction


@dataclass(frozen=True)
class WitWorldInterfaceRef:
    """An interface a world imports or exports — by name/path or inline."""

    direction: str  # import | export
    path: str
    inline: Optional[WitInterface] = None


@dataclass(frozen=True)
class WitWorld:
    """One ``world`` block's contents."""

    name: str
    interface_refs: Tuple[WitWorldInterfaceRef, ...] = ()
    functions: Tuple[WitWorldFunction, ...] = ()
    includes: Tuple[str, ...] = ()
    uses: Tuple[WitUse, ...] = ()


@dataclass(frozen=True)
class WitDocument:
    """A parsed WIT package (one file, or a merged multi-file fileset)."""

    package: Optional[str]  # `ns:name` without the version
    version: Optional[str]
    interfaces: Tuple[WitInterface, ...]
    worlds: Tuple[WitWorld, ...]
    top_uses: Tuple[WitUse, ...]
    raw: str
    source_files: Tuple[str, ...] = ()
    #: Count of nested `package … { }` blocks beyond the first — a declared parser
    #: limit (their contents are not read); surfaced so the normalizer can report it.
    extra_package_blocks: int = 0


# ===========================================================================
# Detection
# ===========================================================================


def is_wit(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a WIT document.

    Cheap and safe for registry-wide sniffing: string checks only, never raises.
    """
    if not content or not isinstance(content, str):
        return False
    cleaned = _strip_comments(content)
    if not cleaned.strip():
        return False
    if re.search(rf"^\s*package\s+{_ID}:{_ID}", cleaned, re.MULTILINE):
        return True
    has_block = re.search(rf"\b(world|interface)\s+{_ID}\s*\{{", cleaned)
    if not has_block:
        return False
    wit_markers = re.search(
        rf":\s*(?:async\s+)?func\s*\(|\b(?:record|variant|resource|flags)\s+{_ID}\s*\{{",
        cleaned,
    )
    return bool(wit_markers)


# ===========================================================================
# Lexical helpers
# ===========================================================================


def _strip_comments(text: str) -> str:
    """Remove ``//``-style line comments and (nested) ``/* */`` block comments.

    Comment bytes are replaced with spaces (newlines kept), so brace positions and
    line structure survive for error reporting and brace matching.
    """
    out: List[str] = []
    i, n = 0, len(text)
    depth = 0
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if depth == 0 and ch == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if ch == "/" and nxt == "*":
            depth += 1
            out.append("  ")
            i += 2
            continue
        if depth > 0 and ch == "*" and nxt == "/":
            depth -= 1
            out.append("  ")
            i += 2
            continue
        if depth > 0:
            out.append(ch if ch == "\n" else " ")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _strip_gates(text: str) -> str:
    """Remove ``@since`` / ``@unstable`` / ``@deprecated`` gate annotations."""
    return re.sub(r"@(?:since|unstable|deprecated)\s*\([^)]*\)", " ", text)


def _find_matching_brace(text: str, start: int) -> int:
    """Index of the ``}`` closing the ``{`` just before ``start``, or ``-1``."""
    depth = 1
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _split_top_level_commas(chunk: str) -> List[str]:
    """Split on commas not nested inside ``<>``, ``()``, or ``{}``."""
    parts: List[str] = []
    current: List[str] = []
    depth = 0
    for ch in chunk:
        if ch in "<({":
            depth += 1
        elif ch in ">)}":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            part = "".join(current).strip()
            if part:
                parts.append(part)
            current = []
            continue
        current.append(ch)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def _line_of(text: str, pos: int) -> int:
    """1-based line number of ``pos`` in ``text``."""
    return text.count("\n", 0, pos) + 1


# ===========================================================================
# Statement parsers
# ===========================================================================


def _parse_use(statement: str) -> Optional[WitUse]:
    """Parse ``use path.{a, b as c}`` (no trailing ``;``), or ``None``."""
    match = re.fullmatch(
        rf"use\s+({_PATH})\s*\.\s*\{{(.*)\}}", statement.strip(), re.DOTALL
    )
    if not match:
        return None
    names: List[Tuple[str, Optional[str]]] = []
    for part in _split_top_level_commas(match.group(2)):
        alias_match = re.fullmatch(rf"({_ID})\s+as\s+({_ID})", part)
        if alias_match:
            names.append((alias_match.group(1), alias_match.group(2)))
        elif re.fullmatch(_ID, part):
            names.append((part, None))
        else:
            raise WitParseError(f"Invalid name {part!r} in use statement {statement!r}")
    return WitUse(path=match.group(1), names=tuple(names))


def _parse_named_fields(chunk: str, *, context: str) -> Tuple[WitField, ...]:
    """Parse ``name: type`` comma-separated members (record fields, params)."""
    fields: List[WitField] = []
    for part in _split_top_level_commas(chunk):
        match = re.fullmatch(rf"({_ID})\s*:\s*(.+)", part, re.DOTALL)
        if not match:
            raise WitParseError(f"Invalid member {part!r} in {context}")
        fields.append(WitField(name=match.group(1), type_expr=" ".join(match.group(2).split())))
    return tuple(fields)


def _parse_func_signature(
    name: str, signature: str, *, kind: str = "freestanding"
) -> WitFunction:
    """Parse ``[async] func(params) [-> result]`` into a :class:`WitFunction`."""
    sig = " ".join(signature.split())
    match = re.fullmatch(r"(async\s+)?func\s*\((.*?)\)\s*(?:->\s*(.+))?", sig, re.DOTALL)
    if not match:
        raise WitParseError(f"Invalid function signature for {name!r}: {signature!r}")
    is_async = bool(match.group(1))
    params = _parse_named_fields(match.group(2), context=f"parameters of {name!r}") if match.group(2).strip() else ()
    result: Optional[str] = None
    named_results: Tuple[WitField, ...] = ()
    result_expr = (match.group(3) or "").strip()
    if result_expr:
        paren = re.fullmatch(r"\((.*)\)", result_expr, re.DOTALL)
        if paren:
            named_results = _parse_named_fields(paren.group(1), context=f"results of {name!r}")
        else:
            result = result_expr
    return WitFunction(
        name=name,
        params=params,
        result=result,
        named_results=named_results,
        kind=kind,
        is_async=is_async,
    )


def _parse_resource_body(name: str, inner: str) -> WitResource:
    """Parse a ``resource`` block's constructor and (static) method statements."""
    constructor: Optional[WitFunction] = None
    methods: List[WitFunction] = []
    for statement in _iter_semicolon_statements(inner, context=f"resource {name!r}"):
        ctor_match = re.fullmatch(r"constructor\s*\((.*?)\)", statement, re.DOTALL)
        if ctor_match:
            params = (
                _parse_named_fields(ctor_match.group(1), context=f"constructor of {name!r}")
                if ctor_match.group(1).strip()
                else ()
            )
            constructor = WitFunction(name="constructor", params=params, kind="constructor")
            continue
        method_match = re.fullmatch(
            rf"({_ID})\s*:\s*(static\s+)?((?:async\s+)?func.*)", statement, re.DOTALL
        )
        if method_match:
            kind = "static" if method_match.group(2) else "method"
            methods.append(
                _parse_func_signature(method_match.group(1), method_match.group(3), kind=kind)
            )
            continue
        raise WitParseError(f"Invalid statement in resource {name!r}: {statement!r}")
    return WitResource(name=name, constructor=constructor, methods=tuple(methods))


def _iter_semicolon_statements(inner: str, *, context: str) -> List[str]:
    """Split block text into ``;``-terminated statements (no nested braces)."""
    statements: List[str] = []
    for raw_statement in inner.split(";"):
        statement = " ".join(raw_statement.split())
        if statement:
            statements.append(statement)
    return statements


@dataclass
class _InterfaceAccumulator:
    """Mutable collector for one interface block's parsed items."""

    uses: List[WitUse] = field(default_factory=list)
    records: List[WitRecord] = field(default_factory=list)
    variants: List[WitVariant] = field(default_factory=list)
    enums: List[WitEnum] = field(default_factory=list)
    flags: List[WitFlags] = field(default_factory=list)
    aliases: List[WitTypeAlias] = field(default_factory=list)
    resources: List[WitResource] = field(default_factory=list)
    functions: List[WitFunction] = field(default_factory=list)


def _parse_interface_body(name: str, inner: str) -> WitInterface:
    """Parse the contents of ``interface <name> { … }``."""
    acc = _InterfaceAccumulator()
    i, n = 0, len(inner)
    while i < n:
        if inner[i].isspace():
            i += 1
            continue

        # `use path.{…};` — matched before the block scan, since its name list
        # is brace-delimited but is a statement, not a block.
        use_match = re.match(rf"use\s+{_PATH}\s*\.\s*\{{[^}}]*\}}\s*;", inner[i:])
        if use_match:
            statement = " ".join(inner[i : i + use_match.end() - 1].split())
            use = _parse_use(statement)
            if use is None:
                raise WitParseError(
                    f"Invalid use statement in interface {name!r}: {statement!r}"
                )
            acc.uses.append(use)
            i += use_match.end()
            continue

        # Braced items: record / variant / enum / flags / resource-with-body.
        block = re.match(
            rf"(record|variant|enum|flags|resource)\s+({_ID})\s*\{{", inner[i:]
        )
        if block:
            open_brace = i + block.end() - 1
            close = _find_matching_brace(inner, open_brace + 1)
            if close == -1:
                raise WitParseError(
                    f"Unterminated {block.group(1)} {block.group(2)!r} in interface {name!r}",
                    code="INPUT_TRUNCATED",
                )
            body = inner[open_brace + 1 : close]
            _parse_interface_block_item(acc, block.group(1), block.group(2), body, name)
            i = close + 1
            continue

        # Semicolon-terminated statement.
        end = inner.find(";", i)
        brace = inner.find("{", i)
        if brace != -1 and (end == -1 or brace < end):
            # A `{` before the next `;` that no braced-item rule matched — e.g. a
            # malformed block header. Report the offending line.
            raise WitParseError(
                f"Invalid block near line {_line_of(inner, i)} in interface {name!r}: "
                f"{inner[i:brace + 1].strip()!r}"
            )
        if end == -1:
            raise WitParseError(
                f"Unterminated statement in interface {name!r}: {inner[i:].strip()!r}",
                code="INPUT_TRUNCATED",
            )
        statement = " ".join(inner[i:end].split())
        if statement:
            _parse_interface_statement(acc, statement, name)
        i = end + 1

    return WitInterface(
        name=name,
        uses=tuple(acc.uses),
        records=tuple(acc.records),
        variants=tuple(acc.variants),
        enums=tuple(acc.enums),
        flags=tuple(acc.flags),
        aliases=tuple(acc.aliases),
        resources=tuple(acc.resources),
        functions=tuple(acc.functions),
    )


def _parse_interface_block_item(
    acc: _InterfaceAccumulator, kind: str, item_name: str, body: str, interface_name: str
) -> None:
    """Dispatch one braced interface item (record/variant/enum/flags/resource)."""
    if kind == "record":
        acc.records.append(
            WitRecord(
                name=item_name,
                fields=_parse_named_fields(body, context=f"record {item_name!r}"),
            )
        )
    elif kind == "variant":
        cases: List[WitVariantCase] = []
        for part in _split_top_level_commas(body):
            case_match = re.fullmatch(rf"({_ID})(?:\s*\((.+)\))?", part, re.DOTALL)
            if not case_match:
                raise WitParseError(f"Invalid case {part!r} in variant {item_name!r}")
            payload = case_match.group(2)
            cases.append(
                WitVariantCase(
                    name=case_match.group(1),
                    payload=" ".join(payload.split()) if payload else None,
                )
            )
        acc.variants.append(WitVariant(name=item_name, cases=tuple(cases)))
    elif kind in ("enum", "flags"):
        members: List[str] = []
        for part in _split_top_level_commas(body):
            if not re.fullmatch(_ID, part):
                raise WitParseError(f"Invalid member {part!r} in {kind} {item_name!r}")
            members.append(part)
        if kind == "enum":
            acc.enums.append(WitEnum(name=item_name, cases=tuple(members)))
        else:
            acc.flags.append(WitFlags(name=item_name, flags=tuple(members)))
    else:  # resource
        acc.resources.append(_parse_resource_body(item_name, body))
    _ = interface_name


def _parse_interface_statement(
    acc: _InterfaceAccumulator, statement: str, interface_name: str
) -> None:
    """Dispatch one semicolon-terminated interface statement."""
    use = _parse_use(statement)
    if use:
        acc.uses.append(use)
        return
    alias_match = re.fullmatch(rf"type\s+({_ID})\s*=\s*(.+)", statement, re.DOTALL)
    if alias_match:
        acc.aliases.append(
            WitTypeAlias(name=alias_match.group(1), target=" ".join(alias_match.group(2).split()))
        )
        return
    resource_match = re.fullmatch(rf"resource\s+({_ID})", statement)
    if resource_match:
        acc.resources.append(WitResource(name=resource_match.group(1)))
        return
    func_match = re.fullmatch(rf"({_ID})\s*:\s*((?:async\s+)?func.*)", statement, re.DOTALL)
    if func_match:
        acc.functions.append(_parse_func_signature(func_match.group(1), func_match.group(2)))
        return
    raise WitParseError(
        f"Invalid statement in interface {interface_name!r}: {statement!r}"
    )


def _parse_world_body(name: str, inner: str) -> WitWorld:
    """Parse the contents of ``world <name> { … }``."""
    interface_refs: List[WitWorldInterfaceRef] = []
    functions: List[WitWorldFunction] = []
    includes: List[str] = []
    uses: List[WitUse] = []

    i, n = 0, len(inner)
    while i < n:
        if inner[i].isspace():
            i += 1
            continue

        # `use path.{…};` / `include path with { … };` — statements whose bodies
        # are brace-delimited, matched before the block scan.
        use_match = re.match(rf"use\s+{_PATH}\s*\.\s*\{{[^}}]*\}}\s*;", inner[i:])
        if use_match:
            statement = " ".join(inner[i : i + use_match.end() - 1].split())
            use = _parse_use(statement)
            if use is None:
                raise WitParseError(
                    f"Invalid use statement in world {name!r}: {statement!r}"
                )
            uses.append(use)
            i += use_match.end()
            continue
        include_with = re.match(
            rf"include\s+({_PATH})\s+with\s+\{{[^}}]*\}}\s*;", inner[i:]
        )
        if include_with:
            includes.append(include_with.group(1))
            i += include_with.end()
            continue

        # Inline interface: `import|export <id>: interface { … }`.
        inline = re.match(
            rf"(import|export)\s+({_ID})\s*:\s*interface\s*\{{", inner[i:]
        )
        if inline:
            open_brace = i + inline.end() - 1
            close = _find_matching_brace(inner, open_brace + 1)
            if close == -1:
                raise WitParseError(
                    f"Unterminated inline interface {inline.group(2)!r} in world {name!r}",
                    code="INPUT_TRUNCATED",
                )
            body = inner[open_brace + 1 : close]
            inline_name = f"{name}.{inline.group(2)}"
            interface_refs.append(
                WitWorldInterfaceRef(
                    direction=inline.group(1),
                    path=inline.group(2),
                    inline=_parse_interface_body(inline_name, body),
                )
            )
            i = close + 1
            continue

        end = inner.find(";", i)
        brace = inner.find("{", i)
        if brace != -1 and (end == -1 or brace < end):
            raise WitParseError(
                f"Invalid block near line {_line_of(inner, i)} in world {name!r}: "
                f"{inner[i:brace + 1].strip()!r}"
            )
        if end == -1:
            raise WitParseError(
                f"Unterminated statement in world {name!r}: {inner[i:].strip()!r}",
                code="INPUT_TRUNCATED",
            )
        statement = " ".join(inner[i:end].split())
        i = end + 1
        if not statement:
            continue

        use = _parse_use(statement)
        if use:
            uses.append(use)
            continue
        include_match = re.fullmatch(
            rf"include\s+({_PATH})(?:\s+with\s+\{{.*\}})?", statement, re.DOTALL
        )
        if include_match:
            includes.append(include_match.group(1))
            continue
        func_match = re.fullmatch(
            rf"(import|export)\s+({_ID})\s*:\s*((?:async\s+)?func.*)", statement, re.DOTALL
        )
        if func_match:
            functions.append(
                WitWorldFunction(
                    direction=func_match.group(1),
                    function=_parse_func_signature(func_match.group(2), func_match.group(3)),
                )
            )
            continue
        ref_match = re.fullmatch(rf"(import|export)\s+({_PATH})", statement)
        if ref_match:
            interface_refs.append(
                WitWorldInterfaceRef(direction=ref_match.group(1), path=ref_match.group(2))
            )
            continue
        raise WitParseError(f"Invalid statement in world {name!r}: {statement!r}")

    return WitWorld(
        name=name,
        interface_refs=tuple(interface_refs),
        functions=tuple(functions),
        includes=tuple(includes),
        uses=tuple(uses),
    )


# ===========================================================================
# Document parsing
# ===========================================================================


def _split_package(decl: str) -> Tuple[str, Optional[str]]:
    """Split ``ns:name@version`` into (``ns:name``, version-or-None)."""
    if "@" in decl:
        package, _, version = decl.partition("@")
        return package, version
    return decl, None


def _check_balanced(cleaned: str, *, source_label: Optional[str]) -> None:
    """Reject documents whose braces do not balance, classifying the direction."""
    depth = 0
    for ch in cleaned:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                raise WitParseError(
                    _labeled("Unbalanced '}' in WIT document", source_label),
                    code="INPUT_MALFORMED",
                )
    if depth > 0:
        raise WitParseError(
            _labeled(
                "WIT document ends inside an unterminated block — the file appears truncated",
                source_label,
            ),
            code="INPUT_TRUNCATED",
        )


def _labeled(message: str, source_label: Optional[str]) -> str:
    return f"{message} ({source_label})" if source_label else message


def parse_wit(content: str, *, source_label: Optional[str] = None) -> WitDocument:
    """Parse WIT text into a :class:`WitDocument`.

    Args:
        content: The raw ``.wit`` source text.
        source_label: Optional filename/URL used in error messages.

    Returns:
        The parsed document.

    Raises:
        WitParseError: When the text is empty, is not WIT, or has a syntax error —
            with an intake-taxonomy ``code`` when the failure is classifiable.
    """
    if not content or not content.strip():
        raise WitParseError(
            _labeled("Invalid or empty WIT document", source_label), code="INPUT_MALFORMED"
        )
    if "\x00" in content:
        raise WitParseError(
            _labeled(
                "WIT document contains NUL bytes — the file is binary or not UTF-8 encoded",
                source_label,
            ),
            code="INPUT_ENCODING_INVALID",
        )
    if not is_wit(content):
        raise WitParseError(
            _labeled("Content does not appear to be a WIT document", source_label),
            code="FORMAT_MISMATCH",
        )

    cleaned = _strip_gates(_strip_comments(content))
    _check_balanced(cleaned, source_label=source_label)

    package: Optional[str] = None
    version: Optional[str] = None
    interfaces: List[WitInterface] = []
    worlds: List[WitWorld] = []
    top_uses: List[WitUse] = []
    extra_package_blocks = 0

    i, n = 0, len(cleaned)
    while i < n:
        if cleaned[i].isspace():
            i += 1
            continue

        # `package ns:name@ver;` — the document's package declaration.
        pkg = re.match(rf"package\s+({_ID}:{_ID}(?:/{_ID})?(?:@[0-9][0-9a-zA-Z.+-]*)?)\s*;", cleaned[i:])
        if pkg:
            declared, declared_version = _split_package(pkg.group(1))
            if package is not None and package != declared:
                raise WitParseError(
                    _labeled(
                        f"Conflicting package declarations {package!r} and {declared!r}",
                        source_label,
                    ),
                    code="INPUT_SEMANTIC_INVALID",
                )
            package = declared
            version = version or declared_version
            i += pkg.end()
            continue

        # Nested package block `package ns:name { … }` — unwrap the first, count the rest.
        pkg_block = re.match(
            rf"package\s+({_ID}:{_ID}(?:@[0-9][0-9a-zA-Z.+-]*)?)\s*\{{", cleaned[i:]
        )
        if pkg_block:
            open_brace = i + pkg_block.end() - 1
            close = _find_matching_brace(cleaned, open_brace + 1)
            if close == -1:
                raise WitParseError(
                    _labeled("Unterminated package block", source_label),
                    code="INPUT_TRUNCATED",
                )
            if package is None:
                declared, declared_version = _split_package(pkg_block.group(1))
                package, version = declared, declared_version
                # Splice the block body in place of the block, then re-scan it.
                cleaned = cleaned[:i] + " " + cleaned[open_brace + 1 : close] + " " + cleaned[close + 1 :]
                n = len(cleaned)
                continue
            # Secondary nested package blocks are a declared parser limit: counted,
            # skipped, and surfaced by the normalizer — never silently absorbed.
            extra_package_blocks += 1
            i = close + 1
            continue

        block = re.match(rf"(interface|world)\s+({_ID})\s*\{{", cleaned[i:])
        if block:
            open_brace = i + block.end() - 1
            close = _find_matching_brace(cleaned, open_brace + 1)
            if close == -1:
                raise WitParseError(
                    _labeled(
                        f"Unterminated {block.group(1)} {block.group(2)!r}", source_label
                    ),
                    code="INPUT_TRUNCATED",
                )
            inner = cleaned[open_brace + 1 : close]
            if block.group(1) == "interface":
                interfaces.append(_parse_interface_body(block.group(2), inner))
            else:
                worlds.append(_parse_world_body(block.group(2), inner))
            i = close + 1
            continue

        end = cleaned.find(";", i)
        if end == -1:
            raise WitParseError(
                _labeled(
                    f"Unterminated statement: {cleaned[i:].strip()[:80]!r}", source_label
                ),
                code="INPUT_TRUNCATED",
            )
        statement = " ".join(cleaned[i:end].split())
        i = end + 1
        if not statement:
            continue
        use = _parse_use(statement)
        if use:
            top_uses.append(use)
            continue
        raise WitParseError(
            _labeled(
                f"Invalid top-level statement near line {_line_of(cleaned, i)}: {statement!r}",
                source_label,
            )
        )

    if not interfaces and not worlds:
        raise WitParseError(
            _labeled(
                "WIT document declares no interfaces or worlds — nothing to import",
                source_label,
            ),
            code="INPUT_SEMANTIC_INVALID",
        )

    return WitDocument(
        package=package,
        version=version,
        interfaces=tuple(interfaces),
        worlds=tuple(worlds),
        top_uses=tuple(top_uses),
        raw=content,
        source_files=(source_label,) if source_label else (),
        extra_package_blocks=extra_package_blocks,
    )


def parse_wit_package(
    members: Dict[str, str], *, source_label: Optional[str] = None
) -> WitDocument:
    """Parse and merge a multi-file WIT package (IXH-7.9 fileset intake).

    Every ``.wit`` member is parsed with :func:`parse_wit` and the results are
    merged into one :class:`WitDocument` — the same-package merge the WIT tooling
    performs for a package directory — so ``use`` statements can resolve against
    interfaces defined in sibling files.

    Args:
        members: Mapping of member path → member text. Non-``.wit`` members are
            ignored (a package directory may carry a README).
        source_label: Optional label for error messages.

    Returns:
        The merged document. ``raw`` concatenates the members in sorted-path
        order with file banners, so the preserved source stays reproducible.

    Raises:
        WitParseError: When no member parses, or two members declare different
            packages (``INPUT_SEMANTIC_INVALID``).
    """
    wit_members = {
        path: text for path, text in members.items() if path.lower().endswith(".wit")
    } or dict(members)
    if not wit_members:
        raise WitParseError(
            _labeled("WIT package fileset has no members", source_label),
            code="INPUT_MALFORMED",
        )

    package: Optional[str] = None
    version: Optional[str] = None
    interfaces: List[WitInterface] = []
    worlds: List[WitWorld] = []
    top_uses: List[WitUse] = []
    extra_package_blocks = 0
    raw_parts: List[str] = []
    files: List[str] = []

    for path in sorted(wit_members):
        doc = parse_wit(wit_members[path], source_label=path)
        if doc.package is not None:
            if package is not None and package != doc.package:
                raise WitParseError(
                    _labeled(
                        f"Fileset members declare different packages: {package!r} "
                        f"({files[0] if files else '?'}) vs {doc.package!r} ({path})",
                        source_label,
                    ),
                    code="INPUT_SEMANTIC_INVALID",
                )
            package = doc.package
            version = version or doc.version
        interfaces.extend(doc.interfaces)
        worlds.extend(doc.worlds)
        top_uses.extend(doc.top_uses)
        extra_package_blocks += doc.extra_package_blocks
        raw_parts.append(f"// file: {path}\n{wit_members[path]}")
        files.append(path)

    return WitDocument(
        package=package,
        version=version,
        interfaces=tuple(interfaces),
        worlds=tuple(worlds),
        top_uses=tuple(top_uses),
        raw="\n\n".join(raw_parts),
        source_files=tuple(files),
        extra_package_blocks=extra_package_blocks,
    )
