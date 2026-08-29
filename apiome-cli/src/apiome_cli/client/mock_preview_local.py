"""Offline preview: render one request against a bundle, with no control plane (#5530, MSC-1.4).

``apiome mock preview --bundle …`` answers the same question as the hosted preview and answers it
the same way — by handing the request to the portable runtime. It does that the way ``apiome mock
run`` already does: it *launches* the runtime (the ``apiome-mock`` executable on ``PATH``, or the
official container image) rather than importing or reimplementing any part of it. That is what
guarantees the two paths agree: there is one renderer, and this module only decides how to reach
it.

The synthetic request travels on the child's **standard input**, never on its command line. A
preview request routinely carries headers — an ``Authorization`` value while reproducing a report,
say — and argv is visible to every process on the machine and is recorded in shell history.
"""

from __future__ import annotations

import json
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

from apiome_cli.client.mock_run import (
    CONTAINER_BUNDLE_PATH,
    DEFAULT_IMAGE,
    LOCAL_EXECUTABLE,
    SECRET_ENV_VAR,
    RuntimeChoice,
    select_runtime,
)

__all__ = [
    "DOCKER_TIMEOUT_SECONDS",
    "LOCAL_TIMEOUT_SECONDS",
    "MockPreviewPlan",
    "OfflinePreviewError",
    "build_preview_plan",
    "run_preview_plan",
]

#: How long to wait for a local render. A preview is one request against an in-memory spec, so a
#: minute is generous; the bound exists so a wedged runtime fails loudly instead of hanging.
LOCAL_TIMEOUT_SECONDS = 60.0

#: How long to wait for a container render. Far longer than the render needs, because the first
#: ``docker run`` of an image also pulls it.
DOCKER_TIMEOUT_SECONDS = 600.0


class OfflinePreviewError(RuntimeError):
    """The portable runtime could not render the preview, or answered unintelligibly."""


@dataclass(frozen=True)
class MockPreviewPlan:
    """Exactly what ``apiome mock preview --bundle`` will execute.

    Attributes:
        runtime: ``"local"`` (the ``apiome-mock`` executable) or ``"docker"`` (the official image).
        argv: The command to execute; the request document goes to its standard input.
        image: The container image, when ``runtime`` is ``"docker"``.
        forwards_secret: True when the plan passes ``APIOME_MOCK_BUNDLE_SECRET`` through.
    """

    runtime: Literal["local", "docker"]
    argv: tuple[str, ...]
    image: str | None = None
    forwards_secret: bool = False

    @property
    def timeout_seconds(self) -> float:
        """How long to wait for this plan's runtime to answer."""
        return DOCKER_TIMEOUT_SECONDS if self.runtime == "docker" else LOCAL_TIMEOUT_SECONDS

    @property
    def command(self) -> str:
        """The argv rendered as a copy-pasteable single line."""
        return shlex.join(self.argv)

    def as_dict(self) -> dict[str, Any]:
        """Render the plan for ``--json`` output."""
        return {
            "runtime": self.runtime,
            "command": list(self.argv),
            "image": self.image,
            "forwardsSecret": self.forwards_secret,
        }


def build_preview_plan(
    bundle: Path,
    *,
    runtime: RuntimeChoice = "auto",
    image: str | None = None,
    require_signature: bool = False,
    secret_present: bool = False,
    which: Callable[[str], str | None] | None = None,
) -> MockPreviewPlan:
    """Build the command that renders one preview against a bundle.

    Args:
        bundle: Path to the bundle; resolved to an absolute path so a container bind mount and a
            local run refer to the same file.
        runtime: ``"auto"``, ``"local"``, or ``"docker"``.
        image: Container image for the Docker plan; defaults to the official image.
        require_signature: Refuse an unsigned bundle.
        secret_present: Whether ``APIOME_MOCK_BUNDLE_SECRET`` is set in the caller's environment.
        which: Executable lookup; ``None`` resolves :func:`shutil.which` at call time.

    Returns:
        The plan to execute.

    Raises:
        MockRuntimeUnavailableError: No usable runtime is installed.
    """
    selected = select_runtime(runtime, which=which or shutil.which)
    absolute = bundle.expanduser().resolve()
    flags = ["--request-file", "-", "--json"]
    if require_signature:
        flags.append("--require-signature")

    if selected == "local":
        return MockPreviewPlan(
            runtime="local",
            argv=(LOCAL_EXECUTABLE, "preview", "--bundle", str(absolute), *flags),
            # The child inherits the environment, so a configured secret needs no forwarding.
            forwards_secret=secret_present,
        )

    selected_image = image or DEFAULT_IMAGE
    argv = [
        "docker",
        "run",
        "--rm",
        # -i, because the request document is written to the container's standard input.
        "--interactive",
        "--volume",
        f"{absolute}:{CONTAINER_BUNDLE_PATH}:ro",
    ]
    if secret_present:
        argv.extend(["--env", SECRET_ENV_VAR])
    argv.extend([selected_image, "preview", "--bundle", CONTAINER_BUNDLE_PATH, *flags])
    return MockPreviewPlan(
        runtime="docker",
        argv=tuple(argv),
        image=selected_image,
        forwards_secret=secret_present,
    )


def run_preview_plan(
    plan: MockPreviewPlan,
    request: Mapping[str, Any],
    *,
    run: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> dict[str, Any]:
    """Execute a preview plan and return the runtime's result.

    Args:
        plan: The plan from :func:`build_preview_plan`.
        request: The synthetic request document, written to the child's standard input.
        run: Process runner, injected for tests; ``None`` uses :func:`subprocess.run`.

    Returns:
        The runtime's preview result — the same object shape the hosted preview endpoint returns.

    Raises:
        OfflinePreviewError: The runtime could not be launched, refused the bundle or the request,
            or printed something that is not a preview result. Its own message is preserved,
            because it is a far better diagnostic than anything this side could synthesize.
    """
    runner = run or subprocess.run
    try:
        completed = runner(
            list(plan.argv),
            input=json.dumps(dict(request)),
            capture_output=True,
            text=True,
            timeout=plan.timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise OfflinePreviewError(f"Failed to launch {plan.argv[0]}: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise OfflinePreviewError(
            f"{plan.argv[0]} did not answer within {plan.timeout_seconds:.0f}s."
        ) from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise OfflinePreviewError(detail or f"{plan.argv[0]} exited with status {completed.returncode}.")

    try:
        payload = json.loads(completed.stdout)
    except ValueError as exc:
        raise OfflinePreviewError(f"{plan.argv[0]} did not print a preview result.") from exc
    if not isinstance(payload, dict):
        raise OfflinePreviewError(f"{plan.argv[0]} printed an unexpected preview shape.")
    return payload
