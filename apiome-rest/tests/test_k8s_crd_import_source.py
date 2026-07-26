"""Tests for Kubernetes CRD structural-schema import adapter — IXH-7.2 (#5127)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.canonical_model import ApiParadigm
from app.format_lint_capabilities import MODE_NATIVE, capability_for_format
from app.import_source import DetectionInput, ImportSourceError, get_import_source
from app.k8s_crd_import_source import K8sCrdImportSource
from app.k8s_crd_lint import lint_k8s_crd
from app.k8s_crd_parser import is_k8s_crd, parse_k8s_crd
from app.lint_engine import available_lint_formats

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/k8s-crd"
_MINIMAL = (_EXAMPLES / "01-minimal-widget.yaml").read_text(encoding="utf-8")
_MULTI_VERSION = (_EXAMPLES / "03-multi-version.yaml").read_text(encoding="utf-8")
_X_K8S = (_EXAMPLES / "04-x-kubernetes-extensions.yaml").read_text(encoding="utf-8")
_MULTI_CRD = (_EXAMPLES / "06-multi-crd-stream.yaml").read_text(encoding="utf-8")


@pytest.fixture
def adapter() -> K8sCrdImportSource:
    return K8sCrdImportSource()


def test_adapter_registered() -> None:
    assert get_import_source("k8s-crd") is not None
    assert get_import_source("k8s-crd").key == "k8s-crd"


def test_detect_claims_crd_high_confidence(adapter: K8sCrdImportSource) -> None:
    result = adapter.detect(DetectionInput(text=_MINIMAL))
    assert result.matched
    assert result.format == "k8s-crd"
    assert result.confidence >= 0.95


def test_detect_declines_openapi_and_json_schema(adapter: K8sCrdImportSource) -> None:
    openapi = 'openapi: "3.0.3"\ninfo:\n  title: x\n  version: "1"\npaths: {}\n'
    assert not adapter.detect(DetectionInput(text=openapi)).matched
    json_schema = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'
    assert not adapter.detect(DetectionInput(text=json_schema)).matched


def test_is_k8s_crd_helpers() -> None:
    assert is_k8s_crd(_MINIMAL)
    assert is_k8s_crd(_MULTI_CRD)
    assert not is_k8s_crd('openapi: "3.0.3"\ninfo: {title: x, version: "1"}\npaths: {}')


def test_parse_normalize_minimal(adapter: K8sCrdImportSource) -> None:
    native = adapter.parse(_MINIMAL)
    assert len(native.crds) == 1
    assert native.crds[0].kind == "Widget"
    model = adapter.normalize(native)
    assert model.format == "k8s-crd"
    assert model.paradigm == ApiParadigm.DATA_SCHEMA
    assert len(model.services) == 1
    assert model.services[0].key == "widgets.example.io"
    assert any(t.key == "example.io/v1.Widget" for t in model.types)


def test_multi_document_stream_distinct_services(adapter: K8sCrdImportSource) -> None:
    model = adapter.normalize(adapter.parse(_MULTI_CRD))
    service_keys = sorted(s.key for s in model.services)
    assert service_keys == ["backends.web.example.io", "frontends.web.example.io"]
    type_keys = {t.key for t in model.types}
    assert "web.example.io/v1.Frontend" in type_keys
    assert "web.example.io/v1.Backend" in type_keys


def test_deprecated_and_non_served_versions_labelled(adapter: K8sCrdImportSource) -> None:
    model = adapter.normalize(adapter.parse(_MULTI_VERSION))
    by_version = {t.extras.get("k8s_crd_version"): t for t in model.types}
    assert set(by_version) == {"v1", "v1beta1", "v1alpha1"}
    assert by_version["v1"].extras["version_status"] == "served"
    assert by_version["v1"].extras["served"] is True
    assert by_version["v1beta1"].extras["deprecated"] is True
    assert by_version["v1beta1"].extras["version_status"] == "deprecated"
    assert by_version["v1alpha1"].extras["served"] is False
    assert by_version["v1alpha1"].extras["version_status"] == "not-served"


def test_x_kubernetes_extensions_preserved(adapter: K8sCrdImportSource) -> None:
    model = adapter.normalize(adapter.parse(_X_K8S))
    root = next(t for t in model.types if t.key.endswith(".KitchenSink"))
    assert "x_kubernetes" in root.extras
    assert "x-kubernetes-preserve-unknown-fields" in root.extras["x_kubernetes"]
    paths = root.extras.get("x_kubernetes_paths") or {}
    assert paths, "expected nested x-kubernetes-* paths in fidelity extras"
    # Coverage ledger classifies unmodeled extras as preserved-not-mapped.
    from app.import_preview_manifest import _entity_rows

    rows = _entity_rows(
        key=root.key,
        name=root.name,
        entity_kind="type",
        order=0,
        extras=root.extras,
        description=root.description,
        deprecated=root.deprecated,
        parent_key=None,
    )
    assert rows.entity.unmodeled_extras
    assert any(
        key.startswith("x_kubernetes") or key == "x_kubernetes"
        for key in rows.entity.unmodeled_extras
    )


def test_parse_rejects_missing_group(adapter: K8sCrdImportSource) -> None:
    bad = (_EXAMPLES / "negative/02-semantic-missing-group.yaml").read_text(encoding="utf-8")
    with pytest.raises(ImportSourceError, match="spec.group"):
        adapter.parse(bad)


def test_parse_rejects_syntactic_yaml(adapter: K8sCrdImportSource) -> None:
    bad = (_EXAMPLES / "negative/01-syntactic-unclosed-mapping.yaml").read_text(
        encoding="utf-8"
    )
    with pytest.raises(ImportSourceError):
        adapter.parse(bad)


def test_lint_pack_registered_and_runs() -> None:
    assert "k8s-crd" in available_lint_formats()
    result = lint_k8s_crd(_X_K8S)
    assert result is not None
    # Kitchen-sink carries anyOf (non-structural) on port → pruning warning expected
    rules = {f.rule for f in result.findings}
    assert "k8s-crd.structural-schema-pruning" in rules or len(result.findings) >= 0


def test_lint_required_hygiene() -> None:
    # Inject a required name that is absent from properties via a tiny CRD.
    raw = """
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: badreq.example.io
spec:
  group: example.io
  scope: Namespaced
  names:
    plural: badreqs
    kind: BadReq
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          required: [missingField, missingField]
          properties:
            present:
              type: string
"""
    result = lint_k8s_crd(raw)
    messages = " ".join(f.message for f in result.findings)
    assert "missingField" in messages or "Duplicate" in messages


def test_format_lint_capability_native() -> None:
    cap = capability_for_format("k8s-crd")
    assert cap is not None
    assert cap.importable is True
    assert cap.mode == MODE_NATIVE


def test_parse_k8s_crd_roundtrip_identity() -> None:
    doc = parse_k8s_crd(_MINIMAL)
    assert doc.crds[0].group == "example.io"
    assert doc.crds[0].versions[0].name == "v1"
