"""Tests for the verification-target store (ECA-1.2, #4730).

``app.verification_target_store`` is the single door between the pure contract and the
``verification_target`` / ``verification_target_audit`` tables. These tests pin what that door
applies, against a stubbed data layer:

* a definition the database would reject never reaches it — the URL, the credential reference, and
  the policy are all vetted first, and the expensive DNS check runs last;
* **target selection is audited**, success and refusal alike, with the actor and whether they were
  an interactive user or a CI runner;
* the ledger records *what* changed and never *to what*, and never the credential reference itself;
* a patch is validated against the merged result, so moving a target between network classes is one
  coherent change rather than a window in which the record is illegal.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest

from app.verification_target import (
    AUTH_KIND_ENV,
    AUTH_KIND_NONE,
    AUTH_SCHEME_BEARER,
    CODE_DISABLED,
    CODE_NOT_FOUND,
    CODE_POLICY_TLS_REQUIRED,
    CODE_PRIVATE_NOT_APPROVED,
    CODE_SLUG_TAKEN,
    CODE_URL_PRIVATE_NETWORK,
    NETWORK_CLASS_PRIVATE,
    NETWORK_CLASS_PUBLIC,
    TargetAuthReference,
    TargetValidationError,
    VerificationPolicy,
    VerificationTargetInput,
    VerificationTargetPatch,
    record_from_row,
)
from app.verification_target_store import (
    ACTION_CREATE,
    ACTION_DELETE,
    ACTION_RESOLVE,
    ACTION_UPDATE,
    ACTOR_KIND_API_KEY,
    ACTOR_KIND_USER,
    OUTCOME_DENIED,
    OUTCOME_SUCCESS,
    TargetActor,
    actor_from_auth,
    create_target,
    delete_target,
    get_target,
    list_targets,
    resolve_target,
    update_target,
)

_TENANT = "11111111-1111-4111-8111-111111111111"
_TARGET = "22222222-2222-4222-8222-222222222222"
_USER = "44444444-4444-4444-8444-444444444444"

_ACTOR = TargetActor(user_id=_USER, label="ada@example.com", kind=ACTOR_KIND_USER)
_RUNNER = TargetActor(user_id=_USER, label="ci-key", kind=ACTOR_KIND_API_KEY)


@pytest.fixture(autouse=True)
def _enforce_ssrf_filtering():
    """Force IP filtering on so a developer's local override cannot make the suite lie."""
    with patch("app.ssrf_guard.settings.ssrf_allow_private", False):
        yield


def _row(**overrides: Any) -> Dict[str, Any]:
    """A stored ``verification_target`` row, as the data layer returns one."""
    row: Dict[str, Any] = {
        "id": _TARGET,
        "tenant_id": _TENANT,
        "slug": "staging",
        "name": "Staging",
        "description": None,
        "environment": "staging",
        "base_url": "https://93.184.216.34/api",
        "network_class": NETWORK_CLASS_PUBLIC,
        "approved_by": None,
        "approved_at": None,
        "approval_reason": None,
        "auth_kind": AUTH_KIND_ENV,
        "auth_scheme": AUTH_SCHEME_BEARER,
        "auth_ref": "APIOME_STAGING_TOKEN",
        "auth_header_name": None,
        "policy": {},
        "enabled": True,
        "created_by": _USER,
        "updated_by": None,
        "created_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 7, 27, tzinfo=timezone.utc),
        "deleted_at": None,
    }
    row.update(overrides)
    return row


