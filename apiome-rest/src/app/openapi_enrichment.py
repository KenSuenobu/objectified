"""
Post-process the generated FastAPI OpenAPI document so apiome-rest dogfoods its lint rules.

The REST surface is large (hundreds of Pydantic models). Rather than hand-editing
``openapi.yaml`` / ``openapi.json`` on every route change, :func:`enrich_openapi_spec`
fills the documentation gaps the in-spec linter (:mod:`app.schema_lint`) checks:

* schema and property ``description`` values
* scalar leaf ``example`` values
* ``maxItems`` on array properties
* PascalCase renames for a few auto-generated component schema names
  (curated map, FastAPI ``app__module__Leaf`` nested-model ids, and the
  ``Model-Input`` / ``Model-Output`` pair FastAPI emits when a model serializes
  differently than it validates)

Curated overrides cover domain models (primitives, classes, paths, operations); everything
else gets deterministic, human-readable defaults derived from schema/property names.
"""

from __future__ import annotations

import copy
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, MutableMapping, Optional, Set

_SCALAR_TYPES = frozenset({"string", "number", "integer", "boolean"})
_DEFAULT_ARRAY_MAX_ITEMS = 1000
_LIST_ARRAY_MAX_ITEMS = 100

# Auto-generated component names → stable PascalCase ids the linter accepts. Entries here take
# precedence over the derivation rules below, so a name that needs a *specific* id is pinned
# rather than left to a heuristic.
SCHEMA_RENAMES: Dict[str, str] = {
    "Body_start_spec_import_multipart_v1_tenants__tenant_slug__imports_upload_post": (
        "SpecImportMultipartUploadBody"
    ),
    "MockScenarioSpec-Input": "MockScenarioSpecInput",
    "MockScenarioSpec-Output": "MockScenarioSpecOutput",
}

#: The suffixes FastAPI appends when a model's validation and serialization schemas diverge, so
#: one Pydantic model becomes two components. The hyphen is what fails
#: ``naming.schema-pascal-case``; the split itself is legitimate and must be preserved, so the
#: rename closes the hyphen rather than merging the pair.
_SPLIT_MODEL_SUFFIXES: tuple[str, ...] = ("-Input", "-Output")

#: What ``naming.schema-pascal-case`` accepts. Used to check a split-model *stem* before closing
#: its hyphen: a stem that is not already PascalCase would still fail the rule afterwards, so it
#: is left for the curated map rather than half-fixed here.
_PASCAL_CASE_RE = re.compile(r"^[A-Z][A-Za-z0-9]*$")

# Schema-level descriptions for high-traffic / domain models.
SCHEMA_DESCRIPTIONS: Dict[str, str] = {
    "PrimitiveSchema": (
        "A tenant-scoped primitive type definition in the registry, including its JSON Schema "
        "document, namespace placement, and resolved reference edges."
    ),
    "PrimitiveCreateRequest": "Request body for registering a new primitive type in the tenant registry.",
    "PrimitiveUpdateRequest": "Partial update payload for an existing primitive type definition.",
    "PrimitiveImportRequest": (
        "Import one or more JSON Schema definitions into the primitives registry, with optional "
        "deduplication and per-type conflict resolutions."
    ),
    "PrimitiveImportRecord": "Audit record for a primitives import job or batch.",
    "PrimitiveImportStageRequest": "Stage a primitives import for review before committing types.",
    "PrimitiveImportStageResult": "Outcome of staging a primitives import, including review classifications.",
    "UnresolvedRefPrimitive": "A primitive whose schema still contains unresolved ``$ref`` targets.",
    "ClassSchema": "A version-scoped class (component schema) with its JSON Schema payload and tags.",
    "ClassCreateRequest": "Request body for creating a new class on a project version.",
    "ClassUpdateRequest": "Partial update payload for a class, including canvas metadata when provided.",
    "ClassTagSchema": "Association between a class and a project tag.",
    "ClassTagAssignRequest": "Request body that assigns a tag to a class by tag id.",
    "PropertySchema": (
        "A property on a class, optionally bound to a registry primitive via ``primitive_id`` / "
        "``primitive_ref``."
    ),
    "ProjectPropertySchema": (
        "A property on a project class, including nested structure and optional primitive binding."
    ),
    "ProjectPropertyCreateRequest": "Request body for creating a property on a class.",
    "ProjectPropertyUpdateRequest": "Partial update payload for a class property.",
    "PathSchema": "An HTTP path template attached to a project version.",
    "PathCreateRequest": "Request body for creating a path on a version.",
    "PathUpdateRequest": "Partial update payload for a path.",
    "PathsCanvasPayload": "Persisted React Flow layout for the Paths designer (nodes, edges, viewport).",
    "PathsCanvasViewport": "Viewport position and zoom for the Paths designer canvas.",
    "OperationSchema": "An HTTP operation (method) attached to a version path.",
    "OperationCreateRequest": "Request body for creating an operation on a path.",
    "OperationUpdateRequest": "Partial update payload for an operation.",
    "OperationDescriptionSchema": "Human-facing summary/description metadata for an operation.",
    "OperationDescriptionRequest": "Request body for creating or updating operation description metadata.",
    "SpecImportMultipartUploadBody": (
        "Multipart upload payload for starting a specification import (raw file bytes plus JSON "
        "metadata)."
    ),
    "MockScenarioSpecInput": "Named mock scenario definition submitted with a version.",
    "MockScenarioSpecOutput": "Named mock scenario definition returned from a version.",
    "HTTPValidationError": "Validation error response emitted when request data fails schema checks.",
    "ValidationError": "A single field-level validation error.",
}

