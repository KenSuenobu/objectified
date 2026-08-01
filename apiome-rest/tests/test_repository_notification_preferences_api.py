"""The notification-preferences REST surface (REPO-7.2, #2800).

``GET``/``PUT /v1/tenants/{slug}/repositories/{id}/notification-preferences`` is the operator
surface for the per-repository, per-event-type opt-out. These tests pin what it puts on the
wire and — more importantly — what it refuses: an opt-out that quietly did nothing is the one
failure an operator would not notice until the pager went off.
"""

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.repository_event_notifications import (
    ALL_EVENT_TYPES,
    DEFAULT_THROTTLE_WINDOW_SECONDS,
    RepositoryNotificationEvent,
)

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}

_URL = f"/v1/tenants/acme/repositories/{_REPO_ID}/notification-preferences"
_AUTO_PAUSED = RepositoryNotificationEvent.AUTO_PAUSED.value
_BREAKING = RepositoryNotificationEvent.BREAKING_CHANGE.value


@pytest.fixture(autouse=True)
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _call(
    method: str,
    *,
    repository: Any = "default",
    preferences: Optional[List[Dict[str, Any]]] = None,
    throttle: Optional[List[Dict[str, Any]]] = None,
    stored: Any = "default",
    json_body: Optional[Dict[str, Any]] = None,
):
    """Drive one endpoint against a mocked database, returning (response, db mock)."""
    with patch("app.tenant_repositories_routes.db") as db, patch(
        "app.tenant_repositories_routes.enforce_permission"
    ):
        db.get_tenant_repository.return_value = (
            {"id": _REPO_ID} if repository == "default" else repository
        )
        db.list_repository_notification_preferences.return_value = preferences or []
        db.get_repository_notification_throttle.return_value = throttle or []
        db.set_repository_notification_preference.return_value = (
            {"event_type": _AUTO_PAUSED, "enabled": False}
            if stored == "default"
            else stored
        )
        response = getattr(client, method)(_URL, **({"json": json_body} if json_body else {}))
    return response, db


# --- reading -----------------------------------------------------------------------------


def test_the_read_reports_every_event_not_just_the_ones_already_configured() -> None:
    """An operator deciding what to mute needs the full list; the stored rows are exceptions."""
    response, _ = _call("get")
    assert response.status_code == 200
    body = response.json()
    assert [p["eventType"] for p in body["preferences"]] == ALL_EVENT_TYPES
    assert all(p["enabled"] for p in body["preferences"])


def test_the_read_names_the_throttle_window_being_enforced() -> None:
    response, _ = _call("get")
    assert response.json()["throttleWindowSeconds"] == DEFAULT_THROTTLE_WINDOW_SECONDS


def test_every_event_arrives_with_an_explanation_of_what_muting_it_costs() -> None:
    response, _ = _call("get")
    assert all(p["description"].strip() for p in response.json()["preferences"])


def test_a_stored_opt_out_is_reported_as_muted() -> None:
    response, _ = _call(
        "get",
        preferences=[
            {
                "event_type": _AUTO_PAUSED,
                "enabled": False,
                "updated_at": "2026-07-31T10:00:00Z",
            }
        ],
    )
    by_event = {p["eventType"]: p for p in response.json()["preferences"]}
    assert by_event[_AUTO_PAUSED]["enabled"] is False
    assert by_event[_AUTO_PAUSED]["updatedAt"] == "2026-07-31T10:00:00Z"
    assert by_event[_BREAKING]["enabled"] is True


def test_the_read_shows_what_the_throttle_has_been_swallowing() -> None:
    """"We have not heard from this repository" and "we have muffled it 41 times" are very
    different situations to be told about."""
    response, _ = _call(
        "get",
        throttle=[
            {
                "event_type": _AUTO_PAUSED,
                "last_notified_at": "2026-07-31T10:00:00Z",
                "suppressed_count": 41,
            }
        ],
    )
    by_event = {p["eventType"]: p for p in response.json()["preferences"]}
    assert by_event[_AUTO_PAUSED]["lastNotifiedAt"] == "2026-07-31T10:00:00Z"
    assert by_event[_AUTO_PAUSED]["suppressedCount"] == 41
    assert by_event[_BREAKING]["suppressedCount"] == 0


