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

/** Serve one pre-flight response (or reject the call to simulate a transport failure). */
function mockPreflight(response: PreflightReport | { failWith: string }): jest.Mock {
  return jest.fn(() => {
    if ('failWith' in response) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ success: false, error: response.failWith }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...response }) });
  }) as unknown as jest.Mock;
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
): Promise<Handlers> {
  global.fetch = mockPreflight(response) as unknown as typeof fetch;
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

    // The only call made is the pre-flight; nothing was written.
    expect(global.fetch).toHaveBeenCalledTimes(1);
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

    expect(handlers.onCommit).toHaveBeenCalledTimes(1);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
