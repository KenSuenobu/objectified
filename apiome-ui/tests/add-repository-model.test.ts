/**
 * The decisions behind the Add-repository redesign (HIVE-7.4, #5321).
 *
 * `add-repository-hive-redesign.test.tsx` renders the screen and `add-repository-css.test.ts`
 * pins the declarations; this holds the rules, with no React in sight. What it covers is the
 * mockup's **Notes → Keeps (1:1)** list — eighteen sentences that must survive the redesign
 * verbatim — and the two validity rules the ticket's acceptance criteria turn on:
 *
 *   1. **Only GitHub linked accounts can browse remotes**, and the limitation is stated.
 *   2. **The public-URL test gives real feedback** — which here means a *standing* verdict that
 *      is withdrawn the moment the URL it was about changes.
 *   3. **Continue is available exactly when the form is complete**, and the sentence that
 *      explains why it is not comes from the same function that disables it.
 *
 * The screen this replaces answered 3 with two separate expressions — one for `disabled`, one
 * for the toast — which is how it came to disable the button while telling the reader nothing
 * was wrong. There is one function now, and this is where it is checked.
 */

import {
  ACCOUNTS_AUTOSELECT_NOTE,
  ACCOUNTS_EMPTY_BODY,
  ACCOUNTS_EMPTY_TITLE,
  ADD_REPOSITORY_SOURCES,
  ADD_REPOSITORY_STEPS,
  BROWSE_LIMITATION_NOTE,
  DEFAULT_SOURCE,
  ENTER_HTTPS_URL_TOAST,
  IMPORT_FAILED_REMEDY,
  IMPORT_FAILED_TITLE,
  LINKED_ACCOUNTS_HREF,
  LIVE_STEP_ID,
  MANAGE_ACCOUNTS_LABEL,
  NOT_ENABLED_MESSAGE,
  PAGE_DESCRIPTION,
  PAGE_TITLE,
  PICK_ACCOUNT_TOAST,
  PICK_REPOSITORY_TOAST,
  PROPOSAL_BADGE,
  PROPOSED_STEPS,
  PROPOSED_STEPS_BADGE,
  PROPOSED_STEPS_TIP,
  REGISTERED_TOAST,
  REPOSITORIES_HREF,
  REPOS_EMPTY,
  REPOS_LOADING,
  REPO_CARD_HINT,
  REQUEST_FAILED,
  SELECT_TENANT_TOAST,
  SOURCE_CARD_HINT,
  SOURCE_CARD_TITLE,
  TEST_BEFORE_CONTINUE_TOAST,
  URL_FIELD_HINT,
  URL_TEST_BUSY_LABEL,
  URL_TEST_LABEL,
  URL_TEST_NEEDS_HTTPS_TOAST,
  URL_TEST_OK_TOAST,
  URL_TEST_UNAUTHORIZED_TOAST,
  URL_TEST_UNREACHABLE,
  URL_TEST_UNTESTED,
  addRepositoryBlocker,
  addRepositoryErrorMessage,
  addRepositoryRequestBody,
  autoSelectedAccountId,
  canBrowseRemotes,
  canSubmitAddRepository,
  cloneUrlFromHtml,
  createdRepositoryId,
  filterRemoteRepos,
  formatGroupAndRepoName,
  githubReposHref,
  isAddRepositorySource,
  isPublicCloneUrl,
  linkedAccountLabel,
  linkedAccountProvider,
  linkedAccountProviderName,
  nonBrowsableProviderNote,
  parseLinkedAccounts,
  remoteReposFromPayload,
  repoSearchPlaceholder,
  reposSearchMiss,
  repositoryPreviewHref,
  sortRemoteRepos,
  urlTestTone,
  type AddRepositoryDraft,
  type LinkedAccount,
  type RemoteRepo,
} from '../src/app/components/ade/repositories/addRepositoryModel';
import { STATUS_TONE } from '../src/app/components/ui/statusVocabulary';

// ---------------------------------------------------------------------------------------
// Fixtures — the accounts and repositories the mockup draws
// ---------------------------------------------------------------------------------------

