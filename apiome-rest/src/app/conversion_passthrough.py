"""OpenAPI-native passthrough detection — MFI-22.7 (#4008).

Catalog → OpenAPI conversion (MFI-EPIC-22) must **not** run a lossy canonical→OpenAPI
projection when the source is already OpenAPI/Swagger, or when it is TypeSpec (which
natively emits OpenAPI via ``tsp`` / MFI-EPIC-14). This module:

* **classifies** a conversion source as ``passthrough``, ``typespec_native``, or ``lossy``;
* **adopts** an OpenAPI 3.x document as-is, or **upgrades** Swagger 2.0 → OpenAPI 3.1 with an
  informational note (never via the canonical emitter);
* **compiles** TypeSpec source through the bundled ``tsp`` toolchain into OpenAPI;
* builds a guaranteed **high**-fidelity report for those near-lossless paths.

Non-OpenAPI sources always stay on the lossy 22.1–22.5 path
(:func:`app.conversion_job.preview_conversion`).
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import threading
from enum import Enum
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional, Tuple

from .canonical_model import CanonicalApi
from .emitter import Loss, LossKind
from .fidelity import FidelityReport, FidelityTier
from .import_ingestion import IngestionError, parse_document
from .toolchain_runner import (
    ToolchainError,
    ToolchainRunner,
    ToolNotAvailableError,
    default_runner,
)


def _conversion_error(message: str, *, status_code: int = 422) -> Exception:
    """Build a :class:`~app.conversion_job.ConversionError` (lazy import avoids a cycle)."""
    from .conversion_job import ConversionError

    return ConversionError(message, status_code=status_code)

logger = logging.getLogger(__name__)

__all__ = [
    "ConversionMode",
    "OPENAPI_PASSTHROUGH_FORMATS",
    "TYPESPEC_NATIVE_FORMATS",
    "TYPESPEC_TOOL_KEY",
    "SWAGGER_UPGRADE_NOTE",
    "classify_conversion",
    "normalize_format_key",
    "upgrade_swagger2_to_openapi31",
    "passthrough_document",
    "emit_typespec_openapi",
    "high_fidelity_report",
    "resolve_passthrough_preview",
]

#: Registry key of the bundled TypeSpec compiler (declared in :mod:`app.toolchain_packaging`).
TYPESPEC_TOOL_KEY = "tsp"

#: Canonical format keys (and bare aliases) whose convert action is a near-lossless adopt of the
#: source OpenAPI/Swagger document — never the lossy canonical emitter.
OPENAPI_PASSTHROUGH_FORMATS = frozenset(
    {
        "openapi",
        "openapi-3.0",
        "openapi-3.1",
        "openapi-3.2",
        "swagger",
        "swagger-2.0",
    }
)

#: Format keys whose convert action must route through TypeSpec's native OpenAPI emit (``tsp``),
#: not the lossy projection.
TYPESPEC_NATIVE_FORMATS = frozenset({"typespec", "tsp", "cadl"})

#: Informational note attached to a Swagger 2.0 → OpenAPI 3.1 upgrade report.
SWAGGER_UPGRADE_NOTE = (
    "Swagger 2.0 was upgraded to OpenAPI 3.1 structurally (servers, components, requestBody) "
    "without a lossy canonical-model projection."
)

#: Default OpenAPI version stamped onto an upgraded Swagger 2.0 document.
_OPENAPI_31 = "3.1.0"

_HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")

#: Match ``#/definitions/Foo`` refs so they can be rewritten to ``#/components/schemas/Foo``.
_DEFINITIONS_REF_RE = re.compile(r"#/definitions/([^\"'\s]+)")


class ConversionMode(str, Enum):
    """How a catalog → OpenAPI conversion should be produced (MFI-22.7)."""

    PASSTHROUGH = "passthrough"
    TYPESPEC_NATIVE = "typespec_native"
    LOSSY = "lossy"


def normalize_format_key(fmt: Optional[str]) -> str:
    """Lower-case, strip, and collapse spaces in a format key for set membership checks."""
    if not fmt:
        return ""
    return fmt.strip().lower().replace(" ", "")


def classify_conversion(
    *,
    source_format: Optional[str] = None,
    api_format: Optional[str] = None,
) -> ConversionMode:
    """Classify a conversion source as passthrough, TypeSpec-native, or lossy.

    Prefers the revision's recorded ``source_format`` when present, then falls back to the
    canonical model's ``format``. OpenAPI/Swagger (incl. bare aliases) → passthrough; TypeSpec
    aliases → typespec_native; everything else → lossy (22.1–22.5).

    Args:
        source_format: Revision / provenance format key (e.g. ``openapi-3.1``, ``typespec``).
        api_format: The reconstructed :class:`~app.canonical_model.CanonicalApi.format`.

    Returns:
        The :class:`ConversionMode` the conversion job must take.
    """
    for candidate in (source_format, api_format):
        key = normalize_format_key(candidate)
        if not key:
            continue
        if key in OPENAPI_PASSTHROUGH_FORMATS or key.startswith("openapi-") or key.startswith(
            "swagger-"
        ):
            return ConversionMode.PASSTHROUGH
        if key in TYPESPEC_NATIVE_FORMATS:
            return ConversionMode.TYPESPEC_NATIVE
    return ConversionMode.LOSSY


# ===========================================================================
# High-fidelity report (passthrough / typespec_native)
# ===========================================================================


def high_fidelity_report(*, note: Optional[str] = None) -> FidelityReport:
    """Return a guaranteed high-fidelity report for a near-lossless conversion path.

    Used for OpenAPI/Swagger passthrough and TypeSpec native emit so the preview never runs the
    lossy analyzer (MFI-22.3) against a re-projected document. Optional ``note`` becomes an
    informational :class:`~app.emitter.Loss` (Swagger 2.0→3.1 upgrade specifics).

    Args:
        note: Optional human-readable informational note (e.g. :data:`SWAGGER_UPGRADE_NOTE`).

    Returns:
        A :class:`~app.fidelity.FidelityReport` with score 100, grade ``A``, tier ``high``.
    """
    losses: List[Loss] = []
    if note:
        losses.append(
            Loss(
                kind=LossKind.INFERRED,
                subject="swagger-2.0-upgrade",
                detail=note,
                pointer=None,
            )
        )
    return FidelityReport(
        score=100,
        grade="A",
        tier=FidelityTier.HIGH,
        items=[],
        losses=losses,
        coverage_counts={},
        penalty=0,
    )


# ===========================================================================
# OpenAPI / Swagger document resolution
# ===========================================================================


def passthrough_document(
    api: CanonicalApi,
    source_text: Optional[str] = None,
) -> Tuple[Dict[str, Any], Optional[str]]:
    """Resolve the OpenAPI document to adopt for a passthrough conversion.

    Prefers ``api.raw`` when it is an OpenAPI/Swagger mapping; otherwise parses ``source_text``.
    Swagger 2.0 documents are upgraded to OpenAPI 3.1; OpenAPI 3.x is returned as-is.

    Args:
        api: The reconstructed canonical model (may carry the native document on ``raw``).
        source_text: Captured catalog source text, used when ``api.raw`` is absent or not a
            document mapping.

    Returns:
        ``(document, note)`` — the OpenAPI document to commit and an optional informational note
        (set for Swagger 2.0 upgrades).

    Raises:
        ConversionError: When no OpenAPI/Swagger document can be recovered from the source.
    """
    document = _extract_openapi_mapping(api.raw)
    if document is None and source_text:
        try:
            parsed = parse_document(source_text)
        except IngestionError as exc:
            raise _conversion_error(
                f"Could not parse OpenAPI/Swagger source for passthrough: {exc}",
                status_code=422,
            ) from exc
        if isinstance(parsed, dict):
            document = parsed

    if not isinstance(document, dict):
        raise _conversion_error(
            "OpenAPI/Swagger passthrough requires the captured source document; re-import the "
            "item with its OpenAPI/Swagger body to enable convert.",
            status_code=422,
        )

    if _is_swagger2(document):
        upgraded, note = upgrade_swagger2_to_openapi31(document)
        return upgraded, note

    if not _is_openapi3(document):
        raise _conversion_error(
            "Source is classified as OpenAPI/Swagger but the captured document has no "
            "`openapi` / `swagger` version marker.",
            status_code=422,
        )
    return copy.deepcopy(document), None


def _extract_openapi_mapping(raw: Any) -> Optional[Dict[str, Any]]:
    """Return an OpenAPI/Swagger mapping from ``api.raw`` when present."""
    if isinstance(raw, dict) and (_is_openapi3(raw) or _is_swagger2(raw)):
        return raw
    return None


def _is_openapi3(document: Dict[str, Any]) -> bool:
    version = document.get("openapi")
    return isinstance(version, str) and version.startswith("3.")


def _is_swagger2(document: Dict[str, Any]) -> bool:
    swagger = document.get("swagger")
    if isinstance(swagger, str) and swagger.startswith("2."):
        return True
    if isinstance(swagger, (int, float)) and str(swagger).startswith("2"):
        return True
    return False


# ===========================================================================
# Swagger 2.0 → OpenAPI 3.1 upgrade
# ===========================================================================


def upgrade_swagger2_to_openapi31(document: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
    """Structurally upgrade a Swagger 2.0 document to OpenAPI 3.1.

    Pure and deterministic: the input is not mutated. Maps ``host``/``basePath``/``schemes`` →
    ``servers``, ``definitions`` → ``components.schemas`` (rewriting ``$ref``), ``parameters`` /
    ``responses`` under components, ``securityDefinitions`` → ``components.securitySchemes``,
    and per-operation ``body``/``formData`` parameters → ``requestBody``.

    Args:
        document: A Swagger 2.0 document mapping.

    Returns:
        ``(upgraded_document, informational_note)``.
    """
    src = copy.deepcopy(document)
    out: Dict[str, Any] = {"openapi": _OPENAPI_31}

    if "info" in src and isinstance(src["info"], dict):
        out["info"] = src["info"]

    servers = _swagger_servers(src)
    if servers:
        out["servers"] = servers

    if "tags" in src:
        out["tags"] = src["tags"]
    if "externalDocs" in src:
        out["externalDocs"] = src["externalDocs"]
    if "security" in src:
        out["security"] = src["security"]

    components: Dict[str, Any] = {}
    definitions = src.get("definitions")
    if isinstance(definitions, dict) and definitions:
        components["schemas"] = {
            name: _rewrite_refs(schema) for name, schema in definitions.items()
        }
    parameters = src.get("parameters")
    if isinstance(parameters, dict) and parameters:
        components["parameters"] = {
            name: _upgrade_parameter(param, consumes=src.get("consumes"))
            for name, param in parameters.items()
            if isinstance(param, dict) and param.get("in") not in {"body", "formData"}
        }
    responses = src.get("responses")
    if isinstance(responses, dict) and responses:
        components["responses"] = {
            name: _upgrade_response(resp, produces=src.get("produces"))
            for name, resp in responses.items()
            if isinstance(resp, dict)
        }
    security_defs = src.get("securityDefinitions")
    if isinstance(security_defs, dict) and security_defs:
        components["securitySchemes"] = {
            name: _upgrade_security_scheme(scheme)
            for name, scheme in security_defs.items()
            if isinstance(scheme, dict)
        }
    if components:
        out["components"] = components

    paths = src.get("paths")
    if isinstance(paths, dict):
        out["paths"] = {
            path: _upgrade_path_item(
                item,
                consumes=src.get("consumes"),
                produces=src.get("produces"),
            )
            for path, item in paths.items()
            if isinstance(item, dict)
        }
    else:
        out["paths"] = {}

    return out, SWAGGER_UPGRADE_NOTE


def _swagger_servers(document: Dict[str, Any]) -> List[Dict[str, str]]:
    """Build OpenAPI ``servers`` from Swagger ``host`` / ``basePath`` / ``schemes``."""
    host = document.get("host")
    if not isinstance(host, str) or not host.strip():
        return []
    base_path = document.get("basePath") or ""
    if not isinstance(base_path, str):
        base_path = ""
    if base_path and not base_path.startswith("/"):
        base_path = f"/{base_path}"
    schemes = document.get("schemes")
    if isinstance(schemes, list) and schemes:
        scheme_list = [str(s) for s in schemes if s]
    else:
        scheme_list = ["https"]
    return [{"url": f"{scheme}://{host}{base_path}"} for scheme in scheme_list]


def _rewrite_refs(node: Any) -> Any:
    """Rewrite ``#/definitions/…`` refs to ``#/components/schemas/…`` recursively."""
    if isinstance(node, dict):
        out: Dict[str, Any] = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                out[key] = _DEFINITIONS_REF_RE.sub(r"#/components/schemas/\1", value)
            else:
                out[key] = _rewrite_refs(value)
        return out
    if isinstance(node, list):
        return [_rewrite_refs(item) for item in node]
    return node


