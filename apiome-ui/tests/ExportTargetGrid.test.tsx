/**
 * ExportTargetGrid — readiness-ranked target grid (IXH-2.4, #5099).
 *
 * Covers the ticket's UI acceptance criteria directly on the shared grid, so both hosts (the
 * ExportDialog and the Export Studio) inherit them:
 *  1. With a pre-flight ranking the grid sorts by readiness and shows each card's rationale.
 *  2. The previous registry ordering remains available as an option (the order toggle).
 *  3. A target the tenant's export policy blocks is rendered **blocked with its reason**, not
 *     hidden, and cannot be selected.
 *  4. An unavailable target stays disabled, as before.
 *  5. Without a ranking the grid behaves exactly as it did before the pre-flight existed.
 *
 * It also covers the FMT-3.2 (#5427) emitted-version badge: a target that offers more than one
 * version of its format shows which one the export will produce, on the selected card and in
 * the fidelity headline.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { ExportTargetGrid } from '../src/app/components/ade/dashboard/export/ExportTargetGrid';
import {
  exportTargetCards,
  resolveExportDialect,
} from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import type { ExportTargetsResponse } from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import type {
  ExportPreflightReport,
  ExportPreflightTarget,
} from '../src/app/components/ade/dashboard/export/exportReadiness';
import { readinessByTarget } from '../src/app/components/ade/dashboard/export/exportReadiness';

/** Three registry targets in key order: avro, openapi, proto (proto is toolchain-unavailable). */
const TARGETS: ExportTargetsResponse = {
  artifact: 'proj-petstore',
  version: null,
  version_record_id: 'rev-1',
  version_label: '1.2.0',
  targets: [
    {
      descriptor: {
        key: 'avro',
        format: 'avro-1.12',
        label: 'Apache Avro',
        description: 'Export the type model as Avro schemas.',
        icon: 'database',
        paradigm: 'schema',
        multi_file: true,
        needs_toolchain: false,
        available: true,
        unavailable_reason: null,
      },
      capability_profile: { operations: false },
      options_schema: {},
      default_options: {},
      fidelity: {
        tier: 'types-only',
        preserved_percent: 50,
        total: 10,
        preserved: 5,
        dropped: 5,
        approximated: 0,
        synthesized: 0,
      },
    },
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
      fidelity: {
        tier: 'lossless',
        preserved_percent: 100,
        total: 10,
        preserved: 10,
        dropped: 0,
        approximated: 0,
        synthesized: 0,
      },
    },
    {
      descriptor: {
        key: 'protobuf',
        format: 'proto3',
        label: 'Protocol Buffers',
        description: 'Export as proto3 source.',
        icon: 'binary',
        paradigm: 'rpc',
        multi_file: true,
        needs_toolchain: true,
        available: false,
        unavailable_reason: 'Requires the buf toolchain, which is not available in this runtime.',
      },
      capability_profile: { operations: true },
      options_schema: {},
      default_options: {},
      fidelity: {
        tier: 'lossy',
        preserved_percent: 80,
        total: 10,
        preserved: 8,
        dropped: 2,
        approximated: 0,
        synthesized: 0,
      },
    },
  ],
};

function rankedTarget(
  key: string,
  overrides: Partial<ExportPreflightTarget>,
): ExportPreflightTarget {
  return {
    rank: 1,
    key,
    format: `${key}-1`,
    readiness: 90,
    band: 'ready',
    blocked: false,
    selectable: true,
    rationale: 'Carries this source without loss (100% preserved). Source grade B.',
    fidelity: {
      tier: 'lossless',
      preserved_percent: 100,
      total: 10,
      preserved: 10,
      dropped: 0,
      approximated: 0,
      synthesized: 0,
    },
    capability: {
      verdict: 'full',
      required: ['operations'],
      supported: ['operations'],
      missing: [],
      synthesized: [],
      reason: 'carries everything',
    },
    policy: {
      verdict: 'pass',
      blocking: false,
      source: 'default',
      reason: 'The tenant quality policy sets no export floor.',
      scope: 'export',
    },
    ...overrides,
  };
}

