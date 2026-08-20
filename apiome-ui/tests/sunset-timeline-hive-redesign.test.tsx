/**
 * The Sunset timeline redesign, rendered (HIVE-8.2, #5328).
 *
 * `sunset-timeline-model.test.ts` holds the decisions and `sunset-timeline-css.test.ts` pins
 * the declarations; this holds the screen that makes them, mounted against a mocked
 * `/api/versions/sunset-timeline` returning the mockup's four rows. What it pins is the
 * ticket's five acceptance criteria and the mockup's **Notes → Keeps (1:1)** list:
 *
 *   1. **The timeline and the table always agree** — every marker has a row, every row is
 *      either a marker or is counted in the card's sentence, and selecting a marker marks its
 *      row.
 *   2. **The status vocabulary matches the server** — the badge and the diamond read the same
 *      normalised status, and the tone comes from the shared vocabulary rather than from a
 *      palette string in this screen.
 *   3. **The timeline is keyboard reachable, and each marker names its UTC instant.**
 *   4. **The CSV export is unchanged** — the same seven fields, the same file name, still
 *      disabled on an empty schedule.
 *   5. The lanes **follow the project filter**, because the drawing is handed the same rows
 *      the table is.
 *
 * Plus the two things the screen this replaces got wrong and this ticket fixes: a failed read
 * drawn as an empty workspace, and status colours frozen on one light palette and one dark one.
 *
 * The clock is frozen at `2026-08-15T12:00:00Z` — the instant the mockup is drawn at — so the
 * countdown chips here are the ones the mockup prints.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

/** The signed-in user the screen reads. Mutable, so one test can sign in with no workspace. */
let sessionUser: Record<string, unknown> | null = {
  user_id: 'u-ada',
  current_tenant_id: 't-acme',
  email: 'ada@acme.io',
};

/** The session's own load state, so the "still checking" branch can be rendered. */
let sessionStatus = 'authenticated';

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionUser ? { user: sessionUser } : null,
    status: sessionStatus,
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/versions/sunset-timeline',
}));

import SunsetTimelinePage from '../src/app/ade/dashboard/versions/sunset-timeline/page';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import { STATUS_TONE_SOFT_CLASS, statusTone } from '../src/app/components/ui/statusVocabulary';
import {
  SUNSET_CSV_FILENAME,
  sunsetCsv,
  type SunsetEntry,
} from '../src/app/components/ade/sunset/sunsetModel';

// ---------------------------------------------------------------------------------------
// Fixtures — the four rows the mockup draws
// ---------------------------------------------------------------------------------------

/** The instant the mockup is drawn at. */
const NOW = Date.parse('2026-08-15T12:00:00Z');

const ORDERS_PAST: SunsetEntry = {
  revisionId: 'rev-orders-12',
  projectId: 'prj-orders',
  projectName: 'Orders Service',
  projectSlug: 'orders-service',
  versionLine: 'v1.2.x',
  sunsetDate: '2026-07-15T00:00:00Z',
  sunsetAt: '2026-07-15T00:00:00Z',
  timelineStatus: 'past',
  lifecyclePhase: 'sunset_reached',
  deprecationMessage: 'Removed GET /orders/legacy — requests now 410.',
  successorRevisionId: 'ver_2ab4d1e0',
  published: true,
  deprecationWarnings: [],
};

const ORDERS_IMMINENT: SunsetEntry = {
  revisionId: 'rev-orders-14',
  projectId: 'prj-orders',
  projectName: 'Orders Service',
  projectSlug: 'orders-service',
  versionLine: 'v1.4.x',
  sunsetDate: '2026-08-27T00:00:00Z',
  sunsetAt: '2026-08-27T00:00:00Z',
  timelineStatus: 'imminent',
  lifecyclePhase: 'deprecated',
  deprecationMessage: null,
  successorRevisionId: 'ver_9cc01b77',
  published: true,
  deprecationWarnings: [
    {
      revisionId: 'rev-orders-14',
      message: '2 consumers still on this line — breaking removal of cart v1 endpoints.',
      migrationGuideUrl: 'https://guides.example.com/orders-v1',
    },
  ],
};

