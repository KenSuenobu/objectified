"""Bulk import of independent specs — MFI-29.5 (#4392).

MFI-29.1 answers *"one spec, many files"*: a proto tree with cross-directory
imports is unpacked and handed to one adapter as a fileset. This module answers
the other shape — *"many specs, one folder"*: a team's ``specs/`` directory (or a
repository path, or one archive) holding **N unrelated documents**, which today
must be imported one at a time.

The engine here is pure and I/O-free. Given the members of one unpacked archive or
git selection it partitions them into independent **groups**, each of which becomes
one ordinary import job:

1. Every member is scanned for the references it makes to sibling members — proto
   ``import "…";``, JSON/YAML ``$ref: "./file.yaml#/…"``, XML
   ``schemaLocation=``/``location=`` (WSDL + XSD), and Avro/JSON ``"$ref"`` string
   values. Only *relative* references that resolve to another member count; URLs,
   fragment-only refs, and well-known imports that are not in the fileset are
   ignored.
2. Members are grouped into **connected components** of that reference graph, taken
   as undirected. Undirected is deliberate: two service protos that both import
   ``common/types.proto`` are one compilation unit even though neither references
   the other, so splitting them would break the import the user actually wants.
3. Each component picks its root with the shared
   :func:`~app.archive_intake.resolve_fileset_root` rules — the same ranking archive
   and git intake already use — so a group's root is chosen the same way it would be
   if that group had been uploaded on its own.
4. A component with no importable root (a ``README.md``, a stray ``.gitignore``, a
   lone ``.json`` nothing recognises) is not an item: its files are reported as
   :class:`BulkSkippedMember` with a reason, never silently dropped.

The result is a :class:`BulkPlan`: an ordered, deterministic list of groups plus
everything that was left out. Callers turn each group into the payload the existing
import chain already accepts — a single-member group is the document verbatim, a
multi-member group is a packed fileset — so bulk import, like git intake before it,
adds a *front end*, not a second pipeline.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .archive_intake import ArchiveIntakeError, resolve_fileset_root
from .format_detection import FormatDetection
from .import_routing import PUBLISHABLE_FORMATS

__all__ = [
    "DEFAULT_MAX_BULK_ITEMS",
    "BulkGroup",
    "BulkPlan",
    "BulkSkippedMember",
    "group_document_bytes",
    "member_references",
    "plan_bulk_import",
    "predicted_import_target",
    "suggested_item_name",
]

#: Default ceiling on the number of items one bulk plan may contain. A plan that
#: finds more reports the overflow explicitly (:attr:`BulkPlan.truncated`) rather
#: than silently importing a prefix.
DEFAULT_MAX_BULK_ITEMS = 50

#: ``import "path/to/file.proto";`` — protobuf's only cross-file construct.
_PROTO_IMPORT_RE = re.compile(r"""import\s+(?:public\s+|weak\s+)?"([^"\n]+)"\s*;""")

#: ``$ref: "./common.yaml#/components/schemas/X"`` in YAML, and ``"$ref": "…"`` in
#: JSON. One expression covers both because YAML's quoted-scalar form is a superset
#: of JSON's here; unquoted YAML values are matched by the second alternative.
_REF_RE = re.compile(
    r"""\$ref\s*:\s*["']([^"'\n]+)["']"""      # YAML: $ref: "target"
    r"""|["']\$ref["']\s*:\s*["']([^"'\n]+)["']"""  # JSON: "$ref": "target"
    r"""|\$ref\s*:\s*([^\s"'{}\[\],]+)"""      # YAML: $ref: target (unquoted)
)

#: ``schemaLocation="types.xsd"`` / ``location="service.wsdl"`` — the XSD/WSDL
#: include-and-import attributes, in either quoting style.
_XML_LOCATION_RE = re.compile(
    r"""(?:schemaLocation|location)\s*=\s*["']([^"'\n]+)["']""", re.IGNORECASE
)

#: Root filenames that name a role rather than the API — a multi-file item rooted at
#: one of these is named after its directory instead (``protos/orders/service.proto``
#: → "orders", not "service").
_GENERIC_ROOT_STEMS = frozenset({"api", "index", "main", "schema", "service", "spec", "root"})

