"""Protobuf ``.proto`` → ``FileDescriptorSet`` compile service — MFI-9.1 (#3764).

Hand-parsing ``.proto`` is fragile: imports, ``option`` inheritance, proto2/proto3 and the
new **Editions** (2023/2024) feature-resolution rules are exactly the kind of thing a real
compiler gets right and a regex does not. The canonical artifact for everything downstream
(canonical-model mapping in MFI-9.2, the descriptor-set fingerprint hook in MFI-3.1, ``buf
lint``/``buf breaking`` in MFI-9.4/9.5) is therefore the **compiled descriptor set**, not the
source text — "compile to a ``FileDescriptorSet`` and hash *that*, not raw ``.proto``".

This module is that compile seam. It has two layers:

* **read layer** — :func:`read_file_descriptor_set` parses the binary ``FileDescriptorSet``
  produced by a compiler with :mod:`google.protobuf.descriptor_pb2` and extracts the facts
  downstream needs (per-file syntax/edition, package, imports, message/enum/service counts,
  which files are pulled-in imports vs. the caller's targets). It is pure and compiler-free,
  so it is exhaustively testable against synthetic descriptors.
* **compile layer** — :func:`compile_proto_descriptor_set` writes the supplied ``.proto``
  files into a scratch module, shells out to **``buf build``** (the bundled ``buf`` tool, via
  the MFI-5.1 toolchain runner) to resolve imports/Editions and emit a
  ``google.protobuf.FileDescriptorSet``, reads that binary back, and hands it to the read
  layer. Multi-file protos with ``import``\\s, and proto3 / Editions 2023 / Editions 2024, are
  all handled by the compiler — we never parse syntax ourselves.

``buf`` writes the descriptor set as a **binary** blob, which the toolchain runner cannot
return as text over stdout (it decodes stdout as UTF-8), so the build is directed to a file in
the scratch directory and the bytes are read back from disk — those bytes are the canonical
artifact the fingerprint hook hashes.

A ``.proto`` that does not compile (syntax error, unresolved import) is an **infrastructure /
input error**, not a return value: there is no descriptor set to inspect, so
:func:`compile_proto_descriptor_set` raises :class:`ProtoCompileError` carrying the compiler's
diagnostics. :class:`ProtoCompileError` also covers the tool being absent (MFI-5.2 packaging),
timing out, or emitting an unreadable descriptor.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from .intake_paths import IntakePathError, validated_intake_path

from google.protobuf import descriptor_pb2
from google.protobuf.message import DecodeError
from pydantic import BaseModel, ConfigDict, Field

from .toolchain_packaging import bundled_tool
from .toolchain_runner import (
    SandboxPolicy,
    ToolchainError,
    ToolchainRunner,
    ToolExecutionError,
    ToolNotAvailableError,
    ToolSpec,
    ToolTimeoutError,
    default_runner,
)

__all__ = [
    "BUF_TOOL_KEY",
    "PROTO_SUPPORTED_SYNTAXES",
    "PROTO_SUPPORTED_EDITIONS",
    "ProtoFile",
    "ProtoFileDescriptor",
    "DescriptorSetSummary",
    "CompiledDescriptorSet",
    "ProtoDescriptorError",
    "ProtoCompileError",
    "read_file_descriptor_set",
    "compile_proto_descriptor_set",
    "materialize_proto_module",
    "BUF_MODULE_YAML",
    "DESCRIPTOR_SET_SUFFIXES",
    "descriptor_set_looks_truncated",
    "is_descriptor_set_filename",
    "sniff_file_descriptor_set",
]


#: Registry key of the bundled ``buf`` tool (declared in :mod:`app.toolchain_packaging`).
BUF_TOOL_KEY = "buf"

#: The proto *syntaxes* MFI-9.1 targets. ``editions`` is the umbrella the per-edition labels
#: (below) live under; ``proto2`` is recognised by the reader but not a first-class import
#: target for the MVP fixtures (proto3 + Editions are).
PROTO_SUPPORTED_SYNTAXES: Tuple[str, ...] = ("proto2", "proto3", "editions")

#: The Protobuf **Editions** the acceptance criteria call out explicitly. The reader maps any
#: edition the compiler emits (see :func:`_edition_label`); this tuple is the documented
#: baseline the fixtures and the ``buf`` runtime are expected to compile.
PROTO_SUPPORTED_EDITIONS: Tuple[str, ...] = ("2023", "2024")

#: Hard ceiling on how many ``.proto`` files one compile may carry, so a hostile request
#: cannot ask us to lay down an unbounded scratch tree before the sandbox caps even apply.
_MAX_PROTO_FILES = 2000

#: Output filename ``buf build`` writes the descriptor set to inside the scratch module. The
#: leading dunder keeps it from colliding with a real ``.proto`` the caller supplied.
_DESCRIPTOR_OUTPUT_NAME = "__apiome_descriptor__.binpb"


# ===========================================================================
# Errors
# ===========================================================================


class ProtoDescriptorError(Exception):
    """A binary ``FileDescriptorSet`` could not be read with ``descriptor_pb2``.

    Raised by :func:`read_file_descriptor_set` when the bytes are not a parseable
    ``google.protobuf.FileDescriptorSet`` (truncated, wrong message, or not protobuf at all).
    """


class ProtoCompileError(Exception):
    """A ``.proto`` set could not be compiled to a descriptor set.

    Covers both *input* failures (a proto with a syntax error or an unresolved ``import`` —
    the compiler exits non-zero with diagnostics) and *infrastructure* failures (the ``buf``
    tool is not installed in this runtime, it timed out, or it produced output we could not
    read). The compiler's diagnostics, when any, are carried in :attr:`diagnostics` so a
    caller (the MFI-9.6 source card / CLI) can surface them verbatim.
    """

    def __init__(self, message: str, *, diagnostics: Optional[str] = None) -> None:
        super().__init__(message)
        #: The compiler's stderr/stdout diagnostics, when the failure produced any.
        self.diagnostics: Optional[str] = diagnostics or None


# ===========================================================================
# Input + result models
# ===========================================================================


class ProtoFile(BaseModel):
    """One ``.proto`` source file handed to the compiler.

    Attributes:
        path: The file's path **relative to the module root**, e.g. ``"acme/user.proto"``.
            This is the path other files ``import`` it by, so it must match the ``import``
            strings exactly. Must be a relative POSIX path ending in ``.proto`` with no ``..``
            traversal and no leading ``/`` (validated by :func:`compile_proto_descriptor_set`).
        content: The raw ``.proto`` source text.
    """

    model_config = ConfigDict(frozen=True)

    path: str = Field(description="Module-root-relative path, e.g. ``acme/user.proto``.")
    content: str = Field(description="Raw ``.proto`` source text.")


class ProtoFileDescriptor(BaseModel):
    """The compiled facts about one file in a ``FileDescriptorSet``.

    Everything here is read straight off the ``FileDescriptorProto`` the compiler produced —
    no source re-parsing — so syntax/edition reflect the compiler's own feature resolution.
    """

    model_config = ConfigDict(frozen=True)

    name: str = Field(description="The file's path within the descriptor set (its import path).")
    package: str = Field(default="", description="The proto ``package`` (empty when unset).")
    syntax: str = Field(description="``proto2`` / ``proto3`` / ``editions``.")
    edition: Optional[str] = Field(
        default=None,
        description="The Edition label (e.g. ``2023``/``2024``) when ``syntax == editions``; "
        "``None`` for proto2/proto3.",
    )
    dependencies: List[str] = Field(
        default_factory=list, description="Import paths this file depends on (``import`` lines)."
    )
    public_dependencies: List[str] = Field(
        default_factory=list,
        description="The subset of ``dependencies`` re-exported via ``import public``.",
    )
    message_count: int = Field(default=0, description="Top-level ``message`` definitions.")
    enum_count: int = Field(default=0, description="Top-level ``enum`` definitions.")
    service_count: int = Field(default=0, description="``service`` definitions (gRPC surfaces).")
    is_import: bool = Field(
        default=False,
        description="True when the file was pulled in to satisfy an import (well-known types, a "
        "transitive dependency) rather than being one of the caller's target files.",
    )


class DescriptorSetSummary(BaseModel):
    """A serializable roll-up of a whole descriptor set — the catalog-facing view."""

    model_config = ConfigDict(frozen=True)

    file_count: int = Field(description="Total files in the descriptor set (targets + imports).")
    target_file_count: int = Field(description="Files that were the caller's compile targets.")
    syntaxes: List[str] = Field(description="Distinct syntaxes present, sorted.")
    editions: List[str] = Field(description="Distinct Edition labels present, sorted.")
    packages: List[str] = Field(description="Distinct non-empty proto packages, sorted.")
    service_count: int = Field(description="Total ``service`` definitions across all files.")
    message_count: int = Field(description="Total top-level ``message`` definitions.")
    enum_count: int = Field(description="Total top-level ``enum`` definitions.")


@dataclass(frozen=True)
class CompiledDescriptorSet:
    """The result of reading (and usually compiling) a ``FileDescriptorSet``.

    Carries three things downstream consumers need:

    * :attr:`descriptor_set_bytes` — the canonical binary artifact, the thing the
      descriptor-set fingerprint hook (MFI-3.1) hashes instead of raw ``.proto``;
    * :attr:`proto` — the parsed ``google.protobuf.FileDescriptorSet`` message, handed to the
      MFI-9.2 canonical-model mapper as-is (no re-parse);
    * :attr:`files` / :attr:`summary` — the extracted, serializable metadata.
    """

    descriptor_set_bytes: bytes
    proto: descriptor_pb2.FileDescriptorSet
    files: Tuple[ProtoFileDescriptor, ...]
    summary: DescriptorSetSummary

    @property
    def target_files(self) -> Tuple[ProtoFileDescriptor, ...]:
        """The caller's target files (imports excluded)."""
        return tuple(f for f in self.files if not f.is_import)


