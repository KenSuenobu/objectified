"""Corpus parity gate and coverage report — FMT-1.4 (#5415).

Fixture coverage used to be maintained by convention: an adapter was registered, and somebody
remembered to add examples, negatives, a golden directory and a round-trip row. Convention held
while there were forty adapters. The format-matrix roadmap adds roughly forty more, and #5414
showed how it fails — ``asyncapi`` shipped with intake examples but no golden corpus and a
round-trip row of thirty-five skipped cells, and nothing said so.

This module is the machine-checkable replacement. It enumerates the **live** registries — every
shipped, non-preview import adapter and every shipped emitter — and, for each, resolves the four
artifacts a registered format is required to carry:

#. **Corpus examples.** A manifest entry set under ``apiome-ui/examples/<directory>/`` with at
   least one ``valid`` entry and at least one ``negative`` (``invalid``) entry.
#. **Golden snapshots.** At least one canonical snapshot under
   ``apiome-rest/tests/golden/corpus/<directory>/``, so the format's canonical model is pinned.
#. **A round-trip matrix row.** The format appears in the committed matrix artifact, and — when it
   also has an emitter — its self round-trip cell exists and either passes or carries a recorded
   reason (the ``xfail`` convention of :mod:`tests.roundtrip_xfails`).
#. **A capability registry entry.** :func:`app.format_capability_registry.capability_for` resolves
   to something better than ``unknown_format``.

A requirement a format genuinely cannot meet is **waived by name and reason** in
:mod:`tests.corpus_parity_waivers`, never by silence — and a waiver is strict, so a waived
requirement that starts being satisfied fails the suite until the waiver is deleted.

**This gate is deterministic and environment-independent.** Its inputs are the corpus manifest,
the files on disk, the *committed* round-trip matrix artifact and the adapter registry — never a
live parse, an emit, or a toolchain probe. That is deliberate: the golden corpus, the matrix
artifact and the generated supported-formats page all encode which bundled binaries existed on the
machine that produced them, so a parity report built from live runs would report a developer's
missing ``buf`` as a coverage gap. Parity asks "does the artifact exist", which is the same answer
everywhere.

The report itself is committed at :data:`ARTIFACT_PATH` (JSON) and :data:`MARKDOWN_PATH`
(human-readable) and drift-checked, so a fixture added without a regeneration turns CI red and a
coverage change lands as a reviewable diff rather than as a silent shift.
"""

from __future__ import annotations

import os
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from corpus_loader import CorpusEntry, Rung, ValidityClass, load_manifest
from corpus_parity_waivers import (
    KNOWN_EXPORT_ONLY_DESTINATIONS,
    KNOWN_PARITY_WAIVERS,
)
from corpus_roundtrip import ARTIFACT_PATH as MATRIX_ARTIFACT_PATH
from corpus_snapshot import GOLDEN_ROOT, golden_paths_on_disk
from pydantic import BaseModel, ConfigDict, Field

from app.format_capability_registry import CapabilityProvenance, capability_for
from app.import_source import (
    ImportSourceDescriptor,
    describe_import_sources,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)
from app.roundtrip_matrix import MatrixCellStatus, RoundTripMatrix
from app.supported_formats_doc import (
    INTERNAL_FORMAT_KEYS,
    is_shipped_import_source,
    shipped_emitters,
)

__all__ = [
    "ARTIFACT_PATH",
    "MARKDOWN_PATH",
    "REGENERATE_COMMAND",
    "REPORT_VERSION",
    "UPDATE_PARITY_ENV",
    "ExcludedFormat",
    "FixtureCounts",
    "FormatParity",
    "ParityReport",
    "ParityRequirement",
    "RequirementStatus",
    "RoundTripCell",
    "build_report",
    "corpus_directory",
    "evaluate_format",
    "gap_summary",
    "load_matrix",
    "load_report",
    "render_markdown",
    "updating_report",
    "write_report",
]

