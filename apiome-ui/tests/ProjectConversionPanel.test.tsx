/**
 * ProjectConversionPanel — the converted-project side of the evidence history (CPDO-3.3, #4803).
 *
 * Pins the project perspective of the shared history list: rows link each target revision to the
 * conversion that created it ("View version" hands the revision row id to the page's version
 * selection), the catalog backlink deep-links into the item's Conversions tab (and hides
 * truthfully when the source item was deleted), the trust badges carry over, and a load error
 * renders a retryable message.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest } from '@jest/globals';

import { ProjectConversionPanel } from '../src/app/ade/dashboard/versions/ProjectConversionPanel';
import type { ConversionProvenanceRow } from '../src/app/utils/conversion-provenance';

const HASH = 'c'.repeat(64);

function row(overrides: Partial<ConversionProvenanceRow> = {}): ConversionProvenanceRow {
  return {
    provenanceId: 'prov-2',
    createdAt: '2026-07-10T00:00:00Z',
    createdBy: 'user-1',
    reconverted: true,
    conversionMode: 'lossy',
    sourceProjectId: 'ci-1',
    sourceProjectName: 'Ping API',
    sourceFormat: 'graphql',
    sourceVersionId: 'rev-2',
    targetProjectId: 'proj-9',
    targetProjectName: 'Ping API (OpenAPI)',
    targetProjectSlug: 'ping-api-openapi',
    targetProjectDeleted: false,
    targetVersionLabel: '1.0.1',
    targetVersionRecordId: 'v-9',
    fidelityScore: 88,
    fidelityGrade: 'B',
    fidelityTier: 'high',
    toolVersions: { 'apiome-rest': '1.79.0' },
    defaults: {},
    schemaVersion: '1.0.0',
    manifestHash: HASH,
    sourceHash: 'sha256:' + 'ab'.repeat(32),
    snapshotAvailable: true,
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof ProjectConversionPanel>> = {}) {
  const retry = jest.fn();
  const onSelectVersion = jest.fn();
  render(
    <ProjectConversionPanel
      rows={[row()]}
      loading={false}
      error={null}
      retry={retry}
      onSelectVersion={onSelectVersion}
      {...props}
    />,
  );
  return { retry, onSelectVersion };
}

describe('ProjectConversionPanel', () => {
  it('links each row back to the catalog item Conversions tab and to its target version', () => {
    const { onSelectVersion } = renderPanel();

    const backlink = screen.getByTestId('conversion-history-open-catalog');
    expect(backlink).toHaveAttribute('href', '/ade/dashboard/catalog/ci-1?tab=conversions');
    expect(backlink).toHaveTextContent('Ping API');

    fireEvent.click(screen.getByTestId('conversion-history-open-version'));
    expect(onSelectVersion).toHaveBeenCalledWith('v-9');
  });

  it('hides the backlink truthfully when the source catalog item was deleted', () => {
    renderPanel({ rows: [row({ sourceProjectId: null, sourceProjectName: null })] });
    expect(screen.queryByTestId('conversion-history-open-catalog')).not.toBeInTheDocument();
    expect(screen.getByText('Source catalog item no longer exists')).toBeInTheDocument();
  });

  it('carries the trust badges: snapshot chip and re-converted', () => {
    renderPanel({
      rows: [row(), row({ provenanceId: 'prov-0', manifestHash: null, snapshotAvailable: false, reconverted: false })],
    });
    const chips = screen.getAllByTestId('conversion-history-snapshot-chip');
    expect(chips[0]).toHaveTextContent(`snapshot ${HASH.slice(0, 12)}`);
    expect(chips[1]).toHaveTextContent('No stored snapshot');
    expect(screen.getAllByTestId('conversion-history-reconverted')).toHaveLength(1);
  });

  it('renders a retryable error', () => {
    const { retry } = renderPanel({ rows: [], error: 'Conversion history unavailable' });
    expect(screen.getByTestId('project-conversion-error')).toHaveTextContent(
      'Conversion history unavailable',
    );
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(retry).toHaveBeenCalled();
  });
});
