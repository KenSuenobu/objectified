/**
 * The rules the Published surface runs on (HIVE-8.1, #5327).
 *
 * Authority: `docs/mockups/ship/published.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria, and `docs/mockups/DESIGN.md` §3.1 (status vocabulary), §7
 * (badges and buttons) and §8 (list page).
 *
 * ### Why a model file
 *
 * The 707-line screen this replaces decided everything inline: it built four REST URLs in
 * four one-line arrow functions, spelled the visibility confirm's copy in a template literal
 * beside the `await`, repeated the same forty-character *"Create an API key to access private
 * versions"* tooltip three times inside a hand-positioned menu, and filtered the table in a
 * predicate nested in the JSX. None of that could be tested without rendering a page and
 * mocking a database.
 *
 * Everything here is a pure function over plain data, so the rules are unit tested directly
 * and the screen is left with the four things that genuinely need a browser: the read, the
 * two writes, which overlay is open, and the clipboard.
 *
 * ### What it deliberately does not decide
 *
 * The mock cell. Its toggle, its URL, its copy and its scenario editor are `VersionMockCell`
 * (SIM-2.2, re-skinned by HIVE-6.2) and stay exactly as they are — this screen and Build →
 * Versions must not grow two answers to the same control.
 *
 * @see `./PublishedTable.tsx` — the columns these rules feed.
 * @see `../versions/versionsModel.ts` — the version stamps and the lifecycle rule, shared.
 */

import type { ConfirmDialogProps } from '@/app/components/dialogs/ConfirmDialog';

import {
  VERSION_LIFECYCLE_LABEL,
  formatSunsetUtc,
  lifecycleFromMetadata,
  revisionDeprecationMeta,
  versionLabel,
  type VersionLifecycle,
} from '../versions/versionsModel';

// ---------------------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------------------

/**
 * One published revision, as `getPublishedVersionsForTenant` returns it.
 *
 * Shaped by the SQL rather than by REST: this screen reads the `versions` row directly, which
 * is why `metadata` is a raw JSON object here and the lifecycle is derived from it below
 * rather than arriving as a field.
 */
export interface PublishedVersion {
  /** The `versions.id` UUID — the row key, and what the two writes address. */
  id: string;
  /** The human version label, e.g. `2.3.1`. Stored without its `v`. */
  version_id: string;
  /** The revision note, or `null`. */
  description: string | null;
  /** Whether the published spec needs an API key. */
  visibility: 'public' | 'private';
  /** When it was published. */
  published_at: string;
  /** When the revision was created. */
  created_at: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  creator_name: string;
  creator_email: string;
  /** Hosted mock toggle state (#4422, SIM-2.1). */
  mock_enabled: boolean;
  /** Revision JSON (#507, #748): `lifecycle`, `deprecated`, `sunsetAt`, `successorRevisionId`. */
  metadata?: Record<string, unknown> | null;
}

