"""Open Data Contract Standard (ODCS) reader — FMT-5.1 (#5439).

Reads a v3.x data contract — YAML or its JSON serialization, alone or as a file set —
into the typed :class:`~app.odcs_contract.OdcsContract` algebra. Detection, version
gating, structural validation and multi-file composition all live here; the canonical
projection lives in :mod:`app.odcs_normalizer`.

**Error grounding.** A failure this reader can classify carries its taxonomy code; one
it cannot carries **none**, which hands the classification to
:func:`app.import_source_pipeline._classify_parse_failure` and is what makes a UTF-16
upload read as ``INPUT_ENCODING_INVALID`` rather than as a generic malformed document.
The codes this reader sets itself are:

``FORMAT_MISMATCH``
    The document loads, but is not an ODCS contract at all (no ``kind:
    DataContract``). A dbt ``schema.yml`` and an ODCS contract are both "a YAML file
    with a list of named things and their columns"; naming the mismatch is more useful
    than reporting an empty contract.
``FORMAT_VERSION_UNSUPPORTED``
    The envelope is ODCS but the declared ``apiVersion`` is outside the v3.x line —
    see :func:`~app.odcs_contract.resolve_api_version`.
``INPUT_SEMANTIC_INVALID``
    Well-formed ODCS that describes no dataset: a missing ``name``, an empty
    ``schema``, a schema object with no ``properties``, a quality pack that names an
    object the contract does not declare.
``INPUT_TRUNCATED``
    The YAML stream ended while a construct was still open. This is a *parser state*,
    not a message heuristic: PyYAML reports the position it gave up at, and a position
    at the end of the input means the document ran out rather than being wrong.
``INPUT_DEPTH_LIMIT`` / ``INPUT_TOO_LARGE`` / ``INPUT_UNSAFE_CONSTRUCT``
    The shared intake guards, plus a relative ``authoritativeDefinitions`` URL that
    tries to escape the imported file set.
"""

from __future__ import annotations

import posixpath
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import yaml

from .intake_resource_guard import IntakeLimitError, guard_document_text
from .odcs_contract import (
    MAX_PROPERTY_DEPTH,
    MAX_SCHEMA_PROPERTIES,
    ODCS_KIND,
    OdcsContract,
    OdcsParseError,
    OdcsProperty,
    OdcsQualityRule,
    OdcsSchemaObject,
    resolve_api_version,
)

__all__ = [
    "ODCS_SUFFIXES",
    "is_odcs",
    "is_odcs_document",
    "parse_odcs",
    "parse_odcs_fileset",
]

#: File extensions an ODCS contract travels under. ODCS defines no suffix of its own —
#: a contract is "a YAML file" — so these are the serializations, and detection is by
#: content rather than by name.
ODCS_SUFFIXES: Tuple[str, ...] = (".odcs.yaml", ".odcs.yml", ".yaml", ".yml", ".json")

#: Contract-level keys this reader consumes structurally. Everything else a document
#: declares at the top level is *governance*, carried verbatim.
_CONTRACT_STRUCTURAL_KEYS = frozenset(
    {
        "apiVersion",
        "kind",
        "id",
        "name",
        "version",
        "status",
        "domain",
        "tenant",
        "dataProduct",
        "description",
        "schema",
    }
)

#: Schema-object keys this reader consumes structurally.
_OBJECT_STRUCTURAL_KEYS = frozenset(
    {"name", "physicalName", "logicalType", "physicalType", "description", "properties", "quality"}
)

#: Property keys this reader consumes structurally.
_PROPERTY_STRUCTURAL_KEYS = frozenset(
    {
        "name",
        "logicalType",
        "physicalType",
        "physicalName",
        "description",
        "required",
        "properties",
        "items",
        "quality",
        "logicalTypeOptions",
        "examples",
    }
)

#: The ``quality[].type`` values the standard names. An unrecognised value is kept as
#: declared — the rule is carried verbatim either way, and inventing a bucket for it
#: would misreport what the document said.
_QUALITY_KINDS = frozenset({"library", "sql", "text", "custom"})

