"""The ``Database`` methods behind webhook ingestion (REPO-4.3, #2781).

Exercised with the connection or ``execute_query`` mocked, in the style of
``test_auth_events_db.py``: no live database is touched. What is pinned here is the SQL's
*shape*, because three of these statements carry a security or correctness guarantee that is
invisible from the Python signature:

* the REST-facing read must not select the secret ciphertext at all;
* the delivery insert must collide (not duplicate) on a redelivery;
* making a repository due must not silently re-enable a repository whose tenant turned
  auto-refresh off, or un-pause one the RAR-3.4 backoff paused.
"""

from unittest.mock import MagicMock

from app.database import Database

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_SUB_ID = "990e8400-e29b-41d4-a716-446655440004"


def _db_with_cursor(fetchone=None):
    """A ``Database`` whose connection yields a cursor returning ``fetchone``."""
    db = Database()
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = fetchone
    db.connect = MagicMock(return_value=conn)
    return db, conn, cursor


# --- Subscription insert ----------------------------------------------------------------


def test_inserting_a_subscription_is_a_no_op_when_one_already_exists() -> None:
    db, conn, cursor = _db_with_cursor(fetchone=None)

    result = db.insert_repository_webhook_subscription(
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="octocat/hello-world",
        secret_enc=b"cipher",
        secret_fingerprint="abc123",
    )

    sql = cursor.execute.call_args[0][0]
    assert "ON CONFLICT (repository_id) DO NOTHING" in sql
    assert result is None
    conn.commit.assert_called_once()


def test_the_insert_never_returns_the_ciphertext_it_just_wrote() -> None:
    db, _, cursor = _db_with_cursor(fetchone={"id": _SUB_ID})

    db.insert_repository_webhook_subscription(
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="octocat/hello-world",
        secret_enc=b"cipher",
        secret_fingerprint="abc123",
    )

    sql = cursor.execute.call_args[0][0]
    returning = sql.split("RETURNING", 1)[1]
    assert "secret_enc" not in returning
    assert "secret_fingerprint" in returning


def test_a_deployment_with_no_encryption_key_stores_a_null_ciphertext() -> None:
    db, _, cursor = _db_with_cursor(fetchone={"id": _SUB_ID})

    db.insert_repository_webhook_subscription(
        tenant_id=_TENANT,
        repository_id=_REPO_ID,
        provider="github",
        repo_full_name="octocat/hello-world",
        secret_enc=None,
        secret_fingerprint=None,
    )

    params = cursor.execute.call_args[0][1]
    assert params[4] is None


def test_a_store_error_rolls_back_and_propagates() -> None:
    db, conn, cursor = _db_with_cursor()
    cursor.execute.side_effect = RuntimeError("boom")

    try:
        db.insert_repository_webhook_subscription(
            tenant_id=_TENANT,
            repository_id=_REPO_ID,
            provider="github",
            repo_full_name="o/r",
            secret_enc=b"c",
            secret_fingerprint="f",
        )
    except RuntimeError:
        pass
    else:  # pragma: no cover - the raise above is the expected path
        raise AssertionError("expected the store error to propagate")

    conn.rollback.assert_called_once()


# --- Reads ------------------------------------------------------------------------------


def test_the_rest_facing_read_does_not_select_the_secret() -> None:
    """A column that is never selected cannot be leaked by a careless response model."""
    db = Database()
    db.execute_query = MagicMock(return_value=[])

    db.get_repository_webhook_subscription(_TENANT, _REPO_ID)

    sql = db.execute_query.call_args[0][0]
    assert "secret_enc" not in sql
    assert "secret_fingerprint" in sql


def test_the_rest_facing_read_is_tenant_scoped() -> None:
    db = Database()
    db.execute_query = MagicMock(return_value=[])

    db.get_repository_webhook_subscription(_TENANT, _REPO_ID)

    sql, params = db.execute_query.call_args[0]
    assert "s.tenant_id = %s::uuid" in sql
    assert params == (_REPO_ID, _TENANT)


def test_the_verification_lookup_is_the_only_read_that_selects_the_secret() -> None:
    db = Database()
    db.execute_query = MagicMock(return_value=[])

    db.find_repository_webhook_subscriptions("github", "octocat/hello-world")

    sql = db.execute_query.call_args[0][0]
    assert "s.secret_enc" in sql


def test_the_verification_lookup_excludes_removed_repositories() -> None:
    """A repository a tenant deleted must not keep driving scans from a leftover hook."""
    db = Database()
    db.execute_query = MagicMock(return_value=[])

    db.find_repository_webhook_subscriptions("github", "octocat/hello-world")

    assert "r.deleted_at IS NULL" in db.execute_query.call_args[0][0]


def test_the_delivery_listing_is_bounded() -> None:
    db = Database()
    db.execute_query = MagicMock(return_value=[])

    db.list_repository_webhook_events(_TENANT, _REPO_ID, 100000)
    assert db.execute_query.call_args[0][1][2] == 200

    db.list_repository_webhook_events(_TENANT, _REPO_ID, 0)
    assert db.execute_query.call_args[0][1][2] == 1


