"""Serverless adapter tests (#4743, PMR-1.3).

The acceptance criteria are tested directly:

* *A function invocation handles a PMR bundle deterministically* — the shared conformance corpus is
  run through every supported provider's real event shape, and identical requests are asserted to
  produce identical responses.
* *Cold-start, size, and timeout constraints are surfaced* — the adapter's measurement, headers, and
  payload guards (``test_serverless_preflight.py`` covers the report built on top of them).
* *No provider secret is embedded in the bundle* — a bundle carrying one cannot be loaded, whether
  it is embedded as text, as structure, or inside a fixture.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Iterator

import pytest
from app.mock_bundle import BundleIdentity, FixtureSource, build_bundle, bundle_bytes

from apiome_mock import serverless
from apiome_mock.bundle import MockBundleError
from apiome_mock.conformance import DEFAULT_BUNDLE_PATH, load_corpus, run_corpus
from apiome_mock.portable_config import PortableSettings
from apiome_mock.serverless import (
    ProviderSecretError,
    ServerlessAdapter,
    aws_lambda_handler,
    create_adapter,
    dispatch,
    get_adapter,
    handler_for,
    load_serverless_bundle,
    reset_adapter,
    scan_provider_secrets,
    serverless_sender,
)
from apiome_mock.serverless_providers import (
    PROVIDER_NAMES,
    AwsLambdaProvider,
    FunctionRequest,
    Provider,
    ProviderLimits,
    provider_for,
)

SECRET = "serverless-signing-secret"

_SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Tiny", "version": "1.0.0"},
    "paths": {
        "/things": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"example": {"things": []}}},
                    }
                }
            }
        }
    },
}


def _write_bundle(tmp_path: Path, *, secret: str | None = None, **kwargs: Any) -> Path:
    """Write a bundle to disk exactly as the exporter would."""
    document = build_bundle(
        identity=BundleIdentity(
            tenant="acme",
            project="tiny",
            version="1.0.0",
            revision_id="11111111-2222-3333-4444-555555555555",
        ),
        spec=_SPEC,
        secret=secret,
        **kwargs,
    )
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))
    return path


@pytest.fixture
def adapter() -> Iterator[ServerlessAdapter]:
    """An adapter over the packaged conformance bundle, closed after the test."""
    built = create_adapter(PortableSettings.isolated(bundle=str(DEFAULT_BUNDLE_PATH)))
    try:
        yield built
    finally:
        built.close()


@pytest.fixture(autouse=True)
def clear_process_adapter() -> Iterator[None]:
    """Keep the process-wide adapter from leaking between tests."""
    reset_adapter()
    yield
    reset_adapter()


# ---------------------------------------------------------------------------
# A function invocation handles a bundle deterministically
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("provider_name", PROVIDER_NAMES)
def test_conformance_corpus_passes_through_every_provider(provider_name: str) -> None:
    """The whole shared corpus, through each provider's real event shape.

    This is the acceptance criterion: a function invocation must answer a bundle exactly as the
    CLI, the image, and the hosted runtime do — event translation included. A fresh adapter per
    provider matters, because the corpus asserts scenario sequence positions that advance per
    execution environment.
    """
    built = create_adapter(PortableSettings.isolated(bundle=str(DEFAULT_BUNDLE_PATH)))
    try:
        report = run_corpus(
            serverless_sender(built, provider=provider_for(provider_name)),
            corpus=load_corpus(),
            base_url=provider_name,
        )
    finally:
        built.close()

    assert report.ok, "\n".join(f"{case.name}: {case.failures}" for case in report.failed)


def test_identical_invocations_produce_identical_responses(adapter: ServerlessAdapter) -> None:
    """Determinism within one execution environment: no per-invocation entropy anywhere."""
    provider = provider_for("aws-lambda")
    event = provider.encode_request(FunctionRequest(method="GET", path=f"{adapter.mount}/pets"))

    first = provider.decode_response(dispatch(provider, event, adapter=adapter))
    second = provider.decode_response(dispatch(provider, event, adapter=adapter))

    assert first.status == second.status
    assert first.body == second.body


def test_two_execution_environments_answer_the_same_bundle_identically() -> None:
    """Determinism *across* environments: a scaled-out function must not answer two ways."""
    provider = provider_for("aws-lambda")
    request = FunctionRequest(method="GET", path="/conformance/petstore/1.0.0/pets")

    bodies = []
    for _ in range(2):
        built = create_adapter(PortableSettings.isolated(bundle=str(DEFAULT_BUNDLE_PATH)))
        try:
            payload = dispatch(provider, provider.encode_request(request), adapter=built)
            bodies.append(provider.decode_response(payload).body)
        finally:
            built.close()

    assert bodies[0] == bodies[1]


def test_reserved_endpoints_answer_through_a_function_invocation(adapter: ServerlessAdapter) -> None:
    """``/ready`` is what a deployment check calls; it must work through an event too."""
    provider = provider_for("aws-lambda")
    payload = dispatch(provider, provider.encode_request(FunctionRequest(method="GET", path="/ready")), adapter=adapter)
    ready = provider.decode_response(payload).json()

    assert ready["status"] == "ready"
    assert ready["bundle"]["digest"] == adapter.bundle.digest


def test_a_path_outside_the_mount_is_a_problem_404(adapter: ServerlessAdapter) -> None:
    """The adapter adds no routing of its own — the runtime's 404 is what comes back."""
    provider = provider_for("aws-lambda")
    payload = dispatch(provider, provider.encode_request(FunctionRequest(method="GET", path="/nope")), adapter=adapter)
    response = provider.decode_response(payload)

    assert response.status == 404
    assert response.header("content-type") == "application/problem+json"


