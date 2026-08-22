"""Postman Collection v2.0 import — FMT-3.6 (#5431).

``postman_parser`` was written against Collection **v2.1**. A v2.0 export — the
form Insomnia and several older exporters write — was detected by its schema URL
but not guaranteed to normalize, because three shapes changed between the minors:
``request.url`` is a *string* in v2.0 and an object in v2.1, an auth scheme's
parameters are an *object* in v2.0 and an array in v2.1, and a variable is
identified by ``id`` in v2.0 where v2.1 uses ``key``. Reading only the v2.1
spelling silently dropped every query parameter, every collection variable (and
therefore the server), and the auth scheme.

This suite pins the acceptance criteria of that ticket:

#. **the headline one** — the same collection expressed as v2.0 and as v2.1
   produces the *same canonical model*, apart from the recorded version itself;
#. the collection minor is recorded in provenance;
#. a fileset resolves an environment file's variables, which is the only thing a
   Postman multi-file set has to offer (and what retired its rung waiver);
#. a Collection **v1** export is rejected by version rather than as a broken
   document, and an empty collection reports a semantic failure;
#. credentials are never read: an auth declaration contributes its scheme and its
   parameter *names*, never their values.

Fixtures are selected through :mod:`tests.corpus_loader` by manifest tag rather
than by path, so a corpus rename cannot silently re-point an assertion at a
different document.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest
from corpus_loader import ValidityClass, load_corpus, unique_corpus_entry

from app.canonical_model import ParameterLocation
from app.fileset import IntakeFileset
from app.format_lint_capabilities import normalize_format_key
from app.import_source import DetectionInput, ImportSourceError
from app.postman_import_source import PostmanImportSource
from app.postman_parser import (
    collection_version,
    is_postman_environment,
    parse_environment,
    parse_postman,
)

_V2_0_SCHEMA = "https://schema.getpostman.com/json/collection/v2.0.0/collection.json"
_V2_1_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"


@pytest.fixture()
def adapter() -> PostmanImportSource:
    return PostmanImportSource()


def _entry(*features: str):
    """The one valid v2.0 corpus fixture carrying every given feature tag."""
    return unique_corpus_entry(format="postman-v2", features=features)


def _text(*features: str) -> str:
    return _entry(*features).read_text()


def _negative_text(*features: str) -> str:
    matches = [
        entry
        for entry in load_corpus(format="postman-v2", validity_class=ValidityClass.INVALID)
        if set(features) <= set(entry.features)
    ]
    assert len(matches) == 1, f"{features}: expected one negative fixture, got {len(matches)}"
    return matches[0].read_text()


def _environment_set() -> IntakeFileset:
    root = _entry("multi-file", "environment-variables")
    set_dir = root.absolute_path.parent
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(set_dir.iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root=root.absolute_path.name)


# ---------------------------------------------------------------------------
# The headline criterion: v2.0 imports with the same fidelity as v2.1
# ---------------------------------------------------------------------------

#: One collection, in each minor's spelling. Same requests, same variables, same
#: auth — only the three shapes that changed between v2.0 and v2.1 differ.
_AS_V2_0 = {
    "info": {"name": "Orders", "schema": _V2_0_SCHEMA},
    "auth": {"type": "basic", "basic": {"username": "{{user}}", "password": "{{secret}}"}},
    "variable": [{"id": "baseUrl", "value": "https://api.example.com/v2"}],
    "item": [
        {
            "name": "List orders",
            "request": {
                "method": "GET",
                "header": [{"key": "Accept", "value": "application/json"}],
                "url": "{{baseUrl}}/orders/:orderId?status=new&limit=25",
            },
            "response": [],
        }
    ],
}

_AS_V2_1 = {
    "info": {"name": "Orders", "schema": _V2_1_SCHEMA},
    "auth": {
        "type": "basic",
        "basic": [
            {"key": "username", "value": "{{user}}", "type": "string"},
            {"key": "password", "value": "{{secret}}", "type": "string"},
        ],
    },
    "variable": [{"key": "baseUrl", "value": "https://api.example.com/v2"}],
    "item": [
        {
            "name": "List orders",
            "request": {
                "method": "GET",
                "header": [{"key": "Accept", "value": "application/json"}],
                "url": {
                    "raw": "{{baseUrl}}/orders/:orderId?status=new&limit=25",
                    "host": ["{{baseUrl}}"],
                    "path": ["orders", ":orderId"],
                    "query": [
                        {"key": "status", "value": "new"},
                        {"key": "limit", "value": "25"},
                    ],
                },
            },
            "response": [],
        }
    ],
}


def _model_without_version(adapter: PostmanImportSource, document: Dict[str, Any]) -> Any:
    """Normalize a collection, dropping the two extras that *should* differ by minor."""
    model = adapter.normalize(adapter.parse(json.dumps(document)), include_raw=False)
    payload = model.model_dump()
    payload["extras"].pop("postman_collection_version", None)
    payload["extras"].pop("postman_schema_url", None)
    return payload


def test_the_same_collection_in_either_minor_normalizes_identically(
    adapter: PostmanImportSource,
) -> None:
    assert _model_without_version(adapter, _AS_V2_0) == _model_without_version(
        adapter, _AS_V2_1
    )


def test_a_v2_0_string_url_yields_the_query_and_path_parameters(
    adapter: PostmanImportSource,
) -> None:
    """The divergence that mattered most: reading only the path dropped every query."""
    model = adapter.normalize(adapter.parse(json.dumps(_AS_V2_0)), include_raw=False)
    [operation] = [op for service in model.services for op in service.operations]

    assert operation.http_path == "/orders/{orderId}"
    assert {parameter.name: parameter.location for parameter in operation.parameters} == {
        "orderId": ParameterLocation.PATH,
        "status": ParameterLocation.QUERY,
        "limit": ParameterLocation.QUERY,
    }


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://api.example.com/ping", "/ping"),
        ("{{baseUrl}}/orders", "/orders"),
        ("api.example.com/ping", "/ping"),
        ("{{host}}:{{port}}/api/v1/ping", "/api/v1/ping"),
        ("{{baseUrl}}", "/"),
    ],
)
def test_a_string_url_drops_only_its_authority(
    adapter: PostmanImportSource, url: str, expected: str
) -> None:
    """A string URL's leading token is the host, in every spelling Postman admits."""
    document = json.loads(json.dumps(_AS_V2_0))
    document["item"][0]["request"]["url"] = url
    model = adapter.normalize(adapter.parse(json.dumps(document)), include_raw=False)

    [operation] = [op for service in model.services for op in service.operations]
    assert operation.http_path == expected


