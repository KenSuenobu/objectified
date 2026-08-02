"""Bundle file graph — IXH-3.5 (#5107).

MFI-29.1 / 29.2 made a single import *dozens of files*: an uploaded ``.zip``, a git
selection, a proto tree. What they do not produce is an account of that bundle. When a
multi-file gRPC import fails, the user is told the compile failed — not which file
failed, which files were never read, which import could not be resolved, or why the
entrypoint the detector picked is the wrong one.

This module is the pure half of the answer. It takes the members a bundle unpacked to
and derives, with no I/O, no clock, and no adapter invocation:

* **import/include edges** — the ``import "x.proto";`` / ``include`` / ``$ref`` /
  ``schemaLocation`` directives each member declares, extracted by a small per-suffix
  rule table (:data:`DIRECTIVE_RULES`);
* **their resolution** — each edge resolved against the bundle, recording *every search
  path that was tried, in order*, so an unresolved import can state what was looked for
  rather than only that it failed. An import the format's toolchain provides itself
  (protobuf well-known types, Cap'n Proto's builtins) resolves to ``provided`` and is
  never reported as missing;
* **per-file roles** — entry point, dependency (transitively reachable from the entry
  point through resolved edges), unreferenced, unreadable;
* **entity attribution** — which canonical entities each file appears to contribute.

**Attribution is a declaration scan, and says so.** No adapter records, per canonical
entity, the member file that produced it — the canonical model has no such field, and
inventing one across 36 adapters is not this ticket. So attribution matches the
canonical entity's name against the *declarations* each file makes (``message Foo``,
``type Query``, a mapping key ``Foo:``). That is evidence, not provenance: it can miss
an entity whose canonical name is synthesized, and it can attribute one name declared
in two files to both. Every surface that renders it therefore carries
:data:`ATTRIBUTION_METHOD` so the user knows which it is — the same never-overclaim
rule the coverage ledger follows.

**Bounded.** Every scan is capped (:data:`MAX_DIRECTIVES_PER_FILE`,
:data:`MAX_DECLARED_SYMBOLS_PER_FILE`, :data:`MAX_SCANNED_BYTES_PER_FILE`) so a bundle
of a few hundred files costs a bounded, linear pass over its text.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Iterable, List, Mapping, Optional, Pattern, Sequence, Set, Tuple

from .intake_paths import is_binary_suffix

__all__ = [
    "ATTRIBUTION_METHOD",
    "BundleFileRole",
    "BundleFileVerdict",
    "DirectiveRule",
    "DIRECTIVE_RULES",
    "EntityRef",
    "ImportResolution",
    "MAX_DECLARED_SYMBOLS_PER_FILE",
    "MAX_DIRECTIVES_PER_FILE",
    "MAX_ENTITY_KEYS_PER_FILE",
    "MAX_SCANNED_BYTES_PER_FILE",
    "RawDirective",
    "ResolvedImport",
    "attribute_entities",
    "classify_roles",
    "declared_symbols",
    "diagnostics_by_member",
    "extract_directives",
    "reachable_from",
    "resolve_bundle_imports",
    "unreadable_reason",
]

#: How per-file entity contribution is derived. Rendered verbatim by every surface that
#: shows attribution, so the evidence quality is never implied to be parser provenance.
ATTRIBUTION_METHOD = "declaration-scan"

#: Per-file scan bounds. A member is already capped by the archive policy's per-file
#: byte ceiling; these keep the *derived* structures bounded too, so one pathological
#: file cannot dominate the inventory.
MAX_SCANNED_BYTES_PER_FILE = 1_000_000
MAX_DIRECTIVES_PER_FILE = 500
MAX_DECLARED_SYMBOLS_PER_FILE = 4000

#: Entity keys listed per file. The *count* a file reports is always exact; only the
#: enumerated keys are capped (the entity explorer is where the full tree lives).
MAX_ENTITY_KEYS_PER_FILE = 100


class BundleFileRole(str, Enum):
    """What one file *is* within the bundle.

    ``ENTRY_POINT``
        The root document the import parses from — detected, or pinned by the caller.
    ``DEPENDENCY``
        Reachable from the entry point through resolved import/include edges.
    ``UNREFERENCED``
        Readable, but neither the entry point nor reachable from it. Not an error:
        several adapters (gRPC among them) compile *every* member of their format, so
        an unreferenced file may still contribute. It is reported because "nothing
        points at this" is the fact behind most "why is my type missing?" questions.
    ``IGNORED``
        Excluded before it ever became a member (resource fork, VCS metadata, dotfile).
        Always carries the reason it was excluded.
    ``UNREADABLE``
        Decoded but not text — a binary member, or one whose bytes are not UTF-8.
    """

    ENTRY_POINT = "entry-point"
    DEPENDENCY = "dependency"
    UNREFERENCED = "unreferenced"
    IGNORED = "ignored"
    UNREADABLE = "unreadable"


class BundleFileVerdict(str, Enum):
    """What happened to one file when the bundle was analysed.

    ``ANALYSED``
        The file was read and its import/include directives extracted.
    ``FAILED``
        The parse of this bundle reported a diagnostic naming this file. The file's
        ``error`` carries the diagnostic verbatim.
    ``NOT_ANALYSED``
        Never read — an ignored or unreadable member.
    """

    ANALYSED = "analysed"
    FAILED = "failed"
    NOT_ANALYSED = "not-analysed"


class ImportResolution(str, Enum):
    """How one declared import/include edge resolved.

    ``MEMBER``
        Resolved to another member of this bundle.
    ``PROVIDED``
        Not in the bundle, and not missing: the format's own toolchain supplies it
        (protobuf well-known types, Cap'n Proto builtins).
    ``UNRESOLVED``
        Nothing was found. The edge carries every search path that was tried.
    """

    MEMBER = "member"
    PROVIDED = "provided"
    UNRESOLVED = "unresolved"


@dataclass(frozen=True)
class DirectiveRule:
    """One import/include syntax a file suffix can declare.

    Attributes:
        directive: The directive's user-facing name (``import``, ``$ref``, …).
        pattern: Compiled regex with a ``target`` group holding the referenced path.
    """

    directive: str
    pattern: Pattern[str]


@dataclass(frozen=True)
class RawDirective:
    """One import/include directive as written, before resolution."""

    directive: str
    target: str
    line: int


@dataclass(frozen=True)
class ResolvedImport:
    """One import/include edge, resolved against the bundle.

    Attributes:
        from_path: The member that declares the directive.
        directive: Directive name (``import``, ``include``, ``$ref``, …).
        target: The reference exactly as the source wrote it.
        to_path: The member it resolved to, or ``None``.
        resolution: :class:`ImportResolution` verdict.
        provider: What supplies a ``provided`` import (e.g. the protobuf well-known
            types); ``None`` otherwise.
        search_paths: Every bundle-relative path tried, in the order tried. Non-empty
            for an unresolved edge — it is the answer to "where did you look?".
        line: 1-based line of the directive in ``from_path``.
    """

    from_path: str
    directive: str
    target: str
    to_path: Optional[str]
    resolution: ImportResolution
    provider: Optional[str]
    search_paths: Tuple[str, ...]
    line: int


@dataclass(frozen=True)
class EntityRef:
    """The identity of one canonical entity, as attribution needs to see it.

    Attributes:
        key: The entity's stable canonical key (what the manifest indexes it by).
        name: Its canonical display name.
        native_name: Its name in the source document, when the adapter recorded one.
    """

    key: str
    name: str
    native_name: Optional[str] = None


@dataclass
class _Attribution:
    """Mutable per-file attribution tally (internal to :func:`attribute_entities`)."""

    keys: List[str] = field(default_factory=list)
    count: int = 0


# ===========================================================================
# Directive extraction
# ===========================================================================

_PROTO_IMPORT = DirectiveRule(
    "import",
    re.compile(r'^[ \t]*import[ \t]+(?:public[ \t]+|weak[ \t]+)?"(?P<target>[^"\n]+)"', re.MULTILINE),
)
_THRIFT_INCLUDE = DirectiveRule(
    "include",
    re.compile(r'^[ \t]*(?:cpp_)?include[ \t]+"(?P<target>[^"\n]+)"', re.MULTILINE),
)
_FLATBUFFERS_INCLUDE = DirectiveRule(
    "include", re.compile(r'^[ \t]*include[ \t]+"(?P<target>[^"\n]+)"', re.MULTILINE)
)
_CAPNP_IMPORT = DirectiveRule(
    "import", re.compile(r'\bimport[ \t]+"(?P<target>[^"\n]+)"', re.MULTILINE)
)
_TYPESPEC_IMPORT = DirectiveRule(
    "import", re.compile(r'^[ \t]*import[ \t]+"(?P<target>[^"\n]+)"', re.MULTILINE)
)
_GRAPHQL_IMPORT = DirectiveRule(
    "# import",
    re.compile(
        r'^[ \t]*#[ \t]*import[ \t]+(?:.+?[ \t]+from[ \t]+)?["\'](?P<target>[^"\'\n]+)["\']',
        re.MULTILINE,
    ),
)
_RAML_INCLUDE = DirectiveRule(
    "!include", re.compile(r"!include[ \t]+(?P<target>[^\s]+)", re.MULTILINE)
)
_AVRO_IDL_IMPORT = DirectiveRule(
    "import",
    re.compile(r'^[ \t]*import[ \t]+(?:idl|schema|protocol)[ \t]+"(?P<target>[^"\n]+)"', re.MULTILINE),
)
_JSON_REF = DirectiveRule(
    "$ref",
    re.compile(r'["\']?\$ref["\']?[ \t]*:[ \t]*["\'](?P<target>[^"\'\n]+)["\']', re.MULTILINE),
)
_YAML_BARE_REF = DirectiveRule(
    "$ref",
    re.compile(r'^[ \t]*\$ref[ \t]*:[ \t]*(?P<target>[^"\'\s][^\s]*)[ \t]*$', re.MULTILINE),
)
_XML_SCHEMA_LOCATION = DirectiveRule(
    "schemaLocation", re.compile(r'\bschemaLocation[ \t]*=[ \t]*"(?P<target>[^"\n]+)"')
)
_XML_LOCATION = DirectiveRule(
    "location", re.compile(r'\blocation[ \t]*=[ \t]*"(?P<target>[^"\n]+)"')
)
_XML_REFERENCE_URI = DirectiveRule(
    "Uri", re.compile(r'<[\w:]*Reference\b[^>]*\bUri[ \t]*=[ \t]*"(?P<target>[^"\n]+)"')
)

_MAPPING_RULES: Tuple[DirectiveRule, ...] = (_JSON_REF, _YAML_BARE_REF)
_XML_RULES: Tuple[DirectiveRule, ...] = (
    _XML_SCHEMA_LOCATION,
    _XML_LOCATION,
    _XML_REFERENCE_URI,
)

#: Import/include syntaxes by file suffix. A suffix absent from this table declares no
#: file-level references we can read, so its members simply have no outgoing edges —
#: which is reported as "no imports", never as "no imports found, probably".
DIRECTIVE_RULES: Mapping[str, Tuple[DirectiveRule, ...]] = {
    ".proto": (_PROTO_IMPORT,),
    ".thrift": (_THRIFT_INCLUDE,),
    ".fbs": (_FLATBUFFERS_INCLUDE,),
    ".capnp": (_CAPNP_IMPORT,),
    ".tsp": (_TYPESPEC_IMPORT,),
    ".graphql": (_GRAPHQL_IMPORT,),
    ".gql": (_GRAPHQL_IMPORT,),
    ".raml": (_RAML_INCLUDE,),
    ".avdl": (_AVRO_IDL_IMPORT,),
    ".json": _MAPPING_RULES,
    ".yaml": _MAPPING_RULES,
    ".yml": _MAPPING_RULES,
    ".xsd": _XML_RULES,
    ".wsdl": _XML_RULES,
    ".xml": _XML_RULES,
    ".edmx": _XML_RULES,
}

#: References a format's own toolchain supplies, keyed by suffix: ``(prefix, provider)``.
#: Every proto bundle imports ``google/protobuf/timestamp.proto`` and no bundle ships
#: it, so without this table the explorer would report a missing import on almost every
#: healthy gRPC import — the exact false alarm that trains users to ignore the panel.
_PROVIDED_PREFIXES: Mapping[str, Tuple[Tuple[str, str], ...]] = {
    ".proto": (
        ("google/protobuf/", "protobuf well-known types"),
        ("google/api/", "googleapis common protos"),
        ("google/rpc/", "googleapis common protos"),
        ("google/type/", "googleapis common protos"),
        ("buf/validate/", "buf validate module"),
        ("validate/", "protoc-gen-validate module"),
    ),
    ".capnp": (("capnp/", "Cap'n Proto builtins"),),
    ".tsp": (("@typespec/", "TypeSpec libraries"),),
}


def _suffix(path: str) -> str:
    """Return the lower-cased final extension of *path* (``""`` when it has none)."""
    base = path.rsplit("/", 1)[-1]
    dot = base.rfind(".")
    return base[dot:].lower() if dot > 0 else ""


def extract_directives(path: str, text: str) -> List[RawDirective]:
    """Extract every import/include directive one member declares.

    Args:
        path: The member's bundle-relative path (its suffix selects the rule set).
        text: The member's decoded text.

    Returns:
        The directives in source order, de-duplicated by ``(directive, target)`` and
        capped at :data:`MAX_DIRECTIVES_PER_FILE`.
    """
    rules = DIRECTIVE_RULES.get(_suffix(path))
    if not rules:
        return []
    body = text[:MAX_SCANNED_BYTES_PER_FILE]
    found: List[RawDirective] = []
    seen: Set[Tuple[str, str]] = set()
    for rule in rules:
        for match in rule.pattern.finditer(body):
            target = (match.group("target") or "").strip()
            if not target:
                continue
            identity = (rule.directive, target)
            if identity in seen:
                continue
            seen.add(identity)
            found.append(
                RawDirective(
                    directive=rule.directive,
                    target=target,
                    line=body.count("\n", 0, match.start()) + 1,
                )
            )
    found.sort(key=lambda directive: (directive.line, directive.target))
    return found[:MAX_DIRECTIVES_PER_FILE]


# ===========================================================================
# Resolution
# ===========================================================================


def _collapse(path: str) -> Optional[str]:
    """Collapse ``.``/``..`` segments, or return ``None`` when the path escapes the root."""
    parts: List[str] = []
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
            continue
        parts.append(part)
    return "/".join(parts) or None


def _directory_of(path: str) -> str:
    """Return the directory component of *path* (``""`` for a top-level member)."""
    return path.rsplit("/", 1)[0] if "/" in path else ""


def _reference_body(target: str) -> Optional[str]:
    """Normalise a reference to a bundle-relative path, or ``None`` when it is not one.

    A pure JSON-Pointer fragment (``#/components/schemas/Pet``) points inside the same
    document, and an absolute URL is the remote-``$ref`` resolver's business (MFI-29.4),
    not the bundle's — neither is a bundle edge, so neither is reported as one.
    """
    raw = target.replace("\\", "/").strip()
    raw = raw.split("#", 1)[0].strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered.startswith("//") or "://" in lowered or lowered.startswith("urn:"):
        return None
    return raw


def _provided_by(path: str, reference: str) -> Optional[str]:
    """Return the toolchain that supplies *reference*, or ``None`` when nothing does."""
    for prefix, provider in _PROVIDED_PREFIXES.get(_suffix(path), ()):
        if reference.lstrip("/").startswith(prefix):
            return provider
    return None


def _include_roots(path: str) -> List[str]:
    """Every directory that could be an include root for *path*, deepest first.

    ``proto/user/user_service.proto`` yields ``["proto/user", "proto", ""]``. This is
    what makes a protobuf bundle resolve: ``import "user/types.proto"`` is written
    against the compiler's **include root**, not against the importing file's
    directory, and the include root is whichever ancestor makes the reference land on
    a real file. Trying them deepest-first prefers the most local interpretation, and
    the tried list is exactly what an unresolved edge reports.
    """
    roots: List[str] = []
    current = _directory_of(path)
    while True:
        roots.append(current)
        if not current:
            return roots
        current = _directory_of(current) if "/" in current else ""


def _search_paths(from_path: str, reference: str, entry_point: Optional[str]) -> List[str]:
    """Build the ordered, de-duplicated list of member paths to try for *reference*.

    The order follows how multi-file toolchains actually resolve: the referring file's
    own directory, then each ancestor up to the bundle root (the include-root walk,
    see :func:`_include_roots`), then the entry point's own directories — a bundle
    whose entry point lives beside a shared ``common/`` tree resolves that way.

    Args:
        from_path: The member declaring the reference.
        reference: The normalised reference body (no fragment, no scheme).
        entry_point: The bundle's entry point, when one was resolved.

    Returns:
        Candidate member paths, in the order they are tried. Candidates that would
        escape the bundle root are dropped rather than tried.
    """
    bases = _include_roots(from_path)
    if entry_point and entry_point != from_path:
        bases.extend(_include_roots(entry_point))
    candidates: List[str] = []
    for base in bases:
        joined = f"{base}/{reference}" if base else reference
        collapsed = _collapse(joined)
        if collapsed and collapsed not in candidates:
            candidates.append(collapsed)
    return candidates


def resolve_bundle_imports(
    members: Mapping[str, str],
    *,
    entry_point: Optional[str] = None,
    readable: Optional[Iterable[str]] = None,
) -> List[ResolvedImport]:
    """Resolve every import/include edge the bundle's members declare.

    Args:
        members: Member text keyed by bundle-relative path.
        entry_point: The resolved root document, when there is one. Only used to add
            its directory to the search path.
        readable: Members worth scanning; defaults to every member. Unreadable members
            (binaries) are excluded by the caller so their bytes are never regex-scanned.

    Returns:
        Every edge, sorted by ``(from_path, line, target)`` — deterministic for a fixed
        bundle, which the inventory's stable paging depends on.
    """
    scanned = sorted(readable) if readable is not None else sorted(members)
    edges: List[ResolvedImport] = []
    for path in scanned:
        text = members.get(path)
        if text is None:
            continue
        for directive in extract_directives(path, text):
            reference = _reference_body(directive.target)
            if reference is None:
                continue
            search_paths = _search_paths(path, reference, entry_point)
            hit = next((candidate for candidate in search_paths if candidate in members), None)
            if hit is not None:
                resolution, to_path, provider = ImportResolution.MEMBER, hit, None
            else:
                provider = _provided_by(path, reference)
                if provider is not None:
                    resolution, to_path = ImportResolution.PROVIDED, None
                else:
                    resolution, to_path = ImportResolution.UNRESOLVED, None
            edges.append(
                ResolvedImport(
                    from_path=path,
                    directive=directive.directive,
                    target=directive.target,
                    to_path=to_path,
                    resolution=resolution,
                    provider=provider,
                    search_paths=tuple(search_paths),
                    line=directive.line,
                )
            )
    edges.sort(key=lambda edge: (edge.from_path, edge.line, edge.target))
    return edges


def reachable_from(entry_point: str, edges: Sequence[ResolvedImport]) -> Set[str]:
    """Return every member transitively reachable from *entry_point* (it excluded).

    Args:
        entry_point: The root member to walk from.
        edges: Resolved edges; only ``member`` resolutions are traversed.

    Returns:
        The reachable member paths. Cycles terminate — a visited member is never
        re-expanded — so a mutually-importing pair is walked once.
    """
    outgoing: Dict[str, List[str]] = {}
    for edge in edges:
        if edge.resolution is ImportResolution.MEMBER and edge.to_path:
            outgoing.setdefault(edge.from_path, []).append(edge.to_path)
    seen: Set[str] = set()
    queue = deque(outgoing.get(entry_point, ()))
    while queue:
        current = queue.popleft()
        if current in seen or current == entry_point:
            continue
        seen.add(current)
        queue.extend(outgoing.get(current, ()))
    return seen


# ===========================================================================
# Roles
# ===========================================================================


def unreadable_reason(path: str, text: str) -> Optional[str]:
    """Return why *path* is not readable text, or ``None`` when it is.

    Archive unpack decodes members with ``errors="replace"``, so a binary member
    arrives as text full of U+FFFD rather than as a failure. Both signals are checked:
    a known-binary extension, and actual replacement characters.

    Args:
        path: The member's bundle-relative path.
        text: Its decoded text.

    Returns:
        A user-facing sentence, or ``None`` when the member is usable text.
    """
    if is_binary_suffix(path):
        return "Binary file type — not specification text, so it was not analysed."
    replacements = text.count("�")
    if replacements:
        return (
            f"Not valid UTF-8 text ({replacements} byte sequence"
            f"{'s' if replacements != 1 else ''} could not be decoded), so it was not analysed."
        )
    return None


def classify_roles(
    members: Mapping[str, str],
    *,
    entry_point: Optional[str],
    edges: Sequence[ResolvedImport],
    unreadable: Iterable[str] = (),
) -> Dict[str, BundleFileRole]:
    """Assign every member its role within the bundle.

    Args:
        members: Member text keyed by bundle-relative path.
        entry_point: The resolved root document, or ``None`` when resolution failed.
        edges: The resolved import/include edges.
        unreadable: Members already judged unreadable by :func:`unreadable_reason`.

    Returns:
        One :class:`BundleFileRole` per member. With no entry point every readable
        member is ``unreferenced``: without a root there is nothing to be a dependency
        *of*, and claiming otherwise would be a guess.
    """
    unreadable_set = set(unreadable)
    reachable = reachable_from(entry_point, edges) if entry_point else set()
    roles: Dict[str, BundleFileRole] = {}
    for path in members:
        if path in unreadable_set:
            roles[path] = BundleFileRole.UNREADABLE
        elif entry_point is not None and path == entry_point:
            roles[path] = BundleFileRole.ENTRY_POINT
        elif path in reachable:
            roles[path] = BundleFileRole.DEPENDENCY
        else:
            roles[path] = BundleFileRole.UNREFERENCED
    return roles


# ===========================================================================
# Entity attribution (declaration scan)
# ===========================================================================

#: Members of a schema language's *types* — the fields and methods that become canonical
#: operations. Kept separate from the type-level patterns because they are indented
#: bodies, not top-level statements: a gRPC ``rpc`` and a GraphQL field are exactly the
#: entities a per-file contribution view is asked about most.
_GRAPHQL_TYPE_DECL = re.compile(
    r"^[ \t]*(?:extend[ \t]+)?(?:type|interface|enum|input|union|scalar)[ \t]+(?P<name>\w+)",
    re.MULTILINE,
)
_GRAPHQL_FIELD_DECL = re.compile(r"^[ \t]+(?P<name>\w+)[ \t]*[(:]", re.MULTILINE)

_DECLARATION_PATTERNS: Mapping[str, Tuple[Pattern[str], ...]] = {
    ".proto": (
        re.compile(r"^[ \t]*(?:service|message|enum|extend)[ \t]+(?P<name>\w+)", re.MULTILINE),
        re.compile(r"\brpc[ \t]+(?P<name>\w+)[ \t]*\(", re.MULTILINE),
    ),
    ".graphql": (_GRAPHQL_TYPE_DECL, _GRAPHQL_FIELD_DECL),
    ".gql": (_GRAPHQL_TYPE_DECL, _GRAPHQL_FIELD_DECL),
    ".thrift": (
        re.compile(
            r"^[ \t]*(?:service|struct|union|exception|enum|senum)[ \t]+(?P<name>\w+)",
            re.MULTILINE,
        ),
    ),
    ".capnp": (
        re.compile(r"^[ \t]*(?:struct|interface|enum|const)[ \t]+(?P<name>\w+)", re.MULTILINE),
    ),
    ".fbs": (
        re.compile(
            r"^[ \t]*(?:table|struct|enum|union|rpc_service)[ \t]+(?P<name>\w+)", re.MULTILINE
        ),
    ),
    ".tsp": (
        re.compile(
            r"^[ \t]*(?:model|interface|op|enum|union|namespace|scalar)[ \t]+(?P<name>\w+)",
            re.MULTILINE,
        ),
    ),
    ".smithy": (
        re.compile(
            r"^[ \t]*(?:service|operation|structure|union|enum|intEnum|resource|list|map)"
            r"[ \t]+(?P<name>\w+)",
            re.MULTILINE,
        ),
    ),
    ".avdl": (
        re.compile(r"^[ \t]*(?:protocol|record|enum|fixed|error)[ \t]+(?P<name>\w+)", re.MULTILINE),
    ),
}

#: Mapping-document suffixes, whose declarations are keys rather than keyword statements.
_MAPPING_SUFFIXES: Tuple[str, ...] = (".json", ".yaml", ".yml", ".raml")

_MAPPING_KEY = re.compile(r'^[ \t"\'-]*(?P<name>[^"\':\n#][^"\':\n]*?)["\']?[ \t]*:', re.MULTILINE)
_OPERATION_ID = re.compile(r'\boperationId["\']?[ \t]*:[ \t]*["\']?(?P<name>[\w.\-]+)')
_XML_NAME = re.compile(r'\bname[ \t]*=[ \t]*"(?P<name>[^"\n]+)"')
_XML_SUFFIXES: Tuple[str, ...] = (".xsd", ".wsdl", ".xml", ".edmx")


def declared_symbols(path: str, text: str) -> Set[str]:
    """Return the names *path* appears to declare.

    Three scans, selected by suffix: keyword declarations for schema languages
    (``message Foo``, plus their members — a proto ``rpc`` and a GraphQL field are
    canonical operations), mapping keys plus ``operationId`` values for JSON/YAML
    documents, and ``name="…"`` attributes for XML ones. A suffix matching none of
    them declares nothing, which is reported as an empty set rather than guessed at.

    Args:
        path: The member's bundle-relative path.
        text: Its decoded text.

    Returns:
        Declared names, capped at :data:`MAX_DECLARED_SYMBOLS_PER_FILE`.
    """
    body = text[:MAX_SCANNED_BYTES_PER_FILE]
    suffix = _suffix(path)
    names: Set[str] = set()

    def _collect(pattern: Pattern[str]) -> None:
        for match in pattern.finditer(body):
            if len(names) >= MAX_DECLARED_SYMBOLS_PER_FILE:
                return
            name = (match.group("name") or "").strip()
            if name:
                names.add(name)

    declarations = _DECLARATION_PATTERNS.get(suffix)
    if declarations is not None:
        for pattern in declarations:
            _collect(pattern)
    elif suffix in _MAPPING_SUFFIXES:
        _collect(_MAPPING_KEY)
        _collect(_OPERATION_ID)
    elif suffix in _XML_SUFFIXES:
        _collect(_XML_NAME)
    return names


def _entity_tokens(entity: EntityRef) -> Set[str]:
    """The names a file could plausibly declare for *entity*.

    Canonical keys are qualified (``pkg.Service#Rpc``) while a file declares the bare
    name, so the tokens are the canonical name, the native name, the key, and the
    trailing segment of each after the qualifier separators.
    """
    tokens: Set[str] = set()
    for candidate in (entity.name, entity.native_name, entity.key):
        value = (candidate or "").strip()
        if not value:
            continue
        tokens.add(value)
        for separator in (".", "/", "#", ":"):
            if separator in value:
                tail = value.rsplit(separator, 1)[-1].strip()
                if tail:
                    tokens.add(tail)
    return tokens


def attribute_entities(
    members: Mapping[str, str],
    entities: Sequence[EntityRef],
    *,
    readable: Optional[Iterable[str]] = None,
) -> Tuple[Dict[str, List[str]], Dict[str, int], List[str]]:
    """Attribute canonical entities to the files that appear to declare them.

    This is the :data:`ATTRIBUTION_METHOD` scan described in the module docstring —
    evidence from each file's declarations, not provenance recorded by the parser.

    Args:
        members: Member text keyed by bundle-relative path.
        entities: The canonical entities the import would create.
        readable: Members worth scanning; defaults to every member.

    Returns:
        ``(keys_by_path, count_by_path, unattributed)`` — the (capped) entity keys per
        file, the *exact* count per file, and the keys no file declared.
    """
    scanned = sorted(readable) if readable is not None else sorted(members)
    declared = {
        path: declared_symbols(path, members[path]) for path in scanned if path in members
    }
    tallies: Dict[str, _Attribution] = {path: _Attribution() for path in declared}
    unattributed: List[str] = []
    for entity in entities:
        tokens = _entity_tokens(entity)
        if not tokens:
            unattributed.append(entity.key)
            continue
        matched = False
        for path, names in declared.items():
            if names & tokens:
                matched = True
                tally = tallies[path]
                tally.count += 1
                if len(tally.keys) < MAX_ENTITY_KEYS_PER_FILE:
                    tally.keys.append(entity.key)
        if not matched:
            unattributed.append(entity.key)
    keys_by_path = {path: tally.keys for path, tally in tallies.items() if tally.keys}
    count_by_path = {path: tally.count for path, tally in tallies.items() if tally.count}
    return keys_by_path, count_by_path, unattributed


# ===========================================================================
# Diagnostics
# ===========================================================================

#: ``path/to/file.ext:12:3:`` style locations inside a compiler diagnostic.
_DIAGNOSTIC_LOCATION = re.compile(r"(?P<path>[\w./@+\-]+\.[A-Za-z0-9]+)(?::\d+){0,2}")


def diagnostics_by_member(message: str, members: Mapping[str, str]) -> Dict[str, str]:
    """Attach a parse diagnostic to the bundle members it names.

    ``buf build`` and friends report faults as ``user/user.proto:5:1: syntax error``.
    A bundle whose import failed therefore already knows *which file* failed — the
    information is simply buried in one string. This lifts it back out so the failing
    file is marked in the inventory instead of the failure being attributed to the
    whole upload.

    Args:
        message: The parse error message (possibly multi-line).
        members: Member text keyed by bundle-relative path.

    Returns:
        Member path → the diagnostic line naming it. A member named on several lines
        keeps the first, so the mapping is deterministic. A bare basename is only
        matched when exactly one member carries it — two ``types.proto`` in different
        directories are ambiguous, and blaming one of them at random is worse than
        leaving the diagnostic on the bundle.
    """
    if not message:
        return {}
    basename_counts: Dict[str, int] = {}
    by_basename: Dict[str, str] = {}
    for path in sorted(members):
        base = path.rsplit("/", 1)[-1]
        basename_counts[base] = basename_counts.get(base, 0) + 1
        by_basename.setdefault(base, path)
    attached: Dict[str, str] = {}
    for line in message.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        for match in _DIAGNOSTIC_LOCATION.finditer(stripped):
            named = match.group("path").lstrip("./")
            if named in members:
                target: Optional[str] = named
            else:
                base = named.rsplit("/", 1)[-1]
                target = by_basename.get(base) if basename_counts.get(base) == 1 else None
            if target is not None and target not in attached:
                attached[target] = stripped
    return attached
