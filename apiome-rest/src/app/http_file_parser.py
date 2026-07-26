"""Parser for VS Code / JetBrains ``.http`` / ``.rest`` request files and cURL paste.

Produces a typed :class:`HttpFileDocument` of concrete request observations that the
shared inferred-spec engine (:mod:`app.inferred_spec`) clusters into a canonical REST
surface. This format asserts nothing — every construct is inferred.
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlparse

from .inferred_spec import HttpObservation

__all__ = [
    "HttpFileDocument",
    "HttpFileParseError",
    "is_http_file",
    "parse_http_file",
    "parse_http_fileset",
    "parse_env_file",
]

_HTTP_METHODS = frozenset(
    {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"}
)
_REQUEST_LINE_RE = re.compile(
    r"^\s*(?P<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+"
    r"(?P<url>\S+)\s*(?:HTTP/\d(?:\.\d)?)?\s*$",
    re.IGNORECASE,
)
_VAR_DEF_RE = re.compile(r"^@(?P<name>[A-Za-z_][\w-]*)\s*=\s*(?P<value>.*)$")
_VAR_REF_RE = re.compile(r"\{\{\s*([A-Za-z_][\w-]*)\s*\}\}")
_SEPARATOR_RE = re.compile(r"^#{3,}.*$")
_REQUEST_NAME_RE = re.compile(r"^#\s*@name\s+(\S+)\s*$", re.IGNORECASE)
_CURL_RE = re.compile(r"^\s*curl\b", re.IGNORECASE | re.MULTILINE)


class HttpFileParseError(ValueError):
    """Raised when an ``.http`` / ``.rest`` / cURL document cannot be parsed."""

    def __init__(self, message: str, *, code: str = "INPUT_MALFORMED") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class HttpFileDocument:
    """Parsed request-file document ready for inference.

    Attributes:
        title: Human title derived from the source label or first ``@name``.
        observations: Concrete HTTP request samples.
        variables: Resolved file-level and environment variables.
        source_label: Filename / paste label for provenance.
        raw: Original text when retained.
    """

    title: str
    observations: List[HttpObservation] = field(default_factory=list)
    variables: Dict[str, str] = field(default_factory=dict)
    source_label: Optional[str] = None
    raw: Optional[str] = None


def is_http_file(text: str, *, filename: Optional[str] = None) -> bool:
    """Cheap sniff: does ``text`` look like an ``.http``/``.rest`` file or cURL paste?"""
    if not text or not text.strip():
        return False
    name = (filename or "").lower()
    if name.endswith(".http") or name.endswith(".rest"):
        return True
    if _CURL_RE.search(text):
        return True
    # Reject obvious OpenAPI / Postman / JSON Schema so we do not steal those pastes.
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        lower = stripped[:200].lower()
        if '"openapi"' in lower or '"swagger"' in lower or '"info"' in lower and '"paths"' in lower:
            return False
        if "postman_collection" in lower or '"item"' in lower and '"request"' in lower:
            return False
    lines = text.splitlines()
    request_lines = 0
    separators = 0
    var_defs = 0
    for line in lines[:80]:
        if _SEPARATOR_RE.match(line):
            separators += 1
        if _VAR_DEF_RE.match(line.strip()):
            var_defs += 1
        if _REQUEST_LINE_RE.match(line):
            request_lines += 1
    if request_lines >= 1:
        return True
    if separators >= 1 and var_defs >= 1:
        return True
    return False


def parse_env_file(text: str) -> Dict[str, str]:
    """Parse a simple ``.env`` / JetBrains http-client env JSON / key=value file.

    Unresolved keys stay absent — callers never invent values.
    """
    text = text.strip()
    if not text:
        return {}
    if text.startswith("{"):
        try:
            document = json.loads(text)
        except json.JSONDecodeError as exc:
            raise HttpFileParseError(
                f"Environment JSON is malformed: {exc}",
                code="INPUT_MALFORMED",
            ) from exc
        if not isinstance(document, dict):
            raise HttpFileParseError(
                "Environment JSON must be an object",
                code="INPUT_MALFORMED",
            )
        # JetBrains http-client.env.json: { "dev": { "host": "..." }, ... }
        # Prefer a flat map; if nested, merge the first environment alphabetically.
        flat: Dict[str, str] = {}
        nested_envs = [
            (key, value)
            for key, value in document.items()
            if isinstance(value, dict)
        ]
        if nested_envs and all(isinstance(v, dict) for v in document.values()):
            env_name, env_vars = sorted(nested_envs, key=lambda pair: pair[0])[0]
            _ = env_name
            for key, value in env_vars.items():
                if isinstance(value, (str, int, float, bool)):
                    flat[str(key)] = str(value)
            return flat
        for key, value in document.items():
            if isinstance(value, (str, int, float, bool)):
                flat[str(key)] = str(value)
        return flat

    result: Dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("@"):
            match = _VAR_DEF_RE.match(stripped)
            if match:
                result[match.group("name")] = match.group("value").strip().strip('"').strip("'")
            continue
        if "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        name = name.strip()
        if name.startswith("export "):
            name = name[len("export ") :].strip()
        if not name:
            continue
        result[name] = value.strip().strip('"').strip("'")
    return result


def _substitute(text: str, variables: Dict[str, str]) -> str:
    """Replace ``{{var}}`` with known values; leave unresolved references literal."""

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in variables:
            return variables[name]
        return match.group(0)

    return _VAR_REF_RE.sub(repl, text)


def _split_blocks(text: str) -> List[Tuple[int, List[str]]]:
    """Split on ``###`` separators; return ``(1-based start_line, lines)`` blocks."""
    lines = text.splitlines()
    blocks: List[Tuple[int, List[str]]] = []
    current: List[str] = []
    start_line = 1
    for index, line in enumerate(lines, start=1):
        if _SEPARATOR_RE.match(line):
            if any(part.strip() for part in current):
                blocks.append((start_line, current))
            current = []
            start_line = index + 1
            continue
        current.append(line)
    if any(part.strip() for part in current):
        blocks.append((start_line, current))
    return blocks