# ---------------------------------------------------------------------------
# Cold start and per-invocation observability
# ---------------------------------------------------------------------------


def test_cold_start_is_measured_and_broken_down(adapter: ServerlessAdapter) -> None:
    """The number a provider's initialization budget is spent against has to be real."""
    cold_start = adapter.cold_start

    assert cold_start.total_ms > 0
    assert cold_start.bundle_ms > 0
    assert cold_start.total_ms == pytest.approx(cold_start.bundle_ms + cold_start.app_ms)


def test_only_the_first_invocation_is_flagged_cold(adapter: ServerlessAdapter) -> None:
    """Warm invocations reuse the compiled bundle, and say so."""
    request = FunctionRequest(method="GET", path="/health")

    first = adapter.invoke(request)
    second = adapter.invoke(request)

    assert first.header("x-apiome-mock-cold-start") == "true"
    assert second.header("x-apiome-mock-cold-start") == "false"
    assert adapter.invocations == 2


def test_every_response_names_the_bundle_that_answered(adapter: ServerlessAdapter) -> None:
    """A digest on the response is how a CI job proves which artifact the function served."""
    response = adapter.invoke(FunctionRequest(method="GET", path="/health"))

    assert response.header("x-apiome-mock-bundle-digest") == adapter.bundle.digest
    assert response.header("x-apiome-mock-runtime") == "serverless"
    assert float(response.header("x-apiome-mock-cold-start-ms") or "0") > 0


def test_describe_reports_the_deployment_without_leaking_configuration(adapter: ServerlessAdapter) -> None:
    """The cold-start log line is built from this; it must be safe to emit at INFO."""
    described = adapter.describe()

    assert described["runtime"]["mode"] == "serverless"
    assert described["bundle"]["digest"] == adapter.bundle.digest
    assert described["bundle"]["bytes"] > 0
    assert described["coldStart"]["totalMs"] > 0
    assert "secret" not in json.dumps(described).lower()


def test_the_remaining_invocation_time_never_changes_the_response(adapter: ServerlessAdapter) -> None:
    """A mock that behaved differently near its deadline would not be deterministic."""

    class _Context:
        def get_remaining_time_in_millis(self) -> int:
            return 12

    provider = provider_for("aws-lambda")
    event = provider.encode_request(FunctionRequest(method="GET", path=f"{adapter.mount}/pets"))

    hurried = provider.decode_response(dispatch(provider, event, context=_Context(), adapter=adapter))
    relaxed = provider.decode_response(dispatch(provider, event, adapter=adapter))

    assert hurried.status == relaxed.status
    assert hurried.body == relaxed.body


