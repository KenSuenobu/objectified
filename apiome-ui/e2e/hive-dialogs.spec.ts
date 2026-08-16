import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The imperative dialogs, measured in a browser (HIVE-2.7, #5286).
 *
 * `tests/hive-dialogs.test.tsx` pins what the components render and what `useDialog()`
 * resolves. What jsdom cannot answer is everything the acceptance criteria are actually
 * about, because it neither compiles CSS nor implements a focus ring:
 *
 *   • focus is really **trapped** inside the overlay and really **restored** to the control
 *     that opened it — the two halves of the definition of done that the native boxes got
 *     for free and a hand-rolled `<div role="dialog">` does not;
 *   • `Esc` really closes an idle dialog and really **does not** close one with a request in
 *     flight;
 *   • the destructive primary is really **red**, resolved from the token rather than from a
 *     frozen hex, and it really re-tints when the theme changes;
 *   • the type-to-confirm gate really keeps the button **disabled** until the phrase matches,
 *     through a real keyboard;
 *   • axe finds nothing serious with each dialog open — the state the sibling suites cannot
 *     reach, because they only ever screenshot the page behind it.
 *
 * Runs against `/design-system/hive#dialogs` — the gallery route, which needs no session and
 * no data. Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default
 * `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The section this ticket owns; the rest of the gallery belongs to its siblings. */
const OWNED_SECTION = '#dialogs';

/**
 * The blocking half of an axe run.
 *
 * @param violations Everything axe reported.
 * @returns Only the serious and critical entries, which is what DESIGN.md §6 forbids.
 */
function blockingViolations<T extends { impact?: string | null }>(violations: T[]): T[] {
  return violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''));
}

/**
 * Load the gallery at a desktop width, with motion frozen.
 *
 * Nothing here is a claim about animation, and Radix's open/close transitions otherwise make
 * every focus assertion a race.
 *
 * @param page The page under test.
 */
async function openGallery(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/design-system/hive');
  await page.waitForLoadState('networkidle');
  await page.locator(OWNED_SECTION).scrollIntoViewIfNeeded();
}

/** The section's trigger buttons, by their gallery labels. */
const TRIGGER = {
  destructive: 'Destructive confirm',
  gated: 'Type-to-confirm',
  ordinary: 'Ordinary confirm',
  failing: 'Confirm that fails',
  prompt: 'Prompt',
  validated: 'Prompt with validation',
  alert: 'Alert',
} as const;

/**
 * Press one of the section's triggers.
 *
 * @param page The page under test.
 * @param label The trigger's label.
 */
async function openDialog(page: Page, label: string): Promise<void> {
  await page.locator(OWNED_SECTION).getByRole('button', { name: label, exact: true }).click();
}

/** What the gallery last recorded the awaited call resolving to. */
function outcome(page: Page) {
  return page.getByTestId('dialog-outcome');
}

test.describe('the Hive imperative dialogs', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test.describe('a destructive confirm', () => {
    test('names its object, states the consequence and labels the button with a verb', async ({
      page,
    }) => {
      await openDialog(page, TRIGGER.destructive);
      const dialog = page.getByRole('alertdialog');

      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Delete role "Release manager"?')).toBeVisible();
      await expect(
        dialog.getByText('Members holding this role lose its permissions immediately.')
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Delete role' })).toBeVisible();
      // DESIGN.md §8's copy rule: buttons are verbs, never "OK".
      await expect(dialog.getByRole('button', { name: 'OK' })).toHaveCount(0);
    });

    test('draws its primary in the danger token, not a frozen red', async ({ page }) => {
      await openDialog(page, TRIGGER.destructive);
      const action = page.getByRole('alertdialog').getByRole('button', { name: 'Delete role' });

      const painted = await action.evaluate((element) => getComputedStyle(element).backgroundColor);

      // What `--danger` resolves to right here, measured by a probe rather than read off the
      // custom property, so the comparison is between two resolved `rgb()` strings.
      const dangerToken = await action.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--danger)';
        element.append(probe);
        const resolved = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return resolved;
      });

      expect(dangerToken).toMatch(/^rgb/);
      expect(painted).toBe(dangerToken);
    });

    test('re-tints when the theme changes, which a hex literal could not', async ({ page }) => {
      await openDialog(page, TRIGGER.destructive);
      const action = page.getByRole('alertdialog').getByRole('button', { name: 'Delete role' });
      const light = await action.evaluate((el) => getComputedStyle(el).backgroundColor);

      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.documentElement.classList.add('dark');
      });
      const dark = await action.evaluate((el) => getComputedStyle(el).backgroundColor);

      expect(dark).not.toBe(light);

      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        document.documentElement.classList.remove('dark');
      });
    });

    test('reports the confirm back to the caller', async ({ page }) => {
      await openDialog(page, TRIGGER.destructive);
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete role' }).click();
      await expect(outcome(page)).toHaveText('Role deleted.');
    });

    test('reports the cancel back to the caller', async ({ page }) => {
      await openDialog(page, TRIGGER.destructive);
      await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(outcome(page)).toHaveText('Cancelled.');
    });
  });

  test.describe('focus', () => {
    test('opens on the safe action, so the destructive one is never under the hands', async ({
      page,
    }) => {
      await openDialog(page, TRIGGER.destructive);
      await expect(page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
    });

    test('is trapped: tabbing round the dialog never reaches the page behind it', async ({
      page,
    }) => {
      await openDialog(page, TRIGGER.destructive);
      const dialog = page.getByRole('alertdialog');

      for (let press = 0; press < 8; press += 1) {
        await page.keyboard.press('Tab');
        const inside = await dialog.evaluate((element) =>
          element.contains(document.activeElement)
        );
        expect(inside).toBe(true);
      }
    });

    test('returns to the trigger when the dialog closes', async ({ page }) => {
      const trigger = page
        .locator(OWNED_SECTION)
        .getByRole('button', { name: TRIGGER.destructive, exact: true });
      await trigger.click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(trigger).toBeFocused();
    });

    test('starts in the field on a prompt, since that is what has to be typed into', async ({
      page,
    }) => {
      await openDialog(page, TRIGGER.prompt);
      await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
    });

    test('starts in the gate on a type-to-confirm, for the same reason', async ({ page }) => {
      await openDialog(page, TRIGGER.gated);
      await expect(page.getByRole('alertdialog').getByRole('textbox')).toBeFocused();
    });
  });

  test.describe('the type-to-confirm gate', () => {
    test('holds the primary disabled until the object’s name is typed exactly', async ({
      page,
    }) => {
      await openDialog(page, TRIGGER.gated);
      const dialog = page.getByRole('alertdialog');
      const action = dialog.getByRole('button', { name: 'Delete tenant' });
      const gate = dialog.getByRole('textbox');

      await expect(action).toBeDisabled();

      await gate.fill('acme corp');
      await expect(action).toBeDisabled();

      await gate.fill('Acme Corp');
      await expect(action).toBeEnabled();

      await action.click();
      await expect(outcome(page)).toHaveText('Tenant deleted.');
    });

    test('says out loud that the action is permanent', async ({ page }) => {
      await openDialog(page, TRIGGER.gated);
      await expect(
        page.getByRole('alertdialog').getByText('This is permanent and cannot be undone.')
      ).toBeVisible();
    });
  });

  test.describe('Esc', () => {
    test('dismisses an idle confirm', async ({ page }) => {
      await openDialog(page, TRIGGER.ordinary);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(outcome(page)).toHaveText('Cancelled.');
    });

    test('dismisses an idle prompt', async ({ page }) => {
      await openDialog(page, TRIGGER.prompt);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(outcome(page)).toHaveText('Cancelled.');
    });

    test('is refused while a request is in flight', async ({ page }) => {
      await openDialog(page, TRIGGER.failing);
      const dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Delete tenant' }).click();

      // The gallery's `perform` takes 600 ms and then throws, so this lands mid-flight.
      await expect(dialog.getByRole('button', { name: /Delete tenant/ })).toHaveAttribute(
        'aria-busy',
        'true'
      );
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();

      // …and once it fails, the dialog stays with the error rather than closing.
      await expect(dialog.getByText('The tenant still owns 3 projects.')).toBeVisible();
      await expect(dialog).toBeVisible();

      // The reader can still back out, which resolves the awaited call.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(outcome(page)).toHaveText('Cancelled.');
    });
  });

  test.describe('the prompt', () => {
    test('shows a labelled field with a hint, not an unlabelled line', async ({ page }) => {
      await openDialog(page, TRIGGER.prompt);
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('textbox')).toHaveAccessibleName('Role name');
      await expect(dialog.locator('label').filter({ hasText: 'Role name' })).toBeVisible();
      await expect(
        dialog.getByText('Members see this name when their access is assigned.')
      ).toBeVisible();
    });

    test('returns the trimmed value to the caller', async ({ page }) => {
      await openDialog(page, TRIGGER.prompt);
      await page.getByRole('dialog').getByRole('textbox').fill('  Release manager  ');
      await page.getByRole('dialog').getByRole('button', { name: 'Create role' }).click();
      await expect(outcome(page)).toHaveText('Created "Release manager".');
    });

    test('submits on Enter, the way the box it replaces did', async ({ page }) => {
      await openDialog(page, TRIGGER.prompt);
      await page.getByRole('dialog').getByRole('textbox').fill('Release manager');
      await page.keyboard.press('Enter');
      await expect(outcome(page)).toHaveText('Created "Release manager".');
    });

    test('refuses an empty answer and names the missing field', async ({ page }) => {
      await openDialog(page, TRIGGER.prompt);
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Create role' }).click();
      await expect(dialog.getByText('Role name is required.')).toBeVisible();
      await expect(dialog).toBeVisible();
    });

    test('runs the caller’s validation and keeps the dialog open', async ({ page }) => {
      await openDialog(page, TRIGGER.validated);
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Rename collection' }).click();
      await expect(
        dialog.getByText('That is already the name of this collection.')
      ).toBeVisible();

      await dialog.getByRole('textbox').fill('Payments v2');
      await dialog.getByRole('button', { name: 'Rename collection' }).click();
      await expect(outcome(page)).toHaveText('Renamed to "Payments v2".');
    });
  });

  test.describe('accessibility', () => {
    test('the section itself has no serious or critical violations', async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .include(OWNED_SECTION)
        .withTags(WCAG_TAGS)
        .analyze();
      expect(blockingViolations(results.violations)).toEqual([]);
    });

    for (const [key, label] of Object.entries(TRIGGER)) {
      test(`the ${key} dialog has no serious or critical violations`, async ({ page }) => {
        await openDialog(page, label);
        // Scoped to the dialog itself, not the document: the dialog is portalled to
        // `<body>`, and the gallery behind it carries its siblings' specimens — whose
        // contrast is their tickets' business, not this one's.
        const results = await new AxeBuilder({ page })
          .include('[role="alertdialog"], [role="dialog"]')
          .withTags(WCAG_TAGS)
          .analyze();
        expect(blockingViolations(results.violations)).toEqual([]);
      });
    }

    test('the confirm is announced as an alert dialog that names and describes itself', async ({
      page,
    }) => {
      await openDialog(page, TRIGGER.destructive);
      const dialog = page.getByRole('alertdialog');

      // `alertdialog` rather than `dialog` is the point: a screen reader announces the
      // question on open instead of waiting to be asked what the panel is.
      await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);
      await expect(dialog).toHaveAttribute('aria-describedby', /.+/);
      await expect(dialog).toHaveAccessibleName('Delete role "Release manager"?');
    });
  });

  test('does not force the document sideways at 1280 px', async ({ page }) => {
    await openDialog(page, TRIGGER.gated);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
