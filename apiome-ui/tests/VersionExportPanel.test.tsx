/**
 * VersionExportPanel — the version-scoped export entry point (MFX-6.5 #3859, MFX-41.3 #4350).
 *
 * Covers the ticket's acceptance criteria for the version view:
 *  1. The fidelity pre-summary renders from a mocked `GET /api/export/targets`, grouping
 *     targets into best-fidelity (lossless) vs lossy (lossy, then types-only) rows.
 *  2. "Export this version" and each target chip deep-link into the Export Studio (the dialog now
 *     lives only on the compact row-menu action) — MFX-41.3.
 *  3. The recent-exports list renders this version's recorded exports with fidelity % badges and
 *     relative times, newest first, and each row offers a "re-run in Studio" link that carries the
 *     run's target and options; an empty state shows when nothing was exported.
 *  4. Nothing is fetched while the panel is inactive, and a fetch failure surfaces the error.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

// The panel deep-links with next/link; render it as a plain anchor so `href` is assertable.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { VersionExportPanel } from '../src/app/components/ade/dashboard/export/VersionExportPanel';
import type { ExportTargetsResponse } from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import {
  recentExportsStorageKey,
  type RecentExport,
} from '../src/app/components/ade/dashboard/export/recentExports';
import { decodeStudioOptions } from '../src/app/components/ade/dashboard/export/exportStudioUrlState';

const ARTIFACT = 'proj-petstore';
const VERSION = 'rev-1';
const LABEL = 'Pet Store API';

function makeTarget(
  key: string,
  label: string,
  tier: 'lossless' | 'lossy' | 'types-only',
  preserved_percent: number,
): ExportTargetsResponse['targets'][number] {
  return {
    descriptor: {
      key,
      format: key,
      label,
      description: `${label} export.`,
      icon: 'file-json',
      paradigm: 'rest',
      multi_file: false,
      needs_toolchain: false,
      available: true,
      unavailable_reason: null,
    },
    capability_profile: {},
    options_schema: {},
    default_options: {},
    fidelity: {
      tier,
      preserved_percent,
      total: 58,
      preserved: Math.round((preserved_percent / 100) * 58),
      dropped: 0,
      approximated: 0,
      synthesized: 0,
    },
  };
}

/** Lossless OpenAPI + TypeSpec, lossy GraphQL, types-only Avro — mirrors the mockup's rows. */
const TARGETS: ExportTargetsResponse = {
  artifact: ARTIFACT,
  version: VERSION,
  version_record_id: VERSION,
  version_label: '1.2.0',
  targets: [
    makeTarget('avro', 'Avro', 'types-only', 31),
    makeTarget('graphql', 'GraphQL SDL', 'lossy', 82),
    makeTarget('openapi', 'OpenAPI 3.1', 'lossless', 100),
    makeTarget('typespec', 'TypeSpec', 'lossless', 100),
  ],
};

function mockFetch(response: ExportTargetsResponse | null = TARGETS): jest.Mock {
  return jest.fn(() =>
    response
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(response) })
      : Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Targets unavailable.' }) }),
  ) as unknown as jest.Mock;
}

function seedRecentExports(entries: RecentExport[]): void {
  localStorage.setItem(recentExportsStorageKey(ARTIFACT, VERSION), JSON.stringify(entries));
}

/** Parse an `/ade/dashboard/export/studio?…` href into its query params. */
function studioParams(href: string): URLSearchParams {
  return new URLSearchParams(href.slice(href.indexOf('?')));
}

describe('VersionExportPanel — fidelity pre-summary (MFX-6.5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('groups targets into best-fidelity vs lossy rows for this source', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);

    await waitFor(() =>
      expect(screen.getByTestId('version-export-presummary')).toBeInTheDocument(),
    );
    expect(screen.getByText('Best-fidelity targets')).toBeInTheDocument();
    expect(screen.getByText('Lossy targets')).toBeInTheDocument();

    const [bestRow, lossyRow] = screen
      .getByTestId('version-export-presummary')
      .querySelectorAll(':scope > div');
    expect(bestRow).toHaveTextContent('OpenAPI 3.1');
    expect(bestRow).toHaveTextContent('TypeSpec');
    expect(bestRow).not.toHaveTextContent('GraphQL SDL');
    // Lossy row lists lossy before types-only (amber before red, per the mockup).
    expect(lossyRow?.textContent?.indexOf('GraphQL SDL')).toBeLessThan(
      lossyRow?.textContent?.indexOf('Avro') ?? -1,
    );
  });

  it('does not fetch while inactive', () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
      <VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active={false} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a targets load failure', async () => {
    global.fetch = mockFetch(null) as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);
    await waitFor(() => expect(screen.getByText('Targets unavailable.')).toBeInTheDocument());
    expect(screen.queryByTestId('version-export-presummary')).not.toBeInTheDocument();
  });

  it('deep-links "Export this version" into the Studio scoped to this source (MFX-41.3)', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);

    const href = screen.getByTestId('version-export-open-studio').getAttribute('href') ?? '';
    expect(href).toContain('/ade/dashboard/export/studio');
    const params = studioParams(href);
    expect(params.get('artifact')).toBe(ARTIFACT);
    expect(params.get('version')).toBe(VERSION);
    expect(params.get('label')).toBe(LABEL);
    expect(params.get('from')).toBe('versions');
    // No target pre-selected on the generic "Export this version" entry.
    expect(params.get('target')).toBeNull();
  });

  it('deep-links each pre-summary chip into the Studio with that target selected (MFX-41.3)', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);

    await waitFor(() =>
      expect(screen.getByTestId('version-export-presummary')).toBeInTheDocument(),
    );
    const openApiChip = screen.getByRole('link', { name: 'OpenAPI 3.1' });
    const params = studioParams(openApiChip.getAttribute('href') ?? '');
    expect(params.get('artifact')).toBe(ARTIFACT);
    expect(params.get('version')).toBe(VERSION);
    expect(params.get('target')).toBe('openapi');
    expect(params.get('from')).toBe('versions');
  });
});