#: Lower-cased substrings a document must carry before this reader will even try to
#: load it. Deliberately the ODCS envelope and nothing else: the structural half is
#: shared with dbt, Kafka Connect and half a dozen catalog formats, and claiming on it
#: would route their documents here.
_TEXT_MARKERS = ("datacontract", "apiversion", "kind")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _looks_like_odcs_text(text: str) -> bool:
    """Whether ``text`` carries the ODCS envelope markers, without parsing it."""
    lowered = text.lower()
    return all(marker in lowered for marker in _TEXT_MARKERS)


def _is_truncation(exc: yaml.YAMLError, text: str) -> bool:
    """Whether a YAML failure is the stream *ending* rather than being wrong.

    PyYAML reports the position it gave up at. A position at (or past) the end of the
    input means a construct — a quoted scalar, a flow collection — was still open when
    the bytes ran out, which is a truncated upload. A position anywhere earlier is a
    document that is wrong where it stands.

    Args:
        exc: The raised YAML error.
        text: The source text the error came from.

    Returns:
        ``True`` when the failure is a truncation.
    """
    mark = getattr(exc, "problem_mark", None)
    if mark is None or not isinstance(getattr(mark, "index", None), int):
        return False
    return mark.index >= len(text.rstrip())


def _load_document(text: str, *, source_label: Optional[str] = None) -> Any:
    """Load one YAML (or JSON) document, applying the shared intake guards.

    Args:
        text: The source text.
        source_label: The document's name, for error messages.

    Returns:
        The loaded value, of whatever type the document had.

    Raises:
        OdcsParseError: With the guard's code for an oversized/too-deep document,
            ``INPUT_TRUNCATED`` for a stream that ended mid-construct, and **no code**
            for any other YAML syntax error.
    """
    try:
        guard_document_text(text, source_label=source_label)
    except IntakeLimitError as exc:
        raise OdcsParseError(str(exc), code=exc.code) from exc
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        where = f" in {source_label}" if source_label else ""
        if _is_truncation(exc, text):
            raise OdcsParseError(
                f"ODCS document{where} ends while a value is still open — the upload is "
                f"truncated: {exc}",
                code="INPUT_TRUNCATED",
            ) from exc
        raise OdcsParseError(f"Invalid YAML{where}: {exc}") from exc


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def is_odcs_document(document: Any) -> bool:
    """Whether a loaded value is an ODCS data contract of *any* version.

    Deliberately version-agnostic: a v2.2 contract must be *claimed* so it can be
    rejected by version with actionable remediation, rather than falling through to
    "no importer recognized this document".

    Args:
        document: The loaded value.

    Returns:
        ``True`` when the value carries the ODCS envelope.
    """
    if not isinstance(document, Mapping):
        return False
    kind = document.get("kind")
    if not isinstance(kind, str) or kind.strip().lower() != ODCS_KIND:
        return False
    return isinstance(document.get("apiVersion"), str)


def is_odcs(content: str) -> bool:
    """Whether ``content`` looks like an ODCS data contract.

    A malformed contract that still carries the envelope is claimed: routing it here
    is what makes it fail as a malformed *ODCS* document instead of being reported as
    somebody else's format.

    Args:
        content: The candidate document text.

    Returns:
        ``True`` when this reader claims the text.
    """
    if not content or not isinstance(content, str) or not content.strip():
        return False
    if not _looks_like_odcs_text(content):
        return False
    try:
        document = _load_document(content)
    except OdcsParseError:
        # Broken YAML that still carries the ODCS envelope markers is ours to reject.
        return True
    return is_odcs_document(document)


# ---------------------------------------------------------------------------
# Structural reading
# ---------------------------------------------------------------------------


def _is_list(value: Any) -> bool:
    """Whether ``value`` is a YAML/JSON *list*.

    ``str`` and ``bytes`` are sequences too, and treating one as a list of items is the
    classic way to turn a mis-typed scalar into a silently wrong document.

    Args:
        value: The loaded value.

    Returns:
        ``True`` for a list-like value that is not text.
    """
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes))


def _text(value: Any) -> Optional[str]:
    """Return a non-empty stripped string, or ``None``."""
    return value.strip() if isinstance(value, str) and value.strip() else None


