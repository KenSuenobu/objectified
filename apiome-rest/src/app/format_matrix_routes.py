"""Format matrix — REST contract (FMT-1.5, #5416).

``GET /v1/formats/matrix`` publishes the one authoritative, machine-readable answer to *"what
formats do you support, in which directions, at which versions?"*.

Before this endpoint the answer had to be reassembled from three registries in Python, so sales
material, the documentation, the portal and every partner integration each re-derived it — and each
derivation could be wrong on its own schedule. The matrix ends that: one row per registered format,
carrying the import half (input kinds, live discovery, remote ``$ref`` support, Project-vs-catalog
routing), the export half (target key, output format, multi-file, and the emitter's capability
profile), the declared version coverage, the file extensions, the toolchain gate, and the
capability registry's boundary summary.

The payload is built by :func:`app.format_matrix.build_format_matrix`, which is also what the
generated ``docs/guide/supported-formats.md`` page renders — so the page and this endpoint cannot
disagree, and ``apiome formats`` renders this response verbatim rather than deriving a fourth view.

Like the other registry endpoints (``/v1/import/sources``, ``/v1/import/format-capabilities``) this
is **non-tenant reference data**: authenticated, because the whole API is, but unscoped. It uses the
session-credentials dependency rather than the tenant-scoped one precisely because there is no
``{tenant_slug}`` path segment — the tenant-scoped dependency would make ``tenant_slug`` a required
*query* parameter the caller never sends and 422 every real call.

The response is deterministic for a given deployment, so a caller may cache it by ``version``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from .auth import validate_session_credentials
from .canonical_model import ApiParadigm
from .format_matrix import DirectionFilter, FormatMatrixResponse, build_format_matrix

router = APIRouter(prefix="/v1/formats", tags=["formats"])


@router.get(
    "/matrix",
    response_model=FormatMatrixResponse,
    summary="Get the format support matrix",
    description=(
        "Return one row per format Apiome reads or writes (FMT-1.5) — the single machine-readable "
        "answer to \"what do you support?\". Each row carries the registry key, label and "
        "paradigm; the import half (accepted input kinds, live-discovery capability, remote "
        "``$ref`` support, and whether an import mints a publishable Project or a catalog item); "
        "the export half (the emitter's target key, output format, multi-file flag and capability "
        "profile); the declared version coverage (every format key the adapter emits, so a "
        "specific version can be requested); the advisory file extensions; the external toolchain "
        "the format hard-requires and whether **this** deployment has it; and the source-format "
        "capability registry's boundary summary. "
        "Optional ``paradigm`` and ``direction`` filters narrow the result and are echoed back in "
        "``filters``, with ``counts`` computed over the rows actually returned, so a filtered "
        "table is never mistaken for the whole surface. "
        "This is the same payload the generated supported-formats documentation page is rendered "
        "from and the ``apiome formats`` command prints, so the three cannot disagree. It is "
        "static reference data — identical for every tenant — and safe to cache by ``version``."
    ),
)
async def get_format_matrix(
    paradigm: Optional[ApiParadigm] = Query(
        default=None,
        description="Return only formats in this paradigm (``rest``, ``rpc``, ``event``, "
        "``graph``, ``data_schema``, ``agent``). Omit for every paradigm.",
    ),
    direction: Optional[DirectionFilter] = Query(
        default=None,
        description="Return only formats with this capability: ``import`` for everything Apiome "
        "can read, ``export`` for everything it can write, ``both`` for the formats that "
        "round-trip. Omit for every direction.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> FormatMatrixResponse:
    """Return the format support matrix, optionally filtered.

    Args:
        paradigm: Restrict the rows to one canonical paradigm, or ``None`` for all of them.
        direction: Restrict the rows to one capability — readable, writable, or round-tripping —
            or ``None`` for all of them.
        auth_data: Authenticated session context. The matrix is tenant-independent, so the value
            is not read; the dependency is present because every endpoint on this API requires
            credentials.

    Returns:
        The :class:`~app.format_matrix.FormatMatrixResponse` for the requested slice.
    """
    _ = auth_data
    return build_format_matrix(paradigm=paradigm, direction=direction)