def test_a_broken_context_object_does_not_fail_the_invocation(adapter: ServerlessAdapter) -> None:
    """Remaining time is telemetry; a provider stub that misbehaves must not cost a response."""

    class _Context:
        def get_remaining_time_in_millis(self) -> int:
            raise RuntimeError("no clock")

    provider = provider_for("aws-lambda")
    event = provider.encode_request(FunctionRequest(method="GET", path=f"{adapter.mount}/pets"))

    assert provider.decode_response(dispatch(provider, event, context=_Context(), adapter=adapter)).status == 200


# ---------------------------------------------------------------------------
# Session state is per execution environment
# ---------------------------------------------------------------------------


def test_session_state_survives_warm_invocations(adapter: ServerlessAdapter) -> None:
    """Two requests to one warm instance share session state, exactly as the served runtime does."""
    provider = provider_for("aws-lambda")
    session = (("x-mock-session", "s-1"), ("content-type", "application/json"))

    dispatch(
        provider,
        provider.encode_request(
            FunctionRequest(
                method="POST",
                path=f"{adapter.mount}/pets",
                headers=session,
                body=json.dumps({"id": 42, "name": "Rex"}).encode("utf-8"),
            )
        ),
        adapter=adapter,
    )
    read_back = provider.decode_response(
        dispatch(
            provider,
            provider.encode_request(FunctionRequest(method="GET", path=f"{adapter.mount}/pets/42", headers=session)),
            adapter=adapter,
        )
    )

    assert read_back.status == 200
    assert (read_back.json() or {}).get("name") == "Rex"


def test_session_state_does_not_reach_a_cold_execution_environment(adapter: ServerlessAdapter) -> None:
    """The constraint the guide documents, asserted: memory does not travel between instances."""
    provider = provider_for("aws-lambda")
    session = (("x-mock-session", "s-2"), ("content-type", "application/json"))
    dispatch(
        provider,
        provider.encode_request(
            FunctionRequest(
                method="POST",
                path=f"{adapter.mount}/pets",
                headers=session,
                body=json.dumps({"id": 99, "name": "Ghost"}).encode("utf-8"),
            )
        ),
        adapter=adapter,
    )

    cold = create_adapter(PortableSettings.isolated(bundle=str(DEFAULT_BUNDLE_PATH)))
    try:
        response = provider.decode_response(
            dispatch(
                provider,
                provider.encode_request(FunctionRequest(method="GET", path=f"{cold.mount}/pets/99", headers=session)),
                adapter=cold,
            )
        )
    finally:
        cold.close()

    assert (response.json() or {}).get("name") != "Ghost"


# ---------------------------------------------------------------------------
# No provider secret is embedded in the bundle
# ---------------------------------------------------------------------------


def test_a_bundle_carrying_an_aws_key_id_is_refused(tmp_path: Path) -> None:
    """An access key id pasted into a spec example is the realistic case, and is caught."""
    spec = json.loads(json.dumps(_SPEC))
    spec["paths"]["/things"]["get"]["responses"]["200"]["content"]["application/json"]["example"] = {
        "note": "call with AKIAIOSFODNN7EXAMPLE"
    }
    document = build_bundle(
        identity=BundleIdentity(tenant="acme", project="tiny", version="1.0.0", revision_id="r1"),
        spec=spec,
    )
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))

    with pytest.raises(ProviderSecretError) as excinfo:
        load_serverless_bundle(path)

    assert [finding.code for finding in excinfo.value.findings] == ["aws-access-key-id"]


def test_a_bundle_carrying_a_service_account_key_is_refused(tmp_path: Path) -> None:
    """A Google key survives JSON parsing as structure, so the shape is what identifies it."""
    spec = json.loads(json.dumps(_SPEC))
    spec["paths"]["/things"]["get"]["responses"]["200"]["content"]["application/json"]["example"] = {
        "type": "service_account",
        "project_id": "acme",
    }
    document = build_bundle(
        identity=BundleIdentity(tenant="acme", project="tiny", version="1.0.0", revision_id="r1"),
        spec=spec,
    )
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))

    with pytest.raises(ProviderSecretError) as excinfo:
        load_serverless_bundle(path)

    assert "gcp-service-account-key" in {finding.code for finding in excinfo.value.findings}


