import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { testUsers } from './fixtures/test-fixtures';

/**
 * Import button on the Versions list screen (#5260).
 *
 * The header offers the same importer the Projects screen does, so a new import can be started
 * without backtracking. REST responses are mocked so this needs neither real projects nor a live
 * import pipeline — the assertions are about the control's placement and the dialog it opens.
 */

const PROJECT_ID = 'proj-e2e-import';
const REVISION_ID = 'rev-e2e-import-1';

async function setupVersionsRouteMocks(page: Page) {
  /** Ensures the Versions page does not block on an empty `current_tenant_id` (dev DB may omit it). */
  await page.route('**/api/auth/get-session', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const res = await route.fetch();
    const text = await res.text();
    try {
      const data = JSON.parse(text) as { user?: Record<string, unknown> };
      if (data?.user) {
        if (data.user.current_tenant_id == null) {
          data.user.current_tenant_id = '00000000-0000-0000-0000-00000000e2e2';
        }
        data.user.is_tenant_admin = true;
      }
      await route.fulfill({
        status: res.status(),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch {
      await route.fulfill({ response: res });
    }
  });

  await page.route('**/api/projects?**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        projects: [{ id: PROJECT_ID, name: 'E2E Import', slug: 'e2e-import', publishable: true }],
      }),
    });
  });

  await page.route('**/api/versions?**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        versions: [
          {
            id: REVISION_ID,
            project_id: PROJECT_ID,
            creator_id: 'e2e-creator',
            version_id: '1.0.0',
            shortMessage: 'seed',
            changelog: null,
            enabled: true,
            published: false,
            deleted_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            published_at: null,
            creator_name: 'E2E',
            creator_email: 'e2e@example.com',
          },
        ],
      }),
    });
  });

  await page.route('**/api/database/versions/has-class-schema**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, map: {} }),
    });
  });

  await page.route(`**/api/projects/${PROJECT_ID}/version-branches**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, branches: [] }),
    });
  });

  await page.route(`**/api/projects/${PROJECT_ID}/version-tags**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, tags: [] }),
    });
  });

  /** No registry-contributed adapters: the source grid then shows exactly the built-in cards. */
  await page.route('**/api/import/sources**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, sources: [] }),
    });
  });
}

async function loginAndOpenVersions(page: Page): Promise<boolean> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('you@example.com').fill(testUsers.valid.email);
  await page.locator('input[type="password"]').fill(testUsers.valid.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3000);

  if (page.url().includes('/login')) return false;

  await page.goto('/ade/dashboard/versions');
  await page.waitForLoadState('networkidle');
  return true;
}

test.describe('Versions screen import (mocked APIs)', () => {
  test('Import sits between the project selector and Compare, and opens the importer', async ({
    page,
  }) => {
    await setupVersionsRouteMocks(page);
    if (!(await loginAndOpenVersions(page))) {
      test.skip(true, 'Login failed — skip E2E (seed admin@apiome.dev / 1234)');
      return;
    }

    const importButton = page.getByTestId('versions-import-button');
    await expect(importButton).toBeVisible({ timeout: 15000 });
    await expect(importButton).toBeEnabled();

    // Placement: project selector → Import → Compare, in document order within the page header.
    // Filtered by the button itself so this is the Versions header, not the app-shell TopHeader.
    const versionsHeader = page.locator('header').filter({ has: importButton });
    const order = await versionsHeader.evaluate((header) => {
      const nodes = Array.from(header.querySelectorAll('[role="combobox"], button'));
      return {
        selector: nodes.findIndex((n) => n.getAttribute('role') === 'combobox'),
        importButton: nodes.findIndex(
          (n) => n.getAttribute('data-testid') === 'versions-import-button',
        ),
        compare: nodes.findIndex((n) => n.textContent?.trim() === 'Compare'),
      };
    });
    expect(order.selector).toBeGreaterThanOrEqual(0);
    expect(order.importButton).toBeGreaterThan(order.selector);
    expect(order.compare).toBeGreaterThan(order.importButton);

    await importButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByText('Import Specification', { exact: true })).toBeVisible();

    // `projects` variant: native + generic sources only — the alternative formats stay on Catalog.
    // Each source card is a button labelled with the source name.
    await expect(dialog.getByRole('button', { name: 'File Upload' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'SwaggerHub' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Postman Collection' })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // Cancelling imports nothing, so the screen stays on the project it was showing.
    await expect(page.getByTestId('versions-import-button')).toBeVisible();
  });
});