# Property descriptions keyed by ``SchemaName.property`` or global ``property`` fallback.
PROPERTY_DESCRIPTIONS: Dict[str, str] = {
    "id": "Stable resource identifier.",
    "tenant_id": "Tenant that owns the resource.",
    "tenant_slug": "URL-safe tenant slug used in path parameters.",
    "project_id": "Project identifier the resource belongs to.",
    "version_id": "Project version identifier or semantic version label, depending on context.",
    "class_id": "Class identifier the resource is attached to.",
    "name": "Human-readable name.",
    "description": "Free-text description.",
    "summary": "Short summary suitable for navigation and reference docs.",
    "slug": "URL-safe identifier.",
    "schema": "Embedded JSON Schema document.",
    "metadata": "Additional JSON metadata bag.",
    "enabled": "Whether the resource is active.",
    "created_at": "Creation timestamp (ISO 8601).",
    "updated_at": "Last update timestamp (ISO 8601).",
    "category": "Classification category for the primitive type.",
    "tags": "Associated tag labels.",
    "is_system": "True when the primitive is shipped by the platform.",
    "is_public": "True when the primitive is visible outside the authoring tenant.",
    "usage_count": "Number of live bindings referencing the primitive.",
    "source": "Provenance source for the record (for example human or imported).",
    "schema_id": "Canonical JSON Schema ``$id`` for the primitive.",
    "draft": "JSON Schema draft identifier (for example 2020-12).",
    "namespace": "Registry namespace segment for the primitive.",
    "base_uri": "Base URI used to resolve relative ``$ref`` values.",
    "refs": "Resolved and unresolved ``$ref`` edges for the primitive schema.",
    "dependents": "Reverse index of ``refs``: the visible types that reference this one, one entry per referencing edge.",
    "pathname": "HTTP path template (for example ``/pets/{petId}``).",
    "operation": "HTTP method name (GET, POST, PUT, PATCH, DELETE, …).",
    "version_path_id": "Identifier of the parent path row for this operation.",
    "path_operation_id": "Identifier of the parent operation row.",
    "operation_id": "OpenAPI ``operationId`` value when set.",
    "primitive_id": "Bound primitive registry row id, when the property references a type.",
    "primitive_ref": "Stored registry ``$ref`` string for the bound primitive.",
    "property_id": "Underlying property identifier when nested or reused.",
    "parent_id": "Parent property id for nested properties.",
    "data": "Structured payload or extension data for the resource.",
    "document_base64": "Base64-encoded specification bytes for JSON import requests.",
    "file": "Raw specification file bytes for multipart import requests.",
    "PrimitiveSchema.name": "Unique primitive type name within the tenant registry.",
    "ClassSchema.name": "Class name as it appears in generated OpenAPI components.",
    "OperationSchema.operation": "HTTP verb for the operation.",
}

