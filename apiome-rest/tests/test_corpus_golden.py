"""Canonical golden snapshot conformance tests — IXH-1.6 (#5092).

Every ``valid`` corpus entry runs detect → parse → normalize → fingerprint → lint and
is compared against a checked-in snapshot of its canonical model (``raw`` excluded)
plus its fingerprint, entity counts, and lint roll-up. That turns the canonical model
— the contract diff, lint, convert, and export all read — into something a reviewer
can see change, instead of a shape only hand-picked assertions covered.

What this suite proves, in the order the acceptance criteria list it:

* a golden exists for every valid entry this environment can run, and no golden is
  orphaned (deleting a fixture must delete its snapshot);
* snapshots are byte-stable: the pipeline is run **twice** per entry and must render
  identically, which is what catches set-iteration order leaking into a list;
* a canonical change fails as an identity-keyed structural diff (which entity, which
  key, which fields) rather than an opaque blob diff — asserted directly, by mutating
  a model and checking the rendered report;
* ``--update-golden`` regenerates instead of comparing;
* the version fingerprint is invariant to source declaration order.

Regenerate with ``pytest tests/test_corpus_golden.py --update-golden`` (or
``UPDATE_CORPUS_GOLDENS=1``), then review the diff before committing.
"""

from __future__ import annotations

import copy
from typing import Dict, List

import pytest
from corpus_adapter_support import (
    KNOWN_IMPORT_BUGS,
    adapter_for,
    build_fileset,
    missing_tools,
    valid_entries,
)
from corpus_loader import CorpusEntry, FilesetRole
from corpus_snapshot import (
    GOLDEN_ROOT,
    SNAPSHOT_VERSION,
    build_snapshot,
    describe_mismatch,
    golden_paths_on_disk,
    load_golden,
    render,
    reordered_source,
    run_pipeline,
    snapshot_path,
    updating_goldens,
    write_golden,
)

from app.import_source import canonical_fingerprint, load_builtin_import_sources

load_builtin_import_sources()

_JSON_SCHEMA_REASON = (
    "json_schema_normalizer never calls normalize_ordering, so Type.fields keeps the "
    "source's property declaration order and the fingerprint moves when the source "
    "is reordered."
)
_JTD_REASON = (
    "jtd_normalizer never calls normalize_ordering, so Type.fields keeps the "
    "source's property declaration order and the fingerprint moves when the source "
    "is reordered."
)
_FHIR_REASON = (
    "fhir_normalizer calls normalize_ordering on only some return paths; the path "
    "these fixtures take leaves Type.fields in source order, so the fingerprint "
    "moves when the source is reordered."
)
_RAML_REASON = (
    "raml_normalizer calls normalize_ordering on only some return paths; the path "
    "these fixtures take leaves Type.fields in source order, so the fingerprint "
    "moves when the source is reordered."
)

