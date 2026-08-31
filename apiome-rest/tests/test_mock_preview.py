"""Control-plane half of the dry-run mock preview (#5528, MSC-1.2).

Covers the three things apiome-rest owns: overlaying an unsaved draft on the version's stored mock
settings, validating that draft with the same rules its save route applies, and the authenticated
hop to the mock runtime that does the actual rendering.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, Iterator
from unittest.mock import patch

import httpx
import pytest

from app.config import settings
from app.mock_bundle import BUNDLED_SETTINGS_KEYS
from app.mock_preview import (
    INTERNAL_TOKEN_HEADER,
    PREVIEW_PATH,
    MockPreviewError,
    MockPreviewRejected,
    MockPreviewUnavailable,
    draft_to_storage,
    effective_mock_settings,
    preview_is_configured,
    request_mock_preview,
    validate_draft_settings,
)
from app.models import MockPreviewSettingsSpec

SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "object"}}},
                    }
                },
            }
        }
    },
}

STORED: Dict[str, Any] = {
    "mode": "private",
    "scenarios": {"quiet": {"operations": {}}},
    "responseCorrelation": {"mode": "path-params"},
}


def _draft(**payload: Any) -> MockPreviewSettingsSpec:
    return MockPreviewSettingsSpec.model_validate(payload)


# ==================================================================================================
# Overlaying a draft
# ==================================================================================================


def test_no_draft_previews_the_stored_settings_unchanged() -> None:
    assert effective_mock_settings(STORED, None) == STORED


def test_a_declared_key_replaces_the_stored_one() -> None:
    merged = effective_mock_settings(STORED, _draft(correlation={"mode": "off"}))
    assert merged["responseCorrelation"] == {"mode": "off"}


def test_an_omitted_key_keeps_the_stored_value() -> None:
    merged = effective_mock_settings(STORED, _draft(correlation={"mode": "inferred"}))
    assert merged["scenarios"] == {"quiet": {"operations": {}}}
    assert merged["mode"] == "private", "hosted-only keys survive the overlay untouched"


def test_an_explicit_null_clears_a_stored_key() -> None:
    merged = effective_mock_settings(STORED, _draft(correlation=None))
    assert "responseCorrelation" not in merged


def test_the_overlay_does_not_mutate_the_stored_settings() -> None:
    stored = dict(STORED)
    effective_mock_settings(stored, _draft(correlation={"mode": "off"}))
    assert stored == STORED


def test_stored_settings_stored_as_json_text_are_understood() -> None:
    merged = effective_mock_settings('{"responseCorrelation": {"mode": "inferred"}}', None)
    assert merged["responseCorrelation"]["mode"] == "inferred"


def test_a_draft_is_canonicalized_exactly_as_saving_it_would_be() -> None:
    """A preview promises what the version *would become*, not what JSON was typed."""
    merged = effective_mock_settings(
        {},
        _draft(
            correlation={
                "mode": "explicit",
                "operations": {"get  /pets/{petId}": {"/id": "{{request.path.petId}}"}},
            }
        ),
    )
    assert merged["responseCorrelation"]["operations"] == {
        "GET /pets/{petId}": {"/id": "{{request.path.petId}}"}
    }


def test_every_draft_key_is_one_that_travels_in_a_bundle() -> None:
    """A draft key the bundle drops would be validated and then silently ignored."""
    fully_declared = _draft(
        scenarios={},
        chaos={"default": {"delayMs": 1}},
        fixturePacks={},
        callbacks={},
        correlation={"mode": "off"},
        activeScenario="quiet",
    )
    assert set(draft_to_storage(fully_declared)) == set(BUNDLED_SETTINGS_KEYS)


def test_a_drafted_active_scenario_overlays_the_stored_one() -> None:
    """Previewing "what would this default to?" is the point of drafting it (#5531, MSC-2.1)."""
    merged = effective_mock_settings({**STORED, "activeScenario": "loud"}, _draft(activeScenario="quiet"))
    assert merged["activeScenario"] == "quiet"


def test_a_drafted_null_active_scenario_clears_the_stored_one() -> None:
    merged = effective_mock_settings({**STORED, "activeScenario": "loud"}, _draft(activeScenario=None))
    assert "activeScenario" not in merged


def test_an_omitted_active_scenario_keeps_the_stored_one() -> None:
    merged = effective_mock_settings({**STORED, "activeScenario": "loud"}, _draft(correlation=None))
    assert merged["activeScenario"] == "loud"


# ==================================================================================================
# Validating a draft
# ==================================================================================================


def test_no_draft_validates_clean() -> None:
    assert validate_draft_settings(None, SPEC) == []


def test_a_valid_draft_validates_clean() -> None:
    draft = _draft(
        correlation={
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}},
        }
    )
    assert validate_draft_settings(draft, SPEC) == []


