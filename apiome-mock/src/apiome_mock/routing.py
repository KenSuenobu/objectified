"""OpenAPI path and method matching for the mock data plane."""

from __future__ import annotations

from app.mock_routing import MockOperation, match_operation


def operations_for_path(operations: tuple[MockOperation, ...], path: str) -> list[MockOperation]:
    """Return every operation whose path template matches the concrete request path."""
    normalized = "/" + path.strip("/")
    matched: list[MockOperation] = []
    for op in operations:
        if op._matcher.match(normalized):
            matched.append(op)
    return matched


def match_request(
    operations: tuple[MockOperation, ...],
    method: str,
    path: str,
) -> tuple[MockOperation | None, dict[str, str], list[str]]:
    """Match method+path; return operation, path params, and allowed methods for the path."""
    path_ops = operations_for_path(operations, path)
    allowed_methods = sorted({op.method for op in path_ops})
    operation, params = match_operation(list(operations), method, path)
    return operation, params, allowed_methods