def _upgrade_path_item(
    item: Dict[str, Any],
    *,
    consumes: Any,
    produces: Any,
) -> Dict[str, Any]:
    """Upgrade one Swagger path item (shared parameters + operations) to OpenAPI 3.1."""
    result: Dict[str, Any] = {}
    shared = item.get("parameters")
    if isinstance(shared, list):
        converted = [
            _upgrade_parameter(param, consumes=consumes)
            for param in shared
            if isinstance(param, dict) and param.get("in") not in {"body", "formData"}
        ]
        if converted:
            result["parameters"] = converted
    for method in _HTTP_METHODS:
        operation = item.get(method)
        if isinstance(operation, dict):
            result[method] = _upgrade_operation(
                operation, consumes=consumes, produces=produces
            )
    return result


def _upgrade_operation(
    operation: Dict[str, Any],
    *,
    consumes: Any,
    produces: Any,
) -> Dict[str, Any]:
    """Upgrade one Swagger operation: body/formData → requestBody, responses → content."""
    result: Dict[str, Any] = {}
    for key in (
        "operationId",
        "summary",
        "description",
        "tags",
        "deprecated",
        "security",
        "externalDocs",
        "servers",
    ):
        if key in operation:
            result[key] = copy.deepcopy(operation[key])

    op_consumes = operation.get("consumes", consumes)
    op_produces = operation.get("produces", produces)

    parameters: List[Dict[str, Any]] = []
    body_param: Optional[Dict[str, Any]] = None
    form_params: List[Dict[str, Any]] = []
    own = operation.get("parameters")
    if isinstance(own, list):
        for param in own:
            if not isinstance(param, dict):
                continue
            location = param.get("in")
            if location == "body":
                body_param = param
            elif location == "formData":
                form_params.append(param)
            else:
                parameters.append(_upgrade_parameter(param, consumes=op_consumes))
    if parameters:
        result["parameters"] = parameters

    request_body = _request_body_from_swagger(
        body_param=body_param, form_params=form_params, consumes=op_consumes
    )
    if request_body is not None:
        result["requestBody"] = request_body

    responses = operation.get("responses")
    if isinstance(responses, dict):
        result["responses"] = {
            code: _upgrade_response(resp, produces=op_produces)
            for code, resp in responses.items()
            if isinstance(resp, dict)
        }
    else:
        result["responses"] = {"default": {"description": "Default response"}}

    return result