def test_a_draft_naming_an_operation_the_version_lacks_is_reported() -> None:
    draft = _draft(
        correlation={"mode": "explicit", "operations": {"GET /nope": {"/id": "{{request.path.x}}"}}}
    )
    errors = validate_draft_settings(draft, SPEC)
    assert errors and any("no operation" in error.lower() for error in errors)


def test_a_draft_with_an_unparseable_expression_is_reported() -> None:
    draft = _draft(
        correlation={
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/id": "{{ random.hex(9999) }}"}},
        }
    )
    assert validate_draft_settings(draft, SPEC) != []


def test_a_draft_scenario_is_validated_against_the_spec() -> None:
    draft = _draft(scenarios={"bad": {"operations": {"GET /nope": {"responses": [{"status": 200}]}}}})
    assert validate_draft_settings(draft, SPEC) != []


# ==================================================================================================
# The hop to the mock runtime
# ==================================================================================================


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "mock_internal_base_url", "http://mock:8775")
    monkeypatch.setattr(settings, "mock_internal_token", "preview-token")
    monkeypatch.setattr(settings, "mock_preview_timeout_seconds", 2.0)
    yield


def _transport(handler: Callable[[httpx.Request], httpx.Response]) -> Any:
    """Patch httpx.AsyncClient so every preview call is answered by ``handler``."""
    original = httpx.AsyncClient

    def build(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    return patch("app.mock_preview.httpx.AsyncClient", side_effect=build)


@pytest.mark.asyncio
async def test_preview_is_not_configured_without_both_halves(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "mock_internal_base_url", "http://mock:8775")
    monkeypatch.setattr(settings, "mock_internal_token", None)
    assert preview_is_configured() is False
    with pytest.raises(MockPreviewUnavailable):
        await request_mock_preview(bundle={}, request={})


@pytest.mark.asyncio
async def test_the_bundle_and_token_reach_the_runtime(configured: None) -> None:
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get(INTERNAL_TOKEN_HEADER)
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"status": 200, "trace": {"layer": "example"}})

    with _transport(handler):
        result = await request_mock_preview(bundle={"bundleFormat": "x"}, request={"path": "/pets"})

    assert seen["url"] == "http://mock:8775" + PREVIEW_PATH
    assert seen["token"] == "preview-token"
    assert seen["body"] == {"bundle": {"bundleFormat": "x"}, "request": {"path": "/pets"}}
    assert result["status"] == 200


@pytest.mark.asyncio
async def test_a_runtime_refusal_carries_its_structured_detail(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": {"problems": [{"code": "digest-mismatch"}]}})

    with _transport(handler), pytest.raises(MockPreviewRejected) as raised:
        await request_mock_preview(bundle={}, request={})

    assert raised.value.status_code == 422
    assert raised.value.detail["problems"][0]["code"] == "digest-mismatch"


@pytest.mark.asyncio
async def test_a_non_json_refusal_still_reports_something_readable(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="upstream exploded")

    with _transport(handler), pytest.raises(MockPreviewRejected) as raised:
        await request_mock_preview(bundle={}, request={})

    assert raised.value.detail == "upstream exploded"


@pytest.mark.asyncio
async def test_an_unreachable_runtime_raises_a_transport_error(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with _transport(handler), pytest.raises(MockPreviewError, match="could not be reached"):
        await request_mock_preview(bundle={}, request={})


@pytest.mark.asyncio
async def test_a_runtime_answering_with_non_json_is_an_error(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json")

    with _transport(handler), pytest.raises(MockPreviewError, match="not JSON"):
        await request_mock_preview(bundle={}, request={})


@pytest.mark.asyncio
async def test_a_runtime_answering_with_a_json_array_is_an_error(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    with _transport(handler), pytest.raises(MockPreviewError, match="unexpected preview shape"):
        await request_mock_preview(bundle={}, request={})