#: Reasons attached to members that never become part of any item.
_REASON_NO_FORMAT = "no-recognisable-format"
_REASON_OVER_ITEM_LIMIT = "over-item-limit"


@dataclass(frozen=True)
class BulkSkippedMember:
    """A member that did not become (or join) an importable item, and why.

    Attributes:
        path: Module-relative member path.
        reason: ``no-recognisable-format`` when nothing in the member's component
            detected as an importable format, or ``over-item-limit`` when the plan
            hit its item ceiling before reaching this component.
    """

    path: str
    reason: str


@dataclass(frozen=True)
class BulkGroup:
    """One independent spec inside a bulk payload — the unit that becomes a job.

    Attributes:
        key: Stable identifier for the item, equal to :attr:`root_path`. Stable
            across re-plans of identical bytes, so a client can select items in one
            call and submit them in the next.
        root_path: The group's root document (a key of :attr:`members`).
        members: The group's files keyed by module-relative path — the root plus
            every sibling it (transitively) references.
        detection: Format detection for the root document.
        reason: Human-readable justification for the grouping, for the per-item list.
    """

    key: str
    root_path: str
    members: Dict[str, str]
    detection: FormatDetection
    reason: str

    @property
    def source_kind(self) -> Optional[str]:
        """Registry key of the adapter that would import this group, when importable."""
        detected = self.detection.detected
        return detected.source_key if detected else None

    @property
    def format(self) -> Optional[str]:
        """The detected format key of the root document."""
        detected = self.detection.detected
        return detected.format if detected else None

    def total_bytes(self) -> int:
        """Return the decoded size of every member of this group, in bytes."""
        return sum(len(text.encode("utf-8", errors="replace")) for text in self.members.values())


@dataclass(frozen=True)
class BulkPlan:
    """The partition of one bulk payload into independent import items.

    Attributes:
        groups: The items, ordered by root path (deterministic for fixed input).
        skipped: Members that are part of no item, each with a reason.
        truncated: ``True`` when more items were found than the plan may carry.
        total_groups: How many items were found *before* the ceiling was applied.
    """

    groups: Tuple[BulkGroup, ...]
    skipped: Tuple[BulkSkippedMember, ...]
    truncated: bool = False
    total_groups: int = 0


def predicted_import_target(format_key: Optional[str]) -> str:
    """Predict where an item will land — ``project`` or ``catalog`` — from its format.

    The authoritative decision is :func:`~app.import_routing.decide_import_routing`,
    which needs a parsed canonical model; running it for every item of a plan would
    mean parsing the whole payload just to draw a list. The routing branch is on the
    emitted format, though, and detection already knows that, so the OpenAPI/Swagger
    family predicts ``project`` and everything else predicts ``catalog`` — matching
    the §0.2 policy for every format whose adapter emits what it detected as.

    Args:
        format_key: The detected format key, or ``None`` when nothing matched.

    Returns:
        ``"project"`` for the publishable OpenAPI/Swagger family, else ``"catalog"``.
    """
    key = (format_key or "").strip().lower()
    return "project" if key in PUBLISHABLE_FORMATS else "catalog"


def _candidate_targets(text: str) -> Iterable[str]:
    """Yield every raw reference target named by a document's text.

    One text scan per member covers the reference vocabularies that appear in the
    formats archive intake accepts. It is deliberately syntactic: a real parse per
    member would mean parsing the payload N times, and a missed reference only
    costs a finer-grained grouping, never a wrong import.

    Args:
        text: The member's decoded text.

    Yields:
        Raw (unresolved) reference targets, in the order they appear.
    """
    for match in _PROTO_IMPORT_RE.finditer(text):
        yield match.group(1)
    for match in _REF_RE.finditer(text):
        target = match.group(1) or match.group(2) or match.group(3)
        if target:
            yield target
    for match in _XML_LOCATION_RE.finditer(text):
        yield match.group(1)


