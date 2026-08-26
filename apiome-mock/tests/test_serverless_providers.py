"""Provider event translation tests (#4743, PMR-1.3).

The adapter's behavior is the portable runtime's, proven by the shared corpus in
``test_serverless.py``. What is *only* testable here is the translation itself: every provider's
event shape in, every provider's return shape out, and the two directions agreeing.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest

from apiome_mock.serverless_providers import (
    PROVIDER_NAMES,
    PROVIDERS,
    AwsLambdaProvider,
    AzureLikeResponse,
    FunctionRequest,
    FunctionResponse,
    Provider,
    UnknownProviderError,
    provider_for,
)


@pytest.fixture(params=PROVIDER_NAMES)
def provider(request: pytest.FixtureRequest) -> Provider:
    """Each supported provider in turn, so shared expectations are asserted for all of them."""
    return provider_for(str(request.param))


# ---------------------------------------------------------------------------
# Round-trip: every provider's two directions must be inverses
# ---------------------------------------------------------------------------


def test_request_survives_a_round_trip_through_every_provider(provider: Provider) -> None:
    """encode_request → decode_request must return the request it started from."""
    original = FunctionRequest(
        method="POST",
        path="/acme/petstore/1.0.0/pets",
        query_string="limit=2&sort=name",
        headers=(("content-type", "application/json"), ("x-mock-scenario", "outage")),
        body=b'{"name":"Rex"}',
    )

    decoded = provider.decode_request(provider.encode_request(original))

    assert decoded.method == original.method
    assert decoded.path == original.path
    assert sorted(decoded.query_string.split("&")) == sorted(original.query_string.split("&"))
    assert decoded.body == original.body
    assert decoded.header("content-type") == "application/json"
    assert decoded.header("x-mock-scenario") == "outage"


def test_response_survives_a_round_trip_through_every_provider(provider: Provider) -> None:
    """encode_response → decode_response must return the response it started from."""
    original = FunctionResponse(
        status=201,
        headers=(("content-type", "application/json"), ("x-mock-fixture", "pets")),
        body=b'{"id":1}',
    )

    decoded = provider.decode_response(provider.encode_response(original, event=None))

    assert decoded.status == 201
    assert decoded.body == b'{"id":1}'
    assert decoded.header("content-type") == "application/json"
    assert decoded.header("x-mock-fixture") == "pets"


def test_binary_bodies_survive_a_round_trip(provider: Provider) -> None:
    """A non-textual body must not be mangled by a JSON event envelope."""
    payload = bytes(range(256))
    original = FunctionResponse(status=200, headers=(("content-type", "application/octet-stream"),), body=payload)

    decoded = provider.decode_response(provider.encode_response(original, event=None))

    assert decoded.body == payload


def test_empty_bodies_survive_a_round_trip(provider: Provider) -> None:
    """A 204 carries no body, and must not gain one in translation."""
    decoded = provider.decode_response(provider.encode_response(FunctionResponse(status=204), event=None))

    assert decoded.status == 204
    assert decoded.body == b""


# ---------------------------------------------------------------------------
# AWS payload formats
# ---------------------------------------------------------------------------


def test_aws_decodes_payload_format_2(provider_aws: AwsLambdaProvider) -> None:
    """An HTTP API event carries the method under requestContext and the path raw."""
    event = {
        "version": "2.0",
        "rawPath": "/acme/petstore/1.0.0/pets/a%20b",
        "rawQueryString": "limit=2",
        "headers": {"Accept": "application/json"},
        "requestContext": {"http": {"method": "get", "path": "/x", "sourceIp": "203.0.113.9"}},
        "body": None,
        "isBase64Encoded": False,
    }

    request = provider_aws.decode_request(event)

    assert request.method == "GET"
    assert request.path == "/acme/petstore/1.0.0/pets/a b"  # percent-decoded, as ASGI requires
    assert request.query_string == "limit=2"
    assert request.header("accept") == "application/json"
    assert request.client_ip == "203.0.113.9"


def test_aws_decodes_payload_format_1(provider_aws: AwsLambdaProvider) -> None:
    """A REST API / ALB event carries httpMethod at the top level and query parameters as a map."""
    event = {
        "httpMethod": "POST",
        "path": "/acme/petstore/1.0.0/pets",
        "headers": {"Content-Type": "application/json"},
        "queryStringParameters": {"limit": "2"},
        "body": '{"name":"Rex"}',
        "isBase64Encoded": False,
    }

    request = provider_aws.decode_request(event)

    assert request.method == "POST"
    assert request.query_string == "limit=2"
    assert request.body == b'{"name":"Rex"}'


def test_aws_prefers_multi_value_headers_when_the_event_has_them(provider_aws: AwsLambdaProvider) -> None:
    """Duplicated request headers are values in their own right, not a comma-joined string."""
    event = {
        "httpMethod": "GET",
        "path": "/pets",
        "headers": {"accept": "application/json"},
        "multiValueHeaders": {"accept": ["application/json", "text/plain"]},
    }

    request = provider_aws.decode_request(event)

    assert [value for key, value in request.headers if key == "accept"] == ["application/json", "text/plain"]


def test_aws_decodes_a_base64_request_body(provider_aws: AwsLambdaProvider) -> None:
    """A binary upload arrives base64-encoded and must reach the app as bytes."""
    event = {
        "version": "2.0",
        "rawPath": "/pets",
        "requestContext": {"http": {"method": "POST"}},
        "body": base64.b64encode(b"\x00\x01\x02").decode("ascii"),
        "isBase64Encoded": True,
    }

    assert provider_aws.decode_request(event).body == b"\x00\x01\x02"


def test_aws_answers_a_v1_event_in_v1_shape(provider_aws: AwsLambdaProvider) -> None:
    """The response format follows the request format, so one handler serves either wiring."""
    payload = provider_aws.encode_response(
        FunctionResponse(status=200, headers=(("content-type", "application/json"),), body=b"{}"),
        event={"httpMethod": "GET", "path": "/pets"},
    )

    assert payload["statusCode"] == 200
    assert payload["multiValueHeaders"] == {"content-type": ["application/json"]}
    assert payload["body"] == "{}"
    assert payload["isBase64Encoded"] is False


def test_aws_lifts_cookies_out_of_the_header_map_in_v2(provider_aws: AwsLambdaProvider) -> None:
    """Payload format 2.0 carries Set-Cookie in its own field, never in headers."""
    payload = provider_aws.encode_response(
        FunctionResponse(status=200, headers=(("set-cookie", "a=b"), ("set-cookie", "c=d"))),
        event={"version": "2.0"},
    )

    assert payload["cookies"] == ["a=b", "c=d"]
    assert "set-cookie" not in payload["headers"]


def test_aws_folds_request_cookies_back_into_the_header_map(provider_aws: AwsLambdaProvider) -> None:
    """The app reads cookies from the Cookie header, so the v2 split has to be undone."""
    event = {
        "version": "2.0",
        "rawPath": "/pets",
        "cookies": ["a=b", "c=d"],
        "requestContext": {"http": {"method": "GET"}},
    }

    assert provider_aws.decode_request(event).header("cookie") == "a=b; c=d"


def test_aws_rejects_an_unrecognized_event(provider_aws: AwsLambdaProvider) -> None:
    """An event from a trigger the adapter does not support must say so, not guess."""
    with pytest.raises(ValueError, match="payload format"):
        provider_aws.decode_request({"Records": [{"s3": {}}]})


def test_aws_rejects_a_non_object_event(provider_aws: AwsLambdaProvider) -> None:
    with pytest.raises(ValueError, match="JSON objects"):
        provider_aws.decode_request("not an event")


# ---------------------------------------------------------------------------
# Google and Azure request shapes
# ---------------------------------------------------------------------------


def test_gcp_decodes_a_flask_shaped_request() -> None:
    """The Functions Framework passes a Flask request; nothing here may import Flask to read it."""
    provider = provider_for("gcp-functions")
    request = provider.decode_request(
        provider.encode_request(FunctionRequest(method="GET", path="/acme/petstore/1.0.0/pets", query_string="limit=2"))
    )

    assert (request.method, request.path, request.query_string) == ("GET", "/acme/petstore/1.0.0/pets", "limit=2")


def test_gcp_rejects_an_object_that_is_not_a_request() -> None:
    provider = provider_for("gcp-functions")
    with pytest.raises(ValueError, match="method"):
        provider.decode_request(object())


def test_azure_reads_path_and_query_out_of_the_request_url() -> None:
    """``azure.functions.HttpRequest`` exposes a full URL rather than a path and a query."""
    provider = provider_for("azure-functions")
    request = provider.decode_request(
        provider.encode_request(
            FunctionRequest(
                method="DELETE",
                path="/acme/petstore/1.0.0/pets/1",
                query_string="hard=true",
                headers=(("host", "mock.azurewebsites.net"),),
            )
        )
    )

    assert request.method == "DELETE"
    assert request.path == "/acme/petstore/1.0.0/pets/1"
    assert request.query_string == "hard=true"


def test_azure_builds_a_response_without_the_sdk_installed() -> None:
    """The stand-in keeps the adapter exercisable where the Azure SDK has no reason to exist."""
    provider = provider_for("azure-functions")
    response = provider.encode_response(FunctionResponse(status=418, body=b"teapot"), event=None)

    assert isinstance(response, AzureLikeResponse)
    assert (response.status_code, response.body) == (418, b"teapot")


def test_azure_rejects_an_object_that_is_not_a_response() -> None:
    provider = provider_for("azure-functions")
    with pytest.raises(ValueError, match="status_code"):
        provider.decode_response(object())


# ---------------------------------------------------------------------------
# Registry and published limits
# ---------------------------------------------------------------------------


def test_provider_lookup_names_the_supported_set_when_it_fails() -> None:
    """An unsupported target is a deployment decision, so the message has to list the options."""
    with pytest.raises(UnknownProviderError) as excinfo:
        provider_for("heroku")

    for name in PROVIDER_NAMES:
        assert name in str(excinfo.value)


def test_every_provider_publishes_usable_limits(provider: Provider) -> None:
    """The limits table is data the preflight and the guide both read; it has to be complete."""
    limits = provider.limits

    assert limits.max_package_bytes > limits.max_request_bytes
    assert limits.max_response_bytes > 0
    assert limits.max_gateway_timeout_seconds <= limits.max_function_timeout_seconds
    assert limits.docs_url.startswith("https://")
    assert limits.verified_on.count("-") == 2
    assert limits.notes


def test_cold_start_budget_falls_back_to_the_front_door_timeout(provider: Provider) -> None:
    """Where initialization is not metered separately it is charged to the first request."""
    limits = provider.limits
    expected = limits.max_init_seconds if limits.max_init_seconds is not None else limits.max_gateway_timeout_seconds

    assert limits.cold_start_budget_seconds == float(expected)


def test_provider_entrypoints_are_importable(provider: Provider) -> None:
    """The documented handler path is what a user pastes into a console; it must resolve."""
    import importlib

    module_name, _, attribute = provider.entrypoint.rpartition(".")
    module = importlib.import_module(module_name)

    assert callable(getattr(module, attribute))


def test_registry_is_keyed_by_provider_name() -> None:
    """``PROVIDERS`` and ``PROVIDER_NAMES`` must not be able to disagree."""
    assert tuple(PROVIDERS) == PROVIDER_NAMES
    assert all(PROVIDERS[name].name == name for name in PROVIDER_NAMES)


def test_provider_renders_itself_for_json_output(provider: Provider) -> None:
    document: dict[str, Any] = provider.as_dict()

    assert document["name"] == provider.name
    assert document["limits"]["docsUrl"] == provider.limits.docs_url
    assert document["payloadFormats"]


@pytest.fixture
def provider_aws() -> AwsLambdaProvider:
    """The registered AWS provider, typed for the payload-format assertions."""
    aws = provider_for("aws-lambda")
    assert isinstance(aws, AwsLambdaProvider)
    return aws
