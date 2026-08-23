"""dbt project reader — FMT-5.4 (#5442).

Reads the two ways an analytics team describes its warehouse — a hand-written
``schema.yml`` *properties file* (alone, or as a project set rooted at
``dbt_project.yml``) and the ``manifest.json`` dbt compiles — into one
:class:`~app.dbt_resources.DbtProject`. Detection, version gating, structural validation,
lineage resolution and multi-file composition all live here; the canonical projection
lives in :mod:`app.dbt_normalizer`.

**Error grounding.** A failure this reader can classify carries its taxonomy code; one it
cannot carries **none**, which hands the classification to
:func:`app.import_source_pipeline._classify_parse_failure` and is what makes a UTF-16
upload read as ``INPUT_ENCODING_INVALID`` and an ODCS contract handed to this adapter read
as ``FORMAT_MISMATCH``. The codes this reader sets itself are:

``INPUT_SEMANTIC_INVALID``
    A document with *standing* — one that carries a dbt marker — that describes no data:
    a properties file with no ``models``/``sources``/``seeds``/``snapshots``/
    ``semantic_models``, a resource with no ``name``, a duplicate resource name, a
    manifest node that is not a mapping.
``FORMAT_VERSION_UNSUPPORTED``
    A properties file that declares a ``version:`` other than 2, or a manifest whose
    ``dbt_schema_version`` is outside the readable line — see
    :func:`~app.dbt_resources.resolve_properties_version` and
    :func:`~app.dbt_resources.resolve_manifest_schema_version`.
``INPUT_REFERENCE_UNRESOLVED``
    A ``relationships`` test or a ``foreign_key`` constraint names a model the import
    does not contain. Those two are the edges this reader *records*, so a dangling one is
    refused rather than silently dropped. Every other ``ref()``/``source()`` — a
    semantic model's ``model:``, an exposure's ``depends_on``, a call scraped out of a
    member's SQL — is recorded as unresolved and carried, because an import is not
    obliged to contain a project's whole upstream.
``INPUT_TRUNCATED``
    The stream ended while a construct was still open. This is a *parser state*, not a
    message heuristic: the loader reports the position it gave up at, and a position at
    the end of the input means the document ran out rather than being wrong.
``INPUT_DEPTH_LIMIT`` / ``INPUT_TOO_LARGE`` / ``INPUT_ENTITY_LIMIT``
    The shared intake guards, plus this reader's own resource and column ceilings.

**Standing, and why the ODCS negative reads as a mismatch.** A document has standing here
when it carries a dbt marker: ``version: 2`` with a properties list, a distinctive
properties key, ``config-version`` (a ``dbt_project.yml``), or a manifest's
``metadata.dbt_schema_version``. A document with standing that is *wrong* is refused with
a code — this reader is the one qualified to judge it. A document with no standing is
refused with **no** code, so the pipeline asks who else claims it; an ODCS contract is
claimed by the ODCS adapter at 0.95 and the failure is reported as ``FORMAT_MISMATCH``.
"""

from __future__ import annotations

import json
import posixpath
import re
from dataclasses import replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import yaml

from .dbt_resources import (
    MAX_ALIAS_COST,
    MAX_COLUMNS,
    MAX_RESOURCES,
    PROPERTIES_VERSION,
    RESOURCE_KINDS,
    DbtColumn,
    DbtParseError,
    DbtProject,
    DbtRef,
    DbtRelationship,
    DbtResource,
    DbtSurface,
    DbtTest,
    resolve_manifest_schema_version,
    resolve_properties_version,
)
from .intake_resource_guard import (
    IntakeLimitError,
    IntakeLimits,
    effective_intake_limits,
    guard_document_text,
)

__all__ = [
    "DBT_SUFFIXES",
    "is_dbt",
    "is_dbt_document",
    "parse_dbt",
    "parse_dbt_fileset",
]

#: File extensions a dbt description travels under. dbt defines no suffix of its own — a
#: properties file is "a YAML file in the project" — so these are the serializations plus
#: ``.sql``, which only ever appears as a *member* of a project set.
DBT_SUFFIXES: Tuple[str, ...] = (".yml", ".yaml", ".json", ".sql")

#: Properties-file keys that hold a list of resources.
_PROPERTIES_KEYS: Tuple[str, ...] = (
    "models",
    "sources",
    "seeds",
    "snapshots",
    "semantic_models",
    "exposures",
    "metrics",
    "saved_queries",
    "unit_tests",
    "analyses",
    "macros",
    "groups",
)

#: Properties keys distinctive enough to claim a document on their own, without the
#: ``version: 2`` marker beside them. ``models``/``sources``/``metrics`` are words half
#: the configuration world uses; ``semantic_models`` and ``snapshots`` are dbt's.
_DISTINCTIVE_KEYS: Tuple[str, ...] = (
    "semantic_models",
    "snapshots",
    "seeds",
    "exposures",
    "saved_queries",
    "unit_tests",
)

#: Properties keys whose entries become canonical types. The rest describe consumption
#: (exposures, metrics) or the build (macros, analyses) and are carried.
_STRUCTURAL_KEYS: Tuple[str, ...] = (
    "models",
    "sources",
    "seeds",
    "snapshots",
    "semantic_models",
)

#: ``dbt_project.yml`` keys that identify it as the project file rather than a properties
#: file. ``config-version`` is the reliable one; the path lists are corroboration.
_PROJECT_KEYS: Tuple[str, ...] = (
    "config-version",
    "profile",
    "model-paths",
    "source-paths",
    "seed-paths",
    "macro-paths",
    "target-path",
)

#: Lower-cased substrings a document must carry before this reader will even try to load
#: it. Deliberately cheap: detection runs every adapter's sniffer over every upload.
_TEXT_MARKERS: Tuple[str, ...] = (
    "models:",
    "sources:",
    "seeds:",
    "snapshots:",
    "exposures:",
    "semantic_models:",
    "config-version",
    "dbt_schema_version",
    '"nodes"',
)

#: Resource-level keys the properties reader consumes structurally; everything else a
#: model/seed/snapshot declares is carried verbatim.
_RESOURCE_STRUCTURAL_KEYS = frozenset(
    {
        "name",
        "description",
        "columns",
        "tests",
        "data_tests",
        "config",
        "constraints",
        "database",
        "schema",
        "alias",
        "identifier",
        "versions",
        "latest_version",
        "freshness",
        "loaded_at_field",
    }
)

#: Column-level keys the properties reader consumes structurally.
_COLUMN_STRUCTURAL_KEYS = frozenset(
    {"name", "description", "data_type", "tests", "data_tests", "constraints"}
)

#: Semantic-model keys the properties reader consumes structurally.
_SEMANTIC_STRUCTURAL_KEYS = frozenset(
    {"name", "description", "entities", "dimensions", "measures"}
)

#: The three member lists a semantic model declares → the ``role`` each member records.
#: Spelled out rather than derived by trimming an ``s``, because ``entities`` does not
#: singularize that way and a silently wrong role is one nothing downstream can match on.
_SEMANTIC_MEMBER_ROLES: Dict[str, str] = {
    "entities": "entity",
    "dimensions": "dimension",
    "measures": "measure",
}

#: Generic tests whose ``to:``/``field:`` arguments name an edge this reader records — and
#: therefore an edge whose target must exist in the import.
_RELATIONSHIP_TEST = "relationships"

#: Constraint types that name another relation.
_FOREIGN_KEY_CONSTRAINT = "foreign_key"

#: ``ref('model')`` / ``ref('pkg', 'model')`` / ``ref('model', v=2)`` and
#: ``source('src', 'table')``, as they appear in YAML strings and in model SQL.
_REF_CALL_RE = re.compile(
    r"\b(?P<fn>ref|source)\s*\(\s*(?P<args>[^()]*?)\s*\)",
    re.IGNORECASE,
)

