# E2E Testing with Playwright

This directory contains end-to-end (E2E) tests for the Apiome UI application using [Playwright](https://playwright.dev/).

## Overview

E2E tests ensure that the application works correctly from a user's perspective by testing complete user flows and UI interactions.

## Test Structure

```
e2e/
├── fixtures/
│   └── test-fixtures.ts    # Custom test fixtures and page objects
├── login.spec.ts           # Login page tests
├── login-a11y.spec.ts      # Login a11y + visual snapshots (OLO-3.5) — axe/keyboard/screenshots
├── navigation.spec.ts      # Navigation and routing tests
├── visual-regression.spec.ts # Visual regression tests with screenshots
├── accessibility.spec.ts   # Accessibility (a11y) tests
├── components.spec.ts      # UI component behavior tests
├── authenticated.spec.ts   # Tests requiring login (dashboard, studio)
└── README.md               # This file
```

### Login a11y + visual suite (OLO-3.5)

`login-a11y.spec.ts` runs under its own config (`playwright.a11y.config.ts`) which boots a
dedicated dev server on `:3200` with a **pinned** environment — GitHub + GitLab SSO enabled
(dummy credentials) and the beta background disabled — so the login "front door" renders
identically in every environment and its committed visual snapshots stay pixel-stable. It
covers WCAG 2.1 A/AA axe scans (default / credentials-expanded / error), a keyboard-only
sign-in flow, and screenshots of the auth card in its default, loading, and error states.

```bash
# Run the login a11y + visual suite
yarn test:e2e:a11y

# Refresh the committed visual baselines after an intentional login redesign
yarn test:e2e:a11y --update-snapshots
```

Structural a11y (label association, landmark, announcement roles) is additionally pinned in
jsdom by `tests/login-a11y.test.tsx`, which runs in the fast `yarn test` (jest) suite.

## Running Tests

### Basic Commands

```bash
# Run all E2E tests
yarn test:e2e

# Run tests in headed mode (with browser visible)
yarn test:e2e:headed

# Run tests with Playwright UI mode (interactive)
yarn test:e2e:ui

# Run tests in debug mode
yarn test:e2e:debug

# View HTML test report
yarn test:e2e:report

# Update visual regression snapshots
yarn test:e2e:update-snapshots
```

### Running Specific Tests

```bash
# Run a specific test file
yarn test:e2e e2e/login.spec.ts

# Run tests matching a pattern
yarn test:e2e --grep "login"

# Run tests in a specific project (browser)
yarn test:e2e --project=chromium
```

## Test Categories

### 1. Login Tests (`login.spec.ts`)
- Page rendering and structure
- Form validation
- Sign up mode toggle
- SSO button presence
- Error handling
- Accessibility basics

### 2. Navigation Tests (`navigation.spec.ts`)
- Route accessibility
- Redirect behavior for unauthenticated users
- Protected route handling
- 404 handling
- Page load performance

### 3. Visual Regression Tests (`visual-regression.spec.ts`)
- Screenshot comparisons for different viewports
- Dark/light mode theme tests
- Responsive design verification
- Component visual consistency

### 4. Accessibility Tests (`accessibility.spec.ts`)
- Keyboard navigation
- Focus management
- ARIA attributes
- Form label accessibility
- Color contrast checks
- Screen reader compatibility

### 5. Component Tests (`components.spec.ts`)
- Form input behavior
- Button states and interactions
- Loading states
- Error state handling
- Network error handling

### 6. Authenticated Tests (`authenticated.spec.ts`)
- Login flow with valid/invalid credentials
- Dashboard access after login
- Studio access after login
- Navigation between protected pages
- Session persistence across navigations

## Writing New Tests

### Using Page Objects

The `fixtures/test-fixtures.ts` file provides page object models for common pages:

```typescript
import { test, expect } from './fixtures/test-fixtures';

test('example test', async ({ loginPage }) => {
  await loginPage.goto();
  await loginPage.fillLoginForm('user@example.com', 'password');
  await loginPage.submitLogin();
});
```

### Available Page Objects

- `LoginPage` - Login page interactions
- `DashboardPage` - Dashboard navigation
- `StudioPage` - Studio/editor interactions

### Adding Visual Regression Tests

```typescript
test('my visual test', async ({ page }) => {
  await page.goto('/some-page');
  await expect(page).toHaveScreenshot('my-screenshot.png');
});
```

On first run, Playwright will create baseline screenshots. Future runs will compare against these baselines.

## Configuration

The Playwright configuration is in `playwright.config.ts`:

- **testDir**: `./e2e`
- **Base URL**: `http://localhost:3000` (or `PLAYWRIGHT_BASE_URL` env var)
- **Browser**: Chromium (others can be enabled in config)
- **Web Server**: Automatically starts `yarn dev` before tests

## CI/CD Integration

Tests are configured to:
- Fail fast on CI if `test.only` is left in code
- Retry failed tests 2 times on CI
- Generate HTML reports
- Capture screenshots and videos on failure

### Environment Variables

- `CI` - Set to any value to enable CI mode
- `PLAYWRIGHT_BASE_URL` - Override the base URL for tests

### Test Credentials

For local E2E testing, the following credentials are used:

| Type | Email | Password |
|------|-------|----------|
| Valid User | `admin@apiome.dev` | `1234` |
| Invalid User | `invalid@example.com` | `wrongpassword` |

These credentials are defined in `fixtures/test-fixtures.ts`.

## Troubleshooting

### Browser Installation

If browsers aren't installed:
```bash
npx playwright install chromium
```

### Flaky Tests

If tests are flaky:
1. Add explicit waits: `await page.waitForLoadState('networkidle')`
2. Increase timeouts in specific tests
3. Use `test.retry(2)` for specific tests

### Visual Regression Failures

If screenshots don't match:
1. Review the diff in the HTML report
2. If the change is intentional, update snapshots: `yarn test:e2e:update-snapshots`
3. Check for dynamic content that should be masked

## Best Practices

1. **Use Page Objects** - Keep selectors centralized in page objects
2. **Wait for States** - Always wait for page loads and network idle
3. **Be Specific** - Use specific selectors (role, label, placeholder)
4. **Handle Dynamic Content** - Mock or wait for dynamic content
5. **Keep Tests Independent** - Each test should be runnable in isolation
6. **Update Snapshots Carefully** - Review visual changes before updating

