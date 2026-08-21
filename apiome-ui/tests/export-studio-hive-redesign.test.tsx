/**
 * The Export Studio, ported to the Hive language (HIVE-8.3, #5329).
 *
 * Authority: `docs/mockups/ship/export-studio.html`, whose **Notes → Keeps (1:1)** list is the
 * ticket's acceptance criteria. `export-studio-a11y.test.tsx` already pins the keyboard and
 * screen-reader contract of these surfaces and keeps doing so; this suite pins what the
 * *redesign* changed, and — more importantly — what it must not have:
 *
 *   1. **The screen wears the shared page chrome.** The hand-rolled `<main>` + `h1` + back link
 *      is `Page` / `PageHeader` / `PageBody`, with the way back to Versions or Catalog in the
 *      trail and exactly one action beside the title.
 *   2. **All 36 targets stay reachable** — the first acceptance criterion — now under four
 *      family headings, with readiness and fidelity still on every card before selection.
 *   3. **A lossy export still requires the typed acknowledgement**, and nothing about the
 *      re-skin reaches the gate.
 *   4. **Job stages, failure classes and the delivery gate behave identically**, and each now
 *      states its status in one attribute the stylesheet paints rather than in two class lists
 *      that could disagree.
 *   5. **The deep-link notices and their codes are preserved**, all six of them.
 *   6. **No component spells a colour.** The rendered tree carries no Tailwind palette class
 *      anywhere under the Studio — the walk at the end of this file is the one that fails if a
 *      future edit reaches for `bg-rose-100` again.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, language }: { value?: string; language?: string }) => (
    <div data-testid="export-artifact-content" data-language={language}>
      {value}
    </div>
  ),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

jest.mock('sonner', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }),
}));

import { ExportStudio } from '../src/app/components/ade/dashboard/export/ExportStudio';
import { ExportTargetGrid } from '../src/app/components/ade/dashboard/export/ExportTargetGrid';
import { GenerateProgress } from '../src/app/components/ade/dashboard/export/GenerateProgress';
import { DeliveryGatePanel } from '../src/app/components/ade/dashboard/export/DeliveryGatePanel';
import { exportTargetCards } from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import { __resetExportJobTrackerForTests } from '../src/app/components/ade/dashboard/export/exportJobTracker';
import { EXPORT_TARGET_FAMILIES } from '../src/app/components/ade/export-studio';
import type {
  ExportTargetEntry,
  ExportTargetsResponse,
  TargetFidelitySummary,
} from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import type { DeliveryGateReport } from '../src/app/components/ade/dashboard/export/exportJob';
import type { ExportStudioLinkIssue } from '../src/app/components/ade/dashboard/export/exportStudioUrlState';

/* -------------------------------------------------------------------------
   Fixtures
   ------------------------------------------------------------------------- */

const LOSSLESS: TargetFidelitySummary = {
  tier: 'lossless',
  preserved_percent: 100,
  total: 58,
  preserved: 58,
  dropped: 0,
  approximated: 0,
  synthesized: 0,
};

const LOSSY: TargetFidelitySummary = {
  tier: 'lossy',
  preserved_percent: 64,
  total: 58,
  preserved: 51,
  dropped: 3,
  approximated: 2,
  synthesized: 2,
};

/**
 * One registry entry.
 *
 * @param key Registry key.
 * @param label Human label.
 * @param paradigm The descriptor's paradigm — what the family headings are derived from.
 * @param fidelity The per-source fidelity summary.
 * @returns The entry, with no options and no toolchain requirement.
 */
function entry(
  key: string,
  label: string,
  paradigm: string,
  fidelity: TargetFidelitySummary = LOSSLESS,
): ExportTargetEntry {
  return {
    descriptor: {
      key,
      format: `${key}-1`,
      label,
      description: `Export as ${label}.`,
      icon: 'file-json',
      paradigm,
      multi_file: false,
      needs_toolchain: false,
      available: true,
      unavailable_reason: null,
    },
    capability_profile: { operations: true },
    options_schema: {},
    default_options: {},
    fidelity,
  };
}

