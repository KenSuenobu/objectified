/**
 * The API keys derivations (HIVE-5.4, #5307).
 *
 * `api-keys-hive-redesign.test.tsx` renders the screen; this holds the decisions it makes,
 * because every one of them is asked from more than one place and a rule that is only tested
 * through a rendered table is a rule that is only tested in the one case the fixture happens
 * to cover.
 *
 * What it pins is the ticket's acceptance criteria, as properties:
 *
 *   * **Scope presets produce the same scope strings as today** — asserted against
 *     `API_KEY_SCOPE_PRESETS`, the table `lib/db/helper` and the REST layer already share.
 *   * **Expired and revoked keys are non-actionable** — `apiKeyRowActions`, which is what the
 *     row's switch is disabled by, states it once for every surface that asks.
 *   * **The prefix is copyable** — and what lands on the clipboard is the characters, not the
 *     ellipsis the cell draws.
 *
 * Plus the two ordering traps the old screen had no answer for: timestamps that sort as
 * strings, and a key with no expiry sorting as though it expired in 1970.
 */

import {
  apiKeyExpiryNotice,
  apiKeyFacetCounts,
  apiKeyRowActions,
  apiKeyScopeList,
  apiKeyScopeUsage,
  apiKeyStatus,
  copyableApiKeyPrefix,
  describeApiKeyBreakdown,
  describeApiKeyScopePreset,
  describeCreatedApiKey,
  displayApiKeyPrefix,
  formatApiKeyDate,
  formatApiKeyLongDate,
  formatApiKeyTimestamp,
  isApiKeyExpired,
  isFullAccessKey,
  matchesApiKeyFacet,
  parseApiKeyExpiry,
  scopesForApiKeyPreset,
  searchApiKeys,
  sortApiKeys,
  summariseApiKeys,
  validateApiKeyDraft,
  API_KEY_EXPIRY_WARNING_DAYS,
  API_KEY_FACETS,
  API_KEY_SCOPE_PRESET_OPTIONS,
  API_KEY_SCOPE_REFERENCE,
  API_KEY_STATUS_LABEL,
  EMPTY_API_KEY_DRAFT,
  type ApiKeyRecord,
} from '../src/app/components/ade/apiKeys/apiKeysModel';
import { API_KEY_SCOPE_PRESETS } from '../src/app/utils/apiKeyScopes';

/** The moment every test judges against, so nothing here depends on the wall clock. */
const NOW = new Date('2026-08-17T12:00:00Z');

/**
 * Build a key, with the fields a test does not care about filled in.
 *
 * @param over The fields this test is about.
 * @returns The record.
 */
function key(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'k-1',
    tenant_id: 't-1',
    name: 'CI contract gate',
    description: 'Blocks merges on breaking classified diffs.',
    key_prefix: 'sk_9f31c2Qm...',
    scopes: ['diff:read'],
    last_used_at: '2026-08-15T08:02:00Z',
    expires_at: null,
    enabled: true,
    created_at: '2026-07-02T10:14:00Z',
    updated_at: '2026-07-02T10:14:00Z',
    ...over,
  };
}

/** Four keys covering every status the screen can draw. */
const KEYS: ApiKeyRecord[] = [
  key({ id: 'k-active', name: 'CI contract gate', expires_at: '2027-01-02T00:00:00Z' }),
  key({
    id: 'k-disabled',
    name: 'Nightly lint',
    scopes: ['lint:read'],
    enabled: false,
    expires_at: null,
    key_prefix: 'sk_2ab7e0Zz...',
  }),
  key({
    id: 'k-expired',
    name: 'Partner sync',
    scopes: ['*'],
    expires_at: '2026-08-01T00:00:00Z',
    key_prefix: 'sk_c41d88Aa...',
  }),
  key({
    id: 'k-both',
    name: 'Terraform',
    scopes: ['diff:read', 'lint:read'],
    last_used_at: null,
    expires_at: '2026-11-12T00:00:00Z',
    key_prefix: 'sk_77e0a1Bb...',
  }),
];

