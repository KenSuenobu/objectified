/**
 * The metrics set (HIVE-2.6, #5285) — the bands, and what the five components render.
 *
 * The ticket's claim is not "the app has charts now"; it is that **one table decides what a
 * number looks like**. So this suite is written in two halves that mirror that claim:
 *
 *   1. `metricTiers.ts` measured directly — every band boundary, both polarities of a delta,
 *      and the two guards (`clampPercent`, `meterPercent`) that stop a bad number becoming a
 *      `NaN%` width or a `NaN` `aria-valuenow`. It is React-free, so these are plain assertions
 *      rather than renders.
 *   2. Each component's contract: the tone it resolves, the geometry it emits, and — the
 *      acceptance criterion that is easiest to lose — the *text* it exposes to assistive tech.
 *      A chart that only says "image" has failed even if it draws beautifully.
 *
 * What is deliberately *not* here is anything that needs a cascade: jsdom compiles no CSS, so
 * "the ring is really a ring" and "the tone really repaints on a dark base" live in
 * `tests/hive-metrics-styles.test.ts` (the stylesheet) and `e2e/hive-metrics.spec.ts` (a
 * browser). Asserting a colour from jsdom would only ever assert the class name, which is what
 * the tone tables below already pin.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  clampPercent,
  deltaDirection,
  deltaTone,
  formatDelta,
  Meter,
  METER_CAP_PERCENT,
  METER_WARN_PERCENT,
  meterPercent,
  meterTier,
  METRIC_TONE_INK_CLASS,
  METRIC_TONE_MARK_CLASS,
  METRIC_TONES,
  Progress,
  Ring,
  RING_TIER_UNSCORED,
  RING_TIERS,
  ringTier,
  Sparkline,
  Stat,
  StatGrid,
  type DeltaPolarity,
  type MetricTone,
} from '../src/app/components/ui/metrics';
import { STATUS_TONE_TEXT_CLASS } from '../src/app/components/ui/statusVocabulary';

// ============================================================================
// The tone tables
// ============================================================================

describe('metric tones', () => {
  it('paints every tone through one channel, so a tone cannot be half-defined', () => {
    for (const tone of METRIC_TONES) {
      expect(METRIC_TONE_MARK_CLASS[tone]).toBe(`text-${tone}`);
      expect(METRIC_TONE_INK_CLASS[tone]).toBeTruthy();
    }
    expect(Object.keys(METRIC_TONE_MARK_CLASS).sort()).toEqual([...METRIC_TONES].sort());
    expect(Object.keys(METRIC_TONE_INK_CLASS).sort()).toEqual([...METRIC_TONES].sort());
  });

  it('takes its ink from the status vocabulary rather than opening a second palette', () => {
    // The whole point of HIVE-2.4 was that one state is one colour. A metric that invented its
    // own green would put a ring and the badge beside it out of step again.
    for (const tone of METRIC_TONES) {
      expect(METRIC_TONE_INK_CLASS[tone]).toBe(STATUS_TONE_TEXT_CLASS[tone]);
    }
  });

  it('spells no colour and no ramp step — every class is a Hive token', () => {
    const classes = [
      ...Object.values(METRIC_TONE_MARK_CLASS),
      ...Object.values(METRIC_TONE_INK_CLASS),
    ];
    for (const value of classes) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}/i);
      // `text-red-500`, `dark:text-red-400` — the two shapes of a frozen Tailwind ramp step.
      expect(value).not.toMatch(/-\d{2,3}\b/);
      expect(value).not.toMatch(/\bdark:/);
    }
  });
});

// ============================================================================
// Ring bands
// ============================================================================

describe('ringTier', () => {
  it('lands each band exactly where #5285 puts its boundary', () => {
    // ≥90 ok · 75–89 accent · 60–74 warn · <60 danger.
    expect(ringTier(100).tone).toBe('ok');
    expect(ringTier(90).tone).toBe('ok');
    expect(ringTier(89).tone).toBe('accent');
    expect(ringTier(75).tone).toBe('accent');
    expect(ringTier(74).tone).toBe('warn');
    expect(ringTier(60).tone).toBe('warn');
    expect(ringTier(59).tone).toBe('danger');
    expect(ringTier(0).tone).toBe('danger');
  });

  it('rounds before it bands, so the arc agrees with the printed figure', () => {
    // 89.6 prints as 90, and a ring that printed 90 in the accent band would look like a bug.
    expect(ringTier(89.6).tone).toBe('ok');
    expect(ringTier(89.4).tone).toBe('accent');
  });

  it('clamps out-of-range scores rather than falling off the table', () => {
    expect(ringTier(140).tone).toBe('ok');
    expect(ringTier(-20).tone).toBe('danger');
  });

  it('treats "not measured" as absent, never as measured-and-zero', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ringTier(value as number | null | undefined)).toBe(RING_TIER_UNSCORED);
    }
    // The unscored band is deliberately not `danger`: nothing has gone wrong.
    expect(RING_TIER_UNSCORED.tone).toBe('neutral');
  });

  it('orders its bands best-first and covers the whole scale without a gap', () => {
    const mins = RING_TIERS.map((tier) => tier.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
    expect(mins[mins.length - 1]).toBe(0);
    for (let score = 0; score <= 100; score += 1) {
      expect(ringTier(score)).not.toBe(RING_TIER_UNSCORED);
    }
  });
});

// ============================================================================
// Meter bands
// ============================================================================

describe('meterTier', () => {
  it('turns warn at 80% and danger at the cap — the acceptance criterion', () => {
    expect(meterTier(0)).toBe('accent');
    expect(meterTier(METER_WARN_PERCENT - 1)).toBe('accent');
    expect(meterTier(METER_WARN_PERCENT)).toBe('warn');
    expect(meterTier(METER_CAP_PERCENT - 1)).toBe('warn');
    expect(meterTier(METER_CAP_PERCENT)).toBe('danger');
    expect(meterTier(130)).toBe('danger');
  });

  it('stays quiet below the warn line rather than calling a half-used quota good news', () => {
    expect(meterTier(50)).not.toBe('ok');
  });
});

describe('meterPercent', () => {
  it('rounds to a whole percent so the bar and the printed figure cannot disagree', () => {
    expect(meterPercent(1, 3)).toBe(33);
    expect(meterPercent(2, 3)).toBe(67);
  });

  it('clamps over-use to the cap', () => {
    expect(meterPercent(12, 10)).toBe(100);
  });

  it('reads a quota of zero or less as full, not as empty', () => {
    expect(meterPercent(0, 0)).toBe(100);
    expect(meterPercent(3, -1)).toBe(100);
  });

  it('reads a nonsense usage as zero rather than as a NaN width', () => {
    expect(meterPercent(Number.NaN, 10)).toBe(0);
    expect(meterPercent(-4, 10)).toBe(0);
  });
});

describe('clampPercent', () => {
  it('never returns a value a CSS width or an aria-valuenow could not take', () => {
    expect(clampPercent(42.4)).toBe(42);
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(101)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ============================================================================
// Deltas
// ============================================================================

describe('deltas', () => {
  it('reads a direction off the sign, with zero as flat', () => {
    expect(deltaDirection(5)).toBe('up');
    expect(deltaDirection(-5)).toBe('down');
    expect(deltaDirection(0)).toBe('flat');
    expect(deltaDirection(Number.NaN)).toBe('flat');
  });

  it('congratulates a rise only when the caller wanted one', () => {
    const cases: [Parameters<typeof deltaTone>[0], DeltaPolarity, MetricTone][] = [
      ['up', 'positive', 'ok'],
      ['down', 'positive', 'danger'],
      ['up', 'negative', 'danger'],
      ['down', 'negative', 'ok'],
      ['up', 'neutral', 'neutral'],
      ['down', 'neutral', 'neutral'],
      ['flat', 'positive', 'neutral'],
      ['flat', 'negative', 'neutral'],
    ];
    for (const [direction, polarity, expected] of cases) {
      expect(deltaTone(direction, polarity)).toBe(expected);
    }
  });

  it('prints the typographic minus, so a column of deltas stays aligned', () => {
    expect(formatDelta(12)).toBe('+12');
    expect(formatDelta(-4)).toBe('−4'); // U+2212, not the narrower hyphen-minus
    expect(formatDelta(-4)).not.toBe('-4');
    expect(formatDelta(0)).toBe('0');
    expect(formatDelta(3, '%')).toBe('+3%');
    expect(formatDelta(Number.NaN, '%')).toBe('0%');
  });
});

// ============================================================================
// Ring
// ============================================================================

describe('<Ring>', () => {
  it('is a meter carrying the score, not a picture of one', () => {
    render(<Ring score={84} label="Quality score" />);
    const ring = screen.getByRole('meter', { name: 'Quality score' });
    expect(ring).toHaveAttribute('aria-valuenow', '84');
    expect(ring).toHaveAttribute('aria-valuemin', '0');
    expect(ring).toHaveAttribute('aria-valuemax', '100');
    expect(ring.getAttribute('aria-valuetext')).toContain('84 out of 100');
  });

  it('speaks both halves of the statement — the number and the letter', () => {
    render(<Ring score={84} label="Quality score" />);
    const spoken = screen.getByRole('meter').getAttribute('aria-valuetext') ?? '';
    expect(spoken).toContain('grade B');
    expect(spoken).toContain('good');
  });

  it('resolves its arc from the band, not from the caller', () => {
    const { rerender } = render(<Ring score={94} label="Quality score" />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'ok');
    rerender(<Ring score={84} label="Quality score" />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'accent');
    rerender(<Ring score={68} label="Quality score" />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'warn');
    rerender(<Ring score={42} label="Quality score" />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'danger');
  });

  it('lets a caller pin the tone without touching the value it reports', () => {
    render(<Ring score={42} tone="violet" label="Quality score" />);
    const ring = screen.getByRole('meter');
    expect(ring).toHaveAttribute('data-tone', 'violet');
    expect(ring).toHaveAttribute('aria-valuenow', '42');
  });

  it('prints the score, and the letter when asked for the letter', () => {
    const { rerender, container } = render(<Ring score={84} label="Quality score" />);
    expect(container.querySelector('.hive-ring__figure')).toHaveTextContent('84');
    rerender(<Ring score={84} display="grade" label="Lint grade" />);
    expect(container.querySelector('.hive-ring__figure')).toHaveTextContent('B');
  });

  it('prefers a captured grade over the one it would derive', () => {
    render(<Ring score={84} grade="A-" display="grade" label="Lint grade" />);
    expect(screen.getByRole('meter').querySelector('.hive-ring__figure')).toHaveTextContent('A');
  });

  it('still draws a captured grade when the score behind it was not kept', () => {
    const { container } = render(<Ring score={null} grade="B" display="grade" label="Lint grade" />);
    const ring = screen.getByRole('img', { name: 'Lint grade: grade B' });
    expect(container.querySelector('.hive-ring__figure')).toHaveTextContent('B');
    // No score, so no arc — but the letter is not "absent" either.
    expect(ring.querySelector('.hive-ring__arc')).toBeNull();
    expect(ring).toHaveAttribute('data-scored', 'true');
  });

  it('says "not scored" rather than drawing a zero', () => {
    const { container } = render(<Ring score={null} label="Technical debt" />);
    const ring = screen.getByRole('img', { name: 'Technical debt: not scored' });
    expect(ring).not.toHaveAttribute('aria-valuenow');
    expect(ring).toHaveAttribute('data-scored', 'false');
    expect(container.querySelector('.hive-ring__arc')).toBeNull();
    expect(container.querySelector('.hive-ring__figure')).toHaveTextContent('—');
  });

  it('draws no arc at zero, so a round cap cannot leave a dot that reads as progress', () => {
    const { container } = render(<Ring score={0} label="Quality score" />);
    expect(container.querySelector('.hive-ring__arc')).toBeNull();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });

  it('sweeps the arc in proportion to the score', () => {
    const { container } = render(<Ring score={50} label="Quality score" />);
    const arc = container.querySelector('.hive-ring__arc');
    const dash = Number(arc?.getAttribute('stroke-dasharray'));
    const offset = Number(arc?.getAttribute('stroke-dashoffset'));
    expect(dash).toBeGreaterThan(0);
    expect(offset / dash).toBeCloseTo(0.5, 2);
  });

  it('carries its size as data, so one viewBox serves all three', () => {
    const { container, rerender } = render(<Ring score={84} label="Quality score" size="sm" />);
    const box = () => container.querySelector('svg')?.getAttribute('viewBox');
    expect(screen.getByRole('meter')).toHaveAttribute('data-size', 'sm');
    const smallBox = box();
    rerender(<Ring score={84} label="Quality score" size="lg" />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-size', 'lg');
    expect(box()).toBe(smallBox);
  });

  it('hides its drawing from assistive tech, which reads the meter instead', () => {
    const { container } = render(<Ring score={84} label="Quality score" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden');
  });
});

// ============================================================================
// Sparkline
// ============================================================================

describe('<Sparkline>', () => {
  it('states the numbers its shape stands in for', () => {
    render(<Sparkline data={[4, 6, 5, 9, 18]} label="Mock requests, last 30 days" />);
    const chart = screen.getByRole('img');
    const name = chart.getAttribute('aria-label') ?? '';
    expect(name).toContain('Mock requests, last 30 days');
    expect(name).toContain('5 points');
    expect(name).toContain('latest 18');
    expect(name).toContain('high 18');
    expect(name).toContain('low 4');
  });

  it('says a flat series is steady rather than reciting a range of nothing', () => {
    render(<Sparkline data={[7, 7, 7]} label="Latency" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('steady at 7');
  });

  it('renders an empty series as "no data" rather than crashing or drawing a line', () => {
    const { container } = render(<Sparkline data={[]} label="Mock requests" />);
    expect(screen.getByRole('img', { name: /no data/ })).toBeInTheDocument();
    expect(container.querySelector('.hive-sparkline__line')).toBeNull();
    expect(container.querySelector('.hive-sparkline__area')).toBeNull();
  });

  it('draws a single reading as a dot — a flat stroke would imply a period of not changing', () => {
    const { container } = render(<Sparkline data={[42]} label="Mock requests" />);
    expect(container.querySelector('.hive-sparkline__point')).toBeInTheDocument();
    expect(container.querySelector('.hive-sparkline__line')).toBeNull();
  });

  it('fills under the line by default and drops the fill on request', () => {
    const { container, rerender } = render(<Sparkline data={[1, 5, 3]} label="Trend" />);
    expect(container.querySelector('.hive-sparkline__area')).toBeInTheDocument();
    rerender(<Sparkline data={[1, 5, 3]} label="Trend" area={false} />);
    expect(container.querySelector('.hive-sparkline__area')).toBeNull();
  });

  it('paints from a token tone, never from a frozen ramp step', () => {
    render(<Sparkline data={[1, 5, 3]} label="Trend" tone="danger" />);
    const chart = screen.getByRole('img');
    expect(chart).toHaveAttribute('data-tone', 'danger');
    expect(chart).toHaveClass('text-danger');
    expect(chart.className.baseVal ?? String(chart.getAttribute('class'))).not.toMatch(/-\d{3}\b/);
  });

  it('scales to its own maximum unless a domain is pinned', () => {
    const free = render(<Sparkline data={[10, 20]} label="Trend" />);
    const freeTop = free.container.querySelector('.hive-sparkline__line')?.getAttribute('d') ?? '';
    free.unmount();
    const pinned = render(<Sparkline data={[10, 20]} label="Trend" domainMax={100} />);
    const pinnedTop =
      pinned.container.querySelector('.hive-sparkline__line')?.getAttribute('d') ?? '';
    // Pinned to 100 the series occupies the bottom fifth; free it fills the box, so the two
    // paths cannot be the same.
    expect(pinnedTop).not.toBe(freeTop);
  });
});

// ============================================================================
// Meter
// ============================================================================

describe('<Meter>', () => {
  it('reports the real pair, not the derived percentage', () => {
    render(<Meter label="Member seats" value={4} max={5} />);
    const meter = screen.getByRole('meter', { name: 'Member seats' });
    expect(meter).toHaveAttribute('aria-valuenow', '4');
    expect(meter).toHaveAttribute('aria-valuemax', '5');
    expect(meter).toHaveAttribute('aria-valuetext', '4 of 5 (80%)');
  });

  it('turns warn at 80% of its quota and danger at the cap', () => {
    const { rerender } = render(<Meter label="Member seats" value={3} max={10} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'accent');
    rerender(<Meter label="Member seats" value={8} max={10} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'warn');
    rerender(<Meter label="Member seats" value={10} max={10} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'danger');
  });

  it('draws the threshold it is heading for, before it gets there', () => {
    const { container } = render(<Meter label="Member seats" value={1} max={10} />);
    const tick = container.querySelector('.hive-progress__tick');
    expect(tick).toBeInTheDocument();
    expect(tick).toHaveStyle({ '--progress-tick': `${METER_WARN_PERCENT}%` });
  });

  it('omits the tick for a meter with no line to cross', () => {
    const { container } = render(<Meter label="Documentation" value={60} warnAt={null} />);
    expect(container.querySelector('.hive-progress__tick')).toBeNull();
  });

  it('lets a score-shaped meter pin its tone, where the usage bands would read backwards', () => {
    render(<Meter label="Documentation score" value={90} tone="ok" />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'ok');
  });

  it('does not stack a progressbar inside the meter for a reader to hear twice', () => {
    render(<Meter label="Member seats" value={4} max={5} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('prints the share, and can hand that job to a caller that prints it elsewhere', () => {
    const { rerender } = render(<Meter label="Member seats" value={4} max={5} />);
    expect(screen.getByRole('meter')).toHaveTextContent('80%');
    rerender(<Meter label="Member seats" value={4} max={5} showValue={false} />);
    expect(screen.getByRole('meter')).not.toHaveTextContent('80%');
  });

  it('shows its label on request without saying it twice to a reader', () => {
    render(<Meter label="Member seats" value={4} max={5} showLabel />);
    const meter = screen.getByRole('meter', { name: 'Member seats' });
    // Visible, but `aria-hidden` — the accessible name already carries it.
    expect(within(meter).getByText('Member seats')).toHaveAttribute('aria-hidden');
  });

  it('takes a percentage directly when there is no pair to report', () => {
    render(<Meter label="Coverage" value={64} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '64%');
  });
});

// ============================================================================
// Progress
// ============================================================================

describe('<Progress>', () => {
  it('is a named progressbar carrying a clamped value', () => {
    render(<Progress value={64} label="Importing operations" />);
    const bar = screen.getByRole('progressbar', { name: 'Importing operations' });
    expect(bar).toHaveAttribute('aria-valuenow', '64');
    expect(bar).toHaveAttribute('aria-valuetext', '64%');
  });

  it('refuses to emit a width or a value a browser could not use', () => {
    const { container } = render(<Progress value={Number.NaN} label="Importing" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(container.querySelector('.hive-progress')).toHaveStyle({ '--progress-value': '0%' });
  });

  it('drives its geometry with a custom property, so the transition stays in the stylesheet', () => {
    const { container } = render(<Progress value={38} label="Importing" />);
    const bar = container.querySelector('.hive-progress');
    expect(bar).toHaveStyle({ '--progress-value': '38%' });
    expect(container.querySelector('.hive-progress__fill')).not.toHaveAttribute('style');
  });

  it('goes silent when an ancestor already owns the semantics', () => {
    const { container } = render(<Progress value={38} decorative />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    const bar = container.querySelector('.hive-progress');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).not.toHaveAttribute('aria-label');
  });

  it('carries its variants as classes, not as inline paint', () => {
    const { container } = render(
      <Progress value={38} label="Exporting" tone="honey" striped thin />,
    );
    const bar = container.querySelector('.hive-progress');
    expect(bar).toHaveClass('hive-progress--thin');
    expect(bar).toHaveClass('hive-progress--striped');
    expect(bar).toHaveClass('text-honey');
    expect(bar).toHaveAttribute('data-tone', 'honey');
  });

  it('ignores a tick that is not inside the track', () => {
    for (const tick of [0, 100, -5, 140, Number.NaN]) {
      const { container, unmount } = render(<Progress value={10} label="x" tick={tick} />);
      expect(container.querySelector('.hive-progress__tick')).toBeNull();
      unmount();
    }
  });
});

// ============================================================================
// Stat / StatGrid
// ============================================================================

describe('<Stat>', () => {
  it('renders the label, the figure, its unit and the footnote', () => {
    render(
      <Stat label="Mean quality" value={84} unit="/ 100" footnote="30-day mean" footnoteEnd="Grade B" />,
    );
    expect(screen.getByText('Mean quality')).toBeInTheDocument();
    expect(screen.getByText('84')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
    expect(screen.getByText('30-day mean')).toBeInTheDocument();
    expect(screen.getByText('Grade B')).toBeInTheDocument();
  });

  it('paints a rise as good news only when the caller said up was good', () => {
    const { container, rerender } = render(<Stat label="Projects" value={128} delta={12} />);
    const delta = () => container.querySelector('.hive-stat__delta');
    expect(delta()).toHaveAttribute('data-direction', 'up');
    expect(delta()).toHaveAttribute('data-tone', 'ok');

    rerender(<Stat label="Open findings" value={37} delta={12} deltaPolarity="negative" />);
    expect(delta()).toHaveAttribute('data-direction', 'up');
    expect(delta()).toHaveAttribute('data-tone', 'danger');
  });

  it('reads a flat delta as no verdict at all', () => {
    const { container } = render(<Stat label="Projects" value={128} delta={0} />);
    const delta = container.querySelector('.hive-stat__delta');
    expect(delta).toHaveAttribute('data-direction', 'flat');
    expect(delta).toHaveAttribute('data-tone', 'neutral');
    expect(delta).toHaveTextContent('0');
  });

  it('omits the chip entirely when there is nothing to compare with', () => {
    const { container } = render(<Stat label="Projects" value={128} />);
    expect(container.querySelector('.hive-stat__delta')).toBeNull();
  });

  it('lets a caller state a change that is not a signed number', () => {
    render(<Stat label="Latency" value="120ms" delta={-8} deltaLabel="8ms faster" />);
    expect(screen.getByText('8ms faster')).toBeInTheDocument();
  });

  it('appends a delta unit without a space, as a figure not a sentence', () => {
    const { container } = render(<Stat label="Coverage" value={64} delta={3} deltaUnit="%" />);
    expect(container.querySelector('.hive-stat__delta')).toHaveTextContent('+3%');
  });

  it('omits the footnote row when neither footnote is given', () => {
    const { container } = render(<Stat label="Projects" value={128} />);
    expect(container.querySelector('.hive-stat__foot')).toBeNull();
  });
});

describe('<StatGrid>', () => {
  it('carries its column count as data, so the collapse rule is CSS and not a prop', () => {
    const { container } = render(
      <StatGrid columns={4}>
        <Stat label="A" value={1} />
      </StatGrid>,
    );
    expect(container.querySelector('.hive-stat-grid')).toHaveAttribute('data-columns', '4');
  });

  it('auto-fits when the caller does not know how many stats there will be', () => {
    const { container } = render(
      <StatGrid>
        <Stat label="A" value={1} />
      </StatGrid>,
    );
    expect(container.querySelector('.hive-stat-grid')).not.toHaveAttribute('data-columns');
  });
});

// ============================================================================
// Voice (DESIGN.md §10)
// ============================================================================

describe('the strings this module ships', () => {
  it('are sentence case and state a fact, not an exclamation', () => {
    const strings = [
      ...RING_TIERS.map((tier) => tier.label),
      RING_TIER_UNSCORED.label,
      // The two composed sentences a reader actually hears.
      (() => {
        render(<Ring score={84} label="Quality score" />);
        return screen.getByRole('meter').getAttribute('aria-valuetext') ?? '';
      })(),
    ];
    for (const value of strings) {
      expect(value).not.toMatch(/!$/);
      expect(value).not.toMatch(/\b[A-Z]{2,}\b/); // no SHOUTING
      expect(value.trim()).toBe(value);
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
