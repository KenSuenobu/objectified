"""Import preview manifest — IXH-3.1 (#5103).

The IXH-2.1 pre-flight answers "is this worth importing?" — grade, findings, policy
verdict. What it does **not** answer is *what the import would create*: which services,
operations, types, and channels will exist, under what stable canonical keys, and what
the source carried that the canonical model could not hold. Before this module the only
pre-commit structure the UI had was ``extractFileMetadata`` — a client-side title/version
sniff.

This module extends the pre-flight into a full **import preview manifest**:

* the canonical **entity tree** (services → operations, plus types and channels), every
  entity carrying its stable canonical key and — where the parser captured one — a
  source location;
* per-entity **provenance** back to the source construct (native name / native id /
  source location, read from the same extras keys the export manifest reads);
* a **coverage ledger** classifying source constructs as ``mapped``,
  ``partially-mapped``, ``inferred``, ``unsupported-by-canonical-model``, or
  ``not-parsed-by-adapter`` — unsupported vs not-parsed are *never* conflated: "the
  canonical model cannot hold this" and "our parser does not yet read this" are
  different facts with different owners, and each ``not-parsed-by-adapter`` entry
  names its CLX-2.4 capability-registry reference; ``inferred`` marks constructs
  synthesized from observations (request files / traffic), never presented as declared;
* the **adapter capability reference** (descriptor + the CLX-2.4 per-format capability
  entry + the adapter's declared parser limits); and
* the **routing decision**, carried on the embedded pre-flight report.

**One vocabulary, two directions (CPDO-1.3 / #4800).** The graph reuses the export
projection manifest's node/edge contract verbatim — the same
:class:`~app.export_projection.ProjectionNode` / :class:`~app.export_projection.ProjectionEdge`
models, the same :class:`~app.export_projection.ProjectionNodeKind` /
:class:`~app.export_projection.ProjectionEdgeRelation` enums, and the same
:class:`~app.projection_taxonomy.ProjectionStatus` /
:class:`~app.projection_taxonomy.ProjectionReason` taxonomy — rather than a second
lookalike shape. The lanes read in the import direction: the *source document* is the
origin and the *canonical model* is the destination, so an outcome (``projects``) edge
runs **native → canonical** (where the export manifest's runs canonical → target), and a
dropped source construct has ``target = None`` exactly as a dropped export construct
does. ``derives`` edges carry provenance for mapped entities, mirroring the export
build. A shared contract test asserts the two surfaces agree on every enum, model, id
scheme, and cursor format.

**Coverage classes ↔ shared statuses.** The ledger classes are a documented, bijective
view over the shared taxonomy — they add no second status vocabulary:

========================================  =============  ==========================
Coverage class                            Status         Reason
========================================  =============  ==========================
``mapped``                                ``retained``   —
``partially-mapped``                      ``approximated``  ``destination_unsupported``
``inferred``                              ``synthesized`` ``source_incomplete``
``unsupported-by-canonical-model``        ``dropped``    ``destination_unsupported``
``not-parsed-by-adapter``                 ``dropped``    ``source_parse_limit``
========================================  =============  ==========================

In the import direction the "destination" is the **canonical model**, so
``destination_unsupported`` truthfully means "the canonical fields cannot hold this"
(the attributes ride in the untyped ``extras`` escape hatch), while
``source_parse_limit`` means "apiome's parser does not read this yet" — the same
never-blame-the-wrong-party rule the export taxonomy enforces.

**What populates the ledger.** Only evidence the pipeline actually has:

* every canonical entity → ``mapped`` when its canonical fields hold everything the
  normalizer recovered, ``partially-mapped`` when source attributes ride only in its
  ``extras`` bag (named in the entry's detail);
* document-level ``extras`` on the model root → ``unsupported-by-canonical-model``
  (the source carried document-level constructs no canonical field models);
* the adapter's **declared parser limits** (:data:`KNOWN_PARSER_LIMITS`) →
  ``not-parsed-by-adapter``. These are adapter-level declarations, not per-document
  detections, so each entry is marked ``document_scoped = false`` — the ledger states
  "this adapter does not read X yet" without pretending to have checked whether *this*
  document uses X.

**Determinism.** :func:`build_import_preview_manifest` is pure — no I/O, no clock. The
entity order is the model's declaration order (itself deterministic for a fixed input),
nodes/edges sort exactly as the export manifest sorts them, and the manifest hash folds
the adapter key, adapter/apiome version provenance, and the request options into a
digest over the full graph — so a fixed (input, adapter version, options) triple is
byte-stable, and an adapter upgrade is a different snapshot.

**Bounded output.** The entity tree, graph, and ledger are cursor-paginated over the
entity list (the cursor codec is shared with the export evidence pages). Truncation is
*stated*: ``truncated`` is true whenever a page omits rows, and every ``total_*`` field
reports the full-manifest count, never the page's.

**Re-import delta (IXH-3.4, #5106).** When the wizard's commit would land in an
*existing* catalog item — the commit resolves its target by slug
(:func:`app.import_source_pipeline._resolve_import_project`), so the request carries the
same client-computed ``project_slug`` — the response also carries an
:class:`ImportReimportDelta`: :func:`app.import_source.canonical_diff` between the
current revision's canonical model (re-parsed from its stored source, exactly as the
convert flow does) and the candidate, grouped by entity family, with breaking-change
annotation joined from :func:`app.breaking_change.classify_models` where a classifier
grades the format. An identical re-import is an explicit **no-op** (matching
fingerprints, empty diff) so the client can offer to skip the commit; a first-time
import (no existing item under the slug) has ``reimport = null``. The delta is computed
**per request, never cached** — the current revision can move between requests — from
canonical models, never raw text.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
from collections import OrderedDict
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .breaking_change import classify_models, get_breaking_change_classifier
from .canonical_model import CanonicalApi
from .arrow_normalizer import ARROW_EXTRAS_KEY
from .cddl_normalizer import CDDL_EXTRAS_KEY
from .dtd_normalizer import DTD_EXTRAS_KEY
from .export_projection import (
    NATIVE_ID_EXTRA_KEYS,
    SOURCE_LOCATION_EXTRA_KEYS,
    NativeEvidence,
    ProjectionEdge,
    ProjectionEdgeRelation,
    ProjectionNode,
    ProjectionNodeKind,
    decode_page_cursor,
    encode_page_cursor,
    first_extra,
)
from .format_lint_capabilities import FormatLintCapability, capability_for_format
from .import_preflight import run_import_preflight
from .import_source import (
    DiffChangeKind,
    canonical_diff,
    canonical_fingerprint,
    get_import_source,
    load_builtin_import_sources,
)
from .import_source_pipeline import ImportRunArtifacts, _normalize_import_project_slug
from .models import ImportPreflightCounts, ImportPreflightReport, ImportPreflightRequest
from .projection_taxonomy import ProjectionReason, ProjectionStatus
from .proto_editions import (
    EDITIONS_PROVENANCE_EXTRA_KEY as PROTO_EDITIONS_EXTRA_KEY,
)
from .relaxng_normalizer import RELAXNG_EXTRAS_KEY

logger = logging.getLogger(__name__)

__all__ = [
    "CoverageClass",
    "STATUS_FOR_COVERAGE",
    "coverage_for_outcome",
    "ParserLimit",
    "KNOWN_PARSER_LIMITS",
    "CapabilityReference",
    "ImportAdapterReference",
    "CoverageEntry",
    "ImportPreviewEntity",
    "ImportPreviewManifest",
    "ImportPreviewManifestRequest",
    "ImportPreviewManifestResponse",
    "ReimportDeltaEntry",
    "ImportReimportDelta",
    "build_reimport_delta",
    "build_import_preview_manifest",
    "paginate_import_preview_manifest",
    "run_import_preview_manifest",
    "clear_preview_manifest_cache",
    "preview_manifest_cache_size",
    "DEFAULT_ENTITY_PAGE_SIZE",
    "MAX_ENTITY_PAGE_SIZE",
    "PREVIEW_MANIFEST_CACHE_MAX_ENTRIES",
    "PROVENANCE_EXTRA_KEYS",
]

#: The apiome-rest package version stamped into every manifest's provenance and hash.
APIOME_VERSION = __version__

#: Default and hard-cap entity page sizes for :func:`paginate_import_preview_manifest`.
DEFAULT_ENTITY_PAGE_SIZE = 200
MAX_ENTITY_PAGE_SIZE = 1000

#: Upper bound on cached full manifests held per process (they can be large, so the
#: bound is tighter than the pre-flight report cache's).
PREVIEW_MANIFEST_CACHE_MAX_ENTRIES = 32

#: Extras keys that carry *provenance* (source location / native id / inference
#: bookkeeping) rather than source semantics. An entity whose extras hold only these
#: keys is fully ``mapped`` (or ``inferred`` when ``provenance == "inferred"``) — the
#: bag is our own bookkeeping, not an unmodeled source attribute.
PROVENANCE_EXTRA_KEYS = frozenset(SOURCE_LOCATION_EXTRA_KEYS) | frozenset(NATIVE_ID_EXTRA_KEYS) | frozenset(
    {
        "provenance",
        "sample_count",
        "sample_counts",
        "inference_evidence",
        "source_label",
        "source_file",
        "source_files",
        "path_inferences",
        "inferred_auth_schemes",
        "samples",
        "http_status",
        "body_schema",
        "http_file_variables",
        "overlay",
        "gateway",
        "wit",
        # FMT-4.1: the RELAX NG projection record (root type, declared limits, composition
        # hrefs). It is our own bookkeeping about the read, not a construct the grammar names.
        RELAXNG_EXTRAS_KEY,
        # FMT-4.2: the DTD projection record (root type, declared limits, the entity and
        # notation declarations, the modules composed in). Our own bookkeeping about the
        # read — the DTD's own constructs are the elements and attributes it declares.
        DTD_EXTRAS_KEY,
        # FMT-4.4: the CDDL projection record (root rule, declared limits, the sockets,
        # generics and group rules composition resolved). Our own bookkeeping about the
        # read — the grammar's own constructs are the rules it declares.
        CDDL_EXTRAS_KEY,
        # FMT-4.5: the Arrow projection record (root type, declared limits, the schema
        # metadata carried through, the Flight envelope). Our own bookkeeping about the
        # read — the schema's own constructs are the fields it declares.
        ARROW_EXTRAS_KEY,
        # FMT-3.6: derived version/provenance labels, not source constructs — the
        # source's own `info.schema` is still reported (as `postman_schema_url`).
        "swagger_1_2",
        "postman_collection_version",
        # FMT-3.7: the resolved Protobuf Editions record (per-file edition, syntax and feature
        # set). It is our own resolution of the document, not a construct the document names.
        # Spelled by its owning module rather than repeated as a literal.
        PROTO_EDITIONS_EXTRA_KEY,
    }
)


# ===========================================================================
# Coverage vocabulary (a view over the shared CPDO-1.3 taxonomy)
# ===========================================================================


class CoverageClass(str, Enum):
    """Coverage classification of one source construct in the import (IXH-3.1).

    The values are the ticket's exact vocabulary. Each class is a documented view over
    the shared :class:`~app.projection_taxonomy.ProjectionStatus` /
    :class:`~app.projection_taxonomy.ProjectionReason` pair (see
    :data:`STATUS_FOR_COVERAGE`) — never a parallel status vocabulary.
    """

    MAPPED = "mapped"
    PARTIALLY_MAPPED = "partially-mapped"
    INFERRED = "inferred"
    UNSUPPORTED_BY_CANONICAL_MODEL = "unsupported-by-canonical-model"
    NOT_PARSED_BY_ADAPTER = "not-parsed-by-adapter"


#: The bijection coverage class → (status, reason) in the shared taxonomy. In the import
#: direction the "destination" is the canonical model, so ``destination_unsupported``
#: means "canonical fields cannot hold this", while ``source_parse_limit`` means "our
#: parser does not read this yet" — the two are never conflated. ``inferred`` means the
#: construct was synthesized from observations (traffic / request files), not declared.
STATUS_FOR_COVERAGE: Dict[CoverageClass, Tuple[ProjectionStatus, Optional[ProjectionReason]]] = {
    CoverageClass.MAPPED: (ProjectionStatus.RETAINED, None),
    CoverageClass.PARTIALLY_MAPPED: (
        ProjectionStatus.APPROXIMATED,
        ProjectionReason.DESTINATION_UNSUPPORTED,
    ),
    CoverageClass.INFERRED: (
        ProjectionStatus.SYNTHESIZED,
        ProjectionReason.SOURCE_INCOMPLETE,
    ),
    CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL: (
        ProjectionStatus.DROPPED,
        ProjectionReason.DESTINATION_UNSUPPORTED,
    ),
    CoverageClass.NOT_PARSED_BY_ADAPTER: (
        ProjectionStatus.DROPPED,
        ProjectionReason.SOURCE_PARSE_LIMIT,
    ),
}


def coverage_for_outcome(
    status: ProjectionStatus, reason: Optional[ProjectionReason]
) -> Optional[CoverageClass]:
    """Invert :data:`STATUS_FOR_COVERAGE`: the coverage class for a (status, reason) pair.

    Args:
        status: The shared-taxonomy status of an outcome edge.
        reason: Its reason code, or ``None``.

    Returns:
        The coverage class the pair encodes, or ``None`` when the pair is not one the
        import manifest produces (the mapping is a bijection over exactly four pairs).
    """
    for coverage, (mapped_status, mapped_reason) in STATUS_FOR_COVERAGE.items():
        if mapped_status is status and mapped_reason is reason:
            return coverage
    return None


# ===========================================================================
# Adapter capability + parser-limit references (CLX-2.4)
# ===========================================================================


@dataclass(frozen=True)
class ParserLimit:
    """One declared "our parser does not yet read this" limit for an adapter.

    A *declaration*, not a per-document detection: it states a construct class the
    adapter's parser is known not to read today, so the coverage ledger can carry an
    honest ``not-parsed-by-adapter`` entry (``document_scoped = false``) instead of
    silently claiming full coverage.

    Attributes:
        construct: Short name of the source construct class the parser skips.
        detail: One-sentence human description of the limit.
    """

    construct: str
    detail: str


#: Declared parser limits per adapter registry key. Entries are additive and must state
#: only *documented* limits (the corpus manifest's recorded adapter bugs); remove an
#: entry in the same change that fixes its parser. An adapter with no entry simply
#: contributes no ``not-parsed-by-adapter`` rows — absence of a declaration is not a
#: claim of completeness.
KNOWN_PARSER_LIMITS: Dict[str, Tuple[ParserLimit, ...]] = {
    "thrift": (
        ParserLimit(
            construct="single-line method parameters",
            detail="Parameters of a method declared entirely on one line are silently "
            "dropped by the Thrift parser.",
        ),
    ),
    "capnproto": (
        ParserLimit(
            construct="parenthesized method result types",
            detail="Methods whose result type nests parentheses (for example "
            "List(Event)) are dropped by the Cap'n Proto parser.",
        ),
    ),
    "asn1": (
        ParserLimit(
            construct="scalar and alias type assignments",
            detail="Scalar and alias typedefs crash the ASN.1 normalizer and are not "
            "represented in the canonical model.",
        ),
    ),
    "cloudevents": (
        ParserLimit(
            construct="top-level event batch arrays",
            detail="A JSON document whose root is a CloudEvents batch array is rejected "
            "by the parser; only single-event documents are read.",
        ),
    ),
    "kong": (
        ParserLimit(
            construct="expression-based routes",
            detail="Kong 3.x `expression` router rules are preserved verbatim in extras "
            "but not evaluated; a route defined only by an expression imports without "
            "its match conditions.",
        ),
    ),
    "gateway-api": (
        ParserLimit(
            construct="ExtensionRef filters and policy attachments",
            detail="HTTPRoute ExtensionRef filters and external policy attachments "
            "(for example auth policies) reference resources outside the manifest; "
            "they are preserved verbatim in extras, not resolved.",
        ),
    ),
    "grpc": (
        ParserLimit(
            construct="Editions `enforce_naming_style` / `default_symbol_visibility`",
            detail="These two Edition 2024 features are resolved and reported in provenance "
            "but not modelled: they govern generated-code naming and symbol visibility — "
            "compiler behaviour with no wire or JSON meaning — so no canonical construct "
            "carries them.",
        ),
        ParserLimit(
            construct="custom options and extension declarations",
            detail="A user-defined `option` and an `extend` block are preserved in the "
            "compiled descriptor set and the retained source, but the canonical model has no "
            "vocabulary for them, so they are neither named nor counted.",
        ),
    ),
    "wit": (
        ParserLimit(
            construct="world include expansion",
            detail="A world's `include` statements are recorded but not expanded — "
            "the included world's imports/exports are not merged into the "
            "including world.",
        ),
        ParserLimit(
            construct="secondary nested package blocks",
            detail="A file nesting more than one `package ns:name { … }` block has "
            "only its first block read; the others are counted and reported, not "
            "parsed.",
        ),
    ),
}


class CapabilityReference(BaseModel):
    """A named reference into the CLX-2.4 per-format capability registry.

    The ledger's ``not-parsed-by-adapter`` entries and the manifest's adapter section
    both point here, so "our parser does not yet read this" is always traceable to the
    registry entry that documents the format's coverage state.
    """

    model_config = ConfigDict(extra="forbid")

    format: str = Field(description="Canonical format key of the registry entry (CLX-2.4).")
    mode: str = Field(description="Registry coverage mode: native / adapted / unsupported.")
    importable: bool = Field(description="Whether an import-source adapter ingests this format today.")
    related_issues: List[str] = Field(
        default_factory=list,
        description="GitHub issues tracking planned coverage work for this format.",
    )
    notes: str = Field(default="", description="The registry entry's human rationale.")

    @classmethod
    def from_capability(cls, capability: FormatLintCapability) -> "CapabilityReference":
        """Project a registry :class:`~app.format_lint_capabilities.FormatLintCapability` row."""
        return cls(
            format=capability.format,
            mode=capability.mode,
            importable=capability.importable,
            related_issues=list(capability.related_issues),
            notes=capability.notes,
        )


class ImportAdapterReference(BaseModel):
    """The adapter that produced the manifest, with its capability references (CLX-2.4)."""

    model_config = ConfigDict(extra="forbid")

    adapter_key: str = Field(description="Registry key of the adapter that ran (e.g. ``openapi``).")
    adapter_label: str = Field(description="Human label of the adapter.")
    paradigm: str = Field(description="The canonical paradigm the adapter produces.")
    formats: List[str] = Field(
        default_factory=list, description="Normalizer format keys the adapter can emit."
    )
    apiome_version: str = Field(
        description="The apiome-rest package version that ran the adapter — the adapter "
        "version provenance folded into the manifest hash (adapters version with the package)."
    )
    capability: CapabilityReference = Field(
        description="The CLX-2.4 capability-registry entry for the normalized model's format."
    )
    parser_limits: List[str] = Field(
        default_factory=list,
        description="Construct classes this adapter's parser is declared not to read yet "
        "(see the coverage ledger's not-parsed-by-adapter entries for details).",
    )


# ===========================================================================
# Entity tree + coverage ledger models
# ===========================================================================


class ImportPreviewEntity(BaseModel):
    """One canonical entity the import would create (IXH-3.1).

    A flat row of the entity tree: services, operations (parented to their service),
    channels, and types, in the model's deterministic declaration order. ``order`` is
    the entity's stable index in the *full* tree, so a paginated client can interleave
    pages without re-sorting.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="Stable canonical key (``acme.PetService``, ``GET /pets/{id}``, ``User``).")
    name: str = Field(description="Source-visible name of the entity.")
    entity_kind: str = Field(description="service | operation | type | channel.")
    parent_key: Optional[str] = Field(
        default=None,
        description="The owning service's key, on an operation; null elsewhere.",
    )
    order: int = Field(description="Stable 0-based index of this entity in the full tree.")
    description: Optional[str] = Field(default=None, description="Entity description, when the source carried one.")
    deprecated: bool = Field(default=False, description="Whether the source marks the entity deprecated.")
    coverage: CoverageClass = Field(description="This entity's coverage classification.")
    native_name: Optional[str] = Field(
        default=None, description="The construct's name in the source document, when recovered."
    )
    native_id: Optional[str] = Field(
        default=None, description="Source-native stable identifier, when the parser captured one."
    )
    source_location: Optional[str] = Field(
        default=None,
        description="Source location (line/range/pointer) the entity came from, when the parser "
        "captured one; null otherwise — never fabricated.",
    )
    unmodeled_extras: List[str] = Field(
        default_factory=list,
        description="Source attribute names that ride only in the entity's ``extras`` bag "
        "because no canonical field models them; non-empty exactly when coverage is "
        "``partially-mapped``.",
    )


