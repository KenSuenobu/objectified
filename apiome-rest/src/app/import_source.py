"""ImportSource SPI & registry — MFI-1.1 (#3733).

The seam the whole multi-format import roadmap hangs on. Today a new import
format would mean editing the import engine and the wizard; there is no extension
point. *This* module defines one — the :class:`ImportSource` adapter contract — so
a format is added by **registering a source**, not by editing the engine.

An :class:`ImportSource` is the per-format adapter the rest of the pipeline drives
through a uniform contract:

* **descriptor metadata** — ``key``/``label``/``description``/``icon``,
  the :class:`~app.canonical_model.ApiParadigm` it produces, the
  :class:`InputKind`\\s it accepts (file/url/paste/discovery), whether it supports
  live discovery, and the normalizer ``formats`` it can emit. The UI (source
  cards, MFI-1.3), the CLI (source dispatch, MFI-1.4), and REST all read this off
  the registry rather than hard-coding a format list.
* **detect** (``bytes/url → confidence``) — a cheap content sniff returning a
  :class:`DetectionResult` so MFI-1.5 auto-detection can pick the best adapter.
* **parse** (``input → native_ast``) — turn raw source text into the format's own
  parse tree (for OpenAPI a parsed ``dict``).
* **normalize** (``native_ast → CanonicalApi``) — map the native tree onto the
  paradigm-agnostic :class:`~app.canonical_model.CanonicalApi` (MFI-2.1), almost
  always by delegating to a registered :class:`~app.normalizer.Normalizer`
  (MFI-2.3) via :meth:`ImportSource._normalize_via_registry`.
* **analyze** (``native_ast → payload analysis``) — describe the native AST while
  it is still in hand (CPDO-1.2), so an X12 envelope or a copybook level survives
  the import instead of being re-derived on every detail read. The default is the
  format-blind walk in :mod:`app.payload_analyzer`; an adapter with format
  semantics worth keeping overrides it, and declares what it can and cannot model
  via :meth:`ImportSource.analysis_capabilities`.
* **fingerprint** / **diff** / **lint** — operate on the *canonical* model, so
  they are written **once** here and work uniformly across every paradigm. The
  defaults are real implementations (a stable SHA-256 over the normalized model
  and a by-key structural diff); an adapter overrides only when it has a
  format-native rule pack (e.g. the OpenAPI adapter delegates ``lint`` to the
  existing OpenAPI linter).

A by-key registry (:func:`register_import_source` / :func:`get_import_source` /
:func:`available_import_sources` / :func:`describe_import_sources`) enumerates the
adapters for UI/CLI/REST. Built-in adapters self-register on import via the
``register=True`` subclass flag; :func:`load_builtin_import_sources` imports them
so the registry is populated without each caller importing every adapter module.

This mirrors the MCP import-source decision (V2-MCP-EPIC-17/24.1): one adapter per
source, enumerated from a registry, surfaced identically everywhere.
"""

from __future__ import annotations

import hashlib
import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, ClassVar, Dict, List, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import ApiParadigm, CanonicalApi
from .normalizer import get_normalizer

if TYPE_CHECKING:  # pragma: no cover - import for type checkers only (avoids a runtime cycle)
    from .fileset import IntakeFileset
    from .payload_analysis import (
        AnalyzerCapabilities,
        AnalyzerInfo,
        PayloadAnalysisDocument,
    )

logger = logging.getLogger(__name__)


def _safe_detect(adapter: "ImportSource", payload: DetectionInput) -> DetectionResult:
    """Call ``adapter.detect`` treating any raise as :data:`NO_MATCH`.

    The SPI contract says sniffers must never raise, but registry-level detection
    feeds a live endpoint (``POST /v1/import/detect``) and the whole import intake
    (IXH-1.3: adversarial input must never 5xx), so a buggy adapter is demoted to
    "did not recognize the input" instead of failing every caller.
    """
    try:
        return adapter.detect(payload)
    except Exception as exc:  # noqa: BLE001 - a broken sniffer must not break detection
        # Log the exception *type* only, never its message or traceback: a parser
        # error quotes the offending source span, which may carry a credential
        # (IXH-1.4). The adapter key plus type is enough to find the bug.
        logger.warning(
            "import-source adapter %r raised %s during detect(); treating as no-match",
            adapter.key,
            type(exc).__name__,
        )
        return NO_MATCH
    from .schema_lint import LintResult

__all__ = [
    "InputKind",
    "DetectionInput",
    "DetectionResult",
    "NO_MATCH",
    "ImportSourceDescriptor",
    "DiffChangeKind",
    "CanonicalDiffEntry",
    "CanonicalDiff",
    "LintFinding",
    "LintReport",
    "ImportSourceError",
    "ImportSource",
    "register_import_source",
    "get_import_source",
    "available_import_sources",
    "describe_import_sources",
    "detect_import_source",
    "load_builtin_import_sources",
    "canonical_fingerprint",
    "canonical_diff",
]