#: One quoted argument of a ``ref()``/``source()`` call, or a ``v=2``/``version=2`` kwarg.
_REF_ARG_RE = re.compile(
    r"""(?:(?P<kw>v|version)\s*=\s*)?(?:'(?P<sq>[^']*)'|"(?P<dq>[^"]*)"|(?P<bare>[A-Za-z0-9_.\-]+))"""
)

#: Manifest ``resource_type`` values that describe data and become canonical types.
_MANIFEST_RESOURCE_TYPES = frozenset({"model", "seed", "snapshot"})

#: Manifest ``resource_type`` values that carry a data test.
_MANIFEST_TEST_TYPES = frozenset({"test", "unit_test"})

#: Manifest top-level keys the reader consumes structurally.
_MANIFEST_STRUCTURAL_KEYS = frozenset(
    {"metadata", "nodes", "sources", "exposures", "metrics", "semantic_models"}
)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _looks_like_dbt_text(text: str) -> bool:
    """Whether ``text`` carries a dbt marker, without parsing it."""
    lowered = text.lower()
    return any(marker in lowered for marker in _TEXT_MARKERS)


def _is_truncation_mark(index: Optional[int], text: str) -> bool:
    """Whether a loader gave up at (or past) the end of the input.

    A position at the end means a construct — a quoted scalar, a flow collection, an
    object — was still open when the bytes ran out, which is a truncated upload. A
    position anywhere earlier is a document that is wrong where it stands.

    Args:
        index: The loader's reported offset, or ``None`` when it reported none.
        text: The source text the error came from.

    Returns:
        ``True`` when the failure is a truncation.
    """
    return isinstance(index, int) and index >= len(text.rstrip())


def _intake_limits() -> IntakeLimits:
    """Return the intake bounds a dbt document is read under.

    Every bound is the deployment's shared default except the YAML alias budget, which is
    raised to :data:`~app.dbt_resources.MAX_ALIAS_COST` — see that constant for why a dbt
    properties file needs more anchor room than an OpenAPI document, and why raising this
    one bound does not weaken the expansion defence.
    """
    shared = effective_intake_limits()
    return replace(shared, max_alias_cost=max(shared.max_alias_cost, MAX_ALIAS_COST))


def _load_document(text: str, *, source_label: Optional[str] = None) -> Any:
    """Load one YAML (or JSON) document, applying the shared intake guards.

    A compiled manifest is JSON, and JSON is a subset of YAML, so one loader reads both —
    but a manifest is large and ``json.loads`` is an order of magnitude faster on it, so a
    document whose first non-space byte is ``{`` is tried as JSON first and falls back to
    YAML if that is not what it is.

    Args:
        text: The source text.
        source_label: The document's name, for error messages.

    Returns:
        The loaded value, of whatever type the document had.

    Raises:
        DbtParseError: With the guard's code for an oversized/too-deep document,
            ``INPUT_TRUNCATED`` for a stream that ended mid-construct, and **no code** for
            any other syntax error.
    """
    try:
        guard_document_text(text, source_label=source_label, limits=_intake_limits())
    except IntakeLimitError as exc:
        raise DbtParseError(str(exc), code=exc.code) from exc
    where = f" in {source_label}" if source_label else ""
    if text.lstrip()[:1] == "{":
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            if _is_truncation_mark(exc.pos, text):
                raise DbtParseError(
                    f"dbt manifest{where} ends while a value is still open — the upload is "
                    f"truncated: {exc}",
                    code="INPUT_TRUNCATED",
                ) from exc
            raise DbtParseError(f"Invalid JSON{where}: {exc}") from exc
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        if _is_truncation_mark(getattr(mark, "index", None), text):
            raise DbtParseError(
                f"dbt document{where} ends while a value is still open — the upload is "
                f"truncated: {exc}",
                code="INPUT_TRUNCATED",
            ) from exc
        raise DbtParseError(f"Invalid YAML{where}: {exc}") from exc


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def _is_list(value: Any) -> bool:
    """Whether ``value`` is a YAML/JSON *list*.

    ``str`` and ``bytes`` are sequences too, and treating one as a list of items is the
    classic way to turn a mis-typed scalar into a silently wrong document.
    """
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes))


def _is_manifest(document: Any) -> bool:
    """Whether a loaded value is a compiled dbt ``manifest.json``."""
    if not isinstance(document, Mapping):
        return False
    metadata = document.get("metadata")
    if isinstance(metadata, Mapping) and metadata.get("dbt_schema_version") is not None:
        return True
    return isinstance(document.get("nodes"), Mapping) and any(
        isinstance(document.get(key), Mapping) for key in ("parent_map", "child_map", "sources")
    )


def _is_properties(document: Any) -> bool:
    """Whether a loaded value is a dbt properties (``schema.yml``) file."""
    if not isinstance(document, Mapping):
        return False
    if any(_is_list(document.get(key)) for key in _DISTINCTIVE_KEYS):
        return True
    declared = document.get("version")
    if declared == 2 and not isinstance(declared, bool):
        return any(_is_list(document.get(key)) for key in _PROPERTIES_KEYS)
    return False


def _is_project_file(document: Any) -> bool:
    """Whether a loaded value is a ``dbt_project.yml``.

    A project file and a properties file are both "a YAML mapping in a dbt project", and
    both spell ``models:`` — but a project file's ``models:`` is a *mapping* of
    per-directory build defaults, not a list of model definitions. ``config-version`` is
    what tells them apart, and requiring it is what stops a properties file's build config
    from being read as a project.
    """
    if not isinstance(document, Mapping):
        return False
    if document.get("config-version") is not None:
        return True
    return isinstance(document.get("name"), str) and sum(
        1 for key in _PROJECT_KEYS if document.get(key) is not None
    ) >= 2


def is_dbt_document(document: Any) -> bool:
    """Whether a loaded value is one of dbt's three descriptions of a project.

    Args:
        document: The loaded value.

    Returns:
        ``True`` for a properties file, a compiled manifest, or a ``dbt_project.yml``.
    """
    return _is_manifest(document) or _is_properties(document) or _is_project_file(document)


def is_dbt(content: str) -> bool:
    """Whether ``content`` looks like a dbt description of a project.

    A malformed document that still carries a dbt marker is claimed: routing it here is
    what makes it fail as a malformed *dbt* document instead of being reported as somebody
    else's format.

    Args:
        content: The candidate document text.

    Returns:
        ``True`` when this reader claims the text.
    """
    if not content or not isinstance(content, str) or not content.strip():
        return False
    if not _looks_like_dbt_text(content):
        return False
    try:
        document = _load_document(content)
    except DbtParseError:
        # Broken YAML/JSON that still carries a dbt marker is ours to reject — but only
        # if the marker is one nothing else spells. `models:` alone is not enough.
        lowered = content.lower()
        return any(
            marker in lowered
            for marker in ("dbt_schema_version", "config-version", "semantic_models:", "snapshots:")
        )
    return is_dbt_document(document)


# ---------------------------------------------------------------------------
# Small readers
# ---------------------------------------------------------------------------


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


def _project_name(source_label: Optional[str]) -> str:
    """Derive a project name for a document that declares none.

    A properties file states no project name — only ``dbt_project.yml`` and a compiled
    manifest do — so a lone ``schema.yml`` is named after itself: the file's stem, without
    its directory or its extension. Using the raw source label instead would push a path
    (``models/marts/schema.yml``) into the canonical identity, where every downstream
    emitter would have to sanitize it.

    Args:
        source_label: The document's name, as intake supplied it.

    Returns:
        The derived name, or ``"dbt project"`` when there is nothing to derive one from.
    """
    if not source_label or not source_label.strip():
        return "dbt project"
    stem = posixpath.splitext(posixpath.basename(source_label.strip().replace("\\", "/")))[0]
    return stem or "dbt project"


def _semantic(message: str, source_label: Optional[str]) -> DbtParseError:
    """Build an ``INPUT_SEMANTIC_INVALID`` error naming the source document."""
    where = f" ({source_label})" if source_label else ""
    return DbtParseError(f"{message}{where}", code="INPUT_SEMANTIC_INVALID")


