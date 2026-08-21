"""Arazzo import source — MFI-30.2 (#4395), FMT-3.1 (#5426).

The :class:`~app.import_source.ImportSource` adapter that puts Arazzo workflow documents
behind the multi-format SPI. It wraps the shared pipeline rather than reimplementing it:

* **parse** reuses :func:`app.import_ingestion.parse_document` (JSON or YAML);
* **parse_fileset** resolves a workflow's relative ``sourceDescriptions[].url`` values
  against its sibling members, so a workflow shipped next to the API documents it calls
  imports as one set (FMT-3.1);
* **normalize** delegates to :class:`app.arazzo_normalizer.ArazzoNormalizer`;
* **lint** delegates to the Arazzo lint pack (:func:`app.arazzo_lint.lint_arazzo_result`);
* **fingerprint** / **diff** use the canonical-model defaults from :mod:`app.import_source`.

Registering this adapter (``register=True``) is all the UI source card, CLI ``import --list``,
and ``POST /v1/import/detect`` need: an Arazzo document now auto-detects with
``importable: true`` and routes to a non-publishable catalog item (store-raw, MFI-23.7).

**Intake failures (FMT-3.1).** Three rejections carry a taxonomy code of their own rather
than falling through to the pipeline's generic "malformed" classification: a document cut
off mid-write (``INPUT_TRUNCATED``), a document with no ``arazzo`` marker at all — an
OpenAPI or AsyncAPI file routed to the wrong importer (``FORMAT_MISMATCH``), and a version
outside the readable range (``FORMAT_VERSION_UNSUPPORTED``). Each maps to a different
remediation hint, which is the point of classifying them apart.

**Version handling (FMT-3.1).** Detection claims *any* ``arazzo:`` marker, including a
version this adapter cannot read — a document that says ``arazzo: 2.0.0`` is an Arazzo
document, and calling it an unrecognized format would send the user after the wrong
problem. The supported range (1.0.x and 1.1.x, see :mod:`app.arazzo_spec`) is enforced in
:meth:`ArazzoImportSource.normalize`, which reports it as ``FORMAT_VERSION_UNSUPPORTED``.
"""

from __future__ import annotations

from posixpath import dirname, normpath
from typing import Any, Dict, List, Optional, Tuple

from . import arazzo_normalizer  # noqa: F401
from .arazzo_lint import lint_arazzo_result
from .arazzo_spec import (
    ArazzoSemanticError,
    ArazzoVersionError,
    is_arazzo_marker,
    validate_arazzo_semantics,
    validate_arazzo_version,
)
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

__all__ = ["ArazzoImportSource", "SourcedArazzoDocument"]

#: Fileset members that are documents the workflow's sources could resolve to.
_DOCUMENT_SUFFIXES = (".yaml", ".yml", ".json")

#: The YAML scanner phrase that means the document ends *inside a token* — a quoted
#: scalar cut off mid-write, which is what a truncated upload looks like. Deliberately
#: narrower than "mentions the end of the stream": an unclosed flow sequence also runs
#: out of input, but that is a syntax error in a complete-looking file, not truncation.
_TRUNCATION_MARKERS = ("found unexpected end of stream",)

#: Characters that betray a non-UTF-8 upload. A file that decoded badly can produce a
#: truncation-shaped parser message, so encoding is decided first (the pipeline reports
#: it as ``INPUT_ENCODING_INVALID`` when no adapter code is supplied).
_ENCODING_MARKERS = ("\ufffd", "\x00")


def _ingestion_error(exc: IngestionError, raw: str) -> ImportSourceError:
    """Turn a parse failure into an ``ImportSourceError`` with the right code.

    Args:
        exc: The ingestion failure raised while parsing.
        raw: The source text that failed, used to rule out an encoding fault before
            attributing a truncation-shaped parser message to truncation.

    Returns:
        The adapter error. Truncation is coded ``INPUT_TRUNCATED``; everything else is
        left uncoded so the pipeline classifies it (empty, encoding, wrong format, or
        simply malformed).
    """
    message = str(exc)
    if any(marker in raw for marker in _ENCODING_MARKERS):
        return ImportSourceError(message)
    if any(marker in message for marker in _TRUNCATION_MARKERS):
        return ImportSourceError(
            f"Arazzo document is truncated: {message}", code="INPUT_TRUNCATED"
        )
    return ImportSourceError(message)


class SourcedArazzoDocument(dict):
    """An Arazzo document plus the sibling documents its sources resolved to.

    A plain ``dict`` subclass so every existing consumer (the normalizer, the linter,
    ``CanonicalApi.raw``) treats it exactly like the parsed document it is — in
    particular the emitter still re-renders the *original* document, so resolving a
    fileset never rewrites the workflow it resolved.

    Attributes:
        resolved_sources: One entry per ``sourceDescriptions`` entry whose ``url``
            pointed at a member of the same set, each carrying the member ``path`` and
            its parsed ``content`` (read with ``getattr(doc, "resolved_sources", None)``).
    """

    resolved_sources: List[Dict[str, Any]]


class ArazzoImportSource(ImportSource, register=True):
    """Adapter for Arazzo 1.0.x and 1.1.x workflow descriptions."""

    key = "arazzo"
    label = "Arazzo"
    description = "Import an Arazzo workflow description."
    icon = "workflow"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("arazzo",)
    file_extensions = (".arazzo.yaml", ".arazzo.yml", ".arazzo.json", ".yaml", ".yml", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize an Arazzo document by its ``arazzo: <version>`` marker."""
        document = payload.document
        if document is None and payload.text:
            try:
                document = parse_document(payload.text, source_label=payload.filename)
            except IngestionError:
                return NO_MATCH
        if not isinstance(document, dict):
            return NO_MATCH

        version = document.get("arazzo")
        if is_arazzo_marker(version):
            return DetectionResult(
                confidence=0.99,
                format="arazzo",
                reason=f"`arazzo: {version}` marker",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        """Parse Arazzo source text (JSON or YAML) into a ``dict``."""
        try:
            return parse_document(raw, source_label=source_label)
        except IngestionError as exc:
            raise _ingestion_error(exc, raw) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> Any:
        """Parse a workflow together with the documents its sources point at (FMT-3.1).

        Exactly one member must carry an ``arazzo:`` marker — that is the workflow being
        imported. Every other member is a candidate *source document*: a
        ``sourceDescriptions`` entry whose ``url`` is a relative path is matched against
        the members by path, and the matched member's parsed document is attached to the
        returned :class:`SourcedArazzoDocument`. That is what lets the lint pack check a
        step's ``operationId`` against the API it actually calls, instead of skipping the
        check because the source was only a URL.

        Members that are neither the root nor parseable JSON/YAML are ignored rather than
        rejected: a set may legitimately carry a README or a licence file alongside the
        documents, and the workflow is what defines the import.

        Args:
            fileset: The root document plus its sibling members.
            source_label: Optional label used in error messages.

        Returns:
            The parsed workflow document, carrying ``resolved_sources``.

        Raises:
            ImportSourceError: When no member is an Arazzo document
                (``FORMAT_MISMATCH``), when more than one is
                (``INPUT_SEMANTIC_INVALID``), or when the fileset root itself is not
                valid JSON/YAML (``INPUT_TRUNCATED`` / uncoded, see
                :func:`_ingestion_error`).
        """
        documents: Dict[str, Any] = {}
        for path in sorted(fileset.members):
            try:
                documents[path] = parse_document(fileset.members[path], source_label=path)
            except IngestionError as exc:
                if path == fileset.root:
                    raise _ingestion_error(exc, fileset.members[path]) from exc
                continue

        roots = [
            path
            for path, document in documents.items()
            if isinstance(document, dict) and is_arazzo_marker(document.get("arazzo"))
        ]
        if not roots:
            label = f" {source_label!r}" if source_label else ""
            raise ImportSourceError(
                f"No member of the fileset{label} is an Arazzo workflow document "
                "(no `arazzo` version marker).",
                code="FORMAT_MISMATCH",
            )
        if len(roots) > 1:
            raise ImportSourceError(
                f"The fileset contains more than one Arazzo document ({', '.join(roots)}); "
                "a workflow import needs exactly one.",
                code="INPUT_SEMANTIC_INVALID",
            )

        root_path = roots[0]
        resolved = SourcedArazzoDocument(documents[root_path])
        resolved.resolved_sources = _resolve_source_members(
            documents[root_path], root_path, documents
        )
        return resolved

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed Arazzo document into a :class:`CanonicalApi`.

        Args:
            native_ast: The parsed document, optionally a :class:`SourcedArazzoDocument`
                carrying the sibling documents its sources resolved to.
            include_raw: Whether to keep the source document on the canonical model.

        Returns:
            The canonical model, with the resolved source documents (if any) published
            on ``extras.resolvedSources``.

        Raises:
            ImportSourceError: When the input is not a mapping or not an Arazzo document
                at all; when its ``arazzo`` marker names a version outside the supported
                range (``FORMAT_VERSION_UNSUPPORTED``); or when a step names nothing to
                invoke (``INPUT_SEMANTIC_INVALID``).
        """
        if not isinstance(native_ast, dict):
            raise ImportSourceError("Arazzo source must be a parsed mapping (dict)")

        detection = self.detect(DetectionInput(document=native_ast))
        if detection.format is None:
            raise ImportSourceError(
                "Document is not an Arazzo description (no `arazzo` version marker); "
                "it looks like a document for a different importer.",
                code="FORMAT_MISMATCH",
            )
        try:
            validate_arazzo_version(native_ast.get("arazzo"))
        except ArazzoVersionError as exc:
            raise ImportSourceError(str(exc), code="FORMAT_VERSION_UNSUPPORTED") from exc
        try:
            validate_arazzo_semantics(native_ast)
        except ArazzoSemanticError as exc:
            raise ImportSourceError(str(exc), code="INPUT_SEMANTIC_INVALID") from exc

        model = self._normalize_via_registry(
            detection.format, native_ast, include_raw=include_raw
        )
        resolved_sources = getattr(native_ast, "resolved_sources", None)
        if resolved_sources:
            model.extras["resolvedSources"] = resolved_sources
        return model

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint via the Arazzo rule pack registered for ``arazzo`` artifacts."""
        return LintReport.from_lint_result(lint_arazzo_result(model))


def _member_candidates(url: str, root_path: str) -> Tuple[str, ...]:
    """Fileset member paths a ``sourceDescriptions[].url`` could name.

    Args:
        url: The declared source URL.
        root_path: The workflow member's own path inside the set.

    Returns:
        Candidate member paths, most specific first: the URL resolved relative to the
        workflow's own directory, then relative to the set root. Absolute URLs (with a
        scheme) yield nothing — they name something outside the set.
    """
    candidate = url.strip()
    if not candidate or "://" in candidate or candidate.startswith("#"):
        return ()
    candidate = candidate.split("#", 1)[0].lstrip("/")
    if not candidate:
        return ()
    directory = dirname(root_path)
    resolved = normpath(f"{directory}/{candidate}") if directory else normpath(candidate)
    return tuple(dict.fromkeys((resolved, normpath(candidate))))


def _resolve_source_members(
    document: Dict[str, Any], root_path: str, documents: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Match each relative ``sourceDescriptions[].url`` to a parsed fileset member.

    Args:
        document: The parsed Arazzo workflow document.
        root_path: The workflow member's path inside the set.
        documents: Every parseable member, keyed by path.

    Returns:
        One entry per resolved source, each with its ``name``, declared ``type``, the
        member ``path`` it resolved to, and that member's parsed ``content``. Sources
        that name a remote URL, or a path no member provides, are simply absent.
    """
    source_descriptions = document.get("sourceDescriptions")
    if not isinstance(source_descriptions, list):
        return []
    resolved: List[Dict[str, Any]] = []
    for entry in source_descriptions:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        url = entry.get("url")
        if not isinstance(name, str) or not name.strip() or not isinstance(url, str):
            continue
        for candidate in _member_candidates(url, root_path):
            if candidate == root_path or candidate not in documents:
                continue
            if not candidate.lower().endswith(_DOCUMENT_SUFFIXES):
                continue
            record: Dict[str, Any] = {
                "name": name,
                "path": candidate,
                "content": documents[candidate],
            }
            if isinstance(entry.get("type"), str):
                record["type"] = entry["type"]
            resolved.append(record)
            break
    return resolved
