/**
 * Format details pane — automated a11y suite (CPDO-2.1, #4797).
 *
 * The pane is the only place a reader meets an EDI or mainframe payload's own structure, and a
 * five-thousand-node tree is exactly the surface where a keyboard or screen-reader user gets left
 * behind. Following the IXH-3.6 / OLO-3.5 precedent (`tests/import-preview-a11y.test.tsx`,
 * `tests/login-a11y.test.tsx`), this is the deterministic jsdom half of the gate:
 *
 *  1. **axe clean** — zero violations in every state the pane can be in: loading, available (tree
 *     mounted, construct selected), bounded/partial with analyzer warnings, unavailable-with-reason,
 *     a permission refusal, and a large/windowed tree.
 *  2. **Keyboard contract** — exactly one Tab stop in the tree (roving tabindex), arrow-key movement,
 *     and every interactive control in the pane reachable as a real button or link rather than a
 *     click-handling `div`.
 *  3. **Text alternatives** — the tree is named and described, every decorative icon is
 *     `aria-hidden`, and every state badge carries its meaning in text (an `sr-only` label plus a
 *     visible value), so no state is conveyed by colour alone.
 *  4. **Reduced motion** — no movement class renders without a `motion-safe:` guard. Colour/opacity
 *     fades are exempt: `prefers-reduced-motion` targets movement.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import { ANALYSIS_TREE_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';
import type { AnalysisRecord, AnalysisSummary } from '@/app/utils/catalog-payload-analysis';
import {
  AVAILABLE_SUMMARY,
  boundedCopybookRecord,
  REGISTRY_SNAPSHOT,
  UNAVAILABLE_SUMMARY,
  wideRecord,
  x12Record,
  x12ScannedRecord,
} from './helpers/payload-analysis-fixture';

/** axe options: WCAG 2.1 A/AA; contrast and the page-landmark rule need a real page. */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

const ITEM_ID = 'cat-1';
const originalFetch = global.fetch;