def _flatten_entries(raw: Any) -> List[Any]:
    """Flatten one level of nested lists out of a YAML sequence.

    dbt's ``columns:`` is the one place a properties file routinely uses YAML anchors for
    composition: ``- *identity_columns`` splices a *list* into a list of columns, so the
    loaded value is a list whose members are sometimes lists. Flattening here is what
    makes an anchor group behave as the shared column group its author meant, rather than
    as one unnamed column.

    Args:
        raw: The loaded sequence value.

    Returns:
        The flattened entries; an empty list when ``raw`` is not a sequence.
    """
    if not _is_list(raw):
        return []
    flattened: List[Any] = []
    for entry in raw:
        if _is_list(entry):
            flattened.extend(entry)
        else:
            flattened.append(entry)
    return flattened


def _parse_ref_expression(expression: Any) -> Optional[DbtRef]:
    """Parse the first ``ref()``/``source()`` call in a YAML string.

    dbt writes a lineage target as a Jinja call inside a plain string —
    ``to: ref('customers')`` — so a reader has to read the call rather than the value.

    Args:
        expression: The declared value, of whatever type it had.

    Returns:
        The parsed reference, or ``None`` when the value names no call.
    """
    if not isinstance(expression, str):
        return None
    match = _REF_CALL_RE.search(expression)
    return _ref_from_match(match) if match else None


def _ref_from_match(match: "re.Match[str]") -> Optional[DbtRef]:
    """Build a :class:`DbtRef` from a matched ``ref()``/``source()`` call."""
    function = match.group("fn").lower()
    positional: List[str] = []
    version: Optional[str] = None
    for argument in _REF_ARG_RE.finditer(match.group("args") or ""):
        value = argument.group("sq") or argument.group("dq") or argument.group("bare") or ""
        if argument.group("kw"):
            version = value
        elif value:
            positional.append(value)
    if not positional:
        return None
    raw = match.group(0)
    if function == "source":
        if len(positional) < 2:
            return None
        return DbtRef(
            kind="source", name=positional[1], source_name=positional[0], raw=raw
        )
    if len(positional) >= 2:
        return DbtRef(kind="ref", name=positional[1], package=positional[0], version=version, raw=raw)
    return DbtRef(kind="ref", name=positional[0], version=version, raw=raw)


def _scrape_refs(text: str) -> Tuple[DbtRef, ...]:
    """Collect every ``ref()``/``source()`` call in a block of model SQL.

    The SQL itself is never parsed, compiled or executed — only the Jinja calls are read,
    because those are the project's declared lineage.

    Args:
        text: The model's SQL.

    Returns:
        The parsed references, in source order, de-duplicated by target.
    """
    seen: Set[Tuple[str, str]] = set()
    refs: List[DbtRef] = []
    for match in _REF_CALL_RE.finditer(text):
        ref = _ref_from_match(match)
        if ref is None:
            continue
        identity = (ref.kind, ref.target)
        if identity in seen:
            continue
        seen.add(identity)
        refs.append(ref)
    return tuple(refs)


def _read_tests(
    raw: Any, *, column: Optional[str], where: str, source_label: Optional[str]
) -> Tuple[DbtTest, ...]:
    """Read a properties-file ``tests:``/``data_tests:`` list.

    dbt spells a test three ways in the same list: a bare string (``unique``), a
    single-key mapping (``accepted_values: {values: [...]}``), and — through a YAML
    anchor — a mapping spliced in from elsewhere. All three land here.

    Args:
        raw: The declared value.
        column: The column the tests belong to, or ``None`` for a resource-level list.
        where: The owning node, for error messages.
        source_label: The document's name, for error messages.

    Returns:
        The parsed tests, in declaration order.

    Raises:
        DbtParseError: ``INPUT_SEMANTIC_INVALID`` when the value is not a list, or when an
            entry is neither a string nor a single-key mapping.
    """
    if raw is None:
        return ()
    if not _is_list(raw):
        raise _semantic(f"`tests` on {where} must be a list of tests", source_label)
    tests: List[DbtTest] = []
    for entry in _flatten_entries(raw):
        if isinstance(entry, str):
            name = entry.strip()
            if not name:
                raise _semantic(f"a test on {where} declares no name", source_label)
            tests.append(DbtTest(name=name, column=column, definition=entry))
            continue
        if not isinstance(entry, Mapping) or len(entry) != 1:
            raise _semantic(
                f"a test on {where} must be a test name or a single-key mapping of a test "
                "name to its arguments",
                source_label,
            )
        (name, arguments), = entry.items()
        if not isinstance(name, str) or not name.strip():
            raise _semantic(f"a test on {where} declares no name", source_label)
        options = dict(arguments) if isinstance(arguments, Mapping) else {}
        tests.append(
            DbtTest(
                name=name.strip(),
                column=column,
                arguments=options,
                severity=_severity_of(options),
                definition=dict(entry),
            )
        )
    return tuple(tests)


def _severity_of(arguments: Mapping[str, Any]) -> Optional[str]:
    """Return a test's declared severity, from ``severity`` or ``config.severity``."""
    config = arguments.get("config")
    declared = arguments.get("severity")
    if declared is None and isinstance(config, Mapping):
        declared = config.get("severity")
    text = _text(declared)
    return text.lower() if text else None


