"""Generated supported-formats reference page — FMT-1.2 (#5413).

``docs/guide/import-a-spec.md`` used to state *"Supported inputs: OpenAPI 3.x, Swagger 2.0,
Arazzo 1.0, JSON Schema 2020-12"*. That is true of the **Projects** importer and silent about the
Catalog importer carrying the other thirty-nine formats, so an evaluator reading our documentation
concluded Apiome supports four. A second copy of the list lived in the UI's format gallery. Three
sources of truth, no way to keep them aligned.

This module removes the prose claim by **deriving** the page from the one place that already knows
the answer: the format matrix (:func:`app.format_matrix.build_format_matrix`, FMT-1.5), which reads
the import-source registry, the emitter registry, the source-format capability registry and the
import-routing rule, and is served verbatim at ``GET /v1/formats/matrix``.

That indirection is the point. The page and the endpoint are two renderings of **one** traversal of
the registries, so they cannot disagree: there is no second walk here to fall behind, and a format
added to the registries reaches the page and the API in the same commit. Only the *presentation* —
which columns, which order, which prose — lives in this module.

The rendering is kept here (rather than in the script that writes the file) so a test can regenerate
the page in memory and compare it byte-for-byte against the committed copy. That test is the drift
gate: the pytest suite runs in CI, so a registry change that is not accompanied by a regenerated
page turns the build red.

Everything here is **pure and deterministic** — same registries in, same bytes out — because a
generator whose output wobbles between runs cannot be drift-checked at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from .canonical_model import ApiParadigm
from .format_capability_registry import CapabilityProvenance, NativeHierarchy
from .format_matrix import (
    INTERNAL_FORMAT_KEYS,
    FormatMatrixRow,
    build_format_matrix,
    is_shipped_import_source,
    shipped_emitters,
)

__all__ = [
    "SUPPORTED_FORMATS_DOCS_PAGE",
    "REGENERATE_COMMAND",
    "INTERNAL_FORMAT_KEYS",
    "FormatRow",
    "collect_format_rows",
    "is_shipped_import_source",
    "render_supported_formats_page",
    "shipped_emitters",
]

#: Path of the generated page, relative to the monorepo root.
SUPPORTED_FORMATS_DOCS_PAGE = "docs/guide/supported-formats.md"

#: The one command that regenerates the page. Quoted in the file header and in the drift test's
#: failure message, so a contributor who breaks the gate is told exactly how to fix it.
REGENERATE_COMMAND = "cd apiome-rest && uv run python scripts/generate_supported_formats_doc.py"

#: Paradigm section order and heading. Fixed rather than sorted so the page reads from the most
#: familiar paradigm to the most specialized, and so adding a paradigm is a deliberate edit here.
_PARADIGM_SECTIONS: Tuple[Tuple[ApiParadigm, str], ...] = (
    (ApiParadigm.REST, "REST"),
    (ApiParadigm.RPC, "RPC"),
    (ApiParadigm.EVENT, "Event"),
    (ApiParadigm.GRAPH, "Graph"),
    (ApiParadigm.DATA_SCHEMA, "Data schema"),
    (ApiParadigm.AGENT, "Agent"),
)

# ``INTERNAL_FORMAT_KEYS``, :func:`is_shipped_import_source` and :func:`shipped_emitters` are
# re-exported from :mod:`app.format_matrix`, which owns "what does this repository ship". They stay
# importable from here because the FMT-1.4 corpus parity gate reads them by this name, and because
# the set of documented formats and the set of gated formats must not drift apart.

#: The em dash used for "not applicable" cells, so an empty cell never reads as a missing fact.
_NONE = "—"


def _escape_cell(text: str) -> str:
    """Make ``text`` safe inside a Markdown table cell.

    A literal ``|`` would end the cell and silently shift every column after it, and a newline
    would end the row. Both are escaped/flattened rather than dropped, so no registry prose is lost.

    Args:
        text: Raw text from a registry descriptor or capability entry.

    Returns:
        The text with pipes escaped and all whitespace collapsed to single spaces.
    """
    return " ".join(text.replace("|", "\\|").split())


def _code_list(values: Sequence[str]) -> str:
    """Render ``values`` as comma-separated inline code, or the not-applicable dash.

    Args:
        values: Already-ordered tokens (format keys, extensions, input kinds).

    Returns:
        ``` `a`, `b` ``` style Markdown, or :data:`_NONE` when the sequence is empty.
    """
    if not values:
        return _NONE
    return ", ".join(f"`{_escape_cell(v)}`" for v in values)


@dataclass(frozen=True)
class FormatRow:
    """One format's row on the generated page.

    Every field is read from a registry — nothing here is asserted by this module — so a row is a
    view of the running system rather than a claim about it.
    """

    key: str
    label: str
    paradigm: ApiParadigm
    input_kinds: Tuple[str, ...]
    supports_live_discovery: bool
    format_keys: Tuple[str, ...]
    file_extensions: Tuple[str, ...]
    can_import: bool
    can_export: bool
    export_label: Optional[str]
    publishable: bool
    import_available: bool
    import_unavailable_reason: Optional[str]
    export_available: bool
    native_hierarchy: NativeHierarchy
    provenance: CapabilityProvenance
    boundary_notes: Tuple[str, ...]

    @property
    def direction(self) -> str:
        """The import/export column value: what a reader can actually do with this format."""
        if self.can_import and self.can_export:
            return "Import + export"
        if self.can_import:
            return "Import only"
        if self.can_export:
            return "Export only"
        return _NONE  # pragma: no cover - a row exists because one of the two is true

    @property
    def anchor(self) -> str:
        """The stable HTML anchor for this format's boundary entry."""
        return f"format-{self.key}"


