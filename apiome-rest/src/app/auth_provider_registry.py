"""Server-side OAuth provider registry for provider-config CRUD (OLO-8.4, #4970).

The canonical registry lives in the UI (``apiome-ui/lib/auth/provider-registry.ts``, OLO-2.3): it
names every sign-in provider this codebase knows about and each provider's status. The REST
provider-config surface (:mod:`app.auth_provider_config_routes`) needs the same facts server-side
to:

* **validate** a ``provider_id`` in ``PUT /v1/admin/auth-providers/{provider_id}`` against the
  known slugs (an unknown slug is a 404 — and the V196 table's own CHECK would reject it anyway),
* refuse to **enable** a ``coming-soon`` provider (no sign-in factory exists for it yet), and
* enforce **required-field completeness** before a provider is enabled.

This module is a small, deliberately-duplicated projection of that registry — REST cannot import
TypeScript, and the set of providers changes rarely (adding one is already a multi-surface edit,
per the UI registry's own doc). The slugs here MUST stay in lockstep with ``PROVIDER_REGISTRY`` in
the UI and with the ``auth_provider_config_provider_id_check`` CHECK in migration V196.

Required-field completeness (``required_fields``): to be *enabled* through the DB, a provider must
have every required field available in its stored row. Historically that is just ``client_id`` and
``client_secret``; issuer-based providers (Okta, Cognito, Keycloak, Auth0, generic OIDC — OLO-9.3–
9.7) additionally require an ``issuer``/``domain`` URL, expressed as a ``config``-kind required
field stored in the ``config`` JSONB (OLO-9.1). REST cannot see the UI process's env, so it
validates completeness against the DB row only — an operator enabling a provider supplies each
field there (the secret is write-only and sealed via OLO-8.3). A provider left with
``enabled = null`` is governed by env-derived enablement (OLO-8.5) and is not completeness-checked
here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

# Provider lifecycle, mirroring ``ProviderStatus`` in the UI registry:
#   * "available"   — implemented end-to-end; may be enabled once configured.
#   * "coming-soon" — advertised as a roadmap teaser; never enabled (no sign-in factory yet).
STATUS_AVAILABLE = "available"
STATUS_COMING_SOON = "coming-soon"

# Where a required field's value lives in the stored ``auth_provider_config`` row — the fact the
# completeness check needs to know which DB location proves a field present. Mirrors
# ``RequiredFieldKind`` in the UI registry (provider-registry.ts).
#   * FIELD_KIND_CLIENT_ID     — the ``client_id`` column.
#   * FIELD_KIND_CLIENT_SECRET — the sealed secret (``client_secret_encrypted``/``enc_key_id`` pair).
#   * FIELD_KIND_CONFIG        — a key inside the ``config`` JSONB extras (e.g. an OIDC ``issuer``).
FIELD_KIND_CLIENT_ID = "client_id"
FIELD_KIND_CLIENT_SECRET = "client_secret"
FIELD_KIND_CONFIG = "config"


@dataclass(frozen=True)
class RequiredField:
    """One field a provider requires to be enabled (OLO-9.1) — mirror of ``RequiredField`` in the
    UI registry (provider-registry.ts).

    Attributes:
        field: Semantic field name (``client_id``, ``client_secret``, ``issuer``, …) — the value
            surfaced in the admin completeness list, so it stays human-meaningful.
        kind: Which stored location proves the field present — one of :data:`FIELD_KIND_CLIENT_ID`,
            :data:`FIELD_KIND_CLIENT_SECRET`, or :data:`FIELD_KIND_CONFIG`.
        env_key: The env var this field maps to (used at boot on the UI side and by the OLO-8.5
            overlay). For a ``config``-kind field this is *also* its key inside the ``config`` JSONB
            (extras are env-var-keyed), which is what the DB completeness check reads.
    """

    field: str
    kind: str
    env_key: str


def client_credential_fields(
    client_id_env_key: str, client_secret_env_key: str
) -> Tuple[RequiredField, ...]:
    """The standard ``client_id`` + ``client_secret`` pair every OAuth provider requires.

    Issuer-based providers append ``config``-kind fields on top of this pair (OLO-9.1);
    ``coming-soon`` entries require nothing.

    Args:
        client_id_env_key: Env var holding the OAuth client id (e.g. ``GITHUB_ID``).
        client_secret_env_key: Env var holding the OAuth client secret (e.g. ``GITHUB_SECRET``).

    Returns:
        The two-field ``(client_id, client_secret)`` requirement tuple.
    """
    return (
        RequiredField("client_id", FIELD_KIND_CLIENT_ID, client_id_env_key),
        RequiredField("client_secret", FIELD_KIND_CLIENT_SECRET, client_secret_env_key),
    )


@dataclass(frozen=True)
class ProviderDescriptor:
    """One sign-in provider this codebase knows about (enabled or not).

    Attributes:
        id: Provider slug — matches the UI registry id, the value stored in
            ``external_auth_providers.provider``, and the V196 CHECK. Never rename an id.
        label: Human-readable name used on admin cards ("GitHub", "Microsoft").
        status: :data:`STATUS_AVAILABLE` or :data:`STATUS_COMING_SOON`.
        required_fields: Every field that must be present for the provider to be enabled, in order;
            empty for ``coming-soon`` providers (nothing can enable them). See :class:`RequiredField`.
    """

    id: str
    label: str
    status: str
    required_fields: Tuple[RequiredField, ...]

    def required_field_names(self) -> List[str]:
        """The semantic names of every required field, in order (the admin-facing ``required_fields``)."""
        return [f.field for f in self.required_fields]


# Every provider this codebase knows about, in display order — the server-side projection of
# ``PROVIDER_REGISTRY`` (provider-registry.ts). ``google`` is available (OLO-9.2, #4985); ``okta``
# is available (OLO-9.3, #4986) with an issuer config field; ``aws`` (Cognito) is available
# (OLO-9.4, #4987) with a user-pool issuer config field.
PROVIDER_REGISTRY: Tuple[ProviderDescriptor, ...] = (
    ProviderDescriptor(
        "github", "GitHub", STATUS_AVAILABLE, client_credential_fields("GITHUB_ID", "GITHUB_SECRET")
    ),
    ProviderDescriptor(
        "gitlab",
        "GitLab",
        STATUS_AVAILABLE,
        client_credential_fields("GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET"),
    ),
    ProviderDescriptor(
        "azure",
        "Microsoft",
        STATUS_AVAILABLE,
        client_credential_fields("AZURE_AD_CLIENT_ID", "AZURE_AD_CLIENT_SECRET"),
    ),
    ProviderDescriptor(
        "google",
        "Google",
        STATUS_AVAILABLE,
        client_credential_fields("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
    ),
    ProviderDescriptor(
        "okta",
        "Okta",
        STATUS_AVAILABLE,
        client_credential_fields("OKTA_CLIENT_ID", "OKTA_CLIENT_SECRET")
        + (RequiredField("issuer", FIELD_KIND_CONFIG, "OKTA_ISSUER"),),
    ),
    ProviderDescriptor(
        "aws",
        "AWS",
        STATUS_AVAILABLE,
        client_credential_fields("COGNITO_CLIENT_ID", "COGNITO_CLIENT_SECRET")
        + (RequiredField("issuer", FIELD_KIND_CONFIG, "COGNITO_ISSUER"),),
    ),
)

_BY_ID: Dict[str, ProviderDescriptor] = {p.id: p for p in PROVIDER_REGISTRY}


def get_provider_descriptor(provider_id: str) -> Optional[ProviderDescriptor]:
    """Look up a registry entry by slug.

    Args:
        provider_id: Provider slug (e.g. ``"github"``).

    Returns:
        The descriptor, or ``None`` for a slug the registry does not know.
    """
    return _BY_ID.get(provider_id)


def known_provider_ids() -> List[str]:
    """Return every known provider slug, in display order."""
    return [p.id for p in PROVIDER_REGISTRY]