# ===========================================================================
# Read layer — binary FileDescriptorSet → structured metadata (compiler-free)
# ===========================================================================


def _edition_label(edition_value: int) -> Optional[str]:
    """Map a ``FileDescriptorProto.edition`` enum value to a short, human label.

    ``EDITION_2023`` → ``"2023"``, ``EDITION_2024`` → ``"2024"``; the proto2/proto3 sentinel
    editions and ``EDITION_UNKNOWN`` resolve to ``None`` (they are reported via ``syntax``
    instead). An unrecognised value falls back to the lower-cased enum name with the
    ``edition_`` prefix stripped, so a future edition still surfaces something meaningful.
    """
    enum = descriptor_pb2.Edition
    if edition_value in (
        enum.EDITION_UNKNOWN,
        enum.EDITION_PROTO2,
        enum.EDITION_PROTO3,
    ):
        return None
    try:
        name = enum.Name(edition_value)
    except ValueError:  # pragma: no cover - defensive; unknown numeric edition
        return None
    return name[len("EDITION_"):].lower() if name.startswith("EDITION_") else name.lower()


def _syntax_label(file_proto: descriptor_pb2.FileDescriptorProto) -> str:
    """Resolve a file's syntax label.

    A ``FileDescriptorProto`` omits ``syntax`` for proto2 (the default), sets it to
    ``"proto3"`` for proto3, and to ``"editions"`` (with the ``edition`` field populated) for
    an Editions file. Normalise the empty/unknown case to ``"proto2"``.
    """
    syntax = file_proto.syntax or "proto2"
    return syntax


