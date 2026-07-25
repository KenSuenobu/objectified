"""Tests for the server-side provider registry (OLO-8.4, #4970; OLO-9.1, #4984).

The Python registry (:mod:`app.auth_provider_registry`) is a deliberate projection of the canonical
UI registry (``provider-registry.ts``). These pin the facts the REST layer depends on and, crucially,
that the two never silently drift: the slugs, order, status, and per-field requirements must match
the UI registry, the canonical snapshot, and the V196 CHECK.
"""

import json
from pathlib import Path

from app.auth_provider_registry import (
    FIELD_KIND_CLIENT_ID,
    FIELD_KIND_CLIENT_SECRET,
    FIELD_KIND_CONFIG,
    PROVIDER_REGISTRY,
    STATUS_AVAILABLE,
    STATUS_COMING_SOON,
    client_credential_fields,
    get_provider_descriptor,
    known_provider_ids,
)

# The single source-of-truth snapshot both language registries are asserted against (OLO-9.1).
_SNAPSHOT_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "auth_providers" / "registry.json"
)


def test_registry_ids_and_order_match_ui_and_v196():
    """Slugs and display order mirror PROVIDER_REGISTRY (UI) and the V196 CHECK list."""
    assert known_provider_ids() == ["github", "gitlab", "azure", "google", "okta", "aws", "keycloak", "oidc", "auth0", "line"]


def test_available_vs_coming_soon_status():
    """github/gitlab/azure/google/okta/aws/keycloak/oidc/auth0/line are available; no coming-soon placeholders remain."""
    status = {p.id: p.status for p in PROVIDER_REGISTRY}
    assert status["github"] == STATUS_AVAILABLE
    assert status["gitlab"] == STATUS_AVAILABLE
    assert status["azure"] == STATUS_AVAILABLE
    assert status["google"] == STATUS_AVAILABLE
    assert status["okta"] == STATUS_AVAILABLE
    assert status["aws"] == STATUS_AVAILABLE
    assert status["keycloak"] == STATUS_AVAILABLE
    assert status["oidc"] == STATUS_AVAILABLE
    assert status["auth0"] == STATUS_AVAILABLE
    assert status["line"] == STATUS_AVAILABLE
    assert all(p.status == STATUS_AVAILABLE for p in PROVIDER_REGISTRY)


def test_available_providers_require_client_id_and_secret():
    """Most available providers require client_id + client_secret; issuer-based providers add issuer."""
    for provider in PROVIDER_REGISTRY:
        if provider.status == STATUS_COMING_SOON:
            assert provider.required_fields == ()
            continue
        names = provider.required_field_names()
        assert names[0:2] == ["client_id", "client_secret"]
        kinds = [f.kind for f in provider.required_fields]
        assert kinds[0:2] == [FIELD_KIND_CLIENT_ID, FIELD_KIND_CLIENT_SECRET]
        if provider.id in ("okta", "aws", "keycloak", "oidc", "auth0"):
            assert names == ["client_id", "client_secret", "issuer"]
            assert kinds == [FIELD_KIND_CLIENT_ID, FIELD_KIND_CLIENT_SECRET, FIELD_KIND_CONFIG]
            expected_env = {
                "okta": "OKTA_ISSUER",
                "aws": "COGNITO_ISSUER",
                "keycloak": "KEYCLOAK_ISSUER",
                "oidc": "OIDC_ISSUER",
                "auth0": "AUTH0_ISSUER",
            }[provider.id]
            assert provider.required_fields[2].env_key == expected_env
        else:
            assert names == ["client_id", "client_secret"]


def test_client_credential_fields_helper():
    """The shared helper maps the id/secret env vars onto the standard required-field pair."""
    fields = client_credential_fields("A_ID", "A_SECRET")
    assert [(f.field, f.kind, f.env_key) for f in fields] == [
        ("client_id", FIELD_KIND_CLIENT_ID, "A_ID"),
        ("client_secret", FIELD_KIND_CLIENT_SECRET, "A_SECRET"),
    ]


def test_lookup_known_and_unknown():
    """Lookup returns the descriptor for a known slug and None otherwise."""
    assert get_provider_descriptor("github").label == "GitHub"
    assert get_provider_descriptor("okta").label == "Okta"
    assert get_provider_descriptor("aws").label == "AWS"
    assert get_provider_descriptor("keycloak").label == "Keycloak"
    assert get_provider_descriptor("oidc").label == "OIDC"
    assert get_provider_descriptor("auth0").label == "Auth0"
    assert get_provider_descriptor("line").label == "LINE"
    assert get_provider_descriptor("not-a-provider") is None


def test_registry_mirrors_canonical_snapshot():
    """The Python registry serializes to the canonical snapshot (drift guard, TS ⇄ Python).

    The mirror on the TypeScript side (``provider-registry-mirror.test.ts``) asserts the same for the
    UI registry, so either registry drifting from ``scripts/auth_providers/registry.json`` turns one
    suite red.
    """
    snapshot = json.loads(_SNAPSHOT_PATH.read_text())
    projected = [
        {
            "id": p.id,
            "label": p.label,
            "status": p.status,
            "required_fields": [
                {"field": f.field, "kind": f.kind, "env_key": f.env_key}
                for f in p.required_fields
            ],
        }
        for p in PROVIDER_REGISTRY
    ]
    assert projected == snapshot["providers"]
