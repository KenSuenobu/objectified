/**
 * The Published versions redesign, rendered (HIVE-8.1, #5327).
 *
 * `published-model.test.ts` holds the decisions and `published-css.test.ts` pins the
 * declarations; this holds the screen that makes them, mounted against a mocked
 * `getPublishedVersionsForTenant` returning the mockup's four rows. What it pins is the
 * ticket's four acceptance criteria and the mockup's **Notes → Keeps (1:1)** list:
 *
 *   1. **The visibility toggle disables while the change is in flight and reflects failure** —
 *      the button is `disabled` and `aria-busy` between the confirm and the round-trip's
 *      answer, and a rejected write leaves the row where it was and raises the danger banner
 *      carrying the server's own words.
 *   2. **Private-version viewing still requires and offers a key** — the View fly-out is inert
 *      with the one reason while the workspace holds no live key; the row's key button always
 *      opens the dialog; and a submitted key reaches the opened URL as `api_key`.
 *   3. **Access URLs are copyable and correct per tenant slug** — the cell prints the schema
 *      path and copies the absolute URL, and enters its copied state.
 *   4. **Deprecated published versions carry their badge**, which links to the sunset timeline.
 *
 * Plus the five things the screen this replaces got wrong and this ticket fixes: a failed read
 * that looked like an empty workspace, an invisible copied state, a mouse-only fly-out, a
 * failure answered with a second modal, and a search box that vanished with the rows.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

const mockConfirm = jest.fn<Promise<boolean>, [unknown]>(() => Promise.resolve(true));
const mockAlert = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());

/** The signed-in user the screen reads. Mutable so one test can sign in with no workspace. */
let sessionUser: Record<string, unknown> = {
  user_id: 'u-ada',
  current_tenant_id: 't-acme',
  email: 'ada@acme.io',
};

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: sessionUser }, status: 'authenticated', update: jest.fn() }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/published',
}));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: (options: unknown) => mockConfirm(options),
    alert: (options: unknown) => mockAlert(options),
    prompt: jest.fn(),
  }),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...(args as [])),
    error: (...args: unknown[]) => mockToastError(...(args as [])),
    message: jest.fn(),
  },
}));

const mockReadVersions = jest.fn<Promise<string>, [string]>();
const mockReadApiKeys = jest.fn<Promise<string>, [string]>();
const mockUpdateVisibility = jest.fn<Promise<string>, [string, string]>();

jest.mock('@lib/db/helper', () => ({
  getPublishedVersionsForTenant: (...args: unknown[]) => mockReadVersions(...(args as [string])),
  getApiKeysForTenant: (...args: unknown[]) => mockReadApiKeys(...(args as [string])),
  updateVersionVisibility: (...args: unknown[]) =>
    mockUpdateVisibility(...(args as [string, string])),
}));

/** A whole editor of its own, not under test here. */
jest.mock('@/app/components/ade/dashboard/MockScenarioEditor', () => ({
  MockScenarioEditor: ({ open }: { open: boolean }) =>
    open ? <div data-testid="scenario-editor">scenarios</div> : null,
}));

jest.mock('@/app/hooks/useMockUsage', () => ({
  useMockUsage: () => ({ seriesByVersion: new Map([['payments-api::2.3.1', [1, 2, 3]]]) }),
}));

jest.mock('@/app/utils/mock-usage-series', () => ({
  mockUsageSeriesKey: (slug: string, label: string) => `${slug}::${label}`,
  MOCK_USAGE_WINDOW_DAYS: 30,
}));

import PublishedVersions from '../src/app/ade/dashboard/published/PublishedVersions';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import { statusTone, STATUS_TONE_SOFT_CLASS } from '../src/app/components/ui/statusVocabulary';
import { PRIVATE_NEEDS_KEY_TITLE } from '../src/app/components/ade/published/publishedModel';
import { previewApiKeyStorageKey } from '../src/app/utils/preview-api-key-storage';

// ---------------------------------------------------------------------------------------
// Fixtures — the four rows the mockup draws
// ---------------------------------------------------------------------------------------