def test_a_v2_0_variable_identified_only_by_id_still_resolves_the_server(
    adapter: PostmanImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(json.dumps(_AS_V2_0)), include_raw=False)
    assert [server.url for server in model.servers] == ["https://api.example.com/v2"]


# ---------------------------------------------------------------------------
# Version recording
# ---------------------------------------------------------------------------


def test_the_collection_minor_is_read_from_the_schema_url() -> None:
    assert collection_version({"info": {"schema": _V2_0_SCHEMA}}) == "2.0"
    assert collection_version({"info": {"schema": _V2_1_SCHEMA}}) == "2.1"
    assert collection_version({"info": {"name": "no schema"}}) is None


def test_a_v2_0_collection_detects_under_its_own_format_key(
    adapter: PostmanImportSource,
) -> None:
    result = adapter.detect(DetectionInput(text=_text("string-url", "single-request")))
    assert result.matched
    assert result.format == "postman-2.0"
    assert result.confidence >= 0.95


def test_a_v2_1_collection_keeps_the_unversioned_key(adapter: PostmanImportSource) -> None:
    """No existing detection result moves: only the new minor gets a scoped key."""
    text = load_corpus(format="postman", validity_class=ValidityClass.VALID)[0].read_text()
    assert adapter.detect(DetectionInput(text=text)).format == "postman"


def test_the_version_is_recorded_in_the_canonical_extras(
    adapter: PostmanImportSource,
) -> None:
    model = adapter.normalize(
        adapter.parse(_text("string-url", "collection-variables")), include_raw=False
    )
    assert model.extras["postman_collection_version"] == "2.0"


def test_the_adapter_declares_v2_0_in_its_version_coverage() -> None:
    assert "postman-2.0" in PostmanImportSource.formats
    assert "postman-2.0" in PostmanImportSource.descriptor().formats


def test_lint_capability_folds_the_version_key_onto_the_family() -> None:
    assert normalize_format_key("postman-2.0") == "postman"


# ---------------------------------------------------------------------------
# Auth: the scheme, never the secret
# ---------------------------------------------------------------------------


def test_auth_is_read_in_both_minors_shapes(adapter: PostmanImportSource) -> None:
    from_v2_0 = adapter.parse(json.dumps(_AS_V2_0)).auth
    from_v2_1 = adapter.parse(json.dumps(_AS_V2_1)).auth

    assert from_v2_0 == from_v2_1
    assert from_v2_0.type == "basic"
    assert from_v2_0.parameters == ("password", "username")


def test_an_auth_declaration_never_carries_its_credential_values(
    adapter: PostmanImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(json.dumps(_AS_V2_0)), include_raw=False)
    rendered = json.dumps(model.extras)

    assert model.extras["postman_auth"] == {
        "type": "basic",
        "parameters": ["password", "username"],
    }
    assert "{{secret}}" not in rendered