/** An API key as `getApiKeysForTenant` summarises it — enough to answer "is there a live one?". */
export interface PublishedApiKeySummary {
  id: string;
  enabled: boolean;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

/** Where the header's shortcut and the key dialog's link go. */
export const API_KEYS_HREF = '/ade/dashboard/api-keys';

/** Where the empty state sends a workspace with nothing published yet. */
export const VERSIONS_HREF = '/ade/dashboard/versions';

/** Where a Deprecated pill sends a reader who wants the rest of the story. */
export const SUNSET_TIMELINE_HREF = '/ade/dashboard/versions/sunset-timeline';

/** The breadcrumb's first crumb. */
export const HOME_HREF = '/ade/dashboard';

// ---------------------------------------------------------------------------------------
// Access URLs
// ---------------------------------------------------------------------------------------

/**
 * The tenant-scoped path every published artefact is addressed by.
 *
 * `{tenant}/{project}/{version}`, all three as *slugs* — the acceptance criterion "access
 * URLs are correct per tenant slug" is this function, which is why it is not four inline
 * template literals any more.
 *
 * @param version The published revision.
 * @returns The path, with no leading or trailing slash.
 */
export function publishedAccessPath(version: PublishedVersion): string {
  return `${version.tenant_slug}/${version.project_slug}/${version.version_id}`;
}

/** The four things a published revision can be opened as. */
export type PublishedViewKind = 'openapi' | 'arazzo' | 'json' | 'swagger';

/** The REST path segment each viewer is served from. */
const VIEW_SEGMENT: Readonly<Record<PublishedViewKind, string>> = {
  openapi: 'schema',
  arazzo: 'arazzo',
  json: 'json',
  swagger: 'swagger',
};

/**
 * The absolute URL of one viewer for one revision.
 *
 * @param restApiBaseUrl The REST base resolved on the server, e.g. `https://api.example.com/v1`.
 * @param version The published revision.
 * @param kind Which viewer.
 * @returns The URL, without an API key.
 */
export function publishedViewUrl(
  restApiBaseUrl: string,
  version: PublishedVersion,
  kind: PublishedViewKind
): string {
  const base = restApiBaseUrl.replace(/\/+$/, '');
  return `${base}/${VIEW_SEGMENT[kind]}/${publishedAccessPath(version)}`;
}

/**
 * The relative access URL the table prints — `schema/acme/payments-api/2.3.1`.
 *
 * The cell shows the path rather than the absolute URL because the host is the same for every
 * row and would push the interesting half out of the column; Copy always copies the absolute
 * one, which is the thing a consumer can paste.
 *
 * @param version The published revision.
 * @returns The printed path.
 */
export function publishedAccessLabel(version: PublishedVersion): string {
  return `${VIEW_SEGMENT.openapi}/${publishedAccessPath(version)}`;
}

/**
 * Append the tenant API key as the `api_key` query parameter REST reads.
 *
 * @param url The viewer URL.
 * @param apiKey The key, or nothing.
 * @returns The URL unchanged when there is no key, otherwise the URL with `api_key` appended.
 */
export function withApiKey(url: string, apiKey: string | null | undefined): string {
  const trimmed = apiKey?.trim();
  if (!trimmed) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}api_key=${encodeURIComponent(trimmed)}`;
}

// ---------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------

/**
 * Whether one key can still authenticate a request.
 *
 * @param key The key summary.
 * @param now The clock, injectable so the rule is deterministic under test.
 * @returns `true` when the key is enabled and has not expired.
 */
export function isApiKeyUsable(key: PublishedApiKeySummary, now: Date = new Date()): boolean {
  if (!key.enabled) return false;
  if (!key.expires_at) return true;
  const expiry = new Date(key.expires_at);
  return Number.isNaN(expiry.getTime()) ? true : expiry >= now;
}

/**
 * Whether the workspace holds at least one key that would open a private version.
 *
 * This is what gates the View fly-out: offering *"OpenAPI"* on a private revision to a
 * workspace with no key at all is an invitation to a 401.
 *
 * @param keys Every key summary read for the tenant.
 * @param now The clock.
 * @returns `true` when any key is live.
 */
export function hasUsableApiKey(
  keys: readonly PublishedApiKeySummary[],
  now: Date = new Date()
): boolean {
  return keys.some((key) => isApiKeyUsable(key, now));
}

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

/**
 * A published revision's lifecycle, from its stored metadata.
 *
 * @param version The published revision.
 * @returns One of the four `#739` lifecycles.
 */
export function publishedLifecycle(version: PublishedVersion): VersionLifecycle {
  return lifecycleFromMetadata(version.metadata);
}

/** The pill a row's lifecycle earns, or `null` for the ordinary case. */
export interface PublishedLifecyclePill {
  /** The lifecycle, which is also the status-vocabulary word the badge is toned by. */
  lifecycle: VersionLifecycle;
  /** What the pill says — `Deprecated`. */
  label: string;
  /** Its `title`, naming the sunset instant when one is scheduled. */
  title: string;
  /** The sunset instant as `27 Aug 2026 00:00 UTC`, or `null`. */
  sunsetLabel: string | null;
}

/**
 * The lifecycle pill for one row.
 *
 * `stable` earns nothing: three of the mockup's four rows draw no pill, because a chip on
 * every row is a chip that says nothing. Anything else is worth a reader's attention, and a
 * deprecated revision with a sunset says when in its tooltip.
 *
 * @param version The published revision.
 * @returns The pill, or `null` when the revision is stable.
 */
export function publishedLifecyclePill(version: PublishedVersion): PublishedLifecyclePill | null {
  const lifecycle = publishedLifecycle(version);
  if (lifecycle === 'stable') return null;
  const { sunsetAt } = revisionDeprecationMeta({ metadata: version.metadata ?? undefined });
  const sunsetLabel = sunsetAt ? formatSunsetUtc(sunsetAt) : null;
  const label = VERSION_LIFECYCLE_LABEL[lifecycle];
  return {
    lifecycle,
    label,
    sunsetLabel,
    title: sunsetLabel
      ? `${label} — sunsets ${sunsetLabel}. See the sunset timeline.`
      : `${label} — see the sunset timeline.`,
  };
}

// ---------------------------------------------------------------------------------------
// Search and the foot
// ---------------------------------------------------------------------------------------

/**
 * The client-side filter, over the four fields the screen this replaces searched.
 *
 * Project name, version label, description and tenant name — kept 1:1, including the fact
 * that there is no sorting and no paging on this surface.
 *
 * @param versions Every published revision read for the tenant.
 * @param query What the reader typed.
 * @returns The matching rows, in the order they arrived (newest published first).
 */
export function searchPublishedVersions(
  versions: readonly PublishedVersion[],
  query: string
): PublishedVersion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...versions];
  return versions.filter((version) =>
    [version.project_name, version.version_id, version.description ?? '', version.tenant_name].some(
      (field) => field.toLowerCase().includes(needle)
    )
  );
}