def _descriptor_for_file(
    file_proto: descriptor_pb2.FileDescriptorProto, *, is_import: bool
) -> ProtoFileDescriptor:
    """Extract one :class:`ProtoFileDescriptor` from a ``FileDescriptorProto``."""
    syntax = _syntax_label(file_proto)
    edition = _edition_label(file_proto.edition) if syntax == "editions" else None

    # ``public_dependency`` holds *indices* into the ``dependency`` list; resolve them back to
    # the import paths so the metadata is self-describing.
    deps = list(file_proto.dependency)
    public_deps = [deps[i] for i in file_proto.public_dependency if 0 <= i < len(deps)]

    return ProtoFileDescriptor(
        name=file_proto.name,
        package=file_proto.package,
        syntax=syntax,
        edition=edition,
        dependencies=deps,
        public_dependencies=public_deps,
        message_count=len(file_proto.message_type),
        enum_count=len(file_proto.enum_type),
        service_count=len(file_proto.service),
        is_import=is_import,
    )


def _summarize(files: Sequence[ProtoFileDescriptor]) -> DescriptorSetSummary:
    """Roll up per-file descriptors into a :class:`DescriptorSetSummary`."""
    syntaxes = sorted({f.syntax for f in files})
    editions = sorted({f.edition for f in files if f.edition})
    packages = sorted({f.package for f in files if f.package})
    return DescriptorSetSummary(
        file_count=len(files),
        target_file_count=sum(1 for f in files if not f.is_import),
        syntaxes=syntaxes,
        editions=editions,
        packages=packages,
        service_count=sum(f.service_count for f in files),
        message_count=sum(f.message_count for f in files),
        enum_count=sum(f.enum_count for f in files),
    )