#: Corpus entries whose canonical output still depends on the *source's* declaration
#: order, so their version fingerprint moves when a semantically identical document
#: is reordered. Surfaced by this suite (IXH-1.6): in every case a ``Type``'s
#: ``fields`` list keeps source order instead of being key-sorted, because the
#: normalizer never reaches :func:`app.normalizer.normalize_ordering`'s field sort.
#:
#: Path -> reason, listed per entry rather than per adapter because the affected
#: normalizers reach the ordering call on *some* return paths: an adapter-wide entry
#: would wrongly excuse the fixtures that are already stable. Strict xfail, matching
#: the :data:`~tests.corpus_adapter_support.KNOWN_IMPORT_BUGS` convention — fixing a
#: normalizer fails this suite until its entries are deleted from the map, so the
#: debt cannot rot.
#:
#: This does **not** affect the golden snapshots: a fingerprint is stable for a
#: *fixed* source, and every corpus fixture is fixed.
KNOWN_ORDER_SENSITIVE_FINGERPRINTS: Dict[str, str] = {
    "fhir/01-patient.json": _FHIR_REASON,
    "fhir/04-minimal-patient.json": _FHIR_REASON,
    "fhir/06-capability-statement.json": _FHIR_REASON,
    "json-schema/01-simple-person.json": _JSON_SCHEMA_REASON,
    "json-schema/02-product-types.json": _JSON_SCHEMA_REASON,
    "json-schema/03-multiple-defs.json": _JSON_SCHEMA_REASON,
    "json-schema/04-draft07-definitions.json": _JSON_SCHEMA_REASON,
    "json-schema/05-allof-inheritance.json": _JSON_SCHEMA_REASON,
    "json-schema/06-oneof-polymorphism.json": _JSON_SCHEMA_REASON,
    "json-schema/07-anyof-flexible.json": _JSON_SCHEMA_REASON,
    "json-schema/08-if-then-else.json": _JSON_SCHEMA_REASON,
    "json-schema/09-advanced-features.json": _JSON_SCHEMA_REASON,
    "json-schema/10-comprehensive-ecommerce.json": _JSON_SCHEMA_REASON,
    "json-schema/11-geojson-feature.json": _JSON_SCHEMA_REASON,
    "json-schema/12-nonconforming-examples.json": _JSON_SCHEMA_REASON,
    "jtd/01-user.jtd.json": _JTD_REASON,
    "jtd/02-order.jtd.json": _JTD_REASON,
    "jtd/04-support-ticket.jtd.json": _JTD_REASON,
    "jtd/05-sensor-envelope-stress.jtd.json": _JTD_REASON,
    "jtd/06-github-push-event.jtd.json": _JTD_REASON,
    "raml/01-simple-api.raml": _RAML_REASON,
    "raml/03-orders-service.raml": _RAML_REASON,
    "raml/04-resource-types-and-traits.raml": _RAML_REASON,
    "raml/05-grammar-corners.raml": _RAML_REASON,
    "raml/06-github-style-api.raml": _RAML_REASON,
}


def _runnable_entries() -> List[CorpusEntry]:
    """Valid entries this environment can actually run end to end.

    Excludes entries whose adapter needs a tool that does not resolve here (their
    parse cannot run at all) and entries listed in
    :data:`~tests.corpus_adapter_support.KNOWN_IMPORT_BUGS` (their pipeline raises by
    design until the adapter is fixed).
    """
    return [
        entry
        for entry in valid_entries()
        if entry.path not in KNOWN_IMPORT_BUGS
        and not missing_tools(entry.adapter_key or "")
    ]


def _entry_param(entry: CorpusEntry) -> "pytest.param":
    """Parametrize one entry, skipping/xfailing on the shared gates."""
    marks = []
    if entry.path in KNOWN_IMPORT_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_IMPORT_BUGS[entry.path], strict=True))
    missing = missing_tools(entry.adapter_key or "")
    if missing:
        marks.append(
            pytest.mark.skip(
                reason=f"bundled {', '.join(missing)} not resolvable in this environment"
            )
        )
    return pytest.param(entry, id=entry.path, marks=marks)


_ENTRY_PARAMS = [_entry_param(entry) for entry in valid_entries()]


# ---------------------------------------------------------------------------
# The snapshot contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("entry", _ENTRY_PARAMS)
def test_canonical_snapshot_matches_golden(entry: CorpusEntry, request) -> None:
    """The entry's live canonical model matches its checked-in snapshot.

    With ``--update-golden`` the snapshot is (re)written instead of compared. On a
    mismatch the failure is an identity-keyed structural diff, not a blob diff.
    """
    snapshot = build_snapshot(run_pipeline(entry, adapter_for(entry)))

    if updating_goldens(request):
        write_golden(entry, snapshot)
        return

    stored = load_golden(entry)
    assert stored is not None, (
        f"{entry.path}: no canonical golden at "
        f"{snapshot_path(entry).relative_to(GOLDEN_ROOT.parents[1])}. Generate it with "
        "`pytest tests/test_corpus_golden.py --update-golden`, then review and commit "
        "it. (An adapter that needs a tool absent from the environment that generated "
        "the goldens will land here first on a machine that has the tool.)"
    )
    if render(stored) != render(snapshot):
        pytest.fail(describe_mismatch(entry, stored, snapshot), pytrace=False)


