"""Static MCP server manifest parser — FMT-1.7 (#5418).

MCP has been a first-class catalog domain since MCAT-1.x, but it could only ever be
reached by *probing*: open a transport, run the ``initialize`` handshake, page through
``tools/list`` / ``resources/list`` / ``resources/templates/list`` / ``prompts/list``,
then normalize what came back. An operator holding a **server manifest** — a server that
is offline, air-gapped, or simply not reachable from Apiome — had no path into the
catalog at all.

This module reads that manifest. A manifest is the paginated discovery result flattened
into one JSON document: the server's identity, its declared ``capabilities``, and the four
capability arrays with their JSON Schemas, plus an optional ``transport`` block recording
how the same server would be reached live.

Why this produces a :class:`~app.mcp_client.normalize.DiscoverySurface`
----------------------------------------------------------------------
The acceptance criterion is that *a manifest and a live probe of the same server produce
identical surface fingerprints*. The only way to guarantee that is to stop short of
building a second surface model: :func:`manifest_surface` hands the manifest's verbatim
wire entries to the very same :class:`~app.mcp_client.normalize.CapabilityItem`
constructors discovery uses, and returns the very same ``DiscoverySurface``. The
fingerprint is therefore not *re-implemented compatibly* — it is the same code over the
same inputs, so the two paths cannot drift.

That contract is what fixes the two normalization rules below.

**Rule 1 — the marker fields are aliases, not new fields.** A manifest may spell the
protocol version ``mcpVersion`` or ``protocolVersion``, and may carry ``instructions``
at the top level or inside ``server``. Both spellings land on the same surface field a
probe would fill, because a probe has only one spelling for each.

**Rule 2 — shared ``$defs`` are inlined.** A live server returns each tool's
``inputSchema`` self-contained; nothing on the wire carries a document-level ``$defs``
block for a client to resolve against. A manifest is a *document*, so it is allowed to
factor shared schemas out — into a top-level ``$defs`` map, or into a sibling file in a
fileset — and this parser resolves those references back into the schemas that use them
before the surface is built. A manifest that factors its schemas out and a probe of the
same server therefore fingerprint identically. Definitions nothing references are
authoring sugar and are dropped; a reference that cannot be resolved, recurses, or nests
past :data:`MAX_REF_DEPTH` is an error rather than a silently half-resolved schema.

Everything else is passed through **verbatim** — vendor keys, ``annotations``, ``_meta``,
a resource's ``size`` hint — because the surface keeps the raw wire entry per item and
the fingerprint projection is what decides which of those fields are semantic.

JSON only, deliberately
-----------------------
MCP is a JSON-RPC protocol and a manifest is its payload written down, so this parser
does **not** fall back to YAML. That is not pedantry: YAML accepts a trailing comma in a
flow mapping, so a YAML fallback would silently accept a JSON document that no MCP client
could read, and the corpus's ``negative/01-syntactic-trailing-comma.json`` would import
cleanly instead of being rejected. YAML is still *parsed* on the failure path — but only
to tell a document that is a different format (an OpenAPI file handed to the wrong
importer) apart from one that is genuinely broken JSON.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

from .intake_resource_guard import IntakeLimitError, guard_document_text, guard_parsed_document
from .mcp_client.discovery import DiscoveryListings
from .mcp_client.handshake import InitializeResult, ServerInfo
from .mcp_client.normalize import DiscoverySurface

__all__ = [
    "MANIFEST_VERSION_KEYS",
    "MAX_REF_DEPTH",
    "McpManifestDocument",
    "McpManifestParseError",
    "McpManifestTransport",
    "dumps_manifest_for_raw",
    "is_mcp_manifest",
    "is_mcp_manifest_document",
    "manifest_surface",
    "parse_mcp_manifest",
    "parse_mcp_manifest_fileset",
]


#: The two accepted spellings of the manifest's protocol-version marker. ``mcpVersion``
#: is the document-level spelling the corpus uses; ``protocolVersion`` is the wire
#: spelling an operator who copied an ``initialize`` result will have.
MANIFEST_VERSION_KEYS: Tuple[str, ...] = ("mcpVersion", "protocolVersion")

#: How deep ``$ref`` resolution may nest before the manifest is rejected. A shared
#: definition pointing at another shared definition is ordinary; sixty-four levels of it
#: is a resource-exhaustion shape, not a schema.
MAX_REF_DEPTH = 64

#: The four capability arrays, in the surface's canonical order, paired with the
#: :class:`~app.mcp_client.discovery.DiscoveryListings` attribute each fills.
_CAPABILITY_ARRAYS: Tuple[Tuple[str, str], ...] = (
    ("tools", "tools"),
    ("resources", "resources"),
    ("resourceTemplates", "resource_templates"),
    ("prompts", "prompts"),
)

#: Root keys that prove the document is a *different* API description handed to the wrong
#: importer, so the failure reads ``FORMAT_MISMATCH`` rather than "broken MCP manifest".
_FOREIGN_FORMAT_MARKERS: Tuple[str, ...] = (
    "openapi",
    "swagger",
    "asyncapi",
    "arazzo",
    "openrpc",
    "discoveryVersion",
)

#: Local ``$ref`` prefixes a manifest may factor shared schemas behind.
_LOCAL_DEF_PREFIXES: Tuple[str, ...] = ("#/$defs/", "#/definitions/")

#: Transport ``type`` values in a manifest, mapped onto the catalog's transport domain
#: (``apiome.mcp_endpoints.transport``). Spellings differ because the manifest uses the
#: MCP spec's hyphenated names and the catalog column uses snake_case.
_TRANSPORT_KINDS: Dict[str, str] = {
    "streamable-http": "streamable_http",
    "streamable_http": "streamable_http",
    "http": "streamable_http",
    "sse": "sse",
    "stdio": "stdio",
}


class McpManifestParseError(ValueError):
    """Raised when an MCP server manifest cannot be parsed.

    Attributes:
        code: The :mod:`app.intake_error_taxonomy` code classifying the failure, so the
            import pipeline reports *why* the manifest was rejected rather than a generic
            "malformed".
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class McpManifestTransport:
    """How the manifest says the same server would be reached live.

    Purely descriptive: nothing in this module connects to it. It is what lets a manifest
    import find the endpoint a probe already created instead of minting a duplicate
    (:mod:`app.mcp_manifest_attach`).

    Attributes:
        kind: The catalog transport (``streamable_http`` / ``sse`` / ``stdio``), or
            ``None`` when the manifest declared no usable ``transport`` block.
        url: The server URL, for an HTTP-family transport.
        command: The executable, for a ``stdio`` transport.
        args: The executable's arguments, for a ``stdio`` transport.
    """

    kind: Optional[str] = None
    url: Optional[str] = None
    command: Optional[str] = None
    args: Tuple[str, ...] = ()

    @classmethod
    def from_payload(cls, payload: Any) -> "McpManifestTransport":
        """Build a transport from a manifest ``transport`` block (or anything else).

        Args:
            payload: The raw ``transport`` value; a non-mapping yields an empty transport
                rather than an error, because a manifest is allowed to omit it entirely.

        Returns:
            The parsed :class:`McpManifestTransport`; every field is ``None``/empty when
            the block is absent or unusable.
        """
        if not isinstance(payload, Mapping):
            return cls()
        kind = _TRANSPORT_KINDS.get(str(payload.get("type") or "").strip().lower())
        args = payload.get("args")
        return cls(
            kind=kind,
            url=_optional_str(payload.get("url")),
            command=_optional_str(payload.get("command")),
            args=tuple(str(a) for a in args if isinstance(a, (str, int, float)))
            if isinstance(args, list)
            else (),
        )

    def endpoint_target(self) -> Optional[str]:
        """Return the catalog ``endpoint_url`` this transport designates, if any.

        An HTTP-family transport designates its URL. A ``stdio`` transport has no URL, so
        the catalog stores its command line — the same string the manual registration path
        stores for a stdio endpoint.

        Returns:
            The endpoint target string, or ``None`` when the manifest named no transport.
        """
        if self.kind in ("streamable_http", "sse"):
            return self.url
        if self.kind == "stdio":
            if not self.command:
                return None
            return " ".join((self.command, *self.args)).strip()
        return None


