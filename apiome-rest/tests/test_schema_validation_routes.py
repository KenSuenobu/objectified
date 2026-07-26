"""HTTP contract tests for the schema instance-validation endpoint — IXH-5.1 (#5113).

``POST /v1/tenants/{tenant_slug}/schemas/{schema_ref}/validate``. Schema resolution is faked
(:mod:`test_schema_reference` covers it); what is asserted here is the endpoint's own contract —
auth and permission gating, the path-shaped reference reaching the service intact, the response
shape, the "a payload we cannot check is a 200 with ``ok: false``" rule, the "an addressing fault
is an HTTP error" rule, and the payload bounds.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.schema_instance_validation import ValidationDiagnostic
from app.schema_reference import ResolvedSchema, SchemaReference, SchemaReferenceError

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}

_PERSON_SCHEMA: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "firstName": {"type": "string", "minLength": 1},
        "age": {"type": "integer", "minimum": 0},
    },
    "required": ["firstName"],
}

_XSD = """<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="note" type="xs:string"/>
</xs:schema>
"""


def _url(reference: str) -> str:
    return f"/v1/tenants/acme/schemas/{reference}/validate"


def _resolved(
    *,
    document: Optional[Dict[str, Any]] = None,
    xml_schema_text: Optional[str] = None,
    source_format: str = "openapi",
    diagnostics: Optional[List[ValidationDiagnostic]] = None,
) -> ResolvedSchema:
    return ResolvedSchema(
        reference=SchemaReference(kind="project", raw="project/petstore/1.0.0/Person"),
        document=_PERSON_SCHEMA if document is None and xml_schema_text is None else document,
        dialect="2020-12",
        xml_schema_text=xml_schema_text,
        source_format=source_format,
        coordinates={"kind": "project", "type_key": "Person"},
        diagnostics=diagnostics or [],
    )


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request and grant the permission the route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch("app.schema_validation_routes.enforce_permission", return_value="test-user-id"):
        yield
    app.dependency_overrides.clear()


# ===========================================================================
# Happy paths
# ===========================================================================


def test_valid_payload_returns_a_clean_verdict() -> None:
    """A payload that satisfies the schema reports ``valid: true`` and no findings."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance": {"firstName": "Ada", "age": 36}},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["valid"] is True
    assert body["validated"] is True
    assert body["validator"] == "jsonschema/2020-12"
    assert body["findings"] == []
    assert body["schema_ref"] == "project/petstore/1.0.0/Person"
    assert body["source"]["kind"] == "project"
    assert body["source"]["projected"] is True
    assert body["source"]["coordinates"]["type_key"] == "Person"


def test_invalid_payload_returns_structured_findings() -> None:
    """Each finding carries pointer, keyword, schema pointer, expected, actual, and message."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance": {"age": -3}},
        )

    body = response.json()
    assert body["ok"] is True
    assert body["valid"] is False
    assert body["total_findings"] == 2
    assert body["truncated"] is False
    by_keyword = {f["keyword"]: f for f in body["findings"]}
    assert by_keyword["required"]["pointer"] == ""
    minimum = by_keyword["minimum"]
    assert minimum["pointer"] == "/age"
    assert minimum["schema_pointer"] == "/properties/age/minimum"
    assert minimum["expected"] == 0
    assert minimum["actual"] == -3
    assert minimum["message"]


def test_instance_text_is_accepted_for_json() -> None:
    """The exact-bytes form parses and validates identically to the value form."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance_text": json.dumps({"firstName": "Ada"})},
        )

    assert response.json()["valid"] is True


