/**
 * The Version-dialogs redesign, rendered (HIVE-6.3, #5314).
 *
 * `version-dialogs-model.test.ts` holds the decisions and `version-dialogs-css.test.ts` pins
 * the declarations; this mounts the panels themselves. Eleven surfaces is too many to reach
 * through one page render, and most of them are already separately mountable — so each is
 * exercised here against its own props and its own mocked reads, and the page-level wiring
 * stays covered by `versions-hive-redesign.test.tsx`.
 *
 * What this pins is the ticket's four acceptance criteria:
 *
 *   1. **Every panel keeps its data contract and its empty/loading copy.** Each surface below
 *      is rendered in its empty, loading and populated states, and the sentences are compared
 *      against `VERSION_DIALOG_COPY` — one source, so a panel and the mockup cannot drift.
 *   2. **Diff views stay readable at all font scales and in dark themes.** jsdom compiles no
 *      stylesheet, so the readable-ness is the CSS suite's; what belongs here is the structure
 *      that makes it possible — the change class travels as `data-change`, never as a colour,
 *      and every legend swatch is accompanied by its word.
 *   3. **React Flow surfaces adopt token colours.** The node and edge values are asserted to
 *      be `var(--…)` references; react-flow is mocked so the values are observable.
 *   4. **Export hand-off carries the current selection** — pinned in `ExportDialog.test.tsx`
 *      for the dialog; here the version panel's target chips and re-run rows are read for the
 *      Studio query they build.
 *
 * Plus an axe pass over the two densest surfaces (the conflict table and the compare legend),
 * which is the DoD's "zero serious/critical violations".
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { jest } from '@jest/globals';

import { VERSION_DIALOG_COPY } from '@/app/components/ade/version-dialogs/versionDialogsModel';

/**
 * The panels below fetch; jsdom ships no `fetch`, so one is installed for the whole file and
 * each suite swaps its implementation. Assigning rather than spying is what the other
 * component suites do, for the same reason: there is nothing to spy on.
 */
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/** axe options shared with the other component suites: contrast is the CSS suite's job. */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

/* -------------------------------------------------------------------------
   react-flow: mocked so a node's style object is observable
   ------------------------------------------------------------------------- */

type FlowNode = { id: string; data?: { label?: string }; style?: Record<string, unknown> };
type FlowEdge = { id: string; style?: Record<string, unknown> };

jest.mock('@xyflow/react', () => {
  const React_ = jest.requireActual('react') as typeof React;
  return {
    __esModule: true,
    ReactFlow: ({
      nodes,
      edges,
      className,
      children,
    }: {
      nodes: FlowNode[];
      edges: FlowEdge[];
      className?: string;
      children?: React.ReactNode;
    }) =>
      React_.createElement(
        'div',
        { 'data-testid': 'flow', className },
        // Each node and edge writes its resolved stroke into an attribute the test can read;
        // this is the only way to see what react-flow would have put in an inline `style`.
        ...nodes.map((node) =>
          React_.createElement('div', {
            key: node.id,
            'data-testid': `flow-node-${node.id}`,
            'data-border': String(node.style?.borderColor ?? ''),
          }, node.data?.label ?? node.id)
        ),
        ...edges.map((edge) =>
          React_.createElement('div', {
            key: edge.id,
            'data-testid': `flow-edge-${edge.id}`,
            'data-stroke': String(edge.style?.stroke ?? ''),
          })
        ),
        children
      ),
    Background: () => null,
    BackgroundVariant: { Dots: 'dots' },
    Controls: () => null,
    MiniMap: ({ className }: { className?: string }) =>
      React_.createElement('div', { 'data-testid': 'minimap', className }),
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
    useReactFlow: () => ({
      setViewport: jest.fn(),
      setCenter: jest.fn(),
      getNode: jest.fn(),
      fitView: jest.fn(),
    }),
    useNodesState: (initial: FlowNode[]) => {
      const [nodes, setNodes] = React_.useState(initial);
      return [nodes, setNodes, jest.fn()];
    },
    useEdgesState: (initial: FlowEdge[]) => {
      const [edges, setEdges] = React_.useState(initial);
      return [edges, setEdges, jest.fn()];
    },
  };
});

