"""On-demand export round-trip comparison — IXH-4.4 (#5112).

The strongest possible answer to *"is this export honest?"* is empirical: emit the
artifact, re-import it through the matching import adapter, and diff the re-imported
canonical model against the source revision. The IXH-1.7 conformance matrix
(:mod:`app.roundtrip_matrix`) proves this claim in CI over the corpus; this module
runs the **same loop for one user document, on demand**, so the Export Studio can
show the user their own round-trip evidence instead of asking them to trust a grid
they cannot see their document in.

The composition deliberately reuses the 1.7 seams rather than re-deriving them, so a
Studio result reconciles with the published matrix for corpus entries:

1. **emit + predict** — :func:`app.export_dispatch.dispatch_from_source` produces the
   emitted bundle *and* the fidelity report from one snapshot of the source, so the
   round-trip verdict and the on-screen fidelity/heatmap describe the same emit
   (unlike :func:`app.roundtrip_matrix.run_roundtrip`, which recomputes its own
   report for the CI matrix);
2. **gate** — :func:`app.roundtrip_matrix.import_adapter_for_emit` /
   :func:`~app.roundtrip_matrix.classify_cell` decide whether the loop can close at
   all; a target with no import adapter is **skipped with the matrix's own
   explanation**, never silently omitted;
3. **re-import** — :func:`app.roundtrip_matrix.reimport_emitted` parses + normalizes
   the emitted bundle back through the matching adapter;
4. **diff + reconcile** — :func:`app.import_source.canonical_diff` compares the two
   models and :func:`app.roundtrip_matrix.reconcile` joins every difference to the
   fidelity finding that explains it. A difference the report explains is
   **expected**; an unexplained difference (or an ``OK`` over-claim) is a fidelity
   bug the user should report.

The run is explicit and bounded: it happens only when a caller posts to the route,
performs exactly one emit + one re-import, and persists nothing (read-only emit, no
job row, no field-identity rows).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .capability_registry import REGISTRY_VERSION
from .emitter import EmitterTarget, describe_emit_targets, get_emitter
from .export_dispatch import dispatch_from_source
from .export_source import ExportSource
from .import_source import (
    CanonicalDiffEntry,
    ImportSourceError,
    canonical_diff,
    canonical_fingerprint,
    get_import_source,
)
from .lossiness import LossinessSeverity, LossItem
from .roundtrip_matrix import (
    MatchedDiff,
    MatrixCellStatus,
    classify_cell,
    import_adapter_for_emit,
    reconcile,
    reimport_emitted,
)

__all__ = [
    "ExportRoundtripRequest",
    "ExportRoundtripResponse",
    "run_export_roundtrip",
]

#: The apiome-rest package version stamped into reproduction provenance
#: (assignment style keeps the lowercase dunder import ruff-clean, matching
#: :mod:`app.export_projection`).
APIOME_VERSION = __version__

#: ``source_format`` label used when classifying the Studio's single-document cell.
#: The matrix labels cells by corpus source format; a Studio run has no corpus file,
#: so the label only appears inside the human-readable skip reason.
_STUDIO_SOURCE_LABEL = "studio"


class ExportRoundtripRequest(BaseModel):
    """A round-trip comparison request: source revision + chosen target + options."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id to round-trip.")
    version: Optional[str] = Field(
        default=None,
        description="Revision UUID, version label (``1.0.0``), or null for the latest revision.",
    )
    target: str = Field(
        description="Target emitter key (``openapi``) or format key (``openapi-3.1``).",
    )
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Per-target emit options (MFX-1.4); null or empty applies the target defaults.",
    )
    min_severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="Lowest loss severity that raises the advisory (MFX-2.4); does not affect "
        "the round-trip verdict, the report, or the reconciliation.",
    )