/** OpenAPI ready, Avro blocked by policy, Protobuf unavailable. */
const REPORT: ExportPreflightReport = {
  artifact: 'proj-petstore',
  version_record_id: 'rev-1',
  version_label: '1.2.0',
  lint: { score: 82, grade: 'B' },
  style_guide: { guide_id: 'g1', name: 'Acme House Style', source: 'custom', fingerprint: 'fp' },
  capability_demand: ['operations'],
  ranking_fingerprint: 'fp-rank',
  targets: [
    rankedTarget('openapi', { rank: 1, readiness: 94, band: 'ready' }),
    rankedTarget('avro', {
      rank: 2,
      readiness: 41,
      band: 'blocked',
      blocked: true,
      selectable: false,
      rationale: 'Blocked by the tenant export policy: grade B required, source is D.',
      policy: {
        verdict: 'block',
        blocking: true,
        source: 'tenant',
        reason: 'grade B required, source is D',
        scope: 'export',
      },
    }),
    rankedTarget('protobuf', {
      rank: 3,
      readiness: 0,
      band: 'unavailable',
      selectable: false,
      rationale: 'Requires the buf toolchain, which is not available in this runtime.',
    }),
  ],
};

function renderGrid(props: Partial<React.ComponentProps<typeof ExportTargetGrid>> = {}) {
  const onSelect = jest.fn();
  const onOrderChange = jest.fn();
  const utils = render(
    <ExportTargetGrid
      cards={exportTargetCards(TARGETS)}
      selectedKey={null}
      onSelect={onSelect}
      readiness={readinessByTarget(REPORT)}
      preflight={REPORT}
      onOrderChange={onOrderChange}
      {...props}
    />,
  );
  return { ...utils, onSelect, onOrderChange };
}

