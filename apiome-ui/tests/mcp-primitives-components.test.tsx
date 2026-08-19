/**
 * Shared MCP UI primitive components — render tests (V2-MCP-24.7 / MCAT-10.7).
 *
 * Verifies every primitive renders its mockup variants: the grade glyph (chip + gauge, scored &
 * unscored), the tone-based badge, the health & recency pills, the finding-severity chip, the
 * underline detail tabs, and the shared error state.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { GradeGlyph } from '../src/app/components/ui/mcp/GradeGlyph';
import { McpBadge } from '../src/app/components/ui/mcp/McpBadge';
import { HealthPill } from '../src/app/components/ui/mcp/HealthPill';
import { FreshnessPill } from '../src/app/components/ui/mcp/FreshnessPill';
import { RecencyPill } from '../src/app/components/ui/mcp/RecencyPill';
import { FindingSeverity } from '../src/app/components/ui/mcp/FindingSeverity';
import {
  DetailTabs,
  DetailTabsList,
  DetailTabsContent,
} from '../src/app/components/ui/mcp/DetailTabs';
import { ErrorState } from '../src/app/components/ui/ErrorState';
import { MCP_DETAIL_TABS } from '../src/app/components/ade/dashboard/mcp/mcpUiPrimitives';

describe('GradeGlyph', () => {
  it('renders the letter + score chip and an accessible label', () => {
    render(<GradeGlyph grade="B" score={82} />);
    const glyph = screen.getByRole('img', { name: /Grade B, score 82 of 100/i });
    expect(glyph).toHaveTextContent('B');
    expect(glyph).toHaveTextContent('82');
  });

  it('derives the letter grade from the score when no grade is given', () => {
    render(<GradeGlyph score={95} />);
    // 95 → A band.
    expect(screen.getByRole('img', { name: /Grade A/i })).toHaveTextContent('A');
  });

  it('renders an unscored neutral glyph when grade and score are absent', () => {
    render(<GradeGlyph />);
    const glyph = screen.getByRole('img', { name: /Unscored/i });
    expect(glyph).toHaveTextContent('—');
  });

  it('renders the gauge variant with the ring and centered score', () => {
    const { container } = render(<GradeGlyph variant="gauge" grade="C" score={60} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Grade C/i })).toHaveTextContent('60 / 100');
  });
});

describe('McpBadge', () => {
  it('applies the requested tone classes and renders children', () => {
    render(<McpBadge tone="violet">OAuth 2.1</McpBadge>);
    const badge = screen.getByText('OAuth 2.1');
    expect(badge.className).toContain('violet');
  });

  it('renders a leading icon when provided', () => {
    render(
      <McpBadge tone="green" icon={<span data-testid="badge-icon" />}>
        bearer
      </McpBadge>,
    );
    expect(screen.getByTestId('badge-icon')).toBeInTheDocument();
    expect(screen.getByText('bearer')).toBeInTheDocument();
  });
});

describe('HealthPill', () => {
  it('shows the resolved label for an explicit status', () => {
    render(<HealthPill status="degraded" />);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('derives health from a raw discovery status', () => {
    render(<HealthPill discoveryStatus="failed" />);
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
  });

  it('hides the label but keeps it accessible in dot-only mode', () => {
    render(<HealthPill status="healthy" dotOnly />);
    expect(screen.getByText('Healthy')).toHaveClass('sr-only');
  });
});

/**
 * The grounds a tone ink is allowed to sit on (HIVE-7.7, #5324).
 *
 * Only `:root` and `[data-theme="dark"]` recalibrate the semantic `-soft`/`-fg` pairs; the other
 * six themes inherit the *light* inks, so a `-fg` drawn straight onto a card measures 1.89–3.21:1
 * in them — which is what axe found on every health and freshness pill on the MCP catalog at
 * once. These four tests are the guard that would have caught it before the browser did.
 */
