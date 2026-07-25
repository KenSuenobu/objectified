-- LINE provider vocabulary widen (OLO-9.41, #5054)
--
-- OLO-9.41 adds the LINE Login provider (JP/TW/TH country MVP). The V198 CHECKs pin a
-- twelve-slug vocabulary that does not include `line`. OLO-9.16 (#5029) will widen the full
-- Better Auth catalog; until then this migration admits `line` alone so the registry entry and
-- identity/config rows can persist without waiting on the catalog gate.
--
-- Idempotent: each constraint is dropped (if present) and re-added with the widened list.

SET search_path TO apiome, public;

ALTER TABLE external_auth_providers
    DROP CONSTRAINT IF EXISTS external_auth_providers_provider_supported_ck;
ALTER TABLE external_auth_providers
    ADD CONSTRAINT external_auth_providers_provider_supported_ck
    CHECK (provider IN (
        'github', 'gitlab', 'azure', 'google', 'aws', 'gcp', 'bitbucket',
        'okta', 'keycloak', 'auth0', 'oidc', 'atlassian',
        'line'
    ));

ALTER TABLE apiome.auth_provider_config
    DROP CONSTRAINT IF EXISTS auth_provider_config_provider_id_check;
ALTER TABLE apiome.auth_provider_config
    ADD CONSTRAINT auth_provider_config_provider_id_check
    CHECK (provider_id IN (
        'github', 'gitlab', 'azure', 'google', 'aws', 'gcp', 'bitbucket',
        'okta', 'keycloak', 'auth0', 'oidc', 'atlassian',
        'line'
    ));

COMMENT ON COLUMN apiome.auth_provider_config.provider_id IS
    'Provider slug matching PROVIDER_REGISTRY ids; primary key, one row per provider. Vocabulary widened for OLO-9.41 (#5054) to accept LINE (line) ahead of the full-catalog OLO-9.16 widen.';