def test_explicit_null_instance_is_validated_not_treated_as_absent() -> None:
    """``null`` is a legitimate JSON instance and must be checked, not rejected as missing."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(_url("project/petstore/1.0.0/Person"), json={"instance": None})

    body = response.json()
    assert body["ok"] is True
    assert body["valid"] is False
    assert [f["keyword"] for f in body["findings"]] == ["type"]


def test_registry_reference_is_marked_verbatim_not_projected() -> None:
    """A registry schema is used as its author wrote it, and the response says so."""
    resolved = _resolved()
    resolved.reference = SchemaReference(
        kind="registry", raw="registry/std/v0/primitives/email", registry_path="std/v0/primitives/email"
    )
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=resolved):
        response = client.post(
            _url("registry/std/v0/primitives/email"), json={"instance": {"firstName": "Ada"}}
        )

    assert response.status_code == 200
    assert response.json()["source"]["projected"] is False


def test_resolution_diagnostics_reach_the_response() -> None:
    """A projection that could not constrain everything says so on every verdict it produces."""
    resolved = _resolved(
        diagnostics=[ValidationDiagnostic(code="INPUT_SEMANTIC_INVALID", message="Money")]
    )
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=resolved):
        response = client.post(
            _url("project/petstore/1.0.0/Person"), json={"instance": {"firstName": "Ada"}}
        )

    body = response.json()
    assert body["valid"] is True
    assert [d["code"] for d in body["diagnostics"]] == ["INPUT_SEMANTIC_INVALID"]


def test_max_findings_truncates_and_reports_the_true_total() -> None:
    """The cap bounds the response without hiding how many failures there really were."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "array",
        "items": {"type": "string"},
    }
    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        return_value=_resolved(document=schema),
    ):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance": list(range(20)), "max_findings": 4},
        )

    body = response.json()
    assert len(body["findings"]) == 4
    assert body["total_findings"] == 20
    assert body["truncated"] is True


# ===========================================================================
# Addressing faults are HTTP errors
# ===========================================================================


def test_malformed_reference_is_a_400_with_the_grammar() -> None:
    """A reference that does not parse never reaches resolution."""
    response = client.post(_url("nonsense/thing"), json={"instance": {}})

    assert response.status_code == 400
    assert "Supported forms" in response.json()["detail"]["message"]


def test_unknown_reference_is_a_404() -> None:
    """A well-formed reference to nothing visible is a miss."""
    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        side_effect=SchemaReferenceError("no such project", status_code=404),
    ):
        response = client.post(_url("project/ghost/1.0.0/Pet"), json={"instance": {}})

    assert response.status_code == 404
    assert response.json()["detail"]["message"] == "no such project"


def test_ambiguous_reference_is_a_422_carrying_candidates() -> None:
    """A caller who must pick a type is handed the list to pick from."""
    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        side_effect=SchemaReferenceError(
            "name a type", status_code=422, candidates=["Order", "Pet"]
        ),
    ):
        response = client.post(_url("project/petstore/latest"), json={"instance": {}})

    assert response.status_code == 422
    assert response.json()["detail"]["candidates"] == ["Order", "Pet"]


def test_authentication_is_required() -> None:
    """Without a credential the endpoint is not reachable at all."""
    app.dependency_overrides.clear()

    response = client.post(_url("project/petstore/1.0.0/Pet"), json={"instance": {}})

    assert response.status_code in (401, 403)


# ===========================================================================
# Uncheckable payloads are 200 + ok:false
# ===========================================================================


def test_missing_instance_is_a_200_with_a_taxonomy_code() -> None:
    """Sending no payload is a serviceability fault, reported with remediation."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(_url("project/petstore/1.0.0/Person"), json={})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["valid"] is None
    assert body["validated"] is False
    assert body["error"]["code"] == "INPUT_EMPTY"
    assert body["error"]["remediation"]


def test_sending_both_instance_forms_is_refused() -> None:
    """The two forms are alternatives, not a merge."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance": {}, "instance_text": "{}"},
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_SEMANTIC_INVALID"


def test_malformed_json_text_is_a_200_with_input_malformed() -> None:
    """Broken JSON is the caller's input problem, reported by code, not by stack trace."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"), json={"instance_text": "{not json"}
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_MALFORMED"
    assert body["error"]["category"] == "input"


def test_oversized_instance_trips_the_resource_guard() -> None:
    """The payload is bounded by the same import guards, with the resource code that names it."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance": {"firstName": "a" * (11 * 1024 * 1024)}},
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_TOO_LARGE"
    assert body["error"]["category"] == "resource"


def test_over_deep_instance_trips_the_depth_guard() -> None:
    """A deeply nested payload is refused before a validator walks it."""
    deep: Any = {}
    cursor = deep
    for _ in range(300):
        cursor["n"] = {}
        cursor = cursor["n"]

    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"), json={"instance": deep}
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_DEPTH_LIMIT"