def test_a_secret_hidden_inside_a_fixture_is_refused(tmp_path: Path) -> None:
    """Fixtures travel base64-encoded, so being unreadable is not the same as being clean."""
    path = _write_bundle(
        tmp_path,
        fixtures=[
            FixtureSource(
                name="seed.json",
                content=json.dumps({"connection": "DefaultEndpointsProtocol=https;AccountKey=abc"}).encode(),
            )
        ],
    )

    with pytest.raises(ProviderSecretError) as excinfo:
        load_serverless_bundle(path)

    assert "azure-shared-key" in {finding.code for finding in excinfo.value.findings}


def test_a_clean_bundle_scans_clean(tmp_path: Path) -> None:
    """The scan must not fire on ordinary specs, or it would be turned off."""
    loaded = load_serverless_bundle(_write_bundle(tmp_path))

    assert loaded.document_bytes > 0
    assert scan_provider_secrets(json.loads(loaded.path.read_text(encoding="utf-8"))) == ()


def test_scan_reports_where_the_credential_is() -> None:
    """A finding a reader cannot act on is not worth raising; the pointer is the actionable part."""
    findings = scan_provider_secrets({"components": {"examples": {"key": "AKIAIOSFODNN7EXAMPLE"}}})

    assert [finding.pointer for finding in findings] == ["/components/examples/key"]


def test_the_signing_secret_comes_from_the_environment_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A function has no command line; the secret must come from the environment and nowhere else."""
    path = _write_bundle(tmp_path, secret=SECRET)
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(path))
    monkeypatch.setenv("APIOME_MOCK_REQUIRE_SIGNATURE", "true")
    monkeypatch.delenv("APIOME_MOCK_BUNDLE_SECRET", raising=False)

    with pytest.raises(MockBundleError):
        create_adapter()  # signature required, no secret configured

    monkeypatch.setenv("APIOME_MOCK_BUNDLE_SECRET", SECRET)
    built = create_adapter()
    try:
        assert built.bundle.signed is True
    finally:
        built.close()


def test_an_event_cannot_supply_the_signing_secret(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller must not be able to talk the runtime into trusting a bundle it cannot verify."""
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(_write_bundle(tmp_path, secret=SECRET)))
    monkeypatch.setenv("APIOME_MOCK_BUNDLE_SECRET", "wrong-secret")

    with pytest.raises(MockBundleError):
        aws_lambda_handler(
            {
                "version": "2.0",
                "rawPath": "/",
                "requestContext": {"http": {"method": "GET"}},
                "apiomeMockBundleSecret": SECRET,
            }
        )


# ---------------------------------------------------------------------------
# Payload limits are enforced, not hoped for
# ---------------------------------------------------------------------------


def _provider_with_limits(**overrides: Any) -> Provider:
    """An AWS-shaped provider with limits small enough to cross in a test."""
    base = provider_for("aws-lambda").limits
    fields: dict[str, Any] = {
        "max_package_bytes": base.max_package_bytes,
        "max_request_bytes": base.max_request_bytes,
        "max_response_bytes": base.max_response_bytes,
        "max_function_timeout_seconds": base.max_function_timeout_seconds,
        "max_gateway_timeout_seconds": base.max_gateway_timeout_seconds,
        "max_init_seconds": base.max_init_seconds,
        "docs_url": base.docs_url,
        "verified_on": base.verified_on,
        "notes": base.notes,
    }
    fields.update(overrides)
    return AwsLambdaProvider(
        name="tiny-limits",
        title="Tiny Limits",
        entrypoint="apiome_mock.serverless.aws_lambda_handler",
        payload_formats=("apigateway-http-2.0",),
        limits=ProviderLimits(**fields),
    )


