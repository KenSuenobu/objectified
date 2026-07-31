-- Repository webhook signing-secret rotation (REPO-4.7, #2785).
--
-- REPO-4.3 made the signing secret write-once: the guard trigger refused any UPDATE that
-- would change `secret_enc`, and the only way to change a secret was to delete the
-- subscription and create another. That is a correct answer to "an attacker with one write
-- primitive must not be able to install their own key", and a bad answer to "this secret has
-- been in a provider's config for eighteen months". Delete-and-recreate drops the old secret
-- the instant it runs, so every delivery signed with it — including the ones already in
-- flight, and every delivery the provider sends until somebody finishes editing the hook —
-- fails to verify. The safe rotation nobody performs is worse than the unsafe one they do.
--
-- So the secret stops being write-once and becomes **write-through-a-shape**. It may change,
-- but only as part of an UPDATE that simultaneously carries the outgoing secret into
-- `previous_secret_enc` and sets an expiry on it. There is still no statement that can
-- silently substitute a key: an attacker who rewrites `secret_enc` must leave the secret they
-- displaced sitting in the row, still verifying deliveries, with a deadline attached and a
-- `repository.webhook_secret_rotated` audit row written by the application beside it.
--
-- Two secrets, one window:
--
--   * `secret_enc` is the **current** secret. New deliveries should be signed with it, and it
--     is the one handed to the provider when the hook is updated.
--   * `previous_secret_enc` is the **outgoing** secret, valid until
--     `previous_secret_expires_at`. Verification accepts either while the window is open.
--     When it closes, the secret-rotation sweep NULLs all three previous_* columns; from that
--     moment a delivery signed with the old secret is a 401 like any other bad signature.
--
-- `provider_secret_synced` is the honest half. Updating the provider's hook needs a token
-- with `admin:repo_hook`, which a repository registered from a public URL does not have and a
-- linked account may have lost. When the update succeeds the flag is TRUE and the window is
-- pure belt-and-braces; when it fails the flag is FALSE, `rotation_error` says why, and the
-- sweep retries on every tick for the whole grace window. An operator therefore sees "this
-- rotation has not reached the provider yet, and here is how long before deliveries start
-- failing" rather than discovering it after the fact.
--
-- Ordering is deliberate: the database is written first, the provider second. The reverse
-- order has a failure mode where the provider signs with a secret this deployment never
-- stored, which no grace window can rescue. This way the worst case is a provider still
-- signing with the previous secret, which verifies for the whole window.

SET search_path TO apiome, public;

-- ─── 1. The outgoing secret ──────────────────────────────────────────────────

ALTER TABLE apiome.repository_webhook_subscription
    -- Fernet ciphertext of the secret that was current before the most recent rotation.
    ADD COLUMN IF NOT EXISTS previous_secret_enc         BYTEA,
    -- Truncated SHA-256 of that secret, so an operator can tell which of the two secrets a
    -- provider is configured with without either side revealing anything.
    ADD COLUMN IF NOT EXISTS previous_secret_fingerprint VARCHAR(32),
    -- When the outgoing secret stops verifying. Always set while an outgoing secret exists
    -- (see the CHECK below): an old secret with no deadline is simply a second live secret.
    ADD COLUMN IF NOT EXISTS previous_secret_expires_at  TIMESTAMPTZ,
    -- When the current secret was minted by a rotation. NULL for a secret that is still the
    -- one minted at registration.
    ADD COLUMN IF NOT EXISTS rotated_at                  TIMESTAMPTZ,
    -- How many times this subscription's secret has been rotated. Monotonic; the guard below
    -- refuses a decrease so the count cannot be laundered.
    ADD COLUMN IF NOT EXISTS rotation_count              INTEGER NOT NULL DEFAULT 0,
    -- Whether the provider's hook is known to hold the *current* secret. FALSE means the
    -- deployment is relying on the grace window and the sweep is still retrying.
    ADD COLUMN IF NOT EXISTS provider_secret_synced      BOOLEAN NOT NULL DEFAULT TRUE,
    -- Why the provider hook could not be updated, when it could not be.
    ADD COLUMN IF NOT EXISTS rotation_error              TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_repository_webhook_rotation_count_non_negative'
    ) THEN
        ALTER TABLE apiome.repository_webhook_subscription
            ADD CONSTRAINT ck_repository_webhook_rotation_count_non_negative
            CHECK (rotation_count >= 0);
    END IF;

    -- An outgoing secret without a deadline is not a grace window, it is a second permanent
    -- key. The pairing is a table constraint rather than an application convention because
    -- the application is not the only thing that can write this row.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_repository_webhook_previous_secret_expires'
    ) THEN
        ALTER TABLE apiome.repository_webhook_subscription
            ADD CONSTRAINT ck_repository_webhook_previous_secret_expires
            CHECK (previous_secret_enc IS NULL OR previous_secret_expires_at IS NOT NULL);
    END IF;
END
$$;

COMMENT ON COLUMN apiome.repository_webhook_subscription.previous_secret_enc IS
    'Fernet ciphertext of the outgoing signing secret during a rotation grace window (REPO-4.7). Verification accepts it until previous_secret_expires_at, after which the sweep clears it.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.previous_secret_fingerprint IS
    'Truncated SHA-256 of the outgoing secret — identifies which secret a provider still holds without revealing it.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.previous_secret_expires_at IS
    'End of the rotation grace window. Never extended in place: the guard trigger refuses an UPDATE that pushes it further out without rotating.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.rotated_at IS
    'When the current secret was minted by a rotation; NULL while the registration-time secret is still current.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.rotation_count IS
    'Monotonic count of rotations. The guard trigger refuses a decrease, so rotation history cannot be erased by an UPDATE.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.provider_secret_synced IS
    'Whether the provider hook is known to hold the *current* secret. FALSE means the grace window is load-bearing and the sweep is still retrying the provider update.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.rotation_error IS
    'Why the provider hook could not be updated to the new secret, when it could not be.';

