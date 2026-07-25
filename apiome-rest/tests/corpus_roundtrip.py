"""Corpus-driven round-trip matrix runner — IXH-1.7 (#5093).

Bridges the corpus loader / adapter-support helpers (test-only) to the shipped
:mod:`app.roundtrip_matrix` engine. Selects one representative ``valid`` entry
per source format, runs every production emit target, and publishes the
machine-readable matrix artifact under ``tests/golden/roundtrip/``.
"""

from __future__ import annotations

import os
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from corpus_adapter_support import (
    KNOWN_DETECTION_BUGS,
    KNOWN_IMPORT_BUGS,
    adapter_for,
    build_fileset,
    missing_tools,
    valid_entries,
)
from corpus_loader import CorpusEntry, FilesetRole, Rung
from roundtrip_xfails import KNOWN_ROUNDTRIP_XFAILS as _GENERATED_XFAILS

from app.canonical_model import CanonicalApi
from app.emitter import EmitterTarget, load_builtin_emitters
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    load_builtin_import_sources,
)
from app.roundtrip_matrix import (
    MATRIX_VERSION,
    MatrixCellResult,
    MatrixCellStatus,
    RoundTripMatrix,
    classify_cell,
    production_emit_targets,
    run_roundtrip,
)
from app.toolchain_runner import is_tool_available

__all__ = [
    "ARTIFACT_PATH",
    "UPDATE_MATRIX_ENV",
    "KNOWN_ROUNDTRIP_XFAILS",
    "KNOWN_UNSUPPORTED_CELLS",
    "build_and_run_matrix",
    "pick_representative",
    "representatives_by_format",
    "updating_matrix",
    "write_matrix_artifact",
]

#: Checked-in machine-readable matrix artifact (consumed by IXH-1.8).
ARTIFACT_PATH = Path(__file__).resolve().parent / "golden" / "roundtrip" / "matrix.json"

#: Set to ``1`` to regenerate the artifact instead of comparing (mirrors
#: ``UPDATE_CORPUS_GOLDENS`` / ``UPDATE_PROJECTION_GOLDENS``).
UPDATE_MATRIX_ENV = "UPDATE_ROUNDTRIP_MATRIX"

#: ``(source_format, emit_key) → reason`` for cells that currently fail the
#: reconcile contract. Populated from the first matrix run in
#: :mod:`roundtrip_xfails`; strict xfail — fixing fidelity/emitter/re-import
#: must remove the entry or the suite fails the "xfail but passed" check.
KNOWN_ROUNDTRIP_XFAILS = dict(_GENERATED_XFAILS)

#: ``(source_format, emit_key) → reason`` for cells that are intentionally
#: unsupported beyond the automatic "no re-import adapter" / "emitter
#: unavailable" gates (e.g. a known paradigm mismatch we choose not to run).
KNOWN_UNSUPPORTED_CELLS: Dict[Tuple[str, str], str] = {}


def updating_matrix(request: object | None = None) -> bool:
    """Whether this run should rewrite the checked-in matrix artifact.

    True when ``UPDATE_ROUNDTRIP_MATRIX=1`` or ``--update-roundtrip-matrix`` was
    passed (mirrors :func:`corpus_snapshot.updating_goldens`).
    """
    if os.environ.get(UPDATE_MATRIX_ENV, "").strip() in {"1", "true", "yes"}:
        return True
    if request is None:
        return False
    getoption = getattr(getattr(request, "config", None), "getoption", None)
    if getoption is None:
        return False
    return bool(getoption("--update-roundtrip-matrix", default=False))


