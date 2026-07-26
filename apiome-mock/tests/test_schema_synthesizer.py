"""Unit tests for schema-driven mock data synthesis (SIM-1.3, #4418)."""

from __future__ import annotations

import json
import time
from pathlib import Path

import jsonschema
import pytest
import yaml

from apiome_mock.schema_synthesizer import generate_example, parse_mock_seed, validate_value

CORPUS_DIR = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples"
EXAMPLES_DIR = CORPUS_DIR / "openapi"
CORPUS_MANIFEST = CORPUS_DIR / "corpus.manifest.json"

#: Manifest feature tag marking a fixture whose ``example`` blocks deliberately violate their
#: schemas (IXH-5.4, #5116). Synthesis honors an explicit ``example`` — that is the documented
#: behavior ``test_explicit_example_wins`` pins — so such a fixture would fail the corpus sweep
#: below by design. It is read from the manifest rather than hard-coded, so a fixture added or
#: retagged later is picked up without editing this test.
NON_CONFORMING_FEATURE = "non-conforming-examples"


def _fixtures_with_deliberately_bad_examples() -> frozenset[str]:
    """Filenames the corpus manifest tags as carrying non-conforming examples."""
    if not CORPUS_MANIFEST.is_file():  # pragma: no cover - corpus always ships with the repo
        return frozenset()
    manifest = json.loads(CORPUS_MANIFEST.read_text(encoding="utf-8"))
    return frozenset(
        Path(entry["path"]).name
        for entry in manifest.get("entries", [])
        if NON_CONFORMING_FEATURE in entry.get("features", [])
    )


def _valid(value: object, schema: dict, root: dict | None = None) -> None:
    error = validate_value(value, schema, root)
    assert error is None, error


def test_explicit_example_wins() -> None:
    assert generate_example({"type": "string", "example": "hello"}) == "hello"


def test_const_and_default_and_enum() -> None:
    assert generate_example({"const": 42}) == 42
    assert generate_example({"type": "string", "default": "d"}) == "d"
    assert generate_example({"type": "string", "enum": ["a", "b"]}) == "a"


def test_integer_respects_bounds() -> None:
    schema = {"type": "integer", "minimum": 10, "maximum": 12}
    for seed in range(20):
        value = generate_example(schema, seed=seed)
        assert 10 <= value <= 12
        assert isinstance(value, int)


def test_string_format_email_uuid_and_timestamp_heuristics() -> None:
    email = generate_example({"type": "string", "format": "email"}, field="contactEmail")
    _valid(email, {"type": "string", "format": "email"})
    assert "@" in email

    uid = generate_example({"type": "string", "format": "uuid"}, field="resourceId")
    jsonschema.validate(uid, {"type": "string", "format": "uuid"})

    created = generate_example({"type": "string", "format": "date-time"}, field="createdAt")
    updated = generate_example({"type": "string", "format": "date-time"}, field="updatedAt")
    assert created.endswith("Z")
    assert updated.endswith("Z")


def test_pattern_generation() -> None:
    schema = {"type": "string", "pattern": "^[A-Z]{2}$"}
    value = generate_example(schema, field="country", seed=3)
    assert len(value) == 2 and value.isupper()
    _valid(value, schema)


def test_object_includes_required_properties() -> None:
    schema = {
        "type": "object",
        "required": ["id", "name"],
        "properties": {
            "id": {"type": "integer"},
            "name": {"type": "string"},
            "email": {"type": "string", "format": "email"},
        },
    }
    value = generate_example(schema, seed=1)
    assert {"id", "name", "email"}.issubset(value.keys())
    _valid(value, schema)


def test_recursive_schema_terminates_under_100ms() -> None:
    root = {
        "components": {
            "schemas": {
                "Node": {
                    "type": "object",
                    "required": ["value"],
                    "properties": {
                        "value": {"type": "integer"},
                        "child": {"$ref": "#/components/schemas/Node"},
                    },
                }
            }
        }
    }
    started = time.perf_counter()
    value = generate_example({"$ref": "#/components/schemas/Node"}, root, seed=1)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert "value" in value
    assert elapsed_ms < 100


def test_deterministic_same_seed_same_output() -> None:
    schema = {
        "type": "object",
        "required": ["id", "name"],
        "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
    }
    first = generate_example(schema, seed=99)
    second = generate_example(schema, seed=99)
    assert first == second


def test_parse_mock_seed_accepts_integers_and_strings() -> None:
    assert parse_mock_seed("42") == 42
    assert parse_mock_seed("alpha") == parse_mock_seed("alpha")
    assert parse_mock_seed(None) == 0


def test_seed_query_produces_byte_identical_json() -> None:
    schema = {
        "type": "object",
        "properties": {
            "email": {"type": "string", "format": "email"},
            "id": {"type": "string", "format": "uuid"},
        },
    }
    first = json.dumps(generate_example(schema, seed=parse_mock_seed("suite"), field="payload"))
    second = json.dumps(generate_example(schema, seed=parse_mock_seed("suite"), field="payload"))
    assert first == second


def _corpus_specs_with_conforming_examples() -> list[Path]:
    """Corpus OpenAPI specs whose examples are meant to satisfy their schemas.

    Fixtures tagged `non-conforming-examples` are excluded rather than skipped: synthesis
    echoes an explicit ``example`` verbatim, so such a fixture is not a subject for this
    test at all — it is exercised instead by the IXH-5.4 example-conformance rule pack.
    """
    excluded = _fixtures_with_deliberately_bad_examples()
    return [path for path in sorted(EXAMPLES_DIR.glob("*.yaml")) if path.name not in excluded]


def test_the_corpus_exclusion_list_is_read_from_the_manifest() -> None:
    """The exclusion is manifest-driven, so a retagged fixture needs no edit here."""
    excluded = _fixtures_with_deliberately_bad_examples()

    assert excluded, "no corpus fixture is tagged `non-conforming-examples` any more"
    assert not (excluded & {path.name for path in _corpus_specs_with_conforming_examples()})


@pytest.mark.parametrize("yaml_path", _corpus_specs_with_conforming_examples(), ids=lambda p: p.name)
def test_examples_corpus_generates_schema_valid_bodies(yaml_path: Path) -> None:
    spec = yaml.safe_load(yaml_path.read_text())
    root = spec
    for name, schema in spec.get("components", {}).get("schemas", {}).items():
        value = generate_example(schema, root, seed=42, field=name)
        _valid(value, schema, root)

    for path_item in spec.get("paths", {}).values():
        if not isinstance(path_item, dict):
            continue
        for operation in path_item.values():
            if not isinstance(operation, dict):
                continue
            for response in operation.get("responses", {}).values():
                if not isinstance(response, dict):
                    continue
                for media in response.get("content", {}).values():
                    schema = media.get("schema")
                    if isinstance(schema, dict):
                        value = generate_example(schema, root, seed=42, field="response")
                        _valid(value, schema, root)