class _ResourceReader:
    """Reads resources out of properties documents, enforcing the import's ceilings.

    The ceilings are this reader's own rather than the shared intake guard's: a project set
    composes several documents into one import, so the totals that matter are the set's,
    not any one member's.
    """

    def __init__(self, *, source_label: Optional[str]) -> None:
        self._source_label = source_label
        self._resources: List[DbtResource] = []
        self._keys: Dict[str, str] = {}
        self._columns = 0

    @property
    def resources(self) -> Tuple[DbtResource, ...]:
        """The resources read so far, in declaration order."""
        return tuple(self._resources)

    def add(self, resource: DbtResource, *, member: Optional[str] = None) -> None:
        """Record one resource, refusing a duplicate key.

        Args:
            resource: The resource to record.
            member: The file-set member it came from, for error messages.

        Raises:
            DbtParseError: ``INPUT_ENTITY_LIMIT`` past :data:`MAX_RESOURCES`;
                ``INPUT_SEMANTIC_INVALID`` when the key is already taken — canonical types
                are keyed by name, so the second would overwrite the first.
        """
        if len(self._resources) >= MAX_RESOURCES:
            raise DbtParseError(
                f"dbt import declares more than {MAX_RESOURCES} resources",
                code="INPUT_ENTITY_LIMIT",
            )
        if resource.kind not in RESOURCE_KINDS:
            raise KeyError(f"unknown dbt resource kind: {resource.kind}")
        if resource.key in self._keys:
            first = self._keys[resource.key]
            where = f" in {member}" if member else ""
            raise _semantic(
                f"dbt import declares {resource.kind} {resource.name!r}{where} twice "
                f"(first as {first}); canonical types are keyed by name, so the second "
                "would overwrite the first",
                self._source_label,
            )
        self._keys[resource.key] = f"{resource.kind} {resource.name!r}"
        self._resources.append(replace(resource, position=len(self._resources)))

    def count_columns(self, added: int) -> None:
        """Charge ``added`` columns against the import's column ceiling.

        Raises:
            DbtParseError: ``INPUT_ENTITY_LIMIT`` past :data:`MAX_COLUMNS`.
        """
        self._columns += added
        if self._columns > MAX_COLUMNS:
            raise DbtParseError(
                f"dbt import declares more than {MAX_COLUMNS} columns",
                code="INPUT_ENTITY_LIMIT",
            )

    # -- properties surface -------------------------------------------------

    def read_columns(self, raw: Any, *, where: str) -> Tuple[DbtColumn, ...]:
        """Read a properties-file ``columns:`` list.

        Args:
            raw: The declared value.
            where: The owning resource, for error messages.

        Returns:
            The parsed columns, in declaration order.

        Raises:
            DbtParseError: ``INPUT_SEMANTIC_INVALID`` for a malformed list, a column with
                no name, or a duplicate column name.
        """
        if raw is None:
            return ()
        if not _is_list(raw):
            raise _semantic(f"`columns` on {where} must be a list", self._source_label)
        columns: List[DbtColumn] = []
        seen: Set[str] = set()
        for entry in _flatten_entries(raw):
            if not isinstance(entry, Mapping):
                raise _semantic(
                    f"`columns` on {where} must be a list of mappings", self._source_label
                )
            name = _text(entry.get("name"))
            if name is None:
                raise _semantic(f"a column of {where} declares no `name`", self._source_label)
            if name in seen:
                raise _semantic(
                    f"{where} declares the column {name!r} twice; canonical members are "
                    "keyed by name, so the second would overwrite the first",
                    self._source_label,
                )
            seen.add(name)
            tests = entry.get("tests")
            if tests is None:
                tests = entry.get("data_tests")
            constraints = entry.get("constraints")
            columns.append(
                DbtColumn(
                    name=name,
                    description=_text(entry.get("description")),
                    data_type=_text(entry.get("data_type")),
                    tests=_read_tests(
                        tests,
                        column=name,
                        where=f"`{where}.{name}`",
                        source_label=self._source_label,
                    ),
                    constraints=tuple(
                        dict(item) for item in _flatten_entries(constraints) if isinstance(item, Mapping)
                    ),
                    governance=_carried(entry, _COLUMN_STRUCTURAL_KEYS),
                )
            )
        self.count_columns(len(columns))
        return tuple(columns)

    def read_resource(
        self, entry: Any, *, kind: str, where: str, inherited: Optional[Mapping[str, Any]] = None
    ) -> DbtResource:
        """Read one ``models[]``/``seeds[]``/``snapshots[]``/source-table entry.

        Args:
            entry: The declared mapping.
            kind: The resource kind — one of
                :data:`~app.dbt_resources.RESOURCE_KINDS`.
            where: The owning list, for error messages.
            inherited: Source-level defaults a table inherits (``database``, ``schema``,
                ``loaded_at_field``, ``freshness``), when ``kind`` is ``source``.

        Returns:
            The parsed resource, with ``position`` still unset — :meth:`add` assigns it.

        Raises:
            DbtParseError: ``INPUT_SEMANTIC_INVALID`` for a malformed entry or one with
                no ``name``.
        """
        if not isinstance(entry, Mapping):
            raise _semantic(f"`{where}` must be a list of mappings", self._source_label)
        name = _text(entry.get("name"))
        if name is None:
            raise _semantic(f"an entry of `{where}` declares no `name`", self._source_label)
        source_name = _text((inherited or {}).get("source_name"))
        key = f"{source_name}.{name}" if kind == "source" and source_name else name
        tests = entry.get("tests")
        if tests is None:
            tests = entry.get("data_tests")
        relation = {
            label: entry.get(label, (inherited or {}).get(label))
            for label in ("database", "schema", "alias", "identifier")
            if entry.get(label, (inherited or {}).get(label)) is not None
        }
        freshness = self._freshness(entry, inherited)
        versions = {
            label: entry[label] for label in ("versions", "latest_version") if label in entry
        }
        config = entry.get("config")
        constraints = entry.get("constraints")
        return DbtResource(
            kind=kind,
            name=name,
            key=key,
            source_name=source_name if kind == "source" else None,
            description=_text(entry.get("description")),
            columns=self.read_columns(entry.get("columns"), where=name),
            tests=_read_tests(
                tests, column=None, where=f"`{name}`", source_label=self._source_label
            ),
            constraints=tuple(
                dict(item) for item in _flatten_entries(constraints) if isinstance(item, Mapping)
            ),
            config=dict(config) if isinstance(config, Mapping) else {},
            relation=relation,
            freshness=freshness,
            versions=versions,
            governance=_carried(entry, _RESOURCE_STRUCTURAL_KEYS),
        )

    @staticmethod
    def _freshness(
        entry: Mapping[str, Any], inherited: Optional[Mapping[str, Any]]
    ) -> Dict[str, Any]:
        """Compose a source table's freshness block with its source's defaults.

        dbt lets a source state one freshness policy and a table override it; the
        ``loaded_at_field`` the policy is measured on is inherited the same way.
        """
        base = dict(inherited or {})
        block: Dict[str, Any] = {}
        declared = entry.get("freshness", base.get("freshness"))
        if isinstance(declared, Mapping):
            block["freshness"] = dict(declared)
        loaded_at = _text(entry.get("loaded_at_field")) or _text(base.get("loaded_at_field"))
        if loaded_at:
            block["loaded_at_field"] = loaded_at
        return block

    def read_semantic_model(self, entry: Any, *, where: str) -> DbtResource:
        """Read one ``semantic_models[]`` entry as an additional layer.

        A semantic model's entities, dimensions and measures are the layer the metrics
        engine addresses; each becomes one column so the layer is visible and diffable,
        and the declaring block travels with it.

        Args:
            entry: The declared mapping.
            where: The owning list, for error messages.

        Returns:
            The parsed resource, keyed ``semantic_model.<name>`` so a semantic model and a
            model of the same name cannot collide.

        Raises:
            DbtParseError: ``INPUT_SEMANTIC_INVALID`` for a malformed entry or one with no
                ``name``.
        """
        if not isinstance(entry, Mapping):
            raise _semantic(f"`{where}` must be a list of mappings", self._source_label)
        name = _text(entry.get("name"))
        if name is None:
            raise _semantic(f"an entry of `{where}` declares no `name`", self._source_label)
        columns: List[DbtColumn] = []
        seen: Set[str] = set()
        for source_key, role in _SEMANTIC_MEMBER_ROLES.items():
            for member in _flatten_entries(entry.get(source_key)):
                if not isinstance(member, Mapping):
                    raise _semantic(
                        f"`{source_key}` on semantic model {name!r} must be a list of mappings",
                        self._source_label,
                    )
                member_name = _text(member.get("name"))
                if member_name is None:
                    raise _semantic(
                        f"a `{source_key}` entry of semantic model {name!r} declares no `name`",
                        self._source_label,
                    )
                if member_name in seen:
                    raise _semantic(
                        f"semantic model {name!r} declares {member_name!r} twice across its "
                        "entities, dimensions and measures; canonical members are keyed by "
                        "name, so the second would overwrite the first",
                        self._source_label,
                    )
                seen.add(member_name)
                columns.append(
                    DbtColumn(
                        name=member_name,
                        description=_text(member.get("description")),
                        semantic={"role": role, **dict(member)},
                    )
                )
        self.count_columns(len(columns))
        return DbtResource(
            kind="semantic_model",
            name=name,
            key=f"semantic_model.{name}",
            description=_text(entry.get("description")),
            columns=tuple(columns),
            semantic=_carried(entry, _SEMANTIC_STRUCTURAL_KEYS),
        )


# ---------------------------------------------------------------------------
# The properties surface
# ---------------------------------------------------------------------------


