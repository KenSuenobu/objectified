/**
 * Import preview step — automated a11y suite (IXH-3.6, #5108).
 *
 * The whole preview step (quality gate + entity explorer + projection map + re-import
 * delta + raw viewer) must be operable by keyboard and screen reader at any data size.
 * Following the OLO-3.5 precedent (tests/login-a11y.test.tsx), this suite is the
 * deterministic jsdom half of the a11y gate: axe scans (WCAG 2.1 A/AA rules; contrast
 * needs a real renderer and is exempted, as is the page-level `region` landmark rule —
 * the step is a dialog fragment) plus the structural keyboard contract:
 *
 *  1. **axe clean** — the step reports zero violations in its loading, pass, blocked
 *     (waiver form), and large/windowed states, with the projection graph, delta, and
 *     truncation banner all mounted.
 *  2. **Keyboard traversal** — exactly one Tab stop per composite widget (roving
 *     tabindex), arrow-key movement in the tree and findings listbox, Enter selection on
 *     graph nodes, and a visible focus indicator on the SVG graph.
 *  3. **Text alternatives** — every SVG graph is either `aria-hidden` beside equivalent
 *     text (the grade orb) or named by its synchronized table caption (the projection
 *     map).
 *  4. **Reduced motion** — no *motion* class (`animate-*`, `transition`,
 *     `transition-transform`) renders without a `motion-safe:` guard anywhere in the
 *     step. Colour/opacity fades are exempt: `prefers-reduced-motion` targets movement.
 *
 * The manual keyboard-only walkthrough script lives in
 * `docs/IMPORT_PREVIEW_BUDGETS_AND_A11Y.md`.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { describe, expect, it, jest, afterEach } from '@jest/globals';

import { CatalogImportQualityStep } from '../src/app/components/ade/dashboard/catalog/CatalogImportQualityStep';
import type { PreflightFinding, PreflightReport } from '../src/app/utils/import-preflight';
import type {
  ImportPreviewEntity,
  ImportReimportDelta,
} from '../src/app/utils/import-preview-manifest';
import type {
  ProjectionEdge,
  ProjectionNode,
} from '../src/app/components/ade/dashboard/export/projectionEvidence';

const RAW_SOURCE = Array.from({ length: 40 }, (_, i) => `type T${i} { id: ID }`).join('\n');

/** axe options: WCAG 2.1 A/AA; contrast and page-landmark rules need a real page. */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

function finding(rank: number, overrides: Partial<PreflightFinding> = {}): PreflightFinding {
  return {
    rank,
    id: `f${rank}`,
    rule: 'graphql-type-description',
    severity: 'warning',
    message: `Type T${rank} has no description.`,
    path: `T${rank}`,
    weight: 2,
    rule_penalty: 4,
    ...overrides,
  };
}

function buildReport(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ok: true,
    detection: { adapter_key: 'graphql', confidence: 0.95, matched: true, importable: true },
    format: 'graphql',
    paradigm: 'graphql',
    routing: { target: 'catalog' },
    counts: { services: 1, operations: 2, channels: 0, types: 2 },
    lint: {
      score: 88,
      grade: 'B',
      report_fingerprint: 'fp-abc',
      severity_counts: { error: 0, warning: 2, info: 0 },
      findings: [finding(1), finding(2, { severity: 'info', path: 'T2.id' })],
    },
    style_guide: { guide_id: 'sg-1', name: 'Platform guide', source: 'custom', fingerprint: 'sg' },
    policy: {
      verdict: 'pass',
      blocking: false,
      source: 'default',
      reason: 'Advisory only.',
      threshold_score: null,
      allow_override: true,
    },
    ...overrides,
  };
}

function entity(overrides: Partial<ImportPreviewEntity> & { key: string }): ImportPreviewEntity {
  return {
    name: overrides.key,
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    deprecated: false,
    coverage: 'mapped',
    unmodeled_extras: [],
    ...overrides,
  };
}

