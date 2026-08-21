"""Fidelity rule-pack SPI — MFX-2.3 (#3840).

The fidelity engine (:mod:`app.fidelity_engine`, MFX-2.2) walks a
:class:`~app.canonical_model.CanonicalApi` construct by construct and predicts each
construct's fate — ``OK`` / ``APPROX`` / ``DROP`` / ``SYNTH`` — when exporting to a
target format. *How* a given construct degrades, though, is **per target**: a
discriminated union survives to OpenAPI but drops to Avro; a numeric range is
enforced by JSON Schema but demoted to a doc comment in Protobuf; a field number is
native to Protobuf, synthesized for a REST source, and carried as a vendor
extension by OpenAPI. Those rules must be **pluggable per emitter**, not wired into
one engine — this module is that seam.

A :class:`FidelityRulePack` is the service-provider contract that maps canonical
constructs → target handling. It is the single place a target's degradation rules
live, so a format epic **ships its pack alongside its emitter** (an emitter exposes
it via :meth:`app.emitter.Emitter.fidelity_rule_pack`) and the engine consumes
whichever pack the target declares, falling back to the profile-derived default.

**Three layers**

* :class:`FidelityVerdict` — the value type: one ``(kind, severity, message,
  target_mapping)`` outcome for one construct. Its classmethods (:meth:`~FidelityVerdict.ok`,
  :meth:`~FidelityVerdict.drop`, :meth:`~FidelityVerdict.approx`,
  :meth:`~FidelityVerdict.synth`) name the four :class:`~app.lossiness.LossinessKind`
  outcomes so a pack reads declaratively.

* :class:`FidelityRulePack` — the SPI: an abstract oracle bound to a
  (:class:`~app.emitter.CapabilityProfile`, target label) pairing that answers five
  questions — one verdict per operation, per channel, and per named type, zero or
  more per record field (a field can incur several independent losses at once), and
  zero or more for the artifact root (the document envelope a target without a title
  field cannot carry).
  It owns the deterministic drive loop (:meth:`~FidelityRulePack.evaluate`) that
  walks a model and assembles a :class:`~app.lossiness.LossinessReport`, so a
  concrete pack only writes the *decisions*.

* :class:`CapabilityRulePack` — the reference default: it derives every verdict
  from the target's six-axis :class:`~app.emitter.CapabilityProfile` alone (the
  logic the engine shipped with in MFX-2.2). It is what the engine uses when a
  target declares no pack, and the class a format epic subclasses to refine
  individual verdicts (a richer ``target_mapping``, a downgraded severity, a
  ``DROP`` upgraded to a lossless ``APPROX``) while inheriting the rest. Its
  per-aspect field helpers (:meth:`~CapabilityRulePack._nullability_verdict` and
  siblings) are the fine-grained override points.

A pack is **pure and deterministic**: given the same model it returns an equal
report, performs no I/O, and (because :class:`~app.lossiness.LossinessReport` sorts
on build) is insensitive to the order the walk visits constructs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional

from pydantic import BaseModel, ConfigDict

from .canonical_model import (
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    Operation,
    OperationKind,
    Type,
    TypeKind,
)
from .emitter import CapabilityProfile
from .lossiness import (
    LossinessKind,
    LossinessReport,
    LossinessReportBuilder,
    LossinessSeverity,
)

__all__ = [
    "ROOT_CONSTRUCT_KEY",
    "FidelityVerdict",
    "FidelityRulePack",
    "CapabilityRulePack",
]

#: The canonical construct key of the artifact **root** — its title, version,
#: identity and servers. It is the empty string because that is the key the root
#: entity carries in a :func:`~app.import_source.canonical_diff`, so a root verdict
#: recorded here reconciles against a ``changed root ''`` difference. Kept as a named
#: constant so a pack never has to spell the bare ``""`` and wonder what it means.
ROOT_CONSTRUCT_KEY = ""


# Operation kinds whose representability depends on the target's *event* capability
# rather than its *operation* capability: a publish/subscribe operation is an event
# flow, so it survives only on a target that can carry events (AsyncAPI, Kafka), not
# merely one that can carry request/response operations.
_EVENT_OPERATION_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})


def _has_any_constraint(constraints: Optional[Constraints]) -> bool:
    """Return ``True`` when ``constraints`` carries at least one set validation facet.

    A :class:`~app.canonical_model.Constraints` with every field ``None`` (or a
    ``None`` constraints object) expresses no validation and so is nothing for a
    target to lose. The ``extras`` bag is ignored — it holds format-specific facets
    the canonical constraint vocabulary does not model, whose portability the
    capability profile does not describe.

    Args:
        constraints: The canonical constraints to inspect, or ``None``.

    Returns:
        ``True`` if any first-class constraint facet (minimum, pattern, format, …)
        is set; ``False`` for ``None`` or an all-empty constraints object.
    """
    if constraints is None:
        return False
    facets = constraints.model_dump(exclude={"extras"}, exclude_none=True)
    return bool(facets)


class FidelityVerdict(BaseModel):
    """One construct's predicted outcome under a target's rule pack.

    The value a :class:`FidelityRulePack` returns for a single construct: *what*
    happened (:class:`~app.lossiness.LossinessKind`), *how much it matters*
    (:class:`~app.lossiness.LossinessSeverity`), a human ``message``, and an
    optional ``target_mapping`` describing how the construct landed in the target
    when it was not dropped. It carries no construct key — the engine attaches the
    canonical key of whatever construct produced the verdict when it records the
    matching :class:`~app.lossiness.LossItem`, so a pack stays focused on the
    decision, not on report bookkeeping.

    Frozen (immutable) so a shared "carried cleanly" verdict can be reused without a
    caller mutating it. The four classmethods name the outcomes so a pack reads as a
    table of decisions rather than a wall of keyword arguments.
    """

    model_config = ConfigDict(frozen=True)

    kind: LossinessKind
    severity: LossinessSeverity
    message: str
    target_mapping: Optional[str] = None

    @classmethod
    def ok(
        cls, message: str, target_mapping: Optional[str] = None
    ) -> "FidelityVerdict":
        """A clean carry (:attr:`~app.lossiness.LossinessKind.OK`), always ``info``."""
        return cls(
            kind=LossinessKind.OK,
            severity=LossinessSeverity.INFO,
            message=message,
            target_mapping=target_mapping,
        )

    @classmethod
    def drop(
        cls,
        message: str,
        severity: LossinessSeverity = LossinessSeverity.CRITICAL,
        target_mapping: Optional[str] = None,
    ) -> "FidelityVerdict":
        """A construct with no target representation (:attr:`~app.lossiness.LossinessKind.DROP`).

        Defaults to ``critical`` — a dropped construct is usually a semantic loss —
        but a pack passes ``info`` for a cosmetic drop (a source field number a
        non-identity target simply has nowhere to put).
        """
        return cls(
            kind=LossinessKind.DROP,
            severity=severity,
            message=message,
            target_mapping=target_mapping,
        )

    @classmethod
    def approx(
        cls,
        message: str,
        severity: LossinessSeverity = LossinessSeverity.WARN,
        target_mapping: Optional[str] = None,
    ) -> "FidelityVerdict":
        """An imperfect representation (:attr:`~app.lossiness.LossinessKind.APPROX`).

        Defaults to ``warn`` — the construct is carried but degraded (a constraint
        demoted to documentation, a non-null guarantee relaxed to optional).
        """
        return cls(
            kind=LossinessKind.APPROX,
            severity=severity,
            message=message,
            target_mapping=target_mapping,
        )

    @classmethod
    def synth(
        cls,
        message: str,
        severity: LossinessSeverity = LossinessSeverity.WARN,
        target_mapping: Optional[str] = None,
    ) -> "FidelityVerdict":
        """A value invented to satisfy the target (:attr:`~app.lossiness.LossinessKind.SYNTH`).

        Defaults to ``warn`` — the target *requires* something the source lacks (a
        protobuf field number), so the emitter must fabricate it.
        """
        return cls(
            kind=LossinessKind.SYNTH,
            severity=severity,
            message=message,
            target_mapping=target_mapping,
        )


class FidelityRulePack(ABC):
    """Service-provider contract mapping canonical constructs → target handling.

    A rule pack is bound at construction to one (target
    :class:`~app.emitter.CapabilityProfile`, human target label) pairing and answers
    four questions the fidelity engine asks as it walks a model:

    * :meth:`operation_verdict` — one verdict per operation;
    * :meth:`channel_verdict` — one verdict per event channel;
    * :meth:`type_verdict` — one verdict per named type (the *container* for a
      record; the whole type for a union / scalar / enum / map / alias);
    * :meth:`field_verdicts` — **zero or more** verdicts per record field, because a
      single field can incur several independent losses at once (a required,
      constrained field on a target lacking both nullability and constraints);
    * :meth:`root_verdicts` — **zero or more** verdicts for the artifact *root*, the
      one canonical entity that is not a construct inside a service: the title,
      version, servers and identity a document envelope carries. It defaults to no
      verdicts, so only a target that genuinely cannot carry the envelope (a Kong
      declarative file, an ``HTTPRoute`` manifest, a request file, a tool array —
      none of which has a title field) declares one.

    The base class owns the deterministic drive loop (:meth:`evaluate`) that visits
    every construct, calls these hooks, and assembles a sorted
    :class:`~app.lossiness.LossinessReport` — so a concrete pack writes only the
    per-construct *decisions*, never report plumbing. Subclasses register their
    behaviour by overriding the hooks; most format epics subclass
    :class:`CapabilityRulePack` (the profile-derived default) and override only the
    verdicts their target handles specially.

    A pack must be **pure and deterministic**: no I/O, and the same model yields an
    equal report. Because the report sorts its items on build, a pack need not visit
    constructs in any particular order.

    Attributes:
        profile: The target's static capability profile (available to subclasses as
            ``self.profile`` for profile-driven decisions).
        target_label: Human label for the target woven into verdict messages.
    """

    def __init__(
        self, profile: CapabilityProfile, target_label: str = "the target"
    ) -> None:
        """Bind the pack to one (profile, target label) pairing.

        Args:
            profile: The target emitter's static :class:`~app.emitter.CapabilityProfile`.
            target_label: Human label for the target woven into verdict messages
                (e.g. "OpenAPI 3.1", "Protobuf"); cosmetic — it never affects a kind
                or severity.
        """
        self.profile = profile
        self.target_label = target_label

    # --- override points ----------------------------------------------------

    def root_verdicts(self, api: CanonicalApi) -> List[FidelityVerdict]:
        """Return every loss the artifact *root* incurs (possibly none).

        The root is the artifact's document envelope — its title, version, identity
        and servers — the one canonical entity that lives outside every service.
        Most destinations have a document envelope of their own and carry it, so the
        default is **no verdicts at all**: a target says nothing about the root
        unless it has something to say. A target whose file format has nowhere to put
        the envelope (a Kong declarative configuration, a Gateway API ``HTTPRoute``
        manifest, an HTTP request file, an LLM tool array — none of which has a title
        field) overrides this to declare the loss *before* an emit runs, rather than
        leaving a re-import to silently rename the model after the file it read.

        Verdicts are recorded under :data:`ROOT_CONSTRUCT_KEY` (the empty string),
        which is the canonical key the root entity carries in a
        :func:`~app.import_source.canonical_diff`.

        Args:
            api: The source canonical model to be exported. Never mutated.

        Returns:
            Zero or more verdicts for the artifact root; ``[]`` by default.
        """
        return []

    @abstractmethod
    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Return the verdict for one operation (request/response, pub/sub, …)."""
        raise NotImplementedError

    @abstractmethod
    def channel_verdict(self, channel: Channel) -> FidelityVerdict:
        """Return the verdict for one event channel."""
        raise NotImplementedError

    @abstractmethod
    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """Return the verdict for one named type.

        For a :attr:`~app.canonical_model.TypeKind.RECORD` this is the verdict for
        the record *container* only; the engine records it, then asks
        :meth:`field_verdicts` for each of the record's fields.
        """
        raise NotImplementedError

    @abstractmethod
    def field_verdicts(self, field: CanonicalField) -> List[FidelityVerdict]:
        """Return every representational loss one record field incurs (possibly none)."""
        raise NotImplementedError

    # --- drive loop ---------------------------------------------------------

    def evaluate(self, api: CanonicalApi) -> LossinessReport:
        """Walk ``api`` construct by construct and assemble its fidelity report.

        The concrete drive loop shared by every pack: it visits the artifact root,
        then operations, then channels, then named types (descending into each
        record's fields), records one :class:`~app.lossiness.LossItem` per verdict
        keyed by the construct's own canonical ``key``, and returns the finished
        report. The report sorts its items into a stable canonical order on build,
        so this walk order does not affect the output.

        Args:
            api: The source canonical model to be exported. Never mutated.

        Returns:
            The predicted :class:`~app.lossiness.LossinessReport` for the export.
        """
        builder = LossinessReportBuilder()
        self._record(builder, ROOT_CONSTRUCT_KEY, self.root_verdicts(api))
        for operation in api.operations():
            self._record(builder, operation.key, [self.operation_verdict(operation)])
        for channel in api.channels:
            self._record(builder, channel.key, [self.channel_verdict(channel)])
        for type_ in api.types:
            self._record(builder, type_.key, [self.type_verdict(type_)])
            if type_.kind is TypeKind.RECORD:
                for field in type_.fields:
                    self._record(builder, field.key, self.field_verdicts(field))
        return builder.build()

    @staticmethod
    def _record(
        builder: LossinessReportBuilder,
        construct_key: str,
        verdicts: List[FidelityVerdict],
    ) -> None:
        """Record each verdict as a :class:`~app.lossiness.LossItem` under ``construct_key``."""
        for verdict in verdicts:
            builder.add(
                construct_key,
                verdict.kind,
                verdict.severity,
                verdict.message,
                verdict.target_mapping,
            )


