"""Route tests for the quality-rank series — IXH-2.7 (#5102).

``GET /v1/lint/workspace/quality-ranks`` is the read half of the grade series: the observation
loader is stubbed so these assert the *contract* (camelCase shape, window/vocabulary validation,
per-format split, attribution breakdown) rather than the database.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "email": "a@b.c"}

# Relative to the wall clock so the requested window always contains these rows.
NOW = datetime.now(timezone.utc).replace(microsecond=0)


@pytest.fixture(autouse=True)
def _auth_override():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _observation(**overrides):
    row = {
        "scope": "import",
        "stage": "preflight",
        "outcome": "pass",
        "format_key": "openapi-3.1",
        "adapter_key": "openapi",
        "style_guide_fingerprint": "guide-a",
        "score": 84,
        "grade": "B",
        "readiness": None,
        "rank": None,
        "blocking": False,
        "adapter_finding_count": 1,
        "spec_finding_count": 5,
        "declared_parser_limits": 0,
        "attribution": {
            "adapter": {"intake-resolution": 1},
            "spec": {"documentation": 5},
        },
        "occurred_at": NOW,
    }
    row.update(overrides)
    return row


def _get(**params):
    return client.get("/v1/lint/workspace/quality-ranks", params=params)


def test_series_is_grouped_per_format_and_serialized_in_camel_case():
    rows = [
        _observation(),
        _observation(score=60, grade="D", occurred_at=NOW - timedelta(days=1)),
        _observation(
            scope="export",
            stage="committed",
            format_key="grpc",
            adapter_key="grpc",
            readiness=77,
            rank=1,
            outcome="warn",
        ),
    ]
    with patch(
        "app.lint_workspace_routes.load_quality_rank_observations", return_value=rows
    ) as loader:
        resp = _get(days=7)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["days"] == 7
    assert body["observationCount"] == 3
    assert body["truncated"] is False
    assert body["stages"] == {"preflight": 2, "committed": 1}
    assert body["outcomes"]["pass"] == 2 and body["outcomes"]["warn"] == 1

    openapi, grpc = body["formats"]
    assert (openapi["scope"], openapi["formatKey"]) == ("import", "openapi-3.1")
    assert openapi["adapterKeys"] == ["openapi"]
    assert openapi["styleGuideVersions"] == ["guide-a"]
    assert openapi["averageScore"] == 72
    assert openapi["latestGrade"] == "B"
    # Drift: the newest scored observation is 24 points above the oldest in the window.
    assert openapi["scoreDelta"] == 24
    assert len(openapi["points"]) == 7
    assert openapi["points"][-1]["averageScore"] == 84

    assert grpc["scope"] == "export"
    assert grpc["averageReadiness"] == 77
    assert grpc["bestRank"] == 1

    # The window handed to the loader matches the requested days.
    kwargs = loader.call_args.kwargs
    assert kwargs["scope"] is None and kwargs["stage"] is None
    assert kwargs["since"] <= NOW - timedelta(days=6)


def test_adapter_and_spec_attribution_are_reported_separately():
    rows = [_observation(), _observation(declared_parser_limits=2, adapter_key="thrift")]
    with patch("app.lint_workspace_routes.load_quality_rank_observations", return_value=rows):
        body = _get(days=3).json()

    entry = body["formats"][0]
    assert entry["adapterFindingCount"] == 2
    assert entry["specFindingCount"] == 10
    assert entry["attribution"]["adapter"] == {"intake-resolution": 2}
    assert entry["attribution"]["spec"] == {"documentation": 10}
    # A declared parser limit is adapter evidence, but it is never counted as a finding.
    assert entry["declaredParserLimits"] == 2
    assert entry["adapterKeys"] == ["openapi", "thrift"]


def test_days_outside_the_supported_window_are_rejected():
    assert _get(days=0).status_code == 422
    assert _get(days=181).status_code == 422


@pytest.mark.parametrize("params", [{"scope": "sideways"}, {"stage": "someday"}])
def test_unknown_scope_or_stage_is_a_400(params):
    resp = _get(**params)
    assert resp.status_code == 400
    assert "must be" in resp.json()["detail"]


@pytest.mark.parametrize(
    "params,expected",
    [
        ({"scope": "export"}, {"scope": "export", "stage": None}),
        ({"stage": "committed"}, {"scope": None, "stage": "committed"}),
    ],
)
def test_scope_and_stage_filters_are_pushed_into_the_read(params, expected):
    with patch(
        "app.lint_workspace_routes.load_quality_rank_observations", return_value=[]
    ) as loader:
        assert _get(**params).status_code == 200
    kwargs = loader.call_args.kwargs
    assert kwargs["scope"] == expected["scope"]
    assert kwargs["stage"] == expected["stage"]


def test_project_scope_is_forwarded():
    with patch(
        "app.lint_workspace_routes.load_quality_rank_observations", return_value=[]
    ) as loader:
        assert _get(projectId="p-1").status_code == 200
    assert loader.call_args.kwargs["project_id"] == "p-1"


def test_a_tenant_with_no_observations_gets_an_empty_but_well_formed_series():
    with patch("app.lint_workspace_routes.load_quality_rank_observations", return_value=[]):
        body = _get(days=14).json()
    assert body["formats"] == []
    assert body["observationCount"] == 0
    assert body["windowStart"] < body["windowEnd"]
    assert body["formatLimit"] > 0