def test_max_findings_is_bounded_by_the_request_schema() -> None:
    """An absurd cap is a request-validation error, not an unbounded response."""
    response = client.post(
        _url("project/petstore/1.0.0/Person"),
        json={"instance": {}, "max_findings": 10_000},
    )

    assert response.status_code == 422


# ===========================================================================
# Media-type routing
# ===========================================================================


def test_xml_payload_against_a_json_only_reference_is_refused_clearly() -> None:
    """Sending XML to a reference with no XML grammar is a format mismatch, not a crash."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()):
        response = client.post(
            _url("project/petstore/1.0.0/Person"),
            json={"instance_text": "<note>x</note>", "media_type": "application/xml"},
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "FORMAT_MISMATCH"


def test_json_payload_against_an_xml_only_reference_is_refused_clearly() -> None:
    """And the mismatch is symmetric."""
    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        return_value=_resolved(document=None, xml_schema_text=_XSD, source_format="xsd"),
    ):
        response = client.post(
            _url("catalog/legacy/1.0.0"), json={"instance": {"note": "x"}}
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "FORMAT_MISMATCH"


def test_xml_payload_is_dispatched_to_the_xml_validator() -> None:
    """An XML reference routes through the external-linter seam, not the JSON validator."""
    from app.xml_instance_validation import XmlValidationResult

    async def _fake(schema_text: str, instance_text: str, **kwargs: Any) -> XmlValidationResult:
        assert schema_text == _XSD
        assert instance_text == "<note>hello</note>"
        return XmlValidationResult(valid=True, validated=True)

    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        return_value=_resolved(document=None, xml_schema_text=_XSD, source_format="xsd"),
    ), patch("app.schema_instance_service.validate_xml_instance", _fake):
        response = client.post(
            _url("catalog/legacy/1.0.0"),
            json={"instance_text": "<note>hello</note>", "media_type": "application/xml"},
        )

    body = response.json()
    assert body["ok"] is True
    assert body["valid"] is True
    assert body["validator"] == "xmllint.validate"
    assert body["media_type"] == "application/xml"


def test_missing_xml_toolchain_reports_not_checked_rather_than_valid() -> None:
    """A deployment without ``xmllint`` never claims an unchecked payload is fine."""
    from app.xml_instance_validation import XmlValidationResult

    async def _fake(*_args: Any, **_kwargs: Any) -> XmlValidationResult:
        return XmlValidationResult(
            valid=None,
            validated=False,
            diagnostics=[
                ValidationDiagnostic(code="ADAPTER_UNAVAILABLE", message="xmllint missing")
            ],
        )

    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        return_value=_resolved(document=None, xml_schema_text=_XSD, source_format="xsd"),
    ), patch("app.schema_instance_service.validate_xml_instance", _fake):
        response = client.post(
            _url("catalog/legacy/1.0.0"),
            json={"instance_text": "<note>hello</note>", "media_type": "application/xml"},
        )

    body = response.json()
    assert body["ok"] is True
    assert body["valid"] is None
    assert body["validated"] is False
    assert [d["code"] for d in body["diagnostics"]] == ["ADAPTER_UNAVAILABLE"]


def test_empty_xml_instance_is_refused() -> None:
    """XML must arrive as text; an empty body has nothing to check."""
    with patch(
        "app.schema_instance_service.resolve_schema_reference",
        return_value=_resolved(document=None, xml_schema_text=_XSD, source_format="xsd"),
    ):
        response = client.post(
            _url("catalog/legacy/1.0.0"),
            json={"instance_text": "   ", "media_type": "application/xml"},
        )

    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_EMPTY"


# ===========================================================================
# The endpoint writes nothing
# ===========================================================================


def test_validation_persists_nothing() -> None:
    """Validation is a read: no write helper on the database handle is ever called."""
    with patch("app.schema_instance_service.resolve_schema_reference", return_value=_resolved()), patch(
        "app.schema_validation_routes.db"
    ) as route_db:
        response = client.post(
            _url("project/petstore/1.0.0/Person"), json={"instance": {"firstName": "Ada"}}
        )

    assert response.status_code == 200
    # The route holds the handle only to pass it to the permission check, which is patched out.
    assert route_db.mock_calls == []