const GITHUB: LinkedAccount = {
  id: 'acct-gh',
  provider: 'github',
  provider_email: 'ada@example.com',
  provider_username: 'ada-lovelace',
};

const GITLAB: LinkedAccount = {
  id: 'acct-gl',
  provider: 'GitLab',
  provider_email: 'ada@example.com',
  provider_username: null,
};

const PAYMENTS: RemoteRepo = {
  id: 1,
  name: 'payments-specs',
  full_name: 'acme/payments-specs',
  description: 'OpenAPI and AsyncAPI sources for the payments platform',
  private: false,
  default_branch: 'main',
  html_url: 'https://github.com/acme/payments-specs',
};

const NOTIFICATIONS: RemoteRepo = {
  id: 2,
  name: 'notifications-contracts',
  full_name: 'acme/notifications-contracts',
  description: 'Private — push/SMS contract sources',
  private: true,
  default_branch: 'main',
  html_url: 'https://github.com/acme/notifications-contracts',
};

const ENGINE: RemoteRepo = {
  id: 3,
  name: 'analytical-engine',
  full_name: 'ada-lovelace/analytical-engine',
  description: 'Personal experiments',
  private: false,
  html_url: 'https://github.com/ada-lovelace/analytical-engine.git',
};

/** A complete linked-account draft. */
const linkedDraft = (over: Partial<AddRepositoryDraft> = {}): AddRepositoryDraft => ({
  source: 'linked',
  accountId: GITHUB.id,
  repo: NOTIFICATIONS,
  url: '',
  urlTest: null,
  ...over,
});

/** A complete public-URL draft. */
const urlDraft = (over: Partial<AddRepositoryDraft> = {}): AddRepositoryDraft => ({
  source: 'public_url',
  accountId: null,
  repo: null,
  url: 'https://github.com/org/public-repo.git',
  urlTest: { ok: true, message: 'URL responded successfully (reachability check only).' },
  ...over,
});

/* -------------------------------------------------------------------------
   1. The flow, and the three steps that do not exist
   ------------------------------------------------------------------------- */

describe('the stepper', () => {
  it('draws the mockup’s four steps in order', () => {
    expect(ADD_REPOSITORY_STEPS.map((step) => step.label)).toEqual([
      'Source',
      'Repository',
      'Scan settings',
      'Confirm',
    ]);
  });

  it('makes the first step the only live one', () => {
    expect(LIVE_STEP_ID).toBe(ADD_REPOSITORY_STEPS[0].id);
    expect(ADD_REPOSITORY_STEPS.some((step) => step.id === LIVE_STEP_ID)).toBe(true);
  });

  it('says which steps are proposed, and why', () => {
    expect(PROPOSED_STEPS_BADGE).toBe('Steps 2–4 proposed');
    expect(PROPOSED_STEPS_TIP).toBe(
      'Today only step 1 exists; steps 2–4 are the proposed split of this single screen'
    );
  });
});

describe('the proposal', () => {
  it('describes exactly the three steps that are not built', () => {
    expect(PROPOSED_STEPS.map((step) => step.id)).toEqual(
      ADD_REPOSITORY_STEPS.filter((step) => step.id !== LIVE_STEP_ID).map((step) => step.id)
    );
  });

  it('numbers each column with the step it stands for', () => {
    expect(PROPOSED_STEPS.map((step) => step.title)).toEqual([
      '2 · Repository',
      '3 · Scan settings',
      '4 · Confirm',
    ]);
  });

  it('says "not in the app today" in words, not only in a colour', () => {
    // DESIGN.md §6: colour is never the only signal, and the honey frame is a colour.
    expect(PROPOSAL_BADGE).toBe('Redesign proposal — not in the app today');
  });

  it('explains each proposed step rather than only naming it', () => {
    for (const step of PROPOSED_STEPS) {
      expect(step.body.length).toBeGreaterThan(60);
    }
  });
});

/* -------------------------------------------------------------------------
   2. The source choice
   ------------------------------------------------------------------------- */

