"""Arazzo emitter: canonical model → Arazzo workflow document.

**Version selection (FMT-3.1, #5426).** Arazzo has two readable minor versions, and the
emitter must not move a document between them behind the user's back. The version written
is, in order: the explicit :attr:`ArazzoEmitOptions.arazzo_version`; the version the model
was imported from (``extras.arazzo``); otherwise :func:`app.arazzo_spec.default_arazzo_version`,
which picks 1.1.0 only when the model declares an AsyncAPI source description — a construct
1.0 cannot express — and 1.0.1 otherwise. A 1.0 import therefore re-emits as 1.0, and a
1.1 import as 1.1, without either being silently upgraded or downgraded.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Union

import yaml
from pydantic import Field

from .arazzo_import_source import ArazzoImportSource
from .arazzo_normalizer import ARAZZO_FORMAT
from .arazzo_spec import (
    SOURCE_TYPE_ASYNCAPI,
    STEP_TARGET_FIELDS,
    ArazzoVersionError,
    default_arazzo_version,
    parse_arazzo_version,
    source_description_types,
    supports_async_sources,
    validate_arazzo_version,
)
from .canonical_model import ApiParadigm, CanonicalApi, OperationKind
from .import_source import DetectionInput
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
    "ArazzoEmitOptions",
    "ArazzoEmitter",
    "ArazzoFidelityRulePack",
    "validate_arazzo_document",
]

_EVENT_OPERATION_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})


class ArazzoFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for Arazzo export."""

    target_label = "Arazzo"

    def event_verdict(self, event) -> FidelityVerdict:
        return FidelityVerdict.drop(
            message=f"{self.target_label} has no event/channel representation; event {event.key!r} is dropped",
            target_mapping="event → dropped",
        )

    def channel_verdict(self, channel) -> FidelityVerdict:
        return FidelityVerdict.drop(
            message=f"{self.target_label} has no event/channel representation; channel {channel.key!r} is dropped",
            target_mapping="channel → dropped",
        )


class ArazzoEmitOptions(EmitOptions):
    """Per-target options for :class:`ArazzoEmitter`."""

    pretty_print: bool = Field(
        default=True,
        description="Pretty-print the generated Arazzo YAML document.",
    )
    arazzo_version: Optional[str] = Field(
        default=None,
        description=(
            "Arazzo specification version to write (1.0.x or 1.1.x). Defaults to the "
            "version the model was imported from, falling back to 1.1.0 when the model "
            "uses an AsyncAPI source description and 1.0.1 otherwise."
        ),
    )


class ArazzoEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as an Arazzo workflow description."""

    key = "arazzo"
    format = ARAZZO_FORMAT
    label = "Arazzo"
    description = "Export as an Arazzo workflow description (.yaml)."
    icon = "workflow"
    paradigm = ApiParadigm.REST
    multi_file = False
    options_model = ArazzoEmitOptions

    OUTPUT_MEDIA_TYPE = "application/yaml"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        return CapabilityProfile(
            operations=True,
            events=False,
            unions=False,
            nullability=True,
            field_identity=True,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        return ArazzoFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[ArazzoEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        options = (
            opts
            if isinstance(opts, ArazzoEmitOptions)
            else ArazzoEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        writer = _ArazzoWriter(api, options)
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


class _ArazzoWriter:
    def __init__(self, api: CanonicalApi, options: ArazzoEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self.output_path = _output_path(api)
        self.version = self._target_version()

    def _has_async_sources(self) -> bool:
        """Whether the model declares an AsyncAPI source description (1.1 only)."""
        if self._api.extras.get("asyncSources"):
            return True
        source_types = self._api.extras.get("sourceTypes")
        if isinstance(source_types, dict):
            return SOURCE_TYPE_ASYNCAPI in source_types.values()
        return SOURCE_TYPE_ASYNCAPI in source_description_types(
            self._api.extras.get("sourceDescriptions")
        ).values()

    def _target_version(self) -> str:
        """Decide which Arazzo version to write.

        Returns:
            The version string for the document's ``arazzo`` marker: the caller's
            explicit option when given, else the model's own imported version, else the
            default for its source types.

        Raises:
            ValueError: When the explicit option is not a version this emitter writes.
        """
        requested = self._options.arazzo_version
        if isinstance(requested, str) and requested.strip():
            try:
                validate_arazzo_version(requested)
            except ArazzoVersionError as exc:
                raise ValueError(f"Invalid `arazzo_version` export option: {exc}") from exc
            return requested.strip()
        imported = self._api.extras.get("arazzo")
        if isinstance(imported, str) and imported.strip():
            try:
                validate_arazzo_version(imported)
            except ArazzoVersionError:
                # An unreadable marker cannot have come from this importer; fall through
                # to the default rather than writing a version nothing can consume.
                pass
            else:
                return imported.strip()
        return default_arazzo_version(has_async_sources=self._has_async_sources())

    def _record_version_losses(self) -> None:
        """Record what the chosen version cannot carry.

        Writing 1.0 for a model that uses an AsyncAPI source description drops the
        sync/async pairing that only Arazzo 1.1 can express. That only happens when the
        caller asked for 1.0 explicitly, and it is recorded rather than silently done.
        """
        if not self._has_async_sources():
            return
        try:
            version = parse_arazzo_version(self.version)
        except ArazzoVersionError:
            return
        if supports_async_sources(version):
            return
        self.losses.record(
            LossKind.NA,
            "async-sources-need-1-1",
            f"Arazzo {self.version} has no AsyncAPI source description; the model's "
            "asynchronous sources are written as-is but are not valid before 1.1.",
        )

    def render(self) -> str:
        document = self._source_document()
        if document is None:
            document = self._rebuild_document()
            self.losses.record(
                LossKind.INFERRED,
                "rebuilt-from-canonical",
                "Arazzo export rebuilt from canonical services because the imported raw "
                "document was unavailable",
            )

        document["arazzo"] = self.version
        self._record_version_losses()

        if self._api.channels:
            self.losses.record(
                LossKind.NA,
                "channels-dropped",
                "Arazzo export has no event/channel representation; channels are omitted",
            )

        self.tracker.record(self._api.identity.name or "arazzo", Provenance.SOURCE)
        if self._options.pretty_print:
            return yaml.dump(document, sort_keys=False, default_flow_style=False, allow_unicode=True)
        return yaml.dump(document, default_flow_style=True, allow_unicode=True)

    def _source_document(self) -> Optional[Dict[str, Any]]:
        raw = self._api.raw
        if isinstance(raw, dict) and isinstance(raw.get("arazzo"), str) and raw.get("arazzo").strip():
            return dict(raw)
        return None

    def _rebuild_document(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "title": self._api.title or self._api.identity.name or "Untitled Workflow",
        }
        summary = self._api.extras.get("infoSummary")
        if isinstance(summary, str) and summary:
            # `info.summary` is a field of its own in Arazzo; the canonical model has no
            # column for it, so the normalizer parks it in extras (FMT-3.1, #5426).
            info["summary"] = summary
        if self._api.version:
            info["version"] = self._api.version
        if self._api.description:
            info["description"] = self._api.description

        document: Dict[str, Any] = {
            "arazzo": self.version,
            "info": info,
            "workflows": self._workflows_from_services(),
        }
        source_descriptions = self._api.extras.get("sourceDescriptions")
        if isinstance(source_descriptions, list) and source_descriptions:
            document["sourceDescriptions"] = source_descriptions
        components = self._api.extras.get("components")
        if isinstance(components, dict) and components:
            # Reusable `$ref` targets for inputs, parameters and success/failure actions.
            # Without them a rebuilt export would carry `$ref`s that resolve to nothing.
            document["components"] = components
        return document

    def _workflows_from_services(self) -> List[Dict[str, Any]]:
        workflows: List[Dict[str, Any]] = []
        # Source declaration order, recorded by the normalizer because the canonical model sorts
        # services by key. Emitting in document order keeps an orchestration readable and makes
        # the emit → re-import round trip reproduce the source ordering (REPO-3.4, #2773).
        services = sorted(
            self._api.services,
            key=lambda svc: (
                svc.extras.get("workflowIndex")
                if isinstance(svc.extras.get("workflowIndex"), int)
                else len(self._api.services),
                svc.key,
            ),
        )
        for service in services:
            workflow: Dict[str, Any] = {"workflowId": service.key}
            # `summary` and `description` are distinct fields in Arazzo. The normalizer keeps the
            # source `summary` in extras and maps `description or summary` onto the Service, so
            # emitting each from its own home round-trips both instead of collapsing a
            # description into a summary (REPO-3.4, #2773).
            summary = service.extras.get("summary")
            if isinstance(summary, str) and summary:
                workflow["summary"] = summary
            if service.description:
                workflow["description"] = service.description
            inputs = service.extras.get("inputs")
            if isinstance(inputs, dict):
                workflow["inputs"] = inputs
            depends_on = service.extras.get("dependsOn")
            if isinstance(depends_on, list) and depends_on:
                workflow["dependsOn"] = depends_on
            for key in ("successActions", "failureActions"):
                actions = service.extras.get(key)
                if isinstance(actions, list) and actions:
                    workflow[key] = actions
            outputs = service.extras.get("outputs")
            if isinstance(outputs, dict) and outputs:
                workflow["outputs"] = outputs

            step_order = service.extras.get("stepOrder")
            operations_by_step: Dict[str, Any] = {}
            for operation in service.operations:
                if operation.kind in _EVENT_OPERATION_KINDS:
                    continue
                step_id = operation.extras.get("stepId") or operation.name
                if isinstance(step_id, str) and step_id:
                    operations_by_step[step_id] = operation

            ordered_step_ids = (
                list(step_order)
                if isinstance(step_order, list)
                else list(operations_by_step.keys())
            )
            steps: List[Dict[str, Any]] = []
            for step_id in ordered_step_ids:
                if not isinstance(step_id, str) or not step_id:
                    continue
                operation = operations_by_step.get(step_id)
                if operation is None:
                    continue
                step = self._step_from_operation(operation, step_id)
                steps.append(step)
                self.tracker.record(operation.key, Provenance.SOURCE)
            workflow["steps"] = steps
            workflows.append(workflow)
        return workflows

    def _step_from_operation(self, operation, step_id: str) -> Dict[str, Any]:
        """Render one canonical operation as an Arazzo workflow step.

        Args:
            operation: The canonical operation the step is built from.
            step_id: The step's identifier within its workflow.

        Returns:
            The step mapping, carrying every Arazzo field the normalizer preserved plus,
            when the model names no call target of its own, a synthesized ``operationId``.
        """
        step: Dict[str, Any] = {"stepId": step_id}
        extras = operation.extras
        for key in (
            "operationId",
            "operationRef",
            # Arazzo 1.0.0's pointer spelling, and the step-calls-a-workflow target; both are
            # carried by the normalizer, so emitting them keeps the round trip lossless
            # (REPO-3.4, #2773).
            "operationPath",
            "workflowId",
            "dependsOn",
            "successCriteria",
            "parameters",
            "requestBody",
            "outputs",
            "onSuccess",
            "onFailure",
            "request",
            "when",
            "assertions",
        ):
            if key in extras and extras[key] is not None:
                step[key] = extras[key]
        if not any(key in step for key in STEP_TARGET_FIELDS):
            # An Arazzo step must name something to invoke, so a model that came from a
            # format with no operation identifier of its own (API Blueprint, a schema-only
            # source) would otherwise emit a workflow no runner — and no re-import — can
            # accept. The canonical operation key is that identity, so it is used and the
            # substitution is recorded rather than made silently (FMT-3.1, #5426).
            step["operationId"] = operation.key
            self.losses.record(
                LossKind.INFERRED,
                f"step-target:{operation.key}",
                "The source names no operation identifier for this step; the canonical "
                "operation key was written as the step's operationId so the workflow "
                "names something to invoke.",
            )
        if operation.description:
            step["description"] = operation.description
        return step


def _output_path(api: CanonicalApi) -> str:
    base = re.sub(r"[^\w\-]+", "-", (api.title or api.identity.name or "workflow").strip()) or "workflow"
    return f"{base.lower()}.arazzo.yaml"


def validate_arazzo_document(content: str) -> None:
    """Parse and validate that ``content`` is an Arazzo workflow document."""
    from .import_ingestion import IngestionError, parse_document

    try:
        document = parse_document(content)
    except IngestionError as exc:
        raise ValueError(str(exc)) from exc
    if not isinstance(document, dict):
        raise ValueError("Arazzo document must be a mapping.")
    detection = ArazzoImportSource().detect(DetectionInput(document=document))
    if not detection.matched:
        raise ValueError("Emitted content is not a recognizable Arazzo workflow document.")
    ArazzoImportSource().normalize(document)
