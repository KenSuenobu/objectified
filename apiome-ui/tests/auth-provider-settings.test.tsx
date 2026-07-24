/**
 * System Configuration screen — sign-in provider cards (OLO-8.7, #4973).
 *
 * Integration tests (RTL) for `AuthProviderSettingsClient` against a mocked
 * `/api/admin/auth-providers` proxy, covering the issue's acceptance criteria:
 * only configured providers are listed (the rest are reachable via the header's
 * "+ Add Provider" menu, coming-soon entries disabled there), an empty-state card
 * when nothing is configured, write-only secret handling ("set / not set", never a
 * value), per-field ".env fallback" indicators, dirty-only partial saves,
 * blocked-enable 422 guidance, the Validate affordance, and the enablement
 * override semantics (true / false / null).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import AuthProviderSettingsClient from '../src/app/admin/dashboard/settings/AuthProviderSettingsClient';
import type { AdminProviderConfigView } from '../lib/auth/admin-provider-config';

/** Build a full masked view with sensible env-fallback defaults. */
function makeView(overrides: Partial<AdminProviderConfigView>): AdminProviderConfigView {
  return {
    provider_id: 'github',
    label: 'GitHub',
    status: 'available',
    enabled: null,
    enabled_source: 'env-fallback',
    client_id: null,
    client_id_source: 'env-fallback',
    secret_set: false,
    secret_source: 'env-fallback',
    config: {},
    required_fields: ['client_id', 'client_secret'],
    missing_for_enable: ['client_id', 'client_secret'],
    can_enable: false,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

const GITHUB = makeView({});
const GITLAB = makeView({
  provider_id: 'gitlab',
  label: 'GitLab',
  enabled: true,
  enabled_source: 'db',
  client_id: 'gitlab-client-id',
  client_id_source: 'db',
  secret_set: true,
  secret_source: 'db',
  config: { GITLAB_BASE_URL: 'https://git.example.com' },
  missing_for_enable: [],
  can_enable: true,
  updated_at: '2026-07-20T10:00:00Z',
  updated_by: 'admin',
});
const AZURE = makeView({
  provider_id: 'azure',
  label: 'Microsoft',
});
const GOOGLE = makeView({
  provider_id: 'google',
  label: 'Google',
});
const OKTA = makeView({
  provider_id: 'okta',
  label: 'Okta',
  required_fields: ['client_id', 'client_secret', 'issuer'],
  missing_for_enable: ['client_id', 'client_secret', 'issuer'],
});
const AWS = makeView({
  provider_id: 'aws',
  label: 'AWS',
  required_fields: ['client_id', 'client_secret', 'issuer'],
  missing_for_enable: ['client_id', 'client_secret', 'issuer'],
});
/** Synthetic coming-soon stand-in so the Add menu / keyboard tests keep covering that path. */
const KEYCLOAK = makeView({
  provider_id: 'keycloak',
  label: 'Keycloak',
  status: 'coming-soon',
  required_fields: [],
  missing_for_enable: [],
});

const DEFAULT_LIST = { providers: [GITHUB, GITLAB, AZURE, GOOGLE, OKTA, AWS, KEYCLOAK] };

/** Install a fetch mock; `putHandler` decides PUT responses, `listBodies` queues GET bodies. */
function mockFetch(
  putHandler?: (url: string, body: Record<string, unknown>) => { status: number; body: unknown },
  listBodies: unknown[] = [DEFAULT_LIST]
) {
  let listCall = 0;
  const impl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const body = listBodies[Math.min(listCall, listBodies.length - 1)];
      listCall += 1;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    if (method === 'PUT' && putHandler) {
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      const result = putHandler(url, parsed);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      } as unknown as Response;
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  global.fetch = impl as unknown as typeof fetch;
  return impl;
}

/** The card `section` for a provider label, as a `within` scope. */
async function card(label: string) {
  const region = await screen.findByRole('region', {
    name: `${label} provider configuration`,
  });
  return within(region);
}

/**
 * Add an unconfigured provider's card to the list via the header's "+ Add Provider" menu.
 * Waits for the initial load first (the trigger is disabled until then).
 */
async function addProvider(label: string) {
  const trigger = await screen.findByRole('button', { name: 'Add Provider' });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(label) }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AuthProviderSettingsClient — rendering', () => {
  it('lists only configured providers; the rest stay out of the way', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    // GitLab is the only provider with DB-stored config in the fixture.
    expect(
      await screen.findByRole('region', { name: 'GitLab provider configuration' })
    ).toBeInTheDocument();
    for (const label of ['GitHub', 'Microsoft', 'Google', 'AWS', 'Keycloak']) {
      expect(
        screen.queryByRole('region', { name: `${label} provider configuration` })
      ).not.toBeInTheDocument();
    }
  });

  it('shows an empty-state card when no providers are configured', async () => {
    mockFetch(undefined, [{ providers: [GITHUB, AZURE, GOOGLE, AWS, KEYCLOAK] }]);
    render(<AuthProviderSettingsClient />);

    expect(await screen.findByText('No providers configured.')).toBeInTheDocument();
    expect(screen.getByText('Click Add to add a new provider.')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('offers unconfigured providers in the Add menu, coming-soon ones disabled', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const trigger = await screen.findByRole('button', { name: 'Add Provider' });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);

    const menu = within(screen.getByRole('menu'));
    // GitLab is configured, so it is not offered again.
    expect(menu.queryByRole('menuitem', { name: /GitLab/ })).not.toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /GitHub/ })).toBeEnabled();
    expect(menu.getByRole('menuitem', { name: /Microsoft/ })).toBeEnabled();
    // Google (OLO-9.2), Okta (OLO-9.3), and AWS Cognito (OLO-9.4) are available/selectable;
    // only the synthetic Keycloak stand-in stays coming-soon/disabled.
    expect(menu.getByRole('menuitem', { name: /Google/ })).toBeEnabled();
    expect(menu.getByRole('menuitem', { name: /Okta/ })).toBeEnabled();
    expect(menu.getByRole('menuitem', { name: /AWS/ })).toBeEnabled();
    expect(menu.getByRole('menuitem', { name: /Keycloak/ })).toBeDisabled();
  });

  it('dismisses an added-but-unsaved card via Cancel, returning it to the Add menu', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    const github = await card('GitHub');
    fireEvent.click(github.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.queryByRole('region', { name: 'GitHub provider configuration' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: /GitHub/ })
    ).toBeEnabled();
  });

  it('offers no Cancel on a persisted provider card', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    expect(gitlab.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('adds a provider card from the menu and stops offering it there', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    expect(
      await screen.findByRole('region', { name: 'GitHub provider configuration' })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const menu = within(screen.getByRole('menu'));
    expect(menu.queryByRole('menuitem', { name: /GitHub/ })).not.toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /Microsoft/ })).toBeEnabled();
  });

  it('shows per-field "using .env fallback" indicators exactly where no DB value is set', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    // GitHub stores nothing: enablement, client id, secret, and both extras fall back.
    await addProvider('GitHub');
    const github = await card('GitHub');
    expect(github.getAllByText('using .env fallback').length).toBe(5);

    // GitLab stores everything it renders: no fallback badges at all.
    const gitlab = await card('GitLab');
    expect(gitlab.queryByText('using .env fallback')).not.toBeInTheDocument();
  });

  it('never renders a secret: only set/not-set state, an empty write-only input', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    expect(gitlab.getByText('Secret: set')).toBeInTheDocument();
    const secretInput = gitlab.getByLabelText('Client secret') as HTMLInputElement;
    expect(secretInput.type).toBe('password');
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toMatch(/Secret is set/);

    await addProvider('GitHub');
    const github = await card('GitHub');
    expect(github.getByText('Secret: not set')).toBeInTheDocument();
  });

  it('reflects stored state: enablement chip, client id value, extras from config JSONB', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    expect(gitlab.getByText('Enabled (database)')).toBeInTheDocument();
    expect((gitlab.getByLabelText('Client ID') as HTMLInputElement).value).toBe(
      'gitlab-client-id'
    );
    expect((gitlab.getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://git.example.com'
    );
    expect(gitlab.getByText(/Last changed/)).toBeInTheDocument();

    await addProvider('GitHub');
    const github = await card('GitHub');
    expect(github.getByText('Env-derived')).toBeInTheDocument();
  });

  it('surfaces a load failure with a retry affordance', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    render(<AuthProviderSettingsClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});

