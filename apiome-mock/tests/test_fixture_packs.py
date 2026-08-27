"""Runtime fixture pack parsing tests (#4745, PMR-2.2).

Also covers replay reporting (#4747, PMR-2.4): a pack built from reviewed proxy captures reports
its origin and redaction status wherever the runtime describes it.
"""

from __future__ import annotations

import json

from app.mock_fixture_packs import (
    PACK_FORMAT,
    canonical_fixture_pack,
    fixture_pack_digest,
)

from apiome_mock.fixture_packs import (
    merged_template_data,
    pack_summary,
    parse_fixture_packs,
)

VALID_PACK = {
    "packFormat": PACK_FORMAT,
    "packFormatVersion": 1,
    "description": "Two pets and one order.",
    "data": {"pets": [{"id": 1, "name": "Rex"}]},
    "collections": {
        "/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}],
        "/orders": [{"id": 1, "petId": 2}],
    },
}


def _settings(packs: dict) -> dict:
    return {"fixturePacks": packs}


class TestParseFixturePacks:
    def test_parses_valid_pack(self) -> None:
        packs = parse_fixture_packs(_settings({"smoke": VALID_PACK}))
        assert set(packs) == {"smoke"}
        pack = packs["smoke"]
        assert pack.name == "smoke"
        assert pack.description == "Two pets and one order."
        assert pack.format_version == 1
        assert pack.data == {"pets": [{"id": 1, "name": "Rex"}]}
        assert pack.collections["/pets"] == (
            ("1", {"id": 1, "name": "Rex"}),
            ("2", {"id": 2, "name": "Bella"}),
        )
        assert pack.resource_count == 3

    def test_accepts_json_text_settings(self) -> None:
        packs = parse_fixture_packs(json.dumps(_settings({"smoke": VALID_PACK})))
        assert set(packs) == {"smoke"}

    def test_format_defaults_when_omitted(self) -> None:
        minimal = {"collections": {"/pets": [{"id": 1}]}}
        packs = parse_fixture_packs(_settings({"minimal": minimal}))
        assert packs["minimal"].format_version == 1

    def test_skips_unsupported_format_id_and_version(self) -> None:
        wrong_format = {**VALID_PACK, "packFormat": "apiome.mock.fixture-pack/v2"}
        wrong_version = {**VALID_PACK, "packFormatVersion": 99}
        bool_version = {**VALID_PACK, "packFormatVersion": True}
        packs = parse_fixture_packs(
            _settings({"a": wrong_format, "b": wrong_version, "c": bool_version, "ok": VALID_PACK})
        )
        assert set(packs) == {"ok"}

    def test_skips_invalid_names_and_non_dict_packs(self) -> None:
        packs = parse_fixture_packs(_settings({"bad name!": VALID_PACK, "": VALID_PACK, "list": [1], "ok": VALID_PACK}))
        assert set(packs) == {"ok"}

    def test_skips_malformed_collections_and_resources(self) -> None:
        pack = {
            "collections": {
                "no-slash": [{"id": 1}],
                "/has space": [{"id": 1}],
                "/not-a-list": {"id": 1},
                "/pets": [{"id": 1}, "not-an-object", {"id": 2}],
            }
        }
        parsed = parse_fixture_packs(_settings({"p": pack}))["p"]
        assert set(parsed.collections) == {"/pets"}
        assert parsed.collections["/pets"] == (("1", {"id": 1}), ("2", {"id": 2}))

    def test_resource_ids_derive_from_id_field_or_position(self) -> None:
        pack = {
            "collections": {
                "/things": [
                    {"name": "no id"},  # -> "1" (position)
                    {"id": "abc"},  # -> "abc"
                    {"id": 7},  # -> "7"
                    {"id": True},  # bool is not an id -> "4" (position)
                ]
            }
        }
        parsed = parse_fixture_packs(_settings({"p": pack}))["p"]
        assert [rid for rid, _ in parsed.collections["/things"]] == ["1", "abc", "7", "4"]

    def test_duplicate_resource_ids_last_wins(self) -> None:
        pack = {"collections": {"/pets": [{"id": 1, "name": "first"}, {"id": 1, "name": "second"}]}}
        parsed = parse_fixture_packs(_settings({"p": pack}))["p"]
        assert parsed.collections["/pets"] == (("1", {"id": 1, "name": "second"}),)

    def test_malformed_settings_yield_empty(self) -> None:
        assert parse_fixture_packs(None) == {}
        assert parse_fixture_packs("not json{") == {}
        assert parse_fixture_packs(42) == {}
        assert parse_fixture_packs({"fixturePacks": "nope"}) == {}
        assert parse_fixture_packs({}) == {}


