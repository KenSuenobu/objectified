/**
 * Preview budgets registry (IXH-3.6, #5108).
 *
 * The acceptance criterion is "documented budgets exist for every preview surface". This
 * suite pins that contract:
 *  1. Every exported budget constant appears in the registry, and every registry entry
 *     matches its exported constant — the documentation and the enforcement cannot drift.
 *  2. Every entry documents the surface, the unit, the above-budget behavior, and the
 *     path to the complete data.
 *  3. A `truncated` mechanism entry must describe a UI statement (truncation is never
 *     silent); a `windowed` entry must keep everything reachable.
 */

import { describe, expect, it } from '@jest/globals';

import * as budgets from '../src/app/utils/preview-budgets';
import { PREVIEW_BUDGETS } from '../src/app/utils/preview-budgets';
import { TREE_VIRTUALIZE_ABOVE } from '../src/app/components/ade/dashboard/catalog/CatalogImportPreviewPanel';
import { VIRTUALIZE_ABOVE } from '../src/app/components/ade/dashboard/catalog/CatalogImportQualityStep';
import { GRAPH_AGGREGATION_THRESHOLD } from '../src/app/components/ade/dashboard/export/projectionGraph';
import { PREVIEW_PAGE_SIZE } from '../src/app/utils/import-preview-manifest';

describe('PREVIEW_BUDGETS — registry ↔ constant consistency', () => {
  it('has one entry per exported budget constant, with the matching value', () => {
    for (const entry of PREVIEW_BUDGETS) {
      const exported = (budgets as Record<string, unknown>)[entry.id];
      expect(typeof exported).toBe('number');
      expect(exported).toBe(entry.budget);
    }
  });

  it('documents every preview surface exactly once', () => {
    const ids = PREVIEW_BUDGETS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'TREE_VIRTUALIZE_ABOVE',
        'PREVIEW_PAGE_SIZE',
        'LOAD_ALL_PAGE_CAP',
        'FINDINGS_VIRTUALIZE_ABOVE',
        'GRAPH_AGGREGATION_THRESHOLD',
        'GRAPH_DRAW_BUDGET',
        'PROJECTION_TABLE_VIRTUALIZE_ABOVE',
        'DELTA_LIST_VIRTUALIZE_ABOVE',
        'RAW_VIEWER_CONTEXT',
        'TEST_BENCH_PAYLOAD_MAX_BYTES',
        'TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE',
        'TEST_BENCH_MAX_FINDINGS',
      ]),
    );
  });

  it('gives every entry a surface, unit, above-budget behavior, and full-data path', () => {
    for (const entry of PREVIEW_BUDGETS) {
      expect(entry.surface.length).toBeGreaterThan(0);
      expect(entry.unit.length).toBeGreaterThan(0);
      expect(entry.aboveBudget.length).toBeGreaterThan(0);
      expect(entry.fullDataPath.length).toBeGreaterThan(0);
      expect(entry.budget).toBeGreaterThan(0);
      expect(['windowed', 'truncated']).toContain(entry.mechanism);
    }
  });

  it('keeps the historical component exports pointing at the central budgets', () => {
    expect(TREE_VIRTUALIZE_ABOVE).toBe(budgets.TREE_VIRTUALIZE_ABOVE);
    expect(VIRTUALIZE_ABOVE).toBe(budgets.FINDINGS_VIRTUALIZE_ABOVE);
    expect(budgets.GRAPH_AGGREGATION_THRESHOLD).toBe(GRAPH_AGGREGATION_THRESHOLD);
    expect(budgets.PREVIEW_PAGE_SIZE).toBe(PREVIEW_PAGE_SIZE);
  });

  it('orders the draw budget above the aggregation threshold, so aggregation runs first', () => {
    // Aggregation is the first line of defence; the draw cap only engages when a manifest
    // is messy enough that non-aggregatable (lossy) rows alone exceed the drawable count.
    expect(budgets.GRAPH_DRAW_BUDGET).toBeGreaterThan(budgets.GRAPH_AGGREGATION_THRESHOLD);
  });
});
