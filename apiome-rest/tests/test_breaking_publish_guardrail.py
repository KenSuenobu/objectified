"""Breaking-publish guardrail — semver policy, assessment, publish gate (CTG-3.4, #4478)."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.breaking_publish_guardrail import (
    MAX_LISTED_BREAKING_CHANGES,
    STATUS_BLOCKED,
    STATUS_DISABLED,
    STATUS_NO_BASELINE,
    STATUS_OK,
    STATUS_UNAVAILABLE,
    STATUS_WARNING,
    assess_breaking_publish,
    resolve_breaking_publish_policy,
)
from app.breaking_publish_policy import (
    DEFAULT_BREAKING_PUBLISH_POLICY,
    normalize_breaking_publish_policy,
)
from app.main import app
from app.semver_version import is_major_bump, next_major_label, parse_semver

client = TestClient(app)

_MOCK_JWT = {
    "tenant_id": "t1",
    "user_id": "user-a",
    "auth_method": "jwt",
}

_BASE_SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pets", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "summary": "List pets",
                "responses": {"200": {"description": "ok"}},
            }
        },
        "/owners": {
            "get": {
                "summary": "List owners",
                "responses": {"200": {"description": "ok"}},
            }
        },
    },
    "components": {"schemas": {}},
}


def _head_row(version_label: str = "1.1.0") -> Dict[str, Any]:
    """A candidate (unpublished) revision row."""
    return {
        "id": "vid-1",
        "project_id": "pid-1",
        "creator_id": "user-a",
        "published": False,
        "version_id": version_label,
        "description": None,
        "change_log": None,
    }


def _baseline_row(version_label: str = "1.0.0") -> Dict[str, Any]:
    """The previous published revision row."""
    return {
        "id": "base-1",
        "project_id": "pid-1",
        "creator_id": "user-a",
        "published": True,
        "version_id": version_label,
        "description": None,
        "change_log": None,
    }


def _breaking_head_spec() -> Dict[str, Any]:
    """``_BASE_SPEC`` with a path removed — a breaking change under the CTG-1.1 taxonomy."""
    spec = copy.deepcopy(_BASE_SPEC)
    del spec["paths"]["/owners"]
    return spec


def _db_for(baseline: Dict[str, Any] | None = _baseline_row()) -> MagicMock:
    """A db double resolving the prior published baseline (or none)."""
    shared = MagicMock()
    shared.get_prior_published_baseline_revision_id.return_value = (
        str(baseline["id"]) if baseline else None
    )
    shared.get_version_by_id.return_value = baseline
    return shared


def _assess(
    *,
    head_label: str = "1.1.0",
    base_label: str = "1.0.0",
    head_spec: Dict[str, Any] | None = None,
    policy: str = "warn",
    shared: MagicMock | None = None,
):
    """Run an assessment with the baseline spec loader stubbed to ``_BASE_SPEC``."""
    shared = shared or _db_for(_baseline_row(base_label))
    with patch("app.breaking_publish_guardrail.db", shared):
        return assess_breaking_publish(
            tenant_slug="acme",
            tenant_id="t1",
            project_id="pid-1",
            head_version=_head_row(head_label),
            head_spec=head_spec if head_spec is not None else copy.deepcopy(_BASE_SPEC),
            policy=policy,
            openapi_loader=lambda *_a, **_k: copy.deepcopy(_BASE_SPEC),
        )


# ===========================================================================
# Semver helpers
# ===========================================================================


@pytest.mark.parametrize(
    "label,expected",
    [
        ("1.2.3", (1, 2, 3, ())),
        ("v2.0.0", (2, 0, 0, ())),
        ("  V0.1.0 ", (0, 1, 0, ())),
        ("3.0.0-rc.1", (3, 0, 0, ("rc", "1"))),
        ("1.0.0+build.5", (1, 0, 0, ())),
    ],
)
def test_parse_semver_accepts_semver_labels(label, expected) -> None:
    assert parse_semver(label) == expected


@pytest.mark.parametrize("label", ["", "   ", "latest", "2026-01-01", "1.2", "01.2.3", None])
def test_parse_semver_rejects_non_semver_labels(label) -> None:
    assert parse_semver(label) is None


def test_is_major_bump_reports_true_false_and_unknown() -> None:
    assert is_major_bump("1.4.0", "2.0.0") is True
    assert is_major_bump("1.4.0", "1.5.0") is False
    assert is_major_bump("1.4.0", "1.4.1") is False
    assert is_major_bump("2.0.0", "1.0.0") is False
    # Unknown, never a silent False: a non-semver label is not a semver violation.
    assert is_major_bump("spring-2026", "2.0.0") is None
    assert is_major_bump("1.0.0", "latest") is None


def test_next_major_label() -> None:
    assert next_major_label("1.4.2") == "2.0.0"
    assert next_major_label("v0.9.9") == "1.0.0"
    assert next_major_label("latest") is None


# ===========================================================================
# Policy vocabulary and resolution
# ===========================================================================


@pytest.mark.parametrize("raw", ["off", "warn", "block", "BLOCK", " Warn "])
def test_normalize_policy_accepts_the_closed_vocabulary(raw) -> None:
    assert normalize_breaking_publish_policy(raw) == raw.strip().lower()


@pytest.mark.parametrize("raw", [None, "", "nope", 7, {"level": "block"}])
def test_normalize_policy_falls_back_to_warn_never_block(raw) -> None:
    assert normalize_breaking_publish_policy(raw) == DEFAULT_BREAKING_PUBLISH_POLICY


def test_resolve_policy_reads_the_assigned_guide() -> None:
    shared = MagicMock()
    shared.get_assigned_style_guide.return_value = {
        "id": "g1",
        "name": "Payments",
        "source": "custom",
        "breaking_publish_policy": "block",
    }
    with patch("app.breaking_publish_guardrail.db", shared):
        assert resolve_breaking_publish_policy("t1", "pid-1") == "block"
    shared.get_assigned_style_guide.assert_called_once_with("t1", "pid-1")


def test_resolve_policy_degrades_to_warn_when_no_guide_or_bad_shape() -> None:
    shared = MagicMock()
    shared.get_assigned_style_guide.return_value = None
    with patch("app.breaking_publish_guardrail.db", shared):
        assert resolve_breaking_publish_policy("t1") == DEFAULT_BREAKING_PUBLISH_POLICY

    shared.get_assigned_style_guide.return_value = ["not", "a", "dict"]
    with patch("app.breaking_publish_guardrail.db", shared):
        assert resolve_breaking_publish_policy("t1") == DEFAULT_BREAKING_PUBLISH_POLICY


def test_resolve_policy_degrades_to_warn_on_db_fault() -> None:
    shared = MagicMock()
    shared.get_assigned_style_guide.side_effect = RuntimeError("connection reset")
    with patch("app.breaking_publish_guardrail.db", shared):
        assert resolve_breaking_publish_policy("t1", "pid-1") == DEFAULT_BREAKING_PUBLISH_POLICY


# ===========================================================================
# Assessment
# ===========================================================================


def test_policy_off_short_circuits_without_touching_the_db() -> None:
    shared = MagicMock()
    with patch("app.breaking_publish_guardrail.db", shared):
        assessment = assess_breaking_publish(
            tenant_slug="acme",
            tenant_id="t1",
            project_id="pid-1",
            head_version=_head_row(),
            head_spec=copy.deepcopy(_BASE_SPEC),
            policy="off",
        )
    assert assessment.status == STATUS_DISABLED
    assert assessment.triggered is False
    assert assessment.blocked is False
    shared.get_prior_published_baseline_revision_id.assert_not_called()


def test_initial_publication_has_no_baseline() -> None:
    assessment = _assess(shared=_db_for(None))
    assert assessment.status == STATUS_NO_BASELINE
    assert assessment.triggered is False


def test_non_breaking_publish_sees_no_friction() -> None:
    assessment = _assess()
    assert assessment.status == STATUS_OK
    assert assessment.breaking is False
    assert assessment.triggered is False
    assert assessment.from_version == "1.0.0"
    assert assessment.to_version == "1.1.0"


def test_breaking_with_major_bump_sees_no_friction() -> None:
    assessment = _assess(head_label="2.0.0", head_spec=_breaking_head_spec())
    assert assessment.breaking is True
    assert assessment.major_bumped is True
    assert assessment.status == STATUS_OK
    assert assessment.triggered is False


def test_breaking_without_major_bump_warns_under_warn_policy() -> None:
    assessment = _assess(head_spec=_breaking_head_spec(), policy="warn")
    assert assessment.status == STATUS_WARNING
    assert assessment.triggered is True
    assert assessment.blocked is False
    assert assessment.breaking is True
    assert assessment.major_bumped is False
    assert assessment.breaking_count >= 1
    assert assessment.breaking_changes
    assert set(assessment.breaking_changes[0]) == {"pointer", "ruleId", "pathGroup", "summary"}
    assert assessment.recommended_version == "2.0.0"
    assert "without a major-version bump" in assessment.message()


def test_breaking_without_major_bump_blocks_under_block_policy() -> None:
    assessment = _assess(head_spec=_breaking_head_spec(), policy="block")
    assert assessment.status == STATUS_BLOCKED
    assert assessment.blocked is True
    assert assessment.triggered is True


def test_non_semver_labels_warn_but_never_block() -> None:
    assessment = _assess(
        head_label="spring-2026",
        base_label="winter-2025",
        head_spec=_breaking_head_spec(),
        policy="block",
    )
    assert assessment.major_bumped is None
    assert assessment.status == STATUS_WARNING
    assert assessment.blocked is False
    assert assessment.detail == "version-labels-not-semver"
    assert "not semver" in assessment.message()


def test_missing_baseline_row_is_unavailable_not_a_block() -> None:
    shared = MagicMock()
    shared.get_prior_published_baseline_revision_id.return_value = "base-1"
    shared.get_version_by_id.return_value = None
    assessment = _assess(shared=shared, policy="block")
    assert assessment.status == STATUS_UNAVAILABLE
    assert assessment.blocked is False
    assert "Baseline revision not found" in (assessment.detail or "")


def test_spec_build_fault_is_unavailable_not_a_block() -> None:
    shared = _db_for(_baseline_row())

    def _explode(*_args, **_kwargs):
        raise RuntimeError("schema validation failed")

    with patch("app.breaking_publish_guardrail.db", shared):
        assessment = assess_breaking_publish(
            tenant_slug="acme",
            tenant_id="t1",
            project_id="pid-1",
            head_version=_head_row(),
            head_spec=copy.deepcopy(_BASE_SPEC),
            policy="block",
            openapi_loader=_explode,
        )
    assert assessment.status == STATUS_UNAVAILABLE
    assert assessment.blocked is False
    assert "schema validation failed" in (assessment.detail or "")


def test_listed_breaking_changes_are_capped_and_marked_truncated() -> None:
    base = copy.deepcopy(_BASE_SPEC)
    base["paths"] = {
        f"/resource-{i}": {"get": {"responses": {"200": {"description": "ok"}}}}
        for i in range(MAX_LISTED_BREAKING_CHANGES + 5)
    }
    shared = _db_for(_baseline_row())
    with patch("app.breaking_publish_guardrail.db", shared):
        assessment = assess_breaking_publish(
            tenant_slug="acme",
            tenant_id="t1",
            project_id="pid-1",
            head_version=_head_row("1.1.0"),
            head_spec={**copy.deepcopy(_BASE_SPEC), "paths": {}},
            policy="warn",
            openapi_loader=lambda *_a, **_k: copy.deepcopy(base),
        )
    assert assessment.breaking_count > MAX_LISTED_BREAKING_CHANGES
    assert len(assessment.breaking_changes) == MAX_LISTED_BREAKING_CHANGES
    assert assessment.truncated is True
    assert assessment.as_payload()["truncated"] is True


def test_payload_is_camel_case_and_complete() -> None:
    payload = _assess(head_spec=_breaking_head_spec(), policy="block").as_payload()
    assert payload["policy"] == "block"
    assert payload["status"] == STATUS_BLOCKED
    assert payload["blocked"] is True
    assert payload["majorBumped"] is False
    assert payload["fromVersion"] == "1.0.0"
    assert payload["toVersion"] == "1.1.0"
    assert payload["baselineRevisionId"] == "base-1"
    assert payload["recommendedVersion"] == "2.0.0"
    assert payload["breakingCount"] >= 1
    assert payload["counts"]["breaking"] >= 1
    assert payload["maxSeverity"] == "breaking"
    assert payload["message"]


# ===========================================================================
# Publish flow integration
# ===========================================================================


_PUBLISHED_ROW = {
    "id": "vid-1",
    "project_id": "pid-1",
    "creator_id": "user-a",
    "version_id": "1.1.0",
    "short_message": None,
    "changelog": None,
    "visibility": "private",
    "published": True,
    "published_at": datetime(2026, 1, 2, 12, 0, 0, tzinfo=timezone.utc),
    "published_immutable": True,
    "enabled": True,
    "parent_version_id": None,
    "merge_parent_version_id": None,
    "forked_from_revision_id": None,
    "upstream_project_id": None,
    "revision_locked": False,
    "metadata": None,
    "creator_name": None,
    "creator_email": None,
    "project_name": "P",
    "project_slug": "p",
    "created_at": None,
    "updated_at": None,
}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _publish_db(policy: str) -> MagicMock:
    """A db double wired for the publish route: clean prechecks, one published baseline."""
    shared = MagicMock()

    def gv(vid: str, _tid: str):
        if str(vid) == "vid-1":
            return _head_row()
        if str(vid) == "base-1":
            return _baseline_row()
        return None

    shared.get_version_by_id.side_effect = gv
    shared.get_classes_for_version.return_value = [{"name": "Pet", "description": "Animal"}]
    shared.get_project_by_id.return_value = {"id": "pid-1", "slug": "pay", "metadata": {}}
    shared.get_prior_published_baseline_revision_id.return_value = "base-1"
    shared.get_assigned_style_guide.return_value = {
        "id": "g1",
        "name": "Payments",
        "source": "custom",
        "breaking_publish_policy": policy,
    }
    shared.publish_version.return_value = dict(_PUBLISHED_ROW)
    return shared


def _load_spec(row, *_args, **_kwargs) -> Dict[str, Any]:
    """Materialize the baseline spec for the baseline row and the breaking head otherwise."""
    return (
        copy.deepcopy(_BASE_SPEC)
        if str(row.get("id")) == "base-1"
        else _breaking_head_spec()
    )


def _publish(shared: MagicMock, body: Dict[str, Any]):
    """POST the publish endpoint with the guardrail's collaborators stubbed."""
    with patch("app.versions_routes.db", shared), patch(
        "app.version_publish_prechecks.db", shared
    ), patch("app.breaking_publish_guardrail.db", shared), patch(
        "app.publication_change_report.db", shared
    ), patch(
        "app.version_publish_prechecks.openapi_for_revision",
        side_effect=_load_spec,
    ), patch(
        # The force path assesses after publish, so it uses the guardrail's own loader.
        "app.breaking_publish_guardrail.openapi_for_revision",
        side_effect=_load_spec,
    ), patch(
        "app.version_publish_prechecks.CompatibilityCheckEngine.run"
    ) as compat_run, patch(
        "app.version_publish_prechecks.evaluate_and_record",
        side_effect=RuntimeError("policy not configured"),
    ):
        compat_run.return_value.overall = "non-breaking"
        return client.post("/v1/versions/acme/pid-1/vid-1/publish", json=body)


