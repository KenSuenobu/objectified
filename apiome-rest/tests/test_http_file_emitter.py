"""Tests for the ``.http`` / ``.rest`` / cURL request-file emitter — FMT-2.4 (#5422).

Exercises the ticket's acceptance criteria:

* **Emitted ``.http`` files re-import through the ``http-file`` adapter to an equivalent
  canonical operation set** — every hand-authored ``.http`` corpus fixture, in both
  dialects, is imported, emitted and re-imported, and its operation keys, methods, paths
  and parameters are asserted identical. Cross-format sources are compared at the endpoint
  level (:func:`endpoint_surface`), which is what a request file can carry; the two
  differences are asserted to be reported as losses rather than hidden.
* **Both dialects are emitted and covered by corpus entries** — the two dialects are
  compared construct by construct, and the two committed corpus fixtures
  (``http-file/07-emitted-vscode-collection.http`` and
  ``…/08-emitted-jetbrains-collection.http``) are asserted to be exactly what the emitter
  writes today, so a change in output that the corpus was not regenerated for fails here.
* **Auth appears as clearly marked placeholders; no credential value is ever synthesized** —
  every emitted credential is a placeholder token or an undefined ``{{…}}`` reference, the
  scheme table is proven symmetric with the importer's, and no emitted document declares a
  value for a credential.
* **The ``curl`` mode produces a runnable script** — the generated scripts pass ``bash -n``
  and one is *actually executed* against a local stub server, which asserts the requests
  the server received are the ones the model describes.
* **Single-operation snippets and the bulk emitter produce identical request lines** — the
  emitted request line is compared byte for byte with
  :func:`~app.snippet_render.synthesize_request`'s URL, and the ``inline`` cURL command with
  :func:`~app.snippet_render.render_curl`.
"""

from __future__ import annotations

import http.server
import json
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Channel,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    EmitOptions,
    EmitOptionsError,
    LossKind,
    coerce_emit_options,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from app.http_file_emitter import (
    AUTH_SCHEME_HEADERS,
    BASE_URL_VARIABLE,
    DIALECTS,
    HTTP_FILE_FORMAT_KEY,
    OUTPUT_MODES,
    VARIABLE_STYLES,
    HttpFileEmitOptions,
    HttpFileEmitter,
    HttpFileFidelityRulePack,
    camel_case,
    collapse_headers,
)
from app.http_file_import_source import HttpFileImportSource
from app.http_file_parser import parse_http_file
from app.import_source import DetectionInput
from app.inferred_spec import _auth_scheme_from_headers
from app.openapi_import_source import OpenApiImportSource
from app.snippet_render import render_curl, render_snippet, synthesize_request

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "http-file"
OPENAPI_CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "openapi"

#: The corpus source the two committed dialect fixtures were emitted from.
DIALECT_FIXTURE_SOURCE = OPENAPI_CORPUS / "31-paths-comprehensive.yaml"

#: ``(dialect, committed fixture)`` pairs — the corpus half of "both dialects are emitted".
DIALECT_FIXTURES: Tuple[Tuple[str, str], ...] = (
    ("vscode", "07-emitted-vscode-collection.http"),
    ("jetbrains", "08-emitted-jetbrains-collection.http"),
)

#: The hand-authored ``.http`` corpus fixtures (the emitted ones are asserted separately).
HAND_AUTHORED_FIXTURES: Tuple[str, ...] = (
    "01-minimal-ping.http",
    "02-typical-vars-auth.http",
    "03-path-templating.http",
    "04-stress-methods-curl.http",
    "05-vscode-style-orders.http",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def import_http_fixture(name: str) -> CanonicalApi:
    """Import one ``.http`` corpus fixture through the real adapter."""
    adapter = HttpFileImportSource()
    label = f"http-file/{name}"
    return adapter.normalize(
        adapter.parse((CORPUS / name).read_text(encoding="utf-8"), source_label=label),
        include_raw=False,
    )


def import_openapi(path: Path) -> CanonicalApi:
    """Import one OpenAPI corpus fixture through the real adapter."""
    adapter = OpenApiImportSource()
    return adapter.normalize(
        adapter.parse(path.read_text(encoding="utf-8"), source_label=path.name),
        include_raw=False,
    )


def reimport(text: str, *, variables: Optional[Dict[str, str]] = None) -> CanonicalApi:
    """Re-import emitted request-file text through the ``http-file`` adapter."""
    document = parse_http_file(text, source_label="roundtrip", variables=variables)
    return HttpFileImportSource().normalize(document, include_raw=False)


def operation_surface(api: CanonicalApi) -> List[Tuple[str, str, str, Tuple[str, ...]]]:
    """The comparable operation set: key, method, path and parameter identities."""
    return sorted(
        (
            operation.key,
            operation.http_method or "",
            operation.http_path or "",
            tuple(
                sorted(f"{p.name}:{p.location.value}" for p in operation.parameters)
            ),
        )
        for operation in api.operations()
    )


def endpoint_surface(api: CanonicalApi) -> List[Tuple[str, str, Tuple[str, ...]]]:
    """The comparable *endpoint* set: method, absolute URL template, required parameters.

    Two documented differences from :func:`operation_surface`, both reported by the emitter
    as losses rather than hidden:

    * A request file writes absolute endpoints and has no syntax for saying where the
      server ends and the operation path begins, so a model whose server carries a base
      path (``https://api.example.com/v1``) re-imports with that prefix on the operation.
      The endpoints are identical either way (``server-base-path``).
    * A runnable request sends only the parameters it must; the optional ones are written
      as comments, which a re-import does not read back
      (``optional-parameters-commented``).

    Two more differences are properties of HTTP itself rather than of the emitter: header
    names are case-insensitive, so they are compared lower-cased; and a request media type
    can only travel as a ``Content-Type`` header, so a re-import reads one back as a
    declared parameter (``media-type-as-header``) — that name is excluded here.
    """
    base = api.servers[0].url.rstrip("/") if api.servers else ""
    return sorted(
        (
            operation.http_method or "",
            base + (operation.http_path or ""),
            tuple(
                sorted(
                    f"{p.name.lower()}:{p.location.value}"
                    for p in operation.parameters
                    if p.required and p.name.lower() != "content-type"
                )
            ),
        )
        for operation in api.operations()
    )


def emit(api: CanonicalApi, **options: Any) -> str:
    """Emit ``api`` and return the single emitted file's text."""
    return HttpFileEmitter().emit(api, opts=HttpFileEmitOptions(**options)).files[0].content


def request_blocks(text: str) -> List[List[str]]:
    """Split emitted ``.http`` text into its ``###``-separated blocks."""
    blocks: List[List[str]] = []
    current: Optional[List[str]] = None
    for line in text.splitlines():
        if line.startswith("###"):
            current = [line]
            blocks.append(current)
        elif current is not None:
            current.append(line)
    return blocks


def request_lines(text: str) -> List[str]:
    """The ``METHOD url`` lines of an emitted ``.http`` document, in order."""
    pattern = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT) \S+$")
    return [line for line in text.splitlines() if pattern.match(line)]


