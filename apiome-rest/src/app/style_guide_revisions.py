"""
Immutable style-guide revisions & governance audit — GOV-1.6 (#4432).

Style guides are edited in place: a rename, a rule-catalog save, a custom-rules save or a
policy-gate change overwrites what was there. That makes a lint result undefendable — the
score names the guide, but not what the guide *contained* when it ran, so a compliance
narrative ("this version was published under guide revision 4") cannot be reconstructed
after the next edit.

This module closes that gap on top of the V236 tables:

* **Revisions** — :func:`record_guide_revision` appends one write-once
  ``style_guide_revisions`` row per edit, snapshotting the guide's identity (name,
  description, external lint profile), every rule row (enabled / severity / custom
  definition) and its draft policy gates, together with the change kind and the actor. An
  edit that changes nothing appends nothing (snapshot fingerprints are compared), so the
  history reads as real changes rather than save-button presses.
* **Self-healing capture** — guides created before this feature have no history. Rather
  than backfill fingerprints in SQL (which would have to re-implement Python's canonical
  JSON and could drift from it), :func:`ensure_guide_revision` captures the *current* state
  the first time a guide's history is read, edited, or linted under. Every edit path calls
  it **before** mutating, so the pre-edit state is preserved even for guides that predate
  GOV-1.6, and unrecorded drift from any other writer is captured rather than lost.
* **Lint-result pinning** — :func:`pin_guide_revision_id` maps a
  :class:`~app.style_guide_engine.CompiledStyleGuide` onto the revision whose rule content
  it matches. The equality is exact, not heuristic: a revision's ``content_fingerprint`` is
  produced by :func:`~app.style_guide_engine.rules_content_fingerprint`, the same function
  that stamps a compiled guide's ``fingerprint``.
* **Audit events** — :func:`audit_style_guide_event` writes the ``style_guide.*`` actions
  into the existing hash-chained ``apiome.access_audit`` ledger (the same ledger the RBAC
  and quality-policy surfaces use, readable through ``GET /v1/access/{tenantSlug}/audit``),
  so create / edit / assign are visible next to every other governance change.

Everything here is **best-effort at the edges**: recording history, pinning a revision or
writing an audit row must never fail the governed action. Failures are logged and swallowed,
the same contract :mod:`app.quality_policy_routes` uses for its audit writes.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .policy_evaluate import (
    default_axis_gates,
    default_ci_outcomes,
    default_required_coverage,
    rules_snapshot_from_rows,
)
from .style_guide_engine import rules_content_fingerprint

logger = logging.getLogger(__name__)

__all__ = [
    "CHANGE_CREATED",
    "CHANGE_CUSTOM_RULES_CHANGED",
    "CHANGE_EDITED",
    "CHANGE_IMPORTED",
    "CHANGE_KINDS",
    "CHANGE_POLICY_CHANGED",
    "CHANGE_RULES_CHANGED",
    "audit_style_guide_event",
    "ensure_guide_revision",
    "guide_snapshot",
    "pin_guide_revision_id",
    "record_guide_revision",
    "resolve_guide_revision_id",
    "revision_rule_counts",
    "snapshot_fingerprint",
]

# --- Change vocabulary (mirrors the V236 CHECK constraint) ------------------------------

#: The guide was created (including "duplicate" / "start from Recommended").
CHANGE_CREATED = "created"
#: Identity changed: name, description or external lint profile.
CHANGE_EDITED = "edited"
#: The built-in rule catalog was saved (enable flags / severity overrides).
CHANGE_RULES_CHANGED = "rules_changed"
#: The custom-rule YAML document was saved.
CHANGE_CUSTOM_RULES_CHANGED = "custom_rules_changed"
#: Draft policy gates (axis gates / required coverage / CI outcomes) changed.
CHANGE_POLICY_CHANGED = "policy_changed"
#: Rules arrived from an external ruleset import (GOV-1.5).
CHANGE_IMPORTED = "imported"

#: Every accepted change kind, in the order they appear above.
CHANGE_KINDS = (
    CHANGE_CREATED,
    CHANGE_EDITED,
    CHANGE_RULES_CHANGED,
    CHANGE_CUSTOM_RULES_CHANGED,
    CHANGE_POLICY_CHANGED,
    CHANGE_IMPORTED,
)

# --- Audit actions ----------------------------------------------------------------------

#: Action prefix every governance style-guide audit event shares, so the access-audit ledger
#: can be filtered down to guide governance alone.
AUDIT_PREFIX = "style_guide."

AUDIT_CREATED = f"{AUDIT_PREFIX}created"
AUDIT_UPDATED = f"{AUDIT_PREFIX}updated"
AUDIT_DELETED = f"{AUDIT_PREFIX}deleted"
AUDIT_RULES_UPDATED = f"{AUDIT_PREFIX}rules_updated"
AUDIT_CUSTOM_RULES_UPDATED = f"{AUDIT_PREFIX}custom_rules_updated"
AUDIT_POLICY_UPDATED = f"{AUDIT_PREFIX}policy_updated"
AUDIT_ASSIGNED = f"{AUDIT_PREFIX}assigned"
AUDIT_UNASSIGNED = f"{AUDIT_PREFIX}unassigned"


# --- Snapshots --------------------------------------------------------------------------


def _canonical_json(value: Any) -> str:
    """Canonical JSON for fingerprinting: sorted keys, no whitespace, stable ordering."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def guide_snapshot(
    guide: Mapping[str, Any], rules: Sequence[Mapping[str, Any]]
) -> Dict[str, Any]:
    """Project a live guide row plus its rule rows into the frozen revision snapshot.

    Args:
        guide: A ``style_guides`` row (``name`` / ``description`` / ``external_lint_profile``
            and the V169 draft gate columns).
        rules: The guide's ``style_guide_rules`` rows.

    Returns:
        ``{"name", "description", "external_lint_profile", "rules", "policy"}`` — exactly the
        columns :func:`record_guide_revision` stores, with the policy gates normalized to
        their documented defaults so a ``NULL`` column and an explicitly-saved default are
        the same snapshot (and therefore not a spurious revision).
    """
    return {
        "name": str(guide.get("name") or ""),
        "description": guide.get("description"),
        "external_lint_profile": guide.get("external_lint_profile") or "baseline",
        "rules": rules_snapshot_from_rows(rules),
        "policy": {
            "axisGates": default_axis_gates(guide.get("axis_gates")),
            "requiredCoverage": list(
                default_required_coverage(guide.get("required_coverage"))
            ),
            "ciOutcomes": default_ci_outcomes(guide.get("ci_outcomes")),
        },
    }


