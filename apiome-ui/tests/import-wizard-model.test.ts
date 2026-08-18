/**
 * The import wizard's decisions (HIVE-6.4, #5315).
 *
 * `import-wizard-hive-redesign.test.tsx` mounts the dialog and `import-wizard-css.test.ts` pins
 * the declarations; this asserts the rules those two rest on, with nothing rendered and no
 * import started.
 *
 * It exists because before this ticket every one of these was spelled inline in
 * `ImportDialog.tsx`'s JSX — the footer verb per source (nine copies), whether Back was allowed
 * (one branch remembered, three did not), which of eight job states is a failure, and what the
 * Analyze step says about a document it cannot import. The ticket's acceptance criteria are
 * mostly claims about *those*, so they are testable here rather than only through a browser.
 */

import { Upload, Link2, Network } from 'lucide-react';

import {
  IMPORT_FILE_EXTENSIONS,
  IMPORT_JOB_STATES,
  IMPORT_WIZARD_COPY,
  IMPORT_WIZARD_STEPS,
  importFooterFor,
  importJobPresentation,
  importQualityGate,
  intakeTabsForCards,
  isAcceptedImportFile,
  stepperIdFor,
  urlTestAction,
  type ImportFooterState,
  type ImportWizardStep,
} from '@/app/components/ade/import/importWizardModel';
import type { ImportSourceCard } from '@/app/components/ade/dashboard/importSourceCatalog';

/** A footer state with every flag off — each test turns on only what it is about. */
function footerState(overrides: Partial<ImportFooterState> = {}): ImportFooterState {
  return {
    step: 'file-upload',
    source: 'file',
    importComplete: false,
    importSucceeded: false,
    ...overrides,
  };
}

/** Three cards standing in for the catalog: two usable, one discovery-only. */
const CARDS: ImportSourceCard[] = [
  {
    key: 'file',
    label: 'File Upload',
    description: 'Drop files or click to browse',
    icon: Upload,
    panel: 'file',
    builtin: true,
    scope: 'both',
  },
  {
    key: 'url',
    label: 'URL Import',
    description: 'Fetch from URL',
    icon: Link2,
    panel: 'url',
    builtin: true,
    scope: 'both',
  },
  {
    key: 'grpc',
    label: 'gRPC',
    description: 'Discovery only',
    icon: Network,
    panel: null,
    builtin: false,
    scope: 'alternative',
  },
];

/* -------------------------------------------------------------------------
   Steps
   ------------------------------------------------------------------------- */

describe('the stepper', () => {
  it('has the five stops the mockup names, in order', () => {
    expect(IMPORT_WIZARD_STEPS.map((step) => step.id)).toEqual([
      'source',
      'analyze',
      'preview',
      'import',
      'done',
    ]);
    expect(IMPORT_WIZARD_STEPS.map((step) => step.label)).toEqual([
      'Source',
      'Analyze',
      'Preview',
      'Import',
      'Done',
    ]);
  });

  it('reads the card grid and the chosen source’s intake as the same stop', () => {
    // Picking a card and filling its form is one decision made in two screens; showing the
    // stepper advance between them would claim progress the reader has not made.
    expect(stepperIdFor('source')).toBe('source');
    expect(stepperIdFor('file-upload')).toBe('source');
  });

  it('maps every internal step to a stop', () => {
    const steps: ImportWizardStep[] = ['source', 'file-upload', 'analysis', 'preview', 'import', 'done'];
    for (const step of steps) {
      expect(IMPORT_WIZARD_STEPS.map((entry) => entry.id)).toContain(stepperIdFor(step));
    }
  });
});

/* -------------------------------------------------------------------------
   Intake tabs
   ------------------------------------------------------------------------- */

describe('the intake tab bar', () => {
  it('offers one tab per source card, in card order', () => {
    const tabs = intakeTabsForCards(CARDS);
    expect(tabs.slice(0, 3).map((tab) => tab.id)).toEqual(['file', 'url', 'grpc']);
    expect(tabs.slice(0, 3).map((tab) => tab.label)).toEqual(['File Upload', 'URL Import', 'gRPC']);
  });

  it('appends Design with AI, which is a source but not a registry adapter', () => {
    const tabs = intakeTabsForCards(CARDS);
    expect(tabs[tabs.length - 1]).toEqual({ id: 'llm', label: 'Design with AI', panel: 'llm' });
  });

  it('keeps a discovery-only adapter as a tab with no panel, rather than dropping it', () => {
    // The server advertises the adapter; a source that silently is not there reads as a bug.
    const grpc = intakeTabsForCards(CARDS).find((tab) => tab.id === 'grpc');
    expect(grpc?.panel).toBeNull();
  });

  it('renders nothing but Design with AI when the registry list is empty', () => {
    expect(intakeTabsForCards([])).toEqual([{ id: 'llm', label: 'Design with AI', panel: 'llm' }]);
  });
});