class ImportSourceError(Exception):
    """An import-source adapter could not parse or normalize its input.

    Carries a human-readable message so a route can surface it directly (e.g. a
    400/422 detail) without leaking a stack trace.

    Args:
        message: Human-readable description of what was wrong with the input.
        code: Optional stable intake-taxonomy code (see
            :mod:`app.intake_error_taxonomy`). Adapters that can classify the
            failure precisely (truncation, unsupported version, unresolved
            reference, …) pass it; when omitted the pipeline classifies the
            failure itself with the coarse default for the failing phase.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


# ===========================================================================
# Descriptor vocabulary
# ===========================================================================


class InputKind(str, Enum):
    """How a source document reaches an adapter.

    Drives which input panel the UI shows (MFI-1.3) and which flags the CLI offers
    (MFI-1.4): an adapter declares the subset it accepts.
    """

    FILE = "file"  # an uploaded file's bytes
    URL = "url"  # an http/https document URL
    PASTE = "paste"  # inline pasted text
    DISCOVERY = "discovery"  # a live endpoint the adapter introspects
    FILESET = "fileset"  # a root document plus sibling members (archive/git intake)


class ImportSourceDescriptor(BaseModel):
    """Self-description of an import source for UI/CLI/REST enumeration.

    This is the registry's public, serializable view of an adapter — everything a
    consumer needs to render a source card or a CLI verb without importing the
    adapter class itself.
    """

    model_config = ConfigDict(frozen=True)

    key: str = Field(description="Stable registry key, e.g. ``openapi``.")
    label: str = Field(description="Human label for source cards / CLI listings.")
    description: str = Field(description="One-line description of what it imports.")
    icon: str = Field(
        description="Icon name (Lucide) the UI renders for this source's card.",
    )
    paradigm: ApiParadigm = Field(
        description="The canonical paradigm the adapter produces.",
    )
    input_kinds: List[InputKind] = Field(
        description="The intake methods this adapter accepts.",
    )
    supports_live_discovery: bool = Field(
        description="Whether the adapter can introspect a live endpoint.",
    )
    formats: List[str] = Field(
        default_factory=list,
        description="Normalizer format keys this adapter can emit "
        "(e.g. ``openapi-3.0``/``openapi-3.1``).",
    )
    file_extensions: List[str] = Field(
        default_factory=list,
        description="Lower-case filename extensions this adapter's documents normally carry, each "
        "including the leading dot and ordered most-canonical first (e.g. ``['.proto']``). This is "
        "what a file picker's ``accept`` list is built from (FMT-1.1), so a format is browsable as "
        "soon as its adapter is registered. Compound extensions are spelled in full "
        "(``.postman_collection.json``). Adapters that accept a ``fileset`` also carry the archive "
        "suffixes, because an archive is a legitimate way to hand them their documents. The list is "
        "an **advisory hint, never an allow-list**: content sniffing (``POST /v1/import/detect``) "
        "is the authority on what a file is, so an unlisted extension must still be offered to "
        "detection rather than rejected on its name.",
    )
    available: bool = Field(
        default=True,
        description="Whether this adapter can actually run in the current runtime — ``False`` when a "
        "hard-required toolchain (e.g. ``buf`` for gRPC/Protobuf) is missing (MFI-5.2). The UI "
        "hides/disables an unavailable source instead of letting an import fail at parse.",
    )
    unavailable_reason: Optional[str] = Field(
        default=None,
        description="Human-readable reason the source is unavailable, or ``null`` when available.",
    )
    supports_remote_refs: bool = Field(
        default=False,
        description="Whether this format's documents may reference other documents by URL, so an "
        "import can opt into SSRF-guarded remote ``$ref`` resolution (MFI-29.4) via the "
        "``resolve_remote_refs`` option. ``false`` sources ignore the option entirely.",
    )


# ===========================================================================
# Detection
# ===========================================================================


@dataclass(frozen=True)
class DetectionInput:
    """The bundle an adapter inspects to decide if it recognizes a document.

    Carries whatever the caller has cheaply available — raw ``text`` and/or an
    already-parsed ``document``, plus filename/content-type/URL hints. An adapter
    reads only what it needs; auto-detection (MFI-1.5) passes the same input to
    every adapter and keeps the highest-confidence match.

    ``data`` carries the *undecoded* upload bytes for adapters that recognize a
    binary artifact (IXH-7.5: a serialized protobuf ``FileDescriptorSet`` / buf
    image). It is optional — callers that only have text omit it, and text-format
    adapters ignore it.
    """

    text: Optional[str] = None
    document: Optional[Dict[str, Any]] = None
    filename: Optional[str] = None
    content_type: Optional[str] = None
    url: Optional[str] = None
    data: Optional[bytes] = None


@dataclass(frozen=True)
class DetectionResult:
    """An adapter's confidence that it recognizes a document.

    Attributes:
        confidence: ``0.0`` (definitely not this format) … ``1.0`` (certain),
            clamped on construction. Auto-detection picks the highest.
        format: The specific normalizer format key recognized (e.g.
            ``openapi-3.1``), when the adapter can pin it down; ``None`` for a
            no-match or a format-family match without a version.
        reason: A short, human-readable justification (e.g. the marker found),
            surfaced when auto-detection has to disambiguate.
    """

    confidence: float
    format: Optional[str] = None
    reason: Optional[str] = None

    def __post_init__(self) -> None:
        clamped = max(0.0, min(1.0, float(self.confidence)))
        object.__setattr__(self, "confidence", clamped)

    @property
    def matched(self) -> bool:
        """Whether the adapter recognized the input at all (confidence > 0)."""
        return self.confidence > 0.0


#: The canonical "this is not my format" result, returned by every adapter that
#: does not recognize a document.
NO_MATCH = DetectionResult(confidence=0.0)


# ===========================================================================
# Canonical diff model (shared default for every adapter)
# ===========================================================================


class DiffChangeKind(str, Enum):
    """The kind of change a :class:`CanonicalDiffEntry` records."""

    ADDED = "added"
    REMOVED = "removed"
    CHANGED = "changed"


class CanonicalDiffEntry(BaseModel):
    """One identity-keyed change between two canonical models."""

    model_config = ConfigDict(frozen=True)

    entity: str = Field(
        description="Entity family: root/service/operation/type/channel.",
    )
    key: str = Field(description="The entity's stable key (empty for ``root``).")
    change: DiffChangeKind


class CanonicalDiff(BaseModel):
    """A structural diff between two :class:`CanonicalApi` models, by stable key.

    Entries are sorted (by entity, key, change) so the diff is deterministic —
    the same pair of models always produces the same diff.
    """

    entries: List[CanonicalDiffEntry] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """Whether the two models are structurally identical (no entries)."""
        return not self.entries

    def of_kind(self, change: DiffChangeKind) -> List[CanonicalDiffEntry]:
        """Return only the entries of a given :class:`DiffChangeKind`."""
        return [e for e in self.entries if e.change == change]


# ===========================================================================
# Lint report (shared default; OpenAPI adapter delegates to the real linter)
# ===========================================================================


class LintFinding(BaseModel):
    """One lint finding against an imported model."""

    model_config = ConfigDict(frozen=True)

    path: str = Field(description="Where in the model the finding applies.")
    rule: str = Field(description="The rule id that fired.")
    severity: str = Field(description="error/warning/info.")
    message: str = Field(description="Human-readable explanation.")
    id: Optional[str] = Field(
        default=None,
        description="Stable finding id (matches engine LintFinding.id when adapted).",
    )
    category: Optional[str] = Field(
        default=None,
        description="Rule category (documentation/naming/structure/…).",
    )


class LintReport(BaseModel):
    """Findings rolled up to a score / grade / fingerprint for an imported model.

    Mirrors the shape of :class:`app.schema_lint.LintResult` (and its MCP twin
    :class:`app.mcp_score.MCPScoreResult`) so a canonical-model lint, an OpenAPI lint, and
    an MCP lint all carry the same persisted quality signals — a weighted 0–100 ``score``, an
    A–F ``grade``, and a stable ``report_fingerprint`` — on one comparable scale (MFI-4.2).
    The three roll-up fields are optional because an adapter may decline to score (the empty
    default report); :meth:`from_lint_result` populates them from an engine result.
    """

    findings: List[LintFinding] = Field(default_factory=list)
    score: Optional[int] = Field(
        default=None, description="0–100 quality score, when the adapter computes one."
    )
    grade: Optional[str] = Field(
        default=None, description="A–F letter grade, when the adapter computes one."
    )
    report_fingerprint: Optional[str] = Field(
        default=None,
        description="Stable hash over score/grade/findings; lets a caller detect a stale score.",
    )
    rule_hits: Dict[str, int] = Field(
        default_factory=dict,
        description="Count of findings per rule id (sorted), for drill-down.",
    )
    severity_counts: Dict[str, int] = Field(
        default_factory=dict,
        description="Count of findings per severity (error/warning/info).",
    )
    categories: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Per-category 0–100 rollup scores when adapted from an engine LintResult.",
    )

    def to_persisted_dict(self) -> Dict[str, Any]:
        """Serialize the report for ``versions.quality_report`` JSONB persistence.

        The payload mirrors :meth:`app.schema_lint.LintResult.report_dict` and
        ``MCPScoreResult.report_dict()`` so every import surface stores findings the lint API
        can serve without recomputing.
        """
        import hashlib

        findings_out: List[Dict[str, str]] = []
        for finding in self.findings:
            finding_id = finding.id
            if not finding_id:
                digest = hashlib.sha256(
                    f"{finding.path}|{finding.rule}|{finding.message}".encode("utf-8")
                ).hexdigest()[:16]
                finding_id = f"lint-{digest}"
            findings_out.append(
                {
                    "id": finding_id,
                    "path": finding.path,
                    "category": finding.category or "",
                    "rule": finding.rule,
                    "severity": finding.severity,
                    "message": finding.message,
                }
            )
        return {
            "score": self.score,
            "grade": self.grade,
            "report_fingerprint": self.report_fingerprint,
            "rule_hits": dict(self.rule_hits),
            "severity_counts": dict(self.severity_counts),
            "findings": findings_out,
            "categories": list(self.categories),
        }

    def with_extra_findings(self, findings: Sequence[LintFinding]) -> "LintReport":
        """Return a copy of this report with ``findings`` merged in and re-scored.

        Some defects are found *outside* the rule engines — the MFI-29.4 remote ``$ref``
        resolver reports references the imported model can no longer describe, because the
        definitions behind them never made it into the model. Those findings still belong on
        the same report, under the same score, so the quality signal a revision persists
        reflects them.

        Merging re-runs the shared roll-up (:func:`app.schema_lint.assemble_lint_result`) over
        the union of the findings, so the score, grade, tallies and ``report_fingerprint``
        stay exactly the values the formula would have produced had one engine emitted all of
        them. A report that declined to score (no ``score``) keeps its findings appended but is
        not given a synthetic score, since its adapter deliberately produced none.

        Args:
            findings: The extra findings to merge (any order; duplicates are kept as-is).

        Returns:
            A new :class:`LintReport`; ``self`` when ``findings`` is empty.
        """
        if not findings:
            return self
        merged = list(self.findings) + list(findings)
        if self.score is None:
            return self.model_copy(update={"findings": merged})

        # Lazy import: the roll-up lives with the engine's finding model, which this SPI
        # module deliberately does not depend on at import time.
        from .schema_lint import LintFinding as EngineFinding
        from .schema_lint import assemble_lint_result

        engine_findings = [
            EngineFinding(
                path=finding.path,
                category=finding.category or finding.rule.split(".", 1)[0],
                rule=finding.rule,
                severity=finding.severity,  # type: ignore[arg-type]
                message=finding.message,
            )
            for finding in merged
        ]
        return LintReport.from_lint_result(assemble_lint_result(engine_findings))

    @classmethod
    def from_lint_result(cls, result: "LintResult") -> "LintReport":
        """Adapt an engine :class:`app.schema_lint.LintResult` into the SPI report shape.

        Both the OpenAPI linter (:func:`app.schema_lint.lint_openapi_spec`) and the
        canonical-model engine (:func:`app.lint_engine.lint_canonical_model`) return a
        ``LintResult`` carrying the deterministic roll-up. This copies the score, grade,
        fingerprint, and the per-rule / per-severity tallies across, and maps each engine
        finding onto the SPI :class:`LintFinding` (path / rule / severity / message).
        Centralising the conversion keeps every adapter's report identical in shape to the
        persisted spec and MCP scores.

        Args:
            result: The engine lint result to adapt.

        Returns:
            A populated :class:`LintReport` mirroring ``result``.
        """
        return cls(
            findings=[
                LintFinding(
                    path=finding.path,
                    rule=finding.rule,
                    severity=finding.severity,
                    message=finding.message,
                    id=finding.id,
                    category=finding.category,
                )
                for finding in result.findings
            ],
            score=result.score,
            grade=result.grade,
            report_fingerprint=result.report_fingerprint,
            rule_hits=dict(result.rule_hits),
            severity_counts=dict(result.severity_counts),
            categories=result.category_dicts(),
        )


# ===========================================================================
# The SPI contract
# ===========================================================================


class ImportSource(ABC):
    """Service-provider contract: one importable source format → canonical model.

    A concrete adapter declares its descriptor metadata (class attributes below)
    and implements the three format-specific steps — :meth:`detect`,
    :meth:`parse`, :meth:`normalize`. The cross-paradigm steps —
    :meth:`fingerprint`, :meth:`diff`, :meth:`lint` — have working defaults that
    operate on the canonical model, so an adapter overrides them only when it has
    a format-native rule pack.

    Adapters must be **deterministic and side-effect free** (parsing maps an
    in-memory document; fetching happens in the ingestion layer before
    :meth:`parse`), so two imports of the same document produce an equal model and
    therefore an identical fingerprint.

    Subclasses self-register via the ``register=True`` flag::

        class FooImportSource(ImportSource, register=True):
            key = "foo"
            ...
    """

    #: Stable registry key, e.g. ``"openapi"``. Required (non-empty) to register.
    key: ClassVar[str] = ""
    #: Human label for source cards / CLI listings.
    label: ClassVar[str] = ""
    #: One-line description of what the adapter imports.
    description: ClassVar[str] = ""
    #: Icon name (Lucide) the UI renders for this source's card.
    icon: ClassVar[str] = "file"
    #: The canonical paradigm this adapter produces.
    paradigm: ClassVar[ApiParadigm]
    #: The intake methods this adapter accepts.
    input_kinds: ClassVar[Tuple[InputKind, ...]] = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
    )
    #: Whether the adapter can introspect a live endpoint (discovery).
    supports_live_discovery: ClassVar[bool] = False
    #: Normalizer format keys this adapter can emit.
    formats: ClassVar[Tuple[str, ...]] = ()
    #: Lower-case filename extensions this format's documents normally carry (FMT-1.1), each with
    #: its leading dot and ordered most-canonical first. Declaring them here is what puts the format
    #: in every file picker's ``accept`` list — the UI derives its pickers from the registry rather
    #: than hand-maintaining a parallel array, so a newly registered adapter is browsable with no UI
    #: change. Spell compound extensions in full (``.postman_collection.json``) and do **not** list
    #: archive suffixes: :meth:`descriptor` appends those automatically for any adapter accepting
    #: :attr:`InputKind.FILESET`. Leave empty only for an adapter that cannot take a file at all
    #: (:attr:`InputKind.FILE` absent), or one whose files genuinely have no conventional extension.
    file_extensions: ClassVar[Tuple[str, ...]] = ()
    #: When ``True`` a non-dry-run import through this adapter is **not** persisted — the pipeline
    #: runs parse→normalize→lint and returns a preview summary without writing a catalog item. Set
    #: only for the internal ``sample`` no-op acceptance adapter; every real format adapter persists
    #: (MFI-23.7 canonical→catalog hook, :func:`app.import_source_pipeline.persist_adapter_import`).
    preview_only: ClassVar[bool] = False
    #: Whether this format's documents may reference definitions in **other documents by URL**
    #: (MFI-29.4). When ``True`` the pipeline runs the shared remote ``$ref`` resolver
    #: (:mod:`app.remote_ref_resolver`) over the intake before :meth:`parse`: with the import's
    #: ``resolve_remote_refs`` opt-in it inlines those references (SSRF-guarded, budgeted,
    #: cached) so the model — and therefore the fingerprint — covers them, and without it the
    #: unresolved externals are reported as lint findings. Adapters whose formats have no
    #: URL-referencing construct leave this ``False`` and are never scanned.
    supports_remote_refs: ClassVar[bool] = False
    #: Toolchain tool keys this adapter's parse **hard-requires** — its import cannot run without them
    #: (e.g. gRPC/Protobuf needs ``buf`` to compile ``.proto``). When any is unavailable in the
    #: runtime (MFI-5.2 packaging), the adapter's descriptor reports ``available = False`` so the UI
    #: can hide/disable it instead of letting an import fail at parse. Adapters that degrade
    #: gracefully without their optional tool leave this empty.
    required_tools: ClassVar[Tuple[str, ...]] = ()
    #: Key of the **payload analyzer** behind :meth:`analyze` (CPDO-1.2). Left at ``generic`` by an
    #: adapter that keeps the default format-blind walk; an adapter with a native extractor sets its
    #: own key, because a record produced by ``edix12`` and one produced by ``generic`` describe the
    #: same bytes at completely different fidelity and must stay distinguishable afterwards.
    analyzer_key: ClassVar[str] = "generic"
    #: Version of that analyzer. Bumped when the tree it produces changes shape, so a record written
    #: by an older extractor is detectable rather than silently mixed in with newer ones.
    analyzer_version: ClassVar[str] = "1.0.0"

    def __init_subclass__(cls, *, register: bool = False, **kwargs: Any) -> None:
        """Optionally self-register a concrete subclass in the source registry.

        Args:
            register: When ``True`` the subclass is added to the global registry
                under its :attr:`key` as soon as it is defined.
        """
        super().__init_subclass__(**kwargs)
        if register:
            register_import_source(cls)

    # --- format-specific steps (each adapter implements these) --------------

    @abstractmethod
    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Return this adapter's confidence that it recognizes ``payload``.

        Must be cheap (a content/extension sniff, not a full parse) and never
        raise: an unrecognized input returns :data:`NO_MATCH`.
        """
        raise NotImplementedError

    @abstractmethod
    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        """Parse raw source text into this format's native parse tree.

        Args:
            raw: The raw document text (already fetched by the ingestion layer).
            source_label: Optional label (filename/URL) for error messages.

        Returns:
            The format's native AST (for OpenAPI a parsed ``dict``).

        Raises:
            ImportSourceError: If the text cannot be parsed as this format.
        """
        raise NotImplementedError

    def parse_fileset(
        self,
        fileset: "IntakeFileset",
        *,
        source_label: Optional[str] = None,
    ) -> Any:
        """Parse a multi-document fileset (archive/git intake) into the native AST.

        Adapters that accept directory-shaped sources (gRPC proto trees, multi-file SDL,
        AsyncAPI suites) override this. The default rejects filesets so single-file adapters
        fail fast with a clear message.

        Raises:
            ImportSourceError: When this adapter does not accept fileset input.
        """
        _ = fileset, source_label
        raise ImportSourceError(
            f"The {self.label!r} source does not accept multi-document fileset input."
        )

    def accepts_bytes(self, raw: bytes, *, filename: Optional[str] = None) -> bool:
        """Whether this adapter wants ``raw`` routed to :meth:`parse_bytes` (IXH-7.5).

        The intake pipeline consults this before decoding an upload to text: an adapter
        that imports a *binary* artifact (a serialized protobuf ``FileDescriptorSet`` /
        buf image) claims the bytes here, and the pipeline then calls
        :meth:`parse_bytes` instead of :meth:`parse`. Like :meth:`detect`, this must be
        cheap and must never raise. The default declines, so text-only adapters are
        unaffected.

        Args:
            raw: The undecoded upload bytes.
            filename: Optional filename/label hint (a conventional binary suffix may
                claim the bytes even when they are malformed, so the failure is
                reported by the binary parser's taxonomy code).

        Returns:
            ``True`` when the bytes should be parsed via :meth:`parse_bytes`.
        """
        _ = raw, filename
        return False

    def parse_bytes(self, raw: bytes, *, source_label: Optional[str] = None) -> Any:
        """Parse a binary document into this format's native parse tree (IXH-7.5).

        The binary counterpart to :meth:`parse`, called by the pipeline only when
        :meth:`accepts_bytes` claimed the payload. Adapters with a binary artifact form
        (the gRPC adapter's descriptor-set / buf-image intake) override this; the
        default rejects, so single-format text adapters fail fast with a clear message.

        Args:
            raw: The undecoded upload bytes.
            source_label: Optional label (filename/URL) for error messages.

        Returns:
            The format's native AST.

        Raises:
            ImportSourceError: When this adapter does not accept binary input, or the
                bytes cannot be parsed (with a taxonomy ``code`` when classifiable).
        """
        _ = raw, source_label
        raise ImportSourceError(
            f"The {self.label!r} source does not accept binary document input."
        )

    @abstractmethod
    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Map a native AST onto the canonical model.

        Almost always a thin delegation to a registered
        :class:`~app.normalizer.Normalizer` via :meth:`_normalize_via_registry`.

        Raises:
            ImportSourceError: If ``native_ast`` is not a document this adapter
                can normalize (e.g. no normalizer is registered for its format).
        """
        raise NotImplementedError

    # --- cross-paradigm steps (working defaults; override when format-native) -

    def fingerprint(self, model: CanonicalApi) -> str:
        """Return a stable content fingerprint of the *normalized* model.

        See :func:`canonical_fingerprint`. Because the canonical model is already
        order-normalized, two imports of the same source fingerprint identically.
        """
        return canonical_fingerprint(model)

    def diff(self, a: CanonicalApi, b: CanonicalApi) -> CanonicalDiff:
        """Return the by-key structural diff between two canonical models.

        See :func:`canonical_diff`.
        """
        return canonical_diff(a, b)

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint the canonical ``model`` and roll findings up to a score / grade / fingerprint.

        The default runs the paradigm-agnostic lint engine
        (:func:`app.lint_engine.lint_canonical_model`) — the always-on common rule pack plus
        any rule pack registered for ``model.format`` — and adapts its deterministic result
        into a :class:`LintReport`. So every adapter, with no format-native override, already
        produces a weighted 0–100 score, an A–F grade, and a stable ``report_fingerprint`` over
        the canonical model (MFI-4.2). Pure and deterministic: the same model always yields the
        same report.

        An adapter with a format-native linter (e.g. the OpenAPI adapter, which lints the
        preserved native document) overrides this, returning a report in the same shape via
        :meth:`LintReport.from_lint_result`.
        """
        # Imported lazily: the engine pulls in the rule catalogue, only needed on the lint path.
        from .lint_engine import lint_canonical_model

        return LintReport.from_lint_result(lint_canonical_model(model))

    # --- native payload analysis (CPDO-1.2) ---------------------------------

    def analyzer_tool_versions(self) -> Dict[str, str]:
        """Return the underlying parser/library versions this adapter's analyzer leaned on.

        Recorded on the stored analysis so a record produced against ``pyx12 4.0.1`` is
        distinguishable from one produced against a later release *without* re-running anything —
        the case an analysis exists to make visible is "the parser changed and nobody noticed".

        Returns:
            A ``tool → version`` mapping; empty when the analyzer uses no external parser.
        """
        return {}

    def analyzer_info(self) -> "AnalyzerInfo":
        """Return the identity recorded on analyses this adapter produces.

        Returns:
            The :class:`~app.payload_analysis.AnalyzerInfo` naming the analyzer key, its version, and
            its tool versions.
        """
        from .payload_analysis import AnalyzerInfo as _AnalyzerInfo

        return _AnalyzerInfo(
            key=self.analyzer_key,
            version=self.analyzer_version,
            tool_versions=self.analyzer_tool_versions(),
        )

    def analysis_capabilities(self) -> "AnalyzerCapabilities":
        """Return what this adapter's analyzer models, and what it knowingly does not.

        The per-record answer to "why is this construct missing?" — the default is the generic
        walk's declaration, which claims no format semantics at all. An adapter with a native
        extractor overrides this with its own vocabulary so a reader can tell an absent X12
        functional group from an unmodelled one.

        Returns:
            The :class:`~app.payload_analysis.AnalyzerCapabilities` recorded on the analysis.
        """
        from .payload_analyzer import GENERIC_CAPABILITIES

        return GENERIC_CAPABILITIES

    def analyze(
        self, native_ast: Any, *, source: Optional[str] = None
    ) -> "PayloadAnalysisDocument":
        """Describe the native AST as a bounded, revision-scoped payload analysis (CPDO-1.2).

        Called by the import pipeline **after parse and before persistence**, while the AST is still
        in hand — the whole point of the analysis is that the native structure survives an import
        instead of being re-derived by whatever parser is installed at read time.

        The default runs the format-blind walk (:func:`app.payload_analyzer.generic_analysis`), which
        records nesting, ordering, and value presence for any AST shape. An adapter with format
        semantics worth keeping — X12 envelopes, copybook levels — overrides this and emits its own
        node vocabulary.

        Implementations must be deterministic (the same AST and bytes must produce the same document,
        since an identical re-analysis is recognised by content fingerprint rather than appended) and
        must put observed payload values only in a node's ``value``, never in ``attributes``: the
        value-visibility policy governs the former and cannot govern the latter.

        Args:
            native_ast: The AST this adapter's :meth:`parse` produced.
            source: The exact source material analysed, hashed into the record's ``source_hash``.
                ``None`` yields a declared ``unavailable`` record — an analysis that cannot name the
                bytes it describes is not checkable, so it is not written.

        Returns:
            The :class:`~app.payload_analysis.PayloadAnalysisDocument`, with observed values still on
            it: :func:`app.payload_analysis_store.store_analysis` applies the redaction policy.
        """
        from .payload_analyzer import generic_analysis

        return generic_analysis(
            native_ast,
            analyzer=self.analyzer_info(),
            capabilities=self.analysis_capabilities(),
            source=source,
            source_format=self.key,
        )

    # --- shared helpers -----------------------------------------------------

    @staticmethod
    def _normalize_via_registry(
        format_key: str, native_ast: Any, *, include_raw: bool = True
    ) -> CanonicalApi:
        """Normalize ``native_ast`` with the :class:`Normalizer` for ``format_key``.

        Args:
            format_key: The normalizer registry key (e.g. ``openapi-3.1``).
            native_ast: The parsed source document the normalizer consumes.
            include_raw: Passed through to the normalizer.

        Returns:
            The canonical model the registered normalizer produces.

        Raises:
            ImportSourceError: If no normalizer is registered for ``format_key``.
        """
        normalizer_cls = get_normalizer(format_key)
        if normalizer_cls is None:
            raise ImportSourceError(
                f"No normalizer registered for format {format_key!r}; "
                "this format's normalizer is provided by a later format epic."
            )
        return normalizer_cls().normalize(native_ast, include_raw=include_raw)

    @classmethod
    def declared_file_extensions(cls) -> Tuple[str, ...]:
        """Return the effective ``accept`` extensions for this adapter (FMT-1.1).

        The adapter's own :attr:`file_extensions`, normalized (lower-cased, leading dot enforced,
        duplicates dropped) and — for an adapter that accepts :attr:`InputKind.FILESET` — followed
        by :data:`app.archive_intake.ARCHIVE_SUFFIXES`, because a ``.zip``/``.tar.gz`` of that
        format's documents is a legitimate way to hand it an import. Appending the archive suffixes
        here rather than on each adapter keeps the two lists from drifting: adding an archive
        container server-side widens every fileset adapter's picker at once.

        Declaration order is preserved (most-canonical extension first) so a picker's hint text
        reads sensibly; only the archive suffixes are appended, always last.

        Returns:
            The de-duplicated extension tuple, each entry lower-case and dot-prefixed. Empty for an
            adapter that declares none and takes no fileset.
        """
        # Imported lazily: ``archive_intake`` imports this module, so a top-level import would cycle.
        from .archive_intake import ARCHIVE_SUFFIXES

        # A one-entry declaration written without its trailing comma — ``(".capnp")`` — is a *str*,
        # and iterating it would silently yield one bogus extension per character. Treat a bare
        # string as the single extension it was plainly meant to be rather than shredding it.
        own = cls.file_extensions
        declared: List[str] = [own] if isinstance(own, str) else list(own)
        if InputKind.FILESET in cls.input_kinds:
            declared.extend(ARCHIVE_SUFFIXES)

        seen: Dict[str, None] = {}
        for raw in declared:
            ext = raw.strip().lower()
            if not ext:
                continue
            if not ext.startswith("."):
                ext = f".{ext}"
            seen.setdefault(ext, None)
        return tuple(seen)

    @classmethod
    def descriptor(cls) -> ImportSourceDescriptor:
        """Return this adapter's serializable :class:`ImportSourceDescriptor`.

        Computes ``available`` from :attr:`required_tools` (MFI-5.2): an adapter whose parser
        hard-requires a bundled binary that is absent in this runtime reports ``available = False``
        plus an ``unavailable_reason``, so the UI can hide/disable it rather than let an import fail.
        ``file_extensions`` comes from :meth:`declared_file_extensions`, so the descriptor carries
        the archive suffixes a fileset adapter implicitly accepts (FMT-1.1).
        """
        from .toolchain_runner import is_tool_available

        missing = [t for t in cls.required_tools if not is_tool_available(t)]
        available = not missing
        unavailable_reason = (
            None
            if available
            else (
                f"Requires the {', '.join(missing)} toolchain, which is not available in this "
                "runtime."
            )
        )
        return ImportSourceDescriptor(
            key=cls.key,
            label=cls.label,
            description=cls.description,
            icon=cls.icon,
            paradigm=cls.paradigm,
            input_kinds=list(cls.input_kinds),
            supports_live_discovery=cls.supports_live_discovery,
            formats=list(cls.formats),
            file_extensions=list(cls.declared_file_extensions()),
            available=available,
            unavailable_reason=unavailable_reason,
            supports_remote_refs=cls.supports_remote_refs,
        )