def _resolve_target(source_path: str, target: str, members: Mapping[str, str]) -> Optional[str]:
    """Resolve one raw reference to the member it names, if any.

    Two anchors are tried, in the order a toolchain would: relative to the referring
    document's directory (how ``$ref`` and XSD ``schemaLocation`` resolve), then
    relative to the fileset root (how protobuf include paths resolve). Anything that
    escapes the fileset, names a URL, or is fragment-only is not a member reference.

    Args:
        source_path: Member path of the document making the reference.
        target: The raw reference text.
        members: Every member of the payload, keyed by module-relative path.

    Returns:
        The referenced member's key, or ``None`` when it is not a sibling member.
    """
    raw = (target or "").strip()
    if not raw or raw.startswith("#"):
        return None
    # Drop any JSON-Pointer fragment: the file is what identifies the member.
    raw = raw.split("#", 1)[0].strip()
    if not raw:
        return None
    if "://" in raw or raw.startswith("//") or raw.startswith("/"):
        return None
    raw = raw.replace("\\", "/")

    candidates: List[str] = []
    parent = PurePosixPath(source_path).parent
    for base in (parent, PurePosixPath(".")):
        try:
            joined = PurePosixPath(str(base / raw)) if str(base) != "." else PurePosixPath(raw)
        except ValueError:  # pragma: no cover - PurePosixPath does not reject names today
            continue
        parts: List[str] = []
        escaped = False
        for part in joined.parts:
            if part == ".":
                continue
            if part == "..":
                if not parts:
                    escaped = True
                    break
                parts.pop()
                continue
            parts.append(part)
        if escaped or not parts:
            continue
        candidates.append("/".join(parts))

    for candidate in candidates:
        if candidate in members and candidate != source_path:
            return candidate
    return None


def member_references(
    path: str, text: str, members: Mapping[str, str]
) -> Tuple[str, ...]:
    """Return the sibling members one document references, deduplicated and ordered.

    Args:
        path: Module-relative path of the referring member.
        text: Its decoded text.
        members: Every member of the payload, keyed by module-relative path.

    Returns:
        The referenced member keys, in first-appearance order.
    """
    seen: Set[str] = set()
    resolved: List[str] = []
    for target in _candidate_targets(text):
        member = _resolve_target(path, target, members)
        if member and member not in seen:
            seen.add(member)
            resolved.append(member)
    return tuple(resolved)


def _connected_components(members: Mapping[str, str]) -> List[Tuple[str, ...]]:
    """Partition members into undirected connected components of the reference graph.

    Undirected connectivity is what makes a proto tree one item: ``a/service.proto``
    and ``b/service.proto`` both importing ``common/types.proto`` reference the same
    file without referencing each other, and a directed closure from either root
    would produce two overlapping items compiling the same shared file twice.

    Args:
        members: Every member of the payload, keyed by module-relative path.

    Returns:
        Components as sorted member tuples, ordered by their first member's path.
    """
    adjacency: Dict[str, Set[str]] = {path: set() for path in members}
    for path, text in members.items():
        for referenced in member_references(path, text, members):
            adjacency[path].add(referenced)
            adjacency[referenced].add(path)

    components: List[Tuple[str, ...]] = []
    unvisited = set(members)
    for start in sorted(members):
        if start not in unvisited:
            continue
        stack = [start]
        seen: Set[str] = set()
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            unvisited.discard(current)
            stack.extend(adjacency[current] - seen)
        components.append(tuple(sorted(seen)))
    components.sort(key=lambda component: component[0])
    return components


def _group_reason(component: Sequence[str], root: str) -> str:
    """Explain why a component is one item, for the per-item result list."""
    if len(component) == 1:
        return f"{root} is an independent document (no references to sibling files)."
    return (
        f"{root} is the root of a {len(component)}-file group linked by references "
        "between its members."
    )


