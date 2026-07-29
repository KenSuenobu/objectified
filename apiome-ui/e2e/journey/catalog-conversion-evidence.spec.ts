/**
 * Catalog detail → projection graph → committed evidence e2e (CPDO-4.1, #4804).
 *
 * The end-to-end acceptance criterion of the CPDO roadmap, driven through the real app + REST +
 * Postgres with a mocked OAuth provider: a user imports a multi-group X12 interchange from the
 * shared examples corpus, inspects its **native** structure on the Format details tab, opens
 * **Convert to OpenAPI** and reads the projection graph's synchronized table and evidence drawer,
 * commits the conversion, and then finds the exact evidence snapshot they approved — same manifest
 * hash — replayed from the Conversions history tab (CPDO-3.3's stored snapshot, never a rebuild).
 *
 * Stack contract is identical to the other journey specs (`playwright.journey.config.ts` brings up
 * the mock provider + a dev server; REST + Postgres must already be up). Self-contained: it seeds
 * its own persona, imports its own fixture (unique slug per run, so re-runs on a shared stack are
 * independent), and never depends on the other journeys.
 *
 * The imported payload is `edi-x12/04-multi-group-po-ack.edi`, selected from the corpus manifest
 * by tag — the same fixture the apiome-rest analysis/conversion goldens and the UI/CLI parity
 * fixtures pin, so every layer of CPDO-4.1 describes one interchange.
 */
import { test, expect, type Page } from '@playwright/test';
import { loadCorpus, readCorpusFile } from '../../lib/corpus/corpus';
import { setMockPersona, type MockPersona } from './support/mock-oauth';
import { closeDb, seedMultiTenantFixture, MULTITENANT_FIXTURE } from './support/db';

const { user } = MULTITENANT_FIXTURE;

/**
 * Grace again (owner of Aurora Labs in the seeded fixture). The provider id is the SAME one the
 * multitenant spec asserts — a persona's provider identity is a property of the persona, and a
 * user can hold only one GitHub link, so a second id would be refused as `provider-already-linked`
 * on any stack where another journey already signed her in.
 */
const PERSONA: MockPersona = {
  email: user.email,
  name: user.name,
  login: 'grace-hopper',
  providerUserId: '900000004221',
  verified: true,
};

/** The corpus entry under test, selected by manifest tag (never by hard-coded path). */
const CORPUS_ENTRY = (() => {
  const matches = loadCorpus({ format: 'edix12', feature: 'multi-functional-group' });
  if (matches.length !== 1) {
    throw new Error(`expected one multi-functional-group edix12 fixture, found ${matches.length}`);
  }
  return matches[0];
})();

/** Unique per run so re-runs against a shared local stack never collide. */
const PROJECT_SLUG = `cpdo-e2e-${Date.now()}`;

// Shared across the serial steps below.
let itemId: string | null = null;
let previewSnapshotHash: string | null = null;

async function login(page: Page): Promise<void> {
  await page.context().clearCookies();
  await setMockPersona(PERSONA);
  await page.goto('/login');
  await page.getByRole('button', { name: /continue with github/i }).click();
  await page.waitForURL(/\/ade/, { timeout: 60_000 });
}

async function gotoItem(page: Page, tab?: string): Promise<void> {
  expect(itemId, 'a previous step must have imported the catalog item').not.toBeNull();
  const suffix = tab ? `?tab=${tab}` : '';
  await page.goto(`/ade/dashboard/catalog/${itemId}${suffix}`);
}

