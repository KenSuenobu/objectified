/**
 * Render tests for the dashboard first-run checklist component (#3614; redrawn by HIVE-4.6,
 * #5300).
 *
 * The redesign is a re-skin with one behavioural change, so this suite is split in two. The
 * first block is the *contract* the mockup's "Keeps (1:1)" list fixes and the ticket's second
 * acceptance criterion repeats — same five steps, same completion derivation, same
 * `ade.dashboard.firstRunChecklist.dismissed` key — asserted through the new markup so a future
 * re-skin cannot quietly drop one. The second block covers what HIVE-4.6 added: exactly one step
 * marked "Next" and carrying the only button, and the finished card offering Browse.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// next/link → plain anchor so the component renders without app-router context.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { FirstRunChecklist } from '@/app/components/ade/dashboard/FirstRunChecklist';
import { FIRST_RUN_DISMISS_KEY, TOTAL_STEPS } from '@/app/components/ade/dashboard/firstRunChecklist';

const EMPTY = { total_projects: 0, total_classes: 0, total_versions: 0, published_versions: 0 };
const SEEDED = { total_projects: 1, total_classes: 3, total_versions: 1, published_versions: 1 };
/** Everything but the publish: the state in which "Publish it" is the next step. */
const UNPUBLISHED = { total_projects: 1, total_classes: 3, total_versions: 1, published_versions: 0 };

/** The heading the unfinished card shows — the handle the dismissal assertions use. */
const OPEN_HEADING = 'Get to your first published spec';

beforeEach(() => {
  window.localStorage.clear();
});

describe('FirstRunChecklist — the contract the redesign keeps', () => {
  it('renders all guided steps including the Designer steps', () => {
    render(<FirstRunChecklist stats={EMPTY} />);
    expect(screen.getByText(/Create your first project/)).toBeInTheDocument();
    expect(screen.getByText(/Add a class from a starter template/)).toBeInTheDocument();
    expect(screen.getByText(/Cut a version/)).toBeInTheDocument();
    expect(screen.getByText(/Publish it/)).toBeInTheDocument();
    expect(screen.getByText(/View it in Browse/)).toBeInTheDocument();
  });

  it('shows 0/N progress for an empty tenant', () => {
    render(<FirstRunChecklist stats={EMPTY} />);
    expect(screen.getByText(`0 / ${TOTAL_STEPS} done`)).toBeInTheDocument();
    expect(screen.getByText(OPEN_HEADING)).toBeInTheDocument();
  });

  it('shows N/N and the completed header for a seeded tenant', () => {
    render(<FirstRunChecklist stats={SEEDED} />);
    expect(screen.getByText(`${TOTAL_STEPS} / ${TOTAL_STEPS} done`)).toBeInTheDocument();
    expect(screen.getByText("You're all set")).toBeInTheDocument();
  });

  it('derives each step from the stats it is about', () => {
    render(<FirstRunChecklist stats={UNPUBLISHED} />);
    const step = (id: string) => document.querySelector(`[data-step="${id}"]`);
    expect(step('project')).toHaveClass('home-step--done');
    expect(step('class')).toHaveClass('home-step--done');
    expect(step('version')).toHaveClass('home-step--done');
    expect(step('publish')).not.toHaveClass('home-step--done');
    expect(step('browse')).not.toHaveClass('home-step--done');
  });

  it('dismisses and persists the dismissal under the documented key', async () => {
    render(<FirstRunChecklist stats={EMPTY} />);
    fireEvent.click(screen.getByLabelText('Dismiss getting-started checklist'));
    await waitFor(() => {
      expect(screen.queryByText(OPEN_HEADING)).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(FIRST_RUN_DISMISS_KEY)).toBe('1');
  });

  it('stays hidden when already dismissed', async () => {
    window.localStorage.setItem(FIRST_RUN_DISMISS_KEY, '1');
    render(<FirstRunChecklist stats={EMPTY} />);
    await waitFor(() => {
      expect(screen.queryByText(OPEN_HEADING)).not.toBeInTheDocument();
    });
  });
});

describe('FirstRunChecklist — what HIVE-4.6 added', () => {
  it('marks exactly one step Next, and gives only that step a button', () => {
    render(<FirstRunChecklist stats={UNPUBLISHED} />);

    const next = document.querySelectorAll('.home-step--next');
    expect(next).toHaveLength(1);
    expect(next[0]).toHaveAttribute('data-step', 'publish');
    expect(screen.getByText('Next')).toBeInTheDocument();

    // One link inside the step grid, on the Next step, pointing at the route that step is about.
    const stepLinks = document.querySelectorAll('.home-steps a');
    expect(stepLinks).toHaveLength(1);
    expect(stepLinks[0]).toHaveAttribute('href', '/ade/dashboard/versions');
  });

  it('marks the first step Next on an empty tenant', () => {
    render(<FirstRunChecklist stats={EMPTY} />);
    const next = document.querySelectorAll('.home-step--next');
    expect(next).toHaveLength(1);
    expect(next[0]).toHaveAttribute('data-step', 'project');
  });

  it('marks no step Next once every step is done', () => {
    render(<FirstRunChecklist stats={SEEDED} />);
    expect(document.querySelectorAll('.home-step--next')).toHaveLength(0);
    expect(screen.queryByText('Next')).not.toBeInTheDocument();
  });

  it('offers Browse in a new tab once the path is finished', () => {
    render(<FirstRunChecklist stats={SEEDED} />);
    const browse = screen.getByRole('link', { name: /Open Browse/ });
    expect(browse).toHaveAttribute('target', '_blank');
    expect(browse).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('does not offer Browse while steps remain', () => {
    render(<FirstRunChecklist stats={UNPUBLISHED} />);
    expect(screen.queryByRole('link', { name: /Open Browse/ })).not.toBeInTheDocument();
  });

  it('draws one hex cell per step, filled up to the completed count', () => {
    render(<FirstRunChecklist stats={UNPUBLISHED} />);
    const cells = document.querySelectorAll('.home-hex__cell');
    expect(cells).toHaveLength(TOTAL_STEPS);
    expect(document.querySelectorAll('.home-hex__cell[data-on="true"]')).toHaveLength(3);
  });

  it('hides the hex progress from assistive tech, which reads the badge instead', () => {
    render(<FirstRunChecklist stats={UNPUBLISHED} />);
    const hex = document.querySelector('.home-hex');
    expect(hex).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(`3 / ${TOTAL_STEPS} done`)).toBeInTheDocument();
  });
});
