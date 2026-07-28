"""Shared projection status + reason vocabulary — EFP-1.1/1.2 (#4810, #4811), CPDO-1.3 (#4800).

The export-fidelity surface classifies every construct's fate in a target with a
:class:`ProjectionStatus` and, when it is not preserved, the *cause category* with a
:class:`ProjectionReason`. Both enums live here, in a dependency-free module, because
several collaborators need them without importing each other:

* :mod:`app.export_projection` builds the projection manifest whose edges carry a
  status + reason;
* :mod:`app.capability_registry` (EFP-1.2) keys its reviewed explanation templates
  and documentation anchors by reason code, and validates that no manifest ever uses
  a reason code the registry does not know; and
* :mod:`app.conversion_projection` (CPDO-1.3) builds the *catalog → OpenAPI*
  conversion manifest, whose edges carry a :class:`ConversionStatus` and the **same**
  :class:`ProjectionReason` codes, so one reason vocabulary explains a loss whether it
  happened on the export side or the conversion side.

:mod:`app.export_projection` re-exports :class:`ProjectionStatus` /
:class:`ProjectionReason`, so ``from app.export_projection import ProjectionStatus,
ProjectionReason`` keeps working.
"""

from __future__ import annotations

from enum import Enum

__all__ = ["ProjectionStatus", "ProjectionReason", "ConversionStatus"]


class ProjectionStatus(str, Enum):
    """The fate of one construct when projected onto a target format (EFP-1.1).

    The four outcomes the :class:`~app.lossiness.LossinessReport` produces map
    one-to-one onto the first four members; the last three extend the vocabulary for
    richer emitter rule packs and the capability registry (EFP-1.2), and are never
    produced by the default report-driven build.
    """

    RETAINED = "retained"  # source meaning represented without material change (← ok)
    TRANSFORMED = "transformed"  # meaning survives a documented target transformation
    APPROXIMATED = "approximated"  # related construct, but not all semantics kept (← approx)
    SYNTHESIZED = "synthesized"  # content invented for target conventions (← synth)
    DROPPED = "dropped"  # the construct is not emitted (← drop)
    UNAVAILABLE = "unavailable"  # apiome cannot reliably inspect/expose the source data
    NOT_APPLICABLE = "not-applicable"  # the construct does not apply to this target/source


class ProjectionReason(str, Enum):
    """The cause *category* of a non-preserved :class:`ProjectionStatus` (EFP-1.1).

    A destination limitation (``destination_unsupported``) must never be claimed when
    the real cause is apiome's emitter (``emitter_unsupported``) or its source
    analysis (``source_incomplete`` / ``source_parse_limit``). EFP-1.2's capability
    registry keys its reviewed explanation and documentation templates by these codes,
    so the taxonomy is the single source of truth for what a valid reason code is.
    """

    DESTINATION_UNSUPPORTED = "destination_unsupported"
    EMITTER_UNSUPPORTED = "emitter_unsupported"
    SOURCE_INCOMPLETE = "source_incomplete"
    SOURCE_PARSE_LIMIT = "source_parse_limit"
    OPTION_EXCLUDED = "option_excluded"
    SECURITY_REDACTED = "security_redacted"
    TARGET_TOOL_UNAVAILABLE = "target_tool_unavailable"
    NOT_APPLICABLE = "not_applicable"


class ConversionStatus(str, Enum):
    """The fate of one source construct when converted to OpenAPI (CPDO-1.3).

    The conversion side answers a narrower question than the export side — there is
    exactly one destination (OpenAPI 3.1) and the authority on what survived is the
    :class:`~app.fidelity.FidelityReport`, not a capability profile — so it carries its
    own status vocabulary rather than reusing :class:`ProjectionStatus`. The first five
    members are in bijection with the report's :class:`~app.fidelity.Coverage` tags
    (``present``/``inferred``/``partial``/``missing``/``n-a``), which is what lets a
    manifest reconcile construct-for-construct with the report it was built from.

    :attr:`UNAVAILABLE` is the sixth, and has no coverage counterpart on purpose: it is
    the honest answer when apiome *cannot determine* a construct's fate — the emitted
    document has no addressable location for it, or the source analysis that would name
    it was bounded or never produced. It is never used to mean "dropped": a construct
    proven absent is :attr:`DROPPED`, a construct whose whereabouts are unknown is
    :attr:`UNAVAILABLE`, and conflating them would let the manifest claim a loss it has
    not established.
    """

    RETAINED = "retained"  # carried faithfully from the source (← coverage present)
    TRANSFORMED = "transformed"  # partly faithful, partly derived (← coverage partial)
    INFERRED = "inferred"  # emitted, but derived by the conversion (← coverage inferred)
    DROPPED = "dropped"  # the source construct is not in the emitted document (← missing)
    UNAVAILABLE = "unavailable"  # apiome cannot determine the construct's fate
    NOT_APPLICABLE = "not-applicable"  # no counterpart for this source/target (← n/a)