const REST = 'https://api.example.com/v1';
const MOCK_HOST = 'https://mock.apiome.dev';
const TENANT_ID = 't-acme';

const PAYMENTS_231 = {
  id: '0f1a2b30-0000-4000-8000-000000000001',
  version_id: '2.3.1',
  description: 'Card, refund and payout endpoints.',
  visibility: 'public' as const,
  published_at: '2026-08-03T16:05:00.000Z',
  created_at: '2026-08-02T16:40:00.000Z',
  project_id: 'prj-payments',
  project_name: 'Payments API',
  project_slug: 'payments-api',
  tenant_id: TENANT_ID,
  tenant_name: 'Acme Corp',
  tenant_slug: 'acme',
  creator_name: 'Grace Hopper',
  creator_email: 'grace@acme.io',
  mock_enabled: true,
  metadata: {},
};

const PAYMENTS_220 = {
  ...PAYMENTS_231,
  id: '0f1a2b30-0000-4000-8000-000000000002',
  version_id: '2.2.0',
  description: 'Card tokenisation + 3DS challenge flow.',
  visibility: 'private' as const,
  published_at: '2026-06-11T14:30:00.000Z',
  creator_name: 'Ada Lovelace',
  creator_email: 'ada@acme.io',
  mock_enabled: false,
};

const ORDERS_192 = {
  ...PAYMENTS_231,
  id: '0f1a2b30-0000-4000-8000-000000000003',
  version_id: '1.9.2',
  description: 'Order lifecycle: cart to checkout to fulfilment.',
  project_id: 'prj-orders',
  project_name: 'Orders Service',
  project_slug: 'orders-service',
  published_at: '2026-08-12T22:40:00.000Z',
  mock_enabled: false,
};

const ORDERS_140 = {
  ...ORDERS_192,
  id: '0f1a2b30-0000-4000-8000-000000000004',
  version_id: '1.4.0',
  description: 'Legacy order flow — sunsets 27 Aug 2026.',
  visibility: 'private' as const,
  published_at: '2026-01-20T16:15:00.000Z',
  creator_name: 'Linus Torvalds',
  creator_email: 'linus@acme.io',
  metadata: { deprecated: true, sunsetAt: '2026-08-27T00:00:00Z' },
};

const ROWS = [ORDERS_192, PAYMENTS_231, PAYMENTS_220, ORDERS_140];

/** One live key, so the View fly-out is open by default. */
const LIVE_KEY = [{ id: 'key-1', enabled: true, expires_at: null }];

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

let openedUrls: string[] = [];

/**
 * Put a spy on the clipboard.
 *
 * `userEvent.setup()` installs a clipboard stub of its own, so any test that drives Radix
 * through `userEvent` has to re-install this afterwards to be able to read the write.
 */
function installClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn(async () => undefined) },
  });
}

/**
 * Mount the screen with the reads it makes already answered.
 *
 * @param options Which rows and which keys the workspace holds.
 * @returns Nothing; the screen is on the document once its first read has landed.
 */
