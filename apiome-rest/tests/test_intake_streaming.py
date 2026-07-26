"""Streaming intake and archive compression-ratio tests — IXH-6.5 (#5124)."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from app.archive_intake import ArchiveIntakeError, ArchivePolicy, unpack_archive
from app.intake_resource_guard import IntakeLimitError, IntakeLimits
from app.intake_streaming import (
    cleanup_intake_tempfile,
    stream_upload_to_tempfile,
    write_bytes_to_tempfile,
)


@pytest.mark.asyncio
async def test_stream_upload_rejects_over_ceiling():
    tight = IntakeLimits(max_bytes=64, max_alias_cost=10, max_depth=8)

    async def chunks():
        yield b"x" * 40
        yield b"y" * 40

    with pytest.raises(IntakeLimitError) as excinfo:
        await stream_upload_to_tempfile(chunks(), limits=tight, source_label="big.bin")
    assert excinfo.value.code == "INPUT_TOO_LARGE"
    assert excinfo.value.limit_name == "max_raw_bytes"


@pytest.mark.asyncio
async def test_stream_upload_writes_tempfile():
    tight = IntakeLimits(max_bytes=1024, max_alias_cost=10, max_depth=8)

    async def chunks():
        yield b"hello "
        yield b"world"

    path, size = await stream_upload_to_tempfile(chunks(), limits=tight)
    try:
        assert size == 11
        assert Path(path).read_bytes() == b"hello world"
    finally:
        cleanup_intake_tempfile(path)


def test_write_bytes_to_tempfile_avoids_base64_payload():
    tight = IntakeLimits(max_bytes=1024, max_alias_cost=10, max_depth=8)
    path, size = write_bytes_to_tempfile(b"spec-bytes", limits=tight)
    try:
        assert size == 10
        assert Path(path).read_bytes() == b"spec-bytes"
    finally:
        cleanup_intake_tempfile(path)


def test_archive_compression_ratio_trips():
    """A tiny zip whose members expand past the ratio ceiling is refused."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("root.json", '{"pad":"' + ("x" * 2000) + '"}')
    raw = buf.getvalue()
    assert len(raw) < 500  # highly compressible
    policy = ArchivePolicy(
        max_entries=10,
        max_total_bytes=10_000_000,
        max_file_bytes=10_000_000,
        max_depth=8,
        max_compression_ratio=2.0,
    )
    with pytest.raises(ArchiveIntakeError) as excinfo:
        unpack_archive(raw, source_label="bomb.zip", policy=policy)
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"
    assert "archive_max_compression_ratio=" in str(excinfo.value)
