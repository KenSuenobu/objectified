"""Unit tests for the pure re-resolution helper (#3459).

``app.type_resolver.reresolve_edges`` recomputes each stored ``$ref`` edge's status
against the current registry (via an injected target lookup) and attaches the resolved
dependency target's identity. These tests exercise the mechanics with no DB or HTTP.
"""

from app.type_resolver import (
    STATUS_RESOLVED,
    STATUS_UNRESOLVED,
    reresolve_edges,
)

BASE = "https://api.apiome.dev/types/"
MONEY = BASE + "tenant/acme/types/money"
DECIMAL = BASE + "tenant/acme/types/decimal"
STRING = BASE + "std/v0/primitives/string"


def _edge(relative_ref, resolved_target, status):
    return {"relative_ref": relative_ref, "resolved_target": resolved_target, "status": status}


def _lookup(existing):
    """Build a target lookup that returns a row for any $id in ``existing``."""
    return lambda schema_id: existing.get(schema_id)


def test_empty_and_none_edges_are_noops():
    for edges in (None, []):
        persisted, dependencies, changed = reresolve_edges(edges, _lookup({}))
        assert persisted == []
        assert dependencies == []
        assert changed is False


def test_unresolved_edge_flips_to_resolved_when_target_appears():
    edges = [_edge("./money", MONEY, STATUS_UNRESOLVED)]
    persisted, dependencies, changed = reresolve_edges(
        edges, _lookup({MONEY: {"id": "m1", "name": "money"}})
    )
    assert changed is True
    assert persisted == [_edge("./money", MONEY, STATUS_RESOLVED)]
    # The resolved edge carries its dependency target's identity.
    assert dependencies == [
        {
            "relative_ref": "./money",
            "resolved_target": MONEY,
            "status": STATUS_RESOLVED,
            "target_id": "m1",
            "target_name": "money",
        }
    ]


def test_resolved_edge_flips_to_unresolved_when_target_disappears():
    edges = [_edge("./money", MONEY, STATUS_RESOLVED)]
    persisted, dependencies, changed = reresolve_edges(edges, _lookup({}))
    assert changed is True
    assert persisted == [_edge("./money", MONEY, STATUS_UNRESOLVED)]
    # An unresolved edge has no dependency target identity.
    assert dependencies[0]["target_id"] is None
    assert dependencies[0]["target_name"] is None


def test_unchanged_statuses_report_no_change():
    edges = [
        _edge("../primitives/string", STRING, STATUS_RESOLVED),
        _edge("./decimal", DECIMAL, STATUS_UNRESOLVED),
    ]
    persisted, dependencies, changed = reresolve_edges(
        edges, _lookup({STRING: {"id": "s1", "name": "string"}})
    )
    assert changed is False
    assert [e["status"] for e in persisted] == [STATUS_RESOLVED, STATUS_UNRESOLVED]


def test_edge_order_is_preserved():
    edges = [
        _edge("a", BASE + "a", STATUS_UNRESOLVED),
        _edge("b", BASE + "b", STATUS_UNRESOLVED),
        _edge("c", BASE + "c", STATUS_UNRESOLVED),
    ]
    persisted, _deps, _changed = reresolve_edges(edges, _lookup({}))
    assert [e["relative_ref"] for e in persisted] == ["a", "b", "c"]


def test_edge_without_target_is_unresolved_and_not_looked_up():
    """A malformed/legacy edge with no resolved_target never hits the lookup."""
    calls = []

    def lookup(schema_id):
        calls.append(schema_id)
        return None

    edges = [{"relative_ref": "./x", "resolved_target": None, "status": STATUS_RESOLVED}]
    persisted, dependencies, changed = reresolve_edges(edges, lookup)
    assert changed is True  # was 'resolved', now 'unresolved'
    assert persisted[0]["status"] == STATUS_UNRESOLVED
    assert dependencies[0]["target_id"] is None
    assert calls == []  # falsy target short-circuits the lookup
