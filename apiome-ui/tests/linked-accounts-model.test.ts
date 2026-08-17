/**
 * What the Linked accounts surface knows (HIVE-4.8, #5302).
 *
 * `src/app/components/ade/account/linkedAccountsModel.ts` is the half of the page that needs no
 * DOM: the row and card view models, the `?linked=true` / `?error=` handshake, the confirm copy
 * and the provider-specific scope tables. Every one of those is a string or a rule the ticket's
 * **Keeps (1:1)** list fixes, and a jsdom render can only check that *some* string reached the
 * screen — so they are pinned here, directly, where a change to the wording fails loudly.
 *
 * Ordered by the acceptance criteria the module answers:
 *
 *   1. **The last-remaining-method guard** — who it fires for, and who it does not.
 *   2. **The PAT flows' scope copy**, and the provider tables behind the cards.
 *   3. **`?linked=true` / `?error=` handling**, including which wins and when the URL is scrubbed.
 *   4. **Coming-soon providers are offered but not linkable**, and unconfigured ones are hidden.
 */

import {
  LAST_METHOD_NOTE,
  LAST_METHOD_TOOLTIP,
  LINKED_ACCOUNTS_PATH,
  LINK_FAILURE_MESSAGE,
  LINK_SUCCESS_MESSAGE,
  PAT_ADD_HINT,
  PAT_PROVIDERS,
  PAT_SCOPES,
  accountHandle,
  buildLinkedAccountRows,
  buildProviderCards,
  describeRemainingMethods,
  isLastSignInMethod,
  parsePayload,
  patMask,
  patScopesFor,
  providerTagline,
  readActionError,
  readLinkOutcome,
  removePatConfirmOptions,
  resolveProviderLabel,
  unlinkConfirmOptions,
  type LinkedAccount,
} from '@/app/components/ade/account/linkedAccountsModel';
import { PROVIDER_REGISTRY, type ProviderSummary } from '@lib/auth/provider-registry';

/** A deployment with GitHub and GitLab configured, Microsoft known but unconfigured. */
const PROVIDERS: ProviderSummary[] = [
  { id: 'github', label: 'GitHub', status: 'available', enabled: true },
  { id: 'gitlab', label: 'GitLab', status: 'available', enabled: true },
  { id: 'azure', label: 'Microsoft', status: 'available', enabled: false },
  { id: 'atlassian', label: 'Atlassian', status: 'coming-soon', enabled: false },
];

/**
 * Build a linked identity.
 *
 * @param overrides The fields this row differs from the default in.
 * @returns The account row.
 */
function account(overrides: Partial<LinkedAccount> = {}): LinkedAccount {
  return {
    id: 'acct-github',
    provider: 'github',
    provider_user_id: 'gh-1',
    provider_email: 'ada@example.com',
    provider_username: 'ada-lovelace',
    access_token_suffix: null,
    created_at: '2026-03-02T17:14:00.000Z',
    last_login_at: null,
    ...overrides,
  };
}

describe('the last-remaining-method guard', () => {
  it('fires for the only identity of a password-less account', () => {
    expect(
      isLastSignInMethod({
        accounts: [{ id: 'acct-github' }],
        hasPassword: false,
        accountId: 'acct-github',
      })
    ).toBe(true);
  });

  it('does not fire when a password is also set', () => {
    expect(
      isLastSignInMethod({
        accounts: [{ id: 'acct-github' }],
        hasPassword: true,
        accountId: 'acct-github',
      })
    ).toBe(false);
  });

  it('does not fire when a second identity is linked', () => {
    for (const accountId of ['acct-github', 'acct-gitlab']) {
      expect(
        isLastSignInMethod({
          accounts: [{ id: 'acct-github' }, { id: 'acct-gitlab' }],
          hasPassword: false,
          accountId,
        })
      ).toBe(false);
    }
  });

  it('does not fire for an id that is not the single linked identity', () => {
    // A stale row id cannot talk the guard into disabling the wrong button.
    expect(
      isLastSignInMethod({
        accounts: [{ id: 'acct-github' }],
        hasPassword: false,
        accountId: 'acct-gone',
      })
    ).toBe(false);
  });

  it('keeps the note and the tooltip the Keeps list fixes', () => {
    expect(LAST_METHOD_NOTE).toBe(
      'Only sign-in method — set a password or link another provider to remove it.'
    );
    expect(LAST_METHOD_TOOLTIP).toBe(
      'This is your only sign-in method. Set a password or link another provider before unlinking it.'
    );
  });
});

