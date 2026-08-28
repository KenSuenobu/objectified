"""Unit tests for template fixture data loading (#4744, PMR-2.1)."""

from __future__ import annotations

import base64

from apiome_mock.fixture_data import MAX_FIXTURE_BYTES, decode_bundle_fixtures


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def test_decode_bundle_fixtures_parses_json_and_keeps_text() -> None:
    entries = (
        {"name": "pets.json", "mediaType": "application/json"},
        {"name": "notes.txt", "mediaType": "text/plain"},
    )
    payloads = {
        "pets.json": _b64('[{"name": "Rex"}]'),
        "notes.txt": _b64("hello"),
    }
    fixtures = decode_bundle_fixtures(entries, payloads)
    assert fixtures == {"pets.json": [{"name": "Rex"}], "notes.txt": "hello"}


def test_decode_bundle_fixtures_skips_bad_entries() -> None:
    entries = (
        {"name": "missing.json", "mediaType": "application/json"},
        {"name": "bad-b64.json", "mediaType": "application/json"},
        {"name": "bad-json.json", "mediaType": "application/json"},
        {"name": "too-big.txt", "mediaType": "text/plain"},
        {"name": "", "mediaType": "text/plain"},
        {"mediaType": "text/plain"},
        {"name": "ok.json", "mediaType": "application/json"},
    )
    payloads = {
        "bad-b64.json": "!!! not base64 !!!",
        "bad-json.json": _b64("{nope"),
        "too-big.txt": base64.b64encode(b"x" * (MAX_FIXTURE_BYTES + 1)).decode("ascii"),
        "ok.json": _b64('{"a": 1}'),
    }
    assert decode_bundle_fixtures(entries, payloads) == {"ok.json": {"a": 1}}


def test_decode_bundle_fixtures_handles_missing_payload_map() -> None:
    entries = ({"name": "pets.json", "mediaType": "application/json"},)
    assert decode_bundle_fixtures(entries, None) == {}
    assert decode_bundle_fixtures(entries, "nope") == {}