describe('status', () => {
  it('reports the three states the table draws', () => {
    expect(apiKeyStatus(KEYS[0], NOW)).toBe('active');
    expect(apiKeyStatus(KEYS[1], NOW)).toBe('disabled');
    expect(apiKeyStatus(KEYS[2], NOW)).toBe('expired');
  });

  it('lets expiry out-rank the switch, because an expired key is refused either way', () => {
    const expiredButOn = key({ enabled: true, expires_at: '2026-08-01T00:00:00Z' });
    const expiredAndOff = key({ enabled: false, expires_at: '2026-08-01T00:00:00Z' });
    expect(apiKeyStatus(expiredButOn, NOW)).toBe('expired');
    expect(apiKeyStatus(expiredAndOff, NOW)).toBe('expired');
  });

  it('does not retire a key whose expiry cannot be parsed', () => {
    expect(isApiKeyExpired(key({ expires_at: 'not a date' }), NOW)).toBe(false);
    expect(apiKeyStatus(key({ expires_at: 'not a date' }), NOW)).toBe('active');
  });

  it('treats a missing expiry as no expiry', () => {
    expect(isApiKeyExpired(key({ expires_at: null }), NOW)).toBe(false);
  });

  it('names every state', () => {
    expect(API_KEY_STATUS_LABEL).toEqual({
      active: 'Active',
      disabled: 'Disabled',
      expired: 'Expired',
    });
  });
});

describe('what a row still offers', () => {
  it('refuses the switch on an expired key, and says why', () => {
    const actions = apiKeyRowActions(KEYS[2], NOW);
    expect(actions.canToggle).toBe(false);
    expect(actions.toggleDisabledReason).toMatch(/expired/i);
  });

  it('still offers Delete on an expired key — that is the remedy the banner asks for', () => {
    expect(apiKeyRowActions(KEYS[2], NOW).canDelete).toBe(true);
  });

  it('offers the switch on a disabled key, because enabling is the reversible direction', () => {
    const actions = apiKeyRowActions(KEYS[1], NOW);
    expect(actions.canToggle).toBe(true);
    expect(actions.toggleDisabledReason).toBeNull();
  });
});

describe('the prefix', () => {
  it('draws exactly one ellipsis, whatever the stored prefix ends with', () => {
    expect(displayApiKeyPrefix('sk_9f31c2Qm...')).toBe('sk_9f31c2Qm…');
    expect(displayApiKeyPrefix('sk_9f31c2Qm')).toBe('sk_9f31c2Qm…');
    expect(displayApiKeyPrefix('sk_9f31c2Qm…')).toBe('sk_9f31c2Qm…');
  });

  it('copies the characters and not the ellipsis, so a log search matches', () => {
    expect(copyableApiKeyPrefix('sk_9f31c2Qm...')).toBe('sk_9f31c2Qm');
    expect(copyableApiKeyPrefix('')).toBe('');
  });
});

describe('timestamps', () => {
  it('prints the list format the screen this replaces used', () => {
    // Built from the parts rather than asserted as a literal: the suite must not depend on
    // the machine's time zone, only on the shape.
    expect(formatApiKeyTimestamp('2026-08-15T08:02:00Z')).toMatch(
      /^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2} (AM|PM)$/
    );
    expect(formatApiKeyDate('2026-08-15T08:02:00Z')).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
  });

  it('says Never rather than Invalid Date', () => {
    expect(formatApiKeyTimestamp(null)).toBe('Never');
    expect(formatApiKeyTimestamp('nonsense')).toBe('Never');
    expect(formatApiKeyDate(undefined)).toBe('Never');
    expect(formatApiKeyLongDate('nonsense')).toBeNull();
  });

  it('spells a date out for the banner', () => {
    // Shape, not a literal — the stamp is rendered in the reader's zone.
    expect(formatApiKeyLongDate('2026-08-01T12:00:00Z')).toMatch(/^[A-Z][a-z]+ \d{1,2}, 2026$/);
  });
});