# Operation parameter descriptions keyed by parameter name.
PARAMETER_DESCRIPTIONS: Dict[str, str] = {
    "authorization": "JWT bearer token for authenticated access (``Authorization: Bearer <token>``).",
    "X-API-Key": "Tenant-scoped API key used as an alternative to JWT bearer authentication.",
    "tenant_slug": "URL-safe tenant slug that scopes the request.",
    "tenant": "URL-safe tenant slug that scopes the request.",
    "project_slug": "URL-safe project slug within the tenant.",
    "project_id": "Project identifier that scopes the request.",
    "version_slug": "Semantic version label or version slug (for example ``1.0.0``).",
    "version_id": "Version identifier or semantic version label, depending on the route.",
    "version_record_id": "Version row identifier (``versions.id`` UUID).",
    "class_name": "Class name within the version.",
    "class_id": "Class identifier within the version.",
    "property_id": "Property identifier on the class.",
    "path_id": "Path identifier within the version.",
    "operation_id": "Operation identifier within the path.",
    "record_id": "Data record identifier.",
    "item_id": "Catalog item identifier.",
    "job_id": "Asynchronous job identifier.",
    "endpoint_id": "MCP endpoint identifier.",
    "guide_id": "Style guide identifier.",
    "role_id": "Role identifier.",
    "member_id": "Tenant member identifier.",
    "tag_id": "Tag identifier.",
    "primitive_id": "Primitive type identifier in the registry.",
    "repository_id": "Connected repository identifier.",
    "branch": "Git branch name.",
    "path": "Repository-relative file path.",
    "search": "Case-insensitive substring filter.",
    "sort": "Sort order for the result set.",
    "limit": "Maximum number of rows to return.",
    "offset": "Number of rows to skip before returning results.",
    "page": "One-based page index.",
    "page_size": "Number of items per page.",
    "dry_run": "When true, validate without persisting side effects.",
    "dryRun": "When true, validate without persisting side effects.",
    "include_deleted": "When true, include soft-deleted records in the response.",
    "format": "Requested output format.",
    "accept": "Requested response content type (``Accept`` header).",
    "If-None-Match": "ETag from a prior response; returns 304 when unchanged.",
    "If-Match": "ETag of the resource version being updated (optimistic concurrency).",
    "Content-Type": "Request body media type.",
    "slug": "URL-safe resource slug.",
    "target": "Export or conversion target format key.",
    "source_kind": "Import source adapter key (for example ``openapi`` or ``graphql``).",
    "base_revision_id": "Base revision UUID used for compatibility comparison.",
    "revision_id": "Revision UUID (``versions.id``).",
    "visibility": "Visibility filter (for example ``public`` or ``private``).",
    "paradigm": "API paradigm filter (REST, RPC, graph, event, data-schema, agent).",
    "source_format": "Source format filter (for example ``graphql`` or ``protobuf``).",
    "feed": "Feed format selector (``rss``, ``atom``, or ``json``).",
    "badge": "Badge snippet format.",
    "file": "Uploaded file bytes.",
    "metadata": "JSON metadata string accompanying a multipart upload.",
    "summary": "Normalized summary counts for the resource.",
    "source": "Source material descriptor (file, URL, paste, or discovery).",
    "parsed": "Parsed canonical entity groups derived from the captured source.",
    "directory_stats": "Aggregate browse directory statistics.",
    "schemas": "Referenced component schemas implicated in the change.",
    "descriptor": "Export target descriptor metadata.",
    "capability_profile": "Capability profile for the export target.",
    "credential": "Stored MCP credential metadata (never includes secret material).",
    "job": "Asynchronous discovery job status payload.",
    "latency": "Observed latency measurements for the endpoint.",
    "endpoint": "MCP endpoint catalog record.",
    "version": "Endpoint or API version metadata.",
    "type_counts": "Counts grouped by entity type.",
    "change_counts": "Counts grouped by change category.",
    "severity_counts": "Counts grouped by finding severity.",
    "facets": "Facet counts for the faceted search response.",
    "graph": "Graph insight payload for the endpoint.",
    "profile": "Profile summary for the requested insight dimension.",
    "discovery": "Discovery reliability metrics.",
    "invocation": "Invocation reliability metrics.",
    "health": "Health signal summary.",
    "tools": "Tool surface metrics for the endpoint.",
    "metrics": "Computed surface metrics for the endpoint.",
    "conversion": "Catalog conversion provenance when the item was converted to OpenAPI.",
    "relatedArtifacts": "Related artifacts linked to the catalog item.",
}

