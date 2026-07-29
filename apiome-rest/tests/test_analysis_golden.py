"""Golden pinning of payload-analysis documents over the corpus (CPDO-4.1, #4804).

The acceptance criteria this file stands for:

* **snapshot changes require intentional review** — every selected fixture's full analysis
  document is compared, as canonical text, against a checked-in golden; the only way to change one
  is ``--update-golden`` (or ``UPDATE_ANALYSIS_GOLDENS=1``) plus a reviewed diff;
* **the corpus covers supported and documented-unsupported constructs** — the selection is every
  valid X12 and copybook fixture (multi-group interchanges, composites, repeated segments, nested
  groups, ODO, COMP-3, 88 conditions, REDEFINES and its warning paths, unmodelled clauses) plus
  generic JSON Schema / GraphQL controls;
* **analysis output is deterministic** — the same bytes analyze to the same document, twice;
* **the published contract holds** — every golden document validates against
  :func:`app.payload_analysis.document_json_schema`, the schema the CLI and UI consume;
* **unavailable, redacted, and legacy analysis are covered** — the absence constructor, the
  value-visibility redaction of a recorded document, and a legacy (pre-CPDO) row read are each
  pinned here at corpus level (store/route behaviour for the same states lives in
  ``test_payload_analysis_store.py`` / ``test_catalog_analysis_routes.py``).
"""

from __future__ import annotations

import difflib
import json

import jsonschema
import pytest
from analysis_corpus import (
    ANALYSIS_SNAPSHOT_VERSION,
    VOLATILE,
    analysis_entries,
    build_analysis_document,
    build_snapshot,
    golden_path,
    golden_paths_on_disk,
    load_golden,
    render,
    updating_goldens,
    write_golden,
)
from corpus_loader import CorpusEntry

from app.payload_analysis import (
    REASON_NOT_ANALYZED,
    STATUS_UNAVAILABLE,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    document_from_row,
    document_json_schema,
    unavailable_document,
)

_ENTRIES = analysis_entries()
_IDS = [entry.path for entry in _ENTRIES]


def _diff(expected: str, actual: str) -> str:
    """Render a bounded unified diff between two golden texts."""
    lines = difflib.unified_diff(
        expected.splitlines(keepends=True),
        actual.splitlines(keepends=True),
        fromfile="golden",
        tofile="live",
        n=2,
    )
    excerpt = list(lines)[:80]
    return "".join(excerpt)


# ---------------------------------------------------------------------------
# The corpus sweep
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_analysis_snapshot_matches_golden(entry: CorpusEntry, request) -> None:
    """The live analysis document equals the reviewed golden, byte for byte."""
    snapshot = build_snapshot(entry, build_analysis_document(entry))

    if updating_goldens(request):
        write_golden(entry, snapshot)
        return

    golden = load_golden(entry)
    assert golden is not None, (
        f"missing analysis golden for {entry.path}; run "
        f"`pytest tests/test_analysis_golden.py --update-golden`, review the new file, commit it"
    )
    expected, actual = render(golden), render(snapshot)
    assert expected == actual, (
        f"analysis document for {entry.path} disagrees with its golden; if the change is "
        f"intended, regenerate with `--update-golden` and review the diff\n"
        f"{_diff(expected, actual)}"
    )


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_analysis_is_deterministic(entry: CorpusEntry) -> None:
    """Analyzing the same bytes twice yields the identical document — the property that makes a
    golden meaningful at all (a nondeterministic analyzer would fail the sweep only sometimes)."""
    first = build_snapshot(entry, build_analysis_document(entry))
    second = build_snapshot(entry, build_analysis_document(entry))
    assert render(first) == render(second)


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_golden_document_validates_against_published_schema(entry: CorpusEntry) -> None:
    """Every golden document conforms to the JSON Schema the API publishes for non-Pydantic
    consumers (the CLI and the UI fixture corpus read exactly this shape)."""
    golden = load_golden(entry)
    assert golden is not None, f"missing analysis golden for {entry.path}"
    assert golden["snapshot_version"] == ANALYSIS_SNAPSHOT_VERSION
    jsonschema.validate(instance=golden["document"], schema=document_json_schema())


