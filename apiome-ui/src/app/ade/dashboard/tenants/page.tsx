'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';
import {
  addTenantAdministrator,
  addTenantUser,
  getTenantsAdministratedByUser,
  getTenantsForUser,
  getTenantUsers,
  removeTenantAdministrator,
  removeTenantUser,
  updateTenant,
} from '../../../../../lib/db/helper';

import { Button } from '@/app/components/ui/Button';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import CreateTenantDialog, {
  type CreatedTenant,
} from '@/app/components/ade/CreateTenantDialog';
import {
  AddMemberDialog,
  buildTenantRows,
  EditMemberRolesDialog,
  EditTenantDialog,
  mergeTenantMembers,
  RemoveMemberDialog,
  summariseTenantRows,
  TenantManageDrawer,
  TenantsTable,
  type TenantAdminRecord,
  type TenantEditDraft,
  type TenantMember,
  type TenantRecord,
  type TenantRow,
  type TenantUserRecord,
} from '@/app/components/ade/tenants';

/**
 * Tenants — `/ade/dashboard/tenants` (HIVE-5.1, #5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §5.4 (drawer), §8 (list).
 *
 * ### What this page owns
 *
 * The data and the mutations, and nothing about how either is drawn. The list is
 * {@link TenantsTable}; managing one tenant is {@link TenantManageDrawer}; the five dialogs
 * are their own components. What is left here is the part that genuinely belongs to the
 * page: one load of the three tables it needs, the six write calls, and which tenant each
 * overlay is currently about.
 *
 * ### The bug this rewrite closes
 *
 * The screen this replaces rendered a `hidden` administration block *per administered
 * tenant*, stacked under the table, and opened one by reaching for it by id and calling
 * `classList.toggle('hidden')` — so React never knew a panel was open. Worse, the three
 * panels inside those blocks shared one `isMembersExpanded` and one `memberFilter` between
 * every tenant on the page: filtering one tenant's members filtered all of them.
 *
 * Both follow from the same mistake — state that belongs to *one tenant* kept where it
 * outlives the tenant. The fix is not to key those two `useState`s by tenant id but to make
 * the panel a drawer that exists only while one tenant is being managed, and to let each
 * section inside it hold its own state. `openTenantId` below is the only tenant-scoped
 * thing this component still keeps, and it is a single id because only one drawer can be
 * open at a time.
 */

/** Where the drawer's "Open full page" and members foot link go. */
const MEMBERS_ROUTE = '/ade/dashboard/members';

/** The breadcrumb's first step. */
const HOME_ROUTE = '/ade/dashboard';

/** The `#create` deep link the workspace switcher's "Create workspace" uses. */
const CREATE_HASH = '#create';

/** Which overlay, if any, is open over the page. */
type TenantOverlay = 'none' | 'create' | 'edit-tenant' | 'add-member' | 'edit-roles' | 'remove-member';

/**
 * Read a `success`/`error` envelope from `lib/db/helper`.
 *
 * Those helpers answer with a JSON *string*, and every call site used to parse it inline and
 * reach for `.error` with a different fallback sentence. One reader keeps the fallbacks
 * consistent and keeps a malformed answer from throwing a `SyntaxError` at the reader
 * instead of a message.
 *
 * @param raw The helper's return value.
 * @param fallback What to say when the call failed without a message.
 * @returns `null` when the call succeeded, otherwise the error to show.
 */