class ExportRoundtripResponse(BaseModel):
    """The round-trip comparison result the Export Studio renders (IXH-4.4).

    ``status`` speaks the IXH-1.7 matrix's vocabulary so a Studio run over a corpus
    entry reconciles with the published matrix cell:

    * ``pass`` — every empirical difference is explained by the fidelity report and
      nothing over-claims preservation;
    * ``fail`` — at least one unexplained difference or over-claim (a fidelity bug
      worth reporting), or the emitted artifact could not be re-imported at all;
    * ``unsupported`` — the comparison was **skipped with an explanation** (no import
      adapter can re-ingest the emit format, or the emitter is unavailable here).

    The three difference groups are exactly the reconciliation's: ``matched``
    (explained by the report — expected loss), ``unexplained`` (the report does not
    account for them), and ``overclaims`` (the report claimed preservation reality
    contradicts). The provenance fields (`emitter_version` / `apiome_version` /
    `registry_version` / fingerprints) give an unexplained difference's issue report
    its reproduction coordinates without shipping any source bytes.
    """

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the round-trip ran for.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    target: str = Field(description="The resolved target format key (e.g. ``openapi-3.1``).")
    emit_key: str = Field(description="The resolved emitter registry key (e.g. ``openapi``).")
    adapter_key: Optional[str] = Field(
        default=None,
        description="The import-adapter registry key that re-imported the emitted artifact; "
        "null when the comparison was skipped (``status: unsupported``).",
    )
    status: MatrixCellStatus = Field(
        description="The round-trip verdict (``pass`` / ``fail`` / ``unsupported``), in the "
        "IXH-1.7 matrix's vocabulary.",
    )
    reason: Optional[str] = Field(
        default=None,
        description="Human-readable explanation for a non-``pass`` status: why the comparison "
        "was skipped, what failed to re-import, or which differences are unaccounted for.",
    )
    diff_count: int = Field(
        default=0, description="Total empirical differences between source and re-import."
    )
    matched_count: int = Field(
        default=0, description="Differences the fidelity report explains (expected loss)."
    )
    matched: List[MatchedDiff] = Field(
        default_factory=list,
        description="Each explained difference paired with the fidelity finding that explains it.",
    )
    unexplained: List[CanonicalDiffEntry] = Field(
        default_factory=list,
        description="Differences no fidelity finding accounts for — a fidelity bug the user "
        "should report.",
    )
    overclaims: List[LossItem] = Field(
        default_factory=list,
        description="``OK`` findings whose construct empirically changed or vanished — the "
        "report over-claimed preservation.",
    )
    loss_drop: int = Field(default=0, description="``drop`` findings in the fidelity report.")
    loss_approx: int = Field(default=0, description="``approx`` findings in the fidelity report.")
    loss_synth: int = Field(default=0, description="``synth`` findings in the fidelity report.")
    loss_ok: int = Field(default=0, description="``ok`` findings in the fidelity report.")
    source_fingerprint: str = Field(
        description="Deterministic fingerprint of the source canonical model (reproduction "
        "coordinate for issue reports; carries no source content).",
    )
    reimported_fingerprint: Optional[str] = Field(
        default=None,
        description="Fingerprint of the re-imported canonical model; equals "
        "``source_fingerprint`` for a byte-honest round-trip. Null when the loop did not close.",
    )
    emitter_version: str = Field(description="The emitter implementation version.")
    apiome_version: str = Field(description="The apiome-rest package version that ran the loop.")
    registry_version: str = Field(description="The capability-registry snapshot version.")


def _target_entry(target_format: str, emit_key: str) -> Optional[EmitterTarget]:
    """Find the registry's :class:`EmitterTarget` for a resolved dispatch target.

    Args:
        target_format: The resolved emit format key (``openapi-3.1``).
        emit_key: The resolved emitter registry key (``openapi``).

    Returns:
        The matching registry entry, or ``None`` when the registry and the dispatch
        disagree (defensive; they are built from the same registrations).
    """
    for entry in describe_emit_targets():
        if entry.descriptor.format == target_format or entry.descriptor.key == emit_key:
            return entry
    return None


