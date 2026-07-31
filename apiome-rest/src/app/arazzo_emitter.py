"""Arazzo emitter: canonical model → Arazzo workflow document."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Union

import yaml
from pydantic import Field

from .arazzo_import_source import ArazzoImportSource
from .arazzo_normalizer import ARAZZO_FORMAT
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
        if self._api.version:
            info["version"] = self._api.version
        if self._api.description:
            info["description"] = self._api.description

        document: Dict[str, Any] = {
            "arazzo": self._api.extras.get("arazzo") or "1.0.1",
            "info": info,
            "workflows": self._workflows_from_services(),
        }
        source_descriptions = self._api.extras.get("sourceDescriptions")
        if isinstance(source_descriptions, list) and source_descriptions:
            document["sourceDescriptions"] = source_descriptions
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

    @staticmethod
    def _step_from_operation(operation, step_id: str) -> Dict[str, Any]:
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