@dataclass(frozen=True)
class McpManifestDocument:
    """A parsed static MCP server manifest, ready for surface normalization.

    The capability arrays hold **verbatim wire entries** (with shared ``$ref``s already
    inlined per Rule 2 in the module docstring), exactly as a probe's
    :class:`~app.mcp_client.discovery.DiscoveryListings` would hold them, so
    :func:`manifest_surface` can hand them straight to the shared normalizer.

    Attributes:
        protocol_version: The declared MCP protocol version, or ``None``.
        server_info: Server identity, parsed by the same
            :class:`~app.mcp_client.handshake.ServerInfo` a handshake uses.
        instructions: Free-text usage guidance, from ``instructions`` at either level.
        capabilities: The declared capabilities object, verbatim.
        tools: ``tools/list`` entries.
        resources: ``resources/list`` entries.
        resource_templates: ``resources/templates/list`` entries.
        prompts: ``prompts/list`` entries.
        transport: How the same server would be reached live.
        title: Display title for the canonical model (server title, else name, else the
            source label's stem, else ``"mcp-server"``).
        raw: The manifest text exactly as supplied.
        source_label: Filename / URL / paste label, for error messages and the title.
    """

    protocol_version: Optional[str] = None
    server_info: ServerInfo = field(default_factory=ServerInfo)
    instructions: Optional[str] = None
    capabilities: Dict[str, Any] = field(default_factory=dict)
    tools: Tuple[Dict[str, Any], ...] = ()
    resources: Tuple[Dict[str, Any], ...] = ()
    resource_templates: Tuple[Dict[str, Any], ...] = ()
    prompts: Tuple[Dict[str, Any], ...] = ()
    transport: McpManifestTransport = field(default_factory=McpManifestTransport)
    title: str = "mcp-server"
    raw: str = ""
    source_label: Optional[str] = None

    def item_count(self) -> int:
        """Total number of declared capabilities across all four kinds."""
        return (
            len(self.tools)
            + len(self.resources)
            + len(self.resource_templates)
            + len(self.prompts)
        )


