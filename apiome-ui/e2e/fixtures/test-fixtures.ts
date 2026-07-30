import { test as base, expect, Page } from '@playwright/test';

/**
 * Custom fixtures for Apiome UI tests
 */

// Test user credentials for authentication tests
export const testUsers = {
  valid: {
    email: 'admin@apiome.dev',
    password: '1234',
  },
  invalid: {
    email: 'invalid@example.com',
    password: 'wrongpassword',
  },
};

// Helper class for page object model
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async waitForLoad() {
    await this.page.waitForLoadState('networkidle');
  }

  // Get email input
  get emailInput() {
    return this.page.getByPlaceholder('you@example.com');
  }

  // Get password input
  get passwordInput() {
    return this.page.locator('input[type="password"]');
  }

  // Get sign in button
  get signInButton() {
    return this.page.getByRole('button', { name: /sign in/i });
  }

  // Get sign up button
  get signUpButton() {
    return this.page.getByRole('button', { name: /sign up/i });
  }

  // Get toggle to switch between sign in and sign up
  get toggleSignUp() {
    return this.page.getByText(/create a new account/i);
  }

  get toggleSignIn() {
    return this.page.getByText(/already have an account/i);
  }

  // Get SSO buttons
  get githubButton() {
    return this.page.getByRole('button', { name: /continue with github/i });
  }

  get gitlabButton() {
    return this.page.getByRole('button', { name: /continue with gitlab/i });
  }

  // Fill login form
  async fillLoginForm(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
  }

  // Submit login
  async submitLogin() {
    await this.signInButton.click();
  }

  // Perform full login
  async login(email: string, password: string) {
    await this.fillLoginForm(email, password);
    await this.submitLogin();
  }
}

// Dashboard page helper
export class DashboardPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/ade/dashboard');
  }

  async waitForLoad() {
    await this.page.waitForLoadState('networkidle');
  }

  // Navigation elements
  get projectsLink() {
    return this.page.getByRole('link', { name: /projects/i });
  }

  get versionsLink() {
    return this.page.getByRole('link', { name: /versions/i });
  }

  get tenantsLink() {
    return this.page.getByRole('link', { name: /tenants/i });
  }

  get apiKeysLink() {
    return this.page.getByRole('link', { name: /api keys/i });
  }

  get profileLink() {
    return this.page.getByRole('link', { name: /profile/i });
  }
}

// Studio page helper
export class StudioPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/ade/studio');
  }

  async gotoEditor() {
    await this.page.goto('/ade/studio/editor');
  }

  async gotoPaths() {
    await this.page.goto('/ade/studio/paths');
  }

  async gotoCode() {
    await this.page.goto('/ade/studio/code');
  }

  async waitForLoad() {
    await this.page.waitForLoadState('networkidle');
  }

  // Project selector
  get projectSelector() {
    return this.page.locator('[class*="Select"]').first();
  }

  // Version selector
  get versionSelector() {
    return this.page.locator('[class*="Select"]').nth(1);
  }

  // Canvas view toggle
  get canvasToggle() {
    return this.page.getByRole('button', { name: /canvas/i });
  }

  // Code view toggle
  get codeToggle() {
    return this.page.getByRole('button', { name: /code/i });
  }

  // Export button
  get exportButton() {
    return this.page.getByTitle('Export canvas');
  }

  // Layout button
  get layoutButton() {
    return this.page.getByTitle('Layout options');
  }

  /** Opens the upper-left canvas tools drawer (Expand, Search, View Mode, …). */
  get canvasToolsTrigger() {
    return this.page.getByRole('button', { name: /^tools$/i });
  }

  // Expand/Collapse — inside the canvas tools mini drawer (#842)
  get expandAllButton() {
    return this.page.getByRole('button', { name: /^expand$/i });
  }

  get collapseAllButton() {
    return this.page.getByRole('button', { name: /^collapse$/i });
  }

  get tagsButton() {
    return this.page.getByRole('button', { name: /^tags$/i });
  }

  // ReactFlow canvas
  get canvas() {
    return this.page.locator('.react-flow');
  }

  // Class nodes on canvas
  get classNodes() {
    return this.page.locator('.react-flow__node');
  }

  // Controls (zoom in, zoom out, fit view)
  get controls() {
    return this.page.locator('.react-flow__controls');
  }

  // MiniMap
  get minimap() {
    return this.page.locator('.react-flow__minimap');
  }
}

// Extended test fixture with page objects
export const test = base.extend<{
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  studioPage: StudioPage;
}>({
  loginPage: async ({ page }, useFixture) => {
    await useFixture(new LoginPage(page));
  },
  dashboardPage: async ({ page }, useFixture) => {
    await useFixture(new DashboardPage(page));
  },
  studioPage: async ({ page }, useFixture) => {
    await useFixture(new StudioPage(page));
  },
});

export { expect };