class CoverageEntry(BaseModel):
    """One row of the coverage ledger (IXH-3.1).

    Classifies one source construct. Entity-scoped rows reference their canonical
    entity by key; document-scoped rows (root-level constructs) have no entity. A
    declared parser limit is marked ``document_scoped = false`` — it states an adapter
    fact, not a verified fact about this document.
    """

    model_config = ConfigDict(extra="forbid")

    source_construct: str = Field(
        description="The source construct this row classifies (an entity key, a document-level "
        "attribute, or a construct class). Named ``source_construct`` (not ``construct``) so it "
        "cannot shadow pydantic's legacy ``BaseModel.construct``."
    )
    coverage: CoverageClass = Field(description="The coverage classification.")
    status: ProjectionStatus = Field(
        description="The shared CPDO-1.3 projection status this class encodes."
    )
    reason: Optional[ProjectionReason] = Field(
        default=None,
        description="The shared reason code for a non-mapped class; null for ``mapped``.",
    )
    detail: str = Field(description="Human-readable explanation of the classification.")
    entity_key: Optional[str] = Field(
        default=None,
        description="The canonical entity this row concerns, when entity-scoped.",
    )
    document_scoped: bool = Field(
        default=True,
        description="True when the row states a fact about this document; false for an "
        "adapter-level declaration (a parser limit not evaluated against this document).",
    )
    capability_reference: Optional[CapabilityReference] = Field(
        default=None,
        description="The CLX-2.4 registry entry documenting the coverage gap; present on "
        "every ``not-parsed-by-adapter`` row.",
    )


