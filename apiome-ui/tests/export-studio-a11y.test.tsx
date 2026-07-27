/**
 * Export Studio — automated design/a11y parity suite (MFX-41.5, #4352).
 *
 * The Studio surfaces built across MFX-EPIC-41/42/43 must be operable by keyboard and screen
 * reader, and must never encode status in colour alone. Following the OLO-3.5 / IXH-3.6 precedent
 * (`tests/login-a11y.test.tsx`, `tests/import-preview-a11y.test.tsx`), this suite is the
 * deterministic jsdom half of the gate — axe scans (WCAG 2.1 A/AA; the contrast and page-landmark
 * rules need a real renderer and are exempted, the same exemption those suites take) plus the
 * structural keyboard and text-alternative contract:
 *
 *  1. **axe clean** — the stepper shell, the Verify workbench (all three lenses, every verdict),
 *     the fidelity panel with its report open, the target grid, and the bundle tree + file tabs
 *     report zero violations.
 *  2. **Keyboard traversal** — one Tab stop per composite widget (roving tabindex) with arrow-key
 *     movement in the verify lens tabs, the bundle tree, and the bundle file tabs.
 *  3. **Focus management** — stepping the Studio moves focus to the newly-rendered step panel,
 *     which is named "Step N of 5: <label>".
 *  4. **Never colour alone** — loss-kind chips carry a glyph *and* the kind word, count chips
 *     carry a glyph, stepper states differ by glyph, and every count badge is named in words.
 *
 * The manual keyboard-only walkthrough script lives in `docs/EXPORT_STUDIO_A11Y_PARITY.md`.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
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
import { VerifyWorkbench } from '../src/app/components/ade/dashboard/export/VerifyWorkbench';
import { FidelityWarningPanel } from '../src/app/components/ade/dashboard/export/FidelityWarningPanel';
import { ExportTargetGrid } from '../src/app/components/ade/dashboard/export/ExportTargetGrid';
import { BundleTree } from '../src/app/components/ade/dashboard/export/BundleTree';
import { BundleFileTabs } from '../src/app/components/ade/dashboard/export/BundleFileTabs';
import { GenerateProgress } from '../src/app/components/ade/dashboard/export/GenerateProgress';
import { __resetExportJobTrackerForTests } from '../src/app/components/ade/dashboard/export/exportJobTracker';
import {
  buildBundleManifest,
  buildBundleTree,
  countFindingsByFile,
} from '../src/app/components/ade/dashboard/export/exportBundle';
import { exportTargetCards } from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import type {
  ExportTargetsResponse,
  TargetFidelitySummary,
} from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import type { ExportFidelityEnvelope } from '../src/app/components/ade/dashboard/export/exportFidelityPreview';
import type { ExportVerifyResponse } from '../src/app/components/ade/dashboard/export/exportVerify';

/** axe options: WCAG 2.1 A/AA; contrast and page-landmark rules need a real page. */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

const LOSSY_SUMMARY: TargetFidelitySummary = {
  tier: 'lossy',
  preserved_percent: 64,
  total: 58,
  preserved: 51,
  dropped: 3,
  approximated: 2,
  synthesized: 2,
};

const PROTO_DESCRIPTOR = {
  key: 'proto',
  format: 'proto-3',
  label: 'gRPC / Protobuf',
  description: 'Export services and messages as a .proto file.',
  icon: 'binary',
  paradigm: 'rpc',
  multi_file: false,
  needs_toolchain: false,
  available: true,
  unavailable_reason: null,
};

/** A lossy fidelity envelope whose report exercises all four loss kinds. */
function lossyFidelity(): ExportFidelityEnvelope {
  return {
    target: PROTO_DESCRIPTOR,
    summary: LOSSY_SUMMARY,
    report: {
      items: [
        { construct: 'Payment.oneOf', kind: 'drop', severity: 'warn', message: 'No unions in proto3.', target_mapping: null },
        { construct: 'Pet.tag.pattern', kind: 'approx', severity: 'info', message: 'Moved to a comment.', target_mapping: 'field comment' },
        { construct: 'field numbers', kind: 'synth', severity: 'info', message: 'Assigned deterministically.', target_mapping: 'field numbers' },
        { construct: 'Pet.name', kind: 'ok', severity: 'info', message: 'Carried faithfully.', target_mapping: 'string name' },
      ],
      kind_counts: { drop: 3, approx: 2, synth: 2, ok: 51 },
      severity_counts: { info: 3, warn: 1, critical: 0 },
    },
    advisory: {
      show: true,
      severity: 'warn',
      requires_ack: true,
      target_format: 'gRPC / Protobuf',
      dropped: 3,
      approximated: 2,
      synthesized: 2,
      affected: 7,
      headline: 'This export loses fidelity',
      message: 'Exporting to gRPC / Protobuf may lose some fidelity: 7 constructs affected.',
    },
  };
}

