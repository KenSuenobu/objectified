/**
 * Tenants list + manage-drawer logic — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` (its **Notes → Keeps (1:1)** list is the
 * acceptance criteria) and `docs/mockups/DESIGN.md` §5.4, §8.
 *
 * Everything here is pure. That is the point of the module rather than a stylistic
 * preference: the screen this ticket replaces kept its member filter and its expansion in
 * *one* pair of `useState`s shared by every tenant panel on the page, so filtering one
 * tenant's members filtered them all and expanding one expanded all. The fix is a drawer
 * scoped to a single tenant — but the fix only holds if the derivations it runs (merge the
 * admin list into the user list, filter, sort, count) take the tenant as an argument
 * instead of reading ambient state. Written as functions of their inputs they cannot leak
 * between tenants, and `tests/tenants-model.test.ts` can hold that.
 *
 * The React that draws all this lives beside it: {@link ../tenants/TenantManageDrawer} for
 * the sheet, {@link ../tenants/TenantsTable} for the list.
 */

/** A tenant row as `lib/db/helper.getTenantsForUser` returns it. */
export interface TenantRecord {
  id: string;
  name: string;
  description: string;
  slug: string;
  enabled: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A `tenant_administrators` row joined to its user. */
export interface TenantAdminRecord {
  /** The join row's own id — what {@link removeTenantAdministrator} needs. */
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  email: string;
}

/** A `tenant_users` row joined to its user. */
export interface TenantUserRecord {
  /** The join row's own id — what {@link removeTenantUser} needs. */
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  email: string;
}

/**
 * One person in a tenant, after the two join tables are merged.
 *
 * `isAdmin` and `isMember` are independent because the tables are: an administrator added
 * straight to `tenant_administrators` has no `tenant_users` row, and the old screen already
 * drew both pills when both were true. Removing such a person needs *both* record ids,
 * which is why they are carried rather than re-derived at the call site.
 */
export interface TenantMember {
  userId: string;
  name: string;
  email: string;
  isAdmin: boolean;
  isMember: boolean;
  /** `tenant_administrators.id`, when they hold the admin role. */
  adminRecordId?: string;
  /** `tenant_users.id`, when they hold the member role. */
  userRecordId?: string;
}

/**
 * Merge the member and administrator join tables into one list of people.
 *
 * A user present in both tables is one person with both roles, not two rows — the old
 * screen's `Map` keyed by `user_id` said the same thing and this keeps it. Order is not
 * meaningful here; {@link sortTenantMembers} decides that.
 *
 * @param users Rows from `tenant_users` for one tenant.
 * @param admins Rows from `tenant_administrators`, which may cover several tenants.
 * @param tenantId The tenant whose members are wanted; `admins` is filtered to it.
 * @returns One entry per distinct `user_id`, in insertion order (members, then
 *   admin-only users).
 */
export function mergeTenantMembers(
  users: readonly TenantUserRecord[],
  admins: readonly TenantAdminRecord[],
  tenantId: string
): TenantMember[] {
  const byUserId = new Map<string, TenantMember>();

  for (const user of users) {
    byUserId.set(user.user_id, {
      userId: user.user_id,
      name: user.name,
      email: user.email,
      isAdmin: false,
      isMember: true,
      userRecordId: user.id,
    });
  }

  for (const admin of admins) {
    if (admin.tenant_id !== tenantId) continue;
    const existing = byUserId.get(admin.user_id);
    if (existing) {
      existing.isAdmin = true;
      existing.adminRecordId = admin.id;
      continue;
    }
    byUserId.set(admin.user_id, {
      userId: admin.user_id,
      name: admin.name,
      email: admin.email,
      isAdmin: true,
      isMember: false,
      adminRecordId: admin.id,
    });
  }

  return Array.from(byUserId.values());
}

/**
 * Narrow a member list by the drawer's filter box.
 *
 * Matches name or email, case-insensitively, on a substring — what the filter did before,
 * kept because the mockup's Keeps list names it ("Filter by name or email…").
 *
 * @param members The tenant's people.
 * @param filter The raw contents of the filter box; blank or whitespace matches everything.
 * @returns The matching members, in the order given.
 */
export function filterTenantMembers(
  members: readonly TenantMember[],
  filter: string
): TenantMember[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...members];
  return members.filter(
    (member) =>
      member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle)
  );
}

/**
 * Order a member list: administrators first, then by name.
 *
 * The mockup's members table is labelled "Admins first, then name", and the screen this
 * replaces sorted the same way. Names are compared with `localeCompare` so accented names
 * land where a reader expects rather than after `Z`.
 *
 * @param members The tenant's people.
 * @returns A new, sorted array; the input is left alone.
 */
