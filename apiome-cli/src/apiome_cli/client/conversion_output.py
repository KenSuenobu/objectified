"""Render catalog → OpenAPI conversion results for the ``convert`` command (MFI-22.6).

Pure, stream-agnostic formatting helpers (no HTTP, no ``typer``) so the fidelity summary + warning
the ``convert`` command prints are unit-testable in isolation. The authoritative fidelity report is
computed server-side by apiome-rest (MFI-22.3); this module only *presents* the report the API
returns — it never recomputes a score, a grade, or a tier.

Two response shapes are rendered, both carrying the same ``report``:

* a **dry-run** (``convert --dry-run``) returns ``{report, openapi, sourceFormat, target}`` — the
  fidelity report and the would-be OpenAPI document, with no Project created;
* a **commit** returns ``{projectId, versionId, report, ...}`` — the created Project/version ids.

Both also carry ``projection``, the bounded conversion projection-manifest summary (CPDO-1.3): the
snapshot hash the server built, the converter tool versions, and the per-status/reason tallies.
:func:`assemble_projection_manifest` pages the manifest's full node/edge graph out of the
``POST .../projection`` endpoint into one machine-readable document — the CLI's exposure of the
manifest, for ``convert --projection-out``.

The mandatory warning sentence mirrors the preview screen (MFI-22.4) so every surface says the same
thing, and the ``low`` fidelity tier is what the command turns into its non-zero exit hint.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

#: Hard cap on cursor hops when assembling a full manifest, so a server that keeps handing back a
#: cursor cannot spin the CLI forever. The server bounds a manifest at 2000 construct edges, so at
#: the maximum page size this is far more headroom than any real manifest needs.
MAX_PROJECTION_PAGES = 200

#: Page size requested when assembling a manifest — the server's hard cap, so the whole graph
#: arrives in as few round-trips as the contract allows.
PROJECTION_PAGE_SIZE = 500

# Mirrors apiome-ui's CONVERSION_WARNING_SENTENCE (MFI-22.4) so every surface warns identically.
CONVERSION_WARNING_SENTENCE = (
    "The fidelity of the original API may not be complete enough to create a fully defined "
    "OpenAPI Specification — review the gaps below before converting."
)

# Coverage tags that mean a construct did NOT reach the converted spec faithfully (mirrors the
# preview's MISSING_COVERAGES): these are the checklist rows worth calling out as gaps.
_GAP_COVERAGES = frozenset({"missing", "partial", "n/a"})


def report_tier(report: Mapping[str, Any]) -> str:
    """Return the report's coarse fidelity tier (``high`` / ``medium`` / ``low``), lower-cased."""
    return str(report.get("tier", "")).strip().lower()


def is_low_tier(report: Mapping[str, Any]) -> bool:
    """True when the conversion is low fidelity — the signal the command turns into a non-zero hint."""
    return report_tier(report) == "low"