def _guardrail_audits(shared: MagicMock) -> list:
    """Every ``version.breaking_publish_guardrail`` audit write recorded on the double."""
    return [
        call.args
        for call in shared.insert_workflow_audit.call_args_list
        if len(call.args) > 3 and call.args[3] == "version.breaking_publish_guardrail"
    ]


def test_publish_is_blocked_when_policy_blocks_a_non_major_breaking_change() -> None:
    shared = _publish_db("block")
    res = _publish(shared, {"shortMessage": "Drop the owners endpoint", "allowBreaking": True})

    assert res.status_code == 422
    detail = res.json()["detail"]
    guardrail = detail["breakingPublishGuardrail"]
    assert guardrail["status"] == "blocked"
    assert guardrail["blocked"] is True
    assert guardrail["breakingCount"] >= 1
    assert guardrail["recommendedVersion"] == "2.0.0"
    assert "force-publish with a reason" in detail["message"]
    shared.publish_version.assert_not_called()


def test_publish_proceeds_and_audits_under_the_warn_policy() -> None:
    shared = _publish_db("warn")
    res = _publish(shared, {"shortMessage": "Drop the owners endpoint", "allowBreaking": True})

    assert res.status_code == 200
    shared.publish_version.assert_called_once()
    audits = _guardrail_audits(shared)
    assert len(audits) == 1
    detail = audits[0][6]
    assert detail["action"] == "warned"
    assert detail["reason"] is None
    assert detail["guardrail"]["status"] == "warning"


