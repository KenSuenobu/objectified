"""Round-trip conformance matrix tests — IXH-1.7 (#5093).

Proves the product claim *import once, emit in every format with honest
fidelity* by running every ``(shipped source format × shipped emit target)``
cell: import → fidelity predict → emit → re-import → ``canonical_diff`` →
reconcile against ``DROP``/``APPROX``/``SYNTH``. Unexplained diffs and
over-claiming ``OK`` findings fail; unsupported cells are recorded explicitly.

What this suite proves, in acceptance-criteria order:

* the published matrix covers every format→emit pair (no silent holes);
* every canonical difference is matched to a fidelity finding;
* a fidelity report that over-claims preservation fails;
* matrix results are a machine-readable artifact (+ Markdown for IXH-1.8).

Regenerate the artifact with
``pytest tests/test_roundtrip_matrix.py --update-roundtrip-matrix`` (or
``UPDATE_ROUNDTRIP_MATRIX=1``).
"""

from __future__ import annotations

import json
from typing import List

import pytest
from corpus_adapter_support import valid_entries
from corpus_loader import Rung
from corpus_roundtrip import (
    ARTIFACT_PATH,
    KNOWN_ROUNDTRIP_XFAILS,
    build_and_run_matrix,
    pick_representative,
    representatives_by_format,
    updating_matrix,
    write_matrix_artifact,
)

from app.canonical_model import ApiParadigm
from app.emitter import (
    CapabilityProfile,
    EmitterDescriptor,
    EmitterTarget,
    load_builtin_emitters,
)
from app.import_source import (
    CanonicalDiff,
    CanonicalDiffEntry,
    DiffChangeKind,
    load_builtin_import_sources,
)
from app.lossiness import (
    LossItem,
    LossinessKind,
    LossinessReport,
    LossinessSeverity,
)
from app.roundtrip_matrix import (
    MATRIX_VERSION,
    SAMPLE_EMIT_KEYS,
    MatrixCellResult,
    MatrixCellStatus,
    RoundTripMatrix,
    classify_cell,
    import_adapter_for_emit,
    normalize_format_key,
    production_emit_targets,
    reconcile,
)

load_builtin_import_sources()
load_builtin_emitters()


# ---------------------------------------------------------------------------
# Unit: reconcile / classify / aliases / representative
# ---------------------------------------------------------------------------


def _diff(*entries: CanonicalDiffEntry) -> CanonicalDiff:
    return CanonicalDiff(entries=list(entries))


def _report(*items: LossItem) -> LossinessReport:
    return LossinessReport(items=list(items))


def _loss(
    construct: str,
    kind: LossinessKind,
    *,
    message: str = "test",
) -> LossItem:
    return LossItem(
        construct_key=construct,
        kind=kind,
        severity=LossinessSeverity.WARN,
        message=message,
    )


def test_reconcile_empty_diff_passes() -> None:
    result = reconcile(_diff(), _report(_loss("User", LossinessKind.OK)))
    assert result.ok
    assert result.unexplained == []
    assert result.overclaims == []


def test_reconcile_removed_explained_by_drop() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="User", change=DiffChangeKind.REMOVED)
        ),
        _report(_loss("User", LossinessKind.DROP, message="cannot carry User")),
    )
    assert result.ok
    assert len(result.matched) == 1


def test_reconcile_removed_unexplained_fails() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="User", change=DiffChangeKind.REMOVED)
        ),
        _report(_loss("User", LossinessKind.OK)),
    )
    assert not result.ok
    assert result.unexplained[0].key == "User"
    assert result.overclaims[0].construct_key == "User"


def test_reconcile_added_explained_by_synth() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="Synthetic", change=DiffChangeKind.ADDED)
        ),
        _report(_loss("Synthetic", LossinessKind.SYNTH)),
    )
    assert result.ok


def test_reconcile_changed_explained_by_nested_drop() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="User", change=DiffChangeKind.CHANGED)
        ),
        _report(_loss("User.email", LossinessKind.DROP, message="email dropped")),
    )
    assert result.ok
    assert result.matched[0].finding.construct_key == "User.email"


def test_reconcile_changed_explained_by_approx() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="User", change=DiffChangeKind.CHANGED)
        ),
        _report(_loss("User", LossinessKind.APPROX)),
    )
    assert result.ok