/**
 * The foot's sentence — `Showing 3 of 4 published versions`.
 *
 * @param shown How many rows the table is drawing.
 * @param total How many the workspace has.
 * @returns The sentence, with `version` singular when the workspace holds exactly one.
 */
export function publishedFootLabel(shown: number, total: number): string {
  return `Showing ${shown} of ${total} published ${total === 1 ? 'version' : 'versions'}`;
}

/**
 * Whether the foot should carry its `(filtered)` marker.
 *
 * Only when a search is actually narrowing the list: a query that matches everything has
 * hidden nothing, and saying "filtered" there is noise.
 *
 * @param query The search box's value.
 * @param shown How many rows the table is drawing.
 * @param total How many the workspace has.
 * @returns `true` when the marker belongs.
 */
export function isPublishedListFiltered(query: string, shown: number, total: number): boolean {
  return Boolean(query.trim()) && shown < total;
}

// ---------------------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------------------

/** The two directions the visibility toggle can go. */
export type PublishedVisibility = 'public' | 'private';

/**
 * The visibility a click on the toggle would move a row to.
 *
 * @param version The published revision.
 * @returns The other visibility.
 */
export function nextVisibility(version: PublishedVersion): PublishedVisibility {
  return version.visibility === 'public' ? 'private' : 'public';
}

/**
 * The toggle's tooltip — `Click to change to private`.
 *
 * @param version The published revision.
 * @returns The tooltip sentence.
 */
export function visibilityToggleTooltip(version: PublishedVersion): string {
  return `Click to change to ${nextVisibility(version)}`;
}

/**
 * The visibility confirm, in the exact words the mockup's overlay carries.
 *
 * `Change Visibility to PUBLIC` / the two-sentence consequence / a `Change Visibility` button
 * — the mockup's **Keeps** list names this copy explicitly, so it is stated once here rather
 * than composed at the call site where a re-word would go unnoticed.
 *
 * @param version The published revision.
 * @returns Options for `useDialog().confirm`.
 */