def _read_properties_document(
    document: Mapping[str, Any],
    reader: _ResourceReader,
    *,
    member: Optional[str],
    source_label: Optional[str],
) -> Dict[str, Any]:
    """Read one properties document's resources into ``reader``.

    Args:
        document: The loaded properties mapping.
        reader: The shared resource reader for this import.
        member: The file-set member this document came from, for error messages.
        source_label: The import's label, for error messages.

    Returns:
        The document's non-structural halves: ``exposures``, ``metrics`` and every
        remaining top-level key, all verbatim.

    Raises:
        DbtParseError: The properties errors described in the module docstring.
    """
    resolve_properties_version(document.get("version"), source_label=member or source_label)
    for entry in _flatten_entries(document.get("models")):
        reader.add(reader.read_resource(entry, kind="model", where="models"), member=member)
    for entry in _flatten_entries(document.get("seeds")):
        reader.add(reader.read_resource(entry, kind="seed", where="seeds"), member=member)
    for entry in _flatten_entries(document.get("snapshots")):
        reader.add(reader.read_resource(entry, kind="snapshot", where="snapshots"), member=member)
    for entry in _flatten_entries(document.get("sources")):
        if not isinstance(entry, Mapping):
            raise _semantic("`sources` must be a list of mappings", member or source_label)
        source_name = _text(entry.get("name"))
        if source_name is None:
            raise _semantic("a `sources` entry declares no `name`", member or source_label)
        inherited = {
            "source_name": source_name,
            "database": entry.get("database"),
            "schema": entry.get("schema", source_name),
            "loaded_at_field": entry.get("loaded_at_field"),
            "freshness": entry.get("freshness"),
        }
        for table in _flatten_entries(entry.get("tables")):
            reader.add(
                reader.read_resource(
                    table, kind="source", where=f"sources.{source_name}.tables", inherited=inherited
                ),
                member=member,
            )
    for entry in _flatten_entries(document.get("semantic_models")):
        reader.add(reader.read_semantic_model(entry, where="semantic_models"), member=member)

    carried = {
        key: value
        for key, value in document.items()
        if key not in _STRUCTURAL_KEYS and key != "version"
    }
    return {
        "exposures": tuple(
            dict(item) for item in _flatten_entries(carried.pop("exposures", None)) if isinstance(item, Mapping)
        ),
        "metrics": tuple(
            dict(item) for item in _flatten_entries(carried.pop("metrics", None)) if isinstance(item, Mapping)
        ),
        "governance": carried,
    }


# ---------------------------------------------------------------------------
# The manifest surface
# ---------------------------------------------------------------------------


def _read_manifest_columns(raw: Any, *, where: str, source_label: Optional[str]) -> Tuple[DbtColumn, ...]:
    """Read a manifest node's ``columns`` mapping.

    A manifest keys columns by name and repeats the name inside each entry; the mapping's
    insertion order is the declaration order dbt compiled, so it is preserved.

    Args:
        raw: The declared ``columns`` value.
        where: The owning node, for error messages.
        source_label: The document's name, for error messages.

    Returns:
        The parsed columns, in the manifest's order.

    Raises:
        DbtParseError: ``INPUT_SEMANTIC_INVALID`` when ``columns`` is not a mapping of
            mappings.
    """
    if raw is None:
        return ()
    if not isinstance(raw, Mapping):
        raise _semantic(f"`columns` on {where} must be a mapping", source_label)
    columns: List[DbtColumn] = []
    for key, entry in raw.items():
        if not isinstance(entry, Mapping):
            raise _semantic(f"`columns.{key}` on {where} must be a mapping", source_label)
        name = _text(entry.get("name")) or _text(key)
        if name is None:
            raise _semantic(f"a column of {where} declares no `name`", source_label)
        columns.append(
            DbtColumn(
                name=name,
                description=_text(entry.get("description")),
                data_type=_text(entry.get("data_type")),
                constraints=tuple(
                    dict(item)
                    for item in _flatten_entries(entry.get("constraints"))
                    if isinstance(item, Mapping)
                ),
                governance=_carried(entry, _COLUMN_STRUCTURAL_KEYS),
            )
        )
    return tuple(columns)


def _manifest_entries(value: Any) -> List[Dict[str, Any]]:
    """Read one of a manifest's collections as a list of mappings.

    A compiled manifest keys ``exposures``, ``metrics`` and ``semantic_models`` by
    ``unique_id``; a properties file spells the same three as lists. Reading both shapes
    here is what lets the rest of the manifest reader stay indifferent to which it got.

    Args:
        value: The declared collection.

    Returns:
        The member mappings, in the collection's own order; empty for anything else.
    """
    members = value.values() if isinstance(value, Mapping) else _flatten_entries(value)
    return [dict(item) for item in members if isinstance(item, Mapping)]


def _manifest_refs(node: Mapping[str, Any]) -> Tuple[str, ...]:
    """Return the upstream ``unique_id``s a manifest node depends on."""
    depends_on = node.get("depends_on")
    if not isinstance(depends_on, Mapping):
        return ()
    return tuple(str(item) for item in _flatten_entries(depends_on.get("nodes")) if isinstance(item, str))


def _manifest_test(node: Mapping[str, Any], unique_id: str) -> DbtTest:
    """Read one manifest ``test`` node into a :class:`DbtTest`.

    A generic test carries ``test_metadata.name`` and its arguments in
    ``test_metadata.kwargs``; a singular test carries neither and is named by the node.

    Args:
        node: The manifest node.
        unique_id: The node's key, used as a fallback name.

    Returns:
        The parsed test.
    """
    metadata = node.get("test_metadata")
    config = node.get("config")
    severity = None
    if isinstance(config, Mapping):
        severity = _text(config.get("severity"))
    arguments: Dict[str, Any] = {}
    name = _text(node.get("name")) or unique_id
    if isinstance(metadata, Mapping):
        name = _text(metadata.get("name")) or name
        kwargs = metadata.get("kwargs")
        if isinstance(kwargs, Mapping):
            arguments = dict(kwargs)
    return DbtTest(
        name=name,
        column=_text(node.get("column_name")) or _text(arguments.get("column_name")),
        arguments=arguments,
        severity=severity.lower() if severity else None,
        definition={"unique_id": unique_id, **{k: v for k, v in node.items() if k != "depends_on"}},
    )


def _read_manifest(
    document: Mapping[str, Any], *, raw: str, source_label: Optional[str]
) -> DbtProject:
    """Read a compiled ``manifest.json`` into a :class:`DbtProject`.

    Args:
        document: The loaded manifest.
        raw: The source text, retained for the fidelity bag.
        source_label: The document's name, for error messages.

    Returns:
        The read project.

    Raises:
        DbtParseError: The version and structural errors described in the module
            docstring, plus ``INPUT_REFERENCE_UNRESOLVED`` for a test node whose target is
            not in the manifest.
    """
    metadata = document.get("metadata")
    if not isinstance(metadata, Mapping):
        raise _semantic("dbt manifest declares no `metadata` block", source_label)
    schema_version = resolve_manifest_schema_version(
        metadata.get("dbt_schema_version"), source_label=source_label
    )

    reader = _ResourceReader(source_label=source_label)
    by_unique_id: Dict[str, str] = {}
    node_refs: Dict[str, Tuple[str, ...]] = {}
    tests: List[Tuple[DbtTest, Tuple[str, ...]]] = []

    nodes = document.get("nodes")
    if nodes is not None and not isinstance(nodes, Mapping):
        raise _semantic("dbt manifest `nodes` must be a mapping keyed by unique id", source_label)
    sources = document.get("sources")
    if sources is not None and not isinstance(sources, Mapping):
        raise _semantic("dbt manifest `sources` must be a mapping keyed by unique id", source_label)

    for unique_id, node in (nodes or {}).items():
        if not isinstance(node, Mapping):
            raise _semantic(f"dbt manifest node {unique_id!r} is not a mapping", source_label)
        resource_type = _text(node.get("resource_type")) or ""
        if resource_type in _MANIFEST_TEST_TYPES:
            tests.append((_manifest_test(node, str(unique_id)), _manifest_refs(node)))
            continue
        if resource_type not in _MANIFEST_RESOURCE_TYPES:
            continue
        resource = _manifest_resource(
            node, unique_id=str(unique_id), kind=resource_type, reader=reader, source_label=source_label
        )
        reader.add(resource)
        by_unique_id[str(unique_id)] = resource.key
        node_refs[resource.key] = _manifest_refs(node)

    for unique_id, node in (sources or {}).items():
        if not isinstance(node, Mapping):
            raise _semantic(f"dbt manifest source {unique_id!r} is not a mapping", source_label)
        resource = _manifest_resource(
            node, unique_id=str(unique_id), kind="source", reader=reader, source_label=source_label
        )
        reader.add(resource)
        by_unique_id[str(unique_id)] = resource.key

    for entry in _manifest_entries(document.get("semantic_models")):
        reader.add(reader.read_semantic_model(entry, where="semantic_models"))

    resources = _attach_manifest_tests(
        reader.resources, tests=tests, by_unique_id=by_unique_id, source_label=source_label
    )
    resources = tuple(
        _with_depends_on(resource, node_refs.get(resource.key, ()), by_unique_id)
        for resource in resources
    )

    graph = {
        label: _summarize_graph(document.get(label))
        for label in ("parent_map", "child_map", "macros", "disabled", "groups", "selectors")
        if document.get(label)
    }
    return DbtProject(
        surface=DbtSurface.MANIFEST,
        name=_text(metadata.get("project_name")) or _project_name(source_label),
        schema_version=schema_version,
        dbt_version=_text(metadata.get("dbt_version")),
        adapter_type=_text(metadata.get("adapter_type")),
        generated_at=_text(metadata.get("generated_at")),
        resources=resources,
        exposures=tuple(_manifest_entries(document.get("exposures"))),
        metrics=tuple(_manifest_entries(document.get("metrics"))),
        manifest_graph=graph,
        governance={
            key: value
            for key, value in document.items()
            if key not in _MANIFEST_STRUCTURAL_KEYS and key not in graph
        },
        raw=raw,
    )


