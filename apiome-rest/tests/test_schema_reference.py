"""Tests for schema reference parsing and resolution — IXH-5.1 (#5113).

A reference is the API's addressing scheme, so its grammar and its scoping are contract. The
parse tests are pure; the resolution tests replace the database and the canonical-model rebuild
with fakes, because what matters here is *which* row a reference reaches (and which it must
never reach), not what Postgres holds today.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Type,
    TypeKind,
    TypeRef,
)
from app.conversion_job import ConversionSource
from app.schema_reference import (
    KIND_CATALOG,
    KIND_PROJECT,
    KIND_REGISTRY,
    LATEST_VERSION_TOKEN,
    SchemaReferenceError,
    parse_schema_reference,
    resolve_schema_reference,
)
from app.schema_validation import REGISTRY_BASE_URL

_TENANT = "tenant-uuid-1"
_ARTIFACT_ID = "11111111-2222-4333-8444-555555555555"
_REVISION_ID = "99999999-8888-4777-a666-555555555555"


# ===========================================================================
# Parsing
# ===========================================================================


@pytest.mark.parametrize(
    "raw,kind,artifact,version,type_name",
    [
        ("project/petstore/1.0.0/Pet", KIND_PROJECT, "petstore", "1.0.0", "Pet"),
        ("project/petstore/latest", KIND_PROJECT, "petstore", "latest", None),
        ("catalog/legacy-soap/2.1.0/Order", KIND_CATALOG, "legacy-soap", "2.1.0", "Order"),
        ("catalog/legacy-soap/latest", KIND_CATALOG, "legacy-soap", "latest", None),
    ],
)
def test_artifact_references_parse(
    raw: str, kind: str, artifact: str, version: str, type_name: Optional[str]
) -> None:
    """Both the three- and four-segment artifact forms parse into their parts."""
    reference = parse_schema_reference(raw)

    assert (reference.kind, reference.artifact, reference.version) == (kind, artifact, version)
    assert reference.type_name == type_name
    assert reference.raw == raw


def test_registry_reference_keeps_its_whole_path() -> None:
    """A registry reference is a namespace path, however many segments deep."""
    reference = parse_schema_reference("registry/std/v0/primitives/email")

    assert reference.kind == KIND_REGISTRY
    assert reference.registry_path == "std/v0/primitives/email"


def test_leading_and_trailing_slashes_are_tolerated() -> None:
    """A reference is a path; stray separators must not change what it names."""
    assert parse_schema_reference("/project/petstore/1.0.0/").artifact == "petstore"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "unknown/petstore/1.0.0",
        "project/petstore",
        "project/petstore/1.0.0/Pet/extra",
        "registry/email",
    ],
)
def test_malformed_references_are_client_errors_with_the_grammar(raw: str) -> None:
    """A bad reference is a 400 that shows the caller the grammar it missed."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        parse_schema_reference(raw)

    assert excinfo.value.status_code == 400
    assert "Supported forms" in str(excinfo.value)


# ===========================================================================
# Registry resolution
# ===========================================================================


def _primitive_row(schema: Dict[str, Any], **overrides: Any) -> Dict[str, Any]:
    row = {
        "id": "prim-1",
        "name": "email",
        "namespace": "std/v0/primitives",
        "schema": schema,
        "draft": "2020-12",
        "base_uri": f"{REGISTRY_BASE_URL}std/v0/primitives/",
    }
    row.update(overrides)
    return row


def test_registry_reference_resolves_by_derived_schema_id() -> None:
    """The reference path is appended to the registry root to form the primitive's ``$id``."""
    document = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "string"}
    fake_db = MagicMock()
    fake_db.get_primitive_by_schema_id.return_value = _primitive_row(document)

    with patch("app.schema_reference.db", fake_db):
        resolved = resolve_schema_reference(
            parse_schema_reference("registry/std/v0/primitives/email"), tenant_id=_TENANT
        )

    fake_db.get_primitive_by_schema_id.assert_called_once_with(
        f"{REGISTRY_BASE_URL}std/v0/primitives/email", _TENANT
    )
    assert resolved.document == document
    assert resolved.dialect == "2020-12"
    assert resolved.source_format == "registry"
    assert resolved.coordinates["schema_id"].endswith("std/v0/primitives/email")


def test_registry_reference_that_matches_nothing_is_a_404() -> None:
    """A registry path outside the caller's read scope simply does not exist to them."""
    fake_db = MagicMock()
    fake_db.get_primitive_by_schema_id.return_value = None

    with patch("app.schema_reference.db", fake_db):
        with pytest.raises(SchemaReferenceError) as excinfo:
            resolve_schema_reference(
                parse_schema_reference("registry/other/v0/secret"), tenant_id=_TENANT
            )

    assert excinfo.value.status_code == 404