export function sortTenantMembers(members: readonly TenantMember[]): TenantMember[] {
  return [...members].sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The member list one drawer shows: merged, filtered, sorted.
 *
 * The composition every members section wants, taking the tenant as an argument — so two
 * open drawers cannot share a filter however the components above are arranged.
 *
 * @param options.users Rows from `tenant_users` for this tenant.
 * @param options.admins Rows from `tenant_administrators` (any tenant).
 * @param options.tenantId The tenant being managed.
 * @param options.filter The filter box's contents.
 * @returns Administrators first, then by name, matching the filter.
 */
export function tenantMembersFor(options: {
  users: readonly TenantUserRecord[];
  admins: readonly TenantAdminRecord[];
  tenantId: string;
  filter: string;
}): TenantMember[] {
  const merged = mergeTenantMembers(options.users, options.admins, options.tenantId);
  return sortTenantMembers(filterTenantMembers(merged, options.filter));
}

/** The counts the members table's foot prints ("5 members · 2 admins"). */
export interface TenantMemberSummary {
  /** Everyone in the tenant. */
  total: number;
  /** How many of them hold the administrator role. */
  admins: number;
}

/**
 * Count a tenant's people and its administrators.
 *
 * Counts the *unfiltered* list — the foot reports the tenant, not the current search.
 *
 * @param members The tenant's people, before filtering.
 * @returns Totals for the table foot.
 */
export function summariseTenantMembers(
  members: readonly TenantMember[]
): TenantMemberSummary {
  return {
    total: members.length,
    admins: members.filter((member) => member.isAdmin).length,
  };
}

/**
 * Whether a user administers a tenant.
 *
 * @param admins Rows from `tenant_administrators` across every tenant.
 * @param tenantId The tenant in question.
 * @param userId The viewer, or `undefined` before the session resolves.
 * @returns True when the pair appears in the join table.
 */
export function isTenantAdmin(
  admins: readonly TenantAdminRecord[],
  tenantId: string,
  userId: string | null | undefined
): boolean {
  if (!userId) return false;
  return admins.some((admin) => admin.tenant_id === tenantId && admin.user_id === userId);
}

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

/**
 * A tenant as the table draws it: the record, plus what the viewer's relationship to it is.
 *
 * Derived rather than stored so the two facts the row's affordances turn on — may I manage
 * this, am I standing in it — are settled once, in one place, instead of at each of the
 * six call sites the old screen recomputed them at.
 */
export interface TenantRow extends TenantRecord {
  /** The viewer administers this tenant, so Manage and Edit are offered. */
  isAdmin: boolean;
  /** This is the session's `current_tenant_id`. */
  isCurrent: boolean;
}

/**
 * The viewer's role in a tenant, as the "Your role" column prints it.
 *
 * Two values, not the mockup's three: the schema has `tenant_administrators` and
 * `tenant_users` and no notion of an owner, so a third pill would be decoration claiming to
 * be data.
 */
export type TenantRoleLabel = 'Admin' | 'Member';

/**
 * The role pill for a row.
 *
 * @param row The tenant row.
 * @returns `'Admin'` when the viewer administers it, otherwise `'Member'`.
 */
export function tenantRoleLabel(row: Pick<TenantRow, 'isAdmin'>): TenantRoleLabel {
  return row.isAdmin ? 'Admin' : 'Member';
}

/**
 * The status vocabulary string for a tenant's enabled flag.
 *
 * Goes through {@link ../../ui/statusVocabulary} rather than naming a colour, so an enabled
 * tenant is the same green as every other `active` thing in the app (DESIGN.md §3.1).
 *
 * @param row The tenant row.
 * @returns `'active'` or `'disabled'` — both members of the shared vocabulary.
 */
export function tenantStatus(row: Pick<TenantRecord, 'enabled'>): 'active' | 'disabled' {
  return row.enabled ? 'active' : 'disabled';
}

/** What the status column reads. */
export function tenantStatusLabel(row: Pick<TenantRecord, 'enabled'>): 'Enabled' | 'Disabled' {
  return row.enabled ? 'Enabled' : 'Disabled';
}

/**
 * Attach the viewer's relationship to each tenant record.
 *
 * @param tenants The records from the API.
 * @param options.admins Rows from `tenant_administrators`.
 * @param options.userId The viewer.
 * @param options.currentTenantId The session's current tenant, if any.
 * @returns One {@link TenantRow} per record, in the order given.
 */
export function buildTenantRows(
  tenants: readonly TenantRecord[],
  options: {
    admins: readonly TenantAdminRecord[];
    userId: string | null | undefined;
    currentTenantId: string | null | undefined;
  }
): TenantRow[] {
  return tenants.map((tenant) => ({
    ...tenant,
    isAdmin: isTenantAdmin(options.admins, tenant.id, options.userId),
    isCurrent: Boolean(options.currentTenantId) && tenant.id === options.currentTenantId,
  }));
}

/** The toolbar's facets. `all` is the resting state, not a filter. */
export type TenantFacet = 'all' | 'administered' | 'enabled';

/** The facets in the order the toolbar draws them. */
export const TENANT_FACETS: readonly TenantFacet[] = ['all', 'administered', 'enabled'];

/** The chip labels, which the mockup fixes. */
export const TENANT_FACET_LABELS: Readonly<Record<TenantFacet, string>> = {
  all: 'All',
  administered: 'You administer',
  enabled: 'Enabled',
};

/**
 * Whether a row belongs to a facet.
 *
 * @param row The tenant row.
 * @param facet The facet being tested.
 * @returns True when the row would survive that chip.
 */
export function matchesTenantFacet(row: TenantRow, facet: TenantFacet): boolean {
  if (facet === 'administered') return row.isAdmin;
  if (facet === 'enabled') return row.enabled;
  return true;
}

/**
 * How many rows each chip would leave, for the faint count beside its label.
 *
 * Counted against the *search-filtered* rows rather than the whole list, so the numbers
 * describe what pressing the chip would actually do from here.
 *
 * @param rows The rows the search box has already narrowed.
 * @returns A count per facet.
 */
export function tenantFacetCounts(
  rows: readonly TenantRow[]
): Readonly<Record<TenantFacet, number>> {
  return {
    all: rows.length,
    administered: rows.filter((row) => row.isAdmin).length,
    enabled: rows.filter((row) => row.enabled).length,
  };
}

/**
 * Narrow the list by the toolbar's search box: tenant name or slug, substring, folded case.
 *
 * The slug is searchable because it is the half of the identity a reader is likelier to
 * have in hand — it is what published spec URLs carry.
 *
 * @param rows Every tenant the viewer belongs to.
 * @param query The search box's contents.
 * @returns The matching rows, in the order given.
 */
export function searchTenantRows(rows: readonly TenantRow[], query: string): TenantRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) || row.slug.toLowerCase().includes(needle)
  );
}

