/**
 * The Add-MCP-server flow's discovery step, rendered (HIVE-7.7, #5324).
 *
 * `mcp-import-flow.test.ts` holds the pure decisions — which job states are terminal, what a
 * failure message says, how the capability counts are summarised — and `import-wizard-css.test.ts`
 * pins the `.imp-stage` declarations HIVE-6.4 gave the wizard. Nothing held the *panel*: the
 * ticket's fourth acceptance criterion is "discover job progress and failure states render", and
 * until this suite the only thing standing behind it was that the module compiled.
 *
 * So this drives `McpDiscoveryPanel` against a polled job through all three of its shapes:
 *
 *   * **Progress** — the three-stage tracker (Connect → Discover capabilities → Lint & grade)
 *     advances with the job's state, and each stage carries its state in words for a reader who
 *     is not looking at the badges.
 *   * **Done** — the panel reports the produced version to the dialog, prints what discovery
 *     found, and pulls the freshly scored version's grade so the quality verdict lands in the
 *     flow rather than only on the endpoint page.
 *   * **Failed** — the run's own error is shown (not a generic one), the stage it died in is
 *     marked failed, and the dialog is told so it can offer Discard / Add this server anyway.
 *
 * The panel polls, so every test drives a scripted sequence of job reads and advances the timers
 * between them rather than waiting on wall-clock time.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import McpDiscoveryPanel from '../src/app/components/ade/dashboard/McpDiscoveryPanel';

const ENDPOINT_ID = 'ep-refunds';
const JOB_ID = 'job_2f7c19';

/** The job reads the panel will get, in order; the last one repeats if it is polled again. */
let jobReads: Array<Record<string, unknown>>;

/** The lint report the panel fetches after a successful run, or null for "unavailable". */
let lintReport: Record<string, unknown> | null;

function stubFetch(): void {
  let read = 0;
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/lint')) {
      return {
        ok: lintReport !== null,
        status: lintReport !== null ? 200 : 404,
        statusText: 'Not found',
        json: async () => lintReport ?? {},
      };
    }
    const job = jobReads[Math.min(read, jobReads.length - 1)];
    read += 1;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ job }) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  lintReport = null;
  jobReads = [];
  stubFetch();
});

/** Mount the panel with a fast poll so a scripted sequence drains quickly. */
function renderPanel(onComplete = jest.fn()) {
  render(
    <McpDiscoveryPanel
      endpointId={ENDPOINT_ID}
      jobId={JOB_ID}
      endpointName="Refunds MCP"
      onComplete={onComplete as (succeeded: boolean, versionId: string | null) => void}
      pollIntervalMs={1}
    />,
  );
  return onComplete;
}

/** One stage of the tracker, by its label. */
function stage(label: string): HTMLElement {
  return screen.getByText(label).closest('.imp-stage') as HTMLElement;
}

describe('discovery progress', () => {
  test('the tracker advances with the job state, and says each stage’s state in words', async () => {
    jobReads = [
      { id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'queued' },
      { id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'running' },
      { id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'running' },
    ];
    renderPanel();

    // Queued: connecting.
    await waitFor(() => expect(stage('Connect')).toHaveAttribute('data-state', 'active'));
    expect(within(stage('Connect')).getByText('In progress')).toBeInTheDocument();
    expect(stage('Discover capabilities')).toHaveAttribute('data-state', 'pending');
    expect(within(stage('Lint & grade')).getByText('Not started')).toBeInTheDocument();

    // Running: connected, discovering.
    await waitFor(() => expect(stage('Connect')).toHaveAttribute('data-state', 'done'));
    expect(stage('Discover capabilities')).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Discovering capabilities…')).toBeInTheDocument();
  });

  test('the live status line is announced, and says what the wait is for', async () => {
    jobReads = [{ id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'running' }];
    renderPanel();

    const status = await screen.findByText('Discovering capabilities…');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(
      screen.getByText('This can take a few moments while we connect and list capabilities.'),
    ).toBeInTheDocument();
  });
});