describe('the source choice', () => {
  it('offers the mockup’s two sources, with its copy verbatim', () => {
    expect(ADD_REPOSITORY_SOURCES).toEqual([
      {
        id: 'linked',
        label: 'Linked account',
        description:
          'Pick from repos accessible via your connected GitHub, GitLab, or Bitbucket account.',
      },
      {
        id: 'public_url',
        label: 'Public Git URL',
        description:
          'Paste the HTTPS clone URL of any public repository — no authentication required.',
      },
    ]);
  });

  it('opens on the linked-account card, as the screen it replaces did', () => {
    expect(DEFAULT_SOURCE).toBe('linked');
  });

  it('narrows a control’s string back to a source', () => {
    expect(isAddRepositorySource('linked')).toBe(true);
    expect(isAddRepositorySource('public_url')).toBe(true);
    expect(isAddRepositorySource('linked_account')).toBe(false);
    expect(isAddRepositorySource('')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   3. Linked accounts — acceptance criterion 1
   ------------------------------------------------------------------------- */

describe('which accounts can browse remotes', () => {
  it('is GitHub, in any case, and nothing else', () => {
    expect(canBrowseRemotes('github')).toBe(true);
    expect(canBrowseRemotes('GitHub')).toBe(true);
    expect(canBrowseRemotes(' GITHUB ')).toBe(true);
    expect(canBrowseRemotes('gitlab')).toBe(false);
    expect(canBrowseRemotes('bitbucket')).toBe(false);
    expect(canBrowseRemotes('')).toBe(false);
    expect(canBrowseRemotes(null)).toBe(false);
    expect(canBrowseRemotes(undefined)).toBe(false);
  });

  it('states the limitation without waiting for the reader to trip over it', () => {
    expect(BROWSE_LIMITATION_NOTE).toContain('GitHub accounts only');
    expect(BROWSE_LIMITATION_NOTE).toContain('Public Git URL');
  });

  it('names the chosen provider when the reader has already picked one', () => {
    expect(nonBrowsableProviderNote('gitlab')).toBe(
      'Browsing repositories from the dashboard is available for GitHub linked accounts. ' +
        'For GitLab, use Public Git URL above, or link a GitHub account.'
    );
    expect(nonBrowsableProviderNote('bitbucket')).toContain('For Bitbucket,');
  });

  it('falls back to "this provider" rather than printing an empty name', () => {
    expect(nonBrowsableProviderNote('')).toContain('For this provider,');
    expect(nonBrowsableProviderNote(null)).toContain('For this provider,');
  });
});

describe('the account tiles', () => {
  it('labels an account by its handle, and by its address when it has none', () => {
    expect(linkedAccountLabel(GITHUB)).toBe('ada-lovelace');
    expect(linkedAccountLabel(GITLAB)).toBe('ada@example.com');
    expect(linkedAccountLabel({ ...GITHUB, provider_username: '   ' })).toBe('ada@example.com');
  });

  it('spells the three known providers the way they spell themselves', () => {
    expect(linkedAccountProviderName('github')).toBe('GitHub');
    expect(linkedAccountProviderName('GITLAB')).toBe('GitLab');
    expect(linkedAccountProviderName('bitbucket')).toBe('Bitbucket');
  });

  it('keeps an unknown provider rather than dropping it', () => {
    expect(linkedAccountProviderName('gitea')).toBe('Gitea');
    expect(linkedAccountProviderName('')).toBe('Account');
  });

  it('maps a provider onto the repositories vocabulary so one palette paints both screens', () => {
    expect(linkedAccountProvider('github')).toBe('github');
    expect(linkedAccountProvider('GitLab')).toBe('gitlab');
    expect(linkedAccountProvider('bitbucket')).toBe('bitbucket');
    // A globe, never another service's logo.
    expect(linkedAccountProvider('gitea')).toBe('public_url');
    expect(linkedAccountProvider(null)).toBe('public_url');
  });

  it('auto-selects only when the choice has already been made for the reader', () => {
    expect(autoSelectedAccountId([GITHUB])).toBe(GITHUB.id);
    expect(autoSelectedAccountId([GITHUB, GITLAB])).toBeNull();
    expect(autoSelectedAccountId([])).toBeNull();
    expect(ACCOUNTS_AUTOSELECT_NOTE).toBe('Auto-selected when exactly one account is linked.');
  });
});

describe('parsing the account payload', () => {
  it('reads the JSON string the helper answers with', () => {
    expect(parseLinkedAccounts(JSON.stringify([GITHUB, GITLAB]))).toEqual([GITHUB, GITLAB]);
  });

  it('accepts an already-parsed array', () => {
    expect(parseLinkedAccounts([GITHUB])).toEqual([GITHUB]);
  });

  it('answers with nothing for a payload that is not a list', () => {
    expect(parseLinkedAccounts('not json')).toEqual([]);
    expect(parseLinkedAccounts('{"accounts":[]}')).toEqual([]);
    expect(parseLinkedAccounts(null)).toEqual([]);
    expect(parseLinkedAccounts(undefined)).toEqual([]);
  });

  it('drops a row with no id rather than rendering a tile that cannot be selected', () => {
    expect(parseLinkedAccounts([GITHUB, { provider: 'github' }, null, 7, { id: '' }])).toEqual([
      GITHUB,
    ]);
  });
});

/* -------------------------------------------------------------------------
   4. The repository picker
   ------------------------------------------------------------------------- */

describe('the repository rows', () => {
  it('sets the owner apart from the name', () => {
    expect(formatGroupAndRepoName('acme/payments-specs')).toBe('acme / payments-specs');
  });

  it('leaves anything that is not an owner/name pair alone', () => {
    expect(formatGroupAndRepoName('payments-specs')).toBe('payments-specs');
    expect(formatGroupAndRepoName('/leading')).toBe('/leading');
    expect(formatGroupAndRepoName('trailing/')).toBe('trailing/');
    expect(formatGroupAndRepoName('')).toBe('');
    expect(formatGroupAndRepoName(undefined)).toBe('');
    expect(formatGroupAndRepoName(null)).toBe('');
  });

  it('splits only on the first slash, so a nested group survives', () => {
    expect(formatGroupAndRepoName('acme/team/specs')).toBe('acme / team/specs');
  });
});

describe('the clone URL derived from a chosen row', () => {
  it('adds the .git suffix exactly once', () => {
    expect(cloneUrlFromHtml(PAYMENTS.html_url)).toBe('https://github.com/acme/payments-specs.git');
    expect(cloneUrlFromHtml(ENGINE.html_url)).toBe(
      'https://github.com/ada-lovelace/analytical-engine.git'
    );
  });

  it('trims a trailing slash before deciding', () => {
    expect(cloneUrlFromHtml('https://github.com/acme/x/')).toBe('https://github.com/acme/x.git');
  });

  it('answers with nothing when the provider gave no URL', () => {
    expect(cloneUrlFromHtml(undefined)).toBeUndefined();
    expect(cloneUrlFromHtml('  ')).toBeUndefined();
    expect(cloneUrlFromHtml(null)).toBeUndefined();
  });
});

describe('ordering and searching the remote list', () => {
  it('sorts by full name, case-insensitively, without mutating the input', () => {
    const input = [NOTIFICATIONS, ENGINE, PAYMENTS];
    const sorted = sortRemoteRepos(input);
    expect(sorted.map((repo) => repo.full_name)).toEqual([
      'acme/notifications-contracts',
      'acme/payments-specs',
      'ada-lovelace/analytical-engine',
    ]);
    expect(input[0]).toBe(NOTIFICATIONS);
  });

  it('matches the name, the owner and the description', () => {
    const all = [PAYMENTS, NOTIFICATIONS, ENGINE];
    expect(filterRemoteRepos(all, 'payments')).toEqual([PAYMENTS]);
    expect(filterRemoteRepos(all, 'ada-lovelace')).toEqual([ENGINE]);
    expect(filterRemoteRepos(all, 'contract')).toEqual([NOTIFICATIONS]);
    expect(filterRemoteRepos(all, 'ACME')).toEqual([PAYMENTS, NOTIFICATIONS]);
  });

  it('returns everything for a blank term', () => {
    const all = [PAYMENTS, NOTIFICATIONS];
    expect(filterRemoteRepos(all, '   ')).toEqual(all);
  });

  it('survives a row whose description is null', () => {
    const bare: RemoteRepo = { id: 9, name: 'bare', full_name: 'acme/bare', description: null };
    expect(filterRemoteRepos([bare], 'bare')).toEqual([bare]);
  });

  it('reads and sorts the browse endpoint’s payload, and ignores unusable rows', () => {
    const payload = { repositories: [ENGINE, PAYMENTS, { name: 'no id' }, null] };
    expect(remoteReposFromPayload(payload).map((repo) => repo.id)).toEqual([1, 3]);
    expect(remoteReposFromPayload({})).toEqual([]);
    expect(remoteReposFromPayload(null)).toEqual([]);
    expect(remoteReposFromPayload({ repositories: 'nope' })).toEqual([]);
  });

  it('keeps the mockup’s state sentences verbatim', () => {
    expect(REPOS_LOADING).toBe('Loading repositories…');
    expect(REPOS_EMPTY).toBe('No repositories returned for this account.');
    expect(repoSearchPlaceholder('ada-lovelace')).toBe('Search repositories for ada-lovelace…');
    expect(reposSearchMiss(' orders ')).toBe('No repositories match “orders”.');
    expect(REPO_CARD_HINT).toContain('group / repository');
    expect(REPO_CARD_HINT).toContain('lock');
  });
});

/* -------------------------------------------------------------------------
   5. The public URL — acceptance criterion 2
   ------------------------------------------------------------------------- */

describe('the URL shape check', () => {
  it('accepts an HTTPS URL with a dotted host', () => {
    expect(isPublicCloneUrl('https://github.com/org/repo.git')).toBe(true);
    expect(isPublicCloneUrl('  https://gitlab.example.com/g/p.git  ')).toBe(true);
  });

  it('refuses anything that is not HTTPS, or has no host', () => {
    expect(isPublicCloneUrl('http://github.com/org/repo.git')).toBe(false);
    expect(isPublicCloneUrl('git@github.com:org/repo.git')).toBe(false);
    expect(isPublicCloneUrl('https://localhost')).toBe(false);
    expect(isPublicCloneUrl('')).toBe(false);
  });
});

describe('the test verdict', () => {
  it('resolves its tone through the shared vocabulary, never as a hue', () => {
    expect(urlTestTone({ ok: true, message: '' })).toBe('ok');
    expect(urlTestTone({ ok: false, message: '' })).toBe('danger');
    // Both are real members of the vocabulary, not strings this module made up.
    expect(STATUS_TONE.succeeded).toBe('ok');
    expect(STATUS_TONE.failed).toBe('danger');
  });

  it('has a sentence for the state before the first test', () => {
    expect(URL_TEST_UNTESTED).toBe('Not tested yet.');
  });

  it('keeps the mockup’s four test outcomes verbatim', () => {
    expect(URL_TEST_LABEL).toBe('Test');
    expect(URL_TEST_BUSY_LABEL).toBe('Testing…');
    expect(URL_TEST_OK_TOAST).toBe('URL looks reachable.');
    expect(URL_TEST_NEEDS_HTTPS_TOAST).toBe('Enter an HTTPS clone URL to test.');
    expect(URL_TEST_UNAUTHORIZED_TOAST).toBe('Sign in to test this URL.');
    expect(URL_TEST_UNREACHABLE).toBe(
      'Could not reach the test service. Check your connection and try again.'
    );
    expect(URL_FIELD_HINT).toBe(
      'Must be reachable without credentials. Private repositories require a linked account instead.'
    );
  });
});

/* -------------------------------------------------------------------------
   6. Whether the reader can continue — acceptance criterion 3’s other half
   ------------------------------------------------------------------------- */

describe('the one rule that both disables the button and explains it', () => {
  it('lets a complete linked-account draft through', () => {
    expect(addRepositoryBlocker(linkedDraft())).toBeNull();
    expect(canSubmitAddRepository(linkedDraft())).toBe(true);
  });

  it('asks for an account before it asks for a repository', () => {
    expect(addRepositoryBlocker(linkedDraft({ accountId: null, repo: null }))).toBe(
      PICK_ACCOUNT_TOAST
    );
    expect(addRepositoryBlocker(linkedDraft({ repo: null }))).toBe(PICK_REPOSITORY_TOAST);
  });

  it('lets a tested public URL through', () => {
    expect(addRepositoryBlocker(urlDraft())).toBeNull();
    expect(canSubmitAddRepository(urlDraft())).toBe(true);
  });

  it('asks for the right shape before it asks for a test', () => {
    expect(addRepositoryBlocker(urlDraft({ url: 'ftp://x', urlTest: null }))).toBe(
      ENTER_HTTPS_URL_TOAST
    );
    expect(addRepositoryBlocker(urlDraft({ urlTest: null }))).toBe(TEST_BEFORE_CONTINUE_TOAST);
  });

  it('does not accept a failed test as a test', () => {
    expect(addRepositoryBlocker(urlDraft({ urlTest: { ok: false, message: 'HTTP 404' } }))).toBe(
      TEST_BEFORE_CONTINUE_TOAST
    );
  });

  it('ignores the other source’s fields entirely', () => {
    // A reader who filled the URL card, switched to linked accounts and picked a repository
    // must not be blocked by the URL they abandoned, and vice versa.
    expect(addRepositoryBlocker(linkedDraft({ url: 'nonsense', urlTest: null }))).toBeNull();
    expect(addRepositoryBlocker(urlDraft({ accountId: null, repo: null }))).toBeNull();
  });
});

describe('the request body', () => {
  it('sends the account, the full name and a derived clone URL for a linked account', () => {
    expect(addRepositoryRequestBody(linkedDraft())).toEqual({
      source: 'linked_account',
      linked_account_id: 'acct-gh',
      repository_full_name: 'acme/notifications-contracts',
      clone_url: 'https://github.com/acme/notifications-contracts.git',
    });
  });

  it('sends the trimmed URL for a public repository', () => {
    expect(addRepositoryRequestBody(urlDraft({ url: '  https://x.dev/a/b.git  ' }))).toEqual({
      source: 'public_url',
      clone_url: 'https://x.dev/a/b.git',
    });
  });

  it('refuses to build a body for an incomplete draft', () => {
    expect(() => addRepositoryRequestBody(linkedDraft({ repo: null }))).toThrow(
      PICK_REPOSITORY_TOAST
    );
    expect(() => addRepositoryRequestBody(urlDraft({ urlTest: null }))).toThrow(
      TEST_BEFORE_CONTINUE_TOAST
    );
  });
});

describe('reading what the API answered', () => {
  it('finds the id of the repository it created', () => {
    expect(createdRepositoryId({ repository: { id: 'r-1' } })).toBe('r-1');
    expect(createdRepositoryId({ repository: { id: 42 } })).toBe('42');
  });

  it('answers null rather than routing to /undefined/preview', () => {
    expect(createdRepositoryId({})).toBeNull();
    expect(createdRepositoryId({ repository: {} })).toBeNull();
    expect(createdRepositoryId({ repository: { id: '' } })).toBeNull();
    expect(createdRepositoryId(null)).toBeNull();
  });

  it('unpicks all four error shapes the API answers in', () => {
    expect(addRepositoryErrorMessage({ error: 'Already registered' }, 'fallback')).toBe(
      'Already registered'
    );
    expect(addRepositoryErrorMessage({ detail: 'Not permitted' }, 'fallback')).toBe(
      'Not permitted'
    );
    expect(addRepositoryErrorMessage({ detail: [{ msg: 'url: invalid' }] }, 'fallback')).toBe(
      'url: invalid'
    );
    expect(addRepositoryErrorMessage({}, 'Bad Request')).toBe('Bad Request');
  });

  it('prefers `error` over `detail` when the API sends both', () => {
    expect(addRepositoryErrorMessage({ error: 'first', detail: 'second' }, 'x')).toBe('first');
  });

  it('never answers with an empty sentence', () => {
    expect(addRepositoryErrorMessage({ error: '  ' }, '')).toBe(REQUEST_FAILED);
    expect(addRepositoryErrorMessage(null, '')).toBe(REQUEST_FAILED);
    expect(addRepositoryErrorMessage({ detail: [] }, '')).toBe(REQUEST_FAILED);
    expect(addRepositoryErrorMessage({ detail: [{}] }, '')).toBe(REQUEST_FAILED);
  });
});

/* -------------------------------------------------------------------------
   7. Routes — acceptance criterion 4
   ------------------------------------------------------------------------- */

describe('where the screen’s links go', () => {
  it('sends Cancel and Back to the repositories list', () => {
    expect(REPOSITORIES_HREF).toBe('/ade/dashboard/repositories');
  });

  it('sends a registered repository to its preview', () => {
    expect(repositoryPreviewHref('r-1')).toBe('/ade/dashboard/repositories/r-1/preview');
  });

  it('escapes an id rather than pasting it into a path', () => {
    expect(repositoryPreviewHref('a/b')).toBe('/ade/dashboard/repositories/a%2Fb/preview');
  });

  it('keys the browse read by account', () => {
    expect(githubReposHref('acct gh')).toBe('/api/sso/github/repos?accountId=acct%20gh');
  });

  it('points the manage link at linked accounts', () => {
    expect(LINKED_ACCOUNTS_HREF).toBe('/ade/dashboard/linked-accounts');
    expect(MANAGE_ACCOUNTS_LABEL).toBe('Manage linked accounts →');
  });
});

/* -------------------------------------------------------------------------
   8. The copy the mockup pins
   ------------------------------------------------------------------------- */

describe('the sentences the mockup’s Keeps (1:1) list names', () => {
  it('keeps the header copy', () => {
    expect(PAGE_TITLE).toBe('Add a repository');
    expect(PAGE_DESCRIPTION).toBe(
      'Register a repository so Apiome can scan it for importable specifications.'
    );
  });

  it('keeps the header description inside DESIGN.md §5.3’s 14-word budget', () => {
    expect(PAGE_DESCRIPTION.split(/\s+/).length).toBeLessThanOrEqual(14);
  });

  it('keeps the source card’s question and its hint', () => {
    expect(SOURCE_CARD_TITLE).toBe('Where does the repository live?');
    expect(SOURCE_CARD_HINT).toBe('Choose a linked account or paste a public Git URL.');
  });

  it('keeps the empty-accounts sentence, split across a title and its body', () => {
    expect(`${ACCOUNTS_EMPTY_TITLE}. ${ACCOUNTS_EMPTY_BODY}`).toBe(
      'No linked accounts yet. Connect GitHub or GitLab to browse private repositories.'
    );
  });

  it('keeps the five blocking toasts', () => {
    expect(SELECT_TENANT_TOAST).toBe('Select a tenant first.');
    expect(ENTER_HTTPS_URL_TOAST).toBe('Enter an HTTPS clone URL.');
    expect(TEST_BEFORE_CONTINUE_TOAST).toBe(
      'Use Test and confirm the URL succeeds before continuing.'
    );
    expect(PICK_ACCOUNT_TOAST).toBe('Pick a linked account.');
    expect(PICK_REPOSITORY_TOAST).toBe('Pick a repository from the list.');
  });

  it('keeps the write’s three outcomes', () => {
    expect(REGISTERED_TOAST).toBe('Repository registered.');
    expect(NOT_ENABLED_MESSAGE).toBe('Repository API is not enabled yet.');
    expect(IMPORT_FAILED_TITLE).toBe('Import failed');
    expect(IMPORT_FAILED_REMEDY).toBe(
      'Fix the problem above and try again, or choose a different source.'
    );
  });
});