# Property examples keyed like PROPERTY_DESCRIPTIONS.
PROPERTY_EXAMPLES: Dict[str, Any] = {
    "id": "res_01h2xcejqtf3fz5y5j0v8k9m2p",
    "tenant_id": "ten_01h2xcejqtf3fz5y5j0v8k9m2p",
    "tenant_slug": "acme",
    "project_id": "prj_01h2xcejqtf3fz5y5j0v8k9m2p",
    "version_id": "1.0.0",
    "class_id": "cls_01h2xcejqtf3fz5y5j0v8k9m2p",
    "name": "Pet",
    "description": "A pet available for adoption in the store.",
    "summary": "List pets",
    "slug": "pet-store",
    "category": "domain",
    "enabled": True,
    "is_system": False,
    "is_public": False,
    "usage_count": 3,
    "source": "human",
    "schema_id": "https://registry.example.com/acme/types/v1/Pet",
    "draft": "2020-12",
    "namespace": "acme.types.v1",
    "base_uri": "https://registry.example.com/acme/types/v1/",
    "pathname": "/pets/{petId}",
    "operation": "GET",
    "operation_id": "getPetById",
    "version_path_id": "pth_01h2xcejqtf3fz5y5j0v8k9m2p",
    "path_operation_id": "op_01h2xcejqtf3fz5y5j0v8k9m2p",
    "primitive_id": "prim_01h2xcejqtf3fz5y5j0v8k9m2p",
    "primitive_ref": "https://registry.example.com/acme/types/v1/Pet",
    "property_id": "prop_01h2xcejqtf3fz5y5j0v8k9m2p",
    "parent_id": "prop_parent_01h2xcejqtf3fz5y5j0v8k9m2p",
    "created_at": "2026-07-12T00:00:00Z",
    "updated_at": "2026-07-12T00:00:00Z",
    "document_base64": "eyJvcGVuYXBpIjoiMy4xLjAifQ==",
    "file": "openapi: 3.1.0\ninfo:\n  title: Example\n  version: 1.0.0\n",
    "import_all": False,
    "dedupe": True,
    "map_core_formats": True,
    "score": 98,
    "grade": "A",
    "count": 1,
    "total": 1,
    "limit": 50,
    "offset": 0,
    "page": 1,
    "page_size": 50,
    "percent": 100,
    "dry_run": True,
    "published": False,
    "visibility": "private",
}

_ACRONYMS = {
    "api": "API",
    "mcp": "MCP",
    "url": "URL",
    "uri": "URI",
    "uuid": "UUID",
    "http": "HTTP",
    "https": "HTTPS",
    "json": "JSON",
    "yaml": "YAML",
    "id": "ID",
    "ids": "IDs",
    "dto": "DTO",
    "sql": "SQL",
    "oauth": "OAuth",
    "sso": "SSO",
    "scim": "SCIM",
    "jwt": "JWT",
    "rpc": "RPC",
    "graphql": "GraphQL",
    "openapi": "OpenAPI",
    "asyncapi": "AsyncAPI",
    "protobuf": "Protobuf",
    "grpc": "gRPC",
    "wsdl": "WSDL",
    "fhir": "FHIR",
    "edi": "EDI",
    "iso": "ISO",
}


_HTTP_METHODS = frozenset({"get", "put", "post", "delete", "patch", "options", "head", "trace"})


def enrich_openapi_spec(spec: Mapping[str, Any]) -> Dict[str, Any]:
    """Return an enriched copy of ``spec`` that satisfies :func:`app.schema_lint.lint_openapi_spec`."""
    enriched = copy.deepcopy(spec)
    _rename_component_schemas(enriched)
    _enrich_info(enriched)
    _enrich_component_schemas(enriched)
    _enrich_paths(enriched)
    return enriched


def _fastapi_module_schema_rename(name: str) -> Optional[str]:
    """Turn FastAPI nested-model ids (`app__slate_cache_routes__Foo`) into PascalCase.

    Generated component names use double-underscore module paths that fail
    ``naming.schema-pascal-case``. Prefer the leaf model name prefixed by a
    shortened module path so collisions across route modules stay unique.
    """
    if not name.startswith("app__"):
        return None
    parts = [part for part in name.split("__") if part]
    if len(parts) < 3:
        return None
    module_tokens = parts[1].removesuffix("_routes").split("_")
    prefix = "".join(
        token[:1].upper() + token[1:] for token in module_tokens if token
    )
    leaf = parts[-1]
    if not prefix or not leaf:
        return None
    candidate = f"{prefix}{leaf}"
    return candidate if candidate != name else None


def _fastapi_split_model_rename(name: str) -> Optional[str]:
    """Turn a FastAPI split-model id (``FooSpec-Input``) into PascalCase (``FooSpecInput``).

    FastAPI emits two components for one Pydantic model whose validation and serialization
    schemas differ. The hyphen is the only thing wrong with the generated id, so the rename
    closes it and keeps the two components distinct — merging them would claim a model round-trips
    identically when the generator has just said it does not.

    A general rule rather than a curated entry per pair: the split appears and disappears as
    models change, and a regenerated spec should not need a hand-edit here to stay lint-clean.

    Args:
        name: The generated component schema name.

    Returns:
        The PascalCase id, or ``None`` when ``name`` is not a split-model id or its stem is not
        already PascalCase (in which case closing the hyphen would not make it valid anyway).
    """
    for suffix in _SPLIT_MODEL_SUFFIXES:
        if not name.endswith(suffix):
            continue
        stem = name[: -len(suffix)]
        if _PASCAL_CASE_RE.match(stem):
            return f"{stem}{suffix[1:]}"
    return None


