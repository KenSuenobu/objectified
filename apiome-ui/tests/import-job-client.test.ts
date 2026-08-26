/**
 * Where an import job's status comes from (BLK-1.4, #5526).
 *
 * The shared execution and completion panels used to read only the in-process worker's job
 * store, so a bulk row — a REST job — was told "Job not found". `importJobClient` is the seam
 * that lets one panel read either store; this pins the REST adapter's field mapping, the two
 * clients' calls, and the verbs each one declares.
 */

import {
  adaptRestImportStatus,
  localImportJobClient,
  restImportJobClient,
} from '@/app/components/ade/import/importJobClient';

const actions = {
  getImportStatus: jest.fn(),
  cancelImport: jest.fn(),
  commitImport: jest.fn(),
  rollbackImport: jest.fn(),
  rollbackCompletedImport: jest.fn(),
  retryImport: jest.fn(),
};
jest.mock('@lib/db/import-actions', () => ({
  getImportStatus: (...args: unknown[]) => actions.getImportStatus(...args),
  cancelImport: (...args: unknown[]) => actions.cancelImport(...args),
  commitImport: (...args: unknown[]) => actions.commitImport(...args),
  rollbackImport: (...args: unknown[]) => actions.rollbackImport(...args),
  rollbackCompletedImport: (...args: unknown[]) => actions.rollbackCompletedImport(...args),
  retryImport: (...args: unknown[]) => actions.retryImport(...args),
}));

/** A completed adapter (AsyncAPI) job as `GET …/imports/{job_id}` returns it. */
const REST_COMPLETED = {
  success: true,
  job_id: 'job-1',
  state: 'completed',
  percent: 100,
  events: [
    { id: 'e1', ts: 10, level: 'info', code: 'PARSED', message: 'Parsed 3 channels.' },
    { id: 'e2', ts: 20, level: 'warn', code: 'LINT', message: 'One warning.', context: { rule: 'x' } },
  ],
  progress: { phase: 'finalizing', total: 4, completed: 4 },
  summary: {
    source: 'asyncapi',
    paradigm: 'event-driven',
    format: 'asyncapi-2',
    counts: { services: 1, operations: 6, types: 12, channels: 3 },
    routing: { target: 'catalog' },
    dry_run: false,
    incremental_mode: false,
    persisted: true,
  },
  result: {
    project_id: 'p-1',
    project_slug: 'shipping-events',
    version_id: '1.2.0',
    version_record_id: 'v-uuid-1',
  },
  error: null,
  correlation_id: 'req-1',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('adapting a REST job to what the panels read', () => {
  it('maps the identity, the log and the produced record ids', () => {
    const status = adaptRestImportStatus(REST_COMPLETED);

    expect(status.jobId).toBe('job-1');
    expect(status.state).toBe('completed');
    expect(status.percent).toBe(100);
    expect(status.events).toEqual([
      { id: 'e1', ts: 10, level: 'info', code: 'PARSED', message: 'Parsed 3 channels.', context: undefined },
      { id: 'e2', ts: 20, level: 'warn', code: 'LINT', message: 'One warning.', context: { rule: 'x' } },
    ]);
    expect(status.progress).toEqual({ phase: 'finalizing', total: 4, completed: 4 });
    // The Canvas link needs the version *record* id, not its label.
    expect(status.result).toEqual({ projectId: 'p-1', versionId: 'v-uuid-1' });
    expect(status.error).toBeNull();
  });

  it('folds an adapter summary onto the fields the completion panel reads', () => {
    const summary = adaptRestImportStatus(REST_COMPLETED).summary;

    expect(summary).toMatchObject({
      classesCreated: 12,
      pathsImported: 6,
      propertiesCreated: 0,
      warnings: 0,
      failed: 0,
      sourceName: 'asyncapi-2',
      dryRun: false,
      incrementalMode: false,
      projectId: 'p-1',
      versionId: 'v-uuid-1',
      // The original keys survive for anything that reads them.
      counts: { services: 1, operations: 6, types: 12, channels: 3 },
    });
  });

  it('leaves a worker-shaped summary alone and reads its dry-run flag', () => {
    const summary = adaptRestImportStatus({
      ...REST_COMPLETED,
      summary: { classesCreated: 7, propertiesCreated: 30, pathsImported: 4, warnings: 1, dryRun: true, sourceName: 'orders.yaml' },
    }).summary;

    expect(summary).toMatchObject({
      classesCreated: 7,
      propertiesCreated: 30,
      pathsImported: 4,
      warnings: 1,
      dryRun: true,
      sourceName: 'orders.yaml',
    });
  });

  it('joins a typed failure to the log once, with its remediation', () => {
    const status = adaptRestImportStatus({
      job_id: 'job-2',
      state: 'failed',
      percent: 30,
      events: [{ id: 'e1', ts: 5, level: 'info', code: 'START', message: 'Started.' }],
      error: {
        code: 'QUALITY_POLICY_BLOCKED',
        category: 'policy',
        message: 'Import scores D, below the tenant floor of B.',
        remediation: 'Fix the findings and import again.',
        retriable: false,
      },
    });

    expect(status.events.at(-1)).toEqual({
      id: 'rest-error',
      ts: 5,
      level: 'error',
      code: 'QUALITY_POLICY_BLOCKED',
      message: 'Import scores D, below the tenant floor of B. Fix the findings and import again.',
    });
    expect(status.error).toEqual({
      code: 'QUALITY_POLICY_BLOCKED',
      message: 'Import scores D, below the tenant floor of B.',
      remediation: 'Fix the findings and import again.',
    });
  });

  it('does not repeat a failure the log already carries', () => {
    const status = adaptRestImportStatus({
      job_id: 'job-2',
      state: 'failed',
      events: [{ id: 'e9', ts: 5, level: 'error', code: 'PARSE', message: 'Broken document.' }],
      error: { code: 'PARSE', message: 'Broken document.' },
    });

    expect(status.events).toHaveLength(1);
  });

  it('reads an unreadable payload as an empty queued job rather than throwing', () => {
    expect(adaptRestImportStatus(null)).toEqual({
      jobId: '',
      state: 'queued',
      percent: 0,
      events: [],
      progress: undefined,
      summary: undefined,
      result: undefined,
      error: null,
    });
    expect(adaptRestImportStatus({ events: ['junk', { level: 'loud' }] }).events).toEqual([
      { id: '', ts: 0, level: 'info', code: '', message: '', context: undefined },
    ]);
  });
});

describe('the REST client', () => {
  it('reads a job through the catalog import proxy', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: async () => REST_COMPLETED,
    }) as unknown as typeof fetch;

    const status = await restImportJobClient.getStatus('job 1');

    expect(global.fetch).toHaveBeenCalledWith('/api/catalog/import/job%201', { credentials: 'include' });
    expect(status.jobId).toBe('job-1');
    expect(actions.getImportStatus).not.toHaveBeenCalled();
  });

  it('surfaces a refused read as an error rather than a queued job', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ success: false, error: 'Import job not found' }),
    }) as unknown as typeof fetch;

    await expect(restImportJobClient.getStatus('job-9')).rejects.toThrow('Import job not found');
  });

  it('cancels through the same proxy and offers nothing it cannot do', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }) as unknown as typeof fetch;

    await expect(restImportJobClient.cancel?.('job-1')).resolves.toEqual({ success: true });
    expect(global.fetch).toHaveBeenCalledWith('/api/catalog/import/job-1', {
      method: 'DELETE',
      credentials: 'include',
    });
    expect(restImportJobClient.kind).toBe('rest');
    expect(restImportJobClient.commit).toBeUndefined();
    expect(restImportJobClient.rollback).toBeUndefined();
    expect(restImportJobClient.rollbackCompleted).toBeUndefined();
    expect(restImportJobClient.retry).toBeUndefined();
  });
});