/* -------------------------------------------------------------------------
   Footer verbs — the ticket's "Back/Cancel semantics per step preserved"
   ------------------------------------------------------------------------- */

describe('the footer', () => {
  it('offers no Back on the card grid, and a disabled forward button', () => {
    const footer = importFooterFor(footerState({ step: 'source', source: null }));
    expect(footer.back).toBeNull();
    expect(footer.cancel.label).toBe('Cancel');
    // The cards navigate on click; the button stays so the footer does not change shape.
    expect(footer.primary).toEqual({ label: 'Next →', disabled: true });
  });

  it('says Analyze → on every intake but URL and MCP', () => {
    for (const source of ['file', 'clipboard', 'git', 'swaggerhub', 'postman']) {
      const footer = importFooterFor(footerState({ source, intakeReady: true }));
      expect(footer.primary).toEqual({ label: 'Analyze →', disabled: false });
    }
  });

  it('says Next → on URL, which already spent its Analyze verb on Test URL', () => {
    const footer = importFooterFor(footerState({ source: 'url', intakeReady: true }));
    expect(footer.primary).toEqual({ label: 'Next →', disabled: false });
  });

  it('says Discover → on MCP, which has no analyze or preview step', () => {
    const footer = importFooterFor(footerState({ source: 'mcp', mcpReady: true }));
    expect(footer.primary).toEqual({ label: 'Discover →', disabled: false });
  });

  it('disables the forward verb until the intake has produced content', () => {
    expect(importFooterFor(footerState({ source: 'file', intakeReady: false })).primary).toEqual({
      label: 'Analyze →',
      disabled: true,
    });
    expect(importFooterFor(footerState({ source: 'mcp', mcpReady: false })).primary).toEqual({
      label: 'Discover →',
      disabled: true,
    });
  });

  it('says what it is doing while it does it', () => {
    expect(
      importFooterFor(footerState({ source: 'file', intakeReady: true, analyzing: true })).primary
    ).toEqual({ label: 'Analyzing...', disabled: true });
    expect(
      importFooterFor(footerState({ source: 'mcp', mcpReady: true, mcpSubmitting: true })).primary
    ).toEqual({ label: 'Starting…', disabled: true });
  });

  it('gates Analyze’s forward verb on the document being importable', () => {
    expect(
      importFooterFor(footerState({ step: 'analysis', analysisImportable: false })).primary
    ).toEqual({ label: 'Next →', disabled: true });
    expect(
      importFooterFor(footerState({ step: 'analysis', analysisImportable: true })).primary
    ).toEqual({ label: 'Next →', disabled: false });
  });

  it('gates Preview’s Import → on at least one selected schema', () => {
    expect(importFooterFor(footerState({ step: 'preview', hasSelection: false })).primary).toEqual({
      label: 'Import →',
      disabled: true,
    });
    expect(importFooterFor(footerState({ step: 'preview', hasSelection: true })).primary).toEqual({
      label: 'Import →',
      disabled: false,
    });
  });

  it('disables Back while a job is running, and re-enables it when the job lands', () => {
    // A running job owns rows in the database; stepping back off it would leave them with
    // nothing watching. This is the acceptance criterion, stated once.
    expect(importFooterFor(footerState({ step: 'import' })).back).toEqual({
      label: '← Back',
      disabled: true,
    });
    expect(
      importFooterFor(footerState({ step: 'import', importComplete: true, importSucceeded: true }))
        .back
    ).toEqual({ label: '← Back', disabled: false });
  });

  it('offers no forward verb while the job is still moving', () => {
    expect(importFooterFor(footerState({ step: 'import' })).primary).toBeNull();
  });

  it('offers Next → only once the job has landed successfully', () => {
    expect(
      importFooterFor(footerState({ step: 'import', importComplete: true, importSucceeded: true }))
        .primary
    ).toEqual({ label: 'Next →', disabled: false });
    expect(
      importFooterFor(footerState({ step: 'import', importComplete: true, importSucceeded: false }))
        .primary
    ).toBeNull();
  });

  it('changes the dismiss verb to Close once there is nothing left to cancel', () => {
    expect(importFooterFor(footerState({ step: 'import' })).cancel.label).toBe('Cancel');
    expect(
      importFooterFor(footerState({ step: 'import', importComplete: true, importSucceeded: true }))
        .cancel.label
    ).toBe('Close');
  });

  it('turns a failed MCP import’s dismiss verb into Discard, with a deliberate way to keep it', () => {
    // Closing also deletes the endpoint that was created, so the verb says so — and keeping a
    // server whose scan failed has to be the explicit choice, not the default.
    const footer = importFooterFor(
      footerState({ step: 'import', source: 'mcp', importComplete: true, importSucceeded: false })
    );
    expect(footer.cancel.label).toBe('Discard');
    expect(footer.keepAnyway).toEqual({ label: 'Add this server anyway', disabled: false });
    expect(footer.primary).toBeNull();
    expect(footer.back).toEqual({ label: '← Back', disabled: false });
  });

  it('offers keepAnyway on no other step or source', () => {
    const states: Partial<ImportFooterState>[] = [
      { step: 'source', source: null },
      { step: 'file-upload', source: 'mcp' },
      { step: 'analysis' },
      { step: 'preview' },
      { step: 'import', importComplete: true, importSucceeded: false },
      { step: 'import', source: 'mcp', importComplete: true, importSucceeded: true },
      { step: 'done', source: 'mcp' },
    ];
    for (const overrides of states) {
      expect(importFooterFor(footerState(overrides)).keepAnyway).toBeNull();
    }
  });

  it('closes the flow from Done with a Done button', () => {
    const footer = importFooterFor(footerState({ step: 'done' }));
    expect(footer.primary).toEqual({ label: 'Done', disabled: false });
    expect(footer.cancel.label).toBe('Close');
    expect(footer.back).toEqual({ label: '← Back', disabled: false });
  });

  it('never offers a disabled dismiss verb — closing is always allowed', () => {
    const steps: ImportWizardStep[] = ['source', 'file-upload', 'analysis', 'preview', 'import', 'done'];
    for (const step of steps) {
      expect(importFooterFor(footerState({ step })).cancel.disabled).toBe(false);
    }
  });
});

