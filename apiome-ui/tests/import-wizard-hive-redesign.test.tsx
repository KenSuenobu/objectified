/**
 * The import-wizard redesign, rendered (HIVE-6.4, #5315).
 *
 * `import-wizard-model.test.ts` holds the decisions and `import-wizard-css.test.ts` pins the
 * declarations; this mounts the wizard itself and the two panels the ticket's acceptance
 * criteria are about.
 *
 * What it pins is those criteria:
 *
 *   1. **Every source tab reaches its intake.** The tab bar is derived from the same cards the
 *      grid draws, so a registry adapter gets a tab; every built-in tab opens its panel, and a
 *      discovery-only adapter is drawn disabled rather than dropped.
 *   2. **All eight job states render, including the failure classes with actionable copy.**
 *      `ImportExecutionPanel` is mounted once per state against a stubbed job store.
 *   3. **Back/Cancel semantics per step are preserved, and Back is disabled during import.**
 *   4. **The AI hand-off still preloads the wizard** — `initialLLMSpec` runs analysis on open and
 *      lands on the Analyze step without the reader picking a source.
 *   5. **The quality snapshot is still written on success.**
 *
 * Plus an axe pass over the two densest surfaces (the source grid and the Import step), which is
 * the DoD's "zero serious/critical violations".
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { jest } from '@jest/globals';

import {
  IMPORT_JOB_STATES,
  IMPORT_WIZARD_COPY,
  importJobPresentation,
} from '@/app/components/ade/import/importWizardModel';

/** axe options shared with the other component suites: contrast is the CSS suite's job. */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

/* -------------------------------------------------------------------------
   Stubs
   ------------------------------------------------------------------------- */

/** The async job store. Each suite swaps `getImportStatus`'s answer. */
const getImportStatus = jest.fn<(jobId: string) => Promise<Record<string, unknown>>>();
const startImport = jest.fn<(input: unknown) => Promise<{ jobId: string }>>();
const rollbackImport = jest.fn<(jobId: string) => Promise<unknown>>();
const cancelImport = jest.fn<(jobId: string) => Promise<unknown>>();
const commitImport = jest.fn<(jobId: string) => Promise<{ success: boolean }>>();
const retryImport = jest.fn<(jobId: string) => Promise<{ success: boolean; jobId?: string }>>();

jest.mock('@lib/db/import-actions', () => ({
  __esModule: true,
  getImportStatus: (...args: [string]) => getImportStatus(...args),
  startImport: (...args: [unknown]) => startImport(...args),
  rollbackImport: (...args: [string]) => rollbackImport(...args),
  cancelImport: (...args: [string]) => cancelImport(...args),
  commitImport: (...args: [string]) => commitImport(...args),
  retryImport: (...args: [string]) => retryImport(...args),
}));

/** Monaco is the clipboard intake's editor; jsdom has no canvas for it. */
jest.mock('@monaco-editor/react', () => {
  const React_ = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ({ value, onChange }: { value?: string; onChange?: (next?: string) => void }) =>
      React_.createElement('textarea', {
        'aria-label': 'Specification content',
        value: value ?? '',
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value),
      }),
  };
});

/** The quality-snapshot writer, so the "still written on success" claim is observable. */
const appendProjectQualitySnapshot = jest.fn();
jest.mock('@/app/utils/project-quality-score-history', () => ({
  __esModule: true,
  appendProjectQualitySnapshot: (...args: unknown[]) => appendProjectQualitySnapshot(...args),
  buildQualitySnapshotReportExtras: () => ({}),
}));

/** The analyzer, so a preloaded spec resolves without parsing a real document. */
const analyzeSpecification = jest.fn<(content: string, filename: string) => Promise<unknown>>();
jest.mock('@/app/utils/openapi-analyzer', () => {
  const actual = jest.requireActual<typeof import('@/app/utils/openapi-analyzer')>(
    '@/app/utils/openapi-analyzer'
  );
  return {
    __esModule: true,
    ...actual,
    analyzeSpecification: (...args: [string, string]) => analyzeSpecification(...args),
  };
});

