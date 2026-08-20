"""AsyncAPI import source — MFI-8.5 (#3763).

The :class:`~app.import_source.ImportSource` adapter that makes the AsyncAPI work of
MFI-8.1…8.4 reachable from the UI source card and the CLI ``import`` command. Like the
reference OpenAPI adapter (:mod:`app.openapi_import_source`) it wraps machinery that
already exists rather than reimplementing it:

* **parse** runs the authoritative ``@asyncapi/parser`` (MFI-8.1,
  :func:`app.asyncapi_parser.parse_asyncapi`) to validate and **dereference** the document
  into canonical JSON. An invalid document is turned into a clean
  :class:`~app.import_source.ImportSourceError`;
* **normalize** delegates to the registered AsyncAPI
  :class:`~app.normalizer.Normalizer` (MFI-8.2,
  :class:`app.asyncapi_normalizer.AsyncApiNormalizer`), looked up by the document's own
  ``asyncapi-2`` / ``asyncapi-3`` family — no mapping logic is duplicated here;
* **lint** delegates to the AsyncAPI lint pack (MFI-8.3,
  :func:`app.asyncapi_lint.lint_asyncapi_result`), folding the ``spectral:asyncapi``
  diagnostics the parser already produced into the score when the parse result is on hand,
  and otherwise degrading gracefully to the native + common packs via the engine default;
* **fingerprint** / **diff** use the canonical-model defaults from
  :mod:`app.import_source` (the AsyncAPI breaking-change overlay of MFI-8.4 layers onto the
  diff view through its own SPI).

Registering this adapter (``register=True``) is all the UI and CLI need: the source card
grid (:mod:`app.import_sources_routes` → ``GET /v1/import/sources``) and the CLI
``import --list`` / ``import asyncapi`` dispatch are both data-driven off the registry, so an
``asyncapi`` card with file/url/paste inputs and the event paradigm appears with no other
change. Detection recognizes both AsyncAPI 2.x and 3.x by their ``asyncapi`` version marker.

**Async parser over a synchronous SPI seam.** The import pipeline
(:func:`app.import_source_pipeline.run_adapter_import_job`) calls :meth:`parse` *synchronously*
from within the service's running event loop, but :func:`parse_asyncapi` is a coroutine that
drives a Node subprocess. :meth:`parse` therefore runs the coroutine to completion on a
dedicated worker thread with its own event loop (:func:`_parse_on_worker_loop`). A fresh
sibling :class:`~app.toolchain_runner.ToolchainRunner` — mirroring the shared runner's
concurrency/timeout configuration — is constructed *inside* that loop so its
:class:`asyncio.Semaphore` binds to the worker loop rather than the (different) service loop.
The parse is bounded (a single event document) and preview-only, so the brief block this puts
on the calling loop is acceptable; a format with genuinely heavy parsing would move to its own
subprocess worker (see the pipeline module docstring).
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Optional

# Importing the AsyncAPI normalizer self-registers the ``asyncapi-2`` / ``asyncapi-3`` format
# keys, which :meth:`AsyncApiImportSource.normalize` resolves through the normalizer registry.
from . import asyncapi_normalizer  # noqa: F401
from .asyncapi_fileset import bundle_asyncapi_fileset
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_ingestion import IngestionError, parse_document
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
    LintReport,
)

__all__ = ["AsyncApiImportSource"]


def _format_for_version(version: str) -> Optional[str]:
    """Return the normalizer/registry format key for an ``asyncapi`` version string.

    ``2.x`` → ``asyncapi-2`` and ``3.x`` → ``asyncapi-3`` (the two registry keys both the
    MFI-8.2 normalizer and MFI-8.3 lint pack register under); any other family is ``None``.
    """
    major = version.split(".", 1)[0]
    if major == "2":
        return "asyncapi-2"
    if major == "3":
        return "asyncapi-3"
    return None


def _parse_on_worker_loop(raw: str, *, source_label: Optional[str]) -> Any:
    """Run the async AsyncAPI parser to completion from synchronous code.

    The adapter's :meth:`AsyncApiImportSource.parse` is part of the synchronous
    :class:`ImportSource` SPI but is called from the service's running event loop, where
    :func:`asyncio.run` is illegal. This runs :func:`app.asyncapi_parser.parse_asyncapi` on a
    dedicated worker thread with its own event loop and a fresh sibling toolchain runner
    (so the runner's loop-bound semaphore is created on *that* loop), then returns the parse
    result. Exceptions raised on the worker thread are re-raised on the caller's thread.

    Returns:
        The :class:`app.asyncapi_parser.AsyncApiParseResult` for the document.
    """
    box: dict[str, Any] = {}

    def _worker() -> None:
        # Imported inside the worker so the parser/toolchain machinery is only pulled in on
        # the import (parse) path, never when the module is imported for registration.
        from .asyncapi_parser import parse_asyncapi
        from .toolchain_runner import ToolchainRunner, default_runner

        async def _drive() -> Any:
            # A fresh runner mirroring the shared one's configuration: its asyncio.Semaphore
            # binds to this worker loop, avoiding a cross-loop reuse of ``default_runner``.
            runner = ToolchainRunner(
                max_concurrency=default_runner.max_concurrency,
                default_timeout_seconds=default_runner.default_timeout_seconds,
                default_policy=default_runner.default_policy,
            )
            return await parse_asyncapi(raw, source_label=source_label, runner=runner)

        try:
            box["value"] = asyncio.run(_drive())
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread below
            box["error"] = exc

    thread = threading.Thread(target=_worker, name="asyncapi-parse", daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


class AsyncApiImportSource(ImportSource, register=True):
    """Adapter for AsyncAPI 2.x / 3.x event-driven API descriptions."""

    key = "asyncapi"
    label = "AsyncAPI"
    description = "Import an AsyncAPI 2.x or 3.x event-driven API description."
    icon = "radio"
    paradigm = ApiParadigm.EVENT
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("asyncapi-2", "asyncapi-3")
    file_extensions = (".asyncapi.yaml", ".asyncapi.yml", ".asyncapi.json", ".yaml", ".yml", ".json")
    # AsyncAPI documents routinely reference a shared message library by URL, and
    # ``@asyncapi/parser`` dereferences in-document ``$ref``\s only — so an import may opt into
    # the MFI-29.4 remote resolver, which inlines those references (SSRF-guarded and budgeted)
    # before this adapter parses, and otherwise reports them as unresolved externals.
    supports_remote_refs = True
    # parse() runs the authoritative Node `@asyncapi/parser` to validate + dereference; with no
    # bundled parser there is no fallback, so the source reports itself unavailable (MFI-5.2)
    # rather than failing every import at parse time. (Tool key: asyncapi_parser.ASYNCAPI_PARSER_TOOL_KEY.)
    required_tools = ("asyncapi-parser",)

    #: The most recent parse result, stashed by :meth:`parse` so :meth:`lint` can fold the
    #: ``spectral:asyncapi`` diagnostics into the score. The import pipeline drives one adapter
    #: instance through parse → normalize → lint for a single job, so this is set before lint;
    #: when lint is reached without a prior parse it falls back to the engine default.
    _parse_result: Any = None

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize an AsyncAPI document by its ``asyncapi`` version marker.

        Reads the already-parsed ``document`` when present, else parses ``text`` cheaply with
        the YAML/JSON loader (no Node subprocess — a malformed document is simply not a match,
        never raised). An ``asyncapi: 2.x`` / ``3.x`` marker pins ``asyncapi-2`` / ``asyncapi-3``
        with high confidence.
        """
        document = payload.document
        if document is None and payload.text:
            try:
                document = parse_document(payload.text, source_label=payload.filename)
            except IngestionError:
                return NO_MATCH
        if not isinstance(document, dict):
            return NO_MATCH

        version = document.get("asyncapi")
        if isinstance(version, str):
            fmt = _format_for_version(version)
            if fmt is not None:
                return DetectionResult(
                    confidence=0.99, format=fmt, reason=f"`asyncapi: {version}` marker"
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        """Parse, validate and dereference AsyncAPI source text via ``@asyncapi/parser``.

        Runs the authoritative parser (MFI-8.1) on a worker-thread event loop (see
        :func:`_parse_on_worker_loop`), so the synchronous SPI seam can drive the async,
        Node-backed parser. The dereferenced parse result is stashed on the instance so
        :meth:`lint` can fold its Spectral diagnostics into the score.

        Returns:
            The :class:`app.asyncapi_parser.AsyncApiParseResult` (its ``document`` is the
            dereferenced, canonical JSON the normalizer consumes).

        Raises:
            ImportSourceError: If the parser tool is unavailable in this runtime, it failed,
                or the document is invalid AsyncAPI (validation errors are surfaced verbatim).
        """
        from .asyncapi_parser import AsyncApiParseError

        try:
            result = _parse_on_worker_loop(raw, source_label=source_label)
            result.raise_if_invalid()
        except AsyncApiParseError as exc:
            raise ImportSourceError(str(exc)) from exc
        self._parse_result = result
        return result

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> Any:
        """Bundle cross-file ``$ref``\\s among *fileset* members, then parse (MFI-29.2)."""
        try:
            bundled = bundle_asyncapi_fileset(fileset)
        except ImportSourceError:
            raise
        except IngestionError as exc:
            raise ImportSourceError(str(exc)) from exc
        return self.parse(bundled, source_label=source_label or fileset.root)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed AsyncAPI document into a :class:`CanonicalApi`.

        Accepts either the :class:`~app.asyncapi_parser.AsyncApiParseResult` :meth:`parse`
        returns or a bare dereferenced document ``dict`` (the latter keeps the adapter testable
        without the Node toolchain). Detects the AsyncAPI family and delegates to its registered
        normalizer (MFI-8.2).

        Raises:
            ImportSourceError: If the source is not a dereferenced AsyncAPI document, or names a
                family with no registered normalizer.
        """
        document = getattr(native_ast, "document", native_ast)
        if not isinstance(document, dict):
            raise ImportSourceError("AsyncAPI source must be a parsed mapping (dict)")

        version = document.get("asyncapi")
        if not isinstance(version, str):
            raise ImportSourceError(
                "Document is not an AsyncAPI description (no `asyncapi` version marker)"
            )
        fmt = _format_for_version(version)
        if fmt is None:
            raise ImportSourceError(
                f"Unsupported AsyncAPI version {version!r}; only the 2.x and 3.x families "
                "are supported."
            )
        return self._normalize_via_registry(fmt, document, include_raw=include_raw)

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint via the AsyncAPI pack, folding Spectral findings when the parse result is on hand.

        When :meth:`parse` ran on this adapter (the normal import flow), its
        ``spectral:asyncapi`` diagnostics are merged into the score through
        :func:`app.asyncapi_lint.lint_asyncapi_result` (MFI-8.3). With no stashed parse result
        (e.g. lint called straight after a dict :meth:`normalize`) it degrades gracefully to the
        engine default — the always-on common pack plus the registered native AsyncAPI rules —
        so the revision is still rolled up to a deterministic score / grade / fingerprint.
        """
        parse_result = self._parse_result
        if parse_result is None:
            return super().lint(model)

        from .asyncapi_lint import lint_asyncapi_result

        return LintReport.from_lint_result(lint_asyncapi_result(model, parse_result))
