"""Corpus manifest contract tests — IXH-1.1 (#5087).

The import example corpus (``apiome-ui/examples/``) is governed by
``corpus.manifest.json``. These tests keep that contract honest:

* **Completeness, both directions** — every file on disk has a manifest entry
  and every manifest entry points at an existing file, so the corpus can never
  silently grow or shrink past its declaration.
* **Schema validity** — the manifest validates against its published JSON
  Schema (``corpus.schema.json``), and the schema itself is a valid Draft
  2020-12 schema.
* **Registry consistency** — every ``adapter_key`` names a registered
  ImportSource adapter, so the manifest cannot drift from the adapter registry.
* **Loader behaviour** — :func:`corpus_loader.load_corpus` filters by format /
  validity class / feature / adapter key as documented.
* **README drift** — ``README.md`` is exactly what
  ``scripts/generate_examples_readme.py`` renders from the manifest, so a
  manifest edit without a README regen (or a hand-edited README) fails CI.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from corpus_loader import (
    EXAMPLES_DIR,
    MANIFEST_PATH,
    SCHEMA_PATH,
    CorpusEntry,
    ExpectedOutcome,
    FilesetRole,
    IntakeGuard,
    Rung,
    ValidityClass,
    corpus_files,
    load_corpus,
    load_manifest,
)
from jsonschema import Draft202012Validator

#: The floor every non-preview adapter's valid-example count must reach
#: (IXH-1.2 acceptance criterion, #5088).
MIN_VALID_EXAMPLES_PER_ADAPTER = 6

#: The floor every non-preview adapter's negative-example count — and distinct
#: failure-class count — must reach (IXH-1.3 acceptance criterion, #5089).
MIN_NEGATIVE_EXAMPLES_PER_ADAPTER = 5

_REPO_ROOT = Path(__file__).resolve().parents[2]
_README_PATH = EXAMPLES_DIR / "README.md"
_GENERATOR_PATH = _REPO_ROOT / "scripts" / "generate_examples_readme.py"


def _raw_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _non_preview_adapter_keys() -> set[str]:
    """Registry keys of every adapter the corpus floor applies to."""
    from app.import_source import (
        available_import_sources,
        get_import_source,
        load_builtin_import_sources,
    )

    load_builtin_import_sources()
    return {
        key
        for key in available_import_sources()
        if not get_import_source(key).preview_only
    }


# ---------------------------------------------------------------------------
# Schema & shape
# ---------------------------------------------------------------------------


def test_published_schema_is_a_valid_draft_2020_12_schema():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)


def test_manifest_validates_against_published_schema():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    errors = sorted(
        Draft202012Validator(schema).iter_errors(_raw_manifest()),
        key=lambda e: list(e.absolute_path),
    )
    assert not errors, "manifest violates corpus.schema.json:\n" + "\n".join(
        f"  at {'/'.join(str(p) for p in error.absolute_path) or '<root>'}: {error.message}"
        for error in errors
    )


def test_manifest_parses_into_typed_contract():
    manifest = load_manifest()
    assert manifest.manifest_version == 1
    assert manifest.entries, "corpus manifest has no entries"
    assert all(isinstance(entry, CorpusEntry) for entry in manifest.entries)


# ---------------------------------------------------------------------------
# Completeness (the acceptance-criteria gate)
# ---------------------------------------------------------------------------


def test_every_corpus_file_is_listed_and_every_entry_exists():
    on_disk = {path.relative_to(EXAMPLES_DIR).as_posix() for path in corpus_files()}
    listed = {entry.path for entry in load_manifest().entries}

    unlisted = sorted(on_disk - listed)
    missing = sorted(listed - on_disk)
    problems = []
    if unlisted:
        problems.append(
            "files on disk with no manifest entry (add them to corpus.manifest.json):\n  "
            + "\n  ".join(unlisted)
        )
    if missing:
        problems.append(
            "manifest entries whose file is missing on disk:\n  " + "\n  ".join(missing)
        )
    assert not problems, "\n".join(problems)


def test_entry_paths_are_unique_and_sorted():
    paths = [entry.path for entry in load_manifest().entries]
    assert len(paths) == len(set(paths)), "duplicate paths in corpus.manifest.json"
    assert paths == sorted(paths), "corpus.manifest.json entries must stay path-sorted"


def test_every_entry_directory_has_directory_metadata():
    manifest = load_manifest()
    entry_dirs = {entry.path.split("/", 1)[0] for entry in manifest.entries}
    undeclared = sorted(entry_dirs - set(manifest.directories))
    stale = sorted(set(manifest.directories) - entry_dirs)
    assert not undeclared, f"directories missing from manifest.directories: {undeclared}"
    assert not stale, f"manifest.directories entries with no files: {stale}"


def test_every_adapter_key_names_a_registered_import_source():
    from app.import_source import available_import_sources, load_builtin_import_sources

    load_builtin_import_sources()
    registered = set(available_import_sources())
    unknown = sorted(
        {
            entry.adapter_key
            for entry in load_manifest().entries
            if entry.adapter_key is not None
        }
        - registered
    )
    assert not unknown, f"manifest adapter_key values not in the adapter registry: {unknown}"


# ---------------------------------------------------------------------------
# Loader behaviour
# ---------------------------------------------------------------------------


def test_load_corpus_without_filters_returns_full_corpus():
    assert len(load_corpus()) == len(load_manifest().entries)


def test_load_corpus_filters_by_format():
    entries = load_corpus(format="openapi")
    assert entries, "no openapi entries in the corpus"
    assert all(entry.format == "openapi" for entry in entries)
    assert all(entry.path.startswith("openapi/") for entry in entries)


def test_load_corpus_filters_by_validity_class_enum_and_string():
    invalid_via_enum = load_corpus(validity_class=ValidityClass.INVALID)
    invalid_via_str = load_corpus(validity_class="invalid")
    assert invalid_via_enum == invalid_via_str
    assert all(e.validity_class is ValidityClass.INVALID for e in invalid_via_enum)
    # The corpus's canonical invalid example must stay classified as such.
    assert "arazzo/negative/property-conflicts.yaml" in {e.path for e in invalid_via_enum}


def test_load_corpus_filters_by_feature():
    entries = load_corpus(feature="occurs-depending-on")
    assert entries, "no occurs-depending-on fixture in the corpus"
    assert all("occurs-depending-on" in entry.features for entry in entries)
    assert all(entry.format == "cobolcopybook" for entry in entries)


def test_load_corpus_filters_by_adapter_key():
    entries = load_corpus(adapter_key="grpc")
    assert entries, "no grpc-adapter entries in the corpus"
    assert all(entry.adapter_key == "grpc" for entry in entries)
    assert {entry.path.split("/", 1)[0] for entry in entries} == {"protobuf"}


def test_load_corpus_filters_compose_with_and_semantics():
    entries = load_corpus(format="avro", feature="enum")
    paths = [entry.path for entry in entries]
    assert "avro/01-user-record.avsc" in paths
    assert all(entry.format == "avro" and "enum" in entry.features for entry in entries)


def test_load_corpus_unknown_filter_values_return_empty():
    assert load_corpus(format="no-such-format") == []
    assert load_corpus(feature="no-such-feature") == []
    assert load_corpus(adapter_key="no-such-adapter") == []


def test_load_corpus_rejects_unknown_validity_class():
    with pytest.raises(ValueError):
        load_corpus(validity_class="bogus")


def test_entries_read_text_returns_content():
    entries = load_corpus(format="smithy")
    assert entries, "no smithy entries in the corpus"
    text = entries[0].read_text()
    assert "$version" in text


# ---------------------------------------------------------------------------
# Depth ladder (IXH-1.2, #5088)
# ---------------------------------------------------------------------------


def test_load_corpus_filters_by_rung():
    entries = load_corpus(rung=Rung.MINIMAL)
    assert entries, "no minimal-rung entries in the corpus"
    assert all(entry.rung is Rung.MINIMAL for entry in entries)
    assert load_corpus(rung="minimal") == entries


def test_every_valid_entry_declares_a_rung():
    untagged = sorted(
        entry.path
        for entry in load_corpus(validity_class=ValidityClass.VALID)
        if entry.rung is None
    )
    assert not untagged, f"valid entries missing a ladder rung: {untagged}"


def test_only_valid_entries_declare_rungs():
    mistagged = sorted(
        entry.path
        for entry in load_corpus()
        if entry.validity_class is not ValidityClass.VALID and entry.rung is not None
    )
    assert not mistagged, f"non-valid entries must not declare a rung: {mistagged}"


def test_every_non_preview_adapter_has_the_valid_example_floor():
    counts = {key: 0 for key in _non_preview_adapter_keys()}
    for entry in load_corpus(validity_class=ValidityClass.VALID):
        if entry.adapter_key in counts:
            counts[entry.adapter_key] += 1
    short = {
        key: count
        for key, count in sorted(counts.items())
        if count < MIN_VALID_EXAMPLES_PER_ADAPTER
    }
    assert not short, (
        f"adapters below the {MIN_VALID_EXAMPLES_PER_ADAPTER}-valid-example floor "
        f"(IXH-1.2): {short}"
    )


def test_every_non_preview_adapter_covers_all_rungs_or_waives():
    manifest = load_manifest()
    covered: dict[str, set[Rung]] = {key: set() for key in _non_preview_adapter_keys()}
    for entry in load_corpus(validity_class=ValidityClass.VALID):
        if entry.adapter_key in covered and entry.rung is not None:
            covered[entry.adapter_key].add(entry.rung)
    problems = []
    for key, rungs in sorted(covered.items()):
        waived = set(manifest.rung_waivers.get(key, {}))
        missing = sorted(r.value for r in set(Rung) - rungs - waived)
        if missing:
            problems.append(f"{key}: uncovered, unwaived rungs {missing}")
    assert not problems, (
        "every adapter must cover all six ladder rungs or record a waiver "
        "in rung_waivers:\n  " + "\n  ".join(problems)
    )


def test_rung_waivers_are_registered_and_not_stale():
    manifest = load_manifest()
    non_preview = _non_preview_adapter_keys()
    covered: dict[str, set[Rung]] = {}
    for entry in load_corpus(validity_class=ValidityClass.VALID):
        if entry.adapter_key is not None and entry.rung is not None:
            covered.setdefault(entry.adapter_key, set()).add(entry.rung)
    problems = []
    for key, waivers in sorted(manifest.rung_waivers.items()):
        if key not in non_preview:
            problems.append(f"{key}: waiver for an unknown or preview-only adapter")
            continue
        stale = sorted(r.value for r in set(waivers) & covered.get(key, set()))
        if stale:
            problems.append(f"{key}: stale waivers for covered rungs {stale}")
    assert not problems, "rung_waivers problems:\n  " + "\n  ".join(problems)


def test_fileset_entries_are_consistent():
    """Files in a per-set subdirectory form coherent multi-file sets.

    Every nested entry must carry a ``fileset_role`` and sit on the
    ``multi-file`` rung; flat entries must not carry a role; and every set
    directory must contain exactly one ``root``. The ``negative/`` (IXH-1.3)
    and ``adversarial/`` (IXH-1.4) tier directories are not sets: their files
    behave like flat entries.
    """
    problems = []
    roots_by_set: dict[str, int] = {}
    for entry in load_corpus():
        segments = entry.path.split("/")
        nested = len(segments) == 3 and segments[1] not in ("negative", "adversarial")
        if nested:
            set_dir = entry.path.rsplit("/", 1)[0]
            roots_by_set.setdefault(set_dir, 0)
            if entry.fileset_role is None:
                problems.append(f"{entry.path}: nested file missing fileset_role")
            elif entry.fileset_role is FilesetRole.ROOT:
                roots_by_set[set_dir] += 1
            if entry.validity_class is ValidityClass.VALID and entry.rung is not Rung.MULTI_FILE:
                problems.append(f"{entry.path}: set member must sit on the multi-file rung")
        elif entry.fileset_role is not None:
            problems.append(f"{entry.path}: fileset_role on a file outside a set directory")
    for set_dir, count in sorted(roots_by_set.items()):
        if count != 1:
            problems.append(f"{set_dir}/: expected exactly one fileset root, found {count}")
    assert not problems, "multi-file set problems:\n  " + "\n  ".join(problems)


# ---------------------------------------------------------------------------
# Negative tier (IXH-1.3, #5089)
# ---------------------------------------------------------------------------


def test_invalid_entries_declare_failure_class_and_error_code():
    """Every invalid entry carries the IXH-1.3 negative-contract fields, and
    only invalid entries carry them."""
    problems = []
    for entry in load_corpus():
        if entry.validity_class is ValidityClass.INVALID:
            if entry.failure_class is None:
                problems.append(f"{entry.path}: invalid entry missing failure_class")
            if entry.expected_error_code is None:
                problems.append(f"{entry.path}: invalid entry missing expected_error_code")
            if entry.expected_outcome is not ExpectedOutcome.REJECTS:
                problems.append(f"{entry.path}: invalid entry must declare expected_outcome rejects")
        else:
            if entry.failure_class is not None:
                problems.append(f"{entry.path}: failure_class on a non-invalid entry")
            if (
                entry.expected_error_code is not None
                and entry.validity_class is not ValidityClass.ADVERSARIAL
            ):
                problems.append(
                    f"{entry.path}: expected_error_code on a non-invalid, "
                    "non-adversarial entry"
                )
    assert not problems, "negative-contract problems:\n  " + "\n  ".join(problems)


def test_expected_error_codes_are_registered_taxonomy_codes():
    from app.intake_error_taxonomy import INTAKE_ERROR_TAXONOMY

    unknown = sorted(
        {
            f"{entry.path}: {entry.expected_error_code}"
            for entry in load_corpus()
            if entry.expected_error_code is not None
            and entry.expected_error_code not in INTAKE_ERROR_TAXONOMY
        }
    )
    assert not unknown, (
        "expected_error_code values not in app.intake_error_taxonomy:\n  " + "\n  ".join(unknown)
    )


def test_invalid_entries_live_in_the_negative_tier():
    """Invalid fixtures live under ``<format>/negative/`` and vice versa."""
    problems = []
    for entry in load_corpus():
        segments = entry.path.split("/")
        in_tier = len(segments) == 3 and segments[1] == "negative"
        if entry.validity_class is ValidityClass.INVALID and not in_tier:
            problems.append(f"{entry.path}: invalid entry outside a negative/ tier directory")
        if in_tier and entry.validity_class is not ValidityClass.INVALID:
            problems.append(f"{entry.path}: negative/ tier file not classified invalid")
    assert not problems, "negative-tier placement problems:\n  " + "\n  ".join(problems)


def test_every_non_preview_adapter_has_the_negative_example_floor():
    """IXH-1.3 acceptance: >= 5 negative entries covering distinct failure
    classes for every shipped adapter."""
    entries_by_adapter: dict[str, list[CorpusEntry]] = {
        key: [] for key in _non_preview_adapter_keys()
    }
    for entry in load_corpus(validity_class=ValidityClass.INVALID):
        if entry.adapter_key in entries_by_adapter:
            entries_by_adapter[entry.adapter_key].append(entry)
    problems = []
    for key, entries in sorted(entries_by_adapter.items()):
        classes = {entry.failure_class for entry in entries if entry.failure_class}
        if len(entries) < MIN_NEGATIVE_EXAMPLES_PER_ADAPTER:
            problems.append(
                f"{key}: {len(entries)} negative entries "
                f"(floor {MIN_NEGATIVE_EXAMPLES_PER_ADAPTER})"
            )
        elif len(classes) < MIN_NEGATIVE_EXAMPLES_PER_ADAPTER:
            problems.append(
                f"{key}: negative entries span only {len(classes)} distinct "
                f"failure classes (floor {MIN_NEGATIVE_EXAMPLES_PER_ADAPTER})"
            )
    assert not problems, (
        "adapters below the IXH-1.3 negative-corpus floor:\n  " + "\n  ".join(problems)
    )


# ---------------------------------------------------------------------------
# README drift (CI gate for the generated human index)
# ---------------------------------------------------------------------------


def _load_readme_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_examples_readme", _GENERATOR_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_readme_matches_manifest_rendering():
    generator = _load_readme_generator()
    rendered = generator.build_readme(_raw_manifest())
    current = _README_PATH.read_text(encoding="utf-8")
    assert current == rendered, (
        "apiome-ui/examples/README.md has drifted from corpus.manifest.json; "
        "run `python3 scripts/generate_examples_readme.py` to regenerate it."
    )


# ---------------------------------------------------------------------------
# Adversarial tier (IXH-1.4, #5090)
# ---------------------------------------------------------------------------


def test_adversarial_entries_declare_a_guard_and_live_in_their_tier():
    """Every adversarial entry names the guard it targets, lives under
    ``<format>/adversarial/``, and nothing else claims that tier."""
    problems = []
    for entry in load_corpus():
        segments = entry.path.split("/")
        in_tier = len(segments) == 3 and segments[1] == "adversarial"
        adversarial = entry.validity_class is ValidityClass.ADVERSARIAL
        if adversarial:
            if entry.guard is None:
                problems.append(f"{entry.path}: adversarial entry missing guard")
            if not in_tier:
                problems.append(
                    f"{entry.path}: adversarial entry outside an adversarial/ tier directory"
                )
            if entry.expected_outcome is ExpectedOutcome.IMPORTS:
                problems.append(
                    f"{entry.path}: adversarial entry must reject or import with warnings"
                )
            if entry.rung is not None:
                problems.append(f"{entry.path}: adversarial entry must not declare a rung")
        else:
            if entry.guard is not None:
                problems.append(f"{entry.path}: guard on a non-adversarial entry")
            if in_tier:
                problems.append(f"{entry.path}: adversarial/ tier file not classified adversarial")
    assert not problems, "adversarial-tier problems:\n  " + "\n  ".join(problems)


def test_rejecting_adversarial_entries_declare_an_error_code():
    """An adversarial entry expected to reject must say which code it rejects with;
    one expected to import with warnings must not."""
    problems = []
    for entry in load_corpus(validity_class=ValidityClass.ADVERSARIAL):
        if entry.expected_outcome is ExpectedOutcome.REJECTS:
            if entry.expected_error_code is None:
                problems.append(f"{entry.path}: rejecting entry missing expected_error_code")
        elif entry.expected_error_code is not None:
            problems.append(
                f"{entry.path}: expected_error_code on an entry that imports with warnings"
            )
    assert not problems, "adversarial error-code problems:\n  " + "\n  ".join(problems)


def test_every_intake_guard_has_corpus_coverage():
    """Each guard in the vocabulary is exercised by at least one fixture.

    Guards whose fixtures are *generated* (archive bombs, path traversal, huge and
    deeply nested documents, alias bombs) are covered by
    ``scripts/generate_adversarial_corpus.py``; the rest appear in the manifest.
    Together they must span the whole vocabulary, so adding a guard without a
    fixture fails here.
    """
    from generated_corpus_spec import generated_guards

    covered = {entry.guard for entry in load_corpus(validity_class=ValidityClass.ADVERSARIAL)}
    covered |= generated_guards()
    missing = sorted(guard.value for guard in set(IntakeGuard) - covered)
    assert not missing, f"intake guards with no adversarial fixture: {missing}"