def _parse_headers_and_body(
    lines: Sequence[str],
) -> Tuple[List[Tuple[str, str]], Optional[str]]:
    headers: List[Tuple[str, str]] = []
    body_start: Optional[int] = None
    for index, line in enumerate(lines):
        if line.strip() == "":
            body_start = index + 1
            break
        if ":" not in line:
            # Not a header — treat remainder as body (JetBrains allows body without blank line
            # when Content-Type is set; keep simple: non-header after headers starts body).
            if headers:
                body_start = index
                break
            continue
        name, _, value = line.partition(":")
        headers.append((name.strip(), value.strip()))
    body: Optional[str] = None
    if body_start is not None:
        body_lines = list(lines[body_start:])
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        body_text = "\n".join(body_lines).strip("\n")
        if body_text.strip():
            body = body_text
    return headers, body


def _parse_curl_command(text: str, *, source_location: str, source_label: Optional[str], source_file: Optional[str], variables: Dict[str, str]) -> HttpObservation:
    """Parse a single ``curl`` invocation into an observation."""
    # Collapse line continuations
    collapsed = re.sub(r"\\\s*\n", " ", text)
    collapsed = _substitute(collapsed.strip(), variables)
    try:
        tokens = shlex.split(collapsed, posix=True)
    except ValueError as exc:
        raise HttpFileParseError(f"cURL command is malformed: {exc}", code="INPUT_MALFORMED") from exc
    if not tokens or tokens[0].lower() != "curl":
        raise HttpFileParseError("Expected a curl command", code="INPUT_MALFORMED")

    method = "GET"
    url: Optional[str] = None
    headers: List[Tuple[str, str]] = []
    body: Optional[str] = None
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in {"-X", "--request"} and index + 1 < len(tokens):
            method = tokens[index + 1].upper()
            index += 2
            continue
        if token in {"-H", "--header"} and index + 1 < len(tokens):
            header = tokens[index + 1]
            name, _, value = header.partition(":")
            headers.append((name.strip(), value.strip()))
            index += 2
            continue
        if token in {"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode"} and index + 1 < len(tokens):
            body = tokens[index + 1]
            if method == "GET":
                method = "POST"
            index += 2
            continue
        if token in {"-u", "--user"} and index + 1 < len(tokens):
            headers.append(("Authorization", f"Basic {tokens[index + 1]}"))
            index += 2
            continue
        if token.startswith("-"):
            # Skip unknown flags; consume a value if it does not look like another flag/URL
            if index + 1 < len(tokens) and not tokens[index + 1].startswith("-") and "://" not in tokens[index + 1] and not tokens[index + 1].startswith("/"):
                index += 2
            else:
                index += 1
            continue
        if url is None:
            url = token
        index += 1

    if not url:
        raise HttpFileParseError("cURL command is missing a URL", code="INPUT_MALFORMED")

    query = tuple(parse_qsl(urlparse(url).query, keep_blank_values=True))
    return HttpObservation(
        method=method,
        url=url,
        headers=tuple(headers),
        query=query,
        request_body=body,
        source_location=source_location,
        source_label=source_label,
        source_file=source_file,
    )


