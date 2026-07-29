"""Payload-analysis golden corpus — shared machinery (CPDO-4.1, #4804).

The CPDO-1.1/1.2 suites assert *properties* of an analysis (all groups kept, redaction applied,
bounds honoured). What none of them pin is the record itself: a parser or extractor change that
reshapes the native tree, renames an attribute, or drops a warning would pass every property test
and still break the UI inspectors and the projection manifest built on top. This module pins the
whole document, one golden per corpus fixture, the same way ``corpus_snapshot`` pins the canonical
model and ``projection_corpus`` pins the export manifest.

Selection is by corpus tag, never by path (the corpus rule since IXH-1.1): every valid ``edix12``
and ``cobolcopybook`` entry — the two format-native extractors — plus the ``minimal``/``typical``
valid ``json-schema`` and ``graphql`` entries as generic-extractor controls.

Goldens store the document under the **default** value-visibility policy (``structural``), value
previews included: every fixture is committed to this repository already, so a preview of it leaks
nothing — the same reasoning ``corpus_snapshot`` records for canonical goldens. What the redaction
*machinery* must do is pinned separately in ``test_analysis_golden.py`` via
:func:`app.payload_analysis.apply_value_visibility`.

Volatile fields: ``analyzer.toolVersions`` values are underlying library versions (e.g. ``pyx12``)
that change on a dependency bump with no behavior change, so goldens replace them with
``[volatile]``. ``analyzer.version`` and ``schemaVersion`` change only when behavior or contract
change, and stay — that is exactly the ``emitter_version`` / ``apiome_version`` split
``projection_corpus`` uses.

Regenerate with ``pytest tests/test_analysis_golden.py --update-golden`` or
``UPDATE_ANALYSIS_GOLDENS=1``; review the diff before committing — that review is the point.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from corpus_adapter_support import adapter_for, missing_tools
from corpus_loader import CorpusEntry, Rung, ValidityClass, load_corpus

from app.import_source import ImportSource
from app.payload_analysis import PayloadAnalysisDocument
from app.payload_analyzer import analyze_import

#: Directory the analysis golden files live in, mirroring the corpus layout
#: (``tests/golden/analysis/<corpus path>.json``).
ANALYSIS_GOLDEN_ROOT = Path(__file__).resolve().parent / "golden" / "analysis"

#: Set to ``1`` (or pass ``--update-golden``) to regenerate analysis goldens.
UPDATE_ANALYSIS_GOLDENS_ENV = "UPDATE_ANALYSIS_GOLDENS"

#: Golden payload layout version, bumped only when the snapshot *shape* changes.
ANALYSIS_SNAPSHOT_VERSION = 1

#: Placeholder written over release-volatile values (underlying tool versions).
VOLATILE = "[volatile]"

#: Formats with a native analyzer — every valid entry of these is snapshotted.
NATIVE_ANALYSIS_FORMATS = ("edix12", "cobolcopybook")

#: Generic-extractor control formats, limited to the low rungs: the controls exist to prove the
#: generic path stays stable, not to re-pin every fixture the canonical goldens already cover.
GENERIC_CONTROL_FORMATS = ("json-schema", "graphql")
GENERIC_CONTROL_RUNGS = (Rung.MINIMAL, Rung.TYPICAL)


def analysis_entries() -> List[CorpusEntry]:
    """Return the corpus entries the analysis golden suite covers, in manifest order.

    Entries whose adapter needs an external tool that is not installed are excluded the same way
    ``corpus_adapter_support.valid_entries`` excludes them for the canonical suite (none of the
    current selection is tool-gated; the guard is for corpus growth, not today's entries).

    Returns:
        The selected entries: all valid native-analyzer fixtures plus the generic controls.
    """
    selected: List[CorpusEntry] = []
    for fmt in NATIVE_ANALYSIS_FORMATS:
        selected.extend(load_corpus(format=fmt, validity_class=ValidityClass.VALID))
    for fmt in GENERIC_CONTROL_FORMATS:
        for rung in GENERIC_CONTROL_RUNGS:
            selected.extend(
                load_corpus(format=fmt, validity_class=ValidityClass.VALID, rung=rung)
            )
    return [entry for entry in selected if not missing_tools(entry.adapter_key)]


def build_analysis_document(
    entry: CorpusEntry, adapter: Optional[ImportSource] = None
) -> PayloadAnalysisDocument:
    """Parse one corpus entry and analyze it exactly as an import does.

    The path is the import pipeline's: the adapter parses its own text, then
    :func:`app.payload_analyzer.analyze_import` runs the adapter's analyzer over the fresh AST.
    A raising analyzer therefore lands here as a declared ``failed`` document, never an exception —
    if a golden ever records ``failed``, that is a real regression made visible, not a test bug.

    Args:
        entry: The valid corpus entry to analyze.
        adapter: Optional pre-resolved adapter (saves a registry lookup).

    Returns:
        The analysis document the import pipeline would have stored.
    """
    source = adapter or adapter_for(entry)
    text = entry.read_text()
    native_ast = source.parse(text, source_label=entry.path)
    return analyze_import(source, native_ast, source=text)


def normalize_volatile(payload: Any) -> Any:
    """Return a deep copy of ``payload`` with dependency-version values normalized.

    Every value inside a ``toolVersions`` mapping becomes :data:`VOLATILE`: those are the versions
    of libraries the analyzer leaned on, which move on a routine dependency bump. The *keys* stay —
    an analyzer that stops or starts leaning on a tool has changed behavior, and the golden should
    say so.

    Args:
        payload: Any JSON-serialized analysis payload.

    Returns:
        The normalized copy (the input is not mutated).
    """

    def _walk_dict(node: Any) -> Any:
        if isinstance(node, dict):
            out: Dict[str, Any] = {}
            for key, value in node.items():
                if key == "toolVersions" and isinstance(value, dict):
                    out[key] = {tool: VOLATILE for tool in value}
                else:
                    out[key] = _walk_dict(value)
            return out
        if isinstance(node, list):
            return [_walk_dict(item) for item in node]
        return node

    return _walk_dict(json.loads(json.dumps(payload)))


def build_snapshot(entry: CorpusEntry, document: PayloadAnalysisDocument) -> Dict[str, Any]:
    """Assemble the golden payload for one analyzed entry.

    The document is serialized ``by_alias`` — the field names the API puts on the wire and
    :func:`app.payload_analysis.document_json_schema` publishes — so the same golden doubles as a
    recorded API fixture for the UI and CLI suites.

    Args:
        entry: The corpus entry that was analyzed.
        document: Its analysis document.

    Returns:
        The snapshot payload, volatile values normalized.
    """
    return {
        "snapshot_version": ANALYSIS_SNAPSHOT_VERSION,
        "corpus_path": entry.path,
        "adapter": entry.adapter_key,
        "document": normalize_volatile(document.model_dump(mode="json", by_alias=True)),
    }


def render(snapshot: Dict[str, Any]) -> str:
    """Serialize a snapshot in the canonical golden form (sorted keys, indent 2, newline)."""
    return json.dumps(snapshot, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def golden_path(entry: CorpusEntry) -> Path:
    """Return the golden file for ``entry`` (corpus path with ``.json`` appended)."""
    return ANALYSIS_GOLDEN_ROOT / f"{entry.path}.json"


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
    """Return every analysis golden on disk as a corpus path (for orphan detection)."""
    if not ANALYSIS_GOLDEN_ROOT.exists():
        return []
    found: List[str] = []
    for path in sorted(ANALYSIS_GOLDEN_ROOT.rglob("*.json")):
        relative = path.relative_to(ANALYSIS_GOLDEN_ROOT).as_posix()
        found.append(relative[: -len(".json")])
    return found


def updating_goldens(request: Any) -> bool:
    """True when this run should (re)write analysis goldens instead of comparing.

    Either the shared ``--update-golden`` pytest option (which refreshes every golden family in
    one command) or this family's own :data:`UPDATE_ANALYSIS_GOLDENS_ENV` variable.

    Args:
        request: The pytest ``request`` fixture.

    Returns:
        Whether goldens should be written.
    """
    if os.environ.get(UPDATE_ANALYSIS_GOLDENS_ENV) == "1":
        return True
    return bool(request.config.getoption("--update-golden"))
