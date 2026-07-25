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
    ValidityClass,
    corpus_files,
    load_corpus,
    load_manifest,
)
from jsonschema import Draft202012Validator

_REPO_ROOT = Path(__file__).resolve().parents[2]
_README_PATH = EXAMPLES_DIR / "README.md"
_GENERATOR_PATH = _REPO_ROOT / "scripts" / "generate_examples_readme.py"


def _raw_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


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
    assert "arazzo/property-conflicts.yaml" in {e.path for e in invalid_via_enum}


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
    assert [entry.path for entry in entries] == ["avro/01-user-record.avsc"]


def test_load_corpus_unknown_filter_values_return_empty():
    assert load_corpus(format="no-such-format") == []
    assert load_corpus(feature="no-such-feature") == []
    assert load_corpus(adapter_key="no-such-adapter") == []


def test_load_corpus_rejects_unknown_validity_class():
    with pytest.raises(ValueError):
        load_corpus(validity_class="bogus")


def test_entries_read_text_returns_content():
    [weather] = load_corpus(format="smithy")
    text = weather.read_text()
    assert "$version" in text


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