describe('a labelled pill wears its own ground', () => {
  it('pairs the health pill’s soft fill with its own ink', () => {
    render(<HealthPill status="degraded" />);
    const pill = screen.getByText('Degraded');
    expect(pill.className).toContain('bg-warn-soft');
    expect(pill.className).toContain('text-warn-fg');
  });

  it('pairs the freshness pill’s soft fill with its own ink', () => {
    render(<FreshnessPill freshness="quarantined" />);
    const pill = screen.getByText('Quarantined');
    expect(pill.className).toContain('bg-danger-soft');
    expect(pill.className).toContain('text-danger-fg');
  });

  it('leaves the dot-only forms a bare saturated swatch, with the label still readable', () => {
    // A dense row cannot carry a second filled pill beside the endpoint's name, and a dot is a
    // *mark* rather than text — the saturated role colour is the step that reads as one.
    const { container, rerender } = render(<HealthPill status="unreachable" dotOnly />);
    const health = screen.getByText('Unreachable');
    expect(health).toHaveClass('sr-only');
    expect(health.parentElement?.className).not.toContain('-soft');
    expect(container.querySelector('.bg-danger')).not.toBeNull();

    rerender(<FreshnessPill freshness="stale" dotOnly />);
    expect(screen.getByText('Stale')).toHaveClass('sr-only');
    expect(container.querySelector('.bg-warn')).not.toBeNull();
  });

  it('inks the grade glyph’s figures in --fg/--fg-muted, leaving the tone to the fill', () => {
    const { rerender } = render(<GradeGlyph grade="A" score={94} />);
    expect(screen.getByText('94').className).toContain('text-fg-muted');
    // The chip beside it is the solid role fill, which is where the tone lives.
    expect(screen.getByText('A').className).toContain('bg-ok');

    rerender(<GradeGlyph variant="gauge" grade="A" score={94} />);
    // The arc carries the tone; the centred letter is the page's own ink.
    expect(screen.getByText('A').className).toContain('text-fg');
    expect(screen.getByText('A').className).not.toContain('text-ok-fg');
  });
});

describe('RecencyPill', () => {
  it('renders the "last discovered" relative time deterministically', () => {
    const now = Date.parse('2026-06-27T12:00:00Z');
    render(<RecencyPill timestamp="2026-06-27T10:00:00Z" nowMs={now} />);
    expect(screen.getByText(/Last discovered 2h ago/)).toBeInTheDocument();
  });

  it('renders "never" for an absent timestamp and honors a custom prefix', () => {
    render(<RecencyPill timestamp={null} prefix="Discovered" nowMs={0} />);
    expect(screen.getByText(/Discovered never/)).toBeInTheDocument();
  });
});

describe('FindingSeverity', () => {
  it('labels MUST / SHOULD / Advisory from an explicit tier', () => {
    const { rerender } = render(<FindingSeverity tier="must" />);
    expect(screen.getByText('MUST')).toBeInTheDocument();
    rerender(<FindingSeverity tier="should" />);
    expect(screen.getByText('SHOULD')).toBeInTheDocument();
    rerender(<FindingSeverity tier="advisory" />);
    expect(screen.getByText('Advisory')).toBeInTheDocument();
  });

  it('resolves the tier from a raw severity and can show a count', () => {
    render(<FindingSeverity severity="error" count={3} />);
    const chip = screen.getByText('MUST');
    expect(within(chip.parentElement as HTMLElement).getByText('3')).toBeInTheDocument();
  });
});

describe('DetailTabs', () => {
  it('auto-renders the canonical detail tab strip and switches panels', async () => {
    const user = userEvent.setup();
    render(
      <DetailTabs defaultValue="overview">
        <DetailTabsList items={MCP_DETAIL_TABS} />
        <DetailTabsContent value="overview">Overview panel</DetailTabsContent>
        <DetailTabsContent value="lint">Lint panel</DetailTabsContent>
      </DetailTabs>,
    );

    // Every canonical tab label renders in the strip.
    for (const tab of MCP_DETAIL_TABS) {
      expect(screen.getByRole('tab', { name: tab.label })).toBeInTheDocument();
    }
    expect(screen.getByText('Overview panel')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Lint & Score' }));
    expect(screen.getByText('Lint panel')).toBeVisible();
  });

  it('can restrict the auto-rendered strip to a subset of tabs', () => {
    render(
      <DetailTabs defaultValue="capabilities">
        <DetailTabsList items={MCP_DETAIL_TABS} only={['capabilities', 'versions']} />
      </DetailTabs>,
    );
    expect(screen.getByRole('tab', { name: 'Capabilities' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Versions' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders the title/description and fires the retry handler', () => {
    const onRetry = jest.fn();
    render(<ErrorState description="Boom." onRetry={onRetry} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Boom.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