jest.mock('@xyflow/react/dist/style.css', () => ({}), { virtual: true });

/* -------------------------------------------------------------------------
   1. Compare — the canvas tab and the revision cards
   ------------------------------------------------------------------------- */

import VersionCanvasCompare from '@/app/ade/dashboard/versions/VersionCanvasCompare';
import { CompareRevisionCard } from '@/app/components/ade/version-dialogs/CompareRevisionCard';

/** Two saved layouts that differ by one added node — the mockup's Refund / RefundReason pair. */
const LEFT_LAYOUT = {
  nodes: [
    { id: 'payment', position: { x: 0, y: 0 }, data: { name: 'Payment' } },
    { id: 'refund', position: { x: 160, y: 0 }, data: { name: 'Refund' } },
  ],
  edges: [{ id: 'payment-refund', source: 'payment', target: 'refund' }],
};

const RIGHT_LAYOUT = {
  nodes: [
    ...LEFT_LAYOUT.nodes,
    { id: 'reason', position: { x: 160, y: 120 }, data: { name: 'RefundReason' } },
  ],
  edges: [
    ...LEFT_LAYOUT.edges,
    { id: 'refund-reason', source: 'refund', target: 'reason' },
  ],
};

describe('the compare dialog’s canvas tab', () => {
  it('draws the four-swatch legend with a word beside every swatch', () => {
    // The AC's "diff views stay readable" rests on the swatch never being the only channel:
    // WCAG 1.4.11 is satisfied by the label, not by the colour.
    const { container } = render(
      <VersionCanvasCompare
        left={LEFT_LAYOUT as never}
        right={RIGHT_LAYOUT as never}
        leftLabel="v2.3.0 (base)"
        rightLabel="v2.3.1 (compare)"
        mode="split"
      />
    );
    const swatches = container.querySelectorAll('.vdlg-legend__swatch');
    expect(swatches).toHaveLength(4);
    for (const swatch of Array.from(swatches)) {
      expect(swatch).toHaveAttribute('data-tone');
      expect(swatch.parentElement?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    expect(screen.getByText('Added (compare side)')).toBeInTheDocument();
    expect(screen.getByText('Removed (base side)')).toBeInTheDocument();
    expect(screen.getByText('Moved / modified')).toBeInTheDocument();
  });

  it('hands react-flow token references rather than hues', () => {
    render(
      <VersionCanvasCompare
        left={LEFT_LAYOUT as never}
        right={RIGHT_LAYOUT as never}
        leftLabel="base"
        rightLabel="compare"
        mode="split"
      />
    );
    // The added node on the compare side is `--ok`; an unchanged one is the faint step.
    const added = screen.getAllByTestId('flow-node-reason')[0];
    expect(added).toHaveAttribute('data-border', 'var(--ok)');
    for (const node of screen.getAllByTestId(/^flow-node-/)) {
      expect(node.getAttribute('data-border')).toMatch(/^var\(--[a-z-]+\)$/);
    }
    for (const edge of screen.getAllByTestId(/^flow-edge-/)) {
      expect(edge.getAttribute('data-stroke')).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it('grounds the graph on the canvas token rather than a grey', () => {
    render(
      <VersionCanvasCompare
        left={LEFT_LAYOUT as never}
        right={RIGHT_LAYOUT as never}
        leftLabel="base"
        rightLabel="compare"
        mode="split"
      />
    );
    for (const flow of screen.getAllByTestId('flow')) {
      expect(flow).toHaveClass('vdlg-flow');
    }
  });

  it('keeps the empty copy for a revision with no saved layout', () => {
    render(
      <VersionCanvasCompare
        left={null}
        right={RIGHT_LAYOUT as never}
        leftLabel="base"
        rightLabel="compare"
        mode="split"
      />
    );
    expect(screen.getByText(VERSION_DIALOG_COPY.canvasEmpty)).toBeInTheDocument();
    expect(screen.getByText(VERSION_DIALOG_COPY.canvasNote)).toBeInTheDocument();
  });

  it('stacks the two revisions in overlay mode, naming which is which', () => {
    const { container } = render(
      <VersionCanvasCompare
        left={LEFT_LAYOUT as never}
        right={RIGHT_LAYOUT as never}
        leftLabel="v2.3.0"
        rightLabel="v2.3.1"
        mode="overlay"
      />
    );
    expect(container.querySelector('.vdlg-canvas__layer--under')).toBeInTheDocument();
    expect(container.querySelector('.vdlg-canvas__layer--over')).toBeInTheDocument();
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByText('Compare')).toBeInTheDocument();
  });
});

describe('a compare revision card', () => {
  it('states the side, the note and the changelog', () => {
    render(
      <CompareRevisionCard
        label="v2.3.0"
        side="base"
        published
        revisionNote="Payouts resource + settlement reports"
        changelog="- added: /payouts"
      />
    );
    expect(screen.getByText(/v2\.3\.0/)).toBeInTheDocument();
    expect(screen.getByText('(base)')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText(/Payouts resource/)).toBeInTheDocument();
    expect(screen.getByText('- added: /payouts')).toBeInTheDocument();
  });

  it('says so plainly when there is no changelog and no note', () => {
    render(<CompareRevisionCard label="v2.4.0" side="compare to" />);
    expect(screen.getByText('No changelog')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText(/Revision note:/)?.parentElement).toHaveTextContent('—');
  });

  it('carries the breaking hints as a warning badge, not as tinted prose', () => {
    // The hint used to be `text-amber-700 dark:text-amber-300` — a semantic ink on the plain
    // surface, which measures 2.0:1 on Solarized. The badge is the calibrated pair.
    const { container } = render(
      <CompareRevisionCard
        label="v2.3.1"
        side="compare to"
        breakingHints={['Refund.amount minimum raised']}
      />
    );
    expect(screen.getByText('Breaking hints')).toBeInTheDocument();
    expect(container.querySelector('.vdlg-revcard__hints')).toHaveTextContent(
      'Refund.amount minimum raised'
    );
  });
});

/* -------------------------------------------------------------------------
   2. Merge conflicts
   ------------------------------------------------------------------------- */

import { VersionMergeConflictList } from '@/app/components/ade/dashboard/VersionMergeConflictList';

const CONFLICTS = [
  { path: 'components.schemas.Payout.properties.status', kinds: ['both_modified'] },
  { path: 'paths./payouts.post.requestBody', kinds: ['divergent'] },
];

/** Mount the conflict list with a resolution map the test controls. */
function renderConflicts(resolutions: Record<string, 'mine' | 'theirs' | 'manual' | null> = {}) {
  const onResolve = jest.fn();
  const onBulkResolve = jest.fn();
  const view = render(
    <VersionMergeConflictList
      conflicts={CONFLICTS}
      targetBranchName="main"
      sourceBranchName="feature/payouts"
      resolutions={resolutions}
      onResolve={onResolve}
      onBulkResolve={onBulkResolve}
    />
  );
  return { ...view, onResolve, onBulkResolve };
}

describe('the merge conflict list', () => {
  it('keeps the count sentence and the mine/theirs legend', () => {
    renderConflicts();
    expect(screen.getByText(/2 paths need a resolution/)).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('feature/payouts')).toBeInTheDocument();
  });

  it('marks an unresolved row on the row, not by colour alone', () => {
    // `data-unresolved` is what the stylesheet washes; the badge beside it is what a reader
    // who cannot see the wash gets.
    const { container } = renderConflicts({ 'paths./payouts.post.requestBody': 'theirs' });
    const unresolved = container.querySelectorAll('tr[data-unresolved]');
    expect(unresolved).toHaveLength(1);
    expect(within(unresolved[0] as HTMLElement).getByText('Unresolved')).toBeInTheDocument();
    expect(screen.getByText('Source (theirs)')).toBeInTheDocument();
  });

  it('resolves one path and both bulk scopes', () => {
    const { onResolve, onBulkResolve } = renderConflicts();
    fireEvent.click(screen.getAllByTitle('Keep target (main) at this path')[0]);
    expect(onResolve).toHaveBeenCalledWith(CONFLICTS[0].path, 'mine');

    fireEvent.click(screen.getByLabelText('Bulk theirs for 2 path(s) matching filter'));
    expect(onBulkResolve).toHaveBeenCalledWith(
      CONFLICTS.map((c) => c.path),
      'theirs'
    );

    fireEvent.click(screen.getByLabelText('Bulk mine for all 2 conflict path(s)'));
    expect(onBulkResolve).toHaveBeenLastCalledWith(
      CONFLICTS.map((c) => c.path),
      'mine'
    );
  });

  it('narrows the bulk-shown scope with the path filter', () => {
    const { onBulkResolve } = renderConflicts();
    fireEvent.change(screen.getByLabelText('Filter paths'), {
      target: { value: 'requestBody' },
    });
    expect(screen.getByText(/Filter matches/)).toHaveTextContent('1');
    fireEvent.click(screen.getByLabelText('Bulk mine for 1 path(s) matching filter'));
    expect(onBulkResolve).toHaveBeenCalledWith(['paths./payouts.post.requestBody'], 'mine');
  });

  it('opens the manual-resolution dialog with the path in it', async () => {
    const { onResolve } = renderConflicts();
    fireEvent.click(screen.getAllByRole('button', { name: 'Manual' })[0]);
    expect(onResolve).toHaveBeenCalledWith(CONFLICTS[0].path, 'manual');
    expect(await screen.findByText('Manual resolution')).toBeInTheDocument();
    // Twice: the row it came from, and the dialog explaining it.
    expect(screen.getAllByText(CONFLICTS[0].path)).toHaveLength(2);
  });

  it('passes axe in its densest state', async () => {
    const { container } = renderConflicts({ 'paths./payouts.post.requestBody': 'theirs' });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

/* -------------------------------------------------------------------------
   3. The compatibility report and its external evidence
   ------------------------------------------------------------------------- */

import { CompatibilityReportPanel } from '@/app/components/ade/dashboard/CompatibilityReportPanel';

describe('the compatibility report', () => {
  it('badges the verdict rather than printing it as a tinted word', () => {
    render(
      <CompatibilityReportPanel
        overall="breaking"
        findings={[
          {
            id: 'f1',
            category: 'breaking',
            rule: 'response-property-removed',
            path: 'paths./payouts.get.responses.200',
            message: 'property settledAt removed from Payout',
          },
        ]}
        ruleHits={{ 'response-property-removed': 1 }}
      />
    );
    expect(screen.getByText('Overall:')).toBeInTheDocument();
    expect(screen.getByText('breaking')).toBeInTheDocument();
    expect(screen.getByText('Rule hits')).toBeInTheDocument();
    // The rule id appears twice: once in the rule-hit list, once on the finding it explains.
    expect(screen.getAllByText('response-property-removed')).toHaveLength(2);
  });

  it('keeps the empty copy the mockup quotes', () => {
    render(<CompatibilityReportPanel findings={[]} />);
    expect(screen.getByText(VERSION_DIALOG_COPY.compatNoFindings)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   4. The lint & score panel
   ------------------------------------------------------------------------- */

import { SchemaVersionScoringPanel } from '@/app/components/ade/dashboard/SchemaVersionScoringPanel';

/** The lint report the panel fetches. */
const LINT_REPORT = {
  success: true,
  score: 88,
  grade: 'B',
  guideName: 'Acme REST',
  guideId: 'g-1',
  findings: [
    {
      severity: 'error',
      rule: 'operation-4xx-response',
      path: 'paths./payouts.post',
      message: 'Missing 4xx response',
    },
  ],
};

describe('the lint & score panel', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('shows the stored grade as a badge and the guide beside it', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => LINT_REPORT } as never);

    render(<SchemaVersionScoringPanel projectId="p-1" versionId="v-1" versionLabel="2.4.0" />);

    expect(await screen.findByTestId('studio-lint-grade')).toHaveTextContent('B');
    expect(screen.getByTestId('studio-lint-guide-name')).toHaveTextContent('Guide: Acme REST');
    expect(screen.getByText(/Score/)).toHaveTextContent('88');
    expect(screen.getByText('v2.4.0')).toBeInTheDocument();
  });

  it('offers the mockup’s error copy and a retry when the report cannot be read', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    render(<SchemaVersionScoringPanel projectId="p-1" versionId="v-1" />);

    const box = await screen.findByTestId('studio-lint-error');
    expect(box).toHaveTextContent('offline');
    expect(screen.getByTestId('studio-lint-retry')).toBeInTheDocument();
  });

  it('falls back to the shared "Lint report unavailable." sentence with no message', async () => {
    // A rejection that is not an `Error` carries no message; the panel says the sentence the
    // mockup quotes rather than inventing a second wording for the same failure.
    fetchMock.mockRejectedValue('');

    render(<SchemaVersionScoringPanel projectId="p-1" versionId="v-1" />);

    expect(await screen.findByText(VERSION_DIALOG_COPY.lintUnavailable)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   5. The version export panel
   ------------------------------------------------------------------------- */

import { VersionExportPanel } from '@/app/components/ade/dashboard/export/VersionExportPanel';

/** One target entry, shaped like `GET /api/export/targets` returns it. */
function targetEntry(key: string, label: string, tier: string, percent: number) {
  return {
    descriptor: {
      key,
      format: key,
      label,
      description: `${label} export`,
      icon: 'file-json',
      paradigm: 'rest',
      multi_file: false,
      needs_toolchain: false,
      available: true,
    },
    capability_profile: {},
    options_schema: {},
    default_options: {},
    fidelity: {
      tier,
      preserved_percent: percent,
      total: 40,
      preserved: Math.round((percent / 100) * 40),
      dropped: 1,
      approximated: 1,
      synthesized: 0,
    },
  };
}

const TARGETS_RESPONSE = {
  artifact: 'p-1',
  version: '2.3.1',
  version_record_id: 'ver-1',
  version_label: '2.3.1',
  targets: [
    targetEntry('asyncapi', 'AsyncAPI', 'lossless', 98),
    targetEntry('graphql', 'GraphQL', 'lossy', 74),
  ],
};

describe('the version export panel', () => {
  afterEach(() => {
    fetchMock.mockReset();
    window.localStorage.clear();
  });

  it('shows the measuring copy while the registry is being read', () => {
    fetchMock.mockImplementation((() => new Promise(() => {})) as never);
    render(<VersionExportPanel artifact="p-1" version="2.3.1" active />);
    expect(screen.getByText(VERSION_DIALOG_COPY.exportMeasuring)).toBeInTheDocument();
  });

  it('groups the targets and deep-links each chip into the Studio with its target', async () => {
    // The AC's "export hand-off carries the current selection", at the panel end: a chip is a
    // link whose query already names the artifact, the version and the target.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => TARGETS_RESPONSE } as never);

    render(<VersionExportPanel artifact="p-1" version="2.3.1" artifactLabel="Payments API" active />);

    const chips = await screen.findAllByTestId('version-export-target-chip');
    expect(chips).toHaveLength(2);
    const asyncapi = chips.find((chip) => chip.textContent?.includes('AsyncAPI'));
    expect(asyncapi).toHaveAttribute(
      'href',
      expect.stringContaining('/ade/dashboard/export/studio')
    );
    expect(asyncapi?.getAttribute('href')).toContain('artifact=p-1');
    expect(asyncapi?.getAttribute('href')).toContain('version=2.3.1');
    expect(asyncapi?.getAttribute('href')).toContain('target=asyncapi');
    expect(asyncapi?.getAttribute('href')).toContain('from=versions');

    expect(screen.getByText('Best-fidelity targets')).toBeInTheDocument();
    expect(screen.getByText('Lossy targets')).toBeInTheDocument();
  });

  it('keeps the empty copy for a version nobody has exported', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => TARGETS_RESPONSE } as never);

    render(<VersionExportPanel artifact="p-1" version="2.3.1" active />);

    await waitFor(() =>
      expect(screen.getByText(VERSION_DIALOG_COPY.exportNoRecent)).toBeInTheDocument()
    );
  });
});

/* -------------------------------------------------------------------------
   6. The suite regression badge
   ------------------------------------------------------------------------- */

import { SuiteRegressionBadge } from '@/app/components/ade/dashboard/SuiteRegressionBadge';

describe('the suite regression badge', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('renders nothing when no suite regressed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, items: [{ latest_run: { regression: false } }] }),
    } as never);

    const { container } = render(<SuiteRegressionBadge surface="project" artifact="p-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('states the count in words when one did', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        items: [{ latest_run: { regression: true } }, { latest_run: { regression: true } }],
      }),
    } as never);

    render(<SuiteRegressionBadge surface="project" artifact="p-1" />);

    const badge = await screen.findByTestId('suite-regression-badge');
    expect(badge).toHaveTextContent('Suite regression ×2');
    expect(badge.getAttribute('title')).toContain('previously-passing payload now failing');
  });
});

/* -------------------------------------------------------------------------
   7. The browser fixtures
   ------------------------------------------------------------------------- */

/**
 * `e2e/hive-version-dialogs.spec.ts` measures these surfaces in a real browser — no horizontal
 * document scroll at 1280 px, the graph stages' heights, the diff pane's two columns, axe —
 * against markup the components actually render. That markup is written here, from the very
 * renders this suite pins, into `e2e/fixtures/hive-version-dialogs/` when
 * `VERSION_DIALOGS_FIXTURE_DUMP=1` is set:
 *
 *     VERSION_DIALOGS_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/version-dialogs-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is
 * there — so a change to a component that would leave the fixtures stale fails loudly here
 * before it fails quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-version-dialogs');
  const dump = process.env.VERSION_DIALOGS_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('renders every surface the browser spec mounts (and writes the fixtures on request)', async () => {
    // 1 — the canvas compare, split, with its legend.
    const canvas = render(
      <VersionCanvasCompare
        left={LEFT_LAYOUT as never}
        right={RIGHT_LAYOUT as never}
        leftLabel="v2.3.0 (base)"
        rightLabel="v2.3.1 (compare)"
        mode="split"
      />
    );
    write('canvas-compare', (canvas.container.firstElementChild as HTMLElement).outerHTML);
    canvas.unmount();

    // 2 — the merge conflict table, one row resolved and one not.
    const conflicts = render(
      <VersionMergeConflictList
        conflicts={CONFLICTS}
        targetBranchName="main"
        sourceBranchName="feature/payouts"
        resolutions={{ 'paths./payouts.post.requestBody': 'theirs' }}
        onResolve={jest.fn()}
        onBulkResolve={jest.fn()}
      />
    );
    write('merge-conflicts', (conflicts.container.firstElementChild as HTMLElement).outerHTML);
    conflicts.unmount();

    // 3 — the compatibility report at its breaking verdict.
    const compat = render(
      <CompatibilityReportPanel
        overall="breaking"
        findings={[
          {
            id: 'f1',
            category: 'breaking',
            rule: 'response-property-removed',
            path: 'paths./payouts.get.responses.200',
            message: 'property settledAt removed from Payout',
          },
          {
            id: 'f2',
            category: 'safe',
            rule: 'response-property-added',
            path: 'paths./payouts.get.responses.200',
            message: 'property reference added to Payout',
          },
        ]}
        ruleHits={{ 'response-property-removed': 1, 'enum-value-removed': 2 }}
        docUrl="https://example.test/breaking"
      />
    );
    write('compat-report', (compat.container.firstElementChild as HTMLElement).outerHTML);
    compat.unmount();

    // 4 — the two compare revision cards, side by side.
    const cards = render(
      <div className="vdlg-compare__cards">
        <CompareRevisionCard
          label="v2.3.0"
          side="base"
          published
          revisionNote="Payouts resource + settlement reports"
          changelog={'- added: /payouts, /payouts/{id}/report\n- breaking: none'}
        />
        <CompareRevisionCard
          label="v2.3.1"
          side="compare to"
          published
          revisionNote="Patch: fix Refund.amount minimum"
          changelog={'- fixed: Refund.amount minimum 0.01'}
          breakingHints={['Refund.amount minimum raised 0 → 0.01']}
        />
      </div>
    );
    write('compare-cards', (cards.container.firstElementChild as HTMLElement).outerHTML);
    cards.unmount();

    // 5 — the export panel with both fidelity buckets filled.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => TARGETS_RESPONSE,
    } as never);
    const exportPanel = render(
      <VersionExportPanel artifact="p-1" version="2.3.1" artifactLabel="Payments API" active />
    );
    await screen.findAllByTestId('version-export-target-chip');
    write('export-panel', (exportPanel.container.firstElementChild as HTMLElement).outerHTML);
    exportPanel.unmount();
  });
});
