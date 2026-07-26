/**
 * exportJob — stage-status derivation, failure classification + recovery, validation extraction,
 * and status copy for the async export job (MFX-46.2, #4380). Pure logic, tested directly (no
 * React, no fetch), mirroring `exportVerify.test.ts`.
 */

import {
  EXPORT_JOB_STAGES,
  classifyExportFailure,
  exportJobStatusLine,
  failedStageForCode,
  failedStageForStatus,
  isTerminalExportState,
  stageStatusFor,
  validationReportFromError,
  type ExportJobError,
  type ExportJobStageKey,
  type ExportJobStatus,
} from '../src/app/components/ade/dashboard/export/exportJob';

/** Build a status with a given state and (optionally) progress/error. */
function status(overrides: Partial<ExportJobStatus>): ExportJobStatus {
  return {
    job_id: 'job-1',
    state: 'running',
    percent: 0,
    events: [],
    ...overrides,
  };
}

const STAGE_KEYS: ExportJobStageKey[] = EXPORT_JOB_STAGES.map((s) => s.key);

describe('exportJob — stage vocabulary', () => {
  it('lists the five pipeline stages in run order', () => {
    expect(STAGE_KEYS).toEqual([
      'loading-source',
      'analyzing-fidelity',
      'emitting',
      'validating',
      'packaging',
    ]);
  });

  it('marks terminal states', () => {
    expect(isTerminalExportState('completed')).toBe(true);
    expect(isTerminalExportState('failed')).toBe(true);
    expect(isTerminalExportState('canceled')).toBe(true);
    expect(isTerminalExportState('queued')).toBe(false);
    expect(isTerminalExportState('running')).toBe(false);
  });
});

describe('exportJob — stageStatusFor', () => {
  it('a queued job (no progress) has every stage pending', () => {
    const s = status({ state: 'queued' });
    for (const key of STAGE_KEYS) expect(stageStatusFor(key, s)).toBe('pending');
  });

  it('a running job marks finished stages done, the phase active, the rest pending', () => {
    // Emitting: two stages done before it, it is active, the last two are pending.
    const s = status({
      state: 'running',
      progress: { phase: 'emitting', total: 5, completed: 2 },
    });
    expect(stageStatusFor('loading-source', s)).toBe('done');
    expect(stageStatusFor('analyzing-fidelity', s)).toBe('done');
    expect(stageStatusFor('emitting', s)).toBe('active');
    expect(stageStatusFor('validating', s)).toBe('pending');
    expect(stageStatusFor('packaging', s)).toBe('pending');
  });

  it('a completed job marks every stage done', () => {
    const s = status({ state: 'completed', percent: 100 });
    for (const key of STAGE_KEYS) expect(stageStatusFor(key, s)).toBe('done');
  });

  it('a failed job marks the failed stage failed, earlier done, later pending', () => {
    const s = status({
      state: 'failed',
      progress: { phase: 'validating', total: 5, completed: 3 },
      error: { code: 'EMITTED_ARTIFACT_INVALID', message: 'bad' },
    });
    expect(stageStatusFor('loading-source', s)).toBe('done');
    expect(stageStatusFor('analyzing-fidelity', s)).toBe('done');
    expect(stageStatusFor('emitting', s)).toBe('done');
    expect(stageStatusFor('validating', s)).toBe('failed');
    expect(stageStatusFor('packaging', s)).toBe('pending');
  });

  it('a canceled job marks completed stages done and the rest canceled', () => {
    const s = status({
      state: 'canceled',
      progress: { phase: 'emitting', total: 5, completed: 2 },
    });
    expect(stageStatusFor('loading-source', s)).toBe('done');
    expect(stageStatusFor('analyzing-fidelity', s)).toBe('done');
    expect(stageStatusFor('emitting', s)).toBe('canceled');
    expect(stageStatusFor('packaging', s)).toBe('canceled');
  });
});

describe('exportJob — failedStage', () => {
  it('maps each error code to its stage', () => {
    expect(failedStageForCode('SOURCE_LOAD_FAILED')).toBe('loading-source');
    expect(failedStageForCode('UNSUPPORTED_TARGET')).toBe('analyzing-fidelity');
    expect(failedStageForCode('TRANSCODE_CONFIRMATION_REQUIRED')).toBe('analyzing-fidelity');
    expect(failedStageForCode('STALE_PREVIEW')).toBe('analyzing-fidelity');
    expect(failedStageForCode('EMIT_FAILED')).toBe('emitting');
    expect(failedStageForCode('EMPTY_EMIT')).toBe('emitting');
    expect(failedStageForCode('EMITTED_ARTIFACT_INVALID')).toBe('validating');
    expect(failedStageForCode('PACKAGING_FAILED')).toBe('packaging');
  });

  it('a code with no fixed stage falls back to the reported progress phase', () => {
    expect(failedStageForCode('EXPORT_EXCEPTION')).toBeNull();
    const s = status({
      state: 'failed',
      progress: { phase: 'packaging', total: 5, completed: 4 },
      error: { code: 'EXPORT_EXCEPTION', message: 'boom' },
    });
    expect(failedStageForStatus(s)).toBe('packaging');
  });
});

