"""Map intake/delivery taxonomy categories to CLI exit codes (IXH-6.4).

Job wait loops key off the structured ``error`` object on a failed import/export
poll payload — ``code``, ``category``, ``message``, ``remediation`` — rather than
parsing free-form event messages. Pre-flight gate codes (3–5) stay exclusive to
the preflight surface; this module only maps *job* taxonomy categories.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from apiome_cli.exit_codes import (
    EXIT_ERROR,
    EXIT_POLICY_BLOCKED,
    EXIT_USAGE,
)

#: Categories that mean the caller's input / config / acknowledgement is at fault.
_USAGE_CATEGORIES = frozenset({"input", "format", "capability", "resource"})

#: Tenant / confirmation policy refused the request.
_POLICY_CATEGORIES = frozenset({"policy"})


def exit_code_for_category(category: str | None) -> int:
    """Return the CLI exit code for a taxonomy ``category`` string.

    Mapping (job wait loops only):

    * ``policy`` → :data:`EXIT_POLICY_BLOCKED` (3)
    * ``input`` / ``format`` / ``capability`` / ``resource`` → :data:`EXIT_USAGE` (2)
    * ``transport`` / ``internal`` / unknown / missing → :data:`EXIT_ERROR` (1)
    """
    if not category or not isinstance(category, str):
        return EXIT_ERROR
    normalized = category.strip().lower()
    if normalized in _POLICY_CATEGORIES:
        return EXIT_POLICY_BLOCKED
    if normalized in _USAGE_CATEGORIES:
        return EXIT_USAGE
    return EXIT_ERROR


def format_taxonomy_error(error: Mapping[str, Any]) -> str | None:
    """Format ``[CODE] message — remediation`` from a structured job ``error`` object.

    Returns ``None`` when the mapping carries nothing usable.
    """
    code = error.get("code")
    message = error.get("message")
    remediation = error.get("remediation")

    code_s = code.strip() if isinstance(code, str) and code.strip() else None
    message_s = message.strip() if isinstance(message, str) and message.strip() else None
    rem_s = (
        remediation.strip()
        if isinstance(remediation, str) and remediation.strip()
        else None
    )

    if not code_s and not message_s and not rem_s:
        return None

    parts: list[str] = []
    if code_s and message_s:
        parts.append(f"[{code_s}] {message_s}")
    elif code_s:
        parts.append(f"[{code_s}]")
    elif message_s:
        parts.append(message_s)

    if rem_s:
        if parts:
            parts.append(f"— {rem_s}")
        else:
            parts.append(rem_s)

    return " ".join(parts) if parts else None


def taxonomy_failure_from_payload(
    payload: Mapping[str, Any],
) -> tuple[str | None, int]:
    """Extract taxonomy stderr detail and exit code from a failed job poll payload.

    Prefers ``payload["error"]`` (structured taxonomy). Returns ``(None, EXIT_ERROR)``
    when no structured error is present — callers should fall back to event scraping.
    """
    error = payload.get("error")
    if not isinstance(error, Mapping):
        return None, EXIT_ERROR
    detail = format_taxonomy_error(error)
    if detail is None and not (
        isinstance(error.get("code"), str) and error.get("code").strip()  # type: ignore[union-attr]
    ):
        return None, EXIT_ERROR
    category = error.get("category")
    category_s = category if isinstance(category, str) else None
    # Even without a formatted detail, a registered category still drives the exit code.
    exit_code = exit_code_for_category(category_s)
    return detail, exit_code