def _upgrade_parameter(param: Dict[str, Any], *, consumes: Any) -> Dict[str, Any]:
    """Upgrade a non-body Swagger parameter to OpenAPI 3.1 (schema-inlined)."""
    del consumes  # reserved for callers that fold form media types elsewhere
    result: Dict[str, Any] = {
        "name": param.get("name", "param"),
        "in": param.get("in", "query"),
    }
    for key in ("description", "required", "deprecated", "allowEmptyValue", "example"):
        if key in param:
            result[key] = copy.deepcopy(param[key])
    schema: Dict[str, Any] = {}
    if "schema" in param and isinstance(param["schema"], dict):
        schema = _rewrite_refs(param["schema"])
    else:
        for key in (
            "type",
            "format",
            "items",
            "enum",
            "default",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "pattern",
            "uniqueItems",
            "multipleOf",
        ):
            if key in param:
                schema[key] = _rewrite_refs(param[key])
    if schema:
        result["schema"] = schema
    return result


def _request_body_from_swagger(
    *,
    body_param: Optional[Dict[str, Any]],
    form_params: List[Dict[str, Any]],
    consumes: Any,
) -> Optional[Dict[str, Any]]:
    """Build an OpenAPI ``requestBody`` from Swagger body / formData parameters."""
    media_types = _media_types(consumes, default="application/json")
    if body_param is not None:
        schema = body_param.get("schema")
        content = {
            mt: {"schema": _rewrite_refs(schema) if isinstance(schema, dict) else {}}
            for mt in media_types
        }
        body: Dict[str, Any] = {"content": content}
        if body_param.get("required"):
            body["required"] = True
        if body_param.get("description"):
            body["description"] = body_param["description"]
        return body

    if not form_params:
        return None

    properties: Dict[str, Any] = {}
    required: List[str] = []
    for param in form_params:
        name = str(param.get("name") or "field")
        schema: Dict[str, Any] = {}
        for key in ("type", "format", "enum", "default", "items"):
            if key in param:
                schema[key] = _rewrite_refs(param[key])
        if param.get("type") == "file":
            schema = {"type": "string", "format": "binary"}
        if param.get("description"):
            schema["description"] = param["description"]
        properties[name] = schema
        if param.get("required"):
            required.append(name)

    form_schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        form_schema["required"] = required

    # Prefer multipart when any file field is present; else form-urlencoded.
    has_file = any(p.get("type") == "file" for p in form_params)
    form_media = "multipart/form-data" if has_file else "application/x-www-form-urlencoded"
    return {"content": {form_media: {"schema": form_schema}}}