def _carried(source: Mapping[str, Any], structural: frozenset) -> Dict[str, Any]:
    """Return every key of ``source`` that is not consumed structurally, verbatim.

    Args:
        source: The source mapping.
        structural: The keys the reader consumes into typed fields.

    Returns:
        A new dict of the remaining keys, spelled exactly as the source spelled them.
    """
    return {key: value for key, value in source.items() if key not in structural}


def _quality_rules(
    raw: Any, *, where: str, source_label: Optional[str]
) -> Tuple[OdcsQualityRule, ...]:
    """Read a ``quality[]`` list into typed rules, keeping each entry verbatim.

    Args:
        raw: The declared ``quality`` value.
        where: The owning node, for error messages.
        source_label: The document's name, for error messages.

    Returns:
        The parsed rules; empty when the node declared none.

    Raises:
        OdcsParseError: ``INPUT_SEMANTIC_INVALID`` when ``quality`` is not a list of
            mappings.
    """
    if raw is None:
        return ()
    if not _is_list(raw):
        raise _semantic(f"`quality` on {where} must be a list of rules", source_label)
    rules: List[OdcsQualityRule] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            raise _semantic(f"`quality` on {where} must be a list of rules", source_label)
        declared = _text(entry.get("type")) or "library"
        kind = declared.lower()
        rules.append(
            OdcsQualityRule(
                kind=kind if kind in _QUALITY_KINDS else declared,
                name=_text(entry.get("rule")),
                property=_text(entry.get("property")),
                dimension=_text(entry.get("dimension")),
                severity=_text(entry.get("severity")),
                definition=dict(entry),
            )
        )
    return tuple(rules)


def _semantic(message: str, source_label: Optional[str]) -> OdcsParseError:
    """Build an ``INPUT_SEMANTIC_INVALID`` error naming the source document."""
    where = f" ({source_label})" if source_label else ""
    return OdcsParseError(f"{message}{where}", code="INPUT_SEMANTIC_INVALID")


class _PropertyReader:
    """Reads a property tree, enforcing the depth and total-count ceilings.

    The ceilings are the reader's own rather than the shared intake guard's: the
    property walk recurses per nesting level, and an uncaught ``RecursionError``
    surfaces from the import pipeline as a 5xx rather than as a rejection.
    """

    def __init__(self, *, source_label: Optional[str]) -> None:
        self._source_label = source_label
        self._count = 0

    def read_all(self, raw: Any, *, where: str, depth: int = 1) -> Tuple[OdcsProperty, ...]:
        """Read a ``properties[]`` list.

        Args:
            raw: The declared ``properties`` value.
            where: The owning node, for error messages.
            depth: The current nesting level (1 for a schema object's own properties).

        Returns:
            The parsed properties, in declaration order.

        Raises:
            OdcsParseError: ``INPUT_SEMANTIC_INVALID`` for a malformed list,
                ``INPUT_DEPTH_LIMIT`` past :data:`MAX_PROPERTY_DEPTH`, and
                ``INPUT_ENTITY_LIMIT`` past :data:`MAX_SCHEMA_PROPERTIES`.
        """
        if raw is None:
            return ()
        if not _is_list(raw):
            raise _semantic(f"`properties` on {where} must be a list", self._source_label)
        if depth > MAX_PROPERTY_DEPTH:
            raise OdcsParseError(
                f"ODCS properties nest more than {MAX_PROPERTY_DEPTH} levels deep under "
                f"{where}",
                code="INPUT_DEPTH_LIMIT",
            )
        properties = tuple(self._read(entry, where=where, depth=depth) for entry in raw)
        seen: Set[str] = set()
        for prop in properties:
            if prop.name in seen:
                raise _semantic(
                    f"{where} declares the property {prop.name!r} twice; canonical members "
                    "are keyed by name, so the second would overwrite the first",
                    self._source_label,
                )
            seen.add(prop.name)
        return properties

    def _read(self, raw: Any, *, where: str, depth: int) -> OdcsProperty:
        """Read one property entry."""
        if not isinstance(raw, Mapping):
            raise _semantic(f"`properties` on {where} must be a list of mappings", self._source_label)
        name = _text(raw.get("name"))
        if name is None:
            raise _semantic(f"a property of {where} declares no `name`", self._source_label)
        self._count += 1
        if self._count > MAX_SCHEMA_PROPERTIES:
            raise OdcsParseError(
                f"ODCS contract declares more than {MAX_SCHEMA_PROPERTIES} properties",
                code="INPUT_ENTITY_LIMIT",
            )
        here = f"`{where}.{name}`"
        logical = _text(raw.get("logicalType"))
        options = raw.get("logicalTypeOptions")
        examples = raw.get("examples")
        return OdcsProperty(
            name=name,
            logical_type=logical.lower() if logical else None,
            physical_type=_text(raw.get("physicalType")),
            physical_name=_text(raw.get("physicalName")),
            description=_text(raw.get("description")),
            required=bool(raw.get("required")),
            properties=self.read_all(raw.get("properties"), where=here, depth=depth + 1),
            items=self._read_items(raw.get("items"), where=here, depth=depth + 1),
            quality=_quality_rules(
                raw.get("quality"), where=here, source_label=self._source_label
            ),
            logical_type_options=dict(options) if isinstance(options, Mapping) else {},
            examples=tuple(examples) if _is_list(examples) else (),
            governance=_carried(raw, _PROPERTY_STRUCTURAL_KEYS),
        )

    def _read_items(self, raw: Any, *, where: str, depth: int) -> Optional[OdcsProperty]:
        """Read an array property's unnamed ``items`` block as a named property.

        ODCS's ``items`` carries a property's attributes without a ``name``; the
        canonical model needs a name for the synthesized element type, so ``items``
        is used — the same word the source used.
        """
        if raw is None:
            return None
        if not isinstance(raw, Mapping):
            raise _semantic(f"`items` on {where} must be a mapping", self._source_label)
        return self._read({"name": "items", **raw}, where=where, depth=depth)