describe('the local client', () => {
  it('is the worker store the panels always read, verb for verb', async () => {
    actions.getImportStatus.mockResolvedValue({ jobId: 'j', state: 'running', percent: 5, events: [] });
    actions.cancelImport.mockResolvedValue({ success: true });
    actions.commitImport.mockResolvedValue({ success: true });
    actions.rollbackImport.mockResolvedValue({ success: true });
    actions.rollbackCompletedImport.mockResolvedValue({ success: false, error: 'no' });
    actions.retryImport.mockResolvedValue({ success: true, jobId: 'j2' });

    expect(localImportJobClient.kind).toBe('local');
    expect((await localImportJobClient.getStatus('j')).state).toBe('running');
    expect(await localImportJobClient.cancel?.('j')).toEqual({ success: true });
    expect(await localImportJobClient.commit?.('j')).toEqual({ success: true });
    expect(await localImportJobClient.rollback?.('j')).toEqual({ success: true });
    expect(await localImportJobClient.rollbackCompleted?.('j')).toEqual({ success: false, error: 'no' });
    expect(await localImportJobClient.retry?.('j')).toEqual({ success: true, jobId: 'j2' });
    expect(actions.getImportStatus).toHaveBeenCalledWith('j');
  });

  it('reads a cancel that returned nothing as having succeeded', async () => {
    actions.cancelImport.mockResolvedValue(undefined);
    expect(await localImportJobClient.cancel?.('j')).toEqual({ success: true });
    actions.cancelImport.mockResolvedValue({ success: false });
    expect(await localImportJobClient.cancel?.('j')).toEqual({ success: false });
  });
});