/** A small projection graph: one retained service, one dropped type. */
function projectionFixture(): { nodes: ProjectionNode[]; edges: ProjectionEdge[] } {
  const make = (key: string, kind: string, status: ProjectionEdge['status']) => ({
    nodes: [
      {
        id: `native:${key}`,
        kind: 'native',
        label: key,
        construct_key: key,
        native: { native_id: key, native_name: key, source_location: '2:1' },
      },
      { id: `canonical:${key}`, kind: 'canonical', label: key, construct_key: key, canonical_kind: kind },
    ] as ProjectionNode[],
    edges: [
      {
        id: `projects:${key}`,
        relation: 'projects',
        source: `native:${key}`,
        target: `canonical:${key}`,
        status,
        reason: status === 'retained' ? null : 'destination_unsupported',
        severity: 'info',
        detail: `${status} detail for ${key}`,
      },
    ] as ProjectionEdge[],
  });
  const a = make('svc:pets', 'service', 'retained');
  const b = make('type:Pet', 'type', 'dropped');
  return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
}

interface MockShape {
  report: PreflightReport | { failWith: string };
  entities?: ImportPreviewEntity[];
  totalEntities?: number;
  nextCursor?: string | null;
  reimport?: ImportReimportDelta | null;
  graph?: { nodes: ProjectionNode[]; edges: ProjectionEdge[] };
}

/** Stub the pre-flight and preview-manifest endpoints from one description. */
function mockEndpoints(shape: MockShape): void {
  global.fetch = jest.fn((url: unknown) => {
    if ('failWith' in shape.report) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ success: false, error: shape.report }),
      });
    }
    const report = shape.report;
    if (String(url).includes('/api/import/preview-manifest')) {
      const entities = shape.entities ?? [
        entity({ key: 'svc:pets', name: 'PetService', entity_kind: 'service', source_location: '3:1' }),
        entity({ key: 'op:listPets', name: 'listPets', entity_kind: 'operation', parent_key: 'svc:pets' }),
        entity({ key: 'type:Pet', name: 'Pet', coverage: 'partially-mapped', unmodeled_extras: ['x-internal'] }),
      ];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            ok: report.ok,
            preflight: report,
            reimport: shape.reimport ?? null,
            manifest: report.ok
              ? {
                  manifest_hash: 'mh-1',
                  adapter: {
                    adapter_key: 'graphql',
                    adapter_label: 'GraphQL SDL',
                    paradigm: 'graphql',
                    formats: ['graphql'],
                    capability: { format: 'graphql', mode: 'native', importable: true, related_issues: [] },
                    parser_limits: [],
                  },
                  counts: report.counts ?? {},
                  coverage_counts: {},
                  status_counts: {},
                  reason_counts: {},
                  entities,
                  total_entities: shape.totalEntities ?? entities.length,
                  nodes: shape.graph?.nodes ?? [],
                  edges: shape.graph?.edges ?? [],
                  coverage: [],
                  total_coverage_entries: 0,
                  page_size: 1000,
                  next_cursor: shape.nextCursor ?? null,
                  truncated: Boolean(shape.nextCursor),
                }
              : null,
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...report }) });
  }) as unknown as typeof fetch;
}

async function renderStep(shape: MockShape): Promise<HTMLElement> {
  mockEndpoints(shape);
  const { container } = render(
    <CatalogImportQualityStep
      documentBase64="dHlwZSBRdWVyeQ=="
      label="schema.graphql"
      sourceKind="graphql"
      inputKind="paste"
      rawSource={RAW_SOURCE}
      autoAdvance={false}
      skipPreference={false}
      onSkipPreferenceChange={jest.fn() as unknown as (v: boolean) => void}
      onCommit={jest.fn() as unknown as () => void}
      onBack={jest.fn() as unknown as () => void}
      onCancel={jest.fn() as unknown as () => void}
      projectSlug="pets"
    />,
  );
  await waitFor(() =>
    expect(screen.queryByTestId('import-quality-loading')).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.queryByTestId('import-preview-loading')).not.toBeInTheDocument(),
  );
  return container;
}

