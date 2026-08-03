"""gRPC / Protobuf import source — MFI-9.6 (#3769).

The :class:`~app.import_source.ImportSource` adapter that makes the gRPC / Protocol Buffers
work of MFI-9.1…9.5 reachable from the UI source card and the CLI ``import`` command. Like the
reference OpenAPI adapter (:mod:`app.openapi_import_source`), the AsyncAPI adapter
(:mod:`app.asyncapi_import_source`), and the GraphQL adapter (:mod:`app.graphql_import_source`)
it wraps machinery that already exists rather than reimplementing it:

* **parse** compiles ``.proto`` source text into a
  :class:`~app.proto_descriptor.CompiledDescriptorSet` via the MFI-9.1 ``buf build`` layer
  (:func:`app.proto_descriptor.compile_proto_descriptor_set`); a proto that does not compile —
  or a runtime with no bundled ``buf`` — becomes a clean
  :class:`~app.import_source.ImportSourceError` carrying the compiler diagnostics;
* **parse_bytes** (IXH-7.5, #5130) accepts the artifact real deployments actually publish: a
  binary serialized ``FileDescriptorSet`` (``protoc --descriptor_set_out``, grpcurl
  ``.protoset``) or a **buf image** (``buf build -o api.binpb``, a compatible superset).
  Decoding is pure :func:`app.proto_descriptor.read_file_descriptor_set` — dependencies are
  already resolved *inside* the set, so no filesystem, network, or ``buf`` toolchain is
  touched. Malformed bytes fail with taxonomy code ``INPUT_MALFORMED``; bytes whose wire
  stream is cut off mid-element fail with ``INPUT_TRUNCATED``;
* **normalize** delegates to the registered Protobuf :class:`~app.normalizer.Normalizer`
  (MFI-9.2, :class:`app.proto_normalizer.ProtoNormalizer`) under the ``protobuf`` format key —
  no mapping logic is duplicated here — and accepts either the compiled descriptor set
  :meth:`parse` / :meth:`discover` return or a bare ``FileDescriptorSet`` / its bytes;
* **lint** delegates to the Protobuf lint pack (MFI-9.4,
  :func:`app.proto_lint.lint_protobuf_result`), which is pure over the canonical model (the
  authoritative ``buf lint`` findings are folded in when a report is on hand; with none the
  native + common packs still produce a deterministic score);
* **fingerprint** / **diff** use the canonical-model defaults from :mod:`app.import_source` (the
  Protobuf breaking-change overlay of MFI-9.5 layers onto the diff view through its own SPI).

**Live discovery (Server Reflection).** gRPC advertises ``supports_live_discovery``:
:meth:`discover` is the discovery counterpart to :meth:`parse` (the gRPC analogue of the GraphQL
adapter's :meth:`~app.graphql_import_source.GraphQlImportSource.introspect`). It runs the
SSRF-guarded MFI-9.3 reflection crawler (:func:`app.grpc_reflection.discover_endpoint`) against a
**running** gRPC server and returns the assembled
:class:`~app.proto_descriptor.CompiledDescriptorSet` — identical in shape to the ``buf build``
file path — ready for :meth:`normalize`. So **both** acceptance paths catalog a version through one
adapter: a ``.proto`` upload via :meth:`parse`, a live reflection endpoint via :meth:`discover`.

Registering this adapter (``register=True``) is all the UI and CLI need for the file path: the
source card grid (:mod:`app.import_sources_routes` → ``GET /v1/import/sources``) and the CLI
``import --list`` / ``import grpc`` dispatch are both data-driven off the registry, so a ``grpc``
card with file/url/paste/discovery inputs and the RPC paradigm appears with no other change.

**Async compiler over a synchronous SPI seam.** The import pipeline
(:func:`app.import_source_pipeline.run_adapter_import_job`) calls :meth:`parse` *synchronously* from
within the service's running event loop, but :func:`compile_proto_descriptor_set` is a coroutine
that drives the ``buf`` subprocess. :meth:`parse` therefore runs the coroutine to completion on a
dedicated worker thread with its own event loop (:func:`_compile_on_worker_loop`) and a fresh
sibling :class:`~app.toolchain_runner.ToolchainRunner` whose :class:`asyncio.Semaphore` binds to
that worker loop — exactly the bridge the AsyncAPI adapter uses for its Node parser.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Mapping, Optional, Sequence, Tuple

# Importing the Protobuf normalizer self-registers the ``protobuf`` format key, which
# :meth:`GrpcImportSource.normalize` resolves through the normalizer registry.
from . import proto_normalizer  # noqa: F401
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
    LintReport,
)
from .proto_descriptor import CompiledDescriptorSet, ProtoFile

__all__ = ["GrpcImportSource"]

#: Default module-relative path given to an uploaded single ``.proto`` when the source has no
#: usable filename (stdin, a paste). ``buf build`` resolves imports by these paths, so a stable,
#: safe default keeps a self-contained proto compiling.
_DEFAULT_PROTO_PATH = "import.proto"

#: Cheap ``.proto`` recognition markers. A real Protocol Buffers source declares its syntax /
#: edition or a top-level ``package`` / ``message`` / ``service`` / ``enum`` — matching any is
#: enough to recognize the format without compiling it (detection must never shell out to ``buf``).
_PROTO_MARKERS: Tuple[str, ...] = (
    'syntax = "proto3"',
    'syntax = "proto2"',
    "syntax='proto3'",
    "syntax='proto2'",
    "edition = ",
    "message ",
    "service ",
    "enum ",
    "package ",
)


def _compile_on_worker_loop(files: Sequence[ProtoFile]) -> CompiledDescriptorSet:
    """Run the async ``buf build`` compiler to completion from synchronous code.

    The adapter's :meth:`GrpcImportSource.parse` is part of the synchronous
    :class:`ImportSource` SPI but is called from the service's running event loop, where
    :func:`asyncio.run` is illegal. This runs
    :func:`app.proto_descriptor.compile_proto_descriptor_set` on a dedicated worker thread with
    its own event loop and a fresh sibling toolchain runner (so the runner's loop-bound semaphore
    is created on *that* loop), then returns the compiled descriptor set. Exceptions raised on the
    worker thread are re-raised on the caller's thread.

    Returns:
        The :class:`app.proto_descriptor.CompiledDescriptorSet` for the supplied ``.proto`` files.
    """
    box: dict[str, Any] = {}

    def _worker() -> None:
        # Imported inside the worker so the compiler/toolchain machinery is only pulled in on the
        # import (parse) path, never when the module is imported for registration.
        from .proto_descriptor import compile_proto_descriptor_set
        from .toolchain_runner import ToolchainRunner, default_runner

        async def _drive() -> CompiledDescriptorSet:
            # A fresh runner mirroring the shared one's configuration: its asyncio.Semaphore binds
            # to this worker loop, avoiding a cross-loop reuse of ``default_runner``.
            runner = ToolchainRunner(
                max_concurrency=default_runner.max_concurrency,
                default_timeout_seconds=default_runner.default_timeout_seconds,
                default_policy=default_runner.default_policy,
            )
            return await compile_proto_descriptor_set(files, runner=runner)

        try:
            box["value"] = asyncio.run(_drive())
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread below
            box["error"] = exc

    thread = threading.Thread(target=_worker, name="proto-compile", daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def _proto_path_for(source_label: Optional[str]) -> str:
    """Return a safe, module-relative ``.proto`` path for a single uploaded source.

    ``buf build`` addresses files by their module-relative path, so a stray directory prefix or a
    non-``.proto`` name would break the compile. This takes the source's basename, ensures a
    ``.proto`` suffix, and falls back to :data:`_DEFAULT_PROTO_PATH` when there is nothing usable
    (stdin/paste). The returned path is always a bare relative name (no ``/``, no ``..``).
    """
    if not source_label:
        return _DEFAULT_PROTO_PATH
    base = source_label.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not base or base in {".", ".."}:
        return _DEFAULT_PROTO_PATH
    if not base.endswith(".proto"):
        base = f"{base}.proto"
    return base


class GrpcImportSource(ImportSource, register=True):
    """Adapter for gRPC / Protocol Buffers (``.proto`` upload or live Server Reflection)."""

    key = "grpc"
    label = "gRPC / Protobuf"
    description = "Import a gRPC / Protocol Buffers API from a .proto file or live server reflection."
    icon = "share-2"
    paradigm = ApiParadigm.RPC
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.DISCOVERY,
        InputKind.FILESET,
    )
    supports_live_discovery = True
    formats = ("protobuf",)
    # parse() compiles .proto via `buf build`; with no bundled `buf` there is no fallback, so the
    # source reports itself unavailable (MFI-5.2) rather than failing every import at parse time.
    required_tools = ("buf",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize Protocol Buffers source text, a binary descriptor set, or a filename hint.

        A ``.proto`` is plain schema text — not the JSON/YAML *mapping* the OpenAPI/AsyncAPI
        adapters sniff — so detection reads ``text`` and matches a proto marker (``syntax``/
        ``edition``/a top-level ``message``/``service``/``enum``/``package``). When the caller
        supplies the undecoded ``data`` bytes (IXH-7.5), a payload that parses as a
        ``FileDescriptorSet`` / buf image is claimed at high confidence — the parse *is* the
        evidence. A ``.proto`` (or ``.binpb``/``.desc``/``.protoset``) filename is a weaker
        signal. Never raises: an unrecognized input returns :data:`NO_MATCH`.
        """
        from .proto_descriptor import is_descriptor_set_filename, sniff_file_descriptor_set

        if payload.data is not None and sniff_file_descriptor_set(payload.data):
            return DetectionResult(
                confidence=0.9,
                format="protobuf",
                reason="binary FileDescriptorSet / buf image",
            )

        text = payload.text
        if text is not None:
            if 'syntax = "proto3"' in text or 'syntax = "proto2"' in text:
                return DetectionResult(
                    confidence=0.97, format="protobuf", reason="`syntax` proto marker"
                )
            if "edition = " in text and ("message " in text or "service " in text):
                return DetectionResult(
                    confidence=0.95, format="protobuf", reason="Protobuf Editions marker"
                )
            if any(marker in text for marker in _PROTO_MARKERS):
                return DetectionResult(
                    confidence=0.7, format="protobuf", reason="Protobuf definition keyword"
                )

        filename = (payload.filename or "").lower()
        if filename.endswith(".proto"):
            return DetectionResult(
                confidence=0.6, format="protobuf", reason="`.proto` file extension"
            )
        if is_descriptor_set_filename(filename):
            return DetectionResult(
                confidence=0.6,
                format="protobuf",
                reason="descriptor-set file extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CompiledDescriptorSet:
        """Compile ``.proto`` source text into a descriptor set via ``buf build`` (MFI-9.1).

        The single uploaded ``.proto`` is compiled through the async toolchain compiler on a
        worker-thread event loop (see :func:`_compile_on_worker_loop`), so the synchronous SPI seam
        can drive the async, ``buf``-backed compiler. External imports of *sibling* files are not
        resolvable from a single upload (only the compiler's bundled well-known types are); such a
        proto surfaces the compiler's "unresolved import" diagnostic as an
        :class:`ImportSourceError`.

        Returns:
            The :class:`app.proto_descriptor.CompiledDescriptorSet` (its ``proto`` descriptor is the
            typed message the MFI-9.2 normalizer consumes — no re-parse).

        Raises:
            ImportSourceError: If ``buf`` is unavailable in this runtime, the proto does not compile
                (syntax error / unresolved import — diagnostics surfaced verbatim), or the compiler
                produced no readable descriptor set.
        """
        from .proto_descriptor import ProtoCompileError, ProtoDescriptorError

        files = (ProtoFile(path=_proto_path_for(source_label), content=raw),)
        try:
            return _compile_on_worker_loop(files)
        except ProtoCompileError as exc:
            detail = f"{exc}"
            if exc.diagnostics:
                detail = f"{detail}\n{exc.diagnostics}"
            raise ImportSourceError(detail) from exc
        except ProtoDescriptorError as exc:
            raise ImportSourceError(str(exc)) from exc

    def accepts_bytes(self, raw: bytes, *, filename: Optional[str] = None) -> bool:
        """Claim binary descriptor-set payloads for :meth:`parse_bytes` (IXH-7.5).

        Two signals route an upload to the binary path: bytes that actually parse as a
        ``FileDescriptorSet`` / buf image, or a conventional descriptor-set filename
        (``.binpb``/``.desc``/``.protoset``). The filename signal deliberately claims
        *malformed* payloads too, so a broken descriptor set fails through
        :meth:`parse_bytes` with a descriptor-specific taxonomy code
        (``INPUT_MALFORMED``/``INPUT_TRUNCATED``) instead of being mis-reported as a
        text-encoding fault. Never raises.
        """
        from .proto_descriptor import is_descriptor_set_filename, sniff_file_descriptor_set

        if is_descriptor_set_filename(filename):
            return True
        try:
            return sniff_file_descriptor_set(raw)
        except Exception:  # noqa: BLE001 - routing must never raise; fall back to text
            return False

    def parse_bytes(
        self, raw: bytes, *, source_label: Optional[str] = None
    ) -> CompiledDescriptorSet:
        """Decode a binary ``FileDescriptorSet`` / buf image into a descriptor set (IXH-7.5).

        The binary counterpart to :meth:`parse` for the artifact real gRPC deployments
        distribute: a serialized ``FileDescriptorSet`` (``protoc --descriptor_set_out``,
        grpcurl's ``.protoset``) or a buf image (``buf build -o api.binpb`` — a
        ``FileDescriptorSet`` with buf's per-file extensions, which decode as unknown
        fields and are ignored). Dependencies are already resolved *within* the set, so
        decoding is pure :func:`app.proto_descriptor.read_file_descriptor_set` — no
        filesystem lookups, no network access, and no ``buf`` toolchain involved.

        Args:
            raw: The serialized ``FileDescriptorSet`` / buf image bytes.
            source_label: Optional label (filename/URL) for error messages.

        Returns:
            The decoded :class:`app.proto_descriptor.CompiledDescriptorSet`, identical in
            shape to what :meth:`parse` / :meth:`discover` return.

        Raises:
            ImportSourceError: With taxonomy code ``INPUT_EMPTY`` for an empty payload,
                ``INPUT_TRUNCATED`` when the wire stream is cut off mid-element, or
                ``INPUT_MALFORMED`` when the bytes are not a descriptor set at all.
        """
        from .proto_descriptor import (
            ProtoDescriptorError,
            descriptor_set_looks_truncated,
            read_file_descriptor_set,
        )

        label = source_label or "uploaded descriptor set"
        if not raw:
            raise ImportSourceError(
                f"{label}: the descriptor-set payload is empty.", code="INPUT_EMPTY"
            )
        try:
            return read_file_descriptor_set(raw)
        except ProtoDescriptorError as exc:
            if descriptor_set_looks_truncated(raw):
                raise ImportSourceError(
                    f"{label}: the descriptor set is cut off mid-message — the upload "
                    f"looks truncated. Re-export it (e.g. `buf build -o api.binpb` or "
                    f"`protoc --descriptor_set_out`) and retry. ({exc})",
                    code="INPUT_TRUNCATED",
                ) from exc
            raise ImportSourceError(
                f"{label}: not a valid binary FileDescriptorSet / buf image. ({exc})",
                code="INPUT_MALFORMED",
            ) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CompiledDescriptorSet:
        """Compile every ``.proto`` member of *fileset* via ``buf build`` (MFI-29.1)."""
        from .proto_descriptor import ProtoCompileError, ProtoDescriptorError

        proto_members = [
            (path, content)
            for path, content in fileset.members.items()
            if path.lower().endswith(".proto")
        ]
        if not proto_members:
            raise ImportSourceError(
                "Fileset contains no .proto files for gRPC / Protobuf import."
            )
        files = tuple(ProtoFile(path=path, content=content) for path, content in proto_members)
        try:
            return _compile_on_worker_loop(files)
        except ProtoCompileError as exc:
            detail = f"{exc}"
            if exc.diagnostics:
                detail = f"{detail}\n{exc.diagnostics}"
            raise ImportSourceError(detail) from exc
        except ProtoDescriptorError as exc:
            raise ImportSourceError(str(exc)) from exc

    def discover(
        self,
        target: str,
        *,
        auth_type: Optional[str] = None,
        auth_payload: Optional[Mapping[str, Any]] = None,
        metadata: Optional[Sequence[Tuple[str, str]]] = None,
        secure: bool = False,
        timeout: Optional[float] = None,
        transport_factory: Optional[Any] = None,
    ) -> CompiledDescriptorSet:
        """Crawl a live gRPC endpoint's Server Reflection surface (the discovery seam).

        The live-endpoint counterpart to :meth:`parse`: it runs the SSRF-guarded MFI-9.3 reflection
        crawler (:func:`app.grpc_reflection.discover_endpoint`) — which enumerates the server's
        services via ``ListServices``, pulls each service's file (plus transitive dependencies) via
        ``FileContainingSymbol``, and assembles them into a descriptor set whose bytes match the
        ``buf build`` file path exactly — then rebuilds the
        :class:`~app.proto_descriptor.CompiledDescriptorSet` ready for :meth:`normalize` /
        :meth:`fingerprint` / :meth:`lint`. So a live reflection endpoint catalogs a version through
        the same canonical path a ``.proto`` upload does.

        Args:
            target: The gRPC endpoint as ``host:port`` (a ``scheme://`` prefix is tolerated and
                stripped; the host is SSRF-validated before any channel opens).
            auth_type: Credential-vault auth type (``none``/``bearer``/``header``/``oauth2``).
            auth_payload: The **decrypted** credential payload for ``auth_type``.
            metadata: Extra gRPC metadata pairs merged in after the auth metadata.
            secure: Open a TLS channel when ``True`` (default insecure).
            timeout: Per-RPC deadline in seconds; defaults to the crawler's own default.
            transport_factory: A reflection-transport factory injected by tests; production omits it
                so a real gRPC channel is built.

        Returns:
            The assembled :class:`app.proto_descriptor.CompiledDescriptorSet`.

        Raises:
            ImportSourceError: If the request is misconfigured (unsafe target / malformed
                credential) or the crawl produced no descriptor set (reflection disabled, the server
                is unreachable, or it exposes no services).
        """
        from .grpc_reflection import GrpcReflectionError, discover_endpoint

        try:
            result = discover_endpoint(
                target,
                auth_type=auth_type,
                auth_payload=auth_payload,
                metadata=metadata,
                secure=secure,
                timeout=timeout,
                transport_factory=transport_factory,
            )
        except GrpcReflectionError as exc:
            raise ImportSourceError(str(exc)) from exc

        compiled = result.compiled() if result.ok else None
        if compiled is None:
            raise ImportSourceError(
                result.reason
                or "gRPC reflection produced no descriptor set for this endpoint."
            )
        return compiled

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a compiled protobuf descriptor set into a :class:`CanonicalApi` (paradigm RPC).

        Accepts the :class:`~app.proto_descriptor.CompiledDescriptorSet` :meth:`parse` /
        :meth:`discover` return, a bare ``google.protobuf.FileDescriptorSet``, or its serialized
        bytes (the latter two keep the adapter testable without ``buf``). Delegates to the registered
        Protobuf normalizer (MFI-9.2), which honours the target/import distinction.

        Raises:
            ImportSourceError: If ``native_ast`` is not a recognized descriptor-set form, or no
                Protobuf normalizer is registered.
        """
        try:
            return self._normalize_via_registry("protobuf", native_ast, include_raw=include_raw)
        except ValueError as exc:
            raise ImportSourceError(str(exc)) from exc

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint via the Protobuf pack (MFI-9.4), folding native + common rules into the score.

        :func:`app.proto_lint.lint_protobuf_result` is pure over the canonical model, so the revision
        always rolls up to a deterministic score / grade / ``report_fingerprint`` even with no
        ``buf`` present; the authoritative ``buf lint`` findings are folded in by the MFI-4.3
        external-linter adapter / the end-to-end ``lint_protobuf`` path when available.
        """
        from .proto_lint import lint_protobuf_result

        return LintReport.from_lint_result(lint_protobuf_result(model))