async function renderPublished(
  options: {
    rows?: unknown[];
    keys?: unknown[];
    readPayload?: unknown;
  } = {}
): Promise<void> {
  const { rows = ROWS, keys = LIVE_KEY, readPayload } = options;
  mockReadVersions.mockResolvedValue(
    JSON.stringify(readPayload ?? { success: true, versions: rows })
  );
  mockReadApiKeys.mockResolvedValue(JSON.stringify(keys));

  render(
    <TooltipProvider>
      <PublishedVersions restApiBaseUrl={REST} mockApiBaseUrl={MOCK_HOST} />
    </TooltipProvider>
  );

  await waitFor(() => expect(mockReadVersions).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
}

/** One row's `<tr>`, found by the row id the table stamps on it. */
function row(id: string): HTMLElement {
  const node = document.querySelector(`tr[data-row-id="${id}"]`);
  if (!node) throw new Error(`no row for ${id}`);
  return node as HTMLElement;
}

/**
 * Open one row's kebab and return its menu.
 *
 * Radix opens a `DropdownMenu` on `pointerdown`, which `fireEvent.click` alone never sends;
 * `userEvent` dispatches the whole pointer sequence, which is also what makes the arrow keys
 * work afterwards.
 *
 * @param id The row's id.
 * @returns The open menu.
 */
async function openRowMenu(id: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(`published-row-menu-${id}`));
  return await screen.findByTestId(`published-row-menu-content-${id}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  sessionUser = { user_id: 'u-ada', current_tenant_id: 't-acme', email: 'ada@acme.io' };
  mockConfirm.mockResolvedValue(true);
  mockUpdateVisibility.mockResolvedValue(JSON.stringify({ success: true }));
  openedUrls = [];
  window.localStorage.clear();
  Object.defineProperty(window, 'open', {
    configurable: true,
    writable: true,
    value: (url?: string | URL) => {
      openedUrls.push(String(url));
      return null;
    },
  });
  installClipboard();
});

// ---------------------------------------------------------------------------------------
// The page frame
// ---------------------------------------------------------------------------------------

describe('the page frame', () => {
  it('draws the Hive page header with the Ship trail and one action', async () => {
    await renderPublished();

    expect(screen.getByRole('heading', { level: 1, name: 'Published versions' })).toBeInTheDocument();
    const crumbs = screen.getByTestId('page-breadcrumb');
    expect(within(crumbs).getByText('Ship')).toBeInTheDocument();
    expect(within(crumbs).getByText('Published')).toBeInTheDocument();

    const apiKeys = screen.getByTestId('published-api-keys');
    expect(apiKeys).toHaveAttribute('href', '/ade/dashboard/api-keys');
  });

  it('describes what the workspace has published', async () => {
    await renderPublished();
    expect(
      screen.getByText('4 published versions · 2 public · 1 with a hosted mock')
    ).toBeInTheDocument();
  });

  it('draws the six columns the mockup names, and no others', async () => {
    await renderPublished();
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent?.trim());
    expect(headers).toEqual([
      'Project / Version',
      'Visibility',
      'Access URL',
      'Mock',
      'Published',
      'Actions',
    ]);
  });

  it('offers no sorting — the mockup says this screen has none', async () => {
    await renderPublished();
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header).not.toHaveAttribute('aria-sort');
    }
  });
});

// ---------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------

describe('the rows', () => {
  it('draws every published version with its project, label and note', async () => {
    await renderPublished();

    const payments = row(PAYMENTS_231.id);
    expect(within(payments).getByText('Payments API')).toBeInTheDocument();
    expect(within(payments).getByText('v2.3.1')).toBeInTheDocument();
    expect(within(payments).getByText('Card, refund and payout endpoints.')).toBeInTheDocument();
  });

  it('marks every published revision Locked, in the shared vocabulary', async () => {
    await renderPublished();
    const chips = screen.getAllByText('Locked');
    expect(chips).toHaveLength(ROWS.length);
    expect(chips[0].closest('[data-status]')).toHaveAttribute('data-status', 'locked');
    expect(chips[0].closest('[data-status]')).toHaveClass(
      STATUS_TONE_SOFT_CLASS[statusTone('locked')].split(' ')[0]
    );
  });

  it('carries the Deprecated badge on a sunsetting row, and only there', async () => {
    await renderPublished();

    const pills = screen.getAllByText('Deprecated');
    expect(pills).toHaveLength(1);
    expect(within(row(ORDERS_140.id)).getByText('Deprecated')).toBeInTheDocument();
  });

  it('links the Deprecated badge to the sunset timeline and names the sunset', async () => {
    await renderPublished();

    const link = screen.getByTestId(`published-lifecycle-${ORDERS_140.id}`);
    expect(link).toHaveAttribute('href', '/ade/dashboard/versions/sunset-timeline');
    expect(link).toHaveAttribute('title', expect.stringContaining('27 Aug 2026 00:00 UTC'));
  });

  it('prints the published stamp and its author', async () => {
    await renderPublished();
    expect(within(row(PAYMENTS_231.id)).getByText('by Grace Hopper')).toBeInTheDocument();
    expect(within(row(ORDERS_140.id)).getByText('by Linus Torvalds')).toBeInTheDocument();
  });

  it('draws the shared mock cell, enabled only where the row says so', async () => {
    await renderPublished();
    expect(
      within(row(PAYMENTS_231.id)).getByRole('switch', { name: 'Mock for version 2.3.1' })
    ).toBeChecked();
    expect(
      within(row(PAYMENTS_220.id)).getByRole('switch', { name: 'Mock for version 2.2.0' })
    ).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------------------
// Access URLs
// ---------------------------------------------------------------------------------------

describe('the access URL', () => {
  it('prints the tenant-slug path', async () => {
    await renderPublished();
    expect(
      within(row(PAYMENTS_231.id)).getByText('schema/acme/payments-api/2.3.1')
    ).toBeInTheDocument();
  });

  it('copies the absolute URL and enters its copied state', async () => {
    await renderPublished();

    const button = screen.getByTestId(`published-access-url-${PAYMENTS_231.id}`);
    expect(button).not.toHaveAttribute('data-copied');

    await act(async () => {
      fireEvent.click(button);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://api.example.com/v1/schema/acme/payments-api/2.3.1'
    );
    await waitFor(() => expect(button).toHaveAttribute('data-copied'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Published API URL copied to clipboard.');
  });

  it('says so when the clipboard refused', async () => {
    await renderPublished();
    (navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-access-url-${PAYMENTS_231.id}`));
    });

    expect(mockToastError).toHaveBeenCalledWith('Failed to copy URL to clipboard.');
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------------------