def curl_commands(script: str) -> List[str]:
    """The ``curl`` commands of an emitted shell script.

    A command runs from its ``curl`` line to the blank line that separates it from the
    next, so a multi-line JSON body comes back joined exactly as it was written.
    """
    commands: List[str] = []
    current: Optional[List[str]] = None
    for line in script.splitlines():
        if line.startswith("curl"):
            current = [line]
            commands.append(current)  # type: ignore[arg-type]
        elif current is not None:
            if not line.strip():
                current = None
            else:
                current.append(line)
    return ["\n".join(command) for command in commands]  # type: ignore[arg-type]


@pytest.fixture(scope="module")
def orders_api() -> CanonicalApi:
    """A realistic inferred model: path params, query params, an API key and a body."""
    return import_http_fixture("05-vscode-style-orders.http")


@pytest.fixture(scope="module")
def petstore_api() -> CanonicalApi:
    """A cross-format source: OpenAPI with operationIds, descriptions and bodies."""
    return import_openapi(OPENAPI_CORPUS / "30-openapi-3.0-petstore.yaml")


def rest_api(
    *,
    servers: Optional[List[Server]] = None,
    operations: Optional[List[Operation]] = None,
    channels: Optional[List[Channel]] = None,
    types: Optional[List[Type]] = None,
    extras: Optional[Dict[str, Any]] = None,
    title: str = "Widgets API",
) -> CanonicalApi:
    """Build a small hand-authored REST model for the unit-level cases."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi",
        protocol="http",
        identity=ApiIdentity(name=title),
        title=title,
        servers=servers if servers is not None else [Server(url="https://api.example.com")],
        services=[
            Service(key="widgets", name="widgets", operations=operations or [])
        ],
        channels=channels or [],
        types=types or [],
        extras=extras or {},
    )


def header_param(
    operation_key: str,
    name: str,
    *,
    required: bool = True,
    default: Optional[str] = None,
    location: ParameterLocation = ParameterLocation.HEADER,
) -> Parameter:
    """Build one string-typed parameter (the canonical model requires a declared type)."""
    return Parameter(
        key=f"{operation_key}#{location.value}.{name}",
        name=name,
        location=location,
        type=TypeRef(name="string"),
        required=required,
        default=default,
    )


def http_operation(
    key: str = "GET /widgets",
    *,
    method: str = "GET",
    path: str = "/widgets",
    parameters: Optional[List[Parameter]] = None,
    messages: Optional[List[Message]] = None,
    extras: Optional[Dict[str, Any]] = None,
    description: Optional[str] = None,
) -> Operation:
    """Build one HTTP operation."""
    return Operation(
        key=key,
        name=key,
        kind=OperationKind.REQUEST_RESPONSE,
        http_method=method,
        http_path=path,
        description=description,
        parameters=parameters or [],
        messages=messages or [],
        extras=extras or {},
    )


def test_the_fixture_lists_cover_every_valid_http_corpus_file() -> None:
    """A new `.http` corpus entry must join one of the two lists, not slip past them."""
    on_disk = {path.name for path in CORPUS.glob("*.http")}
    covered = set(HAND_AUTHORED_FIXTURES) | {fixture for _, fixture in DIALECT_FIXTURES}
    assert on_disk == covered, (
        "apiome-ui/examples/http-file/ and this module's fixture lists disagree; "
        "add the new file to HAND_AUTHORED_FIXTURES or DIALECT_FIXTURES."
    )


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------


def test_emitter_is_registered_under_the_import_adapter_key() -> None:
    """The emit format matches the adapter key, so the round-trip join needs no alias."""
    load_builtin_emitters()
    assert get_emitter(HTTP_FILE_FORMAT_KEY) is HttpFileEmitter
    assert HttpFileEmitter.key == HttpFileImportSource.key


def test_descriptor_describes_a_single_file_rest_target() -> None:
    descriptor = HttpFileEmitter.descriptor()
    assert descriptor.key == "http-file"
    assert descriptor.format == "http-file"
    assert descriptor.paradigm is ApiParadigm.REST
    assert descriptor.multi_file is False
    assert descriptor.needs_toolchain is False
    assert descriptor.available is True
    assert descriptor.label and descriptor.description and descriptor.icon


def test_target_is_enumerated_for_the_export_surfaces() -> None:
    """`describe_emit_targets` is what the UI/CLI list, so the target must appear there."""
    targets = {target.descriptor.format: target for target in describe_emit_targets()}
    assert HTTP_FILE_FORMAT_KEY in targets
    target = targets[HTTP_FILE_FORMAT_KEY]
    assert target.capability_profile.operations is True
    assert target.default_options["dialect"] == "vscode"
    assert set(target.options_schema["properties"]) == {
        "dialect",
        "output",
        "include_examples",
        "variable_style",
        "base_url",
    }


def test_capability_profile_claims_only_operations() -> None:
    """A request file carries calls and nothing about the types behind their bodies."""
    profile = HttpFileEmitter.capability_profile()
    assert profile.operations is True
    assert profile.events is False
    assert profile.unions is False
    assert profile.nullability is False
    assert profile.constraints is False
    assert profile.field_identity is False


def test_fidelity_rule_pack_drops_events_and_non_http_operations() -> None:
    pack = HttpFileFidelityRulePack(HttpFileEmitter.capability_profile(), "HTTP request file")
    rpc = Operation(key="Widgets.Ping", name="Ping", kind=OperationKind.REQUEST_RESPONSE)
    published = Operation(key="events.created", name="created", kind=OperationKind.PUBLISH)
    assert pack.operation_verdict(rpc).kind is not None
    assert "requires an HTTP binding" in pack.operation_verdict(rpc).message
    assert "event vocabulary" in pack.operation_verdict(published).message
    assert pack.operation_verdict(http_operation()).message.endswith("HTTP request file")


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,value",
    [("dialect", "emacs"), ("output", "har"), ("variable_style", "magic")],
)
def test_unknown_option_values_are_rejected(field: str, value: str) -> None:
    with pytest.raises(ValueError):
        HttpFileEmitOptions(**{field: value})


def test_coerce_emit_options_reports_a_bad_option_as_an_emit_options_error() -> None:
    """Routes surface a 422 from this, so the validation error must be typed."""
    with pytest.raises(EmitOptionsError):
        coerce_emit_options(HttpFileEmitter, {"dialect": "emacs"})


def test_plain_emit_options_are_accepted_and_defaulted(orders_api: CanonicalApi) -> None:
    """A caller that passes the base envelope gets the target's defaults, not a crash."""
    result = HttpFileEmitter().emit(orders_api, opts=EmitOptions())
    assert result.files[0].path == "requests.http"
    assert result.files[0].media_type == "text/x-http"