def test_force_publish_gets_past_the_block_and_is_audited() -> None:
    shared = _publish_db("block")
    res = _publish(
        shared,
        {
            "shortMessage": "Emergency rollback of the owners endpoint",
            "skipPublishChecks": True,
            "forcePublishReason": "Incident 4478 — consumers already migrated",
        },
    )

    assert res.status_code == 200
    shared.publish_version.assert_called_once()
    audits = _guardrail_audits(shared)
    assert len(audits) == 1
    detail = audits[0][6]
    assert detail["action"] == "forced"
    assert detail["reason"] == "Incident 4478 — consumers already migrated"
    assert detail["guardrail"]["blocked"] is True
    assert detail["guardrail"]["breakingCount"] >= 1


def test_clean_publish_records_no_guardrail_audit() -> None:
    shared = _publish_db("block")
    with patch("app.versions_routes.db", shared), patch(
        "app.version_publish_prechecks.db", shared
    ), patch("app.breaking_publish_guardrail.db", shared), patch(
        "app.publication_change_report.db", shared
    ), patch(
        "app.version_publish_prechecks.openapi_for_revision",
        return_value=copy.deepcopy(_BASE_SPEC),
    ), patch(
        "app.version_publish_prechecks.CompatibilityCheckEngine.run"
    ) as compat_run, patch(
        "app.version_publish_prechecks.evaluate_and_record",
        side_effect=RuntimeError("policy not configured"),
    ):
        compat_run.return_value.overall = "non-breaking"
        res = client.post(
            "/v1/versions/acme/pid-1/vid-1/publish",
            json={"shortMessage": "Docs only"},
        )

    assert res.status_code == 200
    assert _guardrail_audits(shared) == []


