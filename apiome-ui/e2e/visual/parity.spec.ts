import { expect, test } from '@playwright/test';

import { PARITY_ROUTES } from './routes';
import { PARITY_GATE, explainReport } from './score';
import { writeRouteArtefact } from './support/artefacts';
import { measureParity } from './support/harness';

/**
 * The visual-parity gate (HIVE-10.1, #5337).
 *
 * One test per route map entry: the mockup is rendered, the app's page is rendered at the
 * same width, both are reduced to a design-token signature, and the two are scored along the
 * eight dimensions `score.ts` documents. The gate is the ticket's **95 %**.
 *
 * What each test leaves behind — the verdict as JSON, the two screenshots and their
 * difference — is written under `visual-parity-report/<theme>/`, which the global teardown
 * composes into one page per theme and CI uploads. So a reviewer never has to take the number
 * on trust: the images are there to look at, and the report lists exactly which dimension
 * lost which marks.
 *
 * Runs twice, once per Playwright project: `light` and `dark`.
 *
 * Requires the app to be running; the config boots one on its own port if there is none.
 */

/** The theme this project pins, and the directory its artefacts go in. */
function projectTheme(): { id: string; value: string | null } {
  const metadata = test.info().project.metadata as { themeId?: string; theme?: string | null };
  return { id: metadata.themeId ?? 'light', value: metadata.theme ?? null };
}

test.describe('visual parity against the mockups', () => {
  for (const route of PARITY_ROUTES) {
    test(`${route.id} matches ${route.mockup}`, async ({ page }, testInfo) => {
      const theme = projectTheme();
      const { report, images } = await measureParity(page, route, {
        theme: theme.value,
        capture: true,
      });

      writeRouteArtefact(theme.id, report, images);
      if (images) {
        await testInfo.attach(`${route.id}-mockup.png`, {
          body: images.mockup,
          contentType: 'image/png',
        });
        await testInfo.attach(`${route.id}-app.png`, {
          body: images.app,
          contentType: 'image/png',
        });
        await testInfo.attach(`${route.id}-diff.png`, {
          body: images.diff,
          contentType: 'image/png',
        });
      }

      expect(report.score, explainReport(report)).toBeGreaterThanOrEqual(PARITY_GATE);
    });
  }
});
