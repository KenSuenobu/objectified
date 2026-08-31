"""Folding legacy mock instance configs onto the one engine (#5532, MSC-2.2).

The acceptance criterion these cover is "migrated instance configs serve the same responses before
and after". :data:`LEGACY_FIXTURES` is that fixture set: each entry records what the retired in-REST
engine answered for a request, and the assertions check that the folded settings say the same
thing in the surviving engine's vocabulary. The serving half of the round trip — that apiome-mock
really answers this way — is asserted in ``apiome-mock/tests/test_folded_instance_settings.py``.
"""

from app.mock_instance_config import (
    ACTIVE_SCENARIO_KEY,
    MAX_LATENCY_MS,
    fold_instance_config,
    legacy_scenario_names,
)

SPEC = {
    "openapi": "3.1.0",
    "paths": {
        "/pets": {
            "get": {"responses": {"200": {"description": "ok"}}},
            "post": {"responses": {"201": {"description": "created"}}},
        },
        "/pets/{petId}": {
            "get": {"responses": {"200": {"description": "ok"}}},
            "delete": {"responses": {"204": {"description": "gone"}}},
        },
    },
}

# What the retired engine answered, captured before it was deleted. Each entry is
# (legacy scenario rules, method, path, expected status, expected body-or-None).
LEGACY_FIXTURES = (
    ([{"operation": "*", "status": 500, "body": {"e": 1}}], "GET", "/pets", 500, {"e": 1}),
    ([{"operation": "*", "status": 404, "body": {"e": 2}}], "GET", "/pets/9", 404, {"e": 2}),
    ([{"operation": "GET /pets", "status": 418}], "GET", "/pets", 418, None),
    ([{"operation": "POST /pets", "body": {"made": True}}], "POST", "/pets", 201, {"made": True}),
    ([{"method": "DELETE", "path": "/pets/{petId}", "status": 202}], "DELETE", "/pets/9", 202, None),
)


def _fold(rules, *, name="custom", active="custom", spec=SPEC):
    """Fold a one-scenario legacy config and return its translated scenario."""
    config = {"scenarios": [{"name": name, "rules": rules}], "active_scenario": active}
    return fold_instance_config(config, spec)


def test_a_non_mapping_config_folds_to_nothing():
    """An unreadable stored blob must not be able to take an instance's data plane down."""
    assert fold_instance_config(None, SPEC).settings == {}
    assert fold_instance_config("nope", SPEC).settings == {}
    assert fold_instance_config(["nope"], SPEC).notes == []


def test_the_legacy_fixture_set_translates_to_the_same_answers():
    """Every response the old engine gave has an equivalent in the folded settings."""
    for rules, method, path, status, body in LEGACY_FIXTURES:
        fold = _fold(rules)
        operations = fold.settings["scenarios"]["custom"]["operations"]
        template = "/pets" if path == "/pets" else "/pets/{petId}"
        override = operations.get(f"{method} {template}") or operations["*"]
        if body is None:
            assert override["status"] == status, (method, path)
        else:
            assert override["responses"] == [{"status": status, "body": body}], (method, path)


def test_a_global_rule_collapses_onto_the_wildcard_key():
    """"Every endpoint returns 500" stays one entry rather than becoming one per route."""
    fold = _fold([{"operation": "*", "status": 503}])
    assert fold.settings["scenarios"]["custom"]["operations"] == {"*": {"status": 503}}


def test_a_body_without_a_status_takes_each_operations_own_default():
    """The old engine served the operation's default success status, which differs per route."""
    fold = _fold([{"operation": "*", "body": {"ok": True}}])
    operations = fold.settings["scenarios"]["custom"]["operations"]
    assert operations["GET /pets"]["responses"][0]["status"] == 200
    assert operations["POST /pets"]["responses"][0]["status"] == 201
    assert operations["DELETE /pets/{petId}"]["responses"][0]["status"] == 204


def test_a_status_without_a_body_becomes_a_status_pin():
    """A pin keeps the body tracking the spec, which is what generating it used to do."""
    fold = _fold([{"operation": "GET /pets", "status": 429}])
    assert fold.settings["scenarios"]["custom"]["operations"]["GET /pets"] == {"status": 429}


def test_first_rule_wins_per_operation_exactly_as_the_old_engine_resolved_it():
    """A global rule listed first made every later specific rule unreachable. It still does."""
    fold = _fold(
        [
            {"operation": "*", "status": 500},
            {"operation": "GET /pets", "status": 418},
        ]
    )
    operations = fold.settings["scenarios"]["custom"]["operations"]
    assert operations == {"*": {"status": 500}}
    assert any("rule 2" in note for note in fold.notes)