# ===========================================================================
# Registry
# ===========================================================================


# Key → adapter-class registry. A format epic registers its adapter here so
# UI/CLI/REST resolve and enumerate sources without importing each adapter.
_REGISTRY: Dict[str, type[ImportSource]] = {}

# Detector / client tokens that map to a registered adapter key (e.g. ``protobuf`` → ``grpc``).
_SOURCE_KIND_ALIASES: Dict[str, str] = {
    "protobuf": "grpc",
}


def resolve_import_source_key(key: str) -> str:
    """Normalize a request ``source_kind`` to the registry key of its adapter."""
    normalized = key.strip().lower()
    return _SOURCE_KIND_ALIASES.get(normalized, normalized)


def register_import_source(cls: type[ImportSource]) -> type[ImportSource]:
    """Register a concrete adapter class under its :attr:`ImportSource.key`.

    Args:
        cls: A concrete :class:`ImportSource` subclass with a non-empty ``key``.

    Returns:
        ``cls`` unchanged, so this can also be used as a class decorator.

    Raises:
        ValueError: If ``cls.key`` is empty, or a *different* class is already
            registered under the same key (re-registering the same class is a
            no-op so module re-import is safe).
    """
    key = cls.key
    if not key:
        raise ValueError(f"{cls.__name__} must set a non-empty `key` to register")
    existing = _REGISTRY.get(key)
    if existing is not None and existing is not cls:
        raise ValueError(
            f"import source {key!r} already registered to {existing.__name__}; "
            f"cannot re-register to {cls.__name__}"
        )
    _REGISTRY[key] = cls
    return cls


