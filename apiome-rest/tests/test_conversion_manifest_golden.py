"""Golden pinning of conversion projection manifests over the corpus (CPDO-4.1, #4804).

The acceptance criteria this file stands for:

* **snapshot changes require intentional review** — the full manifest and its summary, per
  representative fixture, compare as canonical text against checked-in goldens; regeneration is
  ``--update-golden`` / ``UPDATE_CONVERSION_GOLDENS=1`` plus a reviewed diff;
* **manifest status totals reconcile** — :func:`app.conversion_projection.reconcile_with_fidelity`
  passes for every corpus conversion, and the summary's totals equal the manifest recount;
* **repeated previews are byte-equivalent** — same fixture, same defaults, same manifest hash and
  identical serialized manifest;
* **every non-retained edge names its cause** — the CPDO-1.3 reason-code contract, swept over
  every fixture rather than one;
* **no raw source values leak** — the manifest carries construct *coordinates*, never payload
  values; the X12 business values and GraphQL raw syntax planted in the fixtures must not appear;
* **REST, CLI, and UI agree** — the recorded wire-format parity envelope
  (``tests/fixtures/conversion_projection_parity.json``) is produced by the real routes and
  re-consumed by ``apiome-cli`` and ``apiome-ui`` copies, so one recorded conversation is the
  cross-surface contract.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from conversion_manifest_corpus import (
    CONVERSION_SNAPSHOT_VERSION,
    PARITY_ENVELOPE_PATH,
    SOURCE_VALUE_PROBES,
    analysis_for,
    build_preview,
    build_snapshot,
    catalog_item_for,
    conversion_entries,
    golden_path,
    golden_paths_on_disk,
    load_golden,
    normalize_volatile_manifest,
    render,
    unique_corpus_entry,
    updating_goldens,
    write_golden,
)
from corpus_loader import CorpusEntry
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.conversion_projection import (
    STATUS_FOR_COVERAGE,
    paginate_conversion_evidence,
    reconcile_with_fidelity,
    summarize_conversion_manifest,
)
from app.main import app
from app.projection_taxonomy import ConversionStatus

_ENTRIES = conversion_entries()
_IDS = [entry.path for entry in _ENTRIES]

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "corpus-tenant", "user_id": "corpus-user", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


# ---------------------------------------------------------------------------
# The corpus sweep
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_conversion_snapshot_matches_golden(entry: CorpusEntry, request) -> None:
    """The live manifest + summary equal the reviewed golden, byte for byte."""
    snapshot = build_snapshot(entry, build_preview(entry))

    if updating_goldens(request):
        write_golden(entry, snapshot)
        return

    golden = load_golden(entry)
    assert golden is not None, (
        f"missing conversion golden for {entry.path}; run "
        f"`pytest tests/test_conversion_manifest_golden.py --update-golden`, review, commit"
    )
    assert render(golden) == render(snapshot), (
        f"conversion manifest for {entry.path} disagrees with its golden; if the change is "
        f"intended, regenerate with `--update-golden` and review the diff"
    )


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_repeated_previews_are_byte_equivalent(entry: CorpusEntry) -> None:
    """Two previews of the same fixture under the same defaults produce the same manifest hash
    and the identical serialized manifest — the reproducibility the MVP promises across surfaces."""
    first = build_preview(entry)
    second = build_preview(entry)
    assert first.manifest.manifest_hash == second.manifest.manifest_hash
    assert first.manifest.model_dump(mode="json") == second.manifest.model_dump(mode="json")


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_manifest_status_totals_reconcile(entry: CorpusEntry) -> None:
    """The manifest's checklist/loss tallies agree with the fidelity report produced by the same
    preview, and the summary's totals equal a recount of the manifest it summarizes."""
    preview = build_preview(entry)
    manifest = preview.manifest

    # Raises on any checklist-key, checklist-status, or loss tally disagreement.
    reconcile_with_fidelity(manifest, preview.fidelity)

    summary = summarize_conversion_manifest(manifest)
    assert summary.edge_count == len(manifest.edges)
    assert summary.node_count == len(manifest.nodes)
    recount: dict = {}
    for edge in manifest.edges:
        recount[edge.status.value] = recount.get(edge.status.value, 0) + 1
    assert {k: v for k, v in summary.status_counts.items() if v} == recount

    # And the checklist lane alone agrees with the report's own coverage counts.
    checklist = [edge for edge in manifest.edges if edge.scope.value == "checklist"]
    coverage_recount: dict = {}
    for item in preview.fidelity.items:
        status = STATUS_FOR_COVERAGE[item.coverage]
        coverage_recount[status.value] = coverage_recount.get(status.value, 0) + 1
    checklist_tally: dict = {}
    for edge in checklist:
        checklist_tally[edge.status.value] = checklist_tally.get(edge.status.value, 0) + 1
    assert checklist_tally == coverage_recount


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_every_non_retained_edge_names_its_cause(entry: CorpusEntry) -> None:
    """A dropped, inferred, transformed, or unavailable construct always says why — the reason
    code is what the evidence drawer and the remediation flow are built on."""
    manifest = build_preview(entry).manifest
    for edge in manifest.edges:
        if edge.status is ConversionStatus.RETAINED:
            continue
        assert edge.reason is not None, f"{entry.path}: edge {edge.id} has no reason"


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_pagination_reassembles_the_whole_manifest(entry: CorpusEntry) -> None:
    """Walking the canonical cursor stream at a small page size yields every edge exactly once —
    what the CLI's ``--projection-out`` and the UI's paging hook both depend on."""
    manifest = build_preview(entry).manifest
    edges: list = []
    cursor = None
    while True:
        page = paginate_conversion_evidence(manifest, cursor=cursor, limit=7, scope=None)
        edges.extend(edge.id for edge in page.edges)
        assert page.total == len(manifest.edges)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert edges == [edge.id for edge in manifest.edges]