def test_declared_vocabularies_match_the_option_fields() -> None:
    assert set(DIALECTS) == {"vscode", "jetbrains"}
    assert set(OUTPUT_MODES) == {"http", "curl"}
    assert set(VARIABLE_STYLES) == {"file", "environment", "inline"}


# ---------------------------------------------------------------------------
# Document structure
# ---------------------------------------------------------------------------


def test_document_opens_with_a_base_url_variable_and_one_block_per_operation(
    orders_api: CanonicalApi,
) -> None:
    text = emit(orders_api)
    assert f"@{BASE_URL_VARIABLE} = https://orders.example.com" in text
    assert len(request_blocks(text)) == len(list(orders_api.operations()))
    assert len(request_lines(text)) == len(list(orders_api.operations()))
    for line in request_lines(text):
        assert "{{baseUrl}}" in line


def test_header_block_lists_every_placeholder_that_reaches_the_document(
    orders_api: CanonicalApi,
) -> None:
    """Whatever the reader must substitute is named up front, and nothing else is."""
    text = emit(orders_api)
    header, _, body = text.partition(f"\n@{BASE_URL_VARIABLE} = ")
    assert "Replace before running:" in header
    advertised = set(re.findall(r"^#   (\S+)", header, flags=re.MULTILINE))
    assert advertised == {"$API_KEY", "{id}", "LIMIT", "STATUS", "ACCEPT"}
    for token in advertised:
        assert token in body, f"{token} is advertised but never appears in a request"


def test_a_placeholder_that_is_collapsed_away_is_not_advertised() -> None:
    """The `content-type` parameter loses to the message's concrete media type."""
    api = rest_api(
        operations=[
            http_operation(
                key="POST /widgets",
                method="POST",
                path="/widgets",
                parameters=[
                    header_param("POST /widgets", "content-type")
                ],
                messages=[
                    Message(
                        key="POST /widgets.request",
                        name="WidgetRequest",
                        role=MessageRole.REQUEST,
                        content_types=["application/json"],
                        payload_schema={"type": "object", "properties": {"n": {"type": "string"}}},
                    )
                ],
            )
        ]
    )
    text = emit(api)
    assert "Content-Type: application/json" in text
    assert "CONTENT_TYPE" not in text


def test_operation_description_becomes_a_comment(petstore_api: CanonicalApi) -> None:
    text = emit(petstore_api)
    assert "# List all pets" in text


def test_extra_servers_are_listed_as_comments_and_recorded_as_a_loss() -> None:
    api = rest_api(
        servers=[
            Server(url="https://api.example.com"),
            Server(url="https://staging.example.com"),
        ],
        operations=[http_operation()],
    )
    result = HttpFileEmitter().emit(api)
    assert "https://staging.example.com" in result.files[0].content
    assert "@baseUrl = https://api.example.com" in result.files[0].content
    assert any(loss.subject == "additional-servers" for loss in result.losses)


def test_output_is_deterministic(orders_api: CanonicalApi) -> None:
    first = HttpFileEmitter().emit(orders_api)
    second = HttpFileEmitter().emit(orders_api)
    assert first.files == second.files
    assert first.provenance == second.provenance
    assert first.losses == second.losses


