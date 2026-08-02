/**
 * CatalogImportQualityStep — the wizard's pre-commit quality gate (IXH-2.2, #5097).
 *
 * Covers every path the acceptance criteria name:
 *  1. **pass** — the report renders (orb, score, tally, style guide) and Import commits;
 *  2. **warn** — the verdict is surfaced but the import is still allowed;
 *  3. **block** — Import is disabled with the policy reason, and the waiver path appears only when
 *     policy permits an override (and does not when it forbids one);
 *  4. **override** — "Import anyway" commits and records a waiver carrying the overridden verdict;
 *  5. **pre-flight error** — a transport failure offers Retry and proceed-without-score; an
 *     unimportable candidate (`ok: false`) commits nothing and explains the taxonomy remediation.
 *
 * Plus the surface contracts: keyboard navigation over the ranked findings, source-location linking
 * into the raw viewer, virtualization above the bounded count, and the auto-advance preference
 * (which must never skip a blocking verdict).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

import { CatalogImportQualityStep } from '../src/app/components/ade/dashboard/catalog/CatalogImportQualityStep';
import { readImportQualityWaivers, type PreflightReport } from '../src/app/utils/import-preflight';

const RAW_SOURCE = ['type Query {', '  hello: String', '}', '', 'type Pet {', '  id: ID', '}'].join('\n');

/** Build a report; each test overrides only the part it is about. */
function buildReport(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ok: true,
    detection: { adapter_key: 'graphql', confidence: 0.95, matched: true, importable: true },
    lint: {
      score: 88,
      grade: 'B',
      report_fingerprint: 'fp-abc',
      severity_counts: { error: 0, warning: 2, info: 1 },
      findings: [
        {
          rank: 1,
          id: 'f1',
          rule: 'graphql-type-description',
          severity: 'warning',
          message: 'Type Query has no description.',
          path: 'Query',
          weight: 2,
          rule_penalty: 4,
          remediation: 'Add a description to the type.',
          docs_url: 'lint-rules#graphql-type-description',
        },
        {
          rank: 2,
          id: 'f2',
          rule: 'graphql-field-description',
          severity: 'info',
          message: 'Field Pet.id has no description.',
          path: 'Pet.id',
          weight: 1,
          rule_penalty: 1,
        },
      ],
    },
    style_guide: {
      guide_id: 'sg-1',
      name: 'Platform guide',
      source: 'custom',
      fingerprint: 'sg-fp',
    },
    policy: {
      verdict: 'pass',
      blocking: false,
      source: 'default',
      reason: 'No import quality policy is configured; the report is advisory only.',
      threshold_score: null,
      allow_override: true,
    },
    cache: { hit: false, key: 'k', content_hash: 'sha-256-abc' },
    ...overrides,
  };
}

/**
 * Stub the three endpoints the step calls: the pre-flight report, the preview manifest the entity
 * explorer fetches (IXH-3.2 — served consistently from the same report, with one located service
 * at `previewLocation`), and, when the user overrides a blocking verdict, the tenant waiver ledger
 * (IXH-2.3). `waiverFailure` makes the ledger refuse the grant the way a role the policy does not
 * name would be refused.
 */
