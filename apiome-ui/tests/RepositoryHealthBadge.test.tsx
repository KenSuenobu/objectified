/**
 * The repository health badge on the surfaces it ships on (REPO-6.5, #2798).
 *
 * The ticket's acceptance criteria are user-visible: three levels, a token problem never
 * reading as healthy, and a tooltip that explains the most recent contributing factor. These
 * tests exercise the badge itself and then the two places it is rendered — a repository card
 * (the grid form of the REPO-6.1 rows) and, through the same parser the detail header uses, a
 * repository payload straight off the API.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';

import { RepositoryHealthBadge } from '../src/app/components/ade/dashboard/repositories/RepositoryHealthBadge';
import {
  type RepositoryHealth,
  parseRepositoryHealth,
} from '../src/app/components/ade/dashboard/repositories/repositoryHealth';
import {
  RepositoryCard,
  dashboardRepositoryFromApi,
} from '../src/app/components/ade/dashboard/repositories/repositoryStoreUi';

function health(overrides: Record<string, unknown> = {}): RepositoryHealth {
  const parsedHealth = parseRepositoryHealth({
    level: 'healthy',
    score: 100,
    window_days: 30,
    scans_attempted: 20,
    scans_succeeded: 20,
    scan_success_rate: 1,
    parse_error_count: 0,
    primary_factor: null,
    factors: [],
    ...overrides,
  });
  if (!parsedHealth) throw new Error('expected the fixture to parse');
  return parsedHealth;
}

const TOKEN_FACTOR = {
  code: 'token-expired',
  level: 'error',
  summary:
    "The linked account's access token has expired. Re-authorize the account to resume scanning.",
  observed_at: '2026-07-30T09:00:00+00:00',
};

const SCAN_FACTOR = {
  code: 'scan-failing',
  level: 'error',
  summary: 'Scanning is failing. 6 of 10 scans failed in the last 30 days (40% succeeded).',
  observed_at: '2026-07-10T09:00:00+00:00',
};

function renderBadge(value: RepositoryHealth | null) {
  return render(
    <TooltipProvider>
      <RepositoryHealthBadge health={value} />
    </TooltipProvider>
  );
}

describe('RepositoryHealthBadge', () => {
  it('renders the healthy level', () => {
    renderBadge(health());
    const badge = screen.getByTestId('repository-health-badge');
    expect(badge).toHaveAttribute('data-health-level', 'healthy');
    expect(badge).toHaveTextContent('Healthy');
  });

  it('renders the warnings level', () => {
    renderBadge(
      health({
        level: 'warnings',
        primary_factor: { ...SCAN_FACTOR, level: 'warnings', code: 'scan-degraded' },
        factors: [{ ...SCAN_FACTOR, level: 'warnings', code: 'scan-degraded' }],
      })
    );
    const badge = screen.getByTestId('repository-health-badge');
    expect(badge).toHaveAttribute('data-health-level', 'warnings');
    expect(badge).toHaveTextContent('Warnings');
  });

  it('renders the error level', () => {
    renderBadge(health({ level: 'error', primary_factor: SCAN_FACTOR, factors: [SCAN_FACTOR] }));
    const badge = screen.getByTestId('repository-health-badge');
    expect(badge).toHaveAttribute('data-health-level', 'error');
    expect(badge).toHaveTextContent('Error');
  });

  it('renders nothing when the repository carries no health', () => {
    const { container } = renderBadge(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the level and its reason for screen readers', () => {
    renderBadge(health({ level: 'error', primary_factor: TOKEN_FACTOR, factors: [TOKEN_FACTOR] }));
    expect(
      screen.getByLabelText(/Repository health: error\..*access token has expired/i)
    ).toBeInTheDocument();
  });

  it('is reachable by keyboard so the tooltip is not mouse-only', () => {
    renderBadge(health());
    expect(screen.getByTestId('repository-health-badge')).toHaveAttribute('tabindex', '0');
  });

  it('explains the most recent contributing factor on hover', async () => {
    const user = userEvent.setup();
    // The token problem is the most recent event; the scan failure is older and more of a
    // headline. The tooltip must lead with what most recently happened.
    renderBadge(
      health({
        level: 'error',
        primary_factor: TOKEN_FACTOR,
        factors: [SCAN_FACTOR, TOKEN_FACTOR],
        scans_attempted: 10,
        scans_succeeded: 4,
        scan_success_rate: 0.4,
      })
    );

    await user.hover(screen.getByTestId('repository-health-badge'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Health: Error');
    expect(tooltip).toHaveTextContent(/access token has expired/);
    expect(tooltip).toHaveTextContent(/Scanning is failing/);
    expect(tooltip).toHaveTextContent('4 of 10 scans succeeded in the last 30 days (40%).');
  });

  it('explains a healthy repository on hover too', async () => {
    const user = userEvent.setup();
    renderBadge(health());
    await user.hover(screen.getByTestId('repository-health-badge'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Health: Healthy');
    expect(tooltip).toHaveTextContent('No scan failures, spec parse errors or credential problems.');
  });

  it('hides its text but keeps its meaning when compact', () => {
    render(
      <TooltipProvider>
        <RepositoryHealthBadge health={health({ level: 'error' })} compact />
      </TooltipProvider>
    );
    const badge = screen.getByTestId('repository-health-badge');
    expect(badge).toHaveTextContent('');
    expect(badge).toHaveAttribute('aria-label', expect.stringContaining('error'));
  });
});

describe('the badge on a repository row', () => {
  function apiRepository(healthPayload: unknown) {
    return {
      id: '880e8400-e29b-41d4-a716-446655440003',
      name: 'api-platform',
      full_name: 'acme/api-platform',
      provider: 'github',
      default_branch: 'main',
      status: 'ready',
      total_files: 1200,
      importable_count: 14,
      health: healthPayload,
    };
  }

  function renderCard(healthPayload: unknown) {
    const repo = dashboardRepositoryFromApi(apiRepository(healthPayload));
    if (!repo) throw new Error('expected the repository payload to parse');
    return render(
      <TooltipProvider>
        <RepositoryCard repo={repo} index={0} />
      </TooltipProvider>
    );
  }

  it('carries the health the API computed', () => {
    renderCard({ level: 'warnings', factors: [{ ...SCAN_FACTOR, level: 'warnings' }] });
    expect(screen.getByTestId('repository-health-badge')).toHaveAttribute(
      'data-health-level',
      'warnings'
    );
  });

  it('shows a token problem even though the repository itself is ready', () => {
    // The acceptance criterion "token issues always demote to at least warnings" is the
    // API's to enforce; what the row must do is surface the verdict next to a green
    // lifecycle status rather than let the status speak for the repository.
    const { container } = renderCard({ level: 'error', factors: [TOKEN_FACTOR] });
    expect(screen.getByTestId('repository-health-badge')).toHaveAttribute(
      'data-health-level',
      'error'
    );
    expect(within(container).getByText('Ready')).toBeInTheDocument();
  });

  it('renders no badge for a repository whose payload predates health', () => {
    renderCard(undefined);
    expect(screen.queryByTestId('repository-health-badge')).not.toBeInTheDocument();
  });
});