def _upgrade_response(resp: Dict[str, Any], *, produces: Any) -> Dict[str, Any]:
    """Upgrade a Swagger response object to OpenAPI 3.1 (schema → content)."""
    result: Dict[str, Any] = {"description": resp.get("description") or ""}
    schema = resp.get("schema")
    if isinstance(schema, dict):
        media_types = _media_types(produces, default="application/json")
        result["content"] = {
            mt: {"schema": _rewrite_refs(schema)} for mt in media_types
        }
    headers = resp.get("headers")
    if isinstance(headers, dict) and headers:
        result["headers"] = {
            name: _upgrade_header(header)
            for name, header in headers.items()
            if isinstance(header, dict)
        }
    if "examples" in resp:
        # Swagger response examples don't map 1:1; keep under x- for fidelity visibility.
        result["x-apiome-swagger-examples"] = copy.deepcopy(resp["examples"])
    return result


def _upgrade_header(header: Dict[str, Any]) -> Dict[str, Any]:
    """Upgrade a Swagger header object to OpenAPI 3.1."""
    result: Dict[str, Any] = {}
    if "description" in header:
        result["description"] = header["description"]
    schema: Dict[str, Any] = {}
    for key in ("type", "format", "enum", "default", "items"):
        if key in header:
            schema[key] = _rewrite_refs(header[key])
    if schema:
        result["schema"] = schema
    return result


