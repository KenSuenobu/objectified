"""Portable (bundle-backed) runtime tests (#4742, PMR-1.2).

Behavioral parity with the hosted runtime is proven by the shared conformance corpus
(``test_conformance_corpus.py``). These tests cover what is specific to the portable app: the URL
shapes it mounts, the operational endpoints it reserves, and the structured logs it emits.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import pytest
import structlog
from fastapi.testclient import TestClient

from apiome_mock import portable
from apiome_mock.bundle import LoadedBundle, load_bundle_file
from apiome_mock.conformance import DEFAULT_BUNDLE_PATH
from apiome_mock.portable import HEALTH_PATH, READY_PATH, create_portable_app, version_prefix
from apiome_mock.portable_config import PortableSettings


@contextmanager
def capture_portable_logs() -> Iterator[list[dict[str, Any]]]:
    """Capture the events :mod:`apiome_mock.portable` emits.

    The runtime configures structlog with ``cache_logger_on_first_use``, so a module-level logger
    that an earlier test already bound keeps writing to the pipeline configured back then and is
    invisible to ``capture_logs``. Swapping in a fresh, unbound logger for the duration of the
    capture makes these assertions independent of test ordering.
    """
    original = portable._log
    portable._log = structlog.get_logger("apiome_mock.portable")
    try:
        with structlog.testing.capture_logs() as logs:
            yield logs
    finally:
        portable._log = original


@pytest.fixture
def bundle() -> LoadedBundle:
    """The conformance bundle, loaded offline."""
    return load_bundle_file(DEFAULT_BUNDLE_PATH)


@pytest.fixture
def prefix(bundle: LoadedBundle) -> str:
    """The hosted-shape mount prefix for the conformance bundle."""
    return version_prefix(bundle)


@pytest.fixture
def client(bundle: LoadedBundle) -> Iterator[TestClient]:
    """A started client for the default (hosted URL shape) configuration."""
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH))
    with TestClient(create_portable_app(bundle, settings)) as started:
        yield started


# ---------------------------------------------------------------------------
# Mounting
# ---------------------------------------------------------------------------


def test_spec_is_served_under_the_hosted_url_shape(client: TestClient, prefix: str) -> None:
    """A request that works against the hosted mock works here by changing only the host."""
    response = client.get(f"{prefix}/pets")

    assert response.status_code == 200
    assert response.json() == [{"id": 1, "name": "Rex"}]


def test_requests_outside_the_mounted_prefix_are_rejected(client: TestClient) -> None:
    response = client.get("/other-tenant/other-project/2.0.0/pets")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "/conformance/petstore/1.0.0" in response.json()["detail"]


def test_the_mount_root_itself_resolves_to_the_spec_root(client: TestClient, prefix: str) -> None:
    """``/{tenant}/{project}/{version}`` maps to spec path ``/`` rather than to a 404 prefix miss."""
    response = client.get(prefix)

    assert response.status_code == 404
    assert response.json()["detail"] == "No operation matches GET /."


def test_root_base_path_serves_spec_paths_at_the_root(bundle: LoadedBundle) -> None:
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH), base_path="root")

    with TestClient(create_portable_app(bundle, settings)) as client:
        response = client.get("/pets")

    assert response.status_code == 200
    assert response.json() == [{"id": 1, "name": "Rex"}]


def test_root_base_path_still_reserves_the_operational_endpoints(bundle: LoadedBundle) -> None:
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH), base_path="root")

    with TestClient(create_portable_app(bundle, settings)) as client:
        assert client.get(HEALTH_PATH).json() == {"status": "ok"}
        assert client.get(READY_PATH).json()["status"] == "ready"


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------


def test_health_is_live_as_soon_as_the_process_serves(bundle: LoadedBundle) -> None:
    """Liveness must not depend on startup having completed."""
    app = create_portable_app(bundle, PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH)))

    response = TestClient(app).get(HEALTH_PATH)

    assert response.status_code == 200


def test_ready_is_503_until_startup_completes(bundle: LoadedBundle) -> None:
    """A client that waits on /ready never sends traffic to a half-started runtime."""
    app = create_portable_app(bundle, PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH)))

    response = TestClient(app).get(READY_PATH)

    assert response.status_code == 503
    assert response.json() == {"status": "starting"}


def test_ready_identifies_the_served_bundle(client: TestClient, bundle: LoadedBundle, prefix: str) -> None:
    payload = client.get(READY_PATH).json()

    assert payload["status"] == "ready"
    assert payload["runtime"]["mode"] == "portable"
    assert payload["runtime"]["mount"] == prefix
    assert payload["bundle"]["digest"] == bundle.digest
    assert payload["bundle"]["tenant"] == "conformance"
    assert payload["bundle"]["operations"] == len(bundle.operations)
    assert payload["bundle"]["scenarios"] == sorted(bundle.scenarios)


def test_ready_reports_not_ready_after_shutdown(bundle: LoadedBundle) -> None:
    app = create_portable_app(bundle, PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH)))

    with TestClient(app) as started:
        assert started.get(READY_PATH).status_code == 200

    assert TestClient(app).get(READY_PATH).status_code == 503


# ---------------------------------------------------------------------------
# Structured logs
# ---------------------------------------------------------------------------


def test_startup_logs_identify_the_bundle(bundle: LoadedBundle) -> None:
    app = create_portable_app(bundle, PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH)))

    with capture_portable_logs() as logs:
        with TestClient(app):
            pass

    events = {entry["event"]: entry for entry in logs}
    assert events["portable_runtime_ready"]["digest"] == bundle.digest
    assert events["portable_runtime_ready"]["mount"] == version_prefix(bundle)
    assert events["portable_runtime_stopped"]["digest"] == bundle.digest


def test_every_request_emits_one_access_log_line(bundle: LoadedBundle, prefix: str) -> None:
    app = create_portable_app(bundle, PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH)))

    with TestClient(app) as client:
        with capture_portable_logs() as logs:
            client.get(f"{prefix}/pets")

    requests = [entry for entry in logs if entry["event"] == "mock_request"]
    assert len(requests) == 1
    assert requests[0]["method"] == "GET"
    assert requests[0]["path"] == f"{prefix}/pets"
    assert requests[0]["status"] == 200
    assert requests[0]["digest"] == bundle.digest
    assert requests[0]["duration_ms"] >= 0


def test_access_log_can_be_switched_off(bundle: LoadedBundle, prefix: str) -> None:
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH), access_log=False)
    app = create_portable_app(bundle, settings)

    with TestClient(app) as client:
        with capture_portable_logs() as logs:
            client.get(f"{prefix}/pets")

    assert [entry for entry in logs if entry["event"] == "mock_request"] == []


# ---------------------------------------------------------------------------
# Isolation from the hosted runtime's dependencies
# ---------------------------------------------------------------------------


def test_session_state_is_scoped_per_session_token(client: TestClient, prefix: str) -> None:
    """Stateful CRUD works with no database, and one session cannot see another's writes."""
    created = client.post(
        f"{prefix}/pets",
        headers={"X-Mock-Session": "alpha"},
        json={"id": 5, "name": "Ada"},
    )
    assert created.status_code == 201

    assert client.get(f"{prefix}/pets", headers={"X-Mock-Session": "alpha"}).json() == [{"id": 5, "name": "Ada"}]
    assert client.get(f"{prefix}/pets", headers={"X-Mock-Session": "beta"}).json() == []


def test_session_caps_come_from_the_declared_settings(bundle: LoadedBundle, prefix: str) -> None:
    """A cap set on the command line is the cap the store enforces."""
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH), session_max_resources=1)

    with TestClient(create_portable_app(bundle, settings)) as client:
        first = client.post(f"{prefix}/pets", headers={"X-Mock-Session": "capped"}, json={"id": 1, "name": "A"})
        second = client.post(f"{prefix}/pets", headers={"X-Mock-Session": "capped"}, json={"id": 2, "name": "B"})

    assert first.status_code == 201
    assert second.status_code == 400


def test_api_keys_are_not_consulted_by_the_portable_runtime(client: TestClient, prefix: str) -> None:
    """There is no control plane to validate a key against; a bundle is already the authorization."""
    response = client.get(f"{prefix}/pets", headers={"X-Api-Key": "whatever"})

    assert response.status_code == 200
