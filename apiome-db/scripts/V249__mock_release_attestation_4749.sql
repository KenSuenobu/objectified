-- Release-proof mock attestation — PMR-3.2 (#4749).
--
-- Problem: a verification run can already say it executed against a `mock` environment (V212's
-- target_environment vocabulary), but it cannot say *which* mock. "The mock passed" with no bundle
-- digest behind it is a claim, not a proof — the bundle may have been rebuilt, the runtime may have
-- been a different version, and nobody can tell afterwards whether a conformance corpus ran at all.
--
-- Solution: one additive, **immutable**, tenant-scoped child of verification_run holding the four
-- identities that turn that claim into evidence:
--
--   * the **bundle digest** (PMR-1.1) — the immutable identity of what was served;
--   * the **runtime** (PMR-1.2) — which apiome-mock, and which image, produced the behavior;
--   * the **conformance result** (PMR-3.1) — the corpus, by digest, and how it went;
--   * the **fixture-pack digests** (PMR-2.2) — which seed data it was proved against.
--
-- Four rules shape the table, each an acceptance criterion turned into a constraint rather than a
-- convention the application is trusted to keep:
--
--   1. **Only immutable digests are linked.** bundle_digest, corpus_digest, and every entry in
--      fixture_packs take the `sha256:<64 hex>` form this platform's digests already use, CHECKed
--      here as well as in app/mock_attestation.py. The application refuses an unpublished revision
--      on top of that (a draft can still change), which the schema cannot express without reaching
--      into the JSONB.
--
--   2. **A verification identifies its runtime and its corpus.** A row claiming `verified` must
--      carry runtime_version and corpus_digest: a pass with no runtime behind it, or no corpus, is
--      exactly the evidence that cannot be reproduced.
--
--   3. **A non-verified verification is explicit.** status <> 'verified' requires a reason_code.
--      That is what makes "missing" a *recorded fact* rather than an absence — a release proof
--      whose mock block is simply not there cannot be told apart from one whose mock verification
--      was skipped.
--
--   4. **Evidence is immutable and tenant-scoped**, exactly as V212's four tables are: the shared
--      BEFORE UPDATE guard rejects in-place edits, and the composite foreign key on
--      (run_id, tenant_id) makes a cross-tenant child structurally impossible.
--
-- One row per run (UNIQUE on run_id): a run has one mock it ran against, or none.
--
-- RBAC: unchanged. The attestation is part of a verification run, so it is read and written through
-- the existing `verification_evidence` resource added by V212.
--
-- Retention: unchanged. purge_verification_evidence() deletes runs; this table cascades with them.
--
-- Rollback notes:
--   DROP TABLE IF EXISTS apiome.verification_run_mock;
-- (The V128 guard function apiome.mcp_forbid_row_mutation() is shared — do not drop it here.)

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- verification_run_mock — the mock a run was verified against, by immutable digest.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_run_mock (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Scope, mirroring V212: tenant_id sits on the child too, so every read is scoped by the same
    -- predicate and the composite FK below pins the row to its parent's tenant.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,

    -- The verdict. Derived by the application from the conformance counts and never accepted from
    -- the runner, the same way V212 derives a run's outcome from its case records.
    status TEXT NOT NULL
        CONSTRAINT verification_run_mock_status_check
            CHECK (status IN ('verified', 'failed', 'missing')),

    -- Why it is not verified. Closed vocabulary so a gate branches on the code, not on prose.
    reason_code TEXT
        CONSTRAINT verification_run_mock_reason_code_check
            CHECK (
                reason_code IS NULL
                OR reason_code IN (
                    'mock-conformance-failed',
                    'mock-conformance-missing',
                    'mock-attestation-missing'
                )
            ),
    reason TEXT,

    -- What was served. NULL only for a row that records the *absence* of an attestation, which has
    -- no bundle it could honestly name.
    bundle_digest TEXT
        CONSTRAINT verification_run_mock_bundle_digest_shape_check
            CHECK (bundle_digest IS NULL OR bundle_digest ~ '^sha256:[0-9a-f]{64}$'),
    bundle_format TEXT,
    bundle_format_version INTEGER
        CONSTRAINT verification_run_mock_bundle_format_version_check
            CHECK (bundle_format_version IS NULL OR bundle_format_version >= 0),
    bundle_signed BOOLEAN NOT NULL DEFAULT FALSE,
    -- The bundle manifest's own api block (tenant, project, version, revision_id, published,
    -- protocol), snapshotted: a project renamed later must not rewrite what this proof says.
    bundle_api JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Which runtime produced the behavior. A conformance pass means nothing without it.
    runtime_name TEXT,
    runtime_version TEXT,
    runtime_image TEXT,

    -- Which corpus was executed. The digest is the identity; the declared version is the label.
    corpus_format TEXT,
    corpus_version TEXT,
    corpus_digest TEXT
        CONSTRAINT verification_run_mock_corpus_digest_shape_check
            CHECK (corpus_digest IS NULL OR corpus_digest ~ '^sha256:[0-9a-f]{64}$'),
    corpus_case_count INTEGER
        CONSTRAINT verification_run_mock_corpus_case_count_check
            CHECK (corpus_case_count IS NULL OR corpus_case_count >= 0),

    -- How it went. Stored so a read needs no join and no re-tally.
    conformance_total INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_mock_total_check CHECK (conformance_total >= 0),
    conformance_passed INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_mock_passed_check CHECK (conformance_passed >= 0),
    conformance_failed INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_mock_failed_check CHECK (conformance_failed >= 0),
    failed_cases JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Which seed data the behavior was proved against: one entry per fixture pack, each with its
    -- digest, origin (authored | capture, PMR-2.4) and redaction status. Digests only — never
    -- resource bodies.
    fixture_packs JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- A run has one mock, or none.
    CONSTRAINT verification_run_mock_run_key UNIQUE (run_id),

    -- The child is pinned to its parent's tenant, exactly as V212's children are.
    CONSTRAINT verification_run_mock_run_fk
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES verification_run (id, tenant_id) ON DELETE CASCADE,

    -- Counts must add up. The application derives them from the corpus report; this keeps a
    -- hand-written INSERT from storing a total its parts contradict.
    CONSTRAINT verification_run_mock_counts_sum_check
        CHECK (conformance_passed + conformance_failed = conformance_total),

    -- A verified mock names what verified it: the bundle it served, the runtime that served it,
    -- and the corpus that judged it — with no failures.
    CONSTRAINT verification_run_mock_verified_evidence_check
        CHECK (
            status <> 'verified'
            OR (
                bundle_digest IS NOT NULL
                AND runtime_version IS NOT NULL
                AND corpus_digest IS NOT NULL
                AND conformance_failed = 0
                AND conformance_total > 0
            )
        ),

    -- A failed mock says which corpus failed it.
    CONSTRAINT verification_run_mock_failed_evidence_check
        CHECK (status <> 'failed' OR (corpus_digest IS NOT NULL AND conformance_failed > 0)),

    -- Anything that is not verified states why. This is the "missing or failed is explicit"
    -- criterion, enforced rather than trusted.
    CONSTRAINT verification_run_mock_reason_required_check
        CHECK (status = 'verified' OR reason_code IS NOT NULL),

    CONSTRAINT verification_run_mock_bundle_api_object_check
        CHECK (jsonb_typeof(bundle_api) = 'object'),
    CONSTRAINT verification_run_mock_failed_cases_array_check
        CHECK (jsonb_typeof(failed_cases) = 'array'),
    CONSTRAINT verification_run_mock_fixture_packs_array_check
        CHECK (jsonb_typeof(fixture_packs) = 'array')
);