/** A delta with entries across two families, sized by `perFamily`. */
function buildDelta(perFamily: number): ImportReimportDelta {
  const operations = Array.from({ length: perFamily }, (_, i) => ({
    entity: 'operation',
    key: `op:changed-${i}`,
    change: 'changed' as const,
    severity: 'dangerous' as const,
    rule_id: 'resp-removed',
    rationale: `Response shape changed on op ${i}.`,
  }));
  const types = Array.from({ length: 3 }, (_, i) => ({
    entity: 'type',
    key: `type:added-${i}`,
    change: 'added' as const,
    severity: 'safe' as const,
  }));
  return {
    target_item_id: 'item-1',
    target_item_name: 'Pets API',
    target_item_slug: 'pets-api',
    current_version_record_id: 'v-1',
    noop: false,
    candidate_fingerprint: 'cand-fp',
    current_fingerprint: 'cur-fp',
    entries: [...operations, ...types],
    counts: { added: 3, removed: 0, changed: perFamily },
    counts_by_entity: {},
    classifier: 'structural-baseline',
    classifier_format_pack: false,
    overall_severity: 'dangerous',
    severity_counts: { safe: 3, dangerous: perFamily, breaking: 0 },
  };
}

afterEach(() => jest.restoreAllMocks());

describe('import preview step — axe (WCAG 2.1 A/AA)', () => {
  it('scans clean in the loaded pass state with tree, graph, delta, and findings', async () => {
    const container = await renderStep({
      report: buildReport(),
      graph: projectionFixture(),
      reimport: buildDelta(4),
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  }, 30000);

  it('scans clean in the loading state', async () => {
    mockEndpoints({ report: buildReport() });
    // Hold the pre-flight open so the loading state stays mounted for the scan.
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const { container } = render(
      <CatalogImportQualityStep
        documentBase64="dHlwZSBRdWVyeQ=="
        label="schema.graphql"
        sourceKind="graphql"
        inputKind="paste"
        rawSource={RAW_SOURCE}
        autoAdvance={false}
        skipPreference={false}
        onSkipPreferenceChange={jest.fn() as unknown as (v: boolean) => void}
        onCommit={jest.fn() as unknown as () => void}
        onBack={jest.fn() as unknown as () => void}
        onCancel={jest.fn() as unknown as () => void}
      />,
    );
    expect(screen.getByTestId('import-quality-loading')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  }, 30000);

  it('scans clean in the blocked state with the waiver justification form', async () => {
    const container = await renderStep({
      report: buildReport({
        lint: {
          score: 41,
          grade: 'F',
          report_fingerprint: 'fp-block',
          severity_counts: { error: 6, warning: 0, info: 0 },
          findings: [finding(1, { severity: 'error' })],
        },
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Score 41 is below the required minimum of 70.',
          threshold_score: 70,
          allow_override: true,
        },
      }),
    });
    expect(screen.getByLabelText(/why is this import necessary/i)).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  }, 30000);

  it('scans clean at scale: windowed findings and tree, truncation banner, windowed delta', async () => {
    const container = await renderStep({
      report: buildReport({
        lint: {
          score: 40,
          grade: 'F',
          report_fingerprint: 'fp-many',
          severity_counts: { error: 0, warning: 0, info: 80 },
          findings: Array.from({ length: 80 }, (_, i) => finding(i + 1, { severity: 'info' })),
        },
      }),
      entities: Array.from({ length: 120 }, (_, i) =>
        entity({ key: `type:T${i}`, name: `Type${i}` }),
      ),
      totalEntities: 500,
      nextCursor: 'cursor-2',
      reimport: buildDelta(60),
      graph: projectionFixture(),
    });
    // The bounded states are all visibly stated, never silent.
    expect(screen.getByTestId('import-preview-truncation')).toHaveTextContent(/120 of 500/);
    expect(screen.getAllByText('windowed').length).toBeGreaterThan(0);
    expect(screen.getByTestId('import-reimport-windowed')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  }, 60000);
});

describe('import preview step — keyboard contract', () => {
  it('gives each composite widget exactly one Tab stop (roving tabindex)', async () => {
    await renderStep({
      report: buildReport(),
      graph: projectionFixture(),
      reimport: buildDelta(4),
    });

    // The findings listbox lives on the default tab; the entity tree and projection
    // graph are on the "What this import adds" tab (hidden panels are out of the
    // accessibility tree, so each widget is checked on its own tab).
    const options = screen.getAllByRole('option');
    expect(options.filter((el) => el.tabIndex === 0)).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'What this import adds' }));

    const treeItems = screen.getAllByRole('treeitem');
    expect(treeItems.filter((el) => el.tabIndex === 0)).toHaveLength(1);

    const graphNodes = screen
      .getAllByRole('button')
      .filter((el) => el.getAttribute('data-testid')?.startsWith('import-projection-node-'));
    expect(graphNodes.length).toBeGreaterThan(0);
    expect(graphNodes.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('moves through the findings listbox by keyboard, with truthful set semantics', async () => {
    await renderStep({ report: buildReport() });
    const list = screen.getByRole('listbox', { name: /ranked lint findings/i });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-setsize', '2');
    expect(options[0]).toHaveAttribute('aria-posinset', '1');
    expect(options[1]).toHaveAttribute('aria-posinset', '2');

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
  });

  it('selects a graph node with Enter and shows a visible focus indicator', async () => {
    await renderStep({ report: buildReport(), graph: projectionFixture() });
    const node = screen.getByTestId('import-projection-node-projects:type:Pet');
    fireEvent.focus(node);
    expect(screen.getByTestId('import-projection-focus-ring')).toBeInTheDocument();
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(screen.getByTestId('import-projection-evidence')).toBeInTheDocument();
    fireEvent.blur(node);
    expect(screen.queryByTestId('import-projection-focus-ring')).not.toBeInTheDocument();
  });

  it('does not nest an interactive control inside the tree rows (source links are spans)', async () => {
    await renderStep({ report: buildReport() });
    fireEvent.click(screen.getByRole('tab', { name: 'What this import adds' }));
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.querySelectorAll('a, button, [role="link"], [role="button"], [tabindex]')).toHaveLength(0);
    }
  });
});

describe('import preview step — text alternatives and reduced motion', () => {
  it('names or hides every SVG: the projection map by its table caption, the orb as decoration', async () => {
    const container = await renderStep({
      report: buildReport(),
      graph: projectionFixture(),
    });
    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      const hidden =
        svg.getAttribute('aria-hidden') === 'true' || svg.closest('[aria-hidden="true"]') !== null;
      const labelledBy = svg.getAttribute('aria-labelledby');
      const named = labelledBy !== null && document.getElementById(labelledBy) !== null;
      expect(hidden || named).toBe(true);
    }
    // The projection map's name is its synchronized table's caption — same content, twice.
    const graphSvg = screen.getByTestId('import-projection-svg');
    const caption = document.getElementById(graphSvg.getAttribute('aria-labelledby')!);
    expect(caption?.tagName.toLowerCase()).toBe('caption');
  });

  it('guards every motion class with motion-safe (prefers-reduced-motion honoured)', async () => {
    const container = await renderStep({
      report: buildReport(),
      graph: projectionFixture(),
      reimport: buildDelta(60),
    });
    const offenders: string[] = [];
    for (const el of Array.from(container.querySelectorAll('*'))) {
      const classAttr = el.getAttribute('class');
      if (!classAttr) continue;
      for (const token of classAttr.split(/\s+/)) {
        // Movement classes must be motion-safe; colour/opacity/shadow fades are exempt
        // (prefers-reduced-motion targets motion, not fades).
        const isMotion =
          token.startsWith('animate-') || token === 'transition' || token === 'transition-transform';
        if (isMotion) offenders.push(`${el.tagName.toLowerCase()}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
