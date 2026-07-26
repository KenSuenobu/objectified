"""Tests for the example-conformance walker and checker — IXH-5.4 (#5116).

Two contracts are under test here. The **walk** must reach every location the family table
declares — a location that is documented but never visited is a coverage lie — and pair each
example with the right governing schema. The **check** must validate under the family's own
dialect, resolve intra-document ``$ref``s, refuse to guess when a schema will not compile, and
stay bounded and deterministic.

:mod:`test_example_conformance_lint` covers the rule-pack adaptation; this file is the pure core.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from app.example_conformance import (
    EXAMPLE_FAMILIES,
    MAX_SCHEMA_WALK_DEPTH,
    SPEC_BASE_URI,
    check_example_conformance,
    family_for_format,
    resolve_example_family,
    supported_example_formats,
    supports_example_conformance,
    walk_example_sites,
)


def _pointers(document: Any, **kwargs: Any) -> List[str]:
    """Return the example pointers the walker finds, in walk order."""
    sites, _family, _truncated = walk_example_sites(document, **kwargs)
    return [site.example_pointer for site in sites]


def _pairs(document: Any, **kwargs: Any) -> Dict[str, str]:
    """Map every example pointer to the schema pointer the walker paired it with."""
    sites, _family, _truncated = walk_example_sites(document, **kwargs)
    return {site.example_pointer: site.schema_pointer for site in sites}


# ===========================================================================
# Family resolution
# ===========================================================================


@pytest.mark.parametrize(
    "document,expected",
    [
        ({"openapi": "3.1.0"}, "openapi-3.1"),
        ({"openapi": "3.1.1"}, "openapi-3.1"),
        ({"openapi": "3.0.3"}, "openapi-3.0"),
        ({"swagger": "2.0"}, "swagger-2"),
        ({"asyncapi": "2.6.0"}, "asyncapi-2"),
        ({"asyncapi": "3.0.0"}, "asyncapi-3"),
        ({"$schema": "https://json-schema.org/draft/2020-12/schema"}, "json-schema"),
    ],
)
def test_family_comes_from_the_documents_own_version_marker(
    document: Dict[str, Any], expected: str
) -> None:
    """A document declares what it is; that declaration is authoritative."""
    family = resolve_example_family(document)

    assert family is not None
    assert family.key == expected


def test_document_version_beats_a_contradicting_format_key() -> None:
    """A 3.0 document stored under the bare ``openapi`` key is still checked as 3.0.

    This is the whole reason the document wins: 3.0 spells ``exclusiveMinimum`` as a boolean,
    which draft 2020-12 rejects as an invalid schema — so trusting the key would turn a *schema*
    dialect mismatch into an unchecked example.
    """
    family = resolve_example_family({"openapi": "3.0.0"}, "openapi")

    assert family is not None
    assert family.key == "openapi-3.0"
    assert family.dialect == "04"


def test_format_key_is_the_fallback_when_the_document_declares_nothing() -> None:
    """A bare JSON Schema with no ``$schema`` is resolved from its stored format key."""
    family = resolve_example_family({"type": "object"}, "json-schema")

    assert family is not None
    assert family.key == "json-schema"


def test_unknown_documents_resolve_to_no_family() -> None:
    """A format with no example syntax yields no family — and therefore no claims."""
    assert resolve_example_family({"type": "object"}) is None
    assert resolve_example_family("not a mapping") is None
    assert resolve_example_family(None, "protobuf") is None
    assert supports_example_conformance("protobuf") is False
    assert supports_example_conformance(None) is False


def test_every_supported_format_token_resolves_to_a_declared_family() -> None:
    """The alias table cannot name a family the family table does not define."""
    tokens = supported_example_formats()

    assert tokens
    for token in tokens:
        family = family_for_format(token)
        assert family is not None, token
        assert family.key in EXAMPLE_FAMILIES


def test_every_family_declares_its_locations_and_a_supported_dialect() -> None:
    """The published location list is the coverage contract; it may never be empty."""
    from app.schema_instance_validation import SUPPORTED_DIALECTS

    for key, family in EXAMPLE_FAMILIES.items():
        assert family.key == key
        assert family.locations, f"{key} declares no locations"
        assert family.dialect in SUPPORTED_DIALECTS, key


# ===========================================================================
# OpenAPI 3.x walking
# ===========================================================================

_OPENAPI_31: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "t", "version": "1"},
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "integer", "example": "bad"}},
                "example": {"id": 1},
                "examples": [{"id": 2}, {"id": "also-bad"}],
            }
        },
        "parameters": {
            "Tenant": {
                "name": "tenant",
                "in": "header",
                "schema": {"type": "string"},
                "example": 7,
            }
        },
        "headers": {"XRate": {"schema": {"type": "integer"}, "example": "nope"}},
        "requestBodies": {
            "PetBody": {
                "content": {"application/json": {"schema": {"type": "object"}, "example": []}}
            }
        },
        "responses": {
            "Err": {
                "content": {"application/json": {"schema": {"type": "object"}, "example": 1}},
                "headers": {"XErr": {"schema": {"type": "string"}, "example": 2}},
            }
        },
    },
    "paths": {
        "/pets": {
            "parameters": [
                {"name": "trace", "in": "header", "schema": {"type": "string"}, "example": 1}
            ],
            "get": {
                "parameters": [
                    {"name": "limit", "in": "query", "schema": {"type": "integer"}, "example": "x"}
                ],
                "responses": {
                    "200": {
                        "content": {
                            "application/json": {
                                "schema": {"type": "array"},
                                "examples": {
                                    "a": {"value": [1]},
                                    "b": {"externalValue": "https://example.com/x.json"},
                                },
                            }
                        },
                        "headers": {"X-Total": {"schema": {"type": "integer"}, "example": "n"}},
                    }
                },
            },
            "post": {
                "requestBody": {
                    "content": {"application/json": {"schema": {"type": "object"}, "example": 5}}
                },
                "responses": {},
            },
        }
    },
    "webhooks": {
        "petCreated": {
            "post": {
                "requestBody": {
                    "content": {"application/json": {"schema": {"type": "object"}, "example": 9}}
                },
                "responses": {},
            }
        }
    },
}


def test_openapi_walk_reaches_every_declared_location() -> None:
    """Each location the 3.1 family declares contributes at least one site."""
    pointers = set(_pointers(_OPENAPI_31))

    assert "/components/schemas/Pet/example" in pointers
    assert "/components/schemas/Pet/examples/0" in pointers
    assert "/components/schemas/Pet/properties/id/example" in pointers
    assert "/components/parameters/Tenant/example" in pointers
    assert "/components/headers/XRate/example" in pointers
    assert "/components/requestBodies/PetBody/content/application~1json/example" in pointers
    assert "/components/responses/Err/content/application~1json/example" in pointers
    assert "/components/responses/Err/headers/XErr/example" in pointers
    assert "/paths/~1pets/parameters/0/example" in pointers
    assert "/paths/~1pets/get/parameters/0/example" in pointers
    assert "/paths/~1pets/get/responses/200/content/application~1json/examples/a/value" in pointers
    assert "/paths/~1pets/get/responses/200/headers/X-Total/example" in pointers
    assert "/paths/~1pets/post/requestBody/content/application~1json/example" in pointers
    assert "/webhooks/petCreated/post/requestBody/content/application~1json/example" in pointers


def test_carrier_examples_are_paired_with_the_carrier_schema() -> None:
    """A media-type example is governed by that media type's ``schema``, not the response."""
    pairs = _pairs(_OPENAPI_31)

    assert (
        pairs["/paths/~1pets/get/responses/200/content/application~1json/examples/a/value"]
        == "/paths/~1pets/get/responses/200/content/application~1json/schema"
    )
    assert pairs["/paths/~1pets/get/parameters/0/example"] == (
        "/paths/~1pets/get/parameters/0/schema"
    )