#: Envelope version of the report shape. Bump only when the report's own structure changes, so a
#: wholesale regeneration is distinguishable in review from a coverage regression.
REPORT_VERSION = 1

#: The committed machine-readable coverage report.
ARTIFACT_PATH = Path(__file__).resolve().parent / "golden" / "parity" / "corpus_parity.json"

#: The committed human-readable companion, published by CI alongside the JSON.
MARKDOWN_PATH = ARTIFACT_PATH.with_suffix(".md")

#: Set to ``1`` to rewrite the committed report instead of comparing against it. Mirrors
#: ``UPDATE_CORPUS_GOLDENS`` / ``UPDATE_ROUNDTRIP_MATRIX``.
UPDATE_PARITY_ENV = "UPDATE_CORPUS_PARITY"

#: The one command that regenerates both report files. Quoted in the report header and in every
#: drift failure message, so a contributor who breaks the gate is told exactly how to fix it.
REGENERATE_COMMAND = "cd apiome-rest && uv run python scripts/generate_corpus_parity_report.py"


class ParityRequirement(str, Enum):
    """The artifacts a registered adapter must carry (the ticket's four, examples split in two).

    ``VALID_EXAMPLES`` and ``NEGATIVE_EXAMPLES`` are the two halves of the ticket's single
    "at least one ``valid`` and one ``negative`` entry" artifact; they are separate members so a
    failure names the half that is missing and a waiver can cover one without excusing the other.
    """

    #: At least one ``valid`` manifest entry owned by the adapter.
    VALID_EXAMPLES = "valid-examples"
    #: At least one ``invalid`` manifest entry owned by the adapter.
    NEGATIVE_EXAMPLES = "negative-examples"
    #: At least one committed golden snapshot per corpus directory the adapter owns.
    GOLDEN_SNAPSHOTS = "golden-snapshots"
    #: A row in the committed round-trip matrix, plus a reasoned self cell where an emitter exists.
    ROUNDTRIP_MATRIX = "roundtrip-matrix"
    #: A ``format_capability_registry`` entry that is not ``unknown_format``.
    CAPABILITY_ENTRY = "capability-entry"


class RequirementStatus(str, Enum):
    """Whether a format meets a requirement, is excused from it, or fails it."""

    #: The artifact exists.
    SATISFIED = "satisfied"
    #: The artifact does not exist, and :mod:`tests.corpus_parity_waivers` says why.
    WAIVED = "waived"
    #: The artifact does not exist and nothing explains it — this is what fails the gate.
    MISSING = "missing"


class FixtureCounts(BaseModel):
    """How many corpus fixtures of each tier a format owns."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    valid: int = Field(ge=0, description="``valid`` entries, fileset members included.")
    negative: int = Field(ge=0, description="``invalid`` entries.")
    adversarial: int = Field(ge=0, description="``adversarial`` entries.")
    scale: int = Field(
        default=0,
        ge=0,
        description="``scale`` entries. Normally zero — scale documents are generated at test time.",
    )
    total: int = Field(ge=0, description="Every manifest entry the adapter owns.")


class RoundTripCell(BaseModel):
    """One self round-trip cell (``format → its own emitter``) read from the matrix artifact."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    source_format: str
    emit_key: str
    #: ``None`` when the matrix artifact has no such cell at all.
    status: Optional[str] = None
    #: Whether the cell carries a non-empty reason. A non-passing cell without one is a silent
    #: hole, which is exactly what this gate exists to reject.
    has_reason: bool = False


