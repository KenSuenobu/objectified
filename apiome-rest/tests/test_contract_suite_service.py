"""The contract-suite service — ECA-1.1 (#4729).

Compilation itself is covered by ``test_contract_suite``; what is asserted here is the service's
own contract: the reference grammar it accepts, the provenance it attaches (including the
publication state it looks up rather than assumes), and the "a version that yields no suite is a
200 with ``ok: false``" rule.

Revision resolution and the database are faked — both have their own tests, and this module owns
neither.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from unittest.mock import patch

import pytest

from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi
from app.contract_suite import ContractSuiteOptions
from app.contract_suite_service import (
    ContractSuiteCompileRequest,
    SchemaReferenceError,
    compile_version_contract_suite,
)
from app.openapi_normalizer import OpenApiNormalizer
from app.schema_reference import ResolvedRevisionModel, parse_schema_reference

_TENANT = "tenant-uuid"
_REVISION = "3f6d3a9e-1c2b-4a5d-8e7f-0a1b2c3d4e5f"

_DOCUMENT: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Petstore", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {"200": {"description": "ok"}},
            }
        }
    },
}


def _revision(api: Optional[CanonicalApi] = None) -> ResolvedRevisionModel:
    """A resolved revision carrying the corpus document's canonical model."""
    return ResolvedRevisionModel(
        reference=parse_schema_reference("project/petstore/1.0.0"),
        api=api if api is not None else OpenApiNormalizer().normalize(_DOCUMENT),
        coordinates={
            "kind": "project",
            "artifact_id": "artifact-uuid",
            "artifact_slug": "petstore",
            "revision_id": _REVISION,
            "version_label": "1.0.0",
            "source_format": "openapi",
        },
        source_format="openapi",
        xml_schema_text=None,
    )


def _compile(
    reference: str = "project/petstore/1.0.0",
    *,
    revision: Optional[ResolvedRevisionModel] = None,
    published: Optional[bool] = True,
    options: Optional[ContractSuiteOptions] = None,
):
    """Compile through the service with resolution and the revision row faked."""
    row = None if published is None else {"published": published}
    request = ContractSuiteCompileRequest(
        options=options or ContractSuiteOptions()
    )
    with patch(
        "app.contract_suite_service.resolve_revision_model",
        return_value=revision if revision is not None else _revision(),
    ), patch("app.contract_suite_service.db") as database:
        database.get_version_by_id.return_value = row
        return compile_version_contract_suite(reference, request, tenant_id=_TENANT)


def test_a_resolvable_version_compiles_to_a_manifest() -> None:
    """The happy path: a suite, its digest, and the reference echoed back."""
    response = _compile()
    assert response.ok is True
    assert response.version_ref == "project/petstore/1.0.0"
    assert response.manifest is not None
    assert response.manifest.digest.startswith("sha256:")
    assert response.manifest.cases


def test_the_resolved_coordinates_become_the_manifests_provenance() -> None:
    """A manifest identifies its own origin without a second lookup."""
    manifest = _compile().manifest
    assert manifest is not None
    source = manifest.source
    assert source is not None
    assert source.kind == "project"
    assert source.reference == "project/petstore/1.0.0"
    assert source.artifact_slug == "petstore"
    assert source.revision_id == _REVISION
    assert source.version_label == "1.0.0"
    assert source.source_format == "openapi"


def test_publication_state_is_looked_up() -> None:
    """Whether a version is published is a fact about the row, not about the reference."""
    assert _compile(published=True).manifest.source.published is True
    assert _compile(published=False).manifest.source.published is False


def test_publication_state_stays_null_when_the_revision_row_cannot_be_read() -> None:
    """A suite must never claim a version is published when nothing checked."""
    assert _compile(published=None).manifest.source.published is None


def test_options_reach_the_compiler() -> None:
    """The request's options are the suite's identity, so they must not be dropped in transit."""
    response = _compile(options=ContractSuiteOptions(seed=11, include_negative=False))
    manifest = response.manifest
    assert manifest is not None
    assert manifest.options.seed == 11
    assert manifest.options.include_negative is False
    assert manifest.counts["negative_cases"] == 0


def test_a_version_with_no_operations_is_a_200_with_ok_false() -> None:
    """A data-schema artifact has no contract to execute; that is an answer, not a 500."""
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA, format="avro", identity=ApiIdentity(name="events")
    )
    response = _compile(revision=_revision(api))
    assert response.ok is False
    assert response.manifest is None
    assert response.error is not None
    assert response.error.code == "FORMAT_MISMATCH"
    assert response.error.remediation


def test_a_type_qualified_reference_is_rejected_as_an_addressing_fault() -> None:
    """A suite is compiled from a whole version; the trailing type segment is a mistake."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        _compile("project/petstore/1.0.0/Pet")
    assert excinfo.value.status_code == 400
    assert "whole version" in str(excinfo.value)


def test_a_malformed_reference_is_rejected_before_anything_resolves() -> None:
    """Parsing faults come from the shared grammar unchanged."""
    with pytest.raises(SchemaReferenceError):
        _compile("nonsense")


def test_compiling_writes_nothing() -> None:
    """Compilation is a pure read: the only database call is the publication lookup."""
    with patch(
        "app.contract_suite_service.resolve_revision_model", return_value=_revision()
    ), patch("app.contract_suite_service.db") as database:
        database.get_version_by_id.return_value = {"published": True}
        compile_version_contract_suite(
            "project/petstore/1.0.0", ContractSuiteCompileRequest(), tenant_id=_TENANT
        )
    assert [call[0] for call in database.mock_calls] == ["get_version_by_id"]
    database.get_version_by_id.assert_called_once_with(_REVISION, _TENANT)