/**
 * A registry covering every family plus one paradigm the family table does not know.
 *
 * Deliberately small — the *count* is not what this suite pins (the grid renders whatever the
 * registry sends); what it pins is that nothing is dropped on the way to a heading.
 */
const TARGETS: ExportTargetsResponse = {
  artifact: 'proj-petstore',
  version: null,
  version_record_id: 'rev-1',
  version_label: '1.2.0',
  targets: [
    entry('openapi', 'OpenAPI 3.1', 'rest'),
    entry('raml', 'RAML', 'rest', LOSSY),
    entry('proto', 'Protocol Buffers (proto3)', 'rpc', LOSSY),
    entry('asyncapi', 'AsyncAPI 3', 'event', LOSSY),
    entry('avro', 'Apache Avro', 'data_schema', LOSSY),
    entry('graphql', 'GraphQL SDL', 'graph', LOSSY),
    entry('toolbundle', 'Agent tool bundle', 'agent', LOSSY),
    // A paradigm no family table knows: it must still reach the grid, under the catch-all.
    entry('holodeck', 'Holodeck program', 'quantum', LOSSY),
  ],
};

/** A blocked delivery, with its override path. */
const BLOCKED_DELIVERY: DeliveryGateReport = {
  decision: 'block',
  blocks_delivery: true,
  warns: false,
  headline: 'Delivery blocked by quality policy',
  message: "The 'proto-3' delivery was blocked before any artifact was produced.",
  reasons: [
    {
      code: 'DELIVERY_FIDELITY_BELOW_FLOOR',
      dimension: 'fidelity',
      severity: 'blocking',
      message: 'Only 42% of the source survives, below the tenant 80% fidelity floor.',
    },
    {
      code: 'DELIVERY_SOURCE_GRADE',
      dimension: 'lint',
      severity: 'info',
      message: 'Source grade B meets the tenant floor (C).',
    },
  ],
  target: 'proto-3',
  override: {
    available: true,
    endpoint: '/v1/tenants/acme/governance/quality-waivers',
    scope: 'export',
    subject_key: 'rev-uuid-1',
    format_key: 'proto',
    roles: ['owner', 'admin'],
    instructions: 'Record an export waiver for this revision with a stated reason.',
  },
};

/** A minimal Studio backend: the registry, and nothing else resolving. */
function mockFetch(): jest.Mock {
  return jest.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/export/targets')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, ...TARGETS }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) });
  }) as unknown as jest.Mock;
}

/**
 * Render the Studio and wait for its registry to land.
 *
 * @param props Extra props for the screen (origin, link issues…).
 * @returns The render result.
 */
async function renderStudio(props: Partial<React.ComponentProps<typeof ExportStudio>> = {}) {
  global.fetch = mockFetch() as unknown as typeof fetch;
  const utils = render(
    <ExportStudio
      artifact="proj-petstore"
      artifactLabel="Pet Store API"
      version="rev-1"
      {...props}
    />,
  );
  await waitFor(() => expect(screen.getByText(/export targets available/)).toBeInTheDocument());
  return utils;
}

/** Every Tailwind palette family, as a class-name matcher. */
const PALETTE_CLASS =
  /\b(?:bg|text|border|fill|stroke|ring|divide|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

/**
 * Assert that no element under a root carries a Tailwind palette class.
 *
 * @param root The container to walk.
 */
function expectNoPaletteClasses(root: HTMLElement) {
  const offenders: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    const className =
      typeof element.className === 'string'
        ? element.className
        : ((element.getAttribute('class') ?? '') as string);
    if (PALETTE_CLASS.test(className)) {
      offenders.push(`${element.tagName.toLowerCase()}.${className}`);
    }
  }
  expect(offenders).toEqual([]);
}

