/**
 * The import wizard's rules, with no React in them (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` — its stepper, its intake tab bar, its
 * footer verbs and its eight job states — and `docs/mockups/DESIGN.md` §3.1 for the status
 * vocabulary the badges resolve through.
 *
 * The wizard is the app's most-used multi-step flow, and before this ticket every one of those
 * decisions was spelled inline in `ImportDialog.tsx`'s JSX: which verb the primary button
 * carries, whether Back is allowed, which of eight job states is a failure, what the quality
 * gate says. Nine sources chose those independently, which is how the same flow came to look
 * like nine flows.
 *
 * Everything here is a pure function of the wizard's state, so `import-wizard-model.test.ts`
 * can assert the whole decision table without mounting anything, and the dialog can stay a
 * view over it.
 */

import type { ImportSourceCard, ImportPanelId } from '../dashboard/importSourceCatalog';

/* -------------------------------------------------------------------------
   Steps
   ------------------------------------------------------------------------- */

/**
 * The wizard's internal position.
 *
 * Six values for five stepper stops: `source` (the card grid) and `file-upload` (the chosen
 * source's intake) are both *Source*, because picking a card and filling its form is one
 * decision made in two screens. The names are the pre-redesign ones — every caller and every
 * existing test branches on them, and renaming them would have been a migration rather than a
 * restyle.
 */
export type ImportWizardStep =
  | 'source'
  | 'file-upload'
  | 'analysis'
  | 'preview'
  | 'import'
  | 'done';

/** The id of one stop on the visible stepper. */
export type ImportStepperId = 'source' | 'analyze' | 'preview' | 'import' | 'done';

/** The five stops, in order, as `ui/Stepper` wants them. */
export const IMPORT_WIZARD_STEPS: ReadonlyArray<{ id: ImportStepperId; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'preview', label: 'Preview' },
  { id: 'import', label: 'Import' },
  { id: 'done', label: 'Done' },
];

/** Which stop on the visible stepper an internal step sits at. */
const STEPPER_ID: Readonly<Record<ImportWizardStep, ImportStepperId>> = {
  source: 'source',
  'file-upload': 'source',
  analysis: 'analyze',
  preview: 'preview',
  import: 'import',
  done: 'done',
};

/**
 * The stepper stop for an internal step.
 *
 * @param step Where the wizard is.
 * @returns The `id` to hand `Stepper`'s `current`.
 */
export function stepperIdFor(step: ImportWizardStep): ImportStepperId {
  return STEPPER_ID[step];
}

/* -------------------------------------------------------------------------
   Intake tabs
   ------------------------------------------------------------------------- */

/**
 * A tab on the intake bar.
 *
 * `panel` is the `selectedSource` the dialog branches on; `null` marks a source that is listed
 * but cannot be opened yet, which the mockup draws disabled with a "Coming soon" title.
 */
export interface ImportIntakeTab {
  /** Stable id — the source card's key. */
  id: string;
  label: string;
  /** The intake panel this tab opens, or `null` for a discovery-only adapter. */
  panel: ImportPanelId | 'llm' | null;
}

/**
 * The two tabs that are not source cards.
 *
 * *Design with AI* is a source in the wizard's sense — it produces a spec that then walks the
 * same Analyze → Preview → Import path — but it is not in `/api/import/sources`, because
 * nothing is fetched from anywhere. It is appended so it reads as a peer of the other intakes
 * rather than as a separate product, which is what the mockup's tab bar shows.
 */
const EXTRA_TABS: ReadonlyArray<ImportIntakeTab> = [
  { id: 'llm', label: 'Design with AI', panel: 'llm' },
];

/**
 * The intake tab bar for a set of source cards.
 *
 * Derived from the cards rather than hard-coded so a registry-contributed adapter gets a tab
 * for free — the same property that made the source *grid* data-driven in MFI-1.3. A card with
 * no generic intake panel still gets a tab, disabled, because hiding it would make a source the
 * server advertises look like one the app has never heard of.
 *
 * @param cards The merged source cards, already filtered for the importer variant.
 * @returns One tab per card, in card order, then *Design with AI*.
 */