def read_file_descriptor_set(
    data: bytes, *, target_files: Optional[Sequence[str]] = None
) -> CompiledDescriptorSet:
    """Parse a binary ``FileDescriptorSet`` and extract its structured metadata.

    This is the compiler-free half of MFI-9.1: it reads the bytes a compiler produced with
    :mod:`google.protobuf.descriptor_pb2` and never looks at ``.proto`` source. It is reused
    by :func:`compile_proto_descriptor_set` and is directly useful to any caller that already
    has a descriptor set (e.g. one assembled from gRPC server reflection in MFI-9.3).

    Args:
        data: The binary ``google.protobuf.FileDescriptorSet`` blob.
        target_files: The import paths that were the caller's *targets*. Files whose name is
            **not** in this set are flagged :attr:`ProtoFileDescriptor.is_import` (well-known
            types, transitive dependencies the compiler pulled in). When ``None``, every file
            is treated as a target (``is_import`` is ``False`` for all) — appropriate when the
            distinction is unknown.

    Returns:
        A :class:`CompiledDescriptorSet` whose :attr:`~CompiledDescriptorSet.descriptor_set_bytes`
        is ``data`` unchanged.

    Raises:
        ProtoDescriptorError: If ``data`` is not a parseable ``FileDescriptorSet``.
    """
    descriptor_set = descriptor_pb2.FileDescriptorSet()
    try:
        descriptor_set.ParseFromString(data)
    except (DecodeError, ValueError) as exc:
        raise ProtoDescriptorError(
            f"Could not parse a google.protobuf.FileDescriptorSet from {len(data)} bytes: {exc}"
        ) from exc

    targets = set(target_files) if target_files is not None else None
    files = tuple(
        _descriptor_for_file(
            file_proto,
            is_import=(targets is not None and file_proto.name not in targets),
        )
        for file_proto in descriptor_set.file
    )

    return CompiledDescriptorSet(
        descriptor_set_bytes=data,
        proto=descriptor_set,
        files=files,
        summary=_summarize(files),
    )


# ===========================================================================
# Binary-intake recognition — IXH-7.5 (#5130)
# ===========================================================================

#: Filename suffixes that conventionally carry a serialized ``FileDescriptorSet`` (or a buf
#: image, which is a compatible superset): ``.binpb`` (the protobuf binary-wire convention buf
#: itself emits, see :data:`_DESCRIPTOR_OUTPUT_NAME`), ``.desc`` (``protoc --descriptor_set_out``
#: convention), and ``.protoset`` (grpcurl's convention). A file with one of these suffixes is
#: routed to the binary intake path *even when its bytes turn out malformed*, so a broken
#: descriptor set fails with a descriptor-specific taxonomy code instead of an encoding error.
DESCRIPTOR_SET_SUFFIXES: Tuple[str, ...] = (".binpb", ".desc", ".protoset")


