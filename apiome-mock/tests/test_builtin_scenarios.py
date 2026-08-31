"""The four scenario names every mock keeps resolving after the fold (#5532, MSC-2.2)."""

from __future__ import annotations

from typing import Any

from app.mock_routes import BUILTIN_SCENARIO_NAMES as REST_BUILTIN_SCENARIO_NAMES

from apiome_mock.builtin_scenarios import (
    BUILTIN_SCENARIO_NAMES,
    BUILTIN_SCENARIOS,
    DEFAULT_SCENARIO_NAME,
    SLOW_SCENARIO_DELAY_MS,
    merge_builtin_scenarios,
)
from apiome_mock.chaos import effective_knobs
from apiome_mock.scenarios import WILDCARD_OPERATION_KEY, parse_scenarios


def test_the_retired_engines_four_names_are_all_defined() -> None:
    assert BUILTIN_SCENARIO_NAMES == {"happy-path", "server-error", "not-found", "slow"}
    assert DEFAULT_SCENARIO_NAME == "happy-path"


def test_the_control_planes_mirrored_list_agrees_with_the_runtime() -> None:
    """apiome-rest cannot import this package, so it mirrors these names to list and validate them.

    Only this test can see both sides, which is why the check lives here rather than there.
    """
    assert set(REST_BUILTIN_SCENARIO_NAMES) == BUILTIN_SCENARIO_NAMES
    assert list(REST_BUILTIN_SCENARIO_NAMES) == list(BUILTIN_SCENARIOS)


def test_happy_path_declares_no_overrides() -> None:
    """It was the *absence* of overrides in the old engine, which is what made it the default."""
    assert parse_scenarios({})["happy-path"].operations == {}


def test_the_error_builtins_carry_their_original_bodies_verbatim() -> None:
    """A client asserting on `error.code` must keep passing across the fold."""
    scenarios = parse_scenarios({})
    server_error = scenarios["server-error"].override_for("GET /anything")
    not_found = scenarios["not-found"].override_for("GET /anything")

    assert server_error is not None and not_found is not None
    assert server_error.responses[0].status == 500
    assert server_error.responses[0].body == {"error": {"code": "internal_error", "message": "Simulated server error."}}
    assert not_found.responses[0].status == 404
    assert not_found.responses[0].body == {"error": {"code": "not_found", "message": "Simulated not-found."}}


def test_slow_is_expressed_as_scenario_scoped_chaos() -> None:
    """ "Respond normally, but late" is this runtime's spelling of the old `latency_ms`."""
    slow = parse_scenarios({})["slow"]
    assert slow.operations == {}
    assert slow.chaos is not None
    assert effective_knobs(slow.chaos, "GET /pets").delay_ms == SLOW_SCENARIO_DELAY_MS


def test_a_stored_scenario_replaces_the_builtin_of_the_same_name() -> None:
    """The built-ins are a floor, never an override — as the old `normalize_scenarios` resolved it."""
    stored: dict[str, Any] = {
        "scenarios": {"server-error": {"operations": {"GET /pets": {"responses": [{"status": 502}]}}}}
    }
    scenarios = parse_scenarios(stored)

    assert scenarios["server-error"].override_for("GET /pets").responses[0].status == 502
    # The stored definition replaces the built-in outright, so the wildcard is gone with it.
    assert scenarios["server-error"].override_for("GET /elsewhere") is None


def test_merging_never_mutates_the_builtin_definitions() -> None:
    merged = merge_builtin_scenarios({"custom": {"operations": {}}})
    merged["happy-path"]["description"] = "tampered"

    assert BUILTIN_SCENARIOS["happy-path"]["description"].startswith("Default:")
    assert "custom" in merged


def test_an_exact_operation_key_beats_the_wildcard() -> None:
    scenarios = parse_scenarios(
        {
            "scenarios": {
                "mixed": {
                    "operations": {
                        WILDCARD_OPERATION_KEY: {"responses": [{"status": 500}]},
                        "GET /pets": {"responses": [{"status": 418}]},
                    }
                }
            }
        }
    )
    mixed = scenarios["mixed"]

    assert mixed.override_for("GET /pets").responses[0].status == 418
    assert mixed.override_for("POST /pets").responses[0].status == 500


def test_a_scenario_with_no_wildcard_falls_through_for_unnamed_operations() -> None:
    scenarios = parse_scenarios(
        {"scenarios": {"narrow": {"operations": {"GET /pets": {"responses": [{"status": 418}]}}}}}
    )
    assert scenarios["narrow"].override_for("POST /pets") is None
