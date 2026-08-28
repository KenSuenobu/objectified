"""Unit tests for mock response-correlation validation and canonicalization (#5527, MSC-1.1)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.mock_correlation import (
    MAX_POINTERS_PER_OPERATION,
    correlation_from_storage,
    correlation_to_storage,
    validate_mock_correlation,
)
from app.models import MockResponseCorrelationSpec

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "array", "items": {"type": "object"}}}},
                    }
                }
            }
        },
        "/pets/{petId}": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "object"}}},
                    }
                }
            }
        },
    },
}


def _correlation(raw: dict) -> MockResponseCorrelationSpec:
    return MockResponseCorrelationSpec.model_validate(raw)


# ---------------------------------------------------------------------------
# Model-level shape
# ---------------------------------------------------------------------------


def test_the_default_block_is_off_with_no_bindings() -> None:
    correlation = _correlation({})

    assert correlation.mode == "off"
    assert correlation.operations == {}


@pytest.mark.parametrize("mode", ["off", "path-params", "inferred", "explicit"])
def test_every_documented_mode_is_accepted(mode: str) -> None:
    assert _correlation({"mode": mode}).mode == mode


@pytest.mark.parametrize("raw", [{"mode": "guess"}, {"mode": 7}, {"unknown": True}])
def test_an_unknown_mode_or_key_is_rejected_by_the_model(raw: dict) -> None:
    with pytest.raises(ValidationError):
        _correlation(raw)


# ---------------------------------------------------------------------------
# validate_mock_correlation
# ---------------------------------------------------------------------------


def test_no_block_is_valid() -> None:
    assert validate_mock_correlation(None, SPEC) == []


def test_an_inference_only_block_needs_no_bindings() -> None:
    assert validate_mock_correlation(_correlation({"mode": "inferred"}), SPEC) == []


def test_a_well_formed_pointer_map_validates() -> None:
    correlation = _correlation(
        {
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}", "": "{{request.body}}"}},
        }
    )

    assert validate_mock_correlation(correlation, SPEC) == []


def test_bindings_saved_with_mode_off_are_refused_rather_than_silently_ignored() -> None:
    correlation = _correlation({"mode": "off", "operations": {"GET /pets": {"/id": "x"}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("would never run" in error for error in errors)


def test_an_operation_key_that_is_not_method_and_path_is_refused() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"pets": {"/id": "x"}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("operation keys must look like" in error for error in errors)


def test_an_operation_the_spec_does_not_have_is_refused() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"DELETE /pets": {"/id": "x"}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("DELETE /pets" in error for error in errors)


def test_an_operation_entry_with_no_bindings_is_refused() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": {}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("declares no pointer bindings" in error for error in errors)


def test_a_pointer_that_is_not_rfc_6901_is_refused() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": {"id": "x"}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("JSON Pointer" in error for error in errors)


def test_a_malformed_template_is_a_save_time_error_not_a_serve_time_surprise() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": {"/id": "{{request.nope}}"}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("unknown request field" in error for error in errors)


def test_an_unterminated_placeholder_is_refused() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": {"/id": "{{request.method"}}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("unterminated" in error for error in errors)


def test_a_literal_binding_without_a_template_is_allowed() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": {"/id": "constant"}}})

    assert validate_mock_correlation(correlation, SPEC) == []


def test_too_many_pointer_bindings_are_refused() -> None:
    pointers = {f"/field{index}": "x" for index in range(MAX_POINTERS_PER_OPERATION + 1)}
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": pointers}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any(str(MAX_POINTERS_PER_OPERATION) in error for error in errors)


def test_an_oversized_block_is_refused() -> None:
    pointers = {f"/field{index}": "x" * 4_000 for index in range(MAX_POINTERS_PER_OPERATION)}
    correlation = _correlation({"mode": "explicit", "operations": {"GET /pets": pointers}})

    errors = validate_mock_correlation(correlation, SPEC)

    assert any("too large" in error for error in errors)


# ---------------------------------------------------------------------------
# Storage round trip
# ---------------------------------------------------------------------------


def test_storage_normalizes_operation_keys_so_the_runtime_lookup_hits() -> None:
    correlation = _correlation({"mode": "explicit", "operations": {"get /pets/{petId}": {"/id": "x"}}})

    assert correlation_to_storage(correlation) == {
        "mode": "explicit",
        "operations": {"GET /pets/{petId}": {"/id": "x"}},
    }


def test_an_inference_only_block_stores_as_just_its_mode() -> None:
    assert correlation_to_storage(_correlation({"mode": "path-params"})) == {"mode": "path-params"}


def test_from_storage_reads_the_block_and_reports_malformed_settings() -> None:
    assert correlation_from_storage(None) == (None, True)
    assert correlation_from_storage({}) == (None, True)
    assert correlation_from_storage({"responseCorrelation": {"mode": "inferred"}}) == (
        {"mode": "inferred"},
        True,
    )
    assert correlation_from_storage('{"responseCorrelation": {"mode": "inferred"}}') == (
        {"mode": "inferred"},
        True,
    )
    assert correlation_from_storage("not json") == (None, False)
    assert correlation_from_storage({"responseCorrelation": []}) == (None, False)


def test_the_stored_block_round_trips_back_through_the_model() -> None:
    correlation = _correlation(
        {"mode": "inferred", "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}}}
    )

    stored = correlation_to_storage(correlation)

    assert MockResponseCorrelationSpec.model_validate(stored) == correlation