class ImportPreviewManifest(BaseModel):
    """One page of the import preview manifest (IXH-3.1).

    The identity fields (``manifest_hash``, ``adapter``, counts) always describe the
    **full** manifest; ``entities`` / ``nodes`` / ``edges`` / ``coverage`` carry the
    requested page. ``truncated`` states whether anything was omitted from this
    response — truncation is declared, never silent.
    """

    model_config = ConfigDict(extra="forbid")

    manifest_hash: str = Field(
        description="Stable content hash over the full manifest (adapter + versions + options "
        "+ graph + ledger). Identical for a fixed input, adapter version, and options."
    )
    adapter: ImportAdapterReference = Field(
        description="The adapter that produced the model, with its CLX-2.4 capability references."
    )
    counts: ImportPreflightCounts = Field(
        description="Full-manifest canonical entity counts — the same values the pre-flight "
        "reports and the committed import's summary reports for this document."
    )
    coverage_counts: Dict[str, int] = Field(
        description="Full-manifest ledger row count per coverage class, zero-filled."
    )
    status_counts: Dict[str, int] = Field(
        description="Full-manifest outcome-edge count per shared ProjectionStatus, zero-filled "
        "(parity with the export projection manifest's counts)."
    )
    reason_counts: Dict[str, int] = Field(
        description="Full-manifest outcome-edge count per shared ProjectionReason, zero-filled."
    )
    entities: List[ImportPreviewEntity] = Field(
        default_factory=list, description="This page's entity rows, in stable tree order."
    )
    total_entities: int = Field(description="Entity count in the full manifest.")
    nodes: List[ProjectionNode] = Field(
        default_factory=list,
        description="CPDO-1.3 projection nodes for this page's entities (plus document-scope "
        "nodes on the first page).",
    )
    edges: List[ProjectionEdge] = Field(
        default_factory=list,
        description="CPDO-1.3 projection edges for this page's entities (plus document-scope "
        "edges on the first page). ``projects`` edges run native → canonical: the import "
        "direction's outcome edge.",
    )
    coverage: List[CoverageEntry] = Field(
        default_factory=list,
        description="This page's coverage-ledger rows (entity rows for the page; document-scope "
        "and adapter-declaration rows ride on the first page).",
    )
    total_coverage_entries: int = Field(description="Ledger row count in the full manifest.")
    page_size: int = Field(description="The applied (clamped) entity page size.")
    next_cursor: Optional[str] = Field(
        default=None,
        description="Opaque cursor for the next entity page; null on the last page. The cursor "
        "codec is shared with the export projection evidence pages.",
    )
    truncated: bool = Field(
        description="True when this response omits rows the full manifest has (more pages exist)."
    )


class ImportPreviewManifestRequest(ImportPreflightRequest):
    """The manifest request: the 2.1 pre-flight intake payload plus pagination.

    Everything the pre-flight accepts (document, adapter/source hints, import target,
    archive root) plus a cursor + page size over the entity tree. Repeating a request
    with the next cursor re-submits the same bytes; the manifest itself is served from a
    content-hash cache, so paging does not re-run the pipeline.
    """

    cursor: Optional[str] = Field(
        default=None,
        description="Opaque entity-page cursor from a previous response; null for the first page.",
    )
    page_size: int = Field(
        default=DEFAULT_ENTITY_PAGE_SIZE,
        ge=1,
        description=f"Maximum entities per page; clamped to {MAX_ENTITY_PAGE_SIZE}.",
    )
    project_slug: Optional[str] = Field(
        default=None,
        description="The catalog project slug the commit would target (the wizard computes it "
        "client-side, exactly as it will at commit time). When set and an existing catalog "
        "item lives under it, the response carries the IXH-3.4 re-import delta; omitted or "
        "unmatched, `reimport` is null (a first-time import).",
    )


class ImportPreviewManifestResponse(BaseModel):
    """The preview-manifest endpoint's response (IXH-3.1).

    Embeds the full IXH-2.1 pre-flight report (detection, routing decision, counts,
    lint, policy verdict, taxonomy error) and adds the manifest. ``manifest`` is null
    exactly when the candidate is not importable (``preflight.ok`` false) — there is no
    model to describe, and the pre-flight's ``error`` says why.
    """

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Mirrors ``preflight.ok``: whether the candidate is importable.")
    preflight: ImportPreflightReport = Field(
        description="The full IXH-2.1 pre-flight report for the same run — detection, routing "
        "decision, entity counts, ranked lint, policy verdict, and the intake-taxonomy error "
        "when the candidate is not importable."
    )
    manifest: Optional[ImportPreviewManifest] = Field(
        default=None,
        description="The requested manifest page; null when the candidate is not importable.",
    )
    reimport: Optional["ImportReimportDelta"] = Field(
        default=None,
        description="The IXH-3.4 re-import delta against the targeted catalog item's current "
        "revision; null for a first-time import (no existing item under the request's "
        "`project_slug`), when no slug was sent, for non-catalog routing, or when the current "
        "revision's source cannot be reconstructed.",
    )


# ===========================================================================
# Re-import delta (IXH-3.4, #5106)
# ===========================================================================


class ReimportDeltaEntry(BaseModel):
    """One identity-keyed change a re-import would make, optionally graded.

    The change itself comes from :func:`app.import_source.canonical_diff` (computed over
    canonical models, never raw text). The severity fields are joined from the format's
    breaking-change classifier where one graded the same key; entries the classifier did
    not grade keep them null — absence of a grade is *stated*, never presented as safety.
    """

    model_config = ConfigDict(extra="forbid")

    entity: str = Field(description="Entity family: root/service/operation/type/channel.")
    key: str = Field(description="The entity's stable canonical key (empty for ``root``).")
    change: DiffChangeKind = Field(description="added / removed / changed.")
    severity: Optional[str] = Field(
        default=None,
        description="Breaking-change grade for this change (safe/dangerous/breaking), when the "
        "classifier graded this key; null when unannotated.",
    )
    rule_id: Optional[str] = Field(
        default=None, description="The classifier rule that produced the grade, when graded."
    )
    rationale: Optional[str] = Field(
        default=None, description="One-line justification for the grade, when graded."
    )


