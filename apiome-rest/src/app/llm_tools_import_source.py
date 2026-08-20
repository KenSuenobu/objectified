"""LLM tool / function-calling import source — IXH-7.3 (#5128).

The :class:`~app.import_source.ImportSource` adapter that makes bare LLM tool /
function-calling schema bundles (OpenAI, Anthropic, and bare ``{name, parameters}``)
importable into the catalog.

**Mixed-dialect policy:** mixed OpenAI + Anthropic + bare tools in one array are
accepted and normalized; each tool records its dialect on
``operation.extras.dialect``. Bundles are never rejected solely for mixing dialects.
"""

from __future__ import annotations

from typing import Any, Optional

from . import llm_tools_normalizer  # noqa: F401 — self-registers the normalizer
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
from .llm_tools_parser import (
    LlmToolsDocument,
    LlmToolsParseError,
    is_llm_tools,
    is_llm_tools_document,
    parse_llm_tools,
)

__all__ = ["LlmToolsImportSource"]


class LlmToolsImportSource(ImportSource, register=True):
    """Adapter for LLM tool / function-calling schema bundles (file / url / paste)."""

    key = "llm-tools"
    label = "LLM Tools"
    description = (
        "Import an OpenAI, Anthropic, or bare function/tool-definition array and "
        "normalize each tool to a canonical agent-paradigm operation."
    )
    icon = "bot"
    paradigm = ApiParadigm.AGENT
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.FILESET,
    )
    supports_live_discovery = False
    formats = ("llm-tools",)
    file_extensions = (".tools.json", ".llm-tools.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_llm_tools(text):
            return DetectionResult(
                confidence=0.97,
                format="llm-tools",
                reason="OpenAI / Anthropic / bare tool-array shape",
            )

        document = payload.document
        if document is not None and is_llm_tools_document(document):
            return DetectionResult(
                confidence=0.97,
                format="llm-tools",
                reason="OpenAI / Anthropic / bare tool-array shape",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".tools.json") or filename.endswith(".llm-tools.json"):
            return DetectionResult(
                confidence=0.75,
                format="llm-tools",
                reason="`.tools.json` / `.llm-tools.json` file extension",
            )
        if "tools" in filename and filename.endswith(".json"):
            return DetectionResult(
                confidence=0.55,
                format="llm-tools",
                reason="filename contains `tools` with JSON extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> LlmToolsDocument:
        try:
            return parse_llm_tools(raw, source_label=source_label)
        except LlmToolsParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> LlmToolsDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("LLM tools fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, LlmToolsDocument):
            raise ImportSourceError(
                "LLM tools source must be an LlmToolsDocument "
                "(see app.llm_tools_parser.parse_llm_tools)"
            )
        return self._normalize_via_registry("llm-tools", native_ast, include_raw=include_raw)
