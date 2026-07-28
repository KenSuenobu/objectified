"""Launch planning for ``apiome mock run`` (#4742, PMR-1.2).

``apiome mock run`` does not reimplement the mock. It *launches* the portable runtime — either the
``apiome-mock`` executable on ``PATH`` or the official container image — so that a laptop, a CI
job, and a container all execute the very same runtime and therefore pass the very same mock
conformance corpus. Reimplementing any part of it here would be the one sure way to break that.

Everything the command does is expressed as a :class:`MockRunPlan`: an argv plus the URL the mock
will answer on. Building the plan is pure, which is what makes ``--dry-run`` a faithful preview of
what would run rather than an approximation of it.

The bundle signing secret is never placed on a command line. When ``APIOME_MOCK_BUNDLE_SECRET`` is
set in the caller's environment the local runtime inherits it, and the Docker plan forwards it by
*name* (``-e APIOME_MOCK_BUNDLE_SECRET``), which passes the value through the daemon without it
ever appearing in ``ps`` output or shell history.
"""

from __future__ import annotations

import json
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

__all__ = [
    "CONTAINER_BUNDLE_PATH",
    "DEFAULT_IMAGE",
    "SECRET_ENV_VAR",
    "MockRunPlan",
    "MockRuntimeUnavailableError",
    "build_run_plan",
    "read_bundle_mount",
]

#: Image used when ``--runtime docker`` is selected without an explicit ``--image``.
DEFAULT_IMAGE = "ghcr.io/apiome/apiome-mock:latest"

#: Where the bundle is mounted inside the container (matches the image's ``APIOME_MOCK_BUNDLE``).
CONTAINER_BUNDLE_PATH = "/bundle/mock-bundle.json"

#: Environment variable carrying the shared HMAC secret; forwarded by name, never by value.
SECRET_ENV_VAR = "APIOME_MOCK_BUNDLE_SECRET"

#: Executable name of the portable runtime when it is installed locally.
LOCAL_EXECUTABLE = "apiome-mock"

RuntimeChoice = Literal["auto", "local", "docker"]


class MockRuntimeUnavailableError(RuntimeError):
    """No runtime could be selected: neither ``apiome-mock`` nor ``docker`` is available."""


@dataclass(frozen=True)
class MockRunPlan:
    """Exactly what ``apiome mock run`` will execute.

    Attributes:
        runtime: Which runtime was selected — ``"local"`` (the ``apiome-mock`` executable) or
            ``"docker"`` (the official image).
        argv: The command to execute, ready for :func:`subprocess.call`.
        base_url: The URL the mock will answer on once it is ready.
        mount: The path prefix the spec is served under, appended to ``base_url``.
        image: The container image, when ``runtime`` is ``"docker"``.
        forwards_secret: True when the plan passes ``APIOME_MOCK_BUNDLE_SECRET`` through.
    """

    runtime: Literal["local", "docker"]
    argv: tuple[str, ...]
    base_url: str
    mount: str
    image: str | None = None
    forwards_secret: bool = False

    @property
    def command(self) -> str:
        """The argv rendered as a copy-pasteable single line (quoted where a shell would need it)."""
        return shlex.join(self.argv)

    def as_dict(self) -> dict[str, Any]:
        """Render the plan for ``--json`` output."""
        return {
            "runtime": self.runtime,
            "command": list(self.argv),
            "baseUrl": self.base_url,
            "mount": self.mount,
            "image": self.image,
            "forwardsSecret": self.forwards_secret,
        }