def run_export_roundtrip(
    source: ExportSource,
    target: str,
    *,
    version: Optional[str] = None,
    options: Optional[Dict[str, Any]] = None,
    min_severity: LossinessSeverity = LossinessSeverity.INFO,
) -> ExportRoundtripResponse:
    """Emit ``source`` to ``target``, re-import, diff against the source, reconcile.

    One explicit, bounded run: a single read-only emit (no artifact, job, or
    field-identity rows persisted), one re-import through the matching adapter, one
    :func:`~app.import_source.canonical_diff`, and one
    :func:`~app.roundtrip_matrix.reconcile` against the **same** fidelity report the
    dispatch computed for this emit — so the verdict and the Studio's fidelity
    surfaces describe one snapshot.

    Args:
        source: The loaded export source (canonical model + resolved coordinates).
        target: Target emitter ``key`` (``openapi``) or format key (``openapi-3.1``).
        version: The caller's version selector, echoed back verbatim.
        options: Per-target emit options; ``None``/empty applies the target defaults.
        min_severity: Advisory threshold passed through to the dispatch; does not
            affect the verdict.

    Returns:
        The full :class:`ExportRoundtripResponse` (``pass`` / ``fail`` /
        ``unsupported``, the three difference groups, and reproduction provenance).

    Raises:
        ExportError: When ``target`` does not resolve, its options are invalid, or
            the emitter produced no document — the same taxonomy the dispatch and
            verify surfaces raise, mapped to HTTP by the route.
    """
    # confirm=True: a severe conversion is *measured* here, not blocked — the round-trip
    # exists precisely to show what a lossy conversion does. persistence=None keeps the
    # emit read-only. (Same stance as the verify surface, MFX-42.5.)
    dispatch = dispatch_from_source(
        source,
        target,
        options=options,
        min_severity=min_severity,
        dry_run=False,
        confirm=True,
        persistence=None,
    )
    descriptor = dispatch.fidelity.target
    emitter_cls = get_emitter(descriptor.format)
    emitter_version = getattr(emitter_cls, "version", "unknown") if emitter_cls else "unknown"
    source_fingerprint = canonical_fingerprint(source.api)
    report = dispatch.fidelity.report

    base: Dict[str, Any] = {
        "artifact": dispatch.artifact,
        "version": version,
        "version_record_id": dispatch.version_record_id,
        "version_label": dispatch.version_label,
        "target": dispatch.target,
        "emit_key": descriptor.key,
        "loss_drop": report.kind_counts.get("drop", 0),
        "loss_approx": report.kind_counts.get("approx", 0),
        "loss_synth": report.kind_counts.get("synth", 0),
        "loss_ok": report.kind_counts.get("ok", 0),
        "source_fingerprint": source_fingerprint,
        "emitter_version": emitter_version,
        "apiome_version": APIOME_VERSION,
        "registry_version": REGISTRY_VERSION,
    }

    # Gate: can the loop close at all? classify_cell is the matrix's own gate, so the
    # skip reason here is word-for-word the reason the published 1.7 grid records.
    entry = _target_entry(dispatch.target, descriptor.key)
    if entry is not None:
        classified = classify_cell(_STUDIO_SOURCE_LABEL, entry)
        if classified is not None:
            return ExportRoundtripResponse(
                **base,
                status=MatrixCellStatus.UNSUPPORTED,
                reason=classified.reason,
            )
    adapter_key = import_adapter_for_emit(descriptor.key, descriptor.format)
    if adapter_key is None:
        # Reachable only if the registry entry vanished between dispatch and gate.
        return ExportRoundtripResponse(
            **base,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=(
                f"No import adapter can re-import emit format {descriptor.format!r} "
                f"(emit key {descriptor.key!r})."
            ),
        )
    adapter = get_import_source(adapter_key)
    if adapter is None:
        return ExportRoundtripResponse(
            **base,
            status=MatrixCellStatus.UNSUPPORTED,
            reason=f"Import adapter {adapter_key!r} unresolved in this runtime.",
        )

    # A real (non-dry-run) dispatch that returned without raising always emits.
    assert dispatch.emit is not None

    try:
        reimported = reimport_emitted(
            adapter,
            dispatch.emit,
            multi_file=descriptor.multi_file,
            source_label=f"roundtrip:{dispatch.artifact}->{descriptor.key}",
        )
    except (ImportSourceError, ValueError, TypeError) as exc:
        # The emitted artifact could not be re-ingested by its own matching adapter —
        # itself a fidelity bug, reported as a failure rather than raised, so the
        # Studio can render it (and its issue-report path) like any other failure.
        return ExportRoundtripResponse(
            **base,
            adapter_key=adapter_key,
            status=MatrixCellStatus.FAIL,
            reason=f"Re-import failed: {exc}",
        )

    diff = canonical_diff(source.api, reimported)
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
            keys = ", ".join(f"OK {item.construct_key!r}" for item in reconciliation.overclaims)
            parts.append(f"overclaim: {keys}")
        reason = "; ".join(parts)

    return ExportRoundtripResponse(
        **base,
        adapter_key=adapter_key,
        status=status,
        reason=reason,
        diff_count=len(diff.entries),
        matched_count=len(reconciliation.matched),
        matched=list(reconciliation.matched),
        unexplained=list(reconciliation.unexplained),
        overclaims=list(reconciliation.overclaims),
        reimported_fingerprint=canonical_fingerprint(reimported),
    )