/** The columns the table can be ordered by. */
export type TenantSortColumn = 'name' | 'status';

/**
 * Order the list.
 *
 * Name is the resting order and the mockup's default. Status sorts enabled before disabled
 * ascending, and breaks its ties by name so the order is total — two runs over the same
 * data always agree, which a `sort` on a boolean alone does not guarantee.
 *
 * @param rows The rows to order.
 * @param sort The sorted column and direction, or `null` for the API's own order.
 * @returns A new, sorted array; the input is left alone.
 */
export function sortTenantRows(
  rows: readonly TenantRow[],
  sort: { column: string; direction: 'asc' | 'desc' } | null | undefined
): TenantRow[] {
  if (!sort) return [...rows];
  const factor = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (sort.column === 'status' && a.enabled !== b.enabled) {
      return (a.enabled ? -1 : 1) * factor;
    }
    return a.name.localeCompare(b.name) * factor;
  });
}

/** The counts the table foot prints ("4 tenants · you administer 2"). */
export interface TenantListSummary {
  total: number;
  administered: number;
  enabled: number;
}

/**
 * Count the list for the table foot.
 *
 * @param rows Every tenant the viewer belongs to, before filtering.
 * @returns Totals for the foot.
 */
export function summariseTenantRows(rows: readonly TenantRow[]): TenantListSummary {
  return {
    total: rows.length,
    administered: rows.filter((row) => row.isAdmin).length,
    enabled: rows.filter((row) => row.enabled).length,
  };
}

// ---------------------------------------------------------------------------------------
// Editing a tenant
// ---------------------------------------------------------------------------------------

/** What a slug may contain, and what the API enforces on its side. */
export const TENANT_SLUG_PATTERN = /^[a-z0-9-]+$/;

/** The draft the Edit tenant dialog holds. */
export interface TenantEditDraft {
  name: string;
  slug: string;
  description: string;
}

/**
 * Validate the Edit tenant dialog.
 *
 * The three messages are the ones the screen already produced, kept verbatim — the mockup's
 * Keeps list quotes them, and an error string is part of a screen's contract with whoever
 * has learned to read it.
 *
 * @param draft The dialog's fields.
 * @returns The first problem, or `null` when the draft is submittable.
 */