describe('VersionExportPanel — recent exports (MFX-6.5, MFX-41.3)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows an empty state when this version was never exported', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);
    expect(screen.getByText('No exports of this version yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('version-recent-exports')).not.toBeInTheDocument();
  });

  it('lists recorded exports with fidelity badges and relative times, newest first', async () => {
    const now = Date.now();
    seedRecentExports([
      {
        targetKey: 'graphql',
        targetLabel: 'GraphQL SDL',
        tier: 'lossy',
        preservedPercent: 82,
        filename: 'petstore.graphql',
        exportedAt: now - 2 * 60 * 60 * 1000,
      },
      {
        targetKey: 'openapi',
        targetLabel: 'OpenAPI 3.1',
        tier: 'lossless',
        preservedPercent: 100,
        filename: 'petstore.json',
        exportedAt: now - 3 * 24 * 60 * 60 * 1000,
      },
    ]);
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);

    const list = screen.getByTestId('version-recent-exports');
    const rows = Array.from(list.querySelectorAll('li')).map((li) => li.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('GraphQL SDL');
    expect(rows[0]).toContain('82% fidelity');
    expect(rows[0]).toContain('2h ago');
    expect(rows[1]).toContain('OpenAPI 3.1');
    expect(rows[1]).toContain('lossless');
    expect(rows[1]).toContain('3d ago');
  });

  it('offers a "re-run in Studio" link carrying the run\'s target and options (MFX-41.3)', async () => {
    seedRecentExports([
      {
        targetKey: 'proto',
        targetLabel: 'Protobuf',
        tier: 'lossy',
        preservedPercent: 74,
        filename: 'petstore.proto',
        options: { package: 'com.example', emit_services: false },
        exportedAt: Date.now(),
      },
    ]);
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);

    const rerun = screen.getByTestId('version-recent-export-rerun');
    const params = studioParams(rerun.getAttribute('href') ?? '');
    expect(params.get('artifact')).toBe(ARTIFACT);
    expect(params.get('version')).toBe(VERSION);
    expect(params.get('target')).toBe('proto');
    expect(params.get('from')).toBe('versions');
    // The overrides travel compactly (MFX-41.4); decode them through the shared contract.
    expect(decodeStudioOptions(params.get('opts'))).toEqual({
      package: 'com.example',
      emit_services: false,
    });
  });

  it('re-runs a defaults-only export with no options param (MFX-41.3)', async () => {
    seedRecentExports([
      {
        targetKey: 'openapi',
        targetLabel: 'OpenAPI 3.1',
        tier: 'lossless',
        preservedPercent: 100,
        filename: 'petstore.json',
        options: null,
        exportedAt: Date.now(),
      },
    ]);
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<VersionExportPanel artifact={ARTIFACT} version={VERSION} artifactLabel={LABEL} active />);

    const params = studioParams(
      screen.getByTestId('version-recent-export-rerun').getAttribute('href') ?? '',
    );
    expect(params.get('target')).toBe('openapi');
    expect(params.get('opts')).toBeNull();
  });

  it('re-reads the list when refreshToken bumps', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { rerender } = render(
      <VersionExportPanel
        artifact={ARTIFACT}
        version={VERSION}
        artifactLabel={LABEL}
        active
        refreshToken={0}
      />,
    );
    expect(screen.getByText('No exports of this version yet.')).toBeInTheDocument();

    seedRecentExports([
      {
        targetKey: 'openapi',
        targetLabel: 'OpenAPI 3.1',
        tier: 'lossless',
        preservedPercent: 100,
        filename: 'petstore.json',
        exportedAt: Date.now(),
      },
    ]);
    rerender(
      <VersionExportPanel
        artifact={ARTIFACT}
        version={VERSION}
        artifactLabel={LABEL}
        active
        refreshToken={1}
      />,
    );
    expect(screen.getByTestId('version-recent-exports')).toHaveTextContent('OpenAPI 3.1');
  });
});
