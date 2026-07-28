/**
 * Loader tests for `useFormatCapabilities` (CPDO-2.4, #4796).
 *
 * The hook is the only place the registry crosses the network, so it is also the only place an
 * untrustworthy registry can be stopped. Its contract:
 *
 * - one fetch per page load, shared by every consumer through the module cache;
 * - a snapshot that fails `validateFormatCapabilitySnapshot` is refused **whole** — rendering
 *   nothing is honest, rendering a bad "the source was not captured" line about a parser limit is
 *   not;
 * - a failed fetch degrades to `null` rather than throwing: the registry explains, it never gates.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  resetFormatCapabilitiesCache,
  useFormatCapabilities,
} from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import type { FormatCapabilitySnapshot } from '@/app/components/ade/dashboard/catalog/formatCapabilityRegistry';

const VALID_SNAPSHOT: FormatCapabilitySnapshot = {
  version: '1',
  review_date: '2026-07-28',
  analysis_schema_version: '1.1.0',
  absence_categories: [
    'absent_in_source',
    'analyzer_failed',
    'format_unsupported',
    'not_analyzed',
    'parse_limit',
    'source_missing',
    'undeclared',
    'value_redacted',
  ],
  absences: [
    {
      category: 'source_missing',
      category_label: 'Source not captured',
      summary_template: 'Nothing to analyse for {construct}.',
      remediation: 'Re-import.',
      source_missing: true,
    },
    {
      category: 'parse_limit',
      category_label: 'Parser limit',
      summary_template: 'apiome does not describe {construct}.',
      remediation: 'Read the source.',
      source_missing: false,
    },
  ],
  reason_absence_categories: {
    not_analyzed: 'not_analyzed',
    no_source_captured: 'source_missing',
    unsupported_format: 'format_unsupported',
    bounds_exceeded: 'parse_limit',
    analyzer_failed: 'analyzer_failed',
  },
  formats: [],
};

/** A probe that renders whatever the hook resolves, so the assertions read off the DOM. */
function Probe() {
  const { snapshot, registryVersion, reviewDate } = useFormatCapabilities(true);
  return (
    <div>
      <span data-testid="version">{registryVersion ?? 'none'}</span>
      <span data-testid="review">{reviewDate ?? 'none'}</span>
      <span data-testid="absences">{snapshot ? String(snapshot.absences.length) : 'none'}</span>
    </div>
  );
}

const originalFetch = global.fetch;

function mockJsonOnce(body: unknown, ok = true): jest.Mock {
  const fetchMock = jest.fn(async () => ({ ok, json: async () => body }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  resetFormatCapabilitiesCache();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.resetAllMocks();
});

describe('useFormatCapabilities', () => {
  it('loads and exposes a valid snapshot', async () => {
    mockJsonOnce({ success: true, ...VALID_SNAPSHOT });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('1'));
    expect(screen.getByTestId('review')).toHaveTextContent('2026-07-28');
    expect(screen.getByTestId('absences')).toHaveTextContent('2');
  });

  it('fetches the registry once and shares it across consumers', async () => {
    const fetchMock = mockJsonOnce({ success: true, ...VALID_SNAPSHOT });
    render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('version')[0]).toHaveTextContent('1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/import/format-capabilities', {
      credentials: 'include',
    });
  });

  it('refuses a snapshot whose parse limit claims the source is missing', async () => {
    mockJsonOnce({
      success: true,
      ...VALID_SNAPSHOT,
      absences: VALID_SNAPSHOT.absences.map((entry) =>
        entry.category === 'parse_limit' ? { ...entry, source_missing: true } : entry,
      ),
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('absences')).toHaveTextContent('none'));
    expect(screen.getByTestId('version')).toHaveTextContent('none');
  });

  it('refuses a snapshot carrying a category outside the vocabulary', async () => {
    mockJsonOnce({
      success: true,
      ...VALID_SNAPSHOT,
      absence_categories: [...VALID_SNAPSHOT.absence_categories, 'category_from_the_future'],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('absences')).toHaveTextContent('none'));
  });

  it('degrades to no registry when the request fails', async () => {
    mockJsonOnce({ success: false, error: 'nope' }, false);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('none'));
  });

  it('degrades to no registry when the response is not the expected shape', async () => {
    mockJsonOnce({ success: true, version: '1' });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('none'));
  });

  it('degrades to no registry when fetch throws', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('none'));
  });

  it('does not fetch while disabled', () => {
    const fetchMock = mockJsonOnce({ success: true, ...VALID_SNAPSHOT });
    function Disabled() {
      useFormatCapabilities(false);
      return <span data-testid="disabled">idle</span>;
    }
    render(<Disabled />);
    expect(screen.getByTestId('disabled')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
