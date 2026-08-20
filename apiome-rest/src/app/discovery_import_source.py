"""Google API Discovery import source — IXH-7.1 (#5126).

The :class:`~app.import_source.ImportSource` adapter that makes Google API Discovery
rest descriptions importable into the catalog (file/url/paste) and supports live
directory discovery against the public Discovery directory endpoint.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from . import discovery_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .discovery_directory import (
    DEFAULT_DIRECTORY_URL,
    DiscoveryApiListing,
    DiscoveryDirectoryError,
    fetch_rest_description,
    import_api_from_directory,
    list_directory_apis,
)
from .discovery_parser import (
    DiscoveryDocument,
    DiscoveryParseError,
    is_discovery,
    is_discovery_directory,
    is_discovery_document,
    parse_discovery,
)
from .fileset import IntakeFileset
from .import_ingestion import IngestionError, parse_document
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = ["DiscoveryImportSource"]


class DiscoveryImportSource(ImportSource, register=True):
    """Adapter for Google API Discovery rest descriptions (``.json`` file / url / paste / live)."""

    key = "discovery"
    label = "Google API Discovery"
    description = (
        "Import a Google API Discovery rest description, or pick an API from the public "
        "Discovery directory."
    )
    icon = "radar"
    paradigm = ApiParadigm.REST
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.DISCOVERY,
        InputKind.FILESET,
    )
    supports_live_discovery = True
    formats = ("discovery",)
    file_extensions = (".discovery.json", ".discovery", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_discovery(text):
            return DetectionResult(
                confidence=0.98,
                format="discovery",
                reason="`discoveryVersion` / `kind: discovery#restDescription` marker",
            )

        document = payload.document
        if document is not None and is_discovery_document(document):
            return DetectionResult(
                confidence=0.98,
                format="discovery",
                reason="`discoveryVersion` / `kind: discovery#restDescription` marker",
            )
        if document is not None and is_discovery_directory(document):
            # Directory listings are Discovery-family but not importable as a rest
            # description; decline so a wrong-format / semantic path can explain.
            return NO_MATCH

        filename = (payload.filename or "").lower()
        if filename.endswith(".discovery.json") or filename.endswith(".discovery"):
            return DetectionResult(
                confidence=0.75,
                format="discovery",
                reason="`.discovery` file extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> DiscoveryDocument:
        try:
            return parse_discovery(raw, source_label=source_label)
        except DiscoveryParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> DiscoveryDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Discovery fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def list_directory(
        self,
        directory_url: str = DEFAULT_DIRECTORY_URL,
        *,
        client: Optional[Any] = None,
    ) -> Sequence[DiscoveryApiListing]:
        """List APIs from a Discovery directory endpoint (SSRF-guarded)."""
        try:
            return list_directory_apis(directory_url, client=client)
        except DiscoveryDirectoryError as exc:
            raise ImportSourceError(str(exc)) from exc

    def import_from_directory(
        self,
        api_id: str,
        *,
        directory_url: str = DEFAULT_DIRECTORY_URL,
        client: Optional[Any] = None,
    ) -> DiscoveryDocument:
        """Resolve ``api_id`` in the directory and parse its rest description."""
        try:
            return import_api_from_directory(
                api_id, directory_url=directory_url, client=client
            )
        except (DiscoveryDirectoryError, DiscoveryParseError) as exc:
            raise ImportSourceError(str(exc)) from exc

    def introspect(
        self,
        endpoint_url: str,
        *,
        auth_type: Optional[str] = None,
        auth_payload: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        fallback_sdl: Optional[str] = None,
        source_label: Optional[str] = None,
        client: Optional[Any] = None,
        api_id: Optional[str] = None,
    ) -> DiscoveryDocument:
        """Fetch a live Discovery rest description (or resolve one from a directory).

        When ``api_id`` is set, ``endpoint_url`` is treated as a directory URL and the
        matching API's ``discoveryRestUrl`` is fetched. Otherwise ``endpoint_url`` must
        point at a rest description (not a bare directory listing).

        Args:
            endpoint_url: Rest-description URL, or directory URL when ``api_id`` is set.
            auth_type: Unused (Discovery documents are public); accepted for SPI parity.
            auth_payload: Unused; accepted for SPI parity.
            headers: Unused; accepted for SPI parity.
            fallback_sdl: Unused; accepted for SPI parity with GraphQL.
            source_label: Label for parse diagnostics; defaults to the fetched URL.
            client: Optional httpx client (tests).
            api_id: When set, select this API from the directory at ``endpoint_url``.

        Returns:
            The parsed :class:`DiscoveryDocument`.

        Raises:
            ImportSourceError: On SSRF rejection, network failure, directory-without-selection,
                or a non-Discovery body.
        """
        del auth_type, auth_payload, headers, fallback_sdl  # SPI parity; Discovery is public.
        url = (endpoint_url or "").strip() or DEFAULT_DIRECTORY_URL
        if api_id:
            return self.import_from_directory(api_id, directory_url=url, client=client)

        try:
            text = fetch_rest_description(url, client=client)
        except DiscoveryDirectoryError as exc:
            raise ImportSourceError(str(exc)) from exc

        try:
            document = parse_document(text)
        except IngestionError as exc:
            raise ImportSourceError(str(exc)) from exc

        if is_discovery_directory(document):
            count = len(document.get("items") or []) if isinstance(document.get("items"), list) else 0
            raise ImportSourceError(
                f"URL returned a Discovery directory listing with {count} API(s). "
                "Pass api_id to select one, or provide a discoveryRestUrl directly."
            )

        return self.parse(text, source_label=source_label or url)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, DiscoveryDocument):
            raise ImportSourceError(
                "Discovery source must be a DiscoveryDocument "
                "(see app.discovery_parser.parse_discovery)"
            )
        return self._normalize_via_registry("discovery", native_ast, include_raw=include_raw)