def test_a_request_level_auth_override_lands_on_its_operation(
    adapter: PostmanImportSource,
) -> None:
    model = adapter.normalize(
        adapter.parse(_text("v2.0-auth-shape", "raw-body")), include_raw=False
    )
    overridden = [
        operation
        for service in model.services
        for operation in service.operations
        if "postman_auth" in operation.extras
    ]
    assert [operation.extras["postman_auth"]["type"] for operation in overridden] == ["basic"]


def test_a_noauth_declaration_contributes_nothing(adapter: PostmanImportSource) -> None:
    document = json.loads(json.dumps(_AS_V2_0))
    document["auth"] = {"type": "noauth"}
    assert adapter.parse(json.dumps(document)).auth is None


# ---------------------------------------------------------------------------
# Filesets: an environment file is what makes a Postman set more than its root
# ---------------------------------------------------------------------------


def test_an_environment_export_is_recognized_and_is_not_a_collection() -> None:
    environment = json.loads(_entry("multi-file", "environment-file").read_text())
    assert is_postman_environment(environment)
    assert not is_postman_environment(_AS_V2_0)


def test_a_set_resolves_its_environments_variables(adapter: PostmanImportSource) -> None:
    document = adapter.parse_fileset(_environment_set(), source_label="06-environment-set")
    variables = {variable.key: variable.value for variable in document.variables}

    assert variables["baseUrl"] == "https://staging.example.com/inventory"
    assert variables["warehouse"] == "AMS"


def test_the_environments_base_url_becomes_the_server(adapter: PostmanImportSource) -> None:
    """The set root parsed alone has no server — which is what the retired waiver denied."""
    fileset = _environment_set()
    with_environment = adapter.normalize(adapter.parse_fileset(fileset), include_raw=False)
    root_alone = adapter.normalize(
        adapter.parse(fileset.members[fileset.root]), include_raw=False
    )

    assert [server.url for server in with_environment.servers] == [
        "https://staging.example.com/inventory"
    ]
    assert root_alone.servers == []


def test_a_collection_variable_wins_over_the_environments_value() -> None:
    collection = json.loads(json.dumps(_AS_V2_0))
    environment = parse_environment(
        json.dumps(
            {
                "name": "staging",
                "_postman_variable_scope": "environment",
                "values": [
                    {"key": "baseUrl", "value": "https://staging.example.com", "enabled": True},
                    {"key": "extra", "value": "kept", "enabled": True},
                ],
            }
        )
    )
    document = parse_postman(json.dumps(collection), environment_variables=environment)
    variables = {variable.key: variable.value for variable in document.variables}

    assert variables["baseUrl"] == "https://api.example.com/v2"
    assert variables["extra"] == "kept"


def test_a_disabled_environment_value_is_not_merged() -> None:
    variables = parse_environment(
        json.dumps(
            {
                "name": "staging",
                "_postman_variable_scope": "environment",
                "values": [{"key": "off", "value": "no", "enabled": False}],
            }
        )
    )
    assert variables == ()


def test_a_member_that_is_not_an_environment_contributes_nothing() -> None:
    assert parse_environment("# just a readme") == ()


# ---------------------------------------------------------------------------
# Negatives the pipeline has to name
# ---------------------------------------------------------------------------


def test_a_collection_v1_export_is_rejected_by_version(
    adapter: PostmanImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative_text("version-out-of-range"))
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"
    assert "v1" in str(excinfo.value)


def test_a_collection_with_no_requests_is_semantically_invalid(
    adapter: PostmanImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative_text("semantic", "no-items"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_an_openapi_document_is_not_claimed_as_a_collection(
    adapter: PostmanImportSource,
) -> None:
    text = _negative_text("wrong-format")
    assert not adapter.detect(DetectionInput(text=text)).matched
    with pytest.raises(ImportSourceError):
        adapter.parse(text)


# ---------------------------------------------------------------------------
# Corpus contract
# ---------------------------------------------------------------------------


def test_every_v2_0_corpus_entry_is_owned_by_the_postman_adapter() -> None:
    entries = load_corpus(format="postman-v2")
    assert entries, "the postman-v2 corpus directory has no manifest entries"
    assert {entry.adapter_key for entry in entries} == {"postman"}
    assert not any("pending-adapter" in entry.features for entry in entries)


def test_the_v2_0_corpus_covers_the_divergences_the_ticket_names() -> None:
    features: List[str] = [
        feature
        for entry in load_corpus(format="postman-v2", validity_class=ValidityClass.VALID)
        for feature in entry.features
    ]
    assert {"string-url", "v2.0-auth-shape", "environment-variables"} <= set(features)