def _schema_objects(
    raw: Any, *, source_label: Optional[str]
) -> Tuple[OdcsSchemaObject, ...]:
    """Read the contract's ``schema[]`` list.

    Args:
        raw: The declared ``schema`` value.
        source_label: The document's name, for error messages.

    Returns:
        The parsed schema objects, in declaration order.

    Raises:
        OdcsParseError: ``INPUT_SEMANTIC_INVALID`` when the contract declares no
            schema, or when an object declares no name or no properties — a data
            contract that names no structure describes no dataset, and importing it
            would create an empty catalog entry rather than fail honestly.
    """
    if not _is_list(raw) or not raw:
        raise _semantic(
            "ODCS contract declares no `schema` objects, so it describes no dataset "
            "structure",
            source_label,
        )
    reader = _PropertyReader(source_label=source_label)
    objects: List[OdcsSchemaObject] = []
    seen: Set[str] = set()
    for entry in raw:
        if not isinstance(entry, Mapping):
            raise _semantic("`schema` must be a list of schema objects", source_label)
        name = _text(entry.get("name"))
        if name is None:
            raise _semantic("a `schema` object declares no `name`", source_label)
        if name in seen:
            raise _semantic(
                f"`schema` declares the object {name!r} twice; canonical types are keyed by "
                "name, so the second would overwrite the first",
                source_label,
            )
        seen.add(name)
        properties = reader.read_all(entry.get("properties"), where=f"`{name}`")
        if not properties:
            raise _semantic(
                f"ODCS schema object {name!r} declares no `properties`, so the contract "
                "describes no dataset structure",
                source_label,
            )
        logical = _text(entry.get("logicalType"))
        objects.append(
            OdcsSchemaObject(
                name=name,
                physical_name=_text(entry.get("physicalName")),
                logical_type=logical.lower() if logical else None,
                physical_type=_text(entry.get("physicalType")),
                description=_text(entry.get("description")),
                properties=properties,
                quality=_quality_rules(
                    entry.get("quality"), where=f"`{name}`", source_label=source_label
                ),
                governance=_carried(entry, _OBJECT_STRUCTURAL_KEYS),
            )
        )
    return tuple(objects)


