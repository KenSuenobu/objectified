"""The hop that carries a sandbox request to the one mock engine (#5532, MSC-2.2)."""

import json
from typing import Any, Dict
from unittest.mock import patch

import httpx
import pytest
from app.config import settings
from app.mock_bundle import verify_bundle
from app.mock_sandbox import (
    INTERNAL_TOKEN_HEADER,
    SANDBOX_PATH,
    MockSandboxError,
    MockSandboxRejected,
    MockSandboxUnavailable,
    request_sandbox_serve,
    sandbox_bundle,
    sandbox_is_configured,
)

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {"/pets": {"get": {"responses": {"200": {"description": "ok"}}}}},
}

INSTANCE: Dict[str, Any] = {
    "id": "00000000-0000-0000-0000-0000000000aa",
    "version_id": "11111111-1111-1111-1111-111111111111",
    "tenant_slug": "acme",
    "project_slug": "petstore",
    "version_slug": "1.0.0",
    "spec": SPEC,
    "settings": {"activeScenario": "outage", "scenarios": {"outage": {"operations": {}}}},
}


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the transport at a reachable mock engine."""
    monkeypatch.setattr(settings, "mock_internal_base_url", "http://mock:8775")
    monkeypatch.setattr(settings, "mock_internal_token", "sandbox-token")
    monkeypatch.setattr(settings, "mock_sandbox_timeout_seconds", 5.0)


def _transport(handler: Any) -> Any:
    """Patch the transport so the outbound request can be inspected without a network."""
    original = httpx.AsyncClient

    def build(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    return patch("app.mock_sandbox.httpx.AsyncClient", side_effect=build)


def test_bundle_carries_the_frozen_spec_and_folded_settings() -> None:
    bundle = sandbox_bundle(INSTANCE)

    assert bundle["spec"] == SPEC
    assert bundle["settings"]["activeScenario"] == "outage"
    # The instance's own coordinates travel, so problem documents and session namespacing name the
    # API the sandbox was frozen from rather than an opaque id.
    assert bundle["manifest"]["api"]["tenant"] == "acme"
    assert bundle["manifest"]["api"]["version"] == "1.0.0"


def test_the_bundle_verifies_on_arrival() -> None:
    """Content digests are what protect a truncated or garbled payload; they must be right."""
    verification = verify_bundle(sandbox_bundle(INSTANCE), secret=None, require_signature=False)
    assert verification.ok, verification.problems


def test_a_bundle_for_an_instance_with_no_version_falls_back_to_its_own_id() -> None:
    """Export test-drive rows carry no version, and a bundle still needs a revision identity."""
    instance = {**INSTANCE, "version_id": None}
    assert sandbox_bundle(instance)["manifest"]["api"]["revisionId"] == instance["id"]


def test_an_instance_with_no_settings_yet_bundles_an_empty_configuration() -> None:
    """A sandbox provisioned with nothing stored still serves — on the built-ins alone."""
    bundle = sandbox_bundle({**INSTANCE, "settings": None})
    assert bundle["settings"] == {}


def test_sandbox_serving_needs_both_halves_of_the_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mock_internal_base_url", "http://mock:8775")
    monkeypatch.setattr(settings, "mock_internal_token", None)
    assert sandbox_is_configured() is False
    monkeypatch.setattr(settings, "mock_internal_base_url", "")
    monkeypatch.setattr(settings, "mock_internal_token", "sandbox-token")
    assert sandbox_is_configured() is False


@pytest.mark.asyncio
async def test_serving_without_configuration_refuses_rather_than_guessing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mock_internal_base_url", "")
    monkeypatch.setattr(settings, "mock_internal_token", None)
    with pytest.raises(MockSandboxUnavailable):
        await request_sandbox_serve(sandbox_id="s", bundle={}, request={})


@pytest.mark.asyncio
async def test_the_sandbox_id_bundle_and_token_reach_the_engine(configured: None) -> None:
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get(INTERNAL_TOKEN_HEADER)
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"status": 204, "bodyEncoding": "empty"})

    with _transport(handler):
        result = await request_sandbox_serve(
            sandbox_id="sandbox-1",
            bundle={"bundleFormat": "x"},
            request={"method": "GET", "path": "/pets"},
        )

    assert seen["url"] == "http://mock:8775" + SANDBOX_PATH
    assert seen["token"] == "sandbox-token"
    # The sandbox id is what scopes session state on the far side, so it must always travel.
    assert seen["body"]["sandbox"] == "sandbox-1"
    assert seen["body"]["bundle"] == {"bundleFormat": "x"}
    assert seen["body"]["request"] == {"method": "GET", "path": "/pets"}
    assert result["status"] == 204


@pytest.mark.asyncio
async def test_an_engine_refusal_carries_its_structured_detail(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": {"problems": [{"code": "digest-mismatch"}]}})

    with _transport(handler), pytest.raises(MockSandboxRejected) as raised:
        await request_sandbox_serve(sandbox_id="s", bundle={}, request={})

    assert raised.value.status_code == 422
    assert raised.value.detail["problems"][0]["code"] == "digest-mismatch"


@pytest.mark.asyncio
async def test_a_non_json_refusal_still_reports_something_readable(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="upstream exploded")

    with _transport(handler), pytest.raises(MockSandboxRejected) as raised:
        await request_sandbox_serve(sandbox_id="s", bundle={}, request={})

    assert raised.value.detail == "upstream exploded"


@pytest.mark.asyncio
async def test_an_unreachable_engine_raises_a_transport_error(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with _transport(handler), pytest.raises(MockSandboxError, match="could not be reached"):
        await request_sandbox_serve(sandbox_id="s", bundle={}, request={})


@pytest.mark.asyncio
async def test_an_engine_answering_with_non_json_is_an_error(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json")

    with _transport(handler), pytest.raises(MockSandboxError, match="not JSON"):
        await request_sandbox_serve(sandbox_id="s", bundle={}, request={})


@pytest.mark.asyncio
async def test_an_engine_answering_with_a_json_array_is_an_error(configured: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    with _transport(handler), pytest.raises(MockSandboxError, match="unexpected response shape"):
        await request_sandbox_serve(sandbox_id="s", bundle={}, request={})