def snapshot_fingerprint(snapshot: Mapping[str, Any]) -> str:
    """SHA-256 hex over a whole guide snapshot — the no-op-edit detector.

    Distinct from the revision's ``content_fingerprint``, which covers the rule rows alone so
    it can be compared against a compiled guide. This one covers identity and policy gates
    too: two revisions may share rule content (a rename changes nothing a linter sees) but
    still be different revisions.
    """
    return hashlib.sha256(_canonical_json(snapshot).encode("utf-8")).hexdigest()


# --- Recording --------------------------------------------------------------------------


def _load_guide_state(guide_id: str, tenant_id: str):
    """Read the live guide row + rule rows, or ``(None, [])`` when the guide is gone."""
    from .database import db  # Lazy: keeps this module importable without a DB layer.

    guide = db.get_style_guide_by_id(guide_id, tenant_id)
    if not isinstance(guide, dict) or not guide.get("id"):
        return None, []
    rules = db.get_style_guide_rules(str(guide["id"]), tenant_id)
    return guide, (rules if isinstance(rules, list) else [])


def record_guide_revision(
    guide_id: str,
    tenant_id: str,
    *,
    change_kind: str,
    actor_user_id: Optional[str] = None,
    actor_label: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Append an immutable revision capturing the guide's **current** state.

    Call this *after* a mutation has been committed — it snapshots what the guide is now.
    A snapshot identical to the guide's newest revision appends nothing and returns that
    revision, so re-saving an unchanged editor tab does not inflate the history.

    Args:
        guide_id: The guide to snapshot.
        tenant_id: The tenant that owns it.
        change_kind: One of :data:`CHANGE_KINDS`; anything else is recorded as
            :data:`CHANGE_EDITED` rather than violating the DB constraint.
        actor_user_id: The acting user id, when a user session made the change.
        actor_label: Human-readable actor label (email / username).

    Returns:
        The revision row (new or the identical existing one), or ``None`` when the guide does
        not exist or the write failed. Never raises.
    """
    try:
        from .database import db

        guide, rules = _load_guide_state(guide_id, tenant_id)
        if guide is None:
            return None
        snapshot = guide_snapshot(guide, rules)
        snap_fp = snapshot_fingerprint(snapshot)

        latest = db.get_latest_style_guide_revision(str(guide["id"]), tenant_id)
        if latest and str(latest.get("snapshot_fingerprint") or "") == snap_fp:
            return latest

        return db.insert_style_guide_revision(
            guide_id=str(guide["id"]),
            tenant_id=tenant_id,
            change_kind=(
                change_kind if change_kind in CHANGE_KINDS else CHANGE_EDITED
            ),
            name=snapshot["name"],
            description=snapshot["description"],
            external_lint_profile=snapshot["external_lint_profile"],
            rules=snapshot["rules"],
            policy=snapshot["policy"],
            content_fingerprint=rules_content_fingerprint(snapshot["rules"]),
            snapshot_fingerprint=snap_fp,
            actor_user_id=actor_user_id,
            actor_label=actor_label,
        )
    except Exception:  # noqa: BLE001 - history capture never fails the governed action
        logger.warning(
            "Failed to record style-guide revision for guide %s (%s)",
            guide_id,
            change_kind,
            exc_info=True,
        )
        return None


def ensure_guide_revision(
    guide_id: str,
    tenant_id: str,
    *,
    actor_user_id: Optional[str] = None,
    actor_label: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Capture the guide's current state as a revision when it is not already recorded.

    The self-healing counterpart of :func:`record_guide_revision`, called **before** an edit
    and on every read of a guide's history:

    * a guide with no revisions (created before GOV-1.6, or seeded by SQL) gets its current
      state as revision 1, kind :data:`CHANGE_CREATED`;
    * a guide whose newest revision no longer matches its live content — some writer changed
      it without recording — gets that drift captured as :data:`CHANGE_EDITED`;
    * a guide already in sync is left alone and its newest revision is returned.

    Because every edit path calls this first, the state *before* an edit is always in the
    history, even for guides that predate this feature.

    Args:
        guide_id: The guide to capture.
        tenant_id: The tenant that owns it.
        actor_user_id: Actor for a genuinely new capture (``None`` for system captures).
        actor_label: Actor label for a genuinely new capture.

    Returns:
        The guide's newest revision after the call, or ``None``. Never raises.
    """
    try:
        from .database import db

        guide, rules = _load_guide_state(guide_id, tenant_id)
        if guide is None:
            return None
        snapshot = guide_snapshot(guide, rules)
        snap_fp = snapshot_fingerprint(snapshot)

        latest = db.get_latest_style_guide_revision(str(guide["id"]), tenant_id)
        if latest and str(latest.get("snapshot_fingerprint") or "") == snap_fp:
            return latest

        return db.insert_style_guide_revision(
            guide_id=str(guide["id"]),
            tenant_id=tenant_id,
            change_kind=CHANGE_CREATED if not latest else CHANGE_EDITED,
            name=snapshot["name"],
            description=snapshot["description"],
            external_lint_profile=snapshot["external_lint_profile"],
            rules=snapshot["rules"],
            policy=snapshot["policy"],
            content_fingerprint=rules_content_fingerprint(snapshot["rules"]),
            snapshot_fingerprint=snap_fp,
            actor_user_id=actor_user_id,
            actor_label=actor_label or (None if actor_user_id else "system"),
        )
    except Exception:  # noqa: BLE001 - capture never fails the caller
        logger.warning(
            "Failed to ensure style-guide revision for guide %s", guide_id, exc_info=True
        )
        return None


# --- Lint-result pinning ----------------------------------------------------------------


def pin_guide_revision_id(guide: Any, tenant_id: str) -> Optional[str]:
    """Return the revision id a lint run under ``guide`` should be pinned to.

    Args:
        guide: The :class:`~app.style_guide_engine.CompiledStyleGuide` the run scored under.
            The in-code fallback guide carries no ``guide_id`` and pins to nothing — there is
            no stored guide to have a revision of.
        tenant_id: The tenant the run belongs to.

    Returns:
        A ``style_guide_revisions.id``, or ``None`` when the run was not governed by a stored
        guide or the revision could not be resolved. Never raises.
    """
    guide_id = getattr(guide, "guide_id", None)
    fingerprint = getattr(guide, "fingerprint", None)
    if not guide_id or not fingerprint:
        return None
    try:
        from .database import db

        row = db.get_style_guide_revision_by_content(
            str(guide_id), tenant_id, str(fingerprint)
        )
        if row:
            return str(row["id"])
        # No revision has this rule content yet: the guide changed without being recorded
        # (or predates GOV-1.6). Capture it now, so this run still pins to real, immutable
        # content rather than to nothing.
        captured = ensure_guide_revision(str(guide_id), tenant_id)
        if captured and str(captured.get("content_fingerprint") or "") == str(fingerprint):
            return str(captured["id"])
        return None
    except Exception:  # noqa: BLE001 - pinning never breaks a lint run
        logger.warning(
            "Failed to pin guide revision for guide %s", guide_id, exc_info=True
        )
        return None


def resolve_guide_revision_id(
    tenant_id: str, project_id: Optional[str] = None
) -> Optional[str]:
    """Resolve the assigned guide for a lint run and return its pinned revision id.

    The one-call form for persistence seams that have a tenant (and maybe a project) but no
    compiled guide in hand — the import/score capture path in :mod:`app.database`.

    Args:
        tenant_id: The tenant whose guide chain applies.
        project_id: The owning project, when known.

    Returns:
        A ``style_guide_revisions.id`` or ``None``. Never raises.
    """
    try:
        from .style_guide_engine import resolve_style_guide

        return pin_guide_revision_id(resolve_style_guide(tenant_id, project_id), tenant_id)
    except Exception:  # noqa: BLE001 - pinning never breaks scoring
        logger.warning(
            "Failed to resolve guide revision for tenant %s (project %s)",
            tenant_id,
            project_id,
            exc_info=True,
        )
        return None


# --- Audit ------------------------------------------------------------------------------


def audit_style_guide_event(
    *,
    tenant_id: str,
    action: str,
    actor_user_id: Optional[str] = None,
    actor_label: Optional[str] = None,
    target: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    """Write one governance audit row for a style-guide change (best-effort).

    Appends to the hash-chained ``apiome.access_audit`` ledger rather than a governance-only
    table: a compliance reviewer reads one ledger, and the ``style_guide.`` action prefix
    filters it down to guide governance. Audit failures are logged and swallowed — a guide
    change that succeeded must never be reported as a failure because its audit row could not
    be appended.

    Args:
        tenant_id: The tenant the change belongs to.
        action: One of the ``AUDIT_*`` constants in this module.
        actor_user_id: The acting user id, when known.
        actor_label: Human-readable actor label (email / username).
        target: The affected object — the guide id, or ``guideId:projectId`` for assignments.
        detail: Structured, non-secret context stored as JSON alongside the row.
    """
    try:
        from .database import db

        db.write_access_audit(
            tenant_id=tenant_id,
            action=action,
            actor_id=actor_user_id,
            actor_label=actor_label,
            target=target,
            source="api",
            detail=detail,
        )
    except Exception:  # noqa: BLE001 - auditing never fails the governed action
        logger.warning(
            "Failed to audit %s for tenant %s", action, tenant_id, exc_info=True
        )


def revision_rule_counts(rules: Sequence[Mapping[str, Any]]) -> Dict[str, int]:
    """Rollup counts for a revision's rule snapshot (list-view columns).

    Args:
        rules: The revision's frozen rule rows.

    Returns:
        ``{"rule_count", "enabled_rule_count", "custom_rule_count"}``.
    """
    rows: List[Mapping[str, Any]] = [r for r in rules if isinstance(r, Mapping)]
    return {
        "rule_count": len(rows),
        "enabled_rule_count": sum(1 for r in rows if r.get("enabled")),
        "custom_rule_count": sum(1 for r in rows if r.get("custom_def") is not None),
    }