# ===========================================================================
# Detection
# ===========================================================================


def is_mcp_manifest_document(document: Any) -> bool:
    """Return ``True`` when a parsed value looks like a static MCP server manifest.

    The marker pair is a protocol-version key (:data:`MANIFEST_VERSION_KEYS`) beside at
    least one non-empty capability array. Requiring both keeps the sniff off a bare LLM
    tool bundle (which has ``tools`` but no version marker) and off an ``initialize``
    result pasted on its own (a version marker but no capability array).

    Args:
        document: Any already-parsed JSON value.

    Returns:
        ``True`` when the document carries the marker pair and no foreign-format key.
    """
    if not isinstance(document, Mapping):
        return False
    if any(marker in document for marker in _FOREIGN_FORMAT_MARKERS):
        return False
    if not any(_optional_str(document.get(key)) for key in MANIFEST_VERSION_KEYS):
        return False
    return any(
        isinstance(document.get(source_key), list) and document.get(source_key)
        for source_key, _ in _CAPABILITY_ARRAYS
    )


def is_mcp_manifest(content: str) -> bool:
    """Return ``True`` when ``content`` parses as a static MCP server manifest.

    Never raises: a document that is not JSON, breaches an intake limit, or carries NUL
    bytes simply does not match.

    Args:
        content: Raw document text.

    Returns:
        ``True`` when the text is JSON carrying the manifest marker pair.
    """
    if not content or not isinstance(content, str) or not content.strip():
        return False
    if "\x00" in content[:256]:
        return False
    try:
        document = json.loads(content)
    except (json.JSONDecodeError, RecursionError, ValueError):
        return False
    return is_mcp_manifest_document(document)


# ===========================================================================
# Parsing
# ===========================================================================


def parse_mcp_manifest(
    content: str,
    *,
    source_label: Optional[str] = None,
) -> McpManifestDocument:
    """Parse a static MCP server manifest into an :class:`McpManifestDocument`.

    Args:
        content: The raw manifest text (JSON).
        source_label: Optional filename / URL used in error messages and for the title.

    Returns:
        The parsed manifest with shared ``$ref``s inlined.

    Raises:
        McpManifestParseError: With a taxonomy ``code`` — ``INPUT_EMPTY`` for blank input,
            ``INPUT_ENCODING_INVALID`` for non-UTF-8 text, ``INPUT_TRUNCATED`` for a
            document that stops mid-value, ``INPUT_MALFORMED`` for broken JSON,
            ``FORMAT_MISMATCH`` for a different format, ``INPUT_REFERENCE_UNRESOLVED`` /
            ``INPUT_REF_LIMIT`` for unusable shared definitions, and
            ``INPUT_SEMANTIC_INVALID`` for a well-formed manifest that describes no
            callable surface.
    """
    return _parse(content, external={}, source_label=source_label)


