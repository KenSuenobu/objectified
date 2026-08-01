"""Super-admin REST CRUD for OAuth provider config (OLO-8.4, #4970).

Server-scoped (NOT tenant-scoped) endpoints over the ``auth_provider_config`` table (V196,
OLO-8.2) that let a super-admin read and edit sign-in provider configuration — the surface the
admin UI (OLO-8.7) and the per-request merge resolver (OLO-8.5) build on:

* ``GET /v1/admin/auth-providers`` — list every registry provider with its stored config,
  **secrets masked** (only a "set / not set" flag), and, per field, whether it currently falls
  back to env (no DB value) or is DB-sourced.
* ``PUT /v1/admin/auth-providers/{provider_id}`` — set ``enabled``, ``client_id``, an optional
  write-only ``client_secret`` (sealed at rest via OLO-8.3), and the ``config`` JSONB extras.
* ``DELETE /v1/admin/auth-providers/{provider_id}`` — drop the whole stored row so the provider
  reverts to env-only governance (OLO-8.5). Distinct from clearing fields one at a time via PUT:
  it leaves no row behind, and it destroys the sealed secret irrecoverably.

Security invariants (issue acceptance criteria):

* **Gated server-side.** Every route depends on :func:`require_super_admin`, which verifies the
  same HMAC-signed super-admin session the ``/admin`` portal mints (OLO-8.1) — a client cannot
  self-assert admin. A caller with no session gets ``401``; one with an invalid/expired/forged
  session gets ``403``.
* **Secrets are never returned.** No response — GET or PUT — carries a decrypted (or encrypted)
  client secret. The stored ciphertext is not even read out of the DB (the data layer omits it);
  the surface reports only ``secret_set``.
* **Write-only secret.** ``client_secret`` is accepted on PUT, sealed via OLO-8.3, and stored; it
  is never echoed back.
* **Validated enablement.** A ``provider_id`` outside the registry is ``404``; enabling a provider
  that is missing a required field (``client_id`` / ``client_secret``), or a ``coming-soon``
  provider that can never be enabled, is rejected with a structured ``422`` error.

``enabled`` semantics (per V196): ``enabled = true`` in the DB is an *explicit override* — "force
this provider on with the DB creds" — so it must carry complete DB creds, and the completeness gate
enforces that on any write whose effective state is ``enabled = true`` (including clearing a required
field while enabled). ``enabled = null`` means "use env-derived enablement" (OLO-8.5); an operator
wanting env fallback leaves ``enabled`` null rather than forcing it true.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from .admin_session import verify_admin_session_token
from .auth_provider_registry import (
    FIELD_KIND_CLIENT_ID,
    FIELD_KIND_CLIENT_SECRET,
    FIELD_KIND_CONFIG,
    PROVIDER_REGISTRY,
    STATUS_AVAILABLE,
    ProviderDescriptor,
    get_provider_descriptor,
)
from .auth_provider_secret_crypto import (
    AuthConfigEncryptionError,
    provider_secret_encryption_configured,
    seal_provider_secret,
)
from .database import db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/admin/auth-providers", tags=["admin-auth-providers"])

# Per-field provenance flags on the response: whether a field's effective value comes from the DB
# row or falls back to env (OLO-8.5) because the DB has no value for it.
SOURCE_DB = "db"
SOURCE_ENV_FALLBACK = "env-fallback"


# ---------------------------------------------------------------------------
# Super-admin gate
# ---------------------------------------------------------------------------


def require_super_admin(
    admin_session: Optional[str] = Cookie(default=None),
    x_admin_session: Optional[str] = Header(default=None, alias="X-Admin-Session"),
) -> None:
    """FastAPI dependency: allow the request only for a verified super-admin session.

    The signed session token (OLO-8.1) is read from the ``admin_session`` cookie or, for
    server-to-server callers that cannot forward cookies, an ``X-Admin-Session`` header (the cookie
    wins when both are present). It is verified server-side by :func:`verify_admin_session_token`
    against the shared signing key — a token this server did not mint, or one that has expired, is
    rejected.

    Args:
        admin_session: Value of the ``admin_session`` cookie, if present.
        x_admin_session: Value of the ``X-Admin-Session`` header, if present.

    Raises:
        HTTPException: ``401`` when no session credential is presented at all; ``403`` when one is
            presented but fails verification (bad signature, expired, malformed, or no signing key
            configured — the surface fails closed).
    """
    token = admin_session or x_admin_session
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Super-admin authentication required.",
        )
    if not verify_admin_session_token(token):
        raise HTTPException(
            status_code=403,
            detail="Invalid or expired super-admin session.",
        )


# ---------------------------------------------------------------------------
# Response / request models
# ---------------------------------------------------------------------------


class ProviderConfigView(BaseModel):
    """One provider's masked configuration — the shape both GET and PUT return.

    Never carries a secret value: ``secret_set`` reports only whether a secret is stored.
    """

    provider_id: str = Field(..., description="Provider slug (e.g. 'github').")
    label: str = Field(..., description="Human-readable provider name.")
    status: str = Field(
        ..., description="Registry lifecycle: 'available' or 'coming-soon'."
    )

    enabled: Optional[bool] = Field(
        None,
        description=(
            "Explicit enable toggle from the DB. null ⇒ no DB value; enablement is env-derived "
            "(OLO-8.5)."
        ),
    )
    enabled_source: str = Field(
        ..., description="'db' when the enable toggle is stored, else 'env-fallback'."
    )

    client_id: Optional[str] = Field(
        None, description="OAuth client id from the DB; null when it falls back to env."
    )
    client_id_source: str = Field(
        ..., description="'db' when a client id is stored, else 'env-fallback'."
    )

    secret_set: bool = Field(
        ...,
        description="Whether a client secret is stored (encrypted). The secret itself is never returned.",
    )
    secret_source: str = Field(
        ..., description="'db' when a secret is stored, else 'env-fallback'."
    )

    config: Dict[str, Any] = Field(
        default_factory=dict,
        description="Non-secret provider extras (JSONB); empty object when none are stored.",
    )

    required_fields: List[str] = Field(
        default_factory=list,
        description="Fields that must be present for this provider to be enabled (empty for coming-soon).",
    )
    missing_for_enable: List[str] = Field(
        default_factory=list,
        description="Required fields not yet satisfied by the DB row; enabling is blocked while non-empty.",
    )
    can_enable: bool = Field(
        ...,
        description="True when the provider is 'available' and all required fields are present in the DB.",
    )

    updated_at: Optional[datetime] = Field(
        None, description="When the row was last changed; null when no row exists."
    )
    updated_by: Optional[str] = Field(
        None, description="Super-admin who last changed the row; null when no row exists."
    )


class ProviderConfigListResponse(BaseModel):
    """Payload of ``GET /v1/admin/auth-providers``."""

    providers: List[ProviderConfigView] = Field(default_factory=list)


class ProviderConfigUpdateRequest(BaseModel):
    """Body of ``PUT /v1/admin/auth-providers/{provider_id}`` — a partial update.

    Every field is optional and interpreted by **presence** (``model_fields_set``), so the admin UI
    can change one field without disturbing the others:

    * a field **omitted** from the body is left exactly as stored;
    * a field sent as ``null`` (or, for the string fields, blank) is **cleared** — the provider then
      falls back to env for it (OLO-8.5);
    * ``client_secret`` is **write-only**: a non-blank value is sealed (OLO-8.3) and stored; ``null``
      / blank clears the stored secret; omitting it leaves the stored secret untouched. It is never
      returned in any response.
    """

    model_config = {"extra": "forbid"}

    enabled: Optional[bool] = Field(
        None, description="Enable toggle; null clears it (enablement becomes env-derived)."
    )
    client_id: Optional[str] = Field(
        None, description="OAuth client id; null/blank clears it (falls back to env)."
    )
    client_secret: Optional[str] = Field(
        None,
        description="Write-only OAuth client secret; sealed and stored. null/blank clears it. Never returned.",
    )
    config: Optional[Dict[str, Any]] = Field(
        None, description="Non-secret provider extras (JSONB); null clears them to an empty object."
    )


# ---------------------------------------------------------------------------
# Required-field completeness
# ---------------------------------------------------------------------------


def _config_value_present(config: Any, key: str) -> bool:
    """Whether ``config[key]`` is a stored, non-blank string.

    A ``config``-kind required field (e.g. an OIDC ``issuer``, OLO-9.1) is satisfied only by a
    non-blank JSONB value — a blank string is treated as absent, matching the UI's "blank ⇒
    fallback, not set" rule (OLO-8.5).

    Args:
        config: The stored ``config`` JSONB (any value; only a dict can carry the key).
        key: The env-var-named key to read (e.g. ``OKTA_ISSUER``).

    Returns:
        True when a non-blank string is stored under ``key``.
    """
    if not isinstance(config, dict):
        return False
    value = config.get(key)
    return isinstance(value, str) and value.strip() != ""


def _missing_required_fields(
    descriptor: ProviderDescriptor,
    *,
    client_id: Any,
    secret_set: bool,
    config: Any,
) -> List[str]:
    """Semantic names of the required fields not satisfied by an effective config state.

    Generalizes completeness beyond ``client_id`` / ``client_secret`` (OLO-9.1): each required
    field is checked at the DB location its ``kind`` names — the ``client_id`` column, the sealed
    secret, or a key in the ``config`` JSONB — so an issuer-based provider names its missing issuer
    just as a classic provider names a missing client id/secret. ``coming-soon`` providers have no
    required fields and so yield an empty list.

    Args:
        descriptor: The provider's registry entry.
        client_id: The effective client id (column value), or a falsy value when absent.
        secret_set: Whether a client secret is effectively stored.
        config: The effective ``config`` JSONB.

    Returns:
        The missing fields' semantic names, in the descriptor's field order.
    """
    missing: List[str] = []
    for req in descriptor.required_fields:
        if req.kind == FIELD_KIND_CLIENT_ID:
            present = bool(client_id)
        elif req.kind == FIELD_KIND_CLIENT_SECRET:
            present = bool(secret_set)
        elif req.kind == FIELD_KIND_CONFIG:
            present = _config_value_present(config, req.env_key)
        else:  # Unknown kind — treat as unsatisfiable so a registry typo fails closed.
            present = False
        if not present:
            missing.append(req.field)
    return missing


# ---------------------------------------------------------------------------
# View construction
# ---------------------------------------------------------------------------


def _provider_view(
    descriptor: ProviderDescriptor, row: Optional[Dict[str, Any]]
) -> ProviderConfigView:
    """Project a registry descriptor + its (optional) stored row into a masked view.

    The secret is reported only as a presence flag: ``secret_set`` is derived from ``enc_key_id``
    (non-null exactly when a secret is stored, per the V196 both-or-neither invariant), and the
    ciphertext is never read from the DB in the first place.

    Args:
        descriptor: The registry entry (id, label, status, required fields).
        row: The stored ``auth_provider_config`` row (read columns only), or ``None`` when the
            provider has no row and is governed entirely by env.

    Returns:
        The masked, env-fallback-annotated view for this provider.
    """
    row = row or {}
    enabled = row.get("enabled")
    client_id = row.get("client_id")
    secret_set = row.get("enc_key_id") is not None
    config = row.get("config") or {}

    # Which required fields are NOT yet satisfied by the DB row (only meaningful for available
    # providers; coming-soon providers have no required fields and can never be enabled).
    missing: List[str] = (
        _missing_required_fields(
            descriptor, client_id=client_id, secret_set=secret_set, config=config
        )
        if descriptor.status == STATUS_AVAILABLE
        else []
    )

    # Generic OIDC (OLO-9.6): operator-set OIDC_DISPLAY_NAME overrides the admin card title.
    label = descriptor.label
    if descriptor.id == "oidc":
        display = config.get("OIDC_DISPLAY_NAME")
        if isinstance(display, str) and display.strip():
            label = display.strip()

    return ProviderConfigView(
        provider_id=descriptor.id,
        label=label,
        status=descriptor.status,
        enabled=enabled,
        enabled_source=SOURCE_DB if enabled is not None else SOURCE_ENV_FALLBACK,
        client_id=client_id,
        client_id_source=SOURCE_DB if client_id else SOURCE_ENV_FALLBACK,
        secret_set=secret_set,
        secret_source=SOURCE_DB if secret_set else SOURCE_ENV_FALLBACK,
        config=config,
        required_fields=descriptor.required_field_names(),
        missing_for_enable=missing,
        can_enable=descriptor.status == STATUS_AVAILABLE and not missing,
        updated_at=row.get("updated_at"),
        updated_by=row.get("updated_by"),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "",
    response_model=ProviderConfigListResponse,
    responses={
        401: {"description": "No super-admin session presented."},
        403: {"description": "Super-admin session invalid or expired."},
    },
)
async def list_auth_providers(
    _: None = Depends(require_super_admin),
) -> ProviderConfigListResponse:
    """List every registry provider with its masked stored config (OLO-8.4).

    One entry per known provider (including ``coming-soon`` placeholders), in registry display
    order, overlaying any stored row. Secrets are never included — each entry reports only
    ``secret_set`` and, per field, whether it is DB-sourced or falls back to env.

    Returns:
        The provider list. Providers with no stored row are reported entirely as env-fallback.
    """
    rows_by_id = {row["provider_id"]: row for row in db.list_auth_provider_config()}
    providers = [
        _provider_view(descriptor, rows_by_id.get(descriptor.id))
        for descriptor in PROVIDER_REGISTRY
    ]
    return ProviderConfigListResponse(providers=providers)


@router.put(
    "/{provider_id}",
    response_model=ProviderConfigView,
    responses={
        401: {"description": "No super-admin session presented."},
        403: {"description": "Super-admin session invalid or expired."},
        404: {"description": "Unknown provider id (not in the registry)."},
        422: {"description": "Enabling a provider that is coming-soon or missing required fields."},
        503: {"description": "A secret was supplied but secret encryption is not configured."},
    },
)
async def update_auth_provider(
    provider_id: str,
    payload: ProviderConfigUpdateRequest,
    _: None = Depends(require_super_admin),
) -> ProviderConfigView:
    """Create or update one provider's config (OLO-8.4).

    Applies a partial update (see :class:`ProviderConfigUpdateRequest`): omitted fields are left
    as stored, explicitly-null fields are cleared to env-fallback, and a non-blank ``client_secret``
    is sealed (OLO-8.3) and stored write-only. When the effective post-write state has the provider
    ``enabled``, required-field completeness is enforced first — an incomplete or ``coming-soon``
    provider is rejected with a structured ``422`` before anything is written.

    Args:
        provider_id: Provider slug from the path; must exist in the registry.
        payload: The partial update.

    Returns:
        The provider's masked view after the write (never carrying the secret).

    Raises:
        HTTPException: ``404`` unknown provider; ``422`` incomplete/ineligible enablement;
            ``503`` when a secret is supplied but encryption is unconfigured.
    """
    descriptor = get_provider_descriptor(provider_id)
    if descriptor is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown auth provider: {provider_id!r}.",
        )

    provided = payload.model_fields_set
    updates: Dict[str, Any] = {}

    if "enabled" in provided:
        updates["enabled"] = payload.enabled

    if "client_id" in provided:
        client_id = payload.client_id.strip() if payload.client_id else None
        updates["client_id"] = client_id or None

    if "config" in provided:
        # config is NOT NULL in V196; clearing it (null) means "no overrides" ⇒ empty object.
        updates["config"] = payload.config if payload.config is not None else {}

    if "client_secret" in provided:
        secret = payload.client_secret.strip() if payload.client_secret else ""
        if secret:
            if not provider_secret_encryption_configured():
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "encryption_not_configured",
                        "provider_id": provider_id,
                        "message": (
                            "Cannot store a client secret: provider-secret encryption is not "
                            "configured. Set AUTH_CONFIG_ENC_KEY (OLO-8.3) and retry."
                        ),
                    },
                )
            try:
                blob, key_id = seal_provider_secret(secret)
            except AuthConfigEncryptionError as exc:
                # Secret-free message: seal_provider_secret never echoes the plaintext.
                logger.warning(
                    "failed to seal client secret for provider %s: %s", provider_id, exc
                )
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "encryption_not_configured",
                        "provider_id": provider_id,
                        "message": (
                            "Cannot store a client secret: provider-secret encryption is "
                            "misconfigured. Check AUTH_CONFIG_ENC_KEY (OLO-8.3)."
                        ),
                    },
                ) from exc
            # The ciphertext and its key id travel together (V196 both-or-neither CHECK).
            updates["client_secret_encrypted"] = blob
            updates["enc_key_id"] = key_id
        else:
            # Explicit null/blank secret ⇒ clear the stored secret (fall back to env). Both columns
            # move to NULL together to satisfy the both-or-neither CHECK.
            updates["client_secret_encrypted"] = None
            updates["enc_key_id"] = None

    # Completeness gate: enforce required fields against the EFFECTIVE post-write state before we
    # write anything, so a rejected enable leaves the stored config untouched.
    existing = db.get_auth_provider_config(provider_id) or {}
    _guard_enable_completeness(descriptor, existing, updates)

    row = db.upsert_auth_provider_config(provider_id, updates, updated_by="admin")
    return _provider_view(descriptor, row)


@router.delete(
    "/{provider_id}",
    response_model=ProviderConfigView,
    responses={
        401: {"description": "No super-admin session presented."},
        403: {"description": "Super-admin session invalid or expired."},
        404: {"description": "Unknown provider id (not in the registry)."},
    },
)
async def delete_auth_provider(
    provider_id: str,
    _: None = Depends(require_super_admin),
) -> ProviderConfigView:
    """Remove one provider's stored configuration entirely (OLO-8.7).

    Drops the whole ``auth_provider_config`` row, returning the provider to env-only governance
    (OLO-8.5) as if it had never been configured — including its ``enabled`` override, so sign-in
    enablement is once again derived from the environment. **The sealed client secret is destroyed
    with the row and cannot be recovered**; re-configuring the provider means re-entering it.

    Deleting is **idempotent**: a provider with no stored row is already in the requested end
    state, so it succeeds rather than 404ing. The ``404`` is reserved for a slug that is not in the
    registry at all, matching PUT — that is a caller error, not an absent row.

    Returns the provider's post-delete view (rather than ``204``) for two reasons: it matches what
    PUT returns, so the admin UI can swap one view for another without a re-fetch; and an empty
    ``204`` body would force every JSON-parsing client on the path — notably the apiome-ui proxy —
    to special-case this route.

    Args:
        provider_id: Provider slug from the path; must exist in the registry.

    Returns:
        The provider's masked view after removal — every field reported as env-fallback.

    Raises:
        HTTPException: ``404`` when the provider id is not in the registry.
    """
    descriptor = get_provider_descriptor(provider_id)
    if descriptor is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown auth provider: {provider_id!r}.",
        )

    deleted = db.delete_auth_provider_config(provider_id)
    if deleted:
        # Audit trail for a destructive, non-recoverable change. Secret-free by construction.
        logger.info(
            "super-admin removed stored auth-provider config for %s (sealed secret destroyed)",
            provider_id,
        )

    # No row now exists, so the view is built from the descriptor alone: pure env-fallback.
    return _provider_view(descriptor, None)


def _guard_enable_completeness(
    descriptor: ProviderDescriptor,
    existing: Dict[str, Any],
    updates: Dict[str, Any],
) -> None:
    """Reject an enablement whose effective post-write state is ineligible or incomplete.

    Computes what each relevant field will be after ``updates`` are applied over ``existing``, and
    — only when the result has the provider ``enabled`` — verifies the provider is ``available`` and
    every required field is present at the DB location its kind names (the ``client_id`` column, the
    sealed secret, or a ``config`` JSONB key such as an OIDC ``issuer`` — OLO-9.1). A failure raises
    a structured ``422`` and no write occurs.

    Args:
        descriptor: The provider's registry entry.
        existing: The currently-stored row (empty dict when none).
        updates: The columns about to be written (from the request).

    Raises:
        HTTPException: ``422`` with a structured body when the enablement is ineligible/incomplete.
    """
    effective_enabled = (
        updates["enabled"] if "enabled" in updates else existing.get("enabled")
    )
    if effective_enabled is not True:
        return  # Not being enabled — nothing to validate.

    if descriptor.status != STATUS_AVAILABLE:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "provider_not_available",
                "provider_id": descriptor.id,
                "status": descriptor.status,
                "message": (
                    f"Provider {descriptor.id!r} is {descriptor.status} and cannot be enabled; "
                    "no sign-in integration exists for it yet."
                ),
            },
        )

    effective_client_id = (
        updates["client_id"] if "client_id" in updates else existing.get("client_id")
    )
    if "client_secret_encrypted" in updates:
        effective_secret_set = updates["client_secret_encrypted"] is not None
    else:
        effective_secret_set = existing.get("enc_key_id") is not None
    # config-kind required fields (e.g. an OIDC issuer, OLO-9.1) are checked against the effective
    # JSONB: the update's config when it sets one, else the stored config.
    effective_config = (
        updates["config"] if "config" in updates else existing.get("config")
    ) or {}

    missing = _missing_required_fields(
        descriptor,
        client_id=effective_client_id,
        secret_set=effective_secret_set,
        config=effective_config,
    )

    if missing:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "provider_incomplete",
                "provider_id": descriptor.id,
                "missing_fields": missing,
                "message": (
                    f"Cannot enable {descriptor.id!r}: missing required "
                    f"{'field' if len(missing) == 1 else 'fields'} {', '.join(missing)}. "
                    "Set them (or the corresponding env vars) before enabling."
                ),
            },
        )