def test_a_model_with_no_http_operation_refuses_to_emit() -> None:
    """A request file is a collection of calls; there is nothing honest to write."""
    api = rest_api(
        operations=[Operation(key="Widgets.Ping", name="Ping", kind=OperationKind.REQUEST_RESPONSE)]
    )
    with pytest.raises(ValueError, match="at least one HTTP operation"):
        HttpFileEmitter().emit(api)


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "source,expected",
    [
        ("GET /users", "getUsers"),
        ("POST /users", "postUsers"),
        ("GET /pets/{petId}", "getPetsPetId"),
        ("listUsers", "listUsers"),
        ("API_KEY", "apiKey"),
        ("AUTHORIZATION", "authorization"),
        ("PET_ID", "petId"),
        ("", "request"),
        ("2fa", "r2fa"),
    ],
)
def test_camel_case_normalizes_shouting_words(source: str, expected: str) -> None:
    assert camel_case(source) == expected


def test_request_names_prefer_the_source_operation_id(petstore_api: CanonicalApi) -> None:
    text = emit(petstore_api)
    assert "# @name listPets" in text
    assert "# @name createPet" in text


def test_request_names_are_unique_within_a_document() -> None:
    """Both editors address a named request's response, so a duplicate name is ambiguous."""
    api = rest_api(
        operations=[
            http_operation(key="GET /a", path="/a", extras={"operationId": "fetch"}),
            http_operation(key="GET /b", path="/b", extras={"operationId": "fetch"}),
            http_operation(key="GET /c", path="/c", extras={"operationId": "fetch"}),
        ]
    )
    names = re.findall(r"^# @name (\S+)$", emit(api), flags=re.MULTILINE)
    assert names == ["fetch", "fetch2", "fetch3"]


# ---------------------------------------------------------------------------
# Dialects
# ---------------------------------------------------------------------------


def test_vscode_names_a_request_on_its_own_line(orders_api: CanonicalApi) -> None:
    block = request_blocks(emit(orders_api, dialect="vscode"))[0]
    assert block[0].startswith("### DELETE /orders/")
    assert block[1].startswith("# @name ")
    assert not any(line.startswith("//") for line in block)


def test_jetbrains_names_a_request_on_the_separator(orders_api: CanonicalApi) -> None:
    block = request_blocks(emit(orders_api, dialect="jetbrains"))[0]
    assert block[0] == "### deleteOrdersId"
    assert block[1] == "// DELETE /orders/{id}"
    assert not any(line.startswith("# @name") for line in block)


def test_the_dialects_differ_only_in_naming_and_comments(orders_api: CanonicalApi) -> None:
    """Same calls, same placeholders — only how a request is labelled changes."""
    vscode = emit(orders_api, dialect="vscode")
    jetbrains = emit(orders_api, dialect="jetbrains")
    assert vscode != jetbrains
    assert request_lines(vscode) == request_lines(jetbrains)
    assert operation_surface(reimport(vscode)) == operation_surface(reimport(jetbrains))


@pytest.mark.parametrize("dialect,fixture", DIALECT_FIXTURES)
def test_committed_dialect_corpus_fixture_is_current_emitter_output(
    dialect: str, fixture: str
) -> None:
    """The corpus entries for both dialects are real output, and stay real output."""
    expected = emit(import_openapi(DIALECT_FIXTURE_SOURCE), dialect=dialect)
    committed = (CORPUS / fixture).read_text(encoding="utf-8")
    assert committed == expected, (
        f"{fixture} has drifted from the emitter; regenerate the corpus fixture."
    )


@pytest.mark.parametrize("dialect,fixture", DIALECT_FIXTURES)
def test_committed_dialect_corpus_fixture_is_detected_and_imports(
    dialect: str, fixture: str
) -> None:
    """The corpus contract for these entries: detected as `http-file` and importable."""
    adapter = HttpFileImportSource()
    text = (CORPUS / fixture).read_text(encoding="utf-8")
    detection = adapter.detect(DetectionInput(text=text, filename=fixture))
    assert detection.format == "http-file"
    assert detection.confidence >= 0.9
    api = adapter.normalize(adapter.parse(text, source_label=fixture), include_raw=False)
    assert endpoint_surface(api) == endpoint_surface(import_openapi(DIALECT_FIXTURE_SOURCE))


# ---------------------------------------------------------------------------
# Round trip
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", HAND_AUTHORED_FIXTURES)
@pytest.mark.parametrize("dialect", DIALECTS)
def test_every_http_corpus_fixture_round_trips_to_the_same_operation_set(
    fixture: str, dialect: str
) -> None:
    api = import_http_fixture(fixture)
    assert operation_surface(reimport(emit(api, dialect=dialect))) == operation_surface(api)


def test_a_cross_format_source_round_trips_to_the_same_operation_set(
    petstore_api: CanonicalApi,
) -> None:
    """The real use: export an OpenAPI catalog item, open it in an editor, re-import it."""
    assert endpoint_surface(reimport(emit(petstore_api))) == endpoint_surface(petstore_api)


def test_path_parameters_are_emitted_as_their_canonical_template(
    petstore_api: CanonicalApi,
) -> None:
    """`/pets/{petId}` — not `/pets/PET_ID`, which re-imports as a literal segment."""
    text = emit(petstore_api)
    assert "GET {{baseUrl}}/pets/{petId}" in text
    assert "PET_ID" not in text


def test_the_environment_style_declares_nothing_and_resolves_from_the_reader(
    orders_api: CanonicalApi,
) -> None:
    text = emit(orders_api, variable_style="environment")
    assert f"@{BASE_URL_VARIABLE}" not in text
    assert "{{baseUrl}}" in text
    assert "environment file" in text
    resolved = reimport(text, variables={BASE_URL_VARIABLE: "https://orders.example.com"})
    assert operation_surface(resolved) == operation_surface(orders_api)


def test_the_inline_style_writes_absolute_urls_and_declares_no_variable(
    orders_api: CanonicalApi,
) -> None:
    text = emit(orders_api, variable_style="inline")
    assert "{{" not in text
    assert f"@{BASE_URL_VARIABLE}" not in text
    assert "GET https://orders.example.com/orders/ID" in text