def _manifest_resource(
    node: Mapping[str, Any],
    *,
    unique_id: str,
    kind: str,
    reader: _ResourceReader,
    source_label: Optional[str],
) -> DbtResource:
    """Read one manifest node (model, seed, snapshot or source) into a resource."""
    name = _text(node.get("name"))
    if name is None:
        raise _semantic(f"dbt manifest node {unique_id!r} declares no `name`", source_label)
    source_name = _text(node.get("source_name")) if kind == "source" else None
    key = f"{source_name}.{name}" if source_name else name
    columns = _read_manifest_columns(node.get("columns"), where=f"`{unique_id}`", source_label=source_label)
    reader.count_columns(len(columns))
    config = node.get("config")
    freshness: Dict[str, Any] = {}
    if isinstance(node.get("freshness"), Mapping):
        freshness["freshness"] = dict(node["freshness"])
    if _text(node.get("loaded_at_field")):
        freshness["loaded_at_field"] = _text(node.get("loaded_at_field"))
    return DbtResource(
        kind=kind,
        name=name,
        key=key,
        unique_id=unique_id,
        source_name=source_name,
        description=_text(node.get("description")),
        columns=columns,
        constraints=tuple(
            dict(item) for item in _flatten_entries(node.get("constraints")) if isinstance(item, Mapping)
        ),
        config=dict(config) if isinstance(config, Mapping) else {},
        relation={
            label: node[label]
            for label in ("database", "schema", "alias", "identifier")
            if node.get(label) is not None
        },
        freshness=freshness,
        versions={
            label: node[label] for label in ("versions", "latest_version", "version") if label in node
        },
        governance=_carried(
            node,
            frozenset(
                _RESOURCE_STRUCTURAL_KEYS
                | {"unique_id", "resource_type", "source_name", "depends_on", "version"}
            ),
        ),
    )