def test_schema_examples_are_paired_with_the_schema_they_sit_in() -> None:
    """A nested property's example is governed by that property, not by its parent."""
    pairs = _pairs(_OPENAPI_31)

    assert pairs["/components/schemas/Pet/example"] == "/components/schemas/Pet"
    assert (
        pairs["/components/schemas/Pet/properties/id/example"]
        == "/components/schemas/Pet/properties/id"
    )


def test_external_value_examples_are_skipped() -> None:
    """An Example Object whose content is not in the document cannot be checked."""
    pointers = _pointers(_OPENAPI_31)

    assert not any("examples/b" in pointer for pointer in pointers)


def test_ref_only_parameters_are_not_walked_twice() -> None:
    """A ``$ref`` parameter is walked at its target under ``components``, not at the use site."""
    document = {
        "openapi": "3.1.0",
        "components": {
            "parameters": {"Tenant": {"schema": {"type": "string"}, "example": 1}}
        },
        "paths": {
            "/x": {"get": {"parameters": [{"$ref": "#/components/parameters/Tenant"}]}}
        },
    }

    assert _pointers(document) == ["/components/parameters/Tenant/example"]


def test_openapi_30_ignores_a_schema_examples_array() -> None:
    """In 3.0 a schema has only ``example``; an ``examples`` key there is a vendor extension."""
    document = {
        "openapi": "3.0.3",
        "components": {
            "schemas": {"P": {"type": "integer", "example": 1, "examples": [2, 3]}}
        },
    }

    assert _pointers(document) == ["/components/schemas/P/example"]