def _rename_component_schemas(spec: MutableMapping[str, Any]) -> None:
    components = spec.setdefault("components", {})
    schemas = components.get("schemas")
    if not isinstance(schemas, dict):
        return
    renames = dict(SCHEMA_RENAMES)
    reserved = set(schemas) | set(renames.values())
    for name in list(schemas):
        if name in renames:
            continue
        auto = _fastapi_module_schema_rename(name) or _fastapi_split_model_rename(name)
        if auto and auto not in reserved:
            renames[name] = auto
            reserved.add(auto)
    for old_name, new_name in renames.items():
        if old_name not in schemas or old_name == new_name:
            continue
        if new_name not in schemas:
            schemas[new_name] = schemas.pop(old_name)
        else:
            schemas.pop(old_name, None)
        _replace_schema_refs(spec, old_name, new_name)


def _replace_schema_refs(node: Any, old_name: str, new_name: str) -> None:
    old_ref = f"#/components/schemas/{old_name}"
    new_ref = f"#/components/schemas/{new_name}"
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key == "$ref" and value == old_ref:
                node[key] = new_ref
            else:
                _replace_schema_refs(value, old_name, new_name)
    elif isinstance(node, list):
        for item in node:
            _replace_schema_refs(item, old_name, new_name)


def _enrich_info(spec: MutableMapping[str, Any]) -> None:
    info = spec.setdefault("info", {})
    if not _nonempty_str(info.get("description")):
        info["description"] = (
            "Apiome REST API for managing tenants, projects, versions, primitives, classes, "
            "paths, operations, catalogs, imports, exports, governance, and MCP catalog surfaces. "
            "All tenant-scoped routes require JWT bearer authentication or an ``X-API-Key`` header."
        )
    info.setdefault(
        "contact",
        {"name": "Apiome", "url": "https://apiome.dev"},
    )
    info.setdefault("license", {"name": "Proprietary"})


def _enrich_component_schemas(spec: MutableMapping[str, Any]) -> None:
    components = spec.get("components")
    schemas = components.get("schemas") if isinstance(components, dict) else None
    if not isinstance(schemas, dict):
        return
    for schema_name in sorted(schemas.keys()):
        schema = schemas[schema_name]
        if isinstance(schema, dict):
            _enrich_schema_node(schema_name, schema, f"components.schemas.{schema_name}")


def _enrich_paths(spec: MutableMapping[str, Any]) -> None:
    paths = spec.get("paths")
    if not isinstance(paths, dict):
        return
    for path_name, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        path_params = path_item.get("parameters")
        if isinstance(path_params, list):
            for param in path_params:
                if isinstance(param, dict):
                    _enrich_parameter(param, path_name=path_name)
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS or not isinstance(operation, dict):
                continue
            op_label = _operation_label(operation, path_name, method)
            for param in operation.get("parameters") or []:
                if isinstance(param, dict):
                    _enrich_parameter(param, path_name=path_name, operation_label=op_label)
            request_body = operation.get("requestBody")
            if isinstance(request_body, dict):
                _enrich_request_body(request_body, op_label)
            for status_code, response in (operation.get("responses") or {}).items():
                if isinstance(response, dict):
                    _enrich_response(response, op_label, status_code)


def _operation_label(operation: Mapping[str, Any], path_name: str, method: str) -> str:
    for key in ("summary", "description", "operationId"):
        value = operation.get(key)
        if _nonempty_str(value):
            return str(value).strip().rstrip(".")
    return f"{method.upper()} {path_name}"


def _enrich_parameter(
    param: MutableMapping[str, Any],
    *,
    path_name: str = "",
    operation_label: str = "",
) -> None:
    name = str(param.get("name") or "").strip()
    if not _nonempty_str(param.get("description")):
        param["description"] = _parameter_description(name, param, path_name=path_name)
    schema = param.get("schema")
    if isinstance(schema, dict):
        schema_name = _inline_schema_name(operation_label or path_name, name)
        _enrich_schema_node(schema_name, schema, f"parameter.{name}")
        if not _nonempty_str(schema.get("description")):
            schema["description"] = param["description"]


def _enrich_request_body(request_body: MutableMapping[str, Any], operation_label: str) -> None:
    if not _nonempty_str(request_body.get("description")):
        request_body["description"] = f"Request body for {operation_label.lower()}."
    content = request_body.get("content")
    if not isinstance(content, dict):
        return
    for media_type, media_obj in content.items():
        if not isinstance(media_obj, dict):
            continue
        schema = media_obj.get("schema")
        if isinstance(schema, dict):
            schema_name = _inline_schema_name(operation_label, "requestBody")
            _enrich_schema_node(schema_name, schema, f"requestBody.{media_type}")