class TestDigests:
    def test_runtime_digest_matches_author_digest(self) -> None:
        parsed = parse_fixture_packs(_settings({"smoke": VALID_PACK}))["smoke"]
        assert parsed.digest == fixture_pack_digest(VALID_PACK)

    def test_digest_is_stable_across_cosmetic_differences(self) -> None:
        implicit = {k: v for k, v in VALID_PACK.items() if k not in ("packFormat", "packFormatVersion")}
        a = parse_fixture_packs(_settings({"smoke": VALID_PACK}))["smoke"]
        b = parse_fixture_packs(_settings({"smoke": implicit}))["smoke"]
        assert a.digest == b.digest

    def test_digest_changes_with_content(self) -> None:
        changed = {**VALID_PACK, "collections": {"/pets": [{"id": 1, "name": "Changed"}]}}
        a = parse_fixture_packs(_settings({"smoke": VALID_PACK}))["smoke"]
        b = parse_fixture_packs(_settings({"smoke": changed}))["smoke"]
        assert a.digest != b.digest

    def test_canonical_form_drops_empty_sections(self) -> None:
        canonical = canonical_fixture_pack({"description": "  ", "data": {}, "collections": {}})
        assert canonical == {"packFormat": PACK_FORMAT, "packFormatVersion": 1}


class TestTemplateDataMerge:
    def test_merges_in_sorted_name_order(self) -> None:
        packs = parse_fixture_packs(
            _settings(
                {
                    "b-pack": {"data": {"shared": "from-b", "only-b": 2}},
                    "a-pack": {"data": {"shared": "from-a", "only-a": 1}},
                }
            )
        )
        merged = merged_template_data(packs)
        assert merged == {"shared": "from-b", "only-a": 1, "only-b": 2}

    def test_empty_packs_merge_to_empty(self) -> None:
        assert merged_template_data({}) == {}


class TestPackSummary:
    def test_summary_has_shape_but_no_bodies(self) -> None:
        parsed = parse_fixture_packs(_settings({"smoke": VALID_PACK}))["smoke"]
        summary = pack_summary(parsed)
        assert summary == {
            "name": "smoke",
            "description": "Two pets and one order.",
            "digest": parsed.digest,
            "packFormat": PACK_FORMAT,
            "packFormatVersion": 1,
            "fixtures": ["pets"],
            "collections": {"/orders": 1, "/pets": 2},
            "resources": 3,
            "origin": "authored",
            "redactionStatus": "not-applicable",
        }
        assert "Rex" not in json.dumps(summary)


CAPTURED_PACK = {
    "packFormat": PACK_FORMAT,
    "packFormatVersion": 2,
    "description": "Recorded from staging.",
    "collections": {"/pets": [{"id": 7, "name": "Rex"}]},
    "provenance": {
        "source": "capture",
        "capturedFrom": ["https://api.example.com/v1"],
        "captures": 3,
        "redactions": 5,
        "approvedBy": "user-1",
        "approvedAt": "2026-08-26T19:00:00Z",
    },
}


class TestPackProvenance:
    def test_an_authored_pack_reports_its_origin_and_that_redaction_does_not_apply(self) -> None:
        pack = parse_fixture_packs(_settings({"smoke": VALID_PACK}))["smoke"]
        assert pack.origin == "authored"
        assert pack.redaction_status == "not-applicable"
        assert pack.provenance == {}

    def test_a_captured_pack_reports_where_it_came_from(self) -> None:
        pack = parse_fixture_packs(_settings({"staging": CAPTURED_PACK}))["staging"]
        assert pack.format_version == 2
        assert pack.origin == "capture"
        assert pack.redaction_status == "redacted"
        assert pack.provenance["capturedFrom"] == ["https://api.example.com/v1"]

    def test_a_capture_that_needed_no_redaction_says_clean(self) -> None:
        clean = {**CAPTURED_PACK, "provenance": {**CAPTURED_PACK["provenance"], "redactions": 0}}
        pack = parse_fixture_packs(_settings({"staging": clean}))["staging"]
        assert pack.redaction_status == "clean"

    def test_the_runtime_digest_matches_what_the_authoring_api_computed(self) -> None:
        pack = parse_fixture_packs(_settings({"staging": CAPTURED_PACK}))["staging"]
        assert pack.digest == fixture_pack_digest(CAPTURED_PACK)

    def test_the_summary_carries_origin_redaction_status_and_provenance(self) -> None:
        pack = parse_fixture_packs(_settings({"staging": CAPTURED_PACK}))["staging"]
        summary = pack_summary(pack)
        assert summary["origin"] == "capture"
        assert summary["redactionStatus"] == "redacted"
        assert summary["provenance"]["captures"] == 3
        assert summary["packFormatVersion"] == 2

    def test_an_authored_summary_omits_the_provenance_block(self) -> None:
        pack = parse_fixture_packs(_settings({"smoke": VALID_PACK}))["smoke"]
        assert "provenance" not in pack_summary(pack)

    def test_a_malformed_provenance_block_is_ignored_not_fatal(self) -> None:
        broken = {**CAPTURED_PACK, "provenance": "nope"}
        pack = parse_fixture_packs(_settings({"staging": broken}))["staging"]
        assert pack.origin == "authored"
        assert pack.collections["/pets"]

    def test_a_pack_declaring_an_unsupported_version_is_skipped_whole(self) -> None:
        future = {**CAPTURED_PACK, "packFormatVersion": 99}
        assert parse_fixture_packs(_settings({"staging": future})) == {}