class _StubDb:
    """A minimal stand-in for ``app.database.db`` that records what the store asked it to do."""

    def __init__(self, *, row: Optional[Dict[str, Any]] = None):
        self.row = row
        self.inserts: List[Dict[str, Any]] = []
        self.updates: List[Dict[str, Any]] = []
        self.audits: List[Dict[str, Any]] = []
        self.deleted = False
        self.audit_raises = False

    # --- reads ---------------------------------------------------------
    def list_verification_targets(self, tenant_id, *, limit=200):
        return [self.row] if self.row else []

    def get_verification_target_by_slug(self, tenant_id, slug):
        if self.row and self.row["slug"] == slug and self.row.get("deleted_at") is None:
            return self.row
        return None

    def get_verification_target_by_id(self, target_id, tenant_id, *, include_deleted=False):
        if not self.row or self.row["id"] != target_id:
            return None
        if self.row.get("deleted_at") is not None and not include_deleted:
            return None
        return self.row

    # --- writes --------------------------------------------------------
    def insert_verification_target(self, **kwargs):
        self.inserts.append(kwargs)
        stored = {k: v for k, v in kwargs.items() if k in _row()}
        stored["policy"] = kwargs.get("policy") or {}
        self.row = _row(**stored)
        return self.row

    def update_verification_target(self, target_id, tenant_id, fields, *, updated_by=None, touch_approval=False):
        self.updates.append({"fields": dict(fields), "touch_approval": touch_approval})
        if not self.row or self.row["id"] != target_id:
            return None
        self.row = {**self.row, **fields, "updated_by": updated_by}
        return self.row

    def soft_delete_verification_target(self, target_id, tenant_id, *, deleted_by=None):
        if not self.row or self.row["id"] != target_id:
            return False
        self.deleted = True
        self.row = {**self.row, "deleted_at": datetime.now(timezone.utc), "enabled": False}
        return True

    def insert_verification_target_audit(self, **kwargs):
        if self.audit_raises:
            raise RuntimeError("ledger unavailable")
        self.audits.append(kwargs)
        return kwargs

    def list_verification_target_audit(self, tenant_id, *, target_id=None, limit=100):
        return [a for a in self.audits if target_id is None or a.get("target_id") == target_id]


def _definition(**overrides: Any) -> VerificationTargetInput:
    """A valid definition of a public staging target."""
    payload: Dict[str, Any] = {
        "slug": "staging",
        "name": "Staging",
        "base_url": "https://93.184.216.34/api/",
        "auth": TargetAuthReference(
            kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref="APIOME_STAGING_TOKEN"
        ),
    }
    payload.update(overrides)
    return VerificationTargetInput(**payload)


# ===========================================================================
# Actor resolution
# ===========================================================================


def test_an_api_key_caller_is_recorded_as_a_runner() -> None:
    actor = actor_from_auth({"auth_method": "api_key", "user_id": _USER}, _USER)
    assert actor.kind == ACTOR_KIND_API_KEY
    assert actor.user_id == _USER


def test_a_session_caller_is_recorded_as_a_user_with_a_label() -> None:
    actor = actor_from_auth(
        {"auth_method": "jwt", "user_id": _USER, "user_email": "ada@example.com"}
    )
    assert (actor.kind, actor.label) == (ACTOR_KIND_USER, "ada@example.com")


# ===========================================================================
# Create
# ===========================================================================


def test_creating_a_target_stores_it_and_audits_the_definition() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        record = create_target(_TENANT, _definition(), actor=_ACTOR)

    assert record.slug == "staging"
    # The URL is stored normalized, so a case's relative path joins deterministically.
    assert stub.inserts[0]["base_url"] == "https://93.184.216.34/api"
    assert stub.inserts[0]["auth_ref"] == "APIOME_STAGING_TOKEN"

    entry = stub.audits[0]
    assert entry["action"] == ACTION_CREATE
    assert entry["outcome"] == OUTCOME_SUCCESS
    assert entry["actor_id"] == _USER
    assert entry["detail"]["auth_kind"] == AUTH_KIND_ENV


def test_a_private_address_is_refused_before_anything_is_stored() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            create_target(_TENANT, _definition(base_url="http://10.0.0.5"), actor=_ACTOR)
    assert exc.value.code == CODE_URL_PRIVATE_NETWORK
    assert stub.inserts == []