describe('the URL intake’s extra Test button', () => {
  it('is offered once there is a URL to test', () => {
    expect(urlTestAction({ canTestUrl: true, isTesting: false, urlTestedSuccessfully: false })).toEqual(
      { label: 'Test URL', disabled: false, tested: false }
    );
  });

  it('is refused while there is nothing to test, or while testing', () => {
    expect(
      urlTestAction({ canTestUrl: false, isTesting: false, urlTestedSuccessfully: false }).disabled
    ).toBe(true);
    expect(
      urlTestAction({ canTestUrl: true, isTesting: true, urlTestedSuccessfully: false })
    ).toEqual({ label: 'Testing...', disabled: true, tested: false });
  });

  it('reports a successful test in its own label', () => {
    expect(
      urlTestAction({ canTestUrl: true, isTesting: false, urlTestedSuccessfully: true })
    ).toEqual({ label: 'URL tested ✓', disabled: false, tested: true });
  });
});

/* -------------------------------------------------------------------------
   The eight job states — the ticket's "All eight job states render"
   ------------------------------------------------------------------------- */

describe('the eight job states', () => {
  it('are all eight, in the order they are reached', () => {
    expect(IMPORT_JOB_STATES).toEqual([
      'queued',
      'running',
      'pending-approval',
      'committing',
      'completed',
      'failed',
      'canceled',
      'rolled-back',
    ]);
  });

  it.each(IMPORT_JOB_STATES)('%s reads as something', (state) => {
    const presentation = importJobPresentation(state);
    expect(presentation.label).not.toBe('');
    // DESIGN.md §8: an error says what happened *and* what to do. So does every other state.
    expect(presentation.note.length).toBeGreaterThan(20);
    expect(presentation.note.endsWith('.')).toBe(true);
  });

  it('resolves every status string through the shared health/jobs vocabulary', () => {
    // A running import is the same amber as a running discovery and a degraded server.
    const allowed = new Set(['pending', 'running', 'completed', 'failed', 'unknown']);
    for (const state of IMPORT_JOB_STATES) {
      expect(allowed).toContain(importJobPresentation(state).status);
    }
  });

  it('calls exactly the five terminal states terminal', () => {
    const terminal = IMPORT_JOB_STATES.filter((state) => importJobPresentation(state).terminal);
    expect(terminal).toEqual(['pending-approval', 'completed', 'failed', 'canceled', 'rolled-back']);
  });

  it('calls exactly the three failures failures', () => {
    const failures = IMPORT_JOB_STATES.filter((state) => importJobPresentation(state).failure);
    expect(failures).toEqual(['failed', 'canceled', 'rolled-back']);
  });

  it('stripes the bar only while the job is still moving', () => {
    const active = IMPORT_JOB_STATES.filter((state) => importJobPresentation(state).active);
    expect(active).toEqual(['queued', 'running', 'committing']);
    for (const state of IMPORT_JOB_STATES) {
      const presentation = importJobPresentation(state);
      expect(presentation.active && presentation.terminal).toBe(false);
    }
  });

  it('never paints a moving job as good or bad news', () => {
    expect(importJobPresentation('queued').progressTone).toBe('accent');
    expect(importJobPresentation('running').progressTone).toBe('accent');
    expect(importJobPresentation('completed').progressTone).toBe('ok');
    expect(importJobPresentation('failed').progressTone).toBe('danger');
  });

  it('reads an unknown state as queued rather than throwing', () => {
    // A newer REST reporting a state this build has never heard of shows a wizard that waits,
    // not a wizard that crashes.
    expect(importJobPresentation('teleported').label).toBe('Queued');
  });
});