describe('discovery done', () => {
  test('reports the produced version, prints what was found, and shows the grade', async () => {
    jobReads = [
      { id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'running' },
      {
        id: JOB_ID,
        endpoint_id: ENDPOINT_ID,
        state: 'completed',
        result: {
          version_id: 'v-1',
          version_seq: 1,
          counts: { tool: 3, resource: 2, prompt: 1 },
        },
      },
    ];
    lintReport = {
      endpoint_id: ENDPOINT_ID,
      version_id: 'v-1',
      version_seq: 1,
      grade: 'B',
      score: 82,
      findings: [
        { id: 'f1', rule_id: 'r1', tier: 'should', severity: 'warning', message: 'a' },
        { id: 'f2', rule_id: 'r2', tier: 'should', severity: 'warning', message: 'b' },
        { id: 'f3', rule_id: 'r3', tier: 'advisory', severity: 'info', message: 'c' },
      ],
    };
    const onComplete = renderPanel();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(true, 'v-1'));
    expect(screen.getByText('Discovery complete')).toBeInTheDocument();
    expect(screen.getByText('3 tools · 2 resources · 1 prompt')).toBeInTheDocument();

    // All three stages done.
    for (const label of ['Connect', 'Discover capabilities', 'Lint & grade']) {
      expect(stage(label)).toHaveAttribute('data-state', 'done');
    }

    // The grade card, pulled from the freshly committed version's lint report.
    expect(await screen.findByText('Quality grade: B · 82/100')).toBeInTheDocument();
    expect(screen.getByText(/The full report is on the endpoint/)).toBeInTheDocument();
  });

  test('a server that exposed nothing says so rather than printing an empty summary', async () => {
    jobReads = [
      {
        id: JOB_ID,
        endpoint_id: ENDPOINT_ID,
        state: 'completed',
        result: { version_id: 'v-1', counts: {} },
      },
    ];
    renderPanel();

    expect(await screen.findByText('No capabilities found')).toBeInTheDocument();
  });

  test('an unavailable lint report omits the grade card rather than failing the step', async () => {
    jobReads = [
      {
        id: JOB_ID,
        endpoint_id: ENDPOINT_ID,
        state: 'completed',
        result: { version_id: 'v-1', counts: { tool: 1 } },
      },
    ];
    lintReport = null;
    const onComplete = renderPanel();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(true, 'v-1'));
    expect(screen.getByText('1 tool')).toBeInTheDocument();
    expect(screen.queryByText(/Quality grade/)).toBeNull();
  });
});

describe('discovery failed', () => {
  test('shows the run’s own error, marks the stage it died in, and tells the dialog', async () => {
    jobReads = [
      { id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'running' },
      {
        id: JOB_ID,
        endpoint_id: ENDPOINT_ID,
        state: 'failed',
        error: 'tools/list returned -32001 “Session expired” after the initialize handshake.',
      },
    ];
    const onComplete = renderPanel();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(false, null));
    expect(
      screen.getByText('tools/list returned -32001 “Session expired” after the initialize handshake.'),
    ).toBeInTheDocument();

    // Connect succeeded; discovery is where it died; grading never started.
    expect(stage('Connect')).toHaveAttribute('data-state', 'done');
    expect(stage('Discover capabilities')).toHaveAttribute('data-state', 'failed');
    expect(within(stage('Discover capabilities')).getByText('Failed')).toBeInTheDocument();
    expect(stage('Lint & grade')).toHaveAttribute('data-state', 'pending');

    // The waiting line is gone once the run is terminal.
    expect(screen.queryByText(/This can take a few moments/)).toBeNull();
  });

  test('a failure with no classified error still says something a reader can act on', async () => {
    jobReads = [{ id: JOB_ID, endpoint_id: ENDPOINT_ID, state: 'failed' }];
    const onComplete = renderPanel();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(false, null));
    expect(screen.getByText('The MCP server could not be discovered.')).toBeInTheDocument();
  });

  test('a request that fails outright ends the poll rather than looping', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('Network is down');
    }) as unknown as typeof fetch;
    const onComplete = renderPanel();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(false, null));
    expect(screen.getByText('Network is down')).toBeInTheDocument();
    // One read, and no retry after the terminal failure.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });
});
