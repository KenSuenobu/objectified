"""Unit tests for the waiver-expiry notification sweep (CLX-4.2, #4860).

Extended by IXH-2.3 (#5098): the same tick also claims import/export quality waivers, so the
two ledgers share one sweep instead of growing a second, near-identical mechanism.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.lint_waiver_expiry_sweep import process_lint_waiver_expiry_sweep


class FakeDb:
    """Claim-once double: returns the pending rows on the first claim, nothing after."""

    def __init__(self, rows, quality_rows=()):
        self._pending = list(rows)
        self._pending_quality = list(quality_rows)
        self.claim_calls = []
        self.quality_claim_calls = []
        self.enqueued = []
        self._counter = 0

    def claim_expiring_lint_waivers(self, *, cutoff, limit=50):
        self.claim_calls.append((cutoff, limit))
        claimed, self._pending = self._pending[:limit], self._pending[limit:]
        return claimed

    def claim_expiring_import_export_quality_waivers(self, *, cutoff, limit=50):
        self.quality_claim_calls.append((cutoff, limit))
        claimed, self._pending_quality = (
            self._pending_quality[:limit],
            self._pending_quality[limit:],
        )
        return claimed

    def list_active_push_webhook_subscription_ids(self, tenant_id):
        return ["s1"]

    def enqueue_push_webhook_delivery(self, tenant_id, subscription_id, event_type, payload):
        self._counter += 1
        self.enqueued.append((tenant_id, event_type, payload))
        return {"id": f"d{self._counter}"}


def _waiver(decision_id: str, expires_at: str) -> dict:
    return {
        "id": decision_id,
        "tenant_id": "t1",
        "project_id": None,
        "source_fingerprint": f"fp-{decision_id}",
        "rule_id": "naming.rule",
        "state": "waived",
        "rationale": "accepted",
        "linked_ticket": None,
        "expires_at": expires_at,
    }


def test_sweep_claims_once_and_notifies_each_waiver():
    db = FakeDb([_waiver("d1", "2026-07-15T00:00:00+00:00"), _waiver("d2", "2026-07-16T00:00:00+00:00")])
    assert process_lint_waiver_expiry_sweep(db, warning_hours=72) == 2
    assert [p["decisionId"] for _, _, p in db.enqueued] == ["d1", "d2"]
    assert all(e == "lint.waiver.expiring" for _, e, _ in db.enqueued)
    payload = db.enqueued[0][2]
    assert payload["expiresAt"] == "2026-07-15T00:00:00+00:00"

    # Second tick: everything already claimed -> nothing new fires.
    assert process_lint_waiver_expiry_sweep(db, warning_hours=72) == 0
    assert len(db.enqueued) == 2


def test_sweep_cutoff_uses_warning_window():
    db = FakeDb([])
    before = datetime.now(timezone.utc)
    process_lint_waiver_expiry_sweep(db, warning_hours=48)
    cutoff, limit = db.claim_calls[0]
    assert limit == 50
    assert timedelta(hours=47, minutes=59) < (cutoff - before) < timedelta(hours=48, minutes=1)


def test_sweep_defaults_to_configured_window():
    from app.config import settings

    db = FakeDb([])
    with patch.object(settings, "lint_waiver_expiry_warning_hours", 24):
        process_lint_waiver_expiry_sweep(db)
    cutoff, _ = db.claim_calls[0]
    delta = cutoff - datetime.now(timezone.utc)
    assert timedelta(hours=23) < delta < timedelta(hours=25)


def test_sweep_survives_claim_failure():
    class BrokenDb:
        def claim_expiring_lint_waivers(self, **kwargs):
            raise RuntimeError("db down")

        def claim_expiring_import_export_quality_waivers(self, **kwargs):
            raise RuntimeError("db down")

    assert process_lint_waiver_expiry_sweep(BrokenDb(), warning_hours=1) == 0


# ---------------------------------------------------------------------------
# Import/export quality waivers (IXH-2.3, #5098)
# ---------------------------------------------------------------------------


def _quality_waiver(waiver_id: str, expires_at: str, scope: str = "import") -> dict:
    return {
        "id": waiver_id,
        "tenant_id": "t1",
        "scope": scope,
        "subject_key": "a" * 64,
        "format_key": "openapi",
        "reason": "demo deadline",
        "expires_at": expires_at,
    }


def test_sweep_notifies_quality_waivers_on_the_same_tick():
    db = FakeDb(
        [_waiver("d1", "2026-07-15T00:00:00+00:00")],
        quality_rows=[_quality_waiver("q1", "2026-07-16T00:00:00+00:00")],
    )
    assert process_lint_waiver_expiry_sweep(db, warning_hours=72) == 2
    kinds = [p.get("kind") for _, _, p in db.enqueued]
    assert kinds == ["lint_finding", "quality:import"]

    quality_payload = db.enqueued[1][2]
    assert quality_payload["decisionId"] == "q1"
    assert quality_payload["sourceFingerprint"] == "a" * 64
    assert quality_payload["rationale"] == "demo deadline"
    assert quality_payload["expiresAt"] == "2026-07-16T00:00:00+00:00"
    assert "quality-waivers" in quality_payload["decisionHref"]

    # Claimed rows are not re-notified on the next tick.
    assert process_lint_waiver_expiry_sweep(db, warning_hours=72) == 0
    assert len(db.enqueued) == 2


def test_both_ledgers_share_the_same_cutoff():
    db = FakeDb([], quality_rows=[])
    process_lint_waiver_expiry_sweep(db, warning_hours=12)
    assert db.claim_calls[0] == db.quality_claim_calls[0]


def test_quality_claim_failure_does_not_lose_lint_notifications():
    class HalfBrokenDb(FakeDb):
        def claim_expiring_import_export_quality_waivers(self, **kwargs):
            raise RuntimeError("db down")

    db = HalfBrokenDb([_waiver("d1", "2026-07-15T00:00:00+00:00")])
    assert process_lint_waiver_expiry_sweep(db, warning_hours=72) == 1
    assert len(db.enqueued) == 1
