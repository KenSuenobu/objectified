import { defineConfig, devices } from '@playwright/test';
import { dotEnvValues } from './e2e/journey/support/env';

/**
 * Playwright configuration for the HIVE-10.1 visual-parity harness (#5337).
 *
 * Runs `e2e/visual/` against a Next.js dev server and the mockups in `docs/mockups/`, which
 * it loads over `file://` and never writes to. Every route in `e2e/visual/routes.ts` is
 * scored against its mockup in design-token space (see `e2e/visual/score.ts` for why that,
 * and not a pixel diff, is the gate), in two themes:
 *
 *   - `light` — the `:root` default, and the project that also owns the theme-swap test and
 *     the harness's own 20 px-regression self-test;
 *   - `dark` — the same eighteen comparisons with `data-theme="dark"` pinned.
 *
 * Run with `yarn test:e2e:visual`; the report lands in `visual-parity-report/<theme>/`
 * (composed by the global teardown) and, per test, in `playwright-report-visual/`.
 *
 * The app under test runs on its own port so a developer's `yarn dev` on :3000 is neither
 * disturbed nor depended on, and boots with a pinned environment: only `GET /login` is ever
 * rendered — the route that compiles the real `globals.css` and needs no session — so no REST
 * API and no Postgres are required to run this suite.
 */
const UI_PORT = Number(process.env.VISUAL_UI_PORT || 3300);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${UI_PORT}`;

/** Env for the app under test: `.env` values, then the pins that keep rendering deterministic. */
function visualServerEnv(): Record<string, string> {
  return {
    ...dotEnvValues(),
    // Stop scripts/run.sh from re-sourcing .env over these pins.
    APIOME_LOAD_DOTENV: '0',
    BETTER_AUTH_URL: BASE_URL,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET || dotEnvValues().BETTER_AUTH_SECRET || 'hive-visual-secret',
    // The beta background is decorative and animated; off, so nothing moves under a screenshot.
    NEXT_PUBLIC_BETA_MODE: '',
  };
}
export default defineConfig({
  testDir: './e2e/visual',
  testMatch: '**/*.spec.ts',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,

  globalTeardown: './e2e/visual/support/global-teardown.ts',

  reporter: [['html', { outputFolder: 'playwright-report-visual', open: 'never' }], ['list']],

  outputDir: 'test-results-visual',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The harness pins `data-theme` itself; a browser-level scheme preference on top of that
    // would only decide what the *mockups* resolve "system" to, which is not what is measured.
    colorScheme: 'light',
  },

  projects: [
    {
      name: 'light',
      use: { ...devices['Desktop Chrome'] },
      metadata: { themeId: 'light', theme: null },
    },
    {
      name: 'dark',
      use: { ...devices['Desktop Chrome'] },
      metadata: { themeId: 'dark', theme: 'dark' },
      // The theme-swap test owns both themes, and the self-test's arithmetic does not depend
      // on the palette; running either again here would only cost time.
      testIgnore: ['**/theme-swap.spec.ts', '**/self-test.spec.ts'],
    },
  ],

  webServer: {
    command: `yarn dev --port ${UI_PORT}`,
    url: `${BASE_URL}/login`,
    env: visualServerEnv(),
    reuseExistingServer: !process.env.CI,
    timeout: 240 * 1000,
  },

  /* Each test navigates twice and screenshots three times, against a dev server. */
  timeout: 120 * 1000,
  expect: {
    timeout: 15 * 1000,
  },
});