def test_every_selected_entry_has_a_golden() -> None:
    """The sweep is complete: adding a corpus fixture without regenerating goldens fails here."""
    missing = [entry.path for entry in _ENTRIES if load_golden(entry) is None]
    assert missing == [], (
        f"corpus entries without analysis goldens: {missing}; run "
        f"`pytest tests/test_analysis_golden.py --update-golden` and review the new files"
    )


def test_no_orphan_goldens() -> None:
    """Every golden on disk belongs to a selected entry: removing or re-tagging a fixture must
    remove its golden too, or the corpus silently claims coverage it no longer has."""
    expected = {entry.path for entry in _ENTRIES}
    orphans = [path for path in golden_paths_on_disk() if path not in expected]
    assert orphans == []


def test_goldens_are_rendered_in_the_canonical_form() -> None:
    """Golden files are exactly ``render``'s output, so diffs are always minimal and re-renders
    are always no-ops."""
    for entry in _ENTRIES:
        path = golden_path(entry)
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        assert text == render(json.loads(text)), f"{path} is not canonically rendered"


def test_goldens_normalize_dependency_versions() -> None:
    """Recorded ``toolVersions`` values are the volatile placeholder — a dependency bump must not
    churn the corpus — while the keys stay, so a change in what an analyzer leans on is visible."""
    for entry in _ENTRIES:
        golden = load_golden(entry)
        if golden is None:
            continue
        tool_versions = golden["document"]["analyzer"]["toolVersions"]
        assert all(value == VOLATILE for value in tool_versions.values()), entry.path


# ---------------------------------------------------------------------------
# Unavailable, redacted, and legacy states
# ---------------------------------------------------------------------------


def test_unavailable_document_keeps_the_empty_tree_contract() -> None:
    """The declared-absence record: empty tree, a stated reason, no contract violations, and the
    same published schema as a full document."""
    document = unavailable_document(REASON_NOT_ANALYZED, source_format="edix12")
    assert document.status == STATUS_UNAVAILABLE
    assert document.status_reason == REASON_NOT_ANALYZED
    assert document.tree == []
    assert document.contract_violations() == []
    jsonschema.validate(
        instance=document.model_dump(mode="json", by_alias=True),
        schema=document_json_schema(),
    )


def test_none_visibility_redacts_the_recorded_previews() -> None:
    """Applying ``NONE`` visibility to a recorded X12 document removes every sampled source value
    the structural policy had kept, counts what it withheld, and changes the content fingerprint —
    redaction is part of the document's identity, not cosmetics."""
    entry = next(e for e in _ENTRIES if e.path == "edi-x12/07-837-composite-claim.edi")
    document = build_analysis_document(entry)
    structural_json = json.dumps(document.model_dump(mode="json"))
    assert "CLAIM-001" in structural_json, (
        "fixture probe value missing under the structural policy; pick a value the "
        "fixture actually carries"
    )

    redacted = apply_value_visibility(document, ValueVisibility.NONE)
    redacted_json = json.dumps(redacted.model_dump(mode="json"))
    assert "CLAIM-001" not in redacted_json
    assert redacted.redaction.redacted_node_count > 0
    assert analysis_content_fingerprint(redacted) != analysis_content_fingerprint(document)


def test_legacy_row_reads_as_declared_unavailable() -> None:
    """A pre-CPDO row (no status, no tree) rebuilds as a declared ``unavailable`` document rather
    than a fabricated tree — the reading half of the legacy contract the store tests pin on the
    writing side."""
    document = document_from_row({"status": None, "tree": None, "warnings": None})
    assert document.status == STATUS_UNAVAILABLE
    assert document.tree == []
    jsonschema.validate(
        instance=document.model_dump(mode="json", by_alias=True),
        schema=document_json_schema(),
    )