describe('scopes', () => {
  it('reports full access as no scopes, so the cell can say so in words', () => {
    expect(apiKeyScopeList(key({ scopes: ['*'] }))).toEqual([]);
    expect(isFullAccessKey(key({ scopes: ['*'] }))).toBe(true);
  });

  it('treats a missing or empty scopes column as full access (pre-V177 rows)', () => {
    expect(isFullAccessKey(key({ scopes: null }))).toBe(true);
    expect(isFullAccessKey(key({ scopes: [] }))).toBe(true);
  });

  it('lists real scopes in order', () => {
    expect(apiKeyScopeList(key({ scopes: ['diff:read', 'lint:read'] }))).toEqual([
      'diff:read',
      'lint:read',
    ]);
  });

  it('draws an unreadable scopes column as full access rather than throwing', () => {
    // `normalizeApiKeyScopes` rejects both of these. A table that cannot draw a row is worse
    // than a row that overstates one key's reach — and the row is where Delete lives.
    expect(isFullAccessKey(key({ scopes: ['nonsense:read'] }))).toBe(true);
    expect(isFullAccessKey(key({ scopes: ['*', 'diff:read'] }))).toBe(true);
  });

  it('counts how many of the tenant keys hold each scope', () => {
    expect(apiKeyScopeUsage(KEYS)).toEqual({
      '*': 1,
      'diff:read': 2,
      'lint:read': 2,
    });
  });

  it('describes the three scopes the reference card lists', () => {
    expect(API_KEY_SCOPE_REFERENCE.map((entry) => entry.scope)).toEqual([
      '*',
      'diff:read',
      'lint:read',
    ]);
    expect(API_KEY_SCOPE_REFERENCE.filter((entry) => entry.full)).toHaveLength(1);
  });
});

describe('the four presets', () => {
  it('produce exactly the scope strings the server already stores', () => {
    // The acceptance criterion, as a property: every option reads its scopes from the shared
    // table rather than restating them.
    for (const option of API_KEY_SCOPE_PRESET_OPTIONS) {
      expect([...option.scopes]).toEqual(API_KEY_SCOPE_PRESETS[option.value]);
      expect([...scopesForApiKeyPreset(option.value)]).toEqual(
        API_KEY_SCOPE_PRESETS[option.value]
      );
    }
  });

  it('cover every preset the shared table defines, in the mockup order', () => {
    expect(API_KEY_SCOPE_PRESET_OPTIONS.map((option) => option.value)).toEqual([
      'full',
      'diff',
      'lint',
      'ci_both',
    ]);
    expect(API_KEY_SCOPE_PRESET_OPTIONS).toHaveLength(
      Object.keys(API_KEY_SCOPE_PRESETS).length
    );
  });

  it('describe themselves in one line for the secret dialog', () => {
    expect(describeApiKeyScopePreset('full')).toBe('full access');
    expect(describeApiKeyScopePreset('ci_both')).toBe('diff:read + lint:read');
  });
});

describe('searching', () => {
  it('matches a name', () => {
    expect(searchApiKeys(KEYS, 'terraform').map((k) => k.id)).toEqual(['k-both']);
  });

  it('matches a prefix pasted out of a log, without its ellipsis', () => {
    expect(searchApiKeys(KEYS, 'sk_c41d88').map((k) => k.id)).toEqual(['k-expired']);
  });

  it('matches a description', () => {
    expect(searchApiKeys(KEYS, 'classified diffs')).toHaveLength(4);
  });

  it('returns everything for a blank query, without aliasing the input', () => {
    const all = searchApiKeys(KEYS, '   ');
    expect(all).toHaveLength(KEYS.length);
    expect(all).not.toBe(KEYS);
  });
});

describe('facets', () => {
  it('counts every chip, with All as the total', () => {
    expect(apiKeyFacetCounts(KEYS, NOW)).toEqual({
      all: 4,
      active: 2,
      disabled: 1,
      expired: 1,
    });
  });

  it('narrows to the chip that was pressed', () => {
    expect(KEYS.filter((k) => matchesApiKeyFacet(k, 'expired', NOW)).map((k) => k.id)).toEqual([
      'k-expired',
    ]);
    expect(KEYS.filter((k) => matchesApiKeyFacet(k, 'all', NOW))).toHaveLength(4);
  });

  it('offers the four chips the mockup draws', () => {
    expect(API_KEY_FACETS).toEqual(['all', 'active', 'disabled', 'expired']);
  });
});