@pytest.mark.parametrize("entry", _ENTRIES, ids=_IDS)
def test_manifest_carries_no_source_values(entry: CorpusEntry) -> None:
    """The manifest is coordinates, never content: the value-bearing literals planted in the
    fixture must not appear anywhere in the serialized manifest (CPDO-3.2's redaction-by-
    construction, swept across the corpus)."""
    probes = SOURCE_VALUE_PROBES.get(entry.path)
    if not probes:
        pytest.skip("fixture carries no value-bearing literal distinguishable from its schema")
    serialized = json.dumps(build_preview(entry).manifest.model_dump(mode="json"))
    for probe in probes:
        assert probe not in serialized, f"{entry.path}: manifest leaked source value {probe!r}"


def test_every_selected_entry_has_a_golden() -> None:
    """The sweep is complete; growing the selection without regenerating goldens fails here."""
    missing = [entry.path for entry in _ENTRIES if load_golden(entry) is None]
    assert missing == []


def test_no_orphan_goldens() -> None:
    """Every golden on disk belongs to a selected entry."""
    expected = {entry.path for entry in _ENTRIES}
    orphans = [path for path in golden_paths_on_disk() if path not in expected]
    assert orphans == []


def test_goldens_are_rendered_in_the_canonical_form() -> None:
    """Golden files are exactly ``render``'s output — minimal diffs, idempotent re-renders."""
    for entry in _ENTRIES:
        path = golden_path(entry)
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        assert text == render(json.loads(text)), f"{path} is not canonically rendered"


def test_golden_snapshot_versions_are_current() -> None:
    """A layout change must bump the snapshot version and regenerate everything together."""
    for entry in _ENTRIES:
        golden = load_golden(entry)
        if golden is None:
            continue
        assert golden["snapshot_version"] == CONVERSION_SNAPSHOT_VERSION, entry.path


# ---------------------------------------------------------------------------
# The recorded wire-format parity envelope (REST ↔ CLI ↔ UI)
# ---------------------------------------------------------------------------

#: The fixture the envelope records: the multi-group interchange, converted with its real
#: analysis attached — the richest manifest in the corpus (all four scopes populated).
_PARITY_FEATURES = ("multi-functional-group",)
_PARITY_PAGE_LIMIT = 16  # small enough to force a multi-page cursor walk


