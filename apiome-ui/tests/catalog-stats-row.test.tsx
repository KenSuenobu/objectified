/**
 * Render tests for the Catalog stats row (MFI-24.1, #4081; re-skinned onto `ui/metrics`'
 * `StatGrid` in HIVE-7.1, #5318).
 *
 * Confirms the four metric cards render from a fixture list and that the numbers shown match what
 * {@link computeCatalogStats} derives — cataloged items with active/disabled sub-badges, average
 * quality as letter+score, formats represented with a sample badge, and converted-to-OpenAPI.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogStatsRow } from '../src/app/components/ade/catalog';
import type { CatalogStatsItem } from '../src/app/utils/catalog-dashboard-stats';

function item(partial: Partial<CatalogStatsItem> = {}): CatalogStatsItem {
  return {
    enabled: true,
    deleted_at: null,
    qualityScore: null,
    sourceFormat: null,
    conversion: null,
    ...partial,
  };
}

const FIXTURE: CatalogStatsItem[] = [
  item({ enabled: true, qualityScore: 92, sourceFormat: 'graphql', conversion: { project: 'A' } }),
  item({ enabled: true, qualityScore: 88, sourceFormat: 'grpc' }),
  item({ enabled: false, qualityScore: 70, sourceFormat: 'asyncapi' }),
  item({ enabled: true, qualityScore: 10, sourceFormat: 'graphql', deleted_at: '2026-06-01T00:00:00Z' }),
];

describe('CatalogStatsRow', () => {
  it('renders four metric cards', () => {
    render(<CatalogStatsRow items={FIXTURE} />);
    expect(screen.getByTestId('catalog-stat-items')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-stat-quality')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-stat-formats')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-stat-converted')).toBeInTheDocument();
  });

  it('shows cataloged-items count with active/disabled sub-badges (deleted excluded)', () => {
    render(<CatalogStatsRow items={FIXTURE} />);
    const card = screen.getByTestId('catalog-stat-items');
    expect(within(card).getByText('3')).toBeInTheDocument(); // 3 live items
    expect(within(card).getByText('2 active')).toBeInTheDocument();
    expect(within(card).getByText('1 disabled')).toBeInTheDocument();
  });

  it('shows average quality as letter · score', () => {
    render(<CatalogStatsRow items={FIXTURE} />);
    const card = screen.getByTestId('catalog-stat-quality');
    // mean of the 3 live scores (92, 88, 70) = 83 -> grade B. The letter and the score are two
    // elements now (the score is a quiet `<small>` beside the band-tinted letter), so the
    // assertion is on the tile's text rather than on one node.
    expect(card.textContent).toContain('B· 83');
  });

  it('shows the distinct format count and a sample badge', () => {
    render(<CatalogStatsRow items={FIXTURE} />);
    const card = screen.getByTestId('catalog-stat-formats');
    expect(within(card).getByText('3')).toBeInTheDocument(); // graphql, grpc, asyncapi
    expect(within(card).getByText(/GraphQL/)).toBeInTheDocument();
  });

  it('shows the converted-to-OpenAPI count with the promotion-path badge', () => {
    render(<CatalogStatsRow items={FIXTURE} />);
    const card = screen.getByTestId('catalog-stat-converted');
    expect(within(card).getByText('1')).toBeInTheDocument();
    expect(within(card).getByText('promotion path')).toBeInTheDocument();
  });

  it('renders an empty-catalog baseline without crashing', () => {
    render(<CatalogStatsRow items={[]} />);
    const quality = screen.getByTestId('catalog-stat-quality');
    expect(within(quality).getByText('—')).toBeInTheDocument();
    const formats = screen.getByTestId('catalog-stat-formats');
    expect(within(formats).getByText('No formats yet')).toBeInTheDocument();
  });
});
