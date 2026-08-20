"""Static MCP server manifest import source — FMT-1.7 (#5418).

The :class:`~app.import_source.ImportSource` adapter that puts MCP into the import-source
registry, where it has never been. Every other path into the MCP catalog is a *live probe*
— transport, handshake, paginated discovery, fingerprint — which means a server that is
offline, air-gapped, or simply unreachable from Apiome cannot be catalogued at all, however
completely its owner can describe it. This adapter accepts that description.

What it accepts is the server's discovery result written down: identity, declared
``capabilities``, and the ``tools`` / ``resources`` / ``resourceTemplates`` / ``prompts``
arrays with their JSON Schemas, as a file, a URL, a paste, or a fileset whose schemas live
in sibling documents. It normalizes to the ``agent`` paradigm through
:mod:`app.mcp_manifest_normalizer`, and — the point of the whole exercise — builds its
capability surface with the *same* normalizer and fingerprint live discovery uses
(:func:`app.mcp_manifest_parser.manifest_surface`), so a manifest and a probe of one server
produce one fingerprint rather than two that happen to agree.

Detection keys on a protocol-version marker (``mcpVersion`` / ``protocolVersion``) beside a
non-empty capability array. That pair cannot collide with the LLM-tools adapter: a bare
tool bundle has no version marker, and this adapter's ``tools`` entries use the MCP wire
spelling ``inputSchema``, which :func:`app.llm_tools_parser.classify_tool_dialect`
explicitly declines.
"""

from __future__ import annotations

from typing import Any, Optional

from . import mcp_manifest_normalizer  # noqa: F401 — self-registers the normalizer
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
from .mcp_manifest_parser import (
    McpManifestDocument,
    McpManifestParseError,
    is_mcp_manifest,
    is_mcp_manifest_document,
    parse_mcp_manifest,
    parse_mcp_manifest_fileset,
)

__all__ = ["McpImportSource"]


class McpImportSource(ImportSource, register=True):
    """Adapter for static MCP server manifests (file / url / paste / fileset)."""

    key = "mcp"
    label = "MCP Server Manifest"
    description = (
        "Import a static Model Context Protocol server descriptor — its tools, resources, "
        "resource templates and prompts with their JSON Schemas — and catalog the server "
        "without probing it. The declared surface is normalized and fingerprinted exactly "
        "as a live discovery would be, so a manifest import and a probe of the same server "
        "are recognisably the same server."
    )
    icon = "plug"
    paradigm = ApiParadigm.AGENT
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.FILESET,
    )
    supports_live_discovery = False
    formats = ("mcp",)
    file_extensions = (".mcp.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Sniff a document for the manifest marker pair.

        Args:
            payload: The detection input (text and/or parsed document, plus hints).

        Returns:
            A high-confidence match on the marker pair, a weaker one on a conventional
            ``.mcp.json`` filename, else :data:`~app.import_source.NO_MATCH`.
        """
        document = payload.document
        if document is not None and is_mcp_manifest_document(document):
            return DetectionResult(
                confidence=0.96,
                format="mcp",
                reason="`mcpVersion` / `protocolVersion` beside an MCP capability array",
            )

        text = payload.text
        if text is not None and is_mcp_manifest(text):
            return DetectionResult(
                confidence=0.96,
                format="mcp",
                reason="`mcpVersion` / `protocolVersion` beside an MCP capability array",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".mcp.json"):
            return DetectionResult(
                confidence=0.7,
                format="mcp",
                reason="`.mcp.json` file extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> McpManifestDocument:
        """Parse manifest text into its native document.

        Args:
            raw: The manifest text.
            source_label: Optional filename / URL for error messages.

        Returns:
            The parsed :class:`~app.mcp_manifest_parser.McpManifestDocument`.

        Raises:
            ImportSourceError: Carrying the parser's intake-taxonomy code.
        """
        try:
            return parse_mcp_manifest(raw, source_label=source_label)
        except McpManifestParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> McpManifestDocument:
        """Parse a manifest whose shared schemas live in sibling members.

        Args:
            fileset: The unpacked set; ``root`` names the manifest itself.
            source_label: Optional label for error messages.

        Returns:
            The parsed manifest with cross-file references inlined.

        Raises:
            ImportSourceError: When the set is empty or the manifest cannot be parsed.
        """
        if not fileset.members:
            raise ImportSourceError(
                "MCP manifest fileset has no members", code="INPUT_MALFORMED"
            )
        try:
            return parse_mcp_manifest_fileset(
                fileset.members,
                root=fileset.root,
                source_label=source_label or fileset.root,
            )
        except McpManifestParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed manifest onto the canonical agent-paradigm model.

        Args:
            native_ast: The parsed manifest.
            include_raw: Whether to preserve the manifest in ``raw``.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: When ``native_ast`` is not a parsed manifest.
        """
        if not isinstance(native_ast, McpManifestDocument):
            raise ImportSourceError(
                "MCP source must be an McpManifestDocument "
                "(see app.mcp_manifest_parser.parse_mcp_manifest)"
            )
        return self._normalize_via_registry("mcp", native_ast, include_raw=include_raw)