const PAYMENTS_SCHEDULED: SunsetEntry = {
  revisionId: 'rev-payments-22',
  projectId: 'prj-payments',
  projectName: 'Payments API',
  projectSlug: 'payments-api',
  versionLine: 'v2.2.x',
  sunsetDate: '2026-09-30T00:00:00Z',
  sunsetAt: '2026-09-30T00:00:00Z',
  // The server's own third status — the one this screen renames.
  timelineStatus: 'announced',
  lifecyclePhase: 'deprecated',
  deprecationMessage: 'Migrate to /payment-intents before sunset.',
  successorRevisionId: 'ver_4c8e1b09',
  published: true,
  deprecationWarnings: [],
};

const INVENTORY_SCHEDULED: SunsetEntry = {
  revisionId: 'rev-inventory-05',
  projectId: 'prj-inventory',
  projectName: 'Inventory Events',
  projectSlug: 'inventory-events',
  versionLine: 'v0.5.x',
  sunsetDate: '2026-11-30T00:00:00Z',
  sunsetAt: '2026-11-30T00:00:00Z',
  timelineStatus: 'announced',
  lifecyclePhase: 'deprecated',
  deprecationMessage: 'No successor (end of life). Channel stock.v0 stops emitting.',
  successorRevisionId: null,
  published: true,
  deprecationWarnings: [],
};

const ROWS: SunsetEntry[] = [
  ORDERS_PAST,
  ORDERS_IMMINENT,
  PAYMENTS_SCHEDULED,
  INVENTORY_SCHEDULED,
];

/** The projects the filter offers. */
const PROJECTS = [
  { id: 'prj-orders', name: 'Orders Service', slug: 'orders-service' },
  { id: 'prj-payments', name: 'Payments API', slug: 'payments-api' },
  { id: 'prj-inventory', name: 'Inventory Events', slug: 'inventory-events' },
];

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** Every `fetch` the screen made, in order. */
let calls: string[] = [];

/** What the timeline endpoint answers with next. */
let timelineResponse: { ok: boolean; body: unknown } = {
  ok: true,
  body: { success: true, entries: ROWS },
};

/** A `fetch` that answers the two endpoints this screen reads. */
function installFetch() {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/projects')) {
      return {
        ok: true,
        json: async () => ({ projects: PROJECTS }),
      } as Response;
    }
    return {
      ok: timelineResponse.ok,
      json: async () => timelineResponse.body,
    } as Response;
  }) as unknown as typeof fetch;
}

/**
 * Mount the screen and wait for its first read to land.
 *
 * @returns The render result.
 */
async function renderScreen() {
  const result = render(
    <TooltipProvider>
      <SunsetTimelinePage />
    </TooltipProvider>
  );
  // The read has settled when `DataTable` has stopped drawing its `aria-hidden` skeleton
  // rows — true for all three landings (rows, empty, failed), and unlike counting microtask
  // hops it does not depend on how many `await`s the mocked `fetch` happens to take.
  await waitFor(() => {
    expect(screen.getByTestId('sunset-table').querySelectorAll('tr[aria-hidden]')).toHaveLength(0);
  });
  // The clock effect runs once the rows have landed, so the drawing is a commit behind them.
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

beforeEach(() => {
  calls = [];
  sessionUser = { user_id: 'u-ada', current_tenant_id: 't-acme', email: 'ada@acme.io' };
  sessionStatus = 'authenticated';
  timelineResponse = { ok: true, body: { success: true, entries: ROWS } };
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  installFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------
// The page chrome
// ---------------------------------------------------------------------------------------

describe('the page chrome', () => {
  it('draws the Hive page header rather than the screen’s own bar', async () => {
    await renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: 'Sunset timeline' })).toBeInTheDocument();
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByText('Ship')).toBeInTheDocument();
    expect(trail.getByText('Sunset timeline')).toBeInTheDocument();
  });

  it('keeps the subtitle’s two facts: where the dates come from, and what imminent means', async () => {
    await renderScreen();
    const description = screen.getByText(/End-of-life schedule for deprecated revisions/);
    expect(description).toHaveTextContent('versions.metadata, #507');
    expect(description).toHaveTextContent('imminent means sunset within 30 days');
  });

  it('offers exactly one page action — the export', async () => {
    await renderScreen();
    expect(screen.getByTestId('sunset-export')).toHaveTextContent('Export CSV');
  });
});

// ---------------------------------------------------------------------------------------
// The table — the source of truth, kept 1:1
// ---------------------------------------------------------------------------------------