def parse_mcp_manifest_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> McpManifestDocument:
    """Parse a manifest whose shared schemas live in sibling files.

    A manifest may factor its schemas into a neighbouring document and reach them with a
    relative reference (``{"$ref": "./schemas.json#/Invoice"}``). Those siblings are
    resolved from ``members`` — never from disk or the network — so a fileset import
    cannot be turned into a fetch.

    Args:
        members: Every member of the set, keyed by its set-relative POSIX path.
        root: The manifest's path within ``members``.
        source_label: Optional label for error messages; defaults to ``root``.

    Returns:
        The parsed manifest with local *and* cross-file references inlined.

    Raises:
        McpManifestParseError: As :func:`parse_mcp_manifest`, plus ``INPUT_MALFORMED``
            when ``root`` names no member of the set.
    """
    if root not in members:
        raise McpManifestParseError(
            f"MCP manifest fileset root {root!r} is not among its members",
            code="INPUT_MALFORMED",
        )
    external: Dict[str, Any] = {}
    for path, text in members.items():
        if path == root:
            continue
        try:
            external[path] = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            # A member that is not JSON simply cannot answer a `$ref`; the unresolved
            # reference is reported against the *reference*, which names the file, rather
            # than as an opaque failure of a file nothing may have pointed at.
            continue
    return _parse(members[root], external=external, source_label=source_label or root)


def _parse(
    content: str,
    *,
    external: Mapping[str, Any],
    source_label: Optional[str],
) -> McpManifestDocument:
    """Shared body of the single-document and fileset parse paths.

    Args:
        content: The manifest text.
        external: Sibling documents, keyed by set-relative path, for cross-file ``$ref``.
        source_label: Label for error messages and the fallback title.

    Returns:
        The parsed :class:`McpManifestDocument`.

    Raises:
        McpManifestParseError: See :func:`parse_mcp_manifest`.
    """
    document = _load_manifest(content, source_label=source_label)

    protocol_version = next(
        (
            value
            for value in (_optional_str(document.get(key)) for key in MANIFEST_VERSION_KEYS)
            if value
        ),
        None,
    )
    server_payload = document.get("server")
    if not isinstance(server_payload, Mapping):
        server_payload = document.get("serverInfo")
    server_info = ServerInfo.from_dict(
        server_payload if isinstance(server_payload, Mapping) else None
    )

    instructions = _optional_str(document.get("instructions"))
    if instructions is None and isinstance(server_payload, Mapping):
        instructions = _optional_str(server_payload.get("instructions"))

    defs = _shared_defs(document)
    arrays: Dict[str, Tuple[Dict[str, Any], ...]] = {}
    for source_key, attribute in _CAPABILITY_ARRAYS:
        arrays[attribute] = _capability_entries(
            document.get(source_key),
            source_key=source_key,
            defs=defs,
            external=external,
            source_label=source_label,
        )

    _validate_surface(arrays, source_label=source_label)

    capabilities = document.get("capabilities")
    return McpManifestDocument(
        protocol_version=protocol_version,
        server_info=server_info,
        instructions=instructions,
        capabilities=dict(capabilities) if isinstance(capabilities, Mapping) else {},
        tools=arrays["tools"],
        resources=arrays["resources"],
        resource_templates=arrays["resource_templates"],
        prompts=arrays["prompts"],
        transport=McpManifestTransport.from_payload(document.get("transport")),
        title=_title_for(server_info, source_label),
        raw=content,
        source_label=source_label,
    )