-- The two queries the sweep runs every tick, both narrow and both on a table that is mostly
-- rows with nothing to do. Partial indexes so a deployment with ten thousand subscriptions
-- and three rotations in flight reads three rows.
CREATE INDEX IF NOT EXISTS idx_repository_webhook_subscription_secret_expiry
    ON apiome.repository_webhook_subscription (previous_secret_expires_at)
    WHERE previous_secret_enc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repository_webhook_subscription_secret_unsynced
    ON apiome.repository_webhook_subscription (previous_secret_expires_at)
    WHERE provider_secret_synced = FALSE;

-- ─── 2. The guard, re-stated for a rotating secret ───────────────────────────

-- The REPO-4.3 guard refused every change to `secret_enc`. This one refuses every change
-- that is not a *rotation*, which is a strictly narrower permission than "the secret is
-- mutable" and a strictly wider one than "the secret is frozen":
--
--   * the new secret must be present (a rotation cannot blank the secret and thereby turn a
--     verified endpoint into one that fails closed for everybody);
--   * the outgoing secret must be exactly the value being displaced — not an arbitrary blob,
--     and not NULL, so the row cannot be rewritten in a way that discards the old key; and
--   * a deadline must be attached to it.
--
-- Everything the old guard forbade outright — repointing the subscription at another
-- repository or tenant, rewriting its id or creation time — is still forbidden outright.
CREATE OR REPLACE FUNCTION apiome.repository_webhook_secret_guard()
RETURNS trigger AS $$
DECLARE
    v_changed  TEXT[] := ARRAY[]::TEXT[];
    v_rotating BOOLEAN;
BEGIN
    IF NEW.id            IS DISTINCT FROM OLD.id            THEN v_changed := array_append(v_changed, 'id');            END IF;
    IF NEW.tenant_id     IS DISTINCT FROM OLD.tenant_id     THEN v_changed := array_append(v_changed, 'tenant_id');     END IF;
    IF NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN v_changed := array_append(v_changed, 'repository_id'); END IF;
    IF NEW.created_at    IS DISTINCT FROM OLD.created_at    THEN v_changed := array_append(v_changed, 'created_at');    END IF;

    v_rotating := OLD.secret_enc IS NOT NULL
                  AND NEW.secret_enc IS DISTINCT FROM OLD.secret_enc;

    IF v_rotating THEN
        -- A secret may only change as part of a well-formed rotation.
        IF NEW.secret_enc IS NULL THEN
            v_changed := array_append(v_changed, 'secret_enc (rotation cannot clear the secret)');
        ELSIF NEW.previous_secret_enc IS DISTINCT FROM OLD.secret_enc THEN
            v_changed := array_append(
                v_changed,
                'secret_enc (rotation must carry the outgoing secret into previous_secret_enc)'
            );
        ELSIF NEW.previous_secret_expires_at IS NULL THEN
            v_changed := array_append(
                v_changed,
                'secret_enc (rotation must set previous_secret_expires_at)'
            );
        ELSIF NEW.rotation_count <= OLD.rotation_count THEN
            v_changed := array_append(
                v_changed, 'secret_enc (rotation must advance rotation_count)'
            );
        END IF;
    ELSE
        -- Not a rotation, so the outgoing secret may only be retained or expired. Inventing
        -- one out of band would install a second live key without a rotation ever happening,
        -- and extending its deadline would keep a retired key alive indefinitely — the exact
        -- long-lived-secret finding this ticket exists to close.
        IF NEW.previous_secret_enc IS DISTINCT FROM OLD.previous_secret_enc
           AND NEW.previous_secret_enc IS NOT NULL THEN
            v_changed := array_append(v_changed, 'previous_secret_enc (only a rotation may set it)');
        END IF;
        IF OLD.previous_secret_expires_at IS NOT NULL
           AND NEW.previous_secret_expires_at IS NOT NULL
           AND NEW.previous_secret_expires_at > OLD.previous_secret_expires_at THEN
            v_changed := array_append(
                v_changed, 'previous_secret_expires_at (a grace window cannot be extended)'
            );
        END IF;
    END IF;

    IF NEW.rotation_count < OLD.rotation_count THEN
        v_changed := array_append(v_changed, 'rotation_count (rotation history cannot be rewound)');
    END IF;

    IF array_length(v_changed, 1) > 0 THEN
        RAISE EXCEPTION
            'repository_webhook_subscription refused an illegal write: %',
            array_to_string(v_changed, ', ')
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.repository_webhook_secret_guard() IS
    'Refuses any UPDATE that repoints a repository webhook subscription, rewinds its rotation count, or changes its signing secret other than as a well-formed rotation carrying the outgoing secret into previous_secret_enc with an expiry (REPO-4.3, extended by REPO-4.7).';

-- The trigger itself is unchanged; re-asserted so a deployment applying only this migration
-- to a hand-restored schema still ends up with the guard attached.
DROP TRIGGER IF EXISTS trg_repository_webhook_secret_guard ON apiome.repository_webhook_subscription;
CREATE TRIGGER trg_repository_webhook_secret_guard
    BEFORE UPDATE ON apiome.repository_webhook_subscription
    FOR EACH ROW EXECUTE FUNCTION apiome.repository_webhook_secret_guard();