def _upgrade_security_scheme(scheme: Dict[str, Any]) -> Dict[str, Any]:
    """Upgrade a Swagger ``securityDefinitions`` entry to OpenAPI 3.1 ``securitySchemes``."""
    scheme_type = scheme.get("type")
    result: Dict[str, Any] = {}
    if scheme_type == "basic":
        result["type"] = "http"
        result["scheme"] = "basic"
    elif scheme_type == "apiKey":
        result["type"] = "apiKey"
        for key in ("name", "in"):
            if key in scheme:
                result[key] = scheme[key]
    elif scheme_type == "oauth2":
        result["type"] = "oauth2"
        flows: Dict[str, Any] = {}
        flow = scheme.get("flow")
        flow_key = {
            "implicit": "implicit",
            "password": "password",
            "application": "clientCredentials",
            "accessCode": "authorizationCode",
        }.get(str(flow), "implicit")
        flow_obj: Dict[str, Any] = {}
        if "authorizationUrl" in scheme:
            flow_obj["authorizationUrl"] = scheme["authorizationUrl"]
        if "tokenUrl" in scheme:
            flow_obj["tokenUrl"] = scheme["tokenUrl"]
        if "scopes" in scheme:
            flow_obj["scopes"] = copy.deepcopy(scheme["scopes"])
        flows[flow_key] = flow_obj
        result["flows"] = flows
    else:
        result = copy.deepcopy(scheme)
    if "description" in scheme:
        result["description"] = scheme["description"]
    return result


