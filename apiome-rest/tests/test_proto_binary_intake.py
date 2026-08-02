"""Binary descriptor-set / buf-image intake tests — IXH-7.5 (#5130).

Real gRPC deployments distribute a serialized ``FileDescriptorSet`` (or a buf image)
rather than a ``.proto`` source tree. These tests cover the whole binary seam:

* the read-layer recognizers (:func:`app.proto_descriptor.sniff_file_descriptor_set`,
  :func:`app.proto_descriptor.descriptor_set_looks_truncated`,
  :func:`app.proto_descriptor.is_descriptor_set_filename`);
* the adapter seam (``GrpcImportSource.accepts_bytes`` / ``parse_bytes`` and its
  taxonomy codes, plus binary-aware ``detect`` and the Connect-RPC delegation);
* registry-level format detection over undecoded bytes;
* the intake pipeline dispatch (``run_adapter_import_job`` routing binary payloads to
  ``parse_bytes`` under the IXH-6.5 size/time guards, with taxonomy codes — not
  encoding faults — on failure);
* the **paired corpus contract**: the descriptor-set and buf-image fixtures compiled
  from ``protobuf/07-inventory-source.proto`` import to the same canonical model as
  the source itself (the source side needs the bundled ``buf``, so that pairing is
  tool-gated like every other compile test).

Decoding a descriptor set is pure :mod:`google.protobuf` — most tests here need no
``buf`` and use synthetic descriptor sets built with ``descriptor_pb2``.
"""

from __future__ import annotations

import base64
import dataclasses
from unittest.mock import patch

import pytest
from corpus_adapter_support import (
    adapter_for,
    detection_input_for,
    is_binary_entry,
    missing_tools,
    parse_native,
)
from corpus_loader import load_corpus, unique_corpus_entry
from google.protobuf import descriptor_pb2

from app.canonical_model import CanonicalApi
from app.connectrpc_import_source import ConnectRpcImportSource
from app.format_detection import detect_format
from app.grpc_import_source import GrpcImportSource
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    load_builtin_import_sources,
)
from app.import_source_pipeline import run_adapter_import_job
from app.proto_descriptor import (
    CompiledDescriptorSet,
    descriptor_set_looks_truncated,
    is_descriptor_set_filename,
    sniff_file_descriptor_set,
)

load_builtin_import_sources()

_FD = descriptor_pb2.FieldDescriptorProto


# ===========================================================================
# Synthetic descriptor set (no buf needed)
# ===========================================================================


def _inventory_descriptor_set() -> descriptor_pb2.FileDescriptorSet:
    """A single-file proto3 descriptor set: an ``inv.v1`` service + item message."""
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "inventory.proto"
    f.package = "inv.v1"
    f.syntax = "proto3"

    item = f.message_type.add()
    item.name = "Item"
    field = item.field.add()
    field.name = "sku"
    field.number = 1
    field.type = _FD.TYPE_STRING
    field.label = _FD.LABEL_OPTIONAL

    svc = f.service.add()
    svc.name = "InventoryService"
    method = svc.method.add()
    method.name = "GetItem"
    method.input_type = ".inv.v1.Item"
    method.output_type = ".inv.v1.Item"
    return fds


@pytest.fixture(scope="module")
def blob() -> bytes:
    return _inventory_descriptor_set().SerializeToString()


#: Bytes whose outer wire framing is length-consistent but whose file entries are not
#: parseable ``FileDescriptorProto`` messages — malformed, not truncated.
_GARBAGE = b"\x0a\x10" + b"\xff" * 16 + b"\x0a\x08notproto"


# ===========================================================================
# Read-layer recognizers
# ===========================================================================


class TestSniffFileDescriptorSet:
    def test_recognizes_serialized_set(self, blob: bytes) -> None:
        assert sniff_file_descriptor_set(blob) is True

    def test_rejects_proto_source_text(self) -> None:
        assert sniff_file_descriptor_set(b'syntax = "proto3"; message M {}') is False

    def test_rejects_garbage_and_short_and_empty(self) -> None:
        assert sniff_file_descriptor_set(_GARBAGE) is False
        assert sniff_file_descriptor_set(b"\x0a\x01") is False
        assert sniff_file_descriptor_set(b"") is False

    def test_rejects_set_with_unnamed_file(self) -> None:
        fds = descriptor_pb2.FileDescriptorSet()
        f = fds.file.add()
        f.package = "unnamed.v1"  # a real compiler always records file names
        assert sniff_file_descriptor_set(fds.SerializeToString()) is False


