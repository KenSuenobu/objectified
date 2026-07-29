"""Conversion-manifest golden corpus — shared machinery (CPDO-4.1, #4804).

CPDO-1.3's suites pin *properties* of the projection manifest (reconciliation, stable ids, bounded
pages); what nothing pinned before this ticket is the manifest itself. A change in the emitter, the
fidelity analyzer, or the manifest builder that reshapes edges, reorders scopes, or reroutes a
construct would pass every property test and silently change what the conversion preview shows a
user. This module pins the full manifest, per representative corpus fixture, exactly as
``projection_corpus`` (EFP-1.3) pins the export manifest.

Each entry is converted through the production path a dry-run uses —
:func:`app.catalog_conversion.build_conversion_source` → :func:`app.conversion_job.preview_conversion`
— from a synthetic catalog item whose captured source is the corpus fixture. Native-analyzer formats
(X12, copybook) attach their real CPDO-1.2 analysis document, so the manifest's ``analysis`` scope is
exercised; the generic controls attach none, pinning the declared analysis-unavailable path.

Volatile values: ``manifest_hash`` folds the package version, and ``tool_versions["apiome-rest"]``
*is* the package version — both move on a release with no behavior change, so goldens store
``[volatile]`` for them (hash determinism itself is pinned by the double-build test, not by
goldens). Every other tool version (emitter, fidelity analyzer, conversion mode) changes only when
behavior changes, and stays.

Regenerate with ``pytest tests/test_conversion_manifest_golden.py --update-golden`` or
``UPDATE_CONVERSION_GOLDENS=1``; review the diff before committing.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from analysis_corpus import build_analysis_document
from corpus_loader import (
    CorpusEntry,
    Rung,
    ValidityClass,
    load_corpus,
    unique_corpus_entry,
)

from app.catalog_conversion import build_conversion_source
from app.conversion_job import ConversionPreview, preview_conversion
from app.payload_analysis import PayloadAnalysisDocument

#: Directory the conversion-manifest golden files live in, mirroring the corpus layout.
CONVERSION_GOLDEN_ROOT = Path(__file__).resolve().parent / "golden" / "conversion_manifests"

#: Set to ``1`` (or pass ``--update-golden``) to regenerate conversion goldens.
UPDATE_CONVERSION_GOLDENS_ENV = "UPDATE_CONVERSION_GOLDENS"

#: Golden payload layout version, bumped only when the snapshot *shape* changes.
CONVERSION_SNAPSHOT_VERSION = 1

#: Placeholder for release-volatile values (the package version and the hash folding it).
VOLATILE = "[volatile]"

#: The recorded wire-format parity envelope consumed by the apiome-cli and apiome-ui copies.
PARITY_ENVELOPE_PATH = Path(__file__).resolve().parent / "fixtures" / "conversion_projection_parity.json"

#: Formats whose entries attach their real payload analysis to the conversion.
NATIVE_ANALYSIS_FORMATS = ("edix12", "cobolcopybook")

# The representative selection: every distinct construct family the roadmap names, one fixture
# each, selected by manifest tag (never path). X12: a plain envelope, the multi-group composition,
# the HIPAA real-world shape, the composite-element fixture. Copybook: ODO, REDEFINES, the
# binary/stress layout, the unmodelled clauses, the imperfect overlays. Controls: the minimal
# JSON Schema and GraphQL fixtures, converting through the generic (no native analysis) path.
_SELECTORS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("edix12", ("850-purchase-order", "iea-trailer")),
    ("edix12", ("multi-functional-group",)),
    ("edix12", ("hipaa-5010",)),
    ("edix12", ("composite-elements",)),
    ("cobolcopybook", ("occurs",)),
    ("cobolcopybook", ("redefines", "level-88")),
    ("cobolcopybook", ("binary",)),
    ("cobolcopybook", ("renames-66",)),
    ("cobolcopybook", ("redefines-target-missing",)),
)

#: Value-bearing source literals that must never appear in a manifest: business values from the
#: X12 fixtures and raw syntax from the GraphQL control. Copybook and JSON Schema fixtures carry
#: no payload values that are distinguishable from construct names, which the manifest carries by
#: design as coordinates.
SOURCE_VALUE_PROBES: Dict[str, Tuple[str, ...]] = {
    "edi-x12/01-850-purchase-order.edi": ("PO-0001", "SENDERID"),
    "edi-x12/04-multi-group-po-ack.edi": ("PO-0002", "SENDERID"),
    "edi-x12/06-834-benefit-enrollment.edi": ("SUBSCRIBER-001", "555443333"),
    "edi-x12/07-837-composite-claim.edi": ("CLAIM-001", "SENDERID"),
    "graphql/01-simple-user.graphql": ("type Query {",),
}


def conversion_entries() -> List[CorpusEntry]:
    """Return the corpus entries the conversion golden suite covers, in manifest order."""
    selected = [
        unique_corpus_entry(format=fmt, features=features) for fmt, features in _SELECTORS
    ]
    for fmt in ("json-schema", "graphql"):
        selected.extend(
            load_corpus(format=fmt, validity_class=ValidityClass.VALID, rung=Rung.MINIMAL)
        )
    return sorted(selected, key=lambda entry: entry.path)


def catalog_item_for(entry: CorpusEntry) -> Dict[str, Any]:
    """Build the synthetic catalog item row a conversion of ``entry`` reconstructs from.

    The shape :meth:`app.database.Database.get_catalog_item_by_id` returns, with the fixture text
    as the captured source — the same construction the CPDO-3.3 route tests use.

    Args:
        entry: The corpus entry to convert.

    Returns:
        The catalog item row.
    """
    # Path-safe (the id travels in route URLs) yet still readable in golden diffs.
    item_id = "corpus-" + entry.path.replace("/", "-").replace(".", "-")
    return {
        "id": item_id,
        "tenant_id": "corpus-tenant",
        "name": entry.path,
        "slug": "corpus-item",
        "publishable": False,
        "source_format": entry.adapter_key,
        "protocol": None,
        "tool_versions": {},
        "format_metadata": {
            "sourceContent": entry.read_text(),
            "sourceLabel": entry.path.rsplit("/", 1)[-1],
        },
    }


def analysis_for(entry: CorpusEntry) -> Optional[PayloadAnalysisDocument]:
    """Return the analysis document a conversion of ``entry`` carries, or ``None``.

    Native-analyzer formats attach their real CPDO-1.2 analysis so the manifest's ``analysis``
    scope is exercised; everything else converts with the analysis declared unavailable.
    """
    if entry.format in NATIVE_ANALYSIS_FORMATS:
        return build_analysis_document(entry)
    return None


def build_preview(entry: CorpusEntry) -> ConversionPreview:
    """Convert ``entry`` through the production dry-run path.

    Args:
        entry: The corpus entry to convert.

    Returns:
        The :class:`~app.conversion_job.ConversionPreview` — fidelity report, OpenAPI document,
        and projection manifest, all describing one conversion.
    """
    source = build_conversion_source(
        catalog_item_for(entry),
        source_version_id="rev-corpus",
        analysis=analysis_for(entry),
    )
    return preview_conversion(source)


def normalize_volatile_manifest(payload: Any) -> Any:
    """Return a deep copy of ``payload`` with release-volatile values normalized.

    Replaces every ``manifest_hash`` value and every ``tool_versions["apiome-rest"]`` value with
    :data:`VOLATILE`, wherever they appear (manifest root, summary, pages). All other tool
    versions are behavior provenance and stay.

    Args:
        payload: Any JSON-serialized manifest/summary/page payload.

    Returns:
        The normalized copy (the input is not mutated).
    """

    def _walk(node: Any) -> Any:
        if isinstance(node, dict):
            out: Dict[str, Any] = {}
            for key, value in node.items():
                if key == "manifest_hash" and isinstance(value, str):
                    out[key] = VOLATILE
                elif key == "tool_versions" and isinstance(value, dict):
                    out[key] = {
                        tool: (VOLATILE if tool == "apiome-rest" else version)
                        for tool, version in value.items()
                    }
                else:
                    out[key] = _walk(value)
            return out
        if isinstance(node, list):
            return [_walk(item) for item in node]
        return node

    return _walk(json.loads(json.dumps(payload)))


def build_snapshot(entry: CorpusEntry, preview: ConversionPreview) -> Dict[str, Any]:
    """Assemble the golden payload for one converted entry.

    Records the summary (what a dry-run response embeds) and the full manifest (what the
    projection pages walk), both volatile-normalized.

    Args:
        entry: The corpus entry that was converted.
        preview: Its conversion preview.

    Returns:
        The snapshot payload.
    """
    from app.conversion_projection import summarize_conversion_manifest

    return {
        "snapshot_version": CONVERSION_SNAPSHOT_VERSION,
        "corpus_path": entry.path,
        "adapter": entry.adapter_key,
        "conversion_mode": preview.conversion_mode,
        "summary": normalize_volatile_manifest(
            summarize_conversion_manifest(preview.manifest).model_dump(mode="json")
        ),
        "manifest": normalize_volatile_manifest(preview.manifest.model_dump(mode="json")),
    }


def render(snapshot: Dict[str, Any]) -> str:
    """Serialize a snapshot in the canonical golden form (sorted keys, indent 2, newline)."""
    return json.dumps(snapshot, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def golden_path(entry: CorpusEntry) -> Path:
    """Return the golden file for ``entry`` (corpus path with ``.json`` appended)."""
    return CONVERSION_GOLDEN_ROOT / f"{entry.path}.json"


def load_golden(entry: CorpusEntry) -> Optional[Dict[str, Any]]:
    """Return the checked-in golden for ``entry``, or ``None`` when absent."""
    path = golden_path(entry)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_golden(entry: CorpusEntry, snapshot: Dict[str, Any]) -> Path:
    """Write ``snapshot`` as ``entry``'s golden and return the path."""
    path = golden_path(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(snapshot), encoding="utf-8")
    return path


def golden_paths_on_disk() -> List[str]:
    """Return every conversion golden on disk as a corpus path (for orphan detection)."""
    if not CONVERSION_GOLDEN_ROOT.exists():
        return []
    return [
        path.relative_to(CONVERSION_GOLDEN_ROOT).as_posix()[: -len(".json")]
        for path in sorted(CONVERSION_GOLDEN_ROOT.rglob("*.json"))
    ]


def updating_goldens(request: Any) -> bool:
    """True when this run should (re)write conversion goldens instead of comparing."""
    if os.environ.get(UPDATE_CONVERSION_GOLDENS_ENV) == "1":
        return True
    return bool(request.config.getoption("--update-golden"))
