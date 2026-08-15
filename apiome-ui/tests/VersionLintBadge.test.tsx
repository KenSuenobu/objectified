/**
 * Server-backed version lint badge (#3609) — lazy, record-first since #5259.
 *
 * The badge renders from the score/grade stored on the version record and never fetches on
 * mount; the full report is fetched only when the badge is clicked.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  VersionLintBadge,
  resolveLintHeadline,
} from '../src/app/components/ade/dashboard/VersionLintBadge';

const REPORT = {
  success: true,
  projectId: 'p1',
  versionRecordId: 'v1',
  versionId: '1.0.0',
  score: 72,
  grade: 'C',
  findings: [
    {
      id: 'lint-1',
      path: 'components.schemas.payment',
      category: 'naming',
      rule: 'naming.schema-pascal-case',
      severity: 'warning',
      message: "Schema 'payment' is not PascalCase.",
    },
  ],
  ruleHits: { 'naming.schema-pascal-case': 1 },
  severityCounts: { error: 0, warning: 1, info: 0 },
  reportFingerprint: 'abc',
  baseRevisionId: null,
  compatibilityOverall: null,
};

/** Only the lint-report calls (the dialog also loads the rule catalog on open). */
function lintFetchCalls(): string[] {
  const calls = (global.fetch as jest.Mock).mock.calls as Array<[RequestInfo | URL]>;
  return calls
    .map(([input]) => (typeof input === 'string' ? input : input.toString()))
    .filter((url) => /\/versions\/[^/]+\/lint(\?|$)/.test(url));
}

function mockBadgeFetch(report: object) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/lint/rules')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          rules: [
            {
              ruleId: 'naming.schema-pascal-case',
              pack: 'openapi',
              category: 'naming',
              defaultSeverity: 'warning',
              rationale: 'Component schema names should be PascalCase.',
              docsAnchor: 'naming-schema-pascal-case',
            },
          ],
          count: 1,
          docsPage: 'docs/guide/lint-rules.md',
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => report });
  }) as unknown as typeof fetch;
}

describe('resolveLintHeadline', () => {
  it('prefers a fetched report over the stored record values', () => {
    expect(
      resolveLintHeadline(40, 'F', { ...REPORT, score: 72, grade: 'C' } as never)
    ).toEqual({ score: 72, grade: 'C' });
  });

  it('uses the stored record values when no report is held', () => {
    expect(resolveLintHeadline(82, 'B', null)).toEqual({ score: 82, grade: 'B' });
    expect(resolveLintHeadline(0, 'F', null)).toEqual({ score: 0, grade: 'F' });
  });

  it('has no headline when the record is unscored', () => {
    expect(resolveLintHeadline(null, null, null)).toBeNull();
    expect(resolveLintHeadline(undefined, undefined, null)).toBeNull();
    expect(resolveLintHeadline(82, null, null)).toBeNull();
  });
});