def plan_bulk_import(
    members: Mapping[str, str],
    *,
    max_items: int = DEFAULT_MAX_BULK_ITEMS,
    where: str = "",
) -> BulkPlan:
    """Partition one unpacked payload into independent import items.

    Args:
        members: Every member of the archive / git selection, keyed by
            module-relative path (the output of archive or git intake).
        max_items: Ceiling on plan size; components past it are reported as
            skipped with reason ``over-item-limit`` and :attr:`BulkPlan.truncated`
            is set, so a caller never mistakes a partial plan for a whole one.
        where: Parenthesised source label appended to error messages by the shared
            root resolver.

    Returns:
        The :class:`BulkPlan`: ordered items plus everything left out.

    Raises:
        ValueError: When ``members`` is empty — there is nothing to plan.
    """
    if not members:
        raise ValueError("A bulk import plan needs at least one member document.")

    groups: List[BulkGroup] = []
    skipped: List[BulkSkippedMember] = []
    overflow: List[BulkSkippedMember] = []
    total_groups = 0
    ceiling = max(1, int(max_items))

    for component in _connected_components(members):
        subset = {path: members[path] for path in component}
        try:
            root, detection, _ambiguous = resolve_fileset_root(
                subset, explicit_root=None, where=where, label="Bulk item"
            )
        except ArchiveIntakeError:
            # Either nothing in this component is a recognisable format, or its root
            # is genuinely ambiguous. Neither is an item, and neither aborts the plan:
            # the files are reported so the caller can import them deliberately.
            skipped.extend(
                BulkSkippedMember(path=path, reason=_REASON_NO_FORMAT) for path in component
            )
            continue

        total_groups += 1
        if len(groups) >= ceiling:
            overflow.extend(
                BulkSkippedMember(path=path, reason=_REASON_OVER_ITEM_LIMIT) for path in component
            )
            continue

        groups.append(
            BulkGroup(
                key=root,
                root_path=root,
                members=subset,
                detection=detection,
                reason=_group_reason(component, root),
            )
        )

    ordered = tuple(sorted(groups, key=lambda group: group.root_path))
    return BulkPlan(
        groups=ordered,
        skipped=tuple(skipped) + tuple(overflow),
        truncated=bool(overflow),
        total_groups=total_groups,
    )


def group_document_bytes(group: BulkGroup) -> Tuple[bytes, str, Optional[str]]:
    """Render one group as the import payload the existing chain accepts.

    A single-file item is sent as the document itself — the catalog then stores the
    user's file verbatim rather than a one-entry zip — while a multi-file item is
    packed as the same deterministic archive MFI-29.1/29.3 already produce, with its
    root named so the adapter compiles the tree.

    Args:
        group: The planned item.

    Returns:
        ``(document_bytes, input_kind, archive_root)`` — ``input_kind`` is ``file``
        for a single-member item and ``fileset`` for a multi-member one;
        ``archive_root`` is ``None`` in the single-member case.
    """
    # Imported here (not at module scope) so this pure planner does not pull the git
    # intake module — and its httpx dependency — into every importer of the planner.
    from .git_intake import pack_fileset_zip

    if len(group.members) == 1:
        return group.members[group.root_path].encode("utf-8"), "file", None
    return pack_fileset_zip(group.members), "fileset", group.root_path


def suggested_item_name(group: BulkGroup) -> str:
    """Derive the catalog item name for a planned item from its root document.

    Prefers the document's own declared ``info.title`` (the OpenAPI and AsyncAPI
    families) and falls back to the root filename stem, which is what the CLI and the
    wizard already use for single-document adapter imports. A multi-file item whose
    root is named for its role rather than its subject (``service.proto``) is named
    after its directory instead, since that is what distinguishes it from its siblings.

    Args:
        group: The planned item.

    Returns:
        A non-empty display name.
    """
    text = group.members.get(group.root_path, "")
    title = _declared_title(text)
    if title:
        return title
    path = PurePosixPath(group.root_path)
    stem = path.name
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    stem = stem.strip()
    if len(group.members) > 1 and stem.lower() in _GENERIC_ROOT_STEMS:
        parent = path.parent.name.strip()
        if parent:
            return parent
    return stem or group.root_path


def _declared_title(text: str) -> Optional[str]:
    """Read ``info.title`` out of a JSON or YAML document without a full parse.

    Args:
        text: The root document's text.

    Returns:
        The trimmed title, or ``None`` when the document declares none.
    """
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            document = json.loads(text)
        except (TypeError, ValueError):
            return None
        info = document.get("info") if isinstance(document, dict) else None
        title = info.get("title") if isinstance(info, dict) else None
        return title.strip() if isinstance(title, str) and title.strip() else None

    # YAML: the title lives under a top-level ``info:`` block, so only match a
    # ``title:`` that is indented beneath it.
    in_info = False
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            in_info = line.strip().startswith("info:")
            continue
        if in_info:
            match = re.match(r"""\s*title\s*:\s*["']?(.+?)["']?\s*$""", line)
            if match:
                value = match.group(1).strip()
                return value or None
    return None
