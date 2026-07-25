/**
 * System Configuration screen — sign-in provider cards (OLO-8.7, #4973).
 *
 * Integration tests (RTL) for `AuthProviderSettingsClient` against a mocked
 * `/api/admin/auth-providers` proxy, covering the issue's acceptance criteria:
 * only configured providers are listed (the rest are reachable via the header's
 * "+ Add Provider" modal, coming-soon entries disabled there), an empty-state card
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
const KEYCLOAK = makeView({
  provider_id: 'keycloak',
  label: 'Keycloak',
  required_fields: ['client_id', 'client_secret', 'issuer'],
  missing_for_enable: ['client_id', 'client_secret', 'issuer'],
});
const OIDC = makeView({
  provider_id: 'oidc',
  label: 'OIDC',
  required_fields: ['client_id', 'client_secret', 'issuer'],
  missing_for_enable: ['client_id', 'client_secret', 'issuer'],
});
const AUTH0 = makeView({
  provider_id: 'auth0',
  label: 'Auth0',
  required_fields: ['client_id', 'client_secret', 'issuer'],
  missing_for_enable: ['client_id', 'client_secret', 'issuer'],
});
const LINE = makeView({
  provider_id: 'line',
  label: 'LINE',
  required_fields: ['client_id', 'client_secret'],
  missing_for_enable: ['client_id', 'client_secret'],
});
const VK = makeView({
  provider_id: 'vk',
  label: 'VK',
  required_fields: ['client_id', 'client_secret'],
  missing_for_enable: ['client_id', 'client_secret'],
});
/** Synthetic coming-soon stand-in so the Add picker / keyboard tests keep covering that path. */
const ATLASSIAN = makeView({
  provider_id: 'atlassian',
  label: 'Atlassian',
  status: 'coming-soon',
  required_fields: [],
  missing_for_enable: [],
});

const DEFAULT_LIST = {
  providers: [GITHUB, GITLAB, AZURE, GOOGLE, OKTA, AWS, KEYCLOAK, OIDC, AUTH0, LINE, VK, ATLASSIAN],
};

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

/** Open the Add Provider modal (waiting for load) and return a `within` scope for the dialog. */
async function openAddModal() {
  const trigger = await screen.findByRole('button', { name: 'Add Provider' });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  return within(screen.getByRole('dialog', { name: 'Add a sign-in provider' }));
}

/** Pick a provider in the open modal (moves to the configure step). */
async function pickProviderInModal(label: string) {
  const dialog = await openAddModal();
  fireEvent.click(dialog.getByRole('option', { name: new RegExp(label) }));
  return within(screen.getByRole('dialog', { name: 'Add a sign-in provider' }));
}

/**
 * Configure and save a provider via the Add modal so its card appears on the page.
 * Waits for the initial load first (the trigger is disabled until then).
 */
