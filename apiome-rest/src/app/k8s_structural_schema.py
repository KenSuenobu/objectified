"""Kubernetes structural-schema vocabulary and validation — FMT-2.1 (#5419).

The rules the ``apiextensions.k8s.io/v1`` API server enforces on a
CustomResourceDefinition, expressed once so both halves of the CRD round trip can
rely on them: :mod:`app.k8s_crd_emitter` builds documents that satisfy them, and
:func:`validate_k8s_crd_document` checks a finished document against them
independently of how it was produced.

A *structural schema* is the restricted JSON Schema dialect Kubernetes accepts. It
is not "OpenAPI minus a few keywords": every node must declare a ``type`` (or opt
out through ``x-kubernetes-preserve-unknown-fields`` / ``x-kubernetes-int-or-string``),
a set of keywords is rejected outright, ``uniqueItems: true`` is unsupported, and
``additionalProperties`` may be neither ``false`` nor a sibling of ``properties``.
Emitting a document that breaks any of them produces YAML a cluster refuses, which
is why the emitter treats each restriction as a fidelity loss to report rather than
a rule to bend.
"""

from __future__ import annotations

import re
from typing import Any, List, Mapping

from .k8s_crd_normalizer import NON_STRUCTURAL_KEYWORDS

__all__ = [
    "CRD_API_VERSION",
    "CRD_KIND",
    "INT_OR_STRING",
    "KUBERNETES_KNOWN_FORMATS",
    "PRESERVE_UNKNOWN_FIELDS",
    "STRUCTURAL_FORBIDDEN_KEYWORDS",
    "DNS_SUBDOMAIN",
    "VERSION_NAME",
    "structural_schema_violations",
    "validate_k8s_crd_document",
]


# ===========================================================================
# Kubernetes vocabulary
# ===========================================================================

#: The CRD API group/version this emitter targets. ``v1beta1`` was removed in
#: Kubernetes 1.22, so ``v1`` is the only version worth emitting.
CRD_API_VERSION = "apiextensions.k8s.io/v1"

#: The resource kind every emitted document declares.
CRD_KIND = "CustomResourceDefinition"

#: Vendor-extension keys that opt a node out of the "every node declares a type"
#: structural rule.
PRESERVE_UNKNOWN_FIELDS = "x-kubernetes-preserve-unknown-fields"
INT_OR_STRING = "x-kubernetes-int-or-string"

#: JSON-Schema keywords a CRD structural schema may not contain. The normalizer's
#: :data:`~app.k8s_crd_normalizer.NON_STRUCTURAL_KEYWORDS` (what Kubernetes prunes
#: or refuses to honour structurally, recorded on import) plus the JSONSchemaProps
#: fields the apiextensions API server rejects outright.
STRUCTURAL_FORBIDDEN_KEYWORDS: frozenset = (
    NON_STRUCTURAL_KEYWORDS
    | frozenset({"$ref", "deprecated", "discriminator", "readOnly", "writeOnly", "xml"})
    # `uniqueItems` is not forbidden outright — Kubernetes accepts the (no-op)
    # `false` and rejects only `true`, which is checked as its own rule below.
) - frozenset({"uniqueItems"})

#: ``format`` values the apiextensions API server recognises. A format outside
#: this set is silently ignored by Kubernetes, so it is dropped and reported as a
#: loss rather than emitted as decoration that validates nothing.
KUBERNETES_KNOWN_FORMATS: frozenset = frozenset(
    {
        "bsonobjectid",
        "byte",
        "cidr",
        "creditcard",
        "date",
        "date-time",
        "datetime",
        "duration",
        "email",
        "hexcolor",
        "hostname",
        "int-or-string",
        "ipv4",
        "ipv6",
        "isbn",
        "isbn10",
        "isbn13",
        "mac",
        "password",
        "rgbcolor",
        "ssn",
        "uri",
        "uuid",
        "uuid3",
        "uuid4",
        "uuid5",
    }
)

#: A Kubernetes API version name (``v1``, ``v2beta3``). Anything else must be
#: replaced with a synthesized name or the API server rejects the CRD.
VERSION_NAME = re.compile(r"^v\d+((alpha|beta)\d+)?$")

#: A DNS subdomain, which is what ``spec.group`` must be.
DNS_SUBDOMAIN = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")

# ===========================================================================
# Structural-schema validation (independent of emission)
# ===========================================================================


def _node_opts_out_of_type(node: Mapping[str, Any]) -> bool:
    """Whether ``node`` legally omits ``type`` via a Kubernetes vendor extension."""
    return node.get(PRESERVE_UNKNOWN_FIELDS) is True or node.get(INT_OR_STRING) is True