def pick_representative(entries: Sequence[CorpusEntry]) -> Optional[CorpusEntry]:
    """Pick one runnable entry: prefer ``typical``, then ``minimal``, then first.

    Skips entries listed in the known detection/import bug maps and entries whose
    adapter tools are missing in this runtime (those formats surface as
    ``skipped`` cells rather than silently omitting the row).
    """
    runnable: List[CorpusEntry] = []
    for entry in entries:
        if entry.path in KNOWN_DETECTION_BUGS or entry.path in KNOWN_IMPORT_BUGS:
            continue
        assert entry.adapter_key is not None
        if missing_tools(entry.adapter_key):
            continue
        runnable.append(entry)
    if not runnable:
        return None

    by_rung: Dict[Optional[Rung], List[CorpusEntry]] = defaultdict(list)
    for entry in runnable:
        by_rung[entry.rung].append(entry)

    for preferred in (Rung.TYPICAL, Rung.MINIMAL):
        if by_rung.get(preferred):
            return sorted(by_rung[preferred], key=lambda e: e.path)[0]
    return sorted(runnable, key=lambda e: e.path)[0]


def representatives_by_format(
    entries: Optional[Sequence[CorpusEntry]] = None,
) -> Dict[str, Optional[CorpusEntry]]:
    """Map each corpus source format to its representative entry (or ``None``)."""
    grouped: Dict[str, List[CorpusEntry]] = defaultdict(list)
    for entry in entries if entries is not None else valid_entries():
        grouped[entry.format].append(entry)
    return {fmt: pick_representative(group) for fmt, group in sorted(grouped.items())}


def _import_entry(entry: CorpusEntry) -> CanonicalApi:
    """Import one corpus entry to a canonical model (detect → parse → normalize)."""
    source = adapter_for(entry)
    filename = Path(entry.path).name
    source.detect(DetectionInput(text=entry.read_text(), filename=filename))
    if entry.fileset_role is FilesetRole.ROOT:
        native = source.parse_fileset(build_fileset(entry), source_label=entry.path)
    else:
        native = source.parse(entry.read_text(), source_label=entry.path)
    return source.normalize(native, include_raw=False)


def _emit_tools_missing(target: EmitterTarget) -> List[str]:
    """Toolchain tools the emitter hard-requires that are unavailable here."""
    emitter_cls = None
    load_builtin_emitters()
    from app.emitter import get_emitter

    emitter_cls = get_emitter(target.descriptor.format)
    if emitter_cls is None:
        return []
    return [tool for tool in emitter_cls.required_tools if not is_tool_available(tool)]