class ImportReimportDelta(BaseModel):
    """What re-importing this candidate would change on an existing catalog item.

    Computed **before** the commit, per request (never cached — the item's current
    revision can move between requests), from the two canonical models by stable key. A
    ``noop`` delta (identical fingerprints, empty ``entries``) tells the client the
    commit would create an empty revision, so it can offer to skip it.
    """

    model_config = ConfigDict(extra="forbid")

    target_item_id: str = Field(description="The existing catalog item (project id) the commit would target.")
    target_item_name: Optional[str] = Field(
        default=None, description="The existing item's display name."
    )
    target_item_slug: str = Field(description="The existing item's slug (the resolution key).")
    current_version_record_id: Optional[str] = Field(
        default=None,
        description="The current revision's record id (``versions.id``) the diff was computed against.",
    )
    noop: bool = Field(
        description="True when the candidate's fingerprint equals the current revision's — the "
        "re-import would change nothing."
    )
    candidate_fingerprint: str = Field(
        description="The candidate model's canonical fingerprint (same value as the pre-flight's)."
    )
    current_fingerprint: str = Field(
        description="The current revision's canonical fingerprint, recomputed from its stored source."
    )
    entries: List[ReimportDeltaEntry] = Field(
        default_factory=list,
        description="Every change, sorted (entity, key, change) — empty for a no-op.",
    )
    counts: Dict[str, int] = Field(
        default_factory=dict,
        description="Total changes per kind: added / removed / changed (zero-filled).",
    )
    counts_by_entity: Dict[str, Dict[str, int]] = Field(
        default_factory=dict,
        description="Per entity family, the added/removed/changed tallies (families with changes only).",
    )
    classifier: Optional[str] = Field(
        default=None,
        description="Identifier of the breaking-change classifier that graded the diff "
        "(``builtin`` for the structural baseline, else the format pack's id); null when "
        "grading was unavailable or failed — in which case NO entry carries a severity.",
    )
    classifier_format_pack: bool = Field(
        default=False,
        description="Whether a format-specific classifier pack (not the structural baseline) "
        "graded the diff.",
    )
    overall_severity: Optional[str] = Field(
        default=None,
        description="Worst severity across the graded changes (safe/dangerous/breaking); null "
        "when ungraded.",
    )
    severity_counts: Dict[str, int] = Field(
        default_factory=dict,
        description="Number of graded changes at each severity (non-zero tiers only).",
    )


# The response references ImportReimportDelta forward (it is documented after the
# response model); resolve the reference now that both classes exist.
ImportPreviewManifestResponse.model_rebuild()


# ===========================================================================
# Internal full-manifest form (built once, paginated per request)
# ===========================================================================


@dataclass
class _EntityRows:
    """One entity together with its graph and ledger rows (page unit)."""

    entity: ImportPreviewEntity
    nodes: List[ProjectionNode]
    edges: List[ProjectionEdge]
    coverage: CoverageEntry


@dataclass
class _FullManifest:
    """The complete, unpaginated manifest a build produces (cached per content hash).

    Carries the candidate's canonical ``model`` so the per-request re-import delta
    (IXH-3.4) can be computed on cache hits too — the pipeline artifacts are only
    collected on the building request. The cache is bounded
    (:data:`PREVIEW_MANIFEST_CACHE_MAX_ENTRIES`), so the retained models are too.
    """

    model: CanonicalApi
    manifest_hash: str
    adapter: ImportAdapterReference
    counts: ImportPreflightCounts
    coverage_counts: Dict[str, int]
    status_counts: Dict[str, int]
    reason_counts: Dict[str, int]
    entity_rows: List[_EntityRows]
    document_nodes: List[ProjectionNode]
    document_edges: List[ProjectionEdge]
    document_coverage: List[CoverageEntry]

    @property
    def total_entities(self) -> int:
        return len(self.entity_rows)

    @property
    def total_coverage_entries(self) -> int:
        return len(self.entity_rows) + len(self.document_coverage)


# ===========================================================================
# Build
# ===========================================================================


def _native_evidence_for(extras: Dict[str, Any], name: Optional[str], key: str) -> NativeEvidence:
    """Recover native evidence from an entity's extras, exactly as the export manifest does."""
    return NativeEvidence(
        native_id=first_extra(extras, NATIVE_ID_EXTRA_KEYS),
        native_name=name or key,
        source_location=first_extra(extras, SOURCE_LOCATION_EXTRA_KEYS),
    )


def _unmodeled_extras(extras: Dict[str, Any]) -> List[str]:
    """Source attribute names in ``extras`` that are not our own provenance bookkeeping."""
    return sorted(key for key in extras if key not in PROVENANCE_EXTRA_KEYS)


def _entity_rows(
    *,
    key: str,
    name: str,
    entity_kind: str,
    order: int,
    extras: Dict[str, Any],
    description: Optional[str],
    deprecated: bool,
    parent_key: Optional[str],
) -> _EntityRows:
    """Build one entity's row, nodes, edges, and ledger entry.

    The graph mirrors the export build's shape: one native node, one canonical node, a
    ``derives`` provenance edge (always ``retained``), and exactly one outcome
    (``projects``) edge — here running native → canonical, the import direction's
    destination lane.
    """
    unmodeled = _unmodeled_extras(extras)
    if extras.get("provenance") == "inferred":
        coverage = CoverageClass.INFERRED
    elif unmodeled:
        coverage = CoverageClass.PARTIALLY_MAPPED
    else:
        coverage = CoverageClass.MAPPED
    status, reason = STATUS_FOR_COVERAGE[coverage]
    evidence = _native_evidence_for(extras, name, key)

    if coverage is CoverageClass.MAPPED:
        detail = "Source construct fully represented by canonical fields."
    elif coverage is CoverageClass.INFERRED:
        sample_count = extras.get("sample_count")
        sample_bit = f" from {sample_count} sample(s)" if sample_count is not None else ""
        path_evidence = extras.get("inference_evidence")
        if isinstance(path_evidence, dict) and path_evidence.get("template"):
            detail = (
                f"Inferred{sample_bit}: path template {path_evidence['template']!r} "
                f"from samples {path_evidence.get('sample_urls', [])!r}."
            )
        else:
            detail = (
                f"Inferred{sample_bit} from observations; never presented as a "
                "declared source construct."
            )
    else:
        detail = (
            "Source attributes not modeled by canonical fields ride in the entity's "
            f"extras bag: {', '.join(unmodeled)}."
        )

    entity = ImportPreviewEntity(
        key=key,
        name=name,
        entity_kind=entity_kind,
        parent_key=parent_key,
        order=order,
        description=description,
        deprecated=deprecated,
        coverage=coverage,
        native_name=evidence.native_name,
        native_id=evidence.native_id,
        source_location=evidence.source_location,
        unmodeled_extras=unmodeled,
    )

    native_id = f"native:{key}"
    canonical_id = f"canonical:{key}"
    nodes = [
        ProjectionNode(
            id=native_id,
            kind=ProjectionNodeKind.NATIVE,
            label=evidence.native_name or key,
            construct_key=key,
            native=evidence,
        ),
        ProjectionNode(
            id=canonical_id,
            kind=ProjectionNodeKind.CANONICAL,
            label=key,
            construct_key=key,
            canonical_kind=entity_kind,
        ),
    ]
    edges = [
        ProjectionEdge(
            id=f"derives:{key}",
            relation=ProjectionEdgeRelation.DERIVES,
            source=native_id,
            target=canonical_id,
            status=ProjectionStatus.RETAINED,
            detail="source construct normalized into the canonical model",
        ),
        ProjectionEdge(
            id=f"projects:{key}#0",
            relation=ProjectionEdgeRelation.PROJECTS,
            source=native_id,
            target=canonical_id,
            status=status,
            reason=reason,
            detail=detail,
        ),
    ]
    ledger = CoverageEntry(
        source_construct=key,
        coverage=coverage,
        status=status,
        reason=reason,
        detail=detail,
        entity_key=key,
        document_scoped=True,
    )
    return _EntityRows(entity=entity, nodes=nodes, edges=edges, coverage=ledger)