async function addAndSaveProvider(
  label: string,
  fill: (dialog: ReturnType<typeof within>) => void = (dialog) => {
    fireEvent.change(dialog.getByLabelText('Client ID'), {
      target: { value: `${label.toLowerCase()}-client-id` },
    });
  }
) {
  const dialog = await pickProviderInModal(label);
  fill(dialog);
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add a sign-in provider' })).not.toBeInTheDocument()
  );
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
    for (const label of [
      'GitHub',
      'Microsoft',
      'Google',
      'AWS',
      'Keycloak',
      'OIDC',
      'Auth0',
      'LINE',
      'Atlassian',
    ]) {
      expect(
        screen.queryByRole('region', { name: `${label} provider configuration` })
      ).not.toBeInTheDocument();
    }
  });

  it('shows an empty-state card when no providers are configured', async () => {
    mockFetch(undefined, [
      { providers: [GITHUB, AZURE, GOOGLE, AWS, KEYCLOAK, OIDC, AUTH0, LINE, ATLASSIAN] },
    ]);
    render(<AuthProviderSettingsClient />);

    expect(await screen.findByText('No providers configured.')).toBeInTheDocument();
    expect(screen.getByText('Click Add to add a new provider.')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('offers unconfigured providers in the Add modal, coming-soon ones disabled', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    // GitLab is configured, so it is not offered again.
    expect(dialog.queryByRole('option', { name: /GitLab/ })).not.toBeInTheDocument();
    expect(dialog.getByRole('option', { name: /GitHub/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /Microsoft/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /Google/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /Okta/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /AWS/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /Keycloak/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /OIDC/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /Auth0/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /LINE/ })).toBeEnabled();
    expect(dialog.getByRole('option', { name: /Atlassian/ })).toBeDisabled();
  });

  it('closes the Add modal via Cancel without adding a card', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await pickProviderInModal('GitHub');
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.queryByRole('dialog', { name: 'Add a sign-in provider' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'GitHub provider configuration' })
    ).not.toBeInTheDocument();

    const reopened = await openAddModal();
    expect(reopened.getByRole('option', { name: /GitHub/ })).toBeEnabled();
  });

  it('offers no Cancel on a persisted provider card', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const gitlab = await card('GitLab');
    expect(gitlab.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('saves from the Add modal and stops offering that provider there', async () => {
    mockFetch((_url, body) => ({
      status: 200,
      body: makeView({
        client_id: String(body.client_id),
        client_id_source: 'db',
        updated_at: '2026-07-24T12:00:00Z',
      }),
    }));
    render(<AuthProviderSettingsClient />);

    await addAndSaveProvider('GitHub');
    expect(
      await screen.findByRole('region', { name: 'GitHub provider configuration' })
    ).toBeInTheDocument();

    const dialog = await openAddModal();
    expect(dialog.queryByRole('option', { name: /GitHub/ })).not.toBeInTheDocument();
    expect(dialog.getByRole('option', { name: /Microsoft/ })).toBeEnabled();
  });

  it('shows per-field "using .env fallback" indicators exactly where no DB value is set', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    // GitHub stores nothing: enablement, client id, secret, and both extras fall back (modal form).
    const dialog = await pickProviderInModal('GitHub');
    expect(dialog.getAllByText('using .env fallback').length).toBe(5);

    // GitLab stores everything it renders: no fallback badges at all.
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
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

    const dialog = await pickProviderInModal('GitHub');
    expect(dialog.getByText('Secret: not set')).toBeInTheDocument();
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

    const dialog = await pickProviderInModal('GitHub');
    expect(dialog.getByText('Env-derived')).toBeInTheDocument();
  });

  it('surfaces a load failure with a retry affordance', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    render(<AuthProviderSettingsClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});

describe('AuthProviderSettingsClient — Add modal search & scroll', () => {
  it('lists picker options alphabetically by label', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    const labels = dialog
      .getAllByRole('option')
      .map((option) => option.querySelector('span.min-w-0')?.textContent?.trim() ?? '');
    expect(labels).toEqual(
      [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    );
    // Registry order starts with GitHub; alphabetical by label does not (Atlassian, Auth0, AWS, …).
    expect(labels[0]).toBe('Atlassian');
    expect(labels.indexOf('GitHub')).toBeGreaterThan(labels.indexOf('Auth0'));
    expect(labels.indexOf('Microsoft')).toBeGreaterThan(labels.indexOf('Keycloak'));
  });

  it('shows a focused search box at the top of the picker', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    const search = dialog.getByRole('textbox', { name: 'Search providers' });
    expect(search).toHaveFocus();
    const scrollRegion = dialog.getByRole('listbox').closest('.max-h-80');
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion).not.toContainElement(search);
  });

  it('renders the item list inside a capped-height scrollable region', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    const listbox = dialog.getByRole('listbox');
    expect(listbox.className).toMatch(/max-h-80/);
    expect(listbox).toContainElement(dialog.getByRole('option', { name: /GitHub/ }));
  });

  it('filters candidates by name, case-insensitively', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    fireEvent.change(dialog.getByRole('textbox', { name: 'Search providers' }), {
      target: { value: 'GOO' },
    });

    expect(dialog.getByRole('option', { name: /Google/ })).toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: /GitHub/ })).not.toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: /Microsoft/ })).not.toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: /AWS/ })).not.toBeInTheDocument();
  });

  it('also matches the registry slug, not just the label', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    // "azure" is the slug; the label is "Microsoft".
    fireEvent.change(dialog.getByRole('textbox', { name: 'Search providers' }), {
      target: { value: 'azure' },
    });

    expect(dialog.getByRole('option', { name: /Microsoft/ })).toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it('shows a no-match message quoting the query, and recovers when cleared', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    const search = dialog.getByRole('textbox', { name: 'Search providers' });
    fireEvent.change(search, { target: { value: 'zzz' } });

    expect(dialog.queryByRole('option')).not.toBeInTheDocument();
    expect(dialog.getByText(/No providers match/)).toHaveTextContent('zzz');

    fireEvent.change(search, { target: { value: '' } });
    expect(dialog.getByRole('option', { name: /GitHub/ })).toBeInTheDocument();
    expect(dialog.getByRole('option', { name: /AWS/ })).toBeInTheDocument();
  });

  it('Enter selects the first available match and opens the configure step', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    const search = dialog.getByRole('textbox', { name: 'Search providers' });
    fireEvent.change(search, { target: { value: 'goo' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(await screen.findByText('Configure Google')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Google provider configuration' })).not.toBeInTheDocument();
  });

  it('Enter is a no-op when the only match is coming-soon', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    const search = dialog.getByRole('textbox', { name: 'Search providers' });
    fireEvent.change(search, { target: { value: 'atlassian' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(screen.queryByText('Configure Atlassian')).not.toBeInTheDocument();
    expect(dialog.getByRole('option', { name: /Atlassian/ })).toBeDisabled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('resets the query on close so a fresh open starts unfiltered', async () => {
    mockFetch();
    render(<AuthProviderSettingsClient />);

    const dialog = await openAddModal();
    fireEvent.change(dialog.getByRole('textbox', { name: 'Search providers' }), {
      target: { value: 'goo' },
    });
    expect(dialog.queryByRole('option', { name: /GitHub/ })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const reopened = await openAddModal();
    expect(reopened.getByRole('textbox', { name: 'Search providers' })).toHaveValue('');
    expect(reopened.getByRole('option', { name: /GitHub/ })).toBeInTheDocument();
  });
});

describe('AuthProviderSettingsClient — saving', () => {
  it('saves only the fields the admin changed (partial update) from the Add modal', async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    mockFetch((url, body) => {
      puts.push({ url, body });
      return {
        status: 200,
        body: makeView({
          client_id: 'new-github-id',
          client_id_source: 'db',
          updated_at: '2026-07-24T12:00:00Z',
        }),
      };
    });
    render(<AuthProviderSettingsClient />);

    const dialog = await pickProviderInModal('GitHub');
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(dialog.getByLabelText('Client ID'), {
      target: { value: 'new-github-id' },
    });
    expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    );
    expect(puts).toEqual([
      {
        url: '/api/admin/auth-providers/github',
        body: { client_id: 'new-github-id' },
      },
    ]);
    const github = await card('GitHub');
    expect((github.getByLabelText('Client ID') as HTMLInputElement).value).toBe('new-github-id');
  });

  it('sends a typed secret write-only from the Add modal', async () => {
    const puts: Array<Record<string, unknown>> = [];
    mockFetch((_url, body) => {
      puts.push(body);
      return {
        status: 200,
        body: makeView({
          secret_set: true,
          secret_source: 'db',
          updated_at: '2026-07-24T12:00:00Z',
        }),
      };
    });
    render(<AuthProviderSettingsClient />);

    const dialog = await pickProviderInModal('GitHub');
    fireEvent.change(dialog.getByLabelText('Client secret'), {
      target: { value: 'super-secret-value' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts).toEqual([{ client_secret: 'super-secret-value' }]);
    const github = await card('GitHub');
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

    const dialog = await pickProviderInModal('GitHub');
    fireEvent.click(dialog.getByRole('radio', { name: 'Enabled' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    const alert = await waitFor(() => dialog.getByRole('alert'));
    expect(alert).toHaveTextContent(/Cannot enable 'github'/);
    expect(alert).toHaveTextContent(/Missing: client_id, client_secret/);
    // Modal stays open — nothing was written to the page list.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'GitHub provider configuration' })
    ).not.toBeInTheDocument();
  });

  it('explains an expired session instead of a generic failure', async () => {
    mockFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
    render(<AuthProviderSettingsClient />);

    const dialog = await pickProviderInModal('GitHub');
    fireEvent.change(dialog.getByLabelText('Client ID'), { target: { value: 'x' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    const alert = await waitFor(() => dialog.getByRole('alert'));
    expect(alert).toHaveTextContent(/session has expired/);
  });
});

describe('AuthProviderSettingsClient — validate affordance', () => {
  it('surfaces the server-computed completeness check (missing fields)', async () => {
    mockFetch(
      (_url, body) => ({
        status: 200,
        body: makeView({
          client_id: String(body.client_id),
          client_id_source: 'db',
          updated_at: '2026-07-24T12:00:00Z',
          missing_for_enable: ['client_secret'],
          can_enable: false,
        }),
      }),
      [
        DEFAULT_LIST,
        {
          providers: [
            makeView({
              client_id: 'gh-id',
              client_id_source: 'db',
              updated_at: '2026-07-24T12:00:00Z',
              missing_for_enable: ['client_secret'],
              can_enable: false,
            }),
            GITLAB,
            AZURE,
            GOOGLE,
            OKTA,
            AWS,
            KEYCLOAK,
            OIDC,
            AUTH0,
            ATLASSIAN,
          ],
        },
      ]
    );
    render(<AuthProviderSettingsClient />);

    await addAndSaveProvider('GitHub', (dialog) => {
      fireEvent.change(dialog.getByLabelText('Client ID'), { target: { value: 'gh-id' } });
    });
    const github = await card('GitHub');
    fireEvent.click(github.getByRole('button', { name: /Validate/ }));

    await waitFor(() =>
      expect(github.getByText(/Not ready to enable/)).toBeInTheDocument()
    );
    expect(github.getByText(/missing: client_secret/)).toBeInTheDocument();
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
