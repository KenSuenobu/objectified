"""Official runtime image tests (#4742, PMR-1.2).

Building an image needs a Docker daemon, which a unit test suite cannot assume. What *can* be
checked here — and is worth checking, because getting it wrong silently breaks every documented
command — is the contract the image publishes: the entrypoint the docs tell people to append
subcommands to, the bundle mount path the CLI bind-mounts onto, the probe the healthcheck uses,
and the architectures the build script targets.

Actually building and running the image is covered by ``scripts/build-image.sh`` plus
``docker run --rm <image> selftest``, which runs the same corpus this suite runs in-process.
"""

from __future__ import annotations

import re
import stat
from pathlib import Path

from apiome_mock.portable import HEALTH_PATH

_MOCK_ROOT = Path(__file__).resolve().parent.parent
DOCKERFILE = _MOCK_ROOT / "Dockerfile"
BUILD_SCRIPT = _MOCK_ROOT / "scripts" / "build-image.sh"

#: Architectures the image is published for. Every base image and wheel supports both.
SUPPORTED_PLATFORMS = ("linux/amd64", "linux/arm64")

#: Documented bind-mount target; the CLI's Docker plan and the image default must agree on it.
CONTAINER_BUNDLE_PATH = "/bundle/mock-bundle.json"


def _dockerfile() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_entrypoint_is_the_runtime_binary() -> None:
    """`docker run <image> run --bundle …` only works if the entrypoint is the binary itself."""
    assert 'ENTRYPOINT ["apiome-mock"]' in _dockerfile()


def test_default_command_still_starts_the_hosted_runtime() -> None:
    """docker-compose builds this image for the hosted mock; its default must not change."""
    assert 'CMD ["serve"]' in _dockerfile()


def test_the_bundle_mount_point_exists_and_is_the_default() -> None:
    dockerfile = _dockerfile()

    assert "mkdir -p /app /bundle" in dockerfile
    assert "chown mock:mock /app /bundle" in dockerfile
    assert f"APIOME_MOCK_BUNDLE={CONTAINER_BUNDLE_PATH}" in dockerfile


def test_the_container_binds_all_interfaces_by_default() -> None:
    """127.0.0.1 inside a container is unreachable from the host."""
    assert "APIOME_MOCK_HTTP_HOST=0.0.0.0" in _dockerfile()


def test_the_healthcheck_polls_the_liveness_endpoint() -> None:
    dockerfile = _dockerfile()

    assert "HEALTHCHECK" in dockerfile
    assert HEALTH_PATH in dockerfile


def test_the_image_runs_as_an_unprivileged_user() -> None:
    assert "USER mock" in _dockerfile()


def test_the_build_script_targets_every_supported_architecture() -> None:
    script = BUILD_SCRIPT.read_text(encoding="utf-8")
    default = re.search(r"PLATFORMS:-([^}]+)}", script)

    assert default is not None
    for platform in SUPPORTED_PLATFORMS:
        assert platform in default.group(1)
    assert "docker buildx build" in script
    assert "--platform" in script


def test_the_build_script_is_executable() -> None:
    assert BUILD_SCRIPT.stat().st_mode & stat.S_IXUSR


def test_the_documented_run_command_matches_the_image_contract() -> None:
    """The Dockerfile header is the first thing a reader copies; keep it true."""
    dockerfile = _dockerfile()

    assert f"{CONTAINER_BUNDLE_PATH}:ro" in dockerfile
    assert "apiome-mock conformance --base-url" in dockerfile