def _build_contract(
    document: Any,
    *,
    raw: str,
    source_label: Optional[str],
    fileset: Optional[Mapping[str, Any]] = None,
    extra_quality: Optional[Mapping[str, Tuple[OdcsQualityRule, ...]]] = None,
) -> OdcsContract:
    """Read a loaded ODCS document into an :class:`OdcsContract`.

    Args:
        document: The loaded value.
        raw: The source text, retained for the fidelity bag.
        source_label: The document's name, for error messages.
        fileset: What a multi-file import composed, when this is a set root.
        extra_quality: Quality rules merged in from sibling quality packs, keyed by
            schema-object name.

    Returns:
        The parsed contract.

    Raises:
        OdcsParseError: ``FORMAT_MISMATCH`` when the document is not an ODCS
            contract, plus the version and structural errors described in the module
            docstring.
    """
    if not isinstance(document, Mapping):
        raise OdcsParseError(
            "ODCS document must be a mapping with `kind: DataContract` at its top level",
            code="FORMAT_MISMATCH",
        )
    kind = _text(document.get("kind"))
    if kind is None or kind.lower() != ODCS_KIND:
        raise OdcsParseError(
            "Document is not an ODCS data contract: expected `kind: DataContract`, found "
            f"{kind!r}",
            code="FORMAT_MISMATCH",
        )
    api_version = resolve_api_version(document.get("apiVersion"))

    name = _text(document.get("name"))
    if name is None:
        raise _semantic("ODCS contract declares no `name`", source_label)

    objects = _schema_objects(document.get("schema"), source_label=source_label)
    if extra_quality:
        objects = tuple(
            OdcsSchemaObject(
                name=obj.name,
                physical_name=obj.physical_name,
                logical_type=obj.logical_type,
                physical_type=obj.physical_type,
                description=obj.description,
                properties=obj.properties,
                quality=obj.quality + extra_quality.get(obj.name, ()),
                governance=obj.governance,
            )
            for obj in objects
        )

    description = document.get("description")
    return OdcsContract(
        api_version=api_version,
        name=name,
        contract_id=_text(document.get("id")),
        version=_text(document.get("version")),
        status=_text(document.get("status")),
        domain=_text(document.get("domain")),
        tenant=_text(document.get("tenant")),
        data_product=_text(document.get("dataProduct")),
        description=dict(description) if isinstance(description, Mapping) else {},
        schema_objects=objects,
        governance=_carried(document, _CONTRACT_STRUCTURAL_KEYS),
        fileset=dict(fileset) if fileset else {},
        raw=raw,
    )


def parse_odcs(raw: str, *, source_label: Optional[str] = None) -> OdcsContract:
    """Parse one ODCS data contract.

    Args:
        raw: The contract text (YAML or its JSON serialization).
        source_label: The document's name, for error messages.

    Returns:
        The parsed contract.

    Raises:
        OdcsParseError: With the taxonomy codes described in the module docstring.
    """
    document = _load_document(raw, source_label=source_label)
    return _build_contract(document, raw=raw, source_label=source_label)


# ---------------------------------------------------------------------------
# File-set composition
# ---------------------------------------------------------------------------


def _relative_member(url: str) -> Optional[str]:
    """Return the file-set member a relative ``authoritativeDefinitions`` URL names.

    Args:
        url: The declared URL.

    Returns:
        The normalized member path, or ``None`` when the URL is absolute (a
        ``https://`` governance link, which import records and never fetches).

    Raises:
        OdcsParseError: ``INPUT_UNSAFE_CONSTRUCT`` when a relative URL escapes the
            imported set with ``..``.
    """
    if "://" in url or url.startswith(("mailto:", "urn:", "#", "/")):
        return None
    normalized = posixpath.normpath(url)
    if normalized.startswith(".."):
        raise OdcsParseError(
            f"ODCS `authoritativeDefinitions` URL {url!r} points outside the imported "
            "file set",
            code="INPUT_UNSAFE_CONSTRUCT",
        )
    return normalized