describe('sorting', () => {
  it('leaves the server order alone when nothing is sorted', () => {
    expect(sortApiKeys(KEYS, null, NOW).map((k) => k.id)).toEqual(KEYS.map((k) => k.id));
  });

  it('sorts names case-insensitively', () => {
    const sorted = sortApiKeys(KEYS, { column: 'name', direction: 'asc' }, NOW);
    expect(sorted.map((k) => k.name)).toEqual([
      'CI contract gate',
      'Nightly lint',
      'Partner sync',
      'Terraform',
    ]);
  });

  it('sorts timestamps as instants and not as the strings the cells print', () => {
    // `08/15/26` sorts before `09/02/25` alphabetically, which is the bug this avoids.
    const rows = [
      key({ id: 'sep-25', last_used_at: '2025-09-02T00:00:00Z' }),
      key({ id: 'aug-26', last_used_at: '2026-08-15T00:00:00Z' }),
    ];
    expect(sortApiKeys(rows, { column: 'lastUsed', direction: 'asc' }, NOW).map((k) => k.id)).toEqual(
      ['sep-25', 'aug-26']
    );
  });

  it('sorts a key that never expires last, not first', () => {
    const sorted = sortApiKeys(KEYS, { column: 'expires', direction: 'asc' }, NOW);
    expect(sorted[sorted.length - 1].id).toBe('k-disabled');
    expect(sorted[0].id).toBe('k-expired');
  });

  it('reverses on the second click', () => {
    const asc = sortApiKeys(KEYS, { column: 'name', direction: 'asc' }, NOW).map((k) => k.id);
    const desc = sortApiKeys(KEYS, { column: 'name', direction: 'desc' }, NOW).map((k) => k.id);
    expect(desc).toEqual([...asc].reverse());
  });

  it('breaks ties by name, so a re-sort is stable', () => {
    const rows = [key({ id: 'b', name: 'Beta' }), key({ id: 'a', name: 'Alpha' })];
    expect(sortApiKeys(rows, { column: 'status', direction: 'asc' }, NOW).map((k) => k.id)).toEqual(
      ['a', 'b']
    );
  });

  it('does not mutate what it was given', () => {
    const before = KEYS.map((k) => k.id);
    sortApiKeys(KEYS, { column: 'name', direction: 'desc' }, NOW);
    expect(KEYS.map((k) => k.id)).toEqual(before);
  });
});

describe('the foot', () => {
  it('counts by status', () => {
    expect(summariseApiKeys(KEYS, NOW)).toEqual({
      total: 4,
      active: 2,
      disabled: 1,
      expired: 1,
    });
  });

  it('prints the mockup sentence', () => {
    expect(describeApiKeyBreakdown(summariseApiKeys(KEYS, NOW))).toBe(
      '4 keys · 2 active · 1 disabled · 1 expired'
    );
  });

  it('leaves out the states nothing is in', () => {
    expect(describeApiKeyBreakdown({ total: 1, active: 1, disabled: 0, expired: 0 })).toBe(
      '1 key · 1 active'
    );
    expect(describeApiKeyBreakdown({ total: 0, active: 0, disabled: 0, expired: 0 })).toBe(
      '0 keys'
    );
  });
});