describe('AuthProviderSettingsClient — Add menu search & scroll', () => {
  /** Open the header's Add menu (waiting for load) and return a `within` scope for it. */
  async function openAddMenu() {
    const trigger = await screen.findByRole('button', { name: 'Add Provider' });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    return within(screen.getByRole('menu'));
  }

  it('shows a focused search box at the top of the menu', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    const search = menu.getByRole('textbox', { name: 'Search providers' });
    expect(search).toHaveFocus();
    // The search stays pinned above the scroll region rather than scrolling away with the items.
    const scrollRegion = screen.getByRole('menu').querySelector('.max-h-64.overflow-y-auto');
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion).not.toContainElement(search);
  });

  it('renders the item list inside a capped-height scrollable region', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    const scrollRegion = screen.getByRole('menu').querySelector('.max-h-64.overflow-y-auto');
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion).toContainElement(menu.getByRole('menuitem', { name: /GitHub/ }));
  });

  it('filters candidates by name, case-insensitively', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    fireEvent.change(menu.getByRole('textbox', { name: 'Search providers' }), {
      target: { value: 'GOO' },
    });

    expect(menu.getByRole('menuitem', { name: /Google/ })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: /GitHub/ })).not.toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: /Microsoft/ })).not.toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: /AWS/ })).not.toBeInTheDocument();
  });

  it('also matches the registry slug, not just the label', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    // "azure" is the slug; the label is "Microsoft".
    fireEvent.change(menu.getByRole('textbox', { name: 'Search providers' }), {
      target: { value: 'azure' },
    });

    expect(menu.getByRole('menuitem', { name: /Microsoft/ })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it('shows a no-match message quoting the query, and recovers when cleared', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    const search = menu.getByRole('textbox', { name: 'Search providers' });
    fireEvent.change(search, { target: { value: 'zzz' } });

    expect(menu.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(menu.getByText(/No providers match/)).toHaveTextContent('zzz');

    fireEvent.change(search, { target: { value: '' } });
    expect(menu.getByRole('menuitem', { name: /GitHub/ })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /AWS/ })).toBeInTheDocument();
  });

  it('Enter adds the first available match and closes the menu', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    const search = menu.getByRole('textbox', { name: 'Search providers' });
    fireEvent.change(search, { target: { value: 'goo' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(
      await screen.findByRole('region', { name: 'Google provider configuration' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Enter is a no-op when the only match is coming-soon', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    const search = menu.getByRole('textbox', { name: 'Search providers' });
    fireEvent.change(search, { target: { value: 'keycloak' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    // Nothing added, menu still open — coming-soon entries stay unselectable via keyboard too.
    expect(
      screen.queryByRole('region', { name: 'Keycloak provider configuration' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('resets the query on close so a fresh open starts unfiltered', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const menu = await openAddMenu();
    fireEvent.change(menu.getByRole('textbox', { name: 'Search providers' }), {
      target: { value: 'goo' },
    });
    expect(menu.queryByRole('menuitem', { name: /GitHub/ })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const reopened = await openAddMenu();
    expect(reopened.getByRole('textbox', { name: 'Search providers' })).toHaveValue('');
    expect(reopened.getByRole('menuitem', { name: /GitHub/ })).toBeInTheDocument();
  });
});

describe('AuthProviderSettingsClient — saving', () => {
  it('saves only the fields the admin changed (partial update), then shows Saved', async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    mockFetch((url, body) => {
      puts.push({ url, body });
      return {
        status: 200,
        body: makeView({ client_id: 'new-github-id', client_id_source: 'db' }),
      };
    });
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    const github = await card('GitHub');
    expect(github.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(github.getByLabelText('Client ID'), {
      target: { value: 'new-github-id' },
    });
    expect(github.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(github.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(github.getByText('Saved')).toBeInTheDocument());
    expect(puts).toEqual([
      {
        url: '/api/admin/auth-providers/github',
        body: { client_id: 'new-github-id' },
      },
    ]);
  });

  it('sends a typed secret write-only and resets the input after saving', async () => {
    const puts: Array<Record<string, unknown>> = [];
    mockFetch((_url, body) => {
      puts.push(body);
      return { status: 200, body: makeView({ secret_set: true, secret_source: 'db' }) };
    });
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    const github = await card('GitHub');
    fireEvent.change(github.getByLabelText('Client secret'), {
      target: { value: 'super-secret-value' },
    });
    fireEvent.click(github.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(github.getByText('Saved')).toBeInTheDocument());
    expect(puts).toEqual([{ client_secret: 'super-secret-value' }]);
    expect((github.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
    expect(github.getByText('Secret: set')).toBeInTheDocument();
  });

  it('clears a stored secret via the clear affordance (client_secret: null)', async () => {
    const puts: Array<Record<string, unknown>> = [];
    mockFetch((_url, body) => {
      puts.push(body);
      return {
        status: 200,
        body: { ...GITLAB, secret_set: false, secret_source: 'env-fallback' },
      };
    });
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    fireEvent.click(gitlab.getByRole('button', { name: 'Clear stored secret' }));
    expect(gitlab.getByText(/will be cleared on save/)).toBeInTheDocument();
    fireEvent.click(gitlab.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(gitlab.getByText('Saved')).toBeInTheDocument());
    expect(puts).toEqual([{ client_secret: null }]);
    expect(gitlab.getByText('Secret: not set')).toBeInTheDocument();
  });

  it('clears the enable override back to env-derived (enabled: null)', async () => {
    const puts: Array<Record<string, unknown>> = [];
    mockFetch((_url, body) => {
      puts.push(body);
      return {
        status: 200,
        body: { ...GITLAB, enabled: null, enabled_source: 'env-fallback' },
      };
    });
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    fireEvent.click(gitlab.getByRole('radio', { name: 'Use .env' }));
    fireEvent.click(gitlab.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(gitlab.getByText('Saved')).toBeInTheDocument());
    expect(puts).toEqual([{ enabled: null }]);
    expect(gitlab.getByText('Env-derived')).toBeInTheDocument();
  });

  it('shows the structured 422 guidance when enabling an incomplete provider', async () => {
    mockFetch(() => ({
      status: 422,
      body: {
        detail: {
          error: 'provider_incomplete',
          provider_id: 'github',
          missing_fields: ['client_id', 'client_secret'],
          message:
            "Cannot enable 'github': missing required fields client_id, client_secret. " +
            'Set them (or the corresponding env vars) before enabling.',
        },
      },
    }));
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    const github = await card('GitHub');
    fireEvent.click(github.getByRole('radio', { name: 'Enabled' }));
    fireEvent.click(github.getByRole('button', { name: 'Save' }));

    const alert = await waitFor(() => github.getByRole('alert'));
    expect(alert).toHaveTextContent(/Cannot enable 'github'/);
    expect(alert).toHaveTextContent(/Missing: client_id, client_secret/);
    // The card still shows the stored (env-derived) state — nothing was written.
    expect(github.getByText('Env-derived')).toBeInTheDocument();
  });

  it('explains an expired session instead of a generic failure', async () => {
    mockFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    const github = await card('GitHub');
    fireEvent.change(github.getByLabelText('Client ID'), { target: { value: 'x' } });
    fireEvent.click(github.getByRole('button', { name: 'Save' }));

    const alert = await waitFor(() => github.getByRole('alert'));
    expect(alert).toHaveTextContent(/session has expired/);
  });
});

describe('AuthProviderSettingsClient — validate affordance', () => {
  it('surfaces the server-computed completeness check (missing fields)', async () => {
    mockFetch(undefined, [DEFAULT_LIST, DEFAULT_LIST]);
    render(<AuthProviderSettingsClient />);

    await addProvider('GitHub');
    const github = await card('GitHub');
    fireEvent.click(github.getByRole('button', { name: /Validate/ }));

    await waitFor(() =>
      expect(github.getByText(/Not ready to enable/)).toBeInTheDocument()
    );
    expect(github.getByText(/missing: client_id, client_secret/)).toBeInTheDocument();
  });

  it('reports a complete configuration as enable-ready', async () => {
    mockFetch(undefined, [DEFAULT_LIST, DEFAULT_LIST]);
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    fireEvent.click(gitlab.getByRole('button', { name: /Validate/ }));

    await waitFor(() =>
      expect(
        gitlab.getByText(/configuration is complete — this provider can be enabled/)
      ).toBeInTheDocument()
    );
  });
});