def test_registry_retriever_is_tenant_scoped_and_registry_only() -> None:
    """External ``$ref``s resolve only through the tenant-scoped registry lookup."""
    document = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object"}
    target = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "string"}
    fake_db = MagicMock()
    fake_db.get_primitive_by_schema_id.side_effect = [
        _primitive_row(document),
        _primitive_row(target),
    ]

    with patch("app.schema_reference.db", fake_db):
        resolved = resolve_schema_reference(
            parse_schema_reference("registry/std/v0/types/date"), tenant_id=_TENANT
        )
        assert resolved.retrieve is not None
        # A registry URI resolves, scoped to this tenant …
        assert resolved.retrieve(f"{REGISTRY_BASE_URL}std/v0/primitives/string") == target
        # … and anything outside the registry root does not, without any fetch being attempted.
        assert resolved.retrieve("https://evil.example.com/schema.json") is None

    assert fake_db.get_primitive_by_schema_id.call_count == 2
    assert fake_db.get_primitive_by_schema_id.call_args[0][1] == _TENANT


def test_registry_type_without_a_stored_document_is_a_422() -> None:
    """A registry row with no schema cannot validate anything, and says so distinctly."""
    fake_db = MagicMock()
    fake_db.get_primitive_by_schema_id.return_value = _primitive_row(None)

    with patch("app.schema_reference.db", fake_db):
        with pytest.raises(SchemaReferenceError) as excinfo:
            resolve_schema_reference(
                parse_schema_reference("registry/std/v0/primitives/email"), tenant_id=_TENANT
            )

    assert excinfo.value.status_code == 422


# ===========================================================================
# Project / catalog resolution
# ===========================================================================


def _api(types: List[Type]) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="fixture"),
        types=types,
    )


_PET = Type(
    key="Pet",
    name="Pet",
    kind=TypeKind.RECORD,
    fields=[CanonicalField(key="Pet.id", name="id", type=TypeRef(name="string", nullable=False))],
)
_OWNER = Type(key="Owner", name="Owner", kind=TypeKind.RECORD)


def _artifact_row(publishable: bool) -> Dict[str, Any]:
    return {"id": _ARTIFACT_ID, "slug": "petstore", "publishable": publishable}


def _projection(source_format: str = "openapi") -> Dict[str, Any]:
    return {
        "id": _ARTIFACT_ID,
        "project_slug": "petstore",
        "source_format": source_format,
        "protocol": "http",
        "format_metadata": {},
        "tool_versions": {},
        "metadata": {},
        "version_label": "1.0.0",
    }


def _conversion_source(
    api: CanonicalApi, source_format: str = "openapi", text: str = "{}"
) -> ConversionSource:
    return ConversionSource(
        api=api,
        source_project_id=_ARTIFACT_ID,
        source_version_id=_REVISION_ID,
        source_format=source_format,
        source_text=text,
    )


def _resolve(
    raw: str,
    *,
    publishable: bool,
    types: List[Type],
    source_format: str = "openapi",
    source_text: str = "{}",
    fake_db: Optional[MagicMock] = None,
):
    """Resolve ``raw`` against a faked database and canonical-model rebuild."""
    db_mock = fake_db or MagicMock()
    db_mock.get_project_by_slug.return_value = _artifact_row(publishable)
    db_mock.get_project_by_id.return_value = _artifact_row(publishable)
    db_mock.get_catalog_item_by_id.return_value = _artifact_row(publishable)
    db_mock.get_version_source_projection.return_value = _projection(source_format)

    with patch("app.schema_reference.db", db_mock), patch(
        "app.schema_reference.resolve_revision_id", return_value=_REVISION_ID
    ), patch(
        "app.schema_reference.build_conversion_source",
        return_value=_conversion_source(_api(types), source_format, source_text),
    ):
        return resolve_schema_reference(parse_schema_reference(raw), tenant_id=_TENANT)


def test_project_reference_projects_the_named_type() -> None:
    """A named type resolves to its projected schema, with the coordinates echoed back."""
    resolved = _resolve("project/petstore/1.0.0/Pet", publishable=True, types=[_PET, _OWNER])

    assert resolved.document["properties"]["id"] == {"type": "string"}
    assert resolved.coordinates["type_key"] == "Pet"
    assert resolved.coordinates["revision_id"] == _REVISION_ID
    assert resolved.coordinates["artifact_id"] == _ARTIFACT_ID
    assert resolved.retrieve is None


