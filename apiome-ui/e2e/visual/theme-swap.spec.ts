import { expect, test } from '@playwright/test';

import { LANDMARK_IDS } from './landmarks';
import { PARITY_ROUTES } from './routes';
import { collectSide, mountFixtureMarkup, pinAppearance, readFixture } from './support/harness';

/**
 * Geometry is the same in every theme (HIVE-10.1, #5337).
 *
 * A theme in this design system is a *token swap* and nothing else — DESIGN.md §2 — so
 * switching one may repaint the page but must never move it. This is the ticket's theme-swap
 * test: every route's page is mounted once, measured light, switched to dark in place, and
 * measured again; every page-chrome landmark must sit in exactly the same place.
 *
 * It swaps the theme on an already-mounted page rather than reloading, because that is the
 * only way to be sure nothing but the token layer changed between the two measurements.
 *
 * Runs in the `light` project only: it owns both themes itself.
 */

/** The width the pages are mounted at — a desktop page beside the rail. */
const PAGE_WIDTH = 1200;

/** Landmark boxes are read to two decimals, so this is "the same pixel". */
const GEOMETRY_EPSILON = 0.02;

test('every page keeps its geometry when the theme changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  const drifted: string[] = [];

  for (const route of PARITY_ROUTES) {
    if (route.subject.kind !== 'fixture') continue;
    await mountFixtureMarkup(
      page,
      readFixture(route.subject.dir, route.subject.file),
      PAGE_WIDTH
    );

    await pinAppearance(page, null);
    const light = await collectSide(page, 'app');

    await pinAppearance(page, 'dark');
    const dark = await collectSide(page, 'app');

    for (const id of LANDMARK_IDS) {
      const before = light.landmarks[id];
      const after = dark.landmarks[id];
      if (!before.present || !after.present) {
        if (before.present !== after.present) {
          drifted.push(`${route.id}: the ${id} landmark appears in only one theme`);
        }
        continue;
      }
      if (
        Math.abs(before.x - after.x) > GEOMETRY_EPSILON ||
        Math.abs(before.width - after.width) > GEOMETRY_EPSILON
      ) {
        drifted.push(
          `${route.id}: the ${id} landmark moves between themes ` +
            `(light x=${before.x.toFixed(4)} w=${before.width.toFixed(4)}, ` +
            `dark x=${after.x.toFixed(4)} w=${after.width.toFixed(4)})`
        );
      }
    }
  }

  expect(drifted, drifted.join('\n')).toEqual([]);
});
