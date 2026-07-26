"""Kubernetes CRD structural-schema import source — IXH-7.2 (#5127).

The :class:`~app.import_source.ImportSource` adapter that makes Kubernetes
CustomResourceDefinition YAML (including multi-document streams) importable
into the catalog.
"""

from __future__ import annotations

from typing import Any, Optional

from . import k8s_crd_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .k8s_crd_parser import (
    K8sCrdDocument,
    K8sCrdParseError,
    is_k8s_crd,
    is_k8s_crd_document,
    parse_k8s_crd,
)

__all__ = ["K8sCrdImportSource"]


class K8sCrdImportSource(ImportSource, register=True):
    """Adapter for Kubernetes CustomResourceDefinition YAML (file / url / paste)."""

    key = "k8s-crd"
    label = "Kubernetes CRD"
    description = (
        "Import a Kubernetes CustomResourceDefinition (or a multi-document YAML "
        "stream of CRDs) and normalize each version's openAPIV3Schema."
    )
    icon = "box"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.FILESET,
    )
    supports_live_discovery = False
    formats = ("k8s-crd",)

    def detect(self, payload: DetectionInput) -> DetectionResult:
        text = payload.text
        if text is not None and is_k8s_crd(text):
            return DetectionResult(
                confidence=0.98,
                format="k8s-crd",
                reason="`apiVersion: apiextensions.k8s.io/*` + `kind: CustomResourceDefinition`",
            )

        document = payload.document
        if document is not None and is_k8s_crd_document(document):
            return DetectionResult(
                confidence=0.98,
                format="k8s-crd",
                reason="`apiVersion: apiextensions.k8s.io/*` + `kind: CustomResourceDefinition`",
            )

        filename = (payload.filename or "").lower()
        if filename.endswith(".crd.yaml") or filename.endswith(".crd.yml"):
            return DetectionResult(
                confidence=0.75,
                format="k8s-crd",
                reason="`.crd.yaml` file extension",
            )
        if "crd" in filename and (filename.endswith(".yaml") or filename.endswith(".yml")):
            return DetectionResult(
                confidence=0.65,
                format="k8s-crd",
                reason="filename contains `crd` with YAML extension",
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> K8sCrdDocument:
        try:
            return parse_k8s_crd(raw, source_label=source_label)
        except K8sCrdParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> K8sCrdDocument:
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Kubernetes CRD fileset is missing its root document")
        return self.parse(fileset.members[root], source_label=root or source_label)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, K8sCrdDocument):
            raise ImportSourceError(
                "Kubernetes CRD source must be a K8sCrdDocument "
                "(see app.k8s_crd_parser.parse_k8s_crd)"
            )
        return self._normalize_via_registry("k8s-crd", native_ast, include_raw=include_raw)
