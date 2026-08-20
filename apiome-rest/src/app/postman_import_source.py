"""Postman import source.

The :class:`~app.import_source.ImportSource` adapter that makes Postman Collection
v2.1 documents importable into the catalog (store-raw).
"""

from __future__ import annotations

from typing import Any, Optional

from . import postman_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .postman_parser import (
    PostmanDocument,
    PostmanParseError,
    is_postman,
    is_postman_document,
    parse_postman,
)

__all__ = ["PostmanImportSource"]


class PostmanImportSource(ImportSource, register=True):
    """Adapter for Postman Collection v2.1 JSON documents."""

    key = "postman"
    label = "Postman"
    description = "Import a Postman Collection v2.1 with HTTP requests and inferred schemas."
    icon = "file-json"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("postman", "postmancollection")
    file_extensions = (".postman_collection.json", ".postman.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        document = payload.document
        if document is not None and is_postman_document(document):
            return DetectionResult(
                confidence=0.98,
                format="postman",
                reason="Postman collection `info.schema` marker",
            )

        text = payload.text
        if text is not None and is_postman(text):
            return DetectionResult(
                confidence=0.98,
                format="postman",
                reason="Postman collection `info.schema` marker",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".postman_collection.json") or filename.endswith(".postman.json"):
            if text is not None and is_postman(text):
                return DetectionResult(
                    confidence=0.9,
                    format="postman",
                    reason="`.postman_collection.json` file extension",
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> PostmanDocument:
        try:
            return parse_postman(raw, source_label=source_label)
        except PostmanParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> PostmanDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Postman fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, PostmanDocument):
            raise ImportSourceError(
                "Postman source must be a PostmanDocument (see app.postman_parser.parse_postman)"
            )
        return self._normalize_via_registry("postman", native_ast, include_raw=include_raw)
