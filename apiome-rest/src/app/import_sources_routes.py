"""
Import-source enumeration & format detection — REST contract (MFI-1.3 / MFI-1.5).

Exposes the import-source registry (MFI-1.1) as a read-only list so the UI's
``ImportDialog`` can render its source cards from data instead of hard-coded JSX,
and the CLI (MFI-1.4) can list available formats. Each entry is the registry's
public :class:`~app.import_source.ImportSourceDescriptor` — key, label,
description, Lucide ``icon`` name, paradigm, accepted ``input_kinds``
(file/url/paste/discovery), live-discovery capability, and emitted ``formats``.

Adding an adapter server-side (a new ``ImportSource`` subclass with
``register=True``) makes it appear here automatically, so a new source card shows
up in the UI with no UI code change.

``POST /v1/import/detect`` (MFI-1.5) sniffs a document's format so the importer —
UI or CLI — can pre-select the right source and, when the input is ambiguous,
prompt the user instead of guessing.

``GET /v1/import/format-capabilities`` (CPDO-2.4) publishes the versioned
source-format capability & parsing-limit registry
(:mod:`app.format_capability_registry`) — for every registered format, what its
analyzer models, what it knowingly does not, how good its source pointers are,
what survives normalization, and whether it converts — plus the reviewed wording
for every way a detail can be absent. It is the same *kind* of registry list as
``/sources`` above (non-tenant registry metadata, authenticated but unscoped), and
it is what lets a catalog screen explain a missing construct honestly instead of
collapsing five different causes into "no details".
"""

from __future__ import annotations

import base64
import binascii
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .archive_intake import ArchiveIntakeError, detect_archive_format, is_archive_payload
from .auth import validate_session_credentials
from .format_capability_registry import (
    FormatCapability,
    FormatCapabilitySnapshot,
    capability_for,
    is_valid_format_key,
    registry_snapshot,
)
from .format_detection import FormatCandidate, FormatDetection, detect_format
from .import_source import (
    DetectionInput,
    ImportSourceDescriptor,
    describe_import_sources,
)

router = APIRouter(prefix="/v1/import", tags=["import-sources"])


class ImportSourceListResponse(BaseModel):
    """The list of registered import sources, for source-card / CLI enumeration."""

    sources: List[ImportSourceDescriptor] = Field(
        default_factory=list,
        description="Every registered adapter's descriptor, sorted by key.",
    )