def is_descriptor_set_filename(filename: Optional[str]) -> bool:
    """Whether *filename* carries a conventional descriptor-set suffix.

    Args:
        filename: The upload's filename or label (``None``/empty returns ``False``).

    Returns:
        ``True`` when the name ends in one of :data:`DESCRIPTOR_SET_SUFFIXES`.
    """
    if not filename:
        return False
    return filename.lower().endswith(DESCRIPTOR_SET_SUFFIXES)


def sniff_file_descriptor_set(data: bytes) -> bool:
    """Whether *data* parses as a plausible binary ``FileDescriptorSet`` / buf image.

    Used by detection and intake routing, so it must never raise and must reject
    non-protobuf content cheaply: a ``FileDescriptorSet``'s only field is ``repeated
    FileDescriptorProto file = 1`` (wire tag ``0x0A``), so anything not starting with that
    byte is dismissed before the real parse. A buf image is a ``FileDescriptorSet`` with
    extension fields layered onto each file, so it parses (and sniffs) identically.

    Args:
        data: The raw uploaded bytes.

    Returns:
        ``True`` when the bytes decode as a ``FileDescriptorSet`` holding at least one
        *named* file — an empty or nameless set is not evidence of the format.
    """
    if len(data) < 8 or data[0] != 0x0A:
        return False
    descriptor_set = descriptor_pb2.FileDescriptorSet()
    try:
        descriptor_set.ParseFromString(data)
    except (DecodeError, ValueError):
        return False
    files = list(descriptor_set.file)
    return bool(files) and all(file_proto.name for file_proto in files)


def _read_varint(data: bytes, pos: int) -> Optional[Tuple[int, int]]:
    """Read one base-128 varint at *pos*; ``None`` when the buffer ends mid-varint.

    Returns:
        ``(value, next_pos)``, or ``None`` on end-of-buffer truncation. A varint longer
        than 10 bytes is not a truncation signal — it is malformed — and returns the
        overlong value so the caller's wire walk keeps its truncated/malformed distinction.
    """
    result = 0
    shift = 0
    while pos < len(data) and shift <= 63:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result, pos
        shift += 7
    return None if pos >= len(data) else (result, pos)


def descriptor_set_looks_truncated(data: bytes) -> bool:
    """Whether unparseable descriptor-set bytes end mid-element (a truncated upload).

    Walks the *top-level* wire format only: each field is a varint tag followed by a
    varint / fixed-width scalar / length-delimited payload. A buffer that ends inside a
    tag, inside a length varint, or before a declared length completes is truncated — the
    signature of an interrupted download or a partial copy. A walk that completes (or hits
    an invalid wire type) means the bytes are wrong for some *other* reason, and the
    caller should report plain malformation instead.

    Args:
        data: The raw bytes that failed :func:`read_file_descriptor_set`.

    Returns:
        ``True`` when the top-level wire stream is cut off mid-element.
    """
    pos = 0
    while pos < len(data):
        tag = _read_varint(data, pos)
        if tag is None:
            return True
        tag_value, pos = tag
        wire_type = tag_value & 0x07
        if wire_type == 0:  # varint scalar
            value = _read_varint(data, pos)
            if value is None:
                return True
            pos = value[1]
        elif wire_type == 1:  # fixed 64-bit
            if pos + 8 > len(data):
                return True
            pos += 8
        elif wire_type == 2:  # length-delimited
            length = _read_varint(data, pos)
            if length is None:
                return True
            length_value, pos = length
            if pos + length_value > len(data):
                return True
            pos += length_value
        elif wire_type == 5:  # fixed 32-bit
            if pos + 4 > len(data):
                return True
            pos += 4
        else:  # groups (3/4) or reserved wire types: malformed, not truncated
            return False
    return False


