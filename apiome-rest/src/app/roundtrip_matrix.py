"""Round-trip conformance matrix — IXH-1.7 (#5093).

The product claim is *import once, emit in every format with honest fidelity*.
Import and export were tested independently; this module proves the claim by
running a matrix over every ``(shipped source format × shipped emit target)``
cell:

1. import a representative document to the canonical model;
2. predict loss via the fidelity engine (:func:`~app.fidelity_engine.compute_lossiness_for_emitter`);
3. emit through the target;
4. re-import the emitted artifact through the matching import adapter;
5. compare the two models with :func:`~app.import_source.canonical_diff`;
6. reconcile every difference against the fidelity report — a ``DROP`` /
   ``APPROX`` / ``SYNTH`` finding must explain it; an unexplained difference
   fails, and a report that over-claims preservation (``OK`` on a construct
   that empirically changed or vanished) also fails.

Unsupported cells are **recorded explicitly** (CLX-2.4 style) rather than
omitted, so the published matrix is a complete grid. Results serialize to a
machine-readable artifact that IXH-1.8's corpus coverage report can render.

This module is pure application code (no pytest, no corpus loader) so the
Export Studio round-trip action (IXH-4.4) and ``apiome corpus verify`` (IXH-1.8)
can reuse the same reconcile path.
"""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import CanonicalApi
from .emitter import (
    EmitResult,
    Emitter,
    EmitterTarget,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from .fidelity_engine import compute_lossiness_for_emitter
from .fileset import IntakeFileset
from .import_source import (
    CanonicalDiff,
    CanonicalDiffEntry,
    DiffChangeKind,
    ImportSource,
    ImportSourceError,
    available_import_sources,
    canonical_diff,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)
from .lossiness import LossItem, LossinessKind, LossinessReport

__all__ = [
    "MATRIX_VERSION",
    "SAMPLE_EMIT_KEYS",
    "MatrixCellStatus",
    "MatchedDiff",
    "ReconciliationResult",
    "MatrixCellResult",
    "RoundTripMatrix",
    "normalize_format_key",
    "import_adapter_for_emit",
    "production_emit_targets",
    "classify_cell",
    "reconcile",
    "serialize_emitted_text",
    "emitted_fileset",
    "reimport_emitted",
    "import_source_text",
    "run_roundtrip",
    "empty_matrix",
]

#: Envelope version of the published matrix artifact. Bump only when the
#: artifact's own shape changes (not when a cell flips status).
MATRIX_VERSION = 1

#: Emit targets excluded from the production matrix (noop / demo emitters).
#: They still appear nowhere — the grid is production targets only — rather
#: than being silently dropped from an otherwise-complete listing.
SAMPLE_EMIT_KEYS = frozenset({"sample", "sample-noop"})

#: Emit key / format → import-adapter registry key. Corpus format keys that
#: differ from the adapter key (``api-blueprint``, ``protobuf``) and versioned
#: emit formats (``openapi-3.1``, ``asyncapi-3``, ``proto3``) resolve here so
#: the matrix has one stable join.
_EMIT_TO_IMPORT: Dict[str, Optional[str]] = {
    "sample": None,
    "sample-noop": None,
    "protobuf": "grpc",
    "proto3": "grpc",
    "openapi": "openapi",
    "openapi-3.1": "openapi",
    "openapi-3.0": "openapi",
    "asyncapi": "asyncapi",
    "asyncapi-3": "asyncapi",
    "asyncapi-2": "asyncapi",
    "api-blueprint": "apiblueprint",
    "apiblueprint": "apiblueprint",
    "apib": "apiblueprint",
    "swagger": "openapi",
}


class MatrixCellStatus(str, Enum):
    """Outcome of one ``(source_format × emit_target)`` matrix cell."""

    PASS = "pass"
    FAIL = "fail"
    UNSUPPORTED = "unsupported"
    SKIPPED = "skipped"
    XFAIL = "xfail"


class MatchedDiff(BaseModel):
    """One empirical diff entry paired with the fidelity finding that explains it."""

    model_config = ConfigDict(extra="forbid")

    entry: CanonicalDiffEntry
    finding: LossItem


class ReconciliationResult(BaseModel):
    """Outcome of joining a :class:`CanonicalDiff` to a :class:`LossinessReport`."""

    model_config = ConfigDict(extra="forbid")

    matched: List[MatchedDiff] = Field(default_factory=list)
    unexplained: List[CanonicalDiffEntry] = Field(default_factory=list)
    overclaims: List[LossItem] = Field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Whether every difference is explained and nothing over-claims preservation."""
        return not self.unexplained and not self.overclaims


class MatrixCellResult(BaseModel):
    """One published cell of the round-trip conformance matrix."""

    model_config = ConfigDict(extra="forbid")

    source_format: str
    emit_key: str
    emit_format: str
    corpus_path: Optional[str] = None
    status: MatrixCellStatus
    reason: Optional[str] = None
    unexplained: List[CanonicalDiffEntry] = Field(default_factory=list)
    overclaims: List[LossItem] = Field(default_factory=list)
    matched_count: int = 0
    diff_count: int = 0
    loss_drop: int = 0
    loss_approx: int = 0
    loss_synth: int = 0
    loss_ok: int = 0

    @property
    def cell_id(self) -> str:
        """Stable ``source→emit`` identity used as a map key and artifact id."""
        return f"{self.source_format}->{self.emit_key}"


class RoundTripMatrix(BaseModel):
    """The full published ``(source_format × emit_target)`` grid."""

    model_config = ConfigDict(extra="forbid")

    matrix_version: int = MATRIX_VERSION
    source_formats: List[str] = Field(default_factory=list)
    emit_keys: List[str] = Field(default_factory=list)
    cells: List[MatrixCellResult] = Field(default_factory=list)

    def cell_map(self) -> Dict[Tuple[str, str], MatrixCellResult]:
        """Index cells by ``(source_format, emit_key)``."""
        return {(c.source_format, c.emit_key): c for c in self.cells}

    def status_counts(self) -> Dict[str, int]:
        """Count cells per :class:`MatrixCellStatus` (zero-filled)."""
        counts = {status.value: 0 for status in MatrixCellStatus}
        for cell in self.cells:
            counts[cell.status.value] += 1
        return counts

    def to_json(self, *, indent: int = 2) -> str:
        """Serialize the matrix deterministically for the checked-in artifact."""
        payload = self.model_dump(mode="json")
        return json.dumps(payload, indent=indent, sort_keys=True) + "\n"

    def to_markdown(self) -> str:
        """Render a compact Markdown summary table for IXH-1.8 job summaries.

        Rows are source formats; columns are emit keys; each cell is a single
        status letter (``P``/``F``/``U``/``S``/``X``) so a 36×35 grid stays
        readable in a CI summary.
        """
        letter = {
            MatrixCellStatus.PASS: "P",
            MatrixCellStatus.FAIL: "F",
            MatrixCellStatus.UNSUPPORTED: "U",
            MatrixCellStatus.SKIPPED: "S",
            MatrixCellStatus.XFAIL: "X",
        }
        index = self.cell_map()
        header = "| source \\ emit | " + " | ".join(self.emit_keys) + " |"
        sep = "|---|" + "|".join(["---"] * len(self.emit_keys)) + "|"
        rows = [header, sep]
        for source in self.source_formats:
            cells = []
            for emit_key in self.emit_keys:
                cell = index.get((source, emit_key))
                cells.append(letter[cell.status] if cell else "?")
            rows.append(f"| {source} | " + " | ".join(cells) + " |")
        counts = self.status_counts()
        legend = (
            "\n\nLegend: P=pass F=fail U=unsupported S=skipped X=xfail. "
            f"Counts: {', '.join(f'{k}={v}' for k, v in counts.items())}."
        )
        return "\n".join(rows) + legend + "\n"


def normalize_format_key(key: str) -> str:
    """Normalize a corpus / emit / adapter format token for join lookups."""
    return key.strip().lower()


def import_adapter_for_emit(emit_key: str, emit_format: str) -> Optional[str]:
    """Return the import-adapter registry key that can re-import ``emit_format``.

    Returns ``None`` when the emit target has no matching import adapter (the
    cell is then ``unsupported`` — we cannot close the round-trip loop), or when
    the emit target is explicitly excluded (sample / noop).
    """
    load_builtin_import_sources()
    registered = set(available_import_sources())
    key_n = normalize_format_key(emit_key)
    fmt_n = normalize_format_key(emit_format)
    # Explicit ``None`` in the alias table means "do not round-trip" (sample).
    if key_n in _EMIT_TO_IMPORT and _EMIT_TO_IMPORT[key_n] is None:
        return None
    if fmt_n in _EMIT_TO_IMPORT and _EMIT_TO_IMPORT[fmt_n] is None:
        return None
    candidates: List[str] = []
    for token in (key_n, fmt_n):
        mapped = _EMIT_TO_IMPORT.get(token, token)
        if mapped:
            candidates.append(mapped)
        candidates.append(token)
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        resolved = resolve_import_source_key(candidate)
        if resolved in registered:
            return resolved
    return None


def production_emit_targets() -> List[EmitterTarget]:
    """Shipped emit targets included in the production matrix (excludes sample)."""
    load_builtin_emitters()
    return [
        target
        for target in describe_emit_targets()
        if target.descriptor.key not in SAMPLE_EMIT_KEYS
        and target.descriptor.format not in SAMPLE_EMIT_KEYS
    ]


def classify_cell(
    source_format: str,
    target: EmitterTarget,
    *,
    reason_override: Optional[str] = None,
) -> Optional[MatrixCellResult]:
    """Return an ``unsupported`` cell when the round-trip cannot run, else ``None``.

    A cell is unsupported when the emitter is unavailable in this runtime, or
    when no import adapter can re-ingest the emit format. ``reason_override``
    lets callers mark known-unsupported pairings without inventing coverage.
    """
    desc = target.descriptor
    if reason_override:
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=reason_override,
        )
    if not desc.available:
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=desc.unavailable_reason or "Emitter unavailable in this runtime.",
        )
    adapter_key = import_adapter_for_emit(desc.key, desc.format)
    if adapter_key is None:
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=(
                f"No import adapter can re-import emit format {desc.format!r} "
                f"(emit key {desc.key!r})."
            ),
        )
    return None


def _related(construct_key: str, entity_key: str) -> bool:
    """Whether a fidelity construct key concerns a canonical-diff entity key.

    Exact match, or a nested field/member under the entity (``User.email`` under
    ``User``). Empty entity keys (root) only match empty / ``root`` constructs.
    """
    if entity_key == "":
        return construct_key in ("", "root")
    return construct_key == entity_key or construct_key.startswith(entity_key + ".")


def _allowed_kinds(change: DiffChangeKind) -> frozenset[LossinessKind]:
    """Fidelity kinds that may explain a given empirical change."""
    if change is DiffChangeKind.REMOVED:
        return frozenset({LossinessKind.DROP})
    if change is DiffChangeKind.ADDED:
        return frozenset({LossinessKind.SYNTH})
    return frozenset({LossinessKind.APPROX, LossinessKind.DROP, LossinessKind.SYNTH})


def reconcile(diff: CanonicalDiff, report: LossinessReport) -> ReconciliationResult:
    """Join every empirical difference to a fidelity finding that explains it.

    Rules (identity on construct keys shared with the canonical model):

    * ``REMOVED`` ↔ ``DROP``
    * ``ADDED`` ↔ ``SYNTH``
    * ``CHANGED`` ↔ ``APPROX`` / ``DROP`` / ``SYNTH`` (including nested fields)

    Failures:

    * **unexplained** — a diff entry with no matching loss item of an allowed kind;
    * **overclaim** — an ``OK`` item whose construct equals a ``REMOVED`` /
      ``CHANGED`` entity (report claimed preservation; reality disagrees), or
      whose construct is nested under a ``REMOVED`` entity.
    """
    matched: List[MatchedDiff] = []
    unexplained: List[CanonicalDiffEntry] = []
    used_finding_ids: set[int] = set()

    for entry in diff.entries:
        allowed = _allowed_kinds(entry.change)
        explanation: Optional[LossItem] = None
        for item in report.items:
            if id(item) in used_finding_ids:
                continue
            if item.kind not in allowed:
                continue
            if not _related(item.construct_key, entry.key):
                continue
            explanation = item
            used_finding_ids.add(id(item))
            break
        if explanation is None:
            unexplained.append(entry)
        else:
            matched.append(MatchedDiff(entry=entry, finding=explanation))

    removed_or_changed = {
        e.key for e in diff.entries if e.change in (DiffChangeKind.REMOVED, DiffChangeKind.CHANGED)
    }
    removed = {e.key for e in diff.entries if e.change is DiffChangeKind.REMOVED}

    overclaims: List[LossItem] = []
    for item in report.items:
        if item.kind is not LossinessKind.OK:
            continue
        # Exact: report says this entity is preserved, but it changed or vanished.
        if item.construct_key in removed_or_changed:
            overclaims.append(item)
            continue
        # Nested under a removed entity: claiming a field survived when its owner
        # was dropped is also an over-claim.
        if any(
            item.construct_key.startswith(parent + ".")
            for parent in removed
            if parent
        ):
            overclaims.append(item)

    return ReconciliationResult(
        matched=matched,
        unexplained=unexplained,
        overclaims=overclaims,
    )


def serialize_emitted_text(content: Any) -> str:
    """Turn one emitted file's content into text the matching adapter can parse."""
    if isinstance(content, str):
        return content
    if isinstance(content, (bytes, bytearray)):
        return bytes(content).decode("utf-8")
    if isinstance(content, (dict, list)):
        return json.dumps(content, indent=2, sort_keys=True) + "\n"
    return str(content)


def emitted_fileset(result: EmitResult) -> IntakeFileset:
    """Build an :class:`IntakeFileset` from a multi-file :class:`EmitResult`."""
    if not result.files:
        raise ValueError("EmitResult has no files")
    members = {
        Path(f.path).name if "/" not in f.path.replace("\\", "/") else f.path.replace("\\", "/"):
        serialize_emitted_text(f.content)
        for f in result.files
    }
    # Prefer a stable root: first file's path (emitters sort by path).
    root = result.files[0].path.replace("\\", "/")
    if root not in members:
        # Path may be nested; fall back to basename membership.
        members = {
            f.path.replace("\\", "/"): serialize_emitted_text(f.content) for f in result.files
        }
        root = result.files[0].path.replace("\\", "/")
    return IntakeFileset.from_members(members, root=root)


def import_source_text(
    adapter: ImportSource,
    text: str,
    *,
    source_label: str = "roundtrip",
    fileset: Optional[IntakeFileset] = None,
) -> CanonicalApi:
    """Parse + normalize text (or a fileset) through ``adapter`` to a canonical model."""
    if fileset is not None:
        native = adapter.parse_fileset(fileset, source_label=source_label)
    else:
        native = adapter.parse(text, source_label=source_label)
    return adapter.normalize(native, include_raw=False)


def reimport_emitted(
    adapter: ImportSource,
    result: EmitResult,
    *,
    multi_file: bool,
    source_label: str = "roundtrip-emitted",
) -> CanonicalApi:
    """Re-import an :class:`EmitResult` through ``adapter``."""
    if multi_file or len(result.files) > 1:
        return import_source_text(
            adapter,
            "",
            source_label=source_label,
            fileset=emitted_fileset(result),
        )
    if not result.files:
        raise ImportSourceError("Emitter produced no files to re-import.")
    text = serialize_emitted_text(result.files[0].content)
    # YAML emitters sometimes return a dict; prefer JSON text. If the adapter
    # expects YAML, try YAML dump when the first parse fails — handled by caller.
    try:
        return import_source_text(adapter, text, source_label=source_label)
    except ImportSourceError:
        if isinstance(result.files[0].content, (dict, list)):
            yaml_text = yaml.safe_dump(result.files[0].content, sort_keys=True)
            return import_source_text(adapter, yaml_text, source_label=source_label)
        raise


def run_roundtrip(
    source: CanonicalApi,
    target: EmitterTarget,
    *,
    source_format: str,
    corpus_path: Optional[str] = None,
    emitter: Optional[Emitter] = None,
    import_adapter: Optional[ImportSource] = None,
) -> MatrixCellResult:
    """Emit ``source`` to ``target``, re-import, diff, and reconcile with fidelity.

    Returns a :class:`MatrixCellResult` with ``pass`` / ``fail`` / ``unsupported``.
    Does not apply skip/xfail policy — callers (the pytest suite) layer those on.
    """
    classified = classify_cell(source_format, target)
    if classified is not None:
        classified.corpus_path = corpus_path
        return classified

    desc = target.descriptor
    emitter_cls = get_emitter(desc.format)
    if emitter_cls is None:
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            corpus_path=corpus_path,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=f"No emitter registered for format {desc.format!r}.",
        )

    emitter_inst = emitter or emitter_cls()
    adapter_key = import_adapter_for_emit(desc.key, desc.format)
    assert adapter_key is not None  # classify_cell already gated this
    adapter = import_adapter or get_import_source(adapter_key)
    if adapter is None:
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            corpus_path=corpus_path,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=f"Import adapter {adapter_key!r} unresolved.",
        )

    try:
        report = compute_lossiness_for_emitter(source, emitter_inst)
    except Exception as exc:  # noqa: BLE001 — surface as cell failure, not crash
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            corpus_path=corpus_path,
            status=MatrixCellStatus.FAIL,
            reason=f"Fidelity engine failed: {exc}",
        )

    try:
        emit_result = emitter_inst.emit(source)
    except Exception as exc:  # noqa: BLE001
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            corpus_path=corpus_path,
            status=MatrixCellStatus.FAIL,
            reason=f"Emit failed: {exc}",
            loss_drop=report.kind_counts.get("drop", 0),
            loss_approx=report.kind_counts.get("approx", 0),
            loss_synth=report.kind_counts.get("synth", 0),
            loss_ok=report.kind_counts.get("ok", 0),
        )

    try:
        reimported = reimport_emitted(
            adapter,
            emit_result,
            multi_file=desc.multi_file,
            source_label=f"{source_format}->{desc.key}",
        )
    except (ImportSourceError, ValueError, TypeError, yaml.YAMLError) as exc:
        return MatrixCellResult(
            source_format=source_format,
            emit_key=desc.key,
            emit_format=desc.format,
            corpus_path=corpus_path,
            status=MatrixCellStatus.FAIL,
            reason=f"Re-import failed: {exc}",
            loss_drop=report.kind_counts.get("drop", 0),
            loss_approx=report.kind_counts.get("approx", 0),
            loss_synth=report.kind_counts.get("synth", 0),
            loss_ok=report.kind_counts.get("ok", 0),
        )

    diff = canonical_diff(source, reimported)
    reconciliation = reconcile(diff, report)

    if reconciliation.ok:
        status = MatrixCellStatus.PASS
        reason = None
    else:
        status = MatrixCellStatus.FAIL
        parts: List[str] = []
        if reconciliation.unexplained:
            keys = ", ".join(
                f"{e.change.value} {e.entity} {e.key!r}" for e in reconciliation.unexplained
            )
            parts.append(f"unexplained: {keys}")
        if reconciliation.overclaims:
            keys = ", ".join(
                f"OK {item.construct_key!r}" for item in reconciliation.overclaims
            )
            parts.append(f"overclaim: {keys}")
        reason = "; ".join(parts)

    return MatrixCellResult(
        source_format=source_format,
        emit_key=desc.key,
        emit_format=desc.format,
        corpus_path=corpus_path,
        status=status,
        reason=reason,
        unexplained=list(reconciliation.unexplained),
        overclaims=list(reconciliation.overclaims),
        matched_count=len(reconciliation.matched),
        diff_count=len(diff.entries),
        loss_drop=report.kind_counts.get("drop", 0),
        loss_approx=report.kind_counts.get("approx", 0),
        loss_synth=report.kind_counts.get("synth", 0),
        loss_ok=report.kind_counts.get("ok", 0),
    )


def empty_matrix(
    source_formats: Sequence[str],
    emit_targets: Sequence[EmitterTarget],
) -> RoundTripMatrix:
    """Build a matrix skeleton with no cells run (used by classifiers / tests)."""
    return RoundTripMatrix(
        source_formats=list(source_formats),
        emit_keys=[t.descriptor.key for t in emit_targets],
        cells=[],
    )