/** The Analyze and Preview panels are covered by their own suites; here they are placeholders. */
jest.mock('@/app/components/ade/dashboard/AnalysisPanel', () => ({
  __esModule: true,
  AnalysisPanel: ({ fileName }: { fileName: string }) => (
    <div data-testid="analysis-panel">{fileName}</div>
  ),
}));
/**
 * The Preview step is stubbed down to its one contract with the wizard: it emits the options
 * the footer reads. A button rather than an effect, so a test can choose whether a selection
 * has been made — which is what the disabled/enabled `Import →` rule is about.
 */
jest.mock('@/app/components/ade/dashboard/PreviewPanel', () => ({
  __esModule: true,
  PreviewPanel: ({
    onImportOptionsChange,
  }: {
    onImportOptionsChange: (options: Record<string, unknown>) => void;
  }) => (
    <div data-testid="preview-panel">
      <button
        type="button"
        onClick={() =>
          onImportOptionsChange({
            projectName: 'Payments API',
            projectSlug: 'payments-api',
            targetVersion: '2.4.0',
            selectedSchemas: ['Refund'],
          })
        }
      >
        Select Refund
      </button>
      <button
        type="button"
        onClick={() =>
          onImportOptionsChange({
            projectName: 'Payments API',
            projectSlug: 'payments-api',
            targetVersion: '2.4.0',
            selectedSchemas: ['Refund'],
            dryRun: true,
          })
        }
      >
        Select Refund (dry run)
      </button>
    </div>
  ),
}));

// eslint-disable-next-line import/first
import ImportDialog from '@/app/components/ade/dashboard/ImportDialog';
// eslint-disable-next-line import/first
import ImportExecutionPanel from '@/app/components/ade/dashboard/ImportExecutionPanel';

/** An analysis that passes every gate. */
const GOOD_ANALYSIS = {
  isValid: true,
  formatSupported: true,
  format: 'openapi',
  formatDisplayName: 'OpenAPI 3.1',
  version: '3.1.0',
  syntax: 'yaml',
  syntaxValid: true,
  schemaValid: true,
  metrics: {
    schemaCount: 2,
    propertyCount: 8,
    referenceCount: 1,
    pathCount: 3,
    externalReferences: [],
    circularReferences: [],
    customExtensions: [],
    compositionSchemas: { allOf: 0, oneOf: 0, anyOf: 0 },
  },
  qualityScore: { overall: 88, grade: 'B', categories: {}, issues: [] },
  errors: [],
  warnings: [],
  unsupportedFeatures: [],
  document: { info: { title: 'Payments API', version: '2.4.0' } },
};

