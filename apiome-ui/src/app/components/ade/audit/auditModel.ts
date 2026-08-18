/**
 * The access-audit derivations — HIVE-5.5 (#5308).
 *
 * Authority: `docs/mockups/workspace/audit.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria, and `apiome-rest/src/app/access_routes.py`, which is where
 * the action vocabulary and the six filter categories really come from.
 *
 * Everything here is pure: it takes rows and returns rows, sentences or classifications, and
 * touches neither React nor `fetch`. That is what lets `tests/audit-model.test.ts` pin the
 * parts of this screen that are actually *claims* — which family an action belongs to,
 * whether an entry links to its predecessor in the hash chain, what a row says in English —
 * without rendering anything.
 *
 * ### Why the six categories are partitioned here and not by the server
 *
 * The list endpoint takes a `filter` and narrows by action prefix, and the screen this
 * replaces sent one request per chip. The mockup asks for a **count on every chip**, and a
 * count is a fact about the whole ledger that a narrowed response cannot carry: after
 * `?filter=role` the client knows how many role events there are and nothing about the other
 * five. So the page reads the ledger once, with the date range the reader chose, and
 * partitions it here — using {@link AUDIT_FILTER_PREFIXES}, the *same* prefixes
 * `_AUDIT_FILTERS` uses server-side, so a chip narrows to exactly the rows the old request
 * returned.
 *
 * The one place the server's own filter is still used is the CSV export, which is the
 * evidence artefact and is generated from the database rather than from what a browser
 * happens to be holding.
 */

import type { BadgeTone } from '@/app/components/ui/Badge';

// ---------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------

/**
 * One row of `apiome.access_audit`, as `GET /api/access/audit` returns it.
 *
 * `detail` is a JSONB column, so it arrives as whatever the writer put there — a flat object
 * in every current writer, but the type is deliberately `unknown`: the screen this replaces
 * declared it `string` and rendered `{ev.target || ev.detail}`, which throws the moment a
 * row has a target of `''` and an object detail.
 */
export interface AuditEvent {
  /** The entry's id. */
  id: string;
  /** The acting user, when there was one. */
  actor_id?: string | null;
  /** The actor's display label at write time — an email, `system`, `platform-admin`. */
  actor_label?: string | null;
  /** The event type, e.g. `role.assigned`. Always a `family.verb` pair in practice. */
  action: string;
  /** What the event was about — an email, a role name, a `resource:action` key. */
  target?: string | null;
  /** Where the action came from: `web`, `api_key`, `api`, `admin`, `sso`, `scim`, `system`. */
  source?: string | null;
  /** Structured context the writer recorded. Shape varies by action. */
  detail?: unknown;
  /** The `entry_hash` of the previous entry in this tenant's chain; `null` at its start. */
  prev_hash?: string | null;
  /** This entry's own hash. */
  entry_hash?: string | null;
  /** When it was written, ISO 8601. */
  created_at?: string | null;
}

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

/** The six categories the audit endpoint understands, in the order the chips show them. */
export const AUDIT_FILTERS = [
  'all',
  'role',
  'permission',
  'member',
  'admin',
  'styleGuide',
] as const;

/** One of {@link AUDIT_FILTERS}. */
export type AuditFilter = (typeof AUDIT_FILTERS)[number];

/**
 * Each category's action prefix — a transcription of `_AUDIT_FILTERS` in
 * `apiome-rest/src/app/access_routes.py`, which is what `?filter=` sends to SQL as
 * `action LIKE '<prefix>%'`. `all` has no prefix.
 *
 * Kept as data rather than as a `switch` so the correspondence with the server can be
 * asserted a row at a time.
 */
export const AUDIT_FILTER_PREFIXES: Readonly<Record<AuditFilter, string | null>> = {
  all: null,
  role: 'role.',
  permission: 'permission.',
  member: 'member.',
  admin: 'admin.',
  // The sixth category the server has understood since GOV-1.6 (#4432) and no UI exposed.
  styleGuide: 'style_guide.',
};

