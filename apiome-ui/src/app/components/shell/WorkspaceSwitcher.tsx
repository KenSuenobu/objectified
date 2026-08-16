'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Plus, Shield } from 'lucide-react';
import { Avatar } from '@/app/components/ui/Avatar';
import { Input } from '@/app/components/ui/Input';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import {
  STATUS_TONE_SOFT_CLASS,
  statusTone,
  type StatusTone,
} from '@/app/components/ui/statusVocabulary';
import CreateTenantDialog, { type CreatedTenant } from '@/app/components/ade/CreateTenantDialog';
import { useAuthSession } from '@lib/auth/session-client';
import { loadTenantMembershipContext } from '@lib/auth/tenant-membership-context';
import type { TenantMembershipContextPayload } from '@lib/auth/tenant-membership-context';
import { persistLastActiveTenant } from '@lib/auth/last-active-tenant-actions';
import type { TenantMembershipRow } from '@lib/auth/tenant-membership-context-mapping';
import { cn } from '@lib/utils';
import { RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';
import {
  RAIL_MENU_ITEM_CLASS,
  RAIL_MENU_ITEM_DISABLED_CLASS,
  RAIL_MENU_LABEL_CLASS,
  RAIL_MENU_SURFACE_CLASS,
  useRailMenu,
} from './railMenu';

/**
 * The rail's workspace switcher (HIVE-3.3, #5289; `DESIGN.md` §5.1–5.2 region 2).
 *
 * This is where the top bar's tenant pill went. The pill was a gradient lozenge with a
 * pulsing dot that lived in a header the redesign retires, and it carried more behaviour
 * than it looked like it did: a filter over name *and* slug, a role badge per membership, a
 * licence-plan chip per membership, suspended memberships that must be visible but not
 * selectable, a check on the current one, and a create entry gated on the plan's tenant cap.
 * Every one of those is here — the switcher moved, it did not shrink.
 *
 * It replaces HIVE-3.1's interim `RailWorkspaceLink`, which linked to the tenants page
 * because the menu could not land in the ticket that built the shell it opens from.
 *
 * ### Workspace, not tenant
 *
 * `DESIGN.md` §5.1 renames the concept for the reader: the *tenant* switcher becomes the
 * **workspace** switcher, and this ticket's create entry is "Create workspace". The word is
 * changed consistently in everything a person reads here — the row, the filter, the empty
 * line, the menu — while every identifier, route, cookie and API stays `tenant`, because
 * those are the storage layer's names and renaming them is not a visual redesign.
 *
 * ### The collapse
 *
 * Collapsed, the rail shows the hex avatar alone and the name moves into a tooltip, exactly
 * as every other rail row does — `.rail-label` is CSS keyed on `data-rail`, so there is no
 * second React tree and nothing flips after hydration. The menu opens from the same anchor
 * at the same size either way (`railMenu.tsx`).
 *
 * ### Why this component owns its own loading
 *
 * `AdeAppShell` used to fetch the membership context purely to read one name out of it. The
 * whole payload — rows, legacy admin ids, the create gate — is this component's subject, so
 * the fetch belongs here: the shell goes back to being the thing that draws a rail, and a
 * host that mounts `AppShell` without a workspace concept simply does not render this
 * region.
 */

/** One membership row, as the enriched `GET /v1/tenants/me` returns it. */
type WorkspaceRow = TenantMembershipRow;

/** Props for {@link WorkspaceSwitcher}. */
export interface WorkspaceSwitcherProps {
  /** Whether the rail is drawing icon-only, in which case the name moves to a tooltip. */
  iconRail: boolean;
  /**
   * Injectable membership loader. Defaults to the `loadTenantMembershipContext` server
   * action — the same one `TopHeader` calls, so nothing new is fetched by moving the
   * switcher here. Exists so a test (or a host with a prefetched context) can supply rows
   * without a server session.
   */
  loadContext?: () => Promise<TenantMembershipContextPayload>;
  /** Called after the session's workspace changes — a host may reload workspace-scoped state. */
  onTenantSelected?: (tenantId: string) => void;
}

/** Copy for a signed-in user who has not joined or created a workspace yet. */
const NO_WORKSPACE = 'No workspace';

/** The row's second line while the membership context is still in flight. */
const LOADING_META = 'Loading…';

/** The row's second line when there is no active workspace to describe. */
const NO_WORKSPACE_META = 'Choose a workspace';

/** What the trigger promises, for the reader who cannot see the chevron. */
const TRIGGER_ACTION = 'Switch workspace';

/** Why a suspended membership cannot be selected. */
const SUSPENDED_TITLE = 'Your membership in this workspace is suspended';

/** The plan tier an unlicensed workspace is treated as, matching the OLO-5.3 enforcement. */
const DEFAULT_PLAN_NAME = 'Free';

/** `id` of the popup, so the trigger's `aria-controls` can point at it. */
const MENU_POPUP_ID = 'rail-workspace-menu';

/**
 * Role → tone, in the shared status vocabulary's names.
 *
 * The header's badges were four hand-written palettes (amber, indigo, emerald, slate, each
 * with a `dark:` twin). These are the same four readings expressed as tones, so the badges
 * follow all nine themes for free and a custom role slug — which the RBAC model allows —
 * lands on `neutral` rather than on no styling at all.
 */
export const WORKSPACE_ROLE_TONE: Readonly<Record<string, StatusTone>> = {
  owner: 'honey',
  admin: 'accent',
  editor: 'ok',
  viewer: 'neutral',
};

/**
 * Ink for a licence chip, per the V097 billing type.
 *
 * `free` is the page's own quiet ink rather than a hue, because "no plan attached" is the
 * absence of a tier rather than a tier of its own — `--fg-muted`, the step that clears AA on
 * the menu surface in every theme (`railMenu.tsx`).
 */
const LICENSE_CHIP_CLASS: Readonly<Record<string, string>> = {
  free: 'text-fg-muted',
  paid: 'text-accent',
  sponsor: 'text-violet',
};

/**
 * The second line of the switcher row: "Owner · Team plan".
 *
 * @param row The active membership, if the context has resolved one.
 * @param loading True while the membership context is still loading.
 * @returns The meta line, never empty — a row with nothing to say still says something.
 */
export function formatWorkspaceMeta(
  row: WorkspaceRow | undefined,
  loading: boolean
): string {
  // No `role` means an unenriched row (a legacy name-only context): claiming a plan there
  // would be a guess, and a wrong plan is worse than no plan.
  if (row?.role) {
    const role = row.role.charAt(0).toUpperCase() + row.role.slice(1);
    return `${role} · ${row.licenseName || DEFAULT_PLAN_NAME}`;
  }
  // A reload after a switch keeps describing the workspace it already knows; only a first
  // load, with nothing to describe yet, says so.
  if (loading) return LOADING_META;
  return NO_WORKSPACE_META;
}

/**
 * Per-membership role badge.
 *
 * With no `role` it falls back to the pre-OLO-6.1 "Admin" shield driven by the legacy
 * administrator set, so a name-only context keeps the one badge it can honestly draw.
 *
 * @param props.role Effective RBAC role slug from the enriched listing, if known.
 * @param props.isLegacyAdmin Legacy administrator flag, for the fallback badge.
 * @returns The badge, or nothing when there is neither a role nor legacy admin rights.
 */
function WorkspaceRoleBadge({ role, isLegacyAdmin }: { role?: string; isLegacyAdmin: boolean }) {
  const effective = role ?? (isLegacyAdmin ? 'admin' : undefined);
  if (!effective) return null;

  const tone = WORKSPACE_ROLE_TONE[effective] ?? 'neutral';
  const label = role ?? 'Admin';
  const showShield = effective === 'owner' || effective === 'admin';

  return (
    <span
      data-testid="tenant-role-badge"
      title={
        role
          ? `Your role in this workspace: ${role}`
          : 'You are an administrator of this workspace'
      }
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-xs px-1.5 py-0.5',
        'text-2xs font-semibold uppercase tracking-[var(--track-caps)]',
        STATUS_TONE_SOFT_CLASS[tone]
      )}
    >
      {showShield && <Shield size={ICON_SIZE.button} aria-hidden />}
      {label}
    </span>
  );
}