def test_an_oversized_request_is_refused_before_the_mock_sees_it(adapter: ServerlessAdapter) -> None:
    """The provider's own limit becomes a documented problem+json rather than a gateway error."""
    provider = _provider_with_limits(max_request_bytes=64)
    event = provider.encode_request(
        FunctionRequest(
            method="POST",
            path=f"{adapter.mount}/pets",
            headers=(("content-type", "application/json"),),
            body=b"x" * 512,
        )
    )

    response = provider.decode_response(dispatch(provider, event, adapter=adapter))

    assert response.status == 413
    assert (response.json() or {})["maxRequestBytes"] == 64
    assert adapter.invocations == 0  # refused without spending an invocation on the mock


def test_an_oversized_response_is_refused_rather_than_truncated(adapter: ServerlessAdapter) -> None:
    """Half a JSON body is worse than a stated refusal."""
    provider = _provider_with_limits(max_response_bytes=8)
    event = provider.encode_request(FunctionRequest(method="GET", path=f"{adapter.mount}/pets"))

    response = provider.decode_response(dispatch(provider, event, adapter=adapter))

    assert response.status == 502
    assert (response.json() or {})["maxResponseBytes"] == 8


def test_an_unsupported_event_is_a_problem_document(adapter: ServerlessAdapter) -> None:
    """A function wired to the wrong trigger should say so in the response it can still return."""
    provider = provider_for("aws-lambda")

    response = provider.decode_response(dispatch(provider, {"Records": []}, adapter=adapter))

    assert response.status == 400
    assert response.header("content-type") == "application/problem+json"
    assert "serverless-event-unsupported" in (response.json() or {})["type"]


# ---------------------------------------------------------------------------
# Process-wide adapter, handlers, and the ASGI door
# ---------------------------------------------------------------------------


def test_the_adapter_is_built_once_per_execution_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Reusing it is the whole point: otherwise every request pays the cold start."""
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(_write_bundle(tmp_path)))

    assert get_adapter() is get_adapter()

    first = get_adapter()
    reset_adapter()

    assert get_adapter() is not first


def test_a_missing_bundle_fails_the_cold_start_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    """A function answering every request with a 500 is harder to diagnose than one that dies."""
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", "")

    with pytest.raises(ValueError, match="APIOME_MOCK_BUNDLE"):
        get_adapter()


def test_handlers_are_registered_for_every_provider() -> None:
    """Each provider's documented entrypoint must be reachable by name too."""
    for name in PROVIDER_NAMES:
        assert callable(handler_for(name))


def test_the_aws_handler_serves_the_configured_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """End to end through the real entrypoint: environment in, API Gateway envelope out."""
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(_write_bundle(tmp_path)))

    payload = aws_lambda_handler(
        {
            "version": "2.0",
            "rawPath": "/acme/tiny/1.0.0/things",
            "rawQueryString": "",
            "headers": {},
            "requestContext": {"http": {"method": "GET"}},
        },
        None,
    )

    assert payload["statusCode"] == 200
    assert json.loads(payload["body"]) == {"things": []}
    assert payload["headers"]["x-apiome-mock-runtime"] == "serverless"


def test_the_asgi_door_serves_the_same_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Providers with a native ASGI shim skip event translation entirely."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(_write_bundle(tmp_path)))

    with TestClient(serverless.asgi_app()) as client:
        assert client.get("/acme/tiny/1.0.0/things").json() == {"things": []}


def test_a_base64_request_body_reaches_the_mock_intact(adapter: ServerlessAdapter) -> None:
    """Binary uploads are the reason isBase64Encoded exists; the mock must see real bytes."""
    provider = provider_for("aws-lambda")
    body = json.dumps({"id": 7, "name": "Bin"}).encode("utf-8")
    event = {
        "version": "2.0",
        "rawPath": f"{adapter.mount}/pets",
        "rawQueryString": "",
        "headers": {"content-type": "application/json", "x-mock-session": "s-3"},
        "requestContext": {"http": {"method": "POST"}},
        "body": base64.b64encode(body).decode("ascii"),
        "isBase64Encoded": True,
    }

    response = provider.decode_response(dispatch(provider, event, adapter=adapter))

    assert response.status == 201