def test_reconcile_ok_on_changed_is_overclaim() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="User", change=DiffChangeKind.CHANGED)
        ),
        _report(
            _loss("User", LossinessKind.OK),
            _loss("User.email", LossinessKind.DROP),
        ),
    )
    # Nested DROP explains CHANGED; OK on User itself is still an over-claim.
    assert result.matched
    assert any(o.construct_key == "User" for o in result.overclaims)
    assert not result.ok


def test_reconcile_nested_ok_under_removed_is_overclaim() -> None:
    result = reconcile(
        _diff(
            CanonicalDiffEntry(entity="type", key="User", change=DiffChangeKind.REMOVED)
        ),
        _report(
            _loss("User", LossinessKind.DROP),
            _loss("User.email", LossinessKind.OK),
        ),
    )
    assert result.matched
    assert any(o.construct_key == "User.email" for o in result.overclaims)
    assert not result.ok


def test_import_adapter_for_emit_aliases() -> None:
    assert import_adapter_for_emit("openapi", "openapi-3.1") == "openapi"
    assert import_adapter_for_emit("protobuf", "proto3") == "grpc"
    assert import_adapter_for_emit("asyncapi", "asyncapi-3") == "asyncapi"
    assert import_adapter_for_emit("apiblueprint", "apiblueprint") == "apiblueprint"
    assert import_adapter_for_emit("sample", "sample-noop") is None
    assert normalize_format_key(" API-Blueprint ") == "api-blueprint"


def test_production_emit_targets_exclude_sample() -> None:
    targets = production_emit_targets()
    keys = {t.descriptor.key for t in targets}
    formats = {t.descriptor.format for t in targets}
    assert not (keys & SAMPLE_EMIT_KEYS)
    assert not (formats & SAMPLE_EMIT_KEYS)
    assert "openapi" in keys
    assert len(targets) >= 30


def test_classify_cell_unsupported_without_reimport_adapter() -> None:
    fake = EmitterTarget(
        descriptor=EmitterDescriptor(
            key="no-reimport",
            format="no-reimport-format-zzz",
            label="Fake",
            description="no adapter",
            icon="file",
            paradigm=ApiParadigm.REST,
            multi_file=False,
            needs_toolchain=False,
            available=True,
            unavailable_reason=None,
        ),
        capability_profile=CapabilityProfile(),
        options_schema={},
        default_options={},
    )
    cell = classify_cell("openapi", fake)
    assert cell is not None
    assert cell.status is MatrixCellStatus.UNSUPPORTED
    assert "No import adapter" in (cell.reason or "")


def test_pick_representative_prefers_typical() -> None:
    by_fmt = representatives_by_format()
    openapi_entries = [e for e in valid_entries() if e.format == "openapi"]
    typical = [e for e in openapi_entries if e.rung is Rung.TYPICAL]
    if typical:
        rep = pick_representative(openapi_entries)
        assert rep is not None
        assert rep.rung is Rung.TYPICAL
    assert "openapi" in by_fmt
    assert by_fmt["openapi"] is not None


def test_matrix_to_markdown_and_json_roundtrip() -> None:
    matrix = RoundTripMatrix(
        matrix_version=MATRIX_VERSION,
        source_formats=["openapi", "avro"],
        emit_keys=["openapi", "avro"],
        cells=[
            MatrixCellResult(
                source_format="openapi",
                emit_key="openapi",
                emit_format="openapi-3.1",
                status=MatrixCellStatus.PASS,
            ),
            MatrixCellResult(
                source_format="openapi",
                emit_key="avro",
                emit_format="avro",
                status=MatrixCellStatus.FAIL,
                reason="unexplained",
            ),
            MatrixCellResult(
                source_format="avro",
                emit_key="openapi",
                emit_format="openapi-3.1",
                status=MatrixCellStatus.UNSUPPORTED,
                reason="demo",
            ),
            MatrixCellResult(
                source_format="avro",
                emit_key="avro",
                emit_format="avro",
                status=MatrixCellStatus.SKIPPED,
                reason="tools",
            ),
        ],
    )
    md = matrix.to_markdown()
    assert "openapi" in md and "avro" in md
    assert "P" in md and "F" in md
    payload = json.loads(matrix.to_json())
    assert payload["matrix_version"] == MATRIX_VERSION
    assert len(payload["cells"]) == 4


# ---------------------------------------------------------------------------
# Full matrix: completeness + reconcile gate + artifact
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def roundtrip_matrix() -> RoundTripMatrix:
    """Run the full matrix once per module (expensive; shared across tests)."""
    return build_and_run_matrix()