class TestTruncationWalk:
    def test_intact_bytes_are_not_truncated(self, blob: bytes) -> None:
        assert descriptor_set_looks_truncated(blob) is False

    def test_cut_mid_element_is_truncated(self, blob: bytes) -> None:
        assert descriptor_set_looks_truncated(blob[: len(blob) // 2]) is True

    def test_cut_mid_length_varint_is_truncated(self) -> None:
        # A tag byte followed by an unterminated varint (continuation bit set at EOF).
        assert descriptor_set_looks_truncated(b"\x0a\x80") is True

    def test_length_consistent_garbage_is_not_truncated(self) -> None:
        assert descriptor_set_looks_truncated(_GARBAGE) is False

    def test_empty_is_not_truncated(self) -> None:
        assert descriptor_set_looks_truncated(b"") is False


def test_is_descriptor_set_filename() -> None:
    assert is_descriptor_set_filename("api.binpb") is True
    assert is_descriptor_set_filename("API.DESC") is True
    assert is_descriptor_set_filename("svc.protoset") is True
    assert is_descriptor_set_filename("api.proto") is False
    assert is_descriptor_set_filename("") is False
    assert is_descriptor_set_filename(None) is False


# ===========================================================================
# Adapter seam — detect / accepts_bytes / parse_bytes
# ===========================================================================


class TestAdapterBinarySeam:
    def test_detect_claims_descriptor_bytes_at_high_confidence(self, blob: bytes) -> None:
        result = GrpcImportSource().detect(DetectionInput(data=blob))
        assert result.matched
        assert result.format == "protobuf"
        assert result.confidence >= 0.9

    def test_detect_claims_descriptor_filename_weakly(self) -> None:
        result = GrpcImportSource().detect(DetectionInput(filename="api.binpb"))
        assert result.matched
        assert 0.0 < result.confidence < 0.9

    def test_detect_still_prefers_proto_source_markers(self) -> None:
        result = GrpcImportSource().detect(DetectionInput(text='syntax = "proto3";'))
        assert result.confidence >= 0.95

    def test_accepts_bytes_by_content_or_suffix(self, blob: bytes) -> None:
        adapter = GrpcImportSource()
        assert adapter.accepts_bytes(blob) is True
        # A conventional suffix claims even malformed bytes, so the failure is
        # reported with a descriptor-specific taxonomy code.
        assert adapter.accepts_bytes(_GARBAGE, filename="broken.binpb") is True
        assert adapter.accepts_bytes(_GARBAGE) is False
        assert adapter.accepts_bytes(b'syntax = "proto3";') is False

    def test_parse_bytes_decodes_without_buf(self, blob: bytes) -> None:
        compiled = GrpcImportSource().parse_bytes(blob, source_label="api.binpb")
        assert isinstance(compiled, CompiledDescriptorSet)
        assert [f.name for f in compiled.files] == ["inventory.proto"]
        assert compiled.summary.service_count == 1
        assert compiled.descriptor_set_bytes == blob

    def test_parse_bytes_then_normalize_yields_canonical_model(self, blob: bytes) -> None:
        adapter = GrpcImportSource()
        model = adapter.normalize(adapter.parse_bytes(blob))
        assert isinstance(model, CanonicalApi)
        assert [s.name for s in model.services] == ["InventoryService"]

    @pytest.mark.parametrize(
        ("payload", "code"),
        [
            (b"", "INPUT_EMPTY"),
            (_GARBAGE, "INPUT_MALFORMED"),
        ],
        ids=["empty", "garbage"],
    )
    def test_parse_bytes_failure_codes(self, payload: bytes, code: str) -> None:
        with pytest.raises(ImportSourceError) as excinfo:
            GrpcImportSource().parse_bytes(payload, source_label="bad.binpb")
        assert excinfo.value.code == code

    def test_parse_bytes_truncated_code(self, blob: bytes) -> None:
        with pytest.raises(ImportSourceError) as excinfo:
            GrpcImportSource().parse_bytes(blob[: len(blob) // 2], source_label="cut.binpb")
        assert excinfo.value.code == "INPUT_TRUNCATED"

    def test_connectrpc_delegates_binary_seam(self, blob: bytes) -> None:
        adapter = ConnectRpcImportSource()
        assert adapter.accepts_bytes(blob) is True
        model = adapter.normalize(adapter.parse_bytes(blob))
        assert model.format == "connectrpc"
        assert [s.name for s in model.services] == ["InventoryService"]


def test_registry_detection_routes_descriptor_bytes_to_grpc(blob: bytes) -> None:
    detection = detect_format(
        DetectionInput(
            text=blob.decode("utf-8", errors="replace"), data=blob, filename="api.binpb"
        )
    )
    best = detection.detected
    assert best is not None
    assert best.format == "protobuf"
    assert best.source_key == "grpc"
    assert best.confidence >= 0.9


# ===========================================================================
# Pipeline dispatch — run_adapter_import_job over binary payloads
# ===========================================================================


def _binary_payload(raw: bytes, *, filename: str = "inventory.binpb") -> dict:
    """Worker-style payload carrying raw binary bytes, dry-run so nothing persists."""
    return {
        "rest_job_id": "binary-intake-test",
        "metadata": {
            "source_kind": "grpc",
            "project": {"name": "Inventory", "slug": "inventory"},
            "version": {"version_id": "1.0.0"},
            "options": {"dry_run": True},
        },
        "document_base64": base64.standard_b64encode(raw).decode("ascii"),
        "filename": filename,
    }


async def test_pipeline_imports_binary_descriptor_set(blob: bytes) -> None:
    final = await run_adapter_import_job(GrpcImportSource(), _binary_payload(blob))
    assert final.state == "completed", (final.error and final.error.message)
    assert any(e.code == "PARSE_OK" for e in final.events)


async def test_pipeline_routes_by_content_without_filename_hint(blob: bytes) -> None:
    # No .binpb suffix: the byte sniff alone must route to the binary seam.
    final = await run_adapter_import_job(
        GrpcImportSource(), _binary_payload(blob, filename="upload.bin")
    )
    assert final.state == "completed", (final.error and final.error.message)


@pytest.mark.parametrize(
    ("raw_fn", "filename", "code"),
    [
        (lambda blob: blob[: len(blob) // 2], "cut.binpb", "INPUT_TRUNCATED"),
        (lambda blob: _GARBAGE, "garbage.binpb", "INPUT_MALFORMED"),
    ],
    ids=["truncated", "malformed"],
)
async def test_pipeline_binary_failures_carry_taxonomy_codes(
    blob: bytes, raw_fn, filename: str, code: str
) -> None:
    # The decoded form of these payloads is mojibake; the binary path must report the
    # descriptor-specific code, never INPUT_ENCODING_INVALID.
    final = await run_adapter_import_job(
        GrpcImportSource(), _binary_payload(raw_fn(blob), filename=filename)
    )
    assert final.state == "failed"
    assert final.error is not None
    assert final.error.code == code


async def test_pipeline_binary_intake_respects_size_guard(blob: bytes) -> None:
    # IXH-6.5: the raw-bytes ceiling applies before the binary parse ever runs.
    from app.intake_resource_guard import resolve_guard_profile

    profile = resolve_guard_profile()
    tight = dataclasses.replace(
        profile,
        limits=dataclasses.replace(profile.limits, max_raw_bytes=8),
    )
    with patch("app.import_source_pipeline.resolve_guard_profile", return_value=tight):
        final = await run_adapter_import_job(GrpcImportSource(), _binary_payload(blob))
    assert final.state == "failed"
    assert final.error is not None
    assert final.error.code == "INPUT_TOO_LARGE"


# ===========================================================================
# Paired corpus contract — source tree vs descriptor set vs buf image
# ===========================================================================


def _pair_entry(feature: str):
    return unique_corpus_entry(format="protobuf", features=("binary-pair", feature))


def test_paired_corpus_entries_exist_and_are_shaped_as_declared() -> None:
    source = _pair_entry("binary-pair-source")
    fds = _pair_entry("binary-pair-descriptor-set")
    image = _pair_entry("binary-pair-buf-image")
    assert not is_binary_entry(source)
    assert is_binary_entry(fds)
    assert is_binary_entry(image)
    assert {e.adapter_key for e in (source, fds, image)} == {"grpc"}


def test_binary_pair_fixtures_decode_and_are_claimed() -> None:
    for feature in ("binary-pair-descriptor-set", "binary-pair-buf-image"):
        entry = _pair_entry(feature)
        adapter = adapter_for(entry)
        detection = adapter.detect(detection_input_for(entry))
        assert detection.matched and detection.confidence >= 0.9, entry.path
        compiled = parse_native(adapter, entry)
        assert isinstance(compiled, CompiledDescriptorSet), entry.path
        assert compiled.summary.service_count == 1, entry.path


@pytest.mark.skipif(
    bool(missing_tools("grpc")), reason="bundled buf not resolvable in this environment"
)
def test_descriptor_set_and_buf_image_match_source_tree_canonical_model() -> None:
    """IXH-7.5 acceptance: all three pair members import to the same canonical model."""
    models: dict[str, CanonicalApi] = {}
    for feature in (
        "binary-pair-source",
        "binary-pair-descriptor-set",
        "binary-pair-buf-image",
    ):
        entry = _pair_entry(feature)
        adapter = adapter_for(entry)
        models[feature] = adapter.normalize(parse_native(adapter, entry))

    reference = models["binary-pair-source"]
    reference_payload = reference.model_dump(mode="json", exclude={"raw"})
    reference_fingerprint = canonical_fingerprint(reference)
    for feature, model in models.items():
        assert model.model_dump(mode="json", exclude={"raw"}) == reference_payload, (
            f"{feature}: canonical model differs from the source tree's"
        )
        assert canonical_fingerprint(model) == reference_fingerprint, feature


def test_negative_binary_corpus_entries_declare_descriptor_codes() -> None:
    entries = [
        e
        for e in load_corpus(format="protobuf")
        if is_binary_entry(e) and e.validity_class.value == "invalid"
    ]
    assert {e.expected_error_code for e in entries} == {
        "INPUT_TRUNCATED",
        "INPUT_MALFORMED",
    }