/**
 * Per-membership licence-plan chip.
 *
 * An unlicensed workspace (no V182 row) reads as `Free`, which is the tier the REST guard
 * treats it as. A row with no enrichment at all renders nothing rather than a guessed tier.
 *
 * @param props.name Plan display name from the enriched listing, if any.
 * @param props.type Plan billing type (`free`/`paid`/`sponsor`), if any.
 * @param props.role Enrichment marker: chips only render for enriched rows.
 * @returns The chip, or nothing for an unenriched row.
 */
function WorkspaceLicenseChip({
  name,
  type,
  role,
}: {
  name?: string | null;
  type?: string | null;
  role?: string;
}) {
  if (!role) return null;
  const label = name || DEFAULT_PLAN_NAME;

  return (
    <span
      data-testid="tenant-license-chip"
      title={name ? `Licence plan: ${name}` : 'No licence attached — Free plan defaults apply'}
      className={cn(
        'inline-flex shrink-0 items-center text-2xs font-medium',
        LICENSE_CHIP_CLASS[type ?? 'free'] ?? LICENSE_CHIP_CLASS.free
      )}
    >
      · {label}
    </span>
  );
}

/**
 * The workspace switcher.
 *
 * @param props See {@link WorkspaceSwitcherProps}.
 * @returns A 44 px rail row and, when open, the 300 px menu it controls.
 */
