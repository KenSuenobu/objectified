"""Import source ingestion for the Primitives import pipeline (#3460).

The import pipeline accepts a source document by one of four **methods** — paste,
file, URL, or git — and normalizes it to a parsed document that the staging step
(#3461/#3462) turns into candidate types. This module is the ingestion layer: one
fetcher per method, each returning the raw text plus the parsed (JSON or YAML)
document.

Only ingestion lives here; detection/staging of candidate types is in
``import_pipeline``. Network and subprocess access are isolated to the URL and
git fetchers so a caller (or a test) can mock a single, well-defined boundary.
"""

import json
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx
import yaml

from .intake_resource_guard import (
    IntakeLimitError,
    guard_document_text,
    guard_parsed_document,
)
from .repository_file_scan import fetch_github_repository_file_text
from .repository_validation import parse_github_owner_repo_from_url
from .ssrf_guard import SSRFError, build_guarded_client, validate_url

# Source intake methods the pipeline understands.
VALID_SOURCE_METHODS = {"paste", "file", "url", "git"}

# Cap on ingested document size, so a runaway URL/git target cannot exhaust memory.
DEFAULT_MAX_BYTES = 2_000_000

# Network timeout for URL ingestion.
_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=15.0)
_UA = "Apiome-ImportPipeline/1.0"


class IngestionError(Exception):
    """A source document could not be fetched or parsed.

    Carries a human-readable ``message`` so the route can surface it directly
    (e.g. a 400/422 detail) without leaking stack traces.
    """

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


@dataclass
class IngestedDocument:
    """The normalized result of ingesting one source document.

    Attributes:
        document: The parsed document as a mapping (JSON or YAML).
        text: The raw source text, retained for re-parsing by later stages.
        resolved_label: A human label for the source (filename / URL / git path),
            falling back to the caller-supplied label when one is not derivable.
    """

    document: Dict[str, Any]
    text: str
    resolved_label: Optional[str] = None


def parse_document(text: str, *, source_label: Optional[str] = None) -> Dict[str, Any]:
    """Parse a source document, accepting either JSON or YAML.

    JSON is tried first (the common case and stricter); YAML is the fallback so
    YAML-authored OpenAPI / JSON Schema documents ingest without a separate flag.
    A YAML document is itself a superset of JSON, so this never loses a JSON parse.

    Resource guards run first and again after parsing (IXH-1.4): an oversized
    document, a YAML alias bomb, or a pathologically deep structure is rejected
    by :mod:`app.intake_resource_guard` before it can exhaust memory or the
    stack. Those violations raise :class:`IntakeLimitError`, which carries the
    intake-taxonomy code and is *not* wrapped in :class:`IngestionError` so the
    specific limit survives to the job status.

    Args:
        text: The raw document text.
        source_label: Optional label used only to make error messages specific.

    Returns:
        The parsed document as a mapping.

    Raises:
        IngestionError: If the text is empty, unparseable as JSON or YAML, or
            does not parse to a JSON object / YAML mapping at the top level.
        IntakeLimitError: If the document breaches an intake resource limit.
    """
    if text is None or not text.strip():
        raise IngestionError("Source document is empty")

    guard_document_text(text, source_label=source_label)

    parsed: Any
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        try:
            parsed = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            where = f" ({source_label})" if source_label else ""
            raise IngestionError(f"Source document is not valid JSON or YAML{where}: {exc}")
        except RecursionError as exc:
            # A deeply nested flow document can still exhaust the stack inside
            # PyYAML's recursive composer, below the pre-parse depth bound.
            raise IntakeLimitError(
                f"Source document nests too deeply to parse"
                f"{f' ({source_label})' if source_label else ''}",
                code="INPUT_DEPTH_LIMIT",
            ) from exc

    guard_parsed_document(parsed, source_label=source_label)

    if not isinstance(parsed, dict):
        where = f" ({source_label})" if source_label else ""
        raise IngestionError(
            f"Source document must be a JSON object / YAML mapping at the top level{where}"
        )
    return parsed