def _parse_request_block(
    lines: Sequence[str],
    *,
    start_line: int,
    variables: Dict[str, str],
    source_label: Optional[str],
    source_file: Optional[str],
) -> Optional[HttpObservation]:
    """Parse one request block; return ``None`` when the block has no request line."""
    local_vars = dict(variables)
    request_name: Optional[str] = None
    content_lines: List[str] = []
    for line in lines:
        stripped = line.strip()
        name_match = _REQUEST_NAME_RE.match(stripped)
        if name_match:
            request_name = name_match.group(1)
            continue
        var_match = _VAR_DEF_RE.match(stripped)
        if var_match:
            local_vars[var_match.group("name")] = var_match.group("value").strip()
            continue
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        content_lines.append(line)

    joined = "\n".join(content_lines).strip()
    if not joined:
        return None

    if _CURL_RE.match(joined):
        return _parse_curl_command(
            joined,
            source_location=f"{start_line}:1",
            source_label=source_label or request_name,
            source_file=source_file,
            variables=local_vars,
        )

    # Find request line
    req_index: Optional[int] = None
    method = "GET"
    url = ""
    for index, line in enumerate(content_lines):
        match = _REQUEST_LINE_RE.match(line)
        if match:
            method = match.group("method").upper()
            url = match.group("url")
            req_index = index
            break
    if req_index is None:
        # Path-only shorthand: first non-empty line is a URL
        for index, line in enumerate(content_lines):
            candidate = line.strip()
            if not candidate or candidate.startswith("#"):
                continue
            if candidate.startswith("http://") or candidate.startswith("https://") or candidate.startswith("/"):
                method = "GET"
                url = candidate
                req_index = index
                break
    if req_index is None:
        return None

    url = _substitute(url, local_vars)
    header_lines = content_lines[req_index + 1 :]
    headers_raw, body = _parse_headers_and_body(header_lines)
    headers = tuple(
        (_substitute(name, local_vars), _substitute(value, local_vars))
        for name, value in headers_raw
    )
    if body is not None:
        body = _substitute(body, local_vars)
    query = tuple(parse_qsl(urlparse(url).query, keep_blank_values=True))
    return HttpObservation(
        method=method,
        url=url,
        headers=headers,
        query=query,
        request_body=body,
        source_location=f"{start_line + req_index}:1",
        source_label=source_label or request_name,
        source_file=source_file,
    )


def _collect_file_variables(text: str) -> Dict[str, str]:
    variables: Dict[str, str] = {}
    for line in text.splitlines():
        match = _VAR_DEF_RE.match(line.strip())
        if match:
            variables[match.group("name")] = match.group("value").strip()
    # Allow variables to reference earlier ones
    resolved = dict(variables)
    for _ in range(3):
        for name, value in list(resolved.items()):
            resolved[name] = _substitute(value, resolved)
    return resolved


