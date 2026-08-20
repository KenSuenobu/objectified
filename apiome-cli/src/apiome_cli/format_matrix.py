"""Format-matrix fetch and rendering for ``apiome formats`` (FMT-1.5, #5416).

``apiome formats`` answers *"what formats does this deployment support, in which directions, at
which versions?"* by printing ``GET /v1/formats/matrix`` — the server's one authoritative answer,
built from the import-source registry, the emitter registry and the source-format capability
registry. The same payload is what the generated ``docs/guide/supported-formats.md`` page is
rendered from, so the CLI, the docs and the API cannot disagree.

Two consequences shape this module:

* **The filters are the server's.** ``--paradigm`` and ``--direction`` become query parameters
  rather than a client-side pass over the rows, so there is one implementation of "does this row
  match?" and the printed table and the counts beside it always agree.
* **``--json`` prints the response verbatim.** Not a reshaped, CLI-flavoured projection — the point
  of the matrix is that there is one machine-readable answer, and a script piping ``apiome formats
  --json`` must receive exactly what a partner calling the endpoint receives.

The Typer wiring lives in ``commands/formats.py``; everything here is pure enough to unit-test
against a payload literal.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient
from apiome_cli.output import ListColumn, emit_json, emit_list_table, join_list

#: The direction values ``--direction`` accepts, in help-text order. They are *capability*
#: questions, not exact matches on a row's own direction: ``import`` includes the formats that also
#: export, because "can Apiome read this?" is what someone choosing an input actually asks.
DIRECTIONS: tuple[str, ...] = ("import", "export", "both")

#: How a row's ``direction`` field is spelled in the table. The payload's ``import_only`` /
#: ``export_only`` / ``both`` are precise but read as jargon in a column three characters wide.
_DIRECTION_LABELS: dict[str, str] = {
    "import_only": "import",
    "export_only": "export",
    "both": "import + export",
}

#: Minimum render width for the table when stdout is not a terminal, so a piped or CI-captured
#: matrix is not squeezed into Rich's 80-column fallback and truncated mid-column.
TABLE_MIN_WIDTH = 200


def fetch_format_matrix(
    client: RestClient,
    *,
    paradigm: str | None = None,
    direction: str | None = None,
) -> dict[str, Any]:
    """Fetch the format matrix (``GET /v1/formats/matrix``).

    Args:
        client: An authenticated REST client.
        paradigm: Optional paradigm filter (``rest``, ``rpc``, ``event``, ``graph``,
            ``data_schema``, ``agent``), applied server-side.
        direction: Optional direction filter (``import``, ``export``, ``both``), applied
            server-side.

    Returns:
        The decoded response body, or an empty payload shape when the response is not the expected
        object — a malformed body prints an empty table rather than raising a ``KeyError`` out of a
        read-only listing command.
    """
    params: dict[str, str] = {}
    if paradigm:
        params["paradigm"] = paradigm
    if direction:
        params["direction"] = direction
    path = api_paths.format_matrix()
    if params:
        path = f"{path}?{urlencode(params)}"
    payload = client.get(path).json()
    if not isinstance(payload, dict) or not isinstance(payload.get("formats"), list):
        return {"formats": [], "counts": {}}
    return payload


def unknown_direction_message(requested: str) -> str:
    """Build an actionable error for a ``--direction`` value the endpoint does not accept.

    Rejecting client-side keeps a typo from becoming a 422 traceback, and names the three values
    rather than making the caller find them in ``--help``.

    Args:
        requested: The value the user passed.

    Returns:
        The error message to print on stderr.
    """
    return (
        f"Unknown direction {requested!r}. "
        f"Expected one of: {', '.join(DIRECTIONS)}."
    )


def direction_label(row: dict[str, Any]) -> str:
    """Render one row's direction for the table.

    Args:
        row: A matrix row.

    Returns:
        A readable direction, or the raw value when the server introduces one this CLI predates —
        an unknown direction is shown, never swallowed.
    """
    value = row.get("direction")
    if not isinstance(value, str):
        return ""
    return _DIRECTION_LABELS.get(value, value)


def routing_label(row: dict[str, Any]) -> str:
    """Render where an import of this format lands: a publishable Project or a catalog item.

    Args:
        row: A matrix row.

    Returns:
        ``Project``, ``Catalog``, or an empty cell for an export-only destination, which is never
        imported and so is routed nowhere.
    """
    support = row.get("import_support")
    if not isinstance(support, dict) or not support.get("supported"):
        return ""
    return "Project" if support.get("publishable") else "Catalog"


def runtime_label(row: dict[str, Any]) -> str:
    """Render whether this deployment can actually run the format, and why not when it cannot.

    Keeps two different facts apart: *Apiome does not support this format* and *this deployment is
    missing a binary*. Only the first is about the product, and this column only ever reports the
    second.

    Args:
        row: A matrix row.

    Returns:
        ``ready``, or ``needs <tool>, <tool>`` naming what is missing here.
    """
    toolchain = row.get("toolchain")
    if isinstance(toolchain, dict):
        missing = toolchain.get("missing_tools")
        if isinstance(missing, list) and missing:
            return "needs " + ", ".join(str(tool) for tool in missing)
    return "ready"


#: The human table's columns. Deliberately the same facts the generated documentation page leads
#: with — key, direction, routing, inputs, version coverage, extensions, runtime — so someone
#: reading the page and someone running the command see the same matrix.
MATRIX_COLUMNS: tuple[ListColumn, ...] = (
    ("Format", "key", None),
    ("Label", "label", None),
    ("Paradigm", "paradigm", None),
    ("Direction", "direction", None),
    ("Routing", "routing", None),
    ("Inputs", "input_kinds", join_list),
    ("Live", "live_discovery", None),
    ("Versions", "version_coverage", join_list),
    ("Extensions", "file_extensions", join_list),
    ("Runtime", "runtime", None),
)


def table_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the matrix rows into the cells the table prints.

    The nested payload is the contract; a table needs one level of scalars. Flattening here — and
    not in the renderer — keeps the projection unit-testable without a terminal.

    Args:
        payload: A format-matrix response.

    Returns:
        One flat dict per row, in the payload's order (label, then key).
    """
    rows = payload.get("formats")
    if not isinstance(rows, list):
        return []
    flattened: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        import_support = row.get("import_support")
        import_support = import_support if isinstance(import_support, dict) else {}
        flattened.append(
            {
                "key": row.get("key", ""),
                "label": row.get("label", ""),
                "paradigm": row.get("paradigm", ""),
                "direction": direction_label(row),
                "routing": routing_label(row),
                "input_kinds": import_support.get("input_kinds", []),
                "live_discovery": "yes" if import_support.get("supports_live_discovery") else "",
                "version_coverage": row.get("version_coverage", []),
                "file_extensions": row.get("file_extensions", []),
                "runtime": runtime_label(row),
            }
        )
    return flattened