# ===========================================================================
# Compile layer — .proto sources → buf build → FileDescriptorSet
# ===========================================================================


def _buf_build_spec() -> ToolSpec:
    """Build the ``buf build`` :class:`ToolSpec` used to emit a ``FileDescriptorSet``.

    Derived from the bundled ``buf`` tool (so the deployment's ``APIOME_BUF_BIN`` override
    and pinned binary still apply), but with ``parses_json=False`` because the descriptor set is
    written as a *binary file* — ``buf build``'s stdout carries no JSON to parse — and a
    ``build`` leading verb so callers only supply the input/output args.
    """
    tool = bundled_tool(BUF_TOOL_KEY)
    executable = tool.executable if tool is not None else "buf"
    env_override_keys = (tool.env_override_key,) if tool is not None else ()
    default_timeout = tool.default_timeout_seconds if tool is not None else 60.0
    return ToolSpec(
        key=BUF_TOOL_KEY,
        executable=executable,
        description="buf build → google.protobuf.FileDescriptorSet (MFI-9.1).",
        base_args=("build",),
        default_timeout_seconds=default_timeout,
        env_override_keys=env_override_keys,
        parses_json=False,
    )


#: Minimal ``buf`` v2 workspace config written into the scratch module so ``buf build`` treats
#: the scratch directory as a single self-contained module and resolves all ``import``\\s
#: against it (no remote dependencies — the sandbox has no network anyway). Exposed as
#: :data:`BUF_MODULE_YAML` so a sibling ``buf`` adapter (e.g. ``buf lint`` in MFI-9.4) can reuse
#: the same materialisation with its own augmented config.
BUF_MODULE_YAML = "version: v2\nmodules:\n  - path: .\n"


def _validated_relative_path(path: str):
    """Validate and normalise a :class:`ProtoFile` path to a safe module-relative POSIX path.

    Raises:
        ProtoCompileError: If the path is empty, absolute, escapes the module root via ``..``,
            or does not end in ``.proto``.
    """
    try:
        return validated_intake_path(
            path,
            required_suffix=".proto",
            label="Proto path",
        )
    except IntakePathError as exc:
        raise ProtoCompileError(str(exc)) from exc


def materialize_proto_module(
    root: str,
    files: Sequence[ProtoFile],
    *,
    buf_yaml: str = BUF_MODULE_YAML,
) -> List[str]:
    """Write every proto into the scratch ``root`` (creating dirs) and the ``buf.yaml``.

    The single ``buf``-module layout both ``buf build`` (MFI-9.1) and ``buf lint`` (MFI-9.4)
    operate on: each validated file is laid down at its module-relative path and a ``buf.yaml``
    is written so ``buf`` treats ``root`` as one self-contained module.

    Args:
        root: The scratch module root directory (already created).
        files: The ``.proto`` files to write, each at its module-relative
            :attr:`ProtoFile.path`.
        buf_yaml: The ``buf.yaml`` body to write. Defaults to the build-only
            :data:`BUF_MODULE_YAML`; the lint adapter passes a config that additionally
            enables its lint categories.

    Returns:
        The list of normalised, module-relative target names (the import paths), in input
        order, for :func:`read_file_descriptor_set` to flag imports against.

    Raises:
        ProtoCompileError: On an unsafe/duplicate path (validation via
            :func:`_validated_relative_path`).
    """
    target_names: List[str] = []
    seen: set[str] = set()
    for proto in files:
        rel = _validated_relative_path(proto.path)
        name = str(rel)
        if name in seen:
            raise ProtoCompileError(f"Duplicate proto path in input: {name!r}")
        seen.add(name)
        target_names.append(name)

        dest = os.path.join(root, *rel.parts)
        os.makedirs(os.path.dirname(dest) or root, exist_ok=True)
        with open(dest, "w", encoding="utf-8") as handle:
            handle.write(proto.content)

    with open(os.path.join(root, "buf.yaml"), "w", encoding="utf-8") as handle:
        handle.write(buf_yaml)

    return target_names