/** A settled verify result: `lossy` (valid, one lint warning) or `invalid` (blocked). */
function verifyResult(kind: 'lossy' | 'invalid'): ExportVerifyResponse {
  return {
    artifact: 'proj-petstore',
    version: null,
    version_record_id: 'rev-1',
    version_label: '1.2.0',
    fidelity: lossyFidelity(),
    guard: null,
    validation:
      kind === 'invalid'
        ? {
            verdict: 'invalid',
            target: 'proto-3',
            blocks_delivery: true,
            warns: false,
            valid: false,
            findings: [
              { message: 'Field number 0 is not allowed.', file: 'petstore.proto', line: 12, column: 3, keyword: 'buf.field-number' },
            ],
            detail: null,
            headline: 'Invalid — export blocked',
            message: 'The export was blocked before delivery.',
          }
        : {
            verdict: 'valid',
            target: 'proto-3',
            blocks_delivery: false,
            warns: false,
            valid: true,
            findings: [],
            detail: null,
            headline: 'Valid',
            message: 'The emitted artifact re-parsed cleanly.',
          },
    lint: {
      applicable: true,
      pack: 'buf-lint',
      score: 88,
      grade: 'B',
      findings: [
        { severity: 'warning', rule: 'PACKAGE_LOWER_SNAKE_CASE', message: 'Package should be lower_snake_case.', file: 'petstore.proto', line: 1 },
      ],
    },
  };
}

/** The workbench with a settled result, at the given verdict. */
function renderWorkbench(kind: 'lossy' | 'invalid' = 'lossy') {
  return render(
    <VerifyWorkbench
      targetLabel="gRPC / Protobuf"
      targetDescription="Export services and messages as a .proto file."
      fidelitySummary={LOSSY_SUMMARY}
      running={false}
      hasRun
      error={null}
      result={verifyResult(kind)}
      verdict={kind}
      acknowledged={false}
      onAcknowledgedChange={jest.fn()}
      onRun={jest.fn()}
    />,
  );
}

/** A two-target registry for the grid: lossless OpenAPI + lossy Protobuf. */
const TARGETS: ExportTargetsResponse = {
  artifact: 'proj-petstore',
  version: null,
  version_record_id: 'rev-1',
  version_label: '1.2.0',
  targets: [
    {
      descriptor: {
        key: 'openapi',
        format: 'openapi-3.1',
        label: 'OpenAPI 3.1',
        description: 'Export the canonical model as an OpenAPI 3.1 document.',
        icon: 'file-json',
        paradigm: 'rest',
        multi_file: false,
        needs_toolchain: false,
        available: true,
        unavailable_reason: null,
      },
      capability_profile: { operations: true },
      options_schema: {},
      default_options: {},
      fidelity: { tier: 'lossless', preserved_percent: 100, total: 58, preserved: 58, dropped: 0, approximated: 0, synthesized: 0 },
    },
    {
      descriptor: PROTO_DESCRIPTOR,
      capability_profile: { operations: true },
      options_schema: {
        type: 'object',
        required: ['package'],
        properties: {
          package: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Package' },
        },
      },
      default_options: { package: null },
      fidelity: LOSSY_SUMMARY,
    },
  ],
};

/** A minimal Studio backend: targets, fidelity preview, and the one-call verify. */
function mockFetch(): jest.Mock {
  return jest.fn((input: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/export/targets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...TARGETS }) });
    }
    if (url.includes('/api/export/preview-manifest')) {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) });
    }
    if (url.includes('/api/export/preview') && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            artifact: 'proj-petstore',
            version: null,
            version_record_id: 'rev-1',
            version_label: '1.2.0',
            fidelity: lossyFidelity(),
          }),
      });
    }
    if (url.includes('/api/export/verify') && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, ...verifyResult('lossy'), verdict: 'lossy' }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) });
  }) as unknown as jest.Mock;
}