export function intakeTabsForCards(cards: ReadonlyArray<ImportSourceCard>): ImportIntakeTab[] {
  return [
    ...cards.map((card) => ({ id: card.key, label: card.label, panel: card.panel })),
    ...EXTRA_TABS,
  ];
}

/* -------------------------------------------------------------------------
   Footer verbs
   ------------------------------------------------------------------------- */

/** What the wizard needs to know to choose its footer. */
export interface ImportFooterState {
  /** Where the wizard is. */
  step: ImportWizardStep;
  /** The chosen source, or `null` on the card grid. */
  source: string | null;
  /** The job (or MCP scan) has reached a terminal state. */
  importComplete: boolean;
  /** That terminal state was a success. */
  importSucceeded: boolean;
  /** An analysis is in flight. */
  analyzing?: boolean;
  /** The chosen source has produced content that can be analyzed. */
  intakeReady?: boolean;
  /** The analysis says the document can be imported. */
  analysisImportable?: boolean;
  /** At least one schema is selected on Preview. */
  hasSelection?: boolean;
  /** The MCP form validates. */
  mcpReady?: boolean;
  /** An MCP endpoint registration is in flight. */
  mcpSubmitting?: boolean;
}

/** One footer button. */
export interface ImportFooterAction {
  /** The verb. */
  label: string;
  /** Whether it is offered at all. */
  disabled: boolean;
}

/** The footer of one step: what sits left, and what sits right. */
export interface ImportFooter {
  /** The Back button, or `null` on the first step where there is nothing behind. */
  back: ImportFooterAction | null;
  /** The dismiss verb — *Cancel*, *Close* or *Discard*, depending on what closing costs. */
  cancel: ImportFooterAction;
  /** The one forward action, or `null` where the step has none. */
  primary: ImportFooterAction | null;
  /**
   * The MCP escape hatch: keep a server whose scan failed. Only ever set on a failed MCP
   * import, where *Discard* is the default and this is the deliberate opposite.
   */
  keepAnyway: ImportFooterAction | null;
}

/**
 * The intake step's forward verb.
 *
 * URL is the one source with two forward actions — *Test URL* proves the address before
 * *Next →* fetches from it — so its primary reads *Next →* while every other intake reads
 * *Analyze →*. MCP has no analyze or preview step at all: its forward verb starts a scan.
 */
function intakePrimary(state: ImportFooterState): ImportFooterAction | null {
  const { source, analyzing = false, intakeReady = false } = state;
  if (source === 'mcp') {
    return {
      label: state.mcpSubmitting ? 'Starting…' : 'Discover →',
      disabled: Boolean(state.mcpSubmitting) || !state.mcpReady,
    };
  }
  if (source === 'url') {
    return { label: analyzing ? 'Analyzing...' : 'Next →', disabled: !intakeReady || analyzing };
  }
  if (source === null) return null;
  return { label: analyzing ? 'Analyzing...' : 'Analyze →', disabled: !intakeReady || analyzing };
}

/**
 * The whole footer for a state.
 *
 * The two rules the ticket's acceptance criteria name are here rather than in the JSX:
 *
 *   - **Back is disabled during import.** A running job owns rows in the database; stepping
 *     back off it would leave them with nothing watching. It re-enables the moment the job
 *     reaches a terminal state.
 *   - **Closing costs something, and the verb says so.** *Cancel* on a step that has written
 *     nothing, *Close* once the job has landed, *Discard* on a failed MCP import where closing
 *     also deletes the endpoint that was created.
 *
 * @param state Where the wizard is and what it holds — see {@link ImportFooterState}.
 * @returns The four slots; `null` for a slot this step does not fill.
 */