def get_import_source(key: str) -> Optional[ImportSource]:
    """Return an instance of the adapter registered under ``key``, or ``None``.

    Built-in adapters are loaded on demand (:func:`load_builtin_import_sources`)
    so a lookup works even if the caller never imported the adapter module.
  Aliases such as ``protobuf`` → ``grpc`` are resolved before registry lookup.
    """
    load_builtin_import_sources()
    resolved = resolve_import_source_key(key)
    cls = _REGISTRY.get(resolved)
    return cls() if cls is not None else None


def available_import_sources() -> List[str]:
    """Return the sorted list of registered import-source keys."""
    load_builtin_import_sources()
    return sorted(_REGISTRY)


def describe_import_sources() -> List[ImportSourceDescriptor]:
    """Return every registered adapter's descriptor, sorted by key.

    This is the **source list** the UI (source cards), the CLI (``import
    --list``), and REST enumerate — the registry's public view.
    """
    load_builtin_import_sources()
    return [_REGISTRY[key].descriptor() for key in sorted(_REGISTRY)]


def detect_import_source(
    payload: DetectionInput,
) -> Optional[Tuple[ImportSource, DetectionResult]]:
    """Return the highest-confidence adapter for ``payload``, or ``None``.

    Polls every registered adapter's :meth:`ImportSource.detect` and keeps the
    best match (confidence > 0). Ties are broken by key for determinism. This is
    the primitive MFI-1.5 auto-detection builds on.

    Returns:
        ``(adapter, result)`` for the best match, or ``None`` when no adapter
        recognized the input.
    """
    load_builtin_import_sources()
    best: Optional[Tuple[ImportSource, DetectionResult]] = None
    for key in sorted(_REGISTRY):
        adapter = _REGISTRY[key]()
        result = _safe_detect(adapter, payload)
        if not result.matched:
            continue
        if best is None or result.confidence > best[1].confidence:
            best = (adapter, result)
    return best