def _enrich_response(
    response: MutableMapping[str, Any], operation_label: str, status_code: str
) -> None:
    desc = response.get("description")
    generic = {"", "successful response", "success"}
    if not _nonempty_str(desc) or str(desc).strip().lower() in generic:
        response["description"] = _response_description(operation_label, status_code)
    content = response.get("content")
    if not isinstance(content, dict):
        return
    for media_type, media_obj in content.items():
        if not isinstance(media_obj, dict):
            continue
        schema = media_obj.get("schema")
        if isinstance(schema, dict):
            schema_name = _inline_schema_name(operation_label, f"response{status_code}")
            _enrich_schema_node(schema_name, schema, f"response.{status_code}.{media_type}")


def _inline_schema_name(context: str, suffix: str) -> str:
    token = re.sub(r"[^A-Za-z0-9]+", "", context)[:40] or "Operation"
    suffix_token = re.sub(r"[^A-Za-z0-9]+", "", suffix)[:20] or "Body"
    return f"{token}{suffix_token}"


def _parameter_description(
    name: str, param: Mapping[str, Any], *, path_name: str = ""
) -> str:
    if name in PARAMETER_DESCRIPTIONS:
        return PARAMETER_DESCRIPTIONS[name]
    location = str(param.get("in") or "query")
    label = _humanize_identifier(name)
    if location == "path":
        if path_name and f"{{{name}}}" in path_name:
            return f"Path parameter identifying the {_humanize_identifier(name).lower()} segment."
        return f"Path parameter: {label.lower()}."
    if location == "header":
        return f"Header parameter: {label}."
    if location == "cookie":
        return f"Cookie parameter: {label.lower()}."
    required = "Required. " if param.get("required") else ""
    return f"{required}Query parameter: {label.lower()}."


def _response_description(operation_label: str, status_code: str) -> str:
    code = str(status_code)
    if code.startswith("2"):
        return f"Successful response for {operation_label.lower()}."
    if code == "202":
        return f"Accepted — asynchronous work started for {operation_label.lower()}."
    if code == "204":
        return f"No content — {operation_label.lower()} completed successfully."
    if code.startswith("4"):
        return f"Client error response for {operation_label.lower()}."
    if code.startswith("5"):
        return f"Server error response for {operation_label.lower()}."
    return f"Response for {operation_label.lower()} (HTTP {code})."


def _enrich_schema_node(schema_name: str, schema: MutableMapping[str, Any], path: str) -> None:
    description = schema.get("description")
    if schema_name in SCHEMA_DESCRIPTIONS:
        schema["description"] = SCHEMA_DESCRIPTIONS[schema_name]
    elif not _nonempty_str(description):
        schema["description"] = _schema_description(schema_name, schema)
    elif isinstance(description, str) and description.startswith("Pydantic model for "):
        schema["description"] = _schema_description(schema_name, schema)

    props = schema.get("properties")
    if isinstance(props, dict):
        for prop_name, prop_schema in props.items():
            if isinstance(prop_schema, dict):
                _enrich_property(schema_name, prop_name, prop_schema, f"{path}.properties.{prop_name}")

    if schema.get("type") == "array":
        items = schema.get("items")
        if isinstance(items, dict):
            item_props = items.get("properties")
            if isinstance(item_props, dict):
                for prop_name, prop_schema in item_props.items():
                    if isinstance(prop_schema, dict):
                        _enrich_property(
                            schema_name,
                            prop_name,
                            prop_schema,
                            f"{path}.items.properties.{prop_name}",
                        )

    for composite_key in ("allOf", "oneOf", "anyOf"):
        variants = schema.get(composite_key)
        if isinstance(variants, list):
            for index, variant in enumerate(variants):
                if isinstance(variant, dict) and "$ref" not in variant:
                    _enrich_schema_node(schema_name, variant, f"{path}.{composite_key}[{index}]")


