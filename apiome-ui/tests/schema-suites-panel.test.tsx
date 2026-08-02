/**
 * BenchSuitesPanel component tests (IXH-5.7, #5119).
 *
 * Walks the suites panel against mocked fetch: listing with latest-run summaries and the
 * regression chip, create-from-current-payload, running a suite (and the status line naming a
 * detected regression), the expandable run history with per-payload verdict diffs, the corpus
 * envelope export download and import flow, and an axe pass over the panel.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { BenchSuitesPanel } from '../src/app/components/ade/dashboard/test-bench/BenchSuitesPanel';

const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

// jsdom's Blob/File lack the standard `.text()`; the component and the export assertion both
// need it, so back it with FileReader (which jsdom does implement).
beforeAll(() => {
  const proto = Blob.prototype as unknown as { text?: () => Promise<string> };
  if (typeof proto.text !== 'function') {
    proto.text = function (this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
});

const SUITE_ID = '4c1e2f00-0000-4000-8000-000000000001';
const RUN_ID = '4c1e2f00-0000-4000-8000-00000000r001';

const PASSING_SUITE = {
  id: SUITE_ID,
  name: 'order regression suite',
  ref: 'catalog/legacy-soap',
  ref_kind: 'catalog',
  ref_artifact: 'legacy-soap',
  suite_version: 1,
  payload_count: 2,
  latest_run: {
    id: RUN_ID,
    suite_version: 1,
    requested_ref: 'catalog/legacy-soap/latest',
    resolved_version_label: '1.2.0',
    trigger: 'manual',
    status: 'completed',
    total: 2,
    passed: 2,
    failed: 0,
    errored: 0,
    regression: false,
    created_at: '2026-08-01T12:00:00Z',
  },
};

const REGRESSED_SUITE = {
  ...PASSING_SUITE,
  latest_run: {
    ...PASSING_SUITE.latest_run,
    passed: 1,
    failed: 1,
    regression: true,
  },
};

const RUN_DETAIL = {
  success: true,
  ...REGRESSED_SUITE.latest_run,
  results: [
    {
      payload_name: 'payload 1',
      expected_valid: true,
      valid: false,
      validated: true,
      status: 'failed',
      previous_status: 'passed',
      regression: true,
      findings: [],
      message: 'expected valid but the validator reported 1 finding',
    },
    {
      payload_name: 'payload 2',
      expected_valid: false,
      valid: false,
      validated: true,
      status: 'passed',
      previous_status: 'passed',
      regression: false,
      findings: [],
      message: 'invalid, as expected',
    },
  ],
};

const EXPORT_ENVELOPE = {
  success: true,
  suite: PASSING_SUITE,
  manifest: {
    manifest_version: 1,
    directories: {},
    entries: [{ path: 'json-schema/test-bench/payload-1.json', features: ['instance-payload'] }],
  },
  files: [{ path: 'json-schema/test-bench/payload-1.json', content: '{"a": 1}' }],
};

/** Route the panel's fetches; overrides swap individual endpoints. */
function mockFetch(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const respond = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.startsWith('/api/schemas/suites?')) {
      return respond(overrides.list ?? { success: true, items: [PASSING_SUITE] });
    }
    if (url === `/api/schemas/suites/${SUITE_ID}/runs` && init?.method === 'POST') {
      return respond(overrides.run ?? { success: true, ...REGRESSED_SUITE.latest_run });
    }
    if (url === `/api/schemas/suites/${SUITE_ID}/runs`) {
      return respond(overrides.history ?? { success: true, items: [REGRESSED_SUITE.latest_run] });
    }
    if (url === `/api/schemas/suites/${SUITE_ID}/runs/${RUN_ID}`) {
      return respond(overrides.runDetail ?? RUN_DETAIL);
    }
    if (url === `/api/schemas/suites/${SUITE_ID}/export`) {
      return respond(overrides.export ?? EXPORT_ENVELOPE);
    }
    if (url === `/api/schemas/suites/${SUITE_ID}` && init?.method === undefined) {
      return respond({ success: true, ...PASSING_SUITE, payloads: [] });
    }
    if (url === '/api/schemas/suites' && init?.method === 'POST') {
      return respond(overrides.create ?? { success: true, ...PASSING_SUITE });
    }
    if (url === '/api/schemas/suites/import' && init?.method === 'POST') {
      return respond(overrides.import ?? { success: true, ...PASSING_SUITE });
    }
    throw new Error(`Unexpected fetch: ${url} (${init?.method ?? 'GET'})`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

function renderPanel(props: Partial<React.ComponentProps<typeof BenchSuitesPanel>> = {}) {
  return render(
    <BenchSuitesPanel
      surface="catalog"
      artifact="legacy-soap"
      version="latest"
      payloadText='{"a": 1}'
      syntheticContent={false}
      active
      {...props}
    />
  );
}

describe('BenchSuitesPanel', () => {
  it('lists suites with their latest run and no regression chrome when calm', async () => {
    mockFetch();
    renderPanel();

    expect(await screen.findByText('order regression suite')).toBeInTheDocument();
    expect(screen.getByTestId(`suite-latest-${SUITE_ID}`)).toHaveTextContent('2/2 passed @ 1.2.0');
    expect(screen.queryByTestId(`suite-regression-${SUITE_ID}`)).not.toBeInTheDocument();
  });

  it('flags a suite whose newest run regressed', async () => {
    mockFetch({ list: { success: true, items: [REGRESSED_SUITE] } });
    renderPanel();

    expect(await screen.findByTestId(`suite-regression-${SUITE_ID}`)).toHaveTextContent(
      /regression/i
    );
  });

  it('creates a suite seeded from the current payload', async () => {
    const { calls } = mockFetch();
    renderPanel();
    await screen.findByText('order regression suite');

    fireEvent.change(screen.getByTestId('suite-create-name'), {
      target: { value: 'fresh suite' },
    });
    fireEvent.click(screen.getByTestId('suite-create'));

    await waitFor(() => {
      const create = calls.find(
        (call) => call.url === '/api/schemas/suites' && call.init?.method === 'POST'
      );
      expect(create).toBeDefined();
      const body = JSON.parse(String(create!.init!.body));
      expect(body).toEqual({
        name: 'fresh suite',
        ref: 'catalog/legacy-soap',
        payloads: [{ name: 'payload 1', payload_text: '{"a": 1}', synthetic: false }],
      });
    });
  });

  it('runs a suite against the selected version and announces a regression', async () => {
    const { calls } = mockFetch();
    renderPanel({ version: '1.3.0' });
    await screen.findByText('order regression suite');

    fireEvent.click(screen.getByTestId(`suite-run-${SUITE_ID}`));

    await waitFor(() => {
      const run = calls.find(
        (call) =>
          call.url === `/api/schemas/suites/${SUITE_ID}/runs` && call.init?.method === 'POST'
      );
      expect(run).toBeDefined();
      expect(JSON.parse(String(run!.init!.body))).toEqual({ version: '1.3.0' });
    });
    await waitFor(() =>
      expect(screen.getByTestId('suites-status-live')).toHaveTextContent(
        '"order regression suite": 1/2 passed — regression detected.'
      )
    );
  });

  it('shows run history with per-payload verdict diffs and regression highlighting', async () => {
    mockFetch({ list: { success: true, items: [REGRESSED_SUITE] } });
    renderPanel();
    await screen.findByText('order regression suite');

    fireEvent.click(screen.getByTestId(`suite-history-${SUITE_ID}`));
    fireEvent.click(await screen.findByTestId(`suite-run-row-${RUN_ID}`));

    const results = await screen.findByTestId(`suite-run-results-${RUN_ID}`);
    expect(results).toHaveTextContent('passed → failed');
    expect(screen.getByTestId('suite-result-regression')).toHaveTextContent('payload 1');
    expect(screen.getByTestId(`suite-run-regression-${RUN_ID}`)).toBeInTheDocument();
  });

  it('downloads the corpus envelope on export', async () => {
    mockFetch();
    const objectUrl = jest.fn(() => 'blob:suite');
    const revoke = jest.fn();
    Object.assign(URL, { createObjectURL: objectUrl, revokeObjectURL: revoke });
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderPanel();
    await screen.findByText('order regression suite');
    fireEvent.click(screen.getByTestId(`suite-export-${SUITE_ID}`));

    await waitFor(() => expect(objectUrl).toHaveBeenCalledTimes(1));
    const blob = objectUrl.mock.calls[0][0] as Blob;
    const text = JSON.parse(await blob.text());
    expect(text.manifest.entries).toHaveLength(1);
    expect(text.files[0].content).toBe('{"a": 1}');
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('imports an exported envelope back as a new suite', async () => {
    const { calls } = mockFetch();
    renderPanel();
    await screen.findByText('order regression suite');

    const file = new File(
      [JSON.stringify({ manifest: EXPORT_ENVELOPE.manifest, files: EXPORT_ENVELOPE.files })],
      'orders-suite.json',
      { type: 'application/json' }
    );
    fireEvent.change(screen.getByTestId('suite-import-input'), { target: { files: [file] } });

    await waitFor(() => {
      const imported = calls.find(
        (call) => call.url === '/api/schemas/suites/import' && call.init?.method === 'POST'
      );
      expect(imported).toBeDefined();
      const body = JSON.parse(String(imported!.init!.body));
      expect(body.name).toBe('orders-suite');
      expect(body.ref).toBe('catalog/legacy-soap');
      expect(body.files).toHaveLength(1);
    });
  });

  it('refuses an import file that is not an envelope, without a request', async () => {
    const { calls } = mockFetch();
    renderPanel();
    await screen.findByText('order regression suite');

    const file = new File(['not json'], 'broken.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('suite-import-input'), { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByTestId('suites-status-live')).toHaveTextContent(
        'The file is not valid JSON.'
      )
    );
    expect(calls.some((call) => call.url === '/api/schemas/suites/import')).toBe(false);
  });

  it('surfaces a structured REST fault through the status line', async () => {
    mockFetch({
      run: { success: false, detail: 'A suite holds at most 50 payloads' },
    });
    renderPanel();
    await screen.findByText('order regression suite');
    fireEvent.click(screen.getByTestId(`suite-run-${SUITE_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId('suites-status-live')).toHaveTextContent(
        'A suite holds at most 50 payloads'
      )
    );
  });

  it('has no axe violations', async () => {
    mockFetch({ list: { success: true, items: [REGRESSED_SUITE] } });
    const { container } = renderPanel();
    await screen.findByText('order regression suite');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