describe('buildLinkedAccountRows', () => {
  it('formats both stamps as MM/DD/YY hh:mm AM and leaves a never-signed-in row null', () => {
    const [row] = buildLinkedAccountRows({
      accounts: [account({ last_login_at: null })],
      providers: PROVIDERS,
      hasPassword: true,
    });

    expect(row.linkedAt).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2} [AP]M$/);
    // The page prints the em dash; the model says there is nothing to print.
    expect(row.lastLoginAt).toBeNull();
  });

  it('refuses a timestamp that is not one rather than inventing today', () => {
    const [row] = buildLinkedAccountRows({
      accounts: [account({ created_at: 'not-a-date', last_login_at: 'also-not' })],
      providers: PROVIDERS,
      hasPassword: true,
    });

    expect(row.linkedAt).toBeNull();
    expect(row.lastLoginAt).toBeNull();
  });

  it('labels a row from the registry, and keeps a since-removed provider readable', () => {
    const rows = buildLinkedAccountRows({
      accounts: [
        account({ id: 'a', provider: 'azure', provider_username: null }),
        account({ id: 'b', provider: 'bitbucket', provider_username: 'ada' }),
      ],
      providers: PROVIDERS,
      hasPassword: true,
    });

    // azure is in the registry but unconfigured: the row still reads "Microsoft".
    expect(rows[0].label).toBe('Microsoft');
    expect(rows[0].handle).toBe('ada@example.com');
    // bitbucket is in neither table: capitalised rather than dropped or printed as a slug.
    expect(rows[1].label).toBe('Bitbucket');
  });

  it('reports the stored token without carrying it', () => {
    const [withToken] = buildLinkedAccountRows({
      accounts: [account({ access_token_suffix: 'a1b2c3' })],
      providers: PROVIDERS,
      hasPassword: true,
    });
    const [without] = buildLinkedAccountRows({
      accounts: [account({ access_token_suffix: null })],
      providers: PROVIDERS,
      hasPassword: true,
    });

    expect(withToken.hasPat).toBe(true);
    expect(without.hasPat).toBe(false);
  });

  it('marks exactly the guarded row', () => {
    const rows = buildLinkedAccountRows({
      accounts: [account({ id: 'a' }), account({ id: 'b', provider: 'gitlab' })],
      providers: PROVIDERS,
      hasPassword: false,
    });
    expect(rows.map((row) => row.isLastSignInMethod)).toEqual([false, false]);

    const single = buildLinkedAccountRows({
      accounts: [account({ id: 'a' })],
      providers: PROVIDERS,
      hasPassword: false,
    });
    expect(single[0].isLastSignInMethod).toBe(true);
  });
});

describe('accountHandle', () => {
  it('prefers the handle, falls back to the address, and never invents one', () => {
    expect(accountHandle({ provider_username: 'ada-lovelace', provider_email: 'a@b.c' })).toBe(
      'ada-lovelace'
    );
    expect(accountHandle({ provider_username: null, provider_email: 'a@b.c' })).toBe('a@b.c');
    expect(accountHandle({ provider_username: null, provider_email: '' })).toBe('');
  });
});

