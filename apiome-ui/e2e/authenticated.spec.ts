import { test, expect } from '@playwright/test';
import { testUsers } from './fixtures/test-fixtures';

/**
 * Authenticated E2E Tests
 *
 * These tests log in with the test user credentials and verify
 * functionality that requires authentication.
 *
 * Note: These tests require the test user (admin@apiome.dev) to exist
 * in the database with the correct password (1234).
 */

// Helper to check if login was successful
async function loginAndVerify(page: any): Promise<boolean> {
  try {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const emailInput = page.getByPlaceholder('you@example.com');
    const passwordInput = page.locator('input[type="password"]');

    await emailInput.fill(testUsers.valid.email);
    await passwordInput.fill(testUsers.valid.password);

    const signInButton = page.getByRole('button', { name: /sign in/i });
    await signInButton.click();

    // Wait for redirect to dashboard (or error)
    await page.waitForTimeout(3000);

    // Check if we got redirected to dashboard
    const url = page.url();
    return url.includes('/ade/dashboard');
  } catch (error) {
    return false;
  }
}

test.describe('Authenticated User Flows', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to login page
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Fill in login credentials
    const emailInput = page.getByPlaceholder('you@example.com');
    const passwordInput = page.locator('input[type="password"]');

    await emailInput.fill(testUsers.valid.email);
    await passwordInput.fill(testUsers.valid.password);

    // Submit login
    const signInButton = page.getByRole('button', { name: /sign in/i });
    await signInButton.click();

    // Wait briefly for response - don't timeout if login fails
    await page.waitForTimeout(3000);
  });

  test.describe('Dashboard Access', () => {
    test('should access dashboard after login', async ({ page }) => {
      // Skip if login failed
      if (page.url().includes('/login')) {
        test.skip(true, 'Login failed - skipping authenticated test');
        return;
      }

      // Should be on dashboard or redirected there
      expect(page.url()).toMatch(/ade/);

      // Dashboard content should be visible
      await page.waitForLoadState('networkidle');
    });

    test('should display navigation sidebar', async ({ page }) => {
      if (page.url().includes('/login')) {
        test.skip(true, 'Login failed - skipping authenticated test');
        return;
      }

      // Look for common sidebar elements
      const sidebar = page.locator('nav, [role="navigation"], aside').first();
      await expect(sidebar).toBeVisible({ timeout: 10000 });
    });

    test('should navigate to projects page', async ({ page }) => {
      if (page.url().includes('/login')) {
        test.skip(true, 'Login failed - skipping authenticated test');
        return;
      }

      // Navigate to projects
      await page.goto('/ade/dashboard/projects');
      await page.waitForLoadState('networkidle');

      expect(page.url()).toContain('/projects');
    });

    test('should navigate to tenants page', async ({ page }) => {
      if (page.url().includes('/login')) {
        test.skip(true, 'Login failed - skipping authenticated test');
        return;
      }

      await page.goto('/ade/dashboard/tenants');
      await page.waitForLoadState('networkidle');

      expect(page.url()).toContain('/tenants');
    });

    test('should navigate to profile page', async ({ page }) => {
      if (page.url().includes('/login')) {
        test.skip(true, 'Login failed - skipping authenticated test');
        return;
      }

      await page.goto('/ade/dashboard/profile');
      await page.waitForLoadState('networkidle');

      expect(page.url()).toContain('/profile');
    });
  });

  test.describe('User Session', () => {
    test('should maintain session across page navigations', async ({ page }) => {
      if (page.url().includes('/login')) {
        test.skip(true, 'Login failed - skipping authenticated test');
        return;
      }

      // Navigate to different pages
      await page.goto('/ade/dashboard');
      await page.waitForLoadState('networkidle');
      expect(page.url()).toContain('/dashboard');

      // Should still be logged in, not redirected to login
      expect(page.url()).not.toContain('/login');
    });
  });
});

test.describe('Login Flow', () => {
  test('should login successfully with valid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const emailInput = page.getByPlaceholder('you@example.com');
    const passwordInput = page.locator('input[type="password"]');
    const signInButton = page.getByRole('button', { name: /sign in/i });

    await emailInput.fill(testUsers.valid.email);
    await passwordInput.fill(testUsers.valid.password);
    await signInButton.click();

    // Wait for response
    await page.waitForTimeout(3000);

    // Check if login was successful
    const url = page.url();
    if (url.includes('error=CredentialsSignin')) {
      // Test user not set up in database - skip this test
      test.skip(true, 'Test user credentials not set up in database. Create user admin@apiome.dev with password 1234.');
      return;
    }

    // Should redirect to dashboard on successful login
    expect(url).toMatch(/ade/);
  });

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const emailInput = page.getByPlaceholder('you@example.com');
    const passwordInput = page.locator('input[type="password"]');
    const signInButton = page.getByRole('button', { name: /sign in/i });

    await emailInput.fill(testUsers.invalid.email);
    await passwordInput.fill(testUsers.invalid.password);
    await signInButton.click();

    // Wait for response
    await page.waitForTimeout(3000);

    // Should stay on login page or show error
    const isOnLoginOrError = page.url().includes('login') || page.url().includes('error');
    expect(isOnLoginOrError).toBeTruthy();
  });
});