def test_a_private_target_must_state_why() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            create_target(
                _TENANT,
                _definition(base_url="http://10.0.0.5", network_class=NETWORK_CLASS_PRIVATE),
                actor=_ACTOR,
            )
    assert exc.value.code == CODE_PRIVATE_NOT_APPROVED
    assert stub.inserts == []


def test_an_approved_private_target_records_its_approver() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        create_target(
            _TENANT,
            _definition(
                base_url="http://10.0.0.5",
                network_class=NETWORK_CLASS_PRIVATE,
                approval_reason="staging lives on the internal VPC",
            ),
            actor=_ACTOR,
        )
    assert stub.inserts[0]["approved_by"] == _USER
    assert stub.inserts[0]["approval_reason"] == "staging lives on the internal VPC"


def test_an_unattributable_credential_cannot_open_an_internal_target() -> None:
    # A private-network target is an exception someone has to own; a credential that resolves to
    # no user would leave nobody accountable for it.
    stub = _StubDb()
    anonymous = TargetActor(user_id=None, label="legacy-key", kind=ACTOR_KIND_API_KEY)
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            create_target(
                _TENANT,
                _definition(
                    base_url="http://10.0.0.5",
                    network_class=NETWORK_CLASS_PRIVATE,
                    approval_reason="internal VPC",
                ),
                actor=anonymous,
            )
    assert exc.value.code == CODE_PRIVATE_NOT_APPROVED
    assert stub.inserts == []


def test_disabling_tls_verification_on_a_public_target_is_refused() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            create_target(
                _TENANT,
                _definition(policy=VerificationPolicy(verify_tls=False)),
                actor=_ACTOR,
            )
    assert exc.value.code == CODE_POLICY_TLS_REQUIRED
    assert stub.inserts == []


def test_a_duplicate_slug_is_a_conflict() -> None:
    stub = _StubDb(row=_row())
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            create_target(_TENANT, _definition(), actor=_ACTOR)
    assert exc.value.code == CODE_SLUG_TAKEN
    assert stub.inserts == []


def test_a_ledger_failure_never_fails_the_action_it_records() -> None:
    stub = _StubDb()
    stub.audit_raises = True
    with patch("app.verification_target_store.db", stub):
        record = create_target(_TENANT, _definition(), actor=_ACTOR)
    assert record.slug == "staging"


# ===========================================================================
# Read
# ===========================================================================


def test_a_target_resolves_by_slug_or_by_id() -> None:
    stub = _StubDb(row=_row())
    with patch("app.verification_target_store.db", stub):
        assert get_target(_TENANT, "staging").id == _TARGET
        assert get_target(_TENANT, _TARGET).slug == "staging"


def test_an_unknown_reference_is_not_found() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            get_target(_TENANT, "nope")
    assert exc.value.code == CODE_NOT_FOUND


def test_a_retired_target_is_readable_by_id_for_the_evidence_that_names_it() -> None:
    stub = _StubDb(row=_row(deleted_at=datetime(2026, 7, 27, tzinfo=timezone.utc)))
    with patch("app.verification_target_store.db", stub):
        assert get_target(_TENANT, _TARGET, include_deleted=True).id == _TARGET
        with pytest.raises(TargetValidationError):
            get_target(_TENANT, _TARGET)


def test_listing_returns_the_tenants_live_targets() -> None:
    stub = _StubDb(row=_row())
    with patch("app.verification_target_store.db", stub):
        assert [r.slug for r in list_targets(_TENANT)] == ["staging"]


# ===========================================================================
# Update
# ===========================================================================


def test_an_empty_patch_changes_nothing_and_writes_nothing() -> None:
    stub = _StubDb(row=_row())
    record = record_from_row(_row())
    with patch("app.verification_target_store.db", stub):
        assert update_target(_TENANT, record, VerificationTargetPatch(), actor=_ACTOR) is record
    assert stub.updates == [] and stub.audits == []