def _row_from_matrix(entry: FormatMatrixRow) -> FormatRow:
    """Project one matrix row onto the page's row shape.

    A pure field mapping — every value already came from a registry when the matrix was built, so
    nothing is asserted or recomputed here.

    Args:
        entry: One row of :func:`app.format_matrix.build_format_matrix`.

    Returns:
        The page's view of that format.
    """
    return FormatRow(
        key=entry.key,
        label=entry.label,
        paradigm=entry.paradigm,
        input_kinds=tuple(entry.import_support.input_kinds),
        supports_live_discovery=entry.import_support.supports_live_discovery,
        format_keys=tuple(entry.version_coverage),
        file_extensions=tuple(entry.file_extensions),
        can_import=entry.import_support.supported,
        can_export=entry.export_support.supported,
        export_label=entry.export_support.label,
        publishable=entry.import_support.publishable,
        import_available=entry.import_support.available,
        import_unavailable_reason=entry.import_support.unavailable_reason,
        # A format with no emitter has no export to be unavailable: the page's availability cell
        # only ever speaks about an export that exists, so "not applicable" reads as available.
        export_available=(
            entry.export_support.available if entry.export_support.supported else True
        ),
        native_hierarchy=entry.capability.native_hierarchy,
        provenance=entry.capability.provenance,
        boundary_notes=tuple(entry.capability.notes),
    )


def collect_format_rows() -> List[FormatRow]:
    """Build one :class:`FormatRow` per documented format, sorted by label then key.

    Reads :func:`app.format_matrix.build_format_matrix` — the same payload
    ``GET /v1/formats/matrix`` serves — rather than walking the registries a second time, so the
    page and the endpoint describe an identical format surface by construction.

    Returns:
        The rows, deterministically ordered.
    """
    return [_row_from_matrix(entry) for entry in build_format_matrix().formats]


def _availability_cell(row: FormatRow) -> str:
    """Render the runtime-availability cell for one row.

    A format whose adapter hard-requires an absent toolchain is reported as unavailable **with the
    reason**, because "gRPC is unsupported" and "this deployment has no `buf`" are different facts
    and only one of them is about the product.
    """
    if row.can_import and not row.import_available:
        reason = row.import_unavailable_reason or "Requires a toolchain absent from this runtime."
        return f"Needs toolchain — {_escape_cell(reason)}"
    if row.can_export and not row.export_available:
        return "Export needs a toolchain absent from this runtime"
    return "Ready"