describe('the visibility toggle', () => {
  it('confirms in the mockup’s words before changing anything', async () => {
    await renderPublished();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Change Visibility to PRIVATE',
        confirmLabel: 'Change Visibility',
      })
    );
  });

  it('writes nothing when the confirm is declined', async () => {
    await renderPublished();
    mockConfirm.mockResolvedValueOnce(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });

    expect(mockUpdateVisibility).not.toHaveBeenCalled();
  });

  it('disables the toggle while the change is in flight', async () => {
    await renderPublished();

    let settle: (value: string) => void = () => undefined;
    mockUpdateVisibility.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        settle = resolve;
      })
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });

    const toggle = screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`);
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      settle(JSON.stringify({ success: true }));
      await Promise.resolve();
    });

    expect(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`)).not.toBeDisabled();
  });

  it('flips the badge and confirms with a toast when the write lands', async () => {
    await renderPublished();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });

    expect(mockUpdateVisibility).toHaveBeenCalledWith(PAYMENTS_231.id, 'private');
    await waitFor(() =>
      expect(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`)).toHaveAttribute(
        'data-status',
        'private'
      )
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('Visibility changed to private.');
  });

  it('reflects failure as a banner carrying the server’s words, and leaves the row alone', async () => {
    await renderPublished();
    mockUpdateVisibility.mockResolvedValueOnce(
      JSON.stringify({ success: false, error: '503 Service Unavailable' })
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });

    const banner = await screen.findByTestId('published-visibility-error');
    expect(banner).toHaveTextContent('Failed to update visibility: 503 Service Unavailable');
    // The failure is a banner, not a second modal over the first.
    expect(mockAlert).not.toHaveBeenCalled();
    expect(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`)).toHaveAttribute(
      'data-status',
      'public'
    );
  });

  it('lets the reader dismiss the failure banner', async () => {
    await renderPublished();
    mockUpdateVisibility.mockResolvedValueOnce(JSON.stringify({ success: false, error: 'nope' }));

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });
    const banner = await screen.findByTestId('published-visibility-error');

    await act(async () => {
      fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    });

    expect(screen.queryByTestId('published-visibility-error')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The row menu
// ---------------------------------------------------------------------------------------

describe('the row menu', () => {
  it('offers the fly-out, Swagger UI, Copy URL and the visibility verb', async () => {
    await renderPublished();
    const menu = await openRowMenu(PAYMENTS_231.id);

    expect(within(menu).getByTestId(`published-row-view-${PAYMENTS_231.id}`)).toBeInTheDocument();
    expect(within(menu).getByText('Swagger UI')).toBeInTheDocument();
    expect(within(menu).getByText('Copy URL')).toBeInTheDocument();
    expect(within(menu).getByText('Make Private')).toBeInTheDocument();
    expect(within(menu).queryByText('Unpublish')).not.toBeInTheDocument();
    expect(within(menu).queryByText('Delete')).not.toBeInTheDocument();
  });

  it('opens the View fly-out from the keyboard', async () => {
    const user = userEvent.setup();
    await renderPublished();
    await openRowMenu(PAYMENTS_231.id);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');

    const flyout = await screen.findByTestId(`published-row-view-content-${PAYMENTS_231.id}`);
    expect(within(flyout).getByText('OpenAPI')).toBeInTheDocument();
    expect(within(flyout).getByText('Arazzo')).toBeInTheDocument();
    expect(within(flyout).getByText('JSON Schema')).toBeInTheDocument();
  });

  it('opens a public revision’s spec in a new tab with no key', async () => {
    const user = userEvent.setup();
    await renderPublished();
    await openRowMenu(PAYMENTS_231.id);
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    const flyout = await screen.findByTestId(`published-row-view-content-${PAYMENTS_231.id}`);

    await act(async () => {
      fireEvent.click(within(flyout).getByText('OpenAPI'));
    });

    expect(openedUrls).toEqual(['https://api.example.com/v1/schema/acme/payments-api/2.3.1']);
  });

  it('opens Swagger UI without gating it, even on a private revision', async () => {
    await renderPublished({ keys: [] });
    const menu = await openRowMenu(PAYMENTS_220.id);

    await act(async () => {
      fireEvent.click(within(menu).getByText('Swagger UI'));
    });

    // No key in the workspace and none saved, so the dialog asks rather than opening blind.
    expect(await screen.findByTestId('published-api-key-dialog')).toBeInTheDocument();
  });

  it('copies the access URL from the menu', async () => {
    await renderPublished();
    const menu = await openRowMenu(PAYMENTS_231.id);
    installClipboard();

    await act(async () => {
      fireEvent.click(within(menu).getByText('Copy URL'));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://api.example.com/v1/schema/acme/payments-api/2.3.1'
    );
  });

  it('changes visibility from the menu', async () => {
    await renderPublished();
    const menu = await openRowMenu(PAYMENTS_231.id);

    await act(async () => {
      fireEvent.click(within(menu).getByText('Make Private'));
    });

    await waitFor(() => expect(mockUpdateVisibility).toHaveBeenCalledWith(PAYMENTS_231.id, 'private'));
  });

  it('makes the fly-out inert, with the reason, when a private row has no key to offer', async () => {
    const user = userEvent.setup();
    await renderPublished({ keys: [{ id: 'k', enabled: false, expires_at: null }] });
    await openRowMenu(PAYMENTS_220.id);
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');

    const flyout = await screen.findByTestId(`published-row-view-content-${PAYMENTS_220.id}`);
    for (const label of ['OpenAPI', 'Arazzo', 'JSON Schema']) {
      const item = within(flyout).getByText(label).closest('[role="menuitem"]');
      expect(item).toHaveAttribute('data-disabled');
      expect(item).toHaveAttribute('title', PRIVATE_NEEDS_KEY_TITLE);
    }
  });
});

// ---------------------------------------------------------------------------------------
// The API-key dialog
// ---------------------------------------------------------------------------------------

describe('the API key dialog', () => {
  it('is offered from the private row’s key button', async () => {
    await renderPublished();
    expect(screen.queryByTestId(`published-row-key-${PAYMENTS_231.id}`)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-row-key-${PAYMENTS_220.id}`));
    });

    expect(await screen.findByTestId('published-api-key-dialog')).toBeInTheDocument();
  });

  it('keeps Open with key inert until a key is typed', async () => {
    await renderPublished();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-row-key-${PAYMENTS_220.id}`));
    });

    expect(await screen.findByTestId('published-api-key-open')).toBeDisabled();

    fireEvent.change(screen.getByTestId('published-api-key-input'), {
      target: { value: 'sk_live_1' },
    });

    expect(screen.getByTestId('published-api-key-open')).not.toBeDisabled();
  });

  it('opens the private spec with the key appended, and remembers it by default', async () => {
    await renderPublished();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-row-key-${PAYMENTS_220.id}`));
    });
    await screen.findByTestId('published-api-key-dialog');

    fireEvent.change(screen.getByTestId('published-api-key-input'), {
      target: { value: 'sk_live_1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('published-api-key-open'));
    });

    expect(openedUrls).toEqual([
      'https://api.example.com/v1/schema/acme/payments-api/2.2.0?api_key=sk_live_1',
    ]);
    expect(window.localStorage.getItem(previewApiKeyStorageKey(TENANT_ID))).toBe('sk_live_1');
  });

  it('submits on Enter', async () => {
    await renderPublished();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-row-key-${PAYMENTS_220.id}`));
    });
    await screen.findByTestId('published-api-key-dialog');

    const input = screen.getByTestId('published-api-key-input');
    fireEvent.change(input, { target: { value: 'sk_live_2' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(openedUrls).toEqual([
      'https://api.example.com/v1/schema/acme/payments-api/2.2.0?api_key=sk_live_2',
    ]);
  });

  it('does not remember the key when the reader unticks the box', async () => {
    await renderPublished();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-row-key-${PAYMENTS_220.id}`));
    });
    await screen.findByTestId('published-api-key-dialog');

    await act(async () => {
      fireEvent.click(screen.getByTestId('published-api-key-remember'));
    });
    fireEvent.change(screen.getByTestId('published-api-key-input'), {
      target: { value: 'sk_live_3' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('published-api-key-open'));
    });

    expect(window.localStorage.getItem(previewApiKeyStorageKey(TENANT_ID))).toBeNull();
  });

  it('skips the prompt when this device already remembers a key', async () => {
    window.localStorage.setItem(previewApiKeyStorageKey(TENANT_ID), 'sk_saved');
    const user = userEvent.setup();
    await renderPublished();
    await openRowMenu(PAYMENTS_220.id);
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    const flyout = await screen.findByTestId(`published-row-view-content-${PAYMENTS_220.id}`);

    await act(async () => {
      fireEvent.click(within(flyout).getByText('Arazzo'));
    });

    expect(screen.queryByTestId('published-api-key-dialog')).not.toBeInTheDocument();
    expect(openedUrls).toEqual([
      'https://api.example.com/v1/arazzo/acme/payments-api/2.2.0?api_key=sk_saved',
    ]);
  });

  it('offers the clear escape hatch only when a key is saved, and forgets it', async () => {
    window.localStorage.setItem(previewApiKeyStorageKey(TENANT_ID), 'sk_saved');
    await renderPublished();

    // The key button always prompts, which is how a remembered key can be replaced.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-row-key-${PAYMENTS_220.id}`));
    });
    await screen.findByTestId('published-api-key-dialog');

    await act(async () => {
      fireEvent.click(screen.getByTestId('published-api-key-clear'));
    });

    expect(window.localStorage.getItem(previewApiKeyStorageKey(TENANT_ID))).toBeNull();
    expect(mockToastSuccess).toHaveBeenCalledWith('Saved API key removed from this browser.');
    await waitFor(() =>
      expect(screen.queryByTestId('published-api-key-clear')).not.toBeInTheDocument()
    );
  });
});

