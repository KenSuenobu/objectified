"""CloudEvents import source.

The :class:`~app.import_source.ImportSource` adapter that makes CloudEvents
structured-mode JSON documents importable into the catalog (store-raw).
"""

from __future__ import annotations

from typing import Any, Optional

from . import cloudevents_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .cloudevents_parser import (
    CloudEventParseError,
    CloudEventsDocument,
    is_cloudevents,
    is_cloudevents_document,
    parse_cloudevents,
)
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["CloudEventsImportSource"]


class CloudEventsImportSource(ImportSource, register=True):
    """Adapter for CloudEvents 1.0 structured-mode JSON documents."""

    key = "cloudevents"
    label = "CloudEvents"
    description = "Import a CloudEvents 1.0 structured-mode event envelope with inferred payload schema."
    icon = "cloud"
    paradigm = ApiParadigm.EVENT
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("cloudevents", "cloud-events")
    file_extensions = (".cloudevents.json", ".cloudevent.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        document = payload.document
        if document is not None and is_cloudevents_document(document):
            event_type = None
            if isinstance(document, dict):
                event_type = document.get("type")
            elif isinstance(document, list) and document and isinstance(document[0], dict):
                event_type = document[0].get("type")
            reason = (
                f"CloudEvents envelope (`type`: `{event_type}`)"
                if isinstance(event_type, str) and event_type
                else "CloudEvents `specversion` + `type` + `source` markers"
            )
            return DetectionResult(confidence=0.98, format="cloudevents", reason=reason)

        text = payload.text
        if text is not None and is_cloudevents(text):
            return DetectionResult(
                confidence=0.98,
                format="cloudevents",
                reason="CloudEvents `specversion` + `type` + `source` markers",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".cloudevent.json") or filename.endswith(".cloudevents.json"):
            if text is not None and is_cloudevents(text):
                return DetectionResult(
                    confidence=0.9,
                    format="cloudevents",
                    reason="`.cloudevents.json` file extension",
                )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> CloudEventsDocument:
        try:
            return parse_cloudevents(raw, source_label=source_label)
        except CloudEventParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> CloudEventsDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("CloudEvents fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, CloudEventsDocument):
            raise ImportSourceError(
                "CloudEvents source must be a CloudEventsDocument "
                "(see app.cloudevents_parser.parse_cloudevents)"
            )
        return self._normalize_via_registry("cloudevents", native_ast, include_raw=include_raw)
