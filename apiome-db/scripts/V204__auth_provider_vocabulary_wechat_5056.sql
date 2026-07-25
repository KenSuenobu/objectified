-- WeChat provider vocabulary widen (OLO-9.43, #5056)
--
-- OLO-9.43 adds the WeChat Open Platform provider (China country MVP). The V203 CHECKs pin a
-- vocabulary that includes `vk` but not `wechat`. OLO-9.16 (#5029) will widen the full
-- Better Auth catalog; until then this migration admits `wechat` alone so the registry entry and
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
        'line', 'vk', 'wechat'
    ));

ALTER TABLE apiome.auth_provider_config
    DROP CONSTRAINT IF EXISTS auth_provider_config_provider_id_check;
ALTER TABLE apiome.auth_provider_config
    ADD CONSTRAINT auth_provider_config_provider_id_check
    CHECK (provider_id IN (
        'github', 'gitlab', 'azure', 'google', 'aws', 'gcp', 'bitbucket',
        'okta', 'keycloak', 'auth0', 'oidc', 'atlassian',
        'line', 'vk', 'wechat'
    ));

COMMENT ON COLUMN apiome.auth_provider_config.provider_id IS
    'Provider slug matching PROVIDER_REGISTRY ids; primary key, one row per provider. Vocabulary widened for OLO-9.43 (#5056) to accept WeChat (wechat) ahead of the full-catalog OLO-9.16 widen.';
