"""Custom palette actions — the safe effect vocabulary and its validation (DUW-5.5, private-suite#2592).

The pure, DB-free half of the custom-actions API: what a stored definition may say, and the
functions that refuse everything else. A custom action is a *declaration* — a matcher plus an
ordered list of effects drawn from a closed vocabulary — and this module is where "declarative
effects only, no arbitrary code execution" is enforced. Anything resembling script execution is
out of scope by design and defers to the DUW-7.4 sandbox (private-suite#2600 / #966).

The vocabulary mirrors what the workspace client can actually perform (the
``WorkspaceActionEffects`` contract of DUW-5.4):

* ``hydrate-set`` — put the matched subject on the canvas' working set and focus it.
* ``lens-switch`` — switch the canvas lens; carries which one.
* ``open-inspector-tab`` — open the subject in an inspector tab (DUW-6.x); carries the tab slug.
* ``run-consumption-query`` — hydrate every operation consuming the matched class, the built-in
  `find every path that consumes …` flow. Only meaningful for a ``class`` subject, and rejected
  for any other, because an action that silently did nothing for the subjects it matched would be
  indistinguishable from a broken one.
* ``open-url`` — open an external ``https://`` URL, optionally templated with ``{subject}``.

Two deliberate strictness choices, both mirroring :mod:`app.custom_rule_dsl`'s stance for lint
rules: **unknown keys are rejected**, not ignored, so a typo (``"len": "combined"``) fails the
write instead of storing an effect that silently does less than its author meant; and **errors
carry a pointer** (``effects[1].lens``) so a management client can mark the offending field.

The database (V243) independently pins the outer shape — a JSON array of 1–5 elements under 16KB —
so a write path that bypassed this module still could not store a script or a payload. This module
owns the element vocabulary, which SQL cannot readably express.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

__all__ = [
    "CustomActionValidationError",
    "EFFECT_TYPES",
    "MAX_EFFECTS",
    "MAX_NAME_CONTAINS_LENGTH",
    "MAX_NAME_LENGTH",
    "MAX_URL_LENGTH",
    "SUBJECT_KINDS",
    "WORKSPACE_LENSES",
    "normalize_action_name",
    "normalize_effects",
    "normalize_name_contains",
    "normalize_subject",
    "validate_effects_against_subject",
]

#: The closed effect vocabulary. Adding to it is an API change reviewed as one — never a passthrough.
EFFECT_TYPES: Tuple[str, ...] = (
    "hydrate-set",
    "lens-switch",
    "open-inspector-tab",
    "run-consumption-query",
    "open-url",
)

#: What an action may declare itself applicable to — the palette's subject kinds, plus ``any``.
SUBJECT_KINDS: Tuple[str, ...] = ("class", "path", "property", "any")

#: The canvas lenses a ``lens-switch`` effect may name (DUW-2.2).
WORKSPACE_LENSES: Tuple[str, ...] = ("schemas", "paths", "combined")

#: Most effects one action may carry. Mirrors V243's CHECK; five is every vocabulary entry once.
MAX_EFFECTS = 5

#: Longest display name. Mirrors V243's VARCHAR(120).
MAX_NAME_LENGTH = 120

#: Longest matcher substring. Mirrors V243's VARCHAR(200).
MAX_NAME_CONTAINS_LENGTH = 200

#: Longest ``open-url`` target. Browsers cap URLs around 2000 characters; so do we.
MAX_URL_LENGTH = 2000

#: Inspector tab slugs: lowercase, hyphenated, bounded. The inspector (DUW-6.x) owns the actual
#: tab vocabulary; until it lands, the slug shape is pinned so a stored value stays addressable.
_TAB_MAX_LENGTH = 40


class CustomActionValidationError(ValueError):
    """A custom-action field is invalid (the route maps this to a 422).

    The message names the offending field as a pointer (``effects[1].lens``) followed by what was
    wrong with it, so a management client can mark the field rather than the form.
    """


def normalize_action_name(raw: Any) -> str:
    """Validate an action's display name.

    Args:
        raw: The name as sent.

    Returns:
        The trimmed name.

    Raises:
        CustomActionValidationError: When it is not a non-blank string within the length cap.
    """
    if not isinstance(raw, str):
        raise CustomActionValidationError("name must be a string")
    name = raw.strip()
    if not name:
        raise CustomActionValidationError("name must not be blank")
    if len(name) > MAX_NAME_LENGTH:
        raise CustomActionValidationError(
            f"name must be at most {MAX_NAME_LENGTH} characters"
        )
    return name


def normalize_subject(raw: Any) -> str:
    """Validate the matcher's subject kind.

    Args:
        raw: The subject kind as sent.

    Returns:
        The subject kind.

    Raises:
        CustomActionValidationError: When it is not one of :data:`SUBJECT_KINDS`.
    """
    if not isinstance(raw, str) or raw not in SUBJECT_KINDS:
        raise CustomActionValidationError(
            f"subject must be one of: {', '.join(SUBJECT_KINDS)}"
        )
    return raw


def normalize_name_contains(raw: Any) -> Optional[str]:
    """Validate the matcher's optional label substring.

    Args:
        raw: The substring as sent, or None.

    Returns:
        The trimmed substring, or None when no narrowing was asked for. An empty or all-blank
        string also normalizes to None: it would match everything, which is what None already says.

    Raises:
        CustomActionValidationError: When it is neither a string nor None, or exceeds the cap.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise CustomActionValidationError("nameContains must be a string")
    text = raw.strip()
    if not text:
        return None
    if len(text) > MAX_NAME_CONTAINS_LENGTH:
        raise CustomActionValidationError(
            f"nameContains must be at most {MAX_NAME_CONTAINS_LENGTH} characters"
        )
    return text


