"""Tests for OpenAPI-native passthrough detection — MFI-22.7 (#4008).

Covers classification, Swagger 2.0 → OpenAPI 3.1 upgrade, high-fidelity reports,
TypeSpec native-emit routing (mocked ``tsp``), and that OpenAPI sources skip
``emit_canonical`` while non-OpenAPI sources stay on the lossy 22.1–22.5 path.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from unittest.mock import MagicMock

import pytest

from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi
from app.conversion_job import ConversionError, ConversionSource, preview_conversion
from app.conversion_passthrough import (
    SWAGGER_UPGRADE_NOTE,
    ConversionMode,
    classify_conversion,
    emit_typespec_openapi,
    high_fidelity_report,
    passthrough_document,
    upgrade_swagger2_to_openapi31,
)
from app.fidelity import FidelityTier
from app.toolchain_runner import ToolNotAvailableError

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


_OPENAPI_31_DOC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pets", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {"200": {"description": "ok"}},
            }
        }
    },
    "components": {"schemas": {"Pet": {"type": "object"}}},
}

_SWAGGER_2_DOC: Dict[str, Any] = {
    "swagger": "2.0",
    "info": {"title": "Pets", "version": "1.0.0"},
    "host": "api.example.com",
    "basePath": "/v1",
    "schemes": ["https"],
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "schema": {"$ref": "#/definitions/Pet"},
                    }
                },
            },
            "post": {
                "operationId": "createPet",
                "parameters": [
                    {
                        "name": "body",
                        "in": "body",
                        "required": True,
                        "schema": {"$ref": "#/definitions/Pet"},
                    }
                ],
                "responses": {"201": {"description": "created"}},
            },
        }
    },
    "definitions": {
        "Pet": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
        }
    },
    "securityDefinitions": {
        "api_key": {"type": "apiKey", "name": "X-API-Key", "in": "header"},
    },
}


def _api(
    *,
    fmt: str,
    raw: Optional[Dict[str, Any]] = None,
    title: str = "Pets",
) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format=fmt,
        identity=ApiIdentity(name="Pets"),
        title=title,
        version="1.0.0",
        raw=raw,
    )


def _source(
    *,
    fmt: str,
    raw: Optional[Dict[str, Any]] = None,
    source_text: Optional[str] = None,
    source_format: Optional[str] = None,
) -> ConversionSource:
    return ConversionSource(
        api=_api(fmt=fmt, raw=raw),
        source_project_id="cat-oas",
        source_format=source_format or fmt,
        source_text=source_text,
    )


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fmt",
    [
        "openapi-3.0",
        "openapi-3.1",
        "openapi-3.2",
        "swagger-2.0",
        "openapi",
        "swagger",
        "OpenAPI-3.1",
    ],
)
def test_classify_openapi_swagger_is_passthrough(fmt: str) -> None:
    assert classify_conversion(source_format=fmt) is ConversionMode.PASSTHROUGH


@pytest.mark.parametrize("fmt", ["typespec", "tsp", "cadl", "TypeSpec"])
def test_classify_typespec_is_native(fmt: str) -> None:
    assert classify_conversion(source_format=fmt) is ConversionMode.TYPESPEC_NATIVE


@pytest.mark.parametrize(
    "fmt",
    ["grpc", "protobuf", "graphql", "asyncapi-3", "odata", "raml", "smithy"],
)
def test_classify_other_formats_are_lossy(fmt: str) -> None:
    assert classify_conversion(source_format=fmt) is ConversionMode.LOSSY


def test_classify_prefers_source_format_over_api_format() -> None:
    # A mis-normalized model that still carries an OpenAPI revision format stays passthrough.
    assert (
        classify_conversion(source_format="openapi-3.1", api_format="graphql")
        is ConversionMode.PASSTHROUGH
    )


def test_classify_falls_back_to_api_format() -> None:
    assert (
        classify_conversion(source_format=None, api_format="typespec")
        is ConversionMode.TYPESPEC_NATIVE
    )


# ---------------------------------------------------------------------------
# High-fidelity report
# ---------------------------------------------------------------------------


def test_high_fidelity_report_is_tier_high() -> None:
    report = high_fidelity_report()
    assert report.score == 100
    assert report.grade == "A"
    assert report.tier is FidelityTier.HIGH
    assert report.penalty == 0
    assert report.losses == []


def test_high_fidelity_report_carries_informational_note() -> None:
    report = high_fidelity_report(note=SWAGGER_UPGRADE_NOTE)
    assert len(report.losses) == 1
    assert report.losses[0].subject == "swagger-2.0-upgrade"
    assert "Swagger 2.0" in report.losses[0].detail
    assert report.tier is FidelityTier.HIGH


# ---------------------------------------------------------------------------
# Swagger 2.0 → OpenAPI 3.1 upgrade
# ---------------------------------------------------------------------------


def test_upgrade_swagger2_sets_openapi_31_and_servers() -> None:
    upgraded, note = upgrade_swagger2_to_openapi31(_SWAGGER_2_DOC)
    assert upgraded["openapi"] == "3.1.0"
    assert "swagger" not in upgraded
    assert upgraded["servers"] == [{"url": "https://api.example.com/v1"}]
    assert note == SWAGGER_UPGRADE_NOTE


def test_upgrade_swagger2_moves_definitions_and_rewrites_refs() -> None:
    upgraded, _ = upgrade_swagger2_to_openapi31(_SWAGGER_2_DOC)
    schemas = upgraded["components"]["schemas"]
    assert "Pet" in schemas
    get_resp = upgraded["paths"]["/pets"]["get"]["responses"]["200"]
    assert get_resp["content"]["application/json"]["schema"]["$ref"] == (
        "#/components/schemas/Pet"
    )


def test_upgrade_swagger2_body_becomes_request_body() -> None:
    upgraded, _ = upgrade_swagger2_to_openapi31(_SWAGGER_2_DOC)
    post = upgraded["paths"]["/pets"]["post"]
    assert "requestBody" in post
    assert post["requestBody"]["required"] is True
    assert (
        post["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        == "#/components/schemas/Pet"
    )
    assert "parameters" not in post or all(
        p.get("in") != "body" for p in post.get("parameters", [])
    )


def test_upgrade_swagger2_security_definitions() -> None:
    upgraded, _ = upgrade_swagger2_to_openapi31(_SWAGGER_2_DOC)
    schemes = upgraded["components"]["securitySchemes"]
    assert schemes["api_key"]["type"] == "apiKey"
    assert schemes["api_key"]["name"] == "X-API-Key"


def test_upgrade_does_not_mutate_input() -> None:
    original = dict(_SWAGGER_2_DOC)
    upgrade_swagger2_to_openapi31(_SWAGGER_2_DOC)
    assert _SWAGGER_2_DOC == original


# ---------------------------------------------------------------------------
# Passthrough document resolution
# ---------------------------------------------------------------------------


def test_passthrough_document_uses_api_raw_openapi() -> None:
    api = _api(fmt="openapi-3.1", raw=_OPENAPI_31_DOC)
    document, note = passthrough_document(api)
    assert document == _OPENAPI_31_DOC
    assert note is None
    # Deep copy — mutating the returned doc must not touch api.raw.
    document["info"]["title"] = "Mutated"
    assert api.raw["info"]["title"] == "Pets"


def test_passthrough_document_upgrades_swagger_raw() -> None:
    api = _api(fmt="swagger-2.0", raw=_SWAGGER_2_DOC)
    document, note = passthrough_document(api)
    assert document["openapi"] == "3.1.0"
    assert note == SWAGGER_UPGRADE_NOTE


def test_passthrough_document_parses_source_text_when_raw_absent() -> None:
    import json

    api = _api(fmt="openapi-3.1", raw=None)
    document, note = passthrough_document(api, source_text=json.dumps(_OPENAPI_31_DOC))
    assert document["openapi"] == "3.1.0"
    assert document["info"]["title"] == "Pets"
    assert note is None


def test_passthrough_document_requires_source() -> None:
    api = _api(fmt="openapi-3.1", raw=None)
    with pytest.raises(ConversionError) as ei:
        passthrough_document(api, source_text=None)
    assert ei.value.status_code == 422


# ---------------------------------------------------------------------------
# preview_conversion — OpenAPI skips emit_canonical
# ---------------------------------------------------------------------------


def test_preview_openapi_passthrough_skips_emitter(monkeypatch: pytest.MonkeyPatch) -> None:
    called = {"emit": False}

    def _boom(*_a: Any, **_k: Any) -> Any:
        called["emit"] = True
        raise AssertionError("emit_canonical must not run for OpenAPI passthrough")

    monkeypatch.setattr("app.conversion_job.emit_canonical", _boom)
    preview = preview_conversion(_source(fmt="openapi-3.1", raw=_OPENAPI_31_DOC))
    assert called["emit"] is False
    assert preview.conversion_mode == "passthrough"
    assert preview.fidelity.tier is FidelityTier.HIGH
    assert preview.fidelity.score == 100
    assert preview.document["info"]["title"] == "Pets"
    assert preview.document["openapi"] == "3.1.0"


def test_preview_swagger_passthrough_is_high_with_note(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.conversion_job.emit_canonical",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no emit")),
    )
    preview = preview_conversion(_source(fmt="swagger-2.0", raw=_SWAGGER_2_DOC))
    assert preview.conversion_mode == "passthrough"
    assert preview.fidelity.tier is FidelityTier.HIGH
    assert preview.document["openapi"] == "3.1.0"
    assert any(loss.subject == "swagger-2.0-upgrade" for loss in preview.fidelity.losses)


def test_preview_typespec_native_mocked(monkeypatch: pytest.MonkeyPatch) -> None:
    emitted = {
        "openapi": "3.1.0",
        "info": {"title": "From TypeSpec", "version": "1.0.0"},
        "paths": {},
    }

    def _fake_emit(source_text: str, **_kwargs: Any) -> Dict[str, Any]:
        assert "model Pet" in source_text
        return emitted

    monkeypatch.setattr("app.conversion_passthrough.emit_typespec_openapi", _fake_emit)
    monkeypatch.setattr(
        "app.conversion_job.emit_canonical",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no lossy emit")),
    )

    tsp = 'import "@typespec/http";\nnamespace Demo;\nmodel Pet { name: string; }\n'
    preview = preview_conversion(
        _source(fmt="typespec", source_text=tsp, source_format="typespec")
    )
    assert preview.conversion_mode == "typespec_native"
    assert preview.fidelity.tier is FidelityTier.HIGH
    assert preview.document["info"]["title"] == "From TypeSpec"


def test_preview_typespec_missing_tool_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def _unavailable(*_a: Any, **_k: Any) -> Any:
        raise ConversionError(
            "TypeSpec native OpenAPI emit requires the bundled `tsp` compiler",
            status_code=422,
        )

    monkeypatch.setattr("app.conversion_passthrough.emit_typespec_openapi", _unavailable)
    with pytest.raises(ConversionError) as ei:
        preview_conversion(
            _source(
                fmt="typespec",
                source_text='import "@typespec/http";\nnamespace X;\n',
                source_format="typespec",
            )
        )
    assert ei.value.status_code == 422
    assert "tsp" in str(ei.value).lower()


def test_preview_lossy_still_emits_for_non_openapi(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-OpenAPI sources still go through emit_canonical + analyze_fidelity."""
    from app.canonical_model import (
        CanonicalField,
        Message,
        MessageRole,
        Operation,
        OperationKind,
        Service,
        Type,
        TypeKind,
        TypeRef,
    )
    from app.export_service import emit_canonical as real_emit

    calls = {"emit": 0}

    def _counting(api: Any, target: str) -> Any:
        calls["emit"] += 1
        return real_emit(api, target)

    monkeypatch.setattr("app.conversion_job.emit_canonical", _counting)

    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Widget.id", name="id", type=TypeRef(name="integer", nullable=False)
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="odata",
        identity=ApiIdentity(name="Widgets"),
        title="Widgets",
        version="1.0.0",
        types=[widget],
        services=[
            Service(
                key="WidgetsSvc",
                name="WidgetsSvc",
                operations=[
                    Operation(
                        key="GET /widgets",
                        name="listWidgets",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path="/widgets",
                        messages=[
                            Message(
                                key="GET /widgets#resp",
                                role=MessageRole.RESPONSE,
                                status_code="200",
                                content_types=["application/json"],
                                payload=TypeRef(name="Widget"),
                            )
                        ],
                    )
                ],
            )
        ],
    )
    preview = preview_conversion(
        ConversionSource(
            api=api,
            source_project_id="cat-odata",
            source_format="odata",
        )
    )
    assert preview.conversion_mode == "lossy"
    assert calls["emit"] == 1
    assert preview.document.get("openapi", "").startswith("3.")


# ---------------------------------------------------------------------------
# emit_typespec_openapi — tool unavailable
# ---------------------------------------------------------------------------


def test_emit_typespec_openapi_empty_source_raises() -> None:
    with pytest.raises(ConversionError) as ei:
        emit_typespec_openapi("   ")
    assert ei.value.status_code == 422


def test_emit_typespec_openapi_tool_unavailable() -> None:
    runner = MagicMock()

    async def _raise(*_a: Any, **_k: Any) -> Any:
        raise ToolNotAvailableError("tsp", "tsp")

    runner.run = _raise
    with pytest.raises(ConversionError) as ei:
        emit_typespec_openapi(
            'import "@typespec/http";\nnamespace Demo;\n',
            runner=runner,
        )
    assert ei.value.status_code == 422
    assert "tsp" in str(ei.value).lower()
