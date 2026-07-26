"""Google API Discovery directory live fetch — IXH-7.1 (#5126).

Lists APIs from a Discovery directory endpoint and fetches a selected rest
description through the SSRF-guarded HTTP client.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
from typing import Any, List, Mapping, Optional, Sequence

import httpx

from .discovery_parser import (
    DiscoveryDocument,
    DiscoveryParseError,
    is_discovery_directory,
    parse_discovery,
)
from .import_ingestion import IngestionError, parse_document
from .ssrf_guard import SSRFError, build_guarded_client, validate_url

__all__ = [
    "DEFAULT_DIRECTORY_URL",
    "DiscoveryApiListing",
    "DiscoveryDirectoryError",
    "fetch_rest_description",
    "import_api_from_directory",
    "list_directory_apis",
]

DEFAULT_DIRECTORY_URL = "https://www.googleapis.com/discovery/v1/apis"

_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=15.0)
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

try:
    _UA = f"apiome-discovery/{metadata.version('apiome-rest')}"
except metadata.PackageNotFoundError:
    _UA = "apiome-discovery/dev"


class DiscoveryDirectoryError(Exception):
    """Raised when a Discovery directory/rest fetch is misconfigured or fails."""


@dataclass(frozen=True)
class DiscoveryApiListing:
    """One API entry from a Discovery directory listing."""

    id: str
    name: str
    version: str
    title: Optional[str]
    description: Optional[str]
    discovery_rest_url: str
    preferred: bool = False


def _optional_str(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _fetch_text(url: str, *, client: Optional[httpx.Client] = None) -> str:
    """GET ``url`` through the SSRF-guarded client and return UTF-8 text."""
    cleaned = (url or "").strip()
    if not cleaned:
        raise DiscoveryDirectoryError("Discovery URL is empty")
    try:
        validate_url(cleaned)
    except SSRFError as exc:
        raise DiscoveryDirectoryError(str(exc)) from exc

    headers = {
        "User-Agent": _UA,
        "Accept": "application/json, application/yaml, text/plain, */*",
    }
    owns_client = client is None
    http = client or build_guarded_client(timeout=_HTTP_TIMEOUT, follow_redirects=True)
    try:
        with http.stream("GET", cleaned, headers=headers) as resp:
            if resp.status_code >= 400:
                raise DiscoveryDirectoryError(
                    f"Discovery URL returned HTTP {resp.status_code}; it may be private or invalid"
                )
            chunks: List[bytes] = []
            total = 0
            for chunk in resp.iter_bytes():
                if not chunk:
                    continue
                chunks.append(chunk)
                total += len(chunk)
                if total > _MAX_RESPONSE_BYTES:
                    raise DiscoveryDirectoryError(
                        f"Discovery response exceeds the {_MAX_RESPONSE_BYTES}-byte limit"
                    )
            return b"".join(chunks).decode("utf-8", errors="replace")
    except SSRFError as exc:
        raise DiscoveryDirectoryError(str(exc)) from exc
    except httpx.HTTPError as exc:
        raise DiscoveryDirectoryError(f"Failed to fetch Discovery URL: {exc}") from exc
    finally:
        if owns_client:
            http.close()


def list_directory_apis(
    directory_url: str = DEFAULT_DIRECTORY_URL,
    *,
    client: Optional[httpx.Client] = None,
) -> Sequence[DiscoveryApiListing]:
    """List APIs advertised by a Discovery directory endpoint.

    Args:
        directory_url: Directory JSON URL (defaults to Google's public directory).
        client: Optional httpx client (tests); production builds a guarded client.

    Returns:
        Stable-ordered listings (preferred first, then by id).

    Raises:
        DiscoveryDirectoryError: On SSRF rejection, network failure, or a non-directory body.
    """
    text = _fetch_text(directory_url, client=client)
    try:
        document = parse_document(text)
    except IngestionError as exc:
        raise DiscoveryDirectoryError(str(exc)) from exc

    if not is_discovery_directory(document):
        raise DiscoveryDirectoryError(
            "URL did not return a Discovery directory listing "
            "(expected kind discovery#directoryList)"
        )

    items = document.get("items")
    if not isinstance(items, list):
        return ()

    listings: List[DiscoveryApiListing] = []
    for entry in items:
        if not isinstance(entry, Mapping):
            continue
        api_id = _optional_str(entry.get("id"))
        name = _optional_str(entry.get("name"))
        version = _optional_str(entry.get("version"))
        rest_url = _optional_str(entry.get("discoveryRestUrl"))
        if not api_id or not name or not version or not rest_url:
            continue
        listings.append(
            DiscoveryApiListing(
                id=api_id,
                name=name,
                version=version,
                title=_optional_str(entry.get("title")),
                description=_optional_str(entry.get("description")),
                discovery_rest_url=rest_url,
                preferred=entry.get("preferred") is True,
            )
        )

    listings.sort(key=lambda item: (not item.preferred, item.id.lower()))
    return tuple(listings)


def fetch_rest_description(
    url: str,
    *,
    client: Optional[httpx.Client] = None,
) -> str:
    """Fetch a Discovery rest-description document as text (SSRF-guarded)."""
    return _fetch_text(url, client=client)


def import_api_from_directory(
    api_id: str,
    *,
    directory_url: str = DEFAULT_DIRECTORY_URL,
    client: Optional[httpx.Client] = None,
) -> DiscoveryDocument:
    """Resolve ``api_id`` in the directory and parse its rest description.

    Args:
        api_id: Directory id (``name:version``, e.g. ``webfonts:v1``) or bare name
            when exactly one preferred match exists.
        directory_url: Directory endpoint to query.
        client: Optional httpx client (tests).

    Returns:
        The parsed :class:`DiscoveryDocument` for the selected API.

    Raises:
        DiscoveryDirectoryError: If the API cannot be resolved or fetched.
        DiscoveryParseError: If the fetched body is not a valid rest description.
    """
    wanted = (api_id or "").strip()
    if not wanted:
        raise DiscoveryDirectoryError("API id is empty")

    listings = list(list_directory_apis(directory_url, client=client))
    match: Optional[DiscoveryApiListing] = None
    for item in listings:
        if item.id == wanted or f"{item.name}:{item.version}" == wanted:
            match = item
            break
    if match is None:
        name_matches = [item for item in listings if item.name == wanted]
        preferred = [item for item in name_matches if item.preferred]
        if len(preferred) == 1:
            match = preferred[0]
        elif len(name_matches) == 1:
            match = name_matches[0]
        elif name_matches:
            ids = ", ".join(item.id for item in name_matches[:8])
            raise DiscoveryDirectoryError(
                f"Ambiguous Discovery API name {wanted!r}; choose one of: {ids}"
            )
    if match is None:
        raise DiscoveryDirectoryError(f"Discovery API {wanted!r} not found in directory")

    text = fetch_rest_description(match.discovery_rest_url, client=client)
    try:
        return parse_discovery(text, source_label=match.discovery_rest_url)
    except DiscoveryParseError:
        raise
