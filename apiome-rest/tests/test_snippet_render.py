"""Unit tests for the SDK-2.3 snippet renderer (:mod:`app.snippet_render`, #4487).

Pure-function coverage, no app/db imports: language resolution and aliases, operation
lookup precedence, request synthesis (servers, path/query/header parameters, secret
placeholders, JSON body synthesis), the escaping helpers, per-language golden snippets,
and byte-for-byte determinism.
"""

from __future__ import annotations

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    ServerVariable,
    Service,
    TypeRef,
)
from app.snippet_render import (
    FALLBACK_SERVER_URL,
    INSTALL_LINES,
    SUPPORTED_LANGS,
    SnippetRenderError,
    find_operation,
    format_python_literal,
    js_single_quote,
    placeholder_for_header,
    placeholder_for_query_param,
    python_double_quote,
    render_snippet,
    resolve_lang,
    shell_quote,
    synthesize_request,
)

# ---------------------------------------------------------------------------- fixtures


def _api(operations, servers=None, types=None) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Pet Store"),
        servers=servers if servers is not None else [Server(url="https://api.pets.dev/v1")],
        services=[Service(key="pets", name="pets", operations=operations)],
        types=types or [],
    )


def _get_pet() -> Operation:
    """GET with a path param, a required non-secret query param, and a secret header."""
    return Operation(
        key="GET /pets/{petId}",
        name="getPet",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/pets/{petId}",
        extras={"operationId": "getPet"},
        parameters=[
            Parameter(
                key="GET /pets/{petId}#path.petId",
                name="petId",
                location=ParameterLocation.PATH,
                type=TypeRef(name="string"),
                required=True,
            ),
            Parameter(
                key="GET /pets/{petId}#query.verbose",
                name="verbose",
                location=ParameterLocation.QUERY,
                type=TypeRef(name="boolean"),
                required=True,
            ),
            Parameter(
                key="GET /pets/{petId}#query.limit",
                name="limit",
                location=ParameterLocation.QUERY,
                type=TypeRef(name="integer"),
                required=False,
            ),
            Parameter(
                key="GET /pets/{petId}#header.X-API-Key",
                name="X-API-Key",
                location=ParameterLocation.HEADER,
                type=TypeRef(name="string"),
                required=True,
            ),
        ],
    )


def _create_pet() -> Operation:
    """POST with an inline JSON request-body schema."""
    return Operation(
        key="POST /pets",
        name="createPet",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="post",
        http_path="/pets",
        extras={"operationId": "createPet"},
        messages=[
            Message(
                key="POST /pets#request",
                role=MessageRole.REQUEST,
                payload_schema={
                    "type": "object",
                    "required": ["name", "tame", "nickname"],
                    "properties": {
                        "name": {"type": "string"},
                        "tame": {"type": "boolean"},
                        "nickname": {"type": "null"},
                    },
                },
                content_types=["application/json"],
                required=True,
            )
        ],
    )


# ---------------------------------------------------------------------------- lang


def test_resolve_lang_canonical_values() -> None:
    for lang in SUPPORTED_LANGS:
        assert resolve_lang(lang) == lang


def test_resolve_lang_aliases_and_case() -> None:
    assert resolve_lang("fetch") == "ts"
    assert resolve_lang("httpx") == "python"
    assert resolve_lang("  CURL ") == "curl"


def test_resolve_lang_unknown() -> None:
    assert resolve_lang("go") is None
    assert resolve_lang("") is None


# ---------------------------------------------------------------------------- lookup


def test_find_operation_by_operation_id_extras() -> None:
    api = _api([_get_pet()])
    assert find_operation(api, "getPet") is api.operations()[0]


def test_find_operation_by_name_and_key() -> None:
    op = Operation(
        key="GET /health",
        name="GET /health",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/health",
    )
    api = _api([op])
    assert find_operation(api, "GET /health") is op
    # URL-encoded canonical key resolves too (paradigms without operationIds).
    assert find_operation(api, "GET%20%2Fhealth") is op


def test_find_operation_extras_beats_name() -> None:
    a = _get_pet()
    b = Operation(
        key="GET /other",
        name="getPet",  # same as a's operationId — must NOT shadow it
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/other",
    )
    api = _api([a, b])
    assert find_operation(api, "getPet") is api.operations()[0]


def test_find_operation_miss() -> None:
    assert find_operation(_api([_get_pet()]), "nope") is None


# ---------------------------------------------------------------------------- secrets