/** The registry's answer to `GET /api/import/sources` — one adapter beyond the built-ins. */
const REGISTRY_SOURCES = {
  sources: [
    {
      key: 'grpc',
      label: 'gRPC',
      description: 'Protobuf service definitions',
      icon: 'network',
      paradigm: 'rpc',
      input_kinds: ['discovery'],
      supports_live_discovery: true,
      formats: ['protobuf'],
    },
  ],
};

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/** Answer the registry call and nothing else, so a stray request is visible as a failure. */
function stubRegistry() {
  fetchMock.mockImplementation(((input: RequestInfo | URL) => {
    if (String(input).includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: async () => REGISTRY_SOURCES });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as never);
}

/** Mount the wizard with the props every entry point passes. */
function renderWizard(overrides: Record<string, unknown> = {}) {
  const onClose = jest.fn();
  const onSuccess = jest.fn();
  const result = render(
    <ImportDialog
      open
      onClose={onClose}
      onSuccess={onSuccess}
      tenantId="tenant-1"
      userId="user-1"
      {...overrides}
    />
  );
  return { ...result, onClose, onSuccess };
}

beforeEach(() => {
  jest.clearAllMocks();
  stubRegistry();
  analyzeSpecification.mockResolvedValue(GOOD_ANALYSIS);
  getImportStatus.mockResolvedValue({ state: 'queued', percent: 0, events: [] });
});

/* -------------------------------------------------------------------------
   1. The Source step
   ------------------------------------------------------------------------- */

describe('the Source step', () => {
  it('draws one card per built-in source, plus whatever the registry adds', async () => {
    renderWizard();
    expect(await screen.findByRole('button', { name: /File Upload/ })).toBeInTheDocument();
    for (const label of [
      'URL Import',
      'Clipboard Paste',
      'Git Repository',
      'SwaggerHub',
      'Postman Collection',
      'MCP Server',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /gRPC/ })).toBeInTheDocument());
  });

  it('draws a discovery-only adapter disabled rather than dropping it', async () => {
    renderWizard();
    const grpc = await screen.findByRole('button', { name: /gRPC/ });
    expect(grpc).toBeDisabled();
    expect(grpc).toHaveAttribute('title', IMPORT_WIZARD_COPY.comingSoon);
  });

  it('opens the chosen source’s intake when a card is pressed', async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole('button', { name: /File Upload/ }));
    expect(await screen.findByText(IMPORT_WIZARD_COPY.dropTitle)).toBeInTheDocument();
  });

  it('offers Cancel and a disabled forward button, and no Back', async () => {
    renderWizard();
    await screen.findByRole('button', { name: /File Upload/ });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '← Back' })).not.toBeInTheDocument();
  });

  it('names the wizard and its five steps', async () => {
    renderWizard();
    await screen.findByRole('button', { name: /File Upload/ });
    expect(screen.getByText(IMPORT_WIZARD_COPY.title)).toBeInTheDocument();
    const stepper = screen.getByRole('list', { name: 'Import progress' });
    for (const label of ['Source', 'Analyze', 'Preview', 'Import', 'Done']) {
      expect(within(stepper).getByText(label)).toBeInTheDocument();
    }
  });

  it('marks Source as the step the reader is on', async () => {
    renderWizard();
    await screen.findByRole('button', { name: /File Upload/ });
    const current = screen.getByRole('list', { name: 'Import progress' }).querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent('Source');
  });

  it('has no serious or critical axe violations', async () => {
    const { container } = renderWizard();
    await screen.findByRole('button', { name: /gRPC/ });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

/* -------------------------------------------------------------------------
   2. The intake tab bar — "every source tab reaches a successful import"
   ------------------------------------------------------------------------- */

describe('the intake tab bar', () => {
  /** Open the wizard on the File intake, where the tab bar is drawn. */
  async function openIntake() {
    const rendered = renderWizard();
    fireEvent.click(await screen.findByRole('button', { name: /File Upload/ }));
    await screen.findByRole('tablist', { name: 'Import source' });
    return rendered;
  }

  it('lists every source the grid offers, plus Design with AI', async () => {
    await openIntake();
    const tabs = screen.getByRole('tablist', { name: 'Import source' });
    for (const label of [
      'File Upload',
      'URL Import',
      'Clipboard Paste',
      'Git Repository',
      'SwaggerHub',
      'Postman Collection',
      'MCP Server',
      'Design with AI',
    ]) {
      expect(within(tabs).getByRole('tab', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('marks the source the reader is on', async () => {
    await openIntake();
    const tabs = screen.getByRole('tablist', { name: 'Import source' });
    expect(within(tabs).getByRole('tab', { name: /File Upload/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('switches intake without a trip back to the card grid', async () => {
    await openIntake();
    const tabs = screen.getByRole('tablist', { name: 'Import source' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /MCP Server/ }));
    expect(await screen.findByText('Add an MCP server')).toBeInTheDocument();
    // The bar is still there, so the next switch is one click away too.
    expect(screen.getByRole('tablist', { name: 'Import source' })).toBeInTheDocument();
  });

  it('draws the discovery-only adapter’s tab disabled', async () => {
    await openIntake();
    const tabs = screen.getByRole('tablist', { name: 'Import source' });
    await waitFor(() =>
      expect(within(tabs).getByRole('tab', { name: /gRPC/ })).toBeDisabled()
    );
  });

  it('carries the right forward verb for each intake', async () => {
    await openIntake();
    expect(screen.getByRole('button', { name: 'Analyze →' })).toBeInTheDocument();

    const tabs = screen.getByRole('tablist', { name: 'Import source' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /URL Import/ }));
    expect(await screen.findByRole('button', { name: 'Next →' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test URL/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /MCP Server/ }));
    expect(await screen.findByRole('button', { name: 'Discover →' })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   3. The File intake
   ------------------------------------------------------------------------- */

describe('the File intake', () => {
  async function openFileIntake() {
    const rendered = renderWizard();
    fireEvent.click(await screen.findByRole('button', { name: /File Upload/ }));
    await screen.findByText(IMPORT_WIZARD_COPY.dropTitle);
    return rendered;
  }

  it('lists the extensions it accepts, and accepts exactly those', async () => {
    await openFileIntake();
    expect(screen.getByText(IMPORT_WIZARD_COPY.dropExtensions)).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.yaml,.yml,.json,.zip,.graphql,.gql,.raml,.proto,.avsc,.thrift');
  });

  it('refuses Analyze until a file has been chosen', async () => {
    await openFileIntake();
    expect(screen.getByRole('button', { name: 'Analyze →' })).toBeDisabled();
  });

  it('reads a chosen file and offers Analyze', async () => {
    await openFileIntake();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['openapi: 3.1.0\ninfo:\n  title: Payments\n  version: 2.4.0\n'], 'payments.yaml', {
      type: 'text/yaml',
    });
    Object.defineProperty(file, 'text', { value: async () => 'openapi: "3.1.0"' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('payments.yaml')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Analyze →' })).toBeEnabled());
  });

  it('says why an unsupported extension was refused', async () => {
    await openFileIntake();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unsupported file type/);
  });
});

/* -------------------------------------------------------------------------
   4. The AI hand-off — "Import this spec still preloads the wizard"
   ------------------------------------------------------------------------- */

describe('the AI hand-off', () => {
  it('analyzes the handed-over spec on open and lands on Analyze', async () => {
    const onConsumeInitialLLMSpec = jest.fn();
    renderWizard({
      initialLLMSpec: '{"openapi":"3.1.0"}',
      onConsumeInitialLLMSpec,
    });

    await waitFor(() =>
      expect(analyzeSpecification).toHaveBeenCalledWith('{"openapi":"3.1.0"}', 'ai-generated-spec.json')
    );
    expect(await screen.findByTestId('analysis-panel')).toBeInTheDocument();
    // The parent is told, so re-opening the dialog does not re-run the analysis.
    expect(onConsumeInitialLLMSpec).toHaveBeenCalled();
  });

  it('leads the Analyze step with the quality gate', async () => {
    renderWizard({ initialLLMSpec: '{"openapi":"3.1.0"}' });
    await screen.findByTestId('analysis-panel');
    expect(screen.getByText('Ready to import')).toBeInTheDocument();
  });

  it('reports a failed analysis instead of stranding the reader on a blank step', async () => {
    analyzeSpecification.mockRejectedValue(new Error('Unexpected end of JSON input'));
    renderWizard({ initialLLMSpec: '{' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Unexpected end of JSON input');
  });
});

/* -------------------------------------------------------------------------
   5. A pre-selected source — the MCP servers entry point
   ------------------------------------------------------------------------- */

describe('opening straight onto a source', () => {
  it('jumps to the MCP intake and consumes the request', async () => {
    const onConsumeInitialSource = jest.fn();
    renderWizard({ initialSource: 'mcp', onConsumeInitialSource });
    expect(await screen.findByText('Add an MCP server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover →' })).toBeDisabled();
    expect(onConsumeInitialSource).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
   6. The eight job states — mounted one at a time
   ------------------------------------------------------------------------- */

describe('the Import step', () => {
  it.each(IMPORT_JOB_STATES)('draws the %s state with its badge and its sentence', async (state) => {
    getImportStatus.mockResolvedValue({
      state,
      percent: state === 'completed' ? 100 : 40,
      events: [],
      progress: { phase: 'creating-classes', total: 4, completed: 2 },
    });

    render(<ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={[]} />);

    const presentation = importJobPresentation(state);
    expect(await screen.findByText(presentation.label)).toBeInTheDocument();
    expect(screen.getByText(presentation.note)).toBeInTheDocument();
  });

  it('offers Accept and Reject only while an approval is pending', async () => {
    getImportStatus.mockResolvedValue({ state: 'pending-approval', percent: 100, events: [] });
    render(<ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={[]} />);
    expect(await screen.findByRole('button', { name: /Accept & commit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject & rollback/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry import/ })).not.toBeInTheDocument();
  });

  it('offers Retry on the two failures a reader can act on', async () => {
    for (const state of ['failed', 'canceled'] as const) {
      getImportStatus.mockResolvedValue({ state, percent: 30, events: [] });
      const { unmount } = render(
        <ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={[]} onRetry={jest.fn()} />
      );
      expect(await screen.findByRole('button', { name: /Retry import/ })).toBeInTheDocument();
      unmount();
    }
  });

  it('offers Cancel only while the job is still moving', async () => {
    getImportStatus.mockResolvedValue({ state: 'running', percent: 40, events: [] });
    const { unmount } = render(<ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={[]} />);
    expect(await screen.findByRole('button', { name: /Cancel import/ })).toBeInTheDocument();
    unmount();

    getImportStatus.mockResolvedValue({ state: 'rolled-back', percent: 0, events: [] });
    render(<ImportExecutionPanel jobId="job-2" isReviewing selectedSchemas={[]} />);
    await screen.findByText('Rolled back');
    expect(screen.queryByRole('button', { name: /Cancel import/ })).not.toBeInTheDocument();
  });

  it('lists the failures with their code, message and context', async () => {
    getImportStatus.mockResolvedValue({
      state: 'failed',
      percent: 30,
      events: [
        {
          id: 'e1',
          ts: 1,
          level: 'error',
          code: 'CLASS_FAILED',
          message: 'Could not create Refund',
          context: { schemaName: 'Refund' },
        },
      ],
    });
    render(<ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={[]} />);
    const failures = await screen.findByRole('alert', { name: 'Import failures' });
    expect(within(failures).getByText('CLASS_FAILED')).toBeInTheDocument();
    expect(within(failures).getByText('Could not create Refund')).toBeInTheDocument();
    expect(within(failures).getByText(/"schemaName": "Refund"/)).toBeInTheDocument();
  });

  it('carries a log line’s severity as data-level rather than as a colour class', async () => {
    getImportStatus.mockResolvedValue({
      state: 'running',
      percent: 20,
      events: [
        { id: 'e1', ts: 1, level: 'info', code: 'START', message: 'Started' },
        { id: 'e2', ts: 2, level: 'warn', code: 'PROP_WARN', message: 'Odd property' },
        { id: 'e3', ts: 3, level: 'warn', code: 'SKIP_PROPERTY', message: 'Skipping x' },
        { id: 'e4', ts: 4, level: 'error', code: 'CLASS_FAILED', message: 'Boom' },
      ],
    });
    const { container } = render(
      <ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={[]} />
    );
    await screen.findAllByText('Started');
    const levels = [...container.querySelectorAll('.imp-log__line')].map((line) =>
      line.getAttribute('data-level')
    );
    expect(levels).toEqual(['info', 'warn', 'skipped', 'error']);
  });

  it('has no serious or critical axe violations', async () => {
    getImportStatus.mockResolvedValue({
      state: 'running',
      percent: 62,
      events: [{ id: 'e1', ts: 1, level: 'info', code: 'START', message: 'Started' }],
      progress: { phase: 'creating-classes', total: 4, completed: 2 },
    });
    const { container } = render(
      <ImportExecutionPanel jobId="job-1" isReviewing selectedSchemas={['Refund']} />
    );
    await screen.findByText('Running');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

/* -------------------------------------------------------------------------
   7. Back / Cancel semantics
   ------------------------------------------------------------------------- */

describe('back and cancel', () => {
  it('returns from an intake to the card grid, forgetting the source', async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole('button', { name: /File Upload/ }));
    await screen.findByText(IMPORT_WIZARD_COPY.dropTitle);

    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(await screen.findByRole('button', { name: /Clipboard Paste/ })).toBeInTheDocument();
    expect(screen.queryByText(IMPORT_WIZARD_COPY.dropTitle)).not.toBeInTheDocument();
  });

  it('returns to the New Project conversation when the wizard was opened from it', async () => {
    const onReturnToNewProjectAI = jest.fn();
    renderWizard({
      initialLLMSpec: '{"openapi":"3.1.0"}',
      openedFromNewProjectAI: true,
      onReturnToNewProjectAI,
    });
    await screen.findByTestId('analysis-panel');

    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(onReturnToNewProjectAI).toHaveBeenCalled();
  });

  it('closes from the card grid without touching the job store', async () => {
    const { onClose } = renderWizard();
    await screen.findByRole('button', { name: /File Upload/ });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(rollbackImport).not.toHaveBeenCalled();
  });

  it('warns on the close button that closing rolls a running job back', async () => {
    renderWizard();
    await screen.findByRole('button', { name: /File Upload/ });
    expect(
      screen.getByRole('button', { name: IMPORT_WIZARD_COPY.closeWarning })
    ).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   8. The recent-jobs drawer
   ------------------------------------------------------------------------- */

describe('the recent-jobs drawer', () => {
  it('opens from the wizard’s head', async () => {
    renderWizard();
    await screen.findByRole('button', { name: /File Upload/ });
    fireEvent.click(screen.getByRole('button', { name: IMPORT_WIZARD_COPY.jobsDrawerTitle }));

    const drawer = await screen.findByRole('dialog', { name: IMPORT_WIZARD_COPY.jobsDrawerTitle });
    expect(within(drawer).getByText(IMPORT_WIZARD_COPY.jobsDrawerNote)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   9. The quality snapshot
   ------------------------------------------------------------------------- */

describe('the quality snapshot', () => {
  /** Walk the wizard from the AI hand-off to a landed import. */
  async function importToCompletion() {
    renderWizard({ initialLLMSpec: '{"openapi":"3.1.0"}' });
    await screen.findByTestId('analysis-panel');

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await screen.findByTestId('preview-panel');

    // With nothing selected the footer refuses — the rule `importFooterFor` states.
    expect(screen.getByRole('button', { name: 'Import →' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Select Refund' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import →' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Import →' }));
  }

  it('is appended once a real import lands, with the grade the analysis gave it', async () => {
    startImport.mockResolvedValue({ jobId: 'job-9' });
    getImportStatus.mockResolvedValue({
      state: 'completed',
      percent: 100,
      events: [],
      result: { projectId: 'project-9' },
    });

    await importToCompletion();

    await waitFor(() =>
      expect(appendProjectQualitySnapshot).toHaveBeenCalledWith(
        'project-9',
        expect.objectContaining({ overall: 88, grade: 'B', importJobId: 'job-9' })
      )
    );
  });

  it('is not appended for a dry run, which saved nothing to score', async () => {
    startImport.mockResolvedValue({ jobId: 'job-10' });
    getImportStatus.mockResolvedValue({
      state: 'completed',
      percent: 100,
      events: [],
      summary: { dryRun: true },
      result: { projectId: 'project-10' },
    });

    renderWizard({ initialLLMSpec: '{"openapi":"3.1.0"}' });
    await screen.findByTestId('analysis-panel');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await screen.findByTestId('preview-panel');
    fireEvent.click(screen.getByRole('button', { name: 'Select Refund (dry run)' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import →' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Import →' }));

    await screen.findByText('Dry run complete. No changes were saved.');
    expect(appendProjectQualitySnapshot).not.toHaveBeenCalled();
  });

  it('starts the import with the options the Preview step emitted', async () => {
    startImport.mockResolvedValue({ jobId: 'job-11' });
    getImportStatus.mockResolvedValue({ state: 'running', percent: 10, events: [] });

    await importToCompletion();

    await waitFor(() => expect(startImport).toHaveBeenCalled());
    expect(startImport).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        project: expect.objectContaining({ name: 'Payments API', slug: 'payments-api' }),
        options: expect.objectContaining({ selectedSchemas: ['Refund'] }),
      })
    );
  });

  it('disables Back while that job runs, and enables it once the job lands', async () => {
    startImport.mockResolvedValue({ jobId: 'job-12' });
    getImportStatus.mockResolvedValue({ state: 'running', percent: 10, events: [] });

    await importToCompletion();

    await waitFor(() => expect(screen.getByRole('button', { name: '← Back' })).toBeDisabled());

    getImportStatus.mockResolvedValue({ state: 'completed', percent: 100, events: [], result: {} });
    await waitFor(() => expect(screen.getByRole('button', { name: '← Back' })).toBeEnabled(), {
      timeout: 5000,
    });
    // And the dismiss verb has stopped saying there is something to cancel.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   10. The browser fixtures
   ------------------------------------------------------------------------- */

/**
 * `e2e/hive-import-wizard.spec.ts` measures this wizard in a real browser — no horizontal
 * document scroll across the themes, densities and font scales, and axe — against markup the
 * components actually render. That markup is written here, from the very renders this suite
 * pins, into `e2e/fixtures/hive-import-wizard/` when `IMPORT_WIZARD_FIXTURE_DUMP=1` is set:
 *
 *     IMPORT_WIZARD_FIXTURE_DUMP=1 npx jest tests/import-wizard-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there
 * — so a change to a component that would leave the fixtures stale fails loudly here before it
 * fails quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-import-wizard');
  const dump = process.env.IMPORT_WIZARD_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The wizard's own dialog element, wherever Radix portalled it. */
  const wizard = () => document.querySelector('.imp-wizard') as HTMLElement;

  it('renders every surface the browser spec mounts (and writes the fixtures on request)', async () => {
    renderWizard();
    await screen.findByRole('button', { name: /gRPC/ });
    write('source', wizard().outerHTML);

    fireEvent.click(screen.getByRole('button', { name: /File Upload/ }));
    await screen.findByText(IMPORT_WIZARD_COPY.dropTitle);
    write('intake', wizard().outerHTML);

    fireEvent.click(screen.getByRole('tab', { name: /MCP Server/ }));
    await screen.findByText('Add an MCP server');
    write('mcp', wizard().outerHTML);
  });

  it('renders the Import step in its running and failed states', async () => {
    getImportStatus.mockResolvedValue({
      state: 'running',
      percent: 62,
      progress: { phase: 'creating-classes', total: 8, completed: 5 },
      events: [
        { id: 'e1', ts: 1, level: 'info', code: 'START', message: 'Import started' },
        { id: 'e2', ts: 2, level: 'warn', code: 'PROP_WARN', message: 'Property amount has no example' },
        { id: 'e3', ts: 3, level: 'warn', code: 'SKIP_PROPERTY', message: 'Skipping property x-internal' },
      ],
    });
    const running = render(
      <ImportExecutionPanel jobId="job-a" isReviewing selectedSchemas={['Refund', 'Payout']} />
    );
    await screen.findByText('Running');
    write('import-running', running.container.innerHTML);
    running.unmount();

    getImportStatus.mockResolvedValue({
      state: 'failed',
      percent: 41,
      events: [
        {
          id: 'e1',
          ts: 1,
          level: 'error',
          code: 'CLASS_FAILED',
          message: 'Could not create Refund: duplicate class name',
          context: { schemaName: 'Refund', reason: 'Duplicate' },
        },
      ],
      summary: { classes: 0, properties: 0 },
    });
    const failed = render(
      <ImportExecutionPanel jobId="job-b" isReviewing selectedSchemas={['Refund']} onRetry={jest.fn()} />
    );
    await screen.findByText('Failed');
    write('import-failed', failed.container.innerHTML);
  });
});