def test_matrix_covers_every_format_emit_pair(roundtrip_matrix: RoundTripMatrix) -> None:
    """Every (corpus format × production emit target) cell is present — no holes."""
    reps = representatives_by_format()
    targets = production_emit_targets()
    expected = {(fmt, t.descriptor.key) for fmt in reps for t in targets}
    actual = {(c.source_format, c.emit_key) for c in roundtrip_matrix.cells}
    assert actual == expected, (
        f"matrix holes or extras: missing={sorted(expected - actual)[:10]} "
        f"extra={sorted(actual - expected)[:10]}"
    )
    assert SAMPLE_EMIT_KEYS.isdisjoint(set(roundtrip_matrix.emit_keys))
    assert len(roundtrip_matrix.cells) == len(reps) * len(targets)


def test_matrix_cells_are_not_silent_failures(roundtrip_matrix: RoundTripMatrix) -> None:
    """Failing cells must be xfail-listed; pass/unsupported/skipped/xfail are fine."""
    bad: List[str] = []
    for cell in roundtrip_matrix.cells:
        if cell.status is MatrixCellStatus.FAIL:
            bad.append(
                f"{cell.cell_id}: {cell.reason} "
                f"(unexplained={len(cell.unexplained)} overclaims={len(cell.overclaims)})"
            )
    if bad:
        preview = "\n".join(bad[:40])
        more = f"\n... and {len(bad) - 40} more" if len(bad) > 40 else ""
        pytest.fail(
            f"{len(bad)} matrix cell(s) failed reconcile. Add to "
            f"KNOWN_ROUNDTRIP_XFAILS with a reason, or fix the fidelity/emitter:\n"
            f"{preview}{more}"
        )


def test_matrix_artifact_complete_and_stable(
    roundtrip_matrix: RoundTripMatrix,
    request: pytest.FixtureRequest,
) -> None:
    """Machine-readable artifact covers the grid; regenerate with the update flag."""
    if updating_matrix(request):
        write_matrix_artifact(roundtrip_matrix)
        assert ARTIFACT_PATH.is_file()
        return

    assert ARTIFACT_PATH.is_file(), (
        f"Missing {ARTIFACT_PATH}; regenerate with "
        "`UPDATE_ROUNDTRIP_MATRIX=1 pytest tests/test_roundtrip_matrix.py`"
    )
    stored = RoundTripMatrix.model_validate_json(ARTIFACT_PATH.read_text(encoding="utf-8"))
    assert stored.matrix_version == MATRIX_VERSION
    assert set(stored.source_formats) == set(roundtrip_matrix.source_formats)
    assert set(stored.emit_keys) == set(roundtrip_matrix.emit_keys)
    assert len(stored.cells) == len(roundtrip_matrix.cells)

    live = {(c.source_format, c.emit_key): c.status for c in roundtrip_matrix.cells}
    gold = {(c.source_format, c.emit_key): c.status for c in stored.cells}
    drift = {
        key: (gold[key], live[key])
        for key in live
        if gold.get(key) != live[key]
    }
    if drift:
        sample = "\n".join(
            f"  {src}->{emit}: artifact={old.value} live={new.value}"
            for (src, emit), (old, new) in list(drift.items())[:20]
        )
        pytest.fail(
            f"{len(drift)} cell status(es) drifted from {ARTIFACT_PATH}. "
            f"If intentional, regenerate with UPDATE_ROUNDTRIP_MATRIX=1.\n{sample}"
        )


def test_same_format_openapi_cell_is_not_unsupported(
    roundtrip_matrix: RoundTripMatrix,
) -> None:
    """OpenAPI → OpenAPI must be runnable (pass/fail/xfail/skipped), never unsupported."""
    cell = roundtrip_matrix.cell_map().get(("openapi", "openapi"))
    assert cell is not None
    assert cell.status is not MatrixCellStatus.UNSUPPORTED


def test_xfail_map_entries_refer_to_real_cells(roundtrip_matrix: RoundTripMatrix) -> None:
    """KNOWN_ROUNDTRIP_XFAILS must not rot into references to missing cells."""
    index = roundtrip_matrix.cell_map()
    orphan = [key for key in KNOWN_ROUNDTRIP_XFAILS if key not in index]
    assert not orphan, f"xfail entries with no cell: {orphan}"