def _hierarchy_cell(row: FormatRow) -> str:
    """Render the analysis-fidelity cell, linking to the format's boundary entry.

    ``native`` means the analyzer keeps the format's own vocabulary (an X12 envelope stays an
    envelope); ``generic`` means the format-blind walk. A reviewed entry links to its notes.
    """
    if row.native_hierarchy is NativeHierarchy.NATIVE:
        text = "Format-native"
    elif row.native_hierarchy is NativeHierarchy.GENERIC:
        text = "Generic"
    else:
        text = _NONE
    if row.provenance is CapabilityProvenance.REVIEWED:
        return f"[{text} (reviewed)](#{row.anchor})"
    return text


def _format_table(rows: Sequence[FormatRow]) -> List[str]:
    """Render the Markdown table for one paradigm section.

    Args:
        rows: The rows in that paradigm, already ordered.

    Returns:
        The table's lines, header first.
    """
    lines = [
        "| Format | Key | Direction | Publishable | Input kinds | Live discovery "
        "| Format keys | File extensions | Analysis | Runtime |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_cell(row.label),
                    f"`{_escape_cell(row.key)}`",
                    row.direction,
                    "Project" if row.publishable else "Catalog",
                    _code_list(row.input_kinds),
                    "Yes" if row.supports_live_discovery else _NONE,
                    _code_list(row.format_keys),
                    _code_list(row.file_extensions),
                    _hierarchy_cell(row),
                    _availability_cell(row),
                )
            )
            + " |"
        )
    return lines


def _header(rows: Sequence[FormatRow]) -> List[str]:
    """Render the page header: the generated-file warning and the headline counts."""
    importable = [r for r in rows if r.can_import]
    exportable = [r for r in rows if r.can_export]
    both = [r for r in rows if r.can_import and r.can_export]
    catalog = [r for r in importable if not r.publishable]
    discovery = [r for r in importable if r.supports_live_discovery]

    return [
        "# Supported formats",
        "",
        "<!-- GENERATED FILE — do not edit by hand.",
        f"     Regenerate with: {REGENERATE_COMMAND} -->",
        "",
        "Every format Apiome reads or writes, generated from the running registries — the "
        "import-source registry, the emitter registry, and the source-format capability registry. "
        "It is regenerated by one command and drift-checked in CI, so this page cannot quietly "
        "fall behind the code the way a hand-maintained list does.",
        "",
        f"- **{len(importable)} formats can be imported.**",
        f"- **{len(exportable)} formats can be exported.**",
        f"- **{len(both)} round-trip** — import *and* export.",
        f"- **{len(discovery)}** can introspect a live endpoint rather than reading a file.",
        "",
        "The same answer is machine-readable at `GET /v1/formats/matrix` and printed by "
        "`apiome formats` (`--json`, `--paradigm`, `--direction`). This page is *rendered from "
        "that response*, so the documentation, the API and the CLI cannot disagree: there is one "
        "traversal of the registries behind all three.",
        "",
        "## Which importer handles which format",
        "",
        "Apiome has two importers, and which one a format uses is decided by the server "
        "(`app.import_routing`), not by where you started:",
        "",
        "- **OpenAPI and Swagger become a publishable Project.** They normalize onto the editable "
        "class/path model, so they can be versioned, linted and published. This is the "
        "**Projects importer**, and its four format keys (`openapi-3.0`, `openapi-3.1`, "
        "`openapi-3.2`, `swagger-2.0`) are the set the older documentation described as the whole "
        "of Apiome's format support.",
        f"- **The other {len(catalog)} formats become a catalog item.** Protobuf, GraphQL, "
        "AsyncAPI, Thrift, EDI X12, COBOL copybooks, FHIR, HL7 v2 and the rest are imported by "
        "the **Catalog importer** and stored with their own structure intact rather than being "
        "forced into the OpenAPI shape. Catalog items are searchable, diffable and convertible; "
        "they are not publishable until converted.",
        "",
        "The **Direction** column below says whether a format can be imported, exported, or both. "
        "The **Publishable** column says which of the two importers claims it.",
        "",
        "## Reading the table",
        "",
        "| Column | Meaning |",
        "| --- | --- |",
        "| **Key** | The stable registry key. This is the `source_kind` the REST API "
        "and CLI take. |",
        "| **Direction** | Whether the format can be imported, exported, or both. |",
        "| **Publishable** | `Project` mints a publishable project; `Catalog` stores a "
        "catalog item. Routing branches on the format a document *normalizes to*, not the "
        "tool that read it — so a format that converts to OpenAPI first (TypeSpec, say) "
        "produces a Project on that path. |",
        "| **Input kinds** | How a document can reach the adapter: uploaded `file`, `url`, "
        "pasted `paste`, live `discovery`, or a multi-file `fileset` (an archive or "
        "repository). |",
        "| **Live discovery** | The adapter can introspect a running endpoint instead of "
        "reading a document. |",
        "| **Format keys** | The version coverage — every format string the adapter emits, "
        "so a specific version can be requested. |",
        "| **File extensions** | What the file pickers offer for this format. Advisory: "
        "content sniffing decides, so an unlisted extension is still accepted. |",
        "| **Analysis** | `Format-native` keeps the format's own vocabulary (an X12 envelope "
        "stays an envelope); `Generic` uses the format-blind walk. Reviewed entries link to "
        "their boundary notes. |",
        "| **Runtime** | `Ready`, or the toolchain this deployment is missing. An unavailable "
        "format is still *supported* — this deployment just cannot run it. |",
        "",
    ]


