/**
 * CPDO-4.2 (#4805) catalog analysis guardrails: metric whitelist, latency
 * tracker resilience, and the documented conversion-projection budgets.
 */

import {
  metricNow,
  trackCatalogAnalysisMetric,
} from '../src/app/components/ade/dashboard/catalog/catalogAnalysisMetrics';
import { PROJECTION_PAGES_PER_WINDOW } from '../src/app/components/ade/dashboard/catalog/useConversionProjection';
import { CONVERSION_PROJECTION_PAGE_LIMIT } from '../src/app/utils/conversion-projection';
import * as budgets from '../src/app/utils/preview-budgets';

describe('catalog analysis guardrails (CPDO-4.2)', () => {
  it('trackCatalogAnalysisMetric posts only whitelist fields', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await trackCatalogAnalysisMetric({
      kind: 'ui_latency',
      surface: 'format_tab',
      latency_ms: 120.5,
      page_total: 42,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/catalog/analysis-metrics');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      kind: 'ui_latency',
      surface: 'format_tab',
      latency_ms: 120.5,
      page_total: 42,
    });
    expect(body).not.toHaveProperty('node_names');
    expect(body).not.toHaveProperty('item_name');
    expect(body).not.toHaveProperty('source');
  });

  it('swallows transport failures — telemetry never breaks the catalog UI', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('offline'));
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      trackCatalogAnalysisMetric({ kind: 'ui_latency', surface: 'projection_graph' }),
    ).resolves.toBeUndefined();
  });

  it('metricNow returns a usable millisecond clock', () => {
    const a = metricNow();
    const b = metricNow();
    expect(typeof a).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('registers the conversion-projection budgets in the central registry', () => {
    expect(budgets.CONVERSION_PROJECTION_PAGE_LIMIT).toBe(CONVERSION_PROJECTION_PAGE_LIMIT);
    expect(budgets.PROJECTION_PAGES_PER_WINDOW).toBe(PROJECTION_PAGES_PER_WINDOW);
    const ids = budgets.PREVIEW_BUDGETS.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining(['CONVERSION_PROJECTION_PAGE_LIMIT', 'PROJECTION_PAGES_PER_WINDOW']),
    );
  });
});