/** Read the full manifest hash off the projection panel's snapshot chip (title carries it). */
async function snapshotHash(page: Page): Promise<string> {
  const chip = page.getByTestId('conversion-projection-snapshot');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  const title = await chip.getAttribute('title');
  const match = title?.match(/([0-9a-f]{64})/);
  expect(match, `snapshot chip title should carry the full hash, got: ${title}`).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

/** Open the Convert dialog and switch to its Projection graph tab. */
async function openProjectionTab(page: Page): Promise<void> {
  await page.getByTestId('catalog-detail-convert').click();
  await expect(page.getByTestId('conversion-tier-pill')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('conversion-tab-projection').click();
  await expect(page.getByTestId('conversion-projection-panel')).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedMultiTenantFixture();
});

test.afterAll(async () => {
  await closeDb();
});

test.describe('CPDO-4.1 — detail → projection graph → committed evidence', () => {
  test('imports the multi-group X12 corpus fixture into the catalog', async ({ page }) => {
    await login(page);

    // Start the store-raw import through the app's own proxy (the wizard's transport), with the
    // session the UI login established.
    const start = await page.request.post('/api/catalog/import', {
      data: {
        filename: CORPUS_ENTRY.path.split('/').at(-1),
        document_base64: Buffer.from(readCorpusFile(CORPUS_ENTRY), 'utf-8').toString('base64'),
        metadata: {
          source_kind: 'edix12',
          project: { name: 'CPDO e2e multi-group PO/ack', slug: PROJECT_SLUG },
          version: { version_id: '1.0.0' },
          options: {},
        },
      },
    });
    expect(start.ok(), await start.text()).toBeTruthy();
    const { job_id: jobId } = await start.json();
    expect(jobId).toBeTruthy();

    // Poll to a terminal state; the job persists the catalog item and reports its id.
    let result: { project_id?: string } | null = null;
    await expect
      .poll(
        async () => {
          const poll = await page.request.get(`/api/catalog/import/${jobId}`);
          const body = await poll.json();
          if (body.state === 'completed') {
            result = body.result ?? null;
            return 'completed';
          }
          if (['failed', 'canceled', 'rolled-back', 'not-found'].includes(body.state)) {
            throw new Error(`import job ended ${body.state}: ${JSON.stringify(body.error)}`);
          }
          return body.state;
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe('completed');

    itemId = result!.project_id ?? null;
    expect(itemId, 'the completed import must name the catalog item it created').toBeTruthy();
  });

  test('format details tab shows the whole native interchange', async ({ page }) => {
    await login(page);
    await gotoItem(page, 'format');

    await expect(page.getByTestId('catalog-detail-pane-format')).toBeVisible();
    // The generic analysis tree renders from the stored record…
    await expect(page.getByRole('tree')).toBeVisible({ timeout: 30_000 });
    // …and the X12 inspector shows BOTH functional groups — the native detail the canonical
    // model's first-group projection drops, which is what the stored analysis exists to keep.
    await expect(page.getByTestId('catalog-x12-inspector')).toBeVisible();
    await expect(page.getByTestId('x12-functional-group')).toHaveCount(2);
  });

  test('projection graph, table, and evidence drawer explain the conversion', async ({ page }) => {
    await login(page);
    await gotoItem(page);
    await openProjectionTab(page);

    previewSnapshotHash = await snapshotHash(page);

    // The synchronized table (the accessibility source of truth) renders rows, and selecting one
    // opens the evidence drawer with its status/reason evidence.
    const rows = page.locator('[data-testid^="conversion-projection-table-row-"]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await rows.first().getByRole('button').click();
    await expect(page.getByTestId('conversion-projection-evidence')).toBeVisible();
    await page.getByTestId('conversion-projection-evidence-close').click();
    await expect(page.getByTestId('conversion-projection-evidence')).toBeHidden();
  });

  test('committing preserves the approved evidence in the conversion history', async ({ page }) => {
    await login(page);
    await gotoItem(page);

    // Convert for real, acknowledging the incomplete result if the tier requires it.
    await page.getByTestId('catalog-detail-convert').click();
    await expect(page.getByTestId('conversion-tier-pill')).toBeVisible({ timeout: 60_000 });
    const ack = page.getByTestId('conversion-ack');
    if (await ack.isVisible()) {
      await ack.check();
    }
    await page.getByTestId('conversion-convert-btn').click();
    await expect(page.getByTestId('catalog-detail-converted')).toBeVisible({ timeout: 60_000 });

    // The Conversions tab lists the commit with its evidence snapshot chip…
    await gotoItem(page, 'conversions');
    await expect(page.getByTestId('conversion-history-panel')).toBeVisible({ timeout: 30_000 });
    const list = page.getByTestId('conversion-history-list');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('conversion-history-snapshot-chip').first()).toBeVisible();

    // …and opening the row replays the STORED snapshot: historic evidence, not a fresh preview,
    // carrying exactly the manifest hash the user approved in the preview step.
    await list.getByRole('button').first().click();
    await expect(page.getByTestId('conversion-history-historic-note')).toBeVisible();
    const storedHash = await snapshotHash(page);
    expect(previewSnapshotHash, 'the preview step must have recorded its hash').not.toBeNull();
    expect(storedHash).toBe(previewSnapshotHash);
  });
});