export function visibilityConfirm(
  version: PublishedVersion
): Pick<ConfirmDialogProps, 'title' | 'message' | 'variant' | 'confirmLabel' | 'cancelLabel'> {
  const next = nextVisibility(version);
  return {
    title: `Change Visibility to ${next.toUpperCase()}`,
    message:
      next === 'public'
        ? 'Change visibility to PUBLIC?\n\nThis will make the OpenAPI Specification public without requiring an API Key.'
        : 'Change visibility to PRIVATE?\n\nThis will restrict access by requiring an API Key.',
    variant: 'warning',
    confirmLabel: 'Change Visibility',
    cancelLabel: 'Cancel',
  };
}

/**
 * The toast a successful visibility change raises.
 *
 * @param next The visibility the row is now in.
 * @returns The sentence.
 */
export function visibilityChangedToast(next: PublishedVisibility): string {
  return `Visibility changed to ${next}.`;
}

/**
 * The banner a failed visibility change raises.
 *
 * The mockup draws it as a danger banner reading `Failed to update visibility: 503 Service
 * Unavailable`, so the server's own words are kept and only the lead-in is ours.
 *
 * @param reason What went wrong, from REST or from the caught error.
 * @returns The sentence.
 */
export function visibilityErrorMessage(reason: string | null | undefined): string {
  const detail = reason?.trim();
  return detail ? `Failed to update visibility: ${detail}` : 'Failed to update visibility.';
}

/** What the screen says when the round-trip itself threw rather than returning a failure. */
export const VISIBILITY_UNKNOWN_ERROR = 'An error occurred while updating visibility';

// ---------------------------------------------------------------------------------------
// The row menu
// ---------------------------------------------------------------------------------------

/**
 * Everything a row can be asked to do.
 *
 * `key` is the mockup's *Private — needs an API key* button beside the kebab: it always
 * prompts, which is the only way a reader can replace a key this device already remembers.
 * Every other action uses a remembered key without asking.
 */
export type PublishedRowAction = PublishedViewKind | 'copy' | 'visibility' | 'key';

/** The tooltip a gated viewer carries, and the only reason it is ever inert. */
export const PRIVATE_NEEDS_KEY_TITLE = 'Create an API key to access private versions';

/** One entry of the kebab's View fly-out. */
export interface PublishedViewItem {
  /** Which viewer. */
  id: PublishedViewKind;
  /** What it says — `OpenAPI`, `Arazzo`, `JSON Schema`. */
  label: string;
  /** Inert because the revision is private and the workspace holds no live key. */
  disabled: boolean;
  /** Its `title` — the reason when inert, what it opens otherwise. */
  title: string;
}

/** What the fly-out's three entries are called, and what they open. */
const VIEW_ITEMS: readonly { id: PublishedViewKind; label: string; title: string }[] = [
  { id: 'openapi', label: 'OpenAPI', title: 'View OpenAPI spec' },
  { id: 'arazzo', label: 'Arazzo', title: 'View in Arazzo' },
  { id: 'json', label: 'JSON Schema', title: 'View JSON Schema' },
];

/** What the menu's rules need beyond the row itself. */
export interface PublishedRowMenuContext {
  /** Whether the workspace holds at least one live API key. */
  hasApiKey: boolean;
}

/**
 * The View fly-out's three entries for one row.
 *
 * A private revision with no key in the workspace makes all three inert with the one reason,
 * which is the acceptance criterion *"private-version viewing still requires and offers a
 * key"* seen from the side where the key does not exist yet. Where a key does exist, the
 * screen asks for it in the dialog instead.
 *
 * Swagger UI is deliberately **not** in this list and is never gated: the screen this replaces
 * left it reachable, and its viewer prompts for the key itself.
 *
 * @param version The published revision.
 * @param context See {@link PublishedRowMenuContext}.
 * @returns The three entries, in mockup order.
 */