def test_the_inline_style_reports_the_path_template_it_gives_up() -> None:
    """Snippet-verbatim path values cannot re-import as parameters; that is a loss."""
    api = import_http_fixture("03-path-templating.http")
    losses = HttpFileEmitter().emit(api, opts=HttpFileEmitOptions(variable_style="inline")).losses
    assert any(loss.subject == "lossy-path-template" for loss in losses)
    assert not any(
        loss.subject == "lossy-path-template"
        for loss in HttpFileEmitter().emit(api).losses
    )


# ---------------------------------------------------------------------------
# Snippet parity
# ---------------------------------------------------------------------------


def test_request_lines_match_the_single_operation_snippet(orders_api: CanonicalApi) -> None:
    """The bulk file and the snippet service describe the same call, byte for byte."""
    emitted = request_lines(emit(orders_api, variable_style="inline"))
    expected = [
        f"{request.method} {request.url}"
        for request, _ in (
            synthesize_request(orders_api, operation) for operation in orders_api.operations()
        )
    ]
    assert emitted == expected


def test_inline_curl_commands_are_rendered_by_the_snippet_renderer(
    orders_api: CanonicalApi,
) -> None:
    """Same function, same quoting — the only divergence is the documented header collapse."""
    import dataclasses

    script = emit(orders_api, output="curl", variable_style="inline")
    expected = []
    for operation in orders_api.operations():
        request, _ = synthesize_request(orders_api, operation)
        collapsed = dataclasses.replace(
            request, headers=dict(collapse_headers(request.headers))
        )
        expected.append(render_curl(collapsed))
    assert curl_commands(script) == expected


def test_an_operation_without_duplicate_headers_matches_the_snippet_verbatim(
    petstore_api: CanonicalApi,
) -> None:
    """When nothing is collapsed, the emitted command *is* the snippet's `code`."""
    script = emit(petstore_api, output="curl", variable_style="inline")
    snippets = [render_snippet(petstore_api, op, "curl").code for op in petstore_api.operations()]
    assert curl_commands(script) == snippets


def test_the_base_url_variable_is_the_one_the_snippets_were_built_against(
    petstore_api: CanonicalApi,
) -> None:
    """A server with a path (`…/v1`) must not be truncated to its host."""
    text = emit(petstore_api)
    assert "@baseUrl = https://api.example.com/v1" in text
    request, _ = synthesize_request(petstore_api, next(iter(petstore_api.operations())))
    assert request.url.startswith("https://api.example.com/v1")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scheme,mapping", sorted(AUTH_SCHEME_HEADERS.items()))
def test_every_auth_scheme_header_re_imports_to_its_own_scheme(
    scheme: str, mapping: Tuple[str, str]
) -> None:
    """The table is the inverse of the importer's, so emit → import is a fixed point."""
    name, value = mapping
    recovered = _auth_scheme_from_headers([(name, value)])
    assert recovered == scheme or AUTH_SCHEME_HEADERS.get(recovered or "") == mapping


@pytest.mark.parametrize("mapping", sorted(AUTH_SCHEME_HEADERS.values()))
def test_no_auth_scheme_row_carries_a_credential(mapping: Tuple[str, str]) -> None:
    """Every mapped value is a scheme keyword plus a placeholder token, never a secret."""
    _, value = mapping
    token = value.rsplit(" ", 1)[-1]
    assert token.startswith("$")
    assert value in {token, f"Bearer {token}", f"Basic {token}", f"Digest {token}"}


def test_an_operation_scoped_scheme_adds_its_header_and_says_so() -> None:
    """A gateway import states auth per operation, so the header is a faithful addition."""
    api = rest_api(
        operations=[http_operation(extras={"security": [{"scheme": "bearer"}]})]
    )
    result = HttpFileEmitter().emit(api)
    assert "Authorization: Bearer $ACCESS_TOKEN" in result.files[0].content
    assert any(loss.subject == "synthesized-auth-header" for loss in result.losses)


def test_a_model_scoped_inferred_scheme_never_adds_a_header() -> None:
    """`inferred_auth_schemes` observes a scheme somewhere; it does not require it here."""
    api = rest_api(
        operations=[http_operation()],
        extras={"inferred_auth_schemes": ["bearer"]},
    )
    result = HttpFileEmitter().emit(api)
    assert "Authorization" not in result.files[0].content
    assert not any(loss.subject == "synthesized-auth-header" for loss in result.losses)


def test_a_model_scoped_scheme_refines_a_placeholder_the_operation_already_declares() -> None:
    """`authorization: $AUTHORIZATION` becomes the scheme the model actually observed."""
    api = rest_api(
        operations=[
            http_operation(
                parameters=[
                    header_param("GET /widgets", "authorization")
                ]
            )
        ],
        extras={"inferred_auth_schemes": ["bearer"]},
    )
    text = emit(api)
    assert "authorization: Bearer $ACCESS_TOKEN" in text
    assert "$AUTHORIZATION" not in text


def test_a_declared_header_value_is_never_overwritten_by_a_scheme() -> None:
    """A non-credential default the model states outright outranks a scheme's placeholder."""
    api = rest_api(
        operations=[
            http_operation(
                parameters=[header_param("GET /widgets", "Cookie", default="tenant=acme")],
                extras={"security": ["cookie"]},
            )
        ]
    )
    text = emit(api)
    assert "Cookie: tenant=acme" in text
    assert "$SECRET" not in text


def test_a_declared_default_on_a_credential_header_is_never_echoed() -> None:
    """The shared synthesizer refuses to print a credential, however it was declared."""
    api = rest_api(
        operations=[
            http_operation(
                parameters=[
                    header_param("GET /widgets", "Authorization", default="Bearer real-token")
                ]
            )
        ]
    )
    text = emit(api)
    assert "real-token" not in text
    assert "Authorization: $AUTHORIZATION" in text


