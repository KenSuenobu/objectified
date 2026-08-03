"""Project-vs-Catalog import routing — MFI-23.7 (#4016).

A finished import must become one of two things: a **publishable Project** (the
existing OpenAPI/Swagger path) or a **non-publishable catalog item** (MFI-23.1 —
the ``publishable = false`` slice of ``apiome.projects``). This module is the single
decision point: given a resolved :class:`~app.import_source.ImportSource` adapter and
the :class:`~app.canonical_model.CanonicalApi` model it produced, it decides which,
and — crucially for the UI — *why*.

The rule (from the roadmap):

* **OpenAPI / Swagger** (including **TypeSpec-emitted OpenAPI**, which a TypeSpec
  adapter normalizes to an ``openapi-3.x`` format) → **Project** (``publishable``),
  exactly as today.
* **Everything else that is OpenAPI-worthy** — a non-OpenAPI import that still carries
  operations and/or types (gRPC, GraphQL, AsyncAPI, Arazzo, OData, …) → **catalog item**
  (non-publishable).
* **Pure data-schema sources** (Avro, Protobuf-schema, JSON-Schema, XSD) — types but no
  operations/channels → **catalog item**, additionally flagged **``schemas_only``** so
  the UI can say *why* it is not an API.

The branch is on the adapter's **emitted format** (``model.format``), not the source
tool, so a tool that emits OpenAPI (TypeSpec) routes to a Project while a tool that
emits anything else routes to the catalog — which is exactly the "and TypeSpec-emitted
OpenAPI" carve-out the ticket calls for.

The decision is **pure** (no I/O): it only reads the canonical model and the adapter's
descriptor, so it is fully unit-testable and the import pipeline (MFI-1.2) can record
it on the import summary for the UI to explain. When the canonical→catalog persistence
hook lands (a later format epic), it consumes :attr:`ImportRoutingDecision.publishable`
to call ``db.create_project(..., publishable=...)`` — ``True`` mints a Project, ``False``
mints a catalog item.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict

from .canonical_model import ApiParadigm, CanonicalApi
from .import_source import ImportSource

__all__ = [
    "PUBLISHABLE_FORMATS",
    "AS_CURRENT_TARGETS",
    "GATEWAY_CONFIG_FORMATS",
    "ImportTarget",
    "ImportRoutingDecision",
    "decide_import_routing",
    "is_json_schema_format",
]


#: Emitted canonical format keys whose import becomes a **publishable Project** — the
#: OpenAPI/Swagger family, as today. A non-OpenAPI source that *emits* one of these
#: (TypeSpec → ``openapi-3.x``) routes here too, because the branch is on the emitted
#: format, not the source tool. Every other format routes to the catalog.
PUBLISHABLE_FORMATS = frozenset(
    {"openapi-3.0", "openapi-3.1", "openapi-3.2", "swagger-2.0"}
)

#: Emitted format keys of the gateway-configuration adapters (IXH-7.8). They route to
#: the catalog like every other non-OpenAPI format; the only specialization is the
#: routing *reason*, which states the partial-fidelity cause (routes without schemas)
#: and the promotion path, because that is exactly what the catalog's non-publishable
#: staging exists for.
GATEWAY_CONFIG_FORMATS = frozenset({"kong", "kong-declarative", "gateway-api", "httproute"})

#: The explicit ``requested_target`` values (from the JSON Schema disambiguation prompt,
#: MFI-26.7) that mean "import the schema **as current** into Types/Projects" rather than
#: store a catalog item. Both map to :attr:`ImportTarget.TYPES`; ``project`` does *not* mint a
#: publishable Project (only OpenAPI/Arazzo do that — §0.3 rule 1), it lands the schema in the
#: type registry as a current type/schema exactly like ``types``.
AS_CURRENT_TARGETS = frozenset({"types", "project"})


def is_json_schema_format(fmt_key: str) -> bool:
    """Return ``True`` when a lower-cased emitted format key is a JSON Schema.

    The ``json-schema`` adapter (MFI-26.7) always emits ``json-schema`` as the canonical
    ``model.format``, but a dialect-tagged variant (``json-schema-2020-12``) is tolerated so
    the check stays correct if the emitted key ever carries the dialect. JSON Schema is the
    only format the routing lets an explicit ``requested_target`` redirect (§0.3): every other
    format ignores the request and keeps its fixed destination.

    Args:
        fmt_key: The already lower-cased, stripped canonical format key.

    Returns:
        ``True`` for ``json-schema`` (or a ``json-schema-*`` variant), else ``False``.
    """
    return fmt_key == "json-schema" or fmt_key.startswith("json-schema")


class ImportTarget(str, Enum):
    """Where a finished import lands.

    ``PROJECT`` is the publishable artifact (the existing OpenAPI/Swagger path); ``CATALOG``
    is the non-publishable catalog item (MFI-23.1); ``TYPES`` is a JSON Schema imported **as
    current** into the type registry (Types/Projects), the destination the MFI-26.7 prompt
    offers as the alternative to the catalog (MFI-26.8). The string values are stable so they
    can be persisted on the import summary and read by the UI.
    """

    PROJECT = "project"
    CATALOG = "catalog"
    TYPES = "types"


@dataclass(frozen=True)
class ImportRoutingDecision:
    """The Project-vs-Catalog routing verdict for one import, with its reason.

    Frozen so a decision is an immutable record that can be stashed on the job
    summary and compared in tests. :attr:`reason` is human-readable and intended for
    the UI to surface ("why is this a catalog item and not a project?").

    Attributes:
        target: :class:`ImportTarget` — ``PROJECT``, ``CATALOG``, or ``TYPES`` (a JSON
            Schema imported as current into the type registry, MFI-26.8).
        publishable: ``True`` for a Project, ``False`` for a catalog item or a ``TYPES``
            (as-current) import. This is the value the catalog persistence hook passes to
            ``db.create_project(publishable=...)``; the ``TYPES`` branch persists into the
            type registry instead and never mints a project.
        schemas_only: ``True`` when the source carries only data types (no operations
            or channels) — a pure data-schema source the UI flags "schemas-only".
            Always ``False`` for a Project.
        reason: A short, human-readable justification for the routing.
        source: The adapter key the import ran through (e.g. ``openapi``, ``grpc``).
        paradigm: The canonical paradigm value (e.g. ``rest``, ``rpc``, ``data_schema``).
        format: The emitted canonical format key the decision branched on.
        operation_count: Number of operations across all services in the model.
        type_count: Number of named data types in the model.
        channel_count: Number of event channels in the model.
    """

    target: ImportTarget
    publishable: bool
    schemas_only: bool
    reason: str
    source: str
    paradigm: str
    format: str
    operation_count: int
    type_count: int
    channel_count: int

    def as_dict(self) -> Dict[str, Any]:
        """Return the decision as a plain JSON-serializable mapping for the summary."""
        return {
            "target": self.target.value,
            "publishable": self.publishable,
            "schemas_only": self.schemas_only,
            "reason": self.reason,
            "source": self.source,
            "paradigm": self.paradigm,
            "format": self.format,
            "counts": {
                "operations": self.operation_count,
                "types": self.type_count,
                "channels": self.channel_count,
            },
        }


def decide_import_routing(
    adapter: ImportSource,
    model: CanonicalApi,
    *,
    requested_target: str | None = None,
) -> ImportRoutingDecision:
    """Decide whether an import becomes a Project, a catalog item, or current Types.

    Pure: reads only ``model``, the ``adapter`` descriptor, and the user's explicit
    ``requested_target``. The branch is on the emitted format (``model.format``) so
    OpenAPI/Swagger — including TypeSpec-emitted OpenAPI — becomes a Project and everything
    else becomes a catalog item, with the pure-data-schema case additionally flagged
    ``schemas_only``.

    The one exception is **JSON Schema** (§0.3 / MFI-26.7): it is the only format that prompts
    the user, so a ``requested_target`` of ``types``/``project`` redirects it to
    :attr:`ImportTarget.TYPES` — imported *as current* into the type registry — instead of the
    catalog. The request is honored **only** for JSON Schema: OpenAPI/Swagger always route to a
    publishable Project and every other non-OpenAPI format always routes to the catalog,
    regardless of ``requested_target`` (so there is no regression to their routing).

    Args:
        adapter: The resolved import-source adapter the document ran through.
        model: The canonical model the adapter normalized the document into.
        requested_target: The user's explicit disambiguation choice for a JSON Schema import
            (``catalog`` / ``types`` / ``project``); ``None`` (or ``catalog``) keeps the
            default catalog branch. Ignored for every non-JSON-Schema format.

    Returns:
        The :class:`ImportRoutingDecision` — target, ``publishable`` flag,
        ``schemas_only`` flag, and a human-readable reason — for the pipeline to
        record on the import summary.
    """
    fmt = (model.format or "").strip()
    fmt_key = fmt.lower()
    source = adapter.key or model.format
    paradigm = model.paradigm
    # Normalize the user's opt-in once; only a JSON Schema import ever consults it.
    requested = (requested_target or "").strip().lower() or None

    operation_count = len(model.operations())
    type_count = len(model.types)
    channel_count = len(model.channels)

    # --- OpenAPI/Swagger (incl. TypeSpec-emitted OpenAPI) → publishable Project ---
    # This branch is intentionally reached before ``requested_target`` is consulted: only
    # OpenAPI and Arazzo create Projects (§0.3 rule 1), and no user opt-in can change that.
    if fmt_key in PUBLISHABLE_FORMATS:
        return ImportRoutingDecision(
            target=ImportTarget.PROJECT,
            publishable=True,
            schemas_only=False,
            reason=(
                f"{fmt} is an OpenAPI/Swagger/Arazzo description "
                "→ publishable Project (as today)."
            ),
            source=source,
            paradigm=paradigm.value,
            format=fmt,
            operation_count=operation_count,
            type_count=type_count,
            channel_count=channel_count,
        )

    # --- JSON Schema imported *as current* → Types/Projects (MFI-26.8) ----------
    # JSON Schema is the only format that asks the user (§0.3): when they pick Types/Projects
    # the schema is imported as a **current** type/schema into the registry rather than stored
    # as a catalog item. This never mints a publishable Project — ``publishable`` stays False —
    # so §0.3 rule 1 (only OpenAPI/Arazzo create Projects) holds even for ``requested='project'``.
    if is_json_schema_format(fmt_key) and requested in AS_CURRENT_TARGETS:
        fmt_label = fmt or paradigm.value
        return ImportRoutingDecision(
            target=ImportTarget.TYPES,
            publishable=False,
            schemas_only=True,
            reason=(
                f"{fmt_label} imported as current type/schema "
                f"(requested target {requested!r}) → Types/Projects, not a catalog item."
            ),
            source=source,
            paradigm=paradigm.value,
            format=fmt,
            operation_count=operation_count,
            type_count=type_count,
            channel_count=channel_count,
        )

    # --- gateway configs → catalog, with the partial-fidelity reason stated ------
    # Same destination as every non-OpenAPI format; the reason names the capability
    # limit (routes without request/response schemas) and the promotion path, so the
    # UI can state *why* this import is staged rather than published (IXH-7.8).
    if fmt_key in GATEWAY_CONFIG_FORMATS:
        fmt_label = fmt or paradigm.value
        return ImportRoutingDecision(
            target=ImportTarget.CATALOG,
            publishable=False,
            schemas_only=False,
            reason=(
                f"{fmt_label} is a gateway routing surface ({operation_count} "
                "operation(s)) with no request/response schemas — a capability limit "
                "of the format, not a loss → non-publishable catalog item; supply "
                "schemas and use the convert flow to promote."
            ),
            source=source,
            paradigm=paradigm.value,
            format=fmt,
            operation_count=operation_count,
            type_count=type_count,
            channel_count=channel_count,
        )

    # --- everything else → non-publishable catalog item -------------------------
    # "schemas-only" = a pure data-schema source: it carries types but exposes no
    # callable surface (no operations, no event channels). The DATA_SCHEMA paradigm
    # is the declared signal; the structural check (types but no ops/channels) backs
    # it up so a data-schema import that mis-declares its paradigm is still flagged.
    schemas_only = (
        paradigm == ApiParadigm.DATA_SCHEMA
        or (type_count > 0 and operation_count == 0 and channel_count == 0)
    )

    fmt_label = fmt or paradigm.value
    if schemas_only:
        reason = (
            f"{fmt_label} is a pure data-schema source "
            f"({type_count} type(s), no operations) → schemas-only catalog item."
        )
    elif operation_count > 0 or channel_count > 0:
        reason = (
            f"{fmt_label} is OpenAPI-worthy but not OpenAPI "
            f"({operation_count} operation(s), {type_count} type(s), "
            f"{channel_count} channel(s)) → catalog item."
        )
    else:
        # No callable surface and no types — nothing publishable to make a Project of.
        reason = (
            f"{fmt_label} carries no operations or types "
            "→ catalog item (nothing publishable detected)."
        )

    return ImportRoutingDecision(
        target=ImportTarget.CATALOG,
        publishable=False,
        schemas_only=schemas_only,
        reason=reason,
        source=source,
        paradigm=paradigm.value,
        format=fmt,
        operation_count=operation_count,
        type_count=type_count,
        channel_count=channel_count,
    )
