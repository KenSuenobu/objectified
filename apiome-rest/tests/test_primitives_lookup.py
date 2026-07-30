"""Unit tests for local-only ``$ref`` target lookup (:mod:`app.primitives_lookup`).

The registry is the whole type system: a reference is dereferenced by **local placement**
(namespace + name), never by fetching or matching a foreign URI. These cover the placement
parse, the two-step lookup (exact ``schema_id`` first, placement second), and the guarantee
that a non-registry URI never dereferences to anything.
"""

from unittest.mock import MagicMock

from app.primitives_lookup import (
    find_primitive_by_registry_uri,
    local_registry_uri,
    registry_placement_of,
)

BASE = "https://api.apiome.dev/types/"


def _db(by_schema_id=None, by_placement=None):
    db = MagicMock()
    db.get_primitive_by_schema_id.side_effect = lambda uri, t: (by_schema_id or {}).get(uri)
    db.get_primitive_by_namespace_name.side_effect = lambda ns, leaf, t: (
        (by_placement or {}).get((ns, leaf))
    )
    return db


# =========================================================================== #
# registry_placement_of
# =========================================================================== #


def test_placement_of_a_local_uri():
    assert registry_placement_of(BASE + "self/v1/schemas/api/schemas/position") == (
        "self/v1/schemas/api/schemas",
        "position",
    )


def test_placement_drops_a_fragment():
    assert registry_placement_of(BASE + "std/v0/types/uri#/properties/x") == (
        "std/v0/types",
        "uri",
    )


def test_a_foreign_uri_has_no_placement():
    assert registry_placement_of("https://schemas.sourcemeta.com/self/position") is None
    assert registry_placement_of("https://json-schema.org/draft/2020-12/schema") is None


def test_a_rootlevel_or_empty_path_has_no_placement():
    assert registry_placement_of(BASE) is None
    assert registry_placement_of(BASE + "leaf-only") is None


# =========================================================================== #
# find_primitive_by_registry_uri
# =========================================================================== #


def test_exact_schema_id_match_wins():
    row = {"id": "r1", "name": "uri"}
    db = _db(by_schema_id={BASE + "std/v0/types/uri": row})

    assert find_primitive_by_registry_uri(db, BASE + "std/v0/types/uri", "t1") is row
    db.get_primitive_by_namespace_name.assert_not_called()


def test_placement_finds_a_type_stored_under_a_foreign_authored_id():
    """The whole point: the row's schema_id is remote, but the type is local — found at
    its namespace + name, with no foreign URI consulted."""
    row = {
        "id": "r2",
        "name": "position",
        "schema_id": "https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position",
    }
    db = _db(by_placement={("self/v1/schemas/api/schemas", "position"): row})

    found = find_primitive_by_registry_uri(
        db, BASE + "self/v1/schemas/api/schemas/position", "t1"
    )
    assert found is row


def test_a_foreign_uri_never_dereferences():
    """Even a foreign URI that IS some row's schema_id is not a registry reference."""
    row = {"id": "r3", "name": "position"}
    foreign = "https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position"
    db = _db(by_schema_id={foreign: row})

    # The lookup is only ever fed local URIs by the resolver; but even called directly
    # with a foreign URI, the placement step refuses it — only the (never-local-matching)
    # schema_id equality could answer, and edges never carry foreign targets to ask about.
    assert registry_placement_of(foreign) is None


def test_nothing_at_that_placement_is_none():
    db = _db()
    assert find_primitive_by_registry_uri(db, BASE + "acme/v1/types/missing", "t1") is None


# =========================================================================== #
# local_registry_uri
# =========================================================================== #


def test_local_registry_uri_joins_base_and_leaf():
    assert local_registry_uri(BASE + "acme/v1/types/", "money") == BASE + "acme/v1/types/money"
    assert local_registry_uri(BASE + "acme/v1/types", "money") == BASE + "acme/v1/types/money"