def test_a_scheme_with_no_header_representation_is_reported_not_approximated() -> None:
    api = rest_api(operations=[http_operation(extras={"security": ["mutualTLS"]})])
    result = HttpFileEmitter().emit(api)
    assert "mutualTLS" not in result.files[0].content
    assert any(loss.subject == "unrepresentable-auth-scheme" for loss in result.losses)


def test_credentials_are_placeholders_in_every_option_combination(
    orders_api: CanonicalApi,
) -> None:
    """No emitted document may ever assign a value to a credential."""
    assignment = re.compile(
        r"^(?:@|\s*)(?:[A-Za-z-]*(?:api[_-]?key|token|authorization|secret|password))"
        r"\s*[:=]\s*(\S+)",
        re.IGNORECASE,
    )
    for dialect in DIALECTS:
        for output in OUTPUT_MODES:
            for style in VARIABLE_STYLES:
                text = emit(
                    orders_api, dialect=dialect, output=output, variable_style=style
                )
                for line in text.splitlines():
                    match = assignment.match(line)
                    if match is None:
                        continue
                    value = match.group(1)
                    assert value.startswith(("$", "{{", '"$', "Bearer", "Basic", "Digest")), (
                        f"{dialect}/{output}/{style} assigns a credential value: {line!r}"
                    )


def test_the_environment_style_spells_credentials_as_undefined_references(
    orders_api: CanonicalApi,
) -> None:
    text = emit(orders_api, variable_style="environment")
    assert "{{apiKey}}" in text
    assert "$API_KEY" not in text
    assert "@apiKey" not in text, "an environment reference must stay undefined"


def test_the_curl_output_keeps_shell_tokens_even_in_the_environment_style(
    orders_api: CanonicalApi,
) -> None:
    """A shell has no `{{…}}` mechanism, so the reference would never resolve."""
    script = emit(orders_api, output="curl", variable_style="environment")
    assert "{{" not in script
    assert "$API_KEY" in script


def test_a_password_formatted_body_field_uses_the_shared_synthesizer_placeholder() -> None:
    """Body values come from the seeded synthesizer's neutral vocabulary, not from here."""
    api = rest_api(
        operations=[
            http_operation(
                key="POST /login",
                method="POST",
                path="/login",
                messages=[
                    Message(
                        key="POST /login.request",
                        name="LoginRequest",
                        role=MessageRole.REQUEST,
                        content_types=["application/json"],
                        payload_schema={
                            "type": "object",
                            "required": ["password"],
                            "properties": {"password": {"type": "string", "format": "password"}},
                        },
                    )
                ],
            )
        ]
    )
    assert '"password": "sample-passphrase"' in emit(api)


def test_optional_parameters_are_commented_next_to_the_request_and_reported() -> None:
    """A runnable call cannot send `?page=PAGE`, but the reader should still see `page`."""
    api = rest_api(
        operations=[
            http_operation(
                parameters=[
                    header_param(
                        "GET /widgets",
                        "page",
                        required=False,
                        location=ParameterLocation.QUERY,
                    ),
                    header_param("GET /widgets", "X-Request-ID", required=False),
                ]
            )
        ]
    )
    result = HttpFileEmitter().emit(api)
    text = result.files[0].content
    assert "# optional:" in text
    assert "#   ?page=…" in text
    assert "#   X-Request-ID: …" in text
    assert "GET {{baseUrl}}/widgets" in text, "an optional parameter must not be sent"
    assert any(loss.subject == "optional-parameters-commented" for loss in result.losses)


def test_optional_parameters_are_commented_in_the_shell_script_too() -> None:
    api = rest_api(
        operations=[
            http_operation(
                parameters=[
                    header_param(
                        "GET /widgets",
                        "page",
                        required=False,
                        location=ParameterLocation.QUERY,
                    )
                ]
            )
        ]
    )
    assert "#   ?page=…" in emit(api, output="curl")


@pytest.mark.parametrize("output", OUTPUT_MODES)
@pytest.mark.parametrize("variable_style", VARIABLE_STYLES)
def test_the_base_url_option_replaces_the_model_server_everywhere(
    orders_api: CanonicalApi, output: str, variable_style: str
) -> None:
    """Including in `inline`, where there is no variable left to point somewhere else."""
    text = emit(
        orders_api,
        output=output,
        variable_style=variable_style,
        base_url="https://sandbox.example.net/",
    )
    assert "https://orders.example.com" not in text
    declares_base = variable_style != "environment" or output == "curl"
    if declares_base:
        assert "https://sandbox.example.net" in text
        assert "https://sandbox.example.net/\n" not in text, "the trailing slash is trimmed"
    else:
        assert "{{baseUrl}}" in text


def test_a_server_with_a_base_path_reports_that_a_re_import_cannot_split_it(
    petstore_api: CanonicalApi,
) -> None:
    losses = HttpFileEmitter().emit(petstore_api).losses
    assert any(loss.subject == "server-base-path" for loss in losses)


# ---------------------------------------------------------------------------
# Bodies
# ---------------------------------------------------------------------------


def test_example_bodies_are_emitted_and_recorded_as_synthesized(
    petstore_api: CanonicalApi,
) -> None:
    result = HttpFileEmitter().emit(petstore_api)
    assert "Content-Type: application/json" in result.files[0].content
    assert any(
        loss.kind is LossKind.INFERRED and loss.subject == "synthesized-example-body"
        for loss in result.losses
    )
    assert not any(loss.subject == "example-body-omitted" for loss in result.losses), (
        "a body that was emitted must not also be reported as omitted"
    )


