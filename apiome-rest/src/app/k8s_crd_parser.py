"""Kubernetes CRD structural-schema parser — IXH-7.2 (#5127).

Parses CustomResourceDefinition YAML (including multi-document streams) into a
typed :class:`K8sCrdDocument` AST. Syntax and shape errors surface as
:class:`K8sCrdParseError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

from .intake_resource_guard import IntakeLimitError, guard_document_text

__all__ = [
    "K8sCrdParseError",
    "K8sCrdVersion",
    "K8sCustomResourceDefinition",
    "K8sCrdDocument",
    "is_k8s_crd",
    "is_k8s_crd_document",
    "parse_k8s_crd",
]

_KIND = "CustomResourceDefinition"
_API_PREFIX = "apiextensions.k8s.io/"


class K8sCrdParseError(ValueError):
    """Raised when CRD YAML cannot be parsed into a CustomResourceDefinition."""


@dataclass(frozen=True)
class K8sCrdVersion:
    """One entry from ``spec.versions[]``."""

    name: str
    served: bool
    storage: bool
    deprecated: bool
    deprecation_warning: Optional[str]
    openapi_v3_schema: Optional[Dict[str, Any]]


@dataclass(frozen=True)
class K8sCustomResourceDefinition:
    """One CustomResourceDefinition resource."""

    api_version: str
    name: str
    group: str
    kind: str
    plural: str
    singular: Optional[str]
    short_names: Tuple[str, ...]
    scope: str
    versions: Tuple[K8sCrdVersion, ...]
    raw_mapping: Dict[str, Any]


@dataclass(frozen=True)
class K8sCrdDocument:
    """Parsed CRD YAML stream (one or more CustomResourceDefinitions)."""

    crds: Tuple[K8sCustomResourceDefinition, ...]
    raw: str


def _as_optional_str(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def is_k8s_crd_document(document: Any) -> bool:
    """Return ``True`` when a parsed mapping looks like a CustomResourceDefinition."""
    if not isinstance(document, Mapping):
        return False
    kind = document.get("kind")
    if not isinstance(kind, str) or kind.strip() != _KIND:
        return False
    api_version = document.get("apiVersion")
    if not isinstance(api_version, str):
        return False
    return api_version.strip().startswith(_API_PREFIX)


def _looks_like_crd_text(content: str) -> bool:
    lowered = content.lower()
    return (
        "kind:" in lowered
        and "customresourcedefinition" in lowered
        and "apiextensions.k8s.io/" in lowered
    )


def is_k8s_crd(content: str) -> bool:
    """Return ``True`` when ``content`` looks like one or more CRDs."""
    if not content or not isinstance(content, str) or not content.strip():
        return False
    if not _looks_like_crd_text(content):
        return False
    try:
        docs = _load_yaml_documents(content)
    except K8sCrdParseError:
        # Truncated / malformed YAML that still carries CRD markers — claim for detect.
        return True
    if not docs:
        return False
    return all(is_k8s_crd_document(doc) for doc in docs)


def _load_yaml_documents(text: str, *, source_label: Optional[str] = None) -> List[Any]:
    """Load a YAML stream, applying intake text guards."""
    try:
        guard_document_text(text, source_label=source_label)
    except IntakeLimitError as exc:
        raise K8sCrdParseError(str(exc)) from exc
    try:
        loaded = list(yaml.safe_load_all(text))
    except yaml.YAMLError as exc:
        raise K8sCrdParseError(f"Invalid YAML: {exc}") from exc
    return [doc for doc in loaded if doc is not None]


def _parse_version(entry: Mapping[str, Any], *, crd_name: str) -> K8sCrdVersion:
    name = _as_optional_str(entry.get("name"))
    if not name:
        raise K8sCrdParseError(
            f"CRD {crd_name!r} has a version entry without a non-empty name"
        )
    schema_block = entry.get("schema")
    openapi: Optional[Dict[str, Any]] = None
    if isinstance(schema_block, Mapping):
        raw_schema = schema_block.get("openAPIV3Schema")
        if isinstance(raw_schema, Mapping):
            openapi = dict(raw_schema)
    warning = _as_optional_str(entry.get("deprecationWarning"))
    return K8sCrdVersion(
        name=name,
        served=entry.get("served") is not False,
        storage=entry.get("storage") is True,
        deprecated=entry.get("deprecated") is True,
        deprecation_warning=warning,
        openapi_v3_schema=openapi,
    )


def _parse_crd(mapping: Mapping[str, Any], *, index: int) -> K8sCustomResourceDefinition:
    if not is_k8s_crd_document(mapping):
        kind = mapping.get("kind") if isinstance(mapping, Mapping) else type(mapping).__name__
        api = mapping.get("apiVersion") if isinstance(mapping, Mapping) else None
        raise K8sCrdParseError(
            f"Document {index} is not a CustomResourceDefinition "
            f"(kind={kind!r}, apiVersion={api!r}); mixed streams are rejected"
        )

    api_version = str(mapping.get("apiVersion")).strip()
    metadata = mapping.get("metadata")
    meta_name = None
    if isinstance(metadata, Mapping):
        meta_name = _as_optional_str(metadata.get("name"))

    spec = mapping.get("spec")
    if not isinstance(spec, Mapping):
        raise K8sCrdParseError(
            f"CRD document {index} is missing a mapping `spec`"
        )

    group = _as_optional_str(spec.get("group"))
    if not group:
        raise K8sCrdParseError(f"CRD document {index} is missing `spec.group`")

    names = spec.get("names")
    if not isinstance(names, Mapping):
        raise K8sCrdParseError(f"CRD document {index} is missing `spec.names`")

    kind = _as_optional_str(names.get("kind"))
    plural = _as_optional_str(names.get("plural"))
    if not kind or not plural:
        raise K8sCrdParseError(
            f"CRD document {index} requires `spec.names.kind` and `spec.names.plural`"
        )

    singular = _as_optional_str(names.get("singular"))
    short_raw = names.get("shortNames")
    short_names: Tuple[str, ...] = ()
    if isinstance(short_raw, list):
        short_names = tuple(
            item.strip()
            for item in short_raw
            if isinstance(item, str) and item.strip()
        )

    scope = _as_optional_str(spec.get("scope")) or "Namespaced"
    crd_name = meta_name or f"{plural}.{group}"

    versions_raw = spec.get("versions")
    versions: List[K8sCrdVersion] = []
    if isinstance(versions_raw, list):
        for entry in versions_raw:
            if isinstance(entry, Mapping):
                versions.append(_parse_version(entry, crd_name=crd_name))

    # Legacy CRDs may use top-level spec.version + validation.openAPIV3Schema.
    if not versions:
        legacy_version = _as_optional_str(spec.get("version"))
        validation = spec.get("validation")
        openapi: Optional[Dict[str, Any]] = None
        if isinstance(validation, Mapping):
            raw_schema = validation.get("openAPIV3Schema")
            if isinstance(raw_schema, Mapping):
                openapi = dict(raw_schema)
        if legacy_version:
            versions.append(
                K8sCrdVersion(
                    name=legacy_version,
                    served=True,
                    storage=True,
                    deprecated=False,
                    deprecation_warning=None,
                    openapi_v3_schema=openapi,
                )
            )

    if not versions:
        raise K8sCrdParseError(
            f"CRD {crd_name!r} declares no versions (need `spec.versions` or `spec.version`)"
        )

    return K8sCustomResourceDefinition(
        api_version=api_version,
        name=crd_name,
        group=group,
        kind=kind,
        plural=plural,
        singular=singular,
        short_names=short_names,
        scope=scope,
        versions=tuple(versions),
        raw_mapping=dict(mapping),
    )


def parse_k8s_crd(
    raw: str,
    *,
    source_label: Optional[str] = None,
) -> K8sCrdDocument:
    """Parse CRD YAML (single document or multi-document stream) into an AST.

    Args:
        raw: YAML text containing one or more CustomResourceDefinition resources.
        source_label: Optional label for intake-guard diagnostics.

    Returns:
        A :class:`K8sCrdDocument` with one entry per CRD in stream order.

    Raises:
        K8sCrdParseError: On invalid YAML, mixed non-CRD documents, or missing
            required identity fields.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise K8sCrdParseError("CRD source is empty")

    docs = _load_yaml_documents(raw, source_label=source_label)
    if not docs:
        raise K8sCrdParseError("CRD YAML stream contains no documents")

    crds: List[K8sCustomResourceDefinition] = []
    for index, doc in enumerate(docs):
        if not isinstance(doc, Mapping):
            raise K8sCrdParseError(
                f"Document {index} is not a YAML mapping (got {type(doc).__name__})"
            )
        crds.append(_parse_crd(doc, index=index))

    return K8sCrdDocument(crds=tuple(crds), raw=raw)
