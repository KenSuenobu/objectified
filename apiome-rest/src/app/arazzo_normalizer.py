"""Arazzo → canonical model normalizer — MFI-30.2 (#4395), FMT-3.1 (#5426).

Maps a parsed **Arazzo** workflow document into a :class:`~app.canonical_model.CanonicalApi`:

* ``info`` → :class:`~app.canonical_model.ApiIdentity` + title/version/description;
* each ``workflow`` → a :class:`~app.canonical_model.Service` (``workflowId`` as key);
* each workflow ``step`` → an :class:`~app.canonical_model.Operation` keyed by
  ``{workflowId}#{stepId}`` with the referenced ``operationId`` / ``operationRef`` preserved
  in ``extras``;
* ``sourceDescriptions`` → the artifact root ``extras`` bag for fidelity and lint.

Workflow step order is captured on each service's ``extras.stepOrder`` so reordering diffs
at the workflow level even though operations are sorted by stable key.

**Arazzo 1.1 (FMT-3.1, #5426).** The May 2026 revision lets one workflow span a
synchronous OpenAPI-described API and an asynchronous AsyncAPI-described event stream.
That is modelled here rather than left in the raw document: the root extras carry the
declared source *types* and the names of the AsyncAPI ones, and each step records the
source description it targets, that source's type, and whether the step is asynchronous
(:func:`app.arazzo_spec.step_is_async`). Every canonical consumer — lint, diff, emit,
workflow persistence — therefore sees the sync/async split without re-reading the source.
The document's own version is preserved verbatim in ``extras.arazzo`` so a 1.0 import
re-emits as 1.0.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .arazzo_spec import (
    SOURCE_TYPE_ASYNCAPI,
    resolve_step_target,
    source_description_names,
    source_description_types,
    step_is_async,
    validate_arazzo_version,
)
from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Operation,
    OperationKind,
    Service,
)
from .normalizer import Keys, Normalizer, normalize_ordering

__all__ = ["ArazzoNormalizer", "ARAZZO_FORMAT"]

ARAZZO_FORMAT = "arazzo"


class ArazzoNormalizer(Normalizer, register=True):
    """Normalize a parsed Arazzo workflow document into a :class:`CanonicalApi`."""

    format = ARAZZO_FORMAT
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, dict):
            raise ValueError("Arazzo source must be a parsed mapping (dict)")
        self._validate_version(source)

        info = source.get("info") or {}
        source_descriptions = source.get("sourceDescriptions") or []

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            protocol="http",
            identity=ApiIdentity(name=info.get("title") or "Untitled Workflow"),
            version=info.get("version"),
            title=info.get("title"),
            description=info.get("description"),
            services=self._services(source),
            raw=source if include_raw else None,
            extras=self._root_extras(source, info, source_descriptions),
        )
        return normalize_ordering(api)

    @staticmethod
    def _validate_version(source: Dict[str, Any]) -> None:
        """Require a version marker this normalizer reads (Arazzo 1.0.x or 1.1.x).

        Args:
            source: The parsed Arazzo document.

        Raises:
            ValueError: When the marker is missing, unparseable, or names an
                unsupported version. The import adapter converts this into an
                ``ImportSourceError`` carrying the right taxonomy code.
        """
        validate_arazzo_version(source.get("arazzo"))

    @staticmethod
    def _root_extras(
        source: Dict[str, Any], info: Dict[str, Any], source_descriptions: List[Any]
    ) -> Dict[str, Any]:
        """Build the artifact-root ``extras`` bag.

        Args:
            source: The parsed Arazzo document.
            info: The document's ``info`` object (already defaulted to a mapping).
            source_descriptions: The document's ``sourceDescriptions`` list.

        Returns:
            The extras mapping: the source's own version marker, its source
            descriptions verbatim, the declared source types and the AsyncAPI ones
            among them (1.1), plus the document-level constructs the canonical model
            has no column for (``components``, ``info.summary``) so an export can
            rebuild them.
        """
        extras: Dict[str, Any] = {
            "arazzo": source.get("arazzo"),
            "sourceDescriptions": source_descriptions,
        }
        source_types = source_description_types(source_descriptions)
        if source_types:
            extras["sourceTypes"] = source_types
        async_sources = sorted(
            name for name, kind in source_types.items() if kind == SOURCE_TYPE_ASYNCAPI
        )
        if async_sources:
            extras["asyncSources"] = async_sources
        if isinstance(source.get("components"), dict) and source["components"]:
            # Arazzo's reusable-component bag (`$ref` targets for inputs, parameters and
            # success/failure actions). It is document-level, so it has no canonical home
            # other than here — without it a rebuilt export would emit dangling `$ref`s.
            extras["components"] = source["components"]
        summary = info.get("summary")
        if isinstance(summary, str) and summary:
            # `info.summary` is distinct from `info.description`, which maps onto the model.
            extras["infoSummary"] = summary
        return extras

    def _services(self, source: Dict[str, Any]) -> List[Service]:
        source_names = source_description_names(source.get("sourceDescriptions"))
        source_types = source_description_types(source.get("sourceDescriptions"))
        workflows = source.get("workflows") or []
        services: List[Service] = []
        for workflow_index, workflow in enumerate(workflows):
            if not isinstance(workflow, dict):
                continue
            workflow_id = workflow.get("workflowId")
            if not isinstance(workflow_id, str) or not workflow_id.strip():
                workflow_id = workflow.get("name")
            if not isinstance(workflow_id, str) or not workflow_id.strip():
                continue
            steps = workflow.get("steps") or []
            step_order = [
                step.get("stepId") or step.get("name")
                for step in steps
                if isinstance(step, dict)
                and isinstance(step.get("stepId") or step.get("name"), str)
                and (step.get("stepId") or step.get("name")).strip()
            ]
            operations = [
                op
                for index, step in enumerate(steps)
                if isinstance(step, dict)
                for op in [
                    self._step_operation(
                        workflow_id,
                        step,
                        index,
                        source_names=source_names,
                        source_types=source_types,
                    )
                ]
            ]
            service_extras: Dict[str, Any] = {
                "workflowId": workflow_id,
                # Declaration order, kept because `normalize_ordering` sorts services by key —
                # the same reason each step carries `stepIndex`.
                "workflowIndex": workflow_index,
                "stepOrder": step_order,
            }
            if isinstance(workflow.get("inputs"), dict):
                service_extras["inputs"] = workflow["inputs"]
            # Workflow-level attributes the Service model has no column for. They are carried
            # verbatim so REPO-3.4 (#2773) can persist them as `api_workflows` columns without
            # re-reading the source document.
            for key in ("summary", "outputs", "dependsOn", "successActions", "failureActions"):
                if workflow.get(key) is not None:
                    service_extras[key] = workflow[key]
            services.append(
                Service(
                    key=workflow_id,
                    name=workflow_id,
                    description=workflow.get("description") or workflow.get("summary"),
                    operations=operations,
                    extras=service_extras,
                )
            )
        return services

    @staticmethod
    def _step_operation(
        workflow_id: str,
        step: Dict[str, Any],
        index: int,
        *,
        source_names: List[str],
        source_types: Dict[str, str],
    ) -> Operation:
        """Map one workflow step onto a canonical :class:`Operation`.

        Args:
            workflow_id: The owning workflow's identifier, used for the operation key.
            step: The step mapping from the source document.
            index: The step's declaration position, preserved as ``extras.stepIndex``.
            source_names: Declared source-description names in declaration order, so an
                ``operationRef`` that points at a source by index resolves to a name.
            source_types: ``{name: type}`` for the declared source descriptions.

        Returns:
            The operation, with every step field the canonical model has no column for
            preserved in ``extras`` (Arazzo 1.1's source link and async marker included).
        """
        step_id = step.get("stepId")
        if not isinstance(step_id, str) or not step_id.strip():
            step_id = step.get("name")
        if not isinstance(step_id, str) or not step_id.strip():
            step_id = f"step{index}"
        op_key = Keys.workflow_step(workflow_id, step_id)

        extras: Dict[str, Any] = {"stepIndex": index, "stepId": step_id}
        if step.get("operationId"):
            extras["operationId"] = step["operationId"]
        if step.get("operationRef"):
            extras["operationRef"] = step["operationRef"]
        if step.get("operationPath"):
            # Arazzo 1.0.0's third target spelling (a pointer into a sourceDescription's
            # document), used by the official LoginAndRetrievePets bundle.
            extras["operationPath"] = step["operationPath"]
        if step.get("dependsOn"):
            extras["dependsOn"] = step["dependsOn"]
        if step.get("successCriteria") is not None:
            extras["successCriteria"] = step["successCriteria"]
        if step.get("parameters"):
            extras["parameters"] = step["parameters"]
        if step.get("requestBody"):
            extras["requestBody"] = step["requestBody"]
        if step.get("request"):
            extras["request"] = step["request"]
        if step.get("when"):
            extras["when"] = step["when"]
        if step.get("assertions"):
            extras["assertions"] = step["assertions"]
        if step.get("outputs"):
            extras["outputs"] = step["outputs"]
        # Step-level attributes REPO-3.4 (#2773) persists as `api_workflow_steps` columns.
        # `workflowId` marks a step that calls a sibling workflow rather than an operation, so
        # operationRef resolution can classify it `not_applicable` instead of "unknown".
        for key in ("onFailure", "onSuccess", "workflowId"):
            if step.get(key) is not None:
                extras[key] = step[key]

        # Arazzo 1.1 (FMT-3.1, #5426): link the step to the source description it calls
        # and record whether that call is asynchronous. Both are derived, not copied, so
        # they are written only when the document actually says enough to know.
        target = resolve_step_target(step, source_names=source_names)
        if target is not None and target.source_name:
            extras["sourceDescription"] = target.source_name
            source_type = source_types.get(target.source_name)
            if source_type:
                extras["sourceType"] = source_type
        if step_is_async(step, target=target, source_types=source_types):
            extras["asyncStep"] = True

        return Operation(
            key=op_key,
            name=step_id,
            kind=OperationKind.ONE_WAY,
            description=step.get("description") or step.get("summary"),
            extras=extras,
            tags=[workflow_id],
        )