@pytest.mark.parametrize("entry", _ENTRY_PARAMS)
def test_pipeline_is_deterministic(entry: CorpusEntry) -> None:
    """Running the same entry twice renders byte-identical output.

    Determinism is a property of the pipeline, not of the stored file: a normalizer
    that iterates a set, or seeds a dict from one, produces a different list order
    per process. Comparing two runs in the same process catches the within-run
    variety; the golden comparison above catches the across-run variety.
    """
    adapter = adapter_for(entry)
    first = render(build_snapshot(run_pipeline(entry, adapter)))
    second = render(build_snapshot(run_pipeline(entry, adapter)))
    assert first == second, (
        f"{entry.path}: two runs of the same pipeline produced different output, so "
        "the canonical model is not deterministic (a set iteration or unsorted "
        "collection is leaking into it)"
    )


@pytest.mark.parametrize("entry", _ENTRY_PARAMS)
def test_snapshot_excludes_the_raw_fidelity_bag(entry: CorpusEntry) -> None:
    """No snapshot carries ``raw``, the native AST.

    ``raw`` is source re-serialization rather than normalized identity — the one
    field :func:`app.import_source.canonical_fingerprint` also excludes — and it is
    where a snapshot would otherwise duplicate the whole fixture.
    """
    snapshot = build_snapshot(run_pipeline(entry, adapter_for(entry)))
    assert "raw" not in snapshot["canonical"], f"{entry.path}: snapshot leaked the raw bag"
    assert snapshot["snapshot_version"] == SNAPSHOT_VERSION


# ---------------------------------------------------------------------------
# Fingerprint stability
# ---------------------------------------------------------------------------


def _fingerprint_param(entry: CorpusEntry) -> "pytest.param":
    marks = []
    reason = KNOWN_ORDER_SENSITIVE_FINGERPRINTS.get(entry.path)
    if reason:
        marks.append(pytest.mark.xfail(reason=reason, strict=True))
    if entry.path in KNOWN_IMPORT_BUGS:
        marks.append(pytest.mark.xfail(reason=KNOWN_IMPORT_BUGS[entry.path], strict=True))
    missing = missing_tools(entry.adapter_key or "")
    if missing:
        marks.append(
            pytest.mark.skip(
                reason=f"bundled {', '.join(missing)} not resolvable in this environment"
            )
        )
    return pytest.param(entry, id=entry.path, marks=marks)


def _parse_text(adapter, entry: CorpusEntry, text: str):
    """Parse ``text`` as this entry, through the seam the entry's shape requires.

    A set *root* must go through ``parse_fileset`` even when only its own text is being
    varied: parsing a root alone leaves its cross-file ``$ref`` targets unresolvable, which is a
    property of the fixture, not of the ordering under test. Everything else parses its own
    text directly, exactly as before.

    Args:
        adapter: The entry's resolved import adapter.
        entry: The manifest entry.
        text: The root/document text to parse (possibly a reordered permutation).

    Returns:
        The adapter's native AST.
    """
    if entry.fileset_role is FilesetRole.ROOT:
        return adapter.parse_fileset(
            build_fileset(entry, root_text=text), source_label=entry.path
        )
    return adapter.parse(text, source_label=entry.path)


def _reorderable_entries() -> List[CorpusEntry]:
    """Valid entries whose source is a structured mapping that can be permuted.

    Computed at collection time so a text-grammar fixture (a ``.proto``, an SDL, an
    IDL) is simply not parametrized, rather than collected and skipped — there is no
    key order to permute, and a skip would imply an unproven case.
    """
    return [entry for entry in valid_entries() if reordered_source(entry) is not None]


