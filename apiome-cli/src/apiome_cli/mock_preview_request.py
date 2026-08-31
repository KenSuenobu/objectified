"""Build a synthetic preview request from command-line options (#5530, MSC-1.4).

``apiome mock preview`` describes one request with ordinary flags — ``-X``, ``--path``, repeated
``-H`` and ``-q``, ``--body`` — and sends it as the JSON document both the hosted preview endpoint
and the portable runtime accept. Turning the flags into that document is pure, so it is here rather
than inside the command, and so the rules below are testable on their own.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Sequence

__all__ = [
    "PreviewRequestError",
    "build_preview_request",
    "parse_body",
    "parse_headers",
    "parse_query",
]


class PreviewRequestError(ValueError):
    """A request option could not be understood."""


def parse_headers(values: Sequence[str]) -> dict[str, str]:
    """Parse repeated ``-H 'Name: value'`` options.

    Args:
        values: The raw option values, in the order they were given.

    Returns:
        The headers, later values replacing earlier ones for the same name.

    Raises:
        PreviewRequestError: An option has no ``:`` separator or an empty name.
    """
    headers: dict[str, str] = {}
    for raw in values:
        name, separator, value = raw.partition(":")
        if not separator or not name.strip():
            raise PreviewRequestError(f"--header must look like 'Name: value' (got {raw!r}).")
        headers[name.strip()] = value.strip()
    return headers


def parse_query(values: Sequence[str]) -> dict[str, str | list[str]]:
    """Parse repeated ``-q name=value`` options.

    A name given more than once becomes a list, which is how a multi-valued query parameter
    reaches the mock — the same distinction the runtime itself makes.

    Args:
        values: The raw option values, in the order they were given.

    Returns:
        The query parameters, single-valued as strings and repeated ones as lists.

    Raises:
        PreviewRequestError: An option has no ``=`` separator or an empty name.
    """
    query: dict[str, str | list[str]] = {}
    for raw in values:
        name, separator, value = raw.partition("=")
        if not separator or not name.strip():
            raise PreviewRequestError(f"--query must look like 'name=value' (got {raw!r}).")
        key = name.strip()
        existing = query.get(key)
        if existing is None:
            query[key] = value
        elif isinstance(existing, list):
            existing.append(value)
        else:
            query[key] = [existing, value]
    return query


def parse_body(value: str | None) -> Any:
    """Resolve the ``--body`` option into the request body to send.

    ``@path`` reads a file and ``@-`` reads standard input, matching the convention curl
    established; anything else is the literal value. In every case the text is parsed as JSON when
    it is valid JSON and sent as a plain string when it is not, because the mock's request matching
    and its ``{{request.body…}}`` expressions read a structured body.

    Args:
        value: The raw ``--body`` option, or ``None`` for no body.

    Returns:
        The body to send: a parsed JSON value, a string, or ``None``.

    Raises:
        PreviewRequestError: A ``@path`` reference cannot be read.
    """
    if value is None:
        return None
    if value.startswith("@"):
        reference = value[1:]
        if reference == "-":
            text = sys.stdin.read()
        else:
            try:
                text = Path(reference).read_text(encoding="utf-8")
            except OSError as exc:
                raise PreviewRequestError(f"Cannot read --body file: {exc}") from exc
    else:
        text = value

    try:
        return json.loads(text)
    except ValueError:
        return text


def build_preview_request(
    *,
    method: str,
    path: str,
    headers: Sequence[str],
    query: Sequence[str],
    body: str | None,
    scenario: str | None,
    seed: int | None,
) -> dict[str, Any]:
    """Assemble the synthetic request document from the command line's options.

    Args:
        method: HTTP method.
        path: Path relative to the version root; a ``?query`` suffix is accepted.
        headers: Repeated ``Name: value`` options.
        query: Repeated ``name=value`` options.
        body: The ``--body`` option.
        scenario: Shorthand for the ``X-Mock-Scenario`` header.
        seed: Shorthand for the ``?__seed=`` parameter that pins synthesis.

    Returns:
        The request document, carrying only the fields the caller actually set so that the
        server's own defaults apply to the rest.

    Raises:
        PreviewRequestError: An option could not be understood.
    """
    request: dict[str, Any] = {"method": method.upper(), "path": path}
    parsed_headers = parse_headers(headers)
    if parsed_headers:
        request["headers"] = parsed_headers
    parsed_query = parse_query(query)
    if parsed_query:
        request["query"] = parsed_query
    resolved_body = parse_body(body)
    if resolved_body is not None:
        request["body"] = resolved_body
    if scenario:
        request["scenario"] = scenario
    if seed is not None:
        request["seed"] = seed
    return request