describe('the provider cards', () => {
  it('offers enabled providers and coming-soon teasers, and hides the unconfigured', () => {
    const cards = buildProviderCards({ providers: PROVIDERS, accounts: [] });

    expect(cards.map((card) => card.id)).toEqual(['github', 'gitlab', 'atlassian']);
    expect(cards.find((card) => card.id === 'atlassian')).toMatchObject({
      available: false,
      comingSoon: true,
      linked: false,
      showPatRow: false,
    });
  });

  it('draws the token row only for a linked, linkable PAT provider', () => {
    const cards = buildProviderCards({
      providers: PROVIDERS,
      accounts: [account({ provider: 'github', access_token_suffix: 'a1b2c3' })],
    });
    const byId = new Map(cards.map((card) => [card.id, card]));

    // GitHub: a PAT provider, enabled, linked → the row, with the stored suffix.
    expect(byId.get('github')).toMatchObject({
      linked: true,
      supportsPat: true,
      showPatRow: true,
      patSuffix: 'a1b2c3',
    });
    // GitLab: a PAT provider, enabled, *not* linked → no row to put a token on.
    expect(byId.get('gitlab')).toMatchObject({
      linked: false,
      supportsPat: true,
      showPatRow: false,
      patSuffix: null,
    });
    // Atlassian: not a PAT provider at all.
    expect(byId.get('atlassian')).toMatchObject({ supportsPat: false, showPatRow: false });
  });

  it('names only the two providers that take a Personal Access Token', () => {
    expect([...PAT_PROVIDERS].sort()).toEqual(['github', 'gitlab']);
  });

  it('gives every provider in the registry a one-liner', () => {
    // Walked from the registry rather than from a fixture, so a provider added by a future OLO
    // ticket cannot reach the grid as a bare name with nothing under it.
    for (const provider of PROVIDER_REGISTRY) {
      expect(providerTagline(provider.id)).toBeTruthy();
    }
  });

  it('gives none to a provider it does not know, rather than a guess', () => {
    expect(providerTagline('bitbucket')).toBeNull();
    const [card] = buildProviderCards({
      providers: [{ id: 'bitbucket', label: 'Bitbucket', status: 'available', enabled: true }],
      accounts: [],
    });
    expect(card.tagline).toBeNull();
  });

  it('prefers the deployment label over the built-in one', () => {
    const renamed: ProviderSummary[] = [
      { id: 'oidc', label: 'Acme SSO', status: 'available', enabled: true },
    ];
    expect(resolveProviderLabel('oidc', renamed)).toBe('Acme SSO');
    // Not in the summaries at all → the built-in display name.
    expect(resolveProviderLabel('oidc', [])).toBe('OpenID Connect');
  });
});

describe('the PAT scope copy', () => {
  it('keeps both providers’ scope lists word for word', () => {
    expect(PAT_SCOPES.github).toBe('repo (or public_repo), read:org, read:user, user:email');
    expect(PAT_SCOPES.gitlab).toBe('read_api, read_repository, read_user');
    expect(patScopesFor('github')).toBe(PAT_SCOPES.github);
    expect(patScopesFor('gitlab')).toBe(PAT_SCOPES.gitlab);
  });

  it('answers null rather than guessing another product’s permission model', () => {
    expect(patScopesFor('azure')).toBeNull();
    expect(patScopesFor('bitbucket')).toBeNull();
  });

  it('masks a stored token to six bullets and six characters', () => {
    expect(patMask('a1b2c3')).toBe('••••••a1b2c3');
    expect(PAT_ADD_HINT).toBe('Optional: add a PAT for direct repo access.');
  });
});

describe('readLinkOutcome', () => {
  it('reports a completed link and asks for the URL to be scrubbed', () => {
    expect(readLinkOutcome('?linked=true')).toEqual({
      success: LINK_SUCCESS_MESSAGE,
      error: null,
      cleanUrl: true,
    });
    // With or without the leading `?`, since `location.search` carries it and a test may not.
    expect(readLinkOutcome('linked=true').success).toBe(LINK_SUCCESS_MESSAGE);
  });

  it('reports the callback’s own error text', () => {
    expect(readLinkOutcome('?error=identity-linked-elsewhere')).toEqual({
      success: null,
      error: 'identity-linked-elsewhere',
      cleanUrl: true,
    });
  });

  it('falls back to a sentence when the error parameter is empty', () => {
    expect(readLinkOutcome('?error=').error).toBe(LINK_FAILURE_MESSAGE);
  });

  it('lets a completed link win over an error it recovered from', () => {
    const outcome = readLinkOutcome('?linked=true&error=state-mismatch');
    expect(outcome.success).toBe(LINK_SUCCESS_MESSAGE);
    expect(outcome.error).toBeNull();
  });

  it('says nothing, and scrubs nothing, on a plain visit', () => {
    expect(readLinkOutcome('')).toEqual({ success: null, error: null, cleanUrl: false });
    expect(readLinkOutcome('?tab=providers')).toEqual({
      success: null,
      error: null,
      cleanUrl: false,
    });
    // `?linked=false` is not a completed link.
    expect(readLinkOutcome('?linked=false').cleanUrl).toBe(false);
  });

  it('names the route the round trip returns to', () => {
    expect(LINKED_ACCOUNTS_PATH).toBe('/ade/dashboard/linked-accounts');
  });
});