class FormatParity(BaseModel):
    """One registered adapter's coverage across all four required artifacts."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    format_key: str = Field(description="Import-source registry key.")
    label: str = Field(description="The adapter's human label.")
    paradigm: str = Field(description="The adapter's canonical paradigm.")
    corpus_formats: Tuple[str, ...] = Field(
        description="Manifest ``format`` keys the adapter owns (``openapi`` also owns ``swagger``).",
    )
    corpus_directories: Tuple[str, ...] = Field(
        description="Directories under ``apiome-ui/examples/`` the adapter's entries live in.",
    )
    fixtures: FixtureCounts
    rungs: Tuple[str, ...] = Field(description="Ladder rungs the adapter's valid entries cover.")
    rung_waivers: Tuple[str, ...] = Field(description="Rungs excused in the manifest.")
    goldens: int = Field(ge=0, description="Committed golden snapshots under the adapter's dirs.")
    golden_directories: Tuple[str, ...] = Field(
        default=(),
        description="Corpus directories that hold at least one committed golden snapshot.",
    )
    emit_key: Optional[str] = Field(
        default=None,
        description="Emitter registry-descriptor key, or ``None`` for an import-only format.",
    )
    roundtrip_row: bool = Field(description="Whether every corpus format has a matrix row.")
    roundtrip_cells: Tuple[RoundTripCell, ...] = Field(
        default=(),
        description="Self round-trip cells; empty for an import-only format.",
    )
    capability_provenance: str = Field(description="``reviewed`` / ``derived`` / ``unknown_format``.")
    requirements: Dict[ParityRequirement, RequirementStatus]
    waivers: Dict[ParityRequirement, str] = Field(
        default_factory=dict,
        description="Reason text for each waived requirement.",
    )

    @property
    def gaps(self) -> List[ParityRequirement]:
        """Requirements this format fails outright, in declaration order."""
        return [
            requirement
            for requirement in ParityRequirement
            if self.requirements.get(requirement) is RequirementStatus.MISSING
        ]

    @property
    def waived(self) -> List[ParityRequirement]:
        """Requirements this format is excused from, in declaration order."""
        return [
            requirement
            for requirement in ParityRequirement
            if self.requirements.get(requirement) is RequirementStatus.WAIVED
        ]


class ExcludedFormat(BaseModel):
    """A registered key the gate deliberately does not require fixtures for."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    format_key: str
    reason: str