describe('ExportTargetGrid with a pre-flight ranking', () => {
  it('orders the cards by readiness rather than by registry key', () => {
    renderGrid();
    const rendered = screen
      .getAllByTestId(/^export-target-/)
      .filter((el) => el.tagName === 'BUTTON')
      .map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual([
      'export-target-openapi',
      'export-target-avro',
      'export-target-protobuf',
    ]);
  });

  it('shows each card its band badge and rationale', () => {
    renderGrid();
    expect(screen.getByTestId('export-target-band-openapi')).toHaveTextContent('ready');
    expect(screen.getByTestId('export-target-band-avro')).toHaveTextContent('blocked');
    expect(screen.getByTestId('export-target-rationale-openapi')).toHaveTextContent(
      'Carries this source without loss',
    );
  });

  it('shows a policy-blocked target with its reason instead of hiding it', () => {
    const { onSelect } = renderGrid();
    const avro = screen.getByTestId('export-target-avro');
    expect(avro).toBeInTheDocument();
    expect(avro).toBeDisabled();
    expect(avro).toHaveAttribute('data-band', 'blocked');
    expect(screen.getByTestId('export-target-rationale-avro')).toHaveTextContent(
      'Blocked by the tenant export policy',
    );
    fireEvent.click(avro);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps an unavailable target disabled with the runtime reason', () => {
    renderGrid();
    const proto = screen.getByTestId('export-target-protobuf');
    expect(proto).toBeDisabled();
    expect(proto).toHaveAttribute(
      'title',
      'Requires the buf toolchain, which is not available in this runtime.',
    );
  });

  it('still selects a ready target', () => {
    const { onSelect } = renderGrid();
    fireEvent.click(screen.getByTestId('export-target-openapi'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect((onSelect.mock.calls[0] as unknown[])[0]).toMatchObject({ key: 'openapi' });
  });

  it('surfaces the source quality line', () => {
    renderGrid();
    expect(screen.getByTestId('export-source-quality')).toHaveTextContent(
      'Source quality B (82/100) under Acme House Style.',
    );
  });

  it('offers the previous ordering as an option', () => {
    const { onOrderChange } = renderGrid();
    fireEvent.click(screen.getByTestId('export-order-toggle'));
    expect(onOrderChange).toHaveBeenCalledWith('registry');
  });

  it('restores the registry order when asked for it', () => {
    renderGrid({ order: 'registry' });
    const rendered = screen
      .getAllByTestId(/^export-target-/)
      .filter((el) => el.tagName === 'BUTTON')
      .map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual([
      'export-target-avro',
      'export-target-openapi',
      'export-target-protobuf',
    ]);
  });
});

describe('ExportTargetGrid without a pre-flight ranking', () => {
  it('renders the registry order with no band badges or toolbar', () => {
    render(
      <ExportTargetGrid
        cards={exportTargetCards(TARGETS)}
        selectedKey={null}
        onSelect={jest.fn()}
      />,
    );
    const rendered = screen
      .getAllByTestId(/^export-target-/)
      .filter((el) => el.tagName === 'BUTTON')
      .map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual([
      'export-target-avro',
      'export-target-openapi',
      'export-target-protobuf',
    ]);
    expect(screen.queryByTestId('export-readiness-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-target-band-openapi')).not.toBeInTheDocument();
  });

  it('keeps every available target selectable', () => {
    const onSelect = jest.fn();
    render(
      <ExportTargetGrid
        cards={exportTargetCards(TARGETS)}
        selectedKey={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('export-target-avro'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('ExportTargetGrid emitted-version badge (FMT-3.2)', () => {
  /** The OpenAPI entry, given the AsyncAPI-style version option FMT-3.2 introduced. */
  function versionedTargets(): ExportTargetsResponse {
    return {
      ...TARGETS,
      targets: TARGETS.targets.map((entry) =>
        entry.descriptor.key === 'openapi'
          ? {
              ...entry,
              options_schema: {
                properties: {
                  openapi_version: {
                    type: 'string',
                    enum: ['3.1', '3.0', '2.0'],
                    default: '3.1',
                  },
                },
              },
              default_options: { openapi_version: '3.1' },
            }
          : entry,
      ),
    };
  }

  function renderVersioned(values: Record<string, unknown>, selectedKey: string | null = 'openapi') {
    const cards = exportTargetCards(versionedTargets());
    const entry = cards.find((card) => card.key === 'openapi')!.entry;
    return render(
      <ExportTargetGrid
        cards={cards}
        selectedKey={selectedKey}
        onSelect={jest.fn()}
        dialect={resolveExportDialect(entry, values)}
      />,
    );
  }

  it('names the chosen downgrade on the selected card', () => {
    renderVersioned({ openapi_version: '2.0' });
    expect(screen.getByTestId('export-target-dialect-openapi')).toHaveTextContent(
      '2.0 · downgrade',
    );
  });

  it('names the native version when nothing was overridden', () => {
    renderVersioned({});
    expect(screen.getByTestId('export-target-dialect-openapi')).toHaveTextContent('3.1 · native');
  });

  it('repeats the badge in the fidelity headline', () => {
    renderVersioned({ openapi_version: '3.0' });
    expect(screen.getByTestId('export-fidelity-headline-dialect')).toHaveTextContent(
      '3.0 · downgrade',
    );
  });

  it('badges only the selected card', () => {
    renderVersioned({ openapi_version: '2.0' });
    expect(screen.queryByTestId('export-target-dialect-avro')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-target-dialect-protobuf')).not.toBeInTheDocument();
  });

  it('renders no badge for a target with a single version', () => {
    const cards = exportTargetCards(TARGETS);
    render(<ExportTargetGrid cards={cards} selectedKey="avro" onSelect={jest.fn()} />);
    expect(screen.queryByTestId('export-target-dialect-avro')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-fidelity-headline-dialect')).not.toBeInTheDocument();
  });
});