def _document_scope_rows(
    api: CanonicalApi,
    capability: CapabilityReference,
    parser_limits: Tuple[ParserLimit, ...],
) -> Tuple[List[ProjectionNode], List[ProjectionEdge], List[CoverageEntry]]:
    """Build the document-level ledger rows and their graph counterparts.

    * Root-level ``extras`` keys → ``unsupported-by-canonical-model``: the source
      carried a document-level construct no canonical field models. These are facts
      about *this* document, so they get a native node and a ``projects`` edge with
      ``target = None`` — exactly how the export manifest represents a drop.
    * Declared parser limits → ``not-parsed-by-adapter``: adapter-level declarations,
      ledger-only (no graph rows — the graph states only document facts), each naming
      its capability-registry reference.
    * Overlay provenance (IXH-7.7) → ``mapped``: each value an OpenAPI Overlay set,
      replaced, appended, or removed, naming the contributing overlay and action —
      the pre-processor applied the action fully, so the row is a retained fact
      about this document, with the attribution in its detail.
    """
    nodes: List[ProjectionNode] = []
    edges: List[ProjectionEdge] = []
    ledger: List[CoverageEntry] = []

    status, reason = STATUS_FOR_COVERAGE[CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL]
    for extra_key in _unmodeled_extras(api.extras):
        construct = f"document#{extra_key}"
        detail = (
            f"The source carried document-level construct {extra_key!r}, which no "
            "canonical field models; it is preserved only in the model's extras bag."
        )
        native_id = f"native:{construct}"
        nodes.append(
            ProjectionNode(
                id=native_id,
                kind=ProjectionNodeKind.NATIVE,
                label=extra_key,
                construct_key=construct,
                native=NativeEvidence(native_name=extra_key),
            )
        )
        edges.append(
            ProjectionEdge(
                id=f"projects:{construct}#0",
                relation=ProjectionEdgeRelation.PROJECTS,
                source=native_id,
                target=None,
                status=status,
                reason=reason,
                detail=detail,
            )
        )
        ledger.append(
            CoverageEntry(
                source_construct=construct,
                coverage=CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL,
                status=status,
                reason=reason,
                detail=detail,
                document_scoped=True,
            )
        )

    limit_status, limit_reason = STATUS_FOR_COVERAGE[CoverageClass.NOT_PARSED_BY_ADAPTER]
    for limit in parser_limits:
        ledger.append(
            CoverageEntry(
                source_construct=limit.construct,
                coverage=CoverageClass.NOT_PARSED_BY_ADAPTER,
                status=limit_status,
                reason=limit_reason,
                detail=(
                    f"{limit.detail} Whether this document uses the construct is not "
                    "evaluated — this is a declared adapter limit."
                ),
                document_scoped=False,
                capability_reference=capability,
            )
        )

    inferred_status, inferred_reason = STATUS_FOR_COVERAGE[CoverageClass.INFERRED]
    path_inferences = api.extras.get("path_inferences") if isinstance(api.extras, dict) else None
    if isinstance(path_inferences, list):
        for index, evidence in enumerate(path_inferences):
            if not isinstance(evidence, dict):
                continue
            method = evidence.get("method") or "?"
            template = evidence.get("template") or "?"
            samples = evidence.get("sample_urls") or []
            construct = f"path-template#{method} {template}"
            detail = (
                f"Inferred path template {method} {template} from "
                f"{len(samples)} sample URL(s): {samples!r}."
            )
            ledger.append(
                CoverageEntry(
                    source_construct=construct,
                    coverage=CoverageClass.INFERRED,
                    status=inferred_status,
                    reason=inferred_reason,
                    detail=detail,
                    document_scoped=True,
                )
            )
            # Keep index referenced so unused-variable linters stay quiet if enumerate changes.
            _ = index

    ledger.extend(_overlay_provenance_rows(api))
    ledger.extend(_gateway_capability_rows(api))
    ledger.extend(_wit_capability_rows(api))
    ledger.extend(_relaxng_capability_rows(api))
    ledger.extend(_dtd_capability_rows(api))
    ledger.extend(_cddl_capability_rows(api))
    ledger.extend(_arrow_capability_rows(api))

    return nodes, edges, ledger


#: Human verbs for overlay provenance kinds (IXH-7.7).
_OVERLAY_KIND_VERBS = {
    "set": "was added",
    "replaced": "was replaced",
    "appended": "was appended",
    "removed": "was removed",
}


def _overlay_provenance_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the IXH-7.7 overlay application report as document-scoped ledger rows.

    One row per provenance record — the value's JSON Pointer, what happened to it,
    and which overlay's action did it — plus one declared-truncation row when the
    report capped its records, so the ledger never silently claims completeness.
    The rows are ``mapped``: the pre-processor applied the action fully, and the
    attribution (which overlay contributed the value) is the row's detail.
    """
    report = api.extras.get("overlay") if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    status, reason = STATUS_FOR_COVERAGE[CoverageClass.MAPPED]
    rows: List[CoverageEntry] = []
    for record in report.get("provenance") or []:
        if not isinstance(record, dict):
            continue
        pointer = str(record.get("pointer") or "")
        kind = str(record.get("kind") or "")
        verb = _OVERLAY_KIND_VERBS.get(kind, f"was {kind or 'changed'}")
        detail = (
            f"The value at {pointer or 'the document root'} {verb} by overlay "
            f"{record.get('overlay')!r} (action #{record.get('action_index')}, "
            f"target {record.get('target')!r})."
        )
        rows.append(
            CoverageEntry(
                source_construct=f"overlay#{pointer or '/'}",
                coverage=CoverageClass.MAPPED,
                status=status,
                reason=reason,
                detail=detail,
                document_scoped=True,
            )
        )
    if report.get("provenance_truncated"):
        total = report.get("provenance_total")
        rows.append(
            CoverageEntry(
                source_construct="overlay#(truncated)",
                coverage=CoverageClass.MAPPED,
                status=status,
                reason=reason,
                detail=(
                    f"The overlay application recorded {total} change(s) in total; "
                    f"only the first {len(report.get('provenance') or [])} carry "
                    "itemized provenance rows here."
                ),
                document_scoped=True,
            )
        )
    return rows


#: Human labels for the gateway-config flavors (IXH-7.8).
_GATEWAY_FLAVOR_LABELS = {
    "kong": "Kong declarative config",
    "gateway-api": "Gateway API HTTPRoute manifests",
}


def _gateway_capability_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the IXH-7.8 gateway-config report as document-scoped ledger rows.

    Gateway configurations declare routes but no request/response schemas. The
    schema absence is stated as ``inferred`` / ``source_incomplete`` — a
    capability limit of the *source format*, **never** a drop — alongside one
    row per inferred auth scheme, one ``partially-mapped`` row per auth plugin
    with no canonical mapping (its config rides in extras), one
    ``unsupported-by-canonical-model`` row per recognized-but-unmodeled source
    construct, and a ``mapped`` statement of credential redaction so the scrub
    is visible, not silent.
    """
    report = api.extras.get("gateway") if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    flavor = str(report.get("flavor") or "")
    label = _GATEWAY_FLAVOR_LABELS.get(flavor, "This gateway configuration")
    rows: List[CoverageEntry] = []

    inferred_status, inferred_reason = STATUS_FOR_COVERAGE[CoverageClass.INFERRED]
    schemaless = int(report.get("schemaless_operation_count") or 0)
    if schemaless:
        rows.append(
            CoverageEntry(
                source_construct="gateway#request-response-schemas",
                coverage=CoverageClass.INFERRED,
                status=inferred_status,
                reason=inferred_reason,
                detail=(
                    f"{label} declares routes without request/response schemas; "
                    f"{schemaless} operation(s) imported without message payloads. "
                    "This is a capability limit of the source format, not a drop — "
                    "supply schemas and use the convert flow to promote the catalog "
                    "item."
                ),
                document_scoped=True,
            )
        )
    for hint in report.get("auth") or []:
        if not isinstance(hint, dict) or not hint.get("scheme"):
            continue
        rows.append(
            CoverageEntry(
                source_construct=f"gateway#auth.{hint.get('plugin')}",
                coverage=CoverageClass.INFERRED,
                status=inferred_status,
                reason=inferred_reason,
                detail=(
                    f"Auth scheme {hint.get('scheme')!r} inferred from plugin "
                    f"{hint.get('plugin')!r} ({hint.get('scope')} scope) — mapped to "
                    "canonical security, labelled inferred, never presented as "
                    "declared."
                ),
                document_scoped=True,
            )
        )

    partial_status, partial_reason = STATUS_FOR_COVERAGE[CoverageClass.PARTIALLY_MAPPED]
    for plugin in report.get("unmapped_plugins") or []:
        if not isinstance(plugin, dict) or not plugin.get("name"):
            continue
        rows.append(
            CoverageEntry(
                source_construct=f"gateway#plugin.{plugin.get('name')}",
                coverage=CoverageClass.PARTIALLY_MAPPED,
                status=partial_status,
                reason=partial_reason,
                detail=(
                    f"Auth plugin {plugin.get('name')!r} ({plugin.get('scope')} scope) "
                    "has no canonical security mapping; its configuration is preserved "
                    "verbatim in extras."
                ),
                document_scoped=True,
            )
        )

    dropped_status, dropped_reason = STATUS_FOR_COVERAGE[
        CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL
    ]
    for entry in report.get("ignored_constructs") or []:
        if not isinstance(entry, dict) or not entry.get("construct"):
            continue
        rows.append(
            CoverageEntry(
                source_construct=f"gateway#{entry.get('construct')}",
                coverage=CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL,
                status=dropped_status,
                reason=dropped_reason,
                detail=(
                    f"Source construct {entry.get('construct')!r} "
                    f"({entry.get('count')} entr(y/ies)): {entry.get('reason')}."
                ),
                document_scoped=True,
            )
        )

    redactions = int(report.get("credential_redactions") or 0)
    if redactions:
        mapped_status, mapped_reason = STATUS_FOR_COVERAGE[CoverageClass.MAPPED]
        rows.append(
            CoverageEntry(
                source_construct="gateway#credential-redactions",
                coverage=CoverageClass.MAPPED,
                status=mapped_status,
                reason=mapped_reason,
                detail=(
                    f"{redactions} credential value(s) were redacted at parse time; "
                    "counts are retained, values are never imported."
                ),
                document_scoped=True,
            )
        )
    return rows