def test_a_specific_rule_listed_first_is_not_swallowed_by_a_later_global_one():
    fold = _fold(
        [
            {"operation": "GET /pets", "status": 418},
            {"operation": "*", "status": 500},
        ]
    )
    operations = fold.settings["scenarios"]["custom"]["operations"]
    assert operations["GET /pets"] == {"status": 418}
    assert operations["GET /pets/{petId}"] == {"status": 500}
    assert fold.notes == []


def test_method_and_path_wildcards_translate_per_operation():
    fold = _fold([{"method": "GET", "path": "*", "status": 503}])
    operations = fold.settings["scenarios"]["custom"]["operations"]
    assert set(operations) == {"GET /pets", "GET /pets/{petId}"}
    assert operations["GET /pets"] == {"status": 503}


def test_a_rule_matching_no_operation_is_reported_not_dropped():
    fold = _fold([{"operation": "GET /ghosts", "status": 500}])
    assert fold.settings["scenarios"]["custom"]["operations"] == {}
    assert len(fold.notes) == 1
    assert "GET /ghosts" in fold.notes[0]


def test_a_rule_that_changes_nothing_is_reported():
    fold = _fold([{"operation": "*"}])
    assert any("sets no status, body or latency" in note for note in fold.notes)


def test_latency_becomes_scenario_chaos():
    fold = _fold([{"operation": "*", "latency_ms": 1500}])
    scenario = fold.settings["scenarios"]["custom"]
    assert scenario["chaos"] == {"default": {"delayMs": 1500}}
    assert scenario["operations"] == {}


def test_per_operation_latency_becomes_a_chaos_override():
    fold = _fold([{"operation": "GET /pets", "latency_ms": 250}])
    assert fold.settings["scenarios"]["custom"]["chaos"] == {
        "operations": {"GET /pets": {"delayMs": 250}}
    }


def test_latency_is_clamped_and_the_clamp_is_reported():
    fold = _fold([{"operation": "*", "latency_ms": 10_000_000}])
    assert fold.settings["scenarios"]["custom"]["chaos"]["default"]["delayMs"] == MAX_LATENCY_MS
    assert any("clamped" in note for note in fold.notes)


def test_the_active_scenario_lands_on_the_msc_2_1_key():
    fold = _fold([{"operation": "*", "status": 500}], name="outage", active="outage")
    assert fold.settings[ACTIVE_SCENARIO_KEY] == "outage"


def test_happy_path_is_not_stored_as_a_default():
    """No stored default is what happy-path means to the runtime, so storing it says nothing."""
    fold = fold_instance_config({"scenarios": [], "active_scenario": "happy-path"}, SPEC)
    assert ACTIVE_SCENARIO_KEY not in fold.settings


def test_untouched_builtin_scenarios_are_left_to_the_runtime():
    """The engine supplies these to every mock, so re-storing them would just duplicate them."""
    config = {
        "scenarios": [
            {"name": "happy-path", "description": "", "rules": []},
            {"name": "slow", "description": "", "rules": [{"operation": "*", "latency_ms": 1500}]},
            {
                "name": "server-error",
                "description": "",
                "rules": [
                    {
                        "operation": "*",
                        "status": 500,
                        "body": {
                            "error": {"code": "internal_error", "message": "Simulated server error."}
                        },
                    }
                ],
            },
        ],
        "active_scenario": "happy-path",
    }
    assert fold_instance_config(config, SPEC).settings == {}


def test_a_customised_builtin_is_translated_like_any_other_scenario():
    """An edited `server-error` is a real scenario and must shadow the built-in."""
    config = {
        "scenarios": [
            {"name": "server-error", "rules": [{"operation": "GET /pets", "status": 502}]}
        ],
        "active_scenario": "server-error",
    }
    fold = fold_instance_config(config, SPEC)
    assert fold.settings["scenarios"]["server-error"]["operations"] == {"GET /pets": {"status": 502}}


def test_the_stored_seed_travels_separately():
    """apiome-mock takes a seed per request, so the fold hands it back rather than storing it."""
    fold = fold_instance_config({"scenarios": [], "seed": 99}, SPEC)
    assert fold.seed == 99
    assert "seed" not in fold.settings


def test_legacy_scenario_names_lists_stored_names_only():
    config = {"scenarios": [{"name": "a"}, {"name": "  b  "}, {"name": ""}, "nope", {"name": "a"}]}
    assert legacy_scenario_names(config) == ["a", "b"]