def test_disabling_examples_omits_the_body_and_says_why(petstore_api: CanonicalApi) -> None:
    result = HttpFileEmitter().emit(
        petstore_api, opts=HttpFileEmitOptions(include_examples=False)
    )
    text = result.files[0].content
    assert '"name":' not in text
    assert any(loss.subject == "example-body-omitted" for loss in result.losses)
    assert endpoint_surface(reimport(text)) == endpoint_surface(petstore_api)


def test_a_schema_example_is_used_verbatim_rather_than_invented() -> None:
    """The shared synthesizer prefers const → example → default before it invents."""
    api = rest_api(
        operations=[
            http_operation(
                key="POST /widgets",
                method="POST",
                path="/widgets",
                messages=[
                    Message(
                        key="POST /widgets.request",
                        name="WidgetRequest",
                        role=MessageRole.REQUEST,
                        content_types=["application/json"],
                        payload_schema={
                            "type": "object",
                            "required": ["sku"],
                            "properties": {
                                "sku": {"type": "string", "example": "WIDGET-001"}
                            },
                        },
                    )
                ],
            )
        ]
    )
    assert '"sku": "WIDGET-001"' in emit(api)


def test_an_emitted_body_is_valid_json(petstore_api: CanonicalApi) -> None:
    for block in request_blocks(emit(petstore_api)):
        if "" not in block:
            continue
        body = "\n".join(block[block.index("") + 1 :]).strip()
        if body:
            json.loads(body)


# ---------------------------------------------------------------------------
# Losses and provenance
# ---------------------------------------------------------------------------


def test_the_constructs_a_request_file_cannot_hold_are_reported() -> None:
    api = rest_api(
        operations=[
            http_operation(),
            Operation(key="Widgets.Ping", name="Ping", kind=OperationKind.REQUEST_RESPONSE),
            Operation(key="widgets.created", name="created", kind=OperationKind.PUBLISH),
        ],
        channels=[Channel(key="widgets", name="widgets", address="widgets")],
        types=[Type(key="Widget", name="Widget", kind=TypeKind.RECORD)],
    )
    subjects = {loss.subject for loss in HttpFileEmitter().emit(api).losses}
    assert {
        "api-title",
        "channels-dropped",
        "types-not-declared",
        "unroutable-operation",
        "event-operation",
    } <= subjects


def test_a_model_with_no_server_reports_its_fallback_base_url() -> None:
    api = rest_api(servers=[], operations=[http_operation()])
    result = HttpFileEmitter().emit(api)
    assert any(loss.subject == "synthesized-base-url" for loss in result.losses)
    base = next(record for record in result.provenance if record.pointer == "/baseUrl")
    assert base.provenance.value == "default"
    assert "stand-in base URL" in result.files[0].content


def test_provenance_covers_every_emitted_block_and_is_sorted(
    orders_api: CanonicalApi,
) -> None:
    records = HttpFileEmitter().emit(orders_api).provenance
    pointers = [record.pointer for record in records]
    assert pointers == sorted(pointers)
    assert "/baseUrl" in pointers
    assert any(pointer.endswith("/url") for pointer in pointers)
    assert any(pointer.endswith("/method") for pointer in pointers)
    assert sum(1 for pointer in pointers if pointer.startswith("/requests/")) >= len(
        list(orders_api.operations())
    )
    assert next(
        record for record in records if record.pointer == "/baseUrl"
    ).provenance.value == "source"


def test_a_declared_header_value_is_source_and_a_placeholder_is_inferred() -> None:
    api = rest_api(
        operations=[
            http_operation(
                parameters=[
                    header_param("GET /widgets", "X-Region", default="eu-west-1"),
                    header_param("GET /widgets", "X-Trace"),
                ]
            )
        ]
    )
    by_pointer = {
        record.pointer: record.provenance.value
        for record in HttpFileEmitter().emit(api).provenance
    }
    assert by_pointer["/requests/getWidgets/headers/X-Region"] == "source"
    assert by_pointer["/requests/getWidgets/headers/X-Trace"] == "inferred"


# ---------------------------------------------------------------------------
# Header collapsing
# ---------------------------------------------------------------------------


def test_collapse_headers_keeps_the_last_spelling_at_the_first_position() -> None:
    collapsed = collapse_headers(
        {"accept": "A", "content-type": "PLACEHOLDER", "Content-Type": "application/json"}
    )
    assert collapsed == [("accept", "A"), ("Content-Type", "application/json")]


def test_collapse_headers_leaves_distinct_names_alone() -> None:
    headers = {"accept": "A", "x-api-key": "$API_KEY"}
    assert collapse_headers(headers) == list(headers.items())


# ---------------------------------------------------------------------------
# cURL output
# ---------------------------------------------------------------------------


def test_curl_output_is_a_shell_script_with_a_guarded_base_url(
    orders_api: CanonicalApi,
) -> None:
    result = HttpFileEmitter().emit(orders_api, opts=HttpFileEmitOptions(output="curl"))
    script = result.files[0].content
    assert result.files[0].path == "requests.sh"
    assert result.files[0].media_type == "text/x-shellscript"
    assert script.startswith("#!/usr/bin/env bash\n")
    assert "set -euo pipefail" in script
    assert 'BASE_URL="${BASE_URL:-https://orders.example.com}"' in script
    assert ': "${API_KEY:?set API_KEY before running this script}"' in script
    assert len(curl_commands(script)) == len(list(orders_api.operations()))


@pytest.mark.parametrize("variable_style", VARIABLE_STYLES)
def test_generated_scripts_are_syntactically_valid_shell(
    orders_api: CanonicalApi, variable_style: str, tmp_path: Path
) -> None:
    script = tmp_path / "requests.sh"
    script.write_text(emit(orders_api, output="curl", variable_style=variable_style))
    completed = subprocess.run(
        ["bash", "-n", str(script)], capture_output=True, text=True, check=False
    )
    assert completed.returncode == 0, completed.stderr


