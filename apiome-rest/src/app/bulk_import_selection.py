"""Narrow a bulk repository batch to the files a reader actually ticked (BLK-1.5).

``POST …/import/bulk/plan`` reads a repository *selection* — a directory, a glob, or the whole
tree — and partitions everything it finds. The repository detail screen's Files tab has a
different shape of intent: a reader ticks N specific rows and asks for those. This module is
the translation between the two.

Two rules make the translation correct rather than merely convenient:

**Grouping runs before the narrowing, not after.** Bulk grouping follows references between
files — a protobuf ``import``, a JSON/YAML ``$ref``, an XSD ``schemaLocation`` — so an item is
its root document *plus the siblings it compiles*. Filtering the member set down to the ticked
paths first would strip those siblings and turn a compilable item into a broken one. So the
whole selection is fetched and planned, and only then are the resulting **items** narrowed, by
root document. A ticked file keeps everything it needs.

**A ticked file that is not a root is reported, not dropped.** Ticking ``common/types.proto``
— a shared type file that ``orders.proto`` already compiles — names no item of its own. Saying
so (:data:`NOT_AN_ITEM_ROOT`) is the honest answer; silently returning fewer items than were
asked for is how a batch quietly imports the wrong thing.

**What it does not do is narrow the read.** Anchoring the repository fetch at the ticked
files' shared directory looks like free savings and is not: ``protos/orders/orders.proto``
imports ``protos/common/types.proto``, which lives outside that anchor. The selection ``path``
stays the caller's to choose — that is what scopes a large repository — and these rules narrow
which *items* survive planning.

The functions here are pure: they take paths and planned roots and return paths and keys, so
the selection rules are exercisable without a repository, a plan, or a network.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Sequence, Tuple

__all__ = [
    "NOT_AN_ITEM_ROOT",
    "normalize_selection_paths",
    "partition_requested_roots",
    "repository_relative_path",
]

#: Why a ticked path produced no item of its own: another item already compiles it.
NOT_AN_ITEM_ROOT = "not-an-item-root"


def normalize_selection_paths(paths: Iterable[str] | None) -> Tuple[str, ...]:
    """Clean a caller's path list into comparable repository-relative paths.

    A path arriving from a client may be blank, may repeat, and may carry a leading ``/`` or
    ``./`` that the repository index never stores. Normalizing here means the comparison later
    is a plain set membership rather than a per-call guess, and that a duplicate tick cannot
    make one file look like two.

    Args:
        paths: The caller's ``git.paths``, or ``None``.

    Returns:
        The cleaned paths, de-duplicated, in first-seen order. Empty when nothing usable was
        supplied — which callers read as "no narrowing requested".
    """
    if not paths:
        return ()
    seen: Dict[str, None] = {}
    for raw in paths:
        if not isinstance(raw, str):
            continue
        text = raw.strip()
        # Leading "/" and "./" can interleave ("./specs", ".//specs"), so strip to a fixed
        # point rather than once each — a half-cleaned path silently matches nothing.
        while text.startswith("/") or text.startswith("./"):
            text = text[1:] if text.startswith("/") else text[2:]
        text = text.rstrip("/")
        if text:
            seen.setdefault(text, None)
    return tuple(seen)


def repository_relative_path(selection_prefix: str, member_path: str) -> str:
    """Re-anchor a member path onto the repository root.

    A repository read keyed at ``specs/`` returns members named ``orders.yaml``; the reader
    ticked ``specs/orders.yaml``. Both name the same file, and only the repository-relative
    form is comparable — it is also what the revision records as
    ``format_metadata.gitPath`` (MFI-29.3), which is what BLK-1.2 reconciles against.

    Args:
        selection_prefix: The selection the members were read under (``""`` for the whole tree).
        member_path: The member's path relative to that selection.

    Returns:
        The path relative to the repository root.
    """
    base = (selection_prefix or "").strip().strip("/")
    return f"{base}/{member_path}" if base else member_path


def partition_requested_roots(
    roots: Sequence[Tuple[str, str]], requested: Sequence[str]
) -> Tuple[List[str], List[str]]:
    """Split planned item roots into the ticked ones and the ticks that matched no root.

    Args:
        roots: ``(item_key, repository_relative_root_path)`` for every planned item, in plan
            order.
        requested: Normalized repository-relative paths the caller ticked.

    Returns:
        ``(kept_keys, unmatched_paths)`` — the keys of the items to plan, in plan order, and
        the ticked paths that named no item root. ``unmatched_paths`` is what the caller reports
        as :data:`NOT_AN_ITEM_ROOT` rather than dropping.
    """
    wanted = set(requested)
    kept = [key for key, root in roots if root in wanted]
    matched = {root for _key, root in roots if root in wanted}
    unmatched = [path for path in requested if path not in matched]
    return kept, unmatched