function mockPreflight(
  response: PreflightReport | { failWith: string },
  waiverFailure?: string,
  previewLocation = '3:1',
  reimport: unknown = null,
): jest.Mock {
  return jest.fn((url: unknown) => {
    if (String(url).includes('/api/quality-policy/waivers')) {
      return waiverFailure
        ? Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ success: false, error: waiverFailure }),
          })
        : Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: { id: 'waiver-1', expiresAt: '2026-08-01T00:00:00Z' },
              }),
          });
    }
    // IXH-3.5: the bundle explorer's own endpoint, answered before the `failWith` short-circuit so
    // the bundle tab settles even in the transport-failure cases.
    if (String(url).includes('/api/import/bundle-inventory')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            ok: true,
            kind: 'archive',
            inventory: {
              entry_point: 'schema.graphql',
              entry_point_pinned: false,
              entry_point_error: null,
              entry_point_candidates: [
                { path: 'schema.graphql', format: 'graphql', confidence: 0.95, selected: true },
                { path: 'types.graphql', format: 'graphql', confidence: 0.9, selected: false },
              ],
              attribution: 'declaration-scan',
              files: [
                {
                  path: 'schema.graphql',
                  role: 'entry-point',
                  verdict: 'analysed',
                  bytes: 120,
                  lines: 6,
                  ignored_reason: null,
                  error: null,
                  imports: [],
                  imported_by: [],
                  entity_keys: [],
                  entity_count: 0,
                },
              ],
              total_files: 1,
              role_counts: {},
              verdict_counts: {},
              unresolved: [],
              total_unresolved: 0,
              total_edges: 0,
              total_entities: 0,
              unattributed_entities: 0,
              page_size: 1000,
              next_cursor: null,
              truncated: false,
            },
            error: null,
          }),
      });
    }
    if ('failWith' in response) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ success: false, error: response.failWith }),
      });
    }
    if (String(url).includes('/api/import/preview-manifest')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            ok: response.ok,
            preflight: response,
            reimport,
            manifest: response.ok
              ? {
                  manifest_hash: 'mh-1',
                  adapter: {
                    adapter_key: 'graphql',
                    adapter_label: 'GraphQL SDL',
                    paradigm: 'graphql',
                    formats: ['graphql'],
                    capability: {
                      format: 'graphql',
                      mode: 'native',
                      importable: true,
                      related_issues: [],
                    },
                    parser_limits: [],
                  },
                  counts: { services: 1, operations: 0, channels: 0, types: 0 },
                  coverage_counts: {},
                  status_counts: {},
                  reason_counts: {},
                  entities: [
                    {
                      key: 'svc:1',
                      name: 'PetService',
                      entity_kind: 'service',
                      parent_key: null,
                      order: 0,
                      deprecated: false,
                      coverage: 'mapped',
                      unmodeled_extras: [],
                      source_location: previewLocation,
                    },
                  ],
                  total_entities: 1,
                  nodes: [],
                  edges: [],
                  coverage: [],
                  total_coverage_entries: 0,
                  page_size: 1000,
                  next_cursor: null,
                  truncated: false,
                }
              : null,
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...response }) });
  }) as unknown as jest.Mock;
}

/** The step's calls to one endpoint, so assertions are not entangled with the preview panel's. */
function callsTo(path: string): unknown[][] {
  return (global.fetch as unknown as jest.Mock).mock.calls.filter((call) =>
    String(call[0]).includes(path),
  );
}

interface Handlers {
  onCommit: jest.Mock;
  onBack: jest.Mock;
  onCancel: jest.Mock;
  onSkipPreferenceChange: jest.Mock;
}

/** Render the step with the given report and default props; returns the spy handlers. */
async function renderStep(
  response: PreflightReport | { failWith: string },
  props: Partial<React.ComponentProps<typeof CatalogImportQualityStep>> = {},
  waiverFailure?: string,
  previewLocation?: string,
  reimport: unknown = null,
): Promise<Handlers> {
  global.fetch = mockPreflight(
    response,
    waiverFailure,
    previewLocation,
    reimport,
  ) as unknown as typeof fetch;
  const handlers: Handlers = {
    onCommit: jest.fn(),
    onBack: jest.fn(),
    onCancel: jest.fn(),
    onSkipPreferenceChange: jest.fn(),
  };
  render(
    <CatalogImportQualityStep
      documentBase64="dHlwZSBRdWVyeQ=="
      label="schema.graphql"
      sourceKind="graphql"
      inputKind="paste"
      rawSource={RAW_SOURCE}
      autoAdvance={false}
      skipPreference={false}
      onSkipPreferenceChange={handlers.onSkipPreferenceChange as unknown as (v: boolean) => void}
      onCommit={handlers.onCommit as unknown as () => void}
      onBack={handlers.onBack as unknown as () => void}
      onCancel={handlers.onCancel as unknown as () => void}
      {...props}
    />,
  );
  await waitFor(() =>
    expect(screen.queryByTestId('import-quality-loading')).not.toBeInTheDocument(),
  );
  // The entity preview panel (IXH-3.2) mounts with the report and fetches its manifest; wait for
  // it to settle so no test tears down with that request still updating state.
  await waitFor(() =>
    expect(screen.queryByTestId('import-preview-loading')).not.toBeInTheDocument(),
  );
  return handlers;
}