COMMENT ON TABLE verification_run_mock IS
    'Immutable release-proof mock attestation for one verification run: bundle digest, runtime version, conformance corpus and result, and fixture-pack digests (PMR-3.2, #4749)';
COMMENT ON COLUMN verification_run_mock.tenant_id IS 'Tenant that owns the evidence; pinned to the parent run through the composite foreign key';
COMMENT ON COLUMN verification_run_mock.run_id IS 'The verification run this attestation belongs to (one per run)';
COMMENT ON COLUMN verification_run_mock.status IS 'verified | failed | missing — derived from the conformance result, never accepted from the runner';
COMMENT ON COLUMN verification_run_mock.reason_code IS 'Why the mock is not verified; required whenever status <> verified so a gap is a recorded fact rather than an absence';
COMMENT ON COLUMN verification_run_mock.reason IS 'Human-readable, credential-scrubbed explanation';
COMMENT ON COLUMN verification_run_mock.bundle_digest IS 'PMR-1.1 manifestDigest (sha256:<hex>) of the served bundle — the immutable identity a release proof links';
COMMENT ON COLUMN verification_run_mock.bundle_format IS 'Bundle format id (apiome.mock.bundle/v1)';
COMMENT ON COLUMN verification_run_mock.bundle_format_version IS 'Additive revision of the bundle format';
COMMENT ON COLUMN verification_run_mock.bundle_signed IS 'Whether the served bundle carried a manifest signature';
COMMENT ON COLUMN verification_run_mock.bundle_api IS 'Bundle manifest api block, snapshotted (tenant, project, version, revision_id, published, protocol)';
COMMENT ON COLUMN verification_run_mock.runtime_name IS 'Runtime that served the bundle (apiome-mock)';
COMMENT ON COLUMN verification_run_mock.runtime_version IS 'Runtime version; a conformance pass is unreproducible without it';
COMMENT ON COLUMN verification_run_mock.runtime_image IS 'Container image reference the runtime ran as, when the job pinned one';
COMMENT ON COLUMN verification_run_mock.corpus_format IS 'Conformance corpus format id (apiome.mock.conformance/v1)';
COMMENT ON COLUMN verification_run_mock.corpus_version IS 'Version label the corpus document declared';
COMMENT ON COLUMN verification_run_mock.corpus_digest IS 'sha256 over the corpus document canonical JSON — what makes two conformance results comparable';
COMMENT ON COLUMN verification_run_mock.corpus_case_count IS 'How many cases the corpus declared; a run that executed fewer is visibly partial';
COMMENT ON COLUMN verification_run_mock.conformance_total IS 'Conformance cases executed';
COMMENT ON COLUMN verification_run_mock.conformance_passed IS 'Conformance cases that passed';
COMMENT ON COLUMN verification_run_mock.conformance_failed IS 'Conformance cases that failed';
COMMENT ON COLUMN verification_run_mock.failed_cases IS 'Names of failing conformance cases (bounded summary; full detail lives in the run''s case records)';
COMMENT ON COLUMN verification_run_mock.fixture_packs IS 'One entry per fixture pack the bundle carried: name, digest, format, format_version, origin, redaction_status. Digests only.';

-- A gate asks "is there passing mock evidence for this bundle" — answer it without scanning runs.
CREATE INDEX IF NOT EXISTS idx_verification_run_mock_tenant_bundle
    ON verification_run_mock (tenant_id, bundle_digest, status);

CREATE INDEX IF NOT EXISTS idx_verification_run_mock_run
    ON verification_run_mock (run_id);

-- ---------------------------------------------------------------------------------------------------
-- Immutability: an attestation is written with its run and never edited afterwards.
-- ---------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_verification_run_mock_immutable ON verification_run_mock;
CREATE TRIGGER trigger_verification_run_mock_immutable
    BEFORE UPDATE ON verification_run_mock
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();
