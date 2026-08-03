"""OpenAPI Overlay 1.0 pre-processor — IXH-7.7 (#5132).

The `Overlay Specification 1.0 <https://spec.openapis.org/overlay/v1.0.0>`_ is the
standard way teams apply environment- or audience-specific modifications to a base
OpenAPI document. Importing base and overlay separately loses the relationship;
importing only a hand-resolved output loses the provenance of which values came
from where. This module is the pure core the OpenAPI adapter
(:class:`app.openapi_import_source.OpenApiImportSource`) applies **before**
normalization: given a base document and one or more overlay documents, it applies
each overlay's actions in order and records, per changed value, which overlay
contributed it.

Semantics implemented (Overlay 1.0 Action Object):

* ``target`` — a JSONPath expression selecting the nodes an action modifies.
  Parsed through the hardened Spectral-compatible parser the custom-rule DSL
  already ships (:func:`app.custom_rule_dsl.parse_jsonpath_expression`), so
  ``[*]`` wildcards behave identically across both features.
* ``update`` — merged into every selected node: an object target deep-merges
  (nested objects merge recursively; any other value replaces), an array target
  **appends** the update value, and a primitive target is replaced.
* ``remove: true`` — removes every selected node from its parent (``update`` is
  ignored, per the specification).

Everything observable is recorded rather than silently applied or dropped:

* **Provenance** — one :class:`OverlayProvenanceRecord` per changed value (JSON
  Pointer, kind, contributing overlay, action index, target expression). The
  import preview coverage ledger renders these as document-scoped rows
  (:mod:`app.import_preview_manifest`), and later overlays in a chain simply
  produce later records for the same pointer, so "last writer" is readable.
* **Findings** — an action whose target matches nothing, or that is structurally
  unusable (no ``update``/``remove``, an unparsable target, a type-mismatched
  update), produces an :class:`OverlayFinding`. The adapter surfaces them as
  ``intake.overlay-*`` lint findings (:mod:`app.intake_lint_rules`), so they ride
  the pre-flight report instead of being silently ignored.

The module never mutates its inputs: :func:`apply_overlays` deep-copies the base
document and returns the resolved copy.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .import_source import ImportSourceError

__all__ = [
    "FINDING_ACTION_INVALID",
    "FINDING_UNMATCHED_TARGET",
    "MAX_MATCHES_PER_ACTION",
    "MAX_PROVENANCE_RECORDS",
    "OVERLAY_EXTRA_KEY",
    "OverlayApplication",
    "OverlayFinding",
    "OverlayProvenanceRecord",
    "OverlayedOpenApiDocument",
    "apply_overlays",
    "is_overlay_document",
    "overlay_lint_findings",
    "overlay_version",
]


#: Key under which the adapter records the overlay report on
#: :attr:`app.canonical_model.CanonicalApi.extras` (and the preview manifest reads it).
OVERLAY_EXTRA_KEY = "overlay"

#: Ceiling on retained provenance records. A pathological overlay (a wildcard update
#: over a huge document) must not bloat the canonical model's extras or the preview
#: manifest; the report declares the truncation (``provenance_truncated``) instead of
#: hiding it.
MAX_PROVENANCE_RECORDS = 500

#: Ceiling on nodes a single action may select. Matches beyond it are not modified;
#: the action gets an ``action-invalid`` finding naming the cap, so an unbounded
#: wildcard is a visible mistake rather than a silent partial application.
MAX_MATCHES_PER_ACTION = 1000

#: Finding codes (stable; the adapter maps them onto ``intake.overlay-*`` lint rules).
FINDING_UNMATCHED_TARGET = "unmatched-target"
FINDING_ACTION_INVALID = "action-invalid"

#: An Overlay version marker: ``1`` followed by minor/patch (``1.0.0``).
_OVERLAY_VERSION_RE = re.compile(r"^1(\.\d+)*$")


class OverlayedOpenApiDocument(dict):
    """A resolved OpenAPI document that carries its overlay application report.

    A plain ``dict`` subclass so every existing consumer (normalizers, the linter,
    ``CanonicalApi.raw``) treats it exactly like the parsed document it is; the
    adapter reads :attr:`overlay_report` off it after normalization to publish the
    report on the canonical model's extras.

    Attributes:
        overlay_report: The :meth:`OverlayApplication.report` dict for the
            application that produced this document (set per instance; read with
            ``getattr(doc, "overlay_report", None)``).
    """

    overlay_report: Dict[str, Any]


@dataclass(frozen=True)
class OverlayProvenanceRecord:
    """One value the overlay application changed, and which overlay changed it.

    Attributes:
        pointer: JSON Pointer (RFC 6901) of the affected value in the resolved
            document; for a removal, the pointer the node had before removal.
        kind: What happened to the value — ``set`` (a key the base did not have),
            ``replaced`` (an existing value overwritten), ``appended`` (an entry
            added to an array target), or ``removed``.
        overlay: Label (member path) of the contributing overlay document.
        action_index: 0-based index of the action inside that overlay's ``actions``.
        target: The action's JSONPath ``target`` expression, verbatim.
    """

    pointer: str
    kind: str
    overlay: str
    action_index: int
    target: str

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for the extras report / preview manifest."""
        return {
            "pointer": self.pointer,
            "kind": self.kind,
            "overlay": self.overlay,
            "action_index": self.action_index,
            "target": self.target,
        }