def _wit_capability_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the IXH-7.9 WIT capability-limit report as document-scoped ledger rows.

    WIT constructs the canonical model cannot hold — resources with methods,
    ``borrow`` handle semantics, tuples, nested results, stream/future wrappers —
    are stated as ``partially-mapped``: the construct itself was normalized (the
    resource type exists, the referenced type is used) and its inexpressible part
    is preserved verbatim in extras. A **capability limit, never a drop.** A
    ``use`` whose target lives outside the supplied package is ``inferred`` /
    ``source_incomplete``: the reference is kept by name, the definition behind
    it was not supplied.
    """
    report = api.extras.get("wit") if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    rows: List[CoverageEntry] = []

    partial_status, partial_reason = STATUS_FOR_COVERAGE[CoverageClass.PARTIALLY_MAPPED]
    for limit in report.get("capability_limits") or []:
        if not isinstance(limit, dict) or not limit.get("construct"):
            continue
        count = int(limit.get("count") or 1)
        rows.append(
            CoverageEntry(
                source_construct=f"wit#{limit.get('construct')}",
                coverage=CoverageClass.PARTIALLY_MAPPED,
                status=partial_status,
                reason=partial_reason,
                detail=(
                    f"{limit.get('detail')} ({count} occurrence(s); a capability "
                    "limit of the canonical model, not a drop — the WIT construct "
                    "is preserved in extras)."
                ),
                document_scoped=True,
            )
        )

    inferred_status, inferred_reason = STATUS_FOR_COVERAGE[CoverageClass.INFERRED]
    for use in report.get("external_uses") or []:
        rows.append(
            CoverageEntry(
                source_construct=f"wit#use.{use}",
                coverage=CoverageClass.INFERRED,
                status=inferred_status,
                reason=inferred_reason,
                detail=(
                    f"`use {use}` resolves outside the supplied package; the "
                    "imported names are referenced by name only. Supply the "
                    "package's dependencies as a fileset to resolve them."
                ),
                document_scoped=True,
            )
        )
    return rows


def _relaxng_capability_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the FMT-4.1 RELAX NG declared limits as document-scoped ledger rows.

    RELAX NG constructs the canonical model cannot fully hold — ``interleave``'s
    order-independence, ``anyName``/``nsName`` wildcards, a ``data`` ``except`` clause,
    ``list`` tokenization, ``mixed`` content, an uninterpreted datatype library, and an
    ``href`` that names a URL import will not fetch — are stated as ``partially-mapped``:
    the construct itself is normalized (the interleaved members exist, the wildcard becomes
    an open-content member, the base datatype survives) and only the part with no canonical
    analogue is lost. A **capability limit, never a silent omission**, which is exactly what
    the ticket's third acceptance criterion asks the registry to carry.

    Args:
        api: The normalized model.

    Returns:
        One ledger row per declared limit, or an empty list for a grammar that met none.
    """
    report = api.extras.get(RELAXNG_EXTRAS_KEY) if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    rows: List[CoverageEntry] = []
    partial_status, partial_reason = STATUS_FOR_COVERAGE[CoverageClass.PARTIALLY_MAPPED]
    for limit in report.get("capability_limits") or []:
        if not isinstance(limit, dict) or not limit.get("construct"):
            continue
        count = int(limit.get("count") or 1)
        locations = [str(name) for name in (limit.get("locations") or [])]
        where = f" Named pattern(s): {', '.join(locations)}." if locations else ""
        rows.append(
            CoverageEntry(
                source_construct=str(limit.get("construct")),
                coverage=CoverageClass.PARTIALLY_MAPPED,
                status=partial_status,
                reason=partial_reason,
                detail=(
                    f"{limit.get('detail')} ({count} occurrence(s); a capability limit of the "
                    f"canonical model, not a drop — the pattern itself is normalized.){where}"
                ),
                document_scoped=True,
            )
        )
    return rows


def _dtd_capability_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the FMT-4.2 DTD declared limits as document-scoped ledger rows.

    DTD constructs the canonical model cannot fully hold — mixed content's interleaving,
    ``ANY``'s open content, an occurrence indicator on a group, the tokenized attribute
    types, ``ID``/``IDREF`` identity, an unparsed entity, an ``<!ATTLIST>`` for an element
    that is never declared, and a system identifier import will not fetch — are stated as
    ``partially-mapped``: the construct itself is normalized (a mixed model keeps its child
    elements and its text, an ``ANY`` element becomes an open-content record, a tokenized
    attribute becomes a list) and only the part with no canonical analogue is lost. A
    **capability limit, never a silent omission**, which is what the ticket's "modelled or
    declared a limit, explicitly" criterion asks the registry to carry.

    Args:
        api: The normalized model.

    Returns:
        One ledger row per declared limit, or an empty list for a DTD that met none.
    """
    report = api.extras.get(DTD_EXTRAS_KEY) if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    rows: List[CoverageEntry] = []
    partial_status, partial_reason = STATUS_FOR_COVERAGE[CoverageClass.PARTIALLY_MAPPED]
    for limit in report.get("capability_limits") or []:
        if not isinstance(limit, dict) or not limit.get("construct"):
            continue
        count = int(limit.get("count") or 1)
        locations = [str(name) for name in (limit.get("locations") or [])]
        where = f" Declaration(s): {', '.join(locations)}." if locations else ""
        rows.append(
            CoverageEntry(
                source_construct=str(limit.get("construct")),
                coverage=CoverageClass.PARTIALLY_MAPPED,
                status=partial_status,
                reason=partial_reason,
                detail=(
                    f"{limit.get('detail')} ({count} occurrence(s); a capability limit of the "
                    f"canonical model, not a drop — the declaration itself is normalized.)"
                    f"{where}"
                ),
                document_scoped=True,
            )
        )
    return rows


def _cddl_capability_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the FMT-4.4 CDDL declared limits as document-scoped ledger rows.

    CDDL constructs the canonical model cannot fully hold — a CBOR tag, a major-type
    shorthand, an unwrap, a table entry beside named members, a group choice spliced into a
    larger group, a socket's open-endedness, a parameterised rule, and the control operators
    with no constraint analogue (``.cbor``, ``.cborseq``, ``.bits``, ``.within``, ``.ne``,
    an unmergeable ``.and``) — are stated as ``partially-mapped``: the construct itself is
    normalized (the tagged type exists, the table becomes an open-content member, the plugs
    become union members, the controlled type keeps its type) and only the part with no
    canonical analogue is lost. A **capability limit, never a silent omission**, which is
    what the ticket's "map to canonical constraints where an analogue exists and are
    declared losses where none does" criterion asks the registry to carry.

    Args:
        api: The normalized model.

    Returns:
        One ledger row per declared limit, or an empty list for a grammar that met none.
    """
    report = api.extras.get(CDDL_EXTRAS_KEY) if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    rows: List[CoverageEntry] = []
    partial_status, partial_reason = STATUS_FOR_COVERAGE[CoverageClass.PARTIALLY_MAPPED]
    for limit in report.get("capability_limits") or []:
        if not isinstance(limit, dict) or not limit.get("construct"):
            continue
        count = int(limit.get("count") or 1)
        locations = [str(name) for name in (limit.get("locations") or [])]
        where = f" Rule(s): {', '.join(locations)}." if locations else ""
        rows.append(
            CoverageEntry(
                source_construct=str(limit.get("construct")),
                coverage=CoverageClass.PARTIALLY_MAPPED,
                status=partial_status,
                reason=partial_reason,
                detail=(
                    f"{limit.get('detail')} ({count} occurrence(s); a capability limit of the "
                    f"canonical model, not a drop — the rule itself is normalized.)"
                    f"{where}"
                ),
                document_scoped=True,
            )
        )
    return rows


def _arrow_capability_rows(api: CanonicalApi) -> List[CoverageEntry]:
    """Render the FMT-4.5 Arrow declared limits as document-scoped ledger rows.

    Arrow constructs the canonical model cannot fully hold — a dictionary encoding, a
    decimal's precision and scale, an extension type's name, a union's mode and type codes,
    an interval, a half-precision float, the large-offset/view/run-end-encoded layout
    variants, a temporal resolution, and a Flight response's endpoints — are stated as
    ``partially-mapped``: the construct itself is normalized (the dictionary-encoded field
    keeps its value type, the decimal keeps the `decimal` scalar, the union keeps its
    variants) and only the part with no canonical analogue is lost. A **capability limit,
    never a silent omission**, which is what the ticket's "nested, dictionary-encoded and
    decimal types are modelled or declared limits" criterion asks the registry to carry.

    Args:
        api: The normalized model.

    Returns:
        One ledger row per declared limit, or an empty list for a schema that met none.
    """
    report = api.extras.get(ARROW_EXTRAS_KEY) if isinstance(api.extras, dict) else None
    if not isinstance(report, dict):
        return []
    rows: List[CoverageEntry] = []
    partial_status, partial_reason = STATUS_FOR_COVERAGE[CoverageClass.PARTIALLY_MAPPED]
    for limit in report.get("capability_limits") or []:
        if not isinstance(limit, dict) or not limit.get("construct"):
            continue
        count = int(limit.get("count") or 1)
        locations = [str(name) for name in (limit.get("locations") or [])]
        where = f" Field(s): {', '.join(locations)}." if locations else ""
        rows.append(
            CoverageEntry(
                source_construct=str(limit.get("construct")),
                coverage=CoverageClass.PARTIALLY_MAPPED,
                status=partial_status,
                reason=partial_reason,
                detail=(
                    f"{limit.get('detail')} ({count} occurrence(s); a capability limit of the "
                    f"canonical model, not a drop — the field itself is normalized.)"
                    f"{where}"
                ),
                document_scoped=True,
            )
        )
    return rows


