"""Session data lifecycle endpoint tests (#4745, PMR-2.2).

Covers the reserved ``__mock__`` control plane end to end on the hosted runtime (fixture pack
listing, session reset/seed, determinism, capacity, namespace isolation) and proves the portable
runtime exposes the identical behavior from a bundle.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_bundle import BundleIdentity, build_bundle
from app.mock_fixture_packs import fixture_pack_digest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.chaos import CHAOS_DELAY_HEADER, parse_chaos
from apiome_mock.fixture_packs import parse_fixture_packs
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.portable import create_portable_app
from apiome_mock.portable_config import PortableSettings
from apiome_mock.scenarios import parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

PETSTORE_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": [{"id": 7, "name": "Rex"}]}},
                                "schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}},
                            }
                        },
                    }
                },
            },
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/NewPet"}}},
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}},
                    }
                },
            },
        },
        "/pets/{petId}": {
            "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}},
                    }
                },
            },
            "delete": {"responses": {"204": {"description": "deleted"}}},
        },
    },
    "components": {
        "schemas": {
            "NewPet": {
                "type": "object",
                "required": ["name"],
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            },
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            },
        }
    },
}

SMOKE_PACK = {
    "description": "Two pets.",
    "data": {"greeting": "hello"},
    "collections": {
        "/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}],
    },
}

BIG_PACK = {
    "collections": {
        "/pets": [{"id": index, "name": f"pet-{index}"} for index in range(1, 12)],
    },
}

CAPTURED_PACK = {
    "description": "Recorded from staging and reviewed.",
    "collections": {"/pets": [{"id": 7, "name": "Rex"}]},
    "provenance": {
        "source": "capture",
        "capturedFrom": ["https://api.example.com/v1"],
        "captures": 1,
        "redactions": 4,
        "approvedBy": "user-1",
        "approvedAt": "2026-08-26T19:00:00Z",
    },
}

MOCK_SETTINGS = {
    "fixturePacks": {"smoke": SMOKE_PACK, "too-big": BIG_PACK, "from-capture": CAPTURED_PACK},
    "scenarios": {
        "flaky": {
            "description": "Fails once, then succeeds.",
            "operations": {
                "GET /pets": {
                    "responses": [{"status": 429}, {"status": 200, "body": []}],
                }
            },
        }
    },
    "chaos": {"operations": {"GET /pets/{petId}": {"delayMs": 1}}},
}

BASE = "/demo/petstore/1.0.0"
CONTROL = f"{BASE}/__mock__"


def _compiled() -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
        scenarios=parse_scenarios(MOCK_SETTINGS),
        chaos=parse_chaos(MOCK_SETTINGS),
        fixture_packs=parse_fixture_packs(MOCK_SETTINGS),
    )


@pytest.fixture
def session_store() -> InMemorySessionStore:
    return InMemorySessionStore(
        SessionCaps(ttl_seconds=3600.0, max_resources=10, max_bytes=1_048_576, max_sessions=100),
    )


@pytest.fixture
def mock_client(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    session_store: InMemorySessionStore,
) -> Iterator[TestClient]:
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
        patch("apiome_mock.server.record_mock_request"),
        patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
        patch("apiome_mock.handler.load_compiled_spec", new=AsyncMock(return_value=_compiled())),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = session_store
            yield client
    get_settings.cache_clear()


def _reset(client: TestClient, *, session: str, pack: str | None = None, base: str = BASE):
    headers = {"X-Mock-Session": session}
    body = {"pack": pack} if pack is not None else None
    return client.post(f"{base}/__mock__/session/reset", headers=headers, json=body)


# ---------------------------------------------------------------------------
# Fixture pack listing
# ---------------------------------------------------------------------------


def test_list_fixture_packs(mock_client: TestClient) -> None:
    response = mock_client.get(f"{CONTROL}/fixture-packs")
    assert response.status_code == 200
    packs = response.json()["packs"]
    assert [pack["name"] for pack in packs] == ["from-capture", "smoke", "too-big"]
    smoke = next(pack for pack in packs if pack["name"] == "smoke")
    assert smoke["digest"] == fixture_pack_digest(SMOKE_PACK)
    assert smoke["packFormatVersion"] == 1
    assert smoke["fixtures"] == ["greeting"]
    assert smoke["collections"] == {"/pets": 2}
    assert smoke["resources"] == 2


def test_list_fixture_packs_rejects_other_methods(mock_client: TestClient) -> None:
    response = mock_client.post(f"{CONTROL}/fixture-packs")
    assert response.status_code == 405
    assert response.headers["Allow"] == "GET, HEAD"


def test_unknown_control_path_is_404_not_spec_routed(mock_client: TestClient) -> None:
    response = mock_client.get(f"{CONTROL}/nope")
    assert response.status_code == 404
    assert response.json()["type"].endswith("/not-found")


# ---------------------------------------------------------------------------
# Session reset and seeding
# ---------------------------------------------------------------------------


def test_reset_requires_session_header(mock_client: TestClient) -> None:
    response = mock_client.post(f"{CONTROL}/session/reset")
    assert response.status_code == 400
    assert response.json()["type"].endswith("/session-required")


def test_reset_rejects_non_post(mock_client: TestClient) -> None:
    response = mock_client.get(f"{CONTROL}/session/reset", headers={"X-Mock-Session": "s1"})
    assert response.status_code == 405
    assert response.headers["Allow"] == "POST"


def test_reset_to_pack_seeds_deterministic_state(mock_client: TestClient) -> None:
    response = _reset(mock_client, session="s1", pack="smoke")
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "session": "s1",
        "reset": True,
        "pack": "smoke",
        "packDigest": fixture_pack_digest(SMOKE_PACK),
        "collections": 1,
        "resources": 2,
        "origin": "authored",
        "redactionStatus": "not-applicable",
    }

    listed = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "s1"})
    assert listed.status_code == 200
    assert sorted(listed.json(), key=lambda item: item["id"]) == [
        {"id": 1, "name": "Rex"},
        {"id": 2, "name": "Bella"},
    ]
    one = mock_client.get(f"{BASE}/pets/1", headers={"X-Mock-Session": "s1"})
    assert one.status_code == 200
    assert one.json() == {"id": 1, "name": "Rex"}


def test_reset_without_pack_clears_session(mock_client: TestClient) -> None:
    assert _reset(mock_client, session="s1", pack="smoke").status_code == 200
    response = _reset(mock_client, session="s1")
    assert response.status_code == 200
    assert response.json() == {
        "session": "s1",
        "reset": True,
        "pack": None,
        "packDigest": None,
        "collections": 0,
        "resources": 0,
        "origin": None,
        "redactionStatus": None,
    }
    listed = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "s1"})
    assert listed.json() == []


def test_reset_discards_session_writes(mock_client: TestClient) -> None:
    assert _reset(mock_client, session="s1", pack="smoke").status_code == 200
    created = mock_client.post(f"{BASE}/pets", headers={"X-Mock-Session": "s1"}, json={"name": "Intruder"})
    assert created.status_code == 201
    deleted = mock_client.delete(f"{BASE}/pets/1", headers={"X-Mock-Session": "s1"})
    assert deleted.status_code == 204

    assert _reset(mock_client, session="s1", pack="smoke").status_code == 200
    listed = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "s1"})
    assert sorted(listed.json(), key=lambda item: item["id"]) == [
        {"id": 1, "name": "Rex"},
        {"id": 2, "name": "Bella"},
    ]


def test_create_after_seed_continues_after_highest_numeric_id(mock_client: TestClient) -> None:
    assert _reset(mock_client, session="s1", pack="smoke").status_code == 200
    created = mock_client.post(f"{BASE}/pets", headers={"X-Mock-Session": "s1"}, json={"name": "Newcomer"})
    assert created.status_code == 201
    assert created.json()["id"] == 3


def test_reset_to_unknown_pack_lists_available(mock_client: TestClient) -> None:
    response = _reset(mock_client, session="s1", pack="missing")
    assert response.status_code == 400
    body = response.json()
    assert body["type"].endswith("/unknown-fixture-pack")
    assert body["availablePacks"] == ["from-capture", "smoke", "too-big"]


def test_reset_rejects_malformed_bodies(mock_client: TestClient) -> None:
    headers = {"X-Mock-Session": "s1", "Content-Type": "application/json"}
    not_json = mock_client.post(f"{CONTROL}/session/reset", headers=headers, content="{nope")
    assert not_json.status_code == 400
    not_object = mock_client.post(f"{CONTROL}/session/reset", headers=headers, content="[1]")
    assert not_object.status_code == 400
    blank_pack = mock_client.post(f"{CONTROL}/session/reset", headers=headers, json={"pack": "  "})
    assert blank_pack.status_code == 400


def test_seed_exceeding_caps_fails_and_keeps_previous_state(mock_client: TestClient) -> None:
    assert _reset(mock_client, session="s1", pack="smoke").status_code == 200
    response = _reset(mock_client, session="s1", pack="too-big")
    assert response.status_code == 400
    assert "resource limit" in response.json()["detail"]
    listed = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "s1"})
    assert len(listed.json()) == 2


def test_reset_restarts_scenario_sequences(mock_client: TestClient) -> None:
    headers = {"X-Mock-Session": "s1", "X-Mock-Scenario": "flaky"}
    first = mock_client.get(f"{BASE}/pets", headers=headers)
    assert first.status_code == 429
    second = mock_client.get(f"{BASE}/pets", headers=headers)
    assert second.status_code == 200

    assert _reset(mock_client, session="s1").status_code == 200
    again = mock_client.get(f"{BASE}/pets", headers=headers)
    assert again.status_code == 429


def test_control_routes_bypass_chaos(mock_client: TestClient) -> None:
    delayed = mock_client.get(f"{BASE}/pets/1", headers={"X-Mock-Session": "s1"})
    assert CHAOS_DELAY_HEADER in delayed.headers
    control = _reset(mock_client, session="s1", pack="smoke")
    assert control.status_code == 200
    assert CHAOS_DELAY_HEADER not in control.headers


# ---------------------------------------------------------------------------
# Isolation: tenant / version / session boundaries
# ---------------------------------------------------------------------------


def test_sessions_are_isolated(mock_client: TestClient) -> None:
    assert _reset(mock_client, session="s1", pack="smoke").status_code == 200
    other = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "s2"})
    assert other.json() == []

    assert _reset(mock_client, session="s2", pack="smoke").status_code == 200
    assert _reset(mock_client, session="s1").status_code == 200
    kept = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "s2"})
    assert len(kept.json()) == 2


def test_reset_never_crosses_version_or_tenant_boundaries(
    mock_client: TestClient, session_store: InMemorySessionStore
) -> None:
    other_version = "/demo/petstore/2.0.0"
    other_tenant = "/other/petstore/1.0.0"
    assert _reset(mock_client, session="shared-token", pack="smoke", base=other_version).status_code == 200
    assert _reset(mock_client, session="shared-token", pack="smoke", base=other_tenant).status_code == 200

    # Same token, different version/tenant: this namespace saw no seed at all.
    listed = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "shared-token"})
    assert listed.json() == []

    # Clearing this namespace leaves the other two seeded namespaces untouched.
    assert _reset(mock_client, session="shared-token").status_code == 200
    for base in (other_version, other_tenant):
        kept = mock_client.get(f"{base}/pets", headers={"X-Mock-Session": "shared-token"})
        assert len(kept.json()) == 2


# ---------------------------------------------------------------------------
# Portable runtime parity
# ---------------------------------------------------------------------------


def test_portable_runtime_serves_the_same_lifecycle(tmp_path) -> None:
    from apiome_mock.bundle import load_bundle_document

    document = build_bundle(
        identity=BundleIdentity(
            tenant="demo",
            project="petstore",
            version="1.0.0",
            revision_id=str(uuid4()),
            published=True,
        ),
        spec=PETSTORE_SPEC,
        mock_settings=MOCK_SETTINGS,
    )
    bundle = load_bundle_document(document)
    settings = PortableSettings(bundle=str(tmp_path / "unused.json"))
    with TestClient(create_portable_app(bundle, settings)) as client:
        listed = client.get(f"{CONTROL}/fixture-packs")
        assert listed.status_code == 200
        assert [pack["name"] for pack in listed.json()["packs"]] == ["from-capture", "smoke", "too-big"]
        listed_packs = {pack["name"]: pack for pack in listed.json()["packs"]}
        assert listed_packs["smoke"]["digest"] == fixture_pack_digest(SMOKE_PACK)

        reset = _reset(client, session="ci-1", pack="smoke")
        assert reset.status_code == 200
        assert reset.json()["packDigest"] == fixture_pack_digest(SMOKE_PACK)

        pets = client.get(f"{BASE}/pets", headers={"X-Mock-Session": "ci-1"})
        assert sorted(pets.json(), key=lambda item: item["id"]) == [
            {"id": 1, "name": "Rex"},
            {"id": 2, "name": "Bella"},
        ]


# ---------------------------------------------------------------------------
# Replay reports its fixture origin and redaction status (#4747, PMR-2.4)
# ---------------------------------------------------------------------------


def test_listing_reports_each_pack_origin_and_redaction_status(mock_client: TestClient) -> None:
    packs = {pack["name"]: pack for pack in mock_client.get(f"{CONTROL}/fixture-packs").json()["packs"]}
    assert packs["smoke"]["origin"] == "authored"
    assert packs["smoke"]["redactionStatus"] == "not-applicable"
    captured = packs["from-capture"]
    assert captured["origin"] == "capture"
    assert captured["redactionStatus"] == "redacted"
    assert captured["provenance"]["capturedFrom"] == ["https://api.example.com/v1"]


def test_reset_to_a_captured_pack_reports_its_origin(mock_client: TestClient) -> None:
    response = _reset(mock_client, session="capture-1", pack="from-capture")
    assert response.status_code == 200
    body = response.json()
    assert body["origin"] == "capture"
    assert body["redactionStatus"] == "redacted"
    assert body["provenance"]["redactions"] == 4
    assert response.headers["X-Mock-Fixture-Origin"] == "capture"
    assert response.headers["X-Mock-Fixture-Redaction"] == "redacted"


def test_reset_to_an_authored_pack_says_redaction_does_not_apply(mock_client: TestClient) -> None:
    response = _reset(mock_client, session="authored-1", pack="smoke")
    assert response.headers["X-Mock-Fixture-Origin"] == "authored"
    assert response.headers["X-Mock-Fixture-Redaction"] == "not-applicable"
    assert "provenance" not in response.json()


def test_a_captured_pack_still_seeds_real_session_state(mock_client: TestClient) -> None:
    assert _reset(mock_client, session="capture-2", pack="from-capture").status_code == 200
    listed = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Session": "capture-2"})
    assert listed.status_code == 200
    assert listed.json() == [{"id": 7, "name": "Rex"}]