# --- Registration state ------------------------------------------------------------------


def test_updating_registration_never_touches_the_secret() -> None:
    """This method must not become an accidental secret-rotation path."""
    db, _, cursor = _db_with_cursor(fetchone={"id": _SUB_ID})

    db.update_repository_webhook_registration(
        _SUB_ID, registration_state="registered", provider_hook_id="1"
    )

    sql = cursor.execute.call_args[0][0]
    set_clause = sql.split("SET", 1)[1].split("WHERE", 1)[0]
    assert "secret_enc" not in set_clause
    assert "registration_state" in set_clause


def test_a_hook_id_is_only_overwritten_when_a_new_one_is_supplied() -> None:
    db, _, cursor = _db_with_cursor(fetchone={"id": _SUB_ID})

    db.update_repository_webhook_registration(_SUB_ID, registration_state="failed")

    assert "COALESCE(%s, provider_hook_id)" in cursor.execute.call_args[0][0]


# --- Delivery ledger ---------------------------------------------------------------------


def test_a_redelivery_collides_and_returns_nothing() -> None:
    db, _, cursor = _db_with_cursor(fetchone=None)

    result = db.record_repository_webhook_event(
        provider="github",
        outcome="enqueued",
        tenant_id=_TENANT,
        subscription_id=_SUB_ID,
        repository_id=_REPO_ID,
        delivery_id="d-1",
    )

    sql = cursor.execute.call_args[0][0]
    assert "ON CONFLICT (subscription_id, delivery_id)" in sql
    assert "WHERE subscription_id IS NOT NULL AND delivery_id IS NOT NULL" in sql
    assert "DO NOTHING" in sql
    assert result is None


def test_an_unattributed_delivery_records_null_ids() -> None:
    db, _, cursor = _db_with_cursor(fetchone={"id": "evt"})

    db.record_repository_webhook_event(
        provider="github", outcome="ignored", repo_full_name="who/knows"
    )

    params = cursor.execute.call_args[0][1]
    assert params[0] is None  # tenant_id
    assert params[1] is None  # subscription_id
    assert params[2] is None  # repository_id


def test_a_negative_job_count_is_clamped_to_zero() -> None:
    """The column carries a CHECK; clamping keeps a caller bug from failing the ledger write."""
    db, _, cursor = _db_with_cursor(fetchone={"id": "evt"})

    db.record_repository_webhook_event(
        provider="github", outcome="ignored", jobs_enqueued=-5
    )

    assert cursor.execute.call_args[0][1][-1] == 0


def test_touching_a_subscription_advances_its_counters() -> None:
    db = Database()
    db._execute_write = MagicMock(return_value=1)

    db.touch_repository_webhook_subscription(_SUB_ID, "d-9")

    sql, params = db._execute_write.call_args[0]
    assert "event_count = event_count + 1" in sql
    assert "COALESCE(%s, last_delivery_id)" in sql
    assert params == ("d-9", _SUB_ID)


# --- Scan enqueue + poll-due --------------------------------------------------------------


def test_a_scan_is_not_enqueued_while_one_is_already_active() -> None:
    db, _, cursor = _db_with_cursor(fetchone=None)

    result = db.enqueue_repository_file_scan_job_if_idle(_TENANT, _REPO_ID, "main")

    sql = cursor.execute.call_args[0][0]
    assert "WHERE NOT EXISTS" in sql
    assert "status IN ('queued', 'running')" in sql
    assert result is None


def test_an_idle_branch_gets_a_new_scan_job() -> None:
    db, _, cursor = _db_with_cursor(fetchone={"id": "job-1"})

    assert db.enqueue_repository_file_scan_job_if_idle(_TENANT, _REPO_ID, "main") == "job-1"


def test_making_a_repository_due_clears_the_anchor_and_the_backoff() -> None:
    db = Database()
    db._execute_write = MagicMock(return_value=1)

    assert db.mark_repository_poll_due(_REPO_ID) is True

    sql = db._execute_write.call_args[0][0]
    assert "last_refreshed_at = NULL" in sql
    assert "refresh_backoff_until = NULL" in sql


def test_a_push_cannot_overrule_a_tenants_auto_refresh_opt_out() -> None:
    db = Database()
    db._execute_write = MagicMock(return_value=0)

    assert db.mark_repository_poll_due(_REPO_ID) is False

    sql = db._execute_write.call_args[0][0]
    assert "COALESCE(auto_refresh_enabled, TRUE) = TRUE" in sql


def test_a_push_cannot_un_pause_an_auto_paused_repository() -> None:
    """A push does not make a repository that keeps failing start working."""
    db = Database()
    db._execute_write = MagicMock(return_value=0)

    db.mark_repository_poll_due(_REPO_ID)

    sql = db._execute_write.call_args[0][0]
    assert "refresh_paused_at IS NULL" in sql
    assert "refresh_paused_at = NULL" not in sql


def test_making_a_repository_due_skips_removed_repositories() -> None:
    db = Database()
    db._execute_write = MagicMock(return_value=0)

    db.mark_repository_poll_due(_REPO_ID)

    assert "deleted_at IS NULL" in db._execute_write.call_args[0][0]