@pytest.mark.parametrize("entry", [_fingerprint_param(e) for e in _reorderable_entries()])
def test_fingerprint_survives_source_reordering(entry: CorpusEntry) -> None:
    """Reordering the source document does not change the version fingerprint.

    The fingerprint identifies *normalized content*, so a document that declares the
    same API with its mappings in a different order must fingerprint identically —
    otherwise every cosmetic edit looks like a new revision to
    ``skip_duplicate_versions`` and to the diff.

    Parametrized over structured (JSON/YAML) sources only. A reordered document that
    the format then rejects — a RAML header comment dropped by the round-trip, say —
    proves nothing either way and is skipped with that reason.
    """
    adapter = adapter_for(entry)
    reordered = reordered_source(entry)
    assert reordered is not None  # guaranteed by the parametrization

    baseline = canonical_fingerprint(
        adapter.normalize(_parse_text(adapter, entry, entry.read_text()))
    )
    try:
        permuted_ast = _parse_text(adapter, entry, reordered)
    except Exception:  # noqa: BLE001 - a reordered doc the format rejects proves nothing
        pytest.skip("the reordered document is not a valid instance of this format")
    permuted = canonical_fingerprint(adapter.normalize(permuted_ast))

    assert permuted == baseline, (
        f"{entry.path}: reordering the source changed the fingerprint "
        f"({baseline} → {permuted}), so declaration order is leaking into the "
        "canonical model"
    )


# ---------------------------------------------------------------------------
# Store completeness
# ---------------------------------------------------------------------------


def test_every_runnable_valid_entry_has_a_golden() -> None:
    """A golden exists for every valid entry this environment can run."""
    missing = sorted(
        entry.path for entry in _runnable_entries() if load_golden(entry) is None
    )
    assert not missing, (
        "valid corpus entries with no canonical golden (generate with "
        "`pytest tests/test_corpus_golden.py --update-golden`):\n  " + "\n  ".join(missing)
    )


def test_no_orphan_goldens() -> None:
    """Every stored golden still maps to a valid corpus entry.

    Deleting or reclassifying a fixture must delete its snapshot, or the store grows
    a tail of files describing documents that no longer exist.
    """
    known = {entry.path for entry in valid_entries()}
    orphans = sorted(path for path in golden_paths_on_disk() if path not in known)
    assert not orphans, (
        "golden snapshots with no matching valid corpus entry (delete them):\n  "
        + "\n  ".join(orphans)
    )


def test_goldens_are_rendered_in_the_canonical_form() -> None:
    """Every stored golden is byte-identical to re-rendering its own payload.

    Guards against a hand-edited or differently-serialized golden slipping in, which
    would make every future comparison fail for a formatting reason.
    """
    problems = []
    for entry in _runnable_entries():
        path = snapshot_path(entry)
        stored_text = path.read_text(encoding="utf-8")
        if stored_text != render(load_golden(entry) or {}):
            problems.append(entry.path)
    assert not problems, (
        "goldens not in canonical serialization (regenerate with --update-golden):\n  "
        + "\n  ".join(sorted(problems))
    )


# ---------------------------------------------------------------------------
# The failure report is a keyed structural diff, not a blob diff
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def sample_snapshot() -> Dict[str, object]:
    """A real snapshot to mutate in the diff-rendering tests.

    Uses an OpenAPI fixture with services, operations, and types, so every entity
    family the diff reports on is present.
    """
    entry = next(
        e
        for e in _runnable_entries()
        if e.adapter_key == "openapi" and e.path.startswith("openapi/")
    )
    return build_snapshot(run_pipeline(entry, adapter_for(entry)))


def _entry_for(path_prefix: str = "openapi/") -> CorpusEntry:
    return next(e for e in _runnable_entries() if e.path.startswith(path_prefix))


def test_dropped_type_is_reported_as_a_removed_key(sample_snapshot) -> None:
    """A normalizer that stops emitting a type names that type in the diff."""
    entry = _entry_for()
    mutated = copy.deepcopy(sample_snapshot)
    types = mutated["canonical"]["types"]
    if not types:
        pytest.skip("the sample fixture declares no types")
    dropped = types.pop()["key"]

    report = describe_mismatch(entry, sample_snapshot, mutated)
    assert "REMOVED" in report.upper(), report
    assert dropped in report, f"the dropped type key {dropped!r} is not named:\n{report}"
    assert "--update-golden" in report