def _definition_urls(document: Any) -> List[str]:
    """Collect every ``authoritativeDefinitions[].url`` a loaded contract declares."""
    urls: List[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, Mapping):
            declared = node.get("authoritativeDefinitions")
            if _is_list(declared):
                for entry in declared:
                    if isinstance(entry, Mapping):
                        url = _text(entry.get("url"))
                        if url:
                            urls.append(url)
            for value in node.values():
                _walk(value)
        elif _is_list(node):
            for value in node:
                _walk(value)

    _walk(document)
    return urls


def parse_odcs_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> OdcsContract:
    """Parse an ODCS contract that is published across several files.

    ODCS has no include directive, so a contract that spans files is composed by being
    *imported together*. Two member roles are recognised, and both are things data
    platforms actually do:

    * a **quality pack** — a YAML file carrying a ``quality[]`` list for one named
      schema object, maintained on its own review cadence — is merged into that
      object's rules;
    * a **referenced definition** — a member named by a relative
      ``authoritativeDefinitions[].url`` — is recorded as resolved. Its content is
      *not* expanded into the canonical model; that is the declared
      ``odcs.authoritative_definition`` limit.

    Any other member is listed and otherwise left alone, so a ``README`` beside a
    contract is not an error.

    Args:
        members: Member path → text, as the intake fileset supplied them.
        root: The member holding the contract.
        source_label: Fallback label when the set names no root.

    Returns:
        The composed contract, with its ``fileset`` record populated.

    Raises:
        OdcsParseError: ``INPUT_SEMANTIC_INVALID`` when the root is missing, when a
            second contract appears in the set, or when a quality pack names an
            object (or a contract id) the root does not declare.
    """
    if root not in members:
        raise _semantic(
            f"ODCS file set is missing its root contract {root!r}", source_label or root
        )
    root_text = members[root]
    document = _load_document(root_text, source_label=root)
    if not is_odcs_document(document):
        # Build the contract anyway so the mismatch is reported with the same wording
        # (and the same code) a single-document import would produce.
        return _build_contract(document, raw=root_text, source_label=root)
    contract_id = _text(document.get("id")) if isinstance(document, Mapping) else None
    declared_objects = {
        _text(entry.get("name"))
        for entry in (document.get("schema") or [])
        if isinstance(entry, Mapping)
    }

    quality_packs: Dict[str, Dict[str, Any]] = {}
    extra_quality: Dict[str, Tuple[OdcsQualityRule, ...]] = {}
    for member in sorted(members):
        if member == root:
            continue
        try:
            loaded = _load_document(members[member], source_label=member)
        except OdcsParseError:
            # A member that is not a document at all (a README, a licence) is simply a
            # member; only the root has to be readable.
            continue
        if is_odcs_document(loaded):
            raise _semantic(
                f"ODCS file set holds a second data contract ({member!r}); a set composes "
                f"one contract with its supporting files, not several contracts",
                source_label or root,
            )
        if not isinstance(loaded, Mapping):
            continue
        rules_raw = loaded.get("quality")
        if rules_raw is None:
            continue
        pack_contract = _text(loaded.get("contractId"))
        if pack_contract and contract_id and pack_contract != contract_id:
            raise _semantic(
                f"quality pack {member!r} declares `contractId: {pack_contract}`, which is "
                f"not this contract ({contract_id})",
                source_label or root,
            )
        target = _text(loaded.get("schema"))
        if target is None or target not in declared_objects:
            raise _semantic(
                f"quality pack {member!r} names schema object {target!r}, which the "
                f"contract does not declare",
                source_label or root,
            )
        rules = _quality_rules(rules_raw, where=f"`{member}`", source_label=member)
        extra_quality[target] = extra_quality.get(target, ()) + rules
        quality_packs[member] = {"schema": target, "rules": len(rules)}

    resolved: Dict[str, str] = {}
    for url in _definition_urls(document):
        member = _relative_member(url)
        if member is not None and member in members:
            resolved[url] = member

    fileset: Dict[str, Any] = {"root": root, "members": sorted(members)}
    if quality_packs:
        fileset["quality_packs"] = quality_packs
    if resolved:
        fileset["resolved_definitions"] = dict(sorted(resolved.items()))
    return _build_contract(
        document,
        raw=root_text,
        source_label=source_label or root,
        fileset=fileset,
        extra_quality=extra_quality,
    )
