"""Shared request routing for the mock runtime (#5532, MSC-2.2).

This module is deliberately *not* an engine. It answers one narrow question — **which OpenAPI
operation does this method + path address?** — and nothing else. Response resolution (scenarios,
templates, predicates, stateful CRUD, fixtures, chaos, the non-HTTP transports) lives entirely in
``apiome_mock``; this package holds only the routing primitives that both the author-time
validators here and the runtime there must agree on.

That split is the point of MSC-2.2. Before it, an ``app.mock_engine`` module owned both routing
*and* a second, weaker resolver, and apiome-mock imported the routing three symbols out of it while
reimplementing everything downstream. Two resolvers described the same product concept, so a
feature built in one was invisible in the other. The resolver is gone; the routing stayed, and it
lives here under a name that says what it is.

What it provides:

* :class:`MockOperation` — one OpenAPI operation flattened out of the spec's ``paths``, carrying a
  compiled matcher for its path template.
* :func:`extract_operations` — flatten a spec into those operations.
* :func:`match_operation` — pick the operation for a concrete request path and extract its path
  parameters, preferring literal segments over parameterised ones.
* :func:`compile_path_template` — the path-template → regex compiler the above are built on,
  exported because callers that route by path alone (allowed-method discovery, for one) need it.

Keeping this free of FastAPI, the database and the resolver lets both packages unit-test routing
directly against synthetic specs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

__all__ = [
    "HTTP_METHODS",
    "MockOperation",
    "compile_path_template",
    "extract_operations",
    "match_operation",
]

HTTP_METHODS: Tuple[str, ...] = (
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
)
"""Path-item keys that name an operation; everything else (``parameters``, ``summary``) is not one."""


def compile_path_template(template: str) -> re.Pattern:
    """Compile an OpenAPI path template into a full-match regex with named groups per ``{param}``.

    ``/pets/{petId}`` becomes ``^/pets/(?P<petId>[^/]+)/?$``. Parameter names are sanitised to valid
    Python group names; a single trailing or leading slash is tolerated.

    Args:
        template: The OpenAPI path template, e.g. ``"/pets/{petId}"``.

    Returns:
        The compiled matcher for concrete request paths.
    """
    normalized = "/" + template.strip("/")
    parts = normalized.split("/")
    pattern_parts: List[str] = []
    for part in parts:
        match = re.fullmatch(r"\{(.+?)\}", part)
        if match:
            group = re.sub(r"\W", "_", match.group(1))
            pattern_parts.append(rf"(?P<{group}>[^/]+)")
        else:
            pattern_parts.append(re.escape(part))
    pattern = "/".join(pattern_parts)
    return re.compile(rf"^{pattern}/?$")


@dataclass
class MockOperation:
    """One OpenAPI operation flattened out of the spec's ``paths``.

    Attributes:
        method: Upper-case HTTP method.
        path_template: The templated path, e.g. ``"/pets/{petId}"``.
        operation: The raw operation object (``responses``, ``requestBody``, ...).
    """

    method: str
    path_template: str
    operation: Dict[str, Any]
    _matcher: re.Pattern = field(repr=False)

    @property
    def key(self) -> str:
        """Canonical ``"METHOD /template"`` identifier used to target the operation in scenarios."""
        return f"{self.method} {self.path_template}"

    @property
    def parameter_count(self) -> int:
        """How many ``{param}`` placeholders the path template declares."""
        return self.path_template.count("{")

    def matches_path(self, path: str) -> Optional[Dict[str, str]]:
        """Match a concrete request path against this operation's template.

        Ignores the method: callers that need method-aware matching use
        :func:`match_operation`, while callers enumerating what a *path* supports (405 handling,
        allowed-method discovery) need exactly this.

        Args:
            path: The concrete request path, with or without a leading slash.

        Returns:
            The extracted path parameters when the template matches, else ``None``. An empty dict
            is a match with no parameters, which is why the miss is ``None`` and not ``{}``.
        """
        matched = self._matcher.match("/" + path.strip("/"))
        return matched.groupdict() if matched else None


def extract_operations(spec: Dict[str, Any]) -> List[MockOperation]:
    """Flatten ``spec.paths`` into one :class:`MockOperation` per method + path.

    Args:
        spec: An OpenAPI document. Anything that is not a mapping with a ``paths`` mapping yields
            no operations rather than raising — a malformed stored spec must never break a caller.

    Returns:
        The operations, in document order.
    """
    operations: List[MockOperation] = []
    paths = spec.get("paths") if isinstance(spec, dict) else None
    if not isinstance(paths, dict):
        return operations
    for template, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        matcher = compile_path_template(template)
        for method, operation in path_item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, dict):
                continue
            operations.append(
                MockOperation(
                    method=method.upper(),
                    path_template=template,
                    operation=operation,
                    _matcher=matcher,
                )
            )
    return operations


def match_operation(
    operations: List[MockOperation], method: str, path: str
) -> Tuple[Optional[MockOperation], Dict[str, str]]:
    """Find the operation matching ``method`` + concrete ``path``; return it and any path params.

    Literal-segment matches are preferred over parameterised ones (``/pets/mine`` beats
    ``/pets/{petId}``) by sorting candidates so templates with fewer parameters win.

    Args:
        operations: The candidate operations, usually from :func:`extract_operations`.
        method: The request HTTP method; case-insensitive.
        path: The concrete request path, relative to the spec root.

    Returns:
        ``(operation, path_params)``; ``(None, {})`` when nothing matches.
    """
    method = method.upper()
    candidates: List[Tuple[int, MockOperation, Dict[str, str]]] = []
    for op in operations:
        if op.method != method:
            continue
        params = op.matches_path(path)
        if params is not None:
            candidates.append((op.parameter_count, op, params))
    if not candidates:
        return None, {}
    candidates.sort(key=lambda c: c[0])
    _, op, params = candidates[0]
    return op, params
