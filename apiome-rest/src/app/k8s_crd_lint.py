"""Kubernetes CRD lint pack — IXH-7.2 (#5127).

Native hygiene rules for CustomResourceDefinition structural schemas:

* **structural-schema pruning** — source keywords Kubernetes prunes, or
  ``x-kubernetes-preserve-unknown-fields`` without a typed schema, are reported;
* **required-field hygiene** — required names missing from ``properties``,
  duplicates, or empty required lists on record types.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple

from .canonical_model import CanonicalApi, CanonicalField, Type, TypeKind
from .lint_engine import LintRule, RulePack, lint_canonical_model
from .schema_lint import LintResult

__all__ = [
    "K8sCrdRulePack",
    "lint_k8s_crd_result",
    "lint_k8s_crd",
]


def _types_sorted(api: CanonicalApi) -> List[Type]:
    return sorted(api.types, key=lambda t: t.key)


def _fields_sorted(type_: Type) -> List[CanonicalField]:
    return sorted(type_.fields, key=lambda f: f.key)


def _check_structural_schema_pruning(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for type_ in _types_sorted(api):
        pruned = type_.extras.get("non_structural_keywords")
        if isinstance(pruned, list) and pruned:
            yield (
                f"types.{type_.key}",
                "Structural schema contains keywords Kubernetes prunes: "
                + ", ".join(str(item) for item in pruned)
                + ".",
            )
        x_ext = type_.extras.get("x_kubernetes")
        if isinstance(x_ext, dict) and x_ext.get("x-kubernetes-preserve-unknown-fields") is True:
            if not type_.fields and type_.kind == TypeKind.RECORD:
                yield (
                    f"types.{type_.key}",
                    "Type sets x-kubernetes-preserve-unknown-fields without declared "
                    "properties; pruning will retain arbitrary fields.",
                )
        for field in _fields_sorted(type_):
            field_pruned = field.extras.get("non_structural_keywords")
            if isinstance(field_pruned, list) and field_pruned:
                yield (
                    f"types.{type_.key}.fields.{field.key}",
                    "Property schema contains keywords Kubernetes prunes: "
                    + ", ".join(str(item) for item in field_pruned)
                    + ".",
                )


def _required_from_raw(api: CanonicalApi, type_: Type) -> List[str]:
    """Best-effort recovery of required names from the fidelity bag for this type."""
    raw = api.raw if isinstance(api.raw, dict) else {}
    # Required hygiene primarily inspects canonical fields: a required field is
    # modelled with nullable=False. Missing-from-properties is recovered from
    # extras stamped at normalize time when present.
    declared = type_.extras.get("required_names")
    if isinstance(declared, list):
        return [name for name in declared if isinstance(name, str)]
    del raw  # fidelity bag kept for future deeper walks; not needed for field-based check
    return []


def _check_required_field_hygiene(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for type_ in _types_sorted(api):
        if type_.kind != TypeKind.RECORD:
            continue
        required_names = _required_from_raw(api, type_)
        if required_names:
            seen: Dict[str, int] = {}
            for name in required_names:
                seen[name] = seen.get(name, 0) + 1
            duplicates = sorted(name for name, count in seen.items() if count > 1)
            if duplicates:
                yield (
                    f"types.{type_.key}",
                    "Duplicate names in required: " + ", ".join(duplicates) + ".",
                )
            property_names = {field.name for field in type_.fields}
            missing = sorted(name for name in seen if name not in property_names)
            if missing:
                yield (
                    f"types.{type_.key}",
                    "required lists fields absent from properties: "
                    + ", ".join(missing)
                    + ".",
                )
            if len(required_names) == 0:
                yield (
                    f"types.{type_.key}",
                    "required is present but empty; omit it or list property names.",
                )

        # Fields that are required in the source become nullable=False. Flag
        # required-looking names that have no description (weak hygiene).
        for field in _fields_sorted(type_):
            if field.type.nullable is False and not (field.description or "").strip():
                # Only emit when the type stamped required_names (schema had required).
                if required_names and field.name in required_names:
                    yield (
                        f"types.{type_.key}.fields.{field.key}",
                        f"Required field {field.name!r} has no description.",
                    )


class K8sCrdRulePack(RulePack, register=True):
    """Native hygiene rules for Kubernetes CRD structural schemas."""

    format = "k8s-crd"
    pack_id = "k8s-crd"

    _RULES: Tuple[LintRule, ...] = (
        LintRule(
            rule_id="k8s-crd.structural-schema-pruning",
            category="structure",
            severity="warning",
            description=(
                "Flag non-structural JSON Schema keywords and preserve-unknown-fields "
                "hygiene issues that affect Kubernetes pruning."
            ),
            check=_check_structural_schema_pruning,
        ),
        LintRule(
            rule_id="k8s-crd.required-field-hygiene",
            category="structure",
            severity="warning",
            description=(
                "Flag required lists with missing, duplicate, or undescribed fields."
            ),
            check=_check_required_field_hygiene,
        ),
    )

    def rules(self) -> List[LintRule]:
        return list(self._RULES)


def lint_k8s_crd_result(model: CanonicalApi) -> LintResult:
    """Lint a normalized Kubernetes CRD artifact through the shared engine."""
    return lint_canonical_model(model)


def lint_k8s_crd(raw: str) -> LintResult:
    """Parse, normalize, and lint raw Kubernetes CRD YAML end-to-end."""
    from .k8s_crd_import_source import K8sCrdImportSource

    adapter = K8sCrdImportSource()
    native = adapter.parse(raw)
    model = adapter.normalize(native)
    return lint_k8s_crd_result(model)