def _fetch_url_text(url: str, *, max_bytes: int) -> str:
    """Fetch a document over http/https, capping the read at ``max_bytes``.

    Args:
        url: The source URL. Only ``http`` and ``https`` schemes are accepted.
        max_bytes: Hard cap on bytes read from the response body.

    Returns:
        The response body decoded as UTF-8 (invalid bytes replaced).

    Raises:
        IngestionError: For a non-http(s) scheme, a network failure, or a non-2xx
            response.
    """
    try:
        scheme = (urlparse(url.strip()).scheme or "").lower()
    except Exception:
        raise IngestionError(f"Malformed URL: {url}")
    if scheme not in ("http", "https"):
        raise IngestionError("URL ingestion supports only http/https URLs")

    # SSRF guard: reject internal/metadata targets before connecting (#3612).
    # ``build_guarded_client`` re-validates every redirect hop as well.
    try:
        validate_url(url.strip())
    except SSRFError as exc:
        raise IngestionError(str(exc))

    headers = {"User-Agent": _UA, "Accept": "application/json, application/yaml, text/plain, */*"}
    try:
        with build_guarded_client(timeout=_HTTP_TIMEOUT, follow_redirects=True) as client:
            with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code >= 400:
                    raise IngestionError(
                        f"URL returned HTTP {resp.status_code}; it may be private or invalid"
                    )
                chunks = []
                total = 0
                for chunk in resp.iter_bytes():
                    if not chunk:
                        continue
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > max_bytes:
                        raise IngestionError(
                            f"Source document exceeds the {max_bytes}-byte ingestion limit"
                        )
    except SSRFError as exc:
        # A redirect hop pointed at a non-public address (caught by the guard hook).
        raise IngestionError(str(exc))
    except httpx.HTTPError as exc:
        raise IngestionError(f"Failed to fetch URL: {exc}")

    return b"".join(chunks).decode("utf-8", errors="replace")


def _fetch_git_text(git: Dict[str, Any], *, max_bytes: int) -> str:
    """Fetch a single file from a Git repository.

    MVP supports public GitHub repositories via the GitHub contents API, reusing
    the repository-scan fetcher (private repos are served by the dedicated
    repository-store import path, not this ad-hoc pipeline).

    Args:
        git: A locator mapping with ``repo_url`` (a github.com URL), ``path`` (the
            file path within the repo), and optional ``ref`` (branch/tag/SHA,
            default ``main``).
        max_bytes: Hard cap on bytes read from the file.

    Returns:
        The file text (UTF-8, invalid bytes replaced).

    Raises:
        IngestionError: For a missing/unsupported locator or a fetch failure.
    """
    repo_url = str(git.get("repo_url") or "").strip()
    path = str(git.get("path") or "").strip()
    ref = str(git.get("ref") or "main").strip() or "main"
    if not repo_url or not path:
        raise IngestionError("git ingestion requires both 'repo_url' and 'path'")

    owner_repo = parse_github_owner_repo_from_url(repo_url)
    if not owner_repo:
        raise IngestionError(
            "git ingestion currently supports github.com repositories only"
        )
    owner, repo = owner_repo

    try:
        text, truncated = fetch_github_repository_file_text(
            owner, repo, path, ref, access_token=None, max_bytes=max_bytes
        )
    except ValueError as exc:
        raise IngestionError(f"Failed to fetch git file: {exc}")

    if truncated:
        raise IngestionError(
            f"git file exceeds the {max_bytes}-byte ingestion limit"
        )
    return text


def ingest_source(
    method: str,
    *,
    content: Optional[str] = None,
    url: Optional[str] = None,
    git: Optional[Dict[str, Any]] = None,
    source_label: Optional[str] = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> IngestedDocument:
    """Fetch and parse a source document by intake method.

    Dispatches on ``method`` and returns a parsed, normalized document:

    - ``paste`` / ``file``: the document text is already in hand (``content``).
      Both share the same intake; they differ only in provenance — ``file`` names
      an uploaded file via ``source_label`` while ``paste`` is inline text.
    - ``url``: fetched over http/https.
    - ``git``: a single file fetched from a (public) GitHub repository.

    Args:
        method: One of :data:`VALID_SOURCE_METHODS`.
        content: Raw document text, required for ``paste`` / ``file``.
        url: Source URL, required for ``url``.
        git: Git locator (``repo_url`` / ``path`` / ``ref``), required for ``git``.
        source_label: Caller-supplied label (filename / human name) used as the
            fallback ``resolved_label`` and to make parse errors specific.
        max_bytes: Hard cap on ingested document size.

    Returns:
        The :class:`IngestedDocument` (parsed mapping + raw text + resolved label).

    Raises:
        IngestionError: For an unknown method, a missing locator, a fetch failure,
            or an unparseable document.
    """
    if method not in VALID_SOURCE_METHODS:
        raise IngestionError(
            f"Invalid source_method '{method}'. "
            f"Expected one of: {', '.join(sorted(VALID_SOURCE_METHODS))}"
        )

    resolved_label = source_label

    if method in ("paste", "file"):
        if content is None or not content.strip():
            raise IngestionError(f"source_method '{method}' requires non-empty 'content'")
        text = content
    elif method == "url":
        if not url or not url.strip():
            raise IngestionError("source_method 'url' requires a 'url'")
        text = _fetch_url_text(url, max_bytes=max_bytes)
        resolved_label = resolved_label or url
    else:  # git
        if not git:
            raise IngestionError("source_method 'git' requires a 'git' locator")
        text = _fetch_git_text(git, max_bytes=max_bytes)
        resolved_label = resolved_label or f"{git.get('repo_url')}#{git.get('path')}"

    document = parse_document(text, source_label=resolved_label)
    return IngestedDocument(document=document, text=text, resolved_label=resolved_label)