def _attach_manifest_tests(
    resources: Tuple[DbtResource, ...],
    *,
    tests: Sequence[Tuple[DbtTest, Tuple[str, ...]]],
    by_unique_id: Mapping[str, str],
    source_label: Optional[str],
) -> Tuple[DbtResource, ...]:
    """Re-attach a manifest's hoisted test nodes to the resources they test.

    A properties file attaches a test to the column it constrains; ``dbt compile`` hoists
    every test into a node of its own and records the tested resource in
    ``depends_on.nodes``. Putting them back is what makes the two surfaces produce the
    same canonical model.

    Args:
        resources: The resources read from the manifest.
        tests: ``(test, upstream unique ids)`` pairs, one per test node.
        by_unique_id: Manifest ``unique_id`` → canonical resource key.
        source_label: The document's name, for error messages.

    Returns:
        The resources, each carrying the tests that name it.

    Raises:
        DbtParseError: ``INPUT_REFERENCE_UNRESOLVED`` when a test node names no resource
            the manifest contains — a compiled manifest states its own graph, so a test
            whose target is missing means the artifact is incomplete.
    """
    attached: Dict[str, List[DbtTest]] = {}
    for test, upstream in tests:
        targets = [by_unique_id[ref] for ref in upstream if ref in by_unique_id]
        if not targets:
            raise DbtParseError(
                f"dbt manifest test {test.name!r} depends on "
                f"{', '.join(upstream) or 'nothing'}, none of which is a model, seed, "
                f"snapshot or source the manifest declares"
                + (f" ({source_label})" if source_label else ""),
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        attached.setdefault(targets[0], []).append(test)
    return tuple(_with_attached_tests(resource, attached.get(resource.key, ())) for resource in resources)


def _with_attached_tests(
    resource: DbtResource, tests: Sequence[DbtTest]
) -> DbtResource:
    """Distribute a resource's hoisted tests between its columns and the resource itself.

    A test that names a column the resource declares belongs *on that column* — that is
    where a properties file would have written it, and where the projection looks for the
    tests it turns into constraints. A test that names no column, or names one the
    resource does not declare, stays on the resource and becomes a resource-level quality
    rule.

    Args:
        resource: The resource the tests were attached to.
        tests: The tests to distribute.

    Returns:
        The resource carrying them.
    """
    if not tests:
        return resource
    by_column: Dict[str, List[DbtTest]] = {}
    resource_level: List[DbtTest] = []
    declared = {column.name for column in resource.columns}
    for test in tests:
        if test.column and test.column in declared:
            by_column.setdefault(test.column, []).append(test)
        else:
            resource_level.append(test)
    columns = tuple(
        replace(column, tests=column.tests + tuple(by_column[column.name]))
        if column.name in by_column
        else column
        for column in resource.columns
    )
    return replace(resource, columns=columns, tests=resource.tests + tuple(resource_level))


def _with_depends_on(
    resource: DbtResource, upstream: Sequence[str], by_unique_id: Mapping[str, str]
) -> DbtResource:
    """Return ``resource`` carrying the lineage its manifest node declared."""
    if not upstream:
        return resource
    refs = tuple(
        DbtRef(
            kind="source" if unique_id.startswith("source.") else "ref",
            name=by_unique_id.get(unique_id, unique_id).rsplit(".", 1)[-1],
            source_name=(
                by_unique_id[unique_id].rsplit(".", 1)[0]
                if unique_id in by_unique_id and unique_id.startswith("source.")
                else None
            ),
            raw=unique_id,
        )
        for unique_id in upstream
    )
    return replace(resource, depends_on=refs)


def _summarize_graph(value: Any) -> Any:
    """Summarize a manifest's own bookkeeping for the extras bag.

    ``parent_map``/``child_map`` are kept as declared (they *are* the lineage);
    ``macros``/``disabled``/``groups``/``selectors`` are reduced to their member names,
    because their bodies are compiled SQL this reader never reads.
    """
    if isinstance(value, Mapping):
        if all(_is_list(item) for item in value.values()):
            return {str(key): [str(item) for item in items] for key, items in value.items()}
        return sorted(str(key) for key in value)
    if _is_list(value):
        return [str(item) for item in value]
    return value


# ---------------------------------------------------------------------------
# Lineage resolution
# ---------------------------------------------------------------------------


def _resolve_ref(ref: DbtRef, resources: Mapping[str, DbtResource]) -> Optional[DbtResource]:
    """Resolve a ``ref()``/``source()`` against the resources the import contains.

    Args:
        ref: The parsed reference.
        resources: Canonical resource key → resource.

    Returns:
        The resource the reference names, or ``None`` when the import does not contain it.
    """
    # `DbtRef.target` is already the resource key a reference names: the bare model name
    # for a `ref()`, `<source>.<table>` for a `source()`. There is deliberately no fuzzy
    # second attempt — a `ref()` cannot reach a source table, and guessing across the two
    # namespaces would resolve an edge the project did not declare.
    return resources.get(ref.target)


def _relationship_targets(
    resource: DbtResource,
    resources: Mapping[str, DbtResource],
    *,
    source_label: Optional[str],
) -> List[DbtRelationship]:
    """Build the lineage edges one resource declares, refusing any that dangles.

    Two constructs declare an edge this reader records: a ``relationships`` generic test
    on a column, and a ``foreign_key`` constraint on a column or on the model. Both name
    their target with a ``ref()``/``source()`` call, and both are refused when the target
    is not in the import — unlike every other ``ref()``, which is merely recorded, because
    these two are the ones the canonical projection writes down.

    Args:
        resource: The declaring resource.
        resources: Canonical resource key → resource.
        source_label: The import's label, for error messages.

    Returns:
        The resolved edges.

    Raises:
        DbtParseError: ``INPUT_REFERENCE_UNRESOLVED`` when a target is missing, naming the
            declaring column and the reference exactly as it was written.
    """
    edges: List[DbtRelationship] = []
    for column in resource.columns:
        for test in column.tests:
            if test.name.rsplit(".", 1)[-1] != _RELATIONSHIP_TEST:
                continue
            edges.append(
                _edge(
                    resource,
                    columns=(column.name,),
                    to=test.arguments.get("to"),
                    to_columns=_as_names(test.arguments.get("field")),
                    origin="relationships_test",
                    resources=resources,
                    source_label=source_label,
                )
            )
        for constraint in column.constraints:
            if _text(constraint.get("type")) != _FOREIGN_KEY_CONSTRAINT:
                continue
            edges.append(
                _edge(
                    resource,
                    columns=(column.name,),
                    to=constraint.get("to"),
                    to_columns=_as_names(constraint.get("to_columns")),
                    origin="foreign_key_constraint",
                    resources=resources,
                    source_label=source_label,
                )
            )
    for test in resource.tests:
        if test.name.rsplit(".", 1)[-1] != _RELATIONSHIP_TEST:
            continue
        edges.append(
            _edge(
                resource,
                columns=_as_names(test.arguments.get("column_name")),
                to=test.arguments.get("to"),
                to_columns=_as_names(test.arguments.get("field")),
                origin="relationships_test",
                resources=resources,
                source_label=source_label,
            )
        )
    for constraint in resource.constraints:
        if _text(constraint.get("type")) != _FOREIGN_KEY_CONSTRAINT:
            continue
        edges.append(
            _edge(
                resource,
                columns=_as_names(constraint.get("columns")),
                to=constraint.get("to"),
                to_columns=_as_names(constraint.get("to_columns")),
                origin="foreign_key_constraint",
                resources=resources,
                source_label=source_label,
            )
        )
    return edges


def _as_names(value: Any) -> Tuple[str, ...]:
    """Read a ``field``/``columns``/``to_columns`` value as a tuple of column names."""
    if isinstance(value, str):
        return (value.strip(),) if value.strip() else ()
    return tuple(item.strip() for item in _flatten_entries(value) if isinstance(item, str) and item.strip())


def _edge(
    resource: DbtResource,
    *,
    columns: Tuple[str, ...],
    to: Any,
    to_columns: Tuple[str, ...],
    origin: str,
    resources: Mapping[str, DbtResource],
    source_label: Optional[str],
) -> DbtRelationship:
    """Resolve one declared edge, or refuse it."""
    ref = _parse_ref_expression(to)
    where = f" ({source_label})" if source_label else ""
    column_note = f" on `{resource.name}.{columns[0]}`" if columns else f" on `{resource.name}`"
    if ref is None:
        raise DbtParseError(
            f"dbt {origin.replace('_', ' ')}{column_note} declares `to: {to!r}`, which "
            f"names no `ref()` or `source()` target{where}",
            code="INPUT_REFERENCE_UNRESOLVED",
        )
    target = _resolve_ref(ref, resources)
    if target is None:
        raise DbtParseError(
            f"dbt {origin.replace('_', ' ')}{column_note} points at `{ref.raw}`, and this "
            f"import declares no {'source' if ref.kind == 'source' else 'model'} "
            f"{ref.target!r}. Import the file set that declares it, or remove the "
            f"reference{where}",
            code="INPUT_REFERENCE_UNRESOLVED",
        )
    return DbtRelationship(
        from_resource=resource.key,
        from_columns=columns,
        to_ref=ref,
        to_columns=to_columns,
        origin=origin,
    )


def _unresolved_refs(
    resources: Sequence[DbtResource],
    by_key: Mapping[str, DbtResource],
    extra: Sequence[Tuple[str, DbtRef]],
) -> Tuple[Tuple[str, DbtRef], ...]:
    """Collect the recorded references that name nothing in the import.

    These are *not* an error: an import is one file or one file set, and a project's
    upstream commonly lives outside it. They are recorded so the catalog can say which
    edges are known to be dangling rather than silently presenting a partial graph.
    """
    unresolved: List[Tuple[str, DbtRef]] = []
    for resource in resources:
        for ref in resource.depends_on:
            if _resolve_ref(ref, by_key) is None:
                unresolved.append((resource.key, ref))
        model_ref = _parse_ref_expression(resource.semantic.get("model")) if resource.semantic else None
        if model_ref is not None and _resolve_ref(model_ref, by_key) is None:
            unresolved.append((resource.key, model_ref))
    for owner, ref in extra:
        if _resolve_ref(ref, by_key) is None:
            unresolved.append((owner, ref))
    return tuple(unresolved)


def _consumer_refs(entries: Sequence[Mapping[str, Any]], *, label: str) -> List[Tuple[str, DbtRef]]:
    """Read the ``depends_on`` refs an exposure (or a saved query) declares."""
    refs: List[Tuple[str, DbtRef]] = []
    for entry in entries:
        owner = f"{label}.{_text(entry.get('name')) or '?'}"
        declared = entry.get("depends_on")
        candidates = declared.get("nodes") if isinstance(declared, Mapping) else declared
        for item in _flatten_entries(candidates):
            ref = _parse_ref_expression(item)
            if ref is not None:
                refs.append((owner, ref))
    return refs


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def _assemble(
    *,
    surface: str,
    name: str,
    resources: Tuple[DbtResource, ...],
    exposures: Tuple[Mapping[str, Any], ...],
    metrics: Tuple[Mapping[str, Any], ...],
    governance: Mapping[str, Any],
    project_config: Mapping[str, Any],
    fileset: Mapping[str, Any],
    version: Optional[str],
    raw: str,
    source_label: Optional[str],
) -> DbtProject:
    """Resolve lineage and build the finished :class:`DbtProject`.

    Raises:
        DbtParseError: ``INPUT_SEMANTIC_INVALID`` when the import describes no data, and
            ``INPUT_REFERENCE_UNRESOLVED`` for a dangling recorded edge.
    """
    if not resources:
        raise _semantic(
            "dbt document declares no `models`, `sources`, `seeds`, `snapshots` or "
            "`semantic_models`, so it describes no data",
            source_label,
        )
    by_key = {resource.key: resource for resource in resources}
    relationships: List[DbtRelationship] = []
    for resource in resources:
        relationships.extend(_relationship_targets(resource, by_key, source_label=source_label))
    unresolved = _unresolved_refs(resources, by_key, _consumer_refs(exposures, label="exposure"))
    return DbtProject(
        surface=surface,
        name=name,
        version=version,
        resources=resources,
        relationships=tuple(relationships),
        unresolved=unresolved,
        exposures=exposures,
        metrics=metrics,
        project_config=dict(project_config),
        governance=dict(governance),
        fileset=dict(fileset),
        raw=raw,
    )


def parse_dbt(raw: str, *, source_label: Optional[str] = None) -> DbtProject:
    """Parse one dbt document — a properties file or a compiled manifest.

    Args:
        raw: The document text (YAML, or the JSON a manifest is).
        source_label: The document's name, for error messages.

    Returns:
        The read project.

    Raises:
        DbtParseError: With the taxonomy codes described in the module docstring, and
            **without** a code when the document carries no dbt marker at all — which is
            what lets the pipeline report it as somebody else's format.
    """
    document = _load_document(raw, source_label=source_label)
    if _is_manifest(document):
        manifest = _read_manifest(document, raw=raw, source_label=source_label)
        return _finish_manifest(manifest, source_label=source_label)
    if not isinstance(document, Mapping) or not (
        _is_properties(document) or _is_project_file(document) or document.get("version") == 2
    ):
        raise DbtParseError(
            "Document is not a dbt project description: expected a properties file "
            "(`version: 2` with a `models:`/`sources:`/`semantic_models:` list), a "
            "`dbt_project.yml` (`config-version:`), or a compiled `manifest.json` "
            "(`metadata.dbt_schema_version`)"
        )
    if _is_project_file(document) and not _is_properties(document):
        raise _semantic(
            "`dbt_project.yml` configures how a project is built and declares no models, "
            "sources, seeds, snapshots or semantic models of its own; import the project "
            "directory as a file set so the properties files beside it are read too",
            source_label,
        )
    reader = _ResourceReader(source_label=source_label)
    carried = _read_properties_document(
        document, reader, member=None, source_label=source_label
    )
    project = _assemble(
        surface=DbtSurface.PROPERTIES,
        name=_project_name(source_label),
        resources=reader.resources,
        exposures=carried["exposures"],
        metrics=carried["metrics"],
        governance=carried["governance"],
        project_config={},
        fileset={},
        version=None,
        raw=raw,
        source_label=source_label,
    )
    return _with_properties_version(project)


def _with_properties_version(project: DbtProject) -> DbtProject:
    """Return ``project`` with its properties version recorded."""
    return replace(project, properties_version=PROPERTIES_VERSION)


def _finish_manifest(project: DbtProject, *, source_label: Optional[str]) -> DbtProject:
    """Resolve a manifest-read project's lineage and check that it describes data."""
    if not project.resources:
        raise _semantic(
            "dbt manifest declares no model, seed, snapshot or source nodes, so it "
            "describes no data",
            source_label,
        )
    by_key = {resource.key: resource for resource in project.resources}
    relationships: List[DbtRelationship] = []
    for resource in project.resources:
        relationships.extend(_relationship_targets(resource, by_key, source_label=source_label))
    unresolved = _unresolved_refs(
        project.resources, by_key, _consumer_refs(project.exposures, label="exposure")
    )
    return replace(project, relationships=tuple(relationships), unresolved=unresolved)


# ---------------------------------------------------------------------------
# File-set composition
# ---------------------------------------------------------------------------


def parse_dbt_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> DbtProject:
    """Parse a dbt project published across several files.

    A dbt project *is* a file set — that is how the tool is used — so composition here is
    not an include mechanism but the ordinary shape of the format. Three member roles are
    recognised:

    * the **project file** (``dbt_project.yml``) supplies the project's name and version,
      and its build configuration is carried verbatim;
    * every **properties file** contributes its resources to one shared namespace, so a
      model in ``marts/schema.yml`` and a source in ``staging/schema.yml`` resolve against
      each other;
    * every **model SQL** member contributes the ``ref()``/``source()`` calls in it as the
      lineage of the model its filename names. The SQL is never compiled or executed.

    Any other member (a ``README``, a ``.csv`` seed, a profile) is listed and otherwise
    left alone.

    Args:
        members: Member path → text, as the intake fileset supplied them.
        root: The member the set is rooted at.
        source_label: Fallback label when the set names no root.

    Returns:
        The composed project.

    Raises:
        DbtParseError: ``INPUT_SEMANTIC_INVALID`` when the root is missing or the set
            describes no data, ``INPUT_REFERENCE_UNRESOLVED`` for a dangling recorded
            edge, plus the per-document errors in the module docstring.
    """
    if root not in members:
        raise _semantic(f"dbt file set is missing its root {root!r}", source_label or root)

    reader = _ResourceReader(source_label=source_label or root)
    exposures: List[Mapping[str, Any]] = []
    metrics: List[Mapping[str, Any]] = []
    governance: Dict[str, Any] = {}
    project_config: Dict[str, Any] = {}
    properties_members: List[str] = []
    sql_members: List[str] = []
    other_members: List[str] = []
    project_name: Optional[str] = None
    project_version: Optional[str] = None

    # The root first, so its version gate and its project identity are applied before any
    # sibling contributes a resource; then the rest in a stable order.
    ordering = [root] + [member for member in sorted(members) if member != root]
    for member in ordering:
        text = members[member]
        if posixpath.splitext(member)[1].lower() == ".sql":
            sql_members.append(member)
            continue
        try:
            document = _load_document(text, source_label=member)
        except DbtParseError:
            if member == root:
                raise
            # A member that is not a document at all (a README, a CSV seed) is simply a
            # member; only the root has to be readable.
            other_members.append(member)
            continue
        if _is_manifest(document):
            if member == root:
                return _finish_manifest(
                    _read_manifest(document, raw=text, source_label=member),
                    source_label=source_label or root,
                )
            other_members.append(member)
            continue
        if isinstance(document, Mapping) and _is_project_file(document) and not _is_properties(document):
            project_config = dict(document)
            project_name = _text(document.get("name"))
            project_version = _text(document.get("version"))
            continue
        if _is_properties(document) or (
            isinstance(document, Mapping) and document.get("version") == 2
        ):
            carried = _read_properties_document(
                document, reader, member=member, source_label=source_label or root
            )
            exposures.extend(carried["exposures"])
            metrics.extend(carried["metrics"])
            for key, value in carried["governance"].items():
                governance.setdefault(key, value)
            properties_members.append(member)
            continue
        other_members.append(member)

    resources = _attach_sql_lineage(reader.resources, members, sql_members)
    fileset: Dict[str, Any] = {"root": root, "members": sorted(members)}
    if properties_members:
        fileset["properties_files"] = sorted(properties_members)
    if sql_members:
        fileset["model_files"] = sorted(sql_members)
    if other_members:
        fileset["other_files"] = sorted(other_members)
    project = _assemble(
        surface=DbtSurface.PROJECT if project_config else DbtSurface.PROPERTIES,
        name=project_name or _project_name(source_label or root),
        resources=resources,
        exposures=tuple(exposures),
        metrics=tuple(metrics),
        governance=governance,
        project_config=project_config,
        fileset=fileset,
        version=project_version,
        raw=members[root],
        source_label=source_label or root,
    )
    return _with_properties_version(project) if properties_members else project


def _attach_sql_lineage(
    resources: Tuple[DbtResource, ...],
    members: Mapping[str, str],
    sql_members: Sequence[str],
) -> Tuple[DbtResource, ...]:
    """Attach the ``ref()``/``source()`` calls in each model's SQL to that model.

    The model a ``.sql`` member describes is the one its filename names — that is dbt's
    own rule, and it is why a model's name is not written inside its SQL.

    Args:
        resources: The resources read from the set's properties files.
        members: Member path → text.
        sql_members: The member paths that end in ``.sql``.

    Returns:
        The resources, each carrying the lineage its SQL declared.
    """
    by_name: Dict[str, Tuple[DbtRef, ...]] = {}
    for member in sql_members:
        stem = posixpath.splitext(posixpath.basename(member))[0]
        refs = _scrape_refs(members[member])
        if refs:
            by_name[stem] = by_name.get(stem, ()) + refs
    if not by_name:
        return resources
    return tuple(
        _with_depends_on_refs(resource, by_name[resource.name])
        if resource.name in by_name and resource.kind in ("model", "snapshot")
        else resource
        for resource in resources
    )


def _with_depends_on_refs(resource: DbtResource, refs: Tuple[DbtRef, ...]) -> DbtResource:
    """Return ``resource`` carrying ``refs`` as its declared lineage."""
    return replace(resource, depends_on=resource.depends_on + refs)
