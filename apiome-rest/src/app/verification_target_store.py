"""Persistence and selection for verification targets — ECA-1.2 (#4730).

:mod:`app.verification_target` defines *what* a target is; this module is the only place one is
read, written, or **resolved**, so the registry's three guarantees are applied once rather than at
each call site:

**Every definition is validated before it is stored.** The URL goes through the SSRF policy, the
credential reference through its per-kind shape rules, and the policy through its cross-field
rules — so a target that the V211 CHECK constraints would reject never reaches the database, and
fails at the boundary with a stable code instead of an opaque driver error.

**Selection is audited, including refusals.** :func:`resolve_target` writes a
``target.resolve`` entry whether it succeeds or not — a run that used staging, a run that was
refused because the target was disabled, and a probe for a slug that does not exist all leave the
same kind of trace. The audit write is best-effort (a ledger hiccup must not fail the run it
records) but every failure is logged, matching :mod:`app.registry_audit`.

**Nothing here ever handles a secret.** The store moves a *reference*: an environment-variable
name the runner reads itself, or a credential-vault id the runner service unseals at request time.
There is no code path in this module that decrypts, fetches, or returns credential material.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional

from .database import db
from .verification_target import (
    AUTH_KIND_NONE,
    CODE_DISABLED,
    CODE_NOT_FOUND,
    CODE_POLICY_TLS_REQUIRED,
    CODE_PRIVATE_NOT_APPROVED,
    CODE_SLUG_TAKEN,
    NETWORK_CLASS_PRIVATE,
    ResolvedTarget,
    TargetValidationError,
    VerificationTargetInput,
    VerificationTargetPatch,
    VerificationTargetRecord,
    policy_violations,
    record_from_row,
    resolve_target_record,
    target_identity,
    validate_base_url,
    validate_slug,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ACTION_CREATE",
    "ACTION_DELETE",
    "ACTION_RESOLVE",
    "ACTION_UPDATE",
    "TARGET_AUDIT_ACTIONS",
    "TargetActor",
    "actor_from_auth",
    "create_target",
    "delete_target",
    "get_target",
    "list_audit",
    "list_targets",
    "resolve_target",
    "update_target",
]

# Audit verbs (stored verbatim in verification_target_audit.action; mirror the V211 CHECK).
ACTION_CREATE = "target.create"
ACTION_UPDATE = "target.update"
ACTION_DELETE = "target.delete"
ACTION_RESOLVE = "target.resolve"

#: Every action this module writes — used by the ledger endpoint's documentation and tests.
TARGET_AUDIT_ACTIONS = (ACTION_CREATE, ACTION_UPDATE, ACTION_DELETE, ACTION_RESOLVE)

OUTCOME_SUCCESS = "success"
OUTCOME_DENIED = "denied"
OUTCOME_FAILURE = "failure"

#: A caller authenticating with an API key is a CI runner; the ledger keeps them distinguishable
#: from an interactive user, which is what "only authorized users **and runners**" is about.
ACTOR_KIND_USER = "user"
ACTOR_KIND_API_KEY = "api_key"


@dataclass(frozen=True)
class TargetActor:
    """Who is acting on the registry, in the shape the audit ledger records.

    Attributes:
        user_id: The resolved acting user id, or ``None`` for an unattributable API-key call.
        label: Email or display name at the time of the action.
        kind: ``user`` for an interactive session, ``api_key`` for a CI runner.
    """

    user_id: Optional[str] = None
    label: Optional[str] = None
    kind: str = ACTOR_KIND_USER


def actor_from_auth(auth_data: Mapping[str, Any], user_id: Optional[str] = None) -> TargetActor:
    """Build a :class:`TargetActor` from a resolved auth context.

    Args:
        auth_data: The dict ``app.auth.validate_authentication`` produced.
        user_id: The id :func:`app.permissions.enforce_permission` resolved, when the caller
            already has it (it fills in the tenant's fallback creator for a legacy API key).

    Returns:
        The actor. An API-key caller is recorded as a runner even when a user id was resolvable,
        because what authenticated is the key.
    """
    is_key = auth_data.get("auth_method") == "api_key"
    resolved = user_id or auth_data.get("user_id")
    return TargetActor(
        user_id=str(resolved) if resolved else None,
        label=auth_data.get("user_email") or auth_data.get("user_name"),
        kind=ACTOR_KIND_API_KEY if is_key else ACTOR_KIND_USER,
    )


def _audit(
    *,
    tenant_id: str,
    action: str,
    outcome: str,
    actor: TargetActor,
    target_id: Optional[str] = None,
    target_slug: Optional[str] = None,
    reason: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    """Write one ledger entry, best-effort.

    The ledger records what happened; it must never be the reason something did not. Any failure
    is logged at warning and swallowed, exactly as :func:`app.registry_audit.record_registry_audit`
    does for the registry ledger.

    Args:
        tenant_id: Tenant the action happened in.
        action: One of the ``ACTION_*`` verbs.
        outcome: ``success`` | ``denied`` | ``failure``.
        actor: Who acted.
        target_id: The target acted on, when one was found.
        target_slug: The slug named, recorded even when nothing matched.
        reason: Stable code; required by the schema whenever the outcome is not success.
        detail: Non-secret context.
    """
    try:
        db.insert_verification_target_audit(
            tenant_id=tenant_id,
            action=action,
            outcome=outcome,
            target_id=target_id,
            target_slug=target_slug,
            reason=reason,
            actor_id=actor.user_id,
            actor_label=actor.label,
            actor_kind=actor.kind,
            detail=detail,
        )
    except Exception as exc:  # noqa: BLE001 - auditing is strictly best-effort
        logger.warning("verification-target audit (%s/%s) failed: %s", action, outcome, exc)


def _assert_policy_coherent(network_class: str, definition: Any) -> None:
    """Raise when a policy contradicts the target's network class.

    Args:
        network_class: The target's (possibly newly patched) network class.
        definition: Anything carrying a ``policy`` attribute.

    Raises:
        TargetValidationError: ``target-policy-tls-required`` when TLS verification is disabled
            on a target that is not an approved private one.
    """
    violations = policy_violations(network_class=network_class, policy=definition.policy)
    if violations:
        raise TargetValidationError(CODE_POLICY_TLS_REQUIRED, "; ".join(violations))


def _assert_private_approved(
    network_class: str, approval_reason: Optional[str], actor: TargetActor
) -> None:
    """Raise unless a private-network target has both a stated reason and an approver.

    V211 refuses to store the row without either, so checking here turns what would be an opaque
    constraint violation into a stable code. The approver is the authenticated caller — which is
    also why an unattributable credential cannot open an internal target: nobody would be
    accountable for it.

    Args:
        network_class: The target's network class.
        approval_reason: The supplied reason.
        actor: The acting principal, whose user id becomes the approver.

    Raises:
        TargetValidationError: ``target-private-not-approved``.
    """
    if network_class != NETWORK_CLASS_PRIVATE:
        return
    if not (approval_reason or "").strip():
        raise TargetValidationError(
            CODE_PRIVATE_NOT_APPROVED,
            "a target with network_class 'private' must state an approval_reason; the "
            "authenticated caller is recorded as its approver",
        )
    if not actor.user_id:
        raise TargetValidationError(
            CODE_PRIVATE_NOT_APPROVED,
            "a private-network target needs an identifiable approver; this credential "
            "resolves to no user",
        )


def list_targets(tenant_id: str) -> List[VerificationTargetRecord]:
    """Every live target defined in a tenant, newest first.

    Args:
        tenant_id: The caller's tenant.

    Returns:
        The records; empty when nothing is defined.
    """
    return [record_from_row(row) for row in db.list_verification_targets(tenant_id)]


def get_target(
    tenant_id: str, target_ref: str, *, include_deleted: bool = False
) -> VerificationTargetRecord:
    """Read one target by slug **or** id.

    Accepting both is what lets CI name a stable handle (``staging``) while an evidence row names
    an immutable id — the same endpoint answers either.

    Args:
        tenant_id: The caller's tenant.
        target_ref: The target's slug or its id.
        include_deleted: Resolve retired targets too (an id lookup for an evidence reference).

    Returns:
        The record.

    Raises:
        TargetValidationError: ``target-not-found`` when nothing matches in this tenant.
    """
    row = db.get_verification_target_by_slug(tenant_id, target_ref)
    if row is None:
        row = db.get_verification_target_by_id(
            target_ref, tenant_id, include_deleted=include_deleted
        )
    if row is None:
        raise TargetValidationError(
            CODE_NOT_FOUND, f"no verification target '{target_ref}' in this tenant"
        )
    return record_from_row(row)


def create_target(
    tenant_id: str, definition: VerificationTargetInput, *, actor: TargetActor
) -> VerificationTargetRecord:
    """Define a new target, validating it before anything is stored.

    Order matters: the slug shape, then the private-network approval, then the policy, then the
    URL (the only check that costs a DNS resolution), then the uniqueness read. A definition that
    is wrong in a cheap way never pays for the expensive check.

    Args:
        tenant_id: The caller's tenant.
        definition: The full definition.
        actor: Who is defining it; recorded as creator and, for a private target, approver.

    Returns:
        The stored record.

    Raises:
        TargetValidationError: with the code naming which rule failed.
    """
    slug = validate_slug(definition.slug)
    _assert_private_approved(definition.network_class, definition.approval_reason, actor)
    _assert_policy_coherent(definition.network_class, definition)
    base_url = validate_base_url(definition.base_url, definition.network_class)

    if db.get_verification_target_by_slug(tenant_id, slug) is not None:
        raise TargetValidationError(
            CODE_SLUG_TAKEN, f"a verification target '{slug}' already exists in this tenant"
        )

    is_private = definition.network_class == NETWORK_CLASS_PRIVATE
    row = db.insert_verification_target(
        tenant_id=tenant_id,
        slug=slug,
        name=definition.name,
        description=definition.description,
        environment=definition.environment,
        base_url=base_url,
        network_class=definition.network_class,
        approved_by=actor.user_id if is_private else None,
        approval_reason=definition.approval_reason if is_private else None,
        auth_kind=definition.auth.kind,
        auth_scheme=definition.auth.scheme,
        auth_ref=definition.auth.ref,
        auth_header_name=definition.auth.header_name,
        policy=definition.policy.model_dump(),
        enabled=definition.enabled,
        created_by=actor.user_id,
    )
    if row is None:
        raise TargetValidationError(
            CODE_NOT_FOUND, "no tenant context for this credential; cannot define a target"
        )

    record = record_from_row(row)
    _audit(
        tenant_id=tenant_id,
        action=ACTION_CREATE,
        outcome=OUTCOME_SUCCESS,
        actor=actor,
        target_id=record.id,
        target_slug=record.slug,
        detail={
            "environment": record.environment,
            "network_class": record.network_class,
            "auth_kind": record.auth.kind,
            "enabled": record.enabled,
        },
    )
    return record


def update_target(
    tenant_id: str,
    record: VerificationTargetRecord,
    patch: VerificationTargetPatch,
    *,
    actor: TargetActor,
) -> VerificationTargetRecord:
    """Apply a partial update to an existing target.

    The patch is validated against the *merged* result rather than against itself: moving a target
    to ``private`` and supplying the reason in the same request is one coherent change, and so is
    moving a private target back to ``public``, which re-runs the address check its URL previously
    skipped.

    Args:
        tenant_id: The caller's tenant.
        record: The current record (already read and authorized by the caller).
        patch: The changes.
        actor: Who is changing it.

    Returns:
        The updated record.

    Raises:
        TargetValidationError: with the code naming which rule failed.
    """
    if not patch.has_changes():
        return record
    changes = patch.model_dump(exclude_unset=True)

    network_class = patch.network_class or record.network_class
    approval_reason = (
        patch.approval_reason if "approval_reason" in changes else record.approval_reason
    )
    _assert_private_approved(network_class, approval_reason, actor)
    if patch.policy is not None:
        _assert_policy_coherent(network_class, patch)
    elif patch.network_class is not None:
        # The policy is unchanged but its meaning may have changed with the network class.
        _assert_policy_coherent(network_class, record)

    fields: Dict[str, Any] = {}
    for column in ("name", "description", "environment", "enabled"):
        if column in changes:
            fields[column] = changes[column]

    if patch.base_url is not None or patch.network_class is not None:
        fields["base_url"] = validate_base_url(
            patch.base_url if patch.base_url is not None else record.base_url, network_class
        )
    if patch.network_class is not None:
        fields["network_class"] = network_class

    became_private = network_class == NETWORK_CLASS_PRIVATE
    touch_approval = False
    if "approval_reason" in changes or patch.network_class is not None:
        fields["approval_reason"] = approval_reason if became_private else None
        fields["approved_by"] = actor.user_id if became_private else None
        touch_approval = became_private

    if patch.auth is not None:
        fields["auth_kind"] = patch.auth.kind
        fields["auth_scheme"] = patch.auth.scheme
        fields["auth_ref"] = patch.auth.ref
        fields["auth_header_name"] = patch.auth.header_name
    if patch.policy is not None:
        fields["policy"] = patch.policy.model_dump()

    row = db.update_verification_target(
        record.id,
        tenant_id,
        fields,
        updated_by=actor.user_id,
        touch_approval=touch_approval,
    )
    if row is None:
        raise TargetValidationError(
            CODE_NOT_FOUND, f"verification target '{record.slug}' is no longer available"
        )

    updated = record_from_row(row)
    _audit(
        tenant_id=tenant_id,
        action=ACTION_UPDATE,
        outcome=OUTCOME_SUCCESS,
        actor=actor,
        target_id=updated.id,
        target_slug=updated.slug,
        # Field *names* only: the ledger says what changed, never to what, so it can never become
        # a second copy of a reference someone would rather not broadcast.
        detail={
            "changed": sorted(fields.keys()),
            "environment": updated.environment,
            "network_class": updated.network_class,
        },
    )
    return updated


def delete_target(
    tenant_id: str, record: VerificationTargetRecord, *, actor: TargetActor
) -> bool:
    """Retire a target (soft delete), freeing its slug for reuse.

    Args:
        tenant_id: The caller's tenant.
        record: The target to retire.
        actor: Who is retiring it.

    Returns:
        True when a live target was retired; False when it was already gone.
    """
    deleted = db.soft_delete_verification_target(
        record.id, tenant_id, deleted_by=actor.user_id
    )
    if deleted:
        _audit(
            tenant_id=tenant_id,
            action=ACTION_DELETE,
            outcome=OUTCOME_SUCCESS,
            actor=actor,
            target_id=record.id,
            target_slug=record.slug,
            detail={"environment": record.environment},
        )
    return deleted


def resolve_target(
    tenant_id: str,
    target_ref: str,
    *,
    actor: TargetActor,
    suite_digest: Optional[str] = None,
) -> ResolvedTarget:
    """Select a target for a run — the audited moment a definition becomes traffic.

    Everything a list read tolerates is refused here: a retired target, a disabled one, and a URL
    that no longer satisfies its network class (DNS moves; a name that resolved publicly at
    definition time can point inward today). Success and refusal are both recorded, so the ledger
    answers "which target did this run use, and what was turned away" from the same place.

    Args:
        tenant_id: The caller's tenant.
        target_ref: The target's slug or id.
        actor: Who is selecting it — a user or a CI runner.
        suite_digest: The ECA-1.1 suite digest this run will execute, recorded on the audit entry
            so a target selection can be tied to the exact contract it was selected for.

    Returns:
        The :class:`~app.verification_target.ResolvedTarget` the runner executes against.

    Raises:
        TargetValidationError: ``target-not-found``, ``target-disabled``, or a URL code, each
            already written to the ledger before it is raised.
    """
    detail: Dict[str, Any] = {}
    if suite_digest:
        detail["suite_digest"] = suite_digest

    try:
        record = get_target(tenant_id, target_ref)
    except TargetValidationError as exc:
        _audit(
            tenant_id=tenant_id,
            action=ACTION_RESOLVE,
            outcome=OUTCOME_DENIED,
            actor=actor,
            target_slug=target_ref,
            reason=exc.code,
            detail=detail,
        )
        raise

    try:
        resolved = resolve_target_record(record)
    except TargetValidationError as exc:
        _audit(
            tenant_id=tenant_id,
            action=ACTION_RESOLVE,
            outcome=OUTCOME_DENIED if exc.code == CODE_DISABLED else OUTCOME_FAILURE,
            actor=actor,
            target_id=record.id,
            target_slug=record.slug,
            reason=exc.code,
            detail={**detail, "environment": record.environment},
        )
        raise

    _audit(
        tenant_id=tenant_id,
        action=ACTION_RESOLVE,
        outcome=OUTCOME_SUCCESS,
        actor=actor,
        target_id=record.id,
        target_slug=record.slug,
        detail={
            **detail,
            **target_identity(record),
            # The reference *kind* is useful ("this run authenticated"); the reference itself is
            # not recorded, so the ledger never points at where a secret is kept.
            "auth_kind": record.auth.kind or AUTH_KIND_NONE,
        },
    )
    return resolved


def list_audit(
    tenant_id: str, *, target_id: Optional[str] = None, limit: int = 100
) -> List[Dict[str, Any]]:
    """Read the audit ledger for a tenant, or for one target.

    Args:
        tenant_id: The caller's tenant.
        target_id: Restrict to one target's history.
        limit: Maximum entries (the store clamps to 1..500).

    Returns:
        The ledger rows, newest first.
    """
    return db.list_verification_target_audit(tenant_id, target_id=target_id, limit=limit)
