"""Canonical golden snapshot store and corpus conformance runner — IXH-1.6 (#5092).

Adapter tests assert a handful of hand-picked properties (``{op.name for op in ...}
== {...}``), so a normalizer change that silently drops a field, reorders a list, or
renames a canonical key is invisible unless someone happened to assert on that exact
field. The canonical model is the contract every downstream feature (diff, lint,
convert, export) reads, and it was unsnapshotted.

This module is the runner and the store. For one ``valid`` corpus entry it executes
**detect → parse → normalize → fingerprint → lint** and renders a deterministic
snapshot: the canonical model with the ``raw`` fidelity bag excluded, plus the
version fingerprint, entity counts, and the lint roll-up. Snapshots live one file per
corpus entry under ``tests/golden/corpus/``, mirroring the corpus layout, so a review
diff points at the fixture that moved.

**Readable failures.** A blob diff over a 10-KB JSON document tells a reviewer
nothing. On mismatch, :func:`describe_mismatch` reconstructs the stored canonical
model and runs the shipped :func:`app.import_source.canonical_diff` against the live
one, so the failure reads as identity-keyed ``ADDED``/``REMOVED``/``CHANGED`` entries
— by canonical key, not by position — and each ``CHANGED`` entity names the fields
that actually differ. Scalar drift (fingerprint, counts, lint score/grade) is
reported as a before → after line.

**Regenerating.** ``pytest --update-golden`` (or ``UPDATE_CORPUS_GOLDENS=1``, the
idiom the EFP-1.3 projection corpus uses) rewrites snapshots instead of comparing
them, so an intended contract change is a one-command refresh whose diff lands in
review.

**On redaction.** The EFP-1.3 projection goldens redact native-evidence fields that
can carry raw source excerpts. That question was checked here and does not apply: a
canonical snapshot is derived wholly from a corpus fixture already committed under
``apiome-ui/examples/``, and no normalizer emits ``source_location``/``native_id``
extras for any corpus entry. If one starts to, revisit this — the snapshot would then
duplicate source text into a second location.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

import yaml
from corpus_adapter_support import adapter_for, build_fileset
from corpus_loader import CorpusEntry, FilesetRole

from app.canonical_model import CanonicalApi
from app.import_source import (
    DetectionInput,
    DiffChangeKind,
    ImportSource,
    LintReport,
    canonical_diff,
    canonical_fingerprint,
)

__all__ = [
    "GOLDEN_ROOT",
    "SNAPSHOT_VERSION",
    "UPDATE_GOLDEN_ENV",
    "CorpusRun",
    "build_snapshot",
    "describe_mismatch",
    "golden_paths_on_disk",
    "load_golden",
    "render",
    "reordered_source",
    "run_pipeline",
    "snapshot_path",
    "write_golden",
]

#: Directory the canonical golden snapshots live in (one file per corpus entry).
GOLDEN_ROOT = Path(__file__).resolve().parent / "golden" / "corpus"

#: Envelope version of the snapshot shape. Bump only when the snapshot's own
#: structure changes (not when a normalizer changes), so a wholesale regeneration is
#: distinguishable in review from a canonical-model regression.
SNAPSHOT_VERSION = 1

#: Set to ``1`` to regenerate snapshots without passing ``--update-golden``; mirrors
#: the EFP-1.3 projection corpus's ``UPDATE_PROJECTION_GOLDENS`` idiom.
UPDATE_GOLDEN_ENV = "UPDATE_CORPUS_GOLDENS"


@dataclass(frozen=True)
class CorpusRun:
    """One entry's full pipeline result.

    Attributes:
        entry: The manifest entry that was run.
        detected_format: The format key the adapter's ``detect()`` reported, or
            ``None`` when it declined to claim the document.
        detected_confidence: The confidence ``detect()`` reported (``0.0`` for a
            no-match).
        model: The normalized canonical model.
        fingerprint: The model's stable ``sha256:`` version fingerprint.
        lint: The adapter's rolled-up lint report.
    """

    entry: CorpusEntry
    detected_format: Optional[str]
    detected_confidence: float
    model: CanonicalApi
    fingerprint: str
    lint: LintReport


def run_pipeline(entry: CorpusEntry, adapter: Optional[ImportSource] = None) -> CorpusRun:
    """Run detect → parse → normalize → fingerprint → lint for one corpus entry.

    Multi-file set roots go through ``parse_fileset`` with every sibling in their
    per-set directory as a member; every other entry parses its own text.

    Args:
        entry: The ``valid`` manifest entry to run.
        adapter: Optional pre-resolved adapter (saves a registry lookup when the
            caller already has one).

    Returns:
        The :class:`CorpusRun` carrying every artifact the snapshot records.
    """
    source = adapter or adapter_for(entry)
    filename = PurePosixPath(entry.path).name

    detection = source.detect(DetectionInput(text=entry.read_text(), filename=filename))

    if entry.fileset_role is FilesetRole.ROOT:
        native_ast = source.parse_fileset(build_fileset(entry), source_label=entry.path)
    else:
        native_ast = source.parse(entry.read_text(), source_label=entry.path)

    model = source.normalize(native_ast, include_raw=True)
    return CorpusRun(
        entry=entry,
        detected_format=detection.format if detection.matched else None,
        detected_confidence=detection.confidence,
        model=model,
        fingerprint=canonical_fingerprint(model),
        lint=source.lint(model),
    )


def canonical_payload(model: CanonicalApi) -> Dict[str, Any]:
    """Return the snapshot's view of a canonical model.

    Excludes only the ``raw`` fidelity bag — the native AST, which is source
    re-serialization rather than normalized identity, and the one field
    :func:`app.import_source.canonical_fingerprint` also excludes. Everything else,
    ``extras`` included, is contract: a normalizer that stops emitting an extras key
    has changed what downstream consumers see.

    Args:
        model: The normalized canonical model.

    Returns:
        The JSON-mode dump, ready to serialize.
    """
    return model.model_dump(mode="json", exclude={"raw"})


def build_snapshot(run: CorpusRun) -> Dict[str, Any]:
    """Assemble the golden snapshot payload for a completed run.

    Every value is derived deterministically from the fixture. The detection
    ``reason`` is deliberately omitted (it is human prose, not contract) while the
    format and confidence are kept, since those are what the manifest asserts.

    Args:
        run: The pipeline result to snapshot.

    Returns:
        The snapshot payload.
    """
    model = run.model
    return {
        "snapshot_version": SNAPSHOT_VERSION,
        "corpus_path": run.entry.path,
        "adapter": run.entry.adapter_key,
        "detection": {
            "format": run.detected_format,
            "confidence": run.detected_confidence,
        },
        "fingerprint": run.fingerprint,
        "counts": {
            "services": len(model.services),
            "operations": sum(len(service.operations) for service in model.services),
            "types": len(model.types),
            "channels": len(model.channels),
            "servers": len(model.servers),
        },
        "lint": {
            "score": run.lint.score,
            "grade": run.lint.grade,
            "report_fingerprint": run.lint.report_fingerprint,
            "findings": len(run.lint.findings),
            "severity_counts": dict(run.lint.severity_counts),
        },
        "canonical": canonical_payload(model),
    }


def render(snapshot: Dict[str, Any]) -> str:
    """Serialize a snapshot deterministically.

    Sorted keys, two-space indent, newline-terminated — the same convention the
    EFP-1.3 projection goldens use, so every golden file in the repo reads the same
    way and any drift (ordering included) shows as a text difference.

    Args:
        snapshot: The snapshot payload.

    Returns:
        The canonical JSON text.
    """
    return json.dumps(snapshot, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def snapshot_path(entry: CorpusEntry) -> Path:
    """Return the golden file path for a corpus entry.

    Mirrors the corpus layout and keeps the fixture's own extension, so
    ``openapi/01-minimal.yaml`` becomes ``golden/corpus/openapi/01-minimal.yaml.json``
    and a ``.json`` fixture beside a ``.yaml`` one of the same stem cannot collide.

    Args:
        entry: The manifest entry.

    Returns:
        The absolute path of the entry's golden snapshot.
    """
    return GOLDEN_ROOT / f"{entry.path}.json"


def load_golden(entry: CorpusEntry) -> Optional[Dict[str, Any]]:
    """Load an entry's stored snapshot, or ``None`` when it does not exist yet.

    Args:
        entry: The manifest entry.

    Returns:
        The parsed snapshot payload, or ``None``.
    """
    path = snapshot_path(entry)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_golden(entry: CorpusEntry, snapshot: Dict[str, Any]) -> Path:
    """Write an entry's snapshot to disk, creating parent directories.

    Args:
        entry: The manifest entry.
        snapshot: The snapshot payload.

    Returns:
        The path written.
    """
    path = snapshot_path(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(snapshot), encoding="utf-8")
    return path


def golden_paths_on_disk() -> List[str]:
    """Return every stored golden as its corpus-relative entry path, sorted.

    The inverse of :func:`snapshot_path`: strips the ``.json`` the store appends, so
    the result can be compared directly against manifest entry paths to find orphans.

    Returns:
        Corpus paths (POSIX separators) that have a golden on disk.
    """
    if not GOLDEN_ROOT.exists():
        return []
    return sorted(
        path.relative_to(GOLDEN_ROOT).as_posix()[: -len(".json")]
        for path in GOLDEN_ROOT.rglob("*.json")
        if path.is_file()
    )


def updating_goldens(request: Any) -> bool:
    """Whether this run should rewrite goldens instead of comparing them.

    Args:
        request: The pytest ``request`` fixture (may be ``None`` outside a test).

    Returns:
        ``True`` when ``--update-golden`` was passed or
        :data:`UPDATE_GOLDEN_ENV` is set to ``1``.
    """
    if os.environ.get(UPDATE_GOLDEN_ENV) == "1":
        return True
    if request is None:
        return False
    return bool(request.config.getoption("--update-golden", default=False))


# ===========================================================================
# Readable failure rendering
# ===========================================================================


def _keyed_membership_delta(before: Any, after: Any) -> Optional[str]:
    """Describe membership drift inside a keyed list, or ``None``.

    A canonical entity's list-valued fields (a type's ``fields``, an operation's
    ``parameters``) hold objects with their own stable ``key``. When such a list
    changes, naming the *members* that appeared or vanished is the difference between
    "``fields`` changed" and "the ``email`` property was dropped" — which is the
    regression this whole suite exists to catch.

    Args:
        before: The stored field value.
        after: The live field value.

    Returns:
        A ``-removed +added`` annotation, or ``None`` when the value is not a keyed
        list or its membership is unchanged (only member *contents* moved).
    """
    if not isinstance(before, list) or not isinstance(after, list):
        return None
    if not all(isinstance(item, dict) and "key" in item for item in (*before, *after)):
        return None
    before_keys = {str(item["key"]) for item in before}
    after_keys = {str(item["key"]) for item in after}
    removed = sorted(before_keys - after_keys)
    added = sorted(after_keys - before_keys)
    if not removed and not added:
        return None
    parts = [f"-{key}" for key in removed] + [f"+{key}" for key in added]
    return " ".join(parts)


def _changed_fields(before: Dict[str, Any], after: Dict[str, Any]) -> List[str]:
    """Return the field names that differ between two entity payloads.

    A field holding a keyed list is annotated with the members that appeared or
    vanished (see :func:`_keyed_membership_delta`).

    Args:
        before: The stored entity payload.
        after: The live entity payload.

    Returns:
        Sorted ``field`` names present-in-one-only or holding different values, each
        optionally annotated with its keyed-membership delta.
    """
    names = set(before) | set(after)
    reported: List[str] = []
    for field in sorted(names):
        old, new = before.get(field), after.get(field)
        if old == new:
            continue
        delta = _keyed_membership_delta(old, new)
        reported.append(f"{field} ({delta})" if delta else field)
    return reported


def _entity_payloads(model: CanonicalApi) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """Flatten a model into ``(entity, key) → payload`` for field-level reporting.

    Deliberately mirrors :func:`app.import_source._entity_map`'s granularity — root,
    each service (excluding nested operations), each operation, type, and channel —
    so the entities named by :func:`app.import_source.canonical_diff` resolve here.

    Args:
        model: The canonical model.

    Returns:
        The entity payload map.
    """
    payloads: Dict[Tuple[str, str], Dict[str, Any]] = {
        ("root", ""): model.model_dump(
            mode="json", exclude={"raw", "extras", "services", "channels", "types"}
        )
    }
    for service in model.services:
        payloads[("service", service.key)] = service.model_dump(
            mode="json", exclude={"operations"}
        )
        for operation in service.operations:
            payloads[("operation", operation.key)] = operation.model_dump(mode="json")
    for type_ in model.types:
        payloads[("type", type_.key)] = type_.model_dump(mode="json")
    for channel in model.channels:
        payloads[("channel", channel.key)] = channel.model_dump(mode="json")
    return payloads


#: Snapshot fields compared as plain scalars (reported as ``before → after``).
_SCALAR_PATHS: Tuple[Tuple[str, ...], ...] = (
    ("fingerprint",),
    ("detection", "format"),
    ("detection", "confidence"),
    ("counts", "services"),
    ("counts", "operations"),
    ("counts", "types"),
    ("counts", "channels"),
    ("counts", "servers"),
    ("lint", "score"),
    ("lint", "grade"),
    ("lint", "findings"),
    ("lint", "report_fingerprint"),
)


def _dig(payload: Dict[str, Any], path: Tuple[str, ...]) -> Any:
    node: Any = payload
    for part in path:
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _scalar_drift(expected: Dict[str, Any], actual: Dict[str, Any]) -> List[str]:
    """Return ``before → after`` lines for every differing scalar snapshot field."""
    lines: List[str] = []
    for path in _SCALAR_PATHS:
        before, after = _dig(expected, path), _dig(actual, path)
        if before != after:
            lines.append(f"  {'.'.join(path)}: {before!r} → {after!r}")
    return lines


def describe_mismatch(
    entry: CorpusEntry, expected: Dict[str, Any], actual: Dict[str, Any]
) -> str:
    """Render a golden mismatch as an identity-keyed structural diff.

    Runs the shipped :func:`app.import_source.canonical_diff` between the stored and
    live canonical models, so the report is by canonical key (a re-ordered source is
    not a diff) rather than a blob comparison, and annotates each ``CHANGED`` entity
    with the fields that actually differ. Scalar drift in the fingerprint, counts, or
    lint roll-up is listed separately.

    Args:
        entry: The manifest entry being compared.
        expected: The stored snapshot payload.
        actual: The freshly built snapshot payload.

    Returns:
        A multi-line, reviewer-readable description ending in the regeneration hint.
    """
    lines = [f"{entry.path}: canonical golden snapshot changed."]

    drift = _scalar_drift(expected, actual)
    if drift:
        lines.append("scalar drift:")
        lines.extend(drift)

    before_model = _model_from_payload(expected.get("canonical"))
    after_model = _model_from_payload(actual.get("canonical"))
    if before_model is not None and after_model is not None:
        diff = canonical_diff(before_model, after_model)
        if diff.entries:
            before_payloads = _entity_payloads(before_model)
            after_payloads = _entity_payloads(after_model)
            lines.append(f"canonical diff ({len(diff.entries)} keyed change(s)):")
            for change in diff.entries:
                label = f"  {change.change.value} {change.entity} {change.key or '<root>'}"
                if change.change is DiffChangeKind.CHANGED:
                    fields = _changed_fields(
                        before_payloads.get((change.entity, change.key), {}),
                        after_payloads.get((change.entity, change.key), {}),
                    )
                    if fields:
                        label += f" — fields: {', '.join(fields)}"
                lines.append(label)
        elif not drift:
            # No keyed change and no scalar drift: the text differs by serialization
            # only, which is itself a determinism bug worth surfacing loudly.
            lines.append(
                "no keyed canonical change and no scalar drift — the snapshot text "
                "differs by serialization alone, which means the pipeline is not "
                "deterministic"
            )
    else:
        lines.append(
            "could not reconstruct one of the canonical models for a keyed diff; "
            "compare the snapshot files directly"
        )

    lines.append(
        "If this change is intended, regenerate with "
        "`pytest tests/test_corpus_golden.py --update-golden` and review the diff."
    )
    return "\n".join(lines)


def _model_from_payload(payload: Optional[Dict[str, Any]]) -> Optional[CanonicalApi]:
    """Rebuild a :class:`CanonicalApi` from a snapshot's canonical payload.

    Args:
        payload: The snapshot's ``canonical`` block, or ``None``.

    Returns:
        The validated model, or ``None`` when the payload is absent or no longer
        validates (an envelope change) — in which case the caller falls back to
        pointing the reviewer at the files.
    """
    if not isinstance(payload, dict):
        return None
    try:
        return CanonicalApi.model_validate(payload)
    except Exception:  # noqa: BLE001 - a stale envelope must not mask the real diff
        return None


# ===========================================================================
# Fingerprint stability
# ===========================================================================


def reordered_source(entry: CorpusEntry) -> Optional[str]:
    """Return the entry's source with its mapping keys deterministically reordered.

    The canonical fingerprint is supposed to depend on normalized *content*, not on
    the order the source happened to declare things in (normalizers run
    ``normalize_ordering`` for exactly this reason). Reversing every mapping's key
    order is a cheap way to prove it: the document means the same thing, so the
    fingerprint must not move.

    Only structured JSON/YAML sources can be reordered this way; a text-grammar
    source (proto, GraphQL SDL, an IDL) has no key order to permute.

    Args:
        entry: The manifest entry.

    Returns:
        The reordered source text, or ``None`` when the source is not a JSON/YAML
        mapping (so the caller skips the check).
    """
    text = entry.read_text()
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError:
        return None
    if not isinstance(document, dict) or not document:
        return None
    return yaml.safe_dump(_reverse_keys(document), sort_keys=False, allow_unicode=True)


def _reverse_keys(node: Any) -> Any:
    """Recursively rebuild mappings with their keys in reverse order."""
    if isinstance(node, dict):
        return {key: _reverse_keys(node[key]) for key in reversed(list(node))}
    if isinstance(node, list):
        return [_reverse_keys(item) for item in node]
    return node
