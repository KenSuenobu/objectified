"""Quality-rank telemetry: attribution, recording and the grade series — IXH-2.7 (#5102).

Everything here is exercised without a database: the attribution and aggregation halves of
:mod:`app.quality_rank_telemetry` are pure, and the recording half is driven through a patched
:meth:`Database.record_quality_rank_observation` so the observation each hook *would* write is
asserted field by field.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import quality_rank_telemetry as qrt

NOW = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)


# --- Attribution ------------------------------------------------------------------------------


def test_intake_rules_are_adapter_attributable_and_others_are_spec():
    breakdown, adapter_total, spec_total = qrt.attribute_rule_hits(
        {
            "intake.unresolved-external-ref": 2,
            "intake.blocked-external-ref": 1,
            "documentation.operation-missing-summary": 4,
            "naming.schema-pascal-case": 3,
        }
    )
    assert adapter_total == 3
    assert spec_total == 7
    assert breakdown[qrt.ADAPTER_ATTRIBUTION] == {qrt.ATTRIBUTION_INTAKE_RESOLUTION: 3}
    assert breakdown[qrt.SPEC_ATTRIBUTION] == {"documentation": 4, "naming": 3}


def test_unknown_rule_namespace_defaults_to_the_specification():
    """Blaming the adapter for every unrecognised rule would make the split meaningless."""
    breakdown, adapter_total, spec_total = qrt.attribute_rule_hits({"brandnew.rule": 5})
    assert adapter_total == 0
    assert spec_total == 5
    assert qrt.ADAPTER_ATTRIBUTION not in breakdown
    assert breakdown[qrt.SPEC_ATTRIBUTION] == {"brandnew": 5}


@pytest.mark.parametrize(
    "hits",
    [None, {}, {"documentation.x": 0}, {"documentation.x": -3}, {"documentation.x": "nope"}],
)
def test_empty_and_unusable_rule_hits_produce_an_empty_breakdown(hits):
    breakdown, adapter_total, spec_total = qrt.attribute_rule_hits(hits)
    assert (breakdown, adapter_total, spec_total) == ({}, 0, 0)


def test_a_rule_id_without_a_dot_is_its_own_class():
    """A namespace-less rule id is its own class; only a blank id falls back to ``other``."""
    breakdown, _adapter, spec_total = qrt.attribute_rule_hits({"bare-rule": 2, "  ": 1})
    assert spec_total == 3
    assert breakdown[qrt.SPEC_ATTRIBUTION] == {"bare-rule": 2, "other": 1}


def test_declared_parser_limits_come_from_the_shared_declaration_table():
    from app.import_preview_manifest import KNOWN_PARSER_LIMITS

    assert qrt.declared_parser_limit_count("thrift") == len(KNOWN_PARSER_LIMITS["thrift"])
    assert qrt.declared_parser_limit_count("THRIFT") == len(KNOWN_PARSER_LIMITS["thrift"])
    assert qrt.declared_parser_limit_count("openapi") == 0
    assert qrt.declared_parser_limit_count(None) == 0


# --- Outcome mapping --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "verdict,gradable,expected",
    [
        ("pass", True, "pass"),
        ("warn", True, "warn"),
        ("block", True, "block"),
        (None, True, "pass"),
        ("nonsense", True, "pass"),
        ("pass", False, "error"),
    ],
)
def test_outcome_for_verdict(verdict, gradable, expected):
    assert qrt.outcome_for_verdict(verdict, gradable=gradable) == expected


@pytest.mark.parametrize(
    "band,expected",
    [("ready", "pass"), ("caution", "warn"), ("blocked", "block"), ("unavailable", "error")],
)
def test_outcome_for_band(band, expected):
    assert qrt.outcome_for_band(band) == expected


# --- Recording --------------------------------------------------------------------------------


def _lint(score=82, grade="B", rule_hits=None, severity=None):
    """A stand-in for the lint report the hooks read (duck-typed by attribute)."""
    return SimpleNamespace(
        score=score,
        grade=grade,
        report_fingerprint="lint-fp",
        rule_hits=rule_hits or {"documentation.x": 2},
        severity_counts=severity or {"error": 1, "warning": 2, "info": 0},
    )


def _policy(verdict="warn", blocking=False):
    return SimpleNamespace(
        verdict=verdict,
        blocking=blocking,
        policy_version_id="11111111-1111-4111-8111-111111111111",
        policy_content_fingerprint="policy-fp",
    )


def _guide(fingerprint="guide-fp"):
    return SimpleNamespace(
        guide_id="22222222-2222-4222-8222-222222222222",
        fingerprint=fingerprint,
        source="custom",
    )


@pytest.fixture
def recorded():
    """Capture every observation the hooks record, without a database."""
    rows = []

    def _record(**kwargs):
        rows.append(kwargs)
        return {"id": f"obs-{len(rows)}"}

    with patch("app.database.db") as fake_db:
        fake_db.record_quality_rank_observation.side_effect = _record
        yield rows


def test_import_preflight_observation_records_grade_policy_and_attribution(recorded):
    report = SimpleNamespace(
        ok=True,
        format="openapi-3.1",
        detection=SimpleNamespace(adapter_key="openapi"),
        lint=_lint(rule_hits={"intake.unresolved-external-ref": 1, "naming.x": 4}),
        policy=_policy(),
        style_guide=_guide(),
    )
    assert qrt.observe_import_preflight(report, tenant_id="t1") == "obs-1"

    row = recorded[0]
    assert row["scope"] == qrt.SCOPE_IMPORT
    assert row["stage"] == qrt.STAGE_PREFLIGHT
    assert row["outcome"] == "warn"
    assert (row["format_key"], row["adapter_key"]) == ("openapi-3.1", "openapi")
    assert (row["score"], row["grade"]) == (82, "B")
    assert (row["error_count"], row["warning_count"], row["info_count"]) == (1, 2, 0)
    assert (row["adapter_finding_count"], row["spec_finding_count"]) == (1, 4)
    assert row["attribution"][qrt.ADAPTER_ATTRIBUTION] == {
        qrt.ATTRIBUTION_INTAKE_RESOLUTION: 1
    }
    assert row["style_guide_fingerprint"] == "guide-fp"
    assert row["policy_content_fingerprint"] == "policy-fp"


def test_an_unimportable_candidate_is_recorded_as_an_error_outcome(recorded):
    report = SimpleNamespace(
        ok=False,
        format=None,
        detection=SimpleNamespace(adapter_key=None),
        lint=None,
        policy=_policy(verdict="pass"),
        style_guide=None,
    )
    qrt.observe_import_preflight(report, tenant_id="t1")
    row = recorded[0]
    assert row["outcome"] == "error"
    assert row["score"] is None and row["grade"] is None


def test_import_commit_observation_names_the_revision_it_landed_on(recorded):
    qrt.observe_import_commit(
        tenant_id="t1",
        adapter_key="thrift",
        format_key="thrift",
        lint=_lint(score=71, grade="C"),
        style_guide=_guide(),
        project_id="p1",
        version_record_id="v1",
    )
    row = recorded[0]
    assert row["stage"] == qrt.STAGE_COMMITTED
    assert row["outcome"] == "pass"
    assert (row["project_id"], row["version_record_id"]) == ("p1", "v1")
    # The adapter's declared parser limits travel with the observation, separately from findings.
    assert row["declared_parser_limits"] >= 1
    assert row["adapter_finding_count"] == 0


def _target(key, band, rank, readiness, preserved=90):
    return SimpleNamespace(
        key=key,
        format=f"{key}-1",
        band=band,
        rank=rank,
        readiness=readiness,
        fidelity=SimpleNamespace(preserved_percent=preserved),
        policy=_policy(verdict="pass"),
    )


def test_export_preflight_records_only_the_head_of_the_ranking(recorded):
    report = SimpleNamespace(
        lint=_lint(),
        style_guide=_guide(),
        version_record_id="v9",
        targets=[
            _target(f"t{i}", "ready", i, 95 - i) for i in range(1, 9)
        ],
    )
    ids = qrt.observe_export_preflight(report, tenant_id="t1", project_id="p1")
    assert len(ids) == qrt.EXPORT_PREFLIGHT_RANK_SAMPLE
    assert [row["adapter_key"] for row in recorded] == ["t1", "t2", "t3", "t4", "t5"]
    assert recorded[0]["scope"] == qrt.SCOPE_EXPORT
    assert recorded[0]["stage"] == qrt.STAGE_PREFLIGHT
    assert recorded[0]["readiness"] == 94
    assert recorded[0]["rank"] == 1
    assert recorded[0]["preserved_percent"] == 90


def test_unavailable_targets_carry_no_readiness_and_are_skipped(recorded):
    report = SimpleNamespace(
        lint=_lint(),
        style_guide=None,
        version_record_id="v9",
        targets=[_target("gone", "unavailable", 1, 0), _target("here", "caution", 2, 60)],
    )
    qrt.observe_export_preflight(report, tenant_id="t1")
    assert [row["adapter_key"] for row in recorded] == ["here"]
    assert recorded[0]["outcome"] == "warn"


def test_delivery_observation_maps_the_decision_and_falls_back_to_its_own_rollup(recorded):
    decision = SimpleNamespace(
        target="openapi-3.1",
        blocks_delivery=True,
        warns=False,
        preserved_percent=64,
        source_score=55,
        source_grade="D",
        source_report_fingerprint="delivery-fp",
        policy=_policy(verdict="block", blocking=True),
    )
    qrt.observe_delivery(
        decision, tenant_id="t1", lint=None, project_id="p1", version_record_id="v1"
    )
    row = recorded[0]
    assert (row["scope"], row["stage"]) == (qrt.SCOPE_EXPORT, qrt.STAGE_COMMITTED)
    assert row["outcome"] == "block"
    assert row["blocking"] is True
    assert (row["score"], row["grade"]) == (55, "D")
    assert row["report_fingerprint"] == "delivery-fp"
    assert row["preserved_percent"] == 64


def test_a_warned_delivery_records_a_warn_outcome(recorded):
    decision = SimpleNamespace(
        target="grpc",
        blocks_delivery=False,
        warns=True,
        preserved_percent=None,
        policy=_policy(verdict="warn"),
    )
    qrt.observe_delivery(decision, tenant_id="t1", lint=_lint())
    assert recorded[0]["outcome"] == "warn"
    assert recorded[0]["preserved_percent"] is None


def test_recording_never_raises_into_the_work_it_observes():
    with patch("app.database.db") as fake_db:
        fake_db.record_quality_rank_observation.side_effect = RuntimeError("table missing")
        assert (
            qrt.record_observation(
                qrt.QualityRankObservation(
                    tenant_id="t1",
                    scope=qrt.SCOPE_IMPORT,
                    stage=qrt.STAGE_PREFLIGHT,
                    outcome="pass",
                )
            )
            is None
        )


def test_an_observation_without_a_tenant_is_not_recorded(recorded):
    assert qrt.observe_import_preflight(SimpleNamespace(ok=True), tenant_id="") is None
    assert qrt.observe_delivery(SimpleNamespace(target="x"), tenant_id="") is None
    assert qrt.observe_export_preflight(SimpleNamespace(targets=[]), tenant_id="") == []
    assert recorded == []


# --- Retention --------------------------------------------------------------------------------


class _PruneDb:
    """Minimal database stand-in recording the cutoff it was asked to prune with."""

    def __init__(self, deleted=7, error=None):
        self.deleted = deleted
        self.error = error
        self.cutoff = None

    def prune_quality_rank_observations(self, *, older_than):
        if self.error:
            raise self.error
        self.cutoff = older_than
        return self.deleted


def test_retention_prunes_against_the_configured_window():
    database = _PruneDb()
    assert qrt.prune_quality_rank_observations(database, now=NOW, retention_days=30) == 7
    assert database.cutoff == NOW - timedelta(days=30)


def test_retention_of_zero_days_keeps_observations_forever():
    database = _PruneDb()
    assert qrt.prune_quality_rank_observations(database, now=NOW, retention_days=0) == 0
    assert database.cutoff is None


def test_a_failed_prune_is_swallowed_and_retried_next_tick():
    database = _PruneDb(error=RuntimeError("locked"))
    assert qrt.prune_quality_rank_observations(database, now=NOW, retention_days=30) == 0


# --- Aggregation ------------------------------------------------------------------------------


def _row(**overrides):
    row = {
        "scope": qrt.SCOPE_IMPORT,
        "stage": qrt.STAGE_PREFLIGHT,
        "outcome": "pass",
        "format_key": "openapi-3.1",
        "adapter_key": "openapi",
        "style_guide_fingerprint": "guide-a",
        "score": 80,
        "grade": "B",
        "readiness": None,
        "rank": None,
        "blocking": False,
        "adapter_finding_count": 0,
        "spec_finding_count": 3,
        "declared_parser_limits": 0,
        "attribution": {qrt.SPEC_ATTRIBUTION: {"documentation": 3}},
        "occurred_at": NOW,
    }
    row.update(overrides)
    return row


def test_series_groups_by_scope_and_format_with_one_point_per_day():
    series = qrt.build_quality_rank_series(
        [
            _row(score=90, grade="A", occurred_at=NOW - timedelta(days=2)),
            _row(score=70, grade="C"),
            _row(scope=qrt.SCOPE_EXPORT, format_key="grpc", adapter_key="grpc", readiness=88),
        ],
        days=3,
        now=NOW,
    )
    assert series["days"] == 3
    assert series["observation_count"] == 3
    assert [(f["scope"], f["format_key"]) for f in series["formats"]] == [
        (qrt.SCOPE_IMPORT, "openapi-3.1"),
        (qrt.SCOPE_EXPORT, "grpc"),
    ]

    openapi = series["formats"][0]
    assert openapi["observations"] == 2
    assert openapi["grade_distribution"]["A"] == 1
    assert openapi["grade_distribution"]["C"] == 1
    assert openapi["average_score"] == 80
    # Drift: newest scored minus oldest scored inside the window.
    assert openapi["score_delta"] == -20
    assert openapi["latest_grade"] == "C"
    assert [point["date"] for point in openapi["points"]] == [
        (NOW - timedelta(days=2)).date().isoformat(),
        (NOW - timedelta(days=1)).date().isoformat(),
        NOW.date().isoformat(),
    ]
    assert openapi["points"][0]["average_score"] == 90
    # A day with no observation is a gap, never a zero score.
    assert openapi["points"][1] == {
        "date": (NOW - timedelta(days=1)).date().isoformat(),
        "observations": 0,
        "average_score": None,
        "average_readiness": None,
        "grade_distribution": {g: 0 for g in (*qrt.GRADES, "ungraded")},
    }


def test_export_readiness_rides_the_same_series():
    series = qrt.build_quality_rank_series(
        [
            _row(
                scope=qrt.SCOPE_EXPORT,
                stage=qrt.STAGE_PREFLIGHT,
                format_key="grpc",
                readiness=90,
                rank=2,
            ),
            _row(
                scope=qrt.SCOPE_EXPORT,
                stage=qrt.STAGE_PREFLIGHT,
                format_key="grpc",
                readiness=70,
                rank=1,
            ),
        ],
        days=2,
        now=NOW,
    )
    grpc = series["formats"][0]
    assert grpc["average_readiness"] == 80
    assert grpc["best_rank"] == 1
    assert grpc["points"][-1]["average_readiness"] == 80


def test_attribution_is_summed_per_class_across_the_window():
    series = qrt.build_quality_rank_series(
        [
            _row(
                adapter_finding_count=2,
                spec_finding_count=1,
                declared_parser_limits=1,
                attribution={
                    qrt.ADAPTER_ATTRIBUTION: {qrt.ATTRIBUTION_INTAKE_RESOLUTION: 2},
                    qrt.SPEC_ATTRIBUTION: {"naming": 1},
                },
            ),
            _row(
                adapter_finding_count=1,
                spec_finding_count=4,
                declared_parser_limits=1,
                attribution={
                    qrt.ADAPTER_ATTRIBUTION: {qrt.ATTRIBUTION_INTAKE_RESOLUTION: 1},
                    qrt.SPEC_ATTRIBUTION: {"naming": 1, "documentation": 3},
                },
            ),
        ],
        days=1,
        now=NOW,
    )
    entry = series["formats"][0]
    assert entry["adapter_finding_count"] == 3
    assert entry["spec_finding_count"] == 5
    assert entry["declared_parser_limits"] == 1
    assert entry["attribution"][qrt.ADAPTER_ATTRIBUTION] == {
        qrt.ATTRIBUTION_INTAKE_RESOLUTION: 3
    }
    assert entry["attribution"][qrt.SPEC_ATTRIBUTION] == {"documentation": 3, "naming": 2}


def test_style_guide_changes_inside_the_window_are_visible():
    series = qrt.build_quality_rank_series(
        [_row(style_guide_fingerprint="guide-a"), _row(style_guide_fingerprint="guide-b")],
        days=1,
        now=NOW,
    )
    assert series["formats"][0]["style_guide_versions"] == ["guide-a", "guide-b"]


def test_rows_outside_the_window_and_undated_rows_are_ignored():
    series = qrt.build_quality_rank_series(
        [
            _row(occurred_at=NOW - timedelta(days=40)),
            _row(occurred_at=None),
            _row(),
        ],
        days=7,
        now=NOW,
    )
    assert series["observation_count"] == 1
    assert series["formats"][0]["observations"] == 1


def test_ungraded_observations_bucket_separately_from_a_low_grade():
    series = qrt.build_quality_rank_series(
        [_row(score=None, grade=None, outcome="error")], days=1, now=NOW
    )
    entry = series["formats"][0]
    assert entry["grade_distribution"]["ungraded"] == 1
    assert entry["average_score"] is None
    assert entry["score_delta"] is None
    assert series["outcomes"]["error"] == 1


def test_format_groups_are_capped_and_truncation_is_stated():
    rows = [_row(format_key=f"fmt-{i}") for i in range(6)]
    series = qrt.build_quality_rank_series(rows, days=1, now=NOW, max_formats=3)
    assert series["truncated"] is True
    assert series["format_limit"] == 3
    assert len(series["formats"]) == 3


def test_the_window_is_clamped_to_the_documented_maximum():
    series = qrt.build_quality_rank_series([], days=10_000, now=NOW)
    assert series["days"] == qrt.MAX_WINDOW_DAYS
    assert len(series["formats"]) == 0
    assert series["stages"] == {qrt.STAGE_PREFLIGHT: 0, qrt.STAGE_COMMITTED: 0}


def test_stage_and_outcome_tallies_cover_both_halves():
    series = qrt.build_quality_rank_series(
        [
            _row(stage=qrt.STAGE_PREFLIGHT, outcome="pass"),
            _row(stage=qrt.STAGE_COMMITTED, outcome="warn"),
            _row(stage=qrt.STAGE_COMMITTED, outcome="block", blocking=True),
        ],
        days=1,
        now=NOW,
    )
    assert series["stages"] == {qrt.STAGE_PREFLIGHT: 1, qrt.STAGE_COMMITTED: 2}
    assert series["outcomes"]["warn"] == 1
    assert series["formats"][0]["blocked_count"] == 1