def _reject_unknown_keys(
    effect: Mapping[str, Any], allowed: Tuple[str, ...], *, pointer: str
) -> None:
    """Refuse keys outside an effect's declared shape.

    Args:
        effect: The effect object.
        allowed: Every key this effect type accepts, including ``type``.
        pointer: Where in the payload the effect sits (``effects[2]``).

    Raises:
        CustomActionValidationError: Naming the first unknown key.
    """
    for key in effect:
        if key not in allowed:
            raise CustomActionValidationError(
                f"{pointer}.{key} is not a recognized field of a "
                f"'{effect.get('type')}' effect"
            )


def _validate_lens_switch(effect: Mapping[str, Any], *, pointer: str) -> Dict[str, Any]:
    """Validate a ``lens-switch`` effect: exactly a lens from the canvas' vocabulary."""
    _reject_unknown_keys(effect, ("type", "lens"), pointer=pointer)
    lens = effect.get("lens")
    if not isinstance(lens, str) or lens not in WORKSPACE_LENSES:
        raise CustomActionValidationError(
            f"{pointer}.lens must be one of: {', '.join(WORKSPACE_LENSES)}"
        )
    return {"type": "lens-switch", "lens": lens}


def _validate_open_inspector_tab(
    effect: Mapping[str, Any], *, pointer: str
) -> Dict[str, Any]:
    """Validate an ``open-inspector-tab`` effect: exactly a bounded tab slug."""
    _reject_unknown_keys(effect, ("type", "tab"), pointer=pointer)
    tab = effect.get("tab")
    if not isinstance(tab, str) or not tab:
        raise CustomActionValidationError(f"{pointer}.tab must be a non-empty string")
    if len(tab) > _TAB_MAX_LENGTH or not all(
        ch.isascii() and (ch.islower() or ch.isdigit() or ch == "-") for ch in tab
    ) or tab.startswith("-") or tab.endswith("-"):
        raise CustomActionValidationError(
            f"{pointer}.tab must be a lowercase slug (letters, digits, single hyphens) of at "
            f"most {_TAB_MAX_LENGTH} characters"
        )
    return {"type": "open-inspector-tab", "tab": tab}