def _enrich_property(
    schema_name: str,
    prop_name: str,
    schema: MutableMapping[str, Any],
    path: str,
) -> None:
    if not _nonempty_str(schema.get("description")):
        schema["description"] = _property_description(schema_name, prop_name)

    if _is_ref_only(schema):
        return

    for composite_key in ("allOf", "oneOf", "anyOf"):
        variants = schema.get(composite_key)
        if isinstance(variants, list):
            for index, variant in enumerate(variants):
                if isinstance(variant, dict) and "$ref" not in variant:
                    _enrich_schema_node(
                        schema_name,
                        variant,
                        f"{path}.{composite_key}[{index}]",
                    )

    schema_types = _schema_type_set(schema)
    non_null_types = schema_types - {"null"}
    if non_null_types and non_null_types <= _SCALAR_TYPES and not _has_example(schema):
        schema["example"] = _fit_example_to_constraints(
            _property_example(schema_name, prop_name, schema), schema
        )

    if "array" in schema_types and "maxItems" not in schema:
        schema["maxItems"] = _array_max_items(prop_name)

    if "array" in schema_types:
        items = schema.get("items")
        if isinstance(items, dict):
            item_props = items.get("properties")
            if isinstance(item_props, dict):
                for child_name, child_schema in item_props.items():
                    if isinstance(child_schema, dict):
                        _enrich_property(
                            schema_name,
                            child_name,
                            child_schema,
                            f"{path}.items.properties.{child_name}",
                        )

    nested = schema.get("properties")
    if isinstance(nested, dict):
        for child_name, child_schema in nested.items():
            if isinstance(child_schema, dict):
                _enrich_property(
                    schema_name,
                    child_name,
                    child_schema,
                    f"{path}.properties.{child_name}",
                )


def _schema_description(schema_name: str, schema: Mapping[str, Any]) -> str:
    if schema_name in SCHEMA_DESCRIPTIONS:
        return SCHEMA_DESCRIPTIONS[schema_name]
    title = schema.get("title")
    if _nonempty_str(title):
        return f"{title.strip()} schema."
    return _schema_description_from_name(schema_name)


def _schema_description_from_name(schema_name: str) -> str:
    name = schema_name
    for suffix in (
        "Response",
        "Request",
        "Body",
        "Schema",
        "Out",
        "In",
        "Item",
        "Payload",
        "Accepted",
        "Status",
        "Summary",
        "Detail",
        "Record",
        "Result",
        "Preview",
    ):
        if name.endswith(suffix) and len(name) > len(suffix):
            name = name[: -len(suffix)]
            break
    label = _humanize_identifier(name)
    lowered = schema_name.lower()
    if "request" in lowered or schema_name.endswith("Body"):
        return f"Request body for {label.lower()}."
    if "response" in lowered or schema_name.endswith("Out"):
        return f"Response payload for {label.lower()}."
    return f"{label} schema."


def _property_description(schema_name: str, prop_name: str) -> str:
    qualified = f"{schema_name}.{prop_name}"
    if qualified in PROPERTY_DESCRIPTIONS:
        return PROPERTY_DESCRIPTIONS[qualified]
    if prop_name in PROPERTY_DESCRIPTIONS:
        return PROPERTY_DESCRIPTIONS[prop_name]
    return _humanize_property_description(prop_name)


def _humanize_property_description(prop_name: str) -> str:
    label = _humanize_identifier(prop_name)
    lower = prop_name.lower()
    if lower.endswith("_count") or lower.endswith("count"):
        return f"Number of {label.lower().replace(' count', '')}."
    if lower.endswith("_at"):
        return f"{label} timestamp (ISO 8601)."
    if lower.endswith("_id") or lower.endswith("id"):
        return f"{label}."
    if lower.startswith("is_") or lower.startswith("has_"):
        return f"Whether {label[3:].lower() if lower.startswith('is_') else label[4:].lower()}."
    if lower.endswith("_url") or lower.endswith("_uri"):
        return f"{label}."
    return f"{label}."