def _load_manifest(content: str, *, source_label: Optional[str]) -> Mapping[str, Any]:
    """Decode manifest text to a JSON object, classifying every way that can fail.

    Args:
        content: The raw manifest text.
        source_label: Label for error messages.

    Returns:
        The parsed top-level object.

    Raises:
        McpManifestParseError: With the taxonomy code for the specific failure.
    """
    where = f" ({source_label})" if source_label else ""

    if not content or not content.strip():
        raise McpManifestParseError(
            f"MCP server manifest is empty{where}", code="INPUT_EMPTY"
        )
    # Scanned whole, not just the head: a NUL a megabyte in is the same evidence of a
    # non-UTF-8 source as one in the first line, and reporting it as "malformed JSON" would
    # send the reader looking for a syntax error that is not there.
    if "\x00" in content or "�" in content[:64]:
        raise McpManifestParseError(
            f"MCP server manifest is not UTF-8 text{where} — it looks like UTF-16 or "
            "binary content",
            code="INPUT_ENCODING_INVALID",
        )

    try:
        guard_document_text(content, source_label=source_label)
    except IntakeLimitError as exc:
        raise McpManifestParseError(str(exc), code=getattr(exc, "code", None)) from exc

    try:
        document: Any = json.loads(content)
    except json.JSONDecodeError as exc:
        raise _classify_json_failure(content, exc, where=where) from exc

    try:
        guard_parsed_document(document, source_label=source_label)
    except IntakeLimitError as exc:
        raise McpManifestParseError(str(exc), code=getattr(exc, "code", None)) from exc

    if not isinstance(document, Mapping):
        raise McpManifestParseError(
            f"MCP server manifest must be a JSON object{where}, not a "
            f"{type(document).__name__}",
            code="FORMAT_MISMATCH",
        )
    if any(marker in document for marker in _FOREIGN_FORMAT_MARKERS):
        raise McpManifestParseError(
            f"Content looks like an API description (OpenAPI/Swagger/AsyncAPI/…){where}, "
            "not an MCP server manifest",
            code="FORMAT_MISMATCH",
        )
    if not any(_optional_str(document.get(key)) for key in MANIFEST_VERSION_KEYS):
        raise McpManifestParseError(
            f"MCP server manifest{where} declares no `mcpVersion` / `protocolVersion`",
            code="FORMAT_MISMATCH",
        )
    return document


def _classify_json_failure(
    content: str,
    exc: json.JSONDecodeError,
    *,
    where: str,
) -> McpManifestParseError:
    """Turn a JSON decode failure into the right taxonomy code.

    Three outcomes, in precedence order:

    1. **A different format.** The text parses as YAML into a mapping that is plainly some
       other API description (or is not manifest-shaped at all) — the document was handed
       to the wrong importer, so ``FORMAT_MISMATCH``.
    2. **Truncated.** The document leaves a string or a bracket open, which is what a
       document cut off mid-write looks like — ``INPUT_TRUNCATED``.
    3. **Malformed.** Anything else, including the trailing comma YAML would have
       accepted — ``INPUT_MALFORMED``.

    Args:
        content: The manifest text that failed to decode.
        exc: The decode error.
        where: Pre-formatted ``" (label)"`` suffix for messages.

    Returns:
        The error to raise (never raised here, so the caller keeps the ``from exc`` chain).
    """
    try:
        loose = yaml.safe_load(content)
    except Exception:  # noqa: BLE001 - a YAML failure only means "no second opinion"
        loose = None
    if isinstance(loose, Mapping) and not is_mcp_manifest_document(loose):
        return McpManifestParseError(
            f"Content is not an MCP server manifest{where}: {exc.msg}",
            code="FORMAT_MISMATCH",
        )

    if _is_unclosed(content):
        return McpManifestParseError(
            f"MCP server manifest is truncated{where}: {exc.msg} at line {exc.lineno}",
            code="INPUT_TRUNCATED",
        )
    return McpManifestParseError(
        f"MCP server manifest is not valid JSON{where}: {exc.msg} at line {exc.lineno} "
        f"column {exc.colno}",
        code="INPUT_MALFORMED",
    )


def _is_unclosed(content: str) -> bool:
    """Return ``True`` when ``content`` ends with an open string, object, or array.

    A single left-to-right scan that tracks string state and brace/bracket depth. This is
    what separates "the file stops mid-value" (truncation) from "the file is complete but
    ungrammatical" (a trailing comma, a bare identifier) — the two failures a reader must
    act on differently, and the reason the corpus declares distinct codes for them.

    Args:
        content: The manifest text.

    Returns:
        ``True`` when a string is still open at end of input, or more containers were
        opened than closed.
    """
    depth = 0
    in_string = False
    escaped = False
    for char in content:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
    return in_string or depth > 0


# ===========================================================================
# Shared definitions (`$ref` inlining — Rule 2)
# ===========================================================================


def _shared_defs(document: Mapping[str, Any]) -> Dict[str, Any]:
    """Collect the manifest's document-level shared schema map.

    Both JSON Schema spellings are accepted (``$defs`` for 2019-09+, ``definitions`` for
    draft-07), with ``$defs`` winning on a key present in both.

    Args:
        document: The parsed manifest.

    Returns:
        Name → schema for every shared definition; empty when the manifest declares none.
    """
    collected: Dict[str, Any] = {}
    for key in ("definitions", "$defs"):
        block = document.get(key)
        if isinstance(block, Mapping):
            collected.update({str(name): value for name, value in block.items()})
    return collected