async def compile_proto_descriptor_set(
    files: Sequence[ProtoFile],
    *,
    runner: Optional[ToolchainRunner] = None,
    timeout: Optional[float] = None,
    policy: Optional[SandboxPolicy] = None,
) -> CompiledDescriptorSet:
    """Compile a set of ``.proto`` files to a ``FileDescriptorSet`` via ``buf build``.

    The supplied files are written into a private scratch module, ``buf build`` resolves their
    ``import``\\s and Editions and emits a binary ``google.protobuf.FileDescriptorSet`` (the
    ``--as-file-descriptor-set`` form, imports included so the set is self-contained), and the
    bytes are read back and parsed by :func:`read_file_descriptor_set`. proto3 and Editions
    2023/2024 are all handled by the compiler — this code never parses proto syntax.

    Args:
        files: The ``.proto`` files to compile. Each :attr:`ProtoFile.path` must be the
            module-relative import path other files reference it by. Must be non-empty.
        runner: The toolchain runner to use; defaults to the shared
            :data:`app.toolchain_runner.default_runner`. Injectable for tests.
        timeout: Optional per-call timeout in seconds; falls back to the tool/service default.
        policy: Optional sandbox policy override; falls back to the runner's default
            (no-network + resource caps).

    Returns:
        A :class:`CompiledDescriptorSet` with the canonical descriptor bytes, the parsed
        ``FileDescriptorSet`` message, and per-file/summary metadata (the caller's files
        flagged as targets, everything ``buf`` pulled in flagged as imports).

    Raises:
        ProtoCompileError: If ``files`` is empty/oversized or carries an unsafe path; if
            ``buf`` is not available in this runtime (MFI-5.2), times out, or exits non-zero
            with compile diagnostics (syntax error, unresolved import); or if it produced no
            readable descriptor set.
        ProtoDescriptorError: If ``buf`` produced bytes that are not a parseable
            ``FileDescriptorSet`` (should not happen for a clean ``buf`` run).
    """
    if not files:
        raise ProtoCompileError("At least one .proto file is required to build a descriptor set")
    if len(files) > _MAX_PROTO_FILES:
        raise ProtoCompileError(
            f"Too many .proto files ({len(files)}); the limit is {_MAX_PROTO_FILES}"
        )

    active_runner = runner if runner is not None else default_runner
    spec = _buf_build_spec()

    with tempfile.TemporaryDirectory(prefix="apiome-proto-") as scratch:
        target_names = materialize_proto_module(scratch, files)
        output_path = os.path.join(scratch, _DESCRIPTOR_OUTPUT_NAME)
        args = [scratch, "--as-file-descriptor-set", "--output", output_path]

        try:
            await active_runner.run_spec(spec, args, timeout=timeout, policy=policy)
        except ToolNotAvailableError as exc:
            raise ProtoCompileError(
                "The 'buf' tool is not available in this runtime; protobuf/gRPC import is "
                "unavailable here (see the bundled toolchain packaging, MFI-5.2)."
            ) from exc
        except ToolTimeoutError as exc:
            raise ProtoCompileError(f"buf build timed out: {exc}") from exc
        except ToolExecutionError as exc:
            # The proto did not compile (syntax error / unresolved import). buf writes the
            # diagnostics to stderr; surface them so the caller can show the author.
            diagnostics = (exc.stderr.strip() or exc.stdout.strip()) or None
            raise ProtoCompileError(
                "buf build failed to compile the supplied .proto files",
                diagnostics=diagnostics,
            ) from exc
        except ToolchainError as exc:
            raise ProtoCompileError(f"buf build failed: {exc}") from exc

        try:
            with open(output_path, "rb") as handle:
                descriptor_bytes = handle.read()
        except OSError as exc:
            raise ProtoCompileError(
                "buf build reported success but wrote no descriptor set"
            ) from exc

    if not descriptor_bytes:
        raise ProtoCompileError("buf build produced an empty descriptor set")

    return read_file_descriptor_set(descriptor_bytes, target_files=target_names)