export function importFooterFor(state: ImportFooterState): ImportFooter {
  const { step, source, importComplete, importSucceeded } = state;

  if (step === 'source') {
    return {
      back: null,
      cancel: { label: 'Cancel', disabled: false },
      // The cards navigate on click, so the grid's forward button never acts. It stays,
      // disabled, because a footer that loses a button between steps reads as a layout jump.
      primary: { label: 'Next →', disabled: true },
      keepAnyway: null,
    };
  }

  if (step === 'import') {
    const failed = importComplete && !importSucceeded;
    if (failed && source === 'mcp') {
      return {
        back: { label: '← Back', disabled: false },
        cancel: { label: 'Discard', disabled: false },
        primary: null,
        keepAnyway: { label: 'Add this server anyway', disabled: false },
      };
    }
    return {
      back: { label: '← Back', disabled: !importComplete },
      cancel: { label: failed ? 'Cancel' : importComplete ? 'Close' : 'Cancel', disabled: false },
      primary:
        importComplete && importSucceeded ? { label: 'Next →', disabled: false } : null,
      keepAnyway: null,
    };
  }

  if (step === 'done') {
    return {
      back: { label: '← Back', disabled: false },
      cancel: { label: 'Close', disabled: false },
      primary: { label: 'Done', disabled: false },
      keepAnyway: null,
    };
  }

  if (step === 'analysis') {
    return {
      back: { label: '← Back', disabled: false },
      cancel: { label: 'Cancel', disabled: false },
      primary: { label: 'Next →', disabled: !state.analysisImportable },
      keepAnyway: null,
    };
  }

  if (step === 'preview') {
    return {
      back: { label: '← Back', disabled: false },
      cancel: { label: 'Cancel', disabled: false },
      primary: { label: 'Import →', disabled: !state.hasSelection },
      keepAnyway: null,
    };
  }

  return {
    back: { label: '← Back', disabled: false },
    cancel: { label: 'Cancel', disabled: false },
    primary: intakePrimary(state),
    keepAnyway: null,
  };
}

/**
 * Whether the URL intake offers its extra *Test URL* button, and what it says.
 *
 * Kept beside the footer rather than in `UrlImportPanel` because it is a *footer* control that
 * happens to drive a panel — the panel exposes the handle, the footer presses it.
 *
 * @param footer The panel's reported state.
 * @returns The button, or `null` when this is not the URL intake.
 */
export function urlTestAction(footer: {
  canTestUrl: boolean;
  isTesting: boolean;
  urlTestedSuccessfully: boolean;
}): ImportFooterAction & { tested: boolean } {
  return {
    label: footer.isTesting ? 'Testing...' : footer.urlTestedSuccessfully ? 'URL tested ✓' : 'Test URL',
    disabled: !footer.canTestUrl || footer.isTesting,
    tested: footer.urlTestedSuccessfully,
  };
}

/* -------------------------------------------------------------------------
   The eight job states
   ------------------------------------------------------------------------- */

/** The async job's state, as the import-actions store reports it. */
export type ImportJobState =
  | 'queued'
  | 'running'
  | 'pending-approval'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rolled-back';

/** All eight, in the order they are reached. */
export const IMPORT_JOB_STATES: ReadonlyArray<ImportJobState> = [
  'queued',
  'running',
  'pending-approval',
  'committing',
  'completed',
  'failed',
  'canceled',
  'rolled-back',
];

/** How one job state reads. */
export interface ImportJobPresentation {
  /** The badge's `data-status`, resolved through the shared status vocabulary. */
  status: string;
  /** The badge's words. */
  label: string;
  /** Whether the job is still moving — drives the striped progress bar. */
  active: boolean;
  /** Whether the job has stopped for good. */
  terminal: boolean;
  /** Whether stopping was a failure the reader has to act on. */
  failure: boolean;
  /**
   * The progress bar's hue — one of `ui/metrics`' tones.
   *
   * Not the same thing as the badge's `status`: the badge says *what state this is*, the bar
   * says *how this is going*, and a job that is merely queued is neither good nor bad news.
   */
  progressTone: 'accent' | 'ok' | 'warn' | 'danger' | 'neutral';
  /** One sentence saying what happened and what to do next (DESIGN.md §8). */
  note: string;
}

/**
 * The eight states, spelled once.
 *
 * The `status` strings are the shared vocabulary's (DESIGN.md §3.1 *Health / jobs*), so a
 * running import is the same amber as a running discovery and a degraded server. The three
 * that have no vocabulary entry of their own — `pending-approval`, `committing`, `rolled-back`
 * — borrow the nearest one rather than inventing a colour: an approval is `pending`, a commit
 * is `running`, and a rollback ended in nothing, which is `unknown`.
 */