def test_an_update_audits_field_names_and_never_their_values() -> None:
    stub = _StubDb(row=_row())
    record = record_from_row(_row())
    patch_body = VerificationTargetPatch(
        name="Staging EU",
        auth=TargetAuthReference(
            kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref="APIOME_EU_TOKEN"
        ),
    )
    with patch("app.verification_target_store.db", stub):
        update_target(_TENANT, record, patch_body, actor=_ACTOR)

    entry = stub.audits[0]
    assert entry["action"] == ACTION_UPDATE
    assert "auth_ref" in entry["detail"]["changed"]
    # The reference *name* changed, but the ledger records only which fields moved.
    assert "APIOME_EU_TOKEN" not in str(entry["detail"])


def test_moving_a_target_to_private_requires_a_reason_in_the_same_change() -> None:
    stub = _StubDb(row=_row())
    record = record_from_row(_row())
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            update_target(
                _TENANT,
                record,
                VerificationTargetPatch(network_class=NETWORK_CLASS_PRIVATE),
                actor=_ACTOR,
            )
    assert exc.value.code == CODE_PRIVATE_NOT_APPROVED
    assert stub.updates == []


def test_moving_a_target_to_private_with_a_reason_records_the_approver() -> None:
    stub = _StubDb(row=_row())
    record = record_from_row(_row())
    with patch("app.verification_target_store.db", stub):
        update_target(
            _TENANT,
            record,
            VerificationTargetPatch(
                network_class=NETWORK_CLASS_PRIVATE,
                base_url="http://10.0.0.5/api",
                approval_reason="moved behind the VPN",
            ),
            actor=_ACTOR,
        )
    fields = stub.updates[0]["fields"]
    assert fields["network_class"] == NETWORK_CLASS_PRIVATE
    assert fields["approved_by"] == _USER
    assert stub.updates[0]["touch_approval"] is True


def test_moving_a_private_target_back_to_public_rechecks_its_address() -> None:
    row = _row(
        base_url="http://10.0.0.5/api",
        network_class=NETWORK_CLASS_PRIVATE,
        approval_reason="internal",
        approved_by=_USER,
    )
    stub = _StubDb(row=row)
    record = record_from_row(row)
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            update_target(
                _TENANT,
                record,
                VerificationTargetPatch(network_class=NETWORK_CLASS_PUBLIC),
                actor=_ACTOR,
            )
    assert exc.value.code == CODE_URL_PRIVATE_NETWORK
    assert stub.updates == []


def test_moving_back_to_public_clears_the_approval() -> None:
    row = _row(
        base_url="http://10.0.0.5/api",
        network_class=NETWORK_CLASS_PRIVATE,
        approval_reason="internal",
        approved_by=_USER,
    )
    stub = _StubDb(row=row)
    record = record_from_row(row)
    with patch("app.verification_target_store.db", stub):
        update_target(
            _TENANT,
            record,
            VerificationTargetPatch(
                network_class=NETWORK_CLASS_PUBLIC, base_url="https://93.184.216.34/api"
            ),
            actor=_ACTOR,
        )
    fields = stub.updates[0]["fields"]
    assert fields["approval_reason"] is None and fields["approved_by"] is None


def test_a_policy_that_contradicts_the_new_network_class_is_refused() -> None:
    row = _row(
        base_url="http://10.0.0.5/api",
        network_class=NETWORK_CLASS_PRIVATE,
        approval_reason="internal",
        approved_by=_USER,
        policy={"verify_tls": False},
    )
    stub = _StubDb(row=row)
    record = record_from_row(row)
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            update_target(
                _TENANT,
                record,
                VerificationTargetPatch(
                    network_class=NETWORK_CLASS_PUBLIC, base_url="https://93.184.216.34/api"
                ),
                actor=_ACTOR,
            )
    assert exc.value.code == CODE_POLICY_TLS_REQUIRED


