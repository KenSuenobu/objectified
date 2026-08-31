-- Fold the in-REST mock engine into apiome-mock — MSC-2.2 (#5532).
--
-- Until now there were two mock engines in the tree. The hosted instances in this table were
-- served by one of them: a resolver living inside apiome-rest that read `config` — a *list* of
-- scenarios whose `rules` set `status` / `latency_ms` / `body`, plus an `active_scenario` naming
-- the default. It had no templates, no match predicates, no stateful CRUD, no fixtures, no chaos
-- and no non-HTTP transports. The other engine, apiome-mock, had all of them and read a different
-- shape entirely: `versions.mock_settings`, scenarios keyed by name with per-operation overrides.
--
-- One product concept, two schemas, two resolvers. Every mock feature had to be built twice or be
-- invisible on one of the two surfaces. #5532 settled it: apiome-mock is the engine, and this
-- migration is the storage half of the fold.
--
-- Two columns:
--
--   settings         The apiome-mock-shaped configuration this instance is now served from —
--                    `scenarios` keyed by name, `chaos`, and `activeScenario` (#5531, MSC-2.1),
--                    which is where the legacy `active_scenario` lands. NULL means "not folded
--                    yet"; apiome-rest folds a row the first time it reads one (and
--                    `apiome-rest/scripts/fold_mock_instance_configs.py` folds every row eagerly
--                    for operators who would rather not wait for traffic).
--
--   migration_notes  Everything in `config` that could NOT be translated, as an array of
--                    human-readable strings: a rule that matched no operation in the frozen spec,
--                    one an earlier rule had already made unreachable, one that set nothing, or a
--                    latency clamped to the 30s ceiling. The acceptance criterion is that
--                    untranslatable rules are *reported, never silently dropped* — this column is
--                    the report, and the management API surfaces it on the instance.
--
-- Why the fold is not done in SQL. It has to be spec-aware: a legacy rule that set a `body` but no
-- `status` served the operation's own default success status (201 for a create, 204 for a delete,
-- 200 otherwise), and precedence was *first matching rule wins per operation*, which inverts in
-- the keyed shape where an exact operation key beats the wildcard. Resolving that correctly means
-- walking the frozen `spec` document operation by operation. Reimplementing that walk in PL/pgSQL
-- would mean two translators — the exact failure mode this ticket exists to remove — so there is
-- one, in `app.mock_instance_config`, and this migration only makes room for its output.
--
-- `config` is kept, unread, as the pre-fold record. It is what a migrated instance is diffed
-- against when someone asks whether it still serves the same responses, and dropping it would
-- throw that away for no space worth having.

SET search_path TO apiome, public;

ALTER TABLE mock_instances
    ADD COLUMN IF NOT EXISTS settings JSONB;

ALTER TABLE mock_instances
    ADD COLUMN IF NOT EXISTS migration_notes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Instances provisioned after this migration write `settings` directly, so the partial index
-- covers exactly the shrinking set the backfill still has to visit.
CREATE INDEX IF NOT EXISTS idx_mock_instances_unfolded
    ON mock_instances(created_at)
    WHERE settings IS NULL;

COMMENT ON COLUMN mock_instances.settings IS 'apiome-mock-shaped mock settings (scenarios, chaos, activeScenario) this instance is served from; NULL until the legacy config is folded (#5532, MSC-2.2)';
COMMENT ON COLUMN mock_instances.migration_notes IS 'Human-readable reports for legacy config rules that could not be translated; empty array means the fold was lossless (#5532, MSC-2.2)';
COMMENT ON COLUMN mock_instances.config IS 'Legacy RC1-2.2 mock configuration (scenario list with rules, active_scenario, seed). Retained unread as the pre-fold record; the serving configuration is `settings` (#5532, MSC-2.2)';
