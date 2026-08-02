"""Corpus provenance and licensing tests — IXH-1.9 (#5095).

``scripts/check_corpus_provenance.py`` is the CI gate that keeps
``apiome-ui/examples/corpus.manifest.json`` free of legal debt (a vendored
third-party document with no license) and privacy debt (a payload captured from
a real system with no anonymization statement). These tests cover both halves:

* **The rule engine** — every rule fires on a purpose-built bad entry and stays
  quiet on a good one, so the gate cannot silently stop enforcing something.
* **The live corpus** — the committed manifest passes the gate, its provenance
  fields validate against the published schema, and the typed loaders expose
  them.

The checker is stdlib-only and lives outside the package, so it is loaded the
same way the README generator is: by path, via ``importlib``, which is also how
CI runs it.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest
from corpus_loader import MANIFEST_PATH, SCHEMA_PATH, Origin, load_corpus, load_manifest
from jsonschema import Draft202012Validator

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CHECKER_PATH = _REPO_ROOT / "scripts" / "check_corpus_provenance.py"


def _load_checker():
    """Import ``scripts/check_corpus_provenance.py`` as a module, by path.

    The module is registered in :data:`sys.modules` before it is executed
    because ``@dataclass`` resolves annotations through the defining module's
    namespace, which a by-path import has not published yet.
    """
    spec = importlib.util.spec_from_file_location("check_corpus_provenance", _CHECKER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


#: A minimal, clean, hand-authored entry — the base every rule case mutates.
GOOD_ENTRY: Dict[str, Any] = {
    "path": "openapi/01-example.yaml",
    "format": "openapi",
    "adapter_key": "openapi",
    "validity_class": "valid",
    "expected_detection": {"format": "openapi-3.1", "min_confidence": 0.9},
    "features": ["paths"],
    "expected_outcome": "imports",
    "source": "hand-authored",
    "license": "Apache-2.0",
    "provenance": "Authored in-repo for the apiome catalog import examples.",
    "rung": "typical",
}

#: A clean entry vendored from an upstream project.
DERIVED_ENTRY: Dict[str, Any] = {
    **GOOD_ENTRY,
    "source": "Example Spec Project",
    "license": "MIT",
    "origin": "derived",
    "source_url": "https://example.com/spec/openapi.yaml",
    "provenance": "Trimmed from the upstream project's published sample specification.",
    "rung": "real-world",
}

#: A clean entry recorded from a real running system.
CAPTURED_ENTRY: Dict[str, Any] = {
    **GOOD_ENTRY,
    "source": "acme-corp staging gateway",
    "license": "Apache-2.0",
    "origin": "captured",
    "anonymization": "Customer names, emails and account numbers replaced with example.com "
    "placeholders; auth headers removed.",
    "provenance": "Recorded from a staging gateway response during adapter development.",
    "rung": "real-world",
}


def _entry(**overrides: Any) -> Dict[str, Any]:
    """Return :data:`GOOD_ENTRY` with ``overrides`` applied (``None`` drops a key)."""
    entry = copy.deepcopy(GOOD_ENTRY)
    for key, value in overrides.items():
        if value is None:
            entry.pop(key, None)
        else:
            entry[key] = value
    return entry


def _rules(entry: Dict[str, Any]) -> List[str]:
    """Return the ids of the rules the checker reports for one entry."""
    return [violation.rule for violation in checker.check_entry(entry)]


# ---------------------------------------------------------------------------
# Clean entries stay clean
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry",
    [GOOD_ENTRY, DERIVED_ENTRY, CAPTURED_ENTRY],
    ids=["hand-authored", "derived", "captured"],
)
def test_well_formed_entries_produce_no_violations(entry):
    assert checker.check_entry(entry) == []


def test_hand_authored_is_the_default_origin():
    assert checker.declared_origin(_entry(origin=None)) == checker.DEFAULT_ORIGIN
    assert checker.declared_origin({"origin": "captured"}) == "captured"


@pytest.mark.parametrize(
    ("entry", "third_party"),
    [(GOOD_ENTRY, False), (DERIVED_ENTRY, True), (CAPTURED_ENTRY, True)],
    ids=["hand-authored", "derived", "captured"],
)
def test_third_party_classification(entry, third_party):
    assert checker.is_third_party_derived(entry) is third_party


def test_an_unmarked_third_party_source_still_counts_as_third_party():
    """A contributor who fills in ``source`` but forgets ``origin`` is not exempt."""
    assert checker.is_third_party_derived(_entry(source="Some Upstream Project")) is True


# ---------------------------------------------------------------------------
# Licensing rules — the IXH-1.9 acceptance criterion
# ---------------------------------------------------------------------------


def test_source_without_license_is_rejected():
    """The IXH-1.9 acceptance criterion: a declared source demands a declared license."""
    assert "license-required" in _rules(_entry(license=None))
    assert "license-required" in _rules(_entry(source="Example Spec Project", license=""))


def test_license_is_required_even_when_the_source_is_missing_too():
    rules = _rules(_entry(source=None, license=None))
    assert "source-required" in rules
    assert "license-required" in rules


def test_missing_source_is_rejected():
    assert "source-required" in _rules(_entry(source=None))


def test_missing_provenance_is_rejected():
    assert "provenance-required" in _rules(_entry(provenance=None))


@pytest.mark.parametrize("license_id", sorted(checker.APPROVED_LICENSES))
def test_every_approved_license_passes(license_id):
    entry = _entry(source="Example Spec Project", license=license_id, origin="derived")
    entry["source_url"] = "https://example.com/spec.yaml"
    assert _rules(entry) == []


@pytest.mark.parametrize(
    "license_id",
    ["GPL-3.0-only", "AGPL-3.0-or-later", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "Proprietary", "unknown"],
)
def test_licenses_outside_the_allowlist_are_rejected(license_id):
    assert "license-not-approved" in _rules(_entry(license=license_id))


def test_the_allowlist_excludes_copyleft_and_non_commercial_families():
    """The allowlist is the reviewed control; keep obviously incompatible families out of it."""
    for name in checker.APPROVED_LICENSES:
        assert not name.startswith(("GPL", "AGPL", "LGPL", "MPL"))
        assert "-SA-" not in name and "-NC-" not in name


# ---------------------------------------------------------------------------
# Origin consistency
# ---------------------------------------------------------------------------


def test_unknown_origin_is_rejected():
    assert _rules(_entry(origin="borrowed")) == ["origin-unknown"]


def test_third_party_source_must_declare_a_non_default_origin():
    assert "origin-source-mismatch" in _rules(_entry(source="Example Spec Project"))


def test_derived_origin_must_not_claim_a_hand_authored_source():
    entry = _entry(origin="derived", source_url="https://example.com/spec.yaml")
    assert "origin-source-mismatch" in _rules(entry)


# ---------------------------------------------------------------------------
# Derived entries: the upstream document must be linked
# ---------------------------------------------------------------------------


def test_derived_entry_requires_a_source_url():
    entry = dict(DERIVED_ENTRY)
    entry.pop("source_url")
    assert "source-url-required" in _rules(entry)


def test_derived_entry_source_url_must_be_an_http_url():
    assert "source-url-invalid" in _rules({**DERIVED_ENTRY, "source_url": "internal-wiki/spec"})


def test_source_url_on_a_non_derived_entry_is_rejected():
    assert "source-url-misplaced" in _rules(
        _entry(source_url="https://example.com/spec.yaml")
    )


# ---------------------------------------------------------------------------
# Captured entries: the anonymization rule
# ---------------------------------------------------------------------------


def test_captured_entry_requires_an_anonymization_statement():
    entry = dict(CAPTURED_ENTRY)
    entry.pop("anonymization")
    assert "anonymization-required" in _rules(entry)


def test_anonymization_on_a_non_captured_entry_is_rejected():
    assert "anonymization-misplaced" in _rules(_entry(anonymization="Names replaced."))


def test_captured_entry_must_use_a_contributor_grantable_license():
    """A recording of a running system carries no upstream license to point at."""
    assert "capture-license-not-grantable" in _rules({**CAPTURED_ENTRY, "license": "MIT"})
    for license_id in checker.CONTRIBUTOR_GRANTABLE_LICENSES:
        assert _rules({**CAPTURED_ENTRY, "license": license_id}) == []


# ---------------------------------------------------------------------------
# Manifest-level behaviour and the CLI
# ---------------------------------------------------------------------------


def test_check_manifest_reports_every_offending_entry():
    manifest = {
        "entries": [
            GOOD_ENTRY,
            _entry(path="openapi/02-bad.yaml", license=None),
            _entry(path="openapi/03-bad.yaml", license="GPL-3.0-only"),
        ]
    }
    violations = checker.check_manifest(manifest)
    assert [(v.path, v.rule) for v in violations] == [
        ("openapi/02-bad.yaml", "license-required"),
        ("openapi/03-bad.yaml", "license-not-approved"),
    ]


def test_check_manifest_rejects_a_manifest_with_no_entries_list():
    with pytest.raises(TypeError):
        checker.check_manifest({"directories": {}})


def test_violation_rendering_is_actionable():
    (violation,) = checker.check_entry(_entry(license=None))
    assert violation.path in violation.render()
    assert violation.rule in violation.render()
    assert violation.as_dict() == {
        "path": violation.path,
        "rule": violation.rule,
        "message": violation.message,
    }


def test_cli_passes_on_the_committed_corpus(capsys):
    assert checker.main(["--repo-root", str(_REPO_ROOT)]) == 0
    assert "corpus provenance OK" in capsys.readouterr().out


def test_cli_emits_machine_readable_violations(tmp_path, capsys):
    """``--json`` prints the violation list a CI consumer can parse."""
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest["entries"] = [_entry(path="openapi/02-bad.yaml", license="GPL-3.0-only")]
    examples = tmp_path / "apiome-ui" / "examples"
    examples.mkdir(parents=True)
    (examples / "corpus.manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    assert checker.main(["--json", "--repo-root", str(tmp_path)]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert [item["rule"] for item in payload] == ["license-not-approved"]


# ---------------------------------------------------------------------------
# The committed corpus
# ---------------------------------------------------------------------------


def test_committed_corpus_has_no_provenance_violations():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    violations = checker.check_manifest(manifest)
    assert not violations, "corpus provenance violations:\n  " + "\n  ".join(
        violation.render() for violation in violations
    )


def test_provenance_fields_validate_against_the_published_schema():
    """The schema accepts the provenance vocabulary and rejects unknown origins."""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    entry_schema = schema["$defs"]["entry"]
    validator = Draft202012Validator(entry_schema)

    for entry in (GOOD_ENTRY, DERIVED_ENTRY, CAPTURED_ENTRY):
        assert not list(validator.iter_errors(entry))
    assert list(validator.iter_errors({**GOOD_ENTRY, "origin": "borrowed"}))
    assert list(validator.iter_errors({**DERIVED_ENTRY, "source_url": "not-a-url"}))


def test_schema_enforces_the_conditional_provenance_fields():
    """The published schema, not just the checker, ties the detail fields to the origin."""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema["$defs"]["entry"])

    derived_without_url = {key: value for key, value in DERIVED_ENTRY.items() if key != "source_url"}
    captured_without_statement = {
        key: value for key, value in CAPTURED_ENTRY.items() if key != "anonymization"
    }
    assert list(validator.iter_errors(derived_without_url))
    assert list(validator.iter_errors(captured_without_statement))
    # …and neither field may appear on an entry whose origin does not call for it.
    assert list(validator.iter_errors({**GOOD_ENTRY, "source_url": "https://example.com/spec.yaml"}))
    assert list(validator.iter_errors({**GOOD_ENTRY, "anonymization": "Names replaced."}))


def test_loader_exposes_provenance_fields_with_the_hand_authored_default():
    entries = load_manifest().entries
    assert all(entry.effective_origin is Origin(checker.declared_origin(entry.model_dump()))
               for entry in entries[:25])
    assert all(entry.license in checker.APPROVED_LICENSES for entry in entries)


def test_load_corpus_filters_by_origin():
    hand_authored = load_corpus(origin=Origin.HAND_AUTHORED)
    assert hand_authored, "no hand-authored entries in the corpus"
    assert hand_authored == load_corpus(origin="hand-authored")
    assert all(entry.effective_origin is Origin.HAND_AUTHORED for entry in hand_authored)
    assert len(hand_authored) + len(load_corpus(origin=Origin.DERIVED)) + len(
        load_corpus(origin=Origin.CAPTURED)
    ) == len(load_corpus())


def test_load_corpus_rejects_an_unknown_origin():
    with pytest.raises(ValueError):
        load_corpus(origin="borrowed")


def test_every_third_party_entry_declares_a_license_and_its_origin_detail():
    """The acceptance criterion, asserted against the live corpus rather than the rule engine."""
    problems = []
    for entry in load_corpus():
        if entry.effective_origin is Origin.HAND_AUTHORED:
            continue
        if entry.license not in checker.APPROVED_LICENSES:
            problems.append(f"{entry.path}: license {entry.license!r} is not approved")
        if entry.effective_origin is Origin.DERIVED and not entry.source_url:
            problems.append(f"{entry.path}: derived entry does not link its upstream document")
        if entry.effective_origin is Origin.CAPTURED and not entry.anonymization:
            problems.append(f"{entry.path}: captured entry has no anonymization statement")
    assert not problems, "third-party provenance problems:\n  " + "\n  ".join(problems)


def _load_generator():
    """Import ``scripts/generate_examples_readme.py`` as a module, by path."""
    spec = importlib.util.spec_from_file_location(
        "generate_examples_readme", _REPO_ROOT / "scripts" / "generate_examples_readme.py"
    )
    generator = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = generator
    spec.loader.exec_module(generator)
    return generator


def _render_readme(entries: List[Dict[str, Any]]) -> str:
    """Render the examples README for a synthetic one-directory manifest."""
    return _load_generator().build_readme(
        {
            "manifest_version": 1,
            "directories": {
                "openapi": {
                    "label": "OpenAPI 3.x",
                    "category": "rest-http",
                    "paradigm": "rest",
                    "marker": "`openapi: 3.x`",
                }
            },
            "entries": entries,
        }
    )


def test_readme_generator_and_checker_agree_on_the_origin_default():
    """Both stdlib scripts resolve an omitted ``origin`` the same way."""
    origin_of = _load_generator()._origin_of
    for entry in (GOOD_ENTRY, DERIVED_ENTRY, CAPTURED_ENTRY, _entry(origin=None)):
        assert origin_of(entry) == checker.declared_origin(entry)


def test_readme_summarizes_provenance_by_origin():
    readme = _render_readme([GOOD_ENTRY])
    assert "## Provenance and licensing" in readme
    assert "| `hand-authored` | 1 | `Apache-2.0` |" in readme
    assert "### Third-party and captured files" not in readme


def test_readme_lists_third_party_and_captured_files():
    """A corpus that vendors or captures anything says so in its generated index."""
    readme = _render_readme(
        [GOOD_ENTRY, {**DERIVED_ENTRY, "path": "openapi/02-derived.yaml"},
         {**CAPTURED_ENTRY, "path": "openapi/03-captured.yaml"}]
    )
    assert "### Third-party and captured files" in readme
    assert "| `openapi/02-derived.yaml` | derived | Example Spec Project | `MIT` " in readme
    assert "https://example.com/spec/openapi.yaml" in readme
    assert "| `openapi/03-captured.yaml` | captured |" in readme
    assert "auth headers removed." in readme


def test_contributor_guide_is_published_and_linked():
    """AC: the guide lives under docs/ and the examples README points at it."""
    guide = _REPO_ROOT / "docs" / "CORPUS_CONTRIBUTOR_GUIDE.md"
    assert guide.is_file(), "docs/CORPUS_CONTRIBUTOR_GUIDE.md is missing"
    text = guide.read_text(encoding="utf-8")
    for expected in ("anonymiz", "Review checklist", "APPROVED_LICENSES", "check_corpus_provenance"):
        assert expected in text, f"the contributor guide must cover {expected!r}"
    for license_id in checker.APPROVED_LICENSES:
        assert license_id in text, f"the guide must list the approved license {license_id}"

    readme = (MANIFEST_PATH.parent / "README.md").read_text(encoding="utf-8")
    assert "docs/CORPUS_CONTRIBUTOR_GUIDE.md" in readme, (
        "the examples README must link the contributor guide"
    )