/** Render the Studio and wait for its target registry to land. */
async function renderStudio() {
  const fetchMock = mockFetch();
  global.fetch = fetchMock as unknown as typeof fetch;
  const utils = render(
    <ExportStudio artifact="proj-petstore" artifactLabel="Pet Store API" version="rev-1" />,
  );
  await waitFor(() => expect(screen.getByText(/export targets available/)).toBeInTheDocument());
  return utils;
}

/** A three-file bundle: one root file plus a folder of two. */
const BUNDLE = buildBundleManifest([
  { path: 'petstore.proto', text: 'syntax = "proto3";' },
  { path: 'com/example/User.avsc', text: '{"type":"record"}' },
  { path: 'com/example/Order.avsc', text: '{"type":"record"}' },
]);
const BUNDLE_NODES = buildBundleTree(BUNDLE.files);
const BUNDLE_COUNTS = countFindingsByFile(
  [{ file: 'com/example/User.avsc' }],
  [{ file: 'com/example/Order.avsc', severity: 'warning' }],
);

beforeEach(() => {
  __resetExportJobTrackerForTests();
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MFX-41.5 — axe scans of the Studio surfaces', () => {
  it('the Studio shell (stepper + source step) has no violations', async () => {
    const { container } = await renderStudio();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('the Verify workbench has no violations at a lossy verdict', async () => {
    const { container } = renderWorkbench('lossy');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('the Verify workbench has no violations at a blocked verdict', async () => {
    const { container } = renderWorkbench('invalid');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('the fidelity panel has no violations with its per-construct report open', async () => {
    const { container } = render(
      <FidelityWarningPanel
        targetLabel="gRPC / Protobuf"
        targetDescription="Export services and messages as a .proto file."
        fidelity={LOSSY_SUMMARY}
        preview={{
          artifact: 'proj-petstore',
          version: null,
          version_record_id: 'rev-1',
          version_label: '1.2.0',
          fidelity: lossyFidelity(),
        }}
        previewLoading={false}
        previewError={null}
        acknowledged={false}
        onAcknowledgedChange={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('export-report-toggle'));
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('the target grid has no violations', async () => {
    const cards = exportTargetCards(TARGETS);
    const { container } = render(
      <ExportTargetGrid cards={cards} selectedKey="proto" onSelect={jest.fn()} />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('the generate progress panel has no violations while a job runs', async () => {
    const { container } = render(
      <GenerateProgress
        status={{
          job_id: 'job-1',
          state: 'running',
          percent: 55,
          events: [],
          progress: { phase: 'emitting', total: 5, completed: 2 },
        }}
        targetLabel="gRPC / Protobuf"
        submitting={false}
        onRetry={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    // The headline announces politely; each stage states its status in words, not tint alone.
    expect(screen.getByRole('status')).toHaveTextContent(/generating gRPC \/ Protobuf/i);
    expect(screen.getByTestId('generate-stage-emitting')).toHaveTextContent(/— active/i);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('the bundle tree and file tabs have no violations', async () => {
    const { container } = render(
      <>
        <BundleFileTabs
          openPaths={['petstore.proto', 'com/example/User.avsc']}
          activePath="petstore.proto"
          countsByPath={BUNDLE_COUNTS}
          onActivate={jest.fn()}
          onClose={jest.fn()}
        />
        <BundleTree
          nodes={BUNDLE_NODES}
          countsByPath={BUNDLE_COUNTS}
          activePath="petstore.proto"
          onSelect={jest.fn()}
        />
      </>,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('MFX-41.5 — keyboard flow through the verify lenses', () => {
  it('keeps one Tab stop and moves the selection with the arrow keys', () => {
    renderWorkbench('lossy');
    const tabs = screen.getByRole('tablist', { name: /verification lenses/i });
    const [fidelityTab, validationTab, lintTab] = within(tabs).getAllByRole('tab');

    // Roving tabindex: exactly one tab is reachable with Tab.
    expect(fidelityTab).toHaveAttribute('tabindex', '0');
    expect(validationTab).toHaveAttribute('tabindex', '-1');
    expect(lintTab).toHaveAttribute('tabindex', '-1');

    fidelityTab.focus();
    fireEvent.keyDown(tabs, { key: 'ArrowRight' });
    expect(validationTab).toHaveAttribute('aria-selected', 'true');
    expect(validationTab).toHaveFocus();

    fireEvent.keyDown(tabs, { key: 'End' });
    expect(lintTab).toHaveAttribute('aria-selected', 'true');
    expect(lintTab).toHaveFocus();

    fireEvent.keyDown(tabs, { key: 'Home' });
    expect(fidelityTab).toHaveAttribute('aria-selected', 'true');

    // Wrap-around keeps the strip cyclic.
    fireEvent.keyDown(tabs, { key: 'ArrowLeft' });
    expect(lintTab).toHaveAttribute('aria-selected', 'true');
  });

  it('ties each tab to its panel and makes the panel focusable', () => {
    renderWorkbench('lossy');
    const tab = screen.getByTestId('verify-tab-fidelity');
    const panel = screen.getByTestId('verify-panel-fidelity');
    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(panel).toHaveAttribute('tabindex', '0');
  });

  it('names every lens count badge in words', () => {
    renderWorkbench('lossy');
    // jsdom applies no media queries, so the desktop tabs and the narrow accordion both mount;
    // the badge is the same component in both, so asserting the first is enough.
    // "7" alone is not a label: the badge says what was counted.
    expect(screen.getAllByTestId('verify-badge-fidelity')[0]).toHaveTextContent(
      /constructs affected/i,
    );
    expect(screen.getAllByTestId('verify-badge-validation')[0]).toHaveTextContent(
      /validation problem/i,
    );
    expect(screen.getAllByTestId('verify-badge-lint')[0]).toHaveTextContent(/lint finding/i);
  });

  it('announces the verdict without stealing focus', () => {
    renderWorkbench('lossy');
    const verdict = screen.getByTestId('verify-verdict');
    expect(verdict).toHaveAttribute('role', 'status');
    // Tone is carried in words, not only in the banner's palette.
    expect(verdict).toHaveTextContent(/lossy/i);
  });
});

describe('MFX-41.5 — keyboard flow through the bundle explorer', () => {
  function renderTree(onSelect = jest.fn()) {
    render(
      <BundleTree
        nodes={BUNDLE_NODES}
        countsByPath={BUNDLE_COUNTS}
        activePath="petstore.proto"
        onSelect={onSelect}
      />,
    );
    return onSelect;
  }

  it('exposes level, position, and set size on every row', () => {
    renderTree();
    const folder = screen.getByTestId('bundle-tree-folder-com');
    expect(folder).toHaveAttribute('aria-level', '1');
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    const nested = screen.getByTestId('bundle-tree-file-com/example/Order.avsc');
    expect(nested).toHaveAttribute('aria-level', '3');
    expect(nested).toHaveAttribute('aria-setsize', '2');
    expect(nested).toHaveAttribute('aria-posinset', '1');
  });

  it('holds exactly one Tab stop, on the open file', () => {
    renderTree();
    const tree = screen.getByRole('tree', { name: /bundle files/i });
    const stops = within(tree)
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(screen.getByTestId('bundle-tree-file-petstore.proto'));
  });

  it('moves with the arrow keys, collapses with ArrowLeft, and opens with Enter', () => {
    const onSelect = renderTree();
    const tree = screen.getByRole('tree', { name: /bundle files/i });

    // From the open file (row 2 of "com", "com/example", …) walk to the top and back down.
    fireEvent.keyDown(tree, { key: 'Home' });
    expect(screen.getByTestId('bundle-tree-folder-com')).toHaveFocus();

    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    // The folder collapsed — its descendants are gone from the DOM.
    expect(screen.getByTestId('bundle-tree-folder-com')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('bundle-tree-file-com/example/User.avsc')).not.toBeInTheDocument();

    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getByTestId('bundle-tree-folder-com')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(tree, { key: 'End' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('petstore.proto');
  });

  it('runs the file tab strip as a roving-tabindex tablist', () => {
    const onActivate = jest.fn();
    render(
      <BundleFileTabs
        openPaths={['petstore.proto', 'com/example/User.avsc']}
        activePath="petstore.proto"
        countsByPath={BUNDLE_COUNTS}
        onActivate={onActivate}
        onClose={jest.fn()}
      />,
    );
    const strip = screen.getByRole('tablist', { name: /open bundle files/i });
    expect(screen.getByTestId('bundle-tab-activate-petstore.proto')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('bundle-tab-activate-com/example/User.avsc')).toHaveAttribute(
      'tabindex',
      '-1',
    );
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenCalledWith('com/example/User.avsc');
  });

  it('closes the focused tab with Delete — the ✕ is only a pointer shortcut', () => {
    const onClose = jest.fn();
    render(
      <BundleFileTabs
        openPaths={['petstore.proto', 'com/example/User.avsc']}
        activePath="petstore.proto"
        countsByPath={BUNDLE_COUNTS}
        onActivate={jest.fn()}
        onClose={onClose}
      />,
    );
    const strip = screen.getByRole('tablist', { name: /open bundle files/i });
    fireEvent.keyDown(strip, { key: 'Delete' });
    expect(onClose).toHaveBeenCalledWith('petstore.proto');

    // The ✕ itself is presentational, so it never becomes a second Tab stop per open file.
    expect(screen.getByTestId('bundle-tab-close-petstore.proto').tagName).toBe('SPAN');
  });

  it('names per-file finding badges in words', () => {
    renderTree();
    expect(screen.getByTestId('bundle-tree-badge-com/example/User.avsc')).toHaveTextContent(
      /1 error/i,
    );
  });
});

describe('MFX-41.5 — status is never colour alone', () => {
  it('gives every loss-kind chip a glyph and the kind word', () => {
    render(
      <FidelityWarningPanel
        targetLabel="gRPC / Protobuf"
        targetDescription="Export services and messages as a .proto file."
        fidelity={LOSSY_SUMMARY}
        preview={{
          artifact: 'proj-petstore',
          version: null,
          version_record_id: 'rev-1',
          version_label: '1.2.0',
          fidelity: lossyFidelity(),
        }}
        previewLoading={false}
        previewError={null}
        acknowledged={false}
        onAcknowledgedChange={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('export-report-toggle'));

    const expected: [string, string, RegExp][] = [
      ['drop', '✕', /dropped/i],
      ['approx', '≈', /approximated/i],
      ['synth', '✚', /synthesized/i],
      ['ok', '✓', /clean/i],
    ];
    for (const [kind, glyph, description] of expected) {
      const chip = screen.getByTestId(`export-fidelity-kind-${kind}`);
      expect(chip).toHaveTextContent(glyph);
      expect(chip).toHaveTextContent(kind.toUpperCase());
      expect(chip).toHaveTextContent(description);
    }
  });

  it('gives every count chip a glyph beside its number and word', () => {
    render(
      <FidelityWarningPanel
        targetLabel="gRPC / Protobuf"
        targetDescription="Export services and messages as a .proto file."
        fidelity={LOSSY_SUMMARY}
        preview={null}
        previewLoading={false}
        previewError={null}
        acknowledged={false}
        onAcknowledgedChange={jest.fn()}
      />,
    );
    const chips: [string, string, string][] = [
      ['dropped', '✕', '3 dropped'],
      ['approximated', '≈', '2 approximated'],
      ['synthesized', '✚', '2 synthesized'],
      ['preserved', '✓', '51 clean'],
    ];
    for (const [key, glyph, words] of chips) {
      const chip = screen.getByTestId(`export-fidelity-chip-${key}`);
      expect(chip).toHaveTextContent(glyph);
      expect(chip).toHaveTextContent(words);
    }
  });

  it('marks the selected target card as pressed', () => {
    const cards = exportTargetCards(TARGETS);
    render(<ExportTargetGrid cards={cards} selectedKey="proto" onSelect={jest.fn()} />);
    expect(screen.getByTestId('export-target-proto')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('export-target-openapi')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('MFX-41.5 — stepper semantics and focus management', () => {
  it('labels the stepper and states each step in words', async () => {
    await renderStudio();
    expect(screen.getByTestId('export-studio-stepper')).toHaveAttribute(
      'aria-label',
      'Export steps',
    );
    const current = screen.getByTestId('export-studio-step-source');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(current).toHaveTextContent(/current step, 1 of 5/i);
    expect(screen.getByTestId('export-studio-step-target')).toHaveTextContent(/not started/i);
  });

  it('marks a completed step done — with a glyph, not only a colour', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));

    const done = screen.getByTestId('export-studio-step-source');
    expect(done).toHaveAttribute('data-state', 'done');
    expect(done).toHaveTextContent(/completed/i);
    // The done and current pills do not share a treatment.
    const current = screen.getByTestId('export-studio-step-target');
    expect(done.className).not.toEqual(current.className);
  });

  it('moves focus to the newly-rendered step panel, which names the step', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));

    const panel = screen.getByTestId('export-studio-body');
    await waitFor(() => expect(panel).toHaveFocus());
    expect(panel).toHaveAttribute('aria-label', 'Step 2 of 5: Target');
  });
});