def _record_parity_conversation() -> dict:
    """Drive the real dry-run + projection routes and record the wire conversation.

    The catalog item, its revision, and its analysis are patched at the route boundary — the same
    seams the CPDO-1.3/3.3 route tests use — so what is recorded is the genuine HTTP contract:
    camelCase top level, snake_case nested payloads, canonical cursor stream.
    """
    entry = unique_corpus_entry(format="edix12", features=_PARITY_FEATURES)
    item = catalog_item_for(entry)
    analysis_record = SimpleNamespace(analysis=analysis_for(entry))

    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.catalog_routes.load_analysis_for_item"
        ) as mock_analysis:
            mock_db.get_catalog_item_by_id.return_value = item
            mock_db.get_latest_revision_id_for_project.return_value = "rev-corpus"
            mock_analysis.return_value = analysis_record

            dry_run = client.post(f"/v1/catalog/corpus-tenant/{item['id']}/convert?dryRun=true")
            assert dry_run.status_code == 200, dry_run.text

            responses = []
            cursor = None
            while True:
                body = {"limit": _PARITY_PAGE_LIMIT}
                if cursor is not None:
                    body["cursor"] = cursor
                page = client.post(
                    f"/v1/catalog/corpus-tenant/{item['id']}/projection", json=body
                )
                assert page.status_code == 200, page.text
                responses.append(page.json())
                cursor = responses[-1]["page"]["next_cursor"]
                if cursor is None:
                    break
    finally:
        app.dependency_overrides.pop(validate_authentication, None)

    summary = responses[0]["summary"]
    status_totals = {
        status: count for status, count in summary["status_counts"].items() if count
    }
    return {
        "envelope_version": 1,
        "corpus_path": entry.path,
        "request": {"target": "openapi", "scope": None, "limit": _PARITY_PAGE_LIMIT},
        "dry_run_projection": json.loads(dry_run.text)["projection"],
        "responses": responses,
        "expected": {
            "edge_count": summary["edge_count"],
            "node_count": summary["node_count"],
            "page_count": len(responses),
            "status_totals": status_totals,
            "manifest_hash": summary["manifest_hash"],
        },
    }


def test_parity_envelope_matches_the_live_routes(request) -> None:
    """The recorded envelope is what the routes serve today (volatile fields normalized) — when
    this fails, the CLI/UI copies are stale and the whole family regenerates together:
    ``--update-golden`` here, then re-copy to ``apiome-cli/tests/fixtures/`` and
    ``apiome-ui/tests/fixtures/`` as each copy's docblock states."""
    live = _record_parity_conversation()

    if updating_goldens(request):
        PARITY_ENVELOPE_PATH.parent.mkdir(parents=True, exist_ok=True)
        PARITY_ENVELOPE_PATH.write_text(render(live), encoding="utf-8")
        return

    assert PARITY_ENVELOPE_PATH.exists(), (
        "missing conversion_projection_parity.json; regenerate with --update-golden"
    )
    recorded = json.loads(PARITY_ENVELOPE_PATH.read_text(encoding="utf-8"))
    assert render(normalize_volatile_manifest(recorded)) == render(
        normalize_volatile_manifest(live)
    ), (
        "the recorded parity envelope no longer matches the live routes; regenerate with "
        "--update-golden and re-copy the apiome-cli / apiome-ui fixture copies"
    )


def test_parity_envelope_is_internally_consistent() -> None:
    """The envelope's own numbers must agree before any other surface consumes them: page edges
    sum to the declared edge count, every page cites the same manifest hash as the dry run, and
    the recorded status totals equal a recount over the recorded pages."""
    if not PARITY_ENVELOPE_PATH.exists():
        pytest.skip("envelope not generated yet")
    envelope = json.loads(PARITY_ENVELOPE_PATH.read_text(encoding="utf-8"))
    expected = envelope["expected"]
    responses = envelope["responses"]

    edges = [edge for response in responses for edge in response["page"]["edges"]]
    assert len(edges) == expected["edge_count"]
    assert len({edge["id"] for edge in edges}) == expected["edge_count"]
    assert len(responses) == expected["page_count"]

    hashes = {response["summary"]["manifest_hash"] for response in responses}
    assert hashes == {expected["manifest_hash"]}
    assert envelope["dry_run_projection"]["manifest_hash"] == expected["manifest_hash"]

    recount: dict = {}
    for edge in edges:
        recount[edge["status"]] = recount.get(edge["status"], 0) + 1
    assert recount == expected["status_totals"]

    for response in responses:
        for edge in response["page"]["edges"]:
            assert edge["status"] == "retained" or edge["reason"]