def test_reading_another_tenants_repository_is_a_404() -> None:
    response, _ = _call("get", repository=None)
    assert response.status_code == 404


def test_the_read_is_scoped_to_the_token_not_the_path() -> None:
    _, db = _call("get")
    db.get_tenant_repository.assert_called_once_with(_TENANT_ID, _REPO_ID)
    db.list_repository_notification_preferences.assert_called_once_with(
        _TENANT_ID, _REPO_ID
    )


# --- writing -----------------------------------------------------------------------------


def test_muting_an_event_is_persisted_and_reflected_back() -> None:
    response, db = _call(
        "put",
        json_body={"preferences": [{"eventType": _AUTO_PAUSED, "enabled": False}]},
        preferences=[{"event_type": _AUTO_PAUSED, "enabled": False}],
    )
    assert response.status_code == 200
    db.set_repository_notification_preference.assert_called_once_with(
        _TENANT_ID, _REPO_ID, _AUTO_PAUSED, False
    )
    by_event = {p["eventType"]: p for p in response.json()["preferences"]}
    assert by_event[_AUTO_PAUSED]["enabled"] is False


def test_an_update_leaves_events_it_did_not_mention_alone() -> None:
    """A client rendering fewer events than the server knows about must not reset the rest."""
    _, db = _call(
        "put", json_body={"preferences": [{"eventType": _AUTO_PAUSED, "enabled": False}]}
    )
    written = {
        call.args[2] for call in db.set_repository_notification_preference.call_args_list
    }
    assert written == {_AUTO_PAUSED}


def test_several_events_can_be_changed_in_one_request() -> None:
    _, db = _call(
        "put",
        json_body={
            "preferences": [
                {"eventType": _AUTO_PAUSED, "enabled": False},
                {"eventType": _BREAKING, "enabled": True},
            ]
        },
    )
    assert db.set_repository_notification_preference.call_count == 2


def test_an_unknown_event_type_is_rejected_rather_than_silently_ignored() -> None:
    """Accepting it would hand back a 200 for an opt-out that mutes nothing."""
    response, db = _call(
        "put",
        json_body={"preferences": [{"eventType": "repository.refresh.nope", "enabled": False}]},
    )
    assert response.status_code == 400
    assert "unknown notification event type" in response.json()["detail"]
    db.set_repository_notification_preference.assert_not_called()


def test_the_rejection_tells_the_caller_what_is_valid() -> None:
    response, _ = _call(
        "put", json_body={"preferences": [{"eventType": "nope", "enabled": False}]}
    )
    for event_type in ALL_EVENT_TYPES:
        assert event_type in response.json()["detail"]


def test_a_repeated_event_type_is_rejected_rather_than_resolved_by_write_order() -> None:
    """"Mute it, and also do not" has no correct answer; last-write-wins would pick one
    silently."""
    response, db = _call(
        "put",
        json_body={
            "preferences": [
                {"eventType": _AUTO_PAUSED, "enabled": False},
                {"eventType": _AUTO_PAUSED, "enabled": True},
            ]
        },
    )
    assert response.status_code == 400
    assert "duplicate" in response.json()["detail"]
    db.set_repository_notification_preference.assert_not_called()


def test_nothing_is_written_until_the_whole_request_validates() -> None:
    """A half-applied preference set leaves the repository in a state nobody asked for."""
    _, db = _call(
        "put",
        json_body={
            "preferences": [
                {"eventType": _AUTO_PAUSED, "enabled": False},
                {"eventType": "repository.refresh.nope", "enabled": False},
            ]
        },
    )
    db.set_repository_notification_preference.assert_not_called()


def test_an_empty_update_is_rejected_by_the_schema() -> None:
    response, _ = _call("put", json_body={"preferences": []})
    assert response.status_code == 422


def test_writing_to_another_tenants_repository_is_a_404() -> None:
    response, _ = _call(
        "put",
        json_body={"preferences": [{"eventType": _AUTO_PAUSED, "enabled": False}]},
        stored=None,
    )
    assert response.status_code == 404


def test_changing_a_preference_never_touches_the_throttle() -> None:
    """Un-muting must not hand an event a fresh slot inside a window it has already used."""
    _, db = _call(
        "put", json_body={"preferences": [{"eventType": _AUTO_PAUSED, "enabled": True}]}
    )
    db.claim_repository_notification_slot.assert_not_called()