const JOB_PRESENTATION: Readonly<Record<ImportJobState, ImportJobPresentation>> = {
  queued: {
    status: 'pending',
    label: 'Queued',
    active: true,
    terminal: false,
    failure: false,
    progressTone: 'accent',
    note: 'Waiting for a worker. This usually starts within a few seconds.',
  },
  running: {
    status: 'running',
    label: 'Running',
    active: true,
    terminal: false,
    failure: false,
    progressTone: 'accent',
    note: 'Importing. You can close this dialog — the job keeps running and reports when it lands.',
  },
  'pending-approval': {
    status: 'pending',
    label: 'Pending approval',
    active: false,
    terminal: true,
    failure: false,
    progressTone: 'warn',
    note: 'Everything is staged but nothing is saved yet. Accept to commit, or reject to roll back.',
  },
  committing: {
    status: 'running',
    label: 'Committing',
    active: true,
    terminal: false,
    failure: false,
    progressTone: 'accent',
    note: 'Writing the staged changes. This is the last step and it cannot be cancelled.',
  },
  completed: {
    status: 'completed',
    label: 'Completed',
    active: false,
    terminal: true,
    failure: false,
    progressTone: 'ok',
    note: 'The import landed. Continue to the summary for the lint report and next actions.',
  },
  failed: {
    status: 'failed',
    label: 'Failed',
    active: false,
    terminal: true,
    failure: true,
    progressTone: 'danger',
    note: 'The import stopped and nothing was saved. Read the failures below, then retry or change the specification.',
  },
  canceled: {
    status: 'unknown',
    label: 'Canceled',
    active: false,
    terminal: true,
    failure: true,
    progressTone: 'neutral',
    note: 'You stopped this import. Nothing was saved — retry when you are ready.',
  },
  'rolled-back': {
    status: 'unknown',
    label: 'Rolled back',
    active: false,
    terminal: true,
    failure: true,
    progressTone: 'neutral',
    note: 'The staged changes were undone, so the workspace is exactly as it was before.',
  },
};

/**
 * How a job state reads — badge, tone and the sentence under it.
 *
 * An unknown state (a newer REST reporting something this build has never heard of) reads as
 * `queued` rather than throwing, so a version skew shows a wizard that waits instead of a
 * wizard that crashes.
 *
 * @param state The state string from the job store.
 * @returns Its presentation — see {@link ImportJobPresentation}.
 */
export function importJobPresentation(state: string): ImportJobPresentation {
  return JOB_PRESENTATION[state as ImportJobState] ?? JOB_PRESENTATION.queued;
}

/* -------------------------------------------------------------------------
   The quality gate
   ------------------------------------------------------------------------- */

/** The banner the Analyze step leads with. */
export interface ImportQualityGate {
  /** The `Alert` tone. */
  tone: 'ok' | 'warn' | 'danger';
  /** The bolded first clause. */
  title: string;
  /** The rest of the sentence: what it means, and what to do. */
  body: string;
  /** Whether the reader may continue to Preview. */
  canContinue: boolean;
}

/**
 * The quality-gate banner for an analysis (the mockup's *Adds* on the Analyze step).
 *
 * Three outcomes, in the order they are checked, because the first that applies is the one that
 * matters: the document cannot be imported at all; it can, but it scored badly enough that the
 * reader should look before continuing; or it is fine.
 *
 * The D/F threshold is the same A–F band the catalog grades against, so a grade means one thing
 * across the app.
 *
 * @param analysis The result, or `null` while none has run.
 * @returns The banner, or `null` when there is nothing to say yet.
 */
