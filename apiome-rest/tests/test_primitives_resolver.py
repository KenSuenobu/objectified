"""Unit tests for relative ``$ref`` resolution into registry edges (#3456).

Covers the canonical resolution cases from the roadmap (``../primitives/string``,
``./decimal``, cross-scope ``../../std/...``), fragment/external ref handling, the
resolved/unresolved status from the injected scope lookup, and edge de-duplication.
The shared URL resolver (:func:`app.primitives_scope.resolve_registry_uri`) is exercised
directly too.
"""

from app.primitives_resolver import (
    STATUS_RESOLVED,
    STATUS_UNRESOLVED,
    build_ref_edges,
)
from app.primitives_scope import resolve_registry_uri

BASE = "https://api.apiome.dev/types/"
STD_TYPES_BASE = BASE + "std/v0/types/"
STD_PRIMS = BASE + "std/v0/primitives/"
ACME_BASE = BASE + "tenant/acme/v1/types/"


def _always(exists):
    """A target_exists predicate that returns a fixed verdict for every URI."""
    return lambda _uri: exists


def _known(*uris):
    """A target_exists predicate that resolves only the given absolute URIs."""
    known = set(uris)
    return lambda uri: uri in known


# ===========================================================================
# resolve_registry_uri — URL mechanics
# ===========================================================================


def test_parent_ref_resolves_against_base():
    # date (base std/v0/types/) -> ../primitives/string
    assert (
        resolve_registry_uri("../primitives/string", STD_TYPES_BASE)
        == STD_PRIMS + "string"
    )


def test_sibling_ref_resolves_against_base():
    # money (base std/v0/types/) -> ./decimal and ./currency-code
    assert resolve_registry_uri("./decimal", STD_TYPES_BASE) == STD_TYPES_BASE + "decimal"
    assert (
        resolve_registry_uri("./currency-code", STD_TYPES_BASE)
        == STD_TYPES_BASE + "currency-code"
    )


def test_cross_scope_ref_resolves_to_std():
    # A tenant type at base .../tenant/acme/ references core via ../../std/v0/types/string.
    base = BASE + "tenant/acme/"
    assert (
        resolve_registry_uri("../../std/v0/types/string", base)
        == STD_TYPES_BASE + "string"
    )


def test_fragment_ref_is_not_a_registry_target():
    assert resolve_registry_uri("#/$defs/Cents", STD_TYPES_BASE) is None


def test_external_ref_is_not_a_registry_target():
    assert resolve_registry_uri("https://json-schema.org/draft/2020-12/schema", STD_TYPES_BASE) is None


# ===========================================================================
# build_ref_edges — edge construction + status
# ===========================================================================


def test_resolved_edge_when_target_exists():
    schema = {"type": "object", "properties": {"v": {"$ref": "../primitives/string"}}}
    edges = build_ref_edges(
        schema, base_uri=STD_TYPES_BASE, target_exists=_known(STD_PRIMS + "string")
    )
    assert edges == [
        {
            "relative_ref": "../primitives/string",
            "resolved_target": STD_PRIMS + "string",
            "status": STATUS_RESOLVED,
        }
    ]


def test_unresolved_edge_when_target_missing():
    schema = {"$ref": "./decimal"}
    edges = build_ref_edges(schema, base_uri=STD_TYPES_BASE, target_exists=_always(False))
    assert edges[0]["status"] == STATUS_UNRESOLVED
    assert edges[0]["resolved_target"] == STD_TYPES_BASE + "decimal"


def test_mixed_resolved_and_unresolved():
    schema = {
        "allOf": [
            {"$ref": "./decimal"},
            {"$ref": "./currency-code"},
        ]
    }
    edges = build_ref_edges(
        schema,
        base_uri=STD_TYPES_BASE,
        target_exists=_known(STD_TYPES_BASE + "decimal"),
    )
    by_ref = {e["relative_ref"]: e["status"] for e in edges}
    assert by_ref == {"./decimal": STATUS_RESOLVED, "./currency-code": STATUS_UNRESOLVED}


def test_fragment_and_external_refs_produce_no_edges():
    schema = {
        "allOf": [
            {"$ref": "#/$defs/Cents"},
            {"$ref": "https://json-schema.org/x"},
        ],
        "$defs": {"Cents": {"type": "integer"}},
    }
    assert build_ref_edges(schema, base_uri=STD_TYPES_BASE, target_exists=_always(True)) == []


def test_duplicate_refs_recorded_once_in_document_order():
    schema = {
        "anyOf": [
            {"$ref": "./decimal"},
            {"items": {"$ref": "../primitives/string"}},
            {"$ref": "./decimal"},
        ]
    }
    edges = build_ref_edges(schema, base_uri=STD_TYPES_BASE, target_exists=_always(True))
    assert [e["relative_ref"] for e in edges] == ["./decimal", "../primitives/string"]


def test_no_refs_yields_empty_edges():
    schema = {"type": "string", "maxLength": 10}
    assert build_ref_edges(schema, base_uri=STD_TYPES_BASE, target_exists=_always(True)) == []


def test_cross_scope_edge_resolves_to_core_target():
    base = BASE + "tenant/acme/"
    schema = {"$ref": "../../std/v0/types/string"}
    edges = build_ref_edges(
        schema, base_uri=base, target_exists=_known(STD_TYPES_BASE + "string")
    )
    assert edges[0]["resolved_target"] == STD_TYPES_BASE + "string"
    assert edges[0]["status"] == STATUS_RESOLVED


def test_target_exists_called_with_absolute_uri():
    seen = []

    def _spy(uri):
        seen.append(uri)
        return True

    build_ref_edges(
        {"$ref": "../primitives/string"}, base_uri=STD_TYPES_BASE, target_exists=_spy
    )
    assert seen == [STD_PRIMS + "string"]


# =========================================================================== #
# Local-only guarantee
# =========================================================================== #


def test_a_foreign_absolute_ref_is_never_an_edge_even_if_claimed_to_exist():
    """Resolution never leaves the registry: a remote URI is not a registry reference,
    so it produces no edge regardless of what the existence predicate would say."""
    schema = {
        "$id": "https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/evaluate/response",
        "$ref": "https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/output-error",
    }

    assert build_ref_edges(schema, base_uri=ACME_BASE, target_exists=_always(True)) == []


def test_every_emitted_target_is_a_local_registry_uri():
    schema = {
        "properties": {
            "a": {"$ref": "../primitives/string"},
            "b": {"$ref": "./missing"},
            "c": {"$ref": "https://json-schema.org/draft/2020-12/schema"},
        }
    }

    edges = build_ref_edges(schema, base_uri=STD_TYPES_BASE, target_exists=_always(False))

    assert len(edges) == 2  # the external ref produced nothing
    assert all(e["resolved_target"].startswith(BASE) for e in edges)
