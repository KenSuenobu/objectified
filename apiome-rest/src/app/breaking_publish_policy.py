"""Breaking-publish guardrail policy vocabulary (CTG-3.4, #4478).

Deliberately dependency-free: the guide editor (``style_guide_routes`` /
``style_guide_revisions``) and the publish gate (``breaking_publish_guardrail``) both need to
normalize the same three-level setting, and the guide surfaces must not drag the compatibility
engine into their import graph to get it.

Levels:
    ``off``   — the guardrail never surfaces.
    ``warn``  — the publish dialog warns; publish proceeds. **Default.**
    ``block`` — publish is refused unless force-published with a reason (GOV-2.5 pattern).
"""

from __future__ import annotations

from typing import Any, Tuple

__all__ = [
    "BREAKING_PUBLISH_POLICY_OFF",
    "BREAKING_PUBLISH_POLICY_WARN",
    "BREAKING_PUBLISH_POLICY_BLOCK",
    "BREAKING_PUBLISH_POLICY_LEVELS",
    "DEFAULT_BREAKING_PUBLISH_POLICY",
    "normalize_breaking_publish_policy",
]

BREAKING_PUBLISH_POLICY_OFF = "off"
BREAKING_PUBLISH_POLICY_WARN = "warn"
BREAKING_PUBLISH_POLICY_BLOCK = "block"

#: Closed vocabulary, mirroring the V237 ``style_guides_breaking_publish_policy_ck`` check.
BREAKING_PUBLISH_POLICY_LEVELS: Tuple[str, ...] = (
    BREAKING_PUBLISH_POLICY_OFF,
    BREAKING_PUBLISH_POLICY_WARN,
    BREAKING_PUBLISH_POLICY_BLOCK,
)

#: What a tenant gets without configuring anything — warn, never block.
DEFAULT_BREAKING_PUBLISH_POLICY = BREAKING_PUBLISH_POLICY_WARN


def normalize_breaking_publish_policy(raw: Any) -> str:
    """Coerce a stored/submitted policy value into the closed vocabulary.

    Args:
        raw: Any candidate value — a DB column, a request field, ``None``.

    Returns:
        One of :data:`BREAKING_PUBLISH_POLICY_LEVELS`; unknown or missing values fall back to
        :data:`DEFAULT_BREAKING_PUBLISH_POLICY`, so a bad value can never silently escalate a
        tenant to ``block``.
    """
    value = str(raw or "").strip().lower()
    if value in BREAKING_PUBLISH_POLICY_LEVELS:
        return value
    return DEFAULT_BREAKING_PUBLISH_POLICY