def _validate_open_url(effect: Mapping[str, Any], *, pointer: str) -> Dict[str, Any]:
    """Validate an ``open-url`` effect: exactly one https URL, no embedded credentials.

    The ``{subject}`` placeholder is allowed anywhere in the URL; the client substitutes the
    matched subject's label, percent-encoded. ``https`` is the whole scheme vocabulary —
    ``javascript:``, ``data:`` and even ``http:`` are not effects, they are payloads.
    """
    _reject_unknown_keys(effect, ("type", "url"), pointer=pointer)
    url = effect.get("url")
    if not isinstance(url, str) or not url.strip():
        raise CustomActionValidationError(f"{pointer}.url must be a non-empty string")
    url = url.strip()
    if len(url) > MAX_URL_LENGTH:
        raise CustomActionValidationError(
            f"{pointer}.url must be at most {MAX_URL_LENGTH} characters"
        )
    try:
        parts = urlsplit(url)
    except ValueError:
        raise CustomActionValidationError(f"{pointer}.url is not a valid URL") from None
    if parts.scheme != "https" or not parts.netloc:
        raise CustomActionValidationError(f"{pointer}.url must be an absolute https:// URL")
    if "@" in parts.netloc:
        raise CustomActionValidationError(f"{pointer}.url must not embed credentials")
    return {"type": "open-url", "url": url}


def _validate_bare(effect: Mapping[str, Any], *, pointer: str) -> Dict[str, Any]:
    """Validate an effect that carries nothing beyond its type."""
    _reject_unknown_keys(effect, ("type",), pointer=pointer)
    return {"type": str(effect["type"])}


#: Per-type validators, dispatched by the ``type`` field — the closed vocabulary in code form.
_EFFECT_VALIDATORS = {
    "hydrate-set": _validate_bare,
    "lens-switch": _validate_lens_switch,
    "open-inspector-tab": _validate_open_inspector_tab,
    "run-consumption-query": _validate_bare,
    "open-url": _validate_open_url,
}


def normalize_effects(raw: Any) -> List[Dict[str, Any]]:
    """Validate and canonicalize an action's effect list.

    Args:
        raw: The effects payload (typically parsed JSON).

    Returns:
        The effects, each reduced to exactly the fields its type declares, in the order given —
        order is meaningful, it is the order the client performs them in.

    Raises:
        CustomActionValidationError: When the list or any element is outside the vocabulary.
    """
    if not isinstance(raw, list):
        raise CustomActionValidationError("effects must be a list")
    if not raw:
        raise CustomActionValidationError("effects must contain at least one effect")
    if len(raw) > MAX_EFFECTS:
        raise CustomActionValidationError(
            f"effects must contain at most {MAX_EFFECTS} effects"
        )

    normalized: List[Dict[str, Any]] = []
    for index, effect in enumerate(raw):
        pointer = f"effects[{index}]"
        if not isinstance(effect, Mapping):
            raise CustomActionValidationError(f"{pointer} must be an object")
        effect_type = effect.get("type")
        validator = _EFFECT_VALIDATORS.get(effect_type) if isinstance(effect_type, str) else None
        if validator is None:
            raise CustomActionValidationError(
                f"{pointer}.type must be one of: {', '.join(EFFECT_TYPES)}"
            )
        normalized.append(validator(effect, pointer=pointer))
    return normalized


def validate_effects_against_subject(
    subject: str, effects: List[Dict[str, Any]]
) -> None:
    """Enforce the one cross-field rule: consumption queries need a class subject.

    ``run-consumption-query`` hydrates the operations consuming a *class*; offered for a path or a
    property subject it would match rows it can do nothing for, which reads as a broken palette
    rather than as a configuration mistake. Rejected at the write, where the author can fix it.

    Args:
        subject: The normalized subject kind.
        effects: The normalized effect list.

    Raises:
        CustomActionValidationError: When the combination is contradictory.
    """
    for index, effect in enumerate(effects):
        if effect["type"] == "run-consumption-query" and subject != "class":
            raise CustomActionValidationError(
                f"effects[{index}]: run-consumption-query requires subject 'class', "
                f"not '{subject}'"
            )
