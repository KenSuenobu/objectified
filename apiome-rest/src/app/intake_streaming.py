"""Streaming multipart intake to bounded temporary storage — IXH-6.5 (#5124).

Large uploads must not be fully buffered and then base64-doubled in memory.
This module streams an upload into a tempfile, enforcing ``max_raw_bytes`` while
writing, and returns a path the import job can read once.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import AsyncIterator, Optional, Tuple, Union

from .intake_resource_guard import IntakeLimitError, IntakeLimits, effective_intake_limits

__all__ = [
    "cleanup_intake_tempfile",
    "stream_upload_to_tempfile",
    "write_bytes_to_tempfile",
]


async def stream_upload_to_tempfile(
    chunks: AsyncIterator[bytes],
    *,
    max_raw_bytes: Optional[int] = None,
    limits: Optional[IntakeLimits] = None,
    suffix: str = ".upload",
    source_label: Optional[str] = None,
) -> Tuple[str, int]:
    """Stream upload chunks into a tempfile, rejecting mid-stream on overflow.

    Args:
        chunks: Async iterator of body chunks (e.g. ``UploadFile`` spoole).
        max_raw_bytes: Optional explicit ceiling; defaults to the active profile.
        limits: Optional :class:`IntakeLimits` supplying the ceiling.
        suffix: Tempfile suffix (keeps archive extensions recognizable).
        source_label: Optional label for error messages.

    Returns:
        ``(absolute_path, byte_count)`` for the written tempfile.

    Raises:
        IntakeLimitError: ``INPUT_TOO_LARGE`` when the stream exceeds the ceiling.
    """
    bounds = limits or effective_intake_limits()
    ceiling = max_raw_bytes if max_raw_bytes is not None else bounds.effective_raw_bytes()
    fd, path = tempfile.mkstemp(prefix="apiome-intake-", suffix=suffix)
    written = 0
    try:
        with os.fdopen(fd, "wb") as handle:
            async for chunk in chunks:
                if not chunk:
                    continue
                written += len(chunk)
                if written > ceiling:
                    raise IntakeLimitError(
                        f"Upload is too large"
                        f"{f' ({source_label})' if source_label else ''}: "
                        f"stream exceeded limit max_raw_bytes={ceiling}",
                        code="INPUT_TOO_LARGE",
                        limit_name="max_raw_bytes",
                        limit_value=ceiling,
                    )
                handle.write(chunk)
        return path, written
    except Exception:
        cleanup_intake_tempfile(path)
        raise


def write_bytes_to_tempfile(
    raw: bytes,
    *,
    limits: Optional[IntakeLimits] = None,
    suffix: str = ".upload",
    source_label: Optional[str] = None,
) -> Tuple[str, int]:
    """Write already-buffered bytes to a tempfile under the raw-byte ceiling.

    Used when a caller already holds bytes (e.g. after a quality-gate preflight)
    but the job payload must avoid a second base64 copy.
    """
    bounds = limits or effective_intake_limits()
    ceiling = bounds.effective_raw_bytes()
    if len(raw) > ceiling:
        raise IntakeLimitError(
            f"Upload is too large"
            f"{f' ({source_label})' if source_label else ''}: "
            f"{len(raw)} bytes exceeds limit max_raw_bytes={ceiling}",
            code="INPUT_TOO_LARGE",
            limit_name="max_raw_bytes",
            limit_value=ceiling,
        )
    fd, path = tempfile.mkstemp(prefix="apiome-intake-", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
        return path, len(raw)
    except Exception:
        cleanup_intake_tempfile(path)
        raise


def cleanup_intake_tempfile(path: Union[str, Path, None]) -> None:
    """Best-effort removal of an intake tempfile."""
    if not path:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass
