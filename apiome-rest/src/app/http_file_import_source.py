"""HTTP request-file import source — IXH-7.4 (#5129).

The :class:`~app.import_source.ImportSource` adapter that makes VS Code / JetBrains
``.http`` / ``.rest`` files and cURL pastes importable. Every construct is
**inferred** (the format asserts nothing); secret scrubbing runs unconditionally in
the shared intake pipeline.
"""

from __future__ import annotations

from typing import Any, Optional

from . import http_file_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .http_file_parser import (
    HttpFileDocument,
    HttpFileParseError,
    is_http_file,
    parse_http_file,
    parse_http_fileset,
)
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["HttpFileImportSource"]


class HttpFileImportSource(ImportSource, register=True):
    """Adapter for ``.http`` / ``.rest`` request files and cURL paste."""

    key = "http-file"
    label = "HTTP Request File"
    description = (
        "Import VS Code / JetBrains .http/.rest request files or cURL snippets and "
        "infer a REST surface (paths, params, bodies, auth). Every construct is "
        "labelled inferred — this format asserts nothing."
    )
    icon = "file-code"
    paradigm = ApiParadigm.REST
    input_kinds = (
        InputKind.FILE,
        InputKind.PASTE,
        InputKind.FILESET,
    )
    supports_live_discovery = False
    formats = ("http-file", "http", "rest")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        filename = (payload.filename or "").lower()
        text = payload.text

        if filename.endswith(".http") or filename.endswith(".rest"):
            if text is None or is_http_file(text, filename=filename):
                return DetectionResult(
                    confidence=0.96,
                    format="http-file",
                    reason="`.http` / `.rest` file extension",
                )

        if text is not None and is_http_file(text, filename=filename or None):
            stripped = text.lstrip()
            if stripped.lower().startswith("curl ") or "\ncurl " in text.lower():
                return DetectionResult(
                    confidence=0.94,
                    format="http-file",
                    reason="cURL command paste",
                )
            return DetectionResult(
                confidence=0.92,
                format="http-file",
                reason="HTTP request-line / ### separator / @variable shape",
            )

        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> HttpFileDocument:
        try:
            return parse_http_file(raw, source_label=source_label, source_file=source_label)
        except HttpFileParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> HttpFileDocument:
        if not fileset.members:
            raise ImportSourceError("HTTP-file fileset has no members", code="INPUT_MALFORMED")
        try:
            return parse_http_fileset(
                fileset.members,
                root=fileset.root,
                source_label=source_label or fileset.root,
            )
        except HttpFileParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, HttpFileDocument):
            raise ImportSourceError(
                "HTTP-file source must be an HttpFileDocument "
                "(see app.http_file_parser.parse_http_file)"
            )
        return self._normalize_via_registry("http-file", native_ast, include_raw=include_raw)
