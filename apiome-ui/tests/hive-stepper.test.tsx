/**
 * The `Stepper` primitive (HIVE-4.4, #5298).
 *
 * `docs/mockups/assets/hive.css` §16 draws the progress row in ten mockups; this is the
 * production one. What the suite pins is the half a stylesheet cannot: which step is
 * marked current, what a screen reader hears in place of the numerals and ticks it is
 * not given, and where the filled run stops.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import { Stepper, stepperStatus, type StepperStep } from '@/app/components/ui/Stepper';

/** The onboarding wizard's own three steps — the first surface to draw one. */
const STEPS: readonly StepperStep[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'organization', label: 'Organization' },
  { id: 'summary', label: 'Review' },
];

/** The steps as list items, in order (the connectors are `aria-hidden`). */
const items = () => within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole('listitem');

/** Every element carrying a connector class, including the hidden ones. */
const connectors = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.step__line'));

describe('stepperStatus — where a step sits', () => {
  it('walks done → current → upcoming across the row', () => {
    expect(stepperStatus(0, 1)).toBe('done');
    expect(stepperStatus(1, 1)).toBe('current');
    expect(stepperStatus(2, 1)).toBe('upcoming');
  });

  it('marks every step done for a finished flow, whatever the current index says', () => {
    // The terminal step of a wizard is past the last step the row shows, so there is no
    // index for it — `complete` is how that state is expressed.
    for (const index of [0, 1, 2]) {
      expect(stepperStatus(index, -1, true)).toBe('done');
    }
  });

  it('marks nothing current when the current id is not in the list', () => {
    expect(stepperStatus(0, -1)).toBe('upcoming');
    expect(stepperStatus(2, -1)).toBe('upcoming');
  });
});

describe('Stepper — the row', () => {
  it('renders one item per step, in order, under the given name', () => {
    render(<Stepper aria-label="Setup progress" steps={STEPS} current="organization" />);

    // `textContent` includes the badge, which `aria-hidden` removes from the a11y tree
    // but not from the DOM — hence the leading numeral on the two steps still showing one.
    expect(items().map((item) => item.textContent)).toEqual([
      'WelcomeCompleted',
      '2OrganizationStep 2 of 3',
      '3ReviewNot started',
    ]);
  });

  it('states `role="list"`, which Safari drops from a marker-less `<ol>`', () => {
    const { container } = render(<Stepper aria-label="Setup progress" steps={STEPS} current="welcome" />);

    const list = container.querySelector('ol');
    expect(list).toHaveAttribute('role', 'list');
  });

  it('marks exactly one step current, and only that one', () => {
    render(<Stepper aria-label="Setup progress" steps={STEPS} current="organization" />);

    const current = items().filter((item) => item.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Organization');
  });

  it('announces the current step’s position, which the numeral alone never did', () => {
    // The badge is `aria-hidden` — it repeats in shape what the list says in structure —
    // so the position has to be spoken somewhere, and this is where.
    render(<Stepper aria-label="Setup progress" steps={STEPS} current="summary" />);

    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    expect(items()[2]).toHaveAttribute('aria-current', 'step');
  });

  it('hides the badge from assistive technology, tick and numeral alike', () => {
    const { container } = render(
      <Stepper aria-label="Setup progress" steps={STEPS} current="organization" />
    );

    const badges = Array.from(container.querySelectorAll('.step__num'));
    expect(badges).toHaveLength(3);
    for (const badge of badges) expect(badge).toHaveAttribute('aria-hidden', 'true');
    // The done step's badge is a tick; the other two are numerals.
    expect(badges[0].querySelector('svg')).toBeInTheDocument();
    expect(badges[1]).toHaveTextContent('2');
    expect(badges[2]).toHaveTextContent('3');
  });

  it('stops the filled run at the reader’s position', () => {
    // A connector is done when the step *behind* it is — which is what makes the row read
    // as distance covered rather than as a decoration between badges.
    const { container } = render(
      <Stepper aria-label="Setup progress" steps={STEPS} current="summary" />
    );

    const lines = connectors(container);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toHaveClass('is-done');
      expect(line).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('fills no connector before the first step is left', () => {
    const { container } = render(
      <Stepper aria-label="Setup progress" steps={STEPS} current="welcome" />
    );

    expect(connectors(container).map((line) => line.className)).toEqual(['step__line', 'step__line']);
  });

  it('draws every step done — and none current — for a finished flow', () => {
    const { container } = render(
      <Stepper aria-label="Setup progress" steps={STEPS} current="welcome" complete />
    );

    expect(items().every((item) => item.dataset.status === 'done')).toBe(true);
    expect(items().some((item) => item.hasAttribute('aria-current'))).toBe(false);
    expect(connectors(container).every((line) => line.classList.contains('is-done'))).toBe(true);
  });

  it('adds the fill modifier only when asked', () => {
    const { container, rerender } = render(<Stepper aria-label="Setup progress" steps={STEPS} />);
    expect(container.querySelector('ol')).not.toHaveClass('stepper--fill');

    rerender(<Stepper aria-label="Setup progress" steps={STEPS} fill />);
    expect(container.querySelector('ol')).toHaveClass('stepper--fill');
  });

  it('forwards its own class and every other `<ol>` attribute', () => {
    const { container } = render(
      <Stepper aria-label="Setup progress" steps={STEPS} className="mine" id="progress" />
    );

    const list = container.querySelector('ol');
    expect(list).toHaveClass('stepper', 'mine');
    expect(list).toHaveAttribute('id', 'progress');
  });

  it('has no axe violations in any of its three states', async () => {
    for (const props of [
      { current: 'welcome' },
      { current: 'organization' },
      { current: 'welcome', complete: true },
    ]) {
      const { container, unmount } = render(
        <Stepper aria-label="Setup progress" steps={STEPS} fill {...props} />
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