def _sort_graph(
    nodes: List[ProjectionNode], edges: List[ProjectionEdge]
) -> Tuple[List[ProjectionNode], List[ProjectionEdge]]:
    """Order nodes/edges exactly as :class:`~app.export_projection.ProjectionManifest` does."""
    kind_order = {
        ProjectionNodeKind.NATIVE: 0,
        ProjectionNodeKind.CANONICAL: 1,
        ProjectionNodeKind.TARGET: 2,
    }
    return (
        sorted(nodes, key=lambda n: (kind_order[n.kind], n.id)),
        sorted(edges, key=lambda e: e.id),
    )


def _manifest_hash(
    *,
    adapter_key: str,
    options: Dict[str, Any],
    nodes: List[ProjectionNode],
    edges: List[ProjectionEdge],
    coverage: List[CoverageEntry],
) -> str:
    """Stable content hash over the full manifest's identity-bearing content.

    Mirrors the export manifest's hash recipe: adapter + version provenance + normalized
    options folded into a digest over the deterministically ordered graph and ledger, so
    an adapter (package) upgrade or an option change is a different snapshot while a
    fixed input yields an identical hash.
    """
    payload = {
        "adapter_key": adapter_key,
        "apiome_version": APIOME_VERSION,
        "options": options,
        "nodes": [node.model_dump(mode="json") for node in nodes],
        "edges": [edge.model_dump(mode="json") for edge in edges],
        "coverage": [entry.model_dump(mode="json") for entry in coverage],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def build_import_preview_manifest(
    api: CanonicalApi,
    *,
    adapter_key: str,
    options: Optional[Dict[str, Any]] = None,
) -> _FullManifest:
    """Build the complete (unpaginated) import preview manifest for one model.

    Pure and deterministic: no I/O, no clock. Everything is derived from the canonical
    model (whose declaration order is deterministic for a fixed input), the adapter's
    registry metadata, and the request options, so a fixed (input, adapter version,
    options) triple yields a byte-stable manifest and hash.

    Args:
        api: The normalized canonical model the pre-flight pipeline produced.
        adapter_key: Registry key of the adapter that produced it.
        options: The request options that shaped the run (source kind, import target,
            archive root) — folded into the manifest hash.

    Returns:
        The internal full-manifest form; paginate with
        :func:`paginate_import_preview_manifest`.
    """
    load_builtin_import_sources()
    adapter = get_import_source(adapter_key)
    capability = CapabilityReference.from_capability(capability_for_format(api.format))
    parser_limits = KNOWN_PARSER_LIMITS.get(adapter_key, ())

    adapter_ref = ImportAdapterReference(
        adapter_key=adapter_key,
        adapter_label=adapter.label if adapter is not None else adapter_key,
        paradigm=api.paradigm.value,
        formats=list(adapter.formats) if adapter is not None else [],
        apiome_version=APIOME_VERSION,
        capability=capability,
        parser_limits=[limit.construct for limit in parser_limits],
    )

    entity_rows: List[_EntityRows] = []
    order = 0

    def _add(**kwargs: Any) -> None:
        nonlocal order
        entity_rows.append(_entity_rows(order=order, **kwargs))
        order += 1

    for service in api.services:
        _add(
            key=service.key,
            name=service.name,
            entity_kind="service",
            extras=service.extras,
            description=service.description,
            deprecated=False,
            parent_key=None,
        )
        for operation in service.operations:
            _add(
                key=operation.key,
                name=operation.name,
                entity_kind="operation",
                extras=operation.extras,
                description=operation.description,
                deprecated=operation.deprecated,
                parent_key=service.key,
            )
    for channel in api.channels:
        _add(
            key=channel.key,
            name=channel.name or channel.address,
            entity_kind="channel",
            extras=channel.extras,
            description=channel.description,
            deprecated=False,
            parent_key=None,
        )
    for type_ in api.types:
        _add(
            key=type_.key,
            name=type_.name,
            entity_kind="type",
            extras=type_.extras,
            description=type_.description,
            deprecated=type_.deprecated,
            parent_key=None,
        )

    document_nodes, document_edges, document_coverage = _document_scope_rows(
        api, capability, parser_limits
    )

    counts = ImportPreflightCounts(
        services=len(api.services),
        operations=sum(len(service.operations) for service in api.services),
        types=len(api.types),
        channels=len(api.channels),
    )

    coverage_counts = {coverage.value: 0 for coverage in CoverageClass}
    status_counts = {status.value: 0 for status in ProjectionStatus}
    reason_counts = {reason.value: 0 for reason in ProjectionReason}
    all_ledger = [rows.coverage for rows in entity_rows] + document_coverage
    for entry in all_ledger:
        coverage_counts[entry.coverage.value] += 1
        status_counts[entry.status.value] += 1
        if entry.reason is not None:
            reason_counts[entry.reason.value] += 1

    all_nodes = [node for rows in entity_rows for node in rows.nodes] + document_nodes
    all_edges = [edge for rows in entity_rows for edge in rows.edges] + document_edges
    sorted_nodes, sorted_edges = _sort_graph(all_nodes, all_edges)

    manifest_hash = _manifest_hash(
        adapter_key=adapter_key,
        options=dict(sorted((options or {}).items())),
        nodes=sorted_nodes,
        edges=sorted_edges,
        coverage=all_ledger,
    )

    return _FullManifest(
        model=api,
        manifest_hash=manifest_hash,
        adapter=adapter_ref,
        counts=counts,
        coverage_counts=coverage_counts,
        status_counts=status_counts,
        reason_counts=reason_counts,
        entity_rows=entity_rows,
        document_nodes=document_nodes,
        document_edges=document_edges,
        document_coverage=document_coverage,
    )


def paginate_import_preview_manifest(
    full: _FullManifest,
    *,
    cursor: Optional[str] = None,
    page_size: int = DEFAULT_ENTITY_PAGE_SIZE,
) -> ImportPreviewManifest:
    """Slice one deterministic entity page out of a full manifest.

    Pages over the entity list in tree order; each page carries the graph and ledger
    rows for exactly its entities. Document-scope rows (root-level constructs and the
    adapter's declared parser limits) ride on the **first** page only, so a client that
    walks every page sees every row exactly once.

    Args:
        full: The full manifest from :func:`build_import_preview_manifest`.
        cursor: Opaque cursor from a previous page, or ``None`` for the first page.
        page_size: Maximum entities per page (clamped to ``[1, MAX_ENTITY_PAGE_SIZE]``).

    Returns:
        The page as the wire :class:`ImportPreviewManifest`.

    Raises:
        ValueError: When ``cursor`` is malformed.
    """
    limit = max(1, min(int(page_size), MAX_ENTITY_PAGE_SIZE))
    start = decode_page_cursor(cursor) if cursor else 0
    page_rows = full.entity_rows[start : start + limit]

    nodes = [node for rows in page_rows for node in rows.nodes]
    edges = [edge for rows in page_rows for edge in rows.edges]
    coverage = [rows.coverage for rows in page_rows]
    if start == 0:
        nodes += full.document_nodes
        edges += full.document_edges
        coverage += full.document_coverage
    nodes, edges = _sort_graph(nodes, edges)

    next_start = start + limit
    next_cursor = encode_page_cursor(next_start) if next_start < full.total_entities else None

    return ImportPreviewManifest(
        manifest_hash=full.manifest_hash,
        adapter=full.adapter,
        counts=full.counts,
        coverage_counts=dict(full.coverage_counts),
        status_counts=dict(full.status_counts),
        reason_counts=dict(full.reason_counts),
        entities=[rows.entity for rows in page_rows],
        total_entities=full.total_entities,
        nodes=nodes,
        edges=edges,
        coverage=coverage,
        total_coverage_entries=full.total_coverage_entries,
        page_size=limit,
        next_cursor=next_cursor,
        truncated=next_cursor is not None or start > 0,
    )


# ===========================================================================
# Re-import delta build (IXH-3.4)
# ===========================================================================


def _load_reimport_target(tenant_id: str, project_slug: str) -> Optional[Dict[str, Any]]:
    """Resolve the existing catalog item a commit under ``project_slug`` would reuse.

    Mirrors the commit's own resolution (:func:`app.import_source_pipeline
    ._resolve_import_project`): the slug is normalized the same way and matched against
    the tenant's projects; only a live **non-publishable** row (a catalog item, MFI-23.1)
    counts — a publishable Project under the slug means the commit would allocate a fresh
    item, i.e. a first-time import.

    Module-level and synchronous (the psycopg driver is synchronous, matching the policy
    lookup already on this path) so tests can monkeypatch it with a fabricated item row.

    Args:
        tenant_id: The tenant the lookup is scoped to.
        project_slug: The client-computed slug the commit would use.

    Returns:
        The catalog item row (with its latest revision's ``format_metadata``), or
        ``None`` when no existing catalog item lives under the slug.
    """
    from .database import db

    slug = _normalize_import_project_slug(project_slug, project_slug)
    if not slug:
        return None
    try:
        existing = db.get_project_by_slug(slug, tenant_id)
        if not existing or existing.get("publishable"):
            return None
        item = db.get_catalog_item_by_id(str(existing["id"]), tenant_id)
        if item is None:
            return None
        # Attach the current revision's record id (best-effort provenance) so the delta
        # builder stays free of DB access.
        item = dict(item)
        item.setdefault(
            "version_record_id",
            db.get_latest_revision_id_for_project(str(existing["id"]), tenant_id),
        )
        return item
    except Exception:  # pragma: no cover - degrade on DB faults, never fail the preview
        logger.exception("re-import target lookup failed for slug %r", project_slug)
        return None


def build_reimport_delta(
    candidate: CanonicalApi,
    item: Dict[str, Any],
) -> Optional[ImportReimportDelta]:
    """Compute what re-importing ``candidate`` would change on catalog item ``item``.

    The current revision's canonical model is re-parsed from the item's stored source
    exactly as the convert flow does (:func:`app.catalog_conversion
    .build_conversion_source`), then diffed against the candidate **by stable canonical
    key** (:func:`app.import_source.canonical_diff`) — never from raw text, so a
    re-ordered but structurally identical source is a no-op. Where the format's
    breaking-change classifier grades the same keys
    (:func:`app.breaking_change.classify_models`), the grades are joined onto the
    entries; a failed or unavailable classification leaves every entry ungraded and
    ``classifier`` null — stated, not implied safe.

    Reads nothing but ``item`` and writes nothing.

    Args:
        candidate: The candidate document's normalized canonical model.
        item: The existing catalog item row (from :func:`_load_reimport_target`).

    Returns:
        The delta, or ``None`` when the item's current source cannot be reconstructed
        (nothing honest to diff against — the panel is skipped).
    """
    from .catalog_conversion import ConversionError, build_conversion_source

    try:
        source = build_conversion_source(item, source_version_id=item.get("version_record_id"))
    except ConversionError:
        return None
    current = source.api

    candidate_fp = canonical_fingerprint(candidate)
    current_fp = canonical_fingerprint(current)
    diff_result = canonical_diff(current, candidate)

    # Best-effort breaking-change annotation: join the classifier's per-change grades
    # onto the canonical entries by (change kind, stable key). `modified` is the
    # classifier vocabulary's word for `changed`; unjoined entries stay ungraded.
    classifier_id: Optional[str] = None
    overall_severity: Optional[str] = None
    severity_counts: Dict[str, int] = {}
    grades: Dict[Tuple[str, str], Any] = {}
    try:
        classification = classify_models(current, candidate)
        classifier_id = classification.classifier
        overall_severity = classification.overall_severity.value
        severity_counts = dict(classification.counts_by_severity)
        for grade in classification.classifications:
            kind = "changed" if grade.kind.value == "modified" else grade.kind.value
            grades.setdefault((kind, grade.key), grade)
    except Exception:  # pragma: no cover - a classifier fault must not lose the delta
        logger.exception("breaking-change classification failed for re-import delta")

    entries: List[ReimportDeltaEntry] = []
    counts = {kind.value: 0 for kind in DiffChangeKind}
    counts_by_entity: Dict[str, Dict[str, int]] = {}
    for entry in diff_result.entries:
        counts[entry.change.value] += 1
        family = counts_by_entity.setdefault(entry.entity, {})
        family[entry.change.value] = family.get(entry.change.value, 0) + 1
        grade = grades.get((entry.change.value, entry.key))
        entries.append(
            ReimportDeltaEntry(
                entity=entry.entity,
                key=entry.key,
                change=entry.change,
                severity=grade.severity.value if grade is not None else None,
                rule_id=grade.rule_id if grade is not None else None,
                rationale=grade.rationale if grade is not None else None,
            )
        )

    return ImportReimportDelta(
        target_item_id=str(item.get("id") or ""),
        target_item_name=item.get("name"),
        target_item_slug=str(item.get("slug") or ""),
        current_version_record_id=(
            str(source.source_version_id) if source.source_version_id else None
        ),
        noop=candidate_fp == current_fp,
        candidate_fingerprint=candidate_fp,
        current_fingerprint=current_fp,
        entries=entries,
        counts=counts,
        counts_by_entity=counts_by_entity,
        classifier=classifier_id,
        classifier_format_pack=get_breaking_change_classifier(candidate.format) is not None,
        overall_severity=overall_severity,
        severity_counts=severity_counts,
    )


# ===========================================================================
# Cache + orchestration
# ===========================================================================

#: Per-process cache of full manifests keyed by (tenant, content hash, adapter, target,
#: archive root) — the same identity the pre-flight report cache keys on. A manifest
#: depends only on the model and adapter (not on the tenant's style guide or policy), so
#: no fingerprint re-validation is needed; the bound keeps large graphs from pinning
#: memory. Paging a big document therefore re-runs nothing.
_manifest_cache: "OrderedDict[str, _FullManifest]" = OrderedDict()


def clear_preview_manifest_cache() -> None:
    """Drop every cached full manifest (tests and process-level reloads)."""
    _manifest_cache.clear()


def preview_manifest_cache_size() -> int:
    """Return how many full manifests are currently cached in this process."""
    return len(_manifest_cache)


def _manifest_cache_key(tenant_id: str, content_hash: str, request: ImportPreflightRequest) -> str:
    """The manifest cache key — everything that can change the built manifest."""
    return "|".join(
        (
            tenant_id,
            content_hash,
            (request.source_kind or "").strip().lower() or "auto",
            request.import_target or "",
            (request.archive_root or "").strip(),
        )
    )


def _manifest_cache_store(key: str, full: _FullManifest) -> None:
    """Insert a full manifest, evicting the least recently used when over the bound."""
    _manifest_cache[key] = full
    _manifest_cache.move_to_end(key)
    while len(_manifest_cache) > PREVIEW_MANIFEST_CACHE_MAX_ENTRIES:
        _manifest_cache.popitem(last=False)


def _request_options(request: ImportPreviewManifestRequest) -> Dict[str, Any]:
    """The request options that shape the manifest, normalized for the hash."""
    options: Dict[str, Any] = {}
    if request.source_kind:
        options["source_kind"] = request.source_kind.strip().lower()
    if request.import_target:
        options["import_target"] = request.import_target
    if request.archive_root and request.archive_root.strip():
        options["archive_root"] = request.archive_root.strip()
    return options


async def run_import_preview_manifest(
    request: ImportPreviewManifestRequest,
    *,
    tenant_id: str,
    tenant_slug: str,
    user_id: Optional[str] = None,
) -> ImportPreviewManifestResponse:
    """Produce the preview manifest for one candidate document (IXH-3.1).

    Runs the IXH-2.1 pre-flight (the one import code path, dry-run semantics, nothing
    persisted) with an artifacts collector, builds the full manifest from the collected
    canonical model, caches it per content hash, and returns the requested page
    alongside the full pre-flight report. A repeat request for another page is served
    from the manifest cache without re-running the pipeline.

    Args:
        request: The candidate document, its intake hints, and the page window.
        tenant_id: The tenant the run is scoped to (cache key + style guide + policy).
        tenant_slug: The tenant's slug, recorded on the pipeline payload.
        user_id: The requesting user (provenance only; nothing is written).

    Returns:
        The response; ``manifest`` is null when the candidate is not importable.

    Raises:
        ValueError: When the request's ``cursor`` is malformed.
    """
    content_hash = ""
    try:
        raw = base64.standard_b64decode(request.document_base64)
        content_hash = hashlib.sha256(raw).hexdigest()
    except (binascii.Error, ValueError):
        # Invalid base64 — the pre-flight reports the taxonomy error itself; the manifest
        # simply has nothing to cache under.
        pass

    cache_key = _manifest_cache_key(tenant_id, content_hash, request)
    cached = _manifest_cache.get(cache_key) if content_hash else None

    # The pre-flight request must not carry the pagination or re-import fields (its
    # model forbids extras and its cache key must match a plain pre-flight of the same
    # bytes).
    preflight_request = ImportPreflightRequest(
        **request.model_dump(exclude={"cursor", "page_size", "project_slug"}, exclude_none=True)
    )

    if cached is not None:
        _manifest_cache.move_to_end(cache_key)
        report = await run_import_preflight(
            preflight_request,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            user_id=user_id,
        )
        full = cached
    else:
        artifacts = ImportRunArtifacts()
        report = await run_import_preflight(
            preflight_request,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            user_id=user_id,
            artifacts=artifacts,
        )
        if not report.ok or artifacts.model is None or artifacts.adapter_key is None:
            return ImportPreviewManifestResponse(ok=report.ok, preflight=report, manifest=None)
        full = build_import_preview_manifest(
            artifacts.model,
            adapter_key=artifacts.adapter_key,
            options=_request_options(request),
        )
        if content_hash:
            _manifest_cache_store(cache_key, full)

    if not report.ok:
        return ImportPreviewManifestResponse(ok=False, preflight=report, manifest=None)

    page = paginate_import_preview_manifest(
        full, cursor=request.cursor, page_size=request.page_size
    )

    # IXH-3.4: the re-import delta, per request and never cached — the target item's
    # current revision can move between requests, and the manifest hash must stay a
    # function of the candidate alone. Only a commit that would land in an existing
    # catalog item has a delta: the request names the slug the commit will use, and the
    # routing decision must be the non-publishable (catalog) direction.
    reimport: Optional[ImportReimportDelta] = None
    routing = report.routing or {}
    if request.project_slug and routing.get("publishable") is False:
        item = _load_reimport_target(tenant_id, request.project_slug)
        if item is not None:
            reimport = build_reimport_delta(full.model, item)

    return ImportPreviewManifestResponse(
        ok=True, preflight=report, manifest=page, reimport=reimport
    )