def test_the_curl_script_actually_runs_against_a_live_server(tmp_path: Path) -> None:
    """The ticket's "runnable script" criterion, proven by running it.

    A local stub stands in for the public host so the check is hermetic; what is asserted
    is that ``bash`` executes the emitted script to completion and that the server received
    exactly the calls the canonical model describes.
    """
    received: List[Tuple[str, str, Optional[str]]] = []

    class _Handler(http.server.BaseHTTPRequestHandler):
        def _record(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else None
            received.append((self.command, self.path, body))
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        # BaseHTTPRequestHandler dispatches on these exact names; the casing is its API.
        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _record  # noqa: N815

        def log_message(self, *args: Any) -> None:  # noqa: A003 - silence the stub
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        api = import_http_fixture("01-minimal-ping.http")
        script = tmp_path / "requests.sh"
        script.write_text(
            emit(api, output="curl", variable_style="inline", base_url=base)
        )
        completed = subprocess.run(
            ["bash", str(script)], capture_output=True, text=True, check=False, timeout=30
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert completed.returncode == 0, completed.stderr
    assert received == [("GET", "/ping", None)]


def test_the_curl_script_sends_bodies_and_headers_it_was_given(tmp_path: Path) -> None:
    """A body and a credential supplied from the environment reach the server intact."""
    received: List[Tuple[str, str, Dict[str, str], Optional[str]]] = []

    class _Handler(http.server.BaseHTTPRequestHandler):
        def _record(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else None
            received.append((self.command, self.path, dict(self.headers), body))
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST = _record  # noqa: N815

        def log_message(self, *args: Any) -> None:  # noqa: A003 - silence the stub
            return

    api = rest_api(
        operations=[
            http_operation(
                key="POST /widgets",
                method="POST",
                path="/widgets",
                parameters=[
                    header_param("POST /widgets", "X-API-Key")
                ],
                messages=[
                    Message(
                        key="POST /widgets.request",
                        name="WidgetRequest",
                        role=MessageRole.REQUEST,
                        content_types=["application/json"],
                        payload_schema={
                            "type": "object",
                            "required": ["name"],
                            "properties": {"name": {"type": "string"}},
                        },
                    )
                ],
            )
        ]
    )

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        script = tmp_path / "requests.sh"
        script.write_text(emit(api, output="curl", base_url=base))
        completed = subprocess.run(
            ["bash", str(script)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin", "API_KEY": "supplied-by-the-caller"},
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert completed.returncode == 0, completed.stderr
    assert len(received) == 1
    method, path, headers, body = received[0]
    assert (method, path) == ("POST", "/widgets")
    assert headers["X-API-Key"] == "supplied-by-the-caller"
    assert json.loads(body or "") == {"name": "kilo-delta"}


def test_the_script_refuses_to_run_without_the_credential_it_names(tmp_path: Path) -> None:
    """The guard lines are the reason an unset credential fails loudly, not silently."""
    api = rest_api(
        operations=[
            http_operation(
                parameters=[
                    header_param("GET /widgets", "X-API-Key")
                ]
            )
        ]
    )
    script = tmp_path / "requests.sh"
    script.write_text(emit(api, output="curl"))
    completed = subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    assert completed.returncode != 0
    assert "set API_KEY before running this script" in completed.stderr


def test_a_dollar_sign_in_a_path_is_not_expanded_by_the_shell(tmp_path: Path) -> None:
    """OData's `/$metadata` must reach the server, not be eaten as an empty variable."""
    received: List[str] = []

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's dispatch name
            received.append(self.path)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args: Any) -> None:  # noqa: A003 - silence the stub
            return

    api = rest_api(
        operations=[http_operation(key="GET /$metadata", path="/$metadata")]
    )
    script_text = emit(api, output="curl")
    assert '\\$metadata' in script_text

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        script = tmp_path / "requests.sh"
        script.write_text(
            emit(api, output="curl", base_url=f"http://127.0.0.1:{server.server_address[1]}")
        )
        completed = subprocess.run(
            ["bash", str(script)], capture_output=True, text=True, check=False, timeout=30
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert completed.returncode == 0, completed.stderr
    assert received == ["/$metadata"]


def test_a_typed_body_survives_the_shell_quoting(petstore_api: CanonicalApi) -> None:
    """A JSON body is single-quoted, so nothing inside it is expanded by the shell."""
    script = emit(petstore_api, output="curl")
    assert "--data-raw '{" in script


# ---------------------------------------------------------------------------
# Emit envelope
# ---------------------------------------------------------------------------


def test_emit_returns_one_file_with_the_expected_envelope(orders_api: CanonicalApi) -> None:
    result = HttpFileEmitter().emit(orders_api)
    assert len(result.files) == 1
    assert result.media_type == "text/x-http"
    assert result.files[0].content.endswith("\n")
    assert result.field_identity_assignments == {}


def test_type_ref_payloads_are_synthesized_like_the_snippet_service_does() -> None:
    """A named-type payload resolves through the same `$ref` builder the snippets use."""
    api = rest_api(
        types=[
            Type(
                key="Widget",
                name="Widget",
                kind=TypeKind.RECORD,
                fields=[],
            )
        ],
        operations=[
            http_operation(
                key="POST /widgets",
                method="POST",
                path="/widgets",
                messages=[
                    Message(
                        key="POST /widgets.request",
                        name="WidgetRequest",
                        role=MessageRole.REQUEST,
                        content_types=["application/json"],
                        payload=TypeRef(name="Widget"),
                    )
                ],
            )
        ],
    )
    request, _ = synthesize_request(api, next(iter(api.operations())))
    text = emit(api)
    if request.body is not None:
        assert request.body in text