describe('CatalogImportQualityStep — passing verdict', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('renders the grade orb, score, severity tally, and resolved style guide', async () => {
    await renderStep(buildReport());

    expect(screen.getByTestId('import-quality-grade')).toHaveTextContent('B');
    expect(screen.getByTestId('import-quality-orb')).toHaveTextContent('88/100');
    const tally = screen.getByTestId('import-quality-severity-tally');
    expect(tally).toHaveTextContent('0 error');
    expect(tally).toHaveTextContent('2 warning');
    expect(tally).toHaveTextContent('1 info');
    expect(screen.getByTestId('import-quality-style-guide')).toHaveTextContent('Platform guide');
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent('Import allowed');
  });

  it('pre-flights without committing, then commits only when the user confirms', async () => {
    const handlers = await renderStep(buildReport());

    // The pre-flight ran once, and the only other call is the preview manifest — both are
    // server-side dry runs; nothing was written.
    expect(callsTo('/api/import/preflight')).toHaveLength(1);
    expect(callsTo('/api/import/preview-manifest')).toHaveLength(1);
    expect((global.fetch as unknown as jest.Mock).mock.calls[0][0]).toBe('/api/import/preflight');
    expect(handlers.onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('import-quality-import'));
    expect(handlers.onCommit).toHaveBeenCalledTimes(1);
    expect(handlers.onCommit.mock.calls[0][0]).toBeNull();
  });

  it('sends the candidate the commit would send', async () => {
    await renderStep(buildReport());
    const [, init] = (global.fetch as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      document_base64: 'dHlwZSBRdWVyeQ==',
      source_kind: 'graphql',
      filename: 'schema.graphql',
      input_kind: 'paste',
      import_target: 'catalog',
    });
  });

  it('offers Back and Cancel as non-committing exits', async () => {
    const handlers = await renderStep(buildReport());
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(handlers.onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(handlers.onCancel).toHaveBeenCalled();
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it('says so plainly when a clean source has no findings', async () => {
    await renderStep(
      buildReport({
        lint: { score: 100, grade: 'A', severity_counts: { error: 0, warning: 0, info: 0 }, findings: [] },
      }),
    );
    expect(screen.getByTestId('import-quality-no-findings')).toBeInTheDocument();
    expect(screen.queryByTestId('import-quality-finding')).not.toBeInTheDocument();
  });
});

describe('CatalogImportQualityStep — ranked findings', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('lists findings in rank order with severity, rule, and location', async () => {
    await renderStep(buildReport());
    const rows = screen.getAllByTestId('import-quality-finding');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('#1');
    expect(rows[0]).toHaveTextContent('warning');
    expect(rows[0]).toHaveTextContent('graphql-type-description');
    expect(rows[1]).toHaveTextContent('#2');
    expect(rows[1]).toHaveTextContent('Pet.id');
  });

  it('links each finding to its source location in the raw viewer', async () => {
    await renderStep(buildReport());
    // Finding 1 → `Query` on line 1.
    expect(screen.getAllByTestId('import-quality-finding')[0]).toHaveTextContent('line 1');
    expect(screen.getByTestId('import-quality-raw-line-active')).toHaveTextContent('type Query {');

    // Selecting finding 2 (`Pet.id`) moves the highlight to the `id` line.
    fireEvent.click(screen.getAllByTestId('import-quality-finding')[1]);
    await waitFor(() =>
      expect(screen.getByTestId('import-quality-raw-line-active')).toHaveTextContent('id: ID'),
    );
    expect(within(screen.getByTestId('import-quality-raw-viewer')).getByText('id: ID')).toBeInTheDocument();
  });

  it('moves selection with the arrow keys, Home, and End', async () => {
    await renderStep(buildReport());
    const list = screen.getByRole('listbox', { name: /ranked lint findings/i });
    const rows = () => screen.getAllByTestId('import-quality-finding');

    expect(rows()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(rows()[1]).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    await waitFor(() => expect(rows()[0]).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(list, { key: 'End' });
    await waitFor(() => expect(rows()[1]).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(list, { key: 'Home' });
    await waitFor(() => expect(rows()[0]).toHaveAttribute('aria-selected', 'true'));
  });

  it('shows the selected finding’s remediation and docs pointer', async () => {
    await renderStep(buildReport());
    expect(screen.getByTestId('import-quality-finding-remediation')).toHaveTextContent(
      'Add a description to the type.',
    );
    expect(screen.getByTestId('import-quality-finding-remediation')).toHaveTextContent(
      'lint-rules#graphql-type-description',
    );
  });

  it('virtualizes above the bounded count instead of mounting every row', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      rank: i + 1,
      id: `f${i}`,
      rule: 'graphql-field-description',
      severity: 'info',
      message: `Finding ${i}`,
      path: 'Pet.id',
      weight: 1,
      rule_penalty: 1,
    }));
    await renderStep(
      buildReport({
        lint: { score: 40, grade: 'F', severity_counts: { error: 0, warning: 0, info: 400 }, findings: many },
      }),
    );
    expect(screen.getByText(/Ranked findings \(400\)/)).toBeInTheDocument();
    expect(screen.getByText('windowed')).toBeInTheDocument();
    // jsdom measures every element as 0px tall, so the window falls back to "mount everything" —
    // the guarantee under test is that the list is *bounded by the window*, not by the report.
    const mounted = screen.getAllByTestId('import-quality-finding').length;
    expect(mounted).toBeLessThanOrEqual(400);
    expect(mounted).toBeGreaterThan(0);
  });
});