def parse_http_file(
    raw: str,
    *,
    source_label: Optional[str] = None,
    source_file: Optional[str] = None,
    variables: Optional[Dict[str, str]] = None,
) -> HttpFileDocument:
    """Parse a single ``.http`` / ``.rest`` / cURL document into observations.

    Args:
        raw: Document text.
        source_label: Human label for provenance.
        source_file: Fileset member path when multi-file.
        variables: Pre-loaded environment variables (merged under file-level ``@`` defs).

    Returns:
        An :class:`HttpFileDocument`.

    Raises:
        HttpFileParseError: On empty input, wrong format, or truncated/malformed content.
    """
    if raw is None:
        raise HttpFileParseError("HTTP request file is empty", code="INPUT_MALFORMED")
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HttpFileParseError(
                "HTTP request file is not valid UTF-8",
                code="INPUT_ENCODING_INVALID",
            ) from exc

    text = raw
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")

    if text.startswith("\ufeff") and "\x00" in text[:64]:
        raise HttpFileParseError(
            "HTTP request file is not valid UTF-8 (looks like UTF-16)",
            code="INPUT_ENCODING_INVALID",
        )
    if "\x00" in text[:256]:
        raise HttpFileParseError(
            "HTTP request file contains NUL bytes; expected UTF-8 text",
            code="INPUT_ENCODING_INVALID",
        )

    # Wrong-format guard for corpus negatives
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        lower = stripped[:400].lower()
        if '"openapi"' in lower or '"swagger"' in lower:
            raise HttpFileParseError(
                "Document looks like OpenAPI/Swagger, not an HTTP request file",
                code="FORMAT_MISMATCH",
            )
        if "postman_collection" in lower:
            raise HttpFileParseError(
                "Document looks like a Postman collection, not an HTTP request file",
                code="FORMAT_MISMATCH",
            )

    if not text.strip():
        raise HttpFileParseError("HTTP request file is empty", code="INPUT_MALFORMED")

    # Truncation: unclosed JSON body after a request line with Content-Type json
    if text.rstrip().endswith("{") or text.rstrip().endswith("["):
        raise HttpFileParseError(
            "HTTP request file appears truncated (unclosed body)",
            code="INPUT_TRUNCATED",
        )

    file_vars = dict(variables or {})
    file_vars.update(_collect_file_variables(text))

    observations: List[HttpObservation] = []
    title = source_label or source_file or "HTTP requests"

    if _CURL_RE.match(text.strip()) and "###" not in text and not _REQUEST_LINE_RE.search(text):
        observations.append(
            _parse_curl_command(
                text,
                source_location="1:1",
                source_label=source_label,
                source_file=source_file,
                variables=file_vars,
            )
        )
    else:
        blocks = _split_blocks(text)
        if not blocks:
            raise HttpFileParseError(
                "No HTTP request blocks found",
                code="INPUT_MALFORMED",
            )
        for start_line, block_lines in blocks:
            obs = _parse_request_block(
                block_lines,
                start_line=start_line,
                variables=file_vars,
                source_label=source_label,
                source_file=source_file,
            )
            if obs is not None:
                observations.append(obs)
                if obs.source_label and title == (source_label or source_file or "HTTP requests"):
                    # Prefer first @name as title hint
                    pass

    if not observations:
        raise HttpFileParseError(
            "No HTTP requests could be parsed from the document",
            code="INPUT_MALFORMED",
        )

    return HttpFileDocument(
        title=title,
        observations=observations,
        variables=file_vars,
        source_label=source_label,
        raw=raw,
    )


def parse_http_fileset(
    members: Dict[str, str],
    *,
    root: Optional[str] = None,
    source_label: Optional[str] = None,
) -> HttpFileDocument:
    """Parse a multi-file intake of ``.http``/``.rest`` plus environment files.

    All request files are merged into one document. Environment / ``.env`` /
    ``http-client.env.json`` members supply variables. Each observation keeps
    ``source_file`` provenance.
    """
    if not members:
        raise HttpFileParseError("HTTP fileset has no members", code="INPUT_MALFORMED")

    env_vars: Dict[str, str] = {}
    request_paths: List[str] = []
    for path, text in sorted(members.items()):
        lower = path.lower()
        if (
            lower.endswith(".env")
            or lower.endswith(".env.json")
            or lower.endswith("http-client.env.json")
            or lower.endswith("http-client.private.env.json")
            or "/env/" in lower
            or lower.endswith(".variables")
        ):
            env_vars.update(parse_env_file(text))
        elif lower.endswith(".http") or lower.endswith(".rest"):
            request_paths.append(path)
        elif is_http_file(text, filename=path):
            request_paths.append(path)

    if not request_paths and root and root in members:
        request_paths = [root]

    if not request_paths:
        raise HttpFileParseError(
            "HTTP fileset contains no .http / .rest request files",
            code="INPUT_MALFORMED",
        )

    all_observations: List[HttpObservation] = []
    merged_vars = dict(env_vars)
    title = source_label or root or request_paths[0]
    raw_parts: List[str] = []

    for path in request_paths:
        document = parse_http_file(
            members[path],
            source_label=path,
            source_file=path,
            variables=env_vars,
        )
        merged_vars.update(document.variables)
        all_observations.extend(document.observations)
        if document.raw:
            raw_parts.append(f"### file: {path}\n{document.raw}")

    if not all_observations:
        raise HttpFileParseError(
            "HTTP fileset produced no requests",
            code="INPUT_MALFORMED",
        )

    return HttpFileDocument(
        title=title,
        observations=all_observations,
        variables=merged_vars,
        source_label=source_label or root,
        raw="\n\n".join(raw_parts) if raw_parts else None,
    )
