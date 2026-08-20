import { expect, test } from '@playwright/test';

import { parityRoute } from './routes';
import { explainReport } from './score';
import { measureParity } from './support/harness';

/**
 * The harness's self-test (HIVE-10.1, #5337).
 *
 * A parity gate that never fails is a green light wired to nothing, so #5337 asks for proof
 * that a deliberate regression is caught: **"a deliberate 20 px padding regression fails the
 * harness"**. That is exactly what this does — it measures a route that passes, then measures
 * the same route again with 20 px of padding added to every padded box, and asserts the
 * second run falls through the gate.
 *
 * The regression is injected by the collector itself (`CollectConfig.paddingDeltaPx`), into
 * the *app* side only, after the page has loaded and before any box is read: every box that
 * already has padding gets 20 px more. Nothing is written to `docs/mockups/`; the mockups
 * stay read-only input, here as everywhere.
 *
 * Runs in the `light` project only — the arithmetic is the same in every theme, and running
 * it twice would only make the suite slower.
 */

/** The route the self-test regresses: a plain table page, so the result is easy to read. */
const SUBJECT = 'published';

/** The padding, in CSS pixels, #5337 names. */
const REGRESSION_PX = 20;

/**
 * How many points the regression must cost, at the least.
 *
 * The spacing dimension is worth 20 % of the score and a wholesale padding shift takes most
 * of it, so the observed cost is around 6 points. Five is the floor: enough headroom that
 * ordinary measurement noise never trips it, tight enough that a dimension quietly losing
 * its teeth does.
 */
const MINIMUM_SENSITIVITY = 0.05;

test(`a deliberate ${REGRESSION_PX} px padding regression fails the gate`, async ({ page }) => {
  const route = parityRoute(SUBJECT);

  const clean = await measureParity(page, route, { theme: null });
  expect(
    clean.report.passed,
    `the self-test needs a passing baseline:\n${explainReport(clean.report)}`
  ).toBe(true);

  const regressed = await measureParity(page, route, {
    theme: null,
    paddingDeltaPx: REGRESSION_PX,
  });

  expect(
    regressed.report.passed,
    `${REGRESSION_PX} px of card padding went unnoticed:\n${explainReport(regressed.report)}`
  ).toBe(false);
  // Not just "below the gate" — the harness has to *react*. Without this a later change that
  // diluted the spacing dimension could leave the regression scoring 94.9 % and this test
  // would still be green while the harness had stopped being able to see anything.
  expect(
    clean.report.score - regressed.report.score,
    `the regression only cost ${(
      (clean.report.score - regressed.report.score) * 100
    ).toFixed(1)} points; the harness has stopped reacting to spacing`
  ).toBeGreaterThanOrEqual(MINIMUM_SENSITIVITY);
});
