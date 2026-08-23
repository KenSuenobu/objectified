-- Re-seed the built-in style guide from the full live rule registry -- FMT-5.5 (#5443).
--
-- V159 seeded the read-only "Apiome Recommended" guide with the rule ids the linter shipped
-- with *at that time*, as a static VALUES list. Every rule pack added since -- the IXH-5.4
-- example-conformance pack, the MFI-29.4 intake pack, the IXH-7.2 Kubernetes CRD pack, the
-- IXH-7.3 LLM tool-bundle pack, the FMT-3.7 protobuf-editions rules, the GraphQL composition
-- rules, one Arazzo rule, and now the FMT-5.5 data-contract pack -- was registered in the
-- GOV-1.2 catalogue but never added here.
--
-- That is not cosmetic. `CompiledStyleGuide.apply` DROPS a finding whose rule is in the
-- registry but not in the guide ("a guide governs exactly the registry rules it enables"),
-- so for every tenant scoring against the seeded builtin guide those 34 rules have been
-- silently switched off: they run, they find defects, and the defects never reach a score.
-- The in-code fallback guide (`style_guide_engine.builtin_fallback_guide`) is built from the
-- live registry and has always had them, which is why the drift never showed up in tests
-- that do not go through the database.
--
-- This migration rewrites `seed_builtin_style_guide` with the complete current registry --
-- 71 rules, each at the default severity its pack declares -- and re-seeds every tenant.
-- Custom guides and their rules are untouched: the function only ever rewrites the rows of
-- the guide whose `source` is 'builtin'.
--
-- Effect on scores: a data-schema catalog item now scores against the FMT-5.5 data-contract
-- pack, and items in the other affected formats now score against the packs that were
-- already running. That is the intended correction -- a rule that fires but is discarded is
-- worse than no rule at all.
--
-- Kept as a static list rather than generated at runtime so a migration stays reviewable and
-- deterministic. `apiome-rest/tests/test_data_contract_lint.py` compares this list against
-- the live registry and fails when the two drift, so the next pack cannot repeat the
-- omission.
SET search_path TO apiome, public;

CREATE OR REPLACE FUNCTION apiome.seed_builtin_style_guide(p_tenant UUID)
RETURNS void AS $$
DECLARE
    v_guide UUID;
BEGIN
    SELECT id INTO v_guide
      FROM apiome.style_guides
     WHERE tenant_id = p_tenant AND source = 'builtin';

    IF v_guide IS NULL THEN
        -- New guide: it becomes the tenant default only if the tenant has none yet, so a
        -- re-seed never steals default status from a guide the tenant chose later.
        INSERT INTO apiome.style_guides (tenant_id, name, description, is_default, source)
        VALUES (
            p_tenant,
            'Apiome Recommended',
            'The built-in Apiome style guide: every shipped lint rule at its default severity. Read-only; duplicate it to customize.',
            NOT EXISTS (SELECT 1 FROM apiome.style_guides WHERE tenant_id = p_tenant AND is_default),
            'builtin'
        )
        RETURNING id INTO v_guide;
    END IF;

    -- Rewrite the builtin rule rows from scratch (idempotent / self-healing).
    DELETE FROM apiome.style_guide_rules WHERE guide_id = v_guide;

    INSERT INTO apiome.style_guide_rules (guide_id, rule_id, enabled, severity)
    SELECT v_guide, r.rule_id, true, r.severity
    FROM (VALUES
        -- OpenAPI / JSON-Schema (schema_lint.OPENAPI_RULES)
        ('compatibility.breaking',                        'error'),
        ('compatibility.unknown',                         'warning'),
        ('documentation.info-missing-description',        'info'),
        ('documentation.operation-missing-summary',       'warning'),
        ('documentation.property-missing-description',    'info'),
        ('documentation.property-missing-example',        'info'),
        ('documentation.schema-missing-description',      'warning'),
        ('naming.property-name',                          'warning'),
        ('naming.schema-pascal-case',                     'warning'),
        ('structure.unbounded-array',                     'warning'),
        -- Cross-format canonical-model pack (lint_engine.CommonRulePack)
        ('common.api-missing-description',                'info'),
        ('common.channel-missing-description',            'info'),
        ('common.field-missing-description',              'info'),
        ('common.message-missing-description',            'info'),
        ('common.operation-missing-description',          'warning'),
        ('common.type-missing-description',               'warning'),
        ('common.unstable-field-name',                    'warning'),
        ('common.unstable-type-name',                     'warning'),
        -- Example-conformance pack (example_conformance_lint), IXH-5.4
        ('examples.non-conforming-example',               'warning'),
        -- Intake-stage pack (intake_lint_rules) -- the source as it arrived
        ('intake.blocked-external-ref',                   'warning'),
        ('intake.overlay-action-invalid',                 'warning'),
        ('intake.overlay-unmatched-target',               'warning'),
        ('intake.unresolved-external-ref',                'warning'),
        -- Data-contract paradigm pack (data_contract_lint), FMT-5.5 #5443
        ('data-contract.classification-missing',          'info'),
        ('data-contract.column-description-coverage',     'warning'),
        ('data-contract.freshness-missing',               'info'),
        ('data-contract.owner-missing',                   'warning'),
        ('data-contract.owner-unresolvable',              'warning'),
        ('data-contract.primary-key-missing',             'warning'),
        ('data-contract.quality-rules-missing',           'warning'),
        ('data-contract.retention-undocumented',          'info'),
        ('data-contract.server-missing',                  'warning'),
        ('data-contract.sla-missing',                     'warning'),
        ('data-contract.status-missing',                  'info'),
        ('data-contract.version-missing',                 'warning'),
        -- GraphQL pack (graphql_lint)
        ('graphql.argument-missing-description',          'info'),
        ('graphql.composition-error',                     'error'),
        ('graphql.composition-invalid-key',               'error'),
        ('graphql.composition-non-shareable-field',       'error'),
        ('graphql.composition-unresolvable-selection',    'error'),
        ('graphql.enum-value-missing-description',        'info'),
        ('graphql.naming-argument-camel-case',            'warning'),
        ('graphql.naming-enum-value-upper-case',          'warning'),
        ('graphql.naming-field-camel-case',               'warning'),
        ('graphql.naming-type-pascal-case',               'warning'),
        ('graphql.require-deprecation-reason',            'warning'),
        -- AsyncAPI pack (asyncapi_lint)
        ('asyncapi.message-missing-name',                 'info'),
        ('asyncapi.message-missing-payload',              'warning'),
        ('asyncapi.message-unstable-name',                'warning'),
        ('asyncapi.server-missing-protocol',              'warning'),
        ('asyncapi.server-missing-security',              'info'),
        -- protobuf pack (proto_lint)
        ('protobuf.editions.closed-enum',                 'warning'),
        ('protobuf.editions.delimited-encoding',          'warning'),
        ('protobuf.editions.legacy-json-format',          'warning'),
        ('protobuf.editions.utf8-validation-off',         'info'),
        ('protobuf.field-no-required',                    'warning'),
        ('protobuf.package-version-suffix',               'warning'),
        ('protobuf.reserved-on-deletion',                 'info'),
        -- Arazzo pack (arazzo_lint)
        ('arazzo.async-source-before-1-1',                'error'),
        ('arazzo.dangling-operation-id',                  'error'),
        ('arazzo.missing-success-criteria',               'warning'),
        ('arazzo.unused-workflow-input',                  'warning'),
        ('arzzo.unresolvable-operation-ref',              'error'),
        -- Kubernetes CRD pack (k8s_crd_lint), IXH-7.2
        ('k8s-crd.required-field-hygiene',                'warning'),
        ('k8s-crd.structural-schema-pruning',             'warning'),
        -- LLM tool-bundle pack (llm_tools_lint), IXH-7.3
        ('llm-tools.duplicate-tool-name',                 'error'),
        ('llm-tools.param-missing-description',           'warning'),
        ('llm-tools.prefer-enum-over-freetext',           'info'),
        ('llm-tools.required-field-hygiene',              'warning'),
        ('llm-tools.tool-missing-description',            'warning'),
        ('llm-tools.tool-weak-description',               'info')
    ) AS r(rule_id, severity);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.seed_builtin_style_guide(UUID) IS 'Idempotently (re)seed the read-only "Apiome Recommended" style guide and its canonical rule rows for a tenant, from the full built-in rule registry (#4427, refreshed #5443)';

-- Re-seed every existing tenant so the rules that were being dropped start counting.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT id FROM apiome.tenants LOOP
        PERFORM apiome.seed_builtin_style_guide(t.id);
    END LOOP;
END;
$$;