export function validateTenantEdit(draft: TenantEditDraft): string | null {
  if (!draft.name.trim()) return 'Tenant name is required';
  if (!draft.slug.trim()) return 'Tenant slug is required';
  if (!TENANT_SLUG_PATTERN.test(draft.slug.trim())) {
    return 'Slug must contain only lowercase letters, numbers, and dashes';
  }
  return null;
}

/** What an edit would change, and therefore what has to be confirmed. */
export interface TenantEditChanges {
  nameChanged: boolean;
  slugChanged: boolean;
  /** True when the slug moved — the only change that needs the URL warning. */
  needsSlugConfirm: boolean;
  /** The name as it stands, and as it would read. */
  name: { before: string; after: string };
  /** The slug as it stands, and as it would read. */
  slug: { before: string; after: string };
}

/**
 * Compare a draft against the tenant it edits.
 *
 * The slug confirm exists because a slug appears in published OpenAPI spec URLs, so moving
 * it breaks links that other people's systems hold. That is worth a second dialog, and the
 * dialog has to *enumerate* the change — before and after, both fields — rather than ask
 * "are you sure?", which is the shape the screen already used and the mockup keeps.
 *
 * @param draft The dialog's fields, as typed.
 * @param tenant The tenant being edited.
 * @returns Which fields moved, and whether the confirm is owed.
 */
export function describeTenantEdit(
  draft: TenantEditDraft,
  tenant: Pick<TenantRecord, 'name' | 'slug'>
): TenantEditChanges {
  const name = draft.name.trim();
  const slug = draft.slug.trim();
  const nameChanged = name !== tenant.name;
  const slugChanged = slug !== tenant.slug;
  return {
    nameChanged,
    slugChanged,
    needsSlugConfirm: slugChanged,
    name: { before: tenant.name, after: name },
    slug: { before: tenant.slug, after: slug },
  };
}

/**
 * The slug a name suggests, for the create flow's live suggestion.
 *
 * Lower-cases, turns runs of anything unusable into a single dash, and trims the dashes off
 * both ends — so "Acme, Inc." suggests `acme-inc` rather than `acme--inc-`.
 *
 * @param name An organization name as typed.
 * @returns A slug matching {@link TENANT_SLUG_PATTERN}, or `''` for a name with nothing
 *   usable in it.
 */
export function suggestTenantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------------------
// The drawer's sections
// ---------------------------------------------------------------------------------------

/** The manage drawer's vertical tabs, in the mockup's order. */
export type TenantManageSection = 'members' | 'license' | 'mcp' | 'keys' | 'history';

/** Those sections in order, so the tab strip and the panels cannot disagree. */
export const TENANT_MANAGE_SECTIONS: readonly TenantManageSection[] = [
  'members',
  'license',
  'mcp',
  'keys',
  'history',
];

/** The tab labels, which the mockup fixes. */
export const TENANT_MANAGE_SECTION_LABELS: Readonly<Record<TenantManageSection, string>> = {
  members: 'Members',
  license: 'License & plan',
  mcp: 'MCP settings',
  keys: 'Per-key capabilities',
  history: 'Policy history',
};

/**
 * The note a section shows instead of its content when the tenant is not the current one.
 *
 * Three of the five sections read live data through `/api/tenants/*`, and that proxy is
 * always scoped to the session's current tenant — there is no per-tenant parameter to pass.
 * So for any other tenant the honest thing is to say what to do, naming the tenant, rather
 * than to show the current tenant's figures under someone else's name.
 *
 * @param section The section being drawn.
 * @param tenantName The tenant the drawer is managing.
 * @returns The lock note, or `null` for a section that works for any tenant.
 */
export function tenantSectionLockNote(
  section: TenantManageSection,
  tenantName: string
): string | null {
  const subject = tenantName.trim() || 'this tenant';
  switch (section) {
    case 'license':
      return `Select ${subject} as your current tenant to view its license details.`;
    case 'mcp':
      return `Select ${subject} as your current tenant to view or edit MCP settings.`;
    case 'keys':
      return `Select ${subject} as your current tenant to view or edit key capabilities.`;
    case 'history':
      return `Select ${subject} as your current tenant to view its policy history.`;
    default:
      // Members come from the tenant list the page already loaded, not from the
      // current-tenant proxy, so they are readable for every tenant the viewer administers.
      return null;
  }
}

/** Whether a section needs the drawer's tenant to be the session's current one. */
export function tenantSectionNeedsCurrent(section: TenantManageSection): boolean {
  return section !== 'members';
}
