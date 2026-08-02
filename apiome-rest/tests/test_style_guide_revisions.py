"""Immutable style-guide revisions & governance audit — GOV-1.6 (#4432).

Covers the service module that turns in-place guide edits into an append-only history:

* **Snapshots** — a live guide row plus its rule rows project onto the frozen snapshot, with
  policy gates normalized so a ``NULL`` column and an explicitly-saved default are the same
  snapshot (and therefore not a spurious revision).
* **Fingerprints** — a revision's ``content_fingerprint`` is byte-identical to the
  fingerprint the linter stamps on the compiled guide (the equality lint-result pinning
  depends on), while ``snapshot_fingerprint`` additionally moves on identity/policy changes.
* **Recording** — an edit appends a revision; an edit that changed nothing appends none; an
  unknown change kind degrades to ``edited`` rather than violating the DB constraint; every
  failure path is swallowed so history capture can never fail the governed action.
* **Self-healing capture** — a guide with no history gets ``created``, a guide whose live
  content drifted from its newest revision gets ``edited``, a guide in sync is untouched.
* **Pinning** — a compiled guide resolves to the revision with matching rule content, the
  in-code fallback guide pins to nothing, an unrecorded guide is captured then pinned, and a
  DB fault degrades to ``None``.
* **Audit** — events reach the hash-chained access ledger with the ``style_guide.`` prefix,
  and a ledger failure never propagates.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.database import Database
from app.style_guide_engine import compile_style_guide, rules_content_fingerprint
from app.style_guide_revisions import (
    AUDIT_ASSIGNED,
    AUDIT_CREATED,
    AUDIT_PREFIX,
    CHANGE_CREATED,
    CHANGE_EDITED,
    CHANGE_KINDS,
    CHANGE_RULES_CHANGED,
    audit_style_guide_event,
    ensure_guide_revision,
    guide_snapshot,
    pin_guide_revision_id,
    record_guide_revision,
    resolve_guide_revision_id,
    revision_rule_counts,
    snapshot_fingerprint,
)

TENANT = "00000000-0000-4000-8000-0000000000a1"
GUIDE = "00000000-0000-4000-8000-0000000000c1"
PROJECT = "00000000-0000-4000-8000-0000000000b1"
REVISION = "00000000-0000-4000-8000-0000000000d1"
USER = "00000000-0000-4000-8000-0000000000e1"


def _guide_row(**over):
    row = {
        "id": GUIDE,
        "name": "Payments Guide",
        "description": "Payments API standards",
        "source": "custom",
        "is_default": False,
        "external_lint_profile": "baseline",
        "axis_gates": None,
        "required_coverage": None,
        "ci_outcomes": None,
    }
    row.update(over)
    return row


def _rule_rows():
    return [
        {
            "rule_id": "naming.schema-pascal-case",
            "enabled": True,
            "severity": "error",
            "custom_def": None,
        },
        {
            "rule_id": "custom.payments-currency",
            "enabled": True,
            "severity": "warning",
            "custom_def": {"given": "$..currency", "then": {"function": "truthy"}},
        },
    ]


# ---------------------------------------------------------------------------
# Snapshots and fingerprints
# ---------------------------------------------------------------------------


def test_snapshot_captures_identity_rules_and_normalized_policy():
    snapshot = guide_snapshot(_guide_row(), _rule_rows())

    assert snapshot["name"] == "Payments Guide"
    assert snapshot["description"] == "Payments API standards"
    assert snapshot["external_lint_profile"] == "baseline"
    # Rules are sorted by rule id so the snapshot (and its fingerprint) is order-independent.
    assert [r["rule_id"] for r in snapshot["rules"]] == [
        "custom.payments-currency",
        "naming.schema-pascal-case",
    ]
    # NULL gate columns normalize to their documented defaults, not to null.
    assert snapshot["policy"]["requiredCoverage"] == ["quality"]
    assert snapshot["policy"]["axisGates"] == {}
    assert snapshot["policy"]["ciOutcomes"]["failOnUnwaivedErrors"] is True


def test_snapshot_is_insensitive_to_rule_row_order():
    rows = _rule_rows()
    assert guide_snapshot(_guide_row(), rows) == guide_snapshot(
        _guide_row(), list(reversed(rows))
    )


def test_content_fingerprint_matches_the_compiled_guide_fingerprint():
    """The equality lint-result pinning is built on: same rules => same fingerprint."""
    rows = _rule_rows()
    compiled = compile_style_guide(GUIDE, "Payments Guide", "custom", tuple(
        {**r} for r in rows
    ))
    snapshot = guide_snapshot(_guide_row(), rows)

    assert rules_content_fingerprint(snapshot["rules"]) == compiled.fingerprint


def test_snapshot_fingerprint_moves_on_a_rename_but_content_fingerprint_does_not():
    rows = _rule_rows()
    before = guide_snapshot(_guide_row(), rows)
    after = guide_snapshot(_guide_row(name="Renamed Guide"), rows)

    assert rules_content_fingerprint(before["rules"]) == rules_content_fingerprint(
        after["rules"]
    )
    assert snapshot_fingerprint(before) != snapshot_fingerprint(after)


def test_snapshot_fingerprint_moves_when_a_severity_changes():
    changed = [dict(r) for r in _rule_rows()]
    changed[0]["severity"] = "info"
    assert snapshot_fingerprint(guide_snapshot(_guide_row(), _rule_rows())) != (
        snapshot_fingerprint(guide_snapshot(_guide_row(), changed))
    )


def test_revision_rule_counts_rolls_up_enabled_and_custom_rules():
    rows = _rule_rows() + [
        {"rule_id": "naming.property-name", "enabled": False, "severity": "warning"}
    ]
    assert revision_rule_counts(rows) == {
        "rule_count": 3,
        "enabled_rule_count": 2,
        "custom_rule_count": 1,
    }


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


def _revision_row(snapshot, **over):
    row = {
        "id": REVISION,
        "guide_id": GUIDE,
        "tenant_id": TENANT,
        "revision_number": 1,
        "change_kind": CHANGE_CREATED,
        "name": snapshot["name"],
        "description": snapshot["description"],
        "external_lint_profile": snapshot["external_lint_profile"],
        "rules": snapshot["rules"],
        "policy": snapshot["policy"],
        "content_fingerprint": rules_content_fingerprint(snapshot["rules"]),
        "snapshot_fingerprint": snapshot_fingerprint(snapshot),
        "actor_user_id": None,
        "actor_label": "system",
        "created_at": None,
    }
    row.update(over)
    return row


def _patched_db(*, guide=None, rules=None, latest=None, by_content=None):
    """Patch the DB accessors the revision service uses, returning the insert mock."""
    return (
        patch("app.database.db.get_style_guide_by_id", return_value=guide),
        patch("app.database.db.get_style_guide_rules", return_value=rules or []),
        patch("app.database.db.get_latest_style_guide_revision", return_value=latest),
        patch(
            "app.database.db.get_style_guide_revision_by_content",
            return_value=by_content,
        ),
    )


def test_record_appends_a_revision_with_the_live_state_and_actor():
    guide, rules = _guide_row(), _rule_rows()
    snapshot = guide_snapshot(guide, rules)
    patches = _patched_db(guide=guide, rules=rules, latest=None)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision",
        return_value=_revision_row(snapshot, change_kind=CHANGE_RULES_CHANGED),
    ) as insert:
        row = record_guide_revision(
            GUIDE,
            TENANT,
            change_kind=CHANGE_RULES_CHANGED,
            actor_user_id=USER,
            actor_label="admin@example.com",
        )

    assert row is not None
    kwargs = insert.call_args.kwargs
    assert kwargs["change_kind"] == CHANGE_RULES_CHANGED
    assert kwargs["actor_user_id"] == USER
    assert kwargs["actor_label"] == "admin@example.com"
    assert kwargs["content_fingerprint"] == rules_content_fingerprint(snapshot["rules"])
    assert kwargs["snapshot_fingerprint"] == snapshot_fingerprint(snapshot)
    assert kwargs["rules"] == snapshot["rules"]


def test_record_appends_nothing_when_the_snapshot_is_unchanged():
    """Re-saving an unchanged editor tab must not inflate the history."""
    guide, rules = _guide_row(), _rule_rows()
    latest = _revision_row(guide_snapshot(guide, rules), revision_number=4)
    patches = _patched_db(guide=guide, rules=rules, latest=latest)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision"
    ) as insert:
        row = record_guide_revision(GUIDE, TENANT, change_kind=CHANGE_RULES_CHANGED)

    insert.assert_not_called()
    assert row["revision_number"] == 4


def test_record_falls_back_to_edited_for_an_unknown_change_kind():
    guide, rules = _guide_row(), _rule_rows()
    patches = _patched_db(guide=guide, rules=rules, latest=None)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision",
        return_value=_revision_row(guide_snapshot(guide, rules)),
    ) as insert:
        record_guide_revision(GUIDE, TENANT, change_kind="not-a-kind")

    assert insert.call_args.kwargs["change_kind"] == CHANGE_EDITED
    assert CHANGE_EDITED in CHANGE_KINDS


def test_record_returns_none_for_a_missing_guide():
    patches = _patched_db(guide=None)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision"
    ) as insert:
        assert record_guide_revision(GUIDE, TENANT, change_kind=CHANGE_EDITED) is None
    insert.assert_not_called()


def test_record_swallows_db_faults():
    """History capture must never fail the guide edit it is recording."""
    with patch(
        "app.database.db.get_style_guide_by_id", side_effect=RuntimeError("db down")
    ):
        assert record_guide_revision(GUIDE, TENANT, change_kind=CHANGE_EDITED) is None


# ---------------------------------------------------------------------------
# Self-healing capture
# ---------------------------------------------------------------------------


def test_ensure_captures_a_guide_with_no_history_as_created():
    guide, rules = _guide_row(), _rule_rows()
    patches = _patched_db(guide=guide, rules=rules, latest=None)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision",
        return_value=_revision_row(guide_snapshot(guide, rules)),
    ) as insert:
        ensure_guide_revision(GUIDE, TENANT)

    kwargs = insert.call_args.kwargs
    assert kwargs["change_kind"] == CHANGE_CREATED
    assert kwargs["actor_user_id"] is None
    assert kwargs["actor_label"] == "system"


def test_ensure_captures_unrecorded_drift_as_edited():
    guide, rules = _guide_row(), _rule_rows()
    stale = _revision_row(guide_snapshot(_guide_row(name="Old Name"), rules))
    patches = _patched_db(guide=guide, rules=rules, latest=stale)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision",
        return_value=_revision_row(guide_snapshot(guide, rules), revision_number=2),
    ) as insert:
        ensure_guide_revision(GUIDE, TENANT)

    assert insert.call_args.kwargs["change_kind"] == CHANGE_EDITED


def test_ensure_is_a_noop_for_a_guide_already_in_sync():
    guide, rules = _guide_row(), _rule_rows()
    latest = _revision_row(guide_snapshot(guide, rules), revision_number=7)
    patches = _patched_db(guide=guide, rules=rules, latest=latest)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision"
    ) as insert:
        row = ensure_guide_revision(GUIDE, TENANT)

    insert.assert_not_called()
    assert row["revision_number"] == 7


def test_ensure_swallows_db_faults():
    with patch(
        "app.database.db.get_style_guide_by_id", side_effect=RuntimeError("db down")
    ):
        assert ensure_guide_revision(GUIDE, TENANT) is None


# ---------------------------------------------------------------------------
# Lint-result pinning
# ---------------------------------------------------------------------------


def test_pin_resolves_the_revision_whose_rules_match_the_compiled_guide():
    rules = _rule_rows()
    compiled = compile_style_guide(GUIDE, "Payments Guide", "custom", tuple(rules))
    snapshot = guide_snapshot(_guide_row(), rules)
    with patch(
        "app.database.db.get_style_guide_revision_by_content",
        return_value=_revision_row(snapshot, revision_number=3),
    ) as lookup:
        assert pin_guide_revision_id(compiled, TENANT) == REVISION

    assert lookup.call_args.args == (GUIDE, TENANT, compiled.fingerprint)


def test_pin_returns_none_for_the_in_code_fallback_guide():
    """The fallback guide is not stored, so there is no revision to pin to."""
    from app.style_guide_engine import builtin_fallback_guide

    with patch("app.database.db.get_style_guide_revision_by_content") as lookup:
        assert pin_guide_revision_id(builtin_fallback_guide(), TENANT) is None
    lookup.assert_not_called()


def test_pin_captures_an_unrecorded_guide_then_pins_to_the_capture():
    guide, rules = _guide_row(), _rule_rows()
    compiled = compile_style_guide(GUIDE, "Payments Guide", "custom", tuple(rules))
    snapshot = guide_snapshot(guide, rules)
    captured = _revision_row(snapshot)
    patches = _patched_db(guide=guide, rules=rules, latest=None, by_content=None)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision", return_value=captured
    ):
        assert pin_guide_revision_id(compiled, TENANT) == REVISION


def test_pin_returns_none_when_the_capture_does_not_match_the_compiled_rules():
    """A guide edited between compile and capture must not be mis-pinned."""
    guide, rules = _guide_row(), _rule_rows()
    compiled = compile_style_guide(GUIDE, "Payments Guide", "custom", tuple(rules))
    other = [dict(rules[0], severity="info")]
    patches = _patched_db(guide=guide, rules=other, latest=None, by_content=None)
    with patches[0], patches[1], patches[2], patches[3], patch(
        "app.database.db.insert_style_guide_revision",
        return_value=_revision_row(guide_snapshot(guide, other)),
    ):
        assert pin_guide_revision_id(compiled, TENANT) is None


def test_pin_degrades_to_none_on_a_db_fault():
    compiled = compile_style_guide(GUIDE, "Payments Guide", "custom", tuple(_rule_rows()))
    with patch(
        "app.database.db.get_style_guide_revision_by_content",
        side_effect=RuntimeError("db down"),
    ):
        assert pin_guide_revision_id(compiled, TENANT) is None


def test_resolve_pins_through_the_assigned_guide_chain():
    rules = _rule_rows()
    compiled = compile_style_guide(GUIDE, "Payments Guide", "custom", tuple(rules))
    snapshot = guide_snapshot(_guide_row(), rules)
    with patch(
        "app.style_guide_engine.resolve_style_guide", return_value=compiled
    ) as resolve, patch(
        "app.database.db.get_style_guide_revision_by_content",
        return_value=_revision_row(snapshot),
    ):
        assert resolve_guide_revision_id(TENANT, PROJECT) == REVISION

    resolve.assert_called_once_with(TENANT, PROJECT)


def test_resolve_degrades_to_none_when_resolution_raises():
    with patch(
        "app.style_guide_engine.resolve_style_guide", side_effect=RuntimeError("boom")
    ):
        assert resolve_guide_revision_id(TENANT) is None


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


def test_audit_writes_a_prefixed_event_into_the_access_ledger():
    with patch("app.database.db.write_access_audit") as write:
        audit_style_guide_event(
            tenant_id=TENANT,
            action=AUDIT_CREATED,
            actor_user_id=USER,
            actor_label="admin@example.com",
            target=GUIDE,
            detail={"name": "Payments Guide"},
        )

    kwargs = write.call_args.kwargs
    assert kwargs["action"] == AUDIT_CREATED
    assert kwargs["action"].startswith(AUDIT_PREFIX)
    assert AUDIT_ASSIGNED.startswith(AUDIT_PREFIX)
    assert kwargs["tenant_id"] == TENANT
    assert kwargs["actor_id"] == USER
    assert kwargs["target"] == GUIDE
    assert kwargs["source"] == "api"
    assert kwargs["detail"] == {"name": "Payments Guide"}


def test_audit_swallows_ledger_failures():
    """An audit failure must never turn a successful guide change into an error."""
    with patch(
        "app.database.db.write_access_audit", side_effect=RuntimeError("ledger down")
    ):
        audit_style_guide_event(tenant_id=TENANT, action=AUDIT_CREATED, target=GUIDE)


# ---------------------------------------------------------------------------
# DB accessors (query shape + tenant/UUID guards)
# ---------------------------------------------------------------------------


def _database_with_mock_query():
    """A Database whose execute_query is mocked (no pool, no connection)."""
    db = Database.__new__(Database)  # skip __init__ (no pool); execute_query is mocked
    db.execute_query = MagicMock(return_value=[])
    return db


def test_insert_assigns_the_next_revision_number_in_one_statement():
    db = _database_with_mock_query()
    db.execute_query.return_value = [{"id": REVISION, "revision_number": 3}]

    row = db.insert_style_guide_revision(
        guide_id=GUIDE,
        tenant_id=TENANT,
        change_kind=CHANGE_RULES_CHANGED,
        name="Payments Guide",
        description=None,
        external_lint_profile="baseline",
        rules=[],
        policy={},
        content_fingerprint="c" * 64,
        snapshot_fingerprint="s" * 64,
        actor_user_id=USER,
        actor_label="ada@example.com",
    )

    assert row["revision_number"] == 3
    query = db.execute_query.call_args.args[0]
    # Numbering happens inside the INSERT, so two concurrent edits cannot mint the same
    # number (the UNIQUE (guide_id, revision_number) constraint is the backstop).
    assert "MAX(rev.revision_number)" in query
    assert "INSERT INTO apiome.style_guide_revisions" in query


def test_insert_drops_a_non_uuid_actor_rather_than_failing_the_write():
    """History must survive an actor id that is not a UUID (API-key / system callers)."""
    db = _database_with_mock_query()
    db.execute_query.return_value = [{"id": REVISION}]

    db.insert_style_guide_revision(
        guide_id=GUIDE,
        tenant_id=TENANT,
        change_kind=CHANGE_CREATED,
        name="G",
        description=None,
        external_lint_profile=None,
        rules=[],
        policy={},
        content_fingerprint="c",
        snapshot_fingerprint="s",
        actor_user_id="not-a-uuid",
        actor_label="svc",
    )

    params = db.execute_query.call_args.args[1]
    assert "not-a-uuid" not in params
    assert "svc" in params


def test_insert_guards_non_uuid_ids():
    db = _database_with_mock_query()
    args = dict(
        change_kind=CHANGE_CREATED,
        name="G",
        description=None,
        external_lint_profile=None,
        rules=[],
        policy={},
        content_fingerprint="c",
        snapshot_fingerprint="s",
    )
    assert db.insert_style_guide_revision(guide_id="nope", tenant_id=TENANT, **args) is None
    assert db.insert_style_guide_revision(guide_id=GUIDE, tenant_id="nope", **args) is None
    db.execute_query.assert_not_called()


def test_list_is_tenant_scoped_newest_first_and_clamps_the_limit():
    db = _database_with_mock_query()

    db.list_style_guide_revisions(GUIDE, TENANT, limit=10_000)

    query, params = db.execute_query.call_args.args
    assert "ORDER BY revision_number DESC" in query
    assert "WHERE guide_id = %s AND tenant_id = %s" in query
    assert params == (GUIDE, TENANT, 500)


def test_list_and_get_guard_non_uuid_ids():
    db = _database_with_mock_query()

    assert db.list_style_guide_revisions("slug-not-uuid", TENANT) == []
    assert db.list_style_guide_revisions(GUIDE, "t1") == []
    assert db.get_style_guide_revision("slug-not-uuid", TENANT) is None
    assert db.get_style_guide_revision(REVISION, "t1") is None
    db.execute_query.assert_not_called()


def test_get_latest_reads_the_newest_row_only():
    db = _database_with_mock_query()
    db.execute_query.return_value = [{"id": REVISION, "revision_number": 9}]

    assert db.get_latest_style_guide_revision(GUIDE, TENANT)["revision_number"] == 9
    assert db.execute_query.call_args.args[1] == (GUIDE, TENANT, 1)


def test_by_content_returns_the_newest_matching_revision():
    db = _database_with_mock_query()
    db.execute_query.return_value = [{"id": REVISION, "revision_number": 5}]

    row = db.get_style_guide_revision_by_content(GUIDE, TENANT, "f" * 64)

    assert row["revision_number"] == 5
    query, params = db.execute_query.call_args.args
    assert params == (GUIDE, TENANT, "f" * 64)
    # Newest wins: a later no-rule change (a rename) repeats the rule content, and the run
    # happened under that revision.
    assert "ORDER BY revision_number DESC" in query and "LIMIT 1" in query


def test_by_content_guards_an_empty_fingerprint():
    db = _database_with_mock_query()
    assert db.get_style_guide_revision_by_content(GUIDE, TENANT, "") is None
    db.execute_query.assert_not_called()
