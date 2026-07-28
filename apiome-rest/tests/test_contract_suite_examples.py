"""Attribution of declared examples to operations — ECA-1.1 (#4729).

Where examples *live* is covered by the IXH-5.4 walker tests. What is asserted here is the layer
the compiler depends on: that a walker pointer becomes the right ``(path, method, site)`` — a
request body, a named parameter, a response — across both HTTP families, and that everything
which names no operation is counted rather than dropped.
"""

from __future__ import annotations

from typing import Any, Dict

from app.contract_suite_examples import (
    SITE_PARAMETER,
    SITE_REQUEST_BODY,
    SITE_RESPONSE,
    harvest_declared_examples,
)

OPENAPI: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Petstore", "version": "1.0.0"},
    "components": {
        "schemas": {"Pet": {"type": "object", "example": {"name": "component"}}},
    },
    "webhooks": {
        "petCreated": {
            "post": {
                "requestBody": {
                    "content": {"application/json": {"schema": {"type": "object"}, "example": {}}}
                },
                "responses": {"200": {"description": "ok"}},
            }
        }
    },
    "paths": {
        "/pets/{petId}": {
            "parameters": [
                {
                    "name": "trace",
                    "in": "header",
                    "schema": {"type": "string"},
                    "example": "shared",
                }
            ],
            "get": {
                "parameters": [
                    {
                        "name": "petId",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                        "example": 42,
                    }
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                                "example": {"name": "Mia"},
                            }
                        },
                        "headers": {
                            "X-Rate": {"schema": {"type": "integer"}, "example": 10}
                        },
                    }
                },
            },
            "put": {
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {"type": "object"},
                            "examples": {
                                "rename": {"value": {"name": "Rex"}},
                                "external": {"externalValue": "https://example.com/x.json"},
                            },
                        }
                    }
                },
                "responses": {"200": {"description": "ok"}},
            },
        }
    },
}

SWAGGER: Dict[str, Any] = {
    "swagger": "2.0",
    "info": {"title": "Legacy", "version": "1.0.0"},
    "paths": {
        "/orders": {
            "post": {
                "parameters": [
                    {
                        "name": "body",
                        "in": "body",
                        "schema": {"type": "object", "example": {"total": 5}},
                    }
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "schema": {"type": "object"},
                        "examples": {"application/json": {"total": 5}},
                    }
                },
            }
        }
    },
}


def test_a_request_body_example_is_attributed_to_its_operation() -> None:
    """`examples/{name}/value` carries the example name and the media type it was declared as."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    bodies = [
        example for example in harvest.examples if example.site == SITE_REQUEST_BODY
    ]
    assert len(bodies) == 1
    body = bodies[0]
    assert (body.http_path, body.http_method) == ("/pets/{petId}", "PUT")
    assert body.name == "rename"
    assert body.media_type == "application/json"
    assert body.value == {"name": "Rex"}
    # The pointer is the example's identity, with `/` in the path escaped as `~1` per RFC 6901.
    assert body.pointer == (
        "/paths/~1pets~1{petId}/put/requestBody/content/application~1json/examples/rename/value"
    )


def test_an_example_with_no_inline_value_is_not_invented() -> None:
    """An `externalValue` entry has nothing to send, so it produces no example."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    assert all(example.name != "external" for example in harvest.examples)


def test_a_parameter_example_carries_its_name_and_location() -> None:
    """The compiler looks a parameter value up by `(location, name)`, not by index."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    parameters = {
        (example.parameter_location, example.parameter_name): example
        for example in harvest.examples
        if example.site == SITE_PARAMETER
    }
    assert parameters[("path", "petId")].value == 42
    assert parameters[("path", "petId")].http_method == "GET"


def test_a_path_level_parameter_example_applies_to_every_method() -> None:
    """Its method is left unset, which is how the compiler knows it is not method-specific."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    shared = next(
        example
        for example in harvest.examples
        if example.parameter_name == "trace"
    )
    assert shared.http_method is None
    assert shared.http_path == "/pets/{petId}"


def test_a_response_example_is_attributed_with_its_status_code() -> None:
    """Response examples describe what comes back, so they carry the code and media type."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    responses = [
        example for example in harvest.examples if example.site == SITE_RESPONSE
    ]
    assert len(responses) == 1
    assert responses[0].status_code == "200"
    assert responses[0].media_type == "application/json"


def test_a_response_header_example_is_not_read_as_a_body() -> None:
    """A header example describes a header; attributing it to the body would be nonsense."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    assert all(example.value != 10 for example in harvest.examples)
    assert harvest.unattributed >= 1


def test_component_and_webhook_examples_are_counted_not_dropped() -> None:
    """"We found examples we did not compile" must be visible to a reader."""
    harvest = harvest_declared_examples(OPENAPI, verify=False)
    assert harvest.unattributed >= 2
    assert all(example.http_path == "/pets/{petId}" for example in harvest.examples)


def test_swagger_body_parameters_and_mime_keyed_responses_are_understood() -> None:
    """Swagger 2 spells both differently; the compiler must not care."""
    harvest = harvest_declared_examples(SWAGGER, verify=False)
    assert harvest.family == "swagger-2"
    sites = {example.site for example in harvest.examples}
    assert sites == {SITE_REQUEST_BODY, SITE_RESPONSE}
    body = next(e for e in harvest.examples if e.site == SITE_REQUEST_BODY)
    assert (body.http_path, body.http_method, body.value) == ("/orders", "POST", {"total": 5})
    response = next(e for e in harvest.examples if e.site == SITE_RESPONSE)
    assert response.media_type == "application/json"


def test_verification_lists_the_examples_that_fail_their_own_schema() -> None:
    """The compiler excludes exactly these, so the set must be exact."""
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Strict", "version": "1.0.0"},
        "paths": {
            "/pets": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["name"],
                                    "properties": {"name": {"type": "string"}},
                                },
                                "examples": {
                                    "good": {"value": {"name": "Mia"}},
                                    "bad": {"value": {"name": 7}},
                                },
                            }
                        }
                    },
                    "responses": {"201": {"description": "ok"}},
                }
            }
        },
    }
    harvest = harvest_declared_examples(document, verify=True)
    assert harvest.verified is True
    assert len(harvest.nonconforming) == 1
    assert next(iter(harvest.nonconforming)).endswith("/examples/bad/value")


def test_an_unwalked_family_claims_nothing() -> None:
    """Silence about a format we do not read is the only honest answer."""
    harvest = harvest_declared_examples({"asyncapi": None, "not": "a spec"}, verify=False)
    assert harvest.family is None
    assert harvest.examples == ()
    assert harvest.nonconforming == frozenset()


def test_a_non_mapping_document_is_handled() -> None:
    """A canonical model's `raw` can be anything; the harvest must not raise."""
    assert harvest_declared_examples(None, verify=False).examples == ()
    assert harvest_declared_examples([1, 2, 3], verify=False).examples == ()


def test_harvest_order_is_the_walkers_deterministic_order() -> None:
    """Case order in a manifest derives from this, so it must be reproducible."""
    first = [e.pointer for e in harvest_declared_examples(OPENAPI, verify=False).examples]
    second = [e.pointer for e in harvest_declared_examples(OPENAPI, verify=False).examples]
    assert first == second