class CapabilityRulePack(FidelityRulePack):
    """Reference rule pack: verdicts derived from the target's capability profile.

    The default the engine uses when a target declares no custom pack, and the base
    a format epic subclasses to refine individual verdicts. Every decision reads off
    the six boolean axes of the target's :class:`~app.emitter.CapabilityProfile`
    (operations, events, unions, nullability, constraints, field identity) — exactly
    the logic the fidelity engine shipped with in MFX-2.2, now relocated behind the
    SPI so a target can override it construct by construct.

    Per-construct behaviour:

    * **operations** — ``OK`` when the target supports the needed axis (``events``
      for publish/subscribe, ``operations`` otherwise), else a critical ``DROP``;
    * **channels** — ``OK`` when ``events``, else a critical ``DROP``;
    * **unions** — ``OK`` when ``unions``, else a critical ``DROP``;
    * **scalars** — ``OK``, or ``APPROX`` when they carry constraints the target
      can't enforce;
    * **records** — the container is ``OK``; each field is inspected by three
      independent aspect helpers (:meth:`_nullability_verdict`,
      :meth:`_constraints_verdict`, :meth:`_field_identity_verdict`) — the
      fine-grained override points for a subclass;
    * **enum / map / alias** — ``OK`` everywhere the canonical model can name them;
    * **root** — no verdict. The six capability axes say nothing about a document
      envelope, so the profile-derived default cannot honestly claim one is lost;
      only a target that knows its file format has no title field declares it.
    """

    # --- operations & channels ---------------------------------------------

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """``OK`` when the target can carry the operation, else a critical ``DROP``.

        A publish/subscribe operation needs the target's *event* capability; every
        other kind needs its *operation* capability. When the needed capability is
        absent the whole operation — parameters, messages, and all — is
        unrepresentable, so it is a single critical ``DROP`` (an operation-bearing
        API exported to a types-only target loses every operation this way).
        """
        needs_events = operation.kind in _EVENT_OPERATION_KINDS
        supported = self.profile.events if needs_events else self.profile.operations
        if supported:
            return FidelityVerdict.ok(
                message=f"operation carried to {self.target_label}"
            )
        axis = "event operations" if needs_events else "operations"
        return FidelityVerdict.drop(
            message=f"{self.target_label} cannot represent {axis}; the operation is dropped",
        )

    def channel_verdict(self, channel: Channel) -> FidelityVerdict:
        """``OK`` when the target carries ``events``, else a critical ``DROP``."""
        if self.profile.events:
            return FidelityVerdict.ok(
                message=f"event channel carried to {self.target_label}"
            )
        return FidelityVerdict.drop(
            message=f"{self.target_label} cannot represent event channels; "
            "the channel is dropped",
        )

    # --- types --------------------------------------------------------------

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """Dispatch a named type to the verdict for its :class:`~app.canonical_model.TypeKind`."""
        if type_.kind is TypeKind.UNION:
            return self._union_verdict(type_)
        if type_.kind is TypeKind.SCALAR:
            return self._scalar_verdict(type_)
        if type_.kind is TypeKind.RECORD:
            # The container is always carried; the potential losses are per field,
            # which the drive loop collects via `field_verdicts`.
            return FidelityVerdict.ok(
                message=f"object carried to {self.target_label}"
            )
        # ENUM / MAP / ALIAS — representable wherever the model can name them.
        return FidelityVerdict.ok(
            message=f"{type_.kind.value} type carried to {self.target_label}"
        )

    def _union_verdict(self, type_: Type) -> FidelityVerdict:
        """``OK`` when the target carries ``unions``, else a critical ``DROP``.

        A discriminated union / one-of has no faithful representation on a target
        that cannot carry alternatives, so its variant semantics are lost.
        """
        if self.profile.unions:
            return FidelityVerdict.ok(
                message=f"union carried to {self.target_label}",
                target_mapping="one-of / discriminated alternatives",
            )
        return FidelityVerdict.drop(
            message=f"{self.target_label} cannot represent discriminated unions; "
            "the type's alternative semantics are dropped",
        )

    def _scalar_verdict(self, type_: Type) -> FidelityVerdict:
        """``OK``, or ``APPROX`` when the scalar carries constraints the target can't keep."""
        if not self.profile.constraints and _has_any_constraint(type_.constraints):
            return FidelityVerdict.approx(
                message=f"{self.target_label} cannot enforce validation constraints; "
                "they are demoted to documentation",
                target_mapping="constraints → doc comment",
            )
        return FidelityVerdict.ok(
            message=f"scalar carried to {self.target_label}"
        )

    # --- record fields ------------------------------------------------------

    def field_verdicts(self, field: CanonicalField) -> List[FidelityVerdict]:
        """Collect every independent loss one record field incurs.

        A field can incur more than one loss at once (a required, constrained field
        on a target lacking both nullability and constraints), so each aspect is a
        separate verdict. The three aspect helpers are the subclass override points;
        each returns ``None`` when its aspect is not lost.
        """
        verdicts: List[FidelityVerdict] = []
        for verdict in (
            self._nullability_verdict(field),
            self._constraints_verdict(field),
            self._field_identity_verdict(field),
        ):
            if verdict is not None:
                verdicts.append(verdict)
        return verdicts

    def _nullability_verdict(
        self, field: CanonicalField
    ) -> Optional[FidelityVerdict]:
        """``APPROX`` when the target can't express the field's non-null guarantee."""
        if not self.profile.nullability and field.type.nullable is False:
            return FidelityVerdict.approx(
                message=f"{self.target_label} cannot express a non-null guarantee; "
                "the field becomes optional",
                target_mapping="required/non-null → optional",
            )
        return None

    def _constraints_verdict(
        self, field: CanonicalField
    ) -> Optional[FidelityVerdict]:
        """``APPROX`` when the target can't enforce the field's validation constraints."""
        if not self.profile.constraints and _has_any_constraint(field.constraints):
            return FidelityVerdict.approx(
                message=f"{self.target_label} cannot enforce validation constraints; "
                "they are demoted to documentation",
                target_mapping="constraints → doc comment",
            )
        return None

    def _field_identity_verdict(
        self, field: CanonicalField
    ) -> Optional[FidelityVerdict]:
        """Reconcile the field's identity with the target's field-identity capability.

        A field number is **synthesized** (``SYNTH``) when the target requires stable
        numbers but the source field has none, and **dropped** (``DROP`` info) when
        the source carries a number a non-identity target cannot keep.
        """
        if self.profile.field_identity and field.field_number is None:
            return FidelityVerdict.synth(
                message=f"{self.target_label} requires stable field numbers; "
                "one is synthesized for this field",
                target_mapping="synthesized field number",
            )
        if not self.profile.field_identity and field.field_number is not None:
            return FidelityVerdict.drop(
                message=f"{self.target_label} has no stable field numbers; "
                "the source field number is dropped",
                severity=LossinessSeverity.INFO,
            )
        return None