def _media_types(value: Any, *, default: str) -> List[str]:
    """Normalize a Swagger ``consumes`` / ``produces`` list to media-type strings."""
    if isinstance(value, list) and value:
        return [str(v) for v in value if v]
    return [default]


# ===========================================================================
# TypeSpec native OpenAPI emit (tsp)
# ===========================================================================


def emit_typespec_openapi(
    source_text: str,
    *,
    source_label: Optional[str] = None,
    runner: Optional[ToolchainRunner] = None,
) -> Dict[str, Any]:
    """Compile TypeSpec source to an OpenAPI document via the bundled ``tsp`` tool.

    Writes a temporary project (``main.tsp`` + ``tspconfig.yaml`` emitting
    ``@typespec/openapi3``), runs ``tsp compile .``, and returns the produced OpenAPI
    JSON/YAML as a dict. Synchronous: when called from a running event loop it bridges onto
    a worker thread (same pattern as the gRPC ``buf`` compile).

    Args:
        source_text: The TypeSpec ``.tsp`` source text.
        source_label: Optional label for error messages.
        runner: Optional toolchain runner (tests inject fakes); defaults to a fresh runner
            on the worker loop.

    Returns:
        The compiled OpenAPI document mapping.

    Raises:
        ConversionError: When ``source_text`` is empty, ``tsp`` is unavailable, compile fails,
            or no OpenAPI output is produced.
    """
    if not (source_text or "").strip():
        raise _conversion_error(
            "TypeSpec native OpenAPI emit requires the captured `.tsp` source text.",
            status_code=422,
        )

    try:
        asyncio.get_running_loop()
        in_loop = True
    except RuntimeError:
        in_loop = False

    if in_loop:
        return _emit_typespec_on_worker(source_text, source_label=source_label, runner=runner)
    return asyncio.run(
        _emit_typespec_async(source_text, source_label=source_label, runner=runner)
    )