export function publishedViewItems(
  version: PublishedVersion,
  context: PublishedRowMenuContext
): PublishedViewItem[] {
  const gated = version.visibility === 'private' && !context.hasApiKey;
  return VIEW_ITEMS.map((item) => ({
    id: item.id,
    label: item.label,
    disabled: gated,
    title: gated ? PRIVATE_NEEDS_KEY_TITLE : item.title,
  }));
}

/** One entry of the kebab, below the fly-out. */
export interface PublishedRowMenuItem {
  /** Which action. */
  id: Extract<PublishedRowAction, 'swagger' | 'copy' | 'visibility'>;
  /** What it says. */
  label: string;
  /** A hairline above it. */
  separatorBefore?: boolean;
}

/**
 * The kebab's entries below the View fly-out, in mockup order.
 *
 * Swagger UI · Copy URL · —— · Make Private/Public. There is deliberately no unpublish and no
 * delete here: the mockup's **Keeps** list says so outright, and both live on Build → Versions
 * where the revision itself is edited.
 *
 * @param version The published revision.
 * @returns The entries.
 */
export function publishedRowMenuItems(version: PublishedVersion): PublishedRowMenuItem[] {
  return [
    { id: 'swagger', label: 'Swagger UI' },
    { id: 'copy', label: 'Copy URL' },
    {
      id: 'visibility',
      label: version.visibility === 'public' ? 'Make Private' : 'Make Public',
      separatorBefore: true,
    },
  ];
}

/**
 * A row's accessible name, for the kebab's label and the table's row announcement.
 *
 * @param version The published revision.
 * @returns `Payments API v2.3.1`.
 */
export function publishedRowLabel(version: PublishedVersion): string {
  return `${version.project_name} ${versionLabel(version)}`;
}

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------

/** How long the Access URL cell stays in its copied state. The mockup's foot names the 2 s. */
export const COPIED_URL_RESET_MS = 2000;

/** The toast a successful Copy URL raises. */
export const COPY_URL_SUCCESS = 'Published API URL copied to clipboard.';

/** The toast a failed Copy URL raises. */
export const COPY_URL_FAILURE = 'Failed to copy URL to clipboard.';

/** The toast clearing the remembered preview key raises. */
export const PREVIEW_KEY_CLEARED = 'Saved API key removed from this browser.';

// ---------------------------------------------------------------------------------------
// The states with no rows
// ---------------------------------------------------------------------------------------

/** What the screen says while the first read is in flight. */
export const PUBLISHED_LOADING_LABEL = 'Loading published versions...';

/** What it says when the read failed. */
export const PUBLISHED_LOAD_ERROR = 'Could not load published versions';

/** What it says to a workspace that has published nothing. */
export const PUBLISHED_EMPTY = {
  title: 'No published versions',
  description:
    "You don't have any published versions yet. Publish a version to make it available via API.",
  actionLabel: 'Go to versions',
} as const;

/** What it says when the search matched nothing. */
export const PUBLISHED_NO_MATCHES = {
  title: 'No matching versions',
  description: 'No published versions match your search query.',
} as const;

/** What it says with no workspace chosen. */
export const PUBLISHED_NO_TENANT = {
  title: 'No tenant selected',
  description: 'Please select a tenant before managing publications.',
} as const;

/** The one line under the page title, describing what the workspace has published. */
export function publishedSummaryLine(versions: readonly PublishedVersion[]): string {
  if (versions.length === 0) {
    return 'Published, locked versions with access URLs, visibility and hosted mocks.';
  }
  const publicCount = versions.filter((version) => version.visibility === 'public').length;
  const mockCount = versions.filter((version) => version.mock_enabled).length;
  const noun = versions.length === 1 ? 'version' : 'versions';
  return `${versions.length} published ${noun} · ${publicCount} public · ${mockCount} with a hosted mock`;
}