describe('exportJob — classifyExportFailure', () => {
  const cases: Array<[string, { class: string; action: string }]> = [
    ['SOURCE_LOAD_FAILED', { class: 'source', action: 'retry' }],
    ['UNSUPPORTED_TARGET', { class: 'target', action: 'reconfigure-target' }],
    ['TRANSCODE_CONFIRMATION_REQUIRED', { class: 'confirmation', action: 'acknowledge-and-retry' }],
    ['STALE_PREVIEW', { class: 'stale-preview', action: 'refresh-preview' }],
    ['EMIT_FAILED', { class: 'emitter', action: 'retry' }],
    ['EMPTY_EMIT', { class: 'emitter', action: 'reconfigure-options' }],
    ['EMITTED_ARTIFACT_INVALID', { class: 'validation', action: 'fix-in-verify' }],
    ['PACKAGING_FAILED', { class: 'packaging', action: 'retry' }],
    ['DELIVERY_FAILED', { class: 'delivery', action: 'retry' }],
  ];

  it.each(cases)('classifies %s', (code, expected) => {
    const info = classifyExportFailure({ code, message: 'x' });
    expect(info.class).toBe(expected.class);
    expect(info.action).toBe(expected.action);
    expect(info.title).toBeTruthy();
    expect(info.actionLabel).toBeTruthy();
  });

  it('degrades an unknown code to a generic retryable failure', () => {
    const info = classifyExportFailure({ code: 'SOMETHING_NEW', message: 'x' });
    expect(info.class).toBe('unknown');
    expect(info.action).toBe('retry');
  });

  it('handles a null error', () => {
    const info = classifyExportFailure(null);
    expect(info.class).toBe('unknown');
    expect(info.action).toBe('retry');
    expect(info.retriable).toBe(true);
  });

  it('prefers server remediation and retriable over local copy (IXH-6.4)', () => {
    const info = classifyExportFailure({
      code: 'UNSUPPORTED_TARGET',
      message: 'Target gone',
      category: 'capability',
      remediation: 'Pick another target from the registry.',
      retriable: false,
    });
    expect(info.description).toBe('Pick another target from the registry.');
    expect(info.retriable).toBe(false);
    expect(info.action).toBe('reconfigure-target');
  });
});

describe('exportJob — validationReportFromError', () => {
  it('extracts an EmittedValidationReport from a validation-gate failure context', () => {
    const error: ExportJobError = {
      code: 'EMITTED_ARTIFACT_INVALID',
      message: 'blocked',
      context: {
        target: 'proto',
        validation: {
          verdict: 'invalid',
          target: 'proto',
          blocks_delivery: true,
          warns: false,
          valid: false,
          findings: [{ message: 'bad field' }],
          headline: 'Invalid',
          message: 'blocked',
        },
      },
    };
    const report = validationReportFromError(error);
    expect(report?.verdict).toBe('invalid');
    expect(report?.findings).toHaveLength(1);
  });

  it('returns null when the context carries no validation report', () => {
    expect(validationReportFromError({ code: 'EMIT_FAILED', message: 'x' })).toBeNull();
    expect(validationReportFromError({ code: 'X', message: 'x', context: { validation: 42 } })).toBeNull();
    expect(validationReportFromError({ code: 'X', message: 'x', context: { validation: {} } })).toBeNull();
    expect(validationReportFromError(null)).toBeNull();
  });
});

describe('exportJob — exportJobStatusLine', () => {
  it('describes each state for the toast/a11y line', () => {
    expect(exportJobStatusLine(status({ state: 'completed' }), 'OpenAPI 3.1')).toMatch(/ready to download/i);
    expect(
      exportJobStatusLine(status({ state: 'failed', error: { code: 'X', message: 'boom' } }), 'OpenAPI 3.1'),
    ).toMatch(/failed: boom/i);
    expect(exportJobStatusLine(status({ state: 'canceled' }), 'OpenAPI 3.1')).toMatch(/canceled/i);
    expect(exportJobStatusLine(status({ state: 'running', percent: 55 }), 'OpenAPI 3.1')).toMatch(/55%/);
  });
});
