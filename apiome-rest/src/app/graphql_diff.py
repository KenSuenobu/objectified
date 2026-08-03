"""GraphQL diff / breaking-change classifier — MFI-10.5 (#3774).

The breaking-change classifier SPI (MFI-3.3, :mod:`app.breaking_change`) grades a canonical
:class:`~app.diff.ModelDiff` *breaking-vs-safe* and anticipates a per-format classifier that
*wraps the format's authoritative tool* — for GraphQL, that tool is **GraphQL-Inspector**. This
module is the GraphQL provider on that SPI, mirroring how MFI-8.4 wrapped ``@asyncapi/diff``.

It has two layers, same shape as the AsyncAPI provider:

* **A structural baseline** — :class:`GraphQlBreakingChangeClassifier` subclasses the
  format-agnostic :class:`~app.breaking_change.BuiltinBreakingChangeClassifier`, so its
  *synchronous, pure* :meth:`~app.breaking_change.BreakingChangeClassifier.classify` already
  grades a GraphQL diff from structure alone (a removed field/type is breaking, an added one
  safe, an enum's variant set moving is dangerous). Registered under the ``graphql`` format key
  (the one the MFI-10.2 normalizer emits), it is what the sync SPI dispatch
  (:func:`app.breaking_change.classify`) resolves for a GraphQL artifact even when no Node
  toolchain is present.

* **The GraphQL-Inspector overlay** — :meth:`GraphQlBreakingChangeClassifier.classify_async`
  (and the module convenience :func:`classify_graphql`) runs GraphQL-Inspector's ``diff`` over
  the two canonical SDL strings MFI-10.2 preserves on :attr:`app.canonical_model.CanonicalApi.raw`,
  then *overlays* its authoritative ``BREAKING`` / ``DANGEROUS`` / ``NON_BREAKING`` verdict onto
  the structural grades. The tool's verdict wins for every change that *joins* a canonical entity
  the diff already reports; a change whose schema-coordinate path matches nothing in the diff
  (a deep edit, a custom directive) keeps the conservative structural grade.

The tool I/O is **async** (it shells out through :mod:`app.toolchain_runner`), so — exactly as
MFI-8.4's tool-backed grading is layered over the sync SPI — it **degrades gracefully**: if the
source SDL is absent, or the ``graphql-inspector-diff`` tool is not installed, or it errors, the
structural baseline stands and a deterministic result is still returned.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .breaking_change import (
    BuiltinBreakingChangeClassifier,
    ChangeClassification,
    ClassificationResult,
    Severity,
)
from .canonical_model import CanonicalApi
from .diff import DiffLabeler, EntityCategory, EntityChange, ModelDiff, diff
from .toolchain_runner import (
    ToolchainError,
    ToolchainRunner,
    ToolNotAvailableError,
    default_runner,
)

logger = logging.getLogger(__name__)

__all__ = [
    "GRAPHQL_DIFF_TOOL_KEY",
    "CRITICALITY_BREAKING",
    "CRITICALITY_DANGEROUS",
    "CRITICALITY_NON_BREAKING",
    "GraphQlDiffChange",
    "GraphQlDiffResult",
    "GraphQlDiffError",
    "run_graphql_diff",
    "GraphQlBreakingChangeClassifier",
    "GraphQlDiffLabeler",
    "classify_graphql",
]


#: Registry key of the bundled Node wrapper tool (declared in :mod:`app.toolchain_packaging`).
GRAPHQL_DIFF_TOOL_KEY = "graphql-inspector-diff"

#: The three criticality levels GraphQL-Inspector assigns (its standard rule set).
CRITICALITY_BREAKING = "BREAKING"
CRITICALITY_DANGEROUS = "DANGEROUS"
CRITICALITY_NON_BREAKING = "NON_BREAKING"

_CRITICALITY_LEVELS = (CRITICALITY_BREAKING, CRITICALITY_DANGEROUS, CRITICALITY_NON_BREAKING)

# How a GraphQL-Inspector criticality maps onto the SPI severity. Unlike `@asyncapi/diff`,
# GraphQL-Inspector always assigns one of the three levels to every change, so the mapping is
# total (no "unclassified" tier to defer to the structural baseline).
_TOOL_SEVERITY: Dict[str, Severity] = {
    CRITICALITY_BREAKING: Severity.BREAKING,
    CRITICALITY_DANGEROUS: Severity.DANGEROUS,
    CRITICALITY_NON_BREAKING: Severity.SAFE,
}

# Ordinal rank of each severity (worst-last), for taking a worst-of aggregate locally without
# reaching into the SPI module's internals.
_SEVERITY_RANK: Dict[Severity, int] = {
    Severity.SAFE: 0,
    Severity.DANGEROUS: 1,
    Severity.BREAKING: 2,
}


# ===========================================================================
# Result models
# ===========================================================================


class GraphQlDiffChange(BaseModel):
    """One change GraphQL-Inspector reported between two schemas.

    :attr:`path` is the tool's dot-path schema coordinate (``User.email``, bare ``User``,
    ``Status.ACTIVE``), the same grammar :func:`app.normalizer.Keys.field` /
    :func:`~app.normalizer.Keys.type` / :func:`~app.normalizer.Keys.enum_value` assign — so the
    classifier can join a change onto a canonical entity by exact key lookup, with no path
    parsing beyond a single ``.`` split.
    """

    model_config = ConfigDict(frozen=True)

    criticality: str = Field(
        description="``BREAKING`` / ``DANGEROUS`` / ``NON_BREAKING`` — the tool's verdict."
    )
    change_type: str = Field(
        description="GraphQL-Inspector's own change-type identifier, e.g. ``FIELD_REMOVED``."
    )
    path: Optional[str] = Field(
        default=None,
        description="Dot-path schema coordinate the change applies to, when the tool sets one.",
    )
    message: str = Field(
        default="", description="The tool's human-readable description of the change."
    )

    @property
    def is_breaking(self) -> bool:
        """Whether the tool classified this change as breaking."""
        return self.criticality == CRITICALITY_BREAKING


class GraphQlDiffResult(BaseModel):
    """The outcome of diffing two GraphQL schemas with GraphQL-Inspector."""

    model_config = ConfigDict(frozen=True)

    changes: List[GraphQlDiffChange] = Field(
        default_factory=list, description="Every classified change, in the tool's order."
    )

    @property
    def breaking(self) -> List[GraphQlDiffChange]:
        """The breaking changes."""
        return [c for c in self.changes if c.criticality == CRITICALITY_BREAKING]

    @property
    def dangerous(self) -> List[GraphQlDiffChange]:
        """The dangerous changes."""
        return [c for c in self.changes if c.criticality == CRITICALITY_DANGEROUS]

    @property
    def non_breaking(self) -> List[GraphQlDiffChange]:
        """The non-breaking changes."""
        return [c for c in self.changes if c.criticality == CRITICALITY_NON_BREAKING]

    @property
    def has_breaking(self) -> bool:
        """Whether the tool found at least one breaking change."""
        return any(c.criticality == CRITICALITY_BREAKING for c in self.changes)


class GraphQlDiffError(Exception):
    """The GraphQL-Inspector diff tool was unavailable, timed out, or returned bad output.

    Reserved for *infrastructure* failures (mirroring :class:`app.asyncapi_diff.AsyncApiDiffError`):
    the bundled tool is not installed in this runtime, it exceeded its timeout, or it produced
    output the wrapper contract does not describe. The classifier catches this and degrades to
    the structural baseline, so a caller rarely sees it; it is raised by the low-level
    :func:`run_graphql_diff` for callers that want the raw failure.
    """


# ===========================================================================
# Low-level tool invocation
# ===========================================================================


def _coerce_changes(raw: Any) -> List[GraphQlDiffChange]:
    """Adapt the wrapper's ``changes`` array into typed, validated changes.

    Tolerant of an odd shape (a non-list, or entries missing fields / carrying an unrecognized
    criticality are skipped) so one malformed change never sinks an otherwise-usable diff.
    """
    if not isinstance(raw, list):
        return []
    out: List[GraphQlDiffChange] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        criticality = entry.get("criticality")
        change_type = entry.get("type")
        if criticality not in _CRITICALITY_LEVELS or not isinstance(change_type, str) or not change_type:
            continue
        path = entry.get("path")
        out.append(
            GraphQlDiffChange(
                criticality=str(criticality),
                change_type=change_type,
                path=str(path) if isinstance(path, str) and path else None,
                message=str(entry.get("message", "")),
            )
        )
    return out


def _result_from_payload(payload: Any) -> GraphQlDiffResult:
    """Build a :class:`GraphQlDiffResult` from the wrapper's parsed JSON object.

    Raises:
        GraphQlDiffError: If ``payload`` is not the object shape the wrapper guarantees.
    """
    if not isinstance(payload, dict):
        raise GraphQlDiffError(
            "GraphQL diff tool returned an unexpected (non-object) result; the wrapper "
            "contract was violated"
        )
    return GraphQlDiffResult(changes=_coerce_changes(payload.get("changes")))


async def run_graphql_diff(
    old_sdl: str,
    new_sdl: str,
    *,
    runner: Optional[ToolchainRunner] = None,
    timeout: Optional[float] = None,
) -> GraphQlDiffResult:
    """Diff two GraphQL SDL documents with GraphQL-Inspector.

    The two SDL strings are the canonical SDL MFI-10.2 produced
    (:attr:`~app.canonical_model.CanonicalApi.raw` under ``sdl``); they are handed to the bundled
    ``graphql-inspector-diff`` tool over ``stdin`` as ``{"old": ..., "new": ...}`` and the tool's
    per-change ``BREAKING`` / ``DANGEROUS`` / ``NON_BREAKING`` verdict comes back as a
    :class:`GraphQlDiffResult`.

    Args:
        old_sdl: The earlier / "from" canonical SDL.
        new_sdl: The later / "to" canonical SDL.
        runner: The toolchain runner to use; defaults to the shared
            :data:`app.toolchain_runner.default_runner`. Injectable for tests.
        timeout: Optional per-call timeout in seconds; falls back to the tool/service default.

    Returns:
        A :class:`GraphQlDiffResult`.

    Raises:
        GraphQlDiffError: For infrastructure failures only — the tool is not installed in this
            runtime, it exceeded its timeout, or it returned output the wrapper contract does
            not describe.
    """
    active_runner = runner if runner is not None else default_runner
    stdin = json.dumps({"old": old_sdl, "new": new_sdl})

    try:
        run_result = await active_runner.run(
            GRAPHQL_DIFF_TOOL_KEY, [], stdin=stdin, timeout=timeout
        )
    except ToolNotAvailableError as exc:
        raise GraphQlDiffError(
            "The GraphQL-Inspector diff tool is not available in this runtime; GraphQL "
            "breaking-change classification falls back to the structural baseline (see the "
            "bundled toolchain packaging, MFI-5.2)."
        ) from exc
    except ToolchainError as exc:
        raise GraphQlDiffError(f"The GraphQL-Inspector diff tool failed: {exc}") from exc

    return _result_from_payload(run_result.parsed_json)


# ===========================================================================
# Joining a tool change onto a canonical entity coordinate
# ===========================================================================


def _sdl_of(raw: Any) -> Optional[str]:
    """Return the canonical SDL string on a :attr:`CanonicalApi.raw`, or ``None``."""
    if not isinstance(raw, dict):
        return None
    sdl = raw.get("sdl")
    return sdl if isinstance(sdl, str) and sdl else None


def _coordinate_for(
    change: GraphQlDiffChange, key_to_category: Dict[str, EntityCategory]
) -> Optional[Tuple[EntityCategory, str]]:
    """Join one tool change onto the canonical ``(category, key)`` it grades, if any.

    GraphQL-Inspector's ``path`` is itself a schema coordinate, so the join is a key lookup
    rather than structural decoding: a 2-segment path (``User.email`` / ``Query.user``) is tried
    first against the diff's own entities — it lands on a :attr:`~app.diff.EntityCategory.FIELD`
    or :attr:`~app.diff.EntityCategory.OPERATION` when one changed under that exact key — then
    falls back to the bare leading segment (``User`` / ``Status``) for a
    :attr:`~app.diff.EntityCategory.TYPE`. The fallback is what folds an enum-value or
    union-member change (``Status.ACTIVE``) onto its *owning type*: those members have no
    separately-keyed canonical entity, they live in the type's ``enum_values``/``union_members``
    self-projection, exactly like the structural baseline already grades them.

    Resolving purely against ``key_to_category`` — built from the entities this *diff* actually
    changed — means a change that does not correspond to any diffed entity (a custom directive,
    deep schema-root metadata) simply finds no candidate and is left unjoined, keeping the
    structural grade; no GraphQL-Inspector change-type enumeration is needed.

    Args:
        change: The tool change to locate.
        key_to_category: Every entity this diff reports, keyed by its canonical ``key`` (built
            from the structural baseline's classifications).

    Returns:
        The canonical ``(EntityCategory, key)`` the change grades, or ``None`` when it does not
        join onto a diffed entity.
    """
    path = change.path
    if not path:
        return None
    segments = path.split(".")

    candidates: List[str] = []
    if len(segments) >= 2:
        candidates.append(f"{segments[0]}.{segments[1]}")
    candidates.append(segments[0])

    for candidate in candidates:
        category = key_to_category.get(candidate)
        if category is not None:
            return (category, candidate)
    return None


def _verdict_index(
    diff_result: GraphQlDiffResult, key_to_category: Dict[str, EntityCategory]
) -> Dict[Tuple[EntityCategory, str], Tuple[Severity, str]]:
    """Index the tool's authoritative verdicts by the canonical coordinate they grade.

    When several changes map to one coordinate (e.g. two enum values added to the same enum) the
    worst severity wins. The value carries the severity and the original GraphQL-Inspector
    ``change_type`` so the overlaid grade can name its source rule.
    """
    index: Dict[Tuple[EntityCategory, str], Tuple[Severity, str]] = {}
    for change in diff_result.changes:
        severity = _TOOL_SEVERITY.get(change.criticality)
        if severity is None:
            continue
        coordinate = _coordinate_for(change, key_to_category)
        if coordinate is None:
            continue
        existing = index.get(coordinate)
        if existing is None or _SEVERITY_RANK[severity] > _SEVERITY_RANK[existing[0]]:
            index[coordinate] = (severity, change.change_type)
    return index


# ===========================================================================
# The GraphQL breaking-change classifier
# ===========================================================================


class GraphQlBreakingChangeClassifier(BuiltinBreakingChangeClassifier, register=True):
    """Grade a GraphQL diff, sharpening the structural baseline with GraphQL-Inspector.

    Registered under the ``graphql`` format key (the one the MFI-10.2 normalizer emits). It
    **subclasses** the format-agnostic :class:`~app.breaking_change.BuiltinBreakingChangeClassifier`,
    so the synchronous SPI methods it inherits
    (:meth:`~app.breaking_change.BreakingChangeClassifier.classify_change` /
    :meth:`~app.breaking_change.BreakingChangeClassifier.classify`) grade a GraphQL diff from
    structure alone — the always-available, pure baseline the sync
    :func:`app.breaking_change.classify` dispatch resolves for a GraphQL artifact.

    The authoritative GraphQL-Inspector grading is the async :meth:`classify_async`, which
    overlays the tool's verdict onto that baseline. It is separate because the tool shells out
    asynchronously (the SPI is sync), and it degrades gracefully back to the baseline when the
    SDL or the tool is unavailable.
    """

    format = "graphql"
    classifier_id = "graphql-inspector-diff"

    async def classify_async(
        self,
        model_diff: ModelDiff,
        base: CanonicalApi,
        target: CanonicalApi,
        *,
        runner: Optional[ToolchainRunner] = None,
        timeout: Optional[float] = None,
    ) -> ClassificationResult:
        """Grade ``model_diff`` with the structural baseline, overlaid with GraphQL-Inspector.

        Starts from the inherited structural grades, then runs GraphQL-Inspector over the two
        canonical SDL strings on :attr:`app.canonical_model.CanonicalApi.raw` and replaces a
        change's grade with the tool's authoritative verdict wherever the tool's schema-coordinate
        path joins onto a canonical entity this diff reports. Every other change — one whose path
        does not join, or any change at all when the SDL/tool is unavailable — keeps the
        conservative structural grade.

        Args:
            model_diff: The diff to grade (as produced by :func:`app.diff.diff`).
            base: The "from" model; its canonical SDL is the "old" document fed to the tool.
            target: The "to" model; its canonical SDL is the "new" document, and its ``format``
                tags the result.
            runner: Optional toolchain runner override (injectable for tests).
            timeout: Optional per-call diff timeout in seconds.

        Returns:
            A :class:`~app.breaking_change.ClassificationResult`, 1:1 with and in the same order
            as ``model_diff.changes``.
        """
        baseline = self.classify(model_diff, base, target)

        old_sdl = _sdl_of(base.raw)
        new_sdl = _sdl_of(target.raw)
        if old_sdl is None or new_sdl is None:
            # No source SDL retained (e.g. normalized with include_raw=False): the structural
            # baseline is the best we can do.
            return baseline

        try:
            diff_result = await run_graphql_diff(
                old_sdl, new_sdl, runner=runner, timeout=timeout
            )
        except GraphQlDiffError as exc:
            logger.warning(
                "graphql-inspector-diff unavailable; using structural baseline: %s", exc
            )
            return baseline

        key_to_category = {c.key: c.category for c in baseline.classifications}
        index = _verdict_index(diff_result, key_to_category)
        if not index:
            return baseline

        classifications = [
            self._overlay(classification, index)
            for classification in baseline.classifications
        ]
        return self._assemble(target, classifications)

    def _overlay(
        self,
        classification: ChangeClassification,
        index: Dict[Tuple[EntityCategory, str], Tuple[Severity, str]],
    ) -> ChangeClassification:
        """Replace a structural grade with the tool's verdict when one joins this change."""
        verdict = index.get((classification.category, classification.key))
        if verdict is None:
            return classification
        severity, change_type = verdict
        return ChangeClassification(
            category=classification.category,
            kind=classification.kind,
            key=classification.key,
            severity=severity,
            rule_id=f"graphql-inspector-diff.{change_type}",
            rationale=(
                f"GraphQL-Inspector classified this {classification.kind.value} "
                f"{classification.category.value} as {change_type} ({severity.value})."
            ),
        )

    def _assemble(
        self, target: CanonicalApi, classifications: List[ChangeClassification]
    ) -> ClassificationResult:
        """Assemble the result from overlaid grades: worst-of overall + per-severity tally."""
        counts: Dict[str, int] = {}
        worst = Severity.SAFE
        for classification in classifications:
            counts[classification.severity.value] = (
                counts.get(classification.severity.value, 0) + 1
            )
            if _SEVERITY_RANK[classification.severity] > _SEVERITY_RANK[worst]:
                worst = classification.severity
        return ClassificationResult(
            format=target.format,
            classifier=self.classifier_id or type(self).__name__,
            overall_severity=worst,
            classifications=classifications,
            counts_by_severity=counts,
        )


# ===========================================================================
# Convenience entry point
# ===========================================================================


async def classify_graphql(
    base: CanonicalApi,
    target: CanonicalApi,
    *,
    runner: Optional[ToolchainRunner] = None,
    timeout: Optional[float] = None,
) -> ClassificationResult:
    """Diff ``base`` → ``target`` and grade it with GraphQL-Inspector in one call.

    The async, tool-backed counterpart of :func:`app.breaking_change.classify_models` for
    GraphQL: it computes the canonical :class:`~app.diff.ModelDiff` and grades it via
    :meth:`GraphQlBreakingChangeClassifier.classify_async`, degrading to the structural baseline
    when the SDL or the tool is unavailable.

    Args:
        base: The earlier / "from" model.
        target: The later / "to" model.
        runner: Optional toolchain runner override (injectable for tests).
        timeout: Optional per-call diff timeout in seconds.

    Returns:
        The :class:`~app.breaking_change.ClassificationResult` for the diff of the two models.
    """
    model_diff = diff(base, target)
    classifier = GraphQlBreakingChangeClassifier()
    return await classifier.classify_async(
        model_diff, base, target, runner=runner, timeout=timeout
    )


# ===========================================================================
# The GraphQL diff labeler — subgraph attribution (IXH-7.6)
# ===========================================================================


class GraphQlDiffLabeler(DiffLabeler, register=True):
    """Attribute each GraphQL change to its owning Federation subgraph(s).

    The first provider on the :class:`app.diff.DiffLabeler` SPI. When a
    federated artifact (supergraph or subgraph set) is diffed, every canonical
    entity the IXH-7.6 normalizer could attribute carries the owning subgraph
    names in ``extras["subgraphs"]`` — this labeler surfaces them as the
    change's human-readable label, so "which subgraph broke the supergraph?"
    is answered directly on the diff:

    * added/removed entities → ``owned by subgraph 'reviews'``;
    * modified entities whose ownership itself moved →
      ``subgraph ownership: products → products, reviews``;
    * entities of a non-federated schema (no ``subgraphs`` extras) → no label.
    """

    format = "graphql"

    def label(
        self, change: EntityChange, base: CanonicalApi, target: CanonicalApi
    ) -> Optional[str]:
        """Return the subgraph-attribution label for ``change``, or ``None``.

        Reads the owning-subgraph names off the change's ``before``/``after``
        self-projections (which carry ``extras`` verbatim); deterministic and
        I/O-free, per the SPI contract.
        """
        before_owners = _owners_of(change.before)
        after_owners = _owners_of(change.after)
        if before_owners and after_owners and before_owners != after_owners:
            return (
                f"subgraph ownership: {', '.join(before_owners)} → "
                f"{', '.join(after_owners)}"
            )
        owners = after_owners or before_owners
        if not owners:
            return None
        noun = "subgraph" if len(owners) == 1 else "subgraphs"
        named = ", ".join(f"'{name}'" for name in owners)
        return f"owned by {noun} {named}"


def _owners_of(payload: Any) -> List[str]:
    """The ``extras['subgraphs']`` list of a change self-projection, if any."""
    if not isinstance(payload, dict):
        return []
    extras = payload.get("extras")
    if not isinstance(extras, dict):
        return []
    owners = extras.get("subgraphs")
    if not isinstance(owners, list):
        return []
    return [str(name) for name in owners]