describe('the table', () => {
  it('keeps the mockup’s seven columns, in order', async () => {
    await renderScreen();
    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent?.trim());
    expect(headers).toEqual([
      'Project',
      'Version line',
      'Sunset',
      'Timeline',
      'Lifecycle',
      'Successor',
      'Notes / #507',
    ]);
  });

  it('prints the stored UTC instant, not a re-formatted one', async () => {
    await renderScreen();
    expect(screen.getByText('2026-07-15T00:00:00Z')).toBeInTheDocument();
    expect(screen.getByText('2026-11-30T00:00:00Z')).toBeInTheDocument();
  });

  it('prints an em dash where the API had no successor', async () => {
    await renderScreen();
    const row = screen.getByTestId('sunset-status-rev-inventory-05').closest('tr') as HTMLElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('shows the first structured warning, and falls back to the deprecation message', async () => {
    await renderScreen();
    expect(
      screen.getByText('2 consumers still on this line — breaking removal of cart v1 endpoints.')
    ).toBeInTheDocument();
    expect(screen.getByText('Migrate to /payment-intents before sunset.')).toBeInTheDocument();
  });

  it('links each row to its migration guide, in a new tab, and says so', async () => {
    await renderScreen();
    const row = screen.getByTestId('sunset-status-rev-orders-14').closest('tr') as HTMLElement;
    const link = within(row).getByRole('link', { name: /Migration guide/ });
    expect(link).toHaveAttribute('href', 'https://guides.example.com/orders-v1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The "new tab" warning is on the label, not in an `sr-only` span — an absolutely
    // positioned box inside a `<td>` escapes the table's scroll container (HIVE-7.3).
    expect(link).toHaveAccessibleName('Migration guide (opens in a new tab)');
    expect(row.querySelector('.sr-only')).toBeNull();
  });

  it('prints both lifecycle sentences', async () => {
    await renderScreen();
    expect(screen.getByText('Sunset reached (read-only / redirect)')).toBeInTheDocument();
    expect(screen.getAllByText('Deprecated (migrate before sunset)')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------
// The status vocabulary
// ---------------------------------------------------------------------------------------

describe('the status badge', () => {
  it('renames the server’s announced to the word the legend uses', async () => {
    await renderScreen();
    expect(screen.getByTestId('sunset-status-rev-payments-22')).toHaveTextContent('scheduled');
    expect(screen.queryByText('announced')).not.toBeInTheDocument();
  });

  it('takes its colour from the shared vocabulary, never from a palette string on this screen', async () => {
    await renderScreen();
    for (const [revision, status] of [
      ['rev-orders-12', 'past'],
      ['rev-orders-14', 'imminent'],
      ['rev-payments-22', 'scheduled'],
    ] as const) {
      const badge = screen.getByTestId(`sunset-status-${revision}`);
      expect(badge).toHaveAttribute('data-status', status);
      for (const token of STATUS_TONE_SOFT_CLASS[statusTone(status)].split(' ')) {
        expect(badge).toHaveClass(token);
      }
    }
  });

  it('never leaves the tone as the only signal — every badge carries its word and a dot', async () => {
    await renderScreen();
    const badge = screen.getByTestId('sunset-status-rev-orders-12');
    expect(badge).toHaveTextContent('past');
    expect(within(badge).getByTestId('badge-dot')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------------------

describe('the timeline', () => {
  it('is drawn above the table, not instead of it', async () => {
    await renderScreen();
    const card = screen.getByTestId('sunset-timeline-card');
    const table = screen.getByTestId('sunset-table');
    expect(card.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names itself, its span and how much of the schedule it holds', async () => {
    await renderScreen();
    expect(screen.getByTestId('sunset-timeline-svg')).toHaveAttribute(
      'aria-label',
      'Sunset timeline: 4 sunsets across 3 projects, Jul 2026 to Dec 2026.'
    );
  });

  it('draws six month columns and a today rule', async () => {
    await renderScreen();
    const svg = screen.getByTestId('sunset-timeline-svg');
    expect(svg.querySelectorAll('.stl-grid line')).toHaveLength(6);
    expect(screen.getByTestId('sunset-timeline-today')).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText('Jul 2026')).toBeInTheDocument();
  });

  it('draws one lane per project and one marker per plotted revision', async () => {
    await renderScreen();
    const svg = screen.getByTestId('sunset-timeline-svg');
    expect(svg.querySelectorAll('.stl-lane')).toHaveLength(3);
    expect(svg.querySelectorAll('.stl-marker')).toHaveLength(4);
  });

  it('prints the mockup’s own countdown chips', async () => {
    await renderScreen();
    const svg = within(screen.getByTestId('sunset-timeline-svg') as unknown as HTMLElement);
    expect(svg.getByText('v1.4.x · 12 d')).toBeInTheDocument();
    expect(svg.getByText('v2.2.x · 46 d')).toBeInTheDocument();
    expect(svg.getByText('v0.5.x · 107 d')).toBeInTheDocument();
    expect(svg.getByText('v1.2.x · past')).toBeInTheDocument();
  });

  it('legends all three statuses in words as well as swatches', async () => {
    await renderScreen();
    const legend = within(screen.getByTestId('sunset-timeline-legend'));
    expect(legend.getByText('past')).toBeInTheDocument();
    expect(legend.getByText('imminent (≤ 30 days)')).toBeInTheDocument();
    expect(legend.getByText('scheduled')).toBeInTheDocument();
  });

  it('reconciles itself with the table in its footer', async () => {
    await renderScreen();
    expect(screen.getByTestId('sunset-timeline-summary')).toHaveTextContent(
      '4 of 4 entries on the timeline · all of them in the table below.'
    );
  });

  it('says what it could not draw rather than dropping it', async () => {
    timelineResponse = {
      ok: true,
      body: {
        success: true,
        entries: [
          ...ROWS,
          { ...ORDERS_PAST, revisionId: 'rev-undated', sunsetAt: null, sunsetDate: null },
          { ...PAYMENTS_SCHEDULED, revisionId: 'rev-far', sunsetAt: '2029-01-01T00:00:00Z' },
        ],
      },
    };
    await renderScreen();
    expect(screen.getByTestId('sunset-timeline-summary')).toHaveTextContent(
      '4 of 6 entries on the timeline · 1 outside this six-month window · 1 with no sunset date · all of them in the table below.'
    );
    // Both unplottable rows are still in the table, which is the point of saying so.
    expect(screen.getAllByRole('row')).toHaveLength(7);
  });

  it('is not drawn at all when nothing in the schedule can be placed', async () => {
    timelineResponse = {
      ok: true,
      body: {
        success: true,
        entries: [{ ...ORDERS_PAST, sunsetAt: null, sunsetDate: null }],
      },
    };
    await renderScreen();
    expect(screen.queryByTestId('sunset-timeline-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('sunset-table')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Keyboard and the marker → row link
// ---------------------------------------------------------------------------------------

describe('every marker is a control', () => {
  it('is reachable by keyboard and named with its UTC instant', async () => {
    await renderScreen();
    const marker = screen.getByTestId('sunset-marker-rev-payments-22');
    expect(marker).toHaveAttribute('role', 'button');
    expect(marker).toHaveAttribute('tabindex', '0');
    expect(marker).toHaveAttribute(
      'aria-label',
      'Payments API v2.2.x — sunset 30 Sep 2026 00:00 UTC (scheduled, in 46 days). Show this row in the table.'
    );
  });

  it('keeps the mockup’s native tooltip saying the same thing as the label', async () => {
    await renderScreen();
    const marker = screen.getByTestId('sunset-marker-rev-orders-14');
    expect(marker.querySelector('title')?.textContent).toBe(marker.getAttribute('aria-label'));
  });

  it('marks the row it points at when it is clicked', async () => {
    await renderScreen();
    await userEvent.click(screen.getByTestId('sunset-marker-rev-orders-14'));
    const row = screen.getByTestId('sunset-status-rev-orders-14').closest('tr') as HTMLElement;
    expect(row).toHaveClass('stl-row--current');
    expect(screen.getByTestId('sunset-marker-rev-orders-14')).toHaveAttribute('data-current');
  });

  it('does the same from the keyboard, on both Enter and Space', async () => {
    await renderScreen();
    for (const key of ['{Enter}', ' ']) {
      const marker = screen.getByTestId('sunset-marker-rev-payments-22');
      marker.focus();
      expect(marker).toHaveFocus();
      await userEvent.keyboard(key);
      expect(
        screen.getByTestId('sunset-status-rev-payments-22').closest('tr')
      ).toHaveClass('stl-row--current');
      await userEvent.click(screen.getByTestId('sunset-marker-rev-orders-12'));
    }
  });

  it('scrolls the row it points at into view', async () => {
    const scrollIntoView = jest
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    await renderScreen();
    await userEvent.click(screen.getByTestId('sunset-marker-rev-orders-14'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('scrolls without animating for a reader who has asked for less motion', async () => {
    // DESIGN.md §3.4. Read off `html[data-motion]`, which is what the stylesheet keys on.
    document.documentElement.dataset.motion = 'reduce';
    const scrollIntoView = jest
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    try {
      await renderScreen();
      await userEvent.click(screen.getByTestId('sunset-marker-rev-orders-14'));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it('marks exactly one row at a time', async () => {
    const { container } = await renderScreen();
    await userEvent.click(screen.getByTestId('sunset-marker-rev-orders-14'));
    await userEvent.click(screen.getByTestId('sunset-marker-rev-payments-22'));
    expect(container.querySelectorAll('.stl-row--current')).toHaveLength(1);
  });

  it('drops a selection whose row is no longer in the table', async () => {
    const { container } = await renderScreen();
    await userEvent.click(screen.getByTestId('sunset-marker-rev-orders-14'));
    expect(container.querySelectorAll('.stl-row--current')).toHaveLength(1);

    timelineResponse = { ok: true, body: { success: true, entries: [PAYMENTS_SCHEDULED] } };
    await act(async () => {
      await userEvent.click(screen.getByRole('combobox', { name: 'Filter by project' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Payments API' }));
    });
    await waitFor(() =>
      expect(container.querySelectorAll('.stl-row--current')).toHaveLength(0)
    );
  });
});

// ---------------------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------------------

describe('the project filter', () => {
  it('offers every project plus the all-projects option', async () => {
    await renderScreen();
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by project' }));
    expect(await screen.findByRole('option', { name: 'All projects' })).toBeInTheDocument();
    for (const project of PROJECTS) {
      expect(screen.getByRole('option', { name: project.name })).toBeInTheDocument();
    }
  });

  it('re-reads the schedule scoped to the chosen project', async () => {
    await renderScreen();
    timelineResponse = { ok: true, body: { success: true, entries: [PAYMENTS_SCHEDULED] } };
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Payments API' }));
    await waitFor(() =>
      expect(calls).toContain('/api/versions/sunset-timeline?projectId=prj-payments')
    );
  });

  it('narrows the lanes with the rows, because the drawing is handed what the table has', async () => {
    await renderScreen();
    expect(screen.getByTestId('sunset-timeline-svg').querySelectorAll('.stl-lane')).toHaveLength(3);

    timelineResponse = { ok: true, body: { success: true, entries: [PAYMENTS_SCHEDULED] } };
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Payments API' }));

    await waitFor(() =>
      expect(screen.getByTestId('sunset-timeline-svg').querySelectorAll('.stl-lane')).toHaveLength(1)
    );
  });

  it('still shows the whole schedule when the project list cannot be read', async () => {
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/projects')) throw new Error('offline');
      return { ok: true, json: async () => ({ success: true, entries: ROWS }) } as Response;
    }) as unknown as typeof fetch;
    await renderScreen();
    expect(screen.getAllByRole('row')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------------------

describe('the CSV export', () => {
  it('writes the model’s file, under the unchanged name', async () => {
    // jsdom's `Blob` implements no `text()`, so the parts are captured on the way in —
    // which also proves the screen hands the model's own output to the download rather
    // than building a second CSV of its own.
    const parts: unknown[][] = [];
    const options: (BlobPropertyBag | undefined)[] = [];
    const RealBlob = global.Blob;
    class RecordingBlob extends RealBlob {
      constructor(chunks: BlobPart[] = [], init?: BlobPropertyBag) {
        super(chunks, init);
        parts.push(chunks);
        options.push(init);
      }
    }
    global.Blob = RecordingBlob as unknown as typeof Blob;

    const createObjectURL = jest.fn(() => 'blob:sunset');
    const revokeObjectURL = jest.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    try {
      await renderScreen();
      await userEvent.click(screen.getByTestId('sunset-export'));
    } finally {
      global.Blob = RealBlob;
    }

    expect(click).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(parts).toEqual([[sunsetCsv(ROWS)]]);
    expect(options[0]).toEqual({ type: 'text/csv;charset=utf-8' });
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('names the download exactly as it always has', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:sunset', revokeObjectURL: () => undefined });
    let downloaded: string | null = null;
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await renderScreen();
    await userEvent.click(screen.getByTestId('sunset-export'));
    expect(downloaded).toBe(SUNSET_CSV_FILENAME);
  });

  it('is disabled while there is nothing to export', async () => {
    timelineResponse = { ok: true, body: { success: true, entries: [] } };
    await renderScreen();
    expect(screen.getByTestId('sunset-export')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------------------

describe('the states', () => {
  it('raises the #507 banner only when a row carries a structured warning', async () => {
    await renderScreen();
    expect(screen.getByTestId('sunset-warnings')).toHaveTextContent(
      'Rows include the same structured warnings as compatibility checks (#507).'
    );

    timelineResponse = { ok: true, body: { success: true, entries: [PAYMENTS_SCHEDULED] } };
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Payments API' }));
    await waitFor(() => expect(screen.queryByTestId('sunset-warnings')).not.toBeInTheDocument());
  });

  it('draws the empty state inside the table card, with a way to Versions', async () => {
    timelineResponse = { ok: true, body: { success: true, entries: [] } };
    await renderScreen();
    expect(screen.getByText('No deprecation or sunset entries')).toBeInTheDocument();
    expect(screen.getByTestId('sunset-empty-versions')).toHaveAttribute(
      'href',
      '/ade/dashboard/versions'
    );
    // The toolbar and the foot are still there — the search for the way out does not vanish.
    expect(screen.getByTestId('sunset-toolbar')).toBeInTheDocument();
  });

  it('draws a failed read as a failure with a retry, not as an empty workspace', async () => {
    timelineResponse = { ok: false, body: { success: false, error: '503 Service Unavailable' } };
    await renderScreen();
    expect(screen.getByText('503 Service Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No deprecation or sunset entries')).not.toBeInTheDocument();

    timelineResponse = { ok: true, body: { success: true, entries: ROWS } };
    await userEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    await waitFor(() => expect(screen.getByTestId('sunset-timeline-card')).toBeInTheDocument());
  });

  it('gates a reader with no workspace, and reads nothing', async () => {
    sessionUser = { user_id: 'u-ada', email: 'ada@acme.io' };
    render(
      <TooltipProvider>
        <SunsetTimelinePage />
      </TooltipProvider>
    );
    expect(await screen.findByText('No tenant selected')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('asks a signed-out reader to sign in', async () => {
    sessionUser = null;
    render(
      <TooltipProvider>
        <SunsetTimelinePage />
      </TooltipProvider>
    );
    expect(await screen.findByText('Sign in to view the sunset timeline.')).toBeInTheDocument();
  });

  it('says it is still checking while the session loads', async () => {
    sessionUser = null;
    sessionStatus = 'loading';
    render(
      <TooltipProvider>
        <SunsetTimelinePage />
      </TooltipProvider>
    );
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The browser fixtures.
 *
 * `e2e/hive-sunset-timeline.spec.ts` measures computed layout, which jsdom cannot do. Rather
 * than hand-writing HTML that would drift from the components, this renders the real screen
 * and writes what it rendered into `e2e/fixtures/hive-sunset-timeline/` when
 * `SUNSET_FIXTURE_DUMP=1` is set:
 *
 *     SUNSET_FIXTURE_DUMP=1 npx jest tests/sunset-timeline-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is
 * there — so a change that would leave the fixtures stale fails loudly here before it fails
 * quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-sunset-timeline');
  const dump = process.env.SUNSET_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  it('renders the timeline and table (and writes its fixture on request)', async () => {
    await renderScreen();
    await screen.findByTestId('sunset-timeline-card');
    write('timeline', page().outerHTML);
  });

  it('renders the empty state (and writes its fixture on request)', async () => {
    timelineResponse = { ok: true, body: { success: true, entries: [] } };
    await renderScreen();
    await screen.findByText('No deprecation or sunset entries');
    write('empty', page().outerHTML);
  });

  it('renders the failed read (and writes its fixture on request)', async () => {
    timelineResponse = { ok: false, body: { success: false, error: '503 Service Unavailable' } };
    await renderScreen();
    await screen.findByText('503 Service Unavailable');
    write('error', page().outerHTML);
  });
});
