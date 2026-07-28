"""COBOL copybook emitter: canonical model → `.cpy` — MFX-31.1.

The inverse of :class:`app.cobolcopybook_normalizer.CobolCopybookNormalizer` and an implementation of
the :class:`app.emitter.Emitter` SPI.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Union

from pydantic import Field

from .canonical_model import ApiParadigm, CanonicalApi, OperationKind
from .cobolcopybook_parser import parse_cobolcopybook
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict

__all__ = [
    "CobolCopybookEmitOptions",
    "CobolCopybookEmitter",
    "CobolCopybookFidelityRulePack",
    "validate_cobolcopybook_document",
]

_EVENT_OPERATION_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})
_TYPES_ONLY_DROP_MESSAGE = "only data schemas are exported"

#: Last column of a fixed-format copybook's code area (columns 8-72; 1-6 are the sequence area and
#: 7 the indicator). A reader that honours the format — including this repo's own parser — stops at
#: this column, so a clause emitted past it is not merely ugly: it is silently truncated, and the
#: truncated text parses as a *different, shorter data name*.
_CODE_AREA_END = 72


def _fixed_format_entry(prefix: str, head: str, clauses: List[str]) -> List[str]:
    """Lay out one data-description entry inside the fixed-format code area.

    A COBOL entry ends at a period, not at a line break, so an entry too long for one line
    continues onto the next. Clauses are kept whole — a clause is never split across the boundary,
    because half of ``DEPENDING ON CUST-PHONE-COUNT`` is not a shorter clause, it is a wrong one.

    Args:
        prefix: The leading whitespace placing the entry in the code area.
        head: The entry's level and name (``05  CUST-PHONES``), which always starts the first line.
        clauses: The clauses to follow it, each already rendered.

    Returns:
        One or more source lines, the last of which carries the terminating period. A single clause
        longer than the code area is emitted on its own line rather than dropped — an over-long name
        is the source's problem, and truncating it here would invent a different one.
    """
    # Continuations indent past the name, which is how a hand-written copybook reads.
    continuation = " " * (len(prefix) + 15)
    lines: List[str] = []
    current = head if not prefix else f"{prefix}{head}"

    for clause in clauses:
        candidate = f"{current} {clause}"
        # +1 for the period this entry must still end with.
        if len(candidate) + 1 <= _CODE_AREA_END:
            current = candidate
            continue
        lines.append(current)
        current = f"{continuation}{clause}"

    lines.append(f"{current}.")
    return lines


class CobolCopybookFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for COBOL copybook export."""

    target_label = "COBOL copybook"

    def operation_verdict(self, operation) -> FidelityVerdict:
        return FidelityVerdict.drop(
            message=f"{self.target_label} is types-only — {_TYPES_ONLY_DROP_MESSAGE}; "
            f"the {operation.kind.value} operation is dropped",
            target_mapping="operation → dropped (types-only export)",
        )

    def channel_verdict(self, channel) -> FidelityVerdict:
        return FidelityVerdict.drop(
            message=f"{self.target_label} is types-only — {_TYPES_ONLY_DROP_MESSAGE}; "
            "the event channel is dropped",
            target_mapping="channel → dropped (types-only export)",
        )


class CobolCopybookEmitOptions(EmitOptions):
    """Per-target options for :class:`CobolCopybookEmitter`."""

    include_comments: bool = Field(
        default=True,
        description="Emit a header comment block in the generated copybook.",
    )


class CobolCopybookEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as a COBOL copybook (``.cpy``)."""

    key = "cobolcopybook"
    format = "cobolcopybook"
    label = "COBOL Copybook"
    description = "Export as a COBOL copybook record layout (.cpy)."
    icon = "file-code"
    paradigm = ApiParadigm.DATA_SCHEMA
    multi_file = False
    options_model = CobolCopybookEmitOptions

    OUTPUT_MEDIA_TYPE = "text/plain"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        return CapabilityProfile(
            operations=False,
            events=False,
            unions=False,
            nullability=False,
            field_identity=True,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        return CobolCopybookFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[CobolCopybookEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        options = (
            opts
            if isinstance(opts, CobolCopybookEmitOptions)
            else CobolCopybookEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        writer = _CobolCopybookWriter(api, options)
        content = writer.render()
        return EmitResult(
            files=[
                EmittedFile(
                    path=writer.output_path,
                    content=content,
                    media_type=self.OUTPUT_MEDIA_TYPE,
                )
            ],
            media_type=self.OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


class _CobolCopybookWriter:
    def __init__(self, api: CanonicalApi, options: CobolCopybookEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self._tree = api.extras.get("cobolcopybook_tree")
        self.output_path = _output_path(api)

    def render(self) -> str:
        if not isinstance(self._tree, dict):
            raise ValueError("COBOL copybook export requires `cobolcopybook_tree` extras from import")

        lines: List[str] = []
        if self._options.include_comments:
            title = self._api.identity.name or "Exported record"
            lines.extend(
                [
                    "      *****************************************************************",
                    f"      * Generated COBOL copybook for {title}",
                    "      *****************************************************************",
                ]
            )

        self._render_field(self._tree, lines=lines, indent=0)
        if self._api.services or self._api.channels:
            self.losses.record(
                LossKind.NA,
                "services-dropped",
                "COBOL copybook export is types-only; services and channels are omitted",
            )
        self.tracker.record(self._api.identity.name or "cobolcopybook", Provenance.SOURCE)
        return "\n".join(lines).rstrip() + "\n"

    def _render_field(self, node: Dict[str, Any], *, lines: List[str], indent: int) -> None:
        level = int(node.get("level", 1))
        name = str(node.get("name", "RECORD"))
        picture = node.get("picture")
        usage = node.get("usage")
        occurs_min = node.get("occurs_min")
        occurs_max = node.get("occurs_max")
        depending_on = node.get("depending_on")
        redefines = node.get("redefines")
        children = node.get("children") or []

        prefix = " " * 7 + " " * (indent * 4)
        clauses: List[str] = []
        # REDEFINES comes first, as COBOL requires: it qualifies the item's storage, and everything
        # after it describes that storage. Emitting it at all is CPDO-2.3 — without it an export
        # turns two overlays into two sequential items and silently changes the record's length.
        if isinstance(redefines, str) and redefines:
            clauses.append(f"REDEFINES {redefines}")
        if isinstance(picture, str) and picture:
            clauses.append(f"PIC {picture}")
        if isinstance(usage, str) and usage:
            clauses.append(usage)
        if occurs_max is not None:
            low = int(occurs_min or 1)
            high = int(occurs_max)
            clauses.append(f"OCCURS {low} TO {high} TIMES")
            if isinstance(depending_on, str) and depending_on:
                # Its own clause, so it wraps onto a continuation line whole rather than being cut
                # in half by the code-area boundary.
                clauses.append(f"DEPENDING ON {depending_on}")
        lines.extend(_fixed_format_entry(prefix, f"{level:02d}  {name}", clauses))

        for condition in node.get("conditions") or []:
            if not isinstance(condition, dict):
                continue
            cond_name = str(condition.get("name", "VALUE"))
            cond_value = str(condition.get("value", ""))
            lines.extend(
                _fixed_format_entry(
                    f"{prefix}    ", f"88  {cond_name:<24}", [f"VALUE '{cond_value}'"]
                )
            )

        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    self._render_field(child, lines=lines, indent=indent + 1)


def _output_path(api: CanonicalApi) -> str:
    root = api.extras.get("cobolcopybook_root")
    base = str(root) if isinstance(root, str) and root else api.identity.name or "record"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", base).strip("-") or "record"
    return f"{safe}.cpy"


def validate_cobolcopybook_document(content: str) -> None:
    """Validate COBOL copybook text by re-parsing it."""
    parse_cobolcopybook(content)