def _capability_entries(
    payload: Any,
    *,
    source_key: str,
    defs: Mapping[str, Any],
    external: Mapping[str, Any],
    source_label: Optional[str],
) -> Tuple[Dict[str, Any], ...]:
    """Validate one capability array and inline every shared reference inside it.

    Args:
        payload: The raw array value from the manifest (may be absent or wrong-typed).
        source_key: The manifest key it came from, for error messages.
        defs: Document-level shared definitions.
        external: Sibling documents for cross-file references.
        source_label: Label for error messages.

    Returns:
        The entries as verbatim wire dicts with references resolved; empty when the key
        is absent.

    Raises:
        McpManifestParseError: When the value is not an array of objects, or a reference
            inside it cannot be resolved.
    """
    where = f" ({source_label})" if source_label else ""
    if payload is None:
        return ()
    if not isinstance(payload, list):
        raise McpManifestParseError(
            f"MCP server manifest{where} declares `{source_key}` as a "
            f"{type(payload).__name__}; it must be an array",
            code="INPUT_SEMANTIC_INVALID",
        )

    entries: List[Dict[str, Any]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, Mapping):
            raise McpManifestParseError(
                f"`{source_key}[{index}]`{where} is not an object",
                code="INPUT_SEMANTIC_INVALID",
            )
        if not _optional_str(item.get("name")):
            raise McpManifestParseError(
                f"`{source_key}[{index}]`{where} is missing a non-empty `name`",
                code="INPUT_SEMANTIC_INVALID",
            )
        resolved = _resolve_refs(
            item,
            defs=defs,
            external=external,
            trail=(),
            depth=0,
            where=where,
        )
        entries.append(dict(resolved))
    return tuple(entries)


def _resolve_refs(
    value: Any,
    *,
    defs: Mapping[str, Any],
    external: Mapping[str, Any],
    trail: Tuple[str, ...],
    depth: int,
    where: str,
) -> Any:
    """Recursively inline every ``$ref`` in ``value`` against the shared definitions.

    Mappings are rebuilt as plain ``dict`` so the result is JSON-serializable; lists are
    walked element-wise; scalars are returned unchanged. A mapping carrying ``$ref``
    alongside sibling keys resolves the reference first and then lets the siblings
    override, which is how JSON Schema 2019-09 defines the combination.

    Args:
        value: Any JSON-shaped value.
        defs: Document-level shared definitions.
        external: Sibling documents for cross-file references.
        trail: References already being resolved on this path, for cycle detection.
        depth: Current nesting depth.
        where: Pre-formatted ``" (label)"`` suffix for messages.

    Returns:
        ``value`` with every resolvable reference replaced by its definition.

    Raises:
        McpManifestParseError: ``INPUT_REF_LIMIT`` past :data:`MAX_REF_DEPTH`,
            ``INPUT_REFERENCE_UNRESOLVED`` for a reference that names nothing or that
            recurses (a recursive schema cannot be inlined; a live server would declare it
            inline in the tool's own schema, and so must the manifest).
    """
    if depth > MAX_REF_DEPTH:
        raise McpManifestParseError(
            f"MCP server manifest{where} nests shared `$ref`s more than "
            f"{MAX_REF_DEPTH} levels deep",
            code="INPUT_REF_LIMIT",
        )

    if isinstance(value, Mapping):
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.strip():
            target = _lookup_ref(reference, defs=defs, external=external, where=where)
            if reference in trail:
                raise McpManifestParseError(
                    f"MCP server manifest{where} defines a recursive `$ref` chain through "
                    f"{reference!r}; a shared definition that references itself cannot be "
                    "inlined — declare it inside the schema that uses it",
                    code="INPUT_REFERENCE_UNRESOLVED",
                )
            resolved = _resolve_refs(
                target,
                defs=defs,
                external=external,
                trail=(*trail, reference),
                depth=depth + 1,
                where=where,
            )
            siblings = {
                key: _resolve_refs(
                    item, defs=defs, external=external, trail=trail, depth=depth + 1, where=where
                )
                for key, item in value.items()
                if key != "$ref"
            }
            if isinstance(resolved, Mapping):
                return {**resolved, **siblings}
            return resolved if not siblings else {**siblings, "const": resolved}
        return {
            key: _resolve_refs(
                item, defs=defs, external=external, trail=trail, depth=depth + 1, where=where
            )
            for key, item in value.items()
        }

    if isinstance(value, (list, tuple)):
        return [
            _resolve_refs(
                item, defs=defs, external=external, trail=trail, depth=depth + 1, where=where
            )
            for item in value
        ]
    return value