def test_placeholder_tokens_parity_with_browse() -> None:
    assert placeholder_for_header("Authorization") == "$AUTHORIZATION"
    assert placeholder_for_header("X-API-Key") == "$API_KEY"
    assert placeholder_for_header("X-Auth-Token") == "$ACCESS_TOKEN"
    assert placeholder_for_header("Proxy-Authorization") == "$SECRET"
    assert placeholder_for_query_param("api_key") == "$API_KEY"
    assert placeholder_for_query_param("apikey") == "$API_KEY"
    assert placeholder_for_query_param("access_token") == "$ACCESS_TOKEN"
    assert placeholder_for_query_param("key") == "$SECRET"


# ---------------------------------------------------------------------------- synthesis


def test_synthesize_request_get() -> None:
    api = _api([_get_pet()])
    request, placeholders = synthesize_request(api, api.operations()[0])
    assert request.method == "GET"
    assert request.url == "https://api.pets.dev/v1/pets/PET_ID?verbose=VERBOSE"
    assert request.headers == {"X-API-Key": "$API_KEY"}
    assert request.body is None
    tokens = {(p.kind, p.token) for p in placeholders}
    assert ("path", "PET_ID") in tokens
    assert ("query", "VERBOSE") in tokens
    assert ("secret", "$API_KEY") in tokens
    secret = next(p for p in placeholders if p.kind == "secret")
    assert secret.location == "header"
    assert secret.name == "X-API-Key"


def test_synthesize_request_secret_query_param() -> None:
    op = _get_pet()
    op = op.model_copy(
        update={
            "parameters": [
                Parameter(
                    key="GET /pets/{petId}#path.petId",
                    name="petId",
                    location=ParameterLocation.PATH,
                    type=TypeRef(name="string"),
                    required=True,
                ),
                Parameter(
                    key="GET /pets/{petId}#query.api_key",
                    name="api_key",
                    location=ParameterLocation.QUERY,
                    type=TypeRef(name="string"),
                    required=True,
                ),
            ]
        }
    )
    request, placeholders = synthesize_request(_api([op]), op)
    assert request.url.endswith("?api_key=$API_KEY")
    secret = next(p for p in placeholders if p.kind == "secret")
    assert (secret.token, secret.location, secret.name) == ("$API_KEY", "query", "api_key")


def test_synthesize_request_defaults_and_optional_query_skipped() -> None:
    op = Operation(
        key="GET /pets",
        name="listPets",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/pets",
        parameters=[
            Parameter(
                key="GET /pets#query.page",
                name="page",
                location=ParameterLocation.QUERY,
                type=TypeRef(name="integer"),
                required=True,
                default=1,
            ),
            Parameter(
                key="GET /pets#query.limit",
                name="limit",
                location=ParameterLocation.QUERY,
                type=TypeRef(name="integer"),
                required=False,
            ),
        ],
    )
    request, placeholders = synthesize_request(_api([op]), op)
    # Defaulted params render their default and add no placeholder; optional ones are omitted.
    assert request.url == "https://api.pets.dev/v1/pets?page=1"
    assert placeholders == []


def test_synthesize_request_server_variables() -> None:
    servers = [
        Server(
            url="https://{region}.api.pets.dev/{basePath}",
            variables=[
                ServerVariable(name="region", default="eu-west-1"),
                ServerVariable(name="basePath"),
            ],
        )
    ]
    op = Operation(
        key="GET /pets",
        name="listPets",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/pets",
    )
    request, placeholders = synthesize_request(_api([op], servers=servers), op)
    assert request.url == "https://eu-west-1.api.pets.dev/BASE_PATH/pets"
    assert [(p.kind, p.token, p.name) for p in placeholders] == [
        ("server", "BASE_PATH", "basePath")
    ]


def test_synthesize_request_no_servers_fallback() -> None:
    op = Operation(
        key="GET /pets",
        name="listPets",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/pets",
    )
    request, placeholders = synthesize_request(_api([op], servers=[]), op)
    assert request.url == f"{FALLBACK_SERVER_URL}/pets"
    assert placeholders[0].kind == "server"


def test_synthesize_request_json_body_minimal_instance() -> None:
    api = _api([_create_pet()])
    request, _ = synthesize_request(api, api.operations()[0])
    assert request.method == "POST"
    assert request.headers["Content-Type"] == "application/json"
    assert request.body_json is not None
    assert set(request.body_json.keys()) == {"name", "tame", "nickname"}
    assert request.body is not None and '"name"' in request.body


def test_synthesize_request_non_json_body_omitted() -> None:
    op = _create_pet()
    op.messages[0].content_types = ["application/octet-stream"]
    request, _ = synthesize_request(_api([op]), op)
    assert request.body is None
    assert "Content-Type" not in request.headers


def test_synthesize_request_unusable_schema_degrades_bodyless(monkeypatch) -> None:
    import app.snippet_render as snippet_render

    def _boom(*args, **kwargs):
        raise ValueError("pathological schema")

    monkeypatch.setattr(snippet_render, "synthesize_instances", _boom)
    op = _create_pet()
    request, _ = synthesize_request(_api([op]), op)
    assert request.body is None
    assert "Content-Type" not in request.headers