class ParityReport(BaseModel):
    """The whole coverage report: one entry per registered format, plus what was excluded."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    report_version: int = REPORT_VERSION
    formats: Tuple[FormatParity, ...]
    excluded_formats: Tuple[ExcludedFormat, ...] = Field(
        default=(),
        description=(
            "Shipped registry keys that are internal machinery or preview-only, with the reason "
            "each is exempt. Adapters registered at runtime by a test or a caller are absent "
            "entirely, so the report does not depend on what else ran in the process."
        ),
    )
    export_only_destinations: Tuple[str, ...] = Field(
        default=(),
        description="Shipped emitters with no import adapter behind them, so no corpus can cover them.",
    )
    pending_corpus_directories: Tuple[str, ...] = Field(
        default=(),
        description="Corpus directories whose entries declare no adapter — fixtures staged ahead of one.",
    )

    def to_json(self) -> str:
        """Serialize deterministically: sorted keys, two-space indent, trailing newline."""
        return self.model_dump_json(indent=2) + "\n"

    def format_map(self) -> Dict[str, FormatParity]:
        """``{format_key: entry}`` for lookups by key."""
        return {entry.format_key: entry for entry in self.formats}

    @property
    def failing(self) -> List[FormatParity]:
        """Every format with at least one unwaived gap."""
        return [entry for entry in self.formats if entry.gaps]


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def corpus_directory(entry_path: str) -> str:
    """Return the corpus directory a manifest path lives in.

    ``openapi/negative/01-truncated.yaml`` and ``openapi/01-minimal.yaml`` both live in
    ``openapi``: tiers and multi-file sets are subdirectories of the format's directory, and the
    golden store mirrors that layout, so the first segment is the unit both sides agree on.

    Args:
        entry_path: A manifest ``path``, relative to ``apiome-ui/examples/``.

    Returns:
        The first path segment.
    """
    return PurePosixPath(entry_path).parts[0]


def load_matrix(path: Path = MATRIX_ARTIFACT_PATH) -> Optional[RoundTripMatrix]:
    """Load the committed round-trip matrix artifact.

    Args:
        path: The artifact path (overridable for tests).

    Returns:
        The parsed matrix, or ``None`` when the artifact has never been generated — which the
        gate reports as a missing round-trip row for every format rather than as a crash.
    """
    if not path.is_file():
        return None
    return RoundTripMatrix.model_validate_json(path.read_text(encoding="utf-8"))


def _emitter_key_for(format_key: str) -> Optional[str]:
    """The registry-descriptor key of the emitter behind ``format_key``, if any."""
    descriptor = shipped_emitters().get(format_key)
    return descriptor.key if descriptor is not None else None


def _exemption_reason(descriptor: ImportSourceDescriptor) -> Optional[str]:
    """Why this shipped adapter is exempt from the parity gate, or ``None`` when it is not.

    Two exemptions, both meaning "this is not a format a user can be sold": an internal
    machinery key (the same :data:`app.supported_formats_doc.INTERNAL_FORMAT_KEYS` the generated
    supported-formats page excludes) and a preview-only adapter, which the corpus floors in
    :mod:`tests.test_corpus_manifest` exempt as well.

    Args:
        descriptor: A shipped adapter's registry descriptor.

    Returns:
        The reason, or ``None`` when the adapter is gated.
    """
    if descriptor.key in INTERNAL_FORMAT_KEYS:
        return "internal machinery, not a format a user can import"
    adapter = get_import_source(descriptor.key)
    if adapter is not None and adapter.preview_only:
        return "preview-only adapter, exempt from the corpus floors as well"
    return None


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def evaluate_format(
    *,
    format_key: str,
    label: str,
    paradigm: str,
    entries: Sequence[CorpusEntry],
    golden_paths: Iterable[str],
    matrix: Optional[RoundTripMatrix],
    emit_key: Optional[str],
    capability_provenance: CapabilityProvenance,
    rung_waivers: Optional[Mapping[Rung, str]] = None,
    waivers: Mapping[Tuple[str, str], str] = KNOWN_PARITY_WAIVERS,
) -> FormatParity:
    """Resolve one format's four required artifacts into a :class:`FormatParity`.

    Pure: every input is passed in, so the gate's logic is unit-testable against synthetic
    corpora instead of only against whatever the repository happens to contain today.

    Args:
        format_key: The import-source registry key being evaluated.
        label: The adapter's human label, for the report.
        paradigm: The adapter's paradigm value, for the report.
        entries: Every manifest entry owned by this adapter (all tiers).
        golden_paths: Corpus-relative paths that have a committed golden snapshot.
        matrix: The committed round-trip matrix, or ``None`` when it does not exist.
        emit_key: The emitter's registry-descriptor key, or ``None`` if the format is import-only.
        capability_provenance: What ``capability_for(format_key)`` reports.
        rung_waivers: The manifest's ``rung_waivers`` for this adapter (``None`` for none).
        waivers: ``(format_key, requirement_value) -> reason`` overrides.

    Returns:
        The format's coverage record, with one :class:`RequirementStatus` per requirement.
    """
    directories = tuple(sorted({corpus_directory(entry.path) for entry in entries}))
    corpus_formats = tuple(sorted({entry.format for entry in entries}))

    by_class = {
        validity: [entry for entry in entries if entry.validity_class is validity]
        for validity in ValidityClass
    }
    counts = FixtureCounts(
        valid=len(by_class[ValidityClass.VALID]),
        negative=len(by_class[ValidityClass.INVALID]),
        adversarial=len(by_class[ValidityClass.ADVERSARIAL]),
        scale=len(by_class[ValidityClass.SCALE]),
        total=len(entries),
    )

    directory_set = set(directories)
    golden_set = set(golden_paths)
    goldens = sum(1 for path in golden_set if corpus_directory(path) in directory_set)
    golden_dirs = {corpus_directory(path) for path in golden_set}
    directories_with_goldens = directory_set & golden_dirs

    matrix_formats = set(matrix.source_formats) if matrix is not None else set()
    cell_map = (
        {(cell.source_format, cell.emit_key): cell for cell in matrix.cells}
        if matrix is not None
        else {}
    )
    roundtrip_row = bool(corpus_formats) and matrix_formats.issuperset(corpus_formats)

    cells: List[RoundTripCell] = []
    if emit_key is not None:
        for source_format in corpus_formats:
            cell = cell_map.get((source_format, emit_key))
            cells.append(
                RoundTripCell(
                    source_format=source_format,
                    emit_key=emit_key,
                    status=cell.status.value if cell is not None else None,
                    has_reason=bool(cell is not None and (cell.reason or "").strip()),
                )
            )
    cells_ok = all(
        cell.status is not None
        and (cell.status == MatrixCellStatus.PASS.value or cell.has_reason)
        for cell in cells
    )

    satisfied: Dict[ParityRequirement, bool] = {
        ParityRequirement.VALID_EXAMPLES: counts.valid > 0,
        ParityRequirement.NEGATIVE_EXAMPLES: counts.negative > 0,
        ParityRequirement.GOLDEN_SNAPSHOTS: (
            bool(directories) and directories_with_goldens == directory_set
        ),
        ParityRequirement.ROUNDTRIP_MATRIX: roundtrip_row and cells_ok,
        ParityRequirement.CAPABILITY_ENTRY: (
            capability_provenance is not CapabilityProvenance.UNKNOWN_FORMAT
        ),
    }

    requirements: Dict[ParityRequirement, RequirementStatus] = {}
    applied_waivers: Dict[ParityRequirement, str] = {}
    for requirement, is_satisfied in satisfied.items():
        reason = waivers.get((format_key, requirement.value))
        if is_satisfied:
            requirements[requirement] = RequirementStatus.SATISFIED
        elif reason:
            requirements[requirement] = RequirementStatus.WAIVED
            applied_waivers[requirement] = reason
        else:
            requirements[requirement] = RequirementStatus.MISSING

    rungs = tuple(
        sorted({entry.rung.value for entry in by_class[ValidityClass.VALID] if entry.rung})
    )
    return FormatParity(
        format_key=format_key,
        label=label,
        paradigm=paradigm,
        corpus_formats=corpus_formats,
        corpus_directories=directories,
        fixtures=counts,
        rungs=rungs,
        rung_waivers=tuple(sorted(rung.value for rung in (rung_waivers or {}))),
        goldens=goldens,
        golden_directories=tuple(sorted(directories_with_goldens)),
        emit_key=emit_key,
        roundtrip_row=roundtrip_row,
        roundtrip_cells=tuple(cells),
        capability_provenance=capability_provenance.value,
        requirements=requirements,
        waivers=applied_waivers,
    )


def build_report(
    *,
    entries: Optional[Sequence[CorpusEntry]] = None,
    golden_paths: Optional[Iterable[str]] = None,
    matrix: Optional[RoundTripMatrix] = None,
    waivers: Mapping[Tuple[str, str], str] = KNOWN_PARITY_WAIVERS,
    export_only: Mapping[str, str] = KNOWN_EXPORT_ONLY_DESTINATIONS,
) -> ParityReport:
    """Build the coverage report from the live registries and the committed artifacts.

    Args:
        entries: Manifest entries to evaluate (default: the whole corpus manifest).
        golden_paths: Corpus paths with a committed golden (default: read from the golden store).
        matrix: The round-trip matrix (default: read from the committed artifact).
        waivers: ``(format_key, requirement_value) -> reason`` overrides.
        export_only: Emitter import keys knowingly shipped without an import adapter.

    Returns:
        The report, with formats ordered by registry key.
    """
    load_builtin_import_sources()
    manifest = load_manifest()
    all_entries = list(entries) if entries is not None else list(manifest.entries)
    paths = list(golden_paths) if golden_paths is not None else golden_paths_on_disk()
    live_matrix = matrix if matrix is not None else load_matrix()

    owned: Dict[str, List[CorpusEntry]] = {}
    unowned_directories: set[str] = set()
    for entry in all_entries:
        if entry.adapter_key is None:
            unowned_directories.add(corpus_directory(entry.path))
            continue
        owned.setdefault(resolve_import_source_key(entry.adapter_key), []).append(entry)

    emitters = shipped_emitters()
    formats: List[FormatParity] = []
    excluded: List[ExcludedFormat] = []
    for descriptor in sorted(describe_import_sources(), key=lambda d: d.key):
        # Adapters that are not defined in this repository are not reported at all, exempt or
        # otherwise: sibling test modules register throwaway adapters and do not always remove
        # them, and a committed report whose contents depend on what else ran in the pytest
        # session could not be drift-checked. Same rule as the generated supported-formats page.
        if not is_shipped_import_source(descriptor.key):
            continue
        reason = _exemption_reason(descriptor)
        if reason is not None:
            excluded.append(ExcludedFormat(format_key=descriptor.key, reason=reason))
            continue
        formats.append(
            evaluate_format(
                format_key=descriptor.key,
                label=descriptor.label,
                paradigm=descriptor.paradigm.value,
                entries=owned.get(descriptor.key, []),
                golden_paths=paths,
                matrix=live_matrix,
                emit_key=_emitter_key_for(descriptor.key),
                capability_provenance=capability_for(descriptor.key).provenance,
                rung_waivers=manifest.rung_waivers.get(descriptor.key, {}),
                waivers=waivers,
            )
        )

    registered = {
        descriptor.key
        for descriptor in describe_import_sources()
        if is_shipped_import_source(descriptor.key)
    }
    orphan_emitters = tuple(
        sorted(key for key in emitters if key not in registered and key not in export_only)
    )
    return ParityReport(
        report_version=REPORT_VERSION,
        formats=tuple(formats),
        excluded_formats=tuple(sorted(excluded, key=lambda item: item.format_key)),
        export_only_destinations=orphan_emitters,
        pending_corpus_directories=tuple(sorted(unowned_directories)),
    )


def gap_summary(report: ParityReport) -> List[str]:
    """Render one human line per unwaived gap, for a failure message.

    Args:
        report: The coverage report.

    Returns:
        ``"<format>: <requirement> — <what is missing>"`` lines, format-sorted.
    """
    lines: List[str] = []
    for entry in report.formats:
        for requirement in entry.gaps:
            lines.append(f"{entry.format_key}: {requirement.value} — {_gap_detail(entry, requirement)}")
    return lines


def _gap_detail(entry: FormatParity, requirement: ParityRequirement) -> str:
    """One sentence naming what is missing and where it belongs."""
    if requirement is ParityRequirement.VALID_EXAMPLES:
        return (
            "no `valid` corpus entry declares this adapter; add fixtures under "
            f"apiome-ui/examples/{entry.format_key}/ and list them in corpus.manifest.json"
        )
    if requirement is ParityRequirement.NEGATIVE_EXAMPLES:
        return (
            "no `invalid` corpus entry declares this adapter; add fixtures under "
            f"apiome-ui/examples/{entry.format_key}/negative/"
        )
    if requirement is ParityRequirement.GOLDEN_SNAPSHOTS:
        without = sorted(set(entry.corpus_directories) - set(entry.golden_directories))
        where = ", ".join(without) if without else entry.format_key
        return (
            f"no golden snapshot under {GOLDEN_ROOT.name}/{where}/; regenerate with "
            "`uv run pytest tests/test_corpus_golden.py --update-golden`"
        )
    if requirement is ParityRequirement.ROUNDTRIP_MATRIX:
        if not entry.roundtrip_row:
            return (
                "no round-trip matrix row; regenerate with "
                "`UPDATE_ROUNDTRIP_MATRIX=1 uv run pytest tests/test_roundtrip_matrix.py`"
            )
        bad = [
            f"{cell.source_format}->{cell.emit_key}={cell.status or 'absent'}"
            for cell in entry.roundtrip_cells
            if cell.status is None
            or (cell.status != MatrixCellStatus.PASS.value and not cell.has_reason)
        ]
        return (
            "self round-trip cell missing or unreasoned (" + ", ".join(bad) + "); record it in "
            "tests/roundtrip_xfails.py with a reason"
        )
    return (
        "format_capability_registry resolves to `unknown_format`; the adapter is not registered "
        "under this key at capability-lookup time"
    )


# ---------------------------------------------------------------------------
# Rendering & persistence
# ---------------------------------------------------------------------------

_STATUS_MARK = {
    RequirementStatus.SATISFIED: "✅",
    RequirementStatus.WAIVED: "⚠️",
    RequirementStatus.MISSING: "❌",
}

_REQUIREMENT_HEADINGS: Tuple[Tuple[ParityRequirement, str], ...] = (
    (ParityRequirement.VALID_EXAMPLES, "Valid examples"),
    (ParityRequirement.NEGATIVE_EXAMPLES, "Negative examples"),
    (ParityRequirement.GOLDEN_SNAPSHOTS, "Golden snapshots"),
    (ParityRequirement.ROUNDTRIP_MATRIX, "Round-trip row"),
    (ParityRequirement.CAPABILITY_ENTRY, "Capability entry"),
)


def render_markdown(report: ParityReport) -> str:
    """Render the human-readable coverage report.

    Deterministic — same report in, same bytes out — so it can be drift-checked like the JSON.

    Args:
        report: The coverage report.

    Returns:
        The Markdown document, ending in a newline.
    """
    total = len(report.formats)
    failing = report.failing
    waived = [entry for entry in report.formats if entry.waived]
    lines: List[str] = [
        "# Corpus parity report",
        "",
        "<!-- GENERATED FILE — do not edit by hand. -->",
        f"<!-- Regenerate with: {REGENERATE_COMMAND} -->",
        "",
        "Every shipped, non-preview import adapter must carry four artifacts: corpus examples "
        "(at least one valid and one negative), a golden snapshot directory, a round-trip matrix "
        "row, and a `format_capability_registry` entry. This report is what the FMT-1.4 parity "
        "gate (`apiome-rest/tests/test_corpus_parity.py`) asserts.",
        "",
        f"- **Formats gated:** {total}",
        f"- **Formats with an unwaived gap:** {len(failing)}",
        f"- **Formats with a waived requirement:** {len(waived)}",
        "",
        "## Fixture counts",
        "",
        "| Format | Label | Paradigm | Valid | Negative | Adversarial | Scale | Total | Rungs | "
        "Goldens | Emitter |",
        "|---|---|---|---:|---:|---:|---:|---:|---|---:|---|",
    ]
    for entry in report.formats:
        rungs = f"{len(entry.rungs)}/6"
        if entry.rung_waivers:
            rungs += f" (+{len(entry.rung_waivers)} waived)"
        lines.append(
            f"| `{entry.format_key}` | {entry.label} | {entry.paradigm} | "
            f"{entry.fixtures.valid} | {entry.fixtures.negative} | {entry.fixtures.adversarial} | "
            f"{entry.fixtures.scale} | {entry.fixtures.total} | {rungs} | {entry.goldens} | "
            + (f"`{entry.emit_key}`" if entry.emit_key else "\u2014")
            + " |"
        )

    lines += [
        "",
        "## Required artifacts",
        "",
        "\u2705 present \u00b7 \u26a0\ufe0f waived with a reason \u00b7 \u274c missing "
        "(this is what fails the gate).",
        "",
        "| Format | "
        + " | ".join(heading for _requirement, heading in _REQUIREMENT_HEADINGS)
        + " |",
        "|---|"
        + "|".join(":-:" for _ in _REQUIREMENT_HEADINGS)
        + "|",
    ]
    for entry in report.formats:
        marks = " | ".join(
            _STATUS_MARK[entry.requirements[requirement]]
            for requirement, _heading in _REQUIREMENT_HEADINGS
        )
        lines.append(f"| `{entry.format_key}` | {marks} |")

    lines += ["", "## Gaps", ""]
    gaps = gap_summary(report)
    if gaps:
        lines += [f"- {line}" for line in gaps]
    else:
        lines.append("None — every gated format carries all four artifacts.")

    lines += ["", "## Waived requirements", ""]
    if waived:
        lines.append("| Format | Requirement | Reason |")
        lines.append("|---|---|---|")
        for entry in waived:
            for requirement in entry.waived:
                lines.append(
                    f"| `{entry.format_key}` | `{requirement.value}` | "
                    f"{entry.waivers[requirement]} |"
                )
    else:
        lines.append("None.")

    lines += ["", "## Not gated", ""]
    if report.excluded_formats:
        lines.append("| Registry key | Why it is exempt |")
        lines.append("|---|---|")
        for excluded in report.excluded_formats:
            lines.append(f"| `{excluded.format_key}` | {excluded.reason} |")
    else:
        lines.append("None — every registered adapter is gated.")

    lines += [
        "",
        "## Corpus directories awaiting an adapter",
        "",
        "Fixtures staged ahead of the adapter that will claim them (`adapter_key: null`). They are "
        "not gated until an adapter registers, at which point every requirement above applies.",
        "",
    ]
    if report.pending_corpus_directories:
        lines.append(
            ", ".join(f"`{directory}`" for directory in report.pending_corpus_directories)
        )
    else:
        lines.append("None.")

    if report.export_only_destinations:
        lines += [
            "",
            "## Export-only destinations with no import adapter",
            "",
            "An emitter with no adapter behind it cannot be covered by the import corpus. Record "
            "it in `KNOWN_EXPORT_ONLY_DESTINATIONS` with a reason, or register an adapter.",
            "",
            ", ".join(f"`{key}`" for key in report.export_only_destinations),
        ]

    lines.append("")
    return "\n".join(lines)


def write_report(report: ParityReport, path: Path = ARTIFACT_PATH) -> None:
    """Write the JSON report and its Markdown companion.

    Args:
        report: The coverage report.
        path: The JSON artifact path; the Markdown lands beside it as ``.md``.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report.to_json(), encoding="utf-8")
    path.with_suffix(".md").write_text(render_markdown(report), encoding="utf-8")


def load_report(path: Path = ARTIFACT_PATH) -> Optional[ParityReport]:
    """Load the committed report, or ``None`` when it has never been generated.

    Args:
        path: The JSON artifact path.

    Returns:
        The parsed report, or ``None``.
    """
    if not path.is_file():
        return None
    return ParityReport.model_validate_json(path.read_text(encoding="utf-8"))


def updating_report(request: Any = None) -> bool:
    """Whether this run should rewrite the committed report instead of comparing it.

    True when ``UPDATE_CORPUS_PARITY=1`` or ``--update-corpus-parity`` was passed; mirrors
    :func:`corpus_roundtrip.updating_matrix`.

    Args:
        request: The pytest ``request`` fixture, or ``None`` outside pytest.

    Returns:
        ``True`` when the artifact should be rewritten.
    """
    if os.environ.get(UPDATE_PARITY_ENV, "").strip() in {"1", "true", "yes"}:
        return True
    if request is None:
        return False
    getoption = getattr(getattr(request, "config", None), "getoption", None)
    if getoption is None:
        return False
    return bool(getoption("--update-corpus-parity", default=False))