function readEnvelope(raw: string, fallback: string): string | null {
  try {
    const body = JSON.parse(raw) as { success?: boolean; error?: string };
    if (body.success) return null;
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

/**
 * The tenants page.
 *
 * @returns The page header, the list, the manage drawer and the five dialogs.
 */
export default function TenantsPage() {
  const { data: session, status, update } = useAuthSession();

  const [tenants, setTenants] = React.useState<TenantRecord[]>([]);
  const [admins, setAdmins] = React.useState<TenantAdminRecord[]>([]);
  const [tenantUsers, setTenantUsers] = React.useState<Record<string, TenantUserRecord[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  /** The tenant whose manage drawer is open — the page's only per-tenant state. */
  const [openTenantId, setOpenTenantId] = React.useState<string | null>(null);
  const [overlay, setOverlay] = React.useState<TenantOverlay>('none');
  /** The tenant an overlay is about, which is not always the one being managed. */
  const [overlayTenantId, setOverlayTenantId] = React.useState<string | null>(null);
  const [overlayMember, setOverlayMember] = React.useState<TenantMember | null>(null);

  const sessionUser = session?.user as
    | { user_id?: string; current_tenant_id?: string }
    | undefined;
  const sessionUserId = sessionUser?.user_id ?? null;
  const currentTenantId = sessionUser?.current_tenant_id ?? null;

  const loadTenantsData = React.useCallback(async () => {
    if (status === 'loading') return;
    if (!sessionUserId) {
      setTenants([]);
      setAdmins([]);
      setTenantUsers({});
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [tenantsData, adminData] = await Promise.all([
        getTenantsForUser(sessionUserId),
        getTenantsAdministratedByUser(sessionUserId),
      ]);
      const parsedTenants = JSON.parse(tenantsData) as TenantRecord[];
      const parsedAdmins = JSON.parse(adminData) as TenantAdminRecord[];
      setTenants(parsedTenants);
      setAdmins(parsedAdmins);

      // Member lists are only readable for tenants the viewer administers, which is also
      // the only place they are shown.
      const administeredIds = [...new Set(parsedAdmins.map((admin) => admin.tenant_id))];
      const usersMap: Record<string, TenantUserRecord[]> = {};
      await Promise.all(
        administeredIds.map(async (tenantId) => {
          const users = await getTenantUsers(tenantId);
          usersMap[tenantId] = JSON.parse(users) as TenantUserRecord[];
        })
      );
      setTenantUsers(usersMap);
    } catch (err) {
      console.error(err);
      setTenants([]);
      setAdmins([]);
      setTenantUsers({});
      setLoadError(err instanceof Error ? err.message : 'Could not load your tenants.');
    } finally {
      setLoading(false);
    }
  }, [sessionUserId, status]);

  React.useEffect(() => {
    void loadTenantsData();
  }, [loadTenantsData]);

  // The workspace switcher's "Create workspace" links here with `#create`; honouring it is
  // what keeps that entry point working now that creation lives on this page.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === CREATE_HASH) setOverlay('create');
  }, []);

  const rows = React.useMemo(
    () => buildTenantRows(tenants, { admins, userId: sessionUserId, currentTenantId }),
    [tenants, admins, sessionUserId, currentTenantId]
  );
  const summary = React.useMemo(() => summariseTenantRows(rows), [rows]);

  const findRow = React.useCallback(
    (id: string | null) => (id ? rows.find((row) => row.id === id) ?? null : null),
    [rows]
  );

  const openTenant = findRow(openTenantId);
  const overlayTenant = findRow(overlayTenantId);

  /** The people of the tenant the drawer is managing — derived, never stored. */
  const openTenantMembers = React.useMemo(() => {
    if (!openTenantId) return [] as TenantMember[];
    return mergeTenantMembers(tenantUsers[openTenantId] ?? [], admins, openTenantId);
  }, [openTenantId, tenantUsers, admins]);

  // ---- mutations ----------------------------------------------------------------------

  const handleSelectTenant = React.useCallback(
    async (tenant: TenantRow) => {
      await update({ current_tenant_id: tenant.id });
    },
    [update]
  );

  const handleCreated = React.useCallback(
    async (tenant: CreatedTenant) => {
      setOverlay('none');
      toast.success(`${tenant.name} created.`);
      await update({ current_tenant_id: tenant.id });
      await loadTenantsData();
    },
    [loadTenantsData, update]
  );

  const handleEditTenantSubmit = React.useCallback(
    async ({ id, draft }: { id: string; draft: TenantEditDraft }) => {
      const before = tenants.find((tenant) => tenant.id === id);
      const failure = readEnvelope(
        await updateTenant(id, draft.name, draft.description, draft.slug),
        'Failed to update tenant'
      );
      if (failure) return failure;
      await loadTenantsData();
      if (before && before.slug !== draft.slug) {
        toast.success(`Tenant updated successfully. New slug: ${draft.slug}`);
      }
      return null;
    },
    [loadTenantsData, tenants]
  );

  const handleAddMemberSubmit = React.useCallback(
    async ({ email, isAdmin }: { email: string; isAdmin: boolean }) => {
      if (!overlayTenantId) return 'No tenant selected';
      const userFailure = readEnvelope(
        await addTenantUser(overlayTenantId, email),
        'Failed to add member'
      );
      if (userFailure) return userFailure;

      if (isAdmin) {
        const adminFailure = readEnvelope(
          await addTenantAdministrator(overlayTenantId, email),
          'Failed to add administrator role'
        );
        // The membership landed even though the role did not, so the list is reloaded
        // before reporting: the reader should see the half that worked.
        if (adminFailure) {
          await loadTenantsData();
          return adminFailure;
        }
      }

      await loadTenantsData();
      return null;
    },
    [loadTenantsData, overlayTenantId]
  );

  const handleEditRolesSubmit = React.useCallback(
    async ({ member, isAdmin }: { member: TenantMember; isAdmin: boolean }) => {
      if (!overlayTenantId) return 'No tenant selected';

      if (isAdmin && !member.isAdmin) {
        const failure = readEnvelope(
          await addTenantAdministrator(overlayTenantId, member.email),
          'Failed to add administrator role'
        );
        if (failure) return failure;
      } else if (!isAdmin && member.isAdmin && member.adminRecordId) {
        const failure = readEnvelope(
          await removeTenantAdministrator(member.adminRecordId),
          'Failed to remove administrator role'
        );
        if (failure) return failure;
      }

      await loadTenantsData();
      return null;
    },
    [loadTenantsData, overlayTenantId]
  );

  const handleRemoveMember = React.useCallback(
    async (member: TenantMember) => {
      // Both roles have to go, and the admin row goes first: a failure part-way then leaves
      // the person a member rather than an administrator of a tenant they were removed from.
      if (member.adminRecordId) {
        const failure = readEnvelope(
          await removeTenantAdministrator(member.adminRecordId),
          'Failed to remove administrator role'
        );
        if (failure) return failure;
      }
      if (member.userRecordId) {
        const failure = readEnvelope(
          await removeTenantUser(member.userRecordId),
          'Failed to remove member'
        );
        if (failure) {
          await loadTenantsData();
          return failure;
        }
      }
      await loadTenantsData();
      return null;
    },
    [loadTenantsData]
  );

  // ---- overlay helpers ----------------------------------------------------------------

  const openOverlayFor = React.useCallback(
    (next: TenantOverlay, tenantId: string, member: TenantMember | null = null) => {
      setOverlayTenantId(tenantId);
      setOverlayMember(member);
      setOverlay(next);
    },
    []
  );

  const closeOverlay = React.useCallback(() => setOverlay('none'), []);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Workspace' },
          { label: 'Tenants' },
        ]}
        title="Tenants"
        description="Your workspaces — switch between them or manage the ones you administer."
        actions={
          <>
            <span className="text-xs text-fg-muted">
              {summary.total} {summary.total === 1 ? 'tenant' : 'tenants'}
            </span>
            <Button kbd="N" onClick={() => setOverlay('create')} data-testid="tenants-new">
              <Plus aria-hidden />
              New tenant
            </Button>
          </>
        }
      />

      <PageBody>
        <TenantsTable
          rows={rows}
          loading={loading}
          error={loadError}
          onRetry={() => void loadTenantsData()}
          onSelectTenant={(tenant) => void handleSelectTenant(tenant)}
          onManageTenant={(tenant) => setOpenTenantId(tenant.id)}
          onEditTenant={(tenant) => openOverlayFor('edit-tenant', tenant.id)}
          onCreateTenant={() => setOverlay('create')}
        />
      </PageBody>

      <TenantManageDrawer
        tenant={openTenant}
        onOpenChange={(open) => {
          if (!open) setOpenTenantId(null);
        }}
        members={openTenantMembers}
        currentUserId={sessionUserId}
        loading={loading}
        onEditTenant={(tenant) => openOverlayFor('edit-tenant', tenant.id)}
        onAddMember={() => openTenantId && openOverlayFor('add-member', openTenantId)}
        onEditMember={(member) =>
          openTenantId && openOverlayFor('edit-roles', openTenantId, member)
        }
        onRemoveMember={(member) =>
          openTenantId && openOverlayFor('remove-member', openTenantId, member)
        }
        membersPageHref={MEMBERS_ROUTE}
      />

      <CreateTenantDialog
        open={overlay === 'create'}
        onOpenChange={(open) => !open && closeOverlay()}
        onCreated={(tenant) => void handleCreated(tenant)}
      />

      <EditTenantDialog
        open={overlay === 'edit-tenant'}
        onOpenChange={(open) => !open && closeOverlay()}
        tenant={overlayTenant}
        onSubmit={handleEditTenantSubmit}
      />

      <AddMemberDialog
        open={overlay === 'add-member'}
        onOpenChange={(open) => !open && closeOverlay()}
        tenantName={overlayTenant?.name ?? 'this tenant'}
        onSubmit={handleAddMemberSubmit}
      />

      <EditMemberRolesDialog
        open={overlay === 'edit-roles'}
        onOpenChange={(open) => !open && closeOverlay()}
        member={overlayMember}
        onSubmit={handleEditRolesSubmit}
      />

      <RemoveMemberDialog
        open={overlay === 'remove-member'}
        onOpenChange={(open) => !open && closeOverlay()}
        member={overlayMember}
        tenantName={overlayTenant?.name ?? 'this tenant'}
        onConfirm={handleRemoveMember}
      />
    </Page>
  );
}
