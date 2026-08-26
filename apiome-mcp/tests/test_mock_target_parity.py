"""Golden parity: an agent's mock URL equals the one apiome-rest publishes (AGX-2.4, #4536).

The Control Panel shows a version's ``mock_base_url`` (``app.versions_routes``); an
AGX-2.4 sandbox toolset builds its own URL from the same slug coordinates. If those two
templates ever drift, agents 404 against a mock a human can reach by hand — a failure
mode that no unit test on either side alone would catch. This file is the guard, in the
same spirit as ``test_effective_policy_parity.py`` (MTG-1.4).
"""

from __future__ import annotations

import app.versions_routes as rest_versions

from apiome_mcp.mock_target import MockCoordinates, build_mock_base_url, resolve_route

_CASES = [
    ("acme-corp", "petstore", "1.0.0"),
    ("tenant-two", "billing-api", "v2"),
    ("a", "b", "c"),
]


def _rest_mock_base_url(tenant: str, project: str, version: str) -> str:
    """The exact URL apiome-rest hands to the UI for a published, mock-enabled version."""
    url = rest_versions._mock_base_url(
        tenant,
        project,
        version,
        mock_enabled=True,
        published=True,
    )
    assert url is not None
    return url


def test_agent_mock_url_matches_rest_published_url() -> None:
    root = rest_versions.settings.mock_public_base_url
    for tenant, project, version in _CASES:
        assert build_mock_base_url(root, MockCoordinates(tenant, project, version)) == _rest_mock_base_url(
            tenant,
            project,
            version,
        )


def test_resolved_mock_route_matches_rest_published_url() -> None:
    """The full routing decision — not just the builder — lands on the published mount point."""
    root = rest_versions.settings.mock_public_base_url
    for tenant, project, version in _CASES:
        route = resolve_route(
            target="mock",
            mock_public_base_url=root,
            coordinates=MockCoordinates(tenant, project, version),
        )
        assert route.base_url == _rest_mock_base_url(tenant, project, version)


def test_mount_path_is_the_documented_sim_shape() -> None:
    """``/{tenant}/{project}/{version}`` is the mock runtime's router contract (SIM-1.1)."""
    assert MockCoordinates("acme-corp", "petstore", "1.0.0").mount_path == "/acme-corp/petstore/1.0.0"