export function importQualityGate(
  analysis: {
    isValid: boolean;
    formatSupported: boolean;
    formatDisplayName?: string;
    errors?: ReadonlyArray<unknown>;
    warnings?: ReadonlyArray<unknown>;
    qualityScore?: { overall: number; grade: string };
  } | null
): ImportQualityGate | null {
  if (!analysis) return null;

  if (!analysis.formatSupported) {
    return {
      tone: 'danger',
      title: 'Format not available for import',
      body: `The detected format ${analysis.formatDisplayName ?? 'is unknown'} is not yet supported for import. Currently supported formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML, AsyncAPI, GraphQL, Protobuf, Thrift, Avro, and Postman.`,
      canContinue: false,
    };
  }

  if (!analysis.isValid) {
    const count = analysis.errors?.length ?? 0;
    return {
      tone: 'danger',
      title: count === 1 ? '1 error blocks this import' : `${count} errors block this import`,
      body: 'Fix them in the source specification and bring it in again — nothing can be imported while the document is invalid.',
      canContinue: false,
    };
  }

  const grade = analysis.qualityScore?.grade;
  if (grade === 'D' || grade === 'F') {
    const warnings = analysis.warnings?.length ?? 0;
    return {
      tone: 'warn',
      title: `Quality grade ${grade}`,
      body: `This specification imports, but it scored ${analysis.qualityScore?.overall ?? 0}/100${
        warnings > 0 ? ` and raised ${warnings === 1 ? '1 warning' : `${warnings} warnings`}` : ''
      }. Review the categories below before continuing — the score is stored with the project.`,
      canContinue: true,
    };
  }

  return {
    tone: 'ok',
    title: 'Ready to import',
    body: grade
      ? `Analysis passed with grade ${grade}. Continue to pick the schemas to bring in.`
      : 'Analysis passed. Continue to pick the schemas to bring in.',
    canContinue: true,
  };
}

/* -------------------------------------------------------------------------
   Copy
   ------------------------------------------------------------------------- */

/**
 * Sentences the wizard and its tests share.
 *
 * One source, so a panel and the suite that pins it cannot drift — the same reason
 * `versionDialogsModel` carries its own copy block.
 */
export const IMPORT_WIZARD_COPY = {
  title: 'Import specification',
  description:
    'Choose a source → analyze → preview and select schemas → import → done. Imports always create a new project.',
  sourceHeading: 'Choose import source',
  comingSoon: 'Coming soon',
  dropTitle: 'Drop files here',
  dropBrowse: 'Browse files',
  dropExtensions:
    'Supports: .yaml, .yml, .json, .zip, .graphql, .gql, .raml, .proto, .avsc, .thrift',
  zipNote: 'ZIP files will be analyzed after clicking Analyze',
  filePreview: 'File preview',
  analyzingFile: 'Analyzing file...',
  jobsDrawerTitle: 'Recent import jobs',
  jobsDrawerNote: 'Shared async job store — survives round-robin REST replicas.',
  closeWarning: 'Close (rolls back a running job)',
} as const;

/** The file extensions the drop zone accepts, in the order the hint lists them. */
export const IMPORT_FILE_EXTENSIONS: ReadonlyArray<string> = [
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
];

/**
 * Whether a filename carries an extension the drop zone accepts.
 *
 * @param name The file's name.
 * @returns `true` when the extension is on the list, matched case-insensitively.
 */
export function isAcceptedImportFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMPORT_FILE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

/* -------------------------------------------------------------------------
   The Catalog importer (HIVE-7.1, #5318)
   ------------------------------------------------------------------------- */

/**
 * The Catalog runs a *second* importer (MFI-23.12) over the alternative, non-OpenAPI formats.
 *
 * Its rail and its verbs are not the Projects importer's — it detects and routes rather than
 * analysing and previewing, and it has a pre-flight quality gate the Projects one does not —
 * but its *frame* is the same, and HIVE-7.1's acceptance criterion is that it shares the frame
 * rather than carrying a copy. So the two wizards' rules live in one module: the chrome takes
 * whichever rail it is handed, and both footers are the same four slots.
 */
export type CatalogImportStepId = 'source' | 'detect' | 'options' | 'quality' | 'import';

/** The Catalog importer's five stops, in order, as `ui/Stepper` wants them. */
export const CATALOG_IMPORT_STEPS: ReadonlyArray<{ id: CatalogImportStepId; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'detect', label: 'Detect & route' },
  { id: 'options', label: 'Options' },
  { id: 'quality', label: 'Quality' },
  { id: 'import', label: 'Import' },
];

