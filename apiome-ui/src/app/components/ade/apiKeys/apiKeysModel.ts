/**
 * The API keys surface, as derivations — HIVE-5.4 (#5307).
 *
 * Authority: `docs/mockups/workspace/api-keys.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, and `docs/mockups/DESIGN.md` §3.1 (status vocabulary),
 * §8 (list page).
 *
 * Everything a key's row says about it is computed here rather than in the components, for
 * the reason every `*Model` in this tree exists: the same question is asked from more than
 * one place. "Is this key expired?" is asked by the row tint, by the status badge, by the
 * Expires cell, by the enable switch (which an expired key must not offer), by the facet
 * chips, by the foot's breakdown and by the banner at the top of the page. Seven answers to
 * one question is how a screen ends up claiming a key is Active in one column and refusing
 * to enable it in another.
 *
 * There is deliberately **no React** in this file, so the rules are unit-tested directly
 * rather than through a rendered table.
 *
 * ### The one rule this module does not own
 *
 * The scope *vocabulary* — what `*`, `diff:read` and `lint:read` mean, and that `*` must
 * stand alone — is `@/app/utils/apiKeyScopes`, which the REST layer and `lib/db/helper`
 * share. This module presents those scopes; it does not decide them, so the strings a preset
 * produces here are the same strings the database has always stored.
 */

import {
  API_KEY_SCOPE_DIFF_READ,
  API_KEY_SCOPE_FULL,
  API_KEY_SCOPE_LINT_READ,
  API_KEY_SCOPE_PRESETS,
  normalizeApiKeyScopes,
  type ApiKeyScopePreset,
} from '@/app/utils/apiKeyScopes';

// ---------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------

/**
 * One row of `apiome.api_keys`, as `getApiKeysForTenant` returns it.
 *
 * The secret itself is never in here and never can be: only its bcrypt hash is stored, and
 * `key_prefix` is the first twelve characters, which is what the list shows.
 */