describe('VersionLintBadge', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the stored grade and score without fetching', () => {
    mockBadgeFetch(REPORT);

    render(
      <VersionLintBadge
        projectId="p1"
        versionId="v1"
        versionLabel="1.0.0"
        storedScore={82}
        storedGrade="B"
      />
    );

    expect(screen.getByTestId('version-lint-badge')).toHaveTextContent('B · 82');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders an unscored chip without fetching when the record has no score', () => {
    mockBadgeFetch(REPORT);

    render(<VersionLintBadge projectId="p1" versionId="v1" versionLabel="1.0.0" />);

    expect(screen.getByTestId('version-lint-badge-unscored')).toHaveTextContent('Lint —');
    expect(screen.queryByTestId('version-lint-badge')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('issues zero lint requests for a whole list of badges (#5259)', () => {
    mockBadgeFetch(REPORT);

    render(
      <>
        {Array.from({ length: 50 }, (_, i) => (
          <VersionLintBadge
            key={`v${i}`}
            projectId="p1"
            versionId={`v${i}`}
            storedScore={i % 2 === 0 ? 90 : null}
            storedGrade={i % 2 === 0 ? 'A' : null}
          />
        ))}
      </>
    );

    expect(screen.getAllByTestId('version-lint-badge')).toHaveLength(25);
    expect(screen.getAllByTestId('version-lint-badge-unscored')).toHaveLength(25);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches the report only on click and shows itemized findings', async () => {
    mockBadgeFetch(REPORT);

    render(
      <VersionLintBadge
        projectId="p1"
        versionId="v1"
        versionLabel="1.0.0"
        storedScore={72}
        storedGrade="C"
      />
    );
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('version-lint-badge'));

    await waitFor(() => expect(screen.getByText(/Quality & Lint report/)).toBeInTheDocument());
    expect(lintFetchCalls()).toEqual(['/api/projects/p1/versions/v1/lint']);
    await waitFor(() => {
      expect(screen.getByTestId('lint-violation-rule-chip')).toHaveTextContent(
        'naming.schema-pascal-case'
      );
    });
    expect(screen.getByText("Schema 'payment' is not PascalCase.")).toBeInTheDocument();
  });

  it('updates the chip from the fetched report when the server re-linted', async () => {
    // The record said B·82; the content changed, so the server re-linted to C·72 (and stored it).
    mockBadgeFetch(REPORT);

    render(
      <VersionLintBadge projectId="p1" versionId="v1" storedScore={82} storedGrade="B" />
    );
    expect(screen.getByTestId('version-lint-badge')).toHaveTextContent('B · 82');

    fireEvent.click(screen.getByTestId('version-lint-badge'));

    await waitFor(() =>
      expect(screen.getByTestId('version-lint-badge')).toHaveTextContent('C · 72')
    );
  });

  it('lints an unscored revision on demand and turns the chip into a grade', async () => {
    mockBadgeFetch(REPORT);

    render(<VersionLintBadge projectId="p1" versionId="v1" versionLabel="1.0.0" />);

    fireEvent.click(screen.getByTestId('version-lint-badge-unscored'));

    await waitFor(() =>
      expect(screen.getByTestId('version-lint-badge')).toHaveTextContent('C · 72')
    );
    expect(lintFetchCalls()).toEqual(['/api/projects/p1/versions/v1/lint']);
  });

  it('reuses the held report when the dialog is re-opened (one fetch total)', async () => {
    mockBadgeFetch(REPORT);

    render(
      <VersionLintBadge projectId="p1" versionId="v1" storedScore={72} storedGrade="C" />
    );

    fireEvent.click(screen.getByTestId('version-lint-badge'));
    await waitFor(() => expect(screen.getByText(/Quality & Lint report/)).toBeInTheDocument());
    // Close via the dialog's overlay-less escape path: press Escape.
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByText(/Quality & Lint report/)).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId('version-lint-badge'));
    await waitFor(() => expect(screen.getByText(/Quality & Lint report/)).toBeInTheDocument());
    expect(lintFetchCalls()).toHaveLength(1);
  });

  it('shows a stale-score note in the dialog when the persisted score is out of date', async () => {
    const staleReport = {
      ...REPORT,
      capturedScore: 55,
      capturedGrade: 'D',
      capturedReportFingerprint: 'old',
      scoreIsStale: true,
    };
    mockBadgeFetch(staleReport);

    render(
      <VersionLintBadge
        projectId="p1"
        versionId="v1"
        versionLabel="1.0.0"
        storedScore={55}
        storedGrade="D"
      />
    );

    fireEvent.click(screen.getByTestId('version-lint-badge'));

    await waitFor(() =>
      expect(screen.getByTestId('version-lint-stale-note')).toBeInTheDocument()
    );
    expect(screen.getByTestId('version-lint-stale-note')).toHaveTextContent('D · 55');
    expect(screen.getByTestId('version-lint-stale-note')).toHaveTextContent('out of date');
  });

  it('omits the stale-score note when the persisted score is current', async () => {
    mockBadgeFetch(REPORT);

    render(
      <VersionLintBadge
        projectId="p1"
        versionId="v1"
        versionLabel="1.0.0"
        storedScore={72}
        storedGrade="C"
      />
    );

    fireEvent.click(screen.getByTestId('version-lint-badge'));
    await waitFor(() => expect(screen.getByText(/Quality & Lint report/)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('lint-violation-rule-chip')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('version-lint-stale-note')).not.toBeInTheDocument();
  });

  it('shows the error and a retry affordance in the dialog when the fetch fails', async () => {
    let attempts = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/lint/rules')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, rules: [] }) });
      }
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'boom' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => REPORT });
    }) as unknown as typeof fetch;

    render(<VersionLintBadge projectId="p1" versionId="v1" />);

    fireEvent.click(screen.getByTestId('version-lint-badge-unscored'));

    await waitFor(() => expect(screen.getByTestId('lint-report-error')).toBeInTheDocument());
    expect(screen.getByTestId('lint-report-error')).toHaveTextContent('boom');
    // The chip stays unscored: a failed fetch never fabricates a grade.
    expect(screen.getByTestId('version-lint-badge-unscored')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getByTestId('version-lint-badge')).toHaveTextContent('C · 72')
    );
    expect(lintFetchCalls()).toHaveLength(2);
  });
});