describe('the expiry banner', () => {
  it('says nothing when every key is healthy', () => {
    expect(apiKeyExpiryNotice([KEYS[1], KEYS[3]], NOW)).toBeNull();
  });

  it('names the one expired key, and dates it', () => {
    const notice = apiKeyExpiryNotice(KEYS, NOW);
    expect(notice?.tone).toBe('danger');
    expect(notice?.title).toContain('Partner sync');
    // Compared against the formatter rather than a literal: the stamp is rendered in the
    // reader's zone, and a literal would pin the suite to whichever one CI runs in.
    expect(notice?.title).toContain(formatApiKeyLongDate(KEYS[2].expires_at) as string);
    expect(notice?.body).toMatch(/refused/);
  });

  it('counts several rather than listing them', () => {
    const twoExpired = [
      key({ id: 'x1', name: 'One', expires_at: '2026-08-01T00:00:00Z' }),
      key({ id: 'x2', name: 'Two', expires_at: '2026-07-01T00:00:00Z' }),
    ];
    const notice = apiKeyExpiryNotice(twoExpired, NOW);
    expect(notice?.title).toBe('2 API keys have expired.');
    expect(notice?.keys).toHaveLength(2);
  });

  it('lets an expiry that has happened out-rank one that is coming', () => {
    const mixed = [
      key({ id: 'gone', name: 'Gone', expires_at: '2026-08-01T00:00:00Z' }),
      key({ id: 'soon', name: 'Soon', expires_at: '2026-08-20T00:00:00Z' }),
    ];
    expect(apiKeyExpiryNotice(mixed, NOW)?.tone).toBe('danger');
  });

  it('warns about a key inside the window, and not about one outside it', () => {
    const inside = key({ id: 'soon', name: 'Soon', expires_at: '2026-08-25T00:00:00Z' });
    const outside = key({ id: 'later', name: 'Later', expires_at: '2027-08-25T00:00:00Z' });
    expect(apiKeyExpiryNotice([inside], NOW)?.tone).toBe('warn');
    expect(apiKeyExpiryNotice([inside], NOW)?.title).toContain('Soon');
    expect(apiKeyExpiryNotice([outside], NOW)).toBeNull();
    expect(API_KEY_EXPIRY_WARNING_DAYS).toBe(14);
  });

  it('says nothing about a disabled key that is about to expire', () => {
    // Nothing is calling with it, so there is nothing to rotate before it breaks.
    const off = key({ enabled: false, expires_at: '2026-08-20T00:00:00Z' });
    expect(apiKeyExpiryNotice([off], NOW)).toBeNull();
  });

  it('ignores an expiry it cannot parse rather than warning about it forever', () => {
    expect(apiKeyExpiryNotice([key({ expires_at: 'nonsense' })], NOW)).toBeNull();
  });
});

describe('the create form', () => {
  it('starts empty, on full access, as the screen this replaces did', () => {
    expect(EMPTY_API_KEY_DRAFT).toEqual({
      name: '',
      description: '',
      preset: 'full',
      expiresInDays: '',
    });
  });

  it('keeps the name message word for word', () => {
    expect(validateApiKeyDraft({ ...EMPTY_API_KEY_DRAFT, name: '   ' })).toBe(
      'API key name is required'
    );
    expect(validateApiKeyDraft({ ...EMPTY_API_KEY_DRAFT, name: 'Release pipeline' })).toBeNull();
  });

  it('refuses an expiry the helper would silently turn into "never"', () => {
    const draft = { ...EMPTY_API_KEY_DRAFT, name: 'Release pipeline' };
    expect(validateApiKeyDraft({ ...draft, expiresInDays: '0' })).toMatch(/whole number/);
    expect(validateApiKeyDraft({ ...draft, expiresInDays: '-5' })).toMatch(/whole number/);
    expect(validateApiKeyDraft({ ...draft, expiresInDays: '2.5' })).toMatch(/whole number/);
    expect(validateApiKeyDraft({ ...draft, expiresInDays: 'soon' })).toMatch(/whole number/);
    expect(validateApiKeyDraft({ ...draft, expiresInDays: '90' })).toBeNull();
    expect(validateApiKeyDraft({ ...draft, expiresInDays: '' })).toBeNull();
  });

  it('sends days as a number, and an empty box as no expiry', () => {
    expect(parseApiKeyExpiry('90')).toBe(90);
    expect(parseApiKeyExpiry(' 30 ')).toBe(30);
    expect(parseApiKeyExpiry('')).toBeNull();
    expect(parseApiKeyExpiry('0')).toBeNull();
    expect(parseApiKeyExpiry('-1')).toBeNull();
  });

  it('summarises what was created for the secret dialog', () => {
    expect(
      describeCreatedApiKey({
        name: ' Release pipeline ',
        description: '',
        preset: 'diff',
        expiresInDays: '',
      })
    ).toBe('“Release pipeline” · scope diff:read · expires never');

    expect(
      describeCreatedApiKey({
        name: 'Rotating',
        description: '',
        preset: 'full',
        expiresInDays: '1',
      })
    ).toBe('“Rotating” · scope full access · expires in 1 day');
  });
});
