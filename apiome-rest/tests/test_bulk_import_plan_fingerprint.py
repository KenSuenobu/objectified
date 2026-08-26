"""Unit tests for plan fingerprints and drift detection (BLK-1.3, #5525).

:mod:`app.bulk_import_plan_fingerprint` is what makes verify-then-apply mean something: the
apply refuses a plan that no longer says what it said when it was reviewed. These cover the
round trip, the refusal to guess at a token this server did not mint, and every shape of
drift — including the two the selection rules change.
"""

from __future__ import annotations

import pytest

from app.bulk_import_plan_fingerprint import (
    PlanDrift,
    ReviewedItem,
    decode_plan_fingerprint,
    describe_reviewed_item,
    detect_plan_drift,
    encode_plan_fingerprint,
)

PROJECT = "660e8400-e29b-41d4-a716-446655440001"
OTHER_PROJECT = "660e8400-e29b-41d4-a716-4466554400ff"


def _item(
    key: str = "specs/orders.yaml",
    resolution: str = "append-version",
    project_id: str = PROJECT,
    version_id: str = "1.4.0",
) -> ReviewedItem:
    return ReviewedItem(
        key=key, resolution=resolution, project_id=project_id, version_id=version_id
    )


def _created(key: str, version_id: str = "1.0.0") -> ReviewedItem:
    return _item(key=key, resolution="create-project", project_id="", version_id=version_id)


# ---------------------------------------------------------------------------
# The token
# ---------------------------------------------------------------------------


def test_a_fingerprint_round_trips_the_decisions_it_carries():
    items = [_item(), _created("specs/shipping.yaml")]

    assert decode_plan_fingerprint(encode_plan_fingerprint(items)) == items


def test_the_same_plan_always_mints_the_same_token():
    items = [_item(), _created("specs/shipping.yaml")]

    assert encode_plan_fingerprint(items) == encode_plan_fingerprint(list(items))


def test_a_changed_plan_mints_a_different_token():
    before = encode_plan_fingerprint([_item(version_id="1.4.0")])
    after = encode_plan_fingerprint([_item(version_id="1.5.0")])

    assert before != after


def test_an_empty_plan_still_has_a_fingerprint():
    token = encode_plan_fingerprint([])

    assert token
    assert decode_plan_fingerprint(token) == []


@pytest.mark.parametrize(
    "token",
    [
        None,
        "",
        "not-a-token",
        "bp1.",
        "bp1.!!!!",
        "bp1.YWJj",  # valid base64, not zlib
        "bp2.eJyLVspIzcnJVyjPL8pJUQIAJmMFQQ==",  # a version this server does not read
        123,
    ],
)
def test_a_token_this_server_did_not_mint_is_unreadable_rather_than_guessed_at(token):
    assert decode_plan_fingerprint(token) is None


def test_a_token_whose_rows_are_the_wrong_shape_is_refused():
    import base64
    import json
    import zlib

    raw = json.dumps([["only", "three", "fields"]]).encode("utf-8")
    packed = base64.urlsafe_b64encode(zlib.compress(raw)).decode("ascii").rstrip("=")

    assert decode_plan_fingerprint(f"bp1.{packed}") is None


# ---------------------------------------------------------------------------
# Drift
# ---------------------------------------------------------------------------


def test_an_unchanged_plan_has_no_drift():
    items = [_item(), _created("specs/shipping.yaml")]

    assert detect_plan_drift(items, items) == []


def test_a_resolution_that_changed_is_named():
    reviewed = [_created("specs/orders.yaml")]
    current = [_item(key="specs/orders.yaml")]

    (drift,) = detect_plan_drift(reviewed, current)

    assert isinstance(drift, PlanDrift)
    assert drift.key == "specs/orders.yaml"
    assert drift.change == "resolution"
    assert "create-project" in drift.reviewed
    assert "append-version" in drift.current
    assert "Re-plan" in drift.detail


def test_a_target_project_that_changed_is_named():
    (drift,) = detect_plan_drift([_item()], [_item(project_id=OTHER_PROJECT)])

    assert drift.change == "target"
    assert OTHER_PROJECT in drift.current


def test_a_version_that_was_taken_in_the_meantime_is_named():
    (drift,) = detect_plan_drift([_item(version_id="1.4.0")], [_item(version_id="1.5.0")])

    assert drift.change == "version"
    assert "1.4.0" in drift.reviewed
    assert "1.5.0" in drift.current


def test_an_item_that_vanished_from_the_plan_is_drift():
    (drift,) = detect_plan_drift([_item(), _created("gone.yaml")], [_item()])

    assert drift.key == "gone.yaml"
    assert drift.change == "item-missing"
    assert drift.current == "not in the plan"


def test_an_item_that_appeared_in_the_plan_is_drift_for_a_whole_batch():
    (drift,) = detect_plan_drift([_item()], [_item(), _created("new.yaml")])

    assert drift.key == "new.yaml"
    assert drift.change == "item-added"
    assert drift.reviewed == "not in the plan"


def test_selected_keys_narrow_the_comparison_to_what_the_batch_will_touch():
    reviewed = [_item(), _created("specs/shipping.yaml")]
    current = [_item(), _created("specs/shipping.yaml", version_id="2.0.0")]

    # The batch is only importing the first item, so the second one moving cannot make this
    # apply wrong.
    assert detect_plan_drift(reviewed, current, keys=["specs/orders.yaml"]) == []
    assert [d.key for d in detect_plan_drift(reviewed, current)] == ["specs/shipping.yaml"]


def test_a_selection_still_catches_drift_in_a_selected_item():
    reviewed = [_item(version_id="1.4.0"), _created("specs/shipping.yaml")]
    current = [_item(version_id="1.9.0"), _created("specs/shipping.yaml")]

    (drift,) = detect_plan_drift(reviewed, current, keys=["specs/orders.yaml"])

    assert drift.change == "version"


def test_a_selected_key_in_neither_plan_is_not_drift():
    """An unknown key is already a per-item failure; it must not fail the whole batch."""
    assert detect_plan_drift([_item()], [_item()], keys=["nope.yaml"]) == []


def test_a_selected_key_repeated_is_reported_once():
    reviewed = [_item(version_id="1.4.0")]
    current = [_item(version_id="1.5.0")]

    drifts = detect_plan_drift(
        reviewed, current, keys=["specs/orders.yaml", "specs/orders.yaml"]
    )

    assert len(drifts) == 1


def test_drift_rows_carry_everything_a_client_renders():
    (drift,) = detect_plan_drift([_item(version_id="1.4.0")], [_item(version_id="1.5.0")])

    assert set(drift.as_dict()) == {"key", "change", "reviewed", "current", "detail"}


def test_describe_reviewed_item_reads_as_a_sentence_fragment():
    assert describe_reviewed_item(None) == "not in the plan"
    assert describe_reviewed_item(_item()) == (
        f"append-version onto project {PROJECT} at 1.4.0"
    )
    assert describe_reviewed_item(_created("x.yaml")) == "create-project at 1.0.0"