def _property_example(schema_name: str, prop_name: str, schema: Mapping[str, Any]) -> Any:
    # A constrained value set is not a hint, it is the answer: a property with ``const`` has
    # exactly one legal example, and one with ``enum`` has a closed list. Name-based guessing
    # must never override them — doing so is what produced examples like ``"warning"`` on an
    # ``enum: [warn, block]`` property, which the IXH-5.4 example-conformance rule (#5116)
    # correctly reports as a defect in our own published contract.
    if "const" in schema:
        return schema["const"]
    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and enum_values:
        # The declared default when it is a legal member (the value a client sees most often),
        # else the first member — deterministic either way.
        default = schema.get("default")
        return default if default in enum_values else enum_values[0]

    qualified = f"{schema_name}.{prop_name}"
    if qualified in PROPERTY_EXAMPLES:
        return PROPERTY_EXAMPLES[qualified]
    if prop_name in PROPERTY_EXAMPLES:
        return PROPERTY_EXAMPLES[prop_name]

    schema_types = _schema_type_set(schema)
    non_null_types = schema_types - {"null"}
    primary = next(iter(sorted(non_null_types)), "string")
    lower = prop_name.lower()

    if primary == "boolean":
        return lower.startswith("is_") or lower.startswith("has_") or lower.startswith("enable")
    if primary == "integer":
        if "count" in lower or "total" in lower:
            return 1
        if "percent" in lower:
            return 100
        if "page" in lower:
            return 1
        if "limit" in lower or "size" in lower:
            return 50
        return 1
    if primary == "number":
        if "percent" in lower:
            return 100.0
        return 1.0

    # string
    if lower.endswith("_id") or lower == "id":
        return f"{prop_name.split('_')[0]}_01h2xcejqtf3fz5y5j0v8k9m2p"
    if "email" in lower:
        return "user@example.com"
    if lower.endswith("_url") or lower.endswith("_uri") or lower == "url":
        return "https://example.com/resource"
    if lower.endswith("_at"):
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if "slug" in lower:
        return "example-resource"
    if "uuid" in lower:
        return str(uuid.uuid4())
    if "grade" in lower:
        return "A"
    if "version" in lower:
        return "1.0.0"
    if "operation" in lower:
        return "GET"
    if "pathname" in lower or lower == "path":
        return "/resources/{id}"
    if "name" in lower:
        return "Example"
    if "description" in lower or "summary" in lower:
        return "Example description for documentation and mocks."
    if "token" in lower:
        return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example"
    if "mime" in lower or "content_type" in lower:
        return "application/json"
    if "format" in lower:
        return "openapi"
    if "status" in lower:
        return "active"
    if "severity" in lower:
        return "warning"
    if "category" in lower:
        return "domain"
    if "rule" in lower:
        return "documentation.schema-missing-description"
    if "message" in lower:
        return "Example validation message."
    if "hash" in lower or "fingerprint" in lower:
        return "a1b2c3d4e5f6789012345678901234ab"
    return "example"


def _fit_example_to_constraints(value: Any, schema: Mapping[str, Any]) -> Any:
    """Adjust a name-guessed example so it satisfies the schema's own numeric/length bounds.

    The guesses above are keyed on a property's *name*, which knows nothing about the bounds
    beside it — that is how a ``status`` property bounded to ``100..599`` ended up with the
    example ``1``, and a secret with ``minLength: 8`` with the 7-character ``"example"``. Both
    are defects in our published contract, and the IXH-5.4 example-conformance rule (#5116)
    reports them, so the guess is fitted to the constraints rather than left to contradict them.

    Only bounds that can be satisfied without inventing meaning are applied: numbers are clamped
    into range, and strings are padded or truncated to length. A string carrying a ``pattern`` is
    left untouched — padding it would likely break the pattern, and a wrong "fix" is worse than
    an honest finding.

    Args:
        value: The guessed example.
        schema: The property schema it must satisfy.

    Returns:
        The value, adjusted where a bound applies.
    """
    if isinstance(value, bool):
        return value

    if isinstance(value, (int, float)):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if isinstance(minimum, (int, float)) and not isinstance(minimum, bool) and value < minimum:
            value = type(value)(minimum)
        if isinstance(maximum, (int, float)) and not isinstance(maximum, bool) and value > maximum:
            value = type(value)(maximum)
        return value

    if isinstance(value, str) and not schema.get("pattern"):
        min_length = schema.get("minLength")
        max_length = schema.get("maxLength")
        if isinstance(min_length, int) and len(value) < min_length:
            # Repeat the guess rather than padding with filler, so the result still reads as
            # an example of the thing rather than as noise.
            value = (value * (min_length // max(len(value), 1) + 1))[:min_length]
        if isinstance(max_length, int) and len(value) > max_length:
            value = value[:max_length]
        return value

    return value


def _array_max_items(prop_name: str) -> int:
    lower = prop_name.lower()
    if any(token in lower for token in ("page", "list", "items", "results", "rows", "entries")):
        return _LIST_ARRAY_MAX_ITEMS
    return _DEFAULT_ARRAY_MAX_ITEMS


def _humanize_identifier(name: str) -> str:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    spaced = spaced.replace("_", " ").replace("-", " ")
    words = [w for w in spaced.split() if w]
    out: list[str] = []
    for word in words:
        key = word.lower()
        out.append(_ACRONYMS.get(key, word.capitalize()))
    return " ".join(out)


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _schema_type_set(schema: Mapping[str, Any]) -> Set[str]:
    raw = schema.get("type")
    if isinstance(raw, str):
        return {raw}
    if isinstance(raw, list):
        return {item for item in raw if isinstance(item, str)}
    return set()


def _is_ref_only(schema: Mapping[str, Any]) -> bool:
    return "$ref" in schema and "type" not in schema and "properties" not in schema


def _has_example(schema: Mapping[str, Any]) -> bool:
    if "example" in schema:
        return True
    examples = schema.get("examples")
    if isinstance(examples, list):
        return len(examples) > 0
    if isinstance(examples, dict):
        return len(examples) > 0
    return False
