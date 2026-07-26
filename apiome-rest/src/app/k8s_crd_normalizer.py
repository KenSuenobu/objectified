"""Kubernetes CRD → canonical model normalizer — IXH-7.2 (#5127).

Maps a parsed :class:`~app.k8s_crd_parser.K8sCrdDocument` into a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA`, with one :class:`Service`
per CRD (resource identity) and per-version structural schemas as typed trees.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Service,
    Type,
    TypeKind,
)
from .k8s_crd_parser import K8sCrdDocument, K8sCrdVersion, K8sCustomResourceDefinition
from .normalizer import Keys, Normalizer, SchemaCoercer, normalize_ordering

__all__ = ["K8sCrdNormalizer", "extract_x_kubernetes_extensions"]

_FORMAT_KEY = "k8s-crd"

# Keywords Kubernetes structural schemas prune / do not honor structurally.
# Surfaced via extras so the lint pack and coverage ledger can report them.
_NON_STRUCTURAL_KEYWORDS = frozenset(
    {
        "id",
        "$schema",
        "$id",
        "definitions",
        "$defs",
        "dependencies",
        "additionalItems",
        "patternProperties",
        "if",
        "then",
        "else",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "uniqueItems",
    }
)


def extract_x_kubernetes_extensions(schema: Any) -> Dict[str, Any]:
    """Return top-level ``x-kubernetes-*`` keys from a schema fragment."""
    if not isinstance(schema, Mapping):
        return {}
    return {
        key: value
        for key, value in schema.items()
        if isinstance(key, str) and key.startswith("x-kubernetes-")
    }


def _collect_x_kubernetes_tree(schema: Any, *, path: str = "$") -> Dict[str, Dict[str, Any]]:
    """Walk a schema tree and map JSON-pointer-ish paths to ``x-kubernetes-*`` bags."""
    found: Dict[str, Dict[str, Any]] = {}
    if not isinstance(schema, Mapping):
        return found
    local = extract_x_kubernetes_extensions(schema)
    if local:
        found[path] = local
    properties = schema.get("properties")
    if isinstance(properties, Mapping):
        for name, child in properties.items():
            if isinstance(name, str):
                found.update(
                    _collect_x_kubernetes_tree(child, path=f"{path}.properties.{name}")
                )
    items = schema.get("items")
    if isinstance(items, Mapping):
        found.update(_collect_x_kubernetes_tree(items, path=f"{path}.items"))
    additional = schema.get("additionalProperties")
    if isinstance(additional, Mapping):
        found.update(
            _collect_x_kubernetes_tree(additional, path=f"{path}.additionalProperties")
        )
    for compose_key in ("anyOf", "oneOf", "allOf"):
        compose = schema.get(compose_key)
        if isinstance(compose, list):
            for index, child in enumerate(compose):
                found.update(
                    _collect_x_kubernetes_tree(child, path=f"{path}.{compose_key}[{index}]")
                )
    return found


def _collect_non_structural_tree(schema: Any) -> List[str]:
    """Return sorted unique non-structural keywords found anywhere in ``schema``."""
    found: set[str] = set()

    def walk(node: Any) -> None:
        if not isinstance(node, Mapping):
            return
        found.update(_non_structural_keys(node))
        for value in node.values():
            if isinstance(value, Mapping):
                walk(value)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

    walk(schema)
    return sorted(found)


def _non_structural_keys(schema: Any) -> List[str]:
    if not isinstance(schema, Mapping):
        return []
    return sorted(
        key
        for key in schema
        if isinstance(key, str) and key in _NON_STRUCTURAL_KEYWORDS
    )


def _attach_schema_extras(
    type_: Type,
    schema: Optional[Dict[str, Any]],
    *,
    version: K8sCrdVersion,
    crd: K8sCustomResourceDefinition,
) -> Type:
    """Stamp version labels and vendor extensions onto a coerced root type."""
    extras: Dict[str, Any] = {
        "k8s_crd_group": crd.group,
        "k8s_crd_kind": crd.kind,
        "k8s_crd_version": version.name,
        "served": version.served,
        "storage": version.storage,
        "deprecated": version.deprecated,
    }
    if version.deprecation_warning:
        extras["deprecation_warning"] = version.deprecation_warning
    if not version.served:
        extras["version_status"] = "not-served"
    elif version.deprecated:
        extras["version_status"] = "deprecated"
    else:
        extras["version_status"] = "served"

    x_ext = extract_x_kubernetes_extensions(schema)
    if x_ext:
        extras["x_kubernetes"] = x_ext
    x_tree = _collect_x_kubernetes_tree(schema)
    if x_tree:
        extras["x_kubernetes_paths"] = x_tree
    pruned = _collect_non_structural_tree(schema) if schema else []
    if pruned:
        extras["non_structural_keywords"] = pruned
    if isinstance(schema, Mapping) and "required" in schema:
        required_raw = schema.get("required")
        if isinstance(required_raw, list):
            extras["required_names"] = [
                name for name in required_raw if isinstance(name, str)
            ]
        elif required_raw is not None:
            extras["required_names"] = []

    fields = [
        _field_with_schema_extras(field, _property_schema(schema, field.name))
        for field in type_.fields
    ]
    return type_.model_copy(update={"extras": {**type_.extras, **extras}, "fields": fields})


def _property_schema(schema: Optional[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    if not isinstance(schema, Mapping):
        return None
    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        return None
    prop = properties.get(name)
    return dict(prop) if isinstance(prop, Mapping) else None


def _field_with_schema_extras(
    field: CanonicalField,
    schema: Optional[Dict[str, Any]],
) -> CanonicalField:
    extras: Dict[str, Any] = dict(field.extras)
    x_ext = extract_x_kubernetes_extensions(schema)
    if x_ext:
        extras["x_kubernetes"] = x_ext
    pruned = _non_structural_keys(schema)
    if pruned:
        extras["non_structural_keywords"] = pruned
    if not extras:
        return field
    return field.model_copy(update={"extras": extras})


def _stub_type(
    *,
    key: str,
    name: str,
    version: K8sCrdVersion,
    crd: K8sCustomResourceDefinition,
    description: Optional[str],
) -> Type:
    """Emit a labelled stub when a version has no openAPIV3Schema."""
    extras: Dict[str, Any] = {
        "k8s_crd_group": crd.group,
        "k8s_crd_kind": crd.kind,
        "k8s_crd_version": version.name,
        "served": version.served,
        "storage": version.storage,
        "deprecated": version.deprecated,
        "missing_openapi_v3_schema": True,
    }
    if version.deprecation_warning:
        extras["deprecation_warning"] = version.deprecation_warning
    if not version.served:
        extras["version_status"] = "not-served"
    elif version.deprecated:
        extras["version_status"] = "deprecated"
    else:
        extras["version_status"] = "served"
    return Type(
        key=key,
        name=name,
        kind=TypeKind.RECORD,
        description=description,
        deprecated=version.deprecated,
        extras=extras,
    )


def _normalize_version_type(
    crd: K8sCustomResourceDefinition,
    version: K8sCrdVersion,
) -> Type:
    type_key = Keys.type(crd.kind, f"{crd.group}/{version.name}")
    schema = version.openapi_v3_schema
    description = None
    if isinstance(schema, dict):
        description = schema.get("description")
        if not isinstance(description, str):
            description = None

    if not isinstance(schema, dict):
        return _stub_type(
            key=type_key,
            name=crd.kind,
            version=version,
            crd=crd,
            description=description,
        )

    coercer = SchemaCoercer(components={}, ref_prefix="#/definitions/")
    # Pass the full type key as the SchemaCoercer name so field keys nest under it.
    coerced = coercer.named_type(type_key, schema)
    coerced = coerced.model_copy(
        update={
            "name": crd.kind,
            "deprecated": version.deprecated or coerced.deprecated,
        }
    )
    root = _attach_schema_extras(coerced, schema, version=version, crd=crd)
    # Collect any types SchemaCoercer synthesized while walking nested schemas.
    # Those keep their bare keys; they remain reachable from field TypeRefs.
    return root


def _service_for_crd(crd: K8sCustomResourceDefinition) -> Service:
    extras: Dict[str, Any] = {
        "k8s_crd_name": crd.name,
        "k8s_crd_group": crd.group,
        "k8s_crd_kind": crd.kind,
        "k8s_crd_plural": crd.plural,
        "k8s_crd_scope": crd.scope,
        "k8s_crd_api_version": crd.api_version,
    }
    if crd.singular:
        extras["k8s_crd_singular"] = crd.singular
    if crd.short_names:
        extras["k8s_crd_short_names"] = list(crd.short_names)
    return Service(
        key=crd.name,
        name=crd.kind,
        description=f"Kubernetes CustomResourceDefinition {crd.name}",
        operations=[],
        extras=extras,
    )


def _artifact_identity(
    crds: Tuple[K8sCustomResourceDefinition, ...],
) -> Tuple[ApiIdentity, Optional[str], Optional[str], Optional[str]]:
    """Return identity, title, description, and version for the stream."""
    if len(crds) == 1:
        crd = crds[0]
        storage = next((v for v in crd.versions if v.storage), crd.versions[0])
        return (
            ApiIdentity(name=crd.kind, namespace=crd.group, id=crd.name),
            crd.kind,
            f"CustomResourceDefinition {crd.name}",
            storage.name,
        )
    names = [crd.name for crd in crds]
    return (
        ApiIdentity(
            name="kubernetes-crds",
            namespace=crds[0].group,
            id=",".join(names),
        ),
        "Kubernetes CRDs",
        f"Multi-document CRD stream ({len(crds)} resources)",
        None,
    )


class K8sCrdNormalizer(Normalizer, register=True):
    """Normalize a parsed Kubernetes CRD document into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, K8sCrdDocument):
            raise ValueError(
                "Kubernetes CRD source must be a K8sCrdDocument "
                "(see app.k8s_crd_parser.parse_k8s_crd)"
            )
        if not source.crds:
            raise ValueError("K8sCrdDocument contains no CustomResourceDefinitions")

        services: List[Service] = []
        types: List[Type] = []
        for crd in source.crds:
            services.append(_service_for_crd(crd))
            for version in crd.versions:
                types.append(_normalize_version_type(crd, version))

        identity, title, description, version = _artifact_identity(source.crds)
        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=identity,
            title=title,
            description=description,
            version=version,
            services=services,
            types=types,
            raw={"k8s_crd": source.raw} if include_raw else None,
            extras={
                "k8s_crd_count": len(source.crds),
                "k8s_crd_names": [crd.name for crd in source.crds],
            },
        )
        return normalize_ordering(api)