/** Where a detected document is headed. Mirrors `catalog-import-formats`' decision. */
export type CatalogImportDestination =
  | 'catalog'
  | 'project'
  | 'json-schema-choice'
  | 'not-importable';

/**
 * The status tone the routing card takes.
 *
 * A destination is a *state* of this import, not an identity, so it resolves through the
 * shared vocabulary rather than through a hue: accent for "this is where it goes", ok for the
 * publishable route, warn for the one that asks a question, neutral for the dead end. This
 * replaces four hand-written `border-indigo-200 bg-indigo-50 … dark:` quads.
 *
 * @param destination The routing decision.
 * @returns The tone name — a key of `ui/statusVocabulary`'s tone tables.
 */
export function catalogRoutingTone(destination: CatalogImportDestination): string {
  switch (destination) {
    case 'catalog':
      return 'accent';
    case 'project':
      return 'ok';
    case 'json-schema-choice':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** What the Catalog importer needs to know to choose its footer. */
export interface CatalogImportFooterState {
  /** Which stop it is on. */
  step: CatalogImportStepId;
  /** A commit is in flight. */
  storing: boolean;
  /** The commit landed. */
  done: boolean;
  /** Detection produced something importable. */
  canContinueFromDetect: boolean;
  /** The chosen format's adapter cannot run in this deployment. */
  adapterUnavailable: boolean;
  /** Where the document is headed. */
  destination: CatalogImportDestination;
  /** Everything the catalog commit needs is present. */
  canStoreCatalog: boolean;
}

/**
 * The Catalog importer's footer for a state.
 *
 * Three rules, and each one is a thing the JSX used to decide in a different place:
 *
 *   - **Continue is refused, not hidden.** A document that routes to Projects, or one whose
 *     adapter is missing in this runtime, leaves the button drawn and disabled — a footer that
 *     loses its forward verb between steps reads as a layout jump, and the routing card above
 *     is what says *why*.
 *   - **Cancel says what closing costs.** *Cancel* while nothing has been written, *Close*
 *     once the item is in the catalog.
 *   - **Back exists everywhere except the first and last stops**, and is refused while a
 *     commit is in flight for the same reason the Projects importer refuses it: a running
 *     write owns rows that nothing would be watching.
 *
 * The `quality` step is deliberately absent: it owns its own footer, because all three of its
 * exits — Cancel, Import anyway, Import — belong on one row with the gate that governs them
 * (IXH-2.2).
 *
 * @param state Where the wizard is and what it holds — see {@link CatalogImportFooterState}.
 * @returns The four slots; `null` for a slot this step does not fill.
 */
export function catalogImportFooterFor(state: CatalogImportFooterState): ImportFooter {
  const { step, storing, done, destination } = state;
  const cancel: ImportFooterAction = {
    label: done ? 'Close' : 'Cancel',
    disabled: storing,
  };

  if (step === 'source') {
    return {
      back: null,
      cancel,
      // The tiles navigate on click, so the grid's forward button never acts.
      primary: { label: 'Continue', disabled: true },
      keepAnyway: null,
    };
  }

  if (step === 'detect') {
    return {
      back: { label: '← Back', disabled: false },
      cancel,
      primary: {
        label: 'Continue',
        disabled: !state.canContinueFromDetect || state.adapterUnavailable,
      },
      keepAnyway: null,
    };
  }

  if (step === 'options') {
    const asks = destination === 'catalog' || destination === 'json-schema-choice';
    return {
      back: { label: '← Back', disabled: false },
      cancel,
      primary: asks
        ? {
            label: 'Continue',
            disabled: destination === 'catalog' && (!state.canStoreCatalog || storing),
          }
        : { label: 'Continue', disabled: true },
      keepAnyway: null,
    };
  }

  // `import`: the commit is running or has landed. There is nowhere back to.
  return {
    back: null,
    cancel,
    primary: done ? { label: 'Done', disabled: false } : null,
    keepAnyway: null,
  };
}