def _emit_typespec_on_worker(
    source_text: str,
    *,
    source_label: Optional[str],
    runner: Optional[ToolchainRunner],
) -> Dict[str, Any]:
    """Run :func:`_emit_typespec_async` on a dedicated worker thread with its own event loop."""
    box: Dict[str, Any] = {}

    def _worker() -> None:
        try:
            box["value"] = asyncio.run(
                _emit_typespec_async(source_text, source_label=source_label, runner=runner)
            )
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread
            box["error"] = exc

    thread = threading.Thread(target=_worker, name="typespec-openapi-emit", daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


async def _emit_typespec_async(
    source_text: str,
    *,
    source_label: Optional[str],
    runner: Optional[ToolchainRunner],
) -> Dict[str, Any]:
    """Async implementation of TypeSpec → OpenAPI via ``tsp compile``."""
    active = runner
    if active is None:
        active = ToolchainRunner(
            max_concurrency=default_runner.max_concurrency,
            default_timeout_seconds=default_runner.default_timeout_seconds,
            default_policy=default_runner.default_policy,
        )

    where = f" ({source_label})" if source_label else ""
    with TemporaryDirectory(prefix="apiome-tsp-") as tmp:
        root = Path(tmp)
        (root / "main.tsp").write_text(source_text, encoding="utf-8")
        (root / "tspconfig.yaml").write_text(
            "\n".join(
                [
                    'emit:',
                    '  - "@typespec/openapi3"',
                    "options:",
                    '  "@typespec/openapi3":',
                    '    output-file: openapi.json',
                    "",
                ]
            ),
            encoding="utf-8",
        )
        try:
            await active.run(
                TYPESPEC_TOOL_KEY,
                ("compile", ".", "--output-dir", "tsp-output"),
                cwd=str(root),
            )
        except ToolNotAvailableError as exc:
            raise _conversion_error(
                "TypeSpec native OpenAPI emit requires the bundled `tsp` compiler "
                f"(APIOME_TSP_BIN / toolchain packaging); it is not available{where}.",
                status_code=422,
            ) from exc
        except ToolchainError as exc:
            raise _conversion_error(
                f"TypeSpec `tsp compile` failed{where}: {exc}",
                status_code=422,
            ) from exc

        document = _read_typespec_openapi_output(root / "tsp-output")
        if document is None:
            raise _conversion_error(
                f"TypeSpec `tsp compile` produced no OpenAPI output{where}.",
                status_code=422,
            )
        return document


def _read_typespec_openapi_output(output_dir: Path) -> Optional[Dict[str, Any]]:
    """Find and parse the OpenAPI JSON/YAML emitted under ``tsp-output``."""
    if not output_dir.is_dir():
        return None
    candidates: List[Path] = []
    for pattern in ("**/openapi.json", "**/*.openapi.json", "**/openapi.yaml", "**/openapi.yml"):
        candidates.extend(sorted(output_dir.glob(pattern)))
    # Also accept any json/yaml under the openapi3 emitter folder.
    for path in sorted(output_dir.rglob("*")):
        if path.is_file() and path.suffix.lower() in {".json", ".yaml", ".yml"}:
            if path not in candidates:
                candidates.append(path)

    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if path.suffix.lower() == ".json":
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                continue
        else:
            try:
                data = parse_document(text, source_label=str(path))
            except IngestionError:
                continue
        if isinstance(data, dict) and _is_openapi3(data):
            return data
    return None


# ===========================================================================
# Preview resolution helper used by conversion_job
# ===========================================================================


def resolve_passthrough_preview(
    *,
    mode: ConversionMode,
    api: CanonicalApi,
    source_text: Optional[str],
) -> Tuple[Dict[str, Any], FidelityReport]:
    """Produce the (document, high-fidelity report) for a non-lossy conversion mode.

    Args:
        mode: Must be :attr:`ConversionMode.PASSTHROUGH` or
            :attr:`ConversionMode.TYPESPEC_NATIVE`.
        api: The reconstructed canonical model.
        source_text: Captured source text (required for TypeSpec; fallback for OpenAPI).

    Returns:
        ``(openapi_document, fidelity_report)``.

    Raises:
        ConversionError: On missing source material or TypeSpec toolchain failure.
        ValueError: If ``mode`` is :attr:`ConversionMode.LOSSY`.
    """
    if mode is ConversionMode.PASSTHROUGH:
        document, note = passthrough_document(api, source_text)
        return document, high_fidelity_report(note=note)

    if mode is ConversionMode.TYPESPEC_NATIVE:
        document = emit_typespec_openapi(source_text or "", source_label=api.format)
        return document, high_fidelity_report()

    raise ValueError(f"resolve_passthrough_preview does not handle mode {mode!r}")