/* -------------------------------------------------------------------------
   The quality gate
   ------------------------------------------------------------------------- */

describe('the Analyze step’s quality gate', () => {
  it('says nothing before an analysis has run', () => {
    expect(importQualityGate(null)).toBeNull();
  });

  it('refuses an unsupported format, and names it', () => {
    const gate = importQualityGate({
      isValid: true,
      formatSupported: false,
      formatDisplayName: 'WSDL 1.1',
      qualityScore: { overall: 90, grade: 'A' },
    });
    expect(gate).toMatchObject({ tone: 'danger', canContinue: false });
    expect(gate?.body).toContain('WSDL 1.1');
    expect(gate?.body).toContain('OpenAPI 3.x');
  });

  it('refuses an invalid document, and counts what blocks it', () => {
    const gate = importQualityGate({
      isValid: false,
      formatSupported: true,
      errors: [{}, {}, {}],
      qualityScore: { overall: 40, grade: 'F' },
    });
    expect(gate).toMatchObject({ tone: 'danger', canContinue: false });
    expect(gate?.title).toBe('3 errors block this import');
  });

  it('says “1 error” rather than “1 errors”', () => {
    const gate = importQualityGate({ isValid: false, formatSupported: true, errors: [{}] });
    expect(gate?.title).toBe('1 error blocks this import');
  });

  it('warns about a D or an F without blocking it', () => {
    const gate = importQualityGate({
      isValid: true,
      formatSupported: true,
      warnings: [{}, {}],
      qualityScore: { overall: 44, grade: 'D' },
    });
    expect(gate).toMatchObject({ tone: 'warn', canContinue: true });
    expect(gate?.title).toBe('Quality grade D');
    expect(gate?.body).toContain('44/100');
    expect(gate?.body).toContain('2 warnings');
  });

  it('passes an A, a B and a C', () => {
    for (const grade of ['A', 'B', 'C']) {
      const gate = importQualityGate({
        isValid: true,
        formatSupported: true,
        qualityScore: { overall: 80, grade },
      });
      expect(gate).toMatchObject({ tone: 'ok', canContinue: true });
      expect(gate?.body).toContain(`grade ${grade}`);
    }
  });

  it('checks the format before the errors, because a format nobody parses has both', () => {
    const gate = importQualityGate({
      isValid: false,
      formatSupported: false,
      formatDisplayName: 'WSDL 1.1',
      errors: [{}],
    });
    expect(gate?.title).toBe('Format not available for import');
  });
});

/* -------------------------------------------------------------------------
   File intake
   ------------------------------------------------------------------------- */

describe('the accepted file extensions', () => {
  it('are the ten the drop zone’s hint lists, in that order', () => {
    expect(IMPORT_FILE_EXTENSIONS).toEqual([
      '.yaml',
      '.yml',
      '.json',
      '.zip',
      '.graphql',
      '.gql',
      '.raml',
      '.proto',
      '.avsc',
      '.thrift',
    ]);
    for (const extension of IMPORT_FILE_EXTENSIONS) {
      expect(IMPORT_WIZARD_COPY.dropExtensions).toContain(extension);
    }
  });

  it('accepts a matching extension whatever its case', () => {
    expect(isAcceptedImportFile('payments-api-v2.4.yaml')).toBe(true);
    expect(isAcceptedImportFile('PAYMENTS.YAML')).toBe(true);
    expect(isAcceptedImportFile('bundle.ZIP')).toBe(true);
  });

  it('refuses anything else, and anything with no extension at all', () => {
    expect(isAcceptedImportFile('notes.txt')).toBe(false);
    expect(isAcceptedImportFile('Makefile')).toBe(false);
    expect(isAcceptedImportFile('')).toBe(false);
  });

  it('reads only the last dot, so a versioned filename is not misread', () => {
    expect(isAcceptedImportFile('spec.v2.json')).toBe(true);
    expect(isAcceptedImportFile('spec.json.bak')).toBe(false);
  });
});