def build_and_run_matrix(
    *,
    entries: Optional[Sequence[CorpusEntry]] = None,
    emit_targets: Optional[Sequence[EmitterTarget]] = None,
    xfails: Optional[Mapping[Tuple[str, str], str]] = None,
    unsupported: Optional[Mapping[Tuple[str, str], str]] = None,
) -> RoundTripMatrix:
    """Run the full ``(source_format × emit_target)`` matrix and return results.

    Every production emit target appears for every corpus source format. Cells
    that cannot run are recorded as ``unsupported`` / ``skipped`` / ``xfail``
    rather than omitted.
    """
    load_builtin_import_sources()
    load_builtin_emitters()

    reps = representatives_by_format(entries)
    targets = list(emit_targets) if emit_targets is not None else production_emit_targets()
    xfail_map = dict(xfails) if xfails is not None else dict(KNOWN_ROUNDTRIP_XFAILS)
    unsupported_map = (
        dict(unsupported) if unsupported is not None else dict(KNOWN_UNSUPPORTED_CELLS)
    )

    source_formats = list(reps.keys())
    emit_keys = [t.descriptor.key for t in targets]
    cells: List[MatrixCellResult] = []

    # Cache imported models per format so we import once, emit many.
    models: Dict[str, CanonicalApi] = {}
    import_errors: Dict[str, str] = {}
    for fmt, entry in reps.items():
        if entry is None:
            continue
        assert entry.adapter_key is not None
        if missing_tools(entry.adapter_key):
            continue
        try:
            models[fmt] = _import_entry(entry)
        except (ImportSourceError, ValueError, TypeError, Exception) as exc:  # noqa: BLE001
            import_errors[fmt] = str(exc)

    for source_format, entry in reps.items():
        for target in targets:
            cell_key = (source_format, target.descriptor.key)

            if cell_key in unsupported_map:
                cells.append(
                    MatrixCellResult(
                        source_format=source_format,
                        emit_key=target.descriptor.key,
                        emit_format=target.descriptor.format,
                        corpus_path=entry.path if entry else None,
                        status=MatrixCellStatus.UNSUPPORTED,
                        reason=unsupported_map[cell_key],
                    )
                )
                continue

            classified = classify_cell(
                source_format,
                target,
                reason_override=None,
            )
            if classified is not None:
                classified.corpus_path = entry.path if entry else None
                cells.append(_apply_xfail(classified, xfail_map))
                continue

            if entry is None:
                cells.append(
                    MatrixCellResult(
                        source_format=source_format,
                        emit_key=target.descriptor.key,
                        emit_format=target.descriptor.format,
                        status=MatrixCellStatus.SKIPPED,
                        reason=(
                            "No runnable representative corpus entry for this "
                            "source format (known bugs or missing tools)."
                        ),
                    )
                )
                continue

            assert entry.adapter_key is not None
            missing_import = missing_tools(entry.adapter_key)
            if missing_import:
                cells.append(
                    MatrixCellResult(
                        source_format=source_format,
                        emit_key=target.descriptor.key,
                        emit_format=target.descriptor.format,
                        corpus_path=entry.path,
                        status=MatrixCellStatus.SKIPPED,
                        reason=(
                            "Source import tools unavailable: "
                            + ", ".join(missing_import)
                        ),
                    )
                )
                continue

            missing_emit = _emit_tools_missing(target)
            if missing_emit:
                cells.append(
                    MatrixCellResult(
                        source_format=source_format,
                        emit_key=target.descriptor.key,
                        emit_format=target.descriptor.format,
                        corpus_path=entry.path,
                        status=MatrixCellStatus.SKIPPED,
                        reason=(
                            "Emit tools unavailable: " + ", ".join(missing_emit)
                        ),
                    )
                )
                continue

            if source_format in import_errors:
                cells.append(
                    MatrixCellResult(
                        source_format=source_format,
                        emit_key=target.descriptor.key,
                        emit_format=target.descriptor.format,
                        corpus_path=entry.path,
                        status=MatrixCellStatus.FAIL,
                        reason=f"Source import failed: {import_errors[source_format]}",
                    )
                )
                continue

            model = models[source_format]
            result = run_roundtrip(
                model,
                target,
                source_format=source_format,
                corpus_path=entry.path,
            )
            cells.append(_apply_xfail(result, xfail_map))

    return RoundTripMatrix(
        matrix_version=MATRIX_VERSION,
        source_formats=source_formats,
        emit_keys=emit_keys,
        cells=cells,
    )


def _apply_xfail(
    cell: MatrixCellResult,
    xfail_map: Dict[Tuple[str, str], str],
) -> MatrixCellResult:
    """Promote a failing cell to ``xfail`` when listed; fail if an xfail passes."""
    key = (cell.source_format, cell.emit_key)
    if key not in xfail_map:
        return cell
    reason = xfail_map[key]
    if cell.status is MatrixCellStatus.PASS:
        return cell.model_copy(
            update={
                "status": MatrixCellStatus.FAIL,
                "reason": (
                    f"Marked xfail but passed — remove from KNOWN_ROUNDTRIP_XFAILS. "
                    f"Was: {reason}"
                ),
            }
        )
    if cell.status is MatrixCellStatus.FAIL:
        return cell.model_copy(
            update={
                "status": MatrixCellStatus.XFAIL,
                "reason": f"{reason} (observed: {cell.reason})",
            }
        )
    return cell


def write_matrix_artifact(matrix: RoundTripMatrix, path: Path = ARTIFACT_PATH) -> None:
    """Write the matrix JSON (+ companion Markdown) to ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(matrix.to_json(), encoding="utf-8")
    md_path = path.with_suffix(".md")
    md_path.write_text(matrix.to_markdown(), encoding="utf-8")
