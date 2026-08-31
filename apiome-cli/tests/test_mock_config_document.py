"""Tests for the mock configuration document and preview request builder (#5530, MSC-1.4)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apiome_cli.mock_config import (
    CONFIG_FORMAT,
    SECTION_KEYS,
    MockConfigError,
    build_document,
    diff_documents,
    document_sections,
    format_errors,
    locate_errors,
    parse_document,
    read_document,
    serialize_document,
)
from apiome_cli.mock_preview_request import (
    PreviewRequestError,
    build_preview_request,
    parse_body,
    parse_headers,
    parse_query,
)

_CORRELATION = {
    "mode": "inferred",
    "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}},
}
_SCENARIOS = {
    "outage": {
        "description": "Everything is on fire",
        "operations": {"GET /pets": {"responses": [{"status": 503}]}},
        "chaos": None,
    }
}
_PACKS = {"seed": {"packFormat": "apiome.mock.fixture-pack/v1", "data": {"tenant": "acme"}}}


def _document(**overrides: object) -> dict:
    base = {
        "correlation": _CORRELATION,
        "scenarios": _SCENARIOS,
        "chaos": {"default": {"delayMs": 100}},
        "fixture_packs": _PACKS,
    }
    base.update(overrides)  # type: ignore[arg-type]
    return build_document(**base)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- shape


def test_a_document_always_carries_every_section() -> None:
    document = build_document(correlation=None, scenarios={}, chaos=None, fixture_packs={})
    assert set(SECTION_KEYS) <= set(document)
    assert document["configFormat"] == CONFIG_FORMAT
    assert document["scenarios"] == {} and document["correlation"] is None


def test_serialization_is_byte_stable_regardless_of_key_order() -> None:
    """Pull output must not depend on the order a mapping happened to be built in."""
    one = build_document(
        correlation=_CORRELATION,
        scenarios={"b": {"description": "b"}, "a": {"description": "a"}},
        chaos=None,
        fixture_packs=_PACKS,
    )
    other = build_document(
        fixture_packs=_PACKS,
        chaos=None,
        scenarios={"a": {"description": "a"}, "b": {"description": "b"}},
        correlation=dict(reversed(list(_CORRELATION.items()))),
    )
    assert serialize_document(one) == serialize_document(other)


def test_serialization_ends_with_a_newline() -> None:
    assert serialize_document(_document()).endswith("}\n")


def test_pull_then_parse_round_trips_unchanged() -> None:
    document = _document()
    assert parse_document(serialize_document(document), source="x") == document


def test_document_sections_are_the_settings_keys() -> None:
    sections = document_sections(_document())
    assert sorted(sections) == sorted(SECTION_KEYS)
    assert sections["correlation"] == _CORRELATION


# --------------------------------------------------------------------------- active scenario


def test_the_active_scenario_is_a_section_of_its_own() -> None:
    """What a mock *defaults to* has to travel with a promoted configuration (#5531, MSC-2.1)."""
    document = _document(active_scenario="outage")
    assert document["activeScenario"] == "outage"
    assert document_sections(document)["activeScenario"] == "outage"


def test_the_active_scenario_round_trips_through_the_file() -> None:
    document = _document(active_scenario="outage")
    assert parse_document(serialize_document(document), source="x") == document


def test_a_document_without_an_active_scenario_carries_it_as_null() -> None:
    """"Absent" and "cleared" must be the same thing for a document that replaces wholesale."""
    document = _document()
    assert document["activeScenario"] is None
    assert '"activeScenario": null' in serialize_document(document)


def test_parsing_rejects_a_non_string_active_scenario() -> None:
    with pytest.raises(MockConfigError, match="'activeScenario' must be a scenario name"):
        parse_document(
            json.dumps({"configFormat": CONFIG_FORMAT, "activeScenario": {"name": "outage"}}),
            source="mock.json",
        )


def test_changing_the_active_scenario_is_a_whole_section_change() -> None:
    result = diff_documents(_document(active_scenario="outage"), _document(active_scenario="calm"))
    assert [(c.section, c.name, c.change) for c in result.changes] == [
        ("activeScenario", None, "modified")
    ]
    assert result.changes[0].path == "activeScenario"


def test_setting_and_clearing_the_active_scenario_read_as_added_and_removed() -> None:
    added = diff_documents(_document(), _document(active_scenario="outage"))
    removed = diff_documents(_document(active_scenario="outage"), _document())
    assert [c.change for c in added.changes] == ["added"]
    assert [c.change for c in removed.changes] == ["removed"]


# --------------------------------------------------------------------------- parsing


def test_parsing_requires_the_format_marker() -> None:
    with pytest.raises(MockConfigError, match="configFormat"):
        parse_document(json.dumps({"scenarios": {}}), source="mock.json")


def test_parsing_rejects_an_unknown_format() -> None:
    with pytest.raises(MockConfigError, match="apiome.mock.other"):
        parse_document(
            json.dumps({"configFormat": "apiome.mock.other/v1"}),
            source="mock.json",
        )


def test_parsing_rejects_an_unknown_format_version() -> None:
    with pytest.raises(MockConfigError, match="configFormatVersion"):
        parse_document(
            json.dumps({"configFormat": CONFIG_FORMAT, "configFormatVersion": 99}),
            source="mock.json",
        )


def test_parsing_rejects_unknown_keys() -> None:
    """A typo'd section would otherwise be dropped silently by a whole-document push."""
    with pytest.raises(MockConfigError, match="fixture_packs"):
        parse_document(
            json.dumps({"configFormat": CONFIG_FORMAT, "fixture_packs": {}}),
            source="mock.json",
        )


def test_parsing_rejects_a_mistyped_section() -> None:
    with pytest.raises(MockConfigError, match="'scenarios' must be an object"):
        parse_document(
            json.dumps({"configFormat": CONFIG_FORMAT, "scenarios": []}),
            source="mock.json",
        )


def test_parsing_rejects_non_json_and_non_objects() -> None:
    with pytest.raises(MockConfigError, match="not valid JSON"):
        parse_document("{", source="mock.json")
    with pytest.raises(MockConfigError, match="must contain a JSON object"):
        parse_document("[]", source="mock.json")


def test_an_omitted_section_reads_as_empty() -> None:
    """A whole-document push clears what the document does not carry."""
    document = parse_document(json.dumps({"configFormat": CONFIG_FORMAT}), source="mock.json")
    assert document["scenarios"] == {}
    assert document["fixturePacks"] == {}
    assert document["correlation"] is None
    assert document["chaos"] is None
    assert document["activeScenario"] is None


def test_read_document_reports_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(MockConfigError, match="Cannot read"):
        read_document(tmp_path / "absent.json")


def test_read_document_parses_a_written_file(tmp_path: Path) -> None:
    path = tmp_path / "mock-config.json"
    path.write_text(serialize_document(_document()), encoding="utf-8")
    assert read_document(path) == _document()


# --------------------------------------------------------------------------- diff


def test_an_unchanged_document_reports_no_changes() -> None:
    result = diff_documents(_document(), _document())
    assert result.changed is False
    assert result.changes == ()
    assert result.unified == ""


def test_named_sections_are_compared_entry_by_entry() -> None:
    local = _document(
        scenarios={
            "outage": {"description": "Reworded", "operations": {}, "chaos": None},
            "maintenance": {"description": "New", "operations": {}, "chaos": None},
        }
    )
    result = diff_documents(_document(), local)
    assert [(c.section, c.name, c.change) for c in result.changes] == [
        ("scenarios", "maintenance", "added"),
        ("scenarios", "outage", "modified"),
    ]
    assert result.changes[0].path == 'scenarios["maintenance"]'


def test_a_removed_scenario_is_reported() -> None:
    result = diff_documents(_document(), _document(scenarios={}))
    assert [(c.name, c.change) for c in result.changes] == [("outage", "removed")]


def test_whole_sections_report_added_removed_and_modified() -> None:
    assert diff_documents(_document(correlation=None), _document()).changes[0].change == "added"
    assert diff_documents(_document(), _document(correlation=None)).changes[0].change == "removed"
    modified = diff_documents(_document(), _document(correlation={"mode": "off"}))
    assert modified.changes[0].change == "modified"
    assert modified.changes[0].path == "correlation"


def test_a_change_carries_a_unified_diff_naming_both_sides() -> None:
    result = diff_documents(
        _document(),
        _document(scenarios={}),
        remote_label="payments-api 1.0.0",
        local_label="mock-config.json",
    )
    assert "--- payments-api 1.0.0" in result.unified
    assert "+++ mock-config.json" in result.unified


def test_diff_json_shape_is_stable() -> None:
    payload = diff_documents(_document(), _document(chaos=None)).as_dict()
    assert payload["changed"] is True
    assert payload["changes"] == [
        {"section": "chaos", "name": None, "path": "chaos", "change": "removed"}
    ]
    assert payload["diff"].startswith("---")


# --------------------------------------------------------------------------- error placement


@pytest.mark.parametrize(
    ("sentence", "path", "message"),
    [
        (
            "Correlation, operation 'GET /pets/{petId}', pointer '/id': template is malformed.",
            'correlation.operations["GET /pets/{petId}"]["/id"]',
            "template is malformed.",
        ),
        (
            "Correlation, operation 'GET /nope': no operation GET /nope exists in this version's spec.",
            'correlation.operations["GET /nope"]',
            "no operation GET /nope exists in this version's spec.",
        ),
        (
            "Correlation: mode 'off' cannot carry operation bindings — they would never run.",
            "correlation",
            "mode 'off' cannot carry operation bindings — they would never run.",
        ),
        (
            "Scenario 'outage', operation 'GET /pets': status 503 is not defined for GET /pets.",
            'scenarios["outage"].operations["GET /pets"]',
            "status 503 is not defined for GET /pets.",
        ),
        (
            "Scenario 'outage' chaos, operation 'GET /nope': operation keys must look like 'GET /pets/{petId}'.",
            'scenarios["outage"].chaos.operations["GET /nope"]',
            "operation keys must look like 'GET /pets/{petId}'.",
        ),
        (
            "Scenario 'outage': at most 50 operation overrides are allowed.",
            'scenarios["outage"]',
            "at most 50 operation overrides are allowed.",
        ),
        (
            "Scenario name 'bad name' is invalid: use 1-64 characters from [A-Za-z0-9._-].",
            'scenarios["bad name"]',
            "is invalid: use 1-64 characters from [A-Za-z0-9._-].",
        ),
        (
            "Pack 'seed' collection '/pets'[2]: each resource must be a JSON object.",
            'fixturePacks["seed"].collections["/pets"][2]',
            "each resource must be a JSON object.",
        ),
        (
            "Pack 'seed' collection '/pets': must be a list of resource objects.",
            'fixturePacks["seed"].collections["/pets"]',
            "must be a list of resource objects.",
        ),
        (
            "Pack 'seed' has unknown keys: colour.",
            'fixturePacks["seed"]',
            "has unknown keys: colour.",
        ),
        (
            "Pack 'seed': data must be an object of fixture values by name.",
            'fixturePacks["seed"]',
            "data must be an object of fixture values by name.",
        ),
        (
            "Chaos, operation 'GET /nope': no operation GET /nope exists in this version's spec.",
            'chaos.operations["GET /nope"]',
            "no operation GET /nope exists in this version's spec.",
        ),
        (
            "At most 50 scenarios are allowed per version.",
            "scenarios",
            "At most 50 scenarios are allowed per version.",
        ),
        (
            "activeScenario 'gone' is not one of this version's scenarios ('outage').",
            "activeScenario",
            "activeScenario 'gone' is not one of this version's scenarios ('outage').",
        ),
        (
            "At most 20 fixture packs are allowed per version.",
            "fixturePacks",
            "At most 20 fixture packs are allowed per version.",
        ),
    ],
)
def test_a_validation_sentence_lands_at_its_document_path(
    sentence: str, path: str, message: str
) -> None:
    (located,) = locate_errors([sentence])
    assert located.path == path
    assert located.message == message


def test_an_unrecognised_sentence_is_reported_verbatim_rather_than_guessed_at() -> None:
    (located,) = locate_errors(["Something entirely new went wrong."])
    assert located.path is None
    assert located.message == "Something entirely new went wrong."


def test_a_structured_error_entry_is_rendered_rather_than_dropped() -> None:
    (located,) = locate_errors([{"loc": ["body", "packs"], "msg": "field required"}])
    assert located.path is None
    assert "field required" in located.message


def test_format_errors_names_the_source_and_every_path() -> None:
    lines = format_errors(locate_errors(["Correlation: bad."]), source="mock-config.json")
    assert lines[0] == "mock-config.json was rejected (1 problem):"
    assert lines[1].strip() == "correlation"


# --------------------------------------------------------------------------- request options


def test_headers_are_parsed_from_name_colon_value() -> None:
    assert parse_headers(["Accept: application/json", "X-Mock-Scenario:outage"]) == {
        "Accept": "application/json",
        "X-Mock-Scenario": "outage",
    }


def test_a_header_without_a_separator_is_a_usage_error() -> None:
    with pytest.raises(PreviewRequestError, match="Name: value"):
        parse_headers(["Accept"])


def test_a_repeated_query_name_becomes_a_list() -> None:
    assert parse_query(["tag=cat", "tag=dog", "limit=5"]) == {
        "tag": ["cat", "dog"],
        "limit": "5",
    }


def test_a_query_without_a_separator_is_a_usage_error() -> None:
    with pytest.raises(PreviewRequestError, match="name=value"):
        parse_query(["limit"])


def test_a_json_body_is_sent_structured_and_anything_else_as_text() -> None:
    assert parse_body('{"name": "Milo"}') == {"name": "Milo"}
    assert parse_body("plain text") == "plain text"
    assert parse_body(None) is None


def test_a_body_can_be_read_from_a_file(tmp_path: Path) -> None:
    path = tmp_path / "body.json"
    path.write_text('{"name": "Milo"}', encoding="utf-8")
    assert parse_body(f"@{path}") == {"name": "Milo"}


def test_a_missing_body_file_is_a_usage_error(tmp_path: Path) -> None:
    with pytest.raises(PreviewRequestError, match="Cannot read --body file"):
        parse_body(f"@{tmp_path / 'absent.json'}")


def test_the_request_carries_only_what_the_caller_set() -> None:
    request = build_preview_request(
        method="get",
        path="/pets",
        headers=[],
        query=[],
        body=None,
        scenario=None,
        seed=None,
    )
    assert request == {"method": "GET", "path": "/pets"}


def test_the_request_carries_every_option_that_was_set() -> None:
    request = build_preview_request(
        method="post",
        path="/pets",
        headers=["Accept: application/json"],
        query=["tag=cat"],
        body='{"name": "Milo"}',
        scenario="outage",
        seed=7,
    )
    assert request == {
        "method": "POST",
        "path": "/pets",
        "headers": {"Accept": "application/json"},
        "query": {"tag": "cat"},
        "body": {"name": "Milo"},
        "scenario": "outage",
        "seed": 7,
    }