def detect_import_source_candidates(
    payload: DetectionInput,
) -> List[Tuple[ImportSource, DetectionResult]]:
    """Return *every* registered adapter that recognizes ``payload`` (confidence > 0).

    Like :func:`detect_import_source` but keeps the whole matched set rather than
    only the winner, sorted by descending confidence then key for determinism.
    The MFI-1.5 auto-detector folds these importable matches in with its
    not-yet-importable format sniffers to rank candidates and flag ambiguity.
    """
    load_builtin_import_sources()
    matches: List[Tuple[ImportSource, DetectionResult]] = []
    for key in sorted(_REGISTRY):
        adapter = _REGISTRY[key]()
        result = _safe_detect(adapter, payload)
        if result.matched:
            matches.append((adapter, result))
    matches.sort(key=lambda pair: (-pair[1].confidence, pair[0].key))
    return matches


# Guard so the (idempotent) built-in import only does its module imports once.
_builtins_loaded = False


def load_builtin_import_sources() -> None:
    """Import the built-in adapter modules so they self-register.

    Idempotent and cheap after the first call. Kept lazy (imports inside the
    function) so the adapter modules can import this one without a cycle.
    """
    global _builtins_loaded
    if _builtins_loaded:
        return
    _builtins_loaded = True
    # ``asyncapi_import_source`` (MFI-8.5) self-registers the ``asyncapi`` adapter and, as a
    # side effect of its own imports, the AsyncAPI normalizer (MFI-8.2) under ``asyncapi-2`` /
    # ``asyncapi-3`` for ``get_normalizer`` / ``available_formats``.
    from . import asyncapi_import_source as _asyncapi  # noqa: F401

    # ``graphql_import_source`` (MFI-10.6) self-registers the ``graphql`` adapter and, as a side
    # effect of its own imports, the GraphQL normalizer (MFI-10.2) under ``graphql`` for
    # ``get_normalizer`` / ``available_formats``.
    from . import graphql_import_source as _graphql  # noqa: F401

    # ``grpc_import_source`` (MFI-9.6) self-registers the ``grpc`` adapter and, as a side effect of
    # its own imports, the Protobuf normalizer (MFI-9.2) under ``protobuf`` for ``get_normalizer`` /
    # ``available_formats``.
    from . import grpc_import_source as _grpc  # noqa: F401

    # ``jsonschema_import_source`` (MFI-26.7) self-registers the ``json-schema`` adapter, which
    # builds the canonical model directly (JSON Schema is a pure data-schema language with no
    # separate paradigm normalizer), so a JSON Schema document imports into the catalog as a
    # schemas-only item.
    from . import jsonschema_import_source as _jsonschema  # noqa: F401
    from . import jtd_import_source as _jtd  # noqa: F401
    from . import arazzo_import_source as _arazzo  # noqa: F401
    from . import openapi_import_source as _openapi  # noqa: F401
    from . import sample_import_source as _sample  # noqa: F401
    from . import thrift_import_source as _thrift  # noqa: F401
    from . import connectrpc_import_source as _connectrpc  # noqa: F401
    from . import flatbuffers_import_source as _flatbuffers  # noqa: F401
    from . import capnproto_import_source as _capnproto  # noqa: F401
    from . import wsdl_import_source as _wsdl  # noqa: F401
    from . import raml_import_source as _raml  # noqa: F401
    from . import wadl_import_source as _wadl  # noqa: F401
    from . import openrpc_import_source as _openrpc  # noqa: F401
    from . import discovery_import_source as _discovery  # noqa: F401
    from . import k8s_crd_import_source as _k8s_crd  # noqa: F401
    from . import llm_tools_import_source as _llm_tools  # noqa: F401
    from . import http_file_import_source as _http_file  # noqa: F401
    from . import avro_import_source as _avro  # noqa: F401
    from . import xmlrpc_import_source as _xmlrpc  # noqa: F401
    from . import xsd_import_source as _xsd  # noqa: F401

    # ``relaxng_import_source`` (FMT-4.1) self-registers the ``relaxng`` adapter — both
    # the XML (`.rng`) and compact (`.rnc`) syntaxes — and, via its own imports, the
    # RELAX NG normalizer under ``relaxng``.
    from . import relaxng_import_source as _relaxng  # noqa: F401

    # ``dtd_import_source`` (FMT-4.2) self-registers the ``dtd`` adapter — external
    # subsets, internal subsets and modular sets — and, via its own imports, the DTD
    # normalizer under ``dtd``.
    from . import dtd_import_source as _dtd  # noqa: F401

    # ``cddl_import_source`` (FMT-4.4) self-registers the ``cddl`` adapter — one grammar
    # or a fileset composed into one namespace — and, via its own imports, the CDDL
    # normalizer under ``cddl``.
    from . import cddl_import_source as _cddl  # noqa: F401

    # ``odcs_import_source`` (FMT-5.1) self-registers the ``odcs`` adapter — an Open Data
    # Contract Standard v3.x contract, alone or as a set with its quality packs — and, via
    # its own imports, the ODCS normalizer under ``odcs``.
    from . import odcs_import_source as _odcs  # noqa: F401

    # ``arrow_import_source`` (FMT-4.5) self-registers the ``arrow`` adapter — the JSON
    # integration form, a binary IPC payload, a captured Flight fileset and a live Flight
    # endpoint — and, via its own imports, the Arrow normalizer under ``arrow``.
    from . import arrow_import_source as _arrow  # noqa: F401

    from . import postman_import_source as _postman  # noqa: F401
    from . import cloudevents_import_source as _cloudevents  # noqa: F401
    from . import smithy_import_source as _smithy  # noqa: F401
    from . import apiblueprint_import_source as _apiblueprint  # noqa: F401
    from . import asn1_import_source as _asn1  # noqa: F401
    from . import edix12_import_source as _edix12  # noqa: F401
    from . import oncrpc_import_source as _oncrpc  # noqa: F401
    from . import corbaidl_import_source as _corbaidl  # noqa: F401
    from . import odata_import_source as _odata  # noqa: F401
    from . import fhir_import_source as _fhir  # noqa: F401
    from . import typespec_import_source as _typespec  # noqa: F401
    from . import hl7v2_import_source as _hl7v2  # noqa: F401
    from . import iso20022_import_source as _iso20022  # noqa: F401
    from . import iso8583_import_source as _iso8583  # noqa: F401
    from . import cobolcopybook_import_source as _cobolcopybook  # noqa: F401
    from . import fix_import_source as _fix  # noqa: F401
    from . import zosconnect_import_source as _zosconnect  # noqa: F401

    # ``kong_import_source`` / ``gateway_api_import_source`` (IXH-7.8) self-register the
    # ``kong`` and ``gateway-api`` adapters and, via their shared normalizer module, the
    # gateway-config normalizers under ``kong`` / ``gateway-api``.
    from . import gateway_api_import_source as _gateway_api  # noqa: F401
    from . import kong_import_source as _kong  # noqa: F401

    # ``wit_import_source`` (IXH-7.9) self-registers the ``wit`` adapter and, as a side
    # effect of its own imports, the WIT normalizer under ``wit``.
    from . import wit_import_source as _wit  # noqa: F401

    # ``mcp_import_source`` (FMT-1.7) self-registers the ``mcp`` adapter and, as a side
    # effect of its own imports, the MCP manifest normalizer under ``mcp``.
    from . import mcp_import_source as _mcp  # noqa: F401