export default function WorkspaceSwitcher({
  iconRail,
  loadContext = loadTenantMembershipContext,
  onTenantSelected,
}: WorkspaceSwitcherProps) {
  const router = useRouter();
  const { data: session, update } = useAuthSession();

  const user = session?.user as
    | { user_id?: string; id?: string; current_tenant_id?: string }
    | undefined;
  const userId = user?.user_id ?? user?.id;
  const sessionTenantId = user?.current_tenant_id;

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [rows, setRows] = React.useState<WorkspaceRow[]>([]);
  const [adminTenantIds, setAdminTenantIds] = React.useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const [createGate, setCreateGate] = React.useState<TenantMembershipContextPayload['createTenant']>(
    null
  );
  const [loading, setLoading] = React.useState(() => Boolean(session?.user));
  const [switching, setSwitching] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  // The workspace the reader just chose, shown on the row before the session round-trip
  // that makes it true has finished. Cleared as soon as the session agrees.
  const [pendingTenantId, setPendingTenantId] = React.useState<string | null>(null);

  const currentTenantId = pendingTenantId ?? sessionTenantId ?? null;
  const hasUser = Boolean(user);

  const {
    anchorRef,
    triggerRef,
    menuRef,
    closeMenu,
    onMenuKeyDown,
    focusFirstItem,
    focusLastItem,
    itemTabIndex,
    onItemFocus,
  } = useRailMenu({ open, onClose: () => setOpen(false) });

  // The memberships. Reloaded when the acting user or the active workspace changes, which
  // is what `TopHeader` did — a switch can change what the caller may see.
  React.useEffect(() => {
    if (!hasUser) {
      setRows([]);
      setAdminTenantIds(new Set());
      setCreateGate(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadContext()
      .then((context) => {
        if (cancelled) return;
        setRows(context.tenants);
        setAdminTenantIds(new Set(context.adminTenantIds));
        setCreateGate(context.createTenant ?? null);
      })
      .catch((error: unknown) => {
        // Non-fatal: a rail whose workspace row cannot name the workspace is still a
        // working rail, and a broken page helps nobody.
        console.error('Failed to load workspaces:', error);
        if (cancelled) return;
        setRows([]);
        setAdminTenantIds(new Set());
        setCreateGate(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasUser, userId, sessionTenantId, loadContext]);

  // The session has caught up with the switch; the optimistic name is no longer needed.
  React.useEffect(() => {
    setPendingTenantId(null);
  }, [sessionTenantId]);

  // A reopened menu starts from an unfiltered list rather than resuming the last search.
  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || (row.slug ?? '').toLowerCase().includes(needle)
    );
  }, [rows, query]);

  const currentRow = rows.find((row) => row.id === currentTenantId);
  const name = currentRow?.name?.trim() || NO_WORKSPACE;
  const meta = formatWorkspaceMeta(currentRow, loading);
  // Nothing to name yet: a bar the shape of the name, not the words "No workspace", which
  // would be a claim the switcher cannot yet make (`DESIGN.md` §8).
  const showNamePlaceholder = loading && !currentRow;

  /**
   * Whether the popup has anything to put inside its `role="menu"`.
   *
   * A menu owning no `menuitem` is an `aria-required-children` violation in its own right,
   * and a filter matching nothing would produce exactly that — so the menu element is
   * rendered only when at least one row or the create entry will be.
   */
  const hasMenuItems = filtered.length > 0 || Boolean(createGate);

  /**
   * Make a workspace the active one: session, cookie, then a re-render of the page.
   *
   * @param row The membership the reader chose.
   */
  const handleSelect = React.useCallback(
    async (row: WorkspaceRow) => {
      if (switching || row.status === 'suspended') return;
      // Choosing the workspace you are already in is a no-op that should still put the menu
      // away — the reader has answered the question the menu asked.
      if (row.id === currentTenantId) {
        closeMenu(true);
        return;
      }

      setSwitching(true);
      setPendingTenantId(row.id);
      try {
        await update({ current_tenant_id: row.id });
        // Durable last-active persistence (OLO-6.1) so the next login restores this
        // workspace via the OLO-3.3 routing rules. Best-effort: a cookie write that fails
        // must not break the switch itself.
        persistLastActiveTenant(row.id).catch((error: unknown) => {
          console.error('Failed to persist last-active workspace:', error);
        });
        onTenantSelected?.(row.id);
        closeMenu(true);
        // Re-render the server components so workspace-scoped views pick up the new
        // workspace without a full page reload.
        router.refresh();
      } catch (error) {
        console.error('Failed to switch workspace:', error);
        setPendingTenantId(null);
      } finally {
        setSwitching(false);
      }
    },
    [closeMenu, currentTenantId, onTenantSelected, router, switching, update]
  );

  /**
   * A workspace created from the menu becomes the active one immediately: list it, spend
   * one slot of the cap, activate it in the session and refresh.
   *
   * @param tenant The workspace the dialog created.
   */
  const handleCreated = React.useCallback(
    async (tenant: CreatedTenant) => {
      setCreateOpen(false);
      setRows((current) =>
        current.some((row) => row.id === tenant.id)
          ? current
          : [...current, { id: tenant.id, name: tenant.name, slug: tenant.slug, role: 'owner' }]
      );
      setCreateGate((gate) =>
        gate ? { ...gate, used: gate.used + 1, allowed: gate.used + 1 < gate.max } : gate
      );
      setPendingTenantId(tenant.id);
      try {
        await update({ current_tenant_id: tenant.id });
        persistLastActiveTenant(tenant.id).catch((error: unknown) => {
          console.error('Failed to persist last-active workspace:', error);
        });
        onTenantSelected?.(tenant.id);
        router.refresh();
      } catch (error) {
        // Non-fatal: the session callback re-derives the active workspace on the next
        // request, so the new workspace is still reachable from this menu.
        console.error('Failed to activate the created workspace:', error);
        setPendingTenantId(null);
      }
    },
    [onTenantSelected, router, update]
  );

  // The shell is a signed-in surface; with no session there is no workspace to switch.
  if (!hasUser) return null;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-testid="rail-workspace"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? MENU_POPUP_ID : undefined}
      // Disabled only while there is genuinely nothing to open. A reload triggered by the
      // switch itself must not disable the row the reader's focus was just restored to.
      disabled={loading && rows.length === 0}
      onClick={() => setOpen((current) => !current)}
      className={cn(
        // 44 px (`hive.css` §6 `.ws-switch`) — as `min-h-11` rather than a fixed height, so
        // the row grows with the font-size preference instead of clipping its second line.
        'rail-item flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-[var(--dur-fast)] disabled:cursor-wait',
        RAIL_ITEM_HOVER_CLASS
      )}
    >
      {/* Decorative — the name is written beside it — and `neutral` until there is an
          identity to hash, so a placeholder never borrows another workspace's tint. */}
      <Avatar
        size="sm"
        shape="hex"
        seed={currentTenantId ?? undefined}
        name={name}
        tone={currentTenantId ? 'auto' : 'neutral'}
        className="shrink-0"
      />
      {/* What the row *does*, for a reader who cannot see the chevron — and, in the icon
          rail, the whole of the button's accessible name once CSS has taken the label away. */}
      <span className="sr-only">{TRIGGER_ACTION}</span>
      <span className="rail-label min-w-0 flex-1 flex-col gap-0.5">
        {showNamePlaceholder ? (
          <Skeleton className="h-3.5 w-24" />
        ) : (
          <span className="truncate text-sm font-semibold leading-tight text-fg">{name}</span>
        )}
        <span className="truncate text-2xs text-fg-muted">{meta}</span>
      </span>
      <span className="rail-label shrink-0 items-center text-fg-subtle">
        <ChevronsUpDown size={ICON_SIZE.button} aria-hidden />
      </span>
    </button>
  );

  return (
    <div ref={anchorRef} className="relative">
      <RailTooltip label={`${name} — ${TRIGGER_ACTION.toLowerCase()}`} when={iconRail}>
        {trigger}
      </RailTooltip>

      {open && (
        <div
          id={MENU_POPUP_ID}
          data-testid="workspace-menu"
          className={cn(RAIL_MENU_SURFACE_CLASS, 'w-75 max-h-[min(70vh,24rem)]')}
        >
          {/*
           * The filter is chrome *around* the menu, not part of it: a `searchbox` is not a
           * permitted child of `role="menu"` and owning one fails axe `aria-required-children`
           * (critical). So the popup itself carries no role, and `role="menu"` sits on the
           * element that owns only the items.
           */}
          <div className="shrink-0 pb-1.5">
            <Input
              type="search"
              autoComplete="off"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // The two keystrokes that make a filtered menu usable without a mouse: down
                // into its first item, up into its last. Everything else typed here is the
                // query — including `Esc`, which the anchor's own handler answers.
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  focusFirstItem();
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  focusLastItem();
                }
              }}
              placeholder="Search workspaces…"
              aria-label="Filter workspaces"
              className="h-nav-item text-sm"
            />
          </div>

          {filtered.length === 0 && (
            <p className="px-2.5 py-2 text-sm text-fg-muted">
              {query.trim() ? 'No matching workspaces' : 'No workspaces yet'}
            </p>
          )}

          {hasMenuItems && (
            <>
              {/* Above the menu rather than inside it: the heading repeats the menu's own
                  accessible name, and a paragraph is not a permitted child of `role="menu"`. */}
              {filtered.length > 0 && (
                <p className={cn(RAIL_MENU_LABEL_CLASS, 'shrink-0')} aria-hidden>
                  Workspaces
                </p>
              )}
              <div
                ref={menuRef}
                role="menu"
                aria-label="Your workspaces"
                onKeyDown={onMenuKeyDown}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                {filtered.length > 0 && (
                  <div role="none" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {filtered.map((row, index) => {
                      const isCurrent = row.id === currentTenantId;
                      const isSuspended = row.status === 'suspended';
                      return (
                        <button
                          key={row.id}
                          type="button"
                          // A single-choice list: exactly one workspace is the current one,
                          // and `aria-checked` is what says so to a reader who cannot see
                          // the tick. `menuitemradio` is a permitted child of `role="menu"`.
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          // `aria-disabled`, never `disabled`: a suspended membership has to
                          // stay reachable, or the reader who needs the explanation is the
                          // one who can never focus the row that carries it.
                          aria-disabled={isSuspended || undefined}
                          title={isSuspended ? SUSPENDED_TITLE : undefined}
                          tabIndex={itemTabIndex(index)}
                          onFocus={() => onItemFocus(index)}
                          onClick={() => void handleSelect(row)}
                          data-testid={`workspace-option-${row.id}`}
                          className={cn(
                            RAIL_MENU_ITEM_CLASS,
                            isSuspended && RAIL_MENU_ITEM_DISABLED_CLASS,
                            isCurrent && 'font-semibold',
                            switching && !isCurrent && 'opacity-50'
                          )}
                        >
                          <Avatar
                            size="xs"
                            shape="hex"
                            seed={row.id}
                            name={row.name}
                            className="shrink-0"
                          />
                          <span className="min-w-0 flex-1 truncate">{row.name}</span>
                          {isSuspended && (
                            <span
                              className={cn(
                                'inline-flex shrink-0 items-center rounded-xs px-1.5 py-0.5',
                                'text-2xs font-semibold uppercase tracking-[var(--track-caps)]',
                                STATUS_TONE_SOFT_CLASS[statusTone('suspended')]
                              )}
                            >
                              Suspended
                            </span>
                          )}
                          <WorkspaceRoleBadge
                            role={row.role}
                            isLegacyAdmin={adminTenantIds.has(row.id)}
                          />
                          <WorkspaceLicenseChip
                            name={row.licenseName}
                            type={row.licenseType}
                            role={row.role}
                          />
                          {isCurrent && (
                            <Check size={ICON_SIZE.dense} className="shrink-0 text-accent" aria-hidden />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {createGate && (
                  <div role="none" className="mt-1.5 shrink-0 border-t border-border pt-1.5">
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="create-tenant-entry"
                      aria-disabled={!createGate.allowed || undefined}
                      title={
                        createGate.allowed
                          ? undefined
                          : `Workspace limit reached (${createGate.used} of ${createGate.max} used) — upgrade your plan to create more`
                      }
                      tabIndex={itemTabIndex(filtered.length)}
                      onFocus={() => onItemFocus(filtered.length)}
                      onClick={() => {
                        if (!createGate.allowed) return;
                        // Focus back on the trigger *before* the dialog opens: that is the
                        // element Radix will return focus to when the dialog closes, and a
                        // menu item that is about to unmount is not one.
                        closeMenu(true);
                        setCreateOpen(true);
                      }}
                      className={cn(
                        RAIL_MENU_ITEM_CLASS,
                        createGate.allowed ? 'text-accent' : RAIL_MENU_ITEM_DISABLED_CLASS
                      )}
                    >
                      <Plus size={ICON_SIZE.dense} className="shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">Create workspace</span>
                      <span className="shrink-0 text-2xs font-medium text-fg-muted">
                        {createGate.used}/{createGate.max}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <CreateTenantDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(tenant) => void handleCreated(tenant)}
      />
    </div>
  );
}
