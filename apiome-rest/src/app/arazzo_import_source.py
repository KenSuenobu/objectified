"""Arazzo import source — MFI-30.2 (#4395).

The :class:`~app.import_source.ImportSource` adapter that puts Arazzo workflow documents
behind the multi-format SPI. It wraps the shared pipeline rather than reimplementing it:

* **parse** reuses :func:`app.import_ingestion.parse_document` (JSON or YAML);
* **normalize** delegates to :class:`app.arazzo_normalizer.ArazzoNormalizer`;
* **lint** delegates to the Arazzo lint pack (:func:`app.arazzo_lint.lint_arazzo_result`);
* **fingerprint** / **diff** use the canonical-model defaults from :mod:`app.import_source`.

Registering this adapter (``register=True``) is all the UI source card, CLI ``import --list``,
and ``POST /v1/import/detect`` need: an Arazzo document now auto-detects with
``importable: true`` and routes to a non-publishable catalog item (store-raw, MFI-23.7).
"""

from __future__ import annotations

from typing import Any, Optional

from . import arazzo_normalizer  # noqa: F401
from .arazzo_lint import lint_arazzo_result
from .canonical_model import ApiParadigm, CanonicalApi
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

__all__ = ["ArazzoImportSource"]


class ArazzoImportSource(ImportSource, register=True):
    """Adapter for Arazzo 1.x workflow descriptions."""

    key = "arazzo"
    label = "Arazzo"
    description = "Import an Arazzo workflow description."
    icon = "workflow"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE)
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
        if isinstance(version, str) and version.strip():
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
            raise ImportSourceError(str(exc)) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed Arazzo document into a :class:`CanonicalApi`."""
        if not isinstance(native_ast, dict):
            raise ImportSourceError("Arazzo source must be a parsed mapping (dict)")

        detection = self.detect(DetectionInput(document=native_ast))
        if detection.format is None:
            raise ImportSourceError(
                "Document is not an Arazzo description (no `arazzo` version marker)"
            )
        return self._normalize_via_registry(
            detection.format, native_ast, include_raw=include_raw
        )

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint via the Arazzo rule pack registered for ``arazzo`` artifacts."""
        return LintReport.from_lint_result(lint_arazzo_result(model))
