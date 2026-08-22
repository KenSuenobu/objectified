"""OpenAPI external-validation profiles (CLX-2.2 / #4852).

Users select ``baseline``, ``tenant_guide``, or ``strict``. Baseline and strict
map onto curated Apiome rulesets under ``rulesets/openapi/``. Tenant-guide
extends baseline with the guide's Spectral-compatible custom YAML overlay.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

import yaml

__all__ = [
    "PROFILE_BASELINE",
    "PROFILE_TENANT_GUIDE",
    "PROFILE_STRICT",
    "VALIDATION_PROFILES",
    "normalize_profile",
    "rulesets_root",
    "spectral_ruleset_path",
    "redocly_config_path",
    "render_tenant_guide_spectral_ruleset",
    "custom_rules_from_guide_rows",
    "is_spectral_exportable",
]

PROFILE_BASELINE = "baseline"
PROFILE_TENANT_GUIDE = "tenant_guide"
PROFILE_STRICT = "strict"
VALIDATION_PROFILES = (PROFILE_BASELINE, PROFILE_TENANT_GUIDE, PROFILE_STRICT)

_RULESETS_ROOT = Path(__file__).resolve().parent / "rulesets" / "openapi"


def rulesets_root() -> Path:
    """Return the on-disk curated OpenAPI rulesets directory."""
    return _RULESETS_ROOT


def normalize_profile(profile: Optional[str]) -> str:
    """Normalize a profile token; unknown/blank values become ``baseline``."""
    value = (profile or "").strip().lower().replace("-", "_")
    if value in VALIDATION_PROFILES:
        return value
    return PROFILE_BASELINE


def spectral_ruleset_path(profile: str) -> Path:
    """Path to the curated Spectral ruleset for ``baseline`` or ``strict``.

    ``tenant_guide`` shares the baseline file as its ``extends`` target; the
    overlay itself is written into the adapter workspace at run time.
    """
    key = normalize_profile(profile)
    folder = PROFILE_STRICT if key == PROFILE_STRICT else PROFILE_BASELINE
    return _RULESETS_ROOT / folder / ".spectral.yaml"


def redocly_config_path(profile: str) -> Path:
    """Path to the curated Redocly config for ``baseline`` or ``strict``.

    Tenant-guide falls back to baseline for Redocly (custom DSL is Spectral-shaped).
    """
    key = normalize_profile(profile)
    folder = PROFILE_STRICT if key == PROFILE_STRICT else PROFILE_BASELINE
    return _RULESETS_ROOT / folder / "redocly.yaml"


def render_tenant_guide_spectral_ruleset(
    *,
    baseline_ruleset: Path,
    custom_rules: Optional[Mapping[str, Any]] = None,
    custom_rules_yaml: Optional[str] = None,
) -> str:
    """Build a Spectral ruleset YAML that extends baseline + tenant custom rules.

    Args:
        baseline_ruleset: Absolute path to the Apiome baseline ``.spectral.yaml``.
        custom_rules: Mapping of rule id → definition (``custom_def`` shape), when known.
        custom_rules_yaml: Optional pre-serialized Spectral subset ``rules:`` document.

    Returns:
        A Spectral ruleset document as a YAML string.
    """
    rules: Dict[str, Any] = {}
    if custom_rules_yaml:
        loaded = yaml.safe_load(custom_rules_yaml) or {}
        if isinstance(loaded, dict):
            maybe = loaded.get("rules")
            if isinstance(maybe, dict):
                rules.update(
                    {
                        str(rule_id): dict(definition)
                        for rule_id, definition in maybe.items()
                        if isinstance(definition, Mapping)
                        and is_spectral_exportable(definition)
                    }
                )
    if custom_rules:
        for rule_id, definition in custom_rules.items():
            if isinstance(definition, Mapping) and is_spectral_exportable(definition):
                rules[str(rule_id)] = dict(definition)

    document: Dict[str, Any] = {
        "extends": [str(baseline_ruleset.resolve())],
        "rules": rules,
    }
    return yaml.dump(document, default_flow_style=False, sort_keys=False, allow_unicode=True)


def is_spectral_exportable(definition: Mapping[str, Any]) -> bool:
    """Return whether a stored custom rule can be handed to the real Spectral binary.

    The Apiome DSL is a Spectral *subset* plus one addition (FMT-4.3, #5436): a rule declares
    the ``scope`` it reads. Only a ``document``-scoped rule is a Spectral rule — a ``canonical``
    one is written against Apiome's own model, and a ``declared`` one carries no ``given``/
    ``then`` at all. Emitting either into a generated ``.spectral.yaml`` would hand the external
    linter a ruleset it cannot load, so they are filtered here rather than at each call site.

    Args:
        definition: A stored ``custom_def`` mapping.

    Returns:
        ``True`` for a document-scoped rule (the default when ``scope`` is absent).
    """
    return definition.get("scope", "document") == "document"


def custom_rules_from_guide_rows(
    rows: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Extract enabled, Spectral-exportable custom rule definitions from guide rows.

    Args:
        rows: Guide rule rows with ``rule_id``, ``enabled``, and optional ``custom_def``.

    Returns:
        Mapping of rule id → definition for Spectral overlay generation. Rules the external
        linter cannot evaluate (:func:`is_spectral_exportable`) are left out.
    """
    out: Dict[str, Any] = {}
    for row in rows:
        if not row.get("enabled", True):
            continue
        custom = row.get("custom_def")
        if isinstance(custom, Mapping) and custom and is_spectral_exportable(custom):
            out[str(row["rule_id"])] = dict(custom)
    return out