@router.get(
    "/sources",
    response_model=ImportSourceListResponse,
    summary="List import sources",
    description=(
        "Enumerate every registered import-source adapter (MFI-1.1 registry). "
        "Drives the ImportDialog source cards (MFI-1.3) and the CLI format list "
        "(MFI-1.4): each descriptor carries the Lucide icon, label, description, "
        "and the input kinds (file/url/paste/discovery) its card/verb should use."
    ),
)
async def list_import_sources(
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> ImportSourceListResponse:
    # The source list is non-tenant registry metadata: authentication is required
    # (consistent with the rest of the API) but no per-tenant scoping applies. This
    # uses the session-credentials dependency rather than validate_authentication
    # precisely because there is no ``{tenant_slug}`` path segment here — the
    # tenant-scoped dependency would otherwise make ``tenant_slug`` a *required query
    # parameter* the caller never sends, rejecting every real call with 422.
    _ = auth_data
    return ImportSourceListResponse(sources=describe_import_sources())


@router.get(
    "/format-capabilities",
    response_model=FormatCapabilitySnapshot,
    summary="Get the source-format capability & parsing-limit registry",
    description=(
        "Return the versioned source-format capability registry (CPDO-2.4): one entry per "
        "registered import source — the native hierarchy its analyzer models, the quality of "
        "the source locations it can point at, the value visibility it can ever carry, the "
        "grammar it knowingly does not read, how much survives the projection onto the "
        "canonical model, and whether the format converts — each stamped with the analyzer key, "
        "analyzer version and underlying tool versions that back the claim. The snapshot also "
        "carries the reviewed explanation for every way a detail can be absent, and the map from "
        "a stored payload-analysis reason code onto those categories. Exactly one category means "
        "the source material is missing; a parser limit, a capability boundary, an analyzer "
        "failure and a redaction each mean something else. This is static reference data — the "
        "same for every tenant and every item — so the UI can fetch it once and cache it by "
        "``version``."
    ),
)
async def get_format_capability_registry(
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> FormatCapabilitySnapshot:
    """Return the versioned source-format capability & parsing-limit registry snapshot.

    Deterministic and format-independent — it describes the *formats*, not any particular
    import — so it is safe to cache by :attr:`FormatCapabilitySnapshot.version`. Uses the
    session-credentials dependency for the same reason as :func:`list_import_sources`: with no
    ``{tenant_slug}`` path segment, the tenant-scoped dependency would make ``tenant_slug`` a
    required query parameter and 422 every real call.

    Args:
        auth_data: Authenticated session context (the snapshot content is tenant-independent).

    Returns:
        The full :class:`~app.format_capability_registry.FormatCapabilitySnapshot`.
    """
    _ = auth_data
    return registry_snapshot()


@router.get(
    "/format-capabilities/{format_key}",
    response_model=FormatCapability,
    summary="Get one source format's capability entry",
    description=(
        "Return the capability & parsing-limit entry for a single source format (CPDO-2.4). "
        "**Always resolves**: a reviewed format returns its reviewed entry, any other registered "
        "adapter returns one derived from the adapter itself, and a key no adapter is registered "
        "under returns an ``unknown_format`` entry that claims nothing about the format. That "
        "last case is deliberate — a catalog item can name an adapter that was later retired, "
        "and a 404 there would leave the UI with exactly the \"no details\" dead end this "
        "registry exists to remove. A key that could never have been registered (wrong "
        "character class, or over 64 characters) is a 422 rather than an echo."
    ),
)
async def get_format_capability(
    format_key: str,
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> FormatCapability:
    """Return one format's capability entry, resolving any registered or retired key.

    Args:
        format_key: The import-source key (aliases such as ``protobuf`` → ``grpc`` resolve).
        auth_data: Authenticated session context (the entry is tenant-independent).

    Returns:
        The format's :class:`~app.format_capability_registry.FormatCapability`.

    Raises:
        HTTPException: 422 when ``format_key`` is not shaped like a format key at all — the
            value is rejected at the boundary rather than echoed back inside an entry.
    """
    _ = auth_data
    normalized = format_key.strip().lower()
    if not is_valid_format_key(normalized):
        raise HTTPException(
            status_code=422,
            detail=(
                "format_key must be 1–64 characters of lowercase letters, digits, '.', '_' or "
                "'-', starting with a letter or digit."
            ),
        )
    return capability_for(normalized)


class DetectFormatRequest(BaseModel):
    """A document (plus optional hints) to auto-detect the format of."""

    text: Optional[str] = Field(
        default=None,
        description="Raw document text to sniff (the primary signal).",
    )
    filename: Optional[str] = Field(
        default=None, description="Optional filename hint (extension-based signals)."
    )
    content_type: Optional[str] = Field(
        default=None, description="Optional MIME type hint."
    )
    url: Optional[str] = Field(default=None, description="Optional source URL hint.")
    document_base64: Optional[str] = Field(
        default=None,
        description=(
            "Standard base64 of an uploaded archive (.zip / .tar.gz) for multi-file intake "
            "(MFI-29.1). When present and the payload is an archive, the root document is "
            "auto-detected (or chosen via ``archive_root``)."
        ),
    )
    archive_root: Optional[str] = Field(
        default=None,
        description="Explicit module-relative root path inside an uploaded archive.",
    )


class FormatCandidateModel(BaseModel):
    """One ranked format guess (mirrors :class:`app.format_detection.FormatCandidate`)."""

    format: str = Field(description="Detected format key (e.g. asyncapi-2, graphql).")
    confidence: float = Field(description="0.0–1.0 certainty from the matching detector.")
    reason: Optional[str] = Field(default=None, description="Short marker justification.")
    source_key: Optional[str] = Field(
        default=None, description="Registry key of the importable adapter, or null for sniffer-only."
    )
    importable: bool = Field(
        description="Whether a registered adapter can import this format today."
    )

    @classmethod
    def from_candidate(cls, candidate: FormatCandidate) -> "FormatCandidateModel":
        """Adapt a detection candidate into its serializable response shape."""
        return cls(
            format=candidate.format,
            confidence=candidate.confidence,
            reason=candidate.reason,
            source_key=candidate.source_key,
            importable=candidate.importable,
        )


class DetectFormatResponse(BaseModel):
    """The auto-detection verdict for a document."""

    matched: bool = Field(description="Whether any detector recognized the document.")
    detected: Optional[FormatCandidateModel] = Field(
        default=None, description="The best candidate, or null when nothing matched."
    )
    ambiguous: bool = Field(
        description="True when leading formats tie within the ambiguity margin (prompt the user)."
    )
    candidates: List[FormatCandidateModel] = Field(
        default_factory=list, description="All distinct-format candidates, ranked."
    )
    ambiguous_candidates: List[FormatCandidateModel] = Field(
        default_factory=list,
        description="The close cluster to choose between when ambiguous; empty otherwise.",
    )
    archive_root: Optional[str] = Field(
        default=None,
        description="When the request carried an archive, the chosen root member path.",
    )
    archive_members: List[str] = Field(
        default_factory=list,
        description="Sorted member paths when an archive was unpacked for detection.",
    )

    @classmethod
    def from_detection(cls, detection: FormatDetection) -> "DetectFormatResponse":
        """Adapt a :class:`FormatDetection` into the REST response shape."""
        return cls(
            matched=detection.matched,
            detected=(
                FormatCandidateModel.from_candidate(detection.detected)
                if detection.detected is not None
                else None
            ),
            ambiguous=detection.ambiguous,
            candidates=[FormatCandidateModel.from_candidate(c) for c in detection.candidates],
            ambiguous_candidates=[
                FormatCandidateModel.from_candidate(c) for c in detection.ambiguous_candidates
            ],
        )


@router.post(
    "/detect",
    response_model=DetectFormatResponse,
    summary="Auto-detect a document's import format",
    description=(
        "Sniff a document's format (MFI-1.5) by polling every registered adapter "
        "and the built-in format sniffers; the highest-confidence match wins. "
        "Recognized-but-not-yet-importable formats (RAML, AsyncAPI, GraphQL, …) "
        "are reported with ``importable: false`` so the importer can name the "
        "format. When two formats tie within the ambiguity margin, ``ambiguous`` "
        "is true and ``ambiguous_candidates`` lists the choices to prompt for."
    ),
)
async def detect_import_format(
    body: DetectFormatRequest,
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> DetectFormatResponse:
    # Detection is pure registry/sniffer metadata over the supplied document; auth is
    # required (consistent with the API) but no per-tenant scoping applies. Uses the
    # session-credentials dependency for the same reason as ``/sources`` above: with no
    # ``{tenant_slug}`` path segment, the tenant-scoped dependency would make
    # ``tenant_slug`` a required query parameter and 422 every real call.
    _ = auth_data

    if body.document_base64:
        try:
            raw = base64.standard_b64decode(body.document_base64)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"document_base64 is not valid base64: {exc}",
            ) from exc
        if is_archive_payload(raw, body.filename):
            try:
                unpacked = detect_archive_format(
                    raw,
                    filename=body.filename,
                    root_path=body.archive_root,
                )
            except ArchiveIntakeError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            base = DetectFormatResponse.from_detection(unpacked.detection)
            return base.model_copy(
                update={
                    "archive_root": unpacked.root_path,
                    "archive_members": sorted(unpacked.members.keys()),
                }
            )

    detection = detect_format(
        DetectionInput(
            text=body.text,
            filename=body.filename,
            content_type=body.content_type,
            url=body.url,
        )
    )
    return DetectFormatResponse.from_detection(detection)