def summary_lines(payload: dict[str, Any]) -> list[str]:
    """Build the headline lines printed under the table.

    The counts come from the response, computed over the rows it actually carries, so a filtered
    listing never prints a whole-registry total beside a partial table.

    Args:
        payload: A format-matrix response.

    Returns:
        The lines to print, or an empty list when the response carries no counts.
    """
    counts = payload.get("counts")
    if not isinstance(counts, dict) or not counts:
        return []

    def count(name: str) -> int:
        value = counts.get(name)
        return value if isinstance(value, int) else 0

    lines = [
        f"{count('total')} formats — "
        f"{count('importable')} importable, "
        f"{count('exportable')} exportable, "
        f"{count('round_trip')} round-trip.",
        f"{count('live_discovery')} with live discovery; "
        f"{count('publishable')} publishable as a Project — the rest import as catalog items.",
    ]
    unavailable = count("unavailable_here")
    if unavailable:
        lines.append(
            f"{unavailable} need a toolchain this deployment is missing — supported, "
            "just not runnable here."
        )
    return lines


def emit_format_matrix(payload: dict[str, Any], *, json_mode: bool) -> None:
    """Print the format matrix as a table, or the response verbatim as JSON.

    Args:
        payload: A format-matrix response.
        json_mode: When ``True``, print the response unchanged so a script receives exactly what
            the endpoint returned.
    """
    if json_mode:
        emit_json(payload)
        return

    rows = table_rows(payload)
    emit_list_table(
        rows,
        MATRIX_COLUMNS,
        empty_message="No formats match.",
        min_width=TABLE_MIN_WIDTH,
    )
    for line in summary_lines(payload):
        typer.echo(line)
