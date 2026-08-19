/**
 * Render + snapshot tests for the token-driven SVG chart kit (V2-MCP-28.3 / MCAT-14.3).
 *
 * Confirms the acceptance criteria that live in the components (not the pure helpers): each chart
 * renders an accessible `role="img"` figure with a hidden data table from fixture data; empty /
 * degenerate data renders an empty state rather than crashing; and the rendered markup is snapshotted
 * so unintended visual regressions surface in review.
 */
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  Sparkline,
  TrendLine,
  BarSeries,
  Donut,
  StackedTimeline,
  Radar,
  Heatmap,
  Gauge,
} from '../src/app/components/ui/mcp/charts';

describe('Sparkline', () => {
  it('renders an accessible figure with a data table from fixture data', () => {
    render(<Sparkline data={[1, 4, 2, 8]} title="Latency trend" />);
    expect(screen.getByRole('img', { name: 'Latency trend' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('cell', { name: '8' })).toBeInTheDocument();
  });

  it('renders an empty state (not a crash) for no data', () => {
    render(<Sparkline data={[]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<Sparkline data={[62, 65, 61, 70, 80]} tone="emerald" title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('TrendLine', () => {
  it('renders an accessible figure with a data table from fixture data', () => {
    render(<TrendLine data={[62, 74, 80, 91]} title="Score trend" />);
    expect(screen.getByRole('img', { name: 'Score trend' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('cell', { name: '91' })).toBeInTheDocument();
  });

  it('gaps a null value ("no data") rather than plotting it, and breaks the line into segments', () => {
    const { container } = render(<TrendLine data={[10, null, 20]} title="Gapped" area={false} />);
    // The gap surfaces as a "no data" cell in the table…
    expect(screen.getByRole('cell', { name: 'no data' })).toBeInTheDocument();
    // …and the line is drawn as two separate <path> segments (one per side of the gap), each a
    // single point → so there are 2 dots and the two flanking values are not joined by a line.
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('overlays a marker at the given index and reports it in the table', () => {
    const { container } = render(
      <TrendLine data={[62, 74, 80, 91]} markers={[2]} title="Marked" />,
    );
    expect(screen.getByRole('cell', { name: 'marker' })).toBeInTheDocument();
    // A marker draws a vertical <line> + a diamond <path>; at least one line is present.
    expect(container.querySelectorAll('line').length).toBeGreaterThan(0);
  });

  it('renders an empty state when every entry is a gap (no crash, not a flat zero line)', () => {
    render(<TrendLine data={[null, null]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('renders an empty state for no data', () => {
    render(<TrendLine data={[]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(
      <TrendLine data={[62, 74, null, 91]} tone="emerald" domainMax={100} markers={[3]} title="snap" />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('BarSeries', () => {
  const data = [
    { label: 'tools', value: 18 },
    { label: 'prompts', value: 3 },
  ];

  it('renders one rect per bar and a data table', () => {
    const { container } = render(<BarSeries data={data} title="Surface" />);
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: '18' })).toBeInTheDocument();
  });

  it('renders an empty state for no bars', () => {
    render(<BarSeries data={[]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<BarSeries data={data} title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('Donut', () => {
  const segments = [
    { label: 'http', value: 12 },
    { label: 'sse', value: 8 },
  ];

  it('renders one arc path per positive segment', () => {
    const { container } = render(<Donut segments={segments} title="Transport" centerLabel="20" />);
    // base track circle + two segment paths
    expect(container.querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('renders an empty state when every value is zero', () => {
    render(<Donut segments={[{ label: 'a', value: 0 }]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<Donut segments={segments} title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('StackedTimeline', () => {
  const series = [
    { key: 'added', label: 'Added' },
    { key: 'removed', label: 'Removed' },
  ];
  const periods = [
    { label: 'v1', values: { added: 4, removed: 0 } },
    { label: 'v2', values: { added: 2, removed: 3 } },
  ];

  it('renders a header + row per period in the fallback table', () => {
    render(<StackedTimeline series={series} periods={periods} title="Churn" />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Added' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'v2' })).toBeInTheDocument();
  });

  it('renders an empty state when there are no periods', () => {
    render(<StackedTimeline series={series} periods={[]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<StackedTimeline series={series} periods={periods} title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('is non-interactive by default (role="img", no per-column buttons)', () => {
    render(<StackedTimeline series={series} periods={periods} title="Churn" />);
    expect(screen.getByRole('img', { name: 'Churn' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders a clickable hit target per column when onSelectPeriod is set', () => {
    const onSelect = jest.fn();
    render(
      <StackedTimeline
        series={series}
        periods={periods}
        title="Churn"
        onSelectPeriod={onSelect}
        periodActionLabel={(p) => `open ${p.label}`}
      />,
    );
    // Interactive frames expose a group (not an img) so the button children are reachable.
    expect(screen.getByRole('group', { name: 'Churn' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'open v2' }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('keeps a zero-total column clickable', () => {
    const onSelect = jest.fn();
    const withEmptyColumn = [
      { label: 'v1', values: { added: 0, removed: 0 } },
      { label: 'v2', values: { added: 3, removed: 1 } },
    ];
    render(
      <StackedTimeline
        series={series}
        periods={withEmptyColumn}
        onSelectPeriod={onSelect}
        periodActionLabel={(p) => `open ${p.label}`}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open v1' }));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('activates a focused column from the keyboard (Enter / Space)', () => {
    const onSelect = jest.fn();
    render(
      <StackedTimeline
        series={series}
        periods={periods}
        onSelectPeriod={onSelect}
        periodActionLabel={(p) => `open ${p.label}`}
      />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'open v1' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'open v2' }), { key: ' ' });
    expect(onSelect).toHaveBeenNthCalledWith(1, 0);
    expect(onSelect).toHaveBeenNthCalledWith(2, 1);
  });
});

describe('Radar', () => {
  const axes = [
    { label: 'Docs', value: 82 },
    { label: 'Safety', value: 90 },
    { label: 'Simplicity', value: 70 },
  ];

  it('renders the value polygon and a data table', () => {
    const { container } = render(<Radar axes={axes} max={100} title="Profile" />);
    // rings + value polygon are all <polygon>; assert the value polygon exists
    expect(container.querySelectorAll('polygon').length).toBeGreaterThan(0);
    expect(screen.getByRole('cell', { name: '82' })).toBeInTheDocument();
  });

  it('renders an empty state for fewer than three axes', () => {
    render(<Radar axes={[{ label: 'a', value: 1 }, { label: 'b', value: 2 }]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<Radar axes={axes} max={100} title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('Heatmap', () => {
  const matrix = [
    [0, 2, 4],
    [1, 3, 5],
  ];

  it('renders one cell per matrix position and a labelled table', () => {
    const { container } = render(
      <Heatmap matrix={matrix} rowLabels={['a', 'b']} colLabels={['x', 'y', 'z']} title="Density" />,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(6);
    expect(screen.getByRole('rowheader', { name: 'a' })).toBeInTheDocument();
  });

  it('renders an empty state for an empty matrix', () => {
    render(<Heatmap matrix={[]} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<Heatmap matrix={matrix} title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe('Gauge', () => {
  it('renders the value in the center and a data table', () => {
    const { container } = render(<Gauge value={94} title="Score" />);
    expect(container.querySelector('text')?.textContent).toBe('94');
    expect(screen.getByRole('cell', { name: '94' })).toBeInTheDocument();
  });

  it('supports a custom domain and label without score-band coloring', () => {
    const { container } = render(<Gauge value={420} min={0} max={1000} tone="blue" centerLabel="420ms" />);
    expect(screen.getByText('420ms')).toBeInTheDocument();
    // The value arc paints the role the `blue` tone resolves to. Since HIVE-7.9 (#5326) that is
    // `--accent` — the one azure DESIGN.md §0 leaves standing — rather than a Tailwind ramp.
    expect(container.querySelector('.stroke-accent')).toBeInTheDocument();
  });

  it('renders an empty state for a non-finite value', () => {
    render(<Gauge value={Number.NaN} />);
    expect(screen.getByRole('img', { name: /No data/ })).toBeInTheDocument();
  });

  it('matches its snapshot', () => {
    const { container } = render(<Gauge value={61} title="snap" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