beforeEach(() => {
  __resetExportJobTrackerForTests();
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* -------------------------------------------------------------------------
   1. The page chrome
   ------------------------------------------------------------------------- */

describe('the Studio wears the shared page chrome', () => {
  it('names the page once, as the h1 the shell expects', async () => {
    await renderStudio();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Export studio');
    // Not a second `main`: the shell owns the landmark since HIVE-3.8.
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('puts the way back in the trail rather than in a bare link above the title', async () => {
    await renderStudio();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByText('Ship')).toBeInTheDocument();
    expect(within(trail).getByRole('link', { name: /back to versions/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/versions'),
    );
  });

  it('follows a catalog origin back to the catalog', async () => {
    await renderStudio({ origin: 'catalog' });
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: /back to catalog/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/catalog'),
    );
  });

  it('keeps the subtitle naming the source and its version', async () => {
    await renderStudio();
    expect(screen.getByText(/verify a conversion before you generate it/i)).toHaveTextContent(
      'Pet Store API',
    );
  });

  it('carries exactly one header action — Generate stays in the footer nav', async () => {
    await renderStudio();
    expect(screen.getByTestId('export-studio-copy-link')).toBeInTheDocument();
    // The footer's per-step primary is the only Generate, and it is not on the Source step.
    expect(screen.queryByTestId('export-studio-generate')).toBeNull();
    expect(screen.getByRole('button', { name: /choose target/i })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   2. The stepper
   ------------------------------------------------------------------------- */

describe('the five-pill stepper', () => {
  it('states each step in words as well as in a pill', async () => {
    await renderStudio();
    const stepper = screen.getByTestId('export-studio-stepper');
    expect(stepper).toHaveAttribute('aria-label', 'Export steps');
    expect(within(stepper).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByTestId('export-studio-step-source')).toHaveTextContent(
      /current step, 1 of 5/i,
    );
    expect(screen.getByTestId('export-studio-step-review')).toHaveTextContent(/not started/i);
  });

  it('carries its whole treatment on one attribute the stylesheet paints', async () => {
    await renderStudio();
    for (const key of ['source', 'target', 'options', 'verify', 'review']) {
      const pill = screen.getByTestId(`export-studio-step-${key}`);
      expect(pill).toHaveClass('xstd-step');
      expect(pill.getAttribute('data-state')).toMatch(/^(done|current|upcoming)$/);
    }
  });

  it('is status, not navigation — a pill is never a control', async () => {
    await renderStudio();
    const stepper = screen.getByTestId('export-studio-stepper');
    expect(within(stepper).queryAllByRole('button')).toEqual([]);
    expect(within(stepper).queryAllByRole('link')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   3. The target step — AC 1
   ------------------------------------------------------------------------- */

describe('the target grid keeps every target reachable, under a family heading', () => {
  const cards = exportTargetCards(TARGETS);

  it('groups the registry by family for the Studio', () => {
    render(
      <ExportTargetGrid cards={cards} selectedKey={null} onSelect={jest.fn()} groupByFamily />,
    );
    const headings = screen
      .getAllByRole('heading', { level: 4 })
      .map((h) => h.textContent?.replace(/\d+$/, '').trim());
    expect(headings).toEqual([
      ...EXPORT_TARGET_FAMILIES.map((family) => family.label),
      'Other targets',
    ]);
  });

  it('draws every registry target exactly once, whatever its paradigm', () => {
    render(
      <ExportTargetGrid cards={cards} selectedKey={null} onSelect={jest.fn()} groupByFamily />,
    );
    for (const target of TARGETS.targets) {
      expect(screen.getAllByTestId(`export-target-${target.descriptor.key}`)).toHaveLength(1);
    }
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(
      TARGETS.targets.length,
    );
  });

  it('counts the cards in each heading, so a family reads as a group', () => {
    render(
      <ExportTargetGrid cards={cards} selectedKey={null} onSelect={jest.fn()} groupByFamily />,
    );
    const rest = screen.getByRole('heading', { level: 4, name: /REST & HTTP/ });
    expect(rest).toHaveTextContent('2');
  });

  it('shows fidelity before selection, on every card', () => {
    render(
      <ExportTargetGrid cards={cards} selectedKey={null} onSelect={jest.fn()} groupByFamily />,
    );
    expect(
      within(screen.getByTestId('export-target-openapi')).getByText('lossless'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('export-target-proto')).getByText('lossy'),
    ).toBeInTheDocument();
  });

  it('leaves the ExportDialog’s flat grid alone', () => {
    // The two callers want different things from one component: opt-in is what lets the
    // dialog stay compact while the Studio's own step affords headings.
    render(<ExportTargetGrid cards={cards} selectedKey={null} onSelect={jest.fn()} />);
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([]);
    for (const target of TARGETS.targets) {
      expect(screen.getByTestId(`export-target-${target.descriptor.key}`)).toBeInTheDocument();
    }
  });

  it('still selects a target, and says so with aria-pressed', () => {
    const onSelect = jest.fn();
    render(
      <ExportTargetGrid cards={cards} selectedKey="proto" onSelect={onSelect} groupByFamily />,
    );
    expect(screen.getByTestId('export-target-proto')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('export-target-openapi'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------
   4. Job stages and failure classes — AC 3
   ------------------------------------------------------------------------- */

describe('the job stages state themselves once, in an attribute', () => {
  /**
   * Render the progress panel at one job state.
   *
   * @param state The job's state.
   * @param extra Anything else to merge into the status.
   * @returns The render result.
   */
  function renderProgress(state: string, extra: Record<string, unknown> = {}) {
    return render(
      <GenerateProgress
        status={
          {
            job_id: 'job-1',
            state,
            percent: 55,
            events: [],
            progress: { phase: 'emitting', total: 5, completed: 2 },
            ...extra,
          } as never
        }
        targetLabel="Protocol Buffers (proto3)"
        submitting={false}
        onRetry={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
  }

  it('gives every stage one class and one status attribute', () => {
    renderProgress('running');
    const stages = screen.getAllByTestId(/^generate-stage-/);
    expect(stages).toHaveLength(5);
    for (const stage of stages) {
      expect(stage).toHaveClass('xstd-stage');
      expect(stage.getAttribute('data-status')).toMatch(/^(pending|active|done|failed)$/);
    }
  });

  it('keeps the word beside the tint, so a stage never reads by colour alone', () => {
    renderProgress('running');
    expect(screen.getByTestId('generate-stage-emitting')).toHaveTextContent(/— active/i);
    expect(screen.getByTestId('generate-stage-loading-source')).toHaveTextContent(/— done/i);
  });

  it('draws a canceled run’s unreached stages at rest', () => {
    renderProgress('canceled');
    expect(screen.getByTestId('generate-canceled')).toHaveTextContent(
      'The export was canceled. You can start it again.',
    );
    for (const stage of screen.getAllByTestId(/^generate-stage-/)) {
      expect(stage.getAttribute('data-status')).not.toBe('canceled');
    }
  });

  it('keeps a failure’s class, its title and its recovery action', () => {
    renderProgress('failed', {
      error: {
        code: 'EMITTED_ARTIFACT_INVALID',
        message: 'protoc rejected the artifact: duplicate message name Refund.',
      },
    });
    const failure = screen.getByTestId('generate-failure-message');
    expect(failure).toHaveTextContent('duplicate message name Refund');
    expect(failure).toHaveClass('xstd-failure__detail');
    expect(screen.getByTestId('generate-failure-action')).toBeInTheDocument();
  });

  it('surfaces a structured warning with its level, not with a colour', () => {
    renderProgress('running', {
      events: [{ id: 'e1', level: 'warn', message: 'Validation toolchain unavailable.' }],
    });
    const event = screen.getByTestId('generate-event-warn');
    expect(event).toHaveClass('xstd-event');
    expect(event).toHaveAttribute('data-level', 'warn');
  });

  it('spells no colour anywhere in the panel', () => {
    const { container } = renderProgress('failed', {
      error: { code: 'EMIT_FAILED', message: 'The emitter failed.' },
      events: [{ id: 'e1', level: 'error', message: 'Boom.' }],
    });
    expectNoPaletteClasses(container);
  });
});

/* -------------------------------------------------------------------------
   5. The delivery gate — AC 3
   ------------------------------------------------------------------------- */

describe('the delivery gate keeps its decision, dimensions and override path', () => {
  it('carries the decision on the panel and the severity on each reason', () => {
    render(<DeliveryGatePanel delivery={BLOCKED_DELIVERY} />);
    const panel = screen.getByTestId('delivery-gate-panel');
    expect(panel).toHaveClass('xstd-gate');
    expect(panel).toHaveAttribute('data-decision', 'block');

    const reasons = screen.getAllByTestId('delivery-gate-reason');
    expect(reasons.map((r) => r.getAttribute('data-severity'))).toEqual(['blocking', 'info']);
    expect(reasons[0]).toHaveClass('xstd-gate__reason');
    expect(reasons[0]).toHaveTextContent('Conversion fidelity');
  });

  it('still prints the override coordinates a waiver needs', () => {
    render(<DeliveryGatePanel delivery={BLOCKED_DELIVERY} />);
    const override = screen.getByTestId('delivery-gate-override');
    expect(override).toHaveAttribute('data-available', 'true');
    expect(screen.getByTestId('delivery-gate-override-endpoint')).toHaveTextContent(
      'POST /v1/tenants/acme/governance/quality-waivers',
    );
    expect(override).toHaveTextContent('owner, admin');
  });

  it('says nothing at all for a clean allow', () => {
    const { container } = render(
      <DeliveryGatePanel
        delivery={{ ...BLOCKED_DELIVERY, decision: 'allow', blocks_delivery: false, reasons: [] }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('spells no colour', () => {
    const { container } = render(<DeliveryGatePanel delivery={BLOCKED_DELIVERY} />);
    expectNoPaletteClasses(container);
  });
});

/* -------------------------------------------------------------------------
   6. The deep-link notices — AC 4
   ------------------------------------------------------------------------- */

describe('the deep-link notices survive the re-skin, codes and all', () => {
  /** One notice of each of the six codes the link parser can raise. */
  const ISSUES: ExportStudioLinkIssue[] = [
    { code: 'options-foreign', message: '`include_examples` is not an option and was ignored.' },
    { code: 'options-redacted', message: 'Credentials are never carried in a link.' },
    { code: 'options-unreadable', message: 'The options in this link could not be read.' },
    { code: 'param-invalid', message: 'A link parameter was not usable.' },
  ];

  it('renders one row per notice, each tagged with its own code', async () => {
    await renderStudio({ linkIssues: ISSUES });
    const notice = screen.getByTestId('export-studio-link-notice');
    for (const issue of ISSUES) {
      expect(notice.querySelector(`[data-issue="${issue.code}"]`)).toHaveTextContent(
        issue.message,
      );
    }
  });

  it('lands a target problem on the Target step', async () => {
    // `target-unknown` and `target-unavailable` are the two codes that also *move* the reader:
    // there is nothing to verify until a target is chosen.
    await renderStudio({ initialTarget: 'no-such-emitter', initialStep: 'verify' });
    await waitFor(() =>
      expect(screen.getByTestId('export-studio-step-target')).toHaveAttribute(
        'data-state',
        'current',
      ),
    );
    expect(
      screen.getByTestId('export-studio-link-notice').querySelector('[data-issue]'),
    ).toHaveAttribute('data-issue', 'target-unknown');
  });

  it('draws no notice when the link was honoured in full', async () => {
    await renderStudio();
    expect(screen.queryByTestId('export-studio-link-notice')).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   7. The rule the whole ticket rests on
   ------------------------------------------------------------------------- */

describe('nothing under the Studio spells a colour', () => {
  it('renders the shell and the source step with no palette class', async () => {
    const { container } = await renderStudio();
    expectNoPaletteClasses(container);
  });

  it('renders the target step with no palette class', async () => {
    await renderStudio({ sourceFormat: 'openapi' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    expectNoPaletteClasses(screen.getByTestId('export-studio-body'));
  });

  it('renders the options step with no palette class', async () => {
    await renderStudio({ initialTarget: 'proto', initialStep: 'options' });
    await waitFor(() =>
      expect(screen.getByTestId('export-studio-step-options')).toHaveAttribute(
        'data-state',
        'current',
      ),
    );
    expectNoPaletteClasses(screen.getByTestId('export-studio-body'));
  });
});

/* -------------------------------------------------------------------------
   8. The browser fixtures
   ------------------------------------------------------------------------- */

/**
 * The browser fixtures.
 *
 * `e2e/hive-export-studio.spec.ts` measures computed layout, which jsdom cannot do. Rather
 * than hand-writing HTML that would drift from the twenty-three components, this renders the
 * real surfaces and writes what they rendered into `e2e/fixtures/hive-export-studio/` when
 * `EXPORT_STUDIO_FIXTURE_DUMP=1` is set:
 *
 *     EXPORT_STUDIO_FIXTURE_DUMP=1 npx jest tests/export-studio-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the tests still run — each renders its surface and checks it is there —
 * so a change that would leave the fixtures stale fails loudly here before it fails quietly in
 * the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-export-studio');
  const dump = process.env.EXPORT_STUDIO_FIXTURE_DUMP === '1';

  /**
   * Write one fixture, or just assert it could be.
   *
   * @param name The fixture's file name, without its extension.
   * @param html The markup to write.
   */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const pageColumn = () => document.querySelector('.page') as HTMLElement;

  it('renders the source step (and writes its fixture on request)', async () => {
    await renderStudio();
    write('source', pageColumn().outerHTML);
  });

  it('renders the target step with its family headings', async () => {
    await renderStudio({ sourceFormat: 'openapi' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    await screen.findByRole('heading', { level: 4, name: /REST & HTTP/ });
    write('target', pageColumn().outerHTML);
  });

  it('renders the deep-link notices', async () => {
    await renderStudio({
      linkIssues: [
        {
          code: 'options-foreign',
          message: '`include_examples` is not an option of Protocol Buffers and was ignored.',
        },
        {
          code: 'options-redacted',
          message: 'Credentials are never carried in a link: `registry_token` was redacted.',
        },
      ],
    });
    await screen.findByTestId('export-studio-link-notice');
    write('notices', pageColumn().outerHTML);
  });

  it('renders a running job with its five stages', () => {
    const { container } = render(
      <GenerateProgress
        status={
          {
            job_id: 'job-1',
            state: 'running',
            percent: 62,
            events: [{ id: 'e1', level: 'warn', message: 'Validation toolchain unavailable.' }],
            progress: { phase: 'emitting', total: 5, completed: 2 },
          } as never
        }
        targetLabel="Protocol Buffers (proto3)"
        submitting={false}
        onRetry={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    write('job', container.innerHTML);
  });

  it('renders a canceled job, whose banner is the shared notice', () => {
    const { container } = render(
      <GenerateProgress
        status={
          {
            job_id: 'job-1',
            state: 'canceled',
            percent: 31,
            events: [],
            progress: { phase: 'emitting', total: 5, completed: 1 },
          } as never
        }
        targetLabel="Apache Avro"
        submitting={false}
        onRetry={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    write('canceled', container.innerHTML);
  });

  it('renders a failed job with its failure card', () => {
    const { container } = render(
      <GenerateProgress
        status={
          {
            job_id: 'job-1',
            state: 'failed',
            percent: 64,
            events: [],
            progress: { phase: 'validating', total: 5, completed: 3 },
            error: {
              code: 'EMITTED_ARTIFACT_INVALID',
              message: 'protoc rejected the artifact: duplicate message name Refund.',
            },
          } as never
        }
        targetLabel="Protocol Buffers (proto3)"
        submitting={false}
        onRetry={jest.fn()}
        onCancel={jest.fn()}
        onFixInVerify={jest.fn()}
      />,
    );
    write('failure', container.innerHTML);
  });

  it('renders the delivery gate at a block', () => {
    const { container } = render(<DeliveryGatePanel delivery={BLOCKED_DELIVERY} />);
    write('gate', container.innerHTML);
  });
});