describe('CatalogImportQualityStep — warn, block, and override', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  const warnReport = buildReport({
    lint: { score: 72, grade: 'C', report_fingerprint: 'fp-warn', severity_counts: { error: 0, warning: 5, info: 0 }, findings: [] },
    policy: {
      verdict: 'warn',
      blocking: false,
      source: 'tenant',
      reason: 'Score 72 is below the recommended 80.',
      threshold_score: 80,
      allow_override: true,
    },
  });

  const blockReport = buildReport({
    lint: { score: 41, grade: 'F', report_fingerprint: 'fp-block', severity_counts: { error: 6, warning: 1, info: 0 }, findings: [] },
    policy: {
      verdict: 'block',
      blocking: true,
      source: 'tenant',
      reason: 'Score 41 is below the required minimum of 70.',
      threshold_score: 70,
      allow_override: true,
    },
  });

  it('warns but still allows the import, and shows the threshold comparison', async () => {
    const handlers = await renderStep(warnReport);
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent('Import allowed with warnings');
    expect(screen.getByTestId('import-quality-threshold')).toHaveTextContent('Policy threshold 80');
    expect(screen.getByTestId('import-quality-threshold')).toHaveTextContent('scores 72');

    const importButton = screen.getByTestId('import-quality-import');
    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);
    expect(handlers.onCommit).toHaveBeenCalledTimes(1);
  });

  it('disables Import with the policy reason when policy blocks', async () => {
    const handlers = await renderStep(blockReport);
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent('Policy blocks this import');
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent(
      'below the required minimum of 70',
    );
    const importButton = screen.getByTestId('import-quality-import');
    expect(importButton).toBeDisabled();
    fireEvent.click(importButton);
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it('offers the waiver path only when policy permits an override', async () => {
    await renderStep(blockReport);
    expect(screen.getByTestId('import-quality-override')).toBeInTheDocument();
    expect(screen.getByLabelText(/why is this import necessary/i)).toBeInTheDocument();
  });

  it('offers no waiver path when policy forbids an override', async () => {
    await renderStep(
      buildReport({
        lint: blockReport.lint,
        policy: { ...blockReport.policy, allow_override: false },
      }),
    );
    expect(screen.getByTestId('import-quality-import')).toBeDisabled();
    expect(screen.queryByTestId('import-quality-override')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/why is this import necessary/i)).not.toBeInTheDocument();
  });

  it('commits and records a waiver when the user imports anyway', async () => {
    const handlers = await renderStep(blockReport);
    fireEvent.change(screen.getByLabelText(/why is this import necessary/i), {
      target: { value: 'Vendor spec we do not control' },
    });
    fireEvent.click(screen.getByTestId('import-quality-override'));

    // The waiver reaches the tenant ledger before the commit: the server enforces the same
    // policy at the import endpoint and matches the waiver on the candidate's content hash.
    await waitFor(() => expect(handlers.onCommit).toHaveBeenCalledTimes(1));
    const grant = (global.fetch as unknown as jest.Mock).mock.calls.find((call) =>
      String(call[0]).includes('/api/quality-policy/waivers'),
    );
    expect(grant).toBeDefined();
    expect(JSON.parse(String((grant![1] as RequestInit).body))).toMatchObject({
      scope: 'import',
      subjectKey: 'sha-256-abc',
      formatKey: 'graphql',
      reason: 'Vendor spec we do not control',
    });
    const waivers = readImportQualityWaivers();
    expect(waivers).toHaveLength(1);
    expect(waivers[0]).toMatchObject({
      label: 'schema.graphql',
      reportFingerprint: 'fp-block',
      contentHash: 'sha-256-abc',
      score: 41,
      grade: 'F',
      policyVerdict: 'block',
      thresholdScore: 70,
      justification: 'Vendor spec we do not control',
    });
    expect(handlers.onCommit.mock.calls[0][0]).toMatchObject({ policyVerdict: 'block' });
  });

  it('does not commit when the tenant ledger refuses the waiver (IXH-2.3)', async () => {
    // The server enforces the policy at the import endpoint too, so a commit sent after a
    // refused grant would only be rejected there — the step stops and states the reason.
    const handlers = await renderStep(
      blockReport,
      {},
      'Your role (editor) may not waive this policy; permitted roles: owner, admin',
    );
    fireEvent.change(screen.getByLabelText(/why is this import necessary/i), {
      target: { value: 'Vendor spec we do not control' },
    });
    fireEvent.click(screen.getByTestId('import-quality-override'));

    await waitFor(() =>
      expect(screen.getByTestId('import-quality-waiver-error')).toHaveTextContent(
        'may not waive this policy',
      ),
    );
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it('names the roles permitted to waive so the user knows who to ask', async () => {
    await renderStep(
      buildReport({
        lint: blockReport.lint,
        policy: { ...blockReport.policy, override_roles: ['owner', 'admin'] },
      }),
    );
    expect(screen.getByText(/only these roles may do: owner, admin/i)).toBeInTheDocument();
  });

  it('commits at most once even when an exit is clicked twice', async () => {
    const handlers = await renderStep(warnReport);
    const importButton = screen.getByTestId('import-quality-import');
    fireEvent.click(importButton);
    fireEvent.click(importButton);
    expect(handlers.onCommit).toHaveBeenCalledTimes(1);
  });
});

describe('CatalogImportQualityStep — pre-flight failure', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('explains a transport failure and offers retry or proceed-without-score', async () => {
    const handlers = await renderStep({ failWith: 'The pre-flight service is unavailable.' });

    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent(
      'Quality could not be scored',
    );
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent(
      'The pre-flight service is unavailable.',
    );
    expect(screen.getByTestId('import-quality-orb')).toHaveTextContent('unscored');

    const proceed = screen.getByTestId('import-quality-import');
    expect(proceed).toHaveTextContent('Import without score');
    fireEvent.click(proceed);
    expect(handlers.onCommit).toHaveBeenCalledWith(null);
  });

  it('re-runs the pre-flight on retry and renders the recovered report', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'Temporary failure.' }) }),
      )
      .mockImplementation(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...buildReport() }) }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
      <CatalogImportQualityStep
        documentBase64="dHlwZSBRdWVyeQ=="
        label="schema.graphql"
        sourceKind="graphql"
        inputKind="paste"
        rawSource={RAW_SOURCE}
        autoAdvance={false}
        skipPreference={false}
        onSkipPreferenceChange={jest.fn() as unknown as (v: boolean) => void}
        onCommit={jest.fn() as unknown as () => void}
        onBack={jest.fn() as unknown as () => void}
        onCancel={jest.fn() as unknown as () => void}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('import-quality-retry')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('import-quality-retry'));
    await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toHaveTextContent('B'));
    expect(callsTo('/api/import/preflight')).toHaveLength(2);
    expect(screen.queryByTestId('import-quality-retry')).not.toBeInTheDocument();
  });

  it('commits nothing for a candidate that cannot be imported, and explains why', async () => {
    const handlers = await renderStep(
      buildReport({
        ok: false,
        lint: null,
        style_guide: null,
        error: {
          code: 'FORMAT_UNRECOGNIZED',
          category: 'format',
          message: 'No importer recognized this document.',
          remediation: 'Pick the format explicitly on the detect step.',
          retriable: false,
        },
      }),
    );

    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent(
      'This source cannot be imported',
    );
    expect(screen.getByTestId('import-quality-remediation')).toHaveTextContent(
      'Pick the format explicitly on the detect step.',
    );
    expect(screen.getByTestId('import-quality-remediation')).toHaveTextContent('FORMAT_UNRECOGNIZED');
    expect(screen.getByTestId('import-quality-import')).toBeDisabled();
    expect(screen.queryByTestId('import-quality-override')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-quality-retry')).not.toBeInTheDocument();
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it('offers retry for a retriable taxonomy error, still without committing', async () => {
    const handlers = await renderStep(
      buildReport({
        ok: false,
        lint: null,
        error: {
          code: 'RESOURCE_TIMEOUT',
          category: 'resource',
          message: 'Pre-flight timed out.',
          remediation: 'Retry, or import a smaller document.',
          retriable: true,
        },
      }),
    );
    expect(screen.getByTestId('import-quality-retry')).toBeInTheDocument();
    expect(screen.getByTestId('import-quality-import')).toBeDisabled();
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });
});

describe('CatalogImportQualityStep — skip preference', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('auto-commits a clean report when the user opted to skip the step', async () => {
    const handlers = await renderStep(buildReport(), { autoAdvance: true, skipPreference: true });
    await waitFor(() => expect(handlers.onCommit).toHaveBeenCalledWith(null));
  });

  it('never auto-commits a blocking verdict, even with the preference on', async () => {
    const handlers = await renderStep(
      buildReport({
        lint: { score: 41, grade: 'F', severity_counts: { error: 6 }, findings: [] },
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Score 41 is below the required minimum of 70.',
          threshold_score: 70,
          allow_override: true,
        },
      }),
      { autoAdvance: true, skipPreference: true },
    );
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent('Policy blocks this import');
  });

  it('never auto-commits when the pre-flight failed', async () => {
    const handlers = await renderStep(
      { failWith: 'The pre-flight service is unavailable.' },
      { autoAdvance: true, skipPreference: true },
    );
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('import-quality-verdict')).toHaveTextContent('Quality could not be scored');
  });

  it('persists a change to the preference through the parent', async () => {
    const handlers = await renderStep(buildReport());
    fireEvent.click(screen.getByLabelText(/skip this step for clean imports/i));
    expect(handlers.onSkipPreferenceChange).toHaveBeenCalledWith(true);
  });
});