export interface ApiKeyRecord {
  /** Primary key. */
  id: string;
  /** The tenant the key acts as. */
  tenant_id: string;
  /** The name the creator gave it. */
  name: string;
  /** What it is for, shown as the row's second line. */
  description?: string | null;
  /** The first twelve characters of the secret, as stored (with a trailing `...`). */
  key_prefix: string;
  /** The scopes it may use. Missing or empty means full access, pre-V177. */
  scopes?: string[] | null;
  /** When it last authenticated a request, or `null` if it never has. */
  last_used_at: string | null;
  /** When it stops being accepted, or `null` for no expiry. */
  expires_at: string | null;
  /** Whether the switch in the row is on. */
  enabled: boolean;
  /** When it was created. */
  created_at: string;
  /** When it was last changed. */
  updated_at?: string | null;
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/**
 * What a key is, in the shared status vocabulary.
 *
 * Three states rather than the two columns the table draws, because "enabled" and "not
 * expired" are not independent: an expired key is refused whatever its switch says, so
 * `expired` out-ranks `disabled`. That precedence is stated once, here.
 */
export type ApiKeyStatus = 'active' | 'disabled' | 'expired';

/** The label each status carries, from the mockup's badges. */
export const API_KEY_STATUS_LABEL: Readonly<Record<ApiKeyStatus, string>> = {
  active: 'Active',
  disabled: 'Disabled',
  expired: 'Expired',
};

/**
 * Whether a key's expiry has passed.
 *
 * @param key The key.
 * @param now The moment to judge against; injected so the suite is not time-dependent.
 * @returns True when the key carries an expiry that is in the past.
 */
export function isApiKeyExpired(
  key: Pick<ApiKeyRecord, 'expires_at'>,
  now: Date = new Date()
): boolean {
  if (!key.expires_at) return false;
  const at = new Date(key.expires_at).getTime();
  // An unparseable date is not an expiry claim, and must not silently retire a working key.
  if (Number.isNaN(at)) return false;
  return at < now.getTime();
}

/**
 * The key's status.
 *
 * @param key The key.
 * @param now The moment to judge against.
 * @returns `expired`, else `disabled` when the switch is off, else `active`.
 */
export function apiKeyStatus(
  key: Pick<ApiKeyRecord, 'expires_at' | 'enabled'>,
  now: Date = new Date()
): ApiKeyStatus {
  if (isApiKeyExpired(key, now)) return 'expired';
  return key.enabled ? 'active' : 'disabled';
}

/**
 * What the reader may still do to a key, and why not.
 *
 * The ticket's third acceptance criterion — *"expired and revoked keys are visually distinct
 * and non-actionable"* — is this function. An expired key's switch is inert, because turning
 * it on would claim to restore a key the server will still refuse; the trash is not, because
 * deleting the dead key is exactly what the banner asks the reader to do. "Revoked" in this
 * data model is `enabled = false`: there is no separate revocation, which the mockup's notes
 * record as kept-as-is.
 *
 * @param key The key.
 * @param now The moment to judge against.
 * @returns Whether the switch and the trash are offered, and the tooltip for a refused one.
 */
export function apiKeyRowActions(
  key: Pick<ApiKeyRecord, 'expires_at' | 'enabled'>,
  now: Date = new Date()
): { canToggle: boolean; canDelete: boolean; toggleDisabledReason: string | null } {
  const expired = isApiKeyExpired(key, now);
  return {
    canToggle: !expired,
    canDelete: true,
    toggleDisabledReason: expired
      ? 'This key has expired. Create a replacement and delete this one.'
      : null,
  };
}

// ---------------------------------------------------------------------------------------
// Presentation of the fields
// ---------------------------------------------------------------------------------------

/**
 * The prefix as the table shows it — `sk_9f31c2Qm7Z…`.
 *
 * `lib/db/helper.createApiKey` stores the prefix with a literal `...` already appended, and
 * the screen this replaces appended a second, typographic one on top of it
 * (`sk_9f31c2Qm7Z...…`). Trimming here means the ellipsis is drawn once, and drawn as one
 * character rather than three.
 *
 * @param prefix The stored prefix.
 * @returns The prefix with exactly one trailing ellipsis.
 */
export function displayApiKeyPrefix(prefix: string): string {
  return `${copyableApiKeyPrefix(prefix)}…`;
}

/**
 * The prefix as the copy button puts it on the clipboard — no ellipsis.
 *
 * What makes a prefix worth copying is pasting it into a log search, and an ellipsis in the
 * query matches nothing. So the copy is the characters that are really the key's, and the
 * `…` stays a piece of typography.
 *
 * @param prefix The stored prefix.
 * @returns The prefix with any trailing dots or ellipsis removed.
 */
export function copyableApiKeyPrefix(prefix: string): string {
  return (prefix ?? '').replace(/[.…]+$/, '');
}

/**
 * A timestamp in the app's list format — `08/15/26 08:02 AM`, or `Never`.
 *
 * Kept 1:1 with the screen this replaces (`MM/DD/YY hh:mm AM`), which the mockup's notes
 * list among the things to keep.
 *
 * @param iso The stored timestamp, or `null`.
 * @returns The formatted stamp, or `Never`.
 */
export function formatApiKeyTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Never';
  const date = at.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  });
  const time = at.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${date} ${time}`;
}

/**
 * A date with no clock — the Expires column, which the mockup draws as `01/02/27`.
 *
 * @param iso The stored timestamp, or `null`.
 * @returns The formatted date, or `Never`.
 */
export function formatApiKeyDate(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Never';
  return at.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  });
}

/**
 * A date as prose — `August 1, 2026`, for the banner and the confirms.
 *
 * @param iso The stored timestamp, or `null`.
 * @returns The long date, or `null` when there is nothing to say.
 */
export function formatApiKeyLongDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------

/**
 * A key's scopes, normalised, with full access reported as the empty list.
 *
 * The table draws one `diff:read` badge per scope and the words "Full access" for `*`, so
 * the two cases are separated here rather than in the cell: a `*` badge beside two others
 * would say a key holds three scopes, and `*` is precisely the scope that stands alone.
 *
 * A key whose stored scopes are invalid (hand-edited, or written by a version that allowed
 * something this one does not) is reported as full access rather than throwing, because a
 * table that cannot draw a row is worse than a row that overstates one key's reach — and the
 * row is still the place the reader goes to delete it.
 *
 * @param key The key.
 * @returns The scope strings, or `[]` when the key has full access.
 */
export function apiKeyScopeList(key: Pick<ApiKeyRecord, 'scopes'>): string[] {
  let normalized: string[];
  try {
    normalized = normalizeApiKeyScopes(key.scopes ?? null);
  } catch {
    return [];
  }
  return normalized.includes(API_KEY_SCOPE_FULL) ? [] : normalized;
}

/**
 * Whether the key may do everything this tenant can.
 *
 * @param key The key.
 * @returns True for a `*` key.
 */
export function isFullAccessKey(key: Pick<ApiKeyRecord, 'scopes'>): boolean {
  return apiKeyScopeList(key).length === 0;
}

/** One row of the "Scope reference" card: the scope, what it allows, and how many keys hold it. */
export interface ApiKeyScopeReference {
  /** The scope string, as it is stored and as the badge prints it. */
  scope: string;
  /** One sentence on what a key holding it may call. */
  allows: string;
  /** Whether it is the full-access scope, which the card draws without the accent tint. */
  full: boolean;
}

/**
 * The three scopes, in the order the mockup's reference card lists them.
 *
 * Stated once so the card, the create dialog's badges and the table's legend cannot drift
 * into three different descriptions of `lint:read`.
 */
export const API_KEY_SCOPE_REFERENCE: readonly ApiKeyScopeReference[] = [
  {
    scope: API_KEY_SCOPE_FULL,
    allows: 'All REST operations for this tenant. Must stand alone.',
    full: true,
  },
  {
    scope: API_KEY_SCOPE_DIFF_READ,
    allows: 'POST /v1/diff/…/classified only — contract gates.',
    full: false,
  },
  {
    scope: API_KEY_SCOPE_LINT_READ,
    allows: 'GET …/lint and …/lint/gate (catalog + MCP).',
    full: false,
  },
];

/**
 * How many of the tenant's keys hold each scope.
 *
 * @param keys Every key.
 * @returns A count per scope string, including `*`.
 */
export function apiKeyScopeUsage(keys: readonly ApiKeyRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    [API_KEY_SCOPE_FULL]: 0,
    [API_KEY_SCOPE_DIFF_READ]: 0,
    [API_KEY_SCOPE_LINT_READ]: 0,
  };
  for (const key of keys) {
    const scopes = apiKeyScopeList(key);
    if (scopes.length === 0) {
      counts[API_KEY_SCOPE_FULL] += 1;
      continue;
    }
    for (const scope of scopes) {
      counts[scope] = (counts[scope] ?? 0) + 1;
    }
  }
  return counts;
}

/** One of the create dialog's four scope cards. */
export interface ApiKeyScopePresetOption {
  /** The preset id, which is also the radio's value. */
  value: ApiKeyScopePreset;
  /** The card's lead line. */
  label: string;
  /** The scope strings it produces — drawn as badges, and sent to the server. */
  scopes: readonly string[];
  /** The sentence under the label. */
  hint: string;
}

/**
 * The four presets, in the mockup's order.
 *
 * `scopes` is read from {@link API_KEY_SCOPE_PRESETS} rather than restated, which is what
 * makes the second acceptance criterion — *"scope presets produce the same scope strings as
 * today"* — a property of the code and not of this list staying in step with it.
 */
export const API_KEY_SCOPE_PRESET_OPTIONS: readonly ApiKeyScopePresetOption[] = [
  {
    value: 'full',
    label: 'Full access',
    scopes: API_KEY_SCOPE_PRESETS.full,
    hint: 'All REST operations for this tenant (the default).',
  },
  {
    value: 'diff',
    label: 'CI: classified diff',
    scopes: API_KEY_SCOPE_PRESETS.diff,
    hint: 'POST /v1/diff/…/classified only — recommended for contract gates.',
  },
  {
    value: 'lint',
    label: 'CI: lint',
    scopes: API_KEY_SCOPE_PRESETS.lint,
    hint: 'GET …/lint and …/lint/gate only (catalog + MCP).',
  },
  {
    value: 'ci_both',
    label: 'CI: diff + lint',
    scopes: API_KEY_SCOPE_PRESETS.ci_both,
    hint: 'Both CI read scopes; still no write access.',
  },
];

/**
 * The scope strings a preset produces — what the create call sends to the server.
 *
 * Read from {@link API_KEY_SCOPE_PRESETS} rather than restated, which is what makes the
 * ticket's second acceptance criterion — *"scope presets produce the same scope strings as
 * today"* — a property of the code rather than of two lists staying in step.
 *
 * @param preset The chosen preset.
 * @returns Its scope strings.
 */
export function scopesForApiKeyPreset(preset: ApiKeyScopePreset): readonly string[] {
  return API_KEY_SCOPE_PRESETS[preset];
}

/**
 * A preset's scopes as one line of prose — the secret dialog's subtitle.
 *
 * @param preset The chosen preset.
 * @returns `full access`, or the scope strings joined.
 */
export function describeApiKeyScopePreset(preset: ApiKeyScopePreset): string {
  const scopes = API_KEY_SCOPE_PRESETS[preset];
  return scopes.includes(API_KEY_SCOPE_FULL) ? 'full access' : scopes.join(' + ');
}

// ---------------------------------------------------------------------------------------
// Searching, faceting, sorting
// ---------------------------------------------------------------------------------------

/** The toolbar's chips, in the mockup's order. */
export const API_KEY_FACETS = ['all', 'active', 'disabled', 'expired'] as const;

/** One chip. */
export type ApiKeyFacet = (typeof API_KEY_FACETS)[number];

/** What each chip is called. */
export const API_KEY_FACET_LABELS: Readonly<Record<ApiKeyFacet, string>> = {
  all: 'All',
  active: 'Active',
  disabled: 'Disabled',
  expired: 'Expired',
};

/**
 * Whether a key belongs under a chip.
 *
 * @param key The key.
 * @param facet The chip.
 * @param now The moment to judge status against.
 * @returns True when the chip would show this key.
 */
export function matchesApiKeyFacet(
  key: ApiKeyRecord,
  facet: ApiKeyFacet,
  now: Date = new Date()
): boolean {
  if (facet === 'all') return true;
  return apiKeyStatus(key, now) === facet;
}

/**
 * How many keys each chip would leave.
 *
 * @param keys The keys the search has already narrowed to.
 * @param now The moment to judge status against.
 * @returns A count per facet.
 */
export function apiKeyFacetCounts(
  keys: readonly ApiKeyRecord[],
  now: Date = new Date()
): Record<ApiKeyFacet, number> {
  const counts: Record<ApiKeyFacet, number> = { all: 0, active: 0, disabled: 0, expired: 0 };
  for (const key of keys) {
    counts.all += 1;
    counts[apiKeyStatus(key, now)] += 1;
  }
  return counts;
}

/**
 * The keys whose name, description or prefix contains `query`.
 *
 * The prefix is searched without its ellipsis, so pasting `sk_9f31c2` from a log finds the
 * key that made the call — which is the reason the mockup adds the box at all.
 *
 * @param keys Every key.
 * @param query What was typed. Blank matches everything.
 * @returns The matching keys, in their original order.
 */
export function searchApiKeys(
  keys: readonly ApiKeyRecord[],
  query: string
): ApiKeyRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...keys];
  return keys.filter((key) =>
    [key.name, key.description ?? '', copyableApiKeyPrefix(key.key_prefix)]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}

/** Which column the table is sorted by, and which way. */
export interface ApiKeySortState {
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * The value a column sorts on.
 *
 * Timestamps sort as numbers rather than as the strings the cells print, because
 * `08/15/26` sorts before `09/02/25` alphabetically. A key with no timestamp sorts as the
 * beginning of time, so "never used" and "never expires" gather at one end rather than
 * scattering.
 *
 * @param key The key.
 * @param column The column id.
 * @param now The moment to judge status against.
 * @returns A string or a number, comparable within the column.
 */
function apiKeySortValue(key: ApiKeyRecord, column: string, now: Date): string | number {
  switch (column) {
    case 'name':
      return key.name.toLowerCase();
    case 'prefix':
      return copyableApiKeyPrefix(key.key_prefix).toLowerCase();
    case 'scopes':
      return isFullAccessKey(key) ? '*' : apiKeyScopeList(key).join(',');
    case 'status':
      return apiKeyStatus(key, now);
    case 'lastUsed':
      return key.last_used_at ? new Date(key.last_used_at).getTime() : 0;
    case 'created':
      return key.created_at ? new Date(key.created_at).getTime() : 0;
    case 'expires':
      // No expiry is *further away* than any date, so it sorts last ascending — which is
      // what "sort by soonest to expire" has to mean for the column to be useful.
      return key.expires_at ? new Date(key.expires_at).getTime() : Number.MAX_SAFE_INTEGER;
    case 'enabled':
      return key.enabled ? 1 : 0;
    default:
      return key.name.toLowerCase();
  }
}

/**
 * The keys in the order the header asks for.
 *
 * @param keys The keys to order.
 * @param sort The sorted column, or `null` for the server's own order (newest first).
 * @param now The moment to judge status against.
 * @returns A new, ordered array.
 */
export function sortApiKeys(
  keys: readonly ApiKeyRecord[],
  sort: ApiKeySortState | null | undefined,
  now: Date = new Date()
): ApiKeyRecord[] {
  const ordered = [...keys];
  if (!sort) return ordered;
  const sign = sort.direction === 'desc' ? -1 : 1;
  return ordered.sort((left, right) => {
    const a = apiKeySortValue(left, sort.column, now);
    const b = apiKeySortValue(right, sort.column, now);
    if (a === b) return left.name.localeCompare(right.name);
    return (a < b ? -1 : 1) * sign;
  });
}

// ---------------------------------------------------------------------------------------
// Counting and the banner
// ---------------------------------------------------------------------------------------

/** How many keys there are, and what state they are in. */
export interface ApiKeySummary {
  total: number;
  active: number;
  disabled: number;
  expired: number;
}

/**
 * The tenant's keys, counted by status.
 *
 * @param keys Every key.
 * @param now The moment to judge status against.
 * @returns The four counts.
 */
export function summariseApiKeys(
  keys: readonly ApiKeyRecord[],
  now: Date = new Date()
): ApiKeySummary {
  const summary: ApiKeySummary = { total: 0, active: 0, disabled: 0, expired: 0 };
  for (const key of keys) {
    summary.total += 1;
    summary[apiKeyStatus(key, now)] += 1;
  }
  return summary;
}

/**
 * Pluralise a count with its noun.
 *
 * @param count How many.
 * @param singular The noun for one.
 * @returns `1 key`, `3 keys`.
 */
function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * The table foot's sentence — `4 keys · 2 active · 1 disabled · 1 expired`.
 *
 * States with no keys in them are left out, so a healthy workspace reads `3 keys · 3 active`
 * rather than listing two zeroes.
 *
 * @param summary From {@link summariseApiKeys}.
 * @returns The sentence.
 */
export function describeApiKeyBreakdown(summary: ApiKeySummary): string {
  const parts = [plural(summary.total, 'key')];
  if (summary.active) parts.push(`${summary.active} active`);
  if (summary.disabled) parts.push(`${summary.disabled} disabled`);
  if (summary.expired) parts.push(`${summary.expired} expired`);
  return parts.join(' · ');
}

/**
 * How many days before its expiry a key starts being worth warning about.
 *
 * Two weeks: long enough that a team on a fortnightly cycle sees the notice before the
 * pipeline breaks, short enough that a key with a year on it does not spend that year
 * carrying a banner nobody can act on.
 */
export const API_KEY_EXPIRY_WARNING_DAYS = 14;

/** Milliseconds in a day, for the window above. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the page says at the top of the body, when it needs to say anything. */
export interface ApiKeyExpiryNotice {
  /** `danger` when keys are already refused, `warn` when they are about to be. */
  tone: 'danger' | 'warn';
  /** The lead sentence, naming the key when there is exactly one. */
  title: string;
  /** What to do about it. */
  body: string;
  /** The keys the notice is about, so a caller can highlight or count them. */
  keys: ApiKeyRecord[];
}

/**
 * The expiry heads-up, or `null` when every key is healthy.
 *
 * Expired out-ranks expiring: a key that is already being refused is a live incident, and a
 * second banner under it about one that will be refused next week buries it. One key is
 * named outright, as the mockup does; several are counted, because a banner listing six
 * names is a paragraph.
 *
 * @param keys Every key.
 * @param now The moment to judge against.
 * @returns The notice, or `null`.
 */
export function apiKeyExpiryNotice(
  keys: readonly ApiKeyRecord[],
  now: Date = new Date()
): ApiKeyExpiryNotice | null {
  const expired = keys.filter((key) => isApiKeyExpired(key, now));
  if (expired.length > 0) {
    const when = expired.length === 1 ? formatApiKeyLongDate(expired[0].expires_at) : null;
    return {
      tone: 'danger',
      title:
        expired.length === 1
          ? `“${expired[0].name}” expired${when ? ` on ${when}` : ''}.`
          : `${plural(expired.length, 'API key')} have expired.`,
      body:
        expired.length === 1
          ? 'Requests with that key are refused — create a replacement and delete the old one.'
          : 'Requests with those keys are refused — create replacements and delete the old ones.',
      keys: expired,
    };
  }

  const horizon = now.getTime() + API_KEY_EXPIRY_WARNING_DAYS * DAY_MS;
  const soon = keys.filter((key) => {
    if (!key.enabled || !key.expires_at) return false;
    const at = new Date(key.expires_at).getTime();
    return !Number.isNaN(at) && at <= horizon;
  });
  if (soon.length === 0) return null;

  const when = soon.length === 1 ? formatApiKeyLongDate(soon[0].expires_at) : null;
  return {
    tone: 'warn',
    title:
      soon.length === 1
        ? `“${soon[0].name}” expires${when ? ` on ${when}` : ' soon'}.`
        : `${plural(soon.length, 'API key')} expire within ${API_KEY_EXPIRY_WARNING_DAYS} days.`,
    body: 'Rotate by creating a replacement, switching the pipeline over, then deleting the old key.',
    keys: soon,
  };
}

// ---------------------------------------------------------------------------------------
// The create form
// ---------------------------------------------------------------------------------------

/** What the create dialog collects. */
export interface ApiKeyDraft {
  /** The name. Required — the one field the server also refuses when blank. */
  name: string;
  /** What it is for. */
  description: string;
  /** The chosen preset. */
  preset: ApiKeyScopePreset;
  /** Days until expiry, as typed. Blank means no expiry. */
  expiresInDays: string;
}

/** A draft with nothing filled in — the dialog's state each time it opens. */
export const EMPTY_API_KEY_DRAFT: ApiKeyDraft = {
  name: '',
  description: '',
  preset: 'full',
  expiresInDays: '',
};

/**
 * The number of days a draft asks for, as the server wants it.
 *
 * @param raw What was typed.
 * @returns A positive integer, or `null` for "no expiration".
 */
export function parseApiKeyExpiry(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const days = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days;
}

/**
 * What is wrong with the draft, or `null` when it may be submitted.
 *
 * The name check is the string the screen this replaces used, and which the mockup lists
 * among the things to keep. The expiry check is new: the old field accepted `-5` and `0`,
 * both of which the helper silently turned into "never expires" — a key the reader believes
 * is short-lived and which is not.
 *
 * @param draft The form's state.
 * @returns The message, or `null`.
 */
export function validateApiKeyDraft(draft: ApiKeyDraft): string | null {
  if (!draft.name.trim()) return 'API key name is required';
  const raw = draft.expiresInDays.trim();
  if (raw !== '') {
    const days = Number.parseInt(raw, 10);
    if (!Number.isFinite(days) || String(days) !== raw || days < 1) {
      return 'Expires in must be a whole number of days, or empty for no expiration';
    }
  }
  return null;
}

/**
 * The secret dialog's subtitle — `“Release pipeline” · scope diff:read · expires never`.
 *
 * @param draft The draft that was submitted.
 * @returns The one-line summary of what was just created.
 */
export function describeCreatedApiKey(draft: ApiKeyDraft): string {
  const days = parseApiKeyExpiry(draft.expiresInDays);
  const expiry = days === null ? 'expires never' : `expires in ${plural(days, 'day')}`;
  return `“${draft.name.trim()}” · scope ${describeApiKeyScopePreset(draft.preset)} · ${expiry}`;
}