def read_bundle_mount(bundle: Path) -> str:
    """Read the path prefix a bundle will be served under, for the URL shown to the user.

    Only the manifest's API coordinates are read, and nothing is validated: verifying digests and
    signatures is the runtime's job, and it will refuse to start if the bundle is bad. This is
    presentation only, so an unreadable or unexpected document yields ``""`` rather than an error
    that would pre-empt the runtime's much better diagnostics.

    Args:
        bundle: Path to the bundle document.

    Returns:
        ``/{tenant}/{project}/{version}``, or ``""`` when the coordinates cannot be read.
    """
    try:
        document = json.loads(bundle.read_text(encoding="utf-8"))
        api = document["manifest"]["api"]
        tenant, project, version = api["tenant"], api["project"], api["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return ""
    if not (tenant and project and version):
        return ""
    return f"/{tenant}/{project}/{version}"


def _select_runtime(
    requested: RuntimeChoice,
    *,
    which: Callable[[str], str | None],
) -> Literal["local", "docker"]:
    """Resolve ``--runtime auto`` against what is actually installed.

    Local is preferred when available: it starts faster, needs no image pull, and reads the bundle
    straight off the filesystem.

    Args:
        requested: The ``--runtime`` value.
        which: Executable lookup (injected so the choice is testable without touching ``PATH``).

    Returns:
        The concrete runtime to use.

    Raises:
        MockRuntimeUnavailableError: The requested runtime — or, for ``auto``, any runtime — is
            not installed.
    """
    if requested == "local":
        if which(LOCAL_EXECUTABLE) is None:
            raise MockRuntimeUnavailableError(
                f"'{LOCAL_EXECUTABLE}' is not on PATH. Install the apiome-mock package, "
                "or use --runtime docker."
            )
        return "local"
    if requested == "docker":
        if which("docker") is None:
            raise MockRuntimeUnavailableError("'docker' is not on PATH.")
        return "docker"
    if which(LOCAL_EXECUTABLE) is not None:
        return "local"
    if which("docker") is not None:
        return "docker"
    raise MockRuntimeUnavailableError(
        f"Neither '{LOCAL_EXECUTABLE}' nor 'docker' is on PATH; one of them is needed to run a "
        "mock bundle."
    )


def _runtime_flags(
    *,
    base_path: str,
    require_signature: bool,
    log_level: str | None,
) -> list[str]:
    """Build the runtime flags shared by both plans (they take the identical CLI surface)."""
    flags = ["--base-path", base_path]
    if require_signature:
        flags.append("--require-signature")
    if log_level:
        flags.extend(["--log-level", log_level])
    return flags


def build_run_plan(
    bundle: Path,
    *,
    host: str,
    port: int,
    runtime: RuntimeChoice = "auto",
    image: str | None = None,
    base_path: str = "version",
    require_signature: bool = False,
    log_level: str | None = None,
    mount: str = "",
    secret_present: bool = False,
    which: Callable[[str], str | None] | None = None,
) -> MockRunPlan:
    """Build the command that runs a mock bundle.

    Args:
        bundle: Path to the bundle to serve; resolved to an absolute path so a container bind
            mount and a local run refer to the same file.
        host: Address to publish the mock on locally.
        port: Port to publish the mock on locally (also the container's internal port, so the
            URL a user sees is the URL the runtime logs).
        runtime: ``"auto"``, ``"local"``, or ``"docker"``.
        image: Container image for the Docker plan; defaults to :data:`DEFAULT_IMAGE`.
        base_path: ``"version"`` or ``"root"`` — the runtime's ``--base-path``.
        require_signature: Pass ``--require-signature`` to the runtime.
        log_level: Runtime log level, or ``None`` to leave the runtime's default.
        mount: Path prefix the spec will be served under, used to build the reported URL.
        secret_present: Whether ``APIOME_MOCK_BUNDLE_SECRET`` is set in the caller's environment.
        which: Executable lookup; ``None`` resolves :func:`shutil.which` at call time.

    Returns:
        The plan to execute.

    Raises:
        MockRuntimeUnavailableError: No usable runtime is installed.
    """
    selected = _select_runtime(runtime, which=which or shutil.which)
    absolute = bundle.expanduser().resolve()
    flags = _runtime_flags(
        base_path=base_path,
        require_signature=require_signature,
        log_level=log_level,
    )
    base_url = f"http://{host}:{port}"

    if selected == "local":
        argv = [
            LOCAL_EXECUTABLE,
            "run",
            "--bundle",
            str(absolute),
            "--host",
            host,
            "--port",
            str(port),
            *flags,
        ]
        # The child process inherits the environment, so a configured secret needs no forwarding.
        return MockRunPlan(
            runtime="local",
            argv=tuple(argv),
            base_url=base_url,
            mount=mount,
            forwards_secret=secret_present,
        )

    selected_image = image or DEFAULT_IMAGE
    docker_argv = [
        "docker",
        "run",
        "--rm",
        "--init",
        "--publish",
        f"{host}:{port}:{port}",
        "--volume",
        f"{absolute}:{CONTAINER_BUNDLE_PATH}:ro",
    ]
    if secret_present:
        docker_argv.extend(["--env", SECRET_ENV_VAR])
    docker_argv.extend(
        [
            selected_image,
            "run",
            "--bundle",
            CONTAINER_BUNDLE_PATH,
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
            *flags,
        ]
    )
    return MockRunPlan(
        runtime="docker",
        argv=tuple(docker_argv),
        base_url=base_url,
        mount=mount,
        image=selected_image,
        forwards_secret=secret_present,
    )