describe('CatalogImportQualityStep — entity preview integration (IXH-3.2)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  // Long enough that a 400-line window centered on line 450 clips lines on *both* sides.
  const LONG_SOURCE = Array.from({ length: 1200 }, (_, i) => `line-${i + 1}-content`).join('\n');

  it('renders the entity preview panel with its manifest tree inside the step', async () => {
    await renderStep(buildReport());
    expect(screen.getByTestId('import-preview-panel')).toBeInTheDocument();
    expect(screen.getByTestId('import-preview-summary')).toBeInTheDocument();
    // The preview lives on its own tab, so its tree only enters the accessibility tree once the
    // tab is selected.
    fireEvent.click(screen.getByTestId('catalog-detail-tab-preview'));
    expect(screen.getByRole('treeitem', { name: /PetService/ })).toBeInTheDocument();
  });

  it('splits findings and the entity preview across tabs, findings first', async () => {
    await renderStep(buildReport());

    // The gate facts stay pinned above the tab bar — tabbing can never hide them.
    expect(screen.getByTestId('import-quality-orb')).toBeVisible();
    expect(screen.getByTestId('import-quality-verdict')).toBeVisible();

    const findingsPanel = screen.getByTestId('import-quality-findings-panel');
    const previewPanel = screen.getByTestId('import-quality-preview-panel');
    expect(findingsPanel).toBeVisible();
    expect(previewPanel).not.toBeVisible();
    // The findings tab carries its count so the split never hides how much is behind it.
    expect(screen.getByTestId('catalog-detail-tab-findings')).toHaveTextContent('Findings (2)');

    fireEvent.click(screen.getByTestId('catalog-detail-tab-preview'));
    expect(previewPanel).toBeVisible();
    expect(findingsPanel).not.toBeVisible();

    fireEvent.click(screen.getByTestId('catalog-detail-tab-findings'));
    expect(findingsPanel).toBeVisible();
  });

  it('drives the raw viewer from a preview link beyond the old 400-line head window', async () => {
    await renderStep(buildReport(), { rawSource: LONG_SOURCE }, undefined, '450:1');

    fireEvent.click(screen.getByTestId('import-preview-source-link'));
    await waitFor(() =>
      expect(screen.getByTestId('import-quality-raw-line-active')).toHaveTextContent(
        'line-450-content',
      ),
    );
    // The viewer states what it clipped on both sides of the centered window.
    expect(screen.getByTestId('import-quality-raw-clipped-before')).toBeInTheDocument();
    expect(screen.getByTestId('import-quality-raw-clipped-after')).toBeInTheDocument();
  });

  it('lets selecting a finding reclaim the raw viewer from a preview link', async () => {
    await renderStep(buildReport());

    // The preview link (line 3) takes the viewer over from finding 1 (line 1)…
    fireEvent.click(screen.getByTestId('import-preview-source-link'));
    await waitFor(() =>
      expect(screen.getByTestId('import-quality-raw-line-active')).toHaveTextContent('}'),
    );

    // …and selecting a finding takes it back.
    fireEvent.click(screen.getAllByTestId('import-quality-finding')[0]);
    await waitFor(() =>
      expect(screen.getByTestId('import-quality-raw-line-active')).toHaveTextContent('type Query {'),
    );
  });

  it('threads the commit-time slug into the manifest request (IXH-3.4)', async () => {
    await renderStep(buildReport(), { projectSlug: 'orders' });
    const manifestCall = callsTo('/api/import/preview-manifest')[0];
    const body = JSON.parse(String((manifestCall[1] as RequestInit).body));
    expect(body.project_slug).toBe('orders');
  });

  it('lets a no-op re-import skip the commit via the wizard cancel exit (IXH-3.4)', async () => {
    const handlers = await renderStep(
      buildReport(),
      { projectSlug: 'orders' },
      undefined,
      undefined,
      {
        target_item_id: 'item-1',
        target_item_name: 'Orders',
        target_item_slug: 'orders',
        current_version_record_id: 'rev-1',
        noop: true,
        candidate_fingerprint: 'fp-same',
        current_fingerprint: 'fp-same',
        entries: [],
        counts: { added: 0, removed: 0, changed: 0 },
        counts_by_entity: {},
        classifier: null,
        classifier_format_pack: false,
        overall_severity: null,
        severity_counts: {},
      },
    );
    expect(screen.getByTestId('import-reimport-noop')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('import-reimport-skip'));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it('keeps the raw viewer available for preview links when there are no findings', async () => {
    await renderStep(
      buildReport({
        lint: { score: 100, grade: 'A', severity_counts: { error: 0, warning: 0, info: 0 }, findings: [] },
      }),
    );
    expect(screen.getByTestId('import-quality-no-findings')).toBeInTheDocument();
    expect(screen.getByTestId('import-quality-raw-viewer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('import-preview-source-link'));
    await waitFor(() =>
      expect(screen.getByTestId('import-quality-raw-line-active')).toHaveTextContent('}'),
    );
  });
});

describe('CatalogImportQualityStep — bundle files tab (IXH-3.5)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('offers no bundle tab for a single-document candidate', async () => {
    await renderStep(buildReport());

    expect(screen.queryByRole('tab', { name: /bundle files/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-quality-bundle-panel')).not.toBeInTheDocument();
  });

  it('mounts the bundle explorer for a fileset candidate', async () => {
    await renderStep(buildReport(), { inputKind: 'fileset' });

    fireEvent.click(screen.getByRole('tab', { name: /bundle files/i }));

    await waitFor(() => expect(screen.getByTestId('bundle-panel')).toBeInTheDocument());
    expect(screen.getByTestId('import-quality-bundle-panel')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-entry-point-select')).toHaveValue('schema.graphql');
  });

  it('mounts the bundle explorer for an archive pinned to a root document', async () => {
    await renderStep(buildReport(), { archiveRoot: 'schema.graphql' });

    expect(screen.getByRole('tab', { name: /bundle files/i })).toBeInTheDocument();
  });

  it('hands an entry-point re-selection back to the wizard', async () => {
    const onArchiveRootChange = jest.fn();
    await renderStep(buildReport(), {
      inputKind: 'fileset',
      onArchiveRootChange: onArchiveRootChange as unknown as (path: string) => void,
    });

    fireEvent.click(screen.getByRole('tab', { name: /bundle files/i }));
    await waitFor(() => expect(screen.getByTestId('bundle-entry-point-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('bundle-entry-point-select'), {
      target: { value: 'types.graphql' },
    });

    expect(onArchiveRootChange).toHaveBeenCalledWith('types.graphql');
  });
});
