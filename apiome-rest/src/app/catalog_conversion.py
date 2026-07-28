"""Reconstruct a conversion source from a stored catalog item — MFI-22.6 (#4007).

The convert-to-project job (:mod:`app.conversion_job`, MFI-22.5) operates on a ready-made
:class:`~app.conversion_job.ConversionSource` — a :class:`~app.canonical_model.CanonicalApi` plus the
provenance coordinates the converted Project links back to. Building that from a catalog item is
deliberately *the caller's concern* (see :class:`~app.conversion_job.ConversionSource`), and this
module is that caller-side glue for the MFI-22.6 REST endpoint.

A catalog item (MFI-23.1) is the ``publishable = false`` slice of ``projects``: its id *is* a project
id, and its latest revision records what *kind* of API it came from (``source_format`` / ``protocol``
/ ``format_metadata`` / ``source_tool_versions``, MFI-7.1/7.2) — **including the captured raw source**
in ``format_metadata`` (the ``sourceContent`` / ``rawSource`` / … keys :func:`resolve_source_payload`
reads). Because the canonical model is not itself re-loadable from the relational catalog, this module
rebuilds it the same way the import did: resolve the source's :class:`~app.import_source.ImportSource`
adapter, ``parse`` the captured text into the format's native AST, and ``normalize`` that into a
:class:`~app.canonical_model.CanonicalApi`. That reconstructed model is exactly what the emitter
(MFI-22.1) and fidelity analyzer (MFI-22.3) consume, so a preview or a commit runs against the same
model the catalog was normalized from.

The adapter is resolved robustly because a revision stores the *canonical format* (e.g. ``protobuf``),
which is not always the adapter's registry key (e.g. ``grpc``): try the key directly, then any adapter
whose ``formats`` advertise that format, then fall back to content sniffing. Every failure to rebuild
(no captured source, unknown format, unparseable text) raises a :class:`ConversionError` with an HTTP
status the endpoint maps straight through, so the caller never has to re-classify it.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .catalog_detail import resolve_source_payload
from .conversion_job import ConversionError, ConversionSource
from .import_source import (
    DetectionInput,
    ImportSource,
    ImportSourceError,
    available_import_sources,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)
from .payload_analysis import PayloadAnalysisDocument

__all__ = [
    "resolve_conversion_adapter",
    "build_conversion_source",
]


def resolve_conversion_adapter(source_format: Optional[str], raw: str) -> ImportSource:
    """Resolve the :class:`ImportSource` that can rebuild a catalog item's canonical model.

    A revision persists the *canonical format* (``model.format``, e.g. ``protobuf`` / ``asyncapi-3``),
    which does not always equal the adapter's registry ``key`` (``grpc`` / ``asyncapi``). Resolution
    therefore tries, in order:

    1. the format as a registry key (``get_import_source(source_format)`` — matches ``graphql``,
       ``openapi``, …);
    2. any registered adapter whose advertised ``formats`` include ``source_format`` (matches
       ``protobuf`` → ``grpc``, ``asyncapi-3`` → ``asyncapi``);
    3. content sniffing over the raw source (:func:`detect_import_source`) as a last resort, so a
       revision that never recorded a usable ``source_format`` can still be converted.

    Args:
        source_format: The revision's recorded source format, if any.
        raw: The captured raw source text (used only for the sniffing fallback).

    Returns:
        A ready import-source adapter instance.

    Raises:
        ConversionError: When no adapter can be resolved (HTTP 400 — an unconvertible source).
    """
    load_builtin_import_sources()

    fmt = (source_format or "").strip()
    if fmt:
        adapter = get_import_source(fmt)
        if adapter is not None:
            return adapter
        for key in available_import_sources():
            candidate = get_import_source(key)
            if candidate is not None and fmt in candidate.formats:
                return candidate

    detected = detect_import_source(DetectionInput(text=raw))
    if detected is not None:
        return detected[0]

    hint = f" {source_format!r}" if source_format else ""
    raise ConversionError(
        f"No import source adapter can convert this catalog item's{hint} source format.",
        status_code=400,
    )


def build_conversion_source(
    item: Dict[str, Any],
    *,
    source_version_id: Optional[str] = None,
    analysis: Optional[PayloadAnalysisDocument] = None,
) -> ConversionSource:
    """Rebuild a :class:`ConversionSource` from a stored catalog item row.

    Extracts the item's captured raw source (:func:`resolve_source_payload`), resolves the source's
    adapter (:func:`resolve_conversion_adapter`), parses + normalizes it back into a
    :class:`~app.canonical_model.CanonicalApi`, and bundles it with the provenance coordinates the
    converted Project must link back to (source project/revision id, format/protocol, tool versions).

    Args:
        item: The catalog item row from :meth:`app.database.Database.get_catalog_item_by_id` — it must
            carry ``id`` and, to be convertible, a captured source in ``format_metadata`` and a
            ``source_format``.
        source_version_id: The source revision (``versions.id``) being converted, recorded on the
            provenance so a later re-import diffs cleanly; ``None`` when it cannot be resolved.
        analysis: The revision's payload analysis (CPDO-1.1/1.2), when the caller loaded one. Carried
            through so the projection manifest (CPDO-1.3) can say what the analyzer *could not*
            describe; ``None`` yields a manifest that declares the analysis unavailable rather than
            one that silently omits the question.

    Returns:
        A :class:`ConversionSource` ready for :func:`app.conversion_job.preview_conversion` /
        :func:`app.conversion_job.run_conversion`.

    Raises:
        ConversionError: When the item has no captured raw source (HTTP 422 — nothing to convert), no
            resolvable adapter (HTTP 400), or its source cannot be parsed/normalized (HTTP 422).
    """
    payload = resolve_source_payload(item)
    if payload is None or payload.get("mode") != "content":
        raise ConversionError(
            "This catalog item has no captured source material to convert; re-import it with its "
            "source document to enable conversion.",
            status_code=422,
        )

    raw = payload["content"]
    source_label = payload.get("filename")
    source_format = item.get("source_format")

    adapter = resolve_conversion_adapter(source_format, raw)
    try:
        native_ast = adapter.parse(raw, source_label=source_label)
        api = adapter.normalize(native_ast)
    except ImportSourceError as exc:
        raise ConversionError(
            f"Could not reconstruct the canonical model for conversion: {exc}",
            status_code=422,
        ) from exc

    return ConversionSource(
        api=api,
        source_project_id=str(item["id"]),
        source_version_id=source_version_id,
        source_format=source_format or api.format,
        source_protocol=item.get("protocol") or api.protocol,
        source_version_label=api.version,
        source_tool_versions=item.get("tool_versions") or {},
        source_text=raw,
        analysis=analysis,
    )