@dataclass(frozen=True)
class OverlayFinding:
    """One overlay action that could not be applied as written.

    Attributes:
        code: :data:`FINDING_UNMATCHED_TARGET` or :data:`FINDING_ACTION_INVALID`.
        overlay: Label (member path) of the overlay the action came from.
        action_index: 0-based index of the action inside that overlay's ``actions``.
        target: The action's ``target`` expression (empty when the action had none).
        message: Human-readable explanation of what was wrong.
    """

    code: str
    overlay: str
    action_index: int
    target: str
    message: str

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for the extras report / lint adaptation."""
        return {
            "code": self.code,
            "overlay": self.overlay,
            "action_index": self.action_index,
            "target": self.target,
            "message": self.message,
        }


@dataclass
class OverlayApplication:
    """The outcome of applying an overlay chain to a base document.

    Attributes:
        document: The resolved document (a deep copy; the base is never mutated).
        applied: Overlay labels in the order they were applied.
        provenance: Per-value records, in application order, capped at
            :data:`MAX_PROVENANCE_RECORDS`.
        findings: Actions that matched nothing or were structurally unusable.
        provenance_truncated: ``True`` when records beyond the cap were dropped.
        provenance_total: Total number of changes observed (including dropped ones).
    """

    document: Dict[str, Any]
    applied: List[str] = field(default_factory=list)
    provenance: List[OverlayProvenanceRecord] = field(default_factory=list)
    findings: List[OverlayFinding] = field(default_factory=list)
    provenance_truncated: bool = False
    provenance_total: int = 0

    def report(self) -> Dict[str, Any]:
        """Build the deterministic ``overlay`` extras block the adapter publishes."""
        return {
            "applied": list(self.applied),
            "provenance": [record.as_dict() for record in self.provenance],
            "findings": [finding.as_dict() for finding in self.findings],
            "provenance_truncated": self.provenance_truncated,
            "provenance_total": self.provenance_total,
        }


def overlay_version(document: Any) -> Optional[str]:
    """Return the document's ``overlay`` version marker, or ``None``.

    Args:
        document: Any parsed value.

    Returns:
        The version string when ``document`` is a mapping whose ``overlay`` key is a
        version-shaped string (``1.0.0``, ``2.0.0``, …); ``None`` otherwise.
    """
    if not isinstance(document, Mapping):
        return None
    version = document.get("overlay")
    if isinstance(version, str) and re.match(r"^\d+(\.\d+)*$", version.strip()):
        return version.strip()
    return None


def is_overlay_document(document: Any) -> bool:
    """Whether a parsed document is an Overlay Specification document.

    Recognition is by the top-level ``overlay`` version marker — the same "look at
    the version key" convention the adapter already uses for ``openapi``/``swagger``
    — so even a truncated overlay (marker present, ``actions`` cut off) is
    recognized and can be routed to overlay-specific guidance instead of a generic
    parse error.

    Args:
        document: Any parsed value.

    Returns:
        ``True`` when the document carries an ``overlay`` version marker.
    """
    return overlay_version(document) is not None


def apply_overlays(
    base: Mapping[str, Any],
    overlays: Sequence[Tuple[str, Mapping[str, Any]]],
) -> OverlayApplication:
    """Apply an ordered chain of Overlay 1.0 documents to a base OpenAPI document.

    Overlays are applied strictly in the given order, each seeing the result of the
    previous one, so a later overlay in the chain wins any conflict — and the
    provenance records show it doing so.

    Args:
        base: The parsed base OpenAPI document. Never mutated.
        overlays: ``(label, overlay_document)`` pairs in application order; the
            label (typically the member path) is what provenance and findings name.

    Returns:
        The :class:`OverlayApplication` with the resolved document, provenance,
        and findings.

    Raises:
        ImportSourceError: When an overlay declares a version other than 1.x
            (``FORMAT_VERSION_UNSUPPORTED``) or has no usable ``actions`` array
            (``INPUT_SEMANTIC_INVALID``) — a structurally invalid overlay document
            is a failed import, unlike an individual action that misses.
    """
    result = OverlayApplication(document=copy.deepcopy(dict(base)))
    for label, overlay in overlays:
        version = overlay_version(overlay)
        if version is None or not _OVERLAY_VERSION_RE.match(version):
            raise ImportSourceError(
                f"Overlay {label!r} declares overlay version {version!r}, but only "
                "Overlay 1.x documents are supported.",
                code="FORMAT_VERSION_UNSUPPORTED",
            )
        actions = overlay.get("actions")
        if not isinstance(actions, list) or not actions:
            raise ImportSourceError(
                f"Overlay {label!r} has no `actions` array; an Overlay document "
                "must declare at least one action.",
                code="INPUT_SEMANTIC_INVALID",
            )
        for index, action in enumerate(actions):
            _apply_action(result, label, index, action)
        result.applied.append(label)

    result.provenance_total = len(result.provenance)
    if len(result.provenance) > MAX_PROVENANCE_RECORDS:
        result.provenance = result.provenance[:MAX_PROVENANCE_RECORDS]
        result.provenance_truncated = True
    return result


def overlay_lint_findings(report: Mapping[str, Any]) -> List[Any]:
    """Adapt an overlay report's findings into intake lint findings.

    Returns SPI :class:`app.import_source.LintFinding` objects (imported lazily so
    this pure module stays off the SPI's import path), one per overlay finding,
    under the registered ``intake.overlay-*`` rules
    (:mod:`app.intake_lint_rules`) — warnings by default, promotable per tenant
    through the style guide like any registered rule.

    Args:
        report: The ``overlay`` extras block (:meth:`OverlayApplication.report`).

    Returns:
        The lint findings; empty when the report carries no findings.
    """
    from .import_source import LintFinding
    from .intake_lint_rules import (
        RULE_OVERLAY_ACTION_INVALID,
        RULE_OVERLAY_UNMATCHED_TARGET,
    )

    rules = {
        FINDING_UNMATCHED_TARGET: RULE_OVERLAY_UNMATCHED_TARGET,
        FINDING_ACTION_INVALID: RULE_OVERLAY_ACTION_INVALID,
    }
    findings: List[Any] = []
    for raw in report.get("findings") or []:
        if not isinstance(raw, Mapping):
            continue
        rule = rules.get(str(raw.get("code")), RULE_OVERLAY_ACTION_INVALID)
        target = str(raw.get("target") or "")
        findings.append(
            LintFinding(
                path=target or "#",
                rule=rule,
                severity="warning",
                category="structure",
                message=str(raw.get("message") or "Overlay action could not be applied."),
            )
        )
    return findings


# ---------------------------------------------------------------------------
# Action application
# ---------------------------------------------------------------------------


def _apply_action(
    result: OverlayApplication, overlay: str, index: int, action: Any
) -> None:
    """Apply one Overlay action, recording provenance and findings on ``result``."""

    def _finding(code: str, target: str, message: str) -> None:
        result.findings.append(
            OverlayFinding(
                code=code,
                overlay=overlay,
                action_index=index,
                target=target,
                message=message,
            )
        )

    if not isinstance(action, Mapping):
        _finding(
            FINDING_ACTION_INVALID,
            "",
            f"Action #{index} of overlay {overlay!r} is not an object.",
        )
        return
    target = action.get("target")
    if not isinstance(target, str) or not target.strip():
        _finding(
            FINDING_ACTION_INVALID,
            "",
            f"Action #{index} of overlay {overlay!r} has no `target` expression.",
        )
        return
    remove = action.get("remove", False)
    if not isinstance(remove, bool):
        _finding(
            FINDING_ACTION_INVALID,
            target,
            f"Action #{index} of overlay {overlay!r} has a non-boolean `remove` value.",
        )
        return
    if not remove and "update" not in action:
        _finding(
            FINDING_ACTION_INVALID,
            target,
            f"Action #{index} of overlay {overlay!r} declares neither `update` nor "
            "`remove: true`, so it can have no effect.",
        )
        return

    # The custom-rule DSL's parser: Spectral-compatible `[*]` wildcards, cached.
    from .custom_rule_dsl import parse_jsonpath_expression

    try:
        expression = parse_jsonpath_expression(target)
    except Exception as exc:  # noqa: BLE001 - jsonpath-ng raises bare Exception subclasses
        _finding(
            FINDING_ACTION_INVALID,
            target,
            f"Target {target!r} of overlay {overlay!r} is not a valid JSONPath "
            f"expression: {exc}.",
        )
        return
    try:
        matches = expression.find(result.document)
    except Exception as exc:  # noqa: BLE001 - evaluation faults must become findings
        _finding(
            FINDING_ACTION_INVALID,
            target,
            f"Target {target!r} of overlay {overlay!r} could not be evaluated: {exc}.",
        )
        return
    if not matches:
        _finding(
            FINDING_UNMATCHED_TARGET,
            target,
            f"Target {target!r} of overlay {overlay!r} (action #{index}) matched "
            "nothing in the document; the action was not applied.",
        )
        return
    if len(matches) > MAX_MATCHES_PER_ACTION:
        _finding(
            FINDING_ACTION_INVALID,
            target,
            f"Target {target!r} of overlay {overlay!r} selected {len(matches)} nodes, "
            f"above the {MAX_MATCHES_PER_ACTION}-node ceiling; only the first "
            f"{MAX_MATCHES_PER_ACTION} were modified.",
        )
        matches = matches[:MAX_MATCHES_PER_ACTION]

    def _record(pointer: str, kind: str) -> None:
        result.provenance.append(
            OverlayProvenanceRecord(
                pointer=pointer,
                kind=kind,
                overlay=overlay,
                action_index=index,
                target=target,
            )
        )

    if remove:
        _remove_matches(matches, _record, _finding, target, overlay)
        return
    for datum in matches:
        _update_match(datum, action.get("update"), _record, _finding, target, overlay)


def _remove_matches(matches, record, finding, target: str, overlay: str) -> None:
    """Remove every matched node from its parent container.

    Dict members are deleted directly; list elements are collected per parent list
    and deleted in descending index order, since removing a lower index first would
    shift every later match's position.
    """
    list_removals: Dict[int, Tuple[list, List[Tuple[int, str]]]] = {}
    for datum in matches:
        parent = datum.context
        if parent is None:
            finding(
                FINDING_ACTION_INVALID,
                target,
                f"Target {target!r} of overlay {overlay!r} selects the document "
                "root, which cannot be removed.",
            )
            continue
        pointer = _pointer_for(datum)
        container = parent.value
        step = _path_step(datum)
        if isinstance(container, dict) and isinstance(step, str):
            if step in container:
                del container[step]
                record(pointer, "removed")
        elif isinstance(container, list) and isinstance(step, int):
            entry = list_removals.setdefault(id(container), (container, []))
            entry[1].append((step, pointer))
        else:  # pragma: no cover - jsonpath-ng only yields dict/list parents
            finding(
                FINDING_ACTION_INVALID,
                target,
                f"Target {target!r} of overlay {overlay!r} selects a node whose "
                "parent is not a container; it cannot be removed.",
            )
    for container, entries in list_removals.values():
        for step, pointer in sorted(entries, reverse=True):
            if 0 <= step < len(container):
                del container[step]
                record(pointer, "removed")


def _update_match(datum, update: Any, record, finding, target: str, overlay: str) -> None:
    """Apply one action's ``update`` value to one matched node (Overlay 1.0)."""
    node = datum.value
    pointer = _pointer_for(datum)
    if isinstance(node, dict):
        if not isinstance(update, Mapping):
            finding(
                FINDING_ACTION_INVALID,
                target,
                f"Target {target!r} of overlay {overlay!r} selects an object, so its "
                "`update` value must be an object to merge (Overlay 1.0).",
            )
            return
        _merge_object(node, update, pointer, record)
        return
    if isinstance(node, list):
        node.append(copy.deepcopy(update))
        record(f"{pointer}/{len(node) - 1}", "appended")
        return
    parent = datum.context
    step = _path_step(datum)
    if parent is None or step is None:  # pragma: no cover - the root is always a mapping
        finding(
            FINDING_ACTION_INVALID,
            target,
            f"Target {target!r} of overlay {overlay!r} selects a value that cannot "
            "be replaced in place.",
        )
        return
    parent.value[step] = copy.deepcopy(update)
    record(pointer, "replaced")


def _merge_object(node: Dict[str, Any], update: Mapping[str, Any], pointer: str, record) -> None:
    """Deep-merge ``update`` into ``node``, recording one record per changed leaf.

    Overlay 1.0 structured merge: nested objects merge recursively; every other
    update value (primitives **and arrays**) replaces the existing value outright.
    """
    for key, value in update.items():
        child_pointer = f"{pointer}/{_escape_pointer_token(str(key))}"
        existing = node.get(key)
        if isinstance(value, Mapping) and isinstance(existing, dict):
            _merge_object(existing, value, child_pointer, record)
            continue
        kind = "set" if key not in node else "replaced"
        node[key] = copy.deepcopy(value)
        record(child_pointer, kind)


# ---------------------------------------------------------------------------
# JSON Pointer derivation
# ---------------------------------------------------------------------------


def _escape_pointer_token(token: str) -> str:
    """Escape one JSON Pointer reference token (RFC 6901: ``~`` → ``~0``, ``/`` → ``~1``)."""
    return token.replace("~", "~0").replace("/", "~1")


def _path_step(datum) -> Any:
    """The dict key (str) or list index (int) of a datum inside its parent, or ``None``."""
    from jsonpath_ng import Fields, Index

    path = datum.path
    if isinstance(path, Fields) and path.fields:
        return path.fields[0]
    if isinstance(path, Index):
        index = getattr(path, "index", None)
        if isinstance(index, int):
            return index
        # jsonpath-ng >= 1.7 stores a tuple in `indices`.
        indices = getattr(path, "indices", None)
        if isinstance(indices, (tuple, list)) and indices:
            return indices[0]
    return None


def _pointer_for(datum) -> str:
    """Build the RFC 6901 JSON Pointer for a jsonpath-ng match datum.

    Walks the datum's context chain to the root, collecting each step's dict key or
    list index. The root document itself yields ``""`` (the whole-document pointer).
    """
    tokens: List[str] = []
    current = datum
    while current is not None and current.context is not None:
        step = _path_step(current)
        if step is None:
            break
        tokens.append(_escape_pointer_token(str(step)))
        current = current.context
    return "".join(f"/{token}" for token in reversed(tokens))