# ===========================================================================
# Preflight endpoint
# ===========================================================================


def test_preflight_endpoint_returns_the_assessment() -> None:
    shared = _publish_db("block")
    with patch("app.versions_routes.db", shared), patch(
        "app.breaking_publish_guardrail.db", shared
    ), patch(
        "app.breaking_publish_guardrail.openapi_for_revision",
        side_effect=lambda row, *_a, **_k: (
            copy.deepcopy(_BASE_SPEC)
            if str(row.get("id")) == "base-1"
            else _breaking_head_spec()
        ),
    ):
        res = client.get("/v1/versions/acme/pid-1/vid-1/breaking-publish-guardrail")

    assert res.status_code == 200
    body = res.json()
    assert body["policy"] == "block"
    assert body["status"] == "blocked"
    assert body["triggered"] is True
    assert body["majorBumped"] is False
    assert body["breakingChanges"][0]["ruleId"]
    assert body["message"]


def test_preflight_endpoint_404s_for_another_projects_revision() -> None:
    shared = MagicMock()
    shared.get_version_by_id.return_value = {"id": "vid-1", "project_id": "other-project"}
    with patch("app.versions_routes.db", shared):
        res = client.get("/v1/versions/acme/pid-1/vid-1/breaking-publish-guardrail")
    assert res.status_code == 404


def test_preflight_endpoint_degrades_instead_of_erroring() -> None:
    shared = MagicMock()
    shared.get_version_by_id.return_value = _head_row()
    shared.get_assigned_style_guide.return_value = {
        "id": "g1",
        "name": "G",
        "source": "custom",
        "breaking_publish_policy": "block",
    }
    shared.get_prior_published_baseline_revision_id.side_effect = RuntimeError("db down")
    with patch("app.versions_routes.db", shared), patch(
        "app.breaking_publish_guardrail.db", shared
    ):
        res = client.get("/v1/versions/acme/pid-1/vid-1/breaking-publish-guardrail")

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "unavailable"
    assert body["blocked"] is False