def structural_schema_violations(
    schema: Any,
    *,
    path: str = "openAPIV3Schema",
) -> List[str]:
    """Return the Kubernetes structural-schema rules ``schema`` breaks.

    Implements the restrictions the apiextensions API server enforces on
    ``spec.versions[].schema.openAPIV3Schema``:

    #. the root, every declared object property and every array item declares a
       non-empty ``type`` — unless the node sets ``x-kubernetes-preserve-unknown-fields``
       or ``x-kubernetes-int-or-string``;
    #. none of :data:`STRUCTURAL_FORBIDDEN_KEYWORDS` appears anywhere;
    #. ``uniqueItems: true`` is not set;
    #. ``additionalProperties`` is neither ``false`` nor a sibling of ``properties``;
    #. an ``array`` node declares an ``items`` schema;
    #. every ``format`` is one Kubernetes knows (:data:`KUBERNETES_KNOWN_FORMATS`).

    Args:
        schema: The candidate ``openAPIV3Schema`` fragment (any value; a non-mapping
            root is itself a violation).
        path: Human-readable path prefix used in the returned messages.

    Returns:
        One message per violation, in document order. An empty list means the
        schema is structural.
    """
    violations: List[str] = []

    def walk(node: Any, node_path: str, *, type_required: bool) -> None:
        if not isinstance(node, Mapping):
            violations.append(f"{node_path}: expected a schema object, got {type(node).__name__}")
            return

        opted_out = _node_opts_out_of_type(node)
        node_type = node.get("type")
        if type_required and not opted_out:
            if not isinstance(node_type, str) or not node_type:
                violations.append(
                    f"{node_path}: must declare a non-empty `type` "
                    f"(or set `{PRESERVE_UNKNOWN_FIELDS}`/`{INT_OR_STRING}`)"
                )
        if opted_out and node.get(INT_OR_STRING) is True and node_type:
            violations.append(f"{node_path}: `{INT_OR_STRING}` nodes must not declare a `type`")

        for keyword in sorted(k for k in node if k in STRUCTURAL_FORBIDDEN_KEYWORDS):
            violations.append(f"{node_path}: `{keyword}` is not allowed in a structural schema")

        if node.get("uniqueItems") is True:
            violations.append(f"{node_path}: `uniqueItems: true` is not supported by Kubernetes")

        additional = node.get("additionalProperties")
        if additional is False:
            violations.append(f"{node_path}: `additionalProperties: false` is not allowed")
        if additional is not None and isinstance(node.get("properties"), Mapping):
            violations.append(
                f"{node_path}: `additionalProperties` and `properties` are mutually exclusive"
            )

        fmt = node.get("format")
        if isinstance(fmt, str) and fmt and fmt not in KUBERNETES_KNOWN_FORMATS:
            violations.append(f"{node_path}: `format: {fmt}` is not a Kubernetes-known format")

        properties = node.get("properties")
        if isinstance(properties, Mapping):
            for name, child in properties.items():
                walk(child, f"{node_path}.properties.{name}", type_required=True)

        if isinstance(additional, Mapping):
            walk(additional, f"{node_path}.additionalProperties", type_required=True)

        if node_type == "array":
            items = node.get("items")
            if isinstance(items, Mapping):
                walk(items, f"{node_path}.items", type_required=True)
            else:
                violations.append(f"{node_path}: an `array` node must declare an `items` schema")

    walk(schema, path, type_required=True)
    return violations


def validate_k8s_crd_document(content: str) -> None:
    """Validate emitted CRD YAML as an ``apiextensions.k8s.io/v1`` document.

    Re-parses ``content`` through the import adapter (so the document really is a
    CustomResourceDefinition stream), then applies the shape rules the API server
    enforces on top of the schema: the ``v1`` API version, a ``metadata.name`` of
    ``<plural>.<group>``, a known ``scope``, Kubernetes-shaped version names,
    exactly one storage version, and a structural ``openAPIV3Schema`` per version.

    Args:
        content: The emitted YAML text (single document or multi-document stream).

    Raises:
        ValueError: When the document cannot be parsed as a CRD, or breaks any of
            the rules above. The message names every violation found.
    """
    from .k8s_crd_import_source import K8sCrdImportSource

    adapter = K8sCrdImportSource()
    document = adapter.parse(content)

    problems: List[str] = []
    for crd in document.crds:
        if crd.api_version != CRD_API_VERSION:
            problems.append(f"{crd.name}: apiVersion must be {CRD_API_VERSION!r}, got {crd.api_version!r}")
        if crd.name != f"{crd.plural}.{crd.group}":
            problems.append(
                f"{crd.name}: metadata.name must be `<plural>.<group>` "
                f"({crd.plural}.{crd.group})"
            )
        if crd.scope not in {"Namespaced", "Cluster"}:
            problems.append(f"{crd.name}: scope must be Namespaced or Cluster, got {crd.scope!r}")
        storage_versions = [version.name for version in crd.versions if version.storage]
        if len(storage_versions) != 1:
            problems.append(
                f"{crd.name}: exactly one version must set `storage: true` "
                f"(found {len(storage_versions)})"
            )
        for version in crd.versions:
            if not VERSION_NAME.match(version.name):
                problems.append(
                    f"{crd.name}/{version.name}: version names must look like `v1`/`v2beta1`"
                )
            if version.openapi_v3_schema is None:
                continue
            problems.extend(
                structural_schema_violations(
                    version.openapi_v3_schema,
                    path=f"{crd.name}/{version.name}",
                )
            )

    if problems:
        raise ValueError("Invalid CustomResourceDefinition: " + "; ".join(problems))