def test_replacing_the_credential_reference_replaces_every_one_of_its_columns() -> None:
    stub = _StubDb(row=_row())
    record = record_from_row(_row())
    with patch("app.verification_target_store.db", stub):
        update_target(
            _TENANT, record, VerificationTargetPatch(auth=TargetAuthReference()), actor=_ACTOR
        )
    fields = stub.updates[0]["fields"]
    assert fields["auth_kind"] == AUTH_KIND_NONE
    assert fields["auth_scheme"] is None and fields["auth_ref"] is None


# ===========================================================================
# Delete
# ===========================================================================


def test_retiring_a_target_is_a_soft_delete_and_is_audited() -> None:
    stub = _StubDb(row=_row())
    record = record_from_row(_row())
    with patch("app.verification_target_store.db", stub):
        assert delete_target(_TENANT, record, actor=_ACTOR) is True
    assert stub.deleted is True
    assert stub.audits[0]["action"] == ACTION_DELETE


def test_retiring_a_target_twice_is_not_audited_twice() -> None:
    stub = _StubDb()
    record = record_from_row(_row())
    with patch("app.verification_target_store.db", stub):
        assert delete_target(_TENANT, record, actor=_ACTOR) is False
    assert stub.audits == []


# ===========================================================================
# Resolve — the audited moment a definition becomes traffic
# ===========================================================================


def test_resolving_a_target_audits_the_selection_with_the_run_context() -> None:
    stub = _StubDb(row=_row())
    with patch("app.verification_target_store.db", stub):
        resolved = resolve_target(
            _TENANT, "staging", actor=_RUNNER, suite_digest="sha256:abc"
        )

    assert resolved.target_id == _TARGET
    entry = stub.audits[0]
    assert entry["action"] == ACTION_RESOLVE
    assert entry["outcome"] == OUTCOME_SUCCESS
    assert entry["actor_kind"] == ACTOR_KIND_API_KEY
    assert entry["detail"]["suite_digest"] == "sha256:abc"
    assert entry["detail"]["target_id"] == _TARGET
    # The reference kind is recorded; the reference itself never is.
    assert entry["detail"]["auth_kind"] == AUTH_KIND_ENV
    assert "APIOME_STAGING_TOKEN" not in str(entry["detail"])


def test_a_resolved_target_carries_the_reference_not_a_credential() -> None:
    stub = _StubDb(row=_row())
    with patch("app.verification_target_store.db", stub):
        resolved = resolve_target(_TENANT, "staging", actor=_RUNNER)
    assert resolved.auth.kind == AUTH_KIND_ENV
    assert resolved.auth.ref == "APIOME_STAGING_TOKEN"
    assert not hasattr(resolved.auth, "value")


def test_resolving_a_disabled_target_is_denied_and_audited() -> None:
    stub = _StubDb(row=_row(enabled=False))
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            resolve_target(_TENANT, "staging", actor=_ACTOR)
    assert exc.value.code == CODE_DISABLED
    entry = stub.audits[0]
    assert (entry["action"], entry["outcome"], entry["reason"]) == (
        ACTION_RESOLVE,
        OUTCOME_DENIED,
        CODE_DISABLED,
    )


def test_probing_for_an_unknown_target_leaves_a_trace() -> None:
    stub = _StubDb()
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError):
            resolve_target(_TENANT, "prod-secret-guess", actor=_RUNNER)
    entry = stub.audits[0]
    assert entry["outcome"] == OUTCOME_DENIED
    assert entry["target_slug"] == "prod-secret-guess"
    assert entry["reason"] == CODE_NOT_FOUND


def test_a_target_that_moved_inward_is_refused_at_resolve_time_and_audited() -> None:
    stub = _StubDb(row=_row(base_url="http://10.0.0.5/api"))
    with patch("app.verification_target_store.db", stub):
        with pytest.raises(TargetValidationError) as exc:
            resolve_target(_TENANT, "staging", actor=_RUNNER)
    assert exc.value.code == CODE_URL_PRIVATE_NETWORK
    assert stub.audits[0]["reason"] == CODE_URL_PRIVATE_NETWORK