# ===========================================================================
# Shared canonical fingerprint + diff
# ===========================================================================


def canonical_fingerprint(model: CanonicalApi) -> str:
    """Return a stable ``sha256:`` fingerprint of a normalized canonical model.

    The hash is taken over the model's JSON serialization with the ``raw``
    fidelity bag excluded (it is the native AST, not part of the *normalized*
    identity) and object keys sorted, so it depends only on the normalized
    content. Since normalizers run :func:`app.normalizer.normalize_ordering`, two
    imports of the same source — however the source ordered its paths/schemas —
    produce byte-identical input here and therefore the same fingerprint.

    Args:
        model: The canonical model to fingerprint.

    Returns:
        ``"sha256:<hex>"``.
    """
    payload = model.model_dump(mode="json", exclude={"raw"})
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _entity_repr(payload: Dict[str, Any]) -> str:
    """Deterministic JSON of one entity for equality comparison in a diff."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _entity_map(model: CanonicalApi) -> Dict[Tuple[str, str], str]:
    """Flatten a canonical model into ``(entity, key) → deterministic-repr``.

    Granularity is one entry per identity-keyed entity — the artifact root, each
    service (its own fields, excluding nested operations), each operation, each
    type, and each channel — so a diff reports add/remove/change at the level a
    reviewer reasons about. ``raw``/``extras`` fidelity bags are excluded from the
    root so a diff is about *normalized* shape, not native re-serialization.
    """
    out: Dict[Tuple[str, str], str] = {}

    root = model.model_dump(
        mode="json",
        exclude={"raw", "extras", "services", "channels", "types"},
    )
    out[("root", "")] = _entity_repr(root)

    for service in model.services:
        out[("service", service.key)] = _entity_repr(
            service.model_dump(mode="json", exclude={"operations"})
        )
        for op in service.operations:
            out[("operation", op.key)] = _entity_repr(op.model_dump(mode="json"))

    for type_ in model.types:
        out[("type", type_.key)] = _entity_repr(type_.model_dump(mode="json"))

    for channel in model.channels:
        out[("channel", channel.key)] = _entity_repr(channel.model_dump(mode="json"))

    return out


def canonical_diff(a: CanonicalApi, b: CanonicalApi) -> CanonicalDiff:
    """Return the by-key structural diff from model ``a`` to model ``b``.

    Entities present in ``b`` but not ``a`` are ``ADDED``; present in ``a`` but not
    ``b`` are ``REMOVED``; present in both with a different normalized
    representation are ``CHANGED``. Comparison is by stable ``key`` (not position),
    which is the whole point of the canonical key grammar — a re-ordered source is
    not a diff. Entries are sorted for determinism.

    Args:
        a: The "before" model.
        b: The "after" model.

    Returns:
        A :class:`CanonicalDiff`; :attr:`CanonicalDiff.is_empty` is ``True`` when
        the two models are structurally identical.
    """
    am = _entity_map(a)
    bm = _entity_map(b)
    a_keys = set(am)
    b_keys = set(bm)

    entries: List[CanonicalDiffEntry] = []
    for entity, key in b_keys - a_keys:
        entries.append(CanonicalDiffEntry(entity=entity, key=key, change=DiffChangeKind.ADDED))
    for entity, key in a_keys - b_keys:
        entries.append(CanonicalDiffEntry(entity=entity, key=key, change=DiffChangeKind.REMOVED))
    for entity, key in a_keys & b_keys:
        if am[(entity, key)] != bm[(entity, key)]:
            entries.append(
                CanonicalDiffEntry(entity=entity, key=key, change=DiffChangeKind.CHANGED)
            )

    entries.sort(key=lambda e: (e.entity, e.key, e.change.value))
    return CanonicalDiff(entries=entries)