def test_synthesize_request_named_payload_typeref() -> None:
    from app.canonical_model import CanonicalField, Type, TypeKind

    pet = Type(
        key="Pet",
        name="Pet",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Pet.name", name="name", type=TypeRef(name="string", nullable=False)
            )
        ],
    )
    op = Operation(
        key="POST /pets",
        name="createPet",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="post",
        http_path="/pets",
        messages=[
            Message(
                key="POST /pets#request",
                role=MessageRole.REQUEST,
                payload=TypeRef(name="Pet", nullable=False),
                content_types=["application/json"],
            )
        ],
    )
    request, _ = synthesize_request(_api([op], types=[pet]), op)
    assert request.body_json is not None
    assert "name" in request.body_json


def test_synthesize_request_non_http_operation_raises() -> None:
    op = Operation(
        key="Query.pets",
        name="pets",
        kind=OperationKind.QUERY,
    )
    try:
        synthesize_request(_api([op]), op)
        raise AssertionError("expected SnippetRenderError")
    except SnippetRenderError as exc:
        assert "HTTP" in str(exc)


# ---------------------------------------------------------------------------- escaping


def test_shell_quote() -> None:
    assert shell_quote("") == "''"
    assert shell_quote("plain") == "'plain'"
    assert shell_quote("it's") == "'it'\\''s'"


def test_js_single_quote() -> None:
    assert js_single_quote("a'b\\c\nd\te") == "'a\\'b\\\\c\\nd\\te'"


def test_python_double_quote() -> None:
    assert python_double_quote('say "hi"\n') == '"say \\"hi\\"\\n"'


def test_format_python_literal_nested() -> None:
    value = {"name": "Rex", "tame": True, "tags": [], "meta": {"age": 3, "chip": None}}
    rendered = format_python_literal(value, 0)
    assert '"name": "Rex"' in rendered
    assert '"tame": True' in rendered
    assert '"tags": []' in rendered
    assert '"chip": None' in rendered


# ---------------------------------------------------------------------------- rendering


def test_render_curl_get_golden() -> None:
    api = _api([_get_pet()])
    render = render_snippet(api, api.operations()[0], "curl")
    assert render.install is None
    assert render.code == (
        "curl 'https://api.pets.dev/v1/pets/PET_ID?verbose=VERBOSE' "
        "-H 'X-API-Key: $API_KEY'"
    )


def test_render_fetch_get_golden() -> None:
    api = _api([_get_pet()])
    render = render_snippet(api, api.operations()[0], "ts")
    assert render.install is None
    assert render.code == (
        "const response = await fetch('https://api.pets.dev/v1/pets/PET_ID?verbose=VERBOSE', {\n"
        "  headers: {\n"
        "    'X-API-Key': '$API_KEY',\n"
        "  },\n"
        "});\n"
        "\n"
        "const data = await response.json();"
    )


def test_render_httpx_get_golden() -> None:
    api = _api([_get_pet()])
    render = render_snippet(api, api.operations()[0], "python")
    assert render.install == "pip install httpx"
    assert render.code == (
        "import httpx\n"
        "\n"
        "response = httpx.request(\n"
        '    "GET",\n'
        '    "https://api.pets.dev/v1/pets/PET_ID?verbose=VERBOSE",\n'
        "    headers={\n"
        '        "X-API-Key": "$API_KEY",\n'
        "    },\n"
        ")\n"
        "response.raise_for_status()"
    )


def test_render_curl_post_body() -> None:
    api = _api([_create_pet()])
    render = render_snippet(api, api.operations()[0], "curl")
    assert render.code.startswith("curl -X POST 'https://api.pets.dev/v1/pets'")
    assert "-H 'Content-Type: application/json'" in render.code
    assert "--data-raw" in render.code


def test_render_fetch_post_body() -> None:
    api = _api([_create_pet()])
    render = render_snippet(api, api.operations()[0], "ts")
    assert "  method: 'POST'," in render.code
    assert "  body: '" in render.code


def test_render_httpx_post_json_literal() -> None:
    api = _api([_create_pet()])
    render = render_snippet(api, api.operations()[0], "python")
    assert "    json={" in render.code
    # Python literals, not JSON: booleans/null must be capitalized/None.
    assert "true" not in render.code
    assert "null" not in render.code


def test_install_lines_registry() -> None:
    assert set(INSTALL_LINES) == set(SUPPORTED_LANGS)


def test_render_deterministic() -> None:
    api = _api([_create_pet()])
    op = api.operations()[0]
    first = render_snippet(api, op, "python")
    second = render_snippet(api, op, "python")
    assert first == second
