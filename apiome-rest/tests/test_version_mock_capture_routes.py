"""Guarded proxy capture REST route tests (#4747, PMR-2.4).

Covers the authoring surface end to end: granting and revoking capture, reading the review queue,
approving or rejecting recorded exchanges, and publishing approved ones into a fixture pack — plus
the two rules that keep provenance honest (the authorization block is server-stamped, and capture
provenance cannot be typed by hand into the fixture-pack editor).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from unittest.mock import patch

import pytest
from app.auth import validate_authentication
from app.main import app
from app.mock_capture import (
    CAPTURE_POLICY_FORMAT,
    MAX_AUTHORIZATION_HOURS,
    authorization_block,
    capture_policy_to_storage,
)
from fastapi.testclient import TestClient

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
CAPTURE_ID = "11111111-1111-4111-8111-111111111111"
UPSTREAM = "https://api.example.com/v1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}

BASE = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock"
POLICY_URL = f"{BASE}/capture-policy"
CAPTURES_URL = f"{BASE}/captures"

NOW = datetime.now(timezone.utc)
LIVE_POLICY = capture_policy_to_storage(
    {
        "enabled": True,
        "upstreams": [UPSTREAM],
        "authorization": authorization_block(authorized_by=USER_ID, now=NOW, ttl_hours=24),
        "redaction": {"headers": ["X-Internal-Trace"]},
    }
)


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_settings: Dict[str, Any] | None = None) -> Dict[str, Any]:
    return {
        "id": VERSION_ID,
        "project_id": PROJECT_ID,
        "creator_id": USER_ID,
        "version_id": "1.0.0",
        "published": True,
        "mock_enabled": True,
        "mock_settings": mock_settings if mock_settings is not None else {},
        "project_slug": "petstore",
        "metadata": None,
    }


def _capture_row(**overrides: Any) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "id": CAPTURE_ID,
        "upstream": f"{UPSTREAM}/pets/7",
        "allowlist_entry": UPSTREAM,
        "policy_digest": "sha256:abc",
        "captured_at": NOW,
        "captured_by": None,
        "operation_key": "GET /pets/{petId}",
        "request_method": "GET",
        "request_path": "/pets/7",
        "status_code": 200,
        "exchange": {
            "captureFormat": "apiome.mock.capture/v1",
            "captureFormatVersion": 1,
            "provenance": {
                "tenant": TENANT,
                "project": "petstore",
                "version": "1.0.0",
                "upstream": f"{UPSTREAM}/pets/7",
                "allowlistEntry": UPSTREAM,
                "policyDigest": "sha256:abc",
                "capturedAt": "2026-08-26T18:00:00Z",
                "pathTemplate": "/pets/{petId}",
            },
            "request": {"method": "GET", "path": "/pets/7", "query": [], "headers": {}, "body": None},
            "response": {"status": 200, "headers": {}, "body": {"id": 7, "name": "Rex"}},
            "redaction": {"clean": False, "count": 1, "decisions": []},
            "validation": {"checked": True, "valid": True, "errors": []},
        },
        "exchange_digest": "sha256:def",
        "redactions": [
            {"pointer": "/request/headers/authorization", "rule": "always-header", "reason": "Credential."}
        ],
        "redaction_count": 1,
        "schema_valid": True,
        "validation_errors": [],
        "review_state": "approved",
        "reviewed_by": USER_ID,
        "reviewed_at": NOW,
        "review_note": None,
        "published_pack": None,
        "expires_at": NOW + timedelta(days=7),
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# Capture policy
# ---------------------------------------------------------------------------


class TestGetCapturePolicy:
    def test_unconfigured_version_reports_unconfigured(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
        ):
            response = client.get(POLICY_URL)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["policy"] is None
        assert body["state"] == "unconfigured"

    def test_a_live_grant_is_reported_with_its_digest_and_counts(self, client: TestClient) -> None:
        with (
            patch(
                "app.versions_routes.db.get_version_by_id",
                return_value=_version_row(mock_settings={"proxyCapture": LIVE_POLICY}),
            ),
            patch("app.versions_routes.enforce_permission"),
            patch(
                "app.versions_routes.db.count_mock_capture_exchanges",
                return_value={"pending": 3, "approved": 1},
            ),
        ):
            response = client.get(POLICY_URL)
        body = response.json()
        assert body["state"] == "authorized"
        assert body["policy"]["upstreams"] == [UPSTREAM]
        assert body["policy"]["policyFormat"] == CAPTURE_POLICY_FORMAT
        assert body["digest"].startswith("sha256:")
        assert body["captures"] == {"pending": 3, "approved": 1}

    def test_an_expired_grant_reports_expired(self, client: TestClient) -> None:
        stale = capture_policy_to_storage(
            {
                "enabled": True,
                "upstreams": [UPSTREAM],
                "authorization": authorization_block(
                    authorized_by=USER_ID, now=NOW - timedelta(days=3), ttl_hours=1
                ),
            }
        )
        with (
            patch(
                "app.versions_routes.db.get_version_by_id",
                return_value=_version_row(mock_settings={"proxyCapture": stale}),
            ),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
        ):
            response = client.get(POLICY_URL)
        assert response.json()["state"] == "expired"

    def test_a_malformed_stored_policy_never_breaks_the_editor(self, client: TestClient) -> None:
        with (
            patch(
                "app.versions_routes.db.get_version_by_id",
                return_value=_version_row(mock_settings={"proxyCapture": {"enabled": "yes"}}),
            ),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
        ):
            response = client.get(POLICY_URL)
        assert response.status_code == 200
        assert response.json()["state"] in {"disabled", "unconfigured", "no-upstreams"}


class TestSetCapturePolicy:
    def _put(self, client: TestClient, payload: Dict[str, Any], *, owner: bool = True):
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=owner),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
            patch(
                "app.versions_routes.db.set_version_mock_capture_policy",
                return_value=_version_row(mock_settings={"proxyCapture": LIVE_POLICY}),
            ) as setter,
        ):
            response = client.put(POLICY_URL, json=payload)
        return response, setter

    def test_a_grant_stamps_the_authorization_server_side(self, client: TestClient) -> None:
        response, setter = self._put(
            client, {"upstreams": [UPSTREAM], "acknowledged": True, "ttlHours": 12}
        )
        assert response.status_code == 200, response.text
        stored = setter.call_args.kwargs["policy"]
        assert stored["authorization"]["authorizedBy"] == USER_ID
        assert stored["upstreams"] == [UPSTREAM]
        assert response.json()["state"] == "authorized"

    def test_a_client_supplied_authorization_is_ignored(self, client: TestClient) -> None:
        _, setter = self._put(
            client,
            {
                "upstreams": [UPSTREAM],
                "acknowledged": True,
                "authorization": {"authorizedBy": "somebody-else"},
            },
        )
        stored = setter.call_args.kwargs["policy"]
        assert stored["authorization"]["authorizedBy"] == USER_ID

    def test_capture_cannot_be_granted_without_acknowledgement(self, client: TestClient) -> None:
        response, setter = self._put(client, {"upstreams": [UPSTREAM]})
        assert response.status_code == 422
        assert "acknowledged" in str(response.json()["detail"])
        setter.assert_not_called()

    def test_switching_capture_off_needs_no_acknowledgement(self, client: TestClient) -> None:
        response, setter = self._put(client, {"enabled": False, "upstreams": [UPSTREAM]})
        assert response.status_code == 200, response.text
        assert setter.call_args.kwargs["policy"]["enabled"] is False

    def test_an_unsafe_upstream_is_rejected(self, client: TestClient) -> None:
        response, setter = self._put(
            client, {"upstreams": ["http://user:pass@internal/"], "acknowledged": True}
        )
        assert response.status_code == 422
        assert "errors" in response.json()["detail"]
        setter.assert_not_called()

    def test_no_upstreams_is_rejected(self, client: TestClient) -> None:
        response, setter = self._put(client, {"upstreams": [], "acknowledged": True})
        assert response.status_code == 422
        setter.assert_not_called()

    def test_an_over_long_lifetime_is_rejected(self, client: TestClient) -> None:
        response, setter = self._put(
            client,
            {"upstreams": [UPSTREAM], "acknowledged": True, "ttlHours": MAX_AUTHORIZATION_HOURS + 1},
        )
        assert response.status_code == 422
        setter.assert_not_called()

    def test_a_non_owner_cannot_grant_capture(self, client: TestClient) -> None:
        response, setter = self._put(
            client, {"upstreams": [UPSTREAM], "acknowledged": True}, owner=False
        )
        assert response.status_code == 403
        setter.assert_not_called()

    def test_revoking_removes_the_policy_and_keeps_the_captures(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=True),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={"pending": 2}),
            patch(
                "app.versions_routes.db.set_version_mock_capture_policy",
                return_value=_version_row(),
            ) as setter,
            patch("app.versions_routes.db.delete_mock_capture_exchanges") as deleter,
        ):
            response = client.delete(POLICY_URL)
        assert response.status_code == 200, response.text
        assert setter.call_args.kwargs["policy"] is None
        assert response.json()["captures"] == {"pending": 2}
        deleter.assert_not_called()


# ---------------------------------------------------------------------------
# Review queue
# ---------------------------------------------------------------------------


class TestListCaptures:
    def test_the_queue_reports_redaction_decisions_and_provenance(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch(
                "app.versions_routes.db.list_mock_capture_exchanges",
                return_value=[_capture_row(review_state="pending")],
            ),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={"pending": 1}),
        ):
            response = client.get(CAPTURES_URL)
        assert response.status_code == 200, response.text
        capture = response.json()["captures"][0]
        assert capture["upstream"] == f"{UPSTREAM}/pets/7"
        assert capture["allowlistEntry"] == UPSTREAM
        assert capture["redactionCount"] == 1
        assert capture["redactions"][0]["rule"] == "always-header"
        assert capture["reviewState"] == "pending"
        assert capture["exchange"] is None

    def test_the_full_document_is_opt_in(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch(
                "app.versions_routes.db.list_mock_capture_exchanges", return_value=[_capture_row()]
            ),
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
        ):
            response = client.get(CAPTURES_URL, params={"includeExchange": "true"})
        assert response.json()["captures"][0]["exchange"]["captureFormat"] == "apiome.mock.capture/v1"

    def test_the_state_filter_reaches_the_query(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch(
                "app.versions_routes.db.list_mock_capture_exchanges", return_value=[]
            ) as lister,
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
        ):
            client.get(CAPTURES_URL, params={"state": "approved", "limit": 5})
        assert lister.call_args.kwargs["review_state"] == "approved"
        assert lister.call_args.kwargs["limit"] == 5

    def test_an_unknown_state_is_rejected(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
        ):
            response = client.get(CAPTURES_URL, params={"state": "maybe"})
        assert response.status_code == 422


class TestReviewCaptures:
    def _review(self, client: TestClient, payload: Dict[str, Any], *, owner: bool = True):
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=owner),
            patch(
                "app.versions_routes.db.review_mock_capture_exchanges", return_value=[CAPTURE_ID]
            ) as reviewer,
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={"approved": 1}),
        ):
            response = client.post(f"{CAPTURES_URL}/review", json=payload)
        return response, reviewer

    def test_approving_records_the_decision_and_the_reviewer(self, client: TestClient) -> None:
        response, reviewer = self._review(
            client, {"captureIds": [CAPTURE_ID], "decision": "approve", "note": "looks right"}
        )
        assert response.status_code == 200, response.text
        assert reviewer.call_args.kwargs["review_state"] == "approved"
        assert reviewer.call_args.kwargs["note"] == "looks right"
        assert reviewer.call_args.args[2] == USER_ID
        assert response.json()["reviewed"] == [CAPTURE_ID]

    def test_rejecting_maps_to_the_rejected_state(self, client: TestClient) -> None:
        _, reviewer = self._review(client, {"captureIds": [CAPTURE_ID], "decision": "reject"})
        assert reviewer.call_args.kwargs["review_state"] == "rejected"

    def test_an_empty_id_list_is_rejected(self, client: TestClient) -> None:
        response, reviewer = self._review(client, {"captureIds": [], "decision": "approve"})
        assert response.status_code == 422
        reviewer.assert_not_called()

    def test_an_unknown_decision_is_rejected(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
        ):
            response = client.post(
                f"{CAPTURES_URL}/review", json={"captureIds": [CAPTURE_ID], "decision": "maybe"}
            )
        assert response.status_code == 422

    def test_a_non_owner_cannot_review(self, client: TestClient) -> None:
        response, reviewer = self._review(
            client, {"captureIds": [CAPTURE_ID], "decision": "approve"}, owner=False
        )
        assert response.status_code == 403
        reviewer.assert_not_called()


class TestPublishCaptures:
    def _publish(
        self,
        client: TestClient,
        payload: Dict[str, Any],
        *,
        approved: list | None = None,
        owner: bool = True,
    ):
        rows = [_capture_row()] if approved is None else approved
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=owner),
            patch("app.versions_routes.db.list_mock_capture_exchanges", return_value=rows),
            patch(
                "app.versions_routes.db.set_version_mock_fixture_packs",
                return_value=_version_row(),
            ) as setter,
            patch(
                "app.versions_routes.db.mark_mock_captures_published", return_value=[CAPTURE_ID]
            ) as marker,
        ):
            response = client.post(f"{CAPTURES_URL}/publish", json=payload)
        return response, setter, marker

    def test_publishing_writes_a_provenance_stamped_pack(self, client: TestClient) -> None:
        response, setter, marker = self._publish(
            client, {"packName": "from-staging", "description": "Recorded pets."}
        )
        assert response.status_code == 200, response.text
        stored = setter.call_args.kwargs["packs"]["from-staging"]
        assert stored["packFormatVersion"] == 2
        assert stored["provenance"] == {
            "source": "capture",
            "capturedFrom": [UPSTREAM],
            "captures": 1,
            "redactions": 1,
            "approvedBy": USER_ID,
            "approvedAt": stored["provenance"]["approvedAt"],
        }
        assert stored["collections"] == {"/pets": [{"id": 7, "name": "Rex"}]}
        body = response.json()
        assert body["packName"] == "from-staging"
        assert body["digest"].startswith("sha256:")
        assert body["provenance"]["source"] == "capture"
        marker.assert_called_once()

    def test_only_approved_captures_are_read(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=True),
            patch(
                "app.versions_routes.db.list_mock_capture_exchanges", return_value=[_capture_row()]
            ) as lister,
            patch(
                "app.versions_routes.db.set_version_mock_fixture_packs", return_value=_version_row()
            ),
            patch("app.versions_routes.db.mark_mock_captures_published", return_value=[]),
        ):
            client.post(f"{CAPTURES_URL}/publish", json={"packName": "p"})
        assert lister.call_args.kwargs["review_state"] == "approved"

    def test_nothing_approved_is_a_conflict(self, client: TestClient) -> None:
        response, setter, marker = self._publish(client, {"packName": "p"}, approved=[])
        assert response.status_code == 409
        setter.assert_not_called()
        marker.assert_not_called()

    def test_naming_captures_narrows_the_publication(self, client: TestClient) -> None:
        other = _capture_row(id="22222222-2222-4222-8222-222222222222")
        response, setter, _ = self._publish(
            client,
            {"packName": "p", "captureIds": [CAPTURE_ID]},
            approved=[_capture_row(), other],
        )
        assert response.status_code == 200, response.text
        assert setter.call_args.kwargs["packs"]["p"]["provenance"]["captures"] == 1

    def test_an_invalid_pack_name_is_rejected(self, client: TestClient) -> None:
        response, setter, _ = self._publish(client, {"packName": "not a name!"})
        assert response.status_code == 422
        setter.assert_not_called()

    def test_a_non_owner_cannot_publish(self, client: TestClient) -> None:
        response, setter, _ = self._publish(client, {"packName": "p"}, owner=False)
        assert response.status_code == 403
        setter.assert_not_called()

    def test_captures_are_marked_published_only_after_the_pack_is_written(
        self, client: TestClient
    ) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=True),
            patch(
                "app.versions_routes.db.list_mock_capture_exchanges", return_value=[_capture_row()]
            ),
            patch("app.versions_routes.db.set_version_mock_fixture_packs", return_value=None),
            patch("app.versions_routes.db.mark_mock_captures_published") as marker,
        ):
            response = client.post(f"{CAPTURES_URL}/publish", json={"packName": "p"})
        assert response.status_code == 403
        marker.assert_not_called()


class TestDeleteCaptures:
    def test_discarding_removes_the_rows(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=True),
            patch("app.versions_routes.db.delete_mock_capture_exchanges", return_value=4) as deleter,
            patch("app.versions_routes.db.count_mock_capture_exchanges", return_value={}),
        ):
            response = client.delete(CAPTURES_URL, params={"state": "rejected"})
        assert response.status_code == 200, response.text
        assert response.json()["deleted"] == 4
        assert deleter.call_args.kwargs["review_state"] == "rejected"

    def test_a_non_owner_cannot_discard(self, client: TestClient) -> None:
        with (
            patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
            patch("app.versions_routes.enforce_permission"),
            patch("app.versions_routes.db.user_owns_version_mock_settings", return_value=False),
            patch("app.versions_routes.db.delete_mock_capture_exchanges") as deleter,
        ):
            response = client.delete(CAPTURES_URL)
        assert response.status_code == 403
        deleter.assert_not_called()


# ---------------------------------------------------------------------------
# Provenance cannot be forged through the fixture-pack editor
# ---------------------------------------------------------------------------


class TestFixturePackProvenanceGuard:
    URL = f"{BASE}/fixture-packs"

    CAPTURED_PACK = {
        "packFormat": "apiome.mock.fixture-pack/v1",
        "packFormatVersion": 2,
        "collections": {"/pets": [{"id": 7, "name": "Rex"}]},
        "provenance": {
            "source": "capture",
            "capturedFrom": [UPSTREAM],
            "captures": 1,
            "redactions": 1,
            "approvedBy": USER_ID,
            "approvedAt": "2026-08-26T19:00:00Z",
        },
    }

    def _put(self, client: TestClient, packs: Dict[str, Any], *, stored: Dict[str, Any] | None = None):
        settings = {"fixturePacks": stored} if stored else {}
        with (
            patch(
                "app.versions_routes.db.get_version_by_id",
                return_value=_version_row(mock_settings=settings),
            ),
            patch("app.versions_routes.enforce_permission"),
            patch(
                "app.versions_routes.db.set_version_mock_fixture_packs",
                return_value=_version_row(mock_settings=settings),
            ) as setter,
        ):
            response = client.put(self.URL, json={"packs": packs})
        return response, setter

    def test_hand_written_capture_provenance_is_refused(self, client: TestClient) -> None:
        response, setter = self._put(client, {"faked": self.CAPTURED_PACK})
        assert response.status_code == 422
        assert "cannot be set by hand" in str(response.json()["detail"])
        setter.assert_not_called()

    def test_editing_a_captured_pack_keeps_its_provenance(self, client: TestClient) -> None:
        stored = {"from-staging": self.CAPTURED_PACK}
        edited = {**self.CAPTURED_PACK, "description": "Renamed."}
        response, setter = self._put(client, {"from-staging": edited}, stored=stored)
        assert response.status_code == 200, response.text
        assert setter.call_args.kwargs["packs"]["from-staging"]["provenance"]["source"] == "capture"

    def test_an_authored_pack_is_unaffected(self, client: TestClient) -> None:
        response, setter = self._put(client, {"smoke": {"collections": {"/pets": [{"id": 1}]}}})
        assert response.status_code == 200, response.text
        setter.assert_called_once()