def test_openapi_31_reads_a_schema_examples_array() -> None:
    """In 3.1 the same key *is* a list of instances."""
    document = {
        "openapi": "3.1.0",
        "components": {"schemas": {"P": {"type": "integer", "examples": [2, 3]}}},
    }

    assert _pointers(document) == [
        "/components/schemas/P/examples/0",
        "/components/schemas/P/examples/1",
    ]


# ===========================================================================
# Swagger 2 walking
# ===========================================================================

_SWAGGER_2: Dict[str, Any] = {
    "swagger": "2.0",
    "definitions": {"Pet": {"type": "object", "example": {"id": "bad"}}},
    "parameters": {
        "Body": {"name": "body", "in": "body", "schema": {"type": "object", "example": 1}}
    },
    "responses": {
        "Err": {"schema": {"type": "object"}, "examples": {"application/json": {"code": "x"}}}
    },
    "paths": {
        "/pets": {
            "post": {
                "parameters": [
                    {"name": "body", "in": "body", "schema": {"type": "object", "example": 2}}
                ],
                "responses": {
                    "200": {
                        "schema": {"type": "array"},
                        "examples": {"application/json": {"not": "an array"}},
                    }
                },
            }
        }
    },
}


def test_swagger2_walks_definitions_body_parameters_and_response_examples() -> None:
    """Swagger 2 has no Media Type Object: schemas hang off the parameter and the response."""
    pairs = _pairs(_SWAGGER_2)

    assert pairs["/definitions/Pet/example"] == "/definitions/Pet"
    assert pairs["/parameters/Body/schema/example"] == "/parameters/Body/schema"
    assert pairs["/responses/Err/examples/application~1json"] == "/responses/Err/schema"
    assert pairs["/paths/~1pets/post/parameters/0/schema/example"] == (
        "/paths/~1pets/post/parameters/0/schema"
    )
    assert pairs["/paths/~1pets/post/responses/200/examples/application~1json"] == (
        "/paths/~1pets/post/responses/200/schema"
    )


def test_swagger2_response_examples_are_keyed_by_mime_not_by_name() -> None:
    """The Swagger 2 ``examples`` map holds the instance directly, not an Example Object."""
    report = check_example_conformance(_SWAGGER_2)

    offending = [
        issue
        for issue in report.issues
        if issue.example_pointer == "/paths/~1pets/post/responses/200/examples/application~1json"
    ]
    assert offending, [i.example_pointer for i in report.issues]
    assert offending[0].keyword == "type"


# ===========================================================================
# AsyncAPI walking
# ===========================================================================

