"""Polling-quota telemetry unit tests (REPO-4.6, #2784).

Pure-module tests over ``app.repository_polling_telemetry``: counter
accumulation, the per-tenant breakdown and its overflow bound, kind validation,
and thread safety. The sweep-level wiring — which events fire on a dispatch and
on each kind of deferral — is covered in
``tests/test_repository_refresh_sweep.py``.
"""

import threading

import pytest

from app.repository_polling_telemetry import (
    KIND_FILES_DEFERRED,
    KIND_POLL_DISPATCHED,
    KIND_REPOSITORY_DEFERRED,
    MAX_TRACKED_TENANTS,
    OVERFLOW_TENANT_KEY,
    RepositoryPollingTelemetry,
)


@pytest.fixture()
def telemetry():
    """A fresh registry per test (never the process-wide singleton)."""
    return RepositoryPollingTelemetry()


def test_empty_snapshot(telemetry):
    assert telemetry.snapshot() == {"totals": {}, "by_tenant": {}}


def test_records_totals_and_per_tenant_counts(telemetry):
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="t1", jobs=3)
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="t2", jobs=1)
    telemetry.record(KIND_REPOSITORY_DEFERRED, tenant_id="t1")

    snapshot = telemetry.snapshot()
    assert snapshot["totals"] == {
        "poll_dispatched": 2,
        "poll_dispatched_jobs": 4,
        "repository_deferred": 1,
    }
    assert snapshot["by_tenant"]["t1"] == {
        "poll_dispatched": 1,
        "poll_dispatched_jobs": 3,
        "repository_deferred": 1,
    }
    assert snapshot["by_tenant"]["t2"] == {
        "poll_dispatched": 1,
        "poll_dispatched_jobs": 1,
    }


def test_zero_jobs_records_the_event_without_a_jobs_counter(telemetry):
    """A poll that enqueued nothing is still a poll; it just adds no volume."""
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="t1", jobs=0)

    snapshot = telemetry.snapshot()
    assert snapshot["totals"] == {"poll_dispatched": 1}
    assert "poll_dispatched_jobs" not in snapshot["totals"]


def test_negative_jobs_are_ignored(telemetry):
    telemetry.record(KIND_FILES_DEFERRED, tenant_id="t1", jobs=-4)
    assert telemetry.snapshot()["totals"] == {"files_deferred": 1}


def test_n_multiplies_the_kind_counter(telemetry):
    telemetry.record(KIND_REPOSITORY_DEFERRED, tenant_id="t1", n=5)
    assert telemetry.snapshot()["totals"]["repository_deferred"] == 5


def test_nonpositive_n_records_nothing(telemetry):
    telemetry.record(KIND_REPOSITORY_DEFERRED, tenant_id="t1", n=0)
    telemetry.record(KIND_REPOSITORY_DEFERRED, tenant_id="t1", n=-3)
    assert telemetry.snapshot() == {"totals": {}, "by_tenant": {}}


def test_unknown_kind_is_rejected(telemetry):
    with pytest.raises(ValueError):
        telemetry.record("quota_exceeded", tenant_id="t1")


def test_tenant_ids_are_stringified(telemetry):
    """A UUID object and its string form must land in the same bucket."""
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id=1234)
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="1234")
    assert telemetry.snapshot()["by_tenant"]["1234"]["poll_dispatched"] == 2


def test_reset_clears_everything(telemetry):
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="t1", jobs=2)
    telemetry.reset()
    assert telemetry.snapshot() == {"totals": {}, "by_tenant": {}}


def test_snapshot_is_a_copy(telemetry):
    """Mutating a snapshot must not corrupt the registry."""
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="t1")
    snapshot = telemetry.snapshot()
    snapshot["totals"]["poll_dispatched"] = 999
    snapshot["by_tenant"]["t1"]["poll_dispatched"] = 999

    assert telemetry.snapshot()["totals"]["poll_dispatched"] == 1
    assert telemetry.snapshot()["by_tenant"]["t1"]["poll_dispatched"] == 1


def test_per_tenant_map_is_bounded_and_totals_stay_exact(telemetry):
    """Beyond the cap, tenants aggregate into the overflow bucket."""
    for i in range(MAX_TRACKED_TENANTS + 10):
        telemetry.record(KIND_REPOSITORY_DEFERRED, tenant_id=f"t{i}")

    snapshot = telemetry.snapshot()
    # The cap plus exactly one overflow bucket.
    assert len(snapshot["by_tenant"]) == MAX_TRACKED_TENANTS + 1
    assert snapshot["by_tenant"][OVERFLOW_TENANT_KEY]["repository_deferred"] == 10
    # The aggregate is always exact, however many tenants there are.
    assert snapshot["totals"]["repository_deferred"] == MAX_TRACKED_TENANTS + 10


def test_already_tracked_tenant_never_overflows(telemetry):
    """A tenant already in the map keeps its own bucket once the map is full."""
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="first")
    for i in range(MAX_TRACKED_TENANTS + 5):
        telemetry.record(KIND_POLL_DISPATCHED, tenant_id=f"t{i}")
    telemetry.record(KIND_POLL_DISPATCHED, tenant_id="first")

    assert telemetry.snapshot()["by_tenant"]["first"]["poll_dispatched"] == 2


def test_concurrent_records_lose_no_counts(telemetry):
    """The registry is shared by sweep workers; counters must be race-free."""
    threads = [
        threading.Thread(
            target=lambda: [
                telemetry.record(KIND_POLL_DISPATCHED, tenant_id="t1", jobs=1)
                for _ in range(200)
            ]
        )
        for _ in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    snapshot = telemetry.snapshot()
    assert snapshot["totals"]["poll_dispatched"] == 1600
    assert snapshot["totals"]["poll_dispatched_jobs"] == 1600
    assert snapshot["by_tenant"]["t1"]["poll_dispatched"] == 1600