def _lookup_ref(
    reference: str,
    *,
    defs: Mapping[str, Any],
    external: Mapping[str, Any],
    where: str,
) -> Any:
    """Resolve one ``$ref`` string to the value it names.

    Two shapes are supported, and only two: a local pointer into the document's shared
    definitions (``#/$defs/Name``, ``#/definitions/Name``) and a relative pointer into a
    sibling fileset member (``./schemas.json#/Name``). Anything else — an absolute URL, a
    pointer into a part of the document that is not a definition map — is *not* resolved,
    because resolving it would either mean fetching (which a parser must never do) or
    inventing a meaning the manifest does not have.

    Args:
        reference: The raw ``$ref`` string.
        defs: Document-level shared definitions.
        external: Sibling documents, keyed by set-relative path.
        where: Pre-formatted ``" (label)"`` suffix for messages.

    Returns:
        The referenced value.

    Raises:
        McpManifestParseError: ``INPUT_REFERENCE_UNRESOLVED`` when nothing answers it.
    """
    for prefix in _LOCAL_DEF_PREFIXES:
        if reference.startswith(prefix):
            name = reference[len(prefix) :]
            if name in defs:
                return defs[name]
            raise McpManifestParseError(
                f"MCP server manifest{where} references undefined shared schema "
                f"{reference!r}",
                code="INPUT_REFERENCE_UNRESOLVED",
            )

    if "#" in reference and not reference.startswith("#"):
        path, _, pointer = reference.partition("#")
        member = _normalize_member_path(path)
        document = external.get(member)
        if document is None:
            raise McpManifestParseError(
                f"MCP server manifest{where} references {reference!r}, but {member!r} is "
                "not a readable JSON member of this fileset",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        resolved = _json_pointer(document, pointer)
        if resolved is _MISSING:
            raise McpManifestParseError(
                f"MCP server manifest{where} references {reference!r}, but {member!r} has "
                "no such definition",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        return resolved

    raise McpManifestParseError(
        f"MCP server manifest{where} carries an unsupported reference {reference!r}; only "
        "`#/$defs/Name` and relative `./file.json#/Name` references are resolved",
        code="INPUT_REFERENCE_UNRESOLVED",
    )


#: Sentinel distinguishing "the pointer resolved to JSON ``null``" from "nothing there".
_MISSING = object()


def _normalize_member_path(path: str) -> str:
    """Normalize a relative fileset reference to its member key (``./a.json`` → ``a.json``)."""
    cleaned = path.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned.lstrip("/")


def _json_pointer(document: Any, pointer: str) -> Any:
    """Resolve an RFC 6901 JSON Pointer within ``document``.

    Args:
        document: The document to walk.
        pointer: The pointer, with or without its leading ``/``. An empty pointer selects
            the whole document.

    Returns:
        The referenced value, or :data:`_MISSING` when any segment does not exist.
    """
    if not pointer or pointer == "/":
        return document
    current = document
    for segment in pointer.lstrip("/").split("/"):
        decoded = segment.replace("~1", "/").replace("~0", "~")
        if isinstance(current, Mapping) and decoded in current:
            current = current[decoded]
            continue
        if isinstance(current, list) and decoded.isdigit() and int(decoded) < len(current):
            current = current[int(decoded)]
            continue
        return _MISSING
    return current


# ===========================================================================
# Semantic validation
# ===========================================================================


def _validate_surface(
    arrays: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    source_label: Optional[str],
) -> None:
    """Reject a well-formed manifest that describes no usable surface.

    Two rules, both of which a live probe would satisfy by construction:

    * **A manifest must declare at least one capability.** A document with four empty
      arrays says nothing about the server, and cataloguing it would create an endpoint
      whose surface is a guess.
    * **Every tool must carry an ``inputSchema`` object.** MCP requires it, so a tool
      without one is not callable — and importing it would put an operation in the catalog
      that no client could invoke.

    Args:
        arrays: The four parsed capability arrays, keyed by surface attribute.
        source_label: Label for error messages.

    Raises:
        McpManifestParseError: ``INPUT_SEMANTIC_INVALID`` when either rule is broken.
    """
    where = f" ({source_label})" if source_label else ""
    if not any(arrays[attribute] for _, attribute in _CAPABILITY_ARRAYS):
        raise McpManifestParseError(
            f"MCP server manifest{where} declares no tools, resources, resource templates "
            "or prompts, so it describes no surface to catalog",
            code="INPUT_SEMANTIC_INVALID",
        )

    schemaless = [
        str(tool.get("name"))
        for tool in arrays["tools"]
        if not isinstance(tool.get("inputSchema"), Mapping)
    ]
    if schemaless:
        listed = ", ".join(repr(name) for name in schemaless[:5])
        more = "" if len(schemaless) <= 5 else f" (+{len(schemaless) - 5} more)"
        raise McpManifestParseError(
            f"MCP server manifest{where} declares {len(schemaless)} tool(s) with no "
            f"`inputSchema`: {listed}{more}. MCP requires an input schema on every tool, "
            "so these tools describe no callable surface",
            code="INPUT_SEMANTIC_INVALID",
        )


# ===========================================================================
# Surface normalization
# ===========================================================================


def manifest_surface(document: McpManifestDocument) -> DiscoverySurface:
    """Build the canonical capability surface a probe of this server would produce.

    This is the acceptance criterion made structural: the manifest's wire entries are
    handed to :meth:`~app.mcp_client.normalize.DiscoverySurface.from_discovery` — the same
    constructor live discovery calls, with the same
    :class:`~app.mcp_client.handshake.InitializeResult` and
    :class:`~app.mcp_client.discovery.DiscoveryListings` shapes — so the resulting
    ``surface_fingerprint`` is produced by the same code over the same inputs and cannot
    drift from the probed one.

    Args:
        document: A parsed manifest.

    Returns:
        The :class:`~app.mcp_client.normalize.DiscoverySurface` for the declared server.
    """
    initialize = InitializeResult(
        protocol_version=document.protocol_version or "",
        server_info=document.server_info,
        capabilities=dict(document.capabilities),
        instructions=document.instructions,
    )
    listings = DiscoveryListings(
        tools=[dict(item) for item in document.tools],
        resources=[dict(item) for item in document.resources],
        resource_templates=[dict(item) for item in document.resource_templates],
        prompts=[dict(item) for item in document.prompts],
    )
    surface = DiscoverySurface.from_discovery(initialize, listings)
    if document.protocol_version:
        return surface
    # `InitializeResult.protocol_version` is a non-optional str, but a manifest may omit
    # the marker's *value*; the surface field is optional, and a probe that never
    # negotiated a version leaves it None. Match that rather than inventing "".
    return DiscoverySurface(
        protocol_version=None,
        server_info=surface.server_info,
        capabilities=surface.capabilities,
        instructions=surface.instructions,
        tools=surface.tools,
        resources=surface.resources,
        resource_templates=surface.resource_templates,
        prompts=surface.prompts,
    )


def dumps_manifest_for_raw(document: McpManifestDocument) -> Any:
    """Best-effort re-parse of the manifest text for the canonical model's fidelity bag.

    Args:
        document: A parsed manifest.

    Returns:
        The manifest as a JSON value, or the raw text when it cannot be re-parsed.
    """
    try:
        return json.loads(document.raw)
    except (json.JSONDecodeError, ValueError):
        return document.raw


# ===========================================================================
# Helpers
# ===========================================================================


def _optional_str(value: Any) -> Optional[str]:
    """Return ``value`` when it is a non-blank string (trimmed), else ``None``."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _title_for(server_info: ServerInfo, source_label: Optional[str]) -> str:
    """Pick the manifest's display title.

    Args:
        server_info: The parsed server identity.
        source_label: Filename / URL the manifest arrived as.

    Returns:
        The server title, else its programmatic name, else the source label's stem, else
        ``"mcp-server"`` — never an empty string, because the title names the canonical
        service.
    """
    if server_info.title:
        return server_info.title
    if server_info.name:
        return server_info.name
    if source_label:
        base = source_label.rsplit("/", 1)[-1]
        for suffix in (".mcp.json", ".json"):
            if base.lower().endswith(suffix):
                base = base[: -len(suffix)]
                break
        if base.strip():
            return base.strip()
    return "mcp-server"