_ASYNCAPI_3: Dict[str, Any] = {
    "asyncapi": "3.0.0",
    "components": {
        "schemas": {"Payload": {"type": "object", "examples": [{"a": 1}]}},
        "messages": {
            "Evt": {
                "payload": {"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}},
                "headers": {"type": "object", "required": ["cid"]},
                "examples": [
                    {"name": "good", "payload": {"id": 1}, "headers": {"cid": "x"}},
                    {"name": "bad", "payload": {"id": "no"}, "headers": {}},
                ],
            }
        },
    },
    "channels": {
        "evt": {
            "messages": {
                "Inline": {
                    "payload": {"type": "string"},
                    "examples": [{"payload": 5}],
                }
            }
        }
    },
}

_ASYNCAPI_2: Dict[str, Any] = {
    "asyncapi": "2.6.0",
    "channels": {
        "evt": {
            "publish": {
                "message": {
                    "payload": {"type": "string"},
                    "examples": [{"payload": 5}],
                }
            },
            "subscribe": {
                "message": {
                    "oneOf": [
                        {"payload": {"type": "integer"}, "examples": [{"payload": "x"}]}
                    ]
                }
            },
        }
    },
}


def test_asyncapi3_walks_component_and_channel_messages() -> None:
    """Message example objects are paired with the message's own payload/headers schemas."""
    pairs = _pairs(_ASYNCAPI_3)

    assert pairs["/components/messages/Evt/examples/1/payload"] == (
        "/components/messages/Evt/payload"
    )
    assert pairs["/components/messages/Evt/examples/1/headers"] == (
        "/components/messages/Evt/headers"
    )
    assert pairs["/components/schemas/Payload/examples/0"] == "/components/schemas/Payload"
    assert pairs["/channels/evt/messages/Inline/examples/0/payload"] == (
        "/channels/evt/messages/Inline/payload"
    )


def test_asyncapi2_walks_publish_subscribe_and_oneof_messages() -> None:
    """The v2 channel shape (``publish``/``subscribe``, with ``oneOf`` variants) is covered."""
    pairs = _pairs(_ASYNCAPI_2)

    assert pairs["/channels/evt/publish/message/examples/0/payload"] == (
        "/channels/evt/publish/message/payload"
    )
    assert pairs["/channels/evt/subscribe/message/oneOf/0/examples/0/payload"] == (
        "/channels/evt/subscribe/message/oneOf/0/payload"
    )


def test_asyncapi_message_example_without_a_matching_schema_is_skipped() -> None:
    """An example ``headers`` block with no ``headers`` schema has nothing to be checked against."""
    document = {
        "asyncapi": "3.0.0",
        "components": {
            "messages": {"E": {"payload": {"type": "object"}, "examples": [{"headers": {"a": 1}}]}}
        },
    }

    assert _pointers(document) == []


# ===========================================================================
# JSON Schema walking
# ===========================================================================


def test_json_schema_walks_the_root_and_every_subschema() -> None:
    """A JSON Schema document is one schema tree; every branch keyword is followed."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "examples": [{"a": 1}],
        "properties": {"a": {"type": "integer", "examples": [1]}},
        "items": {"type": "string", "example": "s"},
        "allOf": [{"type": "object", "example": {}}],
        "$defs": {"D": {"type": "string", "examples": ["d"]}},
        "definitions": {"L": {"type": "string", "example": "l"}},
        "patternProperties": {"^x": {"type": "string", "example": "p"}},
        "additionalProperties": {"type": "string", "example": "ap"},
    }

    pointers = set(_pointers(document))

    assert "/examples/0" in pointers
    assert "/properties/a/examples/0" in pointers
    assert "/items/example" in pointers
    assert "/allOf/0/example" in pointers
    assert "/$defs/D/examples/0" in pointers
    assert "/definitions/L/example" in pointers
    assert "/patternProperties/^x/example" in pointers
    assert "/additionalProperties/example" in pointers


def test_root_schema_example_is_paired_with_the_empty_pointer() -> None:
    """The document root is a legitimate schema location, addressed by ``""``."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["a"],
        "examples": [{}],
    }
    pairs = _pairs(document)

    assert pairs["/examples/0"] == ""
    report = check_example_conformance(document)
    assert [issue.keyword for issue in report.issues] == ["required"]


# ===========================================================================
# Checking
# ===========================================================================


def test_intra_document_refs_resolve_while_nothing_else_does() -> None:
    """A ``$ref`` into the document works; a ``$ref`` out of it leaves the example unchecked."""
    document = {
        "openapi": "3.1.0",
        "components": {
            "schemas": {
                "Pet": {
                    "type": "object",
                    "properties": {"tag": {"$ref": "#/components/schemas/Tag"}},
                    "example": {"tag": {}},
                },
                "Tag": {"type": "object", "required": ["name"]},
                "Remote": {"$ref": "https://example.com/remote.json", "example": {}},
            }
        },
    }

    report = check_example_conformance(document)

    resolved = [i for i in report.issues if i.example_pointer == "/components/schemas/Pet/example"]
    assert resolved and resolved[0].keyword == "required"
    # The remote-ref schema was not checked, and no verdict was invented for it.
    assert report.sites_unchecked == 1
    assert not any("Remote" in i.example_pointer for i in report.issues)


def test_a_schema_that_will_not_compile_yields_no_finding() -> None:
    """An unusable schema means "not checked", never "the example is wrong"."""
    document = {
        "openapi": "3.1.0",
        "components": {"schemas": {"Broken": {"type": 17, "example": "anything"}}},
    }

    report = check_example_conformance(document)

    assert report.issues == ()
    assert report.sites_checked == 0
    assert report.sites_unchecked == 1


def test_openapi_30_boolean_exclusive_minimum_is_checked_not_rejected() -> None:
    """3.0's boolean ``exclusiveMinimum`` is honored — the reason 3.0 is checked as draft-04."""
    document = {
        "openapi": "3.0.3",
        "components": {
            "schemas": {
                "N": {
                    "type": "object",
                    "properties": {
                        "n": {"type": "number", "minimum": 0, "exclusiveMinimum": True}
                    },
                    "example": {"n": 0},
                }
            }
        },
    }

    report = check_example_conformance(document)

    assert report.sites_checked == 1
    assert report.sites_unchecked == 0
    assert [issue.instance_pointer for issue in report.issues] == ["/n"]