def _gap_items(report: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Return the checklist rows for constructs OpenAPI favors but this conversion lacks."""
    items = report.get("items")
    if not isinstance(items, list):
        return []
    return [
        item
        for item in items
        if isinstance(item, Mapping) and str(item.get("coverage")) in _GAP_COVERAGES
    ]


def format_conversion_summary(
    response: Mapping[str, Any],
    *,
    committed: bool,
) -> list[str]:
    """Build the human-readable summary lines for a conversion response.

    Args:
        response: The parsed convert response (dry-run or commit); both carry a ``report``.
        committed: True when this was a commit (a Project was created), False for a dry-run.

    Returns:
        A list of output lines: the fidelity headline, the mandatory warning, up to a few gap rows,
        and — for a commit — the created Project/version ids.
    """
    report = response.get("report")
    if not isinstance(report, Mapping):
        return ["Conversion completed, but no fidelity report was returned."]

    tier = report_tier(report) or "unknown"
    score = report.get("score")
    grade = report.get("grade")
    target = response.get("target", "openapi")

    lines: list[str] = []
    headline = f"Conversion to {target}: fidelity {grade} ({score}/100), tier {tier}."
    lines.append(headline)
    lines.append(CONVERSION_WARNING_SENTENCE)

    gaps = _gap_items(report)
    if gaps:
        lines.append("Gaps OpenAPI favors but this conversion lacks:")
        for item in gaps[:8]:
            title = item.get("title") or item.get("key") or "construct"
            coverage = item.get("coverage")
            reason = item.get("reason")
            detail = f"  - {title} [{coverage}]"
            if reason:
                detail += f": {reason}"
            lines.append(detail)
        if len(gaps) > 8:
            lines.append(f"  … and {len(gaps) - 8} more (use --json for the full report).")

    losses = report.get("losses")
    if isinstance(losses, list) and losses:
        lines.append(f"Projection losses: {len(losses)} (constructs with no faithful OpenAPI form).")

    lines.extend(format_projection_summary(response.get("projection")))

    if committed:
        project_id = response.get("projectId")
        version_id = response.get("versionId")
        reconverted = response.get("reconverted")
        verb = "Re-converted" if reconverted else "Converted"
        lines.append(f"{verb} into project {project_id} version {version_id}.")

    if is_low_tier(report):
        lines.append(
            "Low fidelity — the converted spec will be substantially incomplete. "
            "Re-run with --force to accept, or supply --title/--api-version/--server to close gaps."
        )

    return lines


def format_projection_summary(projection: Any) -> list[str]:
    """Render the projection-manifest summary lines for a conversion response (CPDO-1.3).

    Deliberately short: the manifest's value in a terminal is the *snapshot id* (so a scripted run
    can tell two conversions apart) plus how many constructs did not survive faithfully. The full
    graph is what ``--projection-out`` writes.

    Args:
        projection: The response's ``projection`` object, or anything falsy when the server did not
            return one (an older server, or a response shape without it).

    Returns:
        Zero or more output lines; empty when there is no manifest to describe.
    """
    if not isinstance(projection, Mapping) or not projection.get("manifest_hash"):
        return []

    counts = projection.get("status_counts")
    counts = counts if isinstance(counts, Mapping) else {}
    unfaithful = sum(
        int(counts.get(status, 0) or 0)
        for status in ("transformed", "inferred", "dropped", "unavailable")
    )
    lines = [
        f"Projection manifest {projection['manifest_hash'][:12]}: "
        f"{projection.get('total_constructs', 0)} source construct(s), "
        f"{unfaithful} not carried faithfully."
    ]
    if projection.get("truncated"):
        lines.append(
            f"  Manifest bounded: {projection.get('dropped_edge_count', 0)} row(s) omitted "
            "(losses are never omitted)."
        )
    return lines


def assemble_projection_manifest(
    fetch_page: Callable[[str | None], Mapping[str, Any]],
) -> dict[str, Any]:
    """Page a conversion projection manifest out of the API into one machine-readable document.

    The manifest is served page by page so a large conversion cannot return an unbounded response;
    this walks the cursors and reassembles ``{summary, nodes, edges}`` in the order the server sent
    them, de-duplicating the nodes (a node is repeated on every page whose edges reference it).

    Refuses to loop forever: a server that keeps returning the same cursor, or more than
    :data:`MAX_PROJECTION_PAGES` of them, stops the walk and the result declares itself
    ``pagesTruncated`` rather than silently claiming to be complete.

    Args:
        fetch_page: Callable taking a cursor (``None`` for the first page) and returning the parsed
            projection response — kept as a callable so this stays HTTP-free and unit-testable.

    Returns:
        ``{"summary": {...}, "nodes": [...], "edges": [...], "pagesTruncated": bool}``.
    """
    summary: dict[str, Any] = {}
    nodes: list[Any] = []
    edges: list[Any] = []
    seen_nodes: set[str] = set()
    seen_cursors: set[str] = set()

    cursor: str | None = None
    truncated = False
    for _ in range(MAX_PROJECTION_PAGES):
        response = fetch_page(cursor)
        if not summary and isinstance(response.get("summary"), Mapping):
            summary = dict(response["summary"])
        page = response.get("page")
        page = page if isinstance(page, Mapping) else {}

        for node in page.get("nodes") or []:
            node_id = node.get("id") if isinstance(node, Mapping) else None
            if node_id is not None and node_id in seen_nodes:
                continue
            if node_id is not None:
                seen_nodes.add(node_id)
            nodes.append(node)
        edges.extend(page.get("edges") or [])

        next_cursor = page.get("next_cursor")
        if not next_cursor:
            break
        if next_cursor in seen_cursors:
            truncated = True
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    else:
        truncated = True

    return {"summary": summary, "nodes": nodes, "edges": edges, "pagesTruncated": truncated}
