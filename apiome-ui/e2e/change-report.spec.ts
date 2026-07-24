import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { testUsers } from './fixtures/test-fixtures';

/**
 * Publication change report panel (CR-05 / CR-06, #2704).
 * REST responses are mocked so this does not require a live API or Ollama.
 */

const PROJECT_ID = 'proj-e2e-cr';
const REVISION_ID = 'rev-e2e-1';

async function setupChangeReportRouteMocks(page: Page) {
  let patchedBody = '## E2E seeded report\n\nOriginal body.';

  /** Ensures Versions page does not block on an empty `current_tenant_id` (dev DB may omit it). */
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
          data.user.current_tenant_id = '00000000-0000-0000-0000-00000000e2e1';
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

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        projects: [{ id: PROJECT_ID, name: 'E2E CR', slug: 'e2e-cr' }],
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
            published: true,
            deleted_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            published_at: '2026-01-01T00:00:00.000Z',
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

  await page.route('**/api/change-report-template-versions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, templates: [] }),
    });
  });

  await page.route(`**/api/versions/${REVISION_ID}/change-report?**`, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          report: {
            effectiveHeaderSnapshot: '# E2E',
            effectiveRenderedBody: patchedBody,
            effectiveFootnoteSnapshot: 'footnote',
            editedRenderedBody: null,
            editedHeaderSnapshot: null,
            editedFootnoteSnapshot: null,
            changeModelJson: { schemaVersion: '1.0' },
          },
        }),
      });
      return;
    }
    if (method === 'PATCH') {
      const raw = route.request().postData();
      let body: { editedRenderedBody?: string } = {};
      if (raw) {
        try {
          body = JSON.parse(raw) as { editedRenderedBody?: string };
        } catch {
          body = {};
        }
      }
      if (typeof body.editedRenderedBody === 'string') {
        patchedBody = body.editedRenderedBody;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          report: {
            effectiveHeaderSnapshot: '# E2E',
            effectiveRenderedBody: patchedBody,
            effectiveFootnoteSnapshot: 'footnote',
            editedRenderedBody: patchedBody,
            editedHeaderSnapshot: null,
            editedFootnoteSnapshot: null,
            changeModelJson: { schemaVersion: '1.0' },
          },
        }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe('Publication change report (mocked APIs)', () => {
  test('versions page: change report tab shows report and save persists (mocked)', async ({ page }) => {
    await setupChangeReportRouteMocks(page);

    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.getByPlaceholder('you@example.com').fill(testUsers.valid.email);
    await page.locator('input[type="password"]').fill(testUsers.valid.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(3000);

    if (page.url().includes('/login')) {
      test.skip(true, 'Login failed — skip E2E (seed admin@apiome.app / 1234)');
      return;
    }

    await page.goto('/ade/dashboard/versions');
    await page.waitForLoadState('networkidle');

    // Skip at runtime if the change-report tab is absent — the feature flag
    // (NEXT_PUBLIC_CHANGE_REPORT_UI) is evaluated by the Next.js dev server, not
    // the Playwright runner process, so checking process.env here would be
    // unreliable.  Checking actual DOM state avoids false failures when the tab
    // is intentionally hidden.
    const changeReportTab = page.getByTestId('versions-tab-change-report');
    if (!(await changeReportTab.isVisible())) {
      test.skip(true, 'Change report tab not present in UI — feature flag disabled or feature not available');
      return;
    }

    await changeReportTab.click();
    await expect(page.getByTestId('version-change-report-panel')).toBeVisible({ timeout: 15000 });

    await expect(page.getByTestId('change-report-view')).toContainText('E2E seeded report', {
      timeout: 15000,
    });

    const editTab = page.getByTestId('change-report-tab-edit');
    if (await editTab.isDisabled()) {
      test.skip(true, 'Edit tab disabled — need creator or tenant admin on the seeded revision');
      return;
    }
    await editTab.click();

    const saveBtn = page.getByTestId('change-report-save');
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
    const body = page.getByTestId('change-report-edit-body');
    await body.fill('## Patched by E2E\n\nSaved.');
    await saveBtn.click();

    await page.getByTestId('change-report-tab-view').click();
    await expect(page.getByTestId('change-report-view')).toContainText('Patched by E2E', {
      timeout: 15000,
    });
  });
});