def test_changed_field_names_the_entity_and_the_field(sample_snapshot) -> None:
    """A changed value reports the entity key *and* which field moved."""
    entry = _entry_for()
    mutated = copy.deepcopy(sample_snapshot)
    types = mutated["canonical"]["types"]
    if not types:
        pytest.skip("the sample fixture declares no types")
    target = types[0]
    target["description"] = "mutated by the golden diff test"

    report = describe_mismatch(entry, sample_snapshot, mutated)
    assert "CHANGED" in report.upper(), report
    assert target["key"] in report, report
    assert "description" in report, f"the changed field is not named:\n{report}"


def test_added_type_is_reported_as_an_added_key(sample_snapshot) -> None:
    """A newly emitted entity is reported as ADDED under its own key."""
    entry = _entry_for()
    mutated = copy.deepcopy(sample_snapshot)
    types = mutated["canonical"]["types"]
    if not types:
        pytest.skip("the sample fixture declares no types")
    # Clone a real type rather than hand-rolling one: the canonical model forbids
    # unknown fields, so a synthetic entity would fail to validate and the renderer
    # would fall back to "could not reconstruct" instead of diffing.
    probe = copy.deepcopy(types[0])
    probe["key"] = "GoldenDiffProbe"
    probe["name"] = "GoldenDiffProbe"
    types.append(probe)

    report = describe_mismatch(entry, sample_snapshot, mutated)
    assert "ADDED" in report.upper(), report
    assert "GoldenDiffProbe" in report, report


def test_dropped_type_field_is_named_in_the_membership_delta() -> None:
    """A silently dropped property names *that property*, not just its list.

    The motivating regression for this whole suite: a normalizer stops emitting one
    field of one type. The report must say which member vanished, so a reviewer does
    not have to diff two 10-KB documents to find out.
    """
    entry = next(
        e
        for e in _runnable_entries()
        if e.path == "json-schema/01-simple-person.json"
    )
    baseline = build_snapshot(run_pipeline(entry, adapter_for(entry)))

    mutated = copy.deepcopy(baseline)
    target = next(t for t in mutated["canonical"]["types"] if t.get("fields"))
    dropped = target["fields"].pop()["key"]

    report = describe_mismatch(entry, baseline, mutated)
    assert f"-{dropped}" in report, (
        f"the dropped field {dropped!r} is not named in the membership delta:\n{report}"
    )
    assert "changed type" in report, report


def test_added_type_field_is_named_in_the_membership_delta() -> None:
    """A newly emitted property is named with a ``+`` in the membership delta."""
    entry = next(
        e
        for e in _runnable_entries()
        if e.path == "json-schema/01-simple-person.json"
    )
    baseline = build_snapshot(run_pipeline(entry, adapter_for(entry)))

    mutated = copy.deepcopy(baseline)
    target = next(t for t in mutated["canonical"]["types"] if t.get("fields"))
    probe = copy.deepcopy(target["fields"][0])
    probe["key"] = "Person.goldenProbe"
    probe["name"] = "goldenProbe"
    target["fields"].append(probe)

    report = describe_mismatch(entry, baseline, mutated)
    assert "+Person.goldenProbe" in report, report


def test_scalar_drift_is_reported_as_before_after(sample_snapshot) -> None:
    """Fingerprint, count, and lint drift read as ``before → after`` lines."""
    entry = _entry_for()
    mutated = copy.deepcopy(sample_snapshot)
    mutated["fingerprint"] = "sha256:" + "0" * 64
    mutated["counts"]["types"] = 999
    mutated["lint"]["grade"] = "F"

    report = describe_mismatch(entry, sample_snapshot, mutated)
    assert "scalar drift:" in report, report
    assert "fingerprint" in report and "→" in report, report
    assert "counts.types" in report and "999" in report, report
    assert "lint.grade" in report, report


def test_identical_snapshots_produce_no_keyed_changes(sample_snapshot) -> None:
    """The renderer reports the determinism case distinctly.

    Identical payloads have no keyed change and no scalar drift, so if the rendered
    text ever differed anyway the report says so explicitly instead of showing an
    empty diff.
    """
    report = describe_mismatch(_entry_for(), sample_snapshot, copy.deepcopy(sample_snapshot))
    assert "not deterministic" in report, report