def test_single_type_revision_needs_no_type_segment() -> None:
    """When a revision defines one type, the whole-revision form is unambiguous."""
    resolved = _resolve("project/petstore/latest", publishable=True, types=[_PET])

    assert resolved.coordinates["type_key"] == "Pet"


def test_multi_type_revision_without_a_type_segment_is_a_422_with_candidates() -> None:
    """Ambiguity is refused, and the caller is handed the names it may pick from."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        _resolve("project/petstore/latest", publishable=True, types=[_PET, _OWNER])

    assert excinfo.value.status_code == 422
    assert excinfo.value.candidates == ["Owner", "Pet"]


def test_unknown_type_is_a_404_with_candidates() -> None:
    """A type that does not exist is a miss, with guidance."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        _resolve("project/petstore/1.0.0/Ghost", publishable=True, types=[_PET])

    assert excinfo.value.status_code == 404
    assert excinfo.value.candidates == ["Pet"]


def test_a_project_reference_cannot_reach_a_catalog_item() -> None:
    """The Projects/Catalog boundary is enforced, not merely described."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        _resolve("project/petstore/1.0.0/Pet", publishable=False, types=[_PET])

    assert excinfo.value.status_code == 404
    assert "project" in str(excinfo.value)


def test_a_catalog_reference_cannot_reach_a_project() -> None:
    """And the boundary holds in the other direction too."""
    with pytest.raises(SchemaReferenceError) as excinfo:
        _resolve("catalog/petstore/1.0.0/Pet", publishable=True, types=[_PET])

    assert excinfo.value.status_code == 404
    assert "catalog" in str(excinfo.value)


def test_latest_token_resolves_the_newest_revision() -> None:
    """``latest`` is passed to the shared revision resolver as "no specific version"."""
    db_mock = MagicMock()
    db_mock.get_project_by_slug.return_value = _artifact_row(True)
    db_mock.get_version_source_projection.return_value = _projection()

    with patch("app.schema_reference.db", db_mock), patch(
        "app.schema_reference.resolve_revision_id", return_value=_REVISION_ID
    ) as resolver, patch(
        "app.schema_reference.build_conversion_source",
        return_value=_conversion_source(_api([_PET])),
    ):
        resolve_schema_reference(
            parse_schema_reference(f"project/petstore/{LATEST_VERSION_TOKEN}/Pet"),
            tenant_id=_TENANT,
        )

    resolver.assert_called_once_with(_TENANT, _ARTIFACT_ID, None)


def test_a_slug_is_never_passed_to_a_uuid_lookup() -> None:
    """Id lookups bind a ``uuid``; handing them a slug would be a database error, not a miss."""
    db_mock = MagicMock()
    _resolve("project/petstore/1.0.0/Pet", publishable=True, types=[_PET], fake_db=db_mock)

    db_mock.get_project_by_id.assert_not_called()
    db_mock.get_project_by_slug.assert_called_once_with("petstore", _TENANT)


def test_a_uuid_artifact_resolves_by_id() -> None:
    """An artifact addressed by id skips the slug lookup entirely."""
    db_mock = MagicMock()
    _resolve(
        f"catalog/{_ARTIFACT_ID}/1.0.0/Pet",
        publishable=False,
        types=[_PET],
        fake_db=db_mock,
    )

    db_mock.get_catalog_item_by_id.assert_called_once_with(_ARTIFACT_ID, _TENANT)
    db_mock.get_project_by_slug.assert_not_called()


def test_xsd_backed_revision_carries_its_grammar_for_xml_validation() -> None:
    """An XSD revision exposes the raw grammar, and needs no JSON root type to be usable."""
    grammar = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>'
    resolved = _resolve(
        "catalog/legacy/1.0.0",
        publishable=False,
        types=[_PET, _OWNER],
        source_format="xsd",
        source_text=grammar,
    )

    assert resolved.xml_schema_text == grammar
    assert resolved.document is None
    assert resolved.source_format == "xsd"


def test_unmapped_scalars_surface_as_a_diagnostic() -> None:
    """The projection's honesty metadata reaches the caller as diagnostics."""
    exotic = Type(
        key="Invoice",
        name="Invoice",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="Invoice.total", name="total", type=TypeRef(name="Money"))
        ],
    )

    resolved = _resolve("project/petstore/1.0.0/Invoice", publishable=True, types=[exotic])

    assert [d.code for d in resolved.diagnostics] == ["INPUT_SEMANTIC_INVALID"]
    assert "Money" in resolved.diagnostics[0].message