// ---------------------------------------------------------------------------------------
// Search, the foot, and the states with no rows
// ---------------------------------------------------------------------------------------

describe('search and the foot', () => {
  it('narrows the table and marks the count filtered', async () => {
    await renderPublished();
    expect(screen.getByTestId('published-foot')).toHaveTextContent(
      'Showing 4 of 4 published versions'
    );

    fireEvent.change(screen.getByTestId('published-search'), { target: { value: 'orders' } });

    await waitFor(() =>
      expect(screen.getByTestId('published-foot')).toHaveTextContent(
        'Showing 2 of 4 published versions'
      )
    );
    expect(screen.getByTestId('published-foot')).toHaveTextContent('(filtered)');
  });

  it('keeps the search box on screen when the search matches nothing', async () => {
    await renderPublished();

    fireEvent.change(screen.getByTestId('published-search'), { target: { value: 'zzz' } });

    expect(await screen.findByText('No matching versions')).toBeInTheDocument();
    expect(screen.getByTestId('published-search')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('published-clear-search'));
    });
    expect(await screen.findAllByText('Payments API')).toHaveLength(2);
  });
});

describe('the states with no rows', () => {
  it('asks for a workspace when none is chosen', async () => {
    sessionUser = { user_id: 'u-ada', email: 'ada@acme.io' };

    render(
      <TooltipProvider>
        <PublishedVersions restApiBaseUrl={REST} mockApiBaseUrl={MOCK_HOST} />
      </TooltipProvider>
    );

    expect(await screen.findByText('No tenant selected')).toBeInTheDocument();
    expect(
      screen.getByText('Please select a tenant before managing publications.')
    ).toBeInTheDocument();
    expect(mockReadVersions).not.toHaveBeenCalled();
  });

  it('sends a workspace with nothing published to Versions', async () => {
    await renderPublished({ rows: [] });

    expect(await screen.findByText('No published versions')).toBeInTheDocument();
    expect(screen.getByTestId('published-empty-versions')).toHaveAttribute(
      'href',
      '/ade/dashboard/versions'
    );
    // A foot counting zero of zero says nothing an empty state has not already said.
    expect(screen.queryByTestId('published-foot')).not.toBeInTheDocument();
  });

  it('draws a failed read as an error with a retry, not as an empty workspace', async () => {
    await renderPublished({ readPayload: { success: false, error: 'connection refused' } });

    expect(await screen.findByText('Could not load published versions')).toBeInTheDocument();
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.queryByText('No published versions')).not.toBeInTheDocument();

    mockReadVersions.mockResolvedValueOnce(JSON.stringify({ success: true, versions: ROWS }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    expect(await screen.findAllByText('Payments API')).toHaveLength(2);
  });

  it('names the content while the first read is in flight', async () => {
    mockReadVersions.mockReturnValue(new Promise<string>(() => undefined));
    mockReadApiKeys.mockResolvedValue('[]');

    render(
      <TooltipProvider>
        <PublishedVersions restApiBaseUrl={REST} mockApiBaseUrl={MOCK_HOST} />
      </TooltipProvider>
    );

    expect(await screen.findByText('Loading published versions...')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The browser fixtures.
 *
 * `e2e/hive-published.spec.ts` measures computed layout, which jsdom cannot do. Rather than
 * hand-writing HTML that would drift from the components, this renders the real screen and
 * writes what it rendered into `e2e/fixtures/hive-published/` when `PUBLISHED_FIXTURE_DUMP=1`
 * is set:
 *
 *     PUBLISHED_FIXTURE_DUMP=1 npx jest tests/published-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there
 * — so a change that would leave the fixtures stale fails loudly here before it fails quietly
 * in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-published');
  const dump = process.env.PUBLISHED_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  it('renders the table (and writes its fixture on request)', async () => {
    await renderPublished();
    await screen.findAllByText('Payments API');
    write('table', page().outerHTML);
  });

  it('renders the empty state (and writes its fixture on request)', async () => {
    await renderPublished({ rows: [] });
    await screen.findByText('No published versions');
    write('empty', page().outerHTML);
  });

  it('renders the failure banner over the table (and writes its fixture on request)', async () => {
    await renderPublished();
    mockUpdateVisibility.mockResolvedValueOnce(
      JSON.stringify({ success: false, error: '503 Service Unavailable' })
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId(`published-visibility-${PAYMENTS_231.id}`));
    });
    await screen.findByTestId('published-visibility-error');
    write('error', page().outerHTML);
  });
});
