"""Fixture pack format tests: validation, canonicalization, digests (#4745, PMR-2.2).

Also covers the optional ``provenance`` block added for guarded proxy capture (#4747, PMR-2.4),
including the rule that keeps every pre-existing v1 pack digesting exactly as it did before.
"""

from __future__ import annotations

import json

from app.mock_fixture_packs import (
    MAX_COLLECTIONS_PER_PACK,
    MAX_PACKS,
    MAX_PROVENANCE_UPSTREAMS,
    MAX_RESOURCES_PER_COLLECTION,
    PACK_FORMAT,
    PACK_FORMAT_VERSION,
    PACK_FORMAT_VERSION_PROVENANCE,
    canonical_fixture_pack,
    canonical_pack_provenance,
    collection_resource_id,
    fixture_pack_digest,
    fixture_pack_digests,
    fixture_packs_from_storage,
    fixture_packs_to_storage,
    merged_pack_data,
    pack_provenance,
    validate_fixture_packs,
)

VALID_PACK = {
    "description": "Two pets.",
    "data": {"pets": [{"id": 1, "name": "Rex"}]},
    "collections": {"/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}]},
}


class TestValidation:
    def test_valid_pack_passes(self) -> None:
        assert validate_fixture_packs({"smoke": VALID_PACK}) == []

    def test_explicit_format_and_version_pass(self) -> None:
        pack = {**VALID_PACK, "packFormat": PACK_FORMAT, "packFormatVersion": PACK_FORMAT_VERSION}
        assert validate_fixture_packs({"smoke": pack}) == []

    def test_non_mapping_input_is_one_error(self) -> None:
        assert validate_fixture_packs([1, 2]) == ["Fixture packs must be an object keyed by pack name."]

    def test_pack_count_cap(self) -> None:
        packs = {f"pack-{i}": dict(VALID_PACK) for i in range(MAX_PACKS + 1)}
        errors = validate_fixture_packs(packs)
        assert any(f"At most {MAX_PACKS}" in error for error in errors)

    def test_bad_pack_names_rejected(self) -> None:
        for name in ("", "bad name", "-leading", "x" * 65):
            errors = validate_fixture_packs({name: VALID_PACK})
            assert errors, name
            assert "invalid" in errors[0]

    def test_non_object_pack_rejected(self) -> None:
        assert validate_fixture_packs({"smoke": [1]}) == ["Pack 'smoke' must be a JSON object."]

    def test_unknown_keys_rejected(self) -> None:
        errors = validate_fixture_packs({"smoke": {**VALID_PACK, "collecitons": {}}})
        assert any("unknown keys: collecitons" in error for error in errors)

    def test_wrong_format_and_version_rejected(self) -> None:
        wrong_format = {**VALID_PACK, "packFormat": "apiome.mock.fixture-pack/v9"}
        wrong_version = {**VALID_PACK, "packFormatVersion": 9}
        bool_version = {**VALID_PACK, "packFormatVersion": True}
        assert any("packFormat" in e for e in validate_fixture_packs({"a": wrong_format}))
        assert any("packFormatVersion" in e for e in validate_fixture_packs({"a": wrong_version}))
        assert any("packFormatVersion" in e for e in validate_fixture_packs({"a": bool_version}))

    def test_description_rules(self) -> None:
        assert any(
            "description" in e
            for e in validate_fixture_packs({"a": {"description": 42}})
        )
        assert any(
            "description" in e
            for e in validate_fixture_packs({"a": {"description": "x" * 501}})
        )

    def test_data_rules(self) -> None:
        assert any("data" in e for e in validate_fixture_packs({"a": {"data": [1]}}))
        errors = validate_fixture_packs({"a": {"data": {"bad name": 1}}})
        assert any("fixture data name" in e for e in errors)

    def test_collection_path_rules(self) -> None:
        for path in ("pets", "/has space", "/" + "x" * 200):
            errors = validate_fixture_packs({"a": {"collections": {path: []}}})
            assert errors, path

    def test_collection_shape_rules(self) -> None:
        assert any(
            "list of resource objects" in e
            for e in validate_fixture_packs({"a": {"collections": {"/pets": {"id": 1}}}})
        )
        assert any(
            "JSON object" in e
            for e in validate_fixture_packs({"a": {"collections": {"/pets": ["nope"]}}})
        )

    def test_collection_count_caps(self) -> None:
        too_many_collections = {
            "collections": {f"/c{i}": [] for i in range(MAX_COLLECTIONS_PER_PACK + 1)}
        }
        assert any(
            "collections per pack" in e
            for e in validate_fixture_packs({"a": too_many_collections})
        )
        too_many_resources = {
            "collections": {"/pets": [{"id": i} for i in range(MAX_RESOURCES_PER_COLLECTION + 1)]}
        }
        assert any(
            "resources per collection" in e
            for e in validate_fixture_packs({"a": too_many_resources})
        )

    def test_resource_id_rules(self) -> None:
        bad_id = {"collections": {"/pets": [{"id": 1.5}]}}
        assert any("'id' must be" in e for e in validate_fixture_packs({"a": bad_id}))
        bool_id = {"collections": {"/pets": [{"id": True}]}}
        assert any("'id' must be" in e for e in validate_fixture_packs({"a": bool_id}))
        duplicate = {"collections": {"/pets": [{"id": 1}, {"id": "1"}]}}
        assert any("duplicate resource id" in e for e in validate_fixture_packs({"a": duplicate}))

    def test_positional_and_explicit_ids_can_collide(self) -> None:
        # First resource has no id -> positional "1"; second declares id 1 -> duplicate.
        pack = {"collections": {"/pets": [{"name": "a"}, {"id": 1}]}}
        assert any("duplicate resource id" in e for e in validate_fixture_packs({"a": pack}))

    def test_oversized_pack_rejected(self) -> None:
        big = {"collections": {"/pets": [{"id": 1, "blob": "x" * 140_000}]}}
        assert any("byte size limit" in e for e in validate_fixture_packs({"a": big}))

    def test_all_errors_are_reported_together(self) -> None:
        packs = {
            "bad name": VALID_PACK,
            "broken": {"packFormatVersion": 9, "extra": 1},
        }
        errors = validate_fixture_packs(packs)
        assert len(errors) >= 3


class TestResourceIds:
    def test_id_field_wins(self) -> None:
        assert collection_resource_id({"id": 7}, 0) == "7"
        assert collection_resource_id({"id": "abc"}, 0) == "abc"

    def test_position_fallback(self) -> None:
        assert collection_resource_id({}, 0) == "1"
        assert collection_resource_id({"id": True}, 2) == "3"
        assert collection_resource_id({"id": "   "}, 4) == "5"


class TestCanonicalizationAndDigests:
    def test_canonical_injects_format_and_drops_empties(self) -> None:
        assert canonical_fixture_pack({"data": {}, "collections": {}, "description": ""}) == {
            "packFormat": PACK_FORMAT,
            "packFormatVersion": PACK_FORMAT_VERSION,
        }

    def test_digest_is_stable_and_cosmetic_insensitive(self) -> None:
        explicit = {**VALID_PACK, "packFormat": PACK_FORMAT, "packFormatVersion": PACK_FORMAT_VERSION}
        assert fixture_pack_digest(VALID_PACK) == fixture_pack_digest(explicit)
        assert fixture_pack_digest(VALID_PACK).startswith("sha256:")

    def test_digest_changes_with_content(self) -> None:
        changed = {**VALID_PACK, "description": "Different."}
        assert fixture_pack_digest(VALID_PACK) != fixture_pack_digest(changed)

    def test_digests_mapping(self) -> None:
        digests = fixture_pack_digests({"a": VALID_PACK, "b": VALID_PACK})
        assert digests == {"a": fixture_pack_digest(VALID_PACK), "b": fixture_pack_digest(VALID_PACK)}


class TestStorageHelpers:
    def test_round_trip(self) -> None:
        storage = fixture_packs_to_storage({"smoke": VALID_PACK})
        assert storage["smoke"]["packFormat"] == PACK_FORMAT
        restored = fixture_packs_from_storage({"fixturePacks": storage})
        assert restored == storage

    def test_from_storage_accepts_json_text_and_garbage(self) -> None:
        assert fixture_packs_from_storage(json.dumps({"fixturePacks": {"a": {}}})) == {"a": {}}
        assert fixture_packs_from_storage(None) == {}
        assert fixture_packs_from_storage("{broken") == {}
        assert fixture_packs_from_storage({"fixturePacks": [1]}) == {}
        assert fixture_packs_from_storage({"fixturePacks": {1: {}}}) == {}


class TestMergedPackData:
    def test_sorted_name_order_later_wins(self) -> None:
        packs = {
            "b": {"data": {"shared": "b", "only-b": 1}},
            "a": {"data": {"shared": "a"}},
        }
        assert merged_pack_data(packs) == {"shared": "b", "only-b": 1}

    def test_ignores_malformed_entries(self) -> None:
        packs = {"a": "nope", "b": {"data": [1]}, "c": {"data": {"": 1, "ok": 2}}}
        assert merged_pack_data(packs) == {"ok": 2}


CAPTURE_PROVENANCE = {
    "source": "capture",
    "capturedFrom": ["https://api.example.com/v1"],
    "captures": 2,
    "redactions": 5,
    "approvedBy": "user-1",
    "approvedAt": "2026-08-26T19:00:00Z",
}


class TestProvenance:
    def test_a_pack_without_provenance_still_declares_v1(self) -> None:
        canonical = canonical_fixture_pack(VALID_PACK)
        assert canonical["packFormatVersion"] == PACK_FORMAT_VERSION
        assert "provenance" not in canonical

    def test_adding_provenance_did_not_move_existing_digests(self) -> None:
        """The version-is-the-lowest-that-fits rule: v1 packs digest exactly as before."""
        assert fixture_pack_digest(VALID_PACK) == fixture_pack_digest(
            {**VALID_PACK, "packFormatVersion": PACK_FORMAT_VERSION}
        )

    def test_a_pack_carrying_provenance_declares_v2(self) -> None:
        canonical = canonical_fixture_pack({**VALID_PACK, "provenance": CAPTURE_PROVENANCE})
        assert canonical["packFormatVersion"] == PACK_FORMAT_VERSION_PROVENANCE
        assert canonical["provenance"]["source"] == "capture"

    def test_provenance_changes_the_digest(self) -> None:
        assert fixture_pack_digest(VALID_PACK) != fixture_pack_digest(
            {**VALID_PACK, "provenance": CAPTURE_PROVENANCE}
        )

    def test_a_bare_authored_block_says_nothing_and_is_dropped(self) -> None:
        pack = {**VALID_PACK, "provenance": {"source": "authored"}}
        assert canonical_fixture_pack(pack)["packFormatVersion"] == PACK_FORMAT_VERSION
        assert fixture_pack_digest(pack) == fixture_pack_digest(VALID_PACK)

    def test_captured_from_is_sorted_and_deduplicated(self) -> None:
        block = canonical_pack_provenance(
            {"source": "capture", "capturedFrom": ["https://b.example.com", "https://a.example.com", "https://b.example.com"]}
        )
        assert block["capturedFrom"] == ["https://a.example.com", "https://b.example.com"]

    def test_pack_provenance_reads_the_block_back(self) -> None:
        assert pack_provenance({"provenance": CAPTURE_PROVENANCE})["captures"] == 2
        assert pack_provenance(VALID_PACK) == {}

    def test_a_valid_provenance_block_passes_validation(self) -> None:
        assert validate_fixture_packs({"p": {**VALID_PACK, "provenance": CAPTURE_PROVENANCE}}) == []

    def test_unknown_provenance_keys_are_rejected(self) -> None:
        errors = validate_fixture_packs({"p": {**VALID_PACK, "provenance": {"source": "capture", "vibe": "good"}}})
        assert any("unknown keys" in error for error in errors)

    def test_an_unknown_source_is_rejected(self) -> None:
        errors = validate_fixture_packs({"p": {**VALID_PACK, "provenance": {"source": "divination"}}})
        assert any("source" in error for error in errors)

    def test_counts_must_be_non_negative_integers(self) -> None:
        errors = validate_fixture_packs({"p": {**VALID_PACK, "provenance": {"source": "capture", "captures": -1}}})
        assert any("non-negative integer" in error for error in errors)

    def test_too_many_upstreams_is_rejected(self) -> None:
        block = {
            "source": "capture",
            "capturedFrom": [f"https://a{i}.example.com" for i in range(MAX_PROVENANCE_UPSTREAMS + 1)],
        }
        errors = validate_fixture_packs({"p": {**VALID_PACK, "provenance": block}})
        assert any(str(MAX_PROVENANCE_UPSTREAMS) in error for error in errors)

    def test_provenance_survives_a_storage_round_trip(self) -> None:
        stored = fixture_packs_to_storage({"p": {**VALID_PACK, "provenance": CAPTURE_PROVENANCE}})
        assert stored["p"]["provenance"]["redactions"] == 5
        assert fixture_packs_from_storage({"fixturePacks": stored})["p"]["provenance"]["source"] == "capture"
