"""Tenant import/export quality policy and waivers — IXH-2.3 (#5098).

Covers the acceptance criteria for the policy engine itself:

* the documented default is advisory — a tenant with no policy row blocks nothing;
* per-format overrides resolve deterministically (format override → tenant → default) and the
  winning tier is named in the verdict;
* waivers are honoured until they expire, and only for the format they were granted for;
* only the roles a policy names may override, and an empty list means nobody;
* the server-side import gate refuses a blocked commit and costs nothing under the default.

The API surface (policy CRUD, waiver grant, audit) is covered by
:mod:`tests.test_quality_policy_routes`; the pre-flight verdict by
:mod:`tests.test_import_preflight`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pytest

from app import import_export_quality_policy as qp
from app.import_export_quality_policy import (
    DEFAULT_POLICY,
    SCOPE_EXPORT,
    SCOPE_IMPORT,
    QualityGateError,
    QualityPolicy,
    QualityThresholds,
    evaluate_quality,
    grade_meets,
    load_tenant_policy,
    policy_content_fingerprint,
    policy_from_row,
    resolve_thresholds,
    role_may_override,
    severities_at_or_above,
    subject_key_for_document,
)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"


def _row(**overrides: Any) -> Dict[str, Any]:
    """A stored policy row with everything unset unless a test says otherwise."""
    row: Dict[str, Any] = {
        "id": "11111111-1111-1111-1111-111111111111",
        "tenant_id": TENANT_ID,
        "version_number": 3,
        "content_fingerprint": "fp-policy",
        "import_min_grade": None,
        "import_min_score": None,
        "import_block_on_severity": None,
        "import_enforcement": "advisory",
        "export_min_grade": None,
        "export_min_score": None,
        "export_block_on_severity": None,
        "export_enforcement": "advisory",
        "format_overrides": {},
        "allow_override": True,
        "override_roles": ["owner", "admin"],
        "waiver_ttl_hours": 168,
        "actor_user_id": None,
        "actor_label": "admin@example.com",
        "created_at": "2026-07-25T00:00:00+00:00",
    }
    row.update(overrides)
    return row


def _blocking_import_policy(**overrides: Any) -> QualityPolicy:
    """A policy that blocks imports below grade B."""
    return policy_from_row(
        _row(import_min_grade="B", import_enforcement="block", **overrides)
    )


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


def test_default_policy_blocks_nothing_for_either_scope():
    for scope in (SCOPE_IMPORT, SCOPE_EXPORT):
        verdict = evaluate_quality(
            policy=DEFAULT_POLICY,
            scope=scope,
            format_key="openapi",
            score=11,
            grade="F",
            severity_counts={"error": 9},
        )
        assert verdict.verdict == "pass"
        assert verdict.blocking is False
        assert verdict.source == "default"
        assert verdict.allow_override is True
        assert verdict.threshold_score is None


def test_missing_policy_row_resolves_to_the_default(monkeypatch):
    monkeypatch.setattr(qp.db, "get_latest_import_export_quality_policy", lambda _t: None)
    assert load_tenant_policy(TENANT_ID).is_default is True


def test_unreadable_policy_store_degrades_to_the_default(monkeypatch):
    """A gate that failed closed on an infrastructure fault would stop every import."""

    def _boom(_tenant_id: str):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(qp.db, "get_latest_import_export_quality_policy", _boom)
    assert load_tenant_policy(TENANT_ID) is DEFAULT_POLICY


# ---------------------------------------------------------------------------
# Comparison primitives
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "grade,minimum,expected",
    [
        ("A", "B", True),
        ("B", "B", True),
        ("C", "B", False),
        ("F", "A", False),
        (None, "B", True),  # ungraded candidates are not judged by a grade floor
        ("B", None, True),  # no floor
        ("Z", "B", True),  # unknown grade vocabulary is never a failure
    ],
)
def test_grade_meets(grade, minimum, expected):
    assert grade_meets(grade, minimum) is expected


@pytest.mark.parametrize(
    "counts,minimum,expected",
    [
        ({"error": 2, "warning": 5, "info": 1}, "error", 2),
        ({"error": 2, "warning": 5, "info": 1}, "warning", 7),
        ({"error": 2, "warning": 5, "info": 1}, "info", 8),
        ({"warning": 5}, "error", 0),
        ({"error": 2}, None, 0),
        ({"critical": 4}, "error", 0),  # unknown severity names are not counted
    ],
)
def test_severities_at_or_above(counts, minimum, expected):
    assert severities_at_or_above(counts, minimum) == expected


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def test_tenant_tier_resolves_when_no_override_matches():
    policy = policy_from_row(_row(import_min_score=90, import_enforcement="block"))
    thresholds, source = resolve_thresholds(policy, scope=SCOPE_IMPORT, format_key="graphql")
    assert source == "tenant"
    assert thresholds.min_score == 90
    assert thresholds.enforcement == "block"


def test_format_override_wins_and_is_named_in_the_verdict():
    policy = policy_from_row(
        _row(
            import_min_score=50,
            import_enforcement="block",
            format_overrides={"openapi": {"import": {"minScore": 95}}},
        )
    )
    thresholds, source = resolve_thresholds(policy, scope=SCOPE_IMPORT, format_key="openapi")
    assert source == "format_override"
    assert thresholds.min_score == 95
    # Fields the override did not state are inherited, not reset.
    assert thresholds.enforcement == "block"

    verdict = evaluate_quality(
        policy=policy, scope=SCOPE_IMPORT, format_key="openapi", score=90, grade="A"
    )
    assert verdict.verdict == "block"
    assert verdict.source == "format_override"
    assert verdict.threshold_score == 95


def test_format_override_is_scoped_and_case_insensitive():
    policy = policy_from_row(
        _row(
            import_min_score=50,
            format_overrides={"OpenAPI": {"export": {"minScore": 99}}},
        )
    )
    # The override is an *export* rule, so the import tier is untouched…
    thresholds, source = resolve_thresholds(policy, scope=SCOPE_IMPORT, format_key="openapi")
    assert (thresholds.min_score, source) == (50, "tenant")
    # …and it applies to export under the lowercased key.
    thresholds, source = resolve_thresholds(policy, scope=SCOPE_EXPORT, format_key="openapi")
    assert (thresholds.min_score, source) == (99, "format_override")


def test_resolution_is_deterministic_for_the_same_inputs():
    policy = policy_from_row(
        _row(format_overrides={"grpc": {"import": {"minGrade": "A", "enforcement": "block"}}})
    )
    first = resolve_thresholds(policy, scope=SCOPE_IMPORT, format_key="grpc")
    second = resolve_thresholds(policy, scope=SCOPE_IMPORT, format_key="grpc")
    assert first == second


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def test_advisory_enforcement_warns_without_blocking():
    policy = policy_from_row(_row(import_min_score=90))  # advisory by default
    verdict = evaluate_quality(
        policy=policy, scope=SCOPE_IMPORT, format_key="graphql", score=42, grade="F"
    )
    assert verdict.verdict == "warn"
    assert verdict.blocking is False
    assert [f["kind"] for f in verdict.failures] == ["score"]
    assert "advisory" in verdict.reason


def test_block_enforcement_blocks_and_lists_every_failed_floor():
    policy = policy_from_row(
        _row(
            import_min_score=90,
            import_min_grade="B",
            import_block_on_severity="error",
            import_enforcement="block",
        )
    )
    verdict = evaluate_quality(
        policy=policy,
        scope=SCOPE_IMPORT,
        format_key="graphql",
        score=42,
        grade="F",
        severity_counts={"error": 3, "warning": 1},
    )
    assert verdict.verdict == "block"
    assert verdict.blocking is True
    assert [f["kind"] for f in verdict.failures] == ["score", "grade", "severity"]
    assert verdict.policy_version_id == "11111111-1111-1111-1111-111111111111"
    assert verdict.policy_content_fingerprint == "fp-policy"
    assert "owner, admin" in verdict.reason


def test_meeting_every_floor_passes():
    policy = policy_from_row(
        _row(import_min_score=80, import_min_grade="B", import_enforcement="block")
    )
    verdict = evaluate_quality(
        policy=policy, scope=SCOPE_IMPORT, format_key="graphql", score=85, grade="B"
    )
    assert (verdict.verdict, verdict.blocking) == ("pass", False)
    assert verdict.failures == ()


def test_policy_without_a_floor_never_blocks_even_when_enforcing():
    policy = policy_from_row(_row(import_enforcement="block"))
    verdict = evaluate_quality(
        policy=policy, scope=SCOPE_IMPORT, format_key="graphql", score=0, grade="F"
    )
    assert verdict.verdict == "pass"
    assert "no import floor" in verdict.reason


def test_unscored_candidate_is_not_blocked_by_a_grade_floor():
    policy = _blocking_import_policy()
    verdict = evaluate_quality(
        policy=policy, scope=SCOPE_IMPORT, format_key="wsdl", score=None, grade=None
    )
    assert verdict.verdict == "pass"


def test_waiver_downgrades_a_block_to_a_warning():
    policy = _blocking_import_policy()
    waiver = {
        "id": "22222222-2222-2222-2222-222222222222",
        "expires_at": "2026-08-01T00:00:00+00:00",
        "actor_label": "lead@example.com",
    }
    verdict = evaluate_quality(
        policy=policy,
        scope=SCOPE_IMPORT,
        format_key="graphql",
        score=40,
        grade="F",
        waiver=waiver,
    )
    assert (verdict.verdict, verdict.blocking) == ("warn", False)
    assert verdict.waiver_id == waiver["id"]
    assert verdict.waiver_expires_at == waiver["expires_at"]
    assert "lead@example.com" in verdict.reason


def test_verdict_serializes_every_field_a_client_renders():
    verdict = evaluate_quality(
        policy=_blocking_import_policy(),
        scope=SCOPE_IMPORT,
        format_key="graphql",
        score=40,
        grade="F",
    )
    payload = verdict.as_dict()
    assert payload["verdict"] == "block"
    assert payload["source"] == "tenant"
    assert payload["min_grade"] == "B"
    assert payload["enforcement"] == "block"
    assert payload["override_roles"] == ["owner", "admin"]
    assert payload["failures"] == [{"kind": "grade", "required": "B", "actual": "F"}]


# ---------------------------------------------------------------------------
# Override roles
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "roles,allow,role,expected",
    [
        (["owner", "admin"], True, "owner", True),
        (["owner", "admin"], True, "editor", False),
        (["owner"], False, "owner", False),  # overrides disabled outright
        ([], True, "owner", False),  # an empty list means nobody, not everybody
        (["owner"], True, None, False),  # an unresolvable role never overrides
    ],
)
def test_role_may_override(roles, allow, role, expected):
    policy = policy_from_row(_row(override_roles=roles, allow_override=allow))
    assert role_may_override(policy, role) is expected


def test_effective_role_resolution_is_delegated_to_the_store(monkeypatch):
    monkeypatch.setattr(qp.db, "get_effective_role_slug", lambda _t, _u: "admin")
    assert qp.effective_role_slug(TENANT_ID, "660e8400-e29b-41d4-a716-446655440001") == "admin"
    assert qp.effective_role_slug(TENANT_ID, None) is None


def test_effective_role_degrades_to_none_when_the_store_fails(monkeypatch):
    def _boom(_tenant_id: str, _user_id: str):
        raise RuntimeError("no connection")

    monkeypatch.setattr(qp.db, "get_effective_role_slug", _boom)
    assert qp.effective_role_slug(TENANT_ID, "660e8400-e29b-41d4-a716-446655440001") is None


# ---------------------------------------------------------------------------
# Waiver matching and recording
# ---------------------------------------------------------------------------


def _waiver_row(**overrides: Any) -> Dict[str, Any]:
    row = {
        "id": "33333333-3333-3333-3333-333333333333",
        "scope": SCOPE_IMPORT,
        "subject_key": "abc",
        "format_key": "graphql",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    row.update(overrides)
    return row


def test_waiver_lookup_matches_the_gated_format(monkeypatch):
    rows = [_waiver_row(format_key="openapi"), _waiver_row(format_key="graphql")]
    monkeypatch.setattr(
        qp.db, "list_active_import_export_quality_waivers", lambda *_a, **_k: rows
    )
    hit = qp.find_active_waiver(
        tenant_id=TENANT_ID, scope=SCOPE_IMPORT, subject_key="abc", format_key="graphql"
    )
    assert hit is not None and hit["format_key"] == "graphql"

    miss = qp.find_active_waiver(
        tenant_id=TENANT_ID, scope=SCOPE_IMPORT, subject_key="abc", format_key="grpc"
    )
    assert miss is None


def test_waiver_without_a_format_covers_any_format(monkeypatch):
    monkeypatch.setattr(
        qp.db,
        "list_active_import_export_quality_waivers",
        lambda *_a, **_k: [_waiver_row(format_key=None)],
    )
    hit = qp.find_active_waiver(
        tenant_id=TENANT_ID, scope=SCOPE_IMPORT, subject_key="abc", format_key="grpc"
    )
    assert hit is not None


def test_waiver_lookup_is_time_bounded_by_the_store(monkeypatch):
    """Expiry is enforced in SQL; the helper passes the instant it evaluates against."""
    seen: Dict[str, Any] = {}

    def _list(tenant_id, *, scope, subject_key, now):
        seen.update({"tenant": tenant_id, "scope": scope, "subject": subject_key, "now": now})
        return []

    monkeypatch.setattr(qp.db, "list_active_import_export_quality_waivers", _list)
    instant = datetime(2026, 7, 25, tzinfo=timezone.utc)
    assert (
        qp.find_active_waiver(
            tenant_id=TENANT_ID, scope=SCOPE_IMPORT, subject_key="abc", now=instant
        )
        is None
    )
    assert seen["now"] == instant


def test_unreadable_waiver_ledger_means_no_waiver(monkeypatch):
    def _boom(*_a: Any, **_k: Any):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(qp.db, "list_active_import_export_quality_waivers", _boom)
    assert (
        qp.find_active_waiver(tenant_id=TENANT_ID, scope=SCOPE_IMPORT, subject_key="abc") is None
    )


def test_recording_a_waiver_stamps_the_policy_ttl(monkeypatch):
    captured: Dict[str, Any] = {}

    def _insert(**kwargs: Any) -> Dict[str, Any]:
        captured.update(kwargs)
        return {"id": "w1", **kwargs}

    monkeypatch.setattr(qp.db, "insert_import_export_quality_waiver", _insert)
    policy = policy_from_row(_row(waiver_ttl_hours=48))
    granted_at = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
    qp.record_quality_waiver(
        tenant_id=TENANT_ID,
        scope=SCOPE_IMPORT,
        subject_key="abc",
        reason="  ship it for the demo  ",
        policy=policy,
        actor_user_id="660e8400-e29b-41d4-a716-446655440001",
        actor_label="lead@example.com",
        actor_role="admin",
        now=granted_at,
    )
    assert captured["expires_at"] == granted_at + timedelta(hours=48)
    assert captured["reason"] == "ship it for the demo"
    assert captured["policy_version_id"] == policy.policy_version_id


def test_recording_a_waiver_requires_a_reason(monkeypatch):
    monkeypatch.setattr(
        qp.db, "insert_import_export_quality_waiver", lambda **_k: pytest.fail("inserted")
    )
    with pytest.raises(ValueError):
        qp.record_quality_waiver(
            tenant_id=TENANT_ID,
            scope=SCOPE_IMPORT,
            subject_key="abc",
            reason="   ",
            policy=DEFAULT_POLICY,
            actor_user_id=None,
            actor_label=None,
            actor_role="owner",
        )


def test_subject_key_is_the_document_content_hash():
    assert subject_key_for_document(b"hello") == (
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    )


# ---------------------------------------------------------------------------
# Policy fingerprint
# ---------------------------------------------------------------------------


def test_policy_fingerprint_is_stable_and_content_addressed():
    a = policy_content_fingerprint({"import": {"minGrade": "B"}, "allowOverride": True})
    b = policy_content_fingerprint({"allowOverride": True, "import": {"minGrade": "B"}})
    c = policy_content_fingerprint({"import": {"minGrade": "A"}, "allowOverride": True})
    assert a == b
    assert a != c
    assert len(a) == 64


# ---------------------------------------------------------------------------
# Server-side import gate
# ---------------------------------------------------------------------------


class _FakeLint:
    def __init__(self, score: Optional[int], grade: Optional[str]) -> None:
        self.score = score
        self.grade = grade
        self.severity_counts: Dict[str, int] = {"error": 1}


class _FakeDetection:
    adapter_key = "graphql"


class _FakeReport:
    def __init__(self, ok: bool = True, lint: Optional[_FakeLint] = None) -> None:
        self.ok = ok
        self.lint = lint
        self.detection = _FakeDetection()


async def _gate(**overrides: Any):
    """Run the import gate for a fixed document with sensible defaults."""
    kwargs: Dict[str, Any] = {
        "tenant_id": TENANT_ID,
        "tenant_slug": "acme",
        "user_id": "660e8400-e29b-41d4-a716-446655440001",
        "raw": b"type Query { hello: String }",
        "filename": "schema.graphql",
        "content_type": None,
        "source_kind": None,
        "import_target": None,
    }
    kwargs.update(overrides)
    return await qp.enforce_import_quality_gate(**kwargs)


@pytest.mark.asyncio
async def test_gate_is_free_under_the_default_policy(monkeypatch):
    """No policy configured → the gate never touches the document."""
    monkeypatch.setattr(qp.db, "get_latest_import_export_quality_policy", lambda _t: None)

    async def _never(*_a: Any, **_k: Any):
        pytest.fail("the gate pre-flighted a document under the default policy")

    monkeypatch.setattr("app.import_preflight.run_import_preflight", _never)
    assert await _gate() is None


@pytest.mark.asyncio
async def test_gate_skips_a_configured_but_advisory_policy(monkeypatch):
    monkeypatch.setattr(
        qp.db, "get_latest_import_export_quality_policy", lambda _t: _row(import_min_score=90)
    )

    async def _never(*_a: Any, **_k: Any):
        pytest.fail("the gate pre-flighted a document under an advisory policy")

    monkeypatch.setattr("app.import_preflight.run_import_preflight", _never)
    assert await _gate() is None


@pytest.mark.asyncio
async def test_gate_blocks_a_candidate_below_the_floor(monkeypatch):
    monkeypatch.setattr(
        qp.db,
        "get_latest_import_export_quality_policy",
        lambda _t: _row(import_min_grade="B", import_enforcement="block"),
    )
    monkeypatch.setattr(
        qp.db, "list_active_import_export_quality_waivers", lambda *_a, **_k: []
    )

    async def _report(*_a: Any, **_k: Any):
        return _FakeReport(lint=_FakeLint(score=41, grade="F"))

    monkeypatch.setattr("app.import_preflight.run_import_preflight", _report)
    with pytest.raises(QualityGateError) as excinfo:
        await _gate()
    assert excinfo.value.verdict.blocking is True
    assert excinfo.value.verdict.format_key == "graphql"


@pytest.mark.asyncio
async def test_gate_admits_a_waived_candidate(monkeypatch):
    monkeypatch.setattr(
        qp.db,
        "get_latest_import_export_quality_policy",
        lambda _t: _row(import_min_grade="B", import_enforcement="block"),
    )
    monkeypatch.setattr(
        qp.db,
        "list_active_import_export_quality_waivers",
        lambda *_a, **_k: [_waiver_row(format_key="graphql")],
    )

    async def _report(*_a: Any, **_k: Any):
        return _FakeReport(lint=_FakeLint(score=41, grade="F"))

    monkeypatch.setattr("app.import_preflight.run_import_preflight", _report)
    verdict = await _gate()
    assert verdict is not None and verdict.verdict == "warn"


@pytest.mark.asyncio
async def test_gate_defers_to_the_pipeline_for_an_unimportable_candidate(monkeypatch):
    """A document that cannot be parsed gets the taxonomy error, not "quality policy"."""
    monkeypatch.setattr(
        qp.db,
        "get_latest_import_export_quality_policy",
        lambda _t: _row(import_min_grade="B", import_enforcement="block"),
    )

    async def _report(*_a: Any, **_k: Any):
        return _FakeReport(ok=False, lint=None)

    monkeypatch.setattr("app.import_preflight.run_import_preflight", _report)
    assert await _gate() is None


# ---------------------------------------------------------------------------
# Export half (IXH-2.4 / 2.5 entry point)
# ---------------------------------------------------------------------------


def test_export_evaluation_uses_the_export_tier_and_waivers(monkeypatch):
    monkeypatch.setattr(
        qp.db,
        "get_latest_import_export_quality_policy",
        lambda _t: _row(
            import_min_score=10,
            export_min_score=95,
            export_enforcement="block",
        ),
    )
    claimed: List[Dict[str, Any]] = []

    def _list(tenant_id, *, scope, subject_key, now):
        claimed.append({"scope": scope, "subject": subject_key})
        return []

    monkeypatch.setattr(qp.db, "list_active_import_export_quality_waivers", _list)
    verdict = qp.evaluate_export_quality(
        tenant_id=TENANT_ID,
        target_key="grpc",
        score=80,
        grade="B",
        subject_key="rev-1|grpc",
    )
    assert verdict.verdict == "block"
    assert verdict.scope == SCOPE_EXPORT
    assert verdict.threshold_score == 95
    assert claimed == [{"scope": SCOPE_EXPORT, "subject": "rev-1|grpc"}]


def test_thresholds_merge_only_the_fields_an_override_states():
    base = QualityThresholds(min_grade="B", min_score=70, enforcement="block")
    merged = base.merged_with(
        QualityThresholds(min_score=90), override_fields=["min_score"]
    )
    assert merged == QualityThresholds(min_grade="B", min_score=90, enforcement="block")