/** Route the pane's two GETs; `analysis` may be a record, an HTTP failure, or `null` (never settles). */
function mockTransport(analysis: AnalysisRecord | { status: number; error: string } | null) {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/format-capabilities')) {
      return { ok: true, status: 200, json: async () => ({ success: true, ...REGISTRY_SNAPSHOT }) };
    }
    if (url.includes('/analysis')) {
      // A never-settling promise leaves the pane in its loading state for the scan.
      if (analysis === null) return new Promise(() => {});
      if ('status' in analysis) {
        return {
          ok: false,
          status: analysis.status,
          json: async () => ({ success: false, error: analysis.error }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, record: analysis }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function renderPane(
  options: {
    summary?: AnalysisSummary | null;
    sourceFormat?: string;
    sourceAvailable?: boolean;
    viewportHeight?: number;
  } = {},
) {
  const { container } = render(
    <CatalogFormatDetailPanel
      itemId={ITEM_ID}
      summary={options.summary ?? AVAILABLE_SUMMARY}
      sourceFormat={options.sourceFormat ?? 'edix12'}
      active
      sourceAvailable={options.sourceAvailable ?? true}
      onViewSourceLine={jest.fn()}
      nodeHref={(nodeId) => `/ade/dashboard/catalog/${ITEM_ID}?tab=format&node=${nodeId}`}
      viewportHeight={options.viewportHeight}
    />,
  );
  return container;
}

beforeEach(() => {
  resetFormatCapabilitiesCache();
  mockTransport(x12Record());
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('Format details pane — axe', () => {
  it('is clean while the record is loading', async () => {
    mockTransport(null);
    const container = renderPane();

    await screen.findByTestId('catalog-format-detail-loading');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean with the tree mounted and a construct selected', async () => {
    const container = renderPane();

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('treeitem')[0]);
    await screen.findByTestId('catalog-format-detail-selected');
    // The capability panel (CPDO-2.4) is part of the pane, so it is inside the scan.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /what apiome records/i })).toBeInTheDocument(),
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean with the X12 inspector mounted (CPDO-2.2)', async () => {
    mockTransport(x12ScannedRecord());
    const container = renderPane();

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    // The inspector adds a heading, two data tables, a badge row and a set of reveal buttons — the
    // surfaces a table-heavy panel most often gets wrong.
    await screen.findByTestId('catalog-x12-inspector');
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean for a bounded record with analyzer warnings', async () => {
    mockTransport(boundedCopybookRecord());
    const container = renderPane({ sourceFormat: 'cobolcopybook' });

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    await screen.findByTestId('catalog-format-detail-bounding-note');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean for an unavailable revision, whose absence carries a reviewed explanation', async () => {
    const container = renderPane({ summary: UNAVAILABLE_SUMMARY });

    await waitFor(() =>
      expect(screen.getByRole('note', { name: /why this detail is missing/i })).toBeInTheDocument(),
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean for a permission refusal', async () => {
    mockTransport({ status: 403, error: 'Permission denied: imports:view' });
    const container = renderPane();

    await screen.findByTestId('catalog-format-detail-forbidden');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean for a large, windowed tree', async () => {
    mockTransport(wideRecord(ANALYSIS_TREE_VIRTUALIZE_ABOVE + 10));
    const container = renderPane({ viewportHeight: 96 });

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    await screen.findByTestId('catalog-format-detail-windowed');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('Format details pane — keyboard and text alternatives', () => {
  it('keeps exactly one Tab stop in the tree and moves with the arrow keys', async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());

    const stops = () =>
      screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0');
    expect(stops()).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' });
    await waitFor(() => expect(stops()).toHaveLength(1));
    expect(stops()[0]).toHaveFocus();
  });

  it('exposes every control as a real button or link, never a click-handling div', async () => {
    const container = renderPane();
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('treeitem')[0]);
    await screen.findByTestId('catalog-format-detail-selected');

    // Nothing outside a button/link/input/summary carries a tabindex, and no bare div is focusable.
    for (const el of Array.from(container.querySelectorAll('[tabindex]'))) {
      expect(['button', 'a', 'input', 'summary']).toContain(el.tagName.toLowerCase());
    }
    // Every treeitem is a button, so Enter/Space activation is the platform's, not ours.
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.tagName.toLowerCase()).toBe('button');
    }
  });

  it('names and describes the tree, and hides every decorative icon', async () => {
    const container = renderPane();
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());

    const tree = screen.getByRole('tree');
    expect(tree).toHaveAccessibleName('Native payload structure');
    expect(tree).toHaveAccessibleDescription(/arrow keys/i);

    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      const hidden =
        svg.getAttribute('aria-hidden') === 'true' || svg.closest('[aria-hidden="true"]') !== null;
      const labelledBy = svg.getAttribute('aria-labelledby');
      const named = labelledBy !== null && document.getElementById(labelledBy) !== null;
      expect(hidden || named).toBe(true);
    }
  });

  it('carries every state badge’s meaning in text, not in colour', async () => {
    mockTransport(boundedCopybookRecord());
    renderPane({ sourceFormat: 'cobolcopybook' });
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());

    for (const testId of [
      'catalog-format-detail-status',
      'catalog-format-detail-truncated',
      'catalog-format-detail-warning-state',
    ]) {
      const badge = screen.getByTestId(testId);
      // An sr-only label names *what* the badge is about; the visible text states the value.
      expect(badge.querySelector('.sr-only')?.textContent?.trim()).toBeTruthy();
      expect(badge.textContent?.trim().length).toBeGreaterThan(0);
    }
    // The severity of a warning is printed as a symbol plus a word, never as a colour alone.
    expect(screen.getAllByTestId('catalog-format-detail-warning')[0]).toHaveTextContent('✕ Error');
  });

  it('guards every motion class with motion-safe (prefers-reduced-motion honoured)', async () => {
    mockTransport(wideRecord(ANALYSIS_TREE_VIRTUALIZE_ABOVE + 10));
    const container = renderPane({ viewportHeight: 96 });
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    act(() => {
      fireEvent.scroll(screen.getByRole('tree').parentElement!);
    });

    const offenders: string[] = [];
    for (const el of Array.from(container.querySelectorAll('*'))) {
      const classAttr = el.getAttribute('class');
      if (!classAttr) continue;
      for (const token of classAttr.split(/\s+/)) {
        // Movement classes must be motion-safe; colour/opacity/shadow fades are exempt
        // (prefers-reduced-motion targets motion, not fades).
        const isMotion =
          token.startsWith('animate-') || token === 'transition' || token === 'transition-transform';
        if (isMotion) offenders.push(`${el.tagName.toLowerCase()}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