/** The chips' labels — the five the screen has always had, plus the one it hid. */
export const AUDIT_FILTER_LABELS: Readonly<Record<AuditFilter, string>> = {
  all: 'All events',
  role: 'Role changes',
  permission: 'Permissions',
  member: 'Members',
  admin: 'Admin overrides',
  styleGuide: 'Style guides',
};

/**
 * Whether an event belongs to a category.
 *
 * @param event The row.
 * @param filter The category.
 * @returns True when `all`, or when the action carries that category's prefix.
 */
export function matchesAuditFilter(event: AuditEvent, filter: AuditFilter): boolean {
  const prefix = AUDIT_FILTER_PREFIXES[filter];
  return prefix === null ? true : (event.action ?? '').startsWith(prefix);
}

/**
 * How many rows each chip would leave.
 *
 * @param events The rows the chips sit above — already narrowed by search and date range, so
 *   a count never promises rows the reader would not then see.
 * @returns A count per category.
 */
export function auditFilterCounts(
  events: readonly AuditEvent[]
): Readonly<Record<AuditFilter, number>> {
  const counts = {} as Record<AuditFilter, number>;
  for (const filter of AUDIT_FILTERS) {
    counts[filter] = events.filter((event) => matchesAuditFilter(event, filter)).length;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------
// Event families & their tone
// ---------------------------------------------------------------------------------------

/**
 * The families the mockup colours event badges by — its `.ev--role`, `.ev--permission`,
 * `.ev--member`, `.ev--admin`, `.ev--sso` and `.ev--other`, plus the `style_guide.*` family
 * that the sixth chip selects.
 */
export type AuditFamily =
  | 'role'
  | 'permission'
  | 'member'
  | 'admin'
  | 'sso'
  | 'style_guide'
  | 'other';

/**
 * Which family an action belongs to.
 *
 * The segment before the first dot, when it is one of the known families. Governance actions
 * are `governance.<area>.<verb>`, three segments deep, and land in `other` — which is
 * correct: they are not access events and no chip claims them.
 *
 * @param action The event's action string.
 * @returns The family.
 */
export function auditFamily(action: string): AuditFamily {
  const prefix = (action ?? '').split('.')[0];
  switch (prefix) {
    case 'role':
    case 'permission':
    case 'member':
    case 'admin':
    case 'sso':
      return prefix;
    case 'style_guide':
      return 'style_guide';
    default:
      return 'other';
  }
}

/**
 * The badge tone for a family — the mockup's palette, expressed in the shared vocabulary's
 * tone names rather than in hues, so it follows all nine themes.
 *
 * `member` is `accent` because the mockup's `--accent-soft` *is* the sky tint it names, and
 * `style_guide` takes `honey`, the governance tone the style-guide surfaces already use.
 */
export const AUDIT_FAMILY_TONE: Readonly<Record<AuditFamily, BadgeTone>> = {
  role: 'orange',
  permission: 'rose',
  member: 'accent',
  admin: 'violet',
  sso: 'ok',
  style_guide: 'honey',
  other: 'neutral',
};

/**
 * The tone an event's badge takes.
 *
 * @param action The event's action string.
 * @returns A {@link BadgeTone}.
 */
export function auditBadgeTone(action: string): BadgeTone {
  return AUDIT_FAMILY_TONE[auditFamily(action)];
}

// ---------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------

/**
 * How each `source` value reads at the end of a sentence.
 *
 * Every value here is written by real code: `web` and `api_key` by `access_routes.py` and
 * `permissions.py`, `api` by the four governance route modules, `admin` by the platform
 * override endpoint, and `sso` / `scim` / `system` by the column's own documented vocabulary
 * (`V120__rbac_access_audit_log.sql`).
 */
const SOURCE_PHRASES: Readonly<Record<string, string>> = {
  web: 'from the web console',
  api: 'over the REST API',
  api_key: 'with an API key',
  admin: 'from the platform admin console',
  sso: 'through SSO',
  scim: 'through SCIM provisioning',
  system: 'by the system',
};

/**
 * The phrase for a source, for the drawer's one-sentence summary.
 *
 * @param source The row's `source`.
 * @returns A trailing phrase, or `''` when the source is absent or unrecognised — an unknown
 *   origin says nothing rather than guessing.
 */
export function auditSourcePhrase(source: string | null | undefined): string {
  if (!source) return '';
  return SOURCE_PHRASES[source] ?? '';
}

// ---------------------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------------------

/** The ranges the toolbar offers, widest last. */
export const AUDIT_RANGES = ['24h', '7d', '30d', '90d', 'all'] as const;

/** One of {@link AUDIT_RANGES}. */
export type AuditRange = (typeof AUDIT_RANGES)[number];

/** The range the page opens on — the mockup's own default. */
export const DEFAULT_AUDIT_RANGE: AuditRange = '30d';

/** Each range's label. */
export const AUDIT_RANGE_LABELS: Readonly<Record<AuditRange, string>> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

/** How many days back each bounded range reaches. */
const RANGE_DAYS: Readonly<Record<Exclude<AuditRange, 'all'>, number>> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Milliseconds in a day, so the arithmetic below is readable. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a range starts at.
 *
 * @param range The chosen range.
 * @param now The moment to count back from.
 * @returns The lower bound, or `null` for `all` — which is the absence of a bound, not a
 *   very old date, so the request simply omits `since`.
 */
export function auditRangeStart(range: AuditRange, now: Date): Date | null {
  if (range === 'all') return null;
  return new Date(now.getTime() - RANGE_DAYS[range] * DAY_MS);
}

// ---------------------------------------------------------------------------------------
// Search & sort
// ---------------------------------------------------------------------------------------

/**
 * Everything about a row that a search should match, as one lower-cased string.
 *
 * `detail` is included because it is where the substance of an event lives — the role that
 * was granted, the permission that was denied — and a search that could not reach it would
 * miss the row the reader is looking for while showing them the row above it.
 *
 * @param event The row.
 * @returns The haystack.
 */
function searchHaystack(event: AuditEvent): string {
  return [
    event.actor_label,
    event.actor_id,
    event.action,
    event.target,
    event.source,
    event.detail === null || event.detail === undefined
      ? ''
      : typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Narrow rows to those matching a free-text query.
 *
 * @param events The rows.
 * @param query What was typed. Blank keeps everything.
 * @returns The matching rows, in their original order.
 */
export function searchAuditEvents(
  events: readonly AuditEvent[],
  query: string
): AuditEvent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...events];
  return events.filter((event) => searchHaystack(event).includes(needle));
}

/** The sortable columns, by their `DataTable` column id. */
export type AuditSortColumn = 'when' | 'actor' | 'event' | 'target' | 'source';

/** How one row answers a sort on each column. */
const SORT_KEYS: Readonly<Record<AuditSortColumn, (event: AuditEvent) => string>> = {
  when: (event) => event.created_at ?? '',
  actor: (event) => (event.actor_label || event.actor_id || '').toLowerCase(),
  event: (event) => (event.action ?? '').toLowerCase(),
  target: (event) => (event.target ?? '').toLowerCase(),
  source: (event) => (event.source ?? '').toLowerCase(),
};

/**
 * Order rows for the table.
 *
 * @param events The rows.
 * @param sort The sorted column and direction, or `null` for the ledger's own order — which
 *   is newest first, and is what an append-only record is *for*.
 * @returns A new array; the input is never mutated.
 */
export function sortAuditEvents(
  events: readonly AuditEvent[],
  sort: { column: string; direction: 'asc' | 'desc' } | null | undefined
): AuditEvent[] {
  const rows = [...events];
  if (!sort) return rows;
  const key = SORT_KEYS[sort.column as AuditSortColumn];
  if (!key) return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const compared = key(a).localeCompare(key(b), undefined, { numeric: true });
    // A stable tiebreak on the id, so two entries written in the same millisecond keep one
    // order rather than swapping places on every re-render.
    return compared !== 0 ? compared * sign : a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------

/** Rows per page. The mockup's foot pages a 128-entry ledger into twelve. */
export const AUDIT_PAGE_SIZE = 25;

/**
 * How many pages a row count needs.
 *
 * @param total The number of rows.
 * @param pageSize Rows per page.
 * @returns At least 1, so "page 1 of 1" is what an empty list says.
 */
export function auditPageCount(total: number, pageSize: number = AUDIT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * One page of rows.
 *
 * @param events Every matching row, already ordered.
 * @param page The 1-based page. Values outside the range are clamped, so a filter that
 *   shortens the list cannot leave the reader on a page that no longer exists.
 * @param pageSize Rows per page.
 * @returns That page's rows.
 */
export function auditPage(
  events: readonly AuditEvent[],
  page: number,
  pageSize: number = AUDIT_PAGE_SIZE
): AuditEvent[] {
  const clamped = Math.min(Math.max(1, page), auditPageCount(events.length, pageSize));
  const first = (clamped - 1) * pageSize;
  return events.slice(first, first + pageSize);
}

// ---------------------------------------------------------------------------------------
// The hash chain
// ---------------------------------------------------------------------------------------

/**
 * What can be said about one entry's place in the tenant's hash chain.
 *
 * The distinction the drawer has to draw is between *checked* and *not checked*: the ledger
 * is chained per tenant, so an entry only links to the entry written immediately before it
 * in that tenant — never to the row above it in a filtered view.
 */
export type AuditChainStatus =
  /** This entry's `prev_hash` is the previous entry's `entry_hash`. Checked, and it holds. */
  | 'linked'
  /** It is not. Something between the two rows has changed. */
  | 'broken'
  /** No entry precedes it: this is the first entry of the tenant's chain. */
  | 'chain-start'
  /** The previous entry was not read (the oldest row of the page, or a narrowed date range). */
  | 'not-loaded'
  /** The entry carries no hashes — nothing to check. */
  | 'unavailable';

/** An entry's chain position, as the drawer states it. */
export interface AuditChainPosition {
  /** What could be established. */
  status: AuditChainStatus;
  /** The hash this entry claims to follow, if any. */
  previousHash: string | null;
  /** This entry's own hash, if any. */
  entryHash: string | null;
}

/**
 * Where an entry sits in the chain, checked against the ledger as it was read.
 *
 * The check is real or it is not made: `ledger` must be the whole, unfiltered, newest-first
 * response, because that is the only ordering in which the next element really is the entry
 * written before this one. Given anything else the answer is `not-loaded`, which says "not
 * checked" rather than making a claim about tamper-evidence that nothing verified.
 *
 * @param ledger Every row of the tenant's ledger that was read, newest first.
 * @param event The entry being looked at.
 * @returns Its {@link AuditChainPosition}.
 */
export function auditChainPosition(
  ledger: readonly AuditEvent[],
  event: AuditEvent
): AuditChainPosition {
  const previousHash = event.prev_hash ?? null;
  const entryHash = event.entry_hash ?? null;

  if (!entryHash && !previousHash) {
    return { status: 'unavailable', previousHash, entryHash };
  }
  // `write_access_audit` writes a null `prev_hash` for the first row of a tenant's chain and
  // for nothing else, so this is a fact about the ledger rather than about the response.
  if (previousHash === null) {
    return { status: 'chain-start', previousHash, entryHash };
  }

  const index = ledger.findIndex((row) => row.id === event.id);
  const previous = index >= 0 ? ledger[index + 1] : undefined;
  if (!previous?.entry_hash) {
    return { status: 'not-loaded', previousHash, entryHash };
  }
  return {
    status: previous.entry_hash === previousHash ? 'linked' : 'broken',
    previousHash,
    entryHash,
  };
}

/** What each chain status says on screen. */
export const AUDIT_CHAIN_MESSAGES: Readonly<Record<AuditChainStatus, string>> = {
  linked: 'Verified against the entry written before it.',
  broken: 'Does not match the entry written before it — the chain is broken here.',
  'chain-start': 'The first entry in this workspace’s chain.',
  'not-loaded': 'The entry before it is outside this view, so the link was not checked.',
  unavailable: 'This entry was written without chain hashes.',
};

// ---------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------

/** What a cell shows where a value is missing, in one place so it reads the same everywhere. */
export const NO_VALUE = '—';

/**
 * A timestamp as the table's When column shows it: `Aug 15, 2026, 09:41 AM`.
 *
 * @param value An ISO 8601 instant, or nothing.
 * @returns The formatted stamp, {@link NO_VALUE} when absent, or the raw value when it is not
 *   a date — never a silent `Invalid Date`.
 */
export function formatAuditTimestamp(value: string | null | undefined): string {
  if (!value) return NO_VALUE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The same instant to the second, in UTC — what the drawer shows, because an auditor
 * correlating this entry with a server log needs the seconds and the zone.
 *
 * @param value An ISO 8601 instant, or nothing.
 * @returns `Aug 15, 2026, 09:41:07 AM UTC`, {@link NO_VALUE}, or the raw value.
 */
export function formatAuditExactTimestamp(value: string | null | undefined): string {
  if (!value) return NO_VALUE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}

/**
 * How long ago something happened, in the coarse words a ledger wants.
 *
 * @param value An ISO 8601 instant, or nothing.
 * @param now The moment to measure from.
 * @returns `just now`, `2 hours ago`, `3 days ago`, …, or {@link NO_VALUE}.
 */
export function formatAuditRelative(value: string | null | undefined, now: Date): string {
  if (!value) return NO_VALUE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * The actor as one line — the label if there is one, else the id.
 *
 * @param event The row.
 * @returns The label, the id, or `system` for an entry with neither, which is what an
 *   actor-less row (a background write) actually is.
 */
export function auditActorLabel(event: AuditEvent): string {
  return event.actor_label || event.actor_id || 'system';
}

// ---------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------

/** One `key: value` line of an event's `detail`, ready to draw. */
export interface AuditDetailEntry {
  /** The key, as the writer spelled it. */
  key: string;
  /** The value, flattened to text — arrays as comma-separated lists, objects as JSON. */
  value: string;
}

/**
 * Flatten one `detail` value for display.
 *
 * @param value Whatever the writer stored.
 * @returns Its text form; an empty array reads as `none` rather than as nothing at all,
 *   because "no permissions were revoked" is information.
 */
function flattenDetailValue(value: unknown): string {
  if (value === null || value === undefined) return NO_VALUE;
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * An event's `detail` as key/value lines.
 *
 * Every current writer stores a flat object; anything else (a bare string, a number, an
 * array) is returned as a single `detail` line rather than dropped, and the drawer's JSON
 * block shows the payload verbatim regardless.
 *
 * @param detail The row's `detail`.
 * @returns The lines, in the key order the writer used. Empty when there is no detail.
 */
export function auditDetailEntries(detail: unknown): AuditDetailEntry[] {
  if (detail === null || detail === undefined || detail === '') return [];
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    return [{ key: 'detail', value: flattenDetailValue(detail) }];
  }
  return Object.entries(detail as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: flattenDetailValue(value),
  }));
}

/**
 * The key pairs that are a *change*, so the drawer can draw them as before → after.
 *
 * Each pair is `[before, after]` as the writers spell them: `access_routes.py` records a
 * matrix edit as `granted` / `revoked`, and the older `from_role` / `to_role` and the generic
 * `before` / `after` are recognised too so a writer that adopts either is drawn correctly
 * without another change here.
 */
const CHANGE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['revoked', 'granted'],
  ['from_role', 'to_role'],
  ['before', 'after'],
  ['from', 'to'],
];

/** A before/after pair found in an event's detail. */
export interface AuditChange {
  /** What the pair is about — `role`, `permissions`, … */
  label: string;
  /** The value before, flattened. */
  before: string;
  /** The value after, flattened. */
  after: string;
}

/**
 * The before → after change an event's detail records, when it records one.
 *
 * @param detail The row's `detail`.
 * @returns The change, or `null` when the detail is not a pair — most events are not.
 */
export function auditChange(detail: unknown): AuditChange | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const record = detail as Record<string, unknown>;
  for (const [beforeKey, afterKey] of CHANGE_PAIRS) {
    if (beforeKey in record || afterKey in record) {
      return {
        label: beforeKey === 'revoked' ? 'Permissions' : 'Value',
        before: flattenDetailValue(record[beforeKey]),
        after: flattenDetailValue(record[afterKey]),
      };
    }
  }
  return null;
}

/**
 * The whole entry as pretty JSON — the payload, untruncated.
 *
 * The ticket's second acceptance criterion is that the drawer shows the full payload, so this
 * serialises the record as it arrived, including both hashes, rather than a chosen subset.
 *
 * @param event The row.
 * @returns Two-space-indented JSON.
 */
export function auditEventJson(event: AuditEvent): string {
  return JSON.stringify(event, null, 2);
}

// ---------------------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------------------

/**
 * How each known action reads as a verb phrase: `[with a target, without one]`.
 *
 * Both halves are spelled out rather than the second being derived by deleting `{target}`
 * from the first, because deleting a placeholder leaves its preposition behind — "recorded a
 * platform override on." is a sentence no reader should be shown.
 *
 * Only actions that real code writes are listed; every one of them was found in
 * `apiome-rest/src/app/{access_routes,permissions,style_guide_revisions}.py`. Anything else
 * falls back to naming the action, because a sentence this module invented for an event it
 * does not know would be the most convincing wrong thing on the screen.
 */
const ACTION_PHRASES: Readonly<Record<string, readonly [string, string]>> = {
  'role.created': ['created the role {target}', 'created a role'],
  'role.deleted': ['deleted the role {target}', 'deleted a role'],
  'role.assigned': ['assigned a role to {target}', 'assigned a role'],
  'permission.changed': ['changed the permissions of {target}', 'changed a role’s permissions'],
  'permission.denied': ['was denied {target}', 'was denied access'],
  'member.invited': ['invited {target}', 'invited a member'],
  'member.invite_resent': ['re-issued the invitation to {target}', 're-issued an invitation'],
  'member.suspended': ['suspended {target}', 'suspended a member'],
  'member.reinstated': ['reinstated {target}', 'reinstated a member'],
  'member.offboarded': ['offboarded {target}', 'offboarded a member'],
  'admin.override': ['recorded a platform override on {target}', 'recorded a platform override'],
  'style_guide.created': ['created the style guide {target}', 'created a style guide'],
  'style_guide.updated': ['updated the style guide {target}', 'updated a style guide'],
  'style_guide.deleted': ['deleted the style guide {target}', 'deleted a style guide'],
  'style_guide.rules_updated': ['changed the rules of {target}', 'changed a style guide’s rules'],
  'style_guide.custom_rules_updated': [
    'changed the custom rules of {target}',
    'changed a style guide’s custom rules',
  ],
  'style_guide.policy_updated': [
    'changed the policy of {target}',
    'changed a style guide’s policy',
  ],
  'style_guide.assigned': ['assigned the style guide {target}', 'assigned a style guide'],
  'style_guide.unassigned': ['unassigned the style guide {target}', 'unassigned a style guide'],
};

/**
 * The entry in one plain sentence, built only from fields the row actually carries.
 *
 * @param event The row.
 * @returns A sentence — actor, what they did, to what, and where it came from.
 */
export function describeAuditEvent(event: AuditEvent): string {
  const actor = auditActorLabel(event);
  const target = event.target || '';
  const phrases = ACTION_PHRASES[event.action];
  const phrase = phrases
    ? target
      ? phrases[0].replace('{target}', target)
      : phrases[1]
    : target
      ? `recorded ${event.action} on ${target}`
      : `recorded ${event.action}`;
  const source = auditSourcePhrase(event.source);
  return `${actor} ${phrase}${source ? ` ${source}` : ''}.`;
}

// ---------------------------------------------------------------------------------------
// The foot
// ---------------------------------------------------------------------------------------

/**
 * The foot's sentence about the read itself.
 *
 * A ledger read is capped, and a reader looking at governance evidence has to be told when
 * they are looking at a window rather than at everything — otherwise "no events" and "no
 * events *in the most recent thousand*" are the same screen.
 *
 * @param loaded How many rows came back.
 * @param limit The cap the request asked for.
 * @param range The date range in force.
 * @returns The sentence, or `''` when the read was not capped and nothing needs saying.
 */
export function describeAuditRead(
  loaded: number,
  limit: number,
  range: AuditRange
): string {
  if (loaded < limit) return '';
  const window =
    range === 'all'
      ? 'the ledger'
      : `${AUDIT_RANGE_LABELS[range].toLowerCase()} of the ledger`;
  return `Showing the most recent ${limit} entries of ${window}. Narrow the date range to reach older entries.`;
}
