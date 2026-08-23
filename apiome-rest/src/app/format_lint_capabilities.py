"""Per-format lint capability / coverage matrix (CLX-2.4, #4854).

Publishes whether each catalog/source format has **native** rule-pack coverage,
**adapted** external-linter coverage, or an explicit **unsupported** state.
Live state is derived from the rule-pack and external-adapter registries so the
matrix cannot drift from what is registered. Planned format packs that are not
yet implemented are linked to their existing MFI issues — this module does not
duplicate parser/normalizer work.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .example_conformance import family_for_format
from .external_linter_adapter import (
    adapters_for_format,
    available_adapters,
    load_builtin_adapters,
)
from .format_detection import SNIFFED_FORMATS
from .import_routing import PUBLISHABLE_FORMATS
from .import_source import describe_import_sources, load_builtin_import_sources
from .lint_engine import available_lint_formats, load_format_rule_packs
from .lint_evidence import NATIVE_SCANNER_ID

__all__ = [
    "MODE_NATIVE",
    "MODE_ADAPTED",
    "MODE_UNSUPPORTED",
    "FormatLintCapability",
    "RELATED_FORMAT_LINT_ISSUES",
    "build_format_lint_capabilities",
    "capability_for_format",
    "expected_scanners_for_catalog_format",
    "normalize_format_key",
    "GRAPHQL_ESLINT_SCANNER_ID",
]

MODE_NATIVE = "native"
MODE_ADAPTED = "adapted"
MODE_UNSUPPORTED = "unsupported"

#: GraphQL ESLint evidence scanner id (CLX-2.4). Declared here so expected-scanner
#: wiring does not import the adapter module (avoids load cycles).
GRAPHQL_ESLINT_SCANNER_ID = "graphql.eslint"

#: GitHub issues for planned native lint packs (CLX-2.4). Do not invent new
#: parser/normalizer tickets — link the existing MFI issues.
RELATED_FORMAT_LINT_ISSUES: Dict[str, Tuple[str, ...]] = {
    "smithy": ("https://github.com/apiome/apiome/issues/3810",),
    "raml": ("https://github.com/apiome/apiome/issues/3801",),
    "typespec": ("https://github.com/apiome/apiome/issues/3796",),
    "avro": ("https://github.com/apiome/apiome/issues/3786",),
    "odata": ("https://github.com/apiome/apiome/issues/3779",),
    "api-blueprint": ("https://github.com/apiome/apiome/issues/3806",),
    "apiblueprint": ("https://github.com/apiome/apiome/issues/3806",),
    "apib": ("https://github.com/apiome/apiome/issues/3806",),
    "wsdl": ("https://github.com/apiome/apiome/issues/3791",),
    "soap": ("https://github.com/apiome/apiome/issues/3791",),
}

#: Formats that always receive native OpenAPI ``schema_lint`` (not a RulePack key).
_OPENAPI_NATIVE_FORMATS = frozenset(PUBLISHABLE_FORMATS) | frozenset({"openapi"})

#: Adapter format tokens that should also match these catalog/source keys.
_ADAPTER_FORMAT_ALIASES: Dict[str, Tuple[str, ...]] = {
    "openapi": tuple(sorted(PUBLISHABLE_FORMATS)),
    "asyncapi": ("asyncapi-2", "asyncapi-3"),
}


@dataclass(frozen=True)
class FormatLintCapability:
    """One row of the published format capability matrix.

    Attributes:
        format: Canonical format key used in catalog / detection.
        mode: ``native``, ``adapted``, or ``unsupported``.
        importable: Whether an import-source adapter can ingest this format today.
        native_pack: Registered rule-pack format key, or ``openapi-schema-lint`` /
            ``common`` when that is the only native coverage.
        adapted_scanners: External adapter scanner ids that cover this format.
        common_pack_only: True when only the cross-format common pack runs (no
            format-specific native pack).
        related_issues: Linked GitHub issues for planned pack work (never duplicate).
        notes: Short human rationale for the classification.
        example_conformance: Per-format mode of the IXH-5.4 example-conformance rule —
            ``native`` when this format's example locations are walked and every example is
            validated against its schema, ``unsupported`` when the format has no example syntax
            the walker covers. The rule itself always runs; this says whether it can see
            anything in this format.
        example_locations: The exact locations walked for this format, so coverage is visible
            (and reviewable) per format rather than implied. Empty when
            ``example_conformance`` is ``unsupported``.
    """

    format: str
    mode: str
    importable: bool
    native_pack: Optional[str] = None
    adapted_scanners: Tuple[str, ...] = ()
    common_pack_only: bool = False
    related_issues: Tuple[str, ...] = ()
    notes: str = ""
    example_conformance: str = MODE_UNSUPPORTED
    example_locations: Tuple[str, ...] = ()


def normalize_format_key(format_key: Optional[str]) -> str:
    """Normalize a source/catalog format string for matrix lookup."""
    key = (format_key or "").strip().lower()
    if key in ("api-blueprint", "apib", "blueprint"):
        return "apiblueprint"
    if key in ("tsp", "cadl"):
        return "typespec"
    if key in ("avsc", "avdl", "avro-idl"):
        # FMT-3.5 gave the Avro adapter a surface-scoped detection key (``avro-idl``).
        # Lint capability is stated per *format*, not per surface, so it folds onto the
        # family key rather than adding a row nothing declares rules for.
        return "avro"
    if key in ("edmx",) or key.startswith("odata-"):
        # FMT-3.4 gave the OData adapter version-scoped detection keys (``odata-v2`` /
        # ``odata-v3``). Lint capability is stated per *format*, not per version, so they
        # fold onto the family key rather than adding rows nothing declares rules for.
        return "odata"
    if key in ("soap",) or key.startswith("wsdl-"):
        # FMT-3.3 gave the WSDL adapter a version-scoped detection key (``wsdl-2.0``).
        # Lint capability is stated per *format*, not per grammar, so it folds onto the
        # family key rather than adding a row nothing declares rules for.
        return "wsdl"
    if key in ("grpc",) or key.startswith("protobuf-"):
        # FMT-3.7 gave the gRPC adapter a version-scoped detection key
        # (``protobuf-editions``). Lint capability is stated per *format*, not per dialect, so
        # it folds onto the family key rather than adding a row nothing declares rules for.
        return "protobuf"
    if key == "postman-2.0":
        # FMT-3.6 gave the Postman adapter a version-scoped detection key. Lint
        # capability is stated per *format*, not per collection minor, so it folds
        # onto the family key rather than adding a row nothing declares rules for.
        return "postman"
    if key == "swagger-1.2":
        # FMT-3.6 reads Swagger 1.2 by projecting it onto the Swagger 2.0 canonical
        # path, so the rules that apply to it are exactly the 2.0 rules.
        return "swagger-2.0"
    if key.startswith("openapi") or key.startswith("swagger"):
        return key if key in PUBLISHABLE_FORMATS else (
            key if key == "openapi" else key
        )
    return key


def _importable_format_map() -> Dict[str, bool]:
    """Map every advertised import format token → importable True."""
    load_builtin_import_sources()
    out: Dict[str, bool] = {}
    for desc in describe_import_sources():
        for fmt in desc.formats:
            out[normalize_format_key(fmt)] = True
            out[fmt] = True
    return out


def _matrix_format_keys(importable: Dict[str, bool]) -> List[str]:
    """Sorted unique format keys that belong in the matrix."""
    keys = set(SNIFFED_FORMATS)
    keys.update(importable)
    keys.update(available_lint_formats())
    keys.update(PUBLISHABLE_FORMATS)
    keys.add("openapi")
    keys.add("protobuf")
    # Prefer normalized keys; drop noisy aliases that map elsewhere.
    normalized = {normalize_format_key(k) for k in keys}
    # Keep openapi family distinct.
    normalized.update(PUBLISHABLE_FORMATS)
    return sorted(normalized)


def _adapters_covering(format_key: str) -> List[str]:
    """Scanner ids of adapters that declare coverage for ``format_key``."""
    load_builtin_adapters()
    scanners: List[str] = []
    seen = set()
    candidates = {format_key, normalize_format_key(format_key)}
    # Reverse-alias: catalog openapi-3.1 → adapter token "openapi".
    if format_key in PUBLISHABLE_FORMATS or format_key == "openapi":
        candidates.add("openapi")
    if format_key in ("asyncapi-2", "asyncapi-3", "asyncapi"):
        candidates.add("asyncapi")
    if format_key == "protobuf":
        candidates.add("protobuf")
    if format_key == "graphql":
        candidates.add("graphql")
    for token in sorted(candidates):
        for cls in adapters_for_format(token):
            scanner = cls.scanner_id or cls.adapter_id
            if scanner not in seen:
                seen.add(scanner)
                scanners.append(scanner)
    return scanners


def _native_pack_for(format_key: str) -> Optional[str]:
    """Return the native pack identifier for ``format_key``, if any.

    A format has native coverage from a pack registered under its **format** key, from the
    OpenAPI spec linter, or — since FMT-5.5 — from a pack registered under a **paradigm**
    that covers it. The paradigm case is checked against the pack's own declared coverage
    rather than against the paradigm alone: the data-contract pack self-gates to nothing for
    the schema languages that share the ``data_schema`` paradigm, and a matrix that claimed
    native coverage for those would be exactly the drift this module exists to prevent.
    """
    # Imported inside the function for the same reason the rest of this module defers its
    # engine imports: the pack module pulls in the lint engine and the canonical model, and
    # this module is imported by the route layer at startup.
    from .data_contract_facts import CONTRACT_FORMATS
    from .data_contract_lint import DATA_CONTRACT_PACK_ID

    load_format_rule_packs()
    packs = set(available_lint_formats())
    key = normalize_format_key(format_key)
    if key in packs:
        return key
    if format_key in packs:
        return format_key
    if key in _OPENAPI_NATIVE_FORMATS or format_key in _OPENAPI_NATIVE_FORMATS:
        return "openapi-schema-lint"
    if key in CONTRACT_FORMATS or format_key in CONTRACT_FORMATS:
        return DATA_CONTRACT_PACK_ID
    return None


def capability_for_format(
    format_key: str,
    *,
    importable_map: Optional[Dict[str, bool]] = None,
) -> FormatLintCapability:
    """Classify lint coverage for one format key.

    Args:
        format_key: Catalog / detection format token.
        importable_map: Optional precomputed importable map (perf for bulk build).

    Returns:
        A :class:`FormatLintCapability` row.
    """
    imp = importable_map if importable_map is not None else _importable_format_map()
    key = normalize_format_key(format_key)
    # Prefer original openapi family keys over collapsing to "openapi".
    display = format_key if format_key in PUBLISHABLE_FORMATS else key

    native = _native_pack_for(display) or _native_pack_for(key)
    adapted = tuple(_adapters_covering(display) or _adapters_covering(key))
    related = RELATED_FORMAT_LINT_ISSUES.get(key) or RELATED_FORMAT_LINT_ISSUES.get(
        display, ()
    )
    is_importable = bool(
        imp.get(display) or imp.get(key) or display in PUBLISHABLE_FORMATS
    )

    if native:
        mode = MODE_NATIVE
        common_only = False
        notes = f"Native pack `{native}`"
        if adapted:
            notes += f"; adapted scanners: {', '.join(adapted)}"
    elif adapted:
        mode = MODE_ADAPTED
        common_only = is_importable
        notes = f"Adapted scanners only: {', '.join(adapted)}"
    else:
        mode = MODE_UNSUPPORTED
        common_only = is_importable
        if common_only:
            notes = (
                "Importable; common rule pack only — no format-specific native pack "
                "or external adapter"
            )
        else:
            notes = "No native pack or external adapter registered"
        if related:
            notes += "; see related issues for planned pack work"

    example_family = family_for_format(display) or family_for_format(key)
    return FormatLintCapability(
        format=display if display in PUBLISHABLE_FORMATS else key,
        mode=mode,
        importable=is_importable,
        native_pack=native,
        adapted_scanners=adapted,
        common_pack_only=common_only and mode != MODE_NATIVE,
        related_issues=tuple(related),
        notes=notes,
        example_conformance=MODE_NATIVE if example_family else MODE_UNSUPPORTED,
        example_locations=example_family.locations if example_family else (),
    )


def build_format_lint_capabilities() -> List[FormatLintCapability]:
    """Build the full deterministic format capability matrix.

    Returns:
        Sorted capability rows covering sniffed formats, importable sources,
        registered lint packs, and OpenAPI family keys.
    """
    load_builtin_import_sources()
    load_format_rule_packs()
    load_builtin_adapters()
    # Touch registry so adapter list is loaded (used by docs/tests).
    _ = available_adapters()
    importable = _importable_format_map()
    rows = [
        capability_for_format(fmt, importable_map=importable)
        for fmt in _matrix_format_keys(importable)
    ]
    # Deduplicate by displayed format key (normalize may collapse aliases).
    by_fmt: Dict[str, FormatLintCapability] = {}
    for row in rows:
        by_fmt[row.format] = row
    return [by_fmt[k] for k in sorted(by_fmt)]


def expected_scanners_for_catalog_format(source_format: Optional[str]) -> List[str]:
    """Return evidence scanner ids expected for a catalog revision of ``source_format``.

    Always includes the native catalog scanner. Adds adapted scanners declared for
    the format (Buf, GraphQL ESLint, Spectral, …) so an absent scan is visible as
    ``not_run`` rather than silently clean.

    Args:
        source_format: Revision ``source_format`` (may be None / unknown).

    Returns:
        Deterministic scanner id list.
    """
    scanners: List[str] = [NATIVE_SCANNER_ID]
    if not source_format:
        return scanners
    cap = capability_for_format(source_format)
    for scanner in cap.adapted_scanners:
        if scanner not in scanners:
            scanners.append(scanner)
    # Breaking / secondary OAS adapters are optional evidence; keep primary lint
    # adapters (mode lint/validate) — capability already lists registered ones.
    return scanners


def capability_dicts() -> List[Dict[str, object]]:
    """JSON-ready projection of :func:`build_format_lint_capabilities`."""
    out: List[Dict[str, object]] = []
    for row in build_format_lint_capabilities():
        out.append(
            {
                "format": row.format,
                "mode": row.mode,
                "importable": row.importable,
                "native_pack": row.native_pack,
                "adapted_scanners": list(row.adapted_scanners),
                "common_pack_only": row.common_pack_only,
                "related_issues": list(row.related_issues),
                "notes": row.notes,
                "example_conformance": row.example_conformance,
                "example_locations": list(row.example_locations),
            }
        )
    return out