def test_multiple_of_binary_float_artifacts_are_not_reported() -> None:
    """``273.15`` really is a multiple of ``0.01`` — in decimal, which is how it was written."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "number",
        "multipleOf": 0.01,
        "examples": [273.15, 293.15],
    }

    assert check_example_conformance(document).issues == ()


def test_a_genuine_multiple_of_miss_is_still_reported() -> None:
    """The decimal recheck must not become a blanket exemption for ``multipleOf``."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "number",
        "multipleOf": 2,
        "examples": [7],
    }

    issues = check_example_conformance(document).issues

    assert [issue.keyword for issue in issues] == ["multipleOf"]


def test_conforming_examples_produce_nothing() -> None:
    """The rule is silent on a spec whose examples are correct."""
    document = {
        "openapi": "3.1.0",
        "components": {
            "schemas": {
                "Pet": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {"id": {"type": "integer"}},
                    "example": {"id": 1},
                }
            }
        },
    }

    report = check_example_conformance(document)

    assert report.issues == ()
    assert report.sites_checked == 1


def test_unwalked_family_claims_nothing() -> None:
    """A protobuf descriptor has no examples to check, and the report says so rather than "clean"."""
    report = check_example_conformance({"file": [], "syntax": "proto3"}, format_key="protobuf")

    assert report.family is None
    assert report.issues == ()
    assert report.sites_checked == 0


# ===========================================================================
# Bounds and determinism
# ===========================================================================


def test_site_budget_truncates_and_reports_it() -> None:
    """Past the site ceiling the walk stops and says so, rather than running unbounded."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {f"p{n}": {"type": "string", "example": "x"} for n in range(50)},
    }

    sites, _family, truncated = walk_example_sites(document, max_sites=10)

    assert len(sites) == 10
    assert truncated is True


def test_deeply_nested_schemas_terminate() -> None:
    """A schema nested past the walk ceiling stops the recursion instead of exhausting the stack."""
    document: Dict[str, Any] = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
    cursor = document
    for _ in range(MAX_SCHEMA_WALK_DEPTH + 20):
        cursor["items"] = {"type": "object"}
        cursor = cursor["items"]
    cursor["example"] = "deep"

    sites, _family, _truncated = walk_example_sites(document)

    assert sites == []


def test_self_referential_document_terminates() -> None:
    """A schema that is its own ``additionalProperties`` cannot loop the walk."""
    document: Dict[str, Any] = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
    document["additionalProperties"] = document

    sites, _family, _truncated = walk_example_sites(document)

    assert sites == []


def test_walk_is_deterministic() -> None:
    """Two walks of the same document produce the same sites in the same order."""
    first = _pointers(_OPENAPI_31)
    second = _pointers(_OPENAPI_31)

    assert first == second
    # Mapping keys are visited sorted, so insertion order cannot leak into the output.
    reordered = {
        "openapi": "3.1.0",
        "components": {
            "schemas": {
                "B": {"type": "integer", "example": 1},
                "A": {"type": "integer", "example": 2},
            }
        },
    }
    assert _pointers(reordered) == [
        "/components/schemas/A/example",
        "/components/schemas/B/example",
    ]


def test_issues_per_site_are_capped() -> None:
    """One example that misses in many ways contributes a bounded number of violations."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": [f"r{n}" for n in range(20)],
        "examples": [{}],
    }

    issues = check_example_conformance(document, max_issues_per_site=3).issues

    assert len(issues) == 3


def test_malformed_documents_are_walked_without_raising() -> None:
    """A structurally odd document must degrade to "nothing to check", never crash the lint."""
    for document in (
        {"openapi": "3.1.0", "paths": "not-a-mapping"},
        {"openapi": "3.1.0", "components": {"schemas": [1, 2, 3]}},
        {"openapi": "3.1.0", "paths": {"/x": {"get": {"parameters": "nope"}}}},
        {"asyncapi": "3.0.0", "channels": {"c": {"messages": 5}}},
        {"swagger": "2.0", "definitions": None},
    ):
        report = check_example_conformance(document)
        assert report.issues == ()


def test_base_uri_is_not_dereferenceable() -> None:
    """The document is registered under a URN, so nothing can be fetched for it."""
    assert SPEC_BASE_URI.startswith("urn:")
    assert "://" not in SPEC_BASE_URI