describe('describeRemainingMethods', () => {
  it('names one, two and three remaining ways in', () => {
    expect(describeRemainingMethods({ hasPassword: true, otherLabels: [] })).toBe('your password');
    expect(describeRemainingMethods({ hasPassword: false, otherLabels: ['GitLab'] })).toBe('GitLab');
    expect(describeRemainingMethods({ hasPassword: true, otherLabels: ['GitLab'] })).toBe(
      'your password or GitLab'
    );
    expect(
      describeRemainingMethods({ hasPassword: true, otherLabels: ['GitHub', 'GitLab'] })
    ).toBe('your password, GitHub or GitLab');
  });

  it('answers null when nothing would be left, rather than claiming something would', () => {
    expect(describeRemainingMethods({ hasPassword: false, otherLabels: [] })).toBeNull();
  });
});

describe('the destructive confirms', () => {
  it('names the object, keeps the Keeps sentence, and states the consequence', () => {
    const options = unlinkConfirmOptions({
      label: 'GitHub',
      handle: 'ada-lovelace',
      hasPat: true,
      remaining: 'your password or GitLab',
    });

    expect(options.title).toBe('Unlink GitHub account?');
    expect(options.message).toBe(
      'Are you sure you want to unlink your GitHub account (ada-lovelace)?'
    );
    expect(options.consequence).toBe(
      'You can still sign in with your password or GitLab. The stored Personal Access Token is removed too.'
    );
    expect(options.variant).toBe('danger');
    // DESIGN.md §8: a button is a verb, never "OK".
    expect(options.confirmLabel).toBe('Unlink');
    expect(options.cancelLabel).toBe('Cancel');
    // Reserved for tenants, projects and user deletes — never for an unlink.
    expect(options.typeToConfirm).toBeUndefined();
  });

  it('drops the token sentence for an identity with no token', () => {
    const options = unlinkConfirmOptions({
      label: 'GitLab',
      handle: 'ada@example.com',
      hasPat: false,
      remaining: 'your password',
    });
    expect(options.consequence).toBe('You can still sign in with your password.');
  });

  it('says nothing about what is left when nothing is', () => {
    const options = unlinkConfirmOptions({
      label: 'GitHub',
      handle: 'ada-lovelace',
      hasPat: false,
      remaining: null,
    });
    expect(options.consequence).toBeUndefined();
  });

  it('names the token being removed and what falls back', () => {
    const options = removePatConfirmOptions({
      label: 'GitHub',
      handle: 'ada-lovelace',
      suffix: 'a1b2c3',
    });

    expect(options.title).toBe('Remove Personal Access Token?');
    expect(options.message).toBe(
      'Are you sure you want to remove the Personal Access Token for your GitHub account (ada-lovelace) (••••••a1b2c3)?'
    );
    expect(options.consequence).toBe(
      'Repository imports that rely on it fall back to the OAuth grant.'
    );
    expect(options.confirmLabel).toBe('Remove token');
  });

  it('leaves the mask out when the row does not carry one', () => {
    const options = removePatConfirmOptions({ label: 'GitLab', handle: 'ada', suffix: null });
    expect(options.message).toBe(
      'Are you sure you want to remove the Personal Access Token for your GitLab account (ada)?'
    );
  });
});

describe('reading a server action’s answer', () => {
  it('reports success as null and a failure as its own message', () => {
    expect(readActionError(JSON.stringify({ success: true }), 'fallback')).toBeNull();
    expect(readActionError(JSON.stringify({ success: false, error: 'Nope' }), 'fallback')).toBe(
      'Nope'
    );
  });

  it('falls back for a failure that does not say why, and for junk', () => {
    expect(readActionError(JSON.stringify({ success: false }), 'fallback')).toBe('fallback');
    expect(readActionError('not json', 'fallback')).toBe('fallback');
    expect(readActionError(JSON.stringify([1, 2]), 'fallback')).toBe('fallback');
    expect(readActionError(JSON.stringify(null), 'fallback')).toBe('fallback');
  });

  it('parses a payload of the asked-for shape and refuses any other', () => {
    expect(parsePayload<number[]>('[1,2]', Array.isArray, [])).toEqual([1, 2]);
    // An object where an array was asked for is the fallback, not a crash.
    expect(parsePayload<number[]>('{"a":1}', Array.isArray, [])).toEqual([]);
    expect(parsePayload<number[]>('oops', Array.isArray, [])).toEqual([]);
  });
});
