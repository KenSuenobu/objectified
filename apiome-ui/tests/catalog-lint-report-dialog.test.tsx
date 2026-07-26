/**
 * Tests for the server-backed catalog lint report dialog (MFI-23.10, #4019).
 *
 * The dialog fetches lazily (only when open) and renders the same report surface Projects use via
 * the shared LintReportDialog, with an error + retry affordance when the fetch fails.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogLintReportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogLintReportDialog';

const CATALOG_RULES = {
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
};

const REPORT = {
  success: true,
  projectId: 'cat-1',
  versionRecordId: 'rev-1',
  versionId: '1.0.0',
  score: 100,
  grade: 'A',
  capturedScore: 56,
  capturedGrade: 'C',
  scoreIsStale: true,
  findings: [
    {
      id: 'f1',
      path: 'components.schemas.Order',
      category: 'naming',
      rule: 'naming.schema-pascal-case',
      severity: 'warning',
      message: "Schema 'order' is not PascalCase.",
    },
  ],
  ruleHits: { 'naming.schema-pascal-case': 1 },
  severityCounts: { error: 0, warning: 1, info: 0 },
  reportFingerprint: 'fp',
  baseRevisionId: null,
  compatibilityOverall: null,
};

function catalogLintFetchMock(
  reportResolver: () => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>,
) {
  return jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/lint/rules')) {
      return Promise.resolve({ ok: true, json: async () => CATALOG_RULES });
    }
    return reportResolver();
  }) as unknown as typeof fetch;
}

describe('CatalogLintReportDialog', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not fetch while closed', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(
      <CatalogLintReportDialog itemId={null} itemName="Acme" open={false} onOpenChange={() => {}} />,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches lazily on open and renders the server findings', async () => {
    global.fetch = catalogLintFetchMock(() =>
      Promise.resolve({ ok: true, json: async () => REPORT }),
    );
    render(<CatalogLintReportDialog itemId="cat-1" itemName="Acme" open onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId('lint-violation-rule-chip')).toHaveTextContent(
        'naming.schema-pascal-case',
      ),
    );
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('56', { selector: 'span.font-semibold' })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/catalog/cat-1/lint',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(screen.getByText("Schema 'order' is not PascalCase.")).toBeInTheDocument();
  });

  it('opens expanded to 90vh with the findings list flex-filling the height', async () => {
    global.fetch = catalogLintFetchMock(() =>
      Promise.resolve({ ok: true, json: async () => REPORT }),
    );
    render(<CatalogLintReportDialog itemId="cat-1" itemName="Acme" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // The dialog is pinned to 90% of the viewport height (and widened) for reading room…
    const content = screen.getByRole('dialog');
    expect(content.className).toContain('h-[90vh]');
    expect(content.className).toContain('max-w-6xl');
    // …and the findings list flexes to consume the remaining height instead of a 50vh cap.
    await waitFor(() =>
      expect(screen.getByTestId('lint-report-findings-scroll').className).toContain('flex-1'),
    );
    expect(screen.getByTestId('lint-report-findings-scroll').className).not.toContain('max-h-[50vh]');
  });

  it('shows an error with a retry that re-fetches successfully', async () => {
    let catalogLintCalls = 0;
    const fetchMock = catalogLintFetchMock(() => {
      catalogLintCalls += 1;
      if (catalogLintCalls === 1) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ success: false, detail: 'No revision to lint' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => REPORT });
    });
    global.fetch = fetchMock;

    render(<CatalogLintReportDialog itemId="cat-1" itemName="Acme" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('lint-report-error')).toBeInTheDocument());
    expect(screen.getByText('No revision to lint')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() =>
      expect(screen.getByTestId('lint-violation-rule-chip')).toHaveTextContent(
        'naming.schema-pascal-case',
      ),
    );
    const lintCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/catalog/cat-1/lint'),
    );
    expect(lintCalls).toHaveLength(2);
  });
});