def _boundaries_section(rows: Sequence[FormatRow]) -> List[str]:
    """Render the reviewed-boundary notes.

    Only formats whose capability entry is **reviewed** contribute prose. A derived entry states
    only what the adapter declared about itself, which is not a boundary statement anyone reviewed,
    and printing it here would dress an inference up as a promise.
    """
    reviewed = [r for r in rows if r.provenance is CapabilityProvenance.REVIEWED and r.boundary_notes]
    lines = [
        "## Format boundaries",
        "",
        "What these formats knowingly do **not** model, from the source-format capability registry "
        "(`GET /v1/import/format-capabilities`). Only reviewed entries appear: every other format's "
        "entry is derived from its adapter's own declarations, which is not a reviewed claim about "
        "boundaries and is not presented as one here.",
        "",
    ]
    if not reviewed:  # pragma: no cover - the registry ships reviewed entries
        lines.extend(["*No reviewed boundary entries are registered.*", ""])
        return lines

    for row in reviewed:
        lines.append(f'<a id="{row.anchor}"></a>')
        lines.append("")
        lines.append(f"### {row.label}")
        lines.append("")
        for note in row.boundary_notes:
            lines.append(f"- {' '.join(note.split())}")
        lines.append("")
    return lines


def render_supported_formats_page() -> str:
    """Render the whole ``docs/guide/supported-formats.md`` page.

    Deterministic: the same registries always produce the same bytes, which is what makes the
    committed page drift-checkable.

    Returns:
        The complete Markdown document, newline-terminated.
    """
    rows = collect_format_rows()
    lines: List[str] = list(_header(rows))

    for paradigm, heading in _PARADIGM_SECTIONS:
        section_rows = [row for row in rows if row.paradigm is paradigm]
        if not section_rows:
            continue
        lines.append(f"## {heading}")
        lines.append("")
        lines.extend(_format_table(section_rows))
        lines.append("")

    lines.extend(_boundaries_section(rows))

    lines.extend(
        [
            "## Related",
            "",
            "- [How do I… import a specification?](import-a-spec.md)",
            "- [How do I… export a specification?](export-a-spec.md)",
            "- [Catalog format details](catalog-format-details.md) — what a catalog item "
            "records per format.",
            "- [Export fidelity](export-fidelity.md) — what survives a conversion between formats.",
            "",
        ]
    )

    return "\n".join(lines).rstrip("\n") + "\n"
